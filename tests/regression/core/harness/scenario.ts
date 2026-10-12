/**
 * One set of core case definitions, two physically separate lanes.
 *
 * Scenario files (`tests/scenarios/core/<name>.cases.ts`) import `describe`,
 * `test`, `expect`, `regressionCase`, `abiCase` and `legacyAbiCase` from here
 * instead of `bun:test`. Loading a scenario only RECORDS its definitions; an
 * entry file then replays them into Bun for exactly one lane:
 *
 * - required: `tests/regression/core/<name>.test.ts` (default `bun test`
 *   discovery) registers the plan's required cases for the engine under test,
 *   plus the scenario's control tests;
 * - gaps: `tests/gaps/core/core.gap.ts` (explicit path only, refused when
 *   GHOSTTY_REQUIRED_CI=1) registers the plan's gap cases and nothing else.
 *
 * Both lanes run the unmodified case bodies through the strict shared
 * `runRegression`, so a failing assertion fails the Bun test in either lane.
 * The lane is a literal argument in the entry file, never an environment
 * variable. Cases outside a lane are not registered at all: they are neither
 * passes nor skips, only `scope` report records and inventory counts.
 *
 * Registration fails closed (the entry throws while loading, so `bun test`
 * exits nonzero) when a declared case is not in the plan, a planned case is
 * not declared by any scenario, an id is declared twice, an ABI case's
 * applicability disagrees with its `unsupported` scope, an entry selects no
 * cases, or the tests Bun registered differ from the plan's selection.
 *
 * The engine is the identity of the loaded binary (harness/identity.ts), never
 * a free label, so scope is always looked up for the engine actually running.
 *
 * Bun binds `describe`/`test` imported from 'bun:test' to the first test file
 * that loaded a shared module, and silently misfiles or drops registrations
 * made through them from later files. Entries therefore pass their OWN
 * `describe` and `test` in; this module never registers through its import.
 */
import { type describe as bunDescribe, expect as bunExpect, type test as bunTest } from 'bun:test';
import { type RegressionChecks, runRegression } from '../../support/regression';
import {
  type CaseKind,
  type ScopePlan,
  type SuiteKind,
  assertCatalogueMatches,
  caseScope,
  idsForSuite,
} from '../../support/scope';
import { type BackendKind, type EngineIdentity, type WebEngine, engineIdentity } from './identity';
import {
  SCENARIOS,
  type ScenarioName,
  assertGapLaneAllowed,
  scenarioPath,
  scopePlan,
} from './plan';
import { recordResult, signatureOf } from './report';

/** Bun's `expect`, for control tests (a re-export from 'bun:test' is not supported by Bun). */
export const expect: typeof bunExpect = bunExpect;

export type CaseBody = (checks: RegressionChecks) => void | Promise<void>;
type ControlBody = Parameters<typeof bunTest>[1];

/** The calling entry file's own Bun registration functions. */
export interface BunRegistrar {
  describe: typeof bunDescribe;
  test: typeof bunTest;
}

type CaseDefinition = {
  kind: 'case';
  id: string;
  body: CaseBody;
  timeoutMs: number;
  abi?: BackendKind;
};

export type Definition =
  | { kind: 'describe'; name: string; body: () => void }
  | { kind: 'control'; name: string; body: ControlBody; timeoutMs?: number }
  | CaseDefinition;

export interface DeclaredCase {
  id: string;
  /** Set for cases that exercise one backend's ABI only. */
  abi?: BackendKind;
}

interface Lane {
  /** 'inventory' walks the definitions without registering anything with Bun. */
  mode: 'inventory' | SuiteKind;
  declared: DeclaredCase[];
  /** Ids actually handed to Bun's test(). */
  registered: string[];
  /** The plan's selection for this lane (empty for inventory walks). */
  selected: ReadonlySet<string>;
  controls: string[];
  identity?: EngineIdentity;
  bun?: BunRegistrar;
}

const KINDS: readonly CaseKind[] = ['required', 'gap', 'unsupported'];

let collecting: Definition[] | undefined;
let lane: Lane | undefined;

