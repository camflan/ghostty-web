/**
 * Browser scope inventory: what each suite registers for each web engine.
 *
 *   bun tests/browser/inventory.ts           # counts + ids
 *   bun tests/browser/inventory.ts --json    # machine-readable
 *
 * Static: reads tests/browser/scope.json and the AST catalogue of the specs; it
 * never runs tests or reads historical failure data. Exits 1 if the catalogue
 * and scope.json disagree.
 */
import { assertCatalogueMatches, caseScope, idsForSuite } from '../regression/support/scope';
import { assertGapEntriesMirrorSpecs, declaredCases } from './support/case-catalogue';
import { DYNAMIC_CASE_IDS, loadScopePlan } from './support/suite';

const ENGINES = ['web-candidate', 'web-pinned'] as const;

const plan = loadScopePlan();
const declared = declaredCases();
assertCatalogueMatches(
  plan,
  declared.map((entry) => entry.id)
);
assertGapEntriesMirrorSpecs();

const controls = declared.filter((entry) => entry.kind === 'control').map((entry) => entry.id);
const report = {
  declared: declared.length,
  controls,
  dynamicTemplates: DYNAMIC_CASE_IDS,
  engines: Object.fromEntries(
    ENGINES.map((engine) => {
      const required = idsForSuite(plan, engine, 'required');
      const gaps = idsForSuite(plan, engine, 'gaps');
      const unsupported = plan.cases
        .filter((entry) => caseScope(plan, entry.id, engine) === 'unsupported')
        .map((entry) => entry.id);
      return [
        engine,
        {
          required: required.length,
          requiredCases: required.filter((id) => !controls.includes(id)).length,
          requiredControls: controls.length,
          gaps: gaps.length,
          unsupported: unsupported.length,
          gapIds: gaps,
          unsupportedIds: unsupported,
          requiredIds: required,
        },
      ];
    })
  ),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`declared browser cases: ${report.declared} (${controls.length} required controls)`);
  for (const engine of ENGINES) {
    const e = report.engines[engine];
    console.log(
      `\n${engine}: required ${e.required} (${e.requiredCases} cases + ${e.requiredControls} controls), ` +
        `gaps ${e.gaps}, unsupported ${e.unsupported}`
    );
    for (const id of e.gapIds) {
      console.log(`  gap  ${id}: ${plan.cases.find((c) => c.id === id)?.reason}`);
    }
    for (const id of e.unsupportedIds) console.log(`  unsupported  ${id}`);
  }
}
