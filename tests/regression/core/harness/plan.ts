/**
 * The core lane's reviewed scope plan and scenario inventory.
 *
 * `../scope.json` is the positive contract: a required run executes exactly
 * the ids it lists as required for the engine under test. Gap and unsupported
 * ids are inventory, never passes or skips. There is no fallback: a declared
 * case missing from the plan, or a planned case nobody declares, fails.
 *
 * This module deliberately does not import `bun:test`, so the matrix runner
 * (a plain `bun` script) can read the same plan.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type ScopePlan, parseScopePlan } from '../../support/scope';

/** Scenario definition files: `tests/scenarios/core/<name>.cases.ts`. */
export const SCENARIOS = [
  'api-contracts',
  'facade-capabilities',
  'keyboard',
  'lifecycle',
  'mouse',
  'paste-focus',
  'replies-events',
  'unicode-resize',
  'vt-corpus',
] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export const SCOPE_PLAN_URL = new URL('../scope.json', import.meta.url);
export const SCENARIO_DIR_URL = new URL('../../../scenarios/core/', import.meta.url);
/** Required entries live next to this harness and are found by default `bun test` discovery. */
export const REQUIRED_ENTRY_DIR_URL = new URL('../', import.meta.url);
/** The explicit, opt-in gap entry. Its `.gap.ts` name keeps it out of default discovery. */
export const GAP_ENTRY_URL = new URL('../../../gaps/core/core.gap.ts', import.meta.url);

export function scenarioPath(name: ScenarioName): string {
  return fileURLToPath(new URL(`${name}.cases.ts`, SCENARIO_DIR_URL));
}

let cached: ScopePlan | undefined;

export function scopePlan(): ScopePlan {
  cached ??= parseScopePlan(JSON.parse(readFileSync(SCOPE_PLAN_URL, 'utf8')));
  return cached;
}

/** Set by required CI workflows; the gap lane must never run (or pass) there. */
export const REQUIRED_CI_ENV = 'GHOSTTY_REQUIRED_CI';

export function assertGapLaneAllowed(env: Record<string, string | undefined> = process.env): void {
  if (env[REQUIRED_CI_ENV] === '1') {
    throw new Error(
      `Refusing to run the core gap lane: ${REQUIRED_CI_ENV}=1 marks a required-only CI run. ` +
        'Gap cases reproduce open bugs and are executed only on explicit local/opt-in request.'
    );
  }
}
