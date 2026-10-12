import {
  bytewise,
  randomSplits,
  regressionSeed,
  seededRandom,
  splitAt,
  utf8InteriorOffsets,
} from '../../regression/core/harness/chunking';
import {
  type VtFixture,
  loadVtFixtures,
  normalizeLine,
  normalizeLines,
  parseVtFixtures,
} from '../../regression/core/harness/fixtures';
/**
 * L1 + L3: the shared single-cell VT corpus on the ghostty-web engine.
 * Each fixture runs as one whole write (`vt.<id>`) and under bytewise,
 * UTF-8-interior and seeded random fragmentation (`vt-split.<id>`), each on a
 * fresh WASM instance. Negative controls prove the comparison is sensitive.
 */
import { describe, expect, regressionCase, test } from '../../regression/core/harness/scenario';
import { type Observation, guarded, rawSession, utf8 } from '../../regression/core/harness/web';

const fixtures = loadVtFixtures();
const seed = regressionSeed();

function run(fx: VtFixture, chunks: readonly (string | Uint8Array)[]): Observation {
  const session = rawSession(fx.cols, fx.rows);
  return guarded(
    () => {
      for (const chunk of chunks) session.write(chunk);
      return session.observe();
    },
    () => session.free()
  );
}

function matches(fx: VtFixture, obs: Observation): boolean {
  return (
    JSON.stringify(obs.lines) === JSON.stringify(fx.expectedLines) &&
    (fx.expectedCursor === undefined ||
      JSON.stringify(obs.cursor) === JSON.stringify(fx.expectedCursor))
  );
}

describe('vt corpus: schema', () => {
  const valid = structuredClone(fixtures[0]);

  test('corpus loads, ids are unique and every row is listed', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length);
    for (const fx of fixtures) expect(fx.expectedLines).toHaveLength(fx.rows);
  });

  test('every provenance kind is represented', () => {
    const kinds = new Set(fixtures.map((f) => f.provenance.kind));
    expect([...kinds].sort()).toEqual(['invariant', 'spec', 'upstream-test']);
  });

  const invalid: Array<[string, Record<string, unknown>]> = [
    ['missing row', { expectedLines: valid.expectedLines.slice(1) }],
    ['trailing blank in a line', { expectedLines: ['hello ', ''] }],
    ['wide character', { expectedLines: ['\u4e00', ''] }],
    ['combining mark', { expectedLines: ['e\u0301', ''] }],
    ['control character', { expectedLines: ['a\u001bb', ''] }],
    ['line wider than cols', { expectedLines: ['hello world!', ''] }],
    ['cursor out of range', { expectedCursor: { x: valid.cols, y: 0 } }],
    ['cursor with extra keys', { expectedCursor: { x: 0, y: 0, visible: true } }],
    ['unknown provenance kind', { provenance: { kind: 'characterization', reference: 'x' } }],
    ['empty reference', { provenance: { kind: 'spec', reference: ' ' } }],
    ['upper-case id', { id: 'Print.Basic' }],
    ['unknown field', { expectedCells: [] }],
    ['empty input', { input: '' }],
    ['zero cols', { cols: 0 }],
  ];
  for (const [name, patch] of invalid) {
    test(`validator rejects: ${name}`, () => {
      expect(() => parseVtFixtures([{ ...structuredClone(valid), ...patch }])).toThrow();
    });
  }

  test('validator rejects duplicate ids', () => {
    expect(() => parseVtFixtures([valid, valid])).toThrow(/duplicate/);
  });
});

describe('vt corpus: normaliser', () => {
  test('trims trailing blank cells only', () => {
    expect(normalizeLines(['ab   ', '  c', ' ', ''])).toEqual(['ab', '  c', '', '']);
  });

  test('keeps interior and leading blanks and non-blank trailing cells', () => {
    expect(normalizeLine('a  b')).toBe('a  b');
    expect(normalizeLine('  x')).toBe('  x');
    expect(normalizeLine('ab\u00a0')).toBe('ab\u00a0');
  });

  test('a dropped trailing cell is still detected after normalisation', () => {
    expect(normalizeLine('abcde')).not.toBe(normalizeLine('abcd '));
  });
});

describe('vt corpus: negative controls', () => {
  test('a blank engine (write is a no-op) fails every fixture', () => {
    const passedByBlank = fixtures.filter((fx) => matches(fx, run(fx, [])));
    expect(passedByBlank.map((fx) => fx.id)).toEqual([]);
  });

  test('a per-chunk TextDecoder transport is caught by the UTF-8 split', () => {
    const multibyte = fixtures.filter((fx) => utf8InteriorOffsets(utf8(fx.input)).length > 0);
    expect(multibyte.length).toBeGreaterThan(0);
    for (const fx of multibyte) {
      const bytes = utf8(fx.input);
      const naive = splitAt(bytes, utf8InteriorOffsets(bytes)).map((c) =>
        new TextDecoder().decode(c)
      );
      expect(matches(fx, run(fx, naive))).toBe(false);
    }
  });
});

describe('vt corpus: ghostty-web engine', () => {
  for (const fx of fixtures) {
    regressionCase(`vt.${fx.id}`, (checks) => {
      const obs = run(fx, [utf8(fx.input)]);
      checks.equal('lines', obs.lines, fx.expectedLines);
      if (fx.expectedCursor) checks.equal('cursor', obs.cursor, fx.expectedCursor);
    });
  }
});

describe(`vt corpus: fragmentation invariance (seed ${seed})`, () => {
  for (const [index, fx] of fixtures.entries()) {
    regressionCase(`vt-split.${fx.id}`, (checks) => {
      const bytes = utf8(fx.input);
      const splits: Array<[string, Uint8Array[]]> = [
        ['bytewise', bytewise(bytes)],
        ['random', randomSplits(bytes, seededRandom(seed + index))],
      ];
      const interior = utf8InteriorOffsets(bytes);
      if (interior.length > 0) splits.push(['utf8-interior', splitAt(bytes, interior)]);
      for (const [name, chunks] of splits) {
        const obs = run(fx, chunks);
        checks.equal(`${name}.lines`, obs.lines, fx.expectedLines);
        if (fx.expectedCursor) checks.equal(`${name}.cursor`, obs.cursor, fx.expectedCursor);
      }
    });
  }
});
