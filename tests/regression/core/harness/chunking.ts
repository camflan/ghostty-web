/** Deterministic write fragmentation for invariance tests. */

/** mulberry32: tiny seeded PRNG so random splits are reproducible from the printed seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULT_SEED = 0x5eed2026;

export function regressionSeed(): number {
  const raw = process.env.GHOSTTY_REGRESSION_SEED;
  if (raw === undefined || raw === '') return DEFAULT_SEED;
  const seed = Number(raw);
  if (!Number.isInteger(seed) || seed < 0)
    throw new Error(`Invalid GHOSTTY_REGRESSION_SEED: ${raw}`);
  return seed;
}

export function splitAt(bytes: Uint8Array, offsets: readonly number[]): Uint8Array[] {
  const cuts = [...new Set(offsets)].filter((o) => o > 0 && o < bytes.length).sort((a, b) => a - b);
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const cut of cuts) {
    chunks.push(bytes.subarray(start, cut));
    start = cut;
  }
  chunks.push(bytes.subarray(start));
  return chunks;
}

export function bytewise(bytes: Uint8Array): Uint8Array[] {
  return [...bytes].map((_, i) => bytes.subarray(i, i + 1));
}

/** Offsets that fall strictly inside a multi-byte UTF-8 sequence. */
export function utf8InteriorOffsets(bytes: Uint8Array): number[] {
  const offsets: number[] = [];
  for (let i = 1; i < bytes.length; i++) {
    if ((bytes[i] & 0xc0) === 0x80) offsets.push(i);
  }
  return offsets;
}

export function randomSplits(bytes: Uint8Array, random: () => number, maxCuts = 8): Uint8Array[] {
  const count = Math.min(maxCuts, Math.max(0, bytes.length - 1));
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(1 + Math.floor(random() * (bytes.length - 1)));
  return splitAt(bytes, offsets);
}
