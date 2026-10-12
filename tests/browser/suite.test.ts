/**
 * Contract tests for the browser required/gap split (bun test; no browser needed).
 *
 * Static: scope.json and the AST catalogue agree; gap entries mirror the specs;
 * controls are required-only; unknown ids and missing suites fail closed; the
 * strict runner has no waiver for a historical failure signature.
 * Playwright `--list` (no browser, no web server): the required config registers
 * exactly the required ids for each engine even with an ambient gap flag, the gap
 * config registers exactly the gap ids and no controls, and the gap config refuses
 * GHOSTTY_REQUIRED_CI=1.
 */
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RegressionAssertionError, runRegression } from '../regression/support/regression';
import {
  type ScopePlan,
  assertCatalogueMatches,
  idsForSuite,
  parseScopePlan,
} from '../regression/support/scope';
import { assertGapEntriesMirrorSpecs, declaredCases } from './support/case-catalogue';
import {
  DYNAMIC_CASE_IDS,
  SUITE_ENV,
  browserSuite,
  loadScopePlan,
  registersCase,
  registersControl,
} from './support/suite';

const repo = resolve(import.meta.dir, '../..');
const ENGINES = ['web-candidate', 'web-pinned'] as const;
const plan = loadScopePlan();
const declared = declaredCases();
const controls = declared.filter((entry) => entry.kind === 'control').map((entry) => entry.id);

describe('static browser catalogue', () => {
  test('scope.json classifies exactly the declared cases', () => {
    assertCatalogueMatches(
      plan,
      declared.map((entry) => entry.id)
    );
    expect(declared.length).toBe(111);
    expect(controls.sort()).toEqual([
      'font.altered-alternate-font-fails-readiness',
      'font.missing-primary-font-fails-readiness',
      'font.swapped-fonts-fail-readiness',
      'manifest.scope-catalogue-matches',
      'scene.comparator-rejects-missing-glyph-and-shift',
      'scene.review-montage',
    ]);
    for (const id of controls) expect(registersControl(plan, id, 'gaps')).toBe(false);
  });

  test('dynamic ids are explicit, including the eight scene baselines', () => {
    const scenes = DYNAMIC_CASE_IDS['scene.${scene.id}'];
    expect(scenes).toHaveLength(8);
    const baselines = readdirSync(join(repo, 'tests/browser/scenes/baselines'))
      .filter((name) => name.endsWith('.png'))
      .map((name) => `scene.${name.slice(0, -4)}`)
      .sort();
    expect([...scenes].sort()).toEqual(baselines);
    const fromTemplates = declared.filter((entry) => entry.template).map((entry) => entry.id);
    expect(fromTemplates.sort()).toEqual(Object.values(DYNAMIC_CASE_IDS).flat().sort());
  });

  test('gap entries mirror the specs; history archive is provenance only', () => {
    assertGapEntriesMirrorSpecs();
    const ids = new Set(declared.map((entry) => entry.id));
    const historyDir = join(repo, 'tests/gaps/browser/history');
    for (const name of readdirSync(historyDir)) {
      for (const entry of JSON.parse(readFileSync(join(historyDir, name), 'utf8'))) {
        expect(ids.has(entry.id), `${name}: ${entry.id}`).toBe(true);
      }
    }
    // No runtime code reads the archive.
    for (const dir of ['tests/browser', 'tests/browser/support', 'tests/browser/scenes']) {
      for (const name of readdirSync(join(repo, dir)).filter((n) => n.endsWith('.ts'))) {
        if (name === 'suite.test.ts') continue;
        expect(readFileSync(join(repo, dir, name), 'utf8'), `${dir}/${name}`).not.toContain(
          'known-failures'
        );
      }
    }
  });

  test('unknown or unscoped cases and a missing suite fail closed', () => {
    expect(() => registersCase(plan, 'new.unclassified-case', 'web-candidate', 'required')).toThrow(
      'Unclassified case'
    );
    const gapControl: ScopePlan = parseScopePlan({
      schema: 1,
      cases: [
        {
          id: 'x.control',
          required: ['web-pinned'],
          gaps: ['web-candidate'],
          unsupported: [],
          reason: 'r',
        },
      ],
    });
    expect(() => registersControl(gapControl, 'x.control', 'required')).toThrow(
      'control tests must be required on every engine'
    );
    const saved = process.env[SUITE_ENV];
    try {
      Reflect.deleteProperty(process.env, SUITE_ENV);
      expect(() => browserSuite()).toThrow('only run through');
      process.env[SUITE_ENV] = 'all';
      expect(() => browserSuite()).toThrow('only run through');
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, SUITE_ENV);
      else process.env[SUITE_ENV] = saved;
    }
  });

  test('a required assertion matching a historical failure signature still fails', async () => {
    // Signature archived for color.bg-sgr40-is-theme-black (legacy): the strict runner
    // has no allowlist, so reproducing it is an ordinary failure.
    const run = runRegression('color.bg-sgr40-is-theme-black', (checks) =>
      checks.equal('sgr40-bg', '#1d1f21', '#000000')
    );
    await expect(run).rejects.toBeInstanceOf(RegressionAssertionError);
  });
});

