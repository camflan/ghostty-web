/**
 * Engine identity: the engine label must describe the loaded binary, the
 * production bridge must report the same backend, and wrong or partial ABIs
 * are rejected before any case runs.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_WEB_ENGINE,
  ENGINE_FOR_BACKEND,
  LEGACY_ABI_EXPORTS,
  LIBGHOSTTY_VT_EXPORTS,
  assertBridgeBackend,
  detectAbi,
  engineIdentity,
  resolveWebEngine,
} from './harness/identity';
import { moduleWithExports } from './harness/wasm-builder';
import { freshGhostty, guarded, rawSession } from './harness/web';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const exportsOf = (bytes: BufferSource) =>
  WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map((e) => e.name);

describe('ABI detection from WASM exports', () => {
  test('legacy patch ABI', () => {
    expect(detectAbi(exportsOf(moduleWithExports(LEGACY_ABI_EXPORTS)))).toBe('legacy');
  });

  test('libghostty-vt ABI', () => {
    expect(detectAbi(exportsOf(moduleWithExports(LIBGHOSTTY_VT_EXPORTS)))).toBe('libghostty-vt');
  });

  test('a binary missing one legacy export is rejected, naming it', () => {
    const partial = LEGACY_ABI_EXPORTS.filter((name) => name !== 'ghostty_terminal_write');
    expect(() => detectAbi(exportsOf(moduleWithExports(partial)))).toThrow(
      'missing legacy exports [ghostty_terminal_write]'
    );
  });

  test('an unrelated module is rejected', () => {
    expect(() => detectAbi(exportsOf(moduleWithExports(['main'])))).toThrow(
      'Unrecognised Ghostty WASM ABI'
    );
  });

  test('a module claiming both ABIs is ambiguous', () => {
    const both = [...LEGACY_ABI_EXPORTS, ...LIBGHOSTTY_VT_EXPORTS];
    expect(() => detectAbi(exportsOf(moduleWithExports(both)))).toThrow('Ambiguous');
  });
});

describe('engine selection', () => {
  test('unset: the default engine applies only if it matches the binary', () => {
    // Whichever engine is the default (flipped at the cutover), the other ABI needs it set explicitly.
    const other = DEFAULT_WEB_ENGINE === 'web-pinned' ? 'libghostty-vt' : 'legacy';
    const own = other === 'legacy' ? 'libghostty-vt' : 'legacy';
    expect(resolveWebEngine(undefined, own)).toBe(DEFAULT_WEB_ENGINE);
    expect(() => resolveWebEngine('', other)).toThrow(
      `set GHOSTTY_REGRESSION_ENGINE=${ENGINE_FOR_BACKEND[other]}`
    );
  });

  test('an explicit engine must match the binary', () => {
    expect(resolveWebEngine('web-pinned', 'legacy')).toBe('web-pinned');
    expect(resolveWebEngine('web-candidate', 'libghostty-vt')).toBe('web-candidate');
    expect(() => resolveWebEngine('web-candidate', 'legacy')).toThrow('does not match');
    expect(() => resolveWebEngine('web-pinned', 'libghostty-vt')).toThrow('does not match');
  });

  test('reference and unknown engines are rejected by the web harness', () => {
    expect(() => resolveWebEngine('reference', 'legacy')).toThrow('not applicable');
    expect(() => resolveWebEngine('web-native', 'legacy')).toThrow('Unknown regression engine');
  });
});

describe('bridge backend reporting', () => {
  test('a reported backend must equal the binary ABI', () => {
    expect(() => assertBridgeBackend('Ghostty', 'legacy', 'legacy')).not.toThrow();
    expect(() => assertBridgeBackend('Ghostty', 'libghostty-vt', 'libghostty-vt')).not.toThrow();
    expect(() => assertBridgeBackend('Ghostty', 'legacy', 'libghostty-vt')).toThrow(
      'Ghostty.backend is "legacy"'
    );
    expect(() => assertBridgeBackend('GhosttyTerminal', 'libghostty-vt', 'legacy')).toThrow(
      'GhosttyTerminal.backend'
    );
  });

  test('no silent fallback: an unidentified bridge may only drive a legacy binary', () => {
    expect(() => assertBridgeBackend('Ghostty', undefined, 'legacy')).not.toThrow();
    expect(() => assertBridgeBackend('Ghostty', undefined, 'libghostty-vt')).toThrow(
      'unidentified bridge'
    );
  });
});

describe('the engine under test', () => {
  const identity = engineIdentity();

  test('engine, backend and binary agree', () => {
    expect(identity.engine).toBe(ENGINE_FOR_BACKEND[identity.backend]);
    expect(detectAbi(WebAssembly.Module.exports(identity.module).map((e) => e.name))).toBe(
      identity.backend
    );
    expect(identity.wasmSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('Ghostty and GhosttyTerminal report the loaded backend (when the bridge reports one)', () => {
    const ghostty = freshGhostty() as unknown as { backend?: unknown };
    const session = rawSession(4, 2, freshGhostty());
    guarded(
      () => {
        const terminal = session.term as unknown as { backend?: unknown };
        expect([ghostty.backend, terminal.backend]).toEqual(
          ghostty.backend === undefined
            ? [undefined, undefined]
            : [identity.backend, identity.backend]
        );
      },
      () => session.free()
    );
  });

  function runCore(env: Record<string, string>): { code: number; output: string } {
    const result = Bun.spawnSync(
      ['bun', 'test', 'tests/regression/core/vt-corpus.test.ts', '-t', 'vt\\.print\\.basic$'],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, GHOSTTY_REGRESSION_REPORT: '', ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    return {
      code: result.exitCode ?? -1,
      output: `${result.stdout.toString()}${result.stderr.toString()}`,
    };
  }

  test('a mislabelled engine fails the run instead of selecting other known failures', () => {
    const other = identity.engine === 'web-pinned' ? 'web-candidate' : 'web-pinned';
    const run = runCore({ GHOSTTY_REGRESSION_ENGINE: other });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain(`GHOSTTY_REGRESSION_ENGINE=${other} does not match`);
  }, 30_000);

  test('a binary with a partial ABI fails the run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghostty-identity-'));
    try {
      const path = join(dir, 'partial.wasm');
      writeFileSync(path, moduleWithExports(LEGACY_ABI_EXPORTS.slice(1)));
      const run = runCore({ GHOSTTY_REGRESSION_WASM: path, GHOSTTY_REGRESSION_ENGINE: '' });
      expect(run.code).not.toBe(0);
      expect(run.output).toContain('missing legacy exports [ghostty_terminal_new_with_config]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
