/**
 * Mouse reporting and selection through real page.mouse actions.
 * SGR encodings per src/input/mouse_encode.zig (button 0 press/release,
 * wheel down = 65, 1-based coordinates).
 */

import { THEME, expectProbe, rtest } from './support/fixture';
import { cellInterior, uniformColor } from './support/pixels';

const SGR_MOUSE = '\x1b[?1000h\x1b[?1006h';

rtest('mouse.sgr-press-and-release', async (ctx) => {
  const term = await ctx.harness.create({ cols: 10, rows: 4 });
  await term.writeAndSettle(SGR_MOUSE);
  await term.clearEvents();
  await term.clickCell(1, 3);
  await ctx.harness.frame();
  ctx.checks.equal('sgr-click', (await term.events()).data, ['\x1b[<0;4;2M', '\x1b[<0;4;2m']);
});

rtest('mouse.x10-raw-byte-channel', async (ctx) => {
  const term = await ctx.harness.create({ cols: 120, rows: 10 });
  await term.writeAndSettle('\x1b[?1000h');
  await term.clearEvents();
  await term.clickCell(4, 99);
  await ctx.harness.frame();
  const raw = await term.events();
  ctx.checks.equal(
    'raw-byte-reports',
    raw.binary.map((s) => Array.from(s, (c) => c.charCodeAt(0))),
    [
      [27, 91, 77, 32, 132, 37],
      [27, 91, 77, 35, 132, 37],
    ]
  );
  ctx.checks.equal('no-corrupt-text-copy', raw.data, []);
  await term.writeAndSettle('\x1b[?1006h');
  await term.clearEvents();
  await term.clickCell(4, 99);
  await ctx.harness.frame();
  const sgr = await term.events();
  ctx.checks.equal('sgr-stays-text', sgr.data, ['\x1b[<0;100;5M', '\x1b[<0;100;5m']);
  ctx.checks.equal('no-binary-sgr-duplicate', sgr.binary, []);
});

rtest('mouse.sgr-wheel-reported-when-tracking', async (ctx) => {
  const term = await ctx.harness.create({ cols: 10, rows: 4 });
  await term.writeAndSettle(SGR_MOUSE);
  await term.clearEvents();
  const p = await term.cellCenter(2, 3);
  await ctx.harness.page.mouse.move(p.x, p.y);
  await ctx.harness.page.mouse.wheel(0, 100);
  await ctx.harness.frame();
  const events = await term.events();
  ctx.checks.equal('wheel-reports', [...new Set(events.data)], ['\x1b[<65;4;3M']);
});

async function dragSelect(
  ctx: Parameters<Parameters<typeof rtest>[1]>[0],
  text: string,
  toCol: number
) {
  const term = await ctx.harness.create({ cols: 12, rows: 3 });
  await term.writeAndSettle(`${text}\x1b[3;12H`);
  await term.clearEvents();
  const from = await term.cellCenter(0, 0);
  const to = await term.cellCenter(0, toCol);
  const mouse = ctx.harness.page.mouse;
  await mouse.move(from.x, from.y);
  await mouse.down();
  await mouse.move(to.x, to.y, { steps: 4 });
  await mouse.up();
  await term.settle();
  return term;
}

rtest('mouse.drag-selects-text-and-highlights', async (ctx) => {
  const term = await dragSelect(ctx, 'hello world', 4);
  ctx.checks.equal('selection-text', await term.selection(), 'hello');
  ctx.checks.equal('selection-change-fired', (await term.events()).selectionChanges > 0, true);
  const { image, grid } = await term.capture();
  const top = cellInterior(grid, 0, 2, 0);
  await expectProbe(
    ctx,
    'selected-cell-top-row',
    uniformColor(image, { ...top, y1: top.y0 + 1 }),
    THEME.selectionBackground,
    image
  );
  const outside = cellInterior(grid, 0, 7, 0);
  await expectProbe(
    ctx,
    'unselected-cell-top-row',
    uniformColor(image, { ...outside, y1: outside.y0 + 1 }),
    THEME.background,
    image
  );
});

rtest('mouse.shift-drag-selects-locally-with-tracking', async (ctx) => {
  const term = await ctx.harness.create({ cols: 20, rows: 10 });
  await term.writeAndSettle(`\x1b[5;1Hhello world\x1b[?1002h\x1b[?1006h`);
  await term.clearEvents();
  const from = await term.cellCenter(4, 0);
  const to = await term.cellCenter(4, 4);
  await ctx.harness.page.keyboard.down('Shift');
  await ctx.harness.page.mouse.move(from.x, from.y);
  await ctx.harness.page.mouse.down();
  await ctx.harness.page.mouse.move(to.x, to.y, { steps: 4 });
  await ctx.harness.page.mouse.up();
  await ctx.harness.page.keyboard.up('Shift');
  await term.settle();
  ctx.checks.equal('shift-selection', await term.selection(), 'hello');
  ctx.checks.equal('no-application-input', (await term.events()).data, []);
});

rtest('mouse.tracking-drag-does-not-select-locally', async (ctx) => {
  const term = await ctx.harness.create({ cols: 20, rows: 10 });
  await term.writeAndSettle(`\x1b[5;1Hhello world\x1b[?1002h\x1b[?1006h`);
  await term.clearEvents();
  const from = await term.cellCenter(4, 0);
  const to = await term.cellCenter(4, 4);
  await ctx.harness.page.mouse.move(from.x, from.y);
  await ctx.harness.page.mouse.down();
  await ctx.harness.page.mouse.move(to.x, to.y, { steps: 4 });
  await ctx.harness.page.mouse.up();
  await term.settle();
  const data = (await term.events()).data;
  ctx.checks.equal('no-local-selection', await term.selection(), '');
  ctx.checks.equal('press', data[0], '\x1b[<0;1;5M');
  ctx.checks.equal('release', data.at(-1), '\x1b[<0;5;5m');
});

rtest('mouse.drag-selects-wide-characters', async (ctx) => {
  const term = await dragSelect(ctx, '\u4e00\u4e8c\u4e09x', 5);
  ctx.checks.equal('selection-text', await term.selection(), '\u4e00\u4e8c\u4e09');
});
