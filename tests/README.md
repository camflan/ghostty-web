# Regression suite

This suite gates the migration to the manifest-pinned upstream `libghostty-vt`
backend while retaining an explicitly selected legacy rollback engine. It never
silently substitutes one engine for another.

## Current migration status

The default engine uses Ghostty `246f7028` and Zig 0.16.0. The user approved
native page-granular scrollback retention; exact xterm-style line caps are deferred.
The former exact-count test is now explicitly legacy-only, and native retention
is checked against an independent upstream instance across multiple budgets and
write checkpoints, without hard-coding a particular retained-row count.

## Strict required baseline

The required suite has **no accepted failures, expected-failure matching or skipped
bug reproducers**. Existing bugs and future-parity requirements are in a separate,
explicitly selected [gap suite](gaps/README.md). A gap failure is a real failure,
not a passing test.

Validated on 2026-10-12, including the native keyboard, mouse, paste/focus routing
slices and OSC 8 activation safety after migration checkpoint `ffe8b66`:

| Lane                                             | Native (`web-candidate`) | Legacy (`web-pinned`) |
| ------------------------------------------------ | ------------------------ | --------------------- |
| Required core behavior                           | 255 passed               | 216 passed            |
| Core controls and harness checks                 | 58 passed                | 58 passed             |
| Required browser behavior                        | 90 passed                | 74 passed             |
| Browser controls                                 | 6 passed                 | 6 passed              |
| Opt-in core gaps                                 | 13 failed, exit 1        | 54 failed, exit 1     |
| Opt-in browser gaps                              | 15 failed, exit 1        | 31 failed, exit 1     |
| Unsupported core ABI cases (metadata, not tests) | 3                        | 1                     |

The full default `bun test` run passes **916 tests**, including the native core
lane above, existing public-library tests and harness/policy checks. Browser runs
use the canonical container: **96 native / 80 legacy passes**, zero skips, retries
or flaky results. All eight reviewed scene images remain unchanged. Core matrix
reports list gaps and unsupported ABI scope separately from executed pass/fail
counts; no required cases are missing.

The previous totals of 804 Bun tests, 307 core tests per engine and 105 browser
tests included accepted failures or non-executed applicability checks. **They were
not a 100%-passing behavioral baseline and are superseded by the counts above.**
The split preserved all 263 core behavior declarations and 97 browser behavior
declarations, replacing three obsolete browser manifest checks with one scope
check. The Vim-exit and checkpoint-review fixes added eight required core cases and
three required browser cases. The subsequent native keyboard slice adds ten native
input unit tests and one browser text/shortcut case, and promotes six core keyboard
gaps plus the browser Alt-key gap on native only, without changing their assertions.
The native mouse slice adds ten bridge tests, nine DOM unit tests and two browser
behavior cases, and promotes eight core gaps plus the browser wheel gap unchanged
on native. Application-drag selection suppression passes on both engines; the new
Shift-local selection case reproduces a legacy-only gap. The paste/focus slices add
26 bridge/host unit tests and two browser cases, promoting six core and two browser
gaps unchanged on native. The OSC 8 safety fix adds 49 provider tests and promotes
its browser gap on both engines. The current catalogues contain 271 core and 111
browser declarations (105 browser behavior cases plus 6 controls). No existing
required case was demoted.

See [the migration notes](../docs/migration-libghostty-vt.md) for independent
reference/package validation, improvements and the approved native scrollback
contract. Native-retention negative controls fail when the adapter clamps history
to 100 rows or ignores the configured budget.

## Run it

Prerequisites: Bun **1.2.15**, Node **22.19.0** (Playwright/package checks), and Zig **0.16.0** for native WASM. The optional legacy comparison build needs Zig **0.15.2**. Install locked dependencies and build it first:

```bash
bun install --frozen-lockfile
bun run build:wasm

bun test                         # existing tests + core regression and policy self-tests
bun run test:regression           # native candidate regression suite
bun run build:wasm:legacy        # requires ZIG_0_15_BIN or Zig 0.15.2
bun run test:regression:legacy   # explicitly loads ghostty-vt-legacy.wasm
bun run typecheck                # production AND test/harness TypeScript
```

