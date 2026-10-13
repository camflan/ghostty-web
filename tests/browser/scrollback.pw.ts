/**
 * Scrollback through real input: page.mouse wheel and scrollbar drags over a
 * history of uniquely colour-marked, numbered lines.
 *
 * Oracle: the line each viewport row shows is decoded from its marker pixels
 * and compared with the mapping implied by the fixture (line N is the N-th
 * written line) and the user's actions (lines scrolled). Viewport state from
 * the public API is only used for waits and state/pixel consistency.
 *
 * Policy for output while viewing history (WEB-09): ghostty-web currently
 * follows xterm.js and jumps to the bottom; native Ghostty keeps the viewed
 * content. Both are pinned here — the first as a characterization, the second
 * as a "policy pending" native target — and neither is a row-correctness bug.
 */

import { type CaseContext, THEME, rtest } from './support/fixture';
import {
  type Geometry,
  type HistoryFixture,
  expectedViewport,
  geometry,
  historyFixture,
  linesBytes,
  viewportLines,
  wheelLines,
  wheelPixels,
} from './support/interaction';
import { type Grid, type Image, cloneImage, parseHex } from './support/pixels';

const ROWS = 12;
const COLS = 40;
const TOTAL = 600;
const MIN_HISTORY = 500;

async function fixture(ctx: CaseContext, smooth = 0) {
  const fx = await historyFixture(ctx.harness, {
    cols: COLS,
    rows: ROWS,
    total: TOTAL,
    minHistory: MIN_HISTORY,
    smooth,
  });
  return { fx, g: await geometry(fx.term) };
}

async function shownLines(fx: HistoryFixture): Promise<(number | string)[]> {
  await fx.term.settle();
  const { image, grid } = await fx.term.capture();
  return viewportLines(image, grid);
}

/** Device-pixel rows of the scrollbar thumb, read from the strip's centre column. */
function thumbBand(image: Image, g: Geometry, dpr: number): { top: number; bottom: number } {
  const x = Math.floor((g.rect.width - 8) * dpr);
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y++) {
    const i = (y * image.width + x) * 4;
    const [r, gr, b] = [image.data[i], image.data[i + 1], image.data[i + 2]];
    // Thumb: neutral grey well above the track (~#292929) and the background.
    if (r === gr && gr === b && r >= 64) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  return { top, bottom };
}

rtest('scroll.wheel-steps-show-expected-history-rows', async (ctx) => {
  const { fx, g } = await fixture(ctx);
  ctx.checks.equal('bottom-rows', await shownLines(fx), expectedViewport(fx, 0));
  await wheelLines(ctx, g, 5);
  ctx.checks.equal('viewport-after-up-5', (await fx.term.viewport()).viewportY, 5);
  ctx.checks.equal('rows-after-up-5', await shownLines(fx), expectedViewport(fx, 5));
  await wheelLines(ctx, g, -2);
  ctx.checks.equal('rows-after-down-2', await shownLines(fx), expectedViewport(fx, 3));
  await wheelLines(ctx, g, 200);
  ctx.checks.equal('rows-after-up-200', await shownLines(fx), expectedViewport(fx, 203));
});

rtest('scroll.wheel-clamps-at-top-and-bottom', async (ctx) => {
  const { fx, g } = await fixture(ctx);
  await wheelLines(ctx, g, fx.scrollback + 50);
  const top = await fx.term.viewport();
  ctx.checks.equal('viewport-at-top', top.viewportY, fx.scrollback);
  const oldest = Array.from({ length: ROWS }, (_, row) => fx.oldest + row);
  ctx.checks.equal('rows-at-top', await shownLines(fx), oldest);
  await wheelLines(ctx, g, 10);
  ctx.checks.equal('rows-stay-at-top', await shownLines(fx), oldest);
  await wheelLines(ctx, g, -(fx.scrollback + 50));
  ctx.checks.equal('viewport-at-bottom', (await fx.term.viewport()).viewportY, 0);
  ctx.checks.equal('rows-at-bottom', await shownLines(fx), expectedViewport(fx, 0));
  await wheelLines(ctx, g, -10);
  ctx.checks.equal('rows-stay-at-bottom', await shownLines(fx), expectedViewport(fx, 0));
});

