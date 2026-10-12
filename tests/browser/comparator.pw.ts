/**
 * Self-tests for the per-cell comparator, on real canvases captured from the
 * harness at DPR 1 and 2. Each synthetic edit must be caught even at the most
 * lenient tolerance the lane allows; encoded PNG size must not matter.
 * (PR #128's byte-length heuristic let a 1-pixel translation pass in 6 of 7
 * of its own baselines; see the research report §3.2.)
 */

import { THEME, rtest, test } from './support/fixture';
import {
  EXACT,
  type Grid,
  type Image,
  LENIENT,
  cellRect,
  cloneImage,
  decodePng,
  diffCells,
  encodePng,
  inkCount,
  parseHex,
} from './support/pixels';

function fill(image: Image, x0: number, y0: number, x1: number, y1: number, hex: string): void {
  const [r, g, b] = parseHex(hex);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = b;
      image.data[i + 3] = 255;
    }
  }
}

const MUTATIONS: Record<string, (image: Image, grid: Grid) => Image> = {
  'erase-glyph'(image, grid) {
    const out = cloneImage(image);
    const r = cellRect(grid, 0, 1, out);
    fill(out, r.x0, r.y0, r.x1, r.y1, THEME.background);
    return out;
  },
  'recolor-glyph'(image, grid) {
    const out = cloneImage(image);
    const r = cellRect(grid, 0, 0, out);
    const [br, bg, bb] = parseHex(THEME.background);
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const i = (y * out.width + x) * 4;
        if (out.data[i] !== br || out.data[i + 1] !== bg || out.data[i + 2] !== bb) {
          out.data[i] = 255;
          out.data[i + 1] = 0;
          out.data[i + 2] = 255;
        }
      }
    }
    return out;
  },
  'underline-cell'(image, grid) {
    const out = cloneImage(image);
    const r = cellRect(grid, 0, 2, out);
    fill(out, r.x0, r.y1 - 1, r.x1, r.y1, THEME.foreground);
    return out;
  },
  'translate-one-pixel'(image) {
    const out = cloneImage(image);
    fill(out, 0, 0, out.width, out.height, THEME.background);
    for (let y = 0; y < image.height; y++) {
      out.data.set(
        image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4 - 4),
        (y * image.width + 1) * 4
      );
    }
    return out;
  },
};

const EXPECTED: Record<string, string[] | 'every-ink-cell'> = {
  'erase-glyph': ['0:1'],
  'recolor-glyph': ['0:0'],
  'underline-cell': ['0:2'],
  'translate-one-pixel': 'every-ink-cell',
};

for (const dpr of [1, 2]) {
  test.describe(`comparator dpr ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    rtest(`comparator.detects-single-cell-edits-at-${dpr}`, async ({ harness, checks }) => {
      const term = await harness.create({ cols: 8, rows: 2 });
      await term.writeAndSettle('Hello\x1b[2;8H');
      const { image, grid } = await term.capture();
      const inkCells = ['0:0', '0:1', '0:2', '0:3', '0:4'];
      for (const cell of inkCells) {
        const [row, col] = cell.split(':').map(Number);
        checks.equal(
          `stimulus-ink-${row}-${col}`,
          inkCount(image, cellRect(grid, row, col, image), THEME.background) > 0,
          true
        );
      }
      checks.equal('identity-exact', diffCells(image, cloneImage(image), grid, EXACT), []);
      for (const [name, mutate] of Object.entries(MUTATIONS)) {
        const mutated = mutate(image, grid);
        for (const [mode, options] of [
          ['exact', EXACT],
          ['lenient', LENIENT],
        ] as const) {
          const changed = diffCells(mutated, image, grid, options);
          const want = EXPECTED[name];
          if (want === 'every-ink-cell') {
            checks.equal(
              `${name}-${mode}-covers-ink`,
              inkCells.every((c) => changed.includes(c)),
              true
            );
          } else {
            checks.equal(`${name}-${mode}`, changed, want);
          }
        }
      }
    });

    rtest(`comparator.tolerance-and-png-encoding-at-${dpr}`, async ({ harness, checks }) => {
      const term = await harness.create({ cols: 8, rows: 2 });
      await term.writeAndSettle('Hello\x1b[2;8H');
      const { image, grid } = await term.capture();
      // One pixel off by 1 per channel: exact catches it, lenient accepts it.
      const noisy = cloneImage(image);
      noisy.data[0] = (noisy.data[0] + 1) % 256;
      checks.equal('noise-exact', diffCells(noisy, image, grid, EXACT), ['0:0']);
      checks.equal('noise-lenient', diffCells(noisy, image, grid, LENIENT), []);
      // The same pixels at two compression levels: different bytes, equal images.
      const fast = encodePng(image, 1);
      const small = encodePng(image, 9);
      checks.equal('png-lengths-differ', fast.length !== small.length, true);
      checks.equal(
        'png-decoded-equal',
        diffCells(decodePng(fast), decodePng(small), grid, EXACT),
        []
      );
      // A real edit survives an encode/decode round trip.
      const erased = MUTATIONS['erase-glyph'](image, grid);
      checks.equal(
        'png-roundtrip-edit',
        diffCells(decodePng(encodePng(erased, 9)), image, grid, EXACT),
        ['0:1']
      );
    });
  });
}
