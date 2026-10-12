/**
 * Selection through real page.mouse drags: forward/reverse, multi-line,
 * soft-wrap, wide + combining characters, history, edge auto-scroll, new
 * output, pruning and reflow.
 *
 * Oracles (independent of the selection code under test):
 * - copied text = the fixture text between the dragged cells (Ghostty's
 *   selection string semantics: soft wraps unwrap, wide spacers add nothing);
 * - highlight = the linear selection region between the anchor and end cells,
 *   classified per cell from background pixels (glyph ink ignored), and every
 *   cell outside it must keep a non-selection background;
 * - intended policy: selections are anchored to content (they follow output,
 *   pruning and reflow) and only paint where that content is on screen.
 */

import { type BrowserTerminal, type CaseContext, rtest, test } from './support/fixture';
import {
  type Geometry,
  cellPoint,
  copiedText,
  drag,
  expectedHighlight,
  expectedViewport,
  geometry,
  highlightMap,
  historyFixture,
  lineText,
  linesBytes,
  seedClipboard,
  wheelLines,
} from './support/interaction';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

type Ctx = CaseContext;
type Cell = { row: number; col: number };

/** Drag from the left quarter of `from` to the right quarter of `to`; return clipboard text. */
async function dragSelect(ctx: Ctx, g: Geometry, from: Cell, to: Cell): Promise<string> {
  const seed = `seed-${Math.random()}`;
  await seedClipboard(ctx, seed);
  const forward = from.row < to.row || (from.row === to.row && from.col <= to.col);
  await drag(
    ctx,
    cellPoint(g, from.row, from.col, forward ? 0.25 : 0.75),
    cellPoint(g, to.row, to.col, forward ? 0.75 : 0.25)
  );
  return copiedText(ctx, seed);
}

/** Per-cell highlight map of the settled frame; `strip` = columns under the overlay scrollbar. */
async function highlight(term: BrowserTerminal, strip: ReadonlySet<number> = NONE) {
  await term.settle();
  const { image, grid } = await term.capture();
  return highlightMap(image, grid, strip);
}

const NONE: ReadonlySet<number> = new Set();
/** The overlay scrollbar paints over the last ~14 CSS px (WEB-11); exclude those columns. */
const STRIP_40 = new Set([38, 39]);
const STRIP_20 = new Set([18, 19]);

async function textTerminal(ctx: Ctx, cols: number, rows: number, text: string) {
  const term = await ctx.harness.create({ cols, rows, smoothScrollDuration: 0 });
  await term.writeAndSettle(text);
  return term;
}

rtest('selection.drag-forward-and-reverse-copy-and-highlight', async (ctx) => {
  const term = await textTerminal(
    ctx,
    30,
    6,
    'alpha one\r\nbravo two\r\ncharlie three\r\ndelta four'
  );
  const g = await geometry(term);
  const a = { row: 0, col: 2 };
  const b = { row: 2, col: 4 };
  const want = 'pha one\nbravo two\ncharl';
  const expected = expectedHighlight(6, 30, a, b);
  ctx.checks.equal('forward-copied', await dragSelect(ctx, g, a, b), want);
  ctx.checks.equal('forward-selection', await term.selection(), want);
  ctx.checks.equal('forward-highlight', await highlight(term), expected);
  ctx.checks.equal('reverse-copied', await dragSelect(ctx, g, b, a), want);
  ctx.checks.equal('reverse-highlight', await highlight(term), expected);
});

rtest('selection.control-shifted-or-missing-highlight-is-detected', async (ctx) => {
  // Negative controls for the highlight oracle on a real selection frame.
  const term = await textTerminal(ctx, 30, 6, 'alpha one\r\nbravo two\r\ncharlie three');
  const g = await geometry(term);
  await dragSelect(ctx, g, { row: 1, col: 3 }, { row: 1, col: 7 });
  const actual = await highlight(term);
  const right = expectedHighlight(6, 30, { row: 1, col: 3 }, { row: 1, col: 7 });
  ctx.checks.equal('baseline', actual, right);
  const same = (x: string[], y: string[]) => JSON.stringify(x) === JSON.stringify(y);
  const shiftedRow = expectedHighlight(6, 30, { row: 2, col: 3 }, { row: 2, col: 7 });
  const shiftedCol = expectedHighlight(6, 30, { row: 1, col: 4 }, { row: 1, col: 8 });
  ctx.checks.equal('wrong-row-rejected', same(actual, shiftedRow), false);
  ctx.checks.equal('shifted-column-rejected', same(actual, shiftedCol), false);
  await term.clearSelection();
  ctx.checks.equal(
    'cleared-paints-nothing',
    await highlight(term),
    expectedHighlight(6, 30, { row: 9, col: 0 }, { row: 9, col: 0 })
  );
});

