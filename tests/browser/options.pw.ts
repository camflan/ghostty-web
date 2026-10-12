/**
 * Option/appearance lane: constructor colours, font family/size, runtime
 * option changes. Fonts are checked against an independent canvas oracle (the
 * requested vendored font drawn directly, no terminal code) with positive
 * controls proving the two vendored fonts — and two sizes — really differ, so
 * two wrong paths cannot both pass. Font cases use bare family names (no
 * fallback): the primary DejaVu Sans Mono may also be the system `monospace`.
 *
 * Required/gap membership for this lane lives in scope.json.
 */

import { test } from '@playwright/test';
import {
  GlyphOracles,
  type GlyphProbe,
  checkGlyphs,
  glyphMismatch,
  oraclesDiffer,
} from './scenes/oracle';
import {
  type BrowserTerminal,
  type CaseContext,
  expectProbe,
  expectSameCells,
  rtest,
} from './support/fixture';
import type { CreateOptions, RuntimeOptions, ThemeSpec } from './support/harness-api';
import { cellCore, diffCells, uniformColor } from './support/pixels';

/** Two unrelated, non-default themes; no colour is #000000 (WEB-04 sentinel). */
const THEME_A = {
  background: '#14213d',
  foreground: '#fca311',
  cursor: '#e63946',
  cursorAccent: '#a8dadc',
  selectionBackground: '#2a9d8f',
  selectionForeground: '#f1faee',
  black: '#22223b',
  red: '#d62828',
  blue: '#457b9d',
} as const satisfies ThemeSpec;

const THEME_B = {
  background: '#f4f1de',
  foreground: '#3d405b',
  cursor: '#81b29a',
  cursorAccent: '#6d2e46',
  selectionBackground: '#f2cc8f',
  selectionForeground: '#264653',
  black: '#2b2d42',
  red: '#9b2226',
  blue: '#0a9396',
} as const satisfies ThemeSpec;

/**
 * Probe glyphs, each separated by two blank cells (overflow stays in the probe
 * region). Three blank columns on the right keep content out of the 14px
 * scrollbar strip, which a font change blanks (OPT-01, its own case below).
 */
const GLYPHS = ['A', 'g', '@', 'W', 'm', '0', 'Q', 'k'] as const;
const GLYPH_ROW = ` ${GLYPHS.join('  ')}`;
const GLYPH_COLS = 1 + 3 * (GLYPHS.length - 1) + 4;

function families(ctx: CaseContext): { primary: string; alternate: string } {
  const fonts = ctx.harness.info.fonts;
  if (!fonts.alternate) throw new Error('fonts/font.json has no alternate font');
  return { primary: fonts.primary.family, alternate: fonts.alternate.family };
}

function glyphProbes(
  fontFamily: string,
  fontSize: number,
  theme: ThemeSpec = THEME_A
): GlyphProbe[] {
  return GLYPHS.map((text, i) => ({
    row: 0,
    col: 1 + 3 * i,
    text,
    foreground: theme.foreground ?? '',
    background: theme.background ?? '',
    fontFamily,
    fontSize,
  }));
}

/**
 * Glyph row, a blank row, then palette-coloured text; the cursor stays after
 * the text (left of the scrollbar strip). No block elements: U+2588 overflows
 * its cell vertically and would leak ink into neighbouring probe regions.
 */
async function writeGlyphScene(term: BrowserTerminal): Promise<void> {
  await term.writeAndSettle(`${GLYPH_ROW}\r\n\r\n\x1b[31mmixed\x1b[0m Text 42`);
}

async function renderGlyphs(ctx: CaseContext, fontFamily: string, fontSize: number) {
  const term = await ctx.harness.create({
    cols: GLYPH_COLS,
    rows: 3,
    theme: THEME_A,
    fontFamily,
    fontSize,
  });
  await writeGlyphScene(term);
  return { term, capture: await term.capture(), metrics: await term.cellMetrics() };
}

// --- Constructor colours -------------------------------------------------------

