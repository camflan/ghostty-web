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
color metadata, and uses terminal-derived native keyboard options for ordinary
keys as well as Kitty mode. Native mouse events now use Ghostty's mouse encoder;
the browser retains gesture ownership, wheel granularity and the string transport
boundary (see the mouse slice below). Browser clipboard/shortcut policy remains in
JavaScript. Structured title/bell effects, native selection, synchronized-output
presentation and other improvements remain later work.

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

The required baseline, including native keyboard, mouse, paste/focus routing and
OSC 8 activation safety, was validated on **2026-10-12**:

- **916 native-default Bun tests passed**, with no accepted-failure outcomes.
- Required core: **313 native / 274 legacy passes** (255 / 216 behavior cases plus
  58 controls per engine), with no missing cases or matrix blockers.
- Required browser: **96 native / 80 legacy passes**, zero skips, retries or flaky
  results in the canonical container. All eight reviewed scene images are unchanged.
- Opt-in core gaps: **13 native / 54 legacy failures**. Opt-in browser gaps:
  **15 native / 31 legacy failures**. Every gap run exited **1**; these are open
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

The initial fix cleared the cached native Kitty flags on the non-Kitty path before encoding
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

## Post-checkpoint slice: native keyboard routing

Migration checkpoint `ffe8b66` remains separate from this implementation slice.
Terminal-bound native keyboard events now use `syncFromTerminal()` before every
press, repeat and paired release. Ghostty selects ordinary, application-cursor,
keypad, backarrow, modifyOtherKeys and Kitty encodings, including transitions back
to disabled/default modes. The native path no longer uses the JavaScript printable
bypass or hard-coded special-key escape table. Those remain only for the explicit
legacy backend and standalone InputHandler compatibility path.

The browser adapter supplies resolved Unicode text, key identity and modifier
state. It distinguishes NumLock-off keypad navigation from keypad digits, retains
case rather than lowercasing the transmitted text, and uses an unidentified native
key for code-less printable events. Browser-reported AltGraph text is normalized
without synthetic Ctrl/Alt shortcut bits (or its text-producing Shift bit).
Custom key handlers, Copy/Paste, dead keys, composition and beforeinput stay in
JavaScript; only releases paired with forwarded presses reach the encoder.

Six existing core gap cases now pass their original assertions and are required
on native: Alt-letter, Alt-punctuation, Ctrl+Alt+C, Shift+F5, Shift+Home and Home in
application-cursor mode. The browser Alt-letter case is also promoted. Legacy
membership and behavior are unchanged. Ten new native input unit tests cover
mode transitions, keypad handling, text/layout preservation, AltGraph, dead keys,
composition, repeat/release, backarrow and beforeinput de-duplication. A browser
case checks Unicode text through the existing textarea path and host-owned Copy.

Validation additionally passed eleven byte-exact checks through a real Chromium
keyboard → WebSocket → PTY session, followed by Vim edit/save/resize and same-session
tmux split/switch/resize/detach. No page errors were recorded. OS-level IME, real
non-US keyboard layouts and macOS Option policy remain manual-validation limits:
KeyboardEvent does not supply a complete unshifted layout map, and the adapter's
numeric/shifted-punctuation fallback is necessarily best-effort. This slice does
not change mouse/wheel encoding, paste sanitization, focus reporting, selection,
rendering, the WASM pin, or reviewed visual baselines.

## Post-checkpoint slice: native mouse routing

The native backend owns a persistent, manifest-resolved mouse encoder and reusable
event/output storage. The host supplies canvas-relative CSS coordinates, geometry,
buttons and modifiers; Ghostty selects the live tracking mode and protocol format,
clamps or drops out-of-view events, and deduplicates motion by cell. The tracking
probe uses a separate encoder so it cannot disturb input deduplication. Mode
synchronization is lazy after writes, not repeated for every DOM event; a write
currently resets motion history before the next event, even for ordinary output.
Resize/metric changes and explicit resets also clear that history.

Application tracking now precedes local history scrolling and alternate-screen
arrow fallback. Each nonzero wheel axis produces one native press per DOM event,
preserving the existing web reporting granularity rather than introducing native
trackpad acceleration. Custom wheel handlers retain precedence; disabled stdin and
scrollbar drags remain host-owned. With tracking off, existing history scrolling
and alternate-screen arrow behavior are unchanged.

