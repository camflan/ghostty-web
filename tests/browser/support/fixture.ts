/**
 * Playwright fixtures and case registration for the browser lane.
 *
 * - `rtest(id, body)` registers one scoped regression case (title = id) only when
 *   tests/browser/scope.json puts it in the running suite for the engine: the
 *   required suite (playwright.config.ts) or the gap suite
 *   (playwright.gaps.config.ts). The body runs through the strict shared
 *   `runRegression`: every failed assertion fails the test; there are no
 *   expected-failure signatures, waivers or unexpected-pass inversions.
 * - `controlTest(id, body)` registers a direct Playwright control (negative
 *   controls of the harness itself, catalogue integrity). Controls are required
 *   on every engine and are never part of a gap run.
 * - Uncaught page errors are collected separately and fail the test after the
 *   body; they are never caught or retried.
 * - Each test gets a fresh page; each terminal gets a fresh WASM instance.
 */

import { writeFileSync } from 'node:fs';
import { type Page, type TestInfo, test as base, expect } from '@playwright/test';
import {
  type EngineId,
  type RegressionChecks,
  runRegression,
} from '../../regression/support/regression';
import type { SuiteKind } from '../../regression/support/scope';
import type {
  BufferCellInfo,
  Capture,
  CellMetrics,
  CreateOptions,
  CssRect,
  GlyphOracleCapture,
  GlyphOracleRequest,
  PagePoint,
  ReadyInfo,
  RuntimeOptions,
  ScrollbarState,
  SelectionRange,
  TerminalEvents,
  ThemeSpec,
  ViewportState,
} from './harness-api';
import {
  type CompareOptions,
  EXACT,
  type Grid,
  type Image,
  decodeCapture,
  diffCells,
  diffImage,
  encodePng,
} from './pixels';

import {
  SUITE_METADATA_KEY,
  browserSuite,
  loadScopePlan,
  registersCase,
  registersControl,
  webEngine,
} from './suite';

export const HARNESS_PATH = '/tests/browser/harness.html';

/** Read once per process; parsing is strict (unknown/duplicate/unclassified fail). */
const SCOPE_PLAN = loadScopePlan();

/** Distinct colours so analytic probes can tell every layer apart. */
export const THEME = {
  background: '#202020',
  foreground: '#d0d0d0',
  cursor: '#00ff00',
  cursorAccent: '#202020',
  selectionBackground: '#3355ff',
  selectionForeground: '#ffffff',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  blue: '#2472c8',
  white: '#e5e5e5',
} as const satisfies ThemeSpec;

export class BrowserTerminal {
  constructor(
    readonly page: Page,
    readonly id: number
  ) {}

  write(data: string): Promise<void> {
    return this.page.evaluate(([id, d]) => window.__ghosttyRegression.write(id, d), [
      this.id,
      data,
    ] as const);
  }

  /** Write, then wait until the live render loop has produced a stable frame. */
  async writeAndSettle(data: string): Promise<void> {
    await this.write(data);
    await this.settle();
  }

  settle(): Promise<number> {
    return this.page.evaluate((id) => window.__ghosttyRegression.settle(id), this.id);
  }

  park(): Promise<void> {
    return this.page.evaluate((id) => window.__ghosttyRegression.park(id), this.id);
  }

  render(force: boolean, viewportY?: number): Promise<void> {
    return this.page.evaluate(
      ([id, f, v]) => window.__ghosttyRegression.render(id, f, v ?? undefined),
      [this.id, force, viewportY ?? null] as const
    );
  }

  async capture(): Promise<{ image: Image; grid: Grid; raw: Capture }> {
    const raw = await this.page.evaluate((id) => window.__ghosttyRegression.capture(id), this.id);
    return { ...decodeCapture(raw), raw };
  }

  events(): Promise<TerminalEvents> {
    return this.page.evaluate((id) => window.__ghosttyRegression.events(id), this.id);
  }

  clearEvents(): Promise<void> {
    return this.page.evaluate((id) => window.__ghosttyRegression.clearEvents(id), this.id);
  }