rtest('selection.history-drag-copies-history-lines', async (ctx) => {
  const fx = await historyFixture(ctx.harness, { cols: 40, rows: 8, total: 600, minHistory: 500 });
  const g = await geometry(fx.term);
  await wheelLines(ctx, g, 100);
  const top = expectedViewport(fx, 100)[0];
  const a = { row: 2, col: 3 };
  const b = { row: 4, col: 9 };
  const want = [lineText(top + 2).slice(3), lineText(top + 3), lineText(top + 4).slice(0, 10)].join(
    '\n'
  );
  ctx.checks.equal('copied', await dragSelect(ctx, g, a, b), want);
  ctx.checks.equal('selection-matches-copy', await fx.term.selection(), want);
  ctx.checks.equal('viewport-unchanged-by-drag', (await fx.term.viewport()).viewportY, 100);
  ctx.checks.equal(
    'highlight',
    await highlight(fx.term, STRIP_40),
    expectedHighlight(8, 40, a, b, STRIP_40)
  );
});

rtest('selection.highlight-follows-content-offscreen-and-back', async (ctx) => {
  // xterm.js #4917 shape: a selection scrolled out of view must not paint;
  // partially visible selections are clipped; scrolling back restores it.
  const fx = await historyFixture(ctx.harness, { cols: 40, rows: 8, total: 600, minHistory: 500 });
  const g = await geometry(fx.term);
  await wheelLines(ctx, g, 100);
  const a = { row: 2, col: 3 };
  const b = { row: 4, col: 9 };
  const text = await dragSelect(ctx, g, a, b);
  await wheelLines(ctx, g, -3); // content moves up 3 rows: selection rows -1..1
  ctx.checks.equal(
    'clipped-highlight',
    await highlight(fx.term, STRIP_40),
    expectedHighlight(8, 40, { row: -1, col: 3 }, { row: 1, col: 9 }, STRIP_40)
  );
  await wheelLines(ctx, g, -6); // fully above the viewport
  ctx.checks.equal(
    'offscreen-paints-nothing',
    await highlight(fx.term, STRIP_40),
    expectedHighlight(8, 40, { row: -9, col: 0 }, { row: -9, col: 0 }, STRIP_40)
  );
  await wheelLines(ctx, g, 9);
  ctx.checks.equal(
    'restored-highlight',
    await highlight(fx.term, STRIP_40),
    expectedHighlight(8, 40, a, b, STRIP_40)
  );
  ctx.checks.equal('text-unchanged', await fx.term.selection(), text);
});

rtest('selection.edge-autoscroll-extends-into-history', async (ctx) => {
  const term = await textTerminal(ctx, 40, 6, linesBytes(30));
  const g = await geometry(term);
  const { scrollbackLength } = await term.viewport();
  ctx.checks.equal('history-rows', scrollbackLength, 24);
  const seed = `seed-${Math.random()}`;
  await seedClipboard(ctx, seed);
  const anchor = cellPoint(g, 4, 5, 0.25); // line 28, column 5
  const mouse = ctx.harness.page.mouse;
  await mouse.move(anchor.x, anchor.y);
  await mouse.down();
  await mouse.move(anchor.x, anchor.y - g.cellH, { steps: 2 });
  await mouse.move(anchor.x, g.rect.top - 40, { steps: 3 });
  await ctx.harness.page.waitForFunction(
    ([id, top]) => window.__ghosttyRegression.viewport(id).viewportY === top,
    [term.id, scrollbackLength] as const,
    { timeout: 5_000 }
  );
  await mouse.up();
  const copied = await copiedText(ctx, seed);
  const lines = copied.split('\n');
  // Start column at the clamped top edge is policy; the content between is not.
  ctx.checks.equal(
    'first-line-is-suffix-of-line-0',
    lineText(0).endsWith(lines[0]) && lines[0].length > 0,
    true
  );
  ctx.checks.equal(
    'middle-lines',
    lines.slice(1, -1),
    Array.from({ length: 27 }, (_, k) => lineText(k + 1))
  );
  ctx.checks.equal('last-line-ends-at-anchor', lines.at(-1), lineText(28).slice(0, 6));
  const map = await highlight(term, STRIP_40);
  ctx.checks.equal(
    'rows-below-top-fully-highlighted',
    map.slice(1),
    expectedHighlight(6, 40, { row: 1, col: 0 }, { row: 5, col: 39 }, STRIP_40).slice(1)
  );
});

