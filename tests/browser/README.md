# Browser regression lane

Real-Chromium tests for what happy-dom cannot see: canvas pixels, device-pixel ratio, fonts and
trusted keyboard/mouse/focus events. They guard the Ghostty backend migration, so they assert the
**desired** behaviour. Current defects are never blessed and never waived: a case that does not pass
on an engine is a **gap** for that engine and runs only in the separate gap suite.

## Required and gap suites

`scope.json` is the frozen, reviewed plan (shared contract: `tests/regression/support/scope.ts`):
every case id is `required`, `gaps` or `unsupported` for each of `web-candidate` (libghostty-vt)
and `web-pinned` (legacy), with a reason for anything not required. Membership is a reviewed
edit, never a runtime reaction to a failure.

```bash
# Required suite (CI): every registered test must really pass; exit 1 on any failure.
PLAYWRIGHT_BROWSERS_PATH=<pinned browsers> GHOSTTY_REGRESSION_ENGINE=web-candidate \
  bunx playwright test                                   # = playwright.config.ts
# Gap suite (explicit, local/backlog only): runs the desired assertions of the engine's gaps;
# they fail today, so this exits 1. Refuses GHOSTTY_REQUIRED_CI=1.
PLAYWRIGHT_BROWSERS_PATH=<pinned browsers> GHOSTTY_REGRESSION_ENGINE=web-pinned \
  bunx playwright test -c playwright.gaps.config.ts
# Inventory: counts and ids per engine/suite (static, no browser).
bun tests/browser/inventory.ts [--json]
# Contract tests (no browser): catalogue, scope, --list registration, refusal paths.
bun test tests/browser/suite.test.ts
```

- **Registration, not filtering.** `rtest(id, body)` registers a case only when `scope.json` puts
  it in the running suite for the engine; other cases are not registered, skipped or counted. An id
  missing from `scope.json` fails while loading. Bodies run through the strict `runRegression`
  (no expected-failure signatures, no unexpected-pass inversion, no retries).
- **Controls.** `controlTest(id, body)` is for direct Playwright controls (font-readiness negative
  controls, scene comparator controls, the catalogue check). They must be required on both engines
  and are registered only by the required suite, so a gap run never counts them.
- **The config decides the suite.** `playwright.config.ts` always runs the required suite (it
  overwrites any ambient `GHOSTTY_BROWSER_SUITE`); `playwright.gaps.config.ts` runs the gap suite
  from `tests/gaps/browser/*.gap.ts`, one entry per spec that only imports it. Every test checks the
  config metadata it was loaded with. Both configs fail closed before running if the AST catalogue
  (`support/case-catalogue.ts`) and `scope.json` disagree, if gap entries stop mirroring the specs,
  or if a spec uses `test.skip/fail/fixme/only` or registers a direct `test('…')`.
- **History.** The former expected-failure manifests are archived for provenance only in
  `tests/gaps/browser/history/`; nothing at runtime reads them. `scope.json` was derived from them
  once (gap engines = their engines) and is now independent of them.

## Layout

| Path                           | Role                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness.html`, `harness.ts`   | Dedicated page served by Vite. Drives `Terminal.write` directly (no PTY, no demo). Fresh WASM instance per terminal. The only place that touches internals; reach-ins are feature-detected as `capabilities`. |
| `fonts/`                       | Vendored DejaVu Sans Mono regular and bold, its licence, `font.json` lock and provenance README. Readiness fails with `FONT_NOT_LOADED` on any mismatch.                                                      |
| `support/fixture.ts`           | Playwright fixture (page errors fail the test), scope-aware `rtest` / `controlTest` registration, image attachments.                                                                                          |
| `support/suite.ts`             | Suite/engine selection, `scope.json` loading, explicit dynamic ids (scene and comparator templates).                                                                                                          |
| `support/case-catalogue.ts`    | Static AST catalogue of every declaration; rejects runtime waivers and unscoped direct tests.                                                                                                                 |
| `support/playwright-config.ts` | Shared factory for `playwright.config.ts` (required) and `playwright.gaps.config.ts` (gaps).                                                                                                                  |
| `scope.json`                   | Reviewed required/gap/unsupported plan per case and engine.                                                                                                                                                   |
| `support/pixels.ts`            | Decoded-RGBA probes, per-cell comparator (no global % threshold), cursor-shape classifier, minimal PNG codec for artifacts.                                                                                   |
| `support/harness-api.ts`       | Types shared by page and Node.                                                                                                                                                                                |
| `*.pw.ts`                      | Specs (`.pw.ts` so `bun test` never collects them).                                                                                                                                                           |

## Pre-upgrade extensions

- `options.pw.ts`: multiple non-default themes; font family/size checked against independent canvas glyphs; runtime font changes; runtime theme and existing clipping issues are gaps.
- `scrollback.pw.ts`: real wheel and scrollbar drags through 600 color-marked lines, boundary clamping, smooth-scroll completion, stale/wrong-row controls and explicit scroll-on-output characterization.
- `selection-history.pw.ts`: real forward/reverse and edge-auto-scroll drags, clipboard text and complete highlight maps across history, soft wraps, wide/combining text, new output, pruning and reflow.
- `scenes.pw.ts`: eight whole-grid visual baselines and erase/shift controls, in a matching browser/OS image.
- The scroll-on-output native target is a gap explicitly marked **policy pending** (`scope.json`), not a silent change to the current default; the current jump-to-bottom behaviour is a required characterization.

CI runs the browser suite once, with no retries or responsiveness benchmarks. The optional Linux container command is `bun run test:regression:container`; use it when host rasterization differs.

## Rules

- **No sleeps.** Waits are animation frames (`settle()` = two identical consecutive canvas hashes),
  promises, or state predicates (`waitForFunction`). No `waitForTimeout`, no retries.
- **DPR via the browser context** (`test.use({ deviceScaleFactor })`), never as a renderer option.
- **Independent assertions first.** Spec colours/shapes/bytes, glyph oracles and metamorphic checks remain primary. Eight small, reviewed whole-scene baselines add broader appearance coverage; see [scenes/README.md](scenes/README.md). Missing images fail, and update tools write candidates only.
- **Comparator** compares decoded pixels per cell; encoded PNG size is irrelevant. Its self-tests
  (`comparator.pw.ts`) prove single-cell erase/recolour/underline and a 1-px translation are caught at
  the most lenient tolerance allowed.
- **Negative controls** prove the checks bite: missing/altered font fails readiness; an injected
  renderer mutant that drops one row redraw is caught by the metamorphic check.
- **No waivers.** Required means passing. Promoting a gap to required (after a fix) or demoting a
  required case is a reviewed `scope.json` change; a failing required case is a regression.
- `manifest.pw.ts` (`manifest.scope-catalogue-matches`) checks the AST catalogue against
  `scope.json`, that controls are required on both engines, and that gap entries mirror the specs.
- `GHOSTTY_REGRESSION_ENGINE=reference` is rejected: this lane drives ghostty-web, not the reference.
  `GHOSTTY_BROWSER_SEED` overrides the seeded edit script in `metamorphic.pw.ts`.

Out of scope (manual release gates): OS IME and dead keys on real layouts, screen readers,
clipboard permission prompts, hardware GPUs, Firefox/WebKit.
