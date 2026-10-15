import { describe, expect, test } from 'bun:test';
import { assertCatalogueMatches, caseScope, idsForSuite, parseScopePlan } from './scope';

const entry = {
  id: 'example.case',
  required: ['web-candidate'],
  gaps: ['web-pinned'],
  unsupported: [],
  reason: 'Native implements this contract; the old engine still has the documented bug.',
};

const plan = () => parseScopePlan({ schema: 1, cases: [structuredClone(entry)] });

describe('required/gap scope contract', () => {
  test('native improvements stay required while legacy reproducers stay separate', () => {
    expect(caseScope(plan(), entry.id, 'web-candidate')).toBe('required');
    expect(caseScope(plan(), entry.id, 'web-pinned')).toBe('gap');
    expect(idsForSuite(plan(), 'web-candidate', 'required')).toEqual([entry.id]);
    expect(idsForSuite(plan(), 'web-pinned', 'gaps')).toEqual([entry.id]);
    expect(idsForSuite(plan(), 'web-candidate', 'gaps')).toEqual([]);
  });

  for (const [description, patch, message] of [
    ['unknown id', { id: '*' }, 'literal case id'],
    ['missing scope', { gaps: [] }, 'every engine must have an explicit scope'],
    ['overlap', { gaps: ['web-candidate', 'web-pinned'] }, 'multiple scopes'],
    ['duplicate engine', { required: ['web-candidate', 'web-candidate'] }, 'multiple scopes'],
    ['unknown engine', { required: ['reference'] }, 'unknown engine'],
    ['non-array scopes', { required: 'web-candidate' }, 'must be an array'],
    ['no reason for gap', { reason: '' }, 'gap/unsupported scope needs a reason'],
    [
      'failure exception embedded in scope',
      { failure: { actual: 1, expected: 2 } },
      'failure exemptions',
    ],
    ['old candidate allowance', { candidateReview: {} }, 'failure exemptions'],
  ] as const) {
    test(`rejects ${description}`, () => {
      expect(() => parseScopePlan({ schema: 1, cases: [{ ...entry, ...patch }] })).toThrow(message);
    });
  }

  test('rejects malformed plans and duplicate cases', () => {
    expect(() => parseScopePlan({ schema: 2, cases: [] })).toThrow('schema: 1');
    expect(() => parseScopePlan([])).toThrow('schema: 1');
    expect(() => parseScopePlan({ schema: 1, cases: [entry, entry] })).toThrow('Duplicate');
  });

  test('unknown tests fail closed, never default to a gap or disappear', () => {
    expect(() => caseScope(plan(), 'new.case', 'web-candidate')).toThrow('Unclassified case');
  });

  test('an unsupported ABI is explicit scope, not a passing test', () => {
    const value = parseScopePlan({
      schema: 1,
      cases: [{ ...entry, required: [], gaps: ['web-pinned'], unsupported: ['web-candidate'] }],
    });
    expect(caseScope(value, entry.id, 'web-candidate')).toBe('unsupported');
    expect(idsForSuite(value, 'web-candidate', 'required')).toEqual([]);
  });

  test('invalid suite modes do not silently select zero tests', () => {
    expect(() => idsForSuite(plan(), 'web-candidate', 'all-green' as never)).toThrow(
      'Unknown test suite'
    );
  });

  test('catalogue must exactly account for required, gap and unsupported cases', () => {
    expect(() => assertCatalogueMatches(plan(), [entry.id])).not.toThrow();
    expect(() => assertCatalogueMatches(plan(), [])).toThrow('missing cases');
    expect(() => assertCatalogueMatches(plan(), [entry.id, 'new.case'])).toThrow(
      'unclassified cases'
    );
    expect(() => assertCatalogueMatches(plan(), [entry.id, entry.id])).toThrow('Duplicate');
  });

  test('the returned plan owns its arrays, rather than mutating source evidence', () => {
    const input = { schema: 1, cases: [structuredClone(entry)] };
    const parsed = parseScopePlan(input);
    parsed.cases[0].required.length = 0;
    expect(input.cases[0].required).toEqual(['web-candidate']);
  });
});