async function probeThemeColors(ctx: CaseContext, theme: typeof THEME_A | typeof THEME_B) {
  const term = await ctx.harness.create({ cols: 12, rows: 3, theme });
  // Row 0: default-fg block, palette red block, palette blue background, a block to select.
  // Cursor (block) parked on a blank cell of row 2.
  await term.write('\u2588 \x1b[31m\u2588\x1b[0m \x1b[44m \x1b[0m \u2588\x1b[3;3H');
  // Selection: row 0 cols 6..11 (incl. the block) and row 1 cols 0..3.
  await term.select(6, 0, 10);
  await term.settle();
  const { image, grid } = await term.capture();
  const core = (row: number, col: number) => uniformColor(image, cellCore(grid, row, col));

  // A block glyph under the cursor is redrawn in cursorAccent.
  const accentTerm = await ctx.harness.create({ cols: 4, rows: 1, theme });
  await accentTerm.writeAndSettle('\u2588\x1b[1;1H');
  const accent = await accentTerm.capture();
  return {
    image,
    probes: {
      background: core(2, 8),
      foreground: core(0, 0),
      red: core(0, 2),
      blueBackground: core(0, 4),
      selectionForeground: core(0, 6),
      selectionBackground: core(1, 1),
      cursor: core(2, 2),
      cursorAccent: uniformColor(accent.image, cellCore(accent.grid, 0, 0)),
    },
  };
}

rtest('options.ctor-theme-colors', async (ctx) => {
  for (const [label, theme] of [
    ['a', THEME_A],
    ['b', THEME_B],
  ] as const) {
    const { image, probes } = await probeThemeColors(ctx, theme);
    const expected = {
      background: theme.background,
      foreground: theme.foreground,
      red: theme.red,
      blueBackground: theme.blue,
      selectionForeground: theme.selectionForeground,
      selectionBackground: theme.selectionBackground,
      cursor: theme.cursor,
      cursorAccent: theme.cursorAccent,
    };
    if (JSON.stringify(probes) !== JSON.stringify(expected)) {
      await ctx.testInfo.attach(`theme-${label}.json`, { body: JSON.stringify(probes, null, 2) });
    }
    await expectProbe(ctx, `theme-${label}-colors`, probes, expected, image);
  }
});

// --- Font family -------------------------------------------------------------------

/**
 * Direct font case: the terminal configured with ONE bare family must match
 * that family's oracle glyph for glyph, and must not match the other family.
 * The oracle-vs-oracle control proves the two fonts are distinguishable at all.
 */
async function expectFamily(ctx: CaseContext, family: 'primary' | 'alternate') {
  const names = families(ctx);
  const own = names[family];
  const other = family === 'primary' ? names.alternate : names.primary;
  const oracles = new GlyphOracles(ctx.harness);
  const { capture, metrics } = await renderGlyphs(ctx, own, 15);
  const dpr = ctx.harness.info.dpr;

  const indistinct: string[] = [];
  for (const [i, probe] of glyphProbes(own, 15).entries()) {
    const mine = await oracles.forProbe(probe);
    const theirs = await oracles.forProbe(glyphProbes(other, 15)[i]);
    if (!oraclesDiffer(mine, theirs, probe.background)) indistinct.push(probe.text);
  }
  ctx.checks.equal('control-fonts-distinguishable', indistinct, []);

  const mismatches = await checkGlyphs(oracles, capture, metrics, dpr, glyphProbes(own, 15));
  ctx.checks.equal('glyphs-match-own-family', mismatches, []);

  const matchingOther: string[] = [];
  for (const probe of glyphProbes(other, 15)) {
    const oracle = await oracles.forProbe(probe);
    if (!glyphMismatch(capture.image, capture.grid, metrics, dpr, probe, oracle)) {
      matchingOther.push(probe.text);
    }
  }
  ctx.checks.equal('glyphs-differ-from-other-family', matchingOther, []);
}

rtest('options.font-family-alternate-bare', (ctx) => expectFamily(ctx, 'alternate'));
rtest('options.font-family-primary-bare', (ctx) => expectFamily(ctx, 'primary'));

// --- Font size -----------------------------------------------------------------------

/**
 * The bold alternate has the same advance as the primary, so re-measurement is
 * proven by size: the cell pitch must be the advance rounded up to whole CSS
 * pixels, every probe glyph must match the oracle at that size and fit its cell.
 */
