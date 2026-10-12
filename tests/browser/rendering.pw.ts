/**
 * Analytic pixel probes: colours, ink and Unicode cell placement through the
 * real Terminal.write → WASM → CanvasRenderer path. No golden images; every
 * expectation is a spec-derived colour or a metamorphic equality.
 */

import { THEME, expectProbe, expectSameCells, rtest } from './support/fixture';
import { cellCore, cellInterior, diffCells, inkCount, uniformColor } from './support/pixels';

/** Park the cursor away from probed cells (bottom-right). */
const PARK_CURSOR = '\x1b[3;12H';

async function backgroundOf(
  ctx: Parameters<Parameters<typeof rtest>[1]>[0],
  sgr: string,
  theme = {}
) {
  const term = await ctx.harness.create({ cols: 12, rows: 3, theme: { ...THEME, ...theme } });
  await term.writeAndSettle(`\x1b[${sgr}m    \x1b[0m${PARK_CURSOR}`);
  const { image, grid } = await term.capture();
  return { color: uniformColor(image, cellInterior(grid, 0, 1)), image };
}

// --- Background colours (WEB-04 / RT-06: explicit black is not "default") ---

rtest('color.bg-default-uses-theme-background', async (ctx) => {
  const { color, image } = await backgroundOf(ctx, '0');
  await expectProbe(ctx, 'default-bg', color, THEME.background, image);
});

rtest('color.bg-explicit-truecolor', async (ctx) => {
  const { color, image } = await backgroundOf(ctx, '48;2;18;52;86');
  await expectProbe(ctx, 'truecolor-bg', color, '#123456', image);
});

rtest('color.bg-sgr40-is-theme-black', async (ctx) => {
  const { color, image } = await backgroundOf(ctx, '40');
  await expectProbe(ctx, 'sgr40-bg', color, THEME.black, image);
});

// Control: the palette path itself works when the theme colour is not 0x000000.
rtest('color.bg-sgr40-uses-nonzero-theme-black', async (ctx) => {
  const { color, image } = await backgroundOf(ctx, '40', { black: '#0a0b0c' });
  await expectProbe(ctx, 'sgr40-bg-nonzero', color, '#0a0b0c', image);
});

rtest('color.bg-256-index-16-is-black', async (ctx) => {
  const { color, image } = await backgroundOf(ctx, '48;5;16');
  await expectProbe(ctx, 'index16-bg', color, '#000000', image);
});

rtest('color.bg-truecolor-black-is-black', async (ctx) => {
  const { color, image } = await backgroundOf(ctx, '48;2;0;0;0');
  await expectProbe(ctx, 'rgb000-bg', color, '#000000', image);
});

rtest('color.inverse-swaps-default-colors', async (ctx) => {
  const { color, image } = await backgroundOf(ctx, '7');
  await expectProbe(ctx, 'inverse-bg', color, THEME.foreground, image);
});

// --- Foreground colours, probed inside a full-block glyph (U+2588) ---

rtest('color.fg-truecolor-full-block', async (ctx) => {
  const term = await ctx.harness.create({ cols: 12, rows: 3 });
  await term.writeAndSettle(`\x1b[38;2;255;128;0m\u2588\x1b[0m${PARK_CURSOR}`);
  const { image, grid } = await term.capture();
  await expectProbe(
    ctx,
    'truecolor-fg',
    uniformColor(image, cellCore(grid, 0, 0)),
    '#ff8000',
    image
  );
});

rtest('color.fg-theme-black-on-light-theme', async (ctx) => {
  const light = { ...THEME, background: '#f0f0f0', foreground: '#000000', cursorAccent: '#f0f0f0' };
  const term = await ctx.harness.create({ cols: 12, rows: 3, theme: light });
  await term.writeAndSettle(`\u2588${PARK_CURSOR}`);
  const { image, grid } = await term.capture();
  await expectProbe(
    ctx,
    'theme-black-fg',
    uniformColor(image, cellCore(grid, 0, 0)),
    '#000000',
    image
  );
});

// --- Text ink and Unicode placement ---

rtest('text.glyph-has-ink-blank-cell-has-none', async (ctx) => {
  const term = await ctx.harness.create({ cols: 12, rows: 3 });
  await term.writeAndSettle(`A${PARK_CURSOR}`);
  const { image, grid } = await term.capture();
  ctx.checks.equal(
    'glyph-has-ink',
    inkCount(image, cellInterior(grid, 0, 0, 0), THEME.background) > 0,
    true
  );
  ctx.checks.equal(
    'blank-has-no-ink',
    inkCount(image, cellInterior(grid, 0, 1, 0), THEME.background),
    0
  );
});

