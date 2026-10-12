# Upstream-reference regression lane

This lane runs the shared VT corpus and dedicated semantic probes against the **upstream
libghostty-vt WASM** pinned in [`ghostty-build.json`](../../../ghostty-build.json)
(`targets["libghostty-vt"]`, currently Ghostty `main`
[`246f702876b924a1cb7cade1e99274d1470302fc`](https://github.com/ghostty-org/ghostty/commit/246f702876b924a1cb7cade1e99274d1470302fc),
Zig 0.16.0). It is the same unpatched target the shipping engine builds; this lane drives it
through its own test-only loader, never through `lib/`'s production adapter.

It checks two things:

- **Oracles:** spec, upstream-test and invariant expectations hold on the engine ghostty-web
  embeds.
- **Fixtures:** each fixture tests its stimulus. The negative controls below prove this.

Passing on the same-SHA reference is not the only oracle. Every expectation cites a protocol
spec or an upstream test, and none is taken from ghostty-web output. The lane has **no
expected-failure mechanism**: a reference failure needs triage, and you must not allow-list it.

## Commands

```bash
# 1. Build the reference (about 30 s cold; needs git, bun or node, network access to the
#    pinned SHA, Zig 0.16.0). The expected hash comes from ghostty-build.json.
ZIG_REFERENCE_BIN=/path/to/zig-0.16.0/zig \
  scripts/build-reference-wasm.sh "$WORK_DIR"      # outside the checkout, or ./.regression-reference/<name>

# 2. Run the lane (bash: reference.env is printf %q quoted)
set -a; source "$WORK_DIR/out/reference.env"; set +a
bun run test:regression:reference                 # = bun tests/regression/reference/run.ts

# Options: --fixtures <vt.json>  --filter <substring>

# Fast contract tests (no WASM, no network): runner setup, manifest consistency, builder safety
bun test tests/regression/reference/contract.test.ts
```

## Builds and the version manifest

`ghostty-build.json` is the single source for every Ghostty WASM build: per target it records
`ghosttyCommit`, `zigVersion` (+ the `zigEnv` variable naming the compiler), `buildArgs`,
optional `patch`/`patchSha256`, the published `artifact` name, the reviewed `wasmSha256` and the
`maxWasmBytes` budget. Targets: `libghostty-vt` (shipping + reference; `ghostty-vt.wasm`) and
`legacy` (5714ed07 + `patches/legacy/ghostty-wasm-api.patch`, Zig 0.15.2;
`ghostty-vt-legacy.wasm`). A `null` `wasmSha256` marks an unverified pin: normal builds and the
reference runner refuse it. Pin discovery uses `build-wasm.sh <target> --allow-unverified` with
`--bundle` or an `--out-dir` other than the repo root (single target; the result is marked
`"verified": false` / `<PREFIX>_WASM_VERIFIED=0` and is **not for release**); record the hash,
then build normally.

| Script                                   | Use                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/build-wasm.sh [TARGET...]`      | `libghostty-vt` (default), `legacy` or `all`. Publishes each artifact atomically to `--out-dir` (default: repo root, as `bun run build:wasm` expects) only after the exact manifest hash and size budget pass. Options: `--work-dir` (default `$GHOSTTY_WASM_WORK_DIR` or `.regression-reference/wasm-build`), `--bundle`, `--expect-sha256`. Compilers: `$ZIG_0_16_BIN`, `$ZIG_0_15_BIN` or `zig`. |
| `scripts/build-legacy-wasm.sh`           | `build-wasm.sh legacy "$@"`. The patch is applied to the owned checkout only for the build and reverted afterwards (also on failure; an interrupted build is recovered only when the recorded patch matches). Never uses the `ghostty/` submodule.                                                                                                                                                  |
| `scripts/build-reference-wasm.sh <work>` | Reference contract on top of `build-wasm.sh`: publishes `<work>/out/{ghostty-vt.wasm,build-info.json,reference.env}` atomically. Honours `ZIG_REFERENCE_BIN`, `GHOSTTY_REFERENCE_GIT_URL` and `GHOSTTY_REFERENCE_EXPECTED_WASM_SHA256` (must agree with the manifest).                                                                                                                              |

Safety (all scripts): the work dir must be missing, empty or marked with
`.ghostty-reference-workdir`, outside the checkout except under `.regression-reference/`; it and
its components must not be symlinks; `mkdir .lock` gives one build per work dir. Sources live in
`<work>/sources/<commit>` (fetched by SHA, depth 1, no tags; there is no "latest" mode), are
verified at the pin and pristine before and after the build (never silently reset), and
`build.zig.zon` must declare the manifest's Zig version. Zig caches live in
`<work>/zig-cache/<zigVersion>`; logs in `<work>/logs/<target>.log`; metadata in
`<work>/meta/<target>.build-info.json` (commit, tree, escaped gitUrl, Zig, build args, patch and
sha, artifact, wasm sha256 and bytes, the manifest's expected hash, seconds). Git and Zig global
configuration and caches are not used.

Verified results:

| Target          | Commit     | Zig    | sha256                                                             | Bytes   |
| --------------- | ---------- | ------ | ------------------------------------------------------------------ | ------- |
| `libghostty-vt` | `246f7028` | 0.16.0 | `8b218c0c750fc74e63f3ebf4005fb6967c7b1fba2f2a84d19a08bd4ca5812f49` | 847,348 |
| `legacy`        | `5714ed07` | 0.15.2 | `0789394612a79e22abc37ecf952e360aecfa7ec737d416ef3d664d1b9277fdbd` | 424,058 |

The legacy result is byte-identical to the pre-migration root `ghostty-vt.wasm`.

## Runner contract (`run.ts`)

- **Artifact identity:** read from `ghostty-build.json` (`pin.ts`): the WASM must hash to the
  `libghostty-vt` `wasmSha256` (non-null), so the runner never attributes results from another
  build to the pin. There is no alternate-hash or diagnostic mode. `GHOSTTY_REFERENCE_COMMIT`
  and `GHOSTTY_REFERENCE_WASM_SHA256` are optional; when set (for example from
  `reference.env`), each must match the manifest.
- **Oracle status:** `cases.ts` declares `ORACLE_COMMIT`, the commit at which every citation
  (file, line, test name) was verified. The runner refuses to run when the manifest pin differs,
  so moving the pin means: change `ghosttyCommit`, set `wasmSha256` to `null`, build with
  `--allow-unverified` into scratch, re-verify the citations and any changed upstream semantics,
  then record the hash and `ORACLE_COMMIT`.
- **Exit codes:** `0` means all tests passed and `1` means at least one test failed. Each failure
  prints `FAIL <name>`, its provenance and the assertion diff. `2` means a setup error:
  - `GHOSTTY_REFERENCE_WASM` is unset or missing;
  - the file is not WASM;
  - the WASM has imports, for example the shipping pinned build (checked before the hash);
  - the WASM is import-free but its sha256 is not the verified hash (for example another
    upstream build or feature subset);
  - `GHOSTTY_REFERENCE_COMMIT` or `GHOSTTY_REFERENCE_WASM_SHA256` disagrees with the manifest;
  - the manifest pin is unverified (`null` hash), patched, or differs from `ORACLE_COMMIT`;
  - a required export or type layout is missing;
  - the corpus is invalid;
  - `--filter` matches nothing.
- **Corpus (`tests/regression/fixtures/vt.json`):** each fixture yields `vt/<id>` (rows,
  cursor, the single-cell contract and no VT processing error) and `vt/<id>#bytewise`
  (byte-at-a-time writes must equal a single whole write). Every fixture runs in a fresh WASM
  instance. Normalisation trims only trailing empty or space cells.
- **Dedicated cases (`cases.ts`):**
  - byte-exact replies: DSR, DA1/DA2, XTVERSION, Kitty keyboard query, DECRQM (DEC, ANSI,
    2026), OSC 4/10/11/12 and reply ordering;
  - effects: BEL, OSC 0/2 titles (also fragmented), OSC 7, OSC 52 and OSC 8;
  - modes and RIS or API reset, including `MODE_DEFAULT` surviving RIS;
  - DECSTR (`CSI ! p`, upstream f473f3109): its modes only, scrolling margins, saved cursor,
    charsets, exact-sequence dispatch, and that it keeps the cursor, screen and title;
  - formatter VT replay in origin mode (upstream 23c7a3e5a: CUP relative to the region);
  - wide, ZWJ and combining characters with modes 2027 on and off, plus graphemes kept in
    scrollback;
  - soft-wrap and continuation flags, also across scrollback and in the formatter's unwrap;
  - scrollback counts, viewport scrolling and limits across memory growth;
  - SW-01 resize;
  - shared-instance lifecycle: no trap after a terminal with graphemes is freed (RT-01), and
    **no stale text after free → new**.
- **Negative controls (`control/*`):**
  - every fixture fails on a blank engine;
  - mutated rows or cursors are detected;
  - the normaliser trims only trailing blanks;
  - the runner exits 1 and names the failing test.

  Run against scratch copies of the loader, the mutants were detected by: no-op `write` (93 of
  150 failed, including all 50 `vt/*`), dropped wrap flags (3), truncated graphemes (5),
  recycled terminal (the stale-content case) and dropped replies (12). Against the previous
  pin's artifact (`0f171f65`, `f92471a1…`), 6 of the 7 DECSTR/formatter cases fail (all except
  the "keeps cursor and screen" preservation check), so they exercise the new upstream code.