Shift-started button gestures remain local selection even if Shift is released
mid-drag. Application-owned presses retain their release if Shift changes, including
release outside the canvas. Blur/reset/disposal clear gesture ownership. Tracked
clicks do not activate local hyperlinks or the local context menu; Shift bypasses
that policy. The upstream XTSHIFTESCAPE override is not exposed by this C API, so
this slice implements the default host Shift-selection policy, not that override.
Legacy input encoding/routing is unchanged.

**The PTY API is still string-only.** SGR, URXVT, SGR-pixels and UTF8 mouse formats
can be decoded losslessly. Classic X10 reports containing invalid UTF-8 high-bit
bytes are withheld rather than corrupted or double-encoded; a withheld press does
not create an orphan release. The raw-byte X10 case remains an explicit failing
gap. No `onBinary` API or transport migration is implied by this slice.

Eight existing core gaps pass their unchanged assertions on native and are now
required: Alt/Meta presses, Shift bypass, cell-motion deduplication, no-button
motion, X10 coordinate overflow, and wheel reporting on normal/alternate screens.
The browser wheel gap is promoted too. Ten new bridge tests and nine native DOM
unit tests cover ABI/lifetime, formats/geometry, ownership and transport boundaries.
Two new trusted-pointer browser cases protect Shift-local selection and suppression
of local selection for application drags. The latter passes on both engines;
Shift-local selection remains a reproduced legacy-only gap. No required case was
demoted and no reviewed image changed. The Happy DOM wheel fixture explicitly
supplies coordinates omitted by its WheelEvent implementation; desired behavior
assertions were not changed.

Live validation passed six byte-exact Chromium → WebSocket → PTY mouse probes,
then a fresh same-session Vim/tmux smoke. Vim negotiated 1002/1006, a click landed
at line 10/column 4, and a wheel event moved the viewport top from line 1 to line 4.
Tmux clicks selected both panes, wheel input entered copy mode, and Shift-drag
copied `TMUX_LINE` locally with no mouse reports sent to the PTY. No page error or
WASM trap was recorded. Browser, private tmux server and demo services were stopped.
Real trackpad acceleration and other browser/platform manual gates remain unverified.

## Post-mouse slice: terminal-aware native paste

`Terminal.paste()`, clipboard paste and `beforeinput` paste now share upstream
`ghostty_terminal_paste()`. The bridge supplies one `text/plain` representation;
Ghostty reads live mode 2004, sanitizes its control-byte list and supplies framing
or LF-to-CR conversion. CRLF becomes CRCR when unbracketed, matching the pinned
upstream encoder rather than adding host normalization. Browser event deduplication
still compares the original clipboard text. Legacy and standalone input handlers
retain their existing behavior.

The existing public policy permits multiline paste without prompting, so the
bridge explicitly passes `allow_unsafe=true`. This is **not** a command-injection
confirmation feature: newlines can still execute commands in an unbracketed shell.
Upstream still neutralizes embedded bracketed-paste terminators by replacing ESC
with a space. Clipboard-read callbacks remain disabled; no Kitty clipboard grant,
new browser permission request or clipboard protocol is enabled.

Native output chunks are copied immediately into a separate paste capture, then
emitted as one UTF-8 string. Pending terminal replies are neither consumed nor
mixed into the paste, and no user callback runs inside the native paste operation.
Empty paste emits nothing; disabled stdin still suppresses host input. Ten bridge
and six DOM/public-API tests cover live mode changes, all host paste routes,
Unicode across native chunks and memory growth, reply isolation, failure recovery,
and reentrant host listeners. A trusted Chromium clipboard case checks sanitization
and mode transitions. Three core gaps and the browser newline gap pass their
original assertions and become required on native; legacy failures remain explicit.

## Post-paste slice: native focus reports

The native backend uses manifest-resolved `ghostty_focus_encode()` for mode-1004
reports. `Terminal` tracks focus across its container and hidden textarea as one
input surface; internal transfers do not emit duplicate loss/gain pairs. Window
focus changes report only for the terminal owning DOM focus. Disabled stdin still
tracks state but emits nothing, with no catch-up report when re-enabled. Reports
do not clear selection or mark user-echo pending. `blur()` now blurs a focused
textarea as well as the container; native `focus()` no longer schedules a delayed
refocus that could steal focus back. Disposal removes observers before removing
focused elements. Legacy focus behavior is unchanged.