type Listed = { code: number | null; ids: string[]; output: string };

function list(config: string, env: Record<string, string>): Promise<Listed> {
  return new Promise((done) => {
    const child = spawn(
      'node',
      [
        join(repo, 'node_modules/@playwright/test/cli.js'),
        'test',
        '-c',
        config,
        '--list',
        '--reporter=json',
      ],
      { cwd: repo, env: { ...process.env, GHOSTTY_REQUIRED_CI: '', ...env } }
    );
    let stdout = '';
    let stderr = '';
    // Never hang: a missing `node` or a stuck child ends the listing with a failure result.
    const deadline = setTimeout(() => {
      stderr += '\n[suite.test] playwright --list timed out after 45 s; killed';
      child.kill('SIGKILL');
    }, 45_000);
    child.on('error', (error) => {
      clearTimeout(deadline);
      done({
        code: -1,
        ids: [],
        output: `${stderr}\n[suite.test] cannot run node: ${error.message}`,
      });
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      clearTimeout(deadline);
      const ids: string[] = [];
      try {
        const walk = (suite: { specs?: { title: string }[]; suites?: unknown[] }) => {
          for (const spec of suite.specs ?? []) ids.push(spec.title);
          for (const child of suite.suites ?? []) walk(child as typeof suite);
        };
        for (const suite of JSON.parse(stdout).suites ?? []) walk(suite);
      } catch {
        // Not JSON: the config refused to load; `output` explains why.
      }
      done({ code, ids: ids.sort(), output: stdout + stderr });
    });
  });
}

describe('playwright registration (--list)', () => {
  test('required config: exactly the required ids per engine, even with an ambient gap flag', async () => {
    const results = await Promise.all(
      ENGINES.map((engine) =>
        list('playwright.config.ts', { GHOSTTY_REGRESSION_ENGINE: engine, [SUITE_ENV]: 'gaps' })
      )
    );
    ENGINES.forEach((engine, i) => {
      expect(results[i].code, results[i].output).toBe(0);
      expect(results[i].ids).toEqual(idsForSuite(plan, engine, 'required').sort());
    });
  }, 60_000);

  test('gap config: exactly the gap ids per engine and no controls', async () => {
    const results = await Promise.all(
      ENGINES.map((engine) =>
        list('playwright.gaps.config.ts', {
          GHOSTTY_REGRESSION_ENGINE: engine,
          [SUITE_ENV]: 'required',
        })
      )
    );
    ENGINES.forEach((engine, i) => {
      expect(results[i].code, results[i].output).toBe(0);
      expect(results[i].ids).toEqual(idsForSuite(plan, engine, 'gaps').sort());
      expect(results[i].ids.filter((id) => controls.includes(id))).toEqual([]);
    });
  }, 60_000);

  test('gap config refuses required CI; unknown engine refuses both configs', async () => {
    const [gapsInCi, reference] = await Promise.all([
      list('playwright.gaps.config.ts', { GHOSTTY_REQUIRED_CI: '1' }),
      list('playwright.config.ts', { GHOSTTY_REGRESSION_ENGINE: 'reference' }),
    ]);
    expect(gapsInCi.code).not.toBe(0);
    expect(gapsInCi.output).toContain('refuses to run with GHOSTTY_REQUIRED_CI=1');
    expect(gapsInCi.ids).toEqual([]);
    expect(reference.code).not.toBe(0);
    expect(reference.output).toContain('not applicable to the browser lane');
  }, 60_000);
});
