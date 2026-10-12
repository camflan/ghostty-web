/**
 * Joins the legacy (web-pinned) and candidate (web-candidate) REQUIRED-lane
 * reports against the reviewed scope plan (tests/regression/core/scope.json).
 *
 * An executed case is only ever `pass` or `fail`; there is no accepted-failure
 * or not-applicable outcome. Each engine's executed ids must equal the plan's
 * required ids for that engine, and every one must pass. Gap and unsupported
 * cases are scope metadata (`scope` records), kept apart from executed counts
 * and listed separately. They are run only by the explicit gap lane
 * (`bun test ./tests/gaps/core/core.gap.ts`), which exits nonzero while a gap
 * reproduces.
 *
 * Classification per planned case id:
 *
 *   required-pass       required on each engine that supports it, and passed there
 *   fixed-on-candidate  legacy gap, required and passing on the candidate
 *   gap                 gap or unsupported on both engines (never executed here)
 *   candidate-gap       required on legacy, but a gap on the candidate: needs review
 *   required-failure    a required case failed on an engine (blocker)
 *   required-missing    a required case was not executed on an engine (blocker)
 *   scope-mismatch      a report executed or scoped a case contrary to the plan (blocker)
 *
 * Report ids that the plan does not know are listed in `unplanned` and are
 * blockers too.
 *
 * Usage: bun tests/regression/matrix/compare.ts <legacy.jsonl> <candidate.jsonl> [summary.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { BackendKind } from '../core/harness/identity';
import { scopePlan } from '../core/harness/plan';
import type {
  CaseRecord,
  FailureSignature,
  ReportRecord,
  ScopeRecord,
} from '../core/harness/report';
import { type CaseKind, type ScopePlan, type WebEngine, caseScope } from '../support/scope';

export type Classification =
  | 'required-pass'
  | 'fixed-on-candidate'
  | 'gap'
  | 'candidate-gap'
  | 'required-failure'
  | 'required-missing'
  | 'scope-mismatch';

export const BLOCKERS: readonly Classification[] = [
  'required-failure',
  'required-missing',
  'scope-mismatch',
];

/** One engine's view of a planned case. */
export interface EngineView {
  scope: CaseKind;
  /** Executed outcome; absent for cases this lane did not execute. */
  outcome?: 'pass' | 'fail';
  signature?: FailureSignature;
  /** Why the report disagrees with the plan, if it does. */
  problem?: string;
}

export interface CaseComparison {
  id: string;
  classification: Classification;
  legacy: EngineView;
  candidate: EngineView;
}

export interface EngineSummary {
  wasmSha256: string;
  /** The plan's required ids for this engine. */
  required: number;
  /** Executed cases only. */
  executed: { pass: number; fail: number };
  /** Required ids with no executed record. */
  missing: number;
  /** Scope metadata, never test counts. */
  scope: { gap: number; unsupported: number };
}

export interface MatrixSummary {
  v: 2;
  legacy: EngineSummary;
  candidate: EngineSummary;
  counts: Partial<Record<Classification, number>>;
  /** Ids a report mentions that the plan does not classify. */
  unplanned: string[];
  blockers: string[];
  needsReview: string[];
  /** Cases the explicit gap lane runs, per engine (not regressions of this run). */
  gaps: { legacy: string[]; candidate: string[] };
  unsupported: { legacy: string[]; candidate: string[] };
  cases: CaseComparison[];
}

const SIDES = {
  legacy: { engine: 'web-pinned', backend: 'legacy' },
  candidate: { engine: 'web-candidate', backend: 'libghostty-vt' },
} as const satisfies Record<string, { engine: WebEngine; backend: BackendKind }>;

const SCOPES: readonly CaseKind[] = ['required', 'gap', 'unsupported'];

function fail(label: string, line: number, why: string): never {
  throw new Error(`${label}:${line}: ${why}`);
}

/** Parses a v2 report strictly: unknown versions, kinds or outcomes are errors. */
export function parseReport(text: string, label: string): ReportRecord[] {
  return text
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.trim() !== '')
    .map(({ line, number }) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.v !== 2 || typeof record.id !== 'string') {
        fail(label, number, 'not a v2 core report record');
      }
      if (record.suite !== 'required' && record.suite !== 'gaps') {
        fail(label, number, `unknown suite ${String(record.suite)}`);
      }
      if (record.kind === 'case') {
        if (record.outcome !== 'pass' && record.outcome !== 'fail') {
          fail(label, number, `case outcome must be pass or fail, not ${String(record.outcome)}`);
        }
      } else if (record.kind === 'scope') {
        if (!SCOPES.includes(record.scope as CaseKind)) {
          fail(label, number, `unknown scope ${String(record.scope)}`);
        }
      } else {
        fail(label, number, `unknown record kind ${String(record.kind)}`);
      }
      return record as unknown as ReportRecord;
    });
}

function index(records: readonly ReportRecord[], side: keyof typeof SIDES) {
  const { engine, backend } = SIDES[side];
  const cases = new Map<string, CaseRecord>();
  const scopes = new Map<string, ScopeRecord>();
  const digests = new Set<string>();
  for (const record of records) {
    if (record.engine !== engine || record.backend !== backend) {
      throw new Error(
        `${side} report contains ${record.engine}/${record.backend} for ${record.id}; expected ${engine}/${backend}`
      );
    }
    if (record.suite !== 'required') {
      throw new Error(
        `${side} report contains a ${record.suite}-lane record for ${record.id}; the matrix compares required runs`
      );
    }
    if (cases.has(record.id) || scopes.has(record.id)) {
      throw new Error(`${side} report has duplicate case ${record.id}`);
    }
    if (record.kind === 'case') cases.set(record.id, record);
    else scopes.set(record.id, record);
    digests.add(record.wasmSha256);
  }
  if (digests.size > 1) throw new Error(`${side} report mixes WASM binaries`);
  return { cases, scopes, wasmSha256: [...digests][0] ?? '' };
}

