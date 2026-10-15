/**
 * Upstream-reference regression lane (run explicitly; intentionally NOT a *.test.ts file so
 * `bun test` can never silently skip it).
 *
 *   GHOSTTY_REFERENCE_WASM=/abs/ghostty-vt.wasm bun tests/regression/reference/run.ts
 *
 * Env:
 *   GHOSTTY_REFERENCE_WASM         required; WASM from scripts/build-reference-wasm.sh. Its
 *                                  sha256 must equal ghostty-build.json
 *                                  targets["libghostty-vt"].wasmSha256; any other artifact
 *                                  is a setup error (no alternate-hash mode)
 *   GHOSTTY_REFERENCE_COMMIT       optional; if set, must equal the manifest ghosttyCommit
 *   GHOSTTY_REFERENCE_WASM_SHA256  optional; if set, must equal the manifest wasmSha256
 * The manifest pin must also equal ORACLE_COMMIT (cases.ts), the commit the oracle
 * citations were verified at; moving the pin requires re-verifying them.
 * Args:
 *   --fixtures <path>   shared VT corpus (default tests/regression/fixtures/vt.json)
 *   --filter <text>     only run tests whose name contains <text> (zero matches fails)
 *
 * Exit codes: 0 all passed; 1 one or more tests failed; 2 setup/configuration error.
 * There is no expected-failure mechanism here: the reference must satisfy every oracle.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, type CaseContext, ORACLE_COMMIT, type Provenance } from './cases';
import {
  type VtFixture,
  compareFixture,
  loadCorpus,
  mutations,
  normalizeTrailing,
  observe,
  singleCellViolations,
} from './corpus';
import { ReferenceModule, type ReferenceTerminal } from './loader';
import { type ReferencePin, loadReferencePin } from './pin';

interface NamedTest {
  name: string;
  provenance: Provenance;
  run(): void;
}

class SetupError extends Error {}

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): { fixtures: string; filter?: string } {
  let fixtures = resolve(here, '../fixtures/vt.json');
  let filter: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === '--fixtures' && value) {
      fixtures = resolve(value);
      i++;
    } else if (argv[i] === '--filter' && value) {
      filter = value;
      i++;
    } else {
      throw new SetupError(`unknown or incomplete argument: ${argv[i]}`);
    }
  }
  return { fixtures, filter };
}

function loadModule(): ReferenceModule {
  // The reviewed manifest is the only identity; env values may confirm but never override.
  let pin: ReferencePin;
  try {
    pin = loadReferencePin();
  } catch (error) {
    throw new SetupError((error as Error).message);
  }
  if (pin.commit !== ORACLE_COMMIT) {
    throw new SetupError(
      `ghostty-build.json pins ${pin.commit}, but the reference oracles were verified at ` +
        `${ORACLE_COMMIT} (cases.ts ORACLE_COMMIT); re-verify the citations before moving the pin`
    );
  }
  const commit = process.env.GHOSTTY_REFERENCE_COMMIT;
  if (commit && commit !== pin.commit) {
    throw new SetupError(
      `GHOSTTY_REFERENCE_COMMIT=${commit} does not match this runner's pin ${pin.commit}`
    );
  }
  const envSha = process.env.GHOSTTY_REFERENCE_WASM_SHA256;
  if (envSha && envSha.toLowerCase() !== pin.wasmSha256) {
    throw new SetupError(
      `GHOSTTY_REFERENCE_WASM_SHA256=${envSha} does not match this runner's verified ` +
        `${pin.wasmSha256} for ${pin.commit}`
    );
  }
  const path = process.env.GHOSTTY_REFERENCE_WASM;
  if (!path) {
    throw new SetupError(
      'GHOSTTY_REFERENCE_WASM is not set. Build the reference with\n' +
        '  scripts/build-reference-wasm.sh <work-dir> && source <work-dir>/out/reference.env\n' +
        'then export GHOSTTY_REFERENCE_WASM (see tests/regression/reference/README.md).'
    );
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new SetupError(`GHOSTTY_REFERENCE_WASM=${path} does not exist or is not a file`);
  }
  let mod: ReferenceModule;
  try {
    mod = ReferenceModule.fromFile(path);
  } catch (error) {
    throw new SetupError(`cannot compile ${path} as WebAssembly: ${(error as Error).message}`);
  }
  const imports = mod.importNames();
  if (imports.length > 0) {
    throw new SetupError(
      `${path} is not a usable libghostty-vt reference: WASM must be import-free ` +
        `(freestanding); found: ${imports.join(', ')}`
    );
  }
  if (mod.sha256 !== pin.wasmSha256) {
    throw new SetupError(
      `${path} is not the verified reference for ${pin.commit}: sha256 ${mod.sha256}, ` +
        `expected ${pin.wasmSha256} (build it with scripts/build-reference-wasm.sh)`
    );
  }
  try {
    mod.instantiate().dispose();
  } catch (error) {
    throw new SetupError(
      `${path} is not a usable libghostty-vt reference: ${(error as Error).message}`
    );
  }
  return mod;
}

function corpusTests(mod: ReferenceModule, fixtures: VtFixture[]): NamedTest[] {
  /** Fresh instance per fixture so no fixture can observe another's leftovers. */
  const run = (fx: VtFixture, write: (t: ReferenceTerminal) => void) => {
    const vt = mod.instantiate();
    try {
      const t = vt.createTerminal(fx.cols, fx.rows);
      write(t);
      const obs = observe(t, fx.rows);
      assert.equal(t.vtProcessingError(), false, 'VT processing error flag set');
      return obs;
    } finally {
      vt.dispose();
    }
  };
  const tests: NamedTest[] = [];
  for (const fx of fixtures) {
    tests.push({
      name: `vt/${fx.id}`,
      provenance: fx.provenance,
      run() {
        const obs = run(fx, (t) => t.write(fx.input));
        const problems = [...compareFixture(obs, fx), ...singleCellViolations(obs)];
        assert.deepEqual(problems, [], `${fx.description}\n  ${problems.join('\n  ')}`);
      },
    });
    tests.push({
      name: `vt/${fx.id}#bytewise`,
      provenance: {
        kind: 'invariant',
        reference: 'byte-at-a-time writes equal one whole write (L3)',
      },
      run() {
        const whole = run(fx, (t) => t.write(fx.input));
        const bytes = new TextEncoder().encode(fx.input);
        const split = run(fx, (t) => {
          for (const b of bytes) t.write(Uint8Array.of(b));
        });
        assert.deepEqual(split, whole);
      },
    });
  }

  tests.push({
    name: 'control/blank-engine-fails-every-fixture',
    provenance: {
      kind: 'invariant',
      reference: 'negative control: without its input, every fixture must fail',
    },
    run() {
      const insensitive = fixtures.filter(
        (fx) =>
          compareFixture(
            run(fx, () => {}),
            fx
          ).length === 0
      );
      assert.deepEqual(
        insensitive.map((fx) => fx.id),
        [],
        'fixtures that pass with no input do not test their stimulus'
      );
    },
  });
  tests.push({
    name: 'control/mutated-expectations-fail',
    provenance: {
      kind: 'invariant',
      reference: 'negative control: comparator detects row and cursor changes',
    },
    run() {
      const undetected: string[] = [];
      for (const fx of fixtures) {
        const obs = run(fx, (t) => t.write(fx.input));
        for (const m of mutations(fx)) {
          if (compareFixture(obs, m.fixture).length === 0) undetected.push(`${fx.id}:${m.name}`);
        }
      }
      assert.deepEqual(undetected, []);
    },
  });
  tests.push({
    name: 'control/normalizer-trims-only-trailing-blanks',
    provenance: {
      kind: 'invariant',
      reference: 'corpus contract: normalise only trailing empty/space cells',
    },
    run() {
      assert.equal(normalizeTrailing('ab   '), 'ab');
      assert.equal(normalizeTrailing('  ab'), '  ab');
      assert.equal(normalizeTrailing('a  b '), 'a  b');
      assert.equal(normalizeTrailing('a\t'), 'a\t', 'only spaces are padding');
      const leading = run({ ...fixtures[0], cols: 5, rows: 1, input: '\x1b[3GX' }, (t) =>
        t.write('\x1b[3GX')
      );
      assert.deepEqual(leading.lines, ['  X'], 'leading empty cells are significant');
      const wide = run({ ...fixtures[0], cols: 4, rows: 1, input: '' }, (t) => t.write('\u4e00'));
      assert.notDeepEqual(
        singleCellViolations(wide),
        [],
        'wide cells violate the single-cell contract'
      );
    },
  });
  tests.push({
    name: 'control/runner-exits-1-on-failed-assertion',
    provenance: {
      kind: 'invariant',
      reference: 'negative control: a wrong expectation makes this runner exit 1 and name the test',
    },
    run() {
      const fx = fixtures[0];
      const bad = {
        ...fx,
        expectedLines: [`${fx.expectedLines[0]}Z`, ...fx.expectedLines.slice(1)],
      };
      const dir = mkdtempSync(join(tmpdir(), 'ghostty-reference-control-'));
      try {
        const corpus = join(dir, 'vt.json');
        writeFileSync(corpus, JSON.stringify([bad]));
        const child = spawnSync(
          process.execPath,
          [fileURLToPath(import.meta.url), '--fixtures', corpus, '--filter', `vt/${fx.id}`],
          { encoding: 'utf8', env: process.env, timeout: 60_000 }
        );
        assert.equal(child.status, 1, child.stdout + child.stderr);
        assert.match(child.stdout, new RegExp(`^FAIL vt/${fx.id.replace(/\./g, '\\.')}$`, 'm'));
        assert.match(child.stdout, /reference: 1 passed, 1 failed, 2 total/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  });
  return tests;
}

function caseTests(mod: ReferenceModule): NamedTest[] {
  const ctx: CaseContext = {
    fresh(fn) {
      const vt = mod.instantiate();
      try {
        return fn(vt);
      } finally {
        vt.dispose();
      }
    },
    term(cols, rows, fn) {
      return ctx.fresh((vt) => fn(vt.createTerminal(cols, rows)));
    },
  };
  return CASES.map((c) => ({ name: c.name, provenance: c.provenance, run: () => c.run(ctx) }));
}

function main(): number {
  let tests: NamedTest[];
  let mod: ReferenceModule;
  try {
    const args = parseArgs(process.argv.slice(2));
    const fixtures = loadCorpus(args.fixtures);
    mod = loadModule();
    tests = [...caseTests(mod), ...corpusTests(mod, fixtures)];
    if (args.filter) tests = tests.filter((t) => t.name.includes(args.filter!));
    if (tests.length === 0) throw new SetupError(`no tests match --filter ${args.filter}`);
    console.log(`reference wasm: ${process.env.GHOSTTY_REFERENCE_WASM}`);
    console.log(
      `  sha256 ${mod.sha256} (${mod.byteLength} bytes) = verified build of upstream ${ORACLE_COMMIT}`
    );
    console.log(`  corpus ${args.fixtures} (${fixtures.length} fixtures)\n`);
  } catch (error) {
    console.error(`reference setup error: ${(error as Error).message}`);
    return 2;
  }

  const failures: string[] = [];
  for (const test of tests) {
    try {
      test.run();
      console.log(`ok   ${test.name}`);
    } catch (error) {
      failures.push(test.name);
      console.log(`FAIL ${test.name}`);
      console.log(`     provenance (${test.provenance.kind}): ${test.provenance.reference}`);
      const message = error instanceof Error ? error.message : String(error);
      console.log(message.replace(/^/gm, '     '));
    }
  }
  console.log(
    `\nreference: ${tests.length - failures.length} passed, ${failures.length} failed, ${tests.length} total`
  );
  if (failures.length > 0) console.log(`failed: ${failures.join(', ')}`);
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = main();