rtest('scroll.wheel-partial-line-delta-shows-contiguous-rows', async (ctx) => {
  // A pixel delta that is not a whole number of rows (trackpads). Native Ghostty
  // scrolls whole rows and keeps the remainder, so 100 px of 16 px rows = 6 rows.
  const { fx, g } = await fixture(ctx);
  ctx.checks.equal('cell-height', g.cellH, 16);
  await wheelPixels(ctx, g, -100);
  ctx.checks.equal('rows-after-100px', await shownLines(fx), expectedViewport(fx, 6));
});

rtest('review.short-scroll-duration-settles-on-exact-rows', async (ctx) => {
  const { fx, g } = await fixture(ctx, 10);
  await wheelLines(ctx, g, 3);
  await ctx.harness.frame();
  ctx.checks.equal('subframe-target', (await fx.term.viewport()).viewportY, 3);
  ctx.checks.equal('subframe-rows', await shownLines(fx), expectedViewport(fx, 3));
  const scrolls = (await fx.term.events()).scrolls;
  ctx.checks.equal(
    'no-negative-scroll-events',
    scrolls.every((row) => Number.isInteger(row) && row >= 0),
    true
  );
});

rtest('scroll.smooth-wheel-settles-on-exact-rows', async (ctx) => {
  // Animated path (default-style 100 ms easing): only the settled frame is
  // asserted; it must land on whole rows exactly like the instant path.
  const { fx, g } = await fixture(ctx, 100);
  await wheelLines(ctx, g, 7);
  await ctx.harness.page.waitForFunction(
    (id) => window.__ghosttyRegression.viewport(id).viewportY === 7,
    fx.term.id,
    { timeout: 5_000 }
  );
  ctx.checks.equal('rows-after-animated-up-7', await shownLines(fx), expectedViewport(fx, 7));
  const scrolls = (await fx.term.events()).scrolls;
  ctx.checks.equal('scroll-events-end-on-target', scrolls.at(-1), 7);
});

rtest('scroll.scrollbar-drag-tracks-pointer-and-rows', async (ctx) => {
  const { fx, g } = await fixture(ctx);
  const dpr = ctx.harness.info.dpr;
  await wheelLines(ctx, g, 1); // reveals the overlay scrollbar
  await fx.term.settle();
  const before = thumbBand((await fx.term.capture()).image, g, dpr);
  ctx.checks.equal('thumb-visible', before.top >= 0 && before.bottom > before.top, true);
  const x = g.rect.left + g.rect.width - 8;
  const y = g.rect.top + (before.top + before.bottom) / 2 / dpr;
  const mouse = ctx.harness.page.mouse;
  const D = 48;
  await mouse.move(x, y);
  await mouse.down();
  await mouse.move(x, y - D, { steps: 6 });
  await mouse.up();
  await fx.term.settle();
  const up = await fx.term.viewport();
  const after = thumbBand((await fx.term.capture()).image, g, dpr);
  ctx.checks.equal('drag-up-scrolls-into-history', up.viewportY > 100, true);
  // Line quantisation moves the thumb by under one device pixel from the pointer.
  ctx.checks.equal('thumb-follows-pointer', Math.abs(before.top - after.top - D * dpr) <= 1, true);
  ctx.checks.equal('rows-match-viewport', await shownLines(fx), expectedViewport(fx, up.viewportY));
  ctx.checks.equal('drag-does-not-select', await fx.term.hasSelection(), false);
  await mouse.move(x, y - D);
  await mouse.down();
  await mouse.move(x, y, { steps: 6 });
  await mouse.up();
  ctx.checks.equal('drag-back-restores-position', (await fx.term.viewport()).viewportY, 1);
  ctx.checks.equal('rows-after-drag-back', await shownLines(fx), expectedViewport(fx, 1));
});

