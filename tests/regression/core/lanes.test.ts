/**
 * Lane behaviour, proven with real `bun test` subprocesses: a failing required
 * case fails the process, the gap lane never accepts a failure, unknown or
 * missing cases block registration, the gap entry refuses required CI and is
 * never discovered by default, and ambient environment cannot turn a required
 * entry into the gap lane.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseScope, idsForSuite } from '../support/scope';
import { engineIdentity } from './harness/identity';
import { REQUIRED_CI_ENV, scopePlan } from './harness/plan';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const HARNESS = fileURLToPath(new URL('./harness/', import.meta.url));
const SUPPORT = fileURLToPath(new URL('../support/', import.meta.url));

function bunTest(path: string, env: Record<string, string | undefined> = {}) {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    GHOSTTY_REGRESSION_REPORT: '',
  };
  Reflect.deleteProperty(merged, REQUIRED_CI_ENV);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) Reflect.deleteProperty(merged, key);
    else merged[key] = value;
  }
  const result = Bun.spawnSync(['bun', 'test', path], {
    cwd: REPO_ROOT,
    env: merged,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode ?? -1,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

type Scope = 'required' | 'gap' | 'absent';
interface Fixture {
  suite: 'required' | 'gaps';
  /** Declared cases: id -> the value the case body observes (the oracle expects 1). */
  cases: Record<string, number>;
  /** Plan scope on the engine under test (the other engine is always 'gap'). */
  plan: Record<string, Scope>;
}

