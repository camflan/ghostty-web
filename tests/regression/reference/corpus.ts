/**
 * Shared VT corpus (tests/regression/fixtures/vt.json) checks for the reference engine.
 *
 * Contract (owned by the core lane): single-cell text/control fixtures; each `expectedLines`
 * entry is a visible row WITHOUT trailing padding; adapters normalise ONLY trailing
 * empty/space cells. Wide/grapheme/space-sensitive behaviour lives in dedicated tests.
 */
import { readFileSync } from 'node:fs';
import type { ReferenceTerminal, RowObservation } from './loader';

export type ProvenanceKind = 'spec' | 'upstream-test' | 'invariant';

export interface VtFixture {
  id: string;
  description: string;
  cols: number;
  rows: number;
  input: string;
  expectedLines: string[];
  expectedCursor?: { x: number; y: number };
  provenance: { kind: ProvenanceKind; reference: string };
}

export interface CorpusObservation {
  lines: string[];
  cursor: { x: number; y: number };
  rows: RowObservation[];
}

const KINDS: readonly string[] = ['spec', 'upstream-test', 'invariant'];
const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/** Strict schema validation: a malformed corpus is a setup error, never a skip. */
export function loadCorpus(path: string): VtFixture[] {
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(data) || data.length === 0)
    throw new Error(`${path}: expected non-empty array`);
  const ids = new Set<string>();
  return data.map((raw, index) => {
    const at = `${path}[${index}]`;
    const f = raw as Partial<VtFixture>;
    const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;
    if (typeof f.id !== 'string' || !ID.test(f.id)) throw new Error(`${at}: invalid id`);
    if (ids.has(f.id)) throw new Error(`${at}: duplicate id ${f.id}`);
    ids.add(f.id);
    if (typeof f.description !== 'string' || !f.description.trim()) {
      throw new Error(`${f.id}: missing description`);
    }
    if (!int(f.cols) || !int(f.rows)) throw new Error(`${f.id}: cols/rows must be positive ints`);
    if (typeof f.input !== 'string') throw new Error(`${f.id}: input must be a string`);
    if (
      !Array.isArray(f.expectedLines) ||
      f.expectedLines.length !== f.rows ||
      f.expectedLines.some((l) => typeof l !== 'string' || l !== l.replace(/ +$/, ''))
    ) {
      throw new Error(`${f.id}: expectedLines must be ${f.rows} strings without trailing spaces`);
    }
    if (f.expectedCursor !== undefined) {
      const { x, y } = f.expectedCursor;
      const inRange = (v: unknown, max: number) =>
        Number.isInteger(v) && (v as number) >= 0 && (v as number) < max;
      if (!inRange(x, f.cols!) || !inRange(y, f.rows!))
        throw new Error(`${f.id}: cursor out of range`);
    }
    if (!f.provenance || !KINDS.includes(f.provenance.kind) || !f.provenance.reference?.trim()) {
      throw new Error(`${f.id}: invalid provenance`);
    }
    return f as VtFixture;
  });
}

/**
 * Visible row text: empty cells and spacer heads render as a space, spacer tails render as
 * nothing (they are the right half of the preceding wide cell); then ONLY trailing spaces are
 * removed. Leading/interior blanks are significant.
 */
export function rowText(row: RowObservation): string {
  let text = '';
  for (const cell of row.cells) {
    if (cell.wide === 'spacer_tail') continue;
    text += cell.codepoints.length === 0 || cell.wide === 'spacer_head' ? ' ' : cell.text;
  }
  return normalizeTrailing(text);
}

export function normalizeTrailing(text: string): string {
  return text.replace(/ +$/, '');
}

export function observe(term: ReferenceTerminal, rows: number): CorpusObservation {
  const observed = Array.from({ length: rows }, (_, y) => term.row('ACTIVE', y));
  const { x, y } = term.cursor();
  return { rows: observed, lines: observed.map(rowText), cursor: { x, y } };
}

/** Returns human-readable mismatches between an observation and a fixture (empty = pass). */
export function compareFixture(obs: CorpusObservation, fx: VtFixture): string[] {
  const problems: string[] = [];
  fx.expectedLines.forEach((expected, y) => {
    if (obs.lines[y] !== expected) {
      problems.push(
        `row ${y}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(obs.lines[y])}`
      );
    }
  });
  if (fx.expectedCursor) {
    const { x, y } = fx.expectedCursor;
    if (obs.cursor.x !== x || obs.cursor.y !== y) {
      problems.push(`cursor: expected (${x},${y}), got (${obs.cursor.x},${obs.cursor.y})`);
    }
  }
  return problems;
}

/** The corpus is single-cell only: any wide cell or multi-codepoint cluster violates its contract. */
export function singleCellViolations(obs: CorpusObservation): string[] {
  const problems: string[] = [];
  obs.rows.forEach((row, y) =>
    row.cells.forEach((cell, x) => {
      if (cell.wide !== 'narrow') problems.push(`cell (${x},${y}) is ${cell.wide}`);
      if (cell.codepoints.length > 1) problems.push(`cell (${x},${y}) holds a grapheme cluster`);
    })
  );
  return problems;
}

/** Deliberately wrong copies of a fixture, used to prove the comparator can fail. */
export function mutations(fx: VtFixture): { name: string; fixture: VtFixture }[] {
  const lines = [...fx.expectedLines];
  const y = Math.max(
    0,
    lines.findIndex((l) => l.length > 0)
  );
  const line = lines[y];
  lines[y] = line.length > 0 ? line.slice(0, -1) + (line.endsWith('Z') ? 'Y' : 'Z') : 'Z';
  const out = [{ name: 'line', fixture: { ...fx, expectedLines: lines } }];
  if (fx.expectedCursor) {
    const cursor = { ...fx.expectedCursor, x: (fx.expectedCursor.x + 1) % fx.cols };
    if (fx.cols > 1) out.push({ name: 'cursor', fixture: { ...fx, expectedCursor: cursor } });
  }
  return out;
}