Writes observe mode 1004 before and after upstream parsing. An observable off→on
transition reports the current host focus after the write's other replies. Split
sequences work because upstream retains parser state. RIS/reset disable reporting;
DECSTR follows upstream's retained mode. Three existing core focus gaps and the
trusted-pointer browser gap pass unchanged. Eight new host tests, two bridge tests
and one browser lifecycle case cover internal transfers, multiple terminals,
window events, shadow roots, disabled stdin, reset and teardown.

**Upstream C API limit, not full native-app parity:** there is no mode-change
callback or focused-state setter at this pin. Repeated `?1004h`, an off/on pair
within one write that starts on, and restoring an already-on mode are not observable
as new enables. Enable-triggered reports follow the write's queued replies rather
than appearing at the native app's exact in-stream position; reentrant host listeners
can also interleave focus events with replies. The host does not add a second VT
parser to imitate these cases. Exact parity needs an upstream focused-state option
with native report-on-enable, or a mode-change hook.

## Built-in OSC 8 activation safety

OSC 8 targets are untrusted terminal output. The built-in provider now opens only
absolute URLs using the protocol forms already recognized by `UrlRegexProvider`:
HTTP(S), mailto, FTP, SSH, Git, tel, magnet, Gemini, Gopher and news. A URL must pass
both the prefix policy and the URL parser; the validated normalized URL is opened.
Executable/document schemes (including javascript, data, file and blob), unknown
custom schemes, relative references, malformed URLs, spaces and control-byte
obfuscation are refused. Ctrl/Cmd activation and `noopener,noreferrer` remain
required. Refused links retain their ranges so regex detection cannot override an
explicit OSC 8 link. Custom providers retain their own activation policy.

Forty-nine provider tests cover allowed/refused targets, normalization, modifiers,
active/history lookups and range precedence. The original javascript-activation
browser gap now passes unchanged and is required on both engines. This is a host
security policy, not another terminal parser or an upstream WASM patch.

The completed paste/focus live smoke used Chromium, the loopback demo WebSocket
and a real raw-mode PTY. Six byte-exact checks passed: unbracketed paste, bracketed
paste, report on observable focus-mode enable, blur, focus, and no focus reports
after disable. No browser error or WASM trap was recorded; smoke services were
stopped afterward. Native OS clipboard dialogs, real IME and other browser/platform
manual gates remain unverified.

## Native title/bell callbacks and buffer text checkpoint

Native terminals now subscribe to upstream BELL and TITLE_CHANGED effects rather
than scanning input chunks. Callbacks copy titles immediately and queue events;
user listeners run only after native parsing returns. Replies, bells and titles
retain parser order, including multiple events in one write. The host queue handles
nested writes, reset/disposal and listener exceptions. Same-title suppression stays
at the public host boundary. Legacy continues using its prior heuristics.

The four original native event gaps pass unchanged, including fragmented and
Uint8Array titles and BEL used as an OSC terminator. New native bridge, lifecycle
and browser coverage checks event ordering, callback isolation and fragmentation.
A required reentrancy test additionally guards against duplicate focus reports when
a bell listener enables mode 1004 from a nested write.

Buffer lines capture complete active/history grapheme strings when read, so
retained cells do not look up text from a later write. Column extraction emits
interior blanks, skips wide-character tails when starting at a wide glyph, and
preserves padding when untrimmed. Both engines pass the original blank-cell and
`getChars()` grapheme assertions. The existing public `trimRight` policy still
removes all trailing whitespace; changing it to xterm's narrower unpopulated-cell
trimming broke existing scene-text contracts and was deliberately not included.
Neither those assertions nor the reviewed images were changed.

This checkpoint passed 944 Bun tests, required core 319 native / 276 legacy,
required browser 97 native / 80 legacy in the canonical container, all six package
checks, formatting, lint, typecheck and the pinned build. The new native parser-event
browser case was separately observed failing on legacy; it is not an accepted failure.

Inactive normal-screen reads remain blocked by the pinned C API, which resolves
row counts, grid refs and formatting against the active screen. This checkpoint
does not introduce a JavaScript VT parser or snapshot round-trip workaround to
claim that gap is fixed.

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
