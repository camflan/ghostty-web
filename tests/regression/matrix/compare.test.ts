/** Rules of the required-lane legacy/candidate matrix comparison. */
import { describe, expect, test } from 'bun:test';
import type { CaseRecord, ReportRecord, ScopeRecord } from '../core/harness/report';
import { type CaseKind, type WebEngine, parseScopePlan } from '../support/scope';
import { compareReports, exitCodeOf, parseReport } from './compare';

const SHA = { 'web-pinned': '0'.repeat(64), 'web-candidate': '1'.repeat(64) } as const;
const BACKEND = { 'web-pinned': 'legacy', 'web-candidate': 'libghostty-vt' } as const;
const bug = {
  kind: 'assertion',
  assertion: 'output.bytes',
  expected: ['1b62'],
  actual: ['62'],
} as const;

type Scope = { legacy: CaseKind; candidate: CaseKind };
const ENGINE_KEY = { legacy: 'web-pinned', candidate: 'web-candidate' } as const;

function planOf(scopes: Record<string, Scope>) {
  return parseScopePlan({
    schema: 1,
    cases: Object.entries(scopes).map(([id, scope]) => {
      const entry = {
        id,
        required: [] as WebEngine[],
        gaps: [] as WebEngine[],
        unsupported: [] as WebEngine[],
      };
      for (const side of ['legacy', 'candidate'] as const) {
        const key = { required: 'required', gap: 'gaps', unsupported: 'unsupported' }[
          scope[side]
        ] as 'required' | 'gaps' | 'unsupported';
        entry[key].push(ENGINE_KEY[side]);
      }
      return { ...entry, reason: 'matrix self-test' };
    }),
  });
}

function executed(engine: WebEngine, id: string, outcome: 'pass' | 'fail'): CaseRecord {
  return {
    v: 2,
    kind: 'case',
    id,
    engine,
    backend: BACKEND[engine],
    wasmSha256: SHA[engine],
    suite: 'required',
    outcome,
    ...(outcome === 'fail' ? { signature: bug } : {}),
  };
}

function scoped(engine: WebEngine, id: string, scope: CaseKind): ScopeRecord {
  return {
    v: 2,
    kind: 'scope',
    id,
    engine,
    backend: BACKEND[engine],
    wasmSha256: SHA[engine],
    suite: 'required',
    scope,
  };
}

/** What a correct required run reports for `scopes`, with optional overrides. */
function honestRun(
  engine: WebEngine,
  scopes: Record<string, Scope>,
  fails: string[] = []
): ReportRecord[] {
  const side = engine === 'web-pinned' ? 'legacy' : 'candidate';
  return Object.entries(scopes).map(([id, scope]) =>
    scope[side] === 'required'
      ? executed(engine, id, fails.includes(id) ? 'fail' : 'pass')
      : scoped(engine, id, scope[side])
  );
}

const SCOPES: Record<string, Scope> = {
  'both.pass': { legacy: 'required', candidate: 'required' },
  'native.fixed': { legacy: 'gap', candidate: 'required' },
  'js.bug': { legacy: 'gap', candidate: 'gap' },
  'legacy.abi': { legacy: 'required', candidate: 'unsupported' },
};
const plan = planOf(SCOPES);
const compare = (legacy: ReportRecord[], candidate: ReportRecord[], p = plan) =>
  compareReports(legacy, candidate, p);
const classOf = (summary: ReturnType<typeof compare>, id: string) =>
  summary.cases.find((c) => c.id === id)?.classification;

