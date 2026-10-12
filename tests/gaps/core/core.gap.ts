/**
 * Explicit core GAP lane: open bugs and future behaviour, kept out of the
 * required suite. It runs the ORIGINAL case bodies (tests/scenarios/core) for
 * the cases that tests/regression/core/scope.json classifies as gaps on the
 * engine under test, through the same strict assertions as the required lane.
 * A reproducing bug therefore fails its test and the run exits nonzero; a gap
 * that passes should be promoted to required in scope.json.
 *
 *   bun test ./tests/gaps/core/core.gap.ts            # native (repository ghostty-vt.wasm)
 *   GHOSTTY_REGRESSION_ENGINE=web-pinned GHOSTTY_REGRESSION_WASM=<legacy.wasm> \
 *     bun test ./tests/gaps/core/core.gap.ts          # legacy
 *
 * The `.gap.ts` name keeps it out of default `bun test` discovery; the path must
 * be explicit (`./` or absolute). It refuses to load when GHOSTTY_REQUIRED_CI=1.
 */
import { describe, test } from 'bun:test';
import { SCENARIOS, assertGapLaneAllowed } from '../../regression/core/harness/plan';
import { describeLane, registerScenarios } from '../../regression/core/harness/scenario';

assertGapLaneAllowed();
console.log(describeLane(await registerScenarios(SCENARIOS, 'gaps', { describe, test })));