  cellCenter(row: number, col: number): Promise<PagePoint> {
    return this.page.evaluate(([id, r, c]) => window.__ghosttyRegression.cellCenter(id, r, c), [
      this.id,
      row,
      col,
    ] as const);
  }

  /** Click inside the canvas so the terminal's textarea owns keyboard focus. */
  async clickCell(row: number, col: number): Promise<void> {
    const p = await this.cellCenter(row, col);
    await this.page.mouse.click(p.x, p.y);
  }

  spyResize(): Promise<void> {
    return this.page.evaluate((id) => window.__ghosttyRegression.spyResize(id), this.id);
  }

  resizeCount(): Promise<number> {
    return this.page.evaluate((id) => window.__ghosttyRegression.resizeCount(id), this.id);
  }

  spyViewportDecode(): Promise<void> {
    return this.page.evaluate((id) => window.__ghosttyRegression.spyViewportDecode(id), this.id);
  }

  viewportDecodeCount(): Promise<number> {
    return this.page.evaluate((id) => window.__ghosttyRegression.viewportDecodeCount(id), this.id);
  }

  skipNextRowRedraw(row: number): Promise<void> {
    return this.page.evaluate(([id, r]) => window.__ghosttyRegression.skipNextRowRedraw(id, r), [
      this.id,
      row,
    ] as const);
  }

  selection(): Promise<string> {
    return this.page.evaluate((id) => window.__ghosttyRegression.selection(id), this.id);
  }

  paste(text: string): Promise<void> {
    return this.page.evaluate(([id, t]) => window.__ghosttyRegression.paste(id, t), [
      this.id,
      text,
    ] as const);
  }

  resize(cols: number, rows: number): Promise<void> {
    return this.page.evaluate(([id, c, r]) => window.__ghosttyRegression.resize(id, c, r), [
      this.id,
      cols,
      rows,
    ] as const);
  }

  scrollbackLength(): Promise<number> {
    return this.page.evaluate((id) => window.__ghosttyRegression.scrollbackLength(id), this.id);
  }

  mode(mode: number): Promise<boolean> {
    return this.page.evaluate(([id, m]) => window.__ghosttyRegression.mode(id, m), [
      this.id,
      mode,
    ] as const);
  }

  hostChildCount(): Promise<number> {
    return this.page.evaluate((id) => window.__ghosttyRegression.hostChildCount(id), this.id);
  }

  // --- Options (public `terminal.options` proxy) ---

  setOptions(options: RuntimeOptions): Promise<void> {
    return this.page.evaluate(([id, o]) => window.__ghosttyRegression.setOptions(id, o), [
      this.id,
      options,
    ] as const);
  }

  cellMetrics(): Promise<CellMetrics> {
    return this.page.evaluate((id) => window.__ghosttyRegression.cellMetrics(id), this.id);
  }

  // --- Viewport, scrolling and selection (public Terminal API) ---

  viewport(): Promise<ViewportState> {
    return this.page.evaluate((id) => window.__ghosttyRegression.viewport(id), this.id);
  }

  canvasRect(): Promise<CssRect> {
    return this.page.evaluate((id) => window.__ghosttyRegression.canvasRect(id), this.id);
  }

  scrollLines(amount: number): Promise<void> {
    return this.page.evaluate(([id, n]) => window.__ghosttyRegression.scrollLines(id, n), [
      this.id,
      amount,
    ] as const);
  }

  scrollPages(amount: number): Promise<void> {
    return this.page.evaluate(([id, n]) => window.__ghosttyRegression.scrollPages(id, n), [
      this.id,
      amount,
    ] as const);
  }

  scrollToTop(): Promise<void> {
    return this.page.evaluate((id) => window.__ghosttyRegression.scrollToTop(id), this.id);
  }

  scrollToBottom(): Promise<void> {
    return this.page.evaluate((id) => window.__ghosttyRegression.scrollToBottom(id), this.id);
  }

  scrollToLine(line: number): Promise<void> {
    return this.page.evaluate(([id, l]) => window.__ghosttyRegression.scrollToLine(id, l), [
      this.id,
      line,
    ] as const);
  }