function within<T>(next: Lane, body: () => T): T {
  const previous = lane;
  lane = next;
  try {
    return body();
  } finally {
    lane = previous;
  }
}

function currentLane(what: string): Lane {
  if (!lane) {
    throw new Error(
      `${what}: core scenario definitions must be loaded and registered through harness/scenario.ts`
    );
  }
  return lane;
}

function replay(definition: Definition): void {
  if (definition.kind === 'describe') describe(definition.name, definition.body);
  else if (definition.kind === 'control')
    test(definition.name, definition.body, definition.timeoutMs);
  else declareCase(definition);
}

// ---------------------------------------------------------------------------
// The API scenario files use (same names and signatures as before the split).

export function describe(name: string, body: () => void): void {
  if (collecting) {
    collecting.push({ kind: 'describe', name, body });
    return;
  }
  const active = currentLane(`describe(${name})`);
  if (active.mode === 'inventory' || !active.bun) {
    body();
    return;
  }
  active.bun.describe(name, () => within(active, body));
}

/** A control/metadata test: registered in the required lane only. */
export function test(name: string, body: ControlBody, timeoutMs?: number): void {
  if (collecting) {
    collecting.push({ kind: 'control', name, body, timeoutMs });
    return;
  }
  const active = currentLane(`test(${name})`);
  active.controls.push(name);
  if (active.mode === 'required' && active.bun) active.bun.test(name, body, timeoutMs);
}

export function regressionCase(id: string, body: CaseBody, timeoutMs = 15_000): void {
  declareCase({ kind: 'case', id, body, timeoutMs });
}

/**
 * A conformance case for one backend's ABI (for example the legacy bridge's raw
 * numeric key codes). The plan must mark every other backend's engine
 * `unsupported`: inventory metadata, never a passing or skipped test.
 */
export function abiCase(abi: BackendKind, id: string, body: CaseBody, timeoutMs = 15_000): void {
  declareCase({ kind: 'case', id, body, timeoutMs, abi });
}

/** Shorthand for cases that test the legacy (pinned) ABI specifically. */
export function legacyAbiCase(id: string, body: CaseBody, timeoutMs = 15_000): void {
  abiCase('legacy', id, body, timeoutMs);
}

function declareCase(definition: CaseDefinition): void {
  if (collecting) {
    collecting.push(definition);
    return;
  }
  const active = currentLane(definition.id);
  if (active.declared.some((c) => c.id === definition.id)) {
    throw new Error(`Duplicate regression case id: ${definition.id}`);
  }
  active.declared.push(
    definition.abi ? { id: definition.id, abi: definition.abi } : { id: definition.id }
  );
  const { mode, identity, bun } = active;
  if (mode === 'inventory' || !identity || !bun || !active.selected.has(definition.id)) return;
  active.registered.push(definition.id);
  bun.test(
    definition.id,
    () => execute(definition.id, definition.body, mode, identity),
    definition.timeoutMs
  );
}

async function execute(
  id: string,
  body: CaseBody,
  suite: SuiteKind,
  { engine, backend, wasmSha256 }: EngineIdentity
): Promise<void> {
  const base = { v: 2 as const, id, engine, backend, wasmSha256, suite };
  try {
    await runRegression(id, body);
  } catch (error) {
    recordResult({ ...base, kind: 'case', outcome: 'fail', signature: signatureOf(error) });
    throw error;
  }
  recordResult({ ...base, kind: 'case', outcome: 'pass' });
}

// ---------------------------------------------------------------------------
// Loading and inventory.

function assertIdle(what: string): void {
  if (collecting || lane) throw new Error(`${what}: another scenario is loading or registering`);
}

/** Records definitions made synchronously by `define` (used by self-tests). */
export function collectDefinitions(define: () => void): Definition[] {
  assertIdle('collectDefinitions');
  const definitions: Definition[] = [];
  collecting = definitions;
  try {
    define();
  } finally {
    collecting = undefined;
  }
  return definitions;
}

const loaded = new Map<ScenarioName, Definition[]>();

