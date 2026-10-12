/**
 * Reference identity, read from the single build manifest (ghostty-build.json)
 * rather than duplicated here. The reference engine is the manifest's unpatched
 * `libghostty-vt` target; its `wasmSha256` must be recorded (non-null) before the
 * lane will attribute any result to the pin.
 */
import { readFileSync } from 'node:fs';

export const MANIFEST_URL = new URL('../../../ghostty-build.json', import.meta.url);
export const REFERENCE_TARGET = 'libghostty-vt';

export interface ReferencePin {
  commit: string;
  /** Verified sha256 of scripts/build-reference-wasm.sh output for `commit`. */
  wasmSha256: string;
  zigVersion: string;
}

/** Validate a parsed manifest; throws with a precise reason (setup error, never a skip). */
export function parseReferencePin(manifest: unknown): ReferencePin {
  const m = manifest as { schema?: unknown; targets?: Record<string, Record<string, unknown>> };
  const t = m?.targets?.[REFERENCE_TARGET];
  if (m?.schema !== 1 || !t) {
    throw new Error(`ghostty-build.json: schema 1 target "${REFERENCE_TARGET}" missing`);
  }
  if (typeof t.ghosttyCommit !== 'string' || !/^[0-9a-f]{40}$/.test(t.ghosttyCommit)) {
    throw new Error('ghostty-build.json: libghostty-vt ghosttyCommit is not a full SHA');
  }
  if (t.patch !== null) {
    throw new Error('ghostty-build.json: the reference target must be unpatched upstream');
  }
  if (t.wasmSha256 === null) {
    throw new Error(
      `ghostty-build.json: wasmSha256 for ${t.ghosttyCommit} is null (unverified pin); build it, review, and record the hash`
    );
  }
  if (typeof t.wasmSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(t.wasmSha256)) {
    throw new Error('ghostty-build.json: libghostty-vt wasmSha256 is not a sha256');
  }
  if (typeof t.zigVersion !== 'string') {
    throw new Error('ghostty-build.json: libghostty-vt zigVersion missing');
  }
  return { commit: t.ghosttyCommit, wasmSha256: t.wasmSha256, zigVersion: t.zigVersion };
}

export function loadReferencePin(): ReferencePin {
  return parseReferencePin(JSON.parse(readFileSync(MANIFEST_URL, 'utf8')));
}