rtest('selection.follows-content-when-output-scrolls', async (ctx) => {
  const term = await textTerminal(ctx, 40, 6, linesBytes(30));
  const g = await geometry(term);
  const a = { row: 3, col: 3 };
  const b = { row: 3, col: 7 };
  ctx.checks.equal('copied', await dragSelect(ctx, g, a, b), 'L0027');
  await term.writeAndSettle(`\r\n${linesBytes(2, 30)}`);
  ctx.checks.equal('text-after-output', await term.selection(), 'L0027');
  ctx.checks.equal(
    'highlight-moved-with-content',
    await highlight(term, STRIP_40),
    expectedHighlight(6, 40, { row: 1, col: 3 }, { row: 1, col: 7 }, STRIP_40)
  );
});

rtest('selection.soft-wrap-copies-without-newline', async (ctx) => {
  const term = await textTerminal(ctx, 10, 4, 'abcdefghijklmno\r\nnext');
  const g = await geometry(term);
  const a = { row: 0, col: 0 };
  const b = { row: 1, col: 4 };
  const copied = await dragSelect(ctx, g, a, b);
  ctx.checks.equal('highlight', await highlight(term), expectedHighlight(4, 10, a, b));
  ctx.checks.equal('selection-matches-copy', await term.selection(), copied);
  ctx.checks.equal('copied-unwraps-soft-wrap', copied, 'abcdefghijklmno');
});

rtest('selection.wide-and-combining-in-history', async (ctx) => {
  const fill = Array.from({ length: 8 }, (_, i) => `fill ${i}`).join('\r\n');
  const term = await textTerminal(ctx, 20, 4, `e\u0301 \u4e00x tail\r\n${fill}`);
  const g = await geometry(term);
  await wheelLines(ctx, g, 100); // to the top: the test line is history row 0
  ctx.checks.equal(
    'at-top',
    (await term.viewport()).viewportY,
    (await term.viewport()).scrollbackLength
  );
  const a = { row: 0, col: 0 };
  const b = { row: 0, col: 4 }; // é, space, 一 (cols 2-3), x
  const copied = await dragSelect(ctx, g, a, b);
  ctx.checks.equal(
    'highlight',
    await highlight(term, STRIP_20),
    expectedHighlight(4, 20, a, b, STRIP_20)
  );
  ctx.checks.equal('selection-matches-copy', await term.selection(), copied);
  ctx.checks.equal('copied-text', copied, 'e\u0301 \u4e00x');
});

rtest('selection.survives-history-pruning', async (ctx) => {
  // Content anchoring across pruning: the selected line is still retained after
  // the oldest page is dropped, so the selection must still copy it.
  // An explicit budget makes pruning occur on BOTH engines despite different
  // page sizes. The chosen newest line remains retained; the fixture verifies it.
  const fx = await historyFixture(ctx.harness, {
    cols: 80,
    rows: 8,
    total: 1000,
    minHistory: 900,
    limit: 1000,
  });
  const g = await geometry(fx.term);
  ctx.checks.equal(
    'copied',
    await dragSelect(ctx, g, { row: 7, col: 3 }, { row: 7, col: 7 }),
    'L0999'
  );
  await fx.term.writeAndSettle(`\r\n${linesBytes(200, 1000)}`);
  const oldest = Number((await fx.term.bufferLineText(0))?.trim().slice(1, 5));
  if (!(oldest > 0 && oldest <= 999)) {
    throw new Error(`FIXTURE: expected pruning that keeps line 999, oldest retained is ${oldest}`);
  }
  ctx.checks.equal('text-after-pruning', await fx.term.selection(), 'L0999');
});

rtest('selection.reflow-keeps-selected-content', async (ctx) => {
  const term = await textTerminal(ctx, 20, 4, '0123456789abcdefghij\r\nsecond\r\nthird');
  const g = await geometry(term);
  ctx.checks.equal(
    'copied',
    await dragSelect(ctx, g, { row: 1, col: 0 }, { row: 1, col: 5 }),
    'second'
  );
  await term.resize(10, 4);
  await term.settle();
  const reflowed = await Promise.all([0, 1, 2, 3].map((y) => term.bufferLineText(y)));
  if (
    JSON.stringify(reflowed) !== JSON.stringify(['0123456789', 'abcdefghij', 'second', 'third'])
  ) {
    throw new Error(`FIXTURE: unexpected reflow ${JSON.stringify(reflowed)}`);
  }
  ctx.checks.equal('text-after-reflow', await term.selection(), 'second');
});
