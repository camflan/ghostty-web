/**
 * Runs the REQUIRED core lane once per engine and compares both runs against
 * the reviewed scope plan (tests/regression/core/scope.json).
 *
 *   bun tests/regression/matrix/run.ts --legacy <legacy.wasm> [--candidate <native.wasm>] [--out <dir>]
 *
 * - legacy run:    GHOSTTY_REGRESSION_ENGINE=web-pinned,    GHOSTTY_REGRESSION_WASM=<legacy.wasm>
 * - candidate run: GHOSTTY_REGRESSION_ENGINE=web-candidate, GHOSTTY_REGRESSION_WASM=<native.wasm>
 *   (defaults to the repository's ghostty-vt.wasm)
 *
 * The core harness verifies that each binary's ABI and the bridge's `backend`
 * match the engine, so a binary can never be relabelled to change which cases
 * are required. Every executed case must pass and each engine must execute
 * exactly its required ids; gaps are listed in the summary and run separately
 * by `bun test ./tests/gaps/core/core.gap.ts`. Outputs (default
 * test-results/matrix/): legacy.jsonl, candidate.jsonl, legacy.log,
 * candidate.log, summary.json.
 * Exit code: 0 clean, 1 cases need review, 2 blockers (including a failed
 * required run) or a run did not report.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopePlan } from '../core/harness/plan';
import { compareReports, exitCodeOf, parseReport } from './compare';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function runLane(engine: 'web-pinned' | 'web-candidate', wasm: string, out: string, label: string) {
  const report = join(out, `${label}.jsonl`);
  rmSync(report, { force: true });
  const result = Bun.spawnSync(['bun', 'test', 'tests/regression/core'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GHOSTTY_REGRESSION_ENGINE: engine,
      GHOSTTY_REGRESSION_WASM: wasm,
      GHOSTTY_REGRESSION_REPORT: report,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const log = `${result.stdout.toString()}${result.stderr.toString()}`;
  writeFileSync(join(out, `${label}.log`), log);
  const tail = log.match(/^\s*\d+ (?:pass|fail)$/gm)?.join(', ') ?? 'no summary';
  console.log(`${label}: exit ${result.exitCode} (${tail.replace(/\s+/g, ' ')})`);
  if (!existsSync(report)) {
    throw new Error(`${label} run produced no report; see ${join(out, `${label}.log`)}`);
  }
  return { records: parseReport(readFileSync(report, 'utf8'), label), exitCode: result.exitCode };
}

if (import.meta.main) {
  const legacy = option('legacy');
  if (!legacy) {
    console.error('usage: run.ts --legacy <legacy.wasm> [--candidate <native.wasm>] [--out <dir>]');
    process.exit(64);
  }
  const candidate = option('candidate') ?? join(REPO_ROOT, 'ghostty-vt.wasm');
  const out = resolve(option('out') ?? join(REPO_ROOT, 'test-results', 'matrix'));
  mkdirSync(out, { recursive: true });
  try {
    const legacyRun = runLane('web-pinned', resolve(legacy), out, 'legacy');
    const candidateRun = runLane('web-candidate', resolve(candidate), out, 'candidate');
    const summary = compareReports(legacyRun.records, candidateRun.records, scopePlan());
    writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(
      JSON.stringify(
        {
          legacy: summary.legacy,
          candidate: summary.candidate,
          counts: summary.counts,
          gaps: { legacy: summary.gaps.legacy.length, candidate: summary.gaps.candidate.length },
          unplanned: summary.unplanned,
          blockers: summary.blockers,
          needsReview: summary.needsReview,
        },
        null,
        2
      )
    );
    console.log(`summary: ${join(out, 'summary.json')}`);
    // A required run that exited nonzero (for example a failing control test) is a blocker
    // even when every case record passed.
    const runsFailed = legacyRun.exitCode !== 0 || candidateRun.exitCode !== 0;
    if (runsFailed) console.error('a required core run exited nonzero; see the logs');
    process.exit(runsFailed ? 2 : exitCodeOf(summary));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}