rtest('options.font-size-remeasures', async (ctx) => {
  const { primary } = families(ctx);
  const oracles = new GlyphOracles(ctx.harness);
  const dpr = ctx.harness.info.dpr;
  const widths: number[] = [];
  for (const size of [20, 26]) {
    const sameAsBase: string[] = [];
    for (const probe of glyphProbes(primary, size)) {
      const base = await oracles.forProbe({ ...probe, fontSize: 15 });
      if (!oraclesDiffer(await oracles.forProbe(probe), base, probe.background)) {
        sameAsBase.push(probe.text);
      }
    }
    ctx.checks.equal(`control-size-${size}-differs-from-15`, sameAsBase, []);

    const { term, capture, metrics } = await renderGlyphs(ctx, primary, size);
    const advance = (
      await oracles.get({
        text: 'M',
        fontFamily: primary,
        fontSize: size,
        foreground: '#ffffff',
        background: '#000000',
      })
    ).raw.advance;
    const rect = await term.canvasRect();
    ctx.checks.equal(
      `geometry-${size}`,
      { cellWidth: metrics.width, canvas: [rect.width, rect.height] },
      { cellWidth: Math.ceil(advance), canvas: [GLYPH_COLS * metrics.width, 3 * metrics.height] }
    );
    ctx.checks.equal(
      `glyphs-${size}`,
      await checkGlyphs(oracles, capture, metrics, dpr, glyphProbes(primary, size)),
      []
    );
    widths.push(metrics.width);
  }
  ctx.checks.equal('sizes-remeasured', new Set(widths).size, widths.length);
});

// --- Runtime font changes ------------------------------------------------------------

/**
 * Apply `changes` one by one through `terminal.options`; after each, the live
 * terminal must equal a fresh terminal constructed with the final options
 * (same canvas size, metrics, and every cell exactly) and match the oracle.
 */
async function expectRuntimeMatchesFresh(
  ctx: CaseContext,
  start: { fontFamily: string; fontSize: number },
  changes: Required<Pick<RuntimeOptions, 'fontFamily' | 'fontSize'>>[]
): Promise<void> {
  const oracles = new GlyphOracles(ctx.harness);
  const dpr = ctx.harness.info.dpr;
  const base: CreateOptions = { cols: GLYPH_COLS, rows: 3, theme: THEME_A };
  const live = await ctx.harness.create({ ...base, ...start });
  await writeGlyphScene(live);
  const before = await live.capture();
  let previous = before;
  ctx.checks.equal(
    'control-start-matches-start-font',
    await checkGlyphs(
      oracles,
      before,
      await live.cellMetrics(),
      dpr,
      glyphProbes(start.fontFamily, start.fontSize)
    ),
    []
  );

  for (const [step, change] of changes.entries()) {
    await live.setOptions(change);
    await live.settle();
    const actual = await live.capture();
    const fresh = await ctx.harness.create({ ...base, ...change });
    await writeGlyphScene(fresh);
    const expected = await fresh.capture();
    const liveMetrics = await live.cellMetrics();
    const liveRect = await live.canvasRect();
    const freshRect = await fresh.canvasRect();
    ctx.checks.equal(
      `step-${step}-geometry`,
      {
        metrics: liveMetrics,
        css: [liveRect.width, liveRect.height],
        device: [actual.raw.width, actual.raw.height],
      },
      {
        metrics: await fresh.cellMetrics(),
        css: [freshRect.width, freshRect.height],
        device: [expected.raw.width, expected.raw.height],
      }
    );
    await expectSameCells(
      ctx,
      `step-${step}-cells-equal-fresh`,
      actual.image,
      expected.image,
      expected.grid
    );
    ctx.checks.equal(
      `step-${step}-glyphs-match-oracle`,
      await checkGlyphs(
        oracles,
        actual,
        liveMetrics,
        dpr,
        glyphProbes(change.fontFamily, change.fontSize)
      ),
      []
    );
    // Positive control: the change was visible at all.
    ctx.checks.equal(
      `step-${step}-control-render-changed`,
      diffCells(actual.image, previous.image, actual.grid).length > 0,
      true
    );
    await fresh.dispose();
    previous = actual;
  }
}

rtest('options.runtime-font-size-matches-fresh', async (ctx) => {
  const { primary } = families(ctx);
  await expectRuntimeMatchesFresh(ctx, { fontFamily: primary, fontSize: 15 }, [
    { fontFamily: primary, fontSize: 24 },
    { fontFamily: primary, fontSize: 12 },
  ]);
});

rtest('options.runtime-font-family-matches-fresh', async (ctx) => {
  const { primary, alternate } = families(ctx);
  await expectRuntimeMatchesFresh(ctx, { fontFamily: primary, fontSize: 15 }, [
    { fontFamily: alternate, fontSize: 15 },
    { fontFamily: primary, fontSize: 15 },
  ]);
});