/** Loads a scenario module once per process and returns its recorded definitions. */
export async function loadScenario(name: ScenarioName): Promise<Definition[]> {
  const cached = loaded.get(name);
  if (cached) return cached;
  assertIdle(`loadScenario(${name})`);
  const definitions: Definition[] = [];
  collecting = definitions;
  try {
    await import(scenarioPath(name));
  } finally {
    collecting = undefined;
  }
  if (definitions.length === 0) {
    throw new Error(
      `${name}.cases.ts recorded no definitions; load scenarios only via loadScenario`
    );
  }
  loaded.set(name, definitions);
  return definitions;
}

export async function loadAllScenarios(): Promise<Map<ScenarioName, Definition[]>> {
  const catalogue = new Map<ScenarioName, Definition[]>();
  for (const name of SCENARIOS) catalogue.set(name, await loadScenario(name));
  return catalogue;
}

export interface ScenarioInventory {
  cases: DeclaredCase[];
  /** Control/metadata test names (required lane only). */
  controls: string[];
}

const inventories = new WeakMap<readonly Definition[], ScenarioInventory>();

/** Every case and control a scenario declares, without registering anything. */
export function inventoryOf(definitions: readonly Definition[]): ScenarioInventory {
  const cached = inventories.get(definitions);
  if (cached) return cached;
  assertIdle('inventoryOf');
  const walk: Lane = {
    mode: 'inventory',
    declared: [],
    registered: [],
    selected: new Set(),
    controls: [],
  };
  within(walk, () => {
    for (const definition of definitions) replay(definition);
  });
  const result = { cases: walk.declared, controls: walk.controls };
  inventories.set(definitions, result);
  return result;
}

/** An ABI case is unsupported exactly where its ABI is not the backend under test. */
export function assertApplicability(
  declared: DeclaredCase,
  kind: CaseKind,
  backend: BackendKind,
  engine: WebEngine
): void {
  if (declared.abi === undefined) {
    if (kind === 'unsupported') {
      throw new Error(
        `${declared.id}: only ABI-specific cases may be unsupported; classify it required or gap on ${engine}`
      );
    }
    return;
  }
  const applies = declared.abi === backend;
  if (applies && kind === 'unsupported') {
    throw new Error(
      `${declared.id}: targets the ${declared.abi} ABI under test, so ${engine} cannot be unsupported`
    );
  }
  if (!applies && kind !== 'unsupported') {
    throw new Error(
      `${declared.id}: targets the ${declared.abi} ABI; ${engine} (${backend}) must be unsupported, not ${kind}`
    );
  }
}

// ---------------------------------------------------------------------------
// Registration.

export interface ScenarioRegistration {
  scenario: string;
  /** Registered with Bun and executed in this lane. */
  executed: string[];
  /** Declared but deliberately not registered in this lane, by plan scope. */
  withheld: Record<CaseKind, string[]>;
  controls: { registered: number; withheld: number };
}

export interface LaneRegistration {
  suite: SuiteKind;
  engine: WebEngine;
  backend: BackendKind;
  wasmSha256: string;
  scenarios: ScenarioRegistration[];
  executed: string[];
}

export interface LaneOptions {
  suite: SuiteKind;
  plan: ScopePlan;
  /** Every scenario of the catalogue: the plan must account for all of them exactly. */
  catalogue: ReadonlyMap<string, readonly Definition[]>;
  /** The scenarios this entry registers. */
  select: readonly string[];
  bun: BunRegistrar;
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  return left.size === a.length && a.length === b.length && b.every((id) => left.has(id));
}

function list(ids: readonly string[]): string {
  return `[${[...ids].sort().join(', ')}]`;
}

