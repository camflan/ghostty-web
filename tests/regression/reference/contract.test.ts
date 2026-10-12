/**
 * Fast contract checks for the reference lane's entry points. These need no reference WASM,
 * network or Zig: they prove that misconfiguration fails loudly (runner exit 2, builder exit 1)
 * and that the builder never touches directories it does not own. The reference tests
 * themselves run only via `bun tests/regression/reference/run.ts`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ORACLE_COMMIT } from './cases';
import { MANIFEST_URL, loadReferencePin, parseReferencePin } from './pin';

const repo = resolve(import.meta.dir, '../../..');
const runner = join(repo, 'tests/regression/reference/run.ts');
const builder = join(repo, 'scripts/build-reference-wasm.sh');
const wasmBuilder = join(repo, 'scripts/build-wasm.sh');
const scratch = mkdtempSync(join(tmpdir(), 'ghostty reference contract '));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(cmd: string, args: string[], env: Record<string, string | undefined>) {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env }))
    if (v !== undefined) merged[k] = v;
  const r = spawnSync(cmd, args, { cwd: repo, env: merged, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, output: `${r.stdout}${r.stderr}` };
}

describe('reference runner setup errors exit 2', () => {
  const runWith = (wasm: string | undefined, env: Record<string, string> = {}) =>
    run(process.execPath, [runner], {
      GHOSTTY_REFERENCE_WASM: wasm,
      GHOSTTY_REFERENCE_WASM_SHA256: undefined,
      GHOSTTY_REFERENCE_COMMIT: undefined,
      ...env,
    });
  // (module) — valid and import-free, but not the verified reference artifact.
  const emptyModule = () => {
    const path = join(scratch, 'empty.wasm');
    writeFileSync(path, Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    return path;
  };

  test('missing GHOSTTY_REFERENCE_WASM', () => {
    const r = runWith(undefined);
    expect(r.code).toBe(2);
    expect(r.output).toContain('GHOSTTY_REFERENCE_WASM is not set');
  });

  test('nonexistent path', () => {
    const r = runWith(join(scratch, 'missing.wasm'));
    expect(r.code).toBe(2);
    expect(r.output).toContain('does not exist');
  });

  test('not WebAssembly', () => {
    const path = join(scratch, 'text.wasm');
    writeFileSync(path, 'not wasm');
    const r = runWith(path);
    expect(r.code).toBe(2);
    expect(r.output).toContain('cannot compile');
  });

  test('WASM with imports (e.g. the shipping pinned build) is rejected', () => {
    // (module (import "env" "log" (func)))
    const path = join(scratch, 'imports.wasm');
    writeFileSync(
      path,
      Uint8Array.from([
        0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 2, 11, 1, 3, 0x65, 0x6e, 0x76, 3,
        0x6c, 0x6f, 0x67, 0, 0,
      ])
    );
    const r = runWith(path);
    expect(r.code).toBe(2);
    expect(r.output).toContain('import-free');
  });

  test('import-free WASM that is not the verified build is rejected by hash', () => {
    const r = runWith(emptyModule());
    expect(r.code).toBe(2);
    expect(r.output).toContain('is not the verified reference for');
    expect(r.output).not.toContain('= verified build of upstream');
  });

  test('GHOSTTY_REFERENCE_COMMIT disagreeing with the pin', () => {
    const r = runWith(emptyModule(), { GHOSTTY_REFERENCE_COMMIT: '0'.repeat(40) });
    expect(r.code).toBe(2);
    expect(r.output).toContain("does not match this runner's pin");
  });

  test('GHOSTTY_REFERENCE_WASM_SHA256 disagreeing with the verified hash', () => {
    const r = runWith(emptyModule(), { GHOSTTY_REFERENCE_WASM_SHA256: 'f'.repeat(64) });
    expect(r.code).toBe(2);
    expect(r.output).toContain("does not match this runner's verified");
  });
});

describe('build-reference-wasm.sh refuses unsafe work dirs (exit 1, nothing touched)', () => {
  const build = (dir: string) =>
    run('bash', [builder, dir], { ZIG_REFERENCE_BIN: join(scratch, 'no-such-zig') });

  test('non-empty directory without ownership marker', () => {
    const dir = join(scratch, 'unowned dir');
    mkdirSync(join(dir, 'out'), { recursive: true });
    writeFileSync(join(dir, 'out', 'keep'), 'precious');
    const r = build(dir);
    expect(r.code).toBe(1);
    expect(r.output).toContain('no .ghostty-reference-workdir marker');
    expect(readdirSync(dir)).toEqual(['out']);
    expect(readdirSync(join(dir, 'out'))).toEqual(['keep']);
  });

  test('symlinked output component inside an owned directory', () => {
    const dir = join(scratch, 'owned with link');
    const victim = join(scratch, 'victim');
    mkdirSync(dir, { recursive: true });
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'keep'), 'precious');
    writeFileSync(
      join(dir, '.ghostty-reference-workdir'),
      'ghostty-web scripts/build-reference-wasm.sh work dir\n'
    );
    symlinkSync(victim, join(dir, 'out'));
    const r = build(dir);
    expect(r.code).toBe(1);
    expect(r.output).toContain('is a symlink');
    expect(readdirSync(victim)).toEqual(['keep']);
  });

  test('symlinked work dir', () => {
    const real = join(scratch, 'real');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(scratch, 'link'));
    const r = build(join(scratch, 'link'));
    expect(r.code).toBe(1);
    expect(readdirSync(real)).toEqual([]);
  });

  test('work dir inside the checkout', () => {
    const dir = join(repo, 'tmp-reference-contract');
    const r = build(dir);
    expect(r.code).toBe(1);
    expect(r.output).toContain('inside the ghostty-web checkout');
    expect(existsSync(dir)).toBe(false);
  });

  test('fresh path with spaces is claimed, locked and released before toolchain failure', () => {
    const dir = join(scratch, 'fresh dir with spaces');
    const r = build(dir);
    expect(r.code).toBe(1);
    // ZIG_REFERENCE_BIN is forwarded to the manifest's zigEnv for libghostty-vt.
    expect(r.output).toContain("ZIG_0_16_BIN='");
    expect(readdirSync(dir)).toEqual(['.ghostty-reference-workdir']);
    mkdirSync(join(dir, '.lock'));
    const locked = build(dir);
    expect(locked.code).toBe(1);
    expect(locked.output).toContain('another build holds');
  });
});

describe('ghostty-build.json is the single, consistent pin source', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_URL, 'utf8'));
  const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

  test('reference pin is verified and matches the oracle citations', () => {
    const pin = loadReferencePin();
    expect(pin.commit).toBe(ORACLE_COMMIT);
    expect(pin.wasmSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('an unverified (null) or patched reference pin is refused', () => {
    const target = manifest.targets['libghostty-vt'];
    const withTarget = (patch: Record<string, unknown>) => ({
      ...manifest,
      targets: { ...manifest.targets, 'libghostty-vt': { ...target, ...patch } },
    });
    expect(() => parseReferencePin(withTarget({ wasmSha256: null }))).toThrow('unverified pin');
    expect(() => parseReferencePin(withTarget({ patch: 'patches/x.patch' }))).toThrow('unpatched');
    expect(() => parseReferencePin(withTarget({ ghosttyCommit: 'main' }))).toThrow('full SHA');
  });

  test('legacy patch bytes match their recorded sha256; shipping target is unpatched', () => {
    const legacy = manifest.targets.legacy;
    expect(sha256(join(repo, legacy.patch))).toBe(legacy.patchSha256);
    expect(manifest.targets['libghostty-vt'].patch).toBeNull();
    expect(legacy.artifact).not.toBe(manifest.targets['libghostty-vt'].artifact);
  });
});

describe('build-wasm.sh argument and destination guards (exit 1)', () => {
  const build = (args: string[]) =>
    run('bash', [wasmBuilder, ...args], {
      ZIG_0_16_BIN: join(scratch, 'no-such-zig'),
      ZIG_0_15_BIN: join(scratch, 'no-such-zig'),
    });

  test('unknown target', () => {
    const r = build(['latest', '--work-dir', join(scratch, 'w-unknown')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain("unknown argument 'latest'");
  });

  test('bundle outside the work dir', () => {
    const r = build([
      '--work-dir',
      join(scratch, 'w-bundle'),
      '--bundle',
      join(scratch, 'elsewhere'),
    ]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('must be a direct child of the work dir');
  });

  test('publishing inside the checkout (other than root/.regression-reference)', () => {
    const r = build(['--work-dir', join(scratch, 'w-out'), '--out-dir', join(repo, 'lib')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('is inside the checkout');
  });

  test('legacy needs its own exact compiler', () => {
    const r = build(['legacy', '--work-dir', join(scratch, 'w-legacy'), '--out-dir', scratch]);
    expect(r.code).toBe(1);
    expect(r.output).toContain("ZIG_0_15_BIN='");
    expect(existsSync(join(scratch, 'ghostty-vt-legacy.wasm'))).toBe(false);
  });
});

describe('build-wasm.sh refuses unverified (null-hash) pins by default', () => {
  // A throwaway copy of the builder next to a manifest whose libghostty-vt hash is null;
  // the script resolves its manifest from its own location, so the real one is untouched.
  const fake = join(scratch, 'fake repo');
  mkdirSync(join(fake, 'scripts'), { recursive: true });
  writeFileSync(join(fake, 'scripts', 'build-wasm.sh'), readFileSync(wasmBuilder));
  const manifest = JSON.parse(readFileSync(MANIFEST_URL, 'utf8'));
  manifest.targets['libghostty-vt'].wasmSha256 = null;
  writeFileSync(join(fake, 'ghostty-build.json'), JSON.stringify(manifest));
  const outside = join(scratch, 'unverified-out');
  mkdirSync(outside, { recursive: true });
  const build = (script: string, args: string[]) =>
    run('bash', [script, ...args], { ZIG_0_16_BIN: join(scratch, 'no-such-zig') });

  test('default build of a null pin fails before any compiler or publication', () => {
    const r = build(join(fake, 'scripts', 'build-wasm.sh'), []);
    expect(r.code).toBe(1);
    expect(r.output).toContain('refusing to build an unverified pin');
    expect(r.output).not.toContain('ZIG_0_16_BIN');
    expect(existsSync(join(fake, 'ghostty-vt.wasm'))).toBe(false);
  });

  test('--allow-unverified never targets the repo root or several targets', () => {
    const script = join(fake, 'scripts', 'build-wasm.sh');
    const root = build(script, ['--allow-unverified', '--work-dir', join(scratch, 'wu1')]);
    expect(root.code).toBe(1);
    expect(root.output).toContain('needs --bundle or an explicit --out-dir');
    const rootExplicit = build(script, ['--allow-unverified', '--out-dir', fake]);
    expect(rootExplicit.code).toBe(1);
    expect(rootExplicit.output).toContain('never publishes into the repo root');
    const all = build(script, ['all', '--allow-unverified', '--out-dir', outside]);
    expect(all.code).toBe(1);
    expect(all.output).toContain('needs a single target');
  });

  test('--allow-unverified with an outside --out-dir passes the gate (then needs Zig)', () => {
    const r = build(join(fake, 'scripts', 'build-wasm.sh'), [
      '--allow-unverified',
      '--work-dir',
      join(scratch, 'wu2'),
      '--out-dir',
      outside,
    ]);
    expect(r.code).toBe(1);
    expect(r.output).not.toContain('unverified pin');
    expect(r.output).toContain("ZIG_0_16_BIN='");
    expect(readdirSync(outside)).toEqual([]);
  });

  test('--allow-unverified is rejected for a verified pin', () => {
    const r = build(wasmBuilder, [
      '--allow-unverified',
      '--work-dir',
      join(scratch, 'wu3'),
      '--out-dir',
      outside,
    ]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('only for pins whose wasmSha256 is null');
  });
});