rtest('scroll.scrollbar-drag-past-top-clamps-to-oldest', async (ctx) => {
  const { fx, g } = await fixture(ctx);
  const dpr = ctx.harness.info.dpr;
  await wheelLines(ctx, g, 1);
  await fx.term.settle();
  const band = thumbBand((await fx.term.capture()).image, g, dpr);
  const x = g.rect.left + g.rect.width - 8;
  const mouse = ctx.harness.page.mouse;
  await mouse.move(x, g.rect.top + (band.top + band.bottom) / 2 / dpr);
  await mouse.down();
  await mouse.move(x, g.rect.top - 300, { steps: 6 });
  await mouse.up();
  ctx.checks.equal(
    'drag-past-top-reaches-oldest',
    (await fx.term.viewport()).viewportY,
    fx.scrollback
  );
});

rtest('scroll.output-while-viewing-history-jumps-to-bottom', async (ctx) => {
  // CHARACTERIZATION of the current, documented xterm.js-compatible policy
  // (lib/terminal.ts write(): "Auto-scroll to bottom on new output"). Not a
  // native-Ghostty oracle; remove when the scroll-on-output policy changes.
  const { fx, g } = await fixture(ctx);
  await wheelLines(ctx, g, 20);
  await fx.term.writeAndSettle(`\r\n${linesBytes(3, TOTAL)}`);
  ctx.checks.equal('viewport-at-bottom', (await fx.term.viewport()).viewportY, 0);
  const total = TOTAL + 3;
  ctx.checks.equal(
    'rows-are-newest',
    await shownLines(fx),
    Array.from({ length: ROWS }, (_, row) => total - ROWS + row)
  );
});

rtest('scroll.output-while-viewing-history-keeps-viewed-rows', async (ctx) => {
  // NATIVE TARGET, policy pending (product divergence, not a row bug): native
  // Ghostty pins the viewport to content while scrolled back, so the same
  // history lines stay on screen when output arrives.
  const { fx, g } = await fixture(ctx);
  await wheelLines(ctx, g, 20);
  const viewed = await shownLines(fx);
  ctx.checks.equal('viewed-before-output', viewed, expectedViewport(fx, 20));
  await fx.term.writeAndSettle(`\r\n${linesBytes(3, TOTAL)}`);
  ctx.checks.equal('rows-after-output', await shownLines(fx), viewed);
});

rtest('scroll.control-wrong-and-stale-rows-are-detected', async (ctx) => {
  // Negative controls on a real scrolled frame: an off-by-one mapping must not
  // match, and a stale row (row 4's pixels left in row 5) or a blank row must be
  // reported at exactly that row. (While scrolled the renderer redraws every row
  // each frame, so a one-shot renderer mutant cannot persist; mutate the frame.)
  const { fx, g } = await fixture(ctx);
  await wheelLines(ctx, g, 3);
  await fx.term.settle();
  const { image, grid } = await fx.term.capture();
  const expected = expectedViewport(fx, 3);
  ctx.checks.equal('baseline', viewportLines(image, grid), expected);
  ctx.checks.equal(
    'off-by-one-rejected',
    sameRows(viewportLines(image, grid), expectedViewport(fx, 4)),
    false
  );
  const stale = cloneImage(image);
  copyRow(stale, grid, 4, 5);
  const staleRows = viewportLines(stale, grid);
  ctx.checks.equal('stale-row-caught', wrongRows(staleRows, expected), [5]);
  ctx.checks.equal('stale-row-shows-previous-line', staleRows[5], expected[4]);
  const blank = cloneImage(image);
  fillRow(blank, grid, 7, THEME.background);
  ctx.checks.equal('blank-row-caught', viewportLines(blank, grid)[7], 'blank');
});

function sameRows(a: unknown[], b: unknown[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function wrongRows(actual: (number | string)[], expected: number[]): number[] {
  return actual.flatMap((line, row) => (line === expected[row] ? [] : [row]));
}

function copyRow(image: Image, grid: Grid, from: number, to: number): void {
  const h = Math.round(grid.cellH);
  const stride = image.width * 4;
  image.data.copyWithin(to * h * stride, from * h * stride, (from + 1) * h * stride);
}

function fillRow(image: Image, grid: Grid, row: number, hex: string): void {
  const [r, g, b] = parseHex(hex);
  const h = Math.round(grid.cellH);
  for (let i = row * h * image.width * 4; i < (row + 1) * h * image.width * 4; i += 4) {
    image.data.set([r, g, b, 255], i);
  }
}
