/**
 * Catalogue and scope integrity (control tests, required lane only): the
 * reviewed plan in ./scope.json accounts for exactly the declared cases, every
 * scenario has a required entry, native fixes stay required on native, and
 * the gap backlog cannot silently absorb a native regression.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type WebEngine, assertCatalogueMatches, caseScope, idsForSuite } from '../support/scope';
import { allLiteralCaseIds } from './harness/catalogue';
import { GAP_ENTRY_URL, REQUIRED_ENTRY_DIR_URL, SCENARIOS, scopePlan } from './harness/plan';
import { inventoryOf, loadAllScenarios } from './harness/scenario';

const ENGINES: readonly WebEngine[] = ['web-pinned', 'web-candidate'];
const catalogue = await loadAllScenarios();
const declared = new Map(
  [...catalogue].map(([name, definitions]) => [name, inventoryOf(definitions).cases])
);
const plan = scopePlan();

// Legacy failures fixed by the native core or native host integration. They
// must stay REQUIRED on native even though they remain legacy gaps.
const NATIVE_FIXED = [
  'api.select-wide-characters',
  'api.select-soft-wrapped-line',
  'api.select-all-includes-history',
  'event.bell-not-from-osc-terminator',
  'event.bell-not-from-osc8-terminators',
  'event.title-uint8array',
  'event.title-split-across-writes',
  'focus.blur-report',
  'focus.focus-report',
  'focus.report-on-enable',
  'paste.unbracketed-newline-to-cr',
  'paste.unbracketed-control-bytes',
  'paste.bracketed-end-marker-neutralised',
  'mouse.sgr-alt-press',
  'mouse.sgr-meta-press',
  'mouse.shift-bypasses-reporting',
  'mouse.motion-deduplicated-per-cell',
  'mouse.any-motion-no-button',
  'mouse.x10-beyond-223-dropped',
  'mouse.wheel-reported-when-tracking',
  'mouse.wheel-alt-screen-tracking',
  'key.alt-b',
  'key.alt-period',
  'key.ctrl-alt-c',
  'key.shift-f5',
  'key.shift-home',
  'key.home-decckm',
  'encoder.unshifted-codepoint-honoured',
  'grapheme.clustering-survives-ris',
  'key-encoding.pause',
  'key-encoding.print-screen',
  'key-encoding.scroll-lock',
  'key.kitty1-ctrl-c',
  'key.kitty1-escape',
  'key.kitty1-shift-enter',
  'key.kitty3-release',
  'mouse.mode-reset-turns-reporting-off',
  'mouse.x10-mode9-press',
  'reply.decrqm-2004-reset',
  'reply.decrqm-2004-set',
  'reply.decrqm-2026',
  'reply.kitty-keyboard-query',
  'reply.text-area-size-chars',
  'reply.xtversion-is-dcs',
  'resize.narrow-drops-orphan-wide-head',
  'scrollback.zero-means-none',
];

describe('core scope plan', () => {
  test('the plan accounts for exactly the declared cases (no unknown, missing or duplicate ids)', () => {
    const ids = [...declared.values()].flat().map((c) => c.id);
    expect(ids.length).toBeGreaterThan(200);
    expect(() => assertCatalogueMatches(plan, ids)).not.toThrow();
  });

  test('every literal case id in a scenario file is declared at runtime', () => {
    for (const [name, literals] of allLiteralCaseIds()) {
      const ids = new Set(declared.get(name)?.map((c) => c.id));
      expect({ name, undeclared: literals.filter((id) => !ids.has(id)) }).toEqual({
        name,
        undeclared: [],
      });
    }
  });

  test('every scenario has a required entry and executes required cases on both engines', () => {
    for (const name of SCENARIOS) {
      const entry = new URL(`${name}.test.ts`, REQUIRED_ENTRY_DIR_URL);
      expect(readFileSync(entry, 'utf8')).toContain(
        `await registerScenarios(['${name}'], 'required', { describe, test });`
      );
      for (const engine of ENGINES) {
        const required = (declared.get(name) ?? []).filter(
          (c) => caseScope(plan, c.id, engine) === 'required'
        );
        expect({ name, engine, empty: required.length === 0 }).toEqual({
          name,
          engine,
          empty: false,
        });
      }
    }
  });

  test('ABI cases are unsupported exactly on the other backend, and only ABI cases are', () => {
    const abiOf = new Map([...declared.values()].flat().map((c) => [c.id, c.abi]));
    for (const entry of plan.cases) {
      const abi = abiOf.get(entry.id);
      const expected: WebEngine[] =
        abi === undefined ? [] : abi === 'legacy' ? ['web-candidate'] : ['web-pinned'];
      expect({ id: entry.id, unsupported: entry.unsupported }).toEqual({
        id: entry.id,
        unsupported: expected,
      });
    }
  });

  test('verified fixes retain their required native or shared scope', () => {
    for (const id of ['api.buffer-translate-keeps-blank-cells', 'api.buffer-get-chars-grapheme']) {
      for (const engine of ENGINES) expect(caseScope(plan, id, engine)).toBe('required');
    }
    for (const id of NATIVE_FIXED) {
      expect([id, caseScope(plan, id, 'web-candidate'), caseScope(plan, id, 'web-pinned')]).toEqual(
        [id, 'required', 'gap']
      );
    }
  });

  test('a native gap is never a native regression: it must also be a legacy gap', () => {
    const legacyGaps = new Set(idsForSuite(plan, 'web-pinned', 'gaps'));
    expect(idsForSuite(plan, 'web-candidate', 'gaps').filter((id) => !legacyGaps.has(id))).toEqual(
      []
    );
  });

  test('the old known-failure manifest is archived, not used by the required lane', () => {
    expect(existsSync(new URL('./known-failures.json', import.meta.url))).toBe(false);
    expect(
      existsSync(
        new URL('../../gaps/core/history/core-known-failures-2026-10-10.json', import.meta.url)
      )
    ).toBe(true);
  });

  test('gap entries are explicit only: nothing under tests/gaps is a default-discovered test file', () => {
    expect(existsSync(GAP_ENTRY_URL)).toBe(true);
    const dir = fileURLToPath(new URL('../../gaps/', import.meta.url));
    const files = readdirSync(dir, { recursive: true }).map(String);
    expect(files.filter((f) => /(\.|_)(test|spec)(\.|_)/.test(f))).toEqual([]);
  });

  test('inventory (metadata, not test counts)', () => {
    for (const engine of ENGINES) {
      const counts = Object.fromEntries(
        (['required', 'gap', 'unsupported'] as const).map((kind) => [
          kind,
          plan.cases.filter((c) => caseScope(plan, c.id, engine) === kind).length,
        ])
      );
      console.log(
        `core scope [${engine}]: ${counts.required} required, ${counts.gap} gap (bun test ./tests/gaps/core/core.gap.ts), ${counts.unsupported} unsupported`
      );
      expect(counts.required + counts.gap + counts.unsupported).toBe(plan.cases.length);
    }
  });
});