type Indexed = ReturnType<typeof index>;

function viewOf(plan: ScopePlan, id: string, engine: WebEngine, report: Indexed): EngineView {
  const scope = caseScope(plan, id, engine);
  const executed = report.cases.get(id);
  const scoped = report.scopes.get(id);
  const view: EngineView = { scope };
  if (executed) {
    view.outcome = executed.outcome;
    if (executed.signature) view.signature = executed.signature;
  }
  if (scope === 'required') {
    if (scoped) view.problem = `required case reported as ${scoped.scope} scope`;
  } else if (executed) {
    view.problem = `${scope} case was executed by the required lane`;
  } else if (!scoped) {
    view.problem = `${scope} case has no scope record`;
  } else if (scoped.scope !== scope) {
    view.problem = `reported as ${scoped.scope} scope, plan says ${scope}`;
  }
  return view;
}

export function classify(legacy: EngineView, candidate: EngineView): Classification {
  const views = [legacy, candidate];
  if (views.some((v) => v.problem)) return 'scope-mismatch';
  if (views.some((v) => v.scope === 'required' && v.outcome === undefined))
    return 'required-missing';
  if (views.some((v) => v.scope === 'required' && v.outcome === 'fail')) return 'required-failure';
  if (legacy.scope === 'required' && candidate.scope === 'gap') return 'candidate-gap';
  if (legacy.scope === 'gap' && candidate.scope === 'required') return 'fixed-on-candidate';
  if (views.every((v) => v.scope !== 'required')) return 'gap';
  return 'required-pass';
}

function engineSummary(
  plan: ScopePlan,
  engine: WebEngine,
  report: Indexed,
  cases: readonly CaseComparison[],
  side: 'legacy' | 'candidate'
): EngineSummary {
  const views = cases.map((c) => c[side]);
  const executed = [...report.cases.values()];
  return {
    wasmSha256: report.wasmSha256,
    required: plan.cases.filter((c) => c.required.includes(engine)).length,
    executed: {
      pass: executed.filter((r) => r.outcome === 'pass').length,
      fail: executed.filter((r) => r.outcome === 'fail').length,
    },
    missing: views.filter((v) => v.scope === 'required' && v.outcome === undefined).length,
    scope: {
      gap: views.filter((v) => v.scope === 'gap').length,
      unsupported: views.filter((v) => v.scope === 'unsupported').length,
    },
  };
}

export function compareReports(
  legacyRecords: readonly ReportRecord[],
  candidateRecords: readonly ReportRecord[],
  plan: ScopePlan
): MatrixSummary {
  const legacy = index(legacyRecords, 'legacy');
  const candidate = index(candidateRecords, 'candidate');
  const planned = new Set(plan.cases.map((c) => c.id));
  const unplanned = [
    ...new Set(
      [legacy, candidate]
        .flatMap((r) => [...r.cases.keys(), ...r.scopes.keys()])
        .filter((id) => !planned.has(id))
    ),
  ].sort();
  const cases = plan.cases
    .map((entry): CaseComparison => {
      const l = viewOf(plan, entry.id, SIDES.legacy.engine, legacy);
      const c = viewOf(plan, entry.id, SIDES.candidate.engine, candidate);
      return { id: entry.id, classification: classify(l, c), legacy: l, candidate: c };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const counts: Partial<Record<Classification, number>> = {};
  for (const c of cases) counts[c.classification] = (counts[c.classification] ?? 0) + 1;
  const ids = (side: 'legacy' | 'candidate', scope: CaseKind) =>
    cases.filter((c) => c[side].scope === scope).map((c) => c.id);
  return {
    v: 2,
    legacy: engineSummary(plan, SIDES.legacy.engine, legacy, cases, 'legacy'),
    candidate: engineSummary(plan, SIDES.candidate.engine, candidate, cases, 'candidate'),
    counts,
    unplanned,
    blockers: [
      ...cases.filter((c) => BLOCKERS.includes(c.classification)).map((c) => c.id),
      ...unplanned,
    ],
    needsReview: cases.filter((c) => c.classification === 'candidate-gap').map((c) => c.id),
    gaps: { legacy: ids('legacy', 'gap'), candidate: ids('candidate', 'gap') },
    unsupported: {
      legacy: ids('legacy', 'unsupported'),
      candidate: ids('candidate', 'unsupported'),
    },
    cases,
  };
}

/** Exit code: 0 clean, 1 needs review, 2 blockers. */
export function exitCodeOf(summary: MatrixSummary): 0 | 1 | 2 {
  return summary.blockers.length > 0 ? 2 : summary.needsReview.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  const [legacyPath, candidatePath, outPath] = process.argv.slice(2);
  if (!legacyPath || !candidatePath) {
    console.error('usage: compare.ts <legacy.jsonl> <candidate.jsonl> [summary.json]');
    process.exit(64);
  }
  const summary = compareReports(
    parseReport(readFileSync(legacyPath, 'utf8'), 'legacy'),
    parseReport(readFileSync(candidatePath, 'utf8'), 'candidate'),
    scopePlan()
  );
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (outPath) writeFileSync(outPath, json);
  console.log(JSON.stringify({ counts: summary.counts, blockers: summary.blockers }, null, 2));
  process.exit(exitCodeOf(summary));
}
