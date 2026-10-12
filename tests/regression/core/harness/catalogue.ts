/**
 * Static cross-check of the declared catalogue: case ids written as string
 * literals in `regressionCase('…'`, `legacyAbiCase('…'` or `abiCase(abi, '…'`
 * calls in the scenario files. Every literal must also appear in the runtime
 * inventory (harness/scenario.ts), so a case hidden behind a branch that never
 * runs cannot silently drop out of both lanes. Table- and fixture-driven ids
 * are covered by the runtime inventory itself.
 */
import { readFileSync } from 'node:fs';
import { SCENARIOS, type ScenarioName, scenarioPath } from './plan';

export function literalCaseIds(name: ScenarioName): string[] {
  const source = readFileSync(scenarioPath(name), 'utf8');
  return [
    ...source.matchAll(
      /(?:regressionCase|legacyAbiCase)\(\s*'([^']+)'|abiCase\(\s*'[^']+',\s*'([^']+)'/g
    ),
  ].map((match) => match[1] ?? match[2]);
}

export function allLiteralCaseIds(): Map<ScenarioName, string[]> {
  return new Map(SCENARIOS.map((name) => [name, literalCaseIds(name)]));
}
