# libghostty-vt migration

## Target and rollout status

The default backend uses unpatched Ghostty
`246f702876b924a1cb7cade1e99274d1470302fc`, selected from current upstream on
2026-10-10. The latest stable tag checked (`v1.3.1`) does not contain the required
terminal C API. Exact pins, toolchains, hashes and artifact budgets are centralized
in `ghostty-build.json`.

**Approved contract: retain Ghostty's native page-based scrollback behavior.**
The native backend is the default; the legacy engine remains an explicit
comparison/rollback option. Exact xterm-style retention is deferred, not silently
emulated by hiding rows. This is not a claim that every historical web-layer defect
has been fixed.

| Backend         | Zig    | WASM bytes | Distribution                                           |
| --------------- | ------ | ---------- | ------------------------------------------------------ |
| `libghostty-vt` | 0.16.0 | 847,348    | Default build target, unpatched                        |
| `legacy`        | 0.15.2 | 424,058    | Explicit separately-built comparison/rollback artifact |

The native artifact has a reviewed 1 MiB budget rather than the old shim's
512 KiB budget. That is an intentional size increase for the full upstream API,
not a performance claim. No responsiveness benchmark or long CI repeat is added.

## Bridge boundary

The public `Ghostty`, `GhosttyTerminal` and `KeyEncoder` constructors and methods
remain facades. `backend` reports the actual engine. An explicit backend
requirement rejects a mismatch; an invalid native manifest never falls back to
legacy. Native layouts, bit positions and enums come from `ghostty_type_json`.
Public numeric key constants stay stable and are mapped to native names.

The native adapter caches render snapshots, decodes dirty rows through the bulk
row API, and accumulates dirty state until cleaned. History reads use grid refs
without moving the native viewport; JavaScript retains viewport/selection policy
for this first migration. The old patch is archived in `patches/legacy/` and is
not applied to the upgraded submodule.

Native replies are copied immediately out of callbacks and drained in order;
clipboard-read callbacks are not enabled. Host integration supplies real CSS cell
metrics for size reports, consumes native cursor defaults/styles and explicit
color metadata, and uses terminal-derived native keyboard options while Kitty
keyboard mode is active. Existing browser clipboard/shortcut policy remains in
JavaScript. Structured title/bell effects, complete mouse encoding, native
selection, synchronized-output presentation and other improvements remain later
work rather than being mixed into this bridge replacement.

## Scrollback contract: native retention

The user approved native page-granular retention rather than adding an exact
xterm-style cap during this upgrade. `scrollback` is an approximate budget in
physical history lines; its default is 10000. Ghostty allocates and prunes whole
pages, so the available count varies with width, styles, graphemes and page
recycling. It is **not a guaranteed exact maximum or minimum**. Zero disables
history. `getScrollbackLength()` and buffer APIs expose the history actually
retained; there is no hidden/clamped JavaScript history window.

The old bridge incorrectly interpreted the option as bytes. For one 100-line
budget fixture, legacy retains 977 lines and native retains 304, but neither
observed count is a new hard-coded oracle. Native regression tests compare
retention, accessible content and buffer length with an independently configured
upstream instance at multiple checkpoints and budgets. They also prove that a
small budget really prunes while a large budget retains the same finite input.
The old exact-count check remains explicitly legacy-only; it is not waived on
the native backend.

An exact compatibility cap may be implemented later, together with correct
selection and viewport tracking when the logical history window advances.
Scroll-on-output is a separate product-policy question; adopting native retention
does not silently change today's jump-to-bottom-on-output behavior.

## Regression policy and evidence

- The old engine is reconstructed from its recorded commit, patch hash and Zig
  version; its artifact remains byte-identical to the pre-migration safety build.
- The independent native reference suite now has 157 cases, including upstream's
  newly added DECSTR and origin-mode formatter behavior.
- Old passing public-library tests and all eight reviewed scene images are kept;
  no scene baseline was regenerated to make the candidate pass.
- Native-fixed cases are required on native, even when they remain legacy gaps.
- Required execution has no failure exemptions. Per-engine scope plans positively
  identify required cases; unknown, missing or duplicate cases fail validation.
  Existing bug reproducers and future-parity requirements run separately through
  explicit gap entry points, with their original desired assertions and real
  nonzero failure exits. Historical manifests are evidence only, not runtime
  allowances. A newly failing required case remains a regression, not a new gap.
- The history-pruning interaction fixture now requests an explicit budget, writes
  1000 then 200 lines, and verifies that pruning happened while line 999 remains.
  Both engines expose the same existing selection-anchor failure under that
  fixture. Its desired selected-text invariant is unchanged.
- The decode-count test now counts actual native snapshot refreshes after a write,
  not cached public getter calls. The legacy path still counts its full decodes.

## Final validation

The required baseline, including checkpoint-review fixes, was validated on
**2026-10-12**:

- **792 native-default Bun tests passed**, with no accepted-failure outcomes.
- Required core: **293 native / 274 legacy passes** (235 / 216 behavior cases plus
  58 controls per engine), with no missing cases or matrix blockers.