test.describe('device scale factor 2', () => {
  // handleFontChange rewrites the canvas size without DPR; the result must still
  // equal a fresh terminal at an integer DPR (fractional DPR is covered by dpr.pw.ts).
  test.use({ deviceScaleFactor: 2 });
  rtest('options.runtime-font-size-matches-fresh-at-2x', async (ctx) => {
    ctx.checks.equal('dpr', ctx.harness.info.dpr, 2);
    const { primary, alternate } = families(ctx);
    await expectRuntimeMatchesFresh(ctx, { fontFamily: primary, fontSize: 15 }, [
      { fontFamily: alternate, fontSize: 21 },
    ]);
  });
});

/**
 * OPT-01: handleFontChange renders without the scrollbar opacity, so the
 * renderer's scrollbar pass blanks the right 14 CSS px of every row; rows that
 * are not redrawn afterwards keep the hole. Content reaches the last column.
 */
rtest('options.runtime-font-change-keeps-right-edge', async (ctx) => {
  const { primary } = families(ctx);
  const text = 'edge-to-edge 0123456789';
  const write = (term: BrowserTerminal) => term.writeAndSettle(`${text}\r\n`);
  const base: CreateOptions = { cols: text.length, rows: 2, theme: THEME_A, fontFamily: primary };
  const live = await ctx.harness.create({ ...base, fontSize: 15 });
  await write(live);
  await live.setOptions({ fontSize: 20 });
  await live.settle();
  const actual = await live.capture();
  const fresh = await ctx.harness.create({ ...base, fontSize: 20 });
  await write(fresh);
  const expected = await fresh.capture();
  await expectSameCells(
    ctx,
    'right-edge-equals-fresh',
    actual.image,
    expected.image,
    expected.grid
  );
});

/**
 * OPT-02: cell height comes from the ink box of 'M', so at some sizes glyphs
 * taller than 'M' (the dot of j, |, parentheses) are clipped by the canvas
 * edge or the next row. 15px (the lane default) happens to fit.
 */
rtest('options.font-size-13-tall-glyphs-fit-cell', async (ctx) => {
  const { primary } = families(ctx);
  const oracles = new GlyphOracles(ctx.harness);
  const tall = ['j', 'g', '|', '('];
  const term = await ctx.harness.create({
    cols: 3 * tall.length + 1,
    rows: 3,
    theme: THEME_A,
    fontFamily: primary,
    fontSize: 13,
  });
  await term.writeAndSettle(` ${tall.join('  ')}\r\n\r\n`);
  const probes = tall.map((text, i) => ({
    row: 0,
    col: 1 + 3 * i,
    text,
    foreground: THEME_A.foreground,
    background: THEME_A.background,
    fontFamily: primary,
    fontSize: 13,
  }));
  ctx.checks.equal(
    'tall-glyphs-match-oracle',
    await checkGlyphs(
      oracles,
      await term.capture(),
      await term.cellMetrics(),
      ctx.harness.info.dpr,
      probes
    ),
    []
  );
});

// --- Runtime theme (desired behaviour; currently only console.warn) -----------------

rtest('options.runtime-theme-applies', async (ctx) => {
  const write = (term: BrowserTerminal) =>
    term.writeAndSettle('\u2588 \x1b[31m\u2588\x1b[0m\x1b[3;12H');
  const live = await ctx.harness.create({ cols: 12, rows: 3, theme: THEME_A });
  await write(live);
  await live.setOptions({ theme: THEME_B });
  await live.settle();
  const actual = await live.capture();
  const core = (row: number, col: number) =>
    uniformColor(actual.image, cellCore(actual.grid, row, col));
  ctx.checks.equal(
    'runtime-theme-colors',
    { background: core(1, 5), foreground: core(0, 0), red: core(0, 2) },
    { background: THEME_B.background, foreground: THEME_B.foreground, red: THEME_B.red }
  );
  const fresh = await ctx.harness.create({ cols: 12, rows: 3, theme: THEME_B });
  await write(fresh);
  const expected = await fresh.capture();
  await expectSameCells(
    ctx,
    'runtime-theme-equals-fresh',
    actual.image,
    expected.image,
    expected.grid
  );
});