  select(column: number, row: number, length: number): Promise<void> {
    return this.page.evaluate(([id, c, r, n]) => window.__ghosttyRegression.select(id, c, r, n), [
      this.id,
      column,
      row,
      length,
    ] as const);
  }

  selectLines(start: number, end: number): Promise<void> {
    return this.page.evaluate(([id, a, b]) => window.__ghosttyRegression.selectLines(id, a, b), [
      this.id,
      start,
      end,
    ] as const);
  }

  selectAll(): Promise<void> {
    return this.page.evaluate((id) => window.__ghosttyRegression.selectAll(id), this.id);
  }

  clearSelection(): Promise<void> {
    return this.page.evaluate((id) => window.__ghosttyRegression.clearSelection(id), this.id);
  }

  hasSelection(): Promise<boolean> {
    return this.page.evaluate((id) => window.__ghosttyRegression.hasSelection(id), this.id);
  }

  selectionPosition(): Promise<SelectionRange | undefined> {
    return this.page.evaluate((id) => window.__ghosttyRegression.selectionPosition(id), this.id);
  }

  /** Absolute buffer line text (0 = oldest history line). */
  bufferLineText(y: number, trimRight = true): Promise<string | undefined> {
    return this.page.evaluate(
      ([id, line, trim]) => window.__ghosttyRegression.bufferLineText(id, line, trim),
      [this.id, y, trimRight] as const
    );
  }

  bufferCell(y: number, x: number): Promise<BufferCellInfo | undefined> {
    return this.page.evaluate(
      ([id, line, col]) => window.__ghosttyRegression.bufferCell(id, line, col),
      [this.id, y, x] as const
    );
  }

  scrollbarState(): Promise<ScrollbarState> {
    return this.page.evaluate((id) => window.__ghosttyRegression.scrollbarState(id), this.id);
  }

  /** Dispose; resolves to the number of elements left behind in the host. */
  dispose(): Promise<number> {
    return this.page.evaluate((id) => window.__ghosttyRegression.dispose(id), this.id);
  }
}

export class Harness {
  constructor(
    readonly page: Page,
    readonly info: ReadyInfo
  ) {}

  async create(options: CreateOptions): Promise<BrowserTerminal> {
    const id = await this.page.evaluate((o) => window.__ghosttyRegression.create(o), {
      theme: THEME,
      ...options,
    } as CreateOptions);
    const term = new BrowserTerminal(this.page, id);
    await term.settle();
    return term;
  }

  spyWindowOpen(): Promise<void> {
    return this.page.evaluate(() => window.__ghosttyRegression.spyWindowOpen());
  }

  openedUrls(): Promise<string[]> {
    return this.page.evaluate(() => window.__ghosttyRegression.openedUrls());
  }

  /** Independent oracle: `text` drawn directly with the requested font (no terminal). */
  async glyphOracle(
    request: GlyphOracleRequest
  ): Promise<{ image: Image; grid: Grid; raw: GlyphOracleCapture }> {
    const raw = await this.page.evaluate((r) => window.__ghosttyRegression.glyphOracle(r), request);
    return { ...decodeCapture(raw), raw };
  }

  /** One animation-frame round trip: input handlers have run, a frame was produced. */
  frame(): Promise<void> {
    return this.page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  }
}

/** Navigate to the harness and wait for its (fatal) font/WASM readiness. */
export async function openHarness(page: Page): Promise<ReadyInfo> {
  await page.goto(`${HARNESS_PATH}?engine=${browserEngine()}`);
  await page.waitForFunction(() => window.__ghosttyRegression !== undefined);
  return page.evaluate(() => window.__ghosttyRegression.ready);
}

export function browserEngine(): EngineId {
  return webEngine();
}

export interface HarnessFixtures {
  harness: Harness;
  /**
   * Optional hook run before the harness page loads, e.g.
   * `test.use({ harnessInit: (page) => page.clock.install() })`. Note that an
   * installed clock also fakes requestAnimationFrame, so `settle()` then needs
   * the test to advance time.
   */
  harnessInit: ((page: Page) => Promise<void>) | undefined;
}

