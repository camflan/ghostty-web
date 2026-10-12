/**
 * Browser catalogue integrity, independent of test ordering or filtering. Runs in
 * the required suite only (a control) and never reads historical failure data.
 */
import { expect } from '@playwright/test';
import { assertCatalogueMatches, idsForSuite } from '../regression/support/scope';
import { assertGapEntriesMirrorSpecs, declaredCases } from './support/case-catalogue';
import { controlTest } from './support/fixture';
import { browserSuite, loadScopePlan } from './support/suite';

controlTest('manifest.scope-catalogue-matches', () => {
  const plan = loadScopePlan();
  const declared = declaredCases();
  // Every declared case is classified, and every classified case is declared.
  assertCatalogueMatches(
    plan,
    declared.map((entry) => entry.id)
  );
  expect(declared.length).toBe(plan.cases.length);
  // Controls are required on both engines; nothing else may be a control.
  for (const entry of declared.filter((item) => item.kind === 'control')) {
    const scope = plan.cases.find((item) => item.id === entry.id)!;
    expect(scope.required, entry.id).toEqual(['web-pinned', 'web-candidate']);
  }
  // A case is never both required and a gap for the same engine.
  for (const engine of ['web-pinned', 'web-candidate'] as const) {
    const required = idsForSuite(plan, engine, 'required');
    const gaps = idsForSuite(plan, engine, 'gaps');
    expect(
      required.filter((id) => gaps.includes(id)),
      engine
    ).toEqual([]);
  }
  assertGapEntriesMirrorSpecs();
  expect(browserSuite()).toBe('required');
});