export function registerLane({
  suite,
  plan,
  catalogue,
  select,
  bun,
}: LaneOptions): LaneRegistration {
  if (suite !== 'required' && suite !== 'gaps') throw new Error(`Unknown lane: ${String(suite)}`);
  if (suite === 'gaps') assertGapLaneAllowed();
  const identity = engineIdentity();
  const { engine, backend, wasmSha256 } = identity;
  const wanted: CaseKind = suite === 'required' ? 'required' : 'gap';

  const declaredBy = new Map<string, DeclaredCase[]>();
  for (const [scenario, definitions] of catalogue) {
    declaredBy.set(scenario, inventoryOf(definitions).cases);
  }
  assertCatalogueMatches(
    plan,
    [...declaredBy.values()].flat().map((c) => c.id)
  );
  if (new Set(select).size !== select.length) throw new Error(`Duplicate scenarios: ${select}`);

  const scenarios = select.map((scenario): ScenarioRegistration => {
    const definitions = catalogue.get(scenario);
    const declared = declaredBy.get(scenario);
    if (!definitions || !declared) throw new Error(`Unknown scenario: ${scenario}`);
    const withheld: Record<CaseKind, string[]> = { required: [], gap: [], unsupported: [] };
    const selected: string[] = [];
    for (const item of declared) {
      const kind = caseScope(plan, item.id, engine);
      assertApplicability(item, kind, backend, engine);
      if (kind === wanted) selected.push(item.id);
      else withheld[kind].push(item.id);
    }
    const active: Lane = {
      mode: suite,
      declared: [],
      registered: [],
      selected: new Set(selected),
      controls: [],
      identity,
      bun,
    };
    within(active, () => {
      for (const definition of definitions) replay(definition);
    });
    if (!sameMembers(active.registered, selected)) {
      throw new Error(
        `${scenario}: Bun registered ${list(active.registered)} but the ${suite} plan selects ${list(selected)} on ${engine}`
      );
    }
    for (const kind of KINDS) {
      for (const id of withheld[kind]) {
        recordResult({ v: 2, kind: 'scope', id, engine, backend, wasmSha256, suite, scope: kind });
      }
    }
    const controls = active.controls.length;
    return {
      scenario,
      executed: active.registered,
      withheld,
      controls:
        suite === 'required'
          ? { registered: controls, withheld: 0 }
          : { registered: 0, withheld: controls },
    };
  });

  const executed = scenarios.flatMap((s) => s.executed);
  if (executed.length === 0) {
    throw new Error(
      `The core ${suite} entry for [${select.join(', ')}] selects no cases on ${engine}; ` +
        'an entry must execute at least one planned case'
    );
  }
  if (select.length === catalogue.size) {
    const expected = idsForSuite(plan, engine, suite);
    if (!sameMembers(executed, expected)) {
      throw new Error(
        `The ${suite} lane registered ${list(executed)}; the plan selects ${list(expected)}`
      );
    }
  }
  return { suite, engine, backend, wasmSha256, scenarios, executed };
}

/**
 * The entry point for core lanes. `suite` must be a literal in the entry file:
 * required entries pass 'required', the explicit gap entry passes 'gaps'.
 */
export async function registerScenarios(
  select: readonly ScenarioName[],
  suite: SuiteKind,
  bun: BunRegistrar
): Promise<LaneRegistration> {
  if (suite === 'gaps') assertGapLaneAllowed();
  const catalogue = await loadAllScenarios();
  return registerLane({ suite, plan: scopePlan(), catalogue, select, bun });
}

/** One-line inventory for logs: executed cases versus metadata-only scope. */
export function describeLane(registration: LaneRegistration): string {
  const count = (kind: CaseKind) =>
    registration.scenarios.reduce((n, s) => n + s.withheld[kind].length, 0);
  const controls = registration.scenarios.reduce(
    (n, s) => n + s.controls.registered + s.controls.withheld,
    0
  );
  const executedKind = registration.suite === 'required' ? 'required' : 'gap';
  const notHere = KINDS.filter((kind) => kind !== executedKind)
    .map((kind) => `${count(kind)} ${kind}`)
    .join(', ');
  return (
    `core ${registration.suite} lane [${registration.engine} ${registration.wasmSha256.slice(0, 12)}]: ` +
    `executing ${registration.executed.length} ${executedKind} cases; not executed here (inventory only): ` +
    `${notHere}; ${controls} control tests ${registration.suite === 'required' ? 'registered' : 'withheld (required lane only)'}`
  );
}