Browser tests use **Playwright 1.64.0** and its matching Chromium. Both fonts are vendored and digest-checked, never downloaded from a CDN. On Linux, `--with-deps` installs browser system libraries; omit it if they are already available.

```bash
bunx --no-install playwright install --with-deps chromium --only-shell
bun run test:regression:browser
bun run test:regression:container # exact CI browser/OS image; Linux x86_64 + Docker
bun run test:regression:package   # build + real npm tarball, exports, types, browser initialization
```

The core matrix runs both required engines and checks exact scope coverage:

```bash
bun run test:regression:matrix --legacy ./ghostty-vt-legacy.wasm --candidate ./ghostty-vt.wasm
bun run test:inventory:browser   # required/gap IDs and counts without executing cases
```

Gap commands are **opt-in diagnostics, currently expected to exit 1**. They do not
invert failing assertions into success, and a genuinely fixed gap passes normally:

```bash
bun run test:gaps:core
bun run test:gaps:core:legacy
bun run test:gaps:browser        # explicitly selects playwright.gaps.config.ts
bun run test:regression:container --gaps
GHOSTTY_REGRESSION_ENGINE=web-pinned bun run test:regression:container --gaps
```

Required commands choose their lane explicitly; an ambient suite variable cannot
switch them to gaps. Gap entry points refuse `GHOSTTY_REQUIRED_CI=1`, which required
CI sets. `.gap.ts` entries are not discovered by ordinary `bun test`.

Set `PLAYWRIGHT_BROWSERS_PATH` to an external cache directory if desired; use the same value for installation and execution. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is an explicit local diagnostic override, **not** the CI configuration. The Vite harness defaults to `127.0.0.1:4173` (`GHOSTTY_REGRESSION_PORT` can isolate local runs), refuses an already-running server, and needs no PTY or shell session. Browser specs use `.pw.ts` so `bun test` cannot accidentally execute Playwright tests.

`test:regression:package` requires `npm`, `node` and `tar`. It packs with `--ignore-scripts`, extracts into a temporary isolated consumer, checks ESM/CJS exports and declarations, and starts a local static server for actual Chromium imports of both browser bundles. It does not install network dependencies in the consumer. Set `REGRESSION_ARTIFACT_DIR` to control its temporary directory; failed artifacts are retained and their path printed.

## Visual baseline review

Eight small, finding-free scenes guard the whole terminal image. They also assert text, colors, selection ranges, viewport markers or independently rendered glyphs; they are not blind recordings of current behavior. See [browser/scenes/README.md](browser/scenes/README.md) for the scene catalogue, exact environment, and review process.

```bash
bun run test:regression:scenes:candidates
```

This opt-in command runs in the canonical container and writes candidates/montage to a new external evidence directory. It never overwrites committed baselines. Missing baselines fail normal tests; updates require explicit inspection and manual promotion. Source is mounted read-only when using the container helper.

## Independent upstream reference

The reference is a test-only consumer of **Ghostty `246f702876b924a1cb7cade1e99274d1470302fc`**, built with **Zig 0.16.0**. It is not installed as ghostty-web's engine. It exercises the shared VT fixture corpus and additional native protocol/state behavior with no known-failure allowlist.

```bash
# Use a scratch directory OUTSIDE this repository. Its parent directory must exist.
ZIG_REFERENCE_BIN=/path/to/zig-0.16.0/zig \
  ./scripts/build-reference-wasm.sh /path/to/scratch/ghostty-reference

source /path/to/scratch/ghostty-reference/out/reference.env
export GHOSTTY_REFERENCE_WASM GHOSTTY_REFERENCE_COMMIT GHOSTTY_REFERENCE_WASM_SHA256
bun run test:regression:reference
```

The builders use `ghostty-build.json` as the single source of pins, compilers, hashes and budgets; they isolate source/cache/output directories and emit `build-info.json`. Unverified pins are refused by normal builds. Both the runner and CI check the exercised artifact SHA-256. The runner rejects a different artifact even when no hash environment variable is supplied; any supplied commit/hash must agree with its reviewed constants. Missing WASM, missing exports/capabilities, mismatched provenance, or wrong oracle results must fail; they are not skipped. A future reference revision requires a reviewed pin/compiler/hash update, not a floating `main` fetch during tests.

## What each lane checks

