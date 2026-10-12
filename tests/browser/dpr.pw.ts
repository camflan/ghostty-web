/**
 * Device-pixel-ratio behaviour. The DPR is set on the browser context, never
 * as a renderer option, so the real window.devicePixelRatio path is tested.
 */

import { THEME, expectProbe, rtest, test } from './support/fixture';
import { type Grid, type Image, hexAt } from './support/pixels';

type Ctx = Parameters<Parameters<typeof rtest>[1]>[0];

async function idleResizes(ctx: Ctx): Promise<number> {
  ctx.checks.requireCapabilities(ctx.harness.info.capabilities, [
    'park-render-loop',
    'forced-render',
    'renderer-resize-spy',
  ]);
  const term = await ctx.harness.create({ cols: 81, rows: 5 });
  await term.writeAndSettle('idle frames must not resize the canvas');
  await term.park();
  await term.spyResize();
  for (let i = 0; i < 10; i++) await term.render(false);
  return term.resizeCount();
}

/** Cell boundaries (by column index) along row 0's centre line that are not pure `color`. */
function seamBoundaries(image: Image, grid: Grid, runCells: number, color: string): number[] {
  const y = Math.floor(0.5 * grid.cellH);
  const seams = new Set<number>();
  for (let x = 1; x < Math.floor(runCells * grid.cellW) - 1; x++) {
    if (hexAt(image, x, y) !== color) seams.add(Math.round(x / grid.cellW));
  }
  return [...seams].sort((a, b) => a - b);
}

async function seams(ctx: Ctx) {
  const term = await ctx.harness.create({ cols: 24, rows: 2 });
  await term.writeAndSettle(`\x1b[41m${' '.repeat(20)}\x1b[0m\x1b[2;24H`);
  const { image, grid } = await term.capture();
  return { seams: seamBoundaries(image, grid, 20, THEME.red), image };
}

async function expectNoIdleResizes(ctx: Ctx, dpr: number): Promise<void> {
  ctx.checks.equal('page-dpr', ctx.harness.info.dpr, dpr);
  ctx.checks.equal('resize-calls-in-10-idle-renders', await idleResizes(ctx), 0);
}

async function expectNoSeams(ctx: Ctx, dpr: number): Promise<void> {
  ctx.checks.equal('page-dpr', ctx.harness.info.dpr, dpr);
  const result = await seams(ctx);
  await expectProbe(ctx, 'seam-boundaries', result.seams, [], result.image);
}

rtest('dpr.display-change-updates-backing-size-once', async (ctx) => {
  ctx.checks.requireCapabilities(ctx.harness.info.capabilities, ['renderer-resize-spy']);
  const term = await ctx.harness.create({ cols: 81, rows: 5 });
  await term.writeAndSettle('display-scale change');
  await term.spyResize();
  const before = await term.capture();
  const cdp = await ctx.harness.page.context().newCDPSession(ctx.harness.page);
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1000,
      height: 700,
      deviceScaleFactor: 1.5,
      mobile: false,
    });
    await ctx.harness.page.waitForFunction(() => window.devicePixelRatio === 1.5);
    await term.settle();
    const after = await term.capture();
    ctx.checks.equal('dpr-after-display-change', after.raw.dpr, 1.5);
    ctx.checks.equal(
      'backing-size-after-display-change',
      [after.raw.width, after.raw.height],
      [
        Math.floor(before.raw.cols * before.raw.cellWidth * 1.5),
        Math.floor(before.raw.rows * before.raw.cellHeight * 1.5),
      ]
    );
    ctx.checks.equal('one-resize-for-display-change', await term.resizeCount(), 1);
    await term.settle();
    ctx.checks.equal('no-extra-idle-resize', await term.resizeCount(), 1);
  } finally {
    await cdp.detach();
  }
});

// Literal ids (not generated) so scope.json coverage can be checked statically.
test.describe('dpr 1', () => {
  test.use({ deviceScaleFactor: 1 });
  rtest('dpr.idle-renders-do-not-resize-at-1', (ctx) => expectNoIdleResizes(ctx, 1));
  rtest('dpr.background-run-has-no-seams-at-1', (ctx) => expectNoSeams(ctx, 1));
});

test.describe('dpr 1.25', () => {
  test.use({ deviceScaleFactor: 1.25 });
  rtest('dpr.idle-renders-do-not-resize-at-1-25', (ctx) => expectNoIdleResizes(ctx, 1.25));
  rtest('dpr.background-run-has-no-seams-at-1-25', (ctx) => expectNoSeams(ctx, 1.25));
});

test.describe('dpr 2', () => {
  test.use({ deviceScaleFactor: 2 });
  rtest('dpr.idle-renders-do-not-resize-at-2', (ctx) => expectNoIdleResizes(ctx, 2));
  rtest('dpr.background-run-has-no-seams-at-2', (ctx) => expectNoSeams(ctx, 2));
});
