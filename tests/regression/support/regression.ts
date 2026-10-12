import { isDeepStrictEqual } from 'node:util';

export type EngineId = 'web-pinned' | 'web-candidate' | 'reference';
export const DEFAULT_REGRESSION_ENGINE: EngineId = 'web-candidate';
const ENGINES: readonly string[] = ['web-pinned', 'web-candidate', 'reference'];
const IDENTIFIER = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export function regressionEngine(): EngineId {
  const engine = process.env.GHOSTTY_REGRESSION_ENGINE ?? DEFAULT_REGRESSION_ENGINE;
  if (!ENGINES.includes(engine)) throw new Error(`Unknown regression engine: ${engine}`);
  return engine as EngineId;
}

export class RegressionAssertionError extends Error {
  constructor(
    public readonly assertion: string,
    public readonly actual: unknown,
    public readonly expected: unknown
  ) {
    super(`${assertion}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    this.name = 'RegressionAssertionError';
  }
}

export interface RegressionChecks {
  equal(assertionId: string, actual: unknown, expected: unknown): void;
  requireCapabilities(
    available: readonly string[] | ReadonlySet<string>,
    required: readonly string[]
  ): void;
}

/**
 * The assertion runner for BOTH required and gap tests. Every failed assertion
 * or exception propagates. There is deliberately no allowlist, expected-failure
 * signature, engine-specific exemption, retry, or 'known failure' success state.
 * Suite membership is decided separately, before test registration.
 */
export async function runRegression(
  id: string,
  body: (checks: RegressionChecks) => void | Promise<void>
): Promise<void> {
  if (!IDENTIFIER.test(id)) throw new Error(`Invalid regression id: ${id}`);
  if (typeof body !== 'function') throw new Error(`${id}: an assertion callback is required`);
  let assertions = 0;
  await body({
    equal(assertion, actual, expected) {
      if (!IDENTIFIER.test(assertion)) throw new Error(`Invalid assertion id: ${assertion}`);
      assertions++;
      if (!isDeepStrictEqual(actual, expected)) {
        throw new RegressionAssertionError(assertion, actual, expected);
      }
    },
    requireCapabilities(available, required) {
      const capabilities = new Set(available);
      const missing = required.filter((capability) => !capabilities.has(capability));
      if (missing.length > 0) {
        throw new Error(`${id}: required capabilities missing: ${missing.join(', ')}`);
      }
    },
  });
  if (assertions === 0) throw new Error(`${id}: no assertions executed`);
}