- Required browser: **86 native / 77 legacy passes**, zero skips, retries or flaky
  results in the canonical container. All eight reviewed scene images are unchanged.
- Opt-in core gaps: **33 native / 54 legacy failures**. Opt-in browser gaps:
  **20 native / 29 legacy failures**. Every gap run exited **1**; these are open
  defects/parity requirements, not passing regression coverage. Counts across
  lanes overlap in findings and are not unique bug counts.
- The independently rebuilt upstream reference passed **157 checks**; the real
  package consumer passed **6 checks**. Formatting, lint, both TypeScript projects,
  workflow lint, shellcheck and the full native shipping build passed.

The earlier totals of 804 Bun tests, 307 core tests per engine and 105 browser
tests included accepted failures or applicability-only checks. They are **not**
a fully passing behavioral baseline; the strict counts above supersede them.
The split preserved all behavior declarations and desired assertions, production
source files and reviewed images. Only suite membership, harness controls and
reporting changed; existing bugs were not fixed or redefined as correct.

See [the test guide](../tests/README.md) for scope inventories, commands and the
no-demotion/promotion policy. Nix toolchain selection was evaluated, but a full
Nix package build and GitHub-hosted workflow execution were not run locally.

## Interactive smoke follow-up: keyboard-mode exit

The real PTY smoke test found a native-only regression missing from the initial
suite: after Vim pushed Kitty flags, a key synchronized the encoder, and Vim
popped the flags on exit, Ctrl-B/C/U were encoded as plain letters. That broke
tmux's Ctrl-B prefix in the same session. The focused reproducer passed legacy
and failed native; it was not classified as an existing gap.

The non-Kitty input path now clears the cached native Kitty flags before encoding
control/navigation keys. The change is limited to a terminal-bound native encoder;
standalone encoder options, browser policy and the other input paths are unchanged.
Five new required core cases cover pop, explicit disable, RIS, `Terminal.reset()`
and leaving the alternate screen, each with repeated flag-1/flag-3 cycles and key
releases. A new required browser case exercises the same exit with trusted keys.
All six cases were observed failing before the fix and pass afterward.

The post-fix live retest passed Vim edit/save/resize, exit to the shell, Ctrl-B
(`02`), Ctrl-C (`03`), then tmux split, pane switching, resize and detach **in the
same session**. The earlier shell, scrollback, ordinary selection/copy and bracketed
paste smoke checks passed. No JavaScript error or WASM trap was recorded in the
completed retest. Testing used Chromium on Linux with a real PTY; host fonts lacked
CJK glyphs, and OS IME, accessibility and other browser/platform manual gates are
still unverified. All smoke-test services were stopped afterward.

## Checkpoint review corrections

The bounded checkpoint review found and corrected three additional integration
issues before committing the migration:

- **Kitty release ownership:** key releases are sent only for presses actually
  forwarded to the terminal, never for host-consumed shortcuts or Copy/Paste.
  Pending ownership is cleared on blur/disposal. Two required core cases and one
  trusted-key browser case cover the boundary; existing active-Kitty release
  coverage remains required.
- **Parser-driven grid changes:** DECCOLM can resize upstream's grid to 80/132
  columns without a host resize. The native adapter now checks the C API's actual
  dimensions after each write chunk and restores the host dimensions before
  exposing cached rows. This prevents a permanent render-loop size exception.
  Shared required core/browser cases protect render survival and host-resize
  recovery; a native bridge test additionally checks retained last-cell output.
  Legacy can blank the unsupported resized viewport, so full DECCOLM fidelity is
  not falsely claimed for that backend.
- **Clean CI bootstrap:** the pinned Playwright image lacks `unzip`, which
  `setup-bun` requires. The browser job installs it before setting up Bun. The
  exact image was exercised with the Bun 1.2.15 release ZIP, rather than relying
  only on the local helper's mounted host binary.

These are fixes with new required assertions, not new failure exemptions. The
native WASM pin/hash and reviewed images are unchanged; no broad keyboard/mouse
rewrite or backlog scope change is bundled into this checkpoint.

## Commands

```bash
export ZIG_0_16_BIN=/path/to/zig-0.16.0/zig
export ZIG_0_15_BIN=/path/to/zig-0.15.2/zig
bun run build:wasm:all
bun run test:regression:matrix --legacy ./ghostty-vt-legacy.wasm --candidate ./ghostty-vt.wasm

GHOSTTY_REGRESSION_ENGINE=web-candidate bun run test:regression
GHOSTTY_REGRESSION_ENGINE=web-pinned bun run test:regression:legacy
GHOSTTY_REGRESSION_ENGINE=web-candidate bun run test:regression:container
GHOSTTY_REGRESSION_ENGINE=web-pinned bun run test:regression:container
```

Both matrix axes are part of the reusable regression workflow called by the main
CI workflow. The independent reference and package consumers remain separate
checks. Nix compiler selection was evaluated for both versions; a complete Nix
package build was not run.
