/**
 * Required/gap suite selection for the browser lane.
 *
 * - `tests/browser/scope.json` is the frozen, reviewed positive plan: every case id
 *   is `required`, `gap` or `unsupported` for each web engine (shared contract in
 *   tests/regression/support/scope.ts). Nothing here reads historical failure data.
 * - The suite comes from the Playwright config that loaded the specs:
 *   `playwright.config.ts` always sets `required`; `playwright.gaps.config.ts`
 *   sets `gaps`. Specs refuse to load without it (fail closed).
 * - A required run registers exactly the cases whose scope is `required` for the
 *   engine (a positive list, not "everything except gaps") plus the direct control
 *   tests. A gap run registers exactly the `gap` cases and nothing else. Cases that
 *   are not registered are not skipped or counted; `bun tests/browser/inventory.ts`
 *   reports the split.
 */

import { readFileSync } from 'node:fs';
import { type EngineId, regressionEngine } from '../../regression/support/regression';
import {
  type ScopePlan,
  type SuiteKind,
  type WebEngine,
  caseScope,
  parseScopePlan,
} from '../../regression/support/scope';

export const SCOPE_URL = new URL('../scope.json', import.meta.url);
export const SUITE_ENV = 'GHOSTTY_BROWSER_SUITE';
/** Recorded in config metadata so each test can prove which config loaded it. */
export const SUITE_METADATA_KEY = 'ghosttyBrowserSuite';

/**
 * Case ids built from template literals at their registration site. Listed
 * literally so the static catalogue and the inventory never depend on evaluating
 * spec code; `manifest.scope-catalogue-matches` and the --list contract test
 * prove the expansions are exactly what registers.
 */
export const DYNAMIC_CASE_IDS: Readonly<Record<string, readonly string[]>> = {
  'comparator.detects-single-cell-edits-at-${dpr}': [
    'comparator.detects-single-cell-edits-at-1',
    'comparator.detects-single-cell-edits-at-2',
  ],
  'comparator.tolerance-and-png-encoding-at-${dpr}': [
    'comparator.tolerance-and-png-encoding-at-1',
    'comparator.tolerance-and-png-encoding-at-2',
  ],
  // One per entry of SCENES in scenes/catalogue.ts (eight reviewed baselines).
  'scene.${scene.id}': [
    'scene.dark-styles',
    'scene.light-theme',
    'scene.alternate-font',
    'scene.multiline-selection',
    'scene.history-viewport',
    'scene.wrapped-text',
    'scene.bar-cursor',
    'scene.resized-grid',
  ],
};

export function browserSuite(): SuiteKind {
  const suite = process.env[SUITE_ENV];
  if (suite !== 'required' && suite !== 'gaps') {
    throw new Error(
      `${SUITE_ENV} is ${JSON.stringify(suite)}; browser specs only run through ` +
        'playwright.config.ts (required) or playwright.gaps.config.ts (gaps)'
    );
  }
  return suite;
}

export function webEngine(engine: EngineId = regressionEngine()): WebEngine {
  if (engine !== 'web-pinned' && engine !== 'web-candidate') {
    throw new Error(
      `GHOSTTY_REGRESSION_ENGINE=${engine} is not applicable to the browser lane, which drives ghostty-web`
    );
  }
  return engine;
}

export function loadScopePlan(): ScopePlan {
  return parseScopePlan(JSON.parse(readFileSync(SCOPE_URL, 'utf8')));
}

/** Whether a regression case is registered; unknown ids throw (unclassified). */
export function registersCase(
  plan: ScopePlan,
  id: string,
  engine: WebEngine,
  suite: SuiteKind
): boolean {
  const kind = caseScope(plan, id, engine);
  return suite === 'required' ? kind === 'required' : kind === 'gap';
}

/**
 * Whether a direct control test is registered. Controls (negative controls of the
 * harness itself, catalogue integrity) must be required on every engine and never
 * appear in a gap run.
 */
export function registersControl(plan: ScopePlan, id: string, suite: SuiteKind): boolean {
  for (const engine of ['web-pinned', 'web-candidate'] as const) {
    if (caseScope(plan, id, engine) !== 'required') {
      throw new Error(`${id}: control tests must be required on every engine (${engine})`);
    }
  }
  return suite === 'required';
}
