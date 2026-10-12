/**
 * Engine identity for the core web harness.
 *
 * The engine label selects known failures, so it must describe the binary that
 * is actually under test, never a convenient label:
 *   legacy ABI WASM          -> 'web-pinned'
 *   libghostty-vt ABI WASM   -> 'web-candidate'
 * The ABI is read from the WASM's own exports, independently of the bridge, and
 * the production bridge's readonly `backend` ('legacy' | 'libghostty-vt') on
 * `Ghostty` and `GhosttyTerminal` must agree with it. 'reference' is a separate
 * lane and is rejected here.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REGRESSION_ENGINE } from '../../support/regression';

export type BackendKind = 'legacy' | 'libghostty-vt';
export type WebEngine = 'web-pinned' | 'web-candidate';

/** Exports only the legacy ghostty-web patch ABI provides (pinned 5714ed07 + patch). */
export const LEGACY_ABI_EXPORTS = [
  'ghostty_terminal_new_with_config',
  'ghostty_terminal_write',
  'ghostty_terminal_read_response',
  'ghostty_render_state_get_viewport',
  'ghostty_wasm_alloc_u8_array',
] as const;

/** Exports that identify the upstream libghostty-vt C API. */
export const LIBGHOSTTY_VT_EXPORTS = [
  'ghostty_terminal_new',
  'ghostty_terminal_vt_write',
  'ghostty_render_state_new',
  'ghostty_type_json',
] as const;

export const ENGINE_FOR_BACKEND: Readonly<Record<BackendKind, WebEngine>> = {
  legacy: 'web-pinned',
  'libghostty-vt': 'web-candidate',
};

/** Classify a WASM by its exports; partial or ambiguous ABIs are errors. */
export function detectAbi(exportNames: Iterable<string>): BackendKind {
  const names = new Set(exportNames);
  const legacyMissing = LEGACY_ABI_EXPORTS.filter((name) => !names.has(name));
  const nativeMissing = LIBGHOSTTY_VT_EXPORTS.filter((name) => !names.has(name));
  if (legacyMissing.length === 0 && nativeMissing.length === 0) {
    throw new Error('Ambiguous Ghostty WASM: exports both the legacy and libghostty-vt ABIs');
  }
  if (legacyMissing.length === 0) return 'legacy';
  if (nativeMissing.length === 0) return 'libghostty-vt';
  throw new Error(
    `Unrecognised Ghostty WASM ABI: missing legacy exports [${legacyMissing.join(', ')}] ` +
      `and libghostty-vt exports [${nativeMissing.join(', ')}]`
  );
}

/**
 * Engine used when GHOSTTY_REGRESSION_ENGINE is unset: the shared
 * DEFAULT_REGRESSION_ENGINE (flipped to 'web-candidate' at the libghostty-vt
 * cutover). Like an explicit value, it must match the loaded binary.
 */
export const DEFAULT_WEB_ENGINE: WebEngine = webEngine(DEFAULT_REGRESSION_ENGINE);

function webEngine(engine: string): WebEngine {
  if (engine !== 'web-pinned' && engine !== 'web-candidate') {
    throw new Error(`The default regression engine ${engine} is not a web engine`);
  }
  return engine;
}

/** Engine for the loaded ABI: the requested (or default) engine must describe it. */
export function resolveWebEngine(requested: string | undefined, abi: BackendKind): WebEngine {
  const expected = ENGINE_FOR_BACKEND[abi];
  if (requested === undefined || requested === '') {
    if (DEFAULT_WEB_ENGINE !== expected) {
      throw new Error(
        `GHOSTTY_REGRESSION_ENGINE is unset and the default ${DEFAULT_WEB_ENGINE} does not match ` +
          `the loaded WASM (${abi} ABI requires ${expected}); set GHOSTTY_REGRESSION_ENGINE=${expected}`
      );
    }
    return expected;
  }
  if (requested === 'reference') {
    throw new Error(
      'GHOSTTY_REGRESSION_ENGINE=reference is not applicable to the core web harness; ' +
        'run the reference lane instead'
    );
  }
  if (requested !== 'web-pinned' && requested !== 'web-candidate') {
    throw new Error(`Unknown regression engine: ${requested}`);
  }
  if (requested !== expected) {
    throw new Error(
      `GHOSTTY_REGRESSION_ENGINE=${requested} does not match the loaded WASM ` +
        `(${abi} ABI requires ${expected}); engines must describe the binary under test`
    );
  }
  return requested;
}

/**
 * The production bridge's readonly `backend` must agree with the WASM ABI.
 * Only the pre-migration legacy bridge (which has no `backend`) may omit it,
 * and only for a legacy binary: a libghostty-vt binary is never run through an
 * unidentified bridge.
 */
export function assertBridgeBackend(label: string, reported: unknown, abi: BackendKind): void {
  if (reported === undefined) {
    if (abi === 'legacy') return;
    throw new Error(
      `${label} does not report \`backend\`; refusing to run a ${abi} binary through an unidentified bridge`
    );
  }
  if (reported !== abi) {
    throw new Error(
      `${label}.backend is ${JSON.stringify(reported)} but the loaded WASM exports the ${abi} ABI`
    );
  }
}

export interface EngineIdentity {
  engine: WebEngine;
  backend: BackendKind;
  wasmPath: string;
  wasmSha256: string;
  module: WebAssembly.Module;
}

/** The engine under test: the root WASM, or GHOSTTY_REGRESSION_WASM. */
export const DEFAULT_WASM_URL = new URL('../../../../ghostty-vt.wasm', import.meta.url);

export function wasmPathFromEnv(): string {
  return process.env.GHOSTTY_REGRESSION_WASM || fileURLToPath(DEFAULT_WASM_URL);
}

let cached: EngineIdentity | undefined;

export function engineIdentity(): EngineIdentity {
  if (cached) return cached;
  const wasmPath = wasmPathFromEnv();
  const bytes = readFileSync(wasmPath);
  const module = new WebAssembly.Module(bytes);
  const backend = detectAbi(WebAssembly.Module.exports(module).map((e) => e.name));
  const engine = resolveWebEngine(process.env.GHOSTTY_REGRESSION_ENGINE, backend);
  cached = {
    engine,
    backend,
    wasmPath,
    wasmSha256: createHash('sha256').update(bytes).digest('hex'),
    module,
  };
  return cached;
}
