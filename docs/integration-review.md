# Integration review of the Ghostty alignment work

Reviewed checkpoint: `151eb92` (2026-10-13).

Four scoped review lanes covered the native bridge, rendering/appearance,
input/viewport/events, and API/packaging. The first run completed its bridge review
but three lanes exceeded the bounded review window. Their saved probes were
recovered in a second pass; completed reports and actionable evidence were retained.
This was not treated as a clean result for timed-out lanes.

## Addressed findings

| Area                     | Problem                                                                                                                                     | Correction / regression coverage                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native hyperlinks        | The URI-to-id map grew with all output ever decoded, even with no history.                                                                  | Bound the cache relative to grid size, preserve live/held ids, retain recent history ids, and never reuse an evicted id for a different URI. `native-review.test.ts` covers growth and identity stability.                              |
| Native wide cells        | Upstream clears a wrapped wide-cell marker in the previous row without marking that row dirty, leaving the render-state cache stale.        | Re-read the suspect cell through the active grid API, preserve a held copy before updating, and mark the repaired row dirty. Unit and browser tests compare split reads with a single write. No upstream patch or global redraw bypass. |
| Allocation failure       | A key event could leak when the length allocation failed; a partially constructed mouse probe could leak or remain invalid.                 | Scope every handle under cleanup and make probe construction atomic. Fault-injected tests count handles and verify recovery.                                                                                                            |
| Hold error paths         | A resize/callback error could leave a held frame attached to replaced storage.                                                              | End host holds before pool replacement and reconcile mode state on write failure. Fault-injected and explicit mode-change tests cover it.                                                                                               |
| Read-only input          | Alternate-screen wheel fallback emitted arrow bytes with `disableStdin` enabled.                                                            | Suppress that input on both engines while retaining ordinary enabled wheel behavior.                                                                                                                                                    |
| Key ownership            | Internal container/textarea focus transfers discarded Kitty release ownership; window blur could retain it.                                 | Treat the terminal as one focus surface, clear ownership on real/window blur, and retain it on internal transfers.                                                                                                                      |
| Key delivery             | A disabled key press could acquire ownership and emit a release after input was re-enabled.                                                 | Only delivered native presses acquire release ownership.                                                                                                                                                                                |
| Native modifiers         | Lone Shift/Ctrl/Alt/Meta keys never reached Ghostty's report-all encoder.                                                                   | Map their left/right identities on native, retain empty-encoding browser behavior, and preserve local selection for modifier reports.                                                                                                   |
| Wheel cancellation       | Interrupting an animation could leave a permanently fractional viewport and fractional scroll events.                                       | Settle to the clamped whole-row destination; explicit navigation reports only its final position.                                                                                                                                       |
| Resize ordering          | In-band size replies could reach the PTY before the host's resize callback, and a throwing data listener could cancel notification/repaint. | Defer reply/event delivery across resize notifications, preserve nested-call order, restore rendering, and propagate listener errors instead of swallowing them.                                                                        |
| Legacy selection repaint | Replacing a selection did not repaint its old rows.                                                                                         | Track previously painted selection rows on both engines.                                                                                                                                                                                |
| Legacy cursor repaint    | Hiding/showing an unmoved cursor could leave its old pixels.                                                                                | Track visibility changes on both engines while keeping native-only cursor-style policy. The original legacy DECTCEM assertion now passes unchanged.                                                                                     |

New deterministic regression tests live in `lib/native-review.test.ts`,
`lib/renderer-legacy-repaint.test.ts`, and `lib/review-input.test.ts`. Browser
review cases cover read-only wheel input, internal focus/key releases, modifier
selection ownership, and read-timing-independent wide-cell presentation.

## Compatibility question left explicit

With omitted theme fields, the historical bridge defaults and canvas defaults are
not identical: the native default background query reports black, while the canvas
background is `#1e1e1e`. The behavior predates these fixes. Aligning the color-query
contract with the painted defaults needs an explicit compatibility choice; this
review did not silently alter construction defaults or passing color/image oracles.

The previously documented inactive-screen/focus C-API limits, jump-on-output
policy, native selection pruning policy, and legacy runtime-theme limitation are
also unchanged. They are not counted as fixed findings.

## Validation

- 1,100 Bun tests passed, no accepted failures.
- Required core: 325 native / 278 legacy; no missing cases or blockers.
- Required browser: 120 native / 90 legacy; all eight reviewed images unchanged,
  zero skipped, retried or flaky results in the final canonical runs.
- Independent reference: 157 checks; package consumer: 6 checks.
- Formatting, lint, typecheck and the pinned native build passed.
- Explicit gap commands still exit 1: core 1 native / 50 legacy; browser 1 native /
  31 legacy. Two new legacy keyboard gaps reflect its intentionally retained path,
  not demotions of required tests.
- A real Linux PTY smoke passed before and after the fixes: Vim mouse click/scroll,
  live theme and font-size change, then tmux pane switching, wheel copy mode,
  Shift-local selection and detach in the same browser session. No page errors or
  WASM traps were observed. All smoke processes were stopped.

## Fresh post-fix review (round 2)

A new set of four reviewers examined checkpoint `40fffbe`. All four returned final
reports successfully; none timed out. The collector's response-wrapper formatting
was incorrect, so completion and the report text were verified directly against the
persisted completed-step records rather than inferred from the collector summary.

| Lane      | Reviewer task | Finished (2026-10-13 UTC) | Outcome                                                                                                          |
| --------- | ------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Rendering | `bccb8053d8`  | 07:34:35                  | Found the remaining legacy runtime cursor-style repaint and a replaced-then-cleared selection edge.              |
| Lifecycle | `87a9811877`  | 07:35:40                  | Found stale later resize notifications after a nested resize, and delayed reports after a resize-listener error. |
| Bridge    | `8f58ccecc9`  | 07:36:08                  | Found visible hyperlink IDs could be evicted during the first partial decode after a shrinking resize.           |
| Input     | `b8968792a0`  | 07:39:09                  | Found runaway/frozen scrolling at sub-frame durations and explicit navigation losing to the cancelled target.    |

The resulting fixes preserve hyperlink IDs until a complete resized viewport has
been decoded, then enforce the new cache bound; invalidate the actually drawn
cursor style and selection rows; settle short/invalid scroll durations immediately;
and always assign explicit navigation destinations. Resize delivery uses a guarded
listener snapshot so a successful nested resize supersedes remaining stale callbacks.
An invalid nested resize does not invalidate the valid outer event. Cleanup, repaint
and reply draining still run after an observer throws, while the first error is
preserved for the caller.

Nine new unit cases include eight assertions observed failing before the fixes,
plus the failed-nested-resize control. Two new required browser cases cover short
scroll durations and runtime cursor-style replacement on both engines. Existing
oracles, reviewed images and the compatibility questions above remain unchanged.

Round-2 validation passed: 1,109 Bun tests; required core 325 native / 278 legacy;
required browser 122 native / 92 legacy; 157 reference and six package checks;
formatting, lint, typecheck and the pinned build. The explicit gaps remain one
native core and one native browser case (50 / 31 on legacy), all exiting 1.
The bounded real-PTY Vim/tmux smoke also passed again after these corrections.
