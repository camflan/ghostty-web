/**
 * Machine-readable per-case results for the matrix.
 *
 * When GHOSTTY_REGRESSION_REPORT names a file, the core lanes append JSON
 * lines of two kinds, which consumers must keep apart:
 *
 * - `case`:  a case that actually executed in this lane: `pass` or `fail`, nothing else.
 * - `scope`: a declared case this lane did NOT execute (a gap, an unsupported ABI
 *            case, or a required case withheld from the gap lane). Metadata only:
 *            it is never a pass, a skip or a test count.
 *
 * `tests/regression/matrix/compare.ts` joins the legacy and candidate reports.
 */
import { appendFileSync } from 'node:fs';
import { RegressionAssertionError } from '../../support/regression';
import type { CaseKind, SuiteKind } from '../../support/scope';
import type { BackendKind, WebEngine } from './identity';

export type FailureSignature =
  | { kind: 'assertion'; assertion: string; expected: unknown; actual: unknown }
  | { kind: 'error'; name: string; message: string };

interface RecordBase {
  v: 2;
  id: string;
  engine: WebEngine;
  backend: BackendKind;
  wasmSha256: string;
  /** The lane that produced the record. */
  suite: SuiteKind;
}

export interface CaseRecord extends RecordBase {
  kind: 'case';
  outcome: 'pass' | 'fail';
  /** What was thrown, for 'fail'. */
  signature?: FailureSignature;
}

export interface ScopeRecord extends RecordBase {
  kind: 'scope';
  /** The plan's classification of a case the lane declared but did not execute. */
  scope: CaseKind;
}

export type ReportRecord = CaseRecord | ScopeRecord;

/** JSON-safe signature of a thrown value (assertion payloads are already JSON data). */
export function signatureOf(error: unknown): FailureSignature {
  if (error instanceof RegressionAssertionError) {
    return {
      kind: 'assertion',
      assertion: error.assertion,
      expected: error.expected,
      actual: error.actual,
    };
  }
  if (error instanceof Error) return { kind: 'error', name: error.name, message: error.message };
  return { kind: 'error', name: typeof error, message: String(error) };
}

export function recordResult(record: ReportRecord): void {
  const path = process.env.GHOSTTY_REGRESSION_REPORT;
  if (!path) return;
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}