/** A scratch lane: inline definitions, an inline plan, the real registration code. */
function runFixture({ suite, cases, plan }: Fixture, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ghostty-lane-'));
  const entry = join(dir, 'lane.test.ts');
  writeFileSync(
    entry,
    `import { describe as bunDescribe, test as bunTest } from 'bun:test';
import { engineIdentity } from ${JSON.stringify(`${HARNESS}identity.ts`)};
import { collectDefinitions, describe, regressionCase, registerLane } from ${JSON.stringify(`${HARNESS}scenario.ts`)};
import { parseScopePlan } from ${JSON.stringify(`${SUPPORT}scope.ts`)};
const engine = engineIdentity().engine;
const other = engine === 'web-pinned' ? 'web-candidate' : 'web-pinned';
const scopes = ${JSON.stringify(plan)};
const plan = parseScopePlan({ schema: 1, cases: Object.entries(scopes).map(([id, scope]) => ({
  id,
  required: scope === 'required' ? [engine] : [],
  gaps: scope === 'gap' ? [engine, other] : [other],
  unsupported: [],
  reason: 'lane self-test',
})) });
const observed = ${JSON.stringify(cases)};
const definitions = collectDefinitions(() => {
  describe('fixture', () => {
    for (const [id, value] of Object.entries(observed)) {
      regressionCase(id, (checks) => checks.equal('value', value, 1));
    }
  });
});
registerLane({ suite: ${JSON.stringify(suite)}, plan, catalogue: new Map([['fixture', definitions]]), select: ['fixture'], bun: { describe: bunDescribe, test: bunTest } });
`
  );
  try {
    return bunTest(entry, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('core lanes (subprocess)', () => {
  test('positive control: a passing required case passes the process', () => {
    const run = runFixture({
      suite: 'required',
      cases: { 'fx.ok': 1 },
      plan: { 'fx.ok': 'required' },
    });
    expect(run.output).toContain('(pass) fixture > fx.ok');
    expect(run.code).toBe(0);
  }, 30_000);

  test('a mutated required assertion fails the process', () => {
    const run = runFixture({
      suite: 'required',
      cases: { 'fx.ok': 2 },
      plan: { 'fx.ok': 'required' },
    });
    expect(run.output).toContain('(fail) fixture > fx.ok');
    expect(run.output).toContain('value: expected 1, received 2');
    expect(run.code).not.toBe(0);
  }, 30_000);

  test('gaps are withheld from the required lane and fail the explicit gap lane', () => {
    const fixture = {
      cases: { 'fx.ok': 1, 'fx.bug': 2 },
      plan: { 'fx.ok': 'required', 'fx.bug': 'gap' },
    } as const;
    const required = runFixture({ ...fixture, suite: 'required' });
    expect(required.output).toContain('(pass) fixture > fx.ok');
    expect(required.output).not.toContain('fx.bug');
    expect(required.output).toMatch(/^\s*1 pass\s*$/m);
    expect(required.code).toBe(0);
    const gaps = runFixture({ ...fixture, suite: 'gaps' });
    expect(gaps.output).toContain('(fail) fixture > fx.bug');
    expect(gaps.output).not.toContain('fx.ok');
    expect(gaps.code).not.toBe(0);
  }, 30_000);

  test('a declared case missing from the plan blocks registration', () => {
    const run = runFixture({
      suite: 'required',
      cases: { 'fx.ok': 1, 'fx.new': 1 },
      plan: { 'fx.ok': 'required' },
    });
    expect(run.output).toContain('unclassified cases [fx.new]');
    expect(run.code).not.toBe(0);
  }, 30_000);

  test('a planned case nobody declares blocks registration', () => {
    const run = runFixture({
      suite: 'required',
      cases: { 'fx.ok': 1 },
      plan: { 'fx.ok': 'required', 'fx.gone': 'required' },
    });
    expect(run.output).toContain('missing cases [fx.gone]');
    expect(run.code).not.toBe(0);
  }, 30_000);

  test('an entry that selects no cases fails instead of passing vacuously', () => {
    const run = runFixture({
      suite: 'required',
      cases: { 'fx.bug': 2 },
      plan: { 'fx.bug': 'gap' },
    });
    expect(run.output).toContain('selects no cases');
    expect(run.code).not.toBe(0);
  }, 30_000);

  test('the gap lane refuses to run under required CI', () => {
    const run = runFixture(
      { suite: 'gaps', cases: { 'fx.bug': 1 }, plan: { 'fx.bug': 'gap' } },
      { [REQUIRED_CI_ENV]: '1' }
    );
    expect(run.output).toContain(`Refusing to run the core gap lane: ${REQUIRED_CI_ENV}=1`);
    expect(run.output).not.toContain('(pass)');
    expect(run.code).not.toBe(0);
  }, 30_000);
});

describe('core entries (subprocess)', () => {
  const { engine } = engineIdentity();
  const plan = scopePlan();

  test('the real gap entry refuses under GHOSTTY_REQUIRED_CI=1 before running anything', () => {
    const run = bunTest('./tests/gaps/core/core.gap.ts', { [REQUIRED_CI_ENV]: '1' });
    expect(run.output).toContain('Refusing to run the core gap lane');
    expect(run.output).not.toMatch(/\((pass|fail)\) /);
    expect(run.code).not.toBe(0);
  }, 30_000);

  test('default discovery never runs the gap entry', () => {
    const run = bunTest('tests/gaps');
    expect(run.output).not.toMatch(/\((pass|fail)\) /);
    expect(run.output).not.toContain('core gaps lane');
  }, 30_000);

  test('ambient suite-like environment cannot turn a required entry into the gap lane', () => {
    const run = bunTest('./tests/regression/core/paste-focus.test.ts', {
      GHOSTTY_REGRESSION_SUITE: 'gaps',
      GHOSTTY_SUITE: 'gaps',
      SUITE: 'gaps',
    });
    const executed = [
      ...run.output.matchAll(/^\(pass\) .* > ([a-z0-9.-]+)(?: \[[^\]]*\])?$/gm),
    ].map((m) => m[1]);
    const gaps = new Set(idsForSuite(plan, engine, 'gaps'));
    expect(executed.length).toBeGreaterThan(0);
    expect(executed.filter((id) => gaps.has(id))).toEqual([]);
    expect(executed.every((id) => caseScope(plan, id, engine) === 'required')).toBe(true);
    expect(run.code).toBe(0);
  }, 60_000);
});