| Lane                          | Purpose                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `regression/support/`         | Strict assertions and explicit scope contracts; all failures propagate, unknown cases and empty assertions are rejected  |
| `regression/fixtures/vt.json` | Shared, independently specified VT vectors with source provenance; not snapshots of the shipping backend                 |
| `regression/core/`            | Semantic state, byte-exact protocols/input, fragmentation, Unicode, lifecycle and public-API behavior                    |
| `browser/`                    | Option/glyph oracles, real scrollback/selection/clipboard interaction, analytic pixels, reviewed scenes and DPR behavior |
| `scenarios/core/`             | Shared core behavior definitions; no automatic test discovery                                                            |
| `gaps/`                       | Opt-in bug/parity reproducers with original assertions and nonzero failure exits                                         |
| `regression/reference/`       | Same VT corpus and independent native API checks against the pinned upstream WASM                                        |
| `packaging/`                  | Actual tarball/runtime exports, a declaration consumer and browser WASM resolution                                       |

The shared single-cell corpus trims only trailing empty/space padding by contract. Width, grapheme and space-sensitive regressions need separate explicit assertions: do not make the normalizer erase a meaningful discrepancy. A reference running the same Ghostty core is an **integration oracle**, not proof that the core is correct; hand-written protocol vectors, upstream-test provenance and invariants remain independent checks.

## Required coverage versus the gap backlog

`regression/core/scope.json` and `browser/scope.json` positively classify each case
for each engine as required, gap or unsupported ABI scope. They are reviewed
contracts, not a runtime response to failures. Missing, duplicate or unclassified
cases fail catalogue validation; an unknown case cannot silently become a gap.
Native-fixed cases stay required on native even when legacy still fails them.

Core behavior bodies live in `scenarios/core/*.cases.ts`, with required wrappers
under `regression/core/` and a separate `gaps/core/core.gap.ts` entry. Browser gap
entries import the same `.pw.ts` definitions through `playwright.gaps.config.ts`.
Both lanes execute the same desired assertions through strict `runRegression`:
assertion failures, exceptions, missing capabilities and empty bodies all fail.
There is no failure-signature success path. Unsupported ABI cases are inventory,
not passing or skipped tests. The old manifests under `gaps/*/history/` are frozen
provenance only; the runners do not load them.

Subprocess controls prove that a broken required assertion returns nonzero, gaps
return nonzero when they reproduce, unknown/missing cases block registration, and
required CI rejects gap entry points. Browser listing checks compare the actual
registered tests against the plan on both engines. Policy checks reject test-level
skip, failing/xfail, fixme and focus declarations in these lanes.

**Never move a newly failing required case into gaps to restore green CI.** Fix the
regression, or obtain explicit review of a deliberate supported-contract change.
Promote an existing gap to required only after its original assertion genuinely
passes; keep its case ID and oracle. Do not weaken expectations or regenerate
visual baselines merely to make a migration pass. Trap reproducers must still use
fresh WASM instances; shared-instance recycling is tested separately.

## CI and evidence

`.github/workflows/regression.yml` is a reusable workflow called by the main CI gate, with native/legacy build, core and browser axes plus the independent reference job. Each WASM is built once and shared by artifact. The native default payload is budgeted at 1 MiB; the separately built legacy artifact retains its 512 KiB budget. Bun, Node, Zig and Playwright versions are fixed. The browser job uses the exact image digest recorded with the reviewed scenes. Browser retries are disabled and CI runs each case once. Longer repeat runs are an optional local diagnostic, not a scheduled or pull-request requirement. There are no responsiveness benchmarks or timing budgets.

Playwright traces, screenshots/reports and run logs are uploaded on failure. The reference job preserves build metadata and logs. Local Playwright artifacts live in ignored `test-results/` and `playwright-report/`; cleanup never rewrites expected fixtures.

## Limits

This is a concrete initial migration suite, not a claim of complete Ghostty conformance. Chromium is the automated browser gate. Real IME, macOS Option layouts, AltGr, assistive technology and hardware-GPU/cross-browser behavior still need manual validation. Responsiveness benchmarks are explicitly excluded. Additional browser engines and any larger golden matrix are outside the current scope. See [the research plan](../docs/research/ghostty-alignment/08-regression-suite.md) for the larger coverage map and why the PR #128 PNG-size comparator was not adopted.