rtest('text.wide-char-advances-two-cells', async (ctx) => {
  const wide = await ctx.harness.create({ cols: 12, rows: 3 });
  await wide.writeAndSettle(`\u4e00A${PARK_CURSOR}`);
  const reference = await ctx.harness.create({ cols: 12, rows: 3 });
  await reference.writeAndSettle(`\x1b[1;3HA${PARK_CURSOR}`);
  const a = await wide.capture();
  const b = await reference.capture();
  await expectSameCells(ctx, 'a-after-wide-char-in-col-2', a.image, b.image, a.grid, {
    channelTolerance: 0,
    maxPixelsPerCell: 0,
    cells: ['0:2'],
  });
  ctx.checks.equal(
    'wide-glyph-has-ink',
    inkCount(a.image, cellInterior(a.grid, 0, 0, 0), THEME.background) > 0,
    true
  );
});

rtest('text.combining-mark-renders-as-cluster', async (ctx) => {
  const combined = await ctx.harness.create({ cols: 12, rows: 3 });
  await combined.writeAndSettle(`e\u0301${PARK_CURSOR}`);
  const plain = await ctx.harness.create({ cols: 12, rows: 3 });
  await plain.writeAndSettle(`e${PARK_CURSOR}`);
  const precomposed = await ctx.harness.create({ cols: 12, rows: 3 });
  await precomposed.writeAndSettle(`\u00e9${PARK_CURSOR}`);
  const c = await combined.capture();
  const p = await plain.capture();
  const pre = await precomposed.capture();
  // The accent must be drawn (differs from a bare "e") ...
  ctx.checks.equal(
    'accent-drawn',
    diffCells(c.image, p.image, c.grid, {
      channelTolerance: 0,
      maxPixelsPerCell: 0,
      cells: ['0:0'],
    }),
    ['0:0']
  );
  // ... and the cluster occupies exactly one cell like the precomposed form.
  await expectSameCells(ctx, 'decomposed-equals-precomposed', c.image, pre.image, c.grid);
});

/**
 * Scroll `text` into history (one row), view it at viewport row 0, and
 * compare cell 0:0 with the same text rendered on the active screen.
 */
async function historyVersusActive(
  ctx: Parameters<Parameters<typeof rtest>[1]>[0],
  text: string,
  assertion: string
) {
  ctx.checks.requireCapabilities(ctx.harness.info.capabilities, [
    'park-render-loop',
    'forced-render',
  ]);
  const history = await ctx.harness.create({ cols: 8, rows: 3 });
  await history.writeAndSettle(`${text}\r\nL1\r\nL2\r\nL3`);
  ctx.checks.equal('one-history-row', await history.scrollbackLength(), 1);
  await history.park();
  await history.render(true, 1);
  const active = await ctx.harness.create({ cols: 8, rows: 3 });
  await active.writeAndSettle(`${text}\x1b[3;8H`);
  await active.park();
  await active.render(true);
  const h = await history.capture();
  const a = await active.capture();
  await expectSameCells(ctx, assertion, h.image, a.image, h.grid, {
    channelTolerance: 0,
    maxPixelsPerCell: 0,
    cells: ['0:0'],
  });
}

// Control: a plain history row renders exactly like the active row.
rtest('text.history-row-ascii-matches-active-row', async (ctx) => {
  await historyVersusActive(ctx, 'e', 'history-ascii-cell');
});

// 'e' + U+0301 in history must still draw its own cluster (not the active row's text).
rtest('text.history-row-grapheme-matches-active-row', async (ctx) => {
  await historyVersusActive(ctx, 'e\u0301', 'history-cluster-cell');
});

// --- Renderer work model (functional metric, not a timing) ---

rtest('perf.forced-frame-decodes-viewport-once', async (ctx) => {
  ctx.checks.requireCapabilities(ctx.harness.info.capabilities, [
    'park-render-loop',
    'forced-render',
    'viewport-decode-spy',
  ]);
  const term = await ctx.harness.create({ cols: 40, rows: 12 });
  await term.writeAndSettle('one frame should read the viewport once');
  await term.park();
  await term.spyViewportDecode();
  // Force genuinely stale state: a cached getter alone is not a decode.
  await term.write('!');
  await term.render(true);
  ctx.checks.equal('viewport-decodes-per-forced-frame', await term.viewportDecodeCount(), 1);
});