describe('matrix: required lanes against the scope plan', () => {
  test('a clean pair of required runs has no blockers; gaps are listed, not counted as executed', () => {
    const summary = compare(honestRun('web-pinned', SCOPES), honestRun('web-candidate', SCOPES));
    expect(summary.blockers).toEqual([]);
    expect(exitCodeOf(summary)).toBe(0);
    expect(classOf(summary, 'both.pass')).toBe('required-pass');
    expect(classOf(summary, 'native.fixed')).toBe('fixed-on-candidate');
    expect(classOf(summary, 'js.bug')).toBe('gap');
    expect(classOf(summary, 'legacy.abi')).toBe('required-pass');
    expect(summary.gaps).toEqual({ legacy: ['js.bug', 'native.fixed'], candidate: ['js.bug'] });
    expect(summary.unsupported).toEqual({ legacy: [], candidate: ['legacy.abi'] });
    expect(summary.legacy).toMatchObject({
      required: 2,
      executed: { pass: 2, fail: 0 },
      missing: 0,
      scope: { gap: 2, unsupported: 0 },
    });
    expect(summary.candidate).toMatchObject({
      required: 2,
      executed: { pass: 2, fail: 0 },
      missing: 0,
      scope: { gap: 1, unsupported: 1 },
    });
  });

  test('a failing required case is a blocker on either engine, with its signature', () => {
    const native = compare(
      honestRun('web-pinned', SCOPES),
      honestRun('web-candidate', SCOPES, ['native.fixed'])
    );
    expect(classOf(native, 'native.fixed')).toBe('required-failure');
    expect(native.cases.find((c) => c.id === 'native.fixed')?.candidate.signature).toEqual(bug);
    expect(native.blockers).toEqual(['native.fixed']);
    expect(exitCodeOf(native)).toBe(2);
    const legacy = compare(
      honestRun('web-pinned', SCOPES, ['legacy.abi']),
      honestRun('web-candidate', SCOPES)
    );
    expect(legacy.blockers).toEqual(['legacy.abi']);
  });

  test('a missing required case blocks', () => {
    const candidate = honestRun('web-candidate', SCOPES).filter((r) => r.id !== 'both.pass');
    const summary = compare(honestRun('web-pinned', SCOPES), candidate);
    expect(classOf(summary, 'both.pass')).toBe('required-missing');
    expect(summary.candidate.missing).toBe(1);
    expect(exitCodeOf(summary)).toBe(2);
  });

  test('an empty report blocks every required case instead of passing vacuously', () => {
    const summary = compare(honestRun('web-pinned', SCOPES), []);
    expect(summary.blockers.sort()).toEqual(['both.pass', 'js.bug', 'legacy.abi', 'native.fixed']);
  });

  test('a gap or unsupported case executed by the required lane is a scope mismatch, even if it passed', () => {
    const candidate = honestRun('web-candidate', SCOPES).map((r) =>
      r.id === 'js.bug' ? executed('web-candidate', 'js.bug', 'pass') : r
    );
    const summary = compare(honestRun('web-pinned', SCOPES), candidate);
    expect(classOf(summary, 'js.bug')).toBe('scope-mismatch');
    expect(summary.cases.find((c) => c.id === 'js.bug')?.candidate.problem).toContain(
      'executed by the required lane'
    );
    expect(exitCodeOf(summary)).toBe(2);
  });

  test('scope records must agree with the plan', () => {
    const relabelled = honestRun('web-candidate', SCOPES).map((r) =>
      r.id === 'legacy.abi' ? scoped('web-candidate', 'legacy.abi', 'gap') : r
    );
    expect(classOf(compare(honestRun('web-pinned', SCOPES), relabelled), 'legacy.abi')).toBe(
      'scope-mismatch'
    );
    const withoutScope = honestRun('web-candidate', SCOPES).filter((r) => r.id !== 'js.bug');
    expect(classOf(compare(honestRun('web-pinned', SCOPES), withoutScope), 'js.bug')).toBe(
      'scope-mismatch'
    );
  });

  test('report ids unknown to the plan are blockers', () => {
    const candidate = [
      ...honestRun('web-candidate', SCOPES),
      executed('web-candidate', 'new.case', 'pass'),
    ];
    const summary = compare(honestRun('web-pinned', SCOPES), candidate);
    expect(summary.unplanned).toEqual(['new.case']);
    expect(summary.blockers).toContain('new.case');
  });

  test('a case required on legacy but parked as a candidate gap needs review', () => {
    const scopes: Record<string, Scope> = {
      ...SCOPES,
      'native.regression': { legacy: 'required', candidate: 'gap' },
    };
    const summary = compare(
      honestRun('web-pinned', scopes),
      honestRun('web-candidate', scopes),
      planOf(scopes)
    );
    expect(classOf(summary, 'native.regression')).toBe('candidate-gap');
    expect(summary.needsReview).toEqual(['native.regression']);
    expect(exitCodeOf(summary)).toBe(1);
  });

  test('reports must be single-engine, single-binary, required-lane and duplicate-free', () => {
    const legacy = honestRun('web-pinned', SCOPES);
    const candidate = honestRun('web-candidate', SCOPES);
    expect(() => compare(candidate, candidate)).toThrow('expected web-pinned/legacy');
    expect(() => compare(legacy, [...candidate, candidate[0]])).toThrow('duplicate case');
    expect(() =>
      compare(legacy, [{ ...candidate[0], wasmSha256: '2'.repeat(64) }, ...candidate.slice(1)])
    ).toThrow('mixes WASM binaries');
    expect(() =>
      compare(
        legacy,
        candidate.map((r) => ({ ...r, suite: 'gaps' as const }))
      )
    ).toThrow('gaps-lane record');
  });
});

describe('matrix: report parsing', () => {
  const line = (record: object) => JSON.stringify(record);
  const ok = executed('web-candidate', 'both.pass', 'pass');

  test('accepts v2 case and scope records', () => {
    const text = `${line(ok)}\n\n${line(scoped('web-candidate', 'js.bug', 'gap'))}\n`;
    expect(parseReport(text, 'candidate')).toHaveLength(2);
  });

  for (const [what, record] of [
    ['v1 records', { ...ok, v: 1 }],
    ['a known-failure outcome', { ...ok, outcome: 'known-failure' }],
    ['a not-applicable outcome', { ...ok, outcome: 'not-applicable' }],
    ['an unknown record kind', { ...ok, kind: 'skip' }],
    ['an unknown scope', { ...scoped('web-candidate', 'x', 'gap'), scope: 'expected-failure' }],
    ['an unknown suite', { ...ok, suite: 'all-green' }],
  ] as const) {
    test(`rejects ${what}`, () => {
      expect(() => parseReport(line(record), 'candidate')).toThrow('candidate:1');
    });
  }
});
