/**
 * Explicit, reviewed suite membership. A required run uses the positive required
 * list, never failure matching or 'anything not in the backlog'. Unknown cases
 * fail closed. Changing membership is a reviewable contract edit, not a runtime
 * response to a test failing.
 */
export type WebEngine = 'web-pinned' | 'web-candidate';
export type SuiteKind = 'required' | 'gaps';
export type CaseKind = 'required' | 'gap' | 'unsupported';

export interface CaseScope {
  id: string;
  required: WebEngine[];
  gaps: WebEngine[];
  unsupported: WebEngine[];
  /** Required for gaps/unsupported cases: why this is outside the current contract. */
  reason?: string;
}

export interface ScopePlan {
  schema: 1;
  cases: CaseScope[];
}

const ENGINES: readonly WebEngine[] = ['web-pinned', 'web-candidate'];
const KEYS = ['required', 'gaps', 'unsupported'] as const;
const IDENTIFIER = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseScopePlan(input: unknown): ScopePlan {
  if (!record(input) || input.schema !== 1 || !Array.isArray(input.cases)) {
    throw new Error('Scope plan must have schema: 1 and a cases array');
  }
  const ids = new Set<string>();
  const cases = input.cases.map((value: unknown): CaseScope => {
    if (!record(value) || typeof value.id !== 'string' || !IDENTIFIER.test(value.id)) {
      throw new Error('Each scope entry needs a literal case id');
    }
    if (ids.has(value.id)) throw new Error(`Duplicate scope id: ${value.id}`);
    ids.add(value.id);
    const seen = new Set<WebEngine>();
    for (const key of KEYS) {
      const engines = value[key];
      if (!Array.isArray(engines)) throw new Error(`${value.id}: ${key} must be an array`);
      for (const engine of engines) {
        if (!ENGINES.includes(engine))
          throw new Error(`${value.id}: unknown engine ${String(engine)}`);
        if (seen.has(engine)) throw new Error(`${value.id}: engine ${engine} has multiple scopes`);
        seen.add(engine);
      }
    }
    if (seen.size !== ENGINES.length)
      throw new Error(`${value.id}: every engine must have an explicit scope`);
    const hasReason = typeof value.reason === 'string' && value.reason.trim().length > 0;
    if (
      ((value.gaps as unknown[]).length || (value.unsupported as unknown[]).length) &&
      !hasReason
    ) {
      throw new Error(`${value.id}: gap/unsupported scope needs a reason`);
    }
    if ('failure' in value || 'candidateReview' in value || 'expectedFailure' in value) {
      throw new Error(`${value.id}: scope cannot contain failure exemptions`);
    }
    return {
      id: value.id,
      required: [...(value.required as WebEngine[])],
      gaps: [...(value.gaps as WebEngine[])],
      unsupported: [...(value.unsupported as WebEngine[])],
      ...(hasReason ? { reason: value.reason as string } : {}),
    };
  });
  return { schema: 1, cases };
}

export function caseScope(plan: ScopePlan, id: string, engine: WebEngine): CaseKind {
  if (!ENGINES.includes(engine)) throw new Error(`Unsupported scope engine: ${engine}`);
  const entry = plan.cases.find((item) => item.id === id);
  if (!entry)
    throw new Error(`Unclassified case: ${id}; declare its required/gap scope explicitly`);
  if (entry.required.includes(engine)) return 'required';
  if (entry.gaps.includes(engine)) return 'gap';
  if (entry.unsupported.includes(engine)) return 'unsupported';
  throw new Error(`${id}: missing scope for ${engine}`);
}

export function idsForSuite(plan: ScopePlan, engine: WebEngine, suite: SuiteKind): string[] {
  if (suite !== 'required' && suite !== 'gaps')
    throw new Error(`Unknown test suite: ${String(suite)}`);
  const kind = suite === 'required' ? 'required' : 'gap';
  return plan.cases
    .filter((entry) => caseScope(plan, entry.id, engine) === kind)
    .map((entry) => entry.id);
}

/** Exact coverage, including backlog cases, so removal cannot make an oracle disappear. */
export function assertCatalogueMatches(plan: ScopePlan, ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate declared case ids');
  if (new Set(plan.cases.map((entry) => entry.id)).size !== plan.cases.length) {
    throw new Error('Duplicate scope ids');
  }
  const declared = new Set(ids);
  const planned = new Set(plan.cases.map((entry) => entry.id));
  const missing = [...planned].filter((id) => !declared.has(id));
  const unknown = [...declared].filter((id) => !planned.has(id));
  if (missing.length || unknown.length) {
    throw new Error(
      `Catalogue mismatch: missing cases [${missing.join(', ')}]; unclassified cases [${unknown.join(', ')}]`
    );
  }
}
