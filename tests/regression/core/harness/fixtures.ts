/**
 * Shared VT fixture corpus (`tests/regression/fixtures/vt.json`): schema validation
 * and the one normalisation every engine adapter may apply.
 *
 * The corpus is deliberately limited to single-cell text so that the only
 * normalisation needed is trimming trailing blank cells. Wide characters,
 * graphemes and space-sensitive assertions live in dedicated tests.
 */
import { readFileSync } from 'node:fs';

export type ProvenanceKind = 'spec' | 'upstream-test' | 'invariant';

export interface VtFixture {
  id: string;
  description: string;
  cols: number;
  rows: number;
  input: string;
  /** Desired visible rows, one per terminal row, trailing blank cells removed. */
  expectedLines: string[];
  /** 0-based cursor position after `input` is processed. */
  expectedCursor?: { x: number; y: number };
  provenance: { kind: ProvenanceKind; reference: string };
}

export const VT_FIXTURE_PATH = new URL('../../fixtures/vt.json', import.meta.url);

const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const KINDS: readonly string[] = ['spec', 'upstream-test', 'invariant'];
const FIXTURE_KEYS = new Set([
  'id',
  'description',
  'cols',
  'rows',
  'input',
  'expectedLines',
  'expectedCursor',
  'provenance',
]);
// Characters that are not single-cell: combining marks (incl. variation
// selectors), zero-width format characters, East Asian Wide/Fullwidth blocks
// and emoji. These belong in explicit tests.
const COMBINING = /\p{M}/u;
const NOT_SINGLE_CELL =
  /[\u200b-\u200f\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f000}-\u{1faff}\u{20000}-\u{3fffd}]/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInt(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
}

/** Runtime validation: a malformed fixture must fail loudly, never be skipped. */
export function parseVtFixtures(value: unknown): VtFixture[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('VT fixtures must be a non-empty array');
  }
  const ids = new Set<string>();
  return value.map((entry: unknown, index) => {
    if (!isRecord(entry)) throw new Error(`fixture[${index}] must be an object`);
    const label = `fixture ${typeof entry.id === 'string' ? entry.id : `[${index}]`}`;
    for (const key of Object.keys(entry)) {
      if (!FIXTURE_KEYS.has(key)) throw new Error(`${label}: unknown field ${key}`);
    }
    if (typeof entry.id !== 'string' || !ID.test(entry.id)) {
      throw new Error(`${label}: id must be a lower-case dotted identifier`);
    }
    if (ids.has(entry.id)) throw new Error(`${label}: duplicate id`);
    ids.add(entry.id);
    if (typeof entry.description !== 'string' || entry.description.trim() === '') {
      throw new Error(`${label}: missing description`);
    }
    if (!positiveInt(entry.cols, 500) || !positiveInt(entry.rows, 200)) {
      throw new Error(`${label}: cols/rows must be positive integers`);
    }
    if (typeof entry.input !== 'string' || entry.input.length === 0) {
      throw new Error(`${label}: input must be a non-empty string`);
    }
    const { cols, rows } = entry;
    const lines = entry.expectedLines;
    if (!Array.isArray(lines) || lines.length !== rows) {
      throw new Error(`${label}: expectedLines must list every row (${rows})`);
    }
    lines.forEach((line, y) => {
      if (typeof line !== 'string') throw new Error(`${label}: line ${y} must be a string`);
      if (/ $/.test(line)) throw new Error(`${label}: line ${y} has trailing blanks`);
      if (CONTROL.test(line)) throw new Error(`${label}: line ${y} contains a control character`);
      if (COMBINING.test(line) || NOT_SINGLE_CELL.test(line)) {
        throw new Error(`${label}: line ${y} is not single-cell text; use an explicit test`);
      }
      if ([...line].length > cols) throw new Error(`${label}: line ${y} is wider than ${cols}`);
    });
    if (entry.expectedCursor !== undefined) {
      const cursor = entry.expectedCursor;
      if (
        !isRecord(cursor) ||
        Object.keys(cursor).sort().join() !== 'x,y' ||
        !Number.isInteger(cursor.x) ||
        !Number.isInteger(cursor.y) ||
        (cursor.x as number) < 0 ||
        (cursor.y as number) < 0 ||
        (cursor.x as number) >= cols ||
        (cursor.y as number) >= rows
      ) {
        throw new Error(`${label}: expectedCursor must be an in-range {x, y}`);
      }
    }
    const provenance = entry.provenance;
    if (
      !isRecord(provenance) ||
      typeof provenance.kind !== 'string' ||
      !KINDS.includes(provenance.kind) ||
      typeof provenance.reference !== 'string' ||
      provenance.reference.trim() === ''
    ) {
      throw new Error(`${label}: provenance needs a kind (${KINDS.join('|')}) and reference`);
    }
    return entry as unknown as VtFixture;
  });
}

export function loadVtFixtures(): VtFixture[] {
  return parseVtFixtures(JSON.parse(readFileSync(VT_FIXTURE_PATH, 'utf8')));
}

/** The only permitted adapter normalisation: drop trailing blank (space) cells. */
export function normalizeLine(line: string): string {
  return line.replace(/ +$/, '');
}

export function normalizeLines(lines: readonly string[]): string[] {
  return lines.map(normalizeLine);
}