export const test = base.extend<HarnessFixtures>({
  harnessInit: [undefined, { option: true }],
  harness: async ({ page, harnessInit }, use) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));
    if (harnessInit) await harnessInit(page);
    const info = await openHarness(page);
    await use(new Harness(page, info));
    await page.evaluate(() => window.__ghosttyRegression.disposeAll());
    expect(pageErrors, 'uncaught page errors').toEqual([]);
  },
});

export interface CaseContext {
  harness: Harness;
  checks: RegressionChecks;
  testInfo: TestInfo;
}

/** The config that loaded this test must be the one the case was registered for. */
function assertLoadedSuite(testInfo: TestInfo, suite: SuiteKind): void {
  const loaded = testInfo.config.metadata?.[SUITE_METADATA_KEY];
  if (loaded !== suite) {
    throw new Error(
      `${testInfo.title}: registered for the ${suite} suite but loaded by a config declaring ${JSON.stringify(loaded)}`
    );
  }
}

/**
 * Register one scoped regression case. Nothing is registered (or skipped or
 * counted) when scope.json does not place the case in the running suite; an id
 * missing from scope.json throws while the spec loads.
 */
export function rtest(id: string, body: (ctx: CaseContext) => Promise<void>): void {
  const engine = webEngine();
  const suite = browserSuite();
  if (!registersCase(SCOPE_PLAN, id, engine, suite)) return;
  const entry = SCOPE_PLAN.cases.find((item) => item.id === id);
  const details =
    suite === 'gaps'
      ? {
          tag: '@gap',
          annotation: [{ type: 'gap', description: `${engine}: ${entry?.reason ?? ''}` }],
        }
      : { annotation: [{ type: 'required', description: engine }] };
  test(id, details, async ({ harness }, testInfo) => {
    assertLoadedSuite(testInfo, suite);
    await runRegression(id, (checks) => body({ harness, checks, testInfo }));
  });
}

/** Fixtures available to direct controls (Playwright needs them destructured literally). */
export interface ControlFixtures {
  page: Page;
  browserName: string;
}

/**
 * Register a direct control test (no harness fixture, plain Playwright `expect`).
 * Controls are required on every engine and are registered only by the required
 * suite, so a gap run never counts their passes.
 */
export function controlTest(
  id: string,
  body: (fixtures: ControlFixtures, testInfo: TestInfo) => Promise<void> | void
): void {
  if (!registersControl(SCOPE_PLAN, id, browserSuite())) return;
  base(
    id,
    { annotation: [{ type: 'control', description: 'required on every engine' }] },
    async ({ page, browserName }, testInfo) => {
      assertLoadedSuite(testInfo, 'required');
      await body({ page, browserName }, testInfo);
    }
  );
}

export async function attachImages(
  testInfo: TestInfo,
  name: string,
  images: Record<string, Image>
): Promise<void> {
  for (const [label, image] of Object.entries(images)) {
    // Written under test-results so CI can upload them, and attached to the report.
    const path = testInfo.outputPath(`${name}-${label}.png`);
    writeFileSync(path, encodePng(image));
    await testInfo.attach(`${name}-${label}.png`, { path, contentType: 'image/png' });
  }
}

/** Assert two renders are equal cell-by-cell; attach actual/expected/diff on mismatch. */
export async function expectSameCells(
  ctx: CaseContext,
  assertion: string,
  actual: Image,
  expected: Image,
  grid: Grid,
  options: CompareOptions = EXACT
): Promise<void> {
  const changed = diffCells(actual, expected, grid, options);
  if (changed.length > 0) {
    await attachImages(ctx.testInfo, assertion, {
      actual,
      expected,
      diff: diffImage(actual, expected),
    });
  }
  ctx.checks.equal(assertion, changed, []);
}

/** Assert a probed value; attach the canvas it was probed from on mismatch. */
export async function expectProbe(
  ctx: CaseContext,
  assertion: string,
  actual: unknown,
  expected: unknown,
  image: Image
): Promise<void> {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    await attachImages(ctx.testInfo, assertion, { actual: image });
  }
  ctx.checks.equal(assertion, actual, expected);
}
