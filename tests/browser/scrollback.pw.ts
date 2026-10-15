/**
 * Scrollback through real input: page.mouse wheel and scrollbar drags over a
 * history of uniquely colour-marked, numbered lines.
 *
 * Oracle: the line each viewport row shows is decoded from its marker pixels
 * and compared with the mapping implied by the fixture (line N is the N-th
 * written line) and the user's actions (lines scrolled). Viewport state from
 * the public API is only used for waits and state/pixel consistency.
 *
 * Native preserves viewed history on output and follows actual typed input.
 * The archived legacy backend retains its explicit jump-on-output policy.
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
  // Required legacy characterization, retained unchanged. Native's intentional
  // preservation policy has its own required assertion below.
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

rtest('scroll.output-at-bottom-follows-newest-rows', async (ctx) => {
  // Following live output is unchanged; only scrolled-back reading is pinned.
  const { fx } = await fixture(ctx);
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
  // Approved native policy: keep the same content, not the same bottom offset.
  // The original gap assertion is unchanged.
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

rtest('scroll.user-input-resumes-following', async (ctx) => {
  const { fx, g } = await fixture(ctx);
  await wheelLines(ctx, g, 20);
  await fx.term.clearEvents();
  await fx.term.clickCell(1, 1);
  await ctx.harness.page.keyboard.press('x');
  const data = (await fx.term.events()).data.join('');
  ctx.checks.equal('key-forwarded', data, 'x');
  await fx.term.writeAndSettle(data); // deterministic PTY echo
  ctx.checks.equal('key-echo-at-bottom', (await fx.term.viewport()).viewportY, 0);
  await wheelLines(ctx, g, 20);
  await fx.term.clearEvents();
  await fx.term.paste('pasted');
  const paste = (await fx.term.events()).data.join('');
  ctx.checks.equal('paste-forwarded', paste, 'pasted');
  await fx.term.writeAndSettle(paste);
  ctx.checks.equal('paste-echo-at-bottom', (await fx.term.viewport()).viewportY, 0);
});

rtest('scroll.fractional-wheel-survives-streaming-output', async (ctx) => {
  const { fx, g } = await fixture(ctx);
  for (let i = 0; i < 20; i++) {
    await wheelPixels(ctx, g, -g.cellH / 4);
    await fx.term.writeAndSettle('');
  }
  ctx.checks.equal('accumulated-rows', (await fx.term.viewport()).viewportY, 5);
  ctx.checks.equal('displayed-content', await shownLines(fx), expectedViewport(fx, 5));
});

rtest('scroll.clear-output-is-chunk-independent', async (ctx) => {
  for (const sequence of ['\x1bc', '\x1b[3J', '\x1b[H\x1b[2J\x1b[3J']) {
    const split = await fixture(ctx);
    const combined = await fixture(ctx);
    await split.fx.term.scrollLines(-20);
    await combined.fx.term.scrollLines(-20);
    const output = `\x1b[?25l\r\n${linesBytes(30, TOTAL)}`;
    await split.fx.term.writeAndSettle(sequence);
    await split.fx.term.writeAndSettle(output);
    await combined.fx.term.writeAndSettle(sequence + output);
    ctx.checks.equal('split-bottom', (await split.fx.term.viewport()).viewportY, 0);
    ctx.checks.equal('combined-bottom', (await combined.fx.term.viewport()).viewportY, 0);
    ctx.checks.equal(
      'same-visible-rows',
      await shownLines(combined.fx),
      await shownLines(split.fx)
    );
  }
});

rtest('scroll.resize-taller-clamps-history', async (ctx) => {
  const { fx } = await fixture(ctx);
  await fx.term.scrollToTop();
  const oldRows = await shownLines(fx);
  const before = await fx.term.viewport();
  await fx.term.resize(COLS, ROWS + 6);
  await fx.term.settle();
  const after = await fx.term.viewport();
  ctx.checks.equal('history-pulled', after.scrollbackLength, before.scrollbackLength - 6);
  ctx.checks.equal('clamped-at-top', after.viewportY, after.scrollbackLength);
  ctx.checks.equal('top-rows-painted', (await shownLines(fx)).slice(0, ROWS), oldRows);
});

rtest('scroll.reentrant-observer-keeps-wheel-responsive', async (ctx) => {
  const { fx, g } = await fixture(ctx, 100);
  await ctx.harness.page.evaluate(
    (id) => window.__ghosttyRegression.navigateOnNextScroll(id, 10),
    fx.term.id
  );
  await wheelLines(ctx, g, 5);
  await ctx.harness.page.waitForFunction(
    (id) => window.__ghosttyRegression.viewport(id).viewportY === 10,
    fx.term.id
  );
  await wheelLines(ctx, g, 3);
  await ctx.harness.page.waitForFunction(
    (id) => window.__ghosttyRegression.viewport(id).viewportY === 13,
    fx.term.id
  );
  ctx.checks.equal('rows-after-next-gesture', await shownLines(fx), expectedViewport(fx, 13));
});

rtest('scroll.clear-at-shell-prompt-preserves-viewed-rows', async (ctx) => {
  const { fx, g } = await fixture(ctx);
  await fx.term.writeAndSettle('\r\n\x1b]133;A\x07$ ');
  await wheelLines(ctx, g, 20);
  const before = await fx.term.viewport();
  const expected = Array.from({ length: ROWS }, (_, row) => TOTAL + 1 - ROWS - 20 + row);
  ctx.checks.equal('rows-before-clear', await shownLines(fx), expected);
  await fx.term.clearEvents();
  await ctx.harness.page.evaluate((id) => window.__ghosttyRegression.clear(id), fx.term.id);
  await fx.term.settle();
  const after = await fx.term.viewport();
  ctx.checks.equal(
    'semantic-clear-grows-history',
    after.scrollbackLength > before.scrollbackLength,
    true
  );
  ctx.checks.equal(
    'anchor-offset',
    after.viewportY,
    before.viewportY + after.scrollbackLength - before.scrollbackLength
  );
  ctx.checks.equal('rows-after-clear', await shownLines(fx), expected);
  ctx.checks.equal('scroll-notified', (await fx.term.events()).scrolls, [after.viewportY]);
});

rtest('scroll.thumb-drag-preserves-anchor-during-output', async (ctx) => {
  const { fx, g } = await fixture(ctx);
  await wheelLines(ctx, g, 20);
  const before = await shownLines(fx);
  const initial = await fx.term.viewport();
  const track = g.rect.height - 8;
  const thumb = Math.max(20, (ROWS / (initial.scrollbackLength + ROWS)) * track);
  const x = g.rect.left + g.rect.width - 8;
  const y = Math.round(
    g.rect.top +
      4 +
      (track - thumb) * (1 - initial.viewportY / initial.scrollbackLength) +
      thumb / 2
  );
  const mouse = ctx.harness.page.mouse;
  await mouse.move(x, y);
  await mouse.down();
  try {
    await fx.term.writeAndSettle(`\r\n${linesBytes(5, TOTAL)}`);
    const anchored = await fx.term.viewport();
    ctx.checks.equal('output-anchor', anchored.viewportY, 25);
    ctx.checks.equal('output-keeps-rows', await shownLines(fx), before);
    await mouse.move(x + 1, y);
    ctx.checks.equal('horizontal-motion-keeps-offset', (await fx.term.viewport()).viewportY, 25);
    ctx.checks.equal('horizontal-motion-keeps-rows', await shownLines(fx), before);
    const travel = track - Math.max(20, (ROWS / (anchored.scrollbackLength + ROWS)) * track);
    await mouse.move(x + 1, y - 12);
    const expected = 25 + Math.round((12 * anchored.scrollbackLength) / travel);
    ctx.checks.equal(
      'vertical-motion-still-scrolls',
      (await fx.term.viewport()).viewportY,
      expected
    );
    const top = TOTAL + 5 - ROWS - expected;
    ctx.checks.equal(
      'vertical-motion-paints-rows',
      await shownLines(fx),
      Array.from({ length: ROWS }, (_, i) => top + i)
    );
  } finally {
    await mouse.up();
  }
});

rtest('scroll.thumb-takeover-settles-to-whole-rows', async (ctx) => {
  const { fx, g } = await fixture(ctx, 1000);
  await fx.term.clearEvents();
  await wheelLines(ctx, g, 20);
  const state = await fx.term.viewport();
  const track = g.rect.height - 8;
  const thumb = Math.max(20, (ROWS / (state.scrollbackLength + ROWS)) * track);
  const travel = track - thumb;
  const x = g.rect.left + g.rect.width - 8;
  const y = Math.round(
    g.rect.top + 4 + travel * (1 - state.viewportY / state.scrollbackLength) + thumb / 2
  );
  const mouse = ctx.harness.page.mouse;
  await mouse.move(x, y);
  await mouse.down();
  try {
    ctx.checks.equal('wheel-intent-settled', (await fx.term.viewport()).viewportY, 20);
    await mouse.move(x, y - 8);
  } finally {
    await mouse.up();
  }
  await fx.term.settle();
  const expected = 20 + Math.round((8 * state.scrollbackLength) / travel);
  ctx.checks.equal('drag-ends-at-whole-row', (await fx.term.viewport()).viewportY, expected);
  ctx.checks.equal(
    'integer-scroll-events',
    (await fx.term.events()).scrolls.every(Number.isInteger),
    true
  );
  ctx.checks.equal('rows-match-drag', await shownLines(fx), expectedViewport(fx, expected));
});

rtest('scroll.nested-resize-delivers-final-position', async (ctx) => {
  const { fx } = await fixture(ctx);
  await fx.term.scrollToTop();
  const before = await fx.term.viewport();
  await fx.term.clearEvents();
  await ctx.harness.page.evaluate(
    (id) => window.__ghosttyRegression.resizeOnNextResize(id, 41, 18),
    fx.term.id
  );
  await fx.term.resize(COLS, ROWS + 6);
  await fx.term.settle();
  const after = await fx.term.viewport();
  ctx.checks.equal('nested-dimensions', [after.cols, after.rows], [41, 18]);
  ctx.checks.equal('clamped-offset', after.viewportY, before.scrollbackLength - 6);
  ctx.checks.equal('one-final-scroll-event', (await fx.term.events()).scrolls, [after.viewportY]);
});

rtest('scroll.continuous-frame-aligned-input-progresses-during-gesture', async (ctx) => {
  const { fx, g } = await fixture(ctx, 100); // deprecated value must not resurrect easing
  await ctx.harness.page.evaluate(
    ([id, cellHeight]) => {
      const probe = {
        pixels: 0,
        samples: [] as { expected: number; actual: number }[],
        remove: () => {},
      };
      const host = document.querySelector('.host')!;
      const listener = (event: Event) => {
        const wheel = event as WheelEvent;
        probe.pixels -= wheel.deltaY;
        probe.samples.push({
          expected: Math.trunc(probe.pixels / cellHeight + 1e-9),
          actual: window.__ghosttyRegression.viewport(id).viewportY,
        });
      };
      host.addEventListener('wheel', listener, true);
      probe.remove = () => host.removeEventListener('wheel', listener, true);
      (window as unknown as { scrollProbe: typeof probe }).scrollProbe = probe;
    },
    [fx.term.id, g.cellH] as const
  );
  const cdp = await ctx.harness.page.context().newCDPSession(ctx.harness.page);
  try {
    await cdp.send('Input.synthesizeScrollGesture', {
      x: g.rect.left + g.rect.width / 3,
      y: g.rect.top + g.rect.height / 2,
      yDistance: 400,
      speed: 1200,
      gestureSourceType: 'mouse',
      preventFling: true,
    });
    const samples = await ctx.harness.page.evaluate(() => {
      const probe = (
        window as unknown as {
          scrollProbe: { samples: { expected: number; actual: number }[]; remove(): void };
        }
      ).scrollProbe;
      probe.remove();
      return probe.samples;
    });
    ctx.checks.equal('multiple-input-frames', samples.length > 3, true);
    ctx.checks.equal(
      'progress-at-every-wheel-event',
      samples.map((s) => s.actual),
      samples.map((s) => s.expected)
    );
    ctx.checks.equal(
      'meaningful-progress-before-end',
      samples.slice(0, -1).some((s) => s.actual > 5),
      true
    );
    const final = samples.at(-1)!.expected;
    ctx.checks.equal(
      'rows-follow-native-position',
      await shownLines(fx),
      expectedViewport(fx, final)
    );
  } finally {
    await cdp.detach();
  }
});