## Files

- `loader.ts`: test-only typed loader. It reads layouts and enums from `ghostty_type_json()`,
  validates exports and their arities, refuses imports, reads fresh memory views after every
  call, owns its terminals with explicit `dispose()`, and uses one trampoline per callback
  kind to dispatch effects. Each `instantiate()` gives fresh linear memory.
- `corpus.ts`: corpus schema validation, normalisation, comparison and mutation helpers.
- `cases.ts`: dedicated cases, each with a provenance permalink at `ORACLE_COMMIT`.
- `pin.ts`: reads and validates the reference pin from `ghostty-build.json`.
- `run.ts`: the standalone runner.
- `contract.test.ts`: 23 fast checks that run under `bun test` and need no WASM, Zig or
  network: runner setup errors (missing, non-WASM, has imports, import-free but wrong hash, wrong
  commit env, wrong hash env), manifest consistency (verified reference pin equals
  `ORACLE_COMMIT`; null/patched pins refused; legacy patch bytes match `patchSha256`), builder
  work-dir safety, `build-wasm.sh` argument/destination guards, and null-hash pins refused by
  default (`--allow-unverified` only for a single target outside the repo root).

## Known triage (not asserted)

At the pin, a `GHOSTTY_POINT_TAG_HISTORY` point past the scrollback resolves into the active
area, although `point.h` documents HISTORY as "scrollback history only". The adapter
therefore takes its bounds from `SCROLLBACK_ROWS` and `TOTAL_ROWS`, not from whether a
HISTORY point resolves.
