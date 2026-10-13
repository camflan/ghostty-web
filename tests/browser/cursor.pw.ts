/**
 * Cursor shape and visibility, classified from the bounding box of pixels in
 * the (distinct) theme cursor colour. Font-independent.
 */

import { THEME, expectProbe, expectSameCells, rtest } from './support/fixture';
import { cursorShape } from './support/pixels';

type Ctx = Parameters<Parameters<typeof rtest>[1]>[0];

async function shapeAt(
  ctx: Ctx,
  style: 'block' | 'bar' | 'underline',
  data: string,
  row: number,
  col: number
) {
  const term = await ctx.harness.create({ cols: 6, rows: 2, cursorStyle: style });
  if (data) await term.writeAndSettle(data);
  const { image, grid } = await term.capture();
  return { shape: cursorShape(image, grid, row, col, THEME.cursor), image, grid };
}

// Options-driven shapes (renderer).
rtest('cursor.option-block', async (ctx) => {
  const { shape, image } = await shapeAt(ctx, 'block', '', 0, 0);
  await expectProbe(ctx, 'block-shape', shape, 'block', image);
});

rtest('cursor.option-bar', async (ctx) => {
  const { shape, image } = await shapeAt(ctx, 'bar', '', 0, 0);
  await expectProbe(ctx, 'bar-shape', shape, 'bar', image);
});

rtest('cursor.option-underline', async (ctx) => {
  const { shape, image } = await shapeAt(ctx, 'underline', '', 0, 0);
  await expectProbe(ctx, 'underline-shape', shape, 'underline', image);
});

rtest('cursor.moves-with-output', async (ctx) => {
  const { shape, image, grid } = await shapeAt(ctx, 'block', 'ab', 0, 2);
  await expectProbe(ctx, 'cursor-at-new-position', shape, 'block', image);
  await expectProbe(
    ctx,
    'old-position-cleared',
    cursorShape(image, grid, 0, 0, THEME.cursor),
    'none',
    image
  );
});

// Application-driven shapes (DECSCUSR) and visibility (DECTCEM).
rtest('cursor.decscusr-steady-bar', async (ctx) => {
  const { shape, image } = await shapeAt(ctx, 'block', '\x1b[6 q', 0, 0);
  await expectProbe(ctx, 'decscusr-6-shape', shape, 'bar', image);
});

rtest('cursor.decscusr-steady-underline', async (ctx) => {
  const { shape, image } = await shapeAt(ctx, 'block', '\x1b[4 q', 0, 0);
  await expectProbe(ctx, 'decscusr-4-shape', shape, 'underline', image);
});

rtest('review.runtime-cursor-style-erases-previous-shape', async (ctx) => {
  const term = await ctx.harness.create({ cols: 10, rows: 3, cursorBlink: false });
  await term.writeAndSettle('cursor');
  await term.park();
  for (const style of ['underline', 'bar', 'block'] as const) {
    await term.setOptions({ cursorStyle: style });
    await term.render(false);
    const incremental = await term.capture();
    await term.render(true);
    const full = await term.capture();
    await expectSameCells(ctx, `runtime-${style}`, incremental.image, full.image, full.grid);
  }
});

rtest('cursor.dectcem-hide-erases-cursor', async (ctx) => {
  const { shape, image } = await shapeAt(ctx, 'block', '\x1b[?25l', 0, 0);
  await expectProbe(ctx, 'hidden-cursor-shape', shape, 'none', image);
});

rtest('cursor.dectcem-hide-with-output-on-row', async (ctx) => {
  // Control for the case above: when output also dirties the row, hiding works.
  const term = await ctx.harness.create({ cols: 6, rows: 2 });
  await term.writeAndSettle('\x1b[?25lab');
  const { image, grid } = await term.capture();
  await expectProbe(
    ctx,
    'hidden-at-new-position',
    cursorShape(image, grid, 0, 2, THEME.cursor),
    'none',
    image
  );
  await expectProbe(
    ctx,
    'hidden-at-old-position',
    cursorShape(image, grid, 0, 0, THEME.cursor),
    'none',
    image
  );
});
