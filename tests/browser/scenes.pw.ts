/** Small whole-grid visual baselines, backed by independent semantic/pixel assertions. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { stack } from './scenes/analysis';
import { SCENES, type Scene } from './scenes/catalogue';
import { GlyphOracles, checkGlyphs } from './scenes/oracle';
import { THEME, attachImages, controlTest, expectSameCells, rtest } from './support/fixture';
import { expectedHighlight, highlightMap, viewportLines } from './support/interaction';
import {
  EXACT,
  cellInterior,
  cloneImage,
  decodePng,
  diffCells,
  encodePng,
  parseHex,
  uniformColor,
} from './support/pixels';

const BASELINES = fileURLToPath(new URL('./scenes/baselines/', import.meta.url));
const CONTAINER =
  'mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f';
const candidatePath = process.env.GHOSTTY_SCENE_CANDIDATES;

function candidates(): string | undefined {
  if (!candidatePath) return undefined;
  if (process.env.CI) throw new Error('Scene candidate generation is forbidden in normal CI');
  if (process.env.GHOSTTY_SCENE_ENVIRONMENT !== CONTAINER) {
    throw new Error('Generate candidates with scripts/test-browser-container.sh --candidates');
  }
  if (!isAbsolute(candidatePath)) throw new Error('GHOSTTY_SCENE_CANDIDATES must be absolute');
  mkdirSync(candidatePath, { recursive: true });
  const directory = realpathSync(candidatePath);
  mkdirSync(BASELINES, { recursive: true });
  const relation = relative(realpathSync(BASELINES), directory);
  if (!relation || (!relation.startsWith('..') && !isAbsolute(relation))) {
    throw new Error('Candidates must not overwrite committed scene baselines');
  }
  return directory;
}

function fingerprint(scene: Scene): string {
  return createHash('sha256').update(JSON.stringify(scene)).digest('hex');
}

for (const scene of SCENES) {
  // A static catalogue is the test data; every scene is required on every engine (scope.json).
  rtest(`scene.${scene.id}`, async (ctx) => {
    const font = ctx.harness.info.fonts[scene.fontRole ?? 'primary'];
    const fontSize = scene.fontSize ?? 15;
    const theme = { ...THEME, ...scene.theme };
    const term = await ctx.harness.create({
      cols: scene.cols,
      rows: scene.rows,
      fontFamily: font.family,
      fontSize,
      theme,
      cursorStyle: scene.cursorStyle,
      cursorBlink: false,
      smoothScrollDuration: 0,
    });
    await term.writeAndSettle(scene.input);
    if (scene.action?.kind === 'selection') {
      await term.select(scene.action.col, scene.action.row, scene.action.length);
      await term.settle();
      ctx.checks.equal('selected-text', await term.selection(), scene.action.text);
    } else if (scene.action?.kind === 'history') {
      await term.scrollLines(scene.action.lines);
      await ctx.harness.page.waitForFunction(
        (id) => window.__ghosttyRegression.scrollbarState(id).opacity === 1,
        term.id
      );
      await term.settle();
      ctx.checks.equal('history-offset', (await term.viewport()).viewportY, -scene.action.lines);
    } else if (scene.action?.kind === 'resize') {
      await term.resize(scene.action.cols, scene.action.rows);
      await term.settle();
    }
    const capture = await term.capture();
    const { image, grid, raw } = capture;
    ctx.checks.equal('baseline-dpr', raw.dpr, 1);
    if (scene.lines) {
      const lines = await Promise.all(scene.lines.map((_, row) => term.bufferLineText(row)));
      ctx.checks.equal('scene-text', lines, scene.lines);
    }
    if (scene.action?.kind === 'history') {
      ctx.checks.equal(
        'visible-history-rows',
        viewportLines(image, grid),
        Array.from({ length: scene.rows }, (_, row) =>
          scene.action!.kind === 'history' ? scene.action!.first + row : -1
        )
      );
    } else {
      // Empty bottom-right cell: a direct independent background oracle.
      ctx.checks.equal(
        'background',
        uniformColor(image, cellInterior(grid, grid.rows - 1, grid.cols - 3)),
        theme.background
      );
    }
    if (scene.action?.kind === 'selection') {
      ctx.checks.equal(
        'whole-highlight-map',
        highlightMap(image, grid),
        expectedHighlight(grid.rows, grid.cols, { row: 1, col: 2 }, { row: 2, col: 4 })
      );
    }
    if (scene.id === 'bar-cursor') {
      const x = 7 * grid.cellW;
      const y = 4 * grid.cellH;
      ctx.checks.equal(
        'bar-cursor',
        uniformColor(image, { x0: x, x1: x + 2, y0: y, y1: y + grid.cellH }),
        theme.cursor
      );
    }
    if (scene.glyph) {
      ctx.checks.equal(
        'independent-glyph-oracle',
        await checkGlyphs(
          new GlyphOracles(ctx.harness),
          capture,
          await term.cellMetrics(),
          raw.dpr,
          [
            {
              ...scene.glyph,
              fontFamily: font.family,
              fontSize,
              foreground: theme.foreground,
              background: theme.background,
            },
          ]
        ),
        []
      );
    }

    const metadata = {
      scene: scene.id,
      description: scene.description,
      scenarioSha256: fingerprint(scene),
      browser: ctx.harness.page.context().browser()!.version(),
      container: CONTAINER,
      font: { family: font.family, sha256: font.sha256, size: fontSize },
      dpr: raw.dpr,
      width: image.width,
      height: image.height,
      grid,
    };
    const output = candidates();
    if (output) {
      writeFileSync(resolve(output, `${scene.id}.png`), encodePng(image));
      writeFileSync(
        resolve(output, `${scene.id}.json`),
        `${JSON.stringify({ ...metadata, observedWasmSha256: ctx.harness.info.wasm.sha256 }, null, 2)}\n`
      );
      ctx.testInfo.annotations.push({ type: 'candidate-only', description: output });
      return;
    }
    const imagePath = resolve(BASELINES, `${scene.id}.png`);
    const metadataPath = resolve(BASELINES, `${scene.id}.json`);
    if (!existsSync(imagePath) || !existsSync(metadataPath)) {
      throw new Error(
        `Missing reviewed scene baseline: ${scene.id}; generate candidates separately, never auto-update`
      );
    }
    const { observedWasmSha256: _provenanceOnly, ...expectedMetadata } = JSON.parse(
      readFileSync(metadataPath, 'utf8')
    );
    // A backend upgrade may change the WASM hash; it must not silently change the scene.
    ctx.checks.equal('scene-environment', metadata, expectedMetadata);
    await expectSameCells(
      ctx,
      'reviewed-scene-pixels',
      image,
      decodePng(readFileSync(imagePath)),
      grid,
      EXACT
    );
  });
}

controlTest(
  'scene.comparator-rejects-missing-glyph-and-shift',
  async ({ browserName }, testInfo) => {
    expect(browserName).toBe('chromium');
    const directory = candidates() ?? BASELINES;
    const base = resolve(directory, 'dark-styles.png');
    const metadata = resolve(directory, 'dark-styles.json');
    if (!existsSync(base) || !existsSync(metadata))
      throw new Error('Missing reviewed comparator baseline');
    const expected = decodePng(readFileSync(base));
    const { grid } = JSON.parse(readFileSync(metadata, 'utf8'));
    const erased = cloneImage(expected);
    const [r, g, b] = parseHex(THEME.background);
    for (let y = 0; y < grid.cellH; y++) {
      for (let x = 0; x < grid.cellW; x++) {
        const i = (y * erased.width + x) * 4;
        erased.data.set([r, g, b, 255], i);
      }
    }
    expect(diffCells(erased, expected, grid, EXACT).length).toBeGreaterThan(0);
    const shifted = cloneImage(expected);
    for (let y = 0; y < expected.height; y++) {
      for (let x = 1; x < expected.width; x++) {
        const i = (y * expected.width + x) * 4;
        shifted.data.set(expected.data.subarray(i - 4, i), i);
      }
    }
    expect(diffCells(shifted, expected, grid, EXACT).length).toBeGreaterThan(0);
    await attachImages(testInfo, 'negative-controls', { expected, erased, shifted });
  }
);

controlTest('scene.review-montage', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium');
  const directory = candidates() ?? BASELINES;
  const images = SCENES.map((scene) =>
    decodePng(readFileSync(resolve(directory, `${scene.id}.png`)))
  );
  await attachImages(testInfo, 'review', { montage: stack(images) });
  expect(images).toHaveLength(8);
});
