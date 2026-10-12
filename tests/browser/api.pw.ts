/**
 * Public API callbacks, links and paste, observed through the xterm.js-style
 * API surface the embedder sees. Paste expectations follow Ghostty's
 * src/input/paste.zig ("encode unbracketed newlines": LF → CR).
 */

import { expectProbe, rtest } from './support/fixture';
import { cellInterior, inkCount } from './support/pixels';

rtest('api.title-bell-and-cursor-move-callbacks', async ({ harness, checks }) => {
  const term = await harness.create({ cols: 10, rows: 3 });
  await term.writeAndSettle('\x1b]2;regress-title\x1b\\');
  await term.writeAndSettle('\x07');
  await term.writeAndSettle('x\r\ny');
  const events = await term.events();
  checks.equal('titles', events.titles, ['regress-title']);
  checks.equal('bells', events.bells, 1);
  checks.equal('cursor-moves', events.cursorMoves, 1);
});

rtest('api.native-title-and-bell-parser-events', async ({ harness, checks }) => {
  const term = await harness.create({ cols: 20, rows: 3 });
  const bytes = Array.from(new TextEncoder().encode('\x1b]2;€uro\x07'));
  await harness.page.evaluate(([id, data]) => window.__ghosttyRegression.writeBytes(id, data), [
    term.id,
    bytes.slice(0, 6),
  ] as const);
  checks.equal('partial-title-not-reported', (await term.events()).titles, []);
  await harness.page.evaluate(([id, data]) => window.__ghosttyRegression.writeBytes(id, data), [
    term.id,
    bytes.slice(6),
  ] as const);
  await term.writeAndSettle('\x1b]8;;https://example.com\x07link\x1b]8;;\x07');
  await term.writeAndSettle('\x07\x07\x1b]2;next\x07');
  const events = await term.events();
  checks.equal('native-titles', events.titles, ['€uro', 'next']);
  checks.equal('only-executed-bells', events.bells, 2);
});

rtest('api.resize-updates-grid-and-canvas', async (ctx) => {
  const term = await ctx.harness.create({ cols: 10, rows: 3 });
  await term.resize(14, 5);
  await term.writeAndSettle('\x1b[5;14H#');
  const events = await term.events();
  ctx.checks.equal('resize-events', events.resizes, [{ cols: 14, rows: 5 }]);
  const { image, grid, raw } = await term.capture();
  ctx.checks.equal('grid', [raw.cols, raw.rows], [14, 5]);
  ctx.checks.equal(
    'canvas-size',
    [raw.width, raw.height],
    [14 * raw.cellWidth * raw.dpr, 5 * raw.cellHeight * raw.dpr]
  );
  await expectProbe(
    ctx,
    'last-cell-has-ink',
    inkCount(image, cellInterior(grid, 4, 13, 0), '#202020') > 0,
    true,
    image
  );
});

rtest('api.deccolm-keeps-rendering-host-grid', async (ctx) => {
  const term = await ctx.harness.create({ cols: 20, rows: 3 });
  await term.writeAndSettle('\x1b[?40h\x1b[?3h');
  await term.writeAndSettle('\x1b[?3l');
  const before = await term.capture();
  ctx.checks.equal('host-grid', [before.raw.cols, before.raw.rows], [20, 3]);
  ctx.checks.equal('no-host-resize', (await term.events()).resizes, []);
  // Legacy can blank on DECCOLM, but supported host resize/output must recover.
  // Native additionally preserves content at the host size (native bridge tests).
  await term.resize(22, 4);
  await term.writeAndSettle('\x1b[4;22H#');
  const { image, grid } = await term.capture();
  await expectProbe(
    ctx,
    'output-after-host-resize',
    inkCount(image, cellInterior(grid, 3, 21, 0), '#202020') > 0,
    true,
    image
  );
});

rtest('api.paste-bracketed-when-2004-set', async ({ harness, checks }) => {
  const term = await harness.create({ cols: 10, rows: 3 });
  await term.writeAndSettle('\x1b[?2004h');
  await term.clearEvents();
  await term.paste('hi');
  checks.equal('bracketed-paste', (await term.events()).data, ['\x1b[200~hi\x1b[201~']);
});

rtest('api.paste-unbracketed-converts-newlines', async ({ harness, checks }) => {
  const term = await harness.create({ cols: 10, rows: 3 });
  await term.clearEvents();
  await term.paste('a\nb');
  checks.equal('unbracketed-paste', (await term.events()).data, ['a\rb']);
});

rtest('api.dispose-removes-dom', async ({ harness, checks }) => {
  const term = await harness.create({ cols: 10, rows: 3 });
  checks.equal('children-while-open', await term.hostChildCount(), 2); // canvas + textarea
  checks.equal('children-after-dispose', await term.dispose(), 0);
});

const osc8 = (uri: string, text: string) => `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`;

async function ctrlClick(
  term: Awaited<ReturnType<Parameters<Parameters<typeof rtest>[1]>[0]['harness']['create']>>,
  row: number,
  col: number
) {
  const p = await term.cellCenter(row, col);
  const page = term.page;
  await page.mouse.move(p.x, p.y);
  await page.keyboard.down('Control');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Control');
}

rtest('link.osc8-https-opens-on-ctrl-click', async ({ harness, checks }) => {
  await harness.spyWindowOpen();
  const term = await harness.create({ cols: 20, rows: 3 });
  await term.writeAndSettle(`${osc8('https://example.com/', 'site')}\x1b[3;20H`);
  await ctrlClick(term, 0, 1);
  await harness.page.waitForFunction(() => window.__ghosttyRegression.openedUrls().length > 0);
  checks.equal('opened', await harness.openedUrls(), ['https://example.com/']);
});

rtest('link.osc8-javascript-scheme-not-opened', async ({ harness, checks }) => {
  await harness.spyWindowOpen();
  const term = await harness.create({ cols: 20, rows: 3 });
  await term.writeAndSettle(
    `${osc8('javascript:alert(document.domain)', 'evil')}\r\n${osc8('https://example.com/', 'site')}\x1b[3;20H`
  );
  await ctrlClick(term, 0, 1);
  // Barrier: a safe link clicked afterwards proves the first click was fully handled.
  await ctrlClick(term, 1, 1);
  await harness.page.waitForFunction(() =>
    window.__ghosttyRegression.openedUrls().includes('https://example.com/')
  );
  checks.equal('opened', await harness.openedUrls(), ['https://example.com/']);
});
