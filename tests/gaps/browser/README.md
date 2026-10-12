# Browser gap suite

Reproducers for current defects and future parity targets, kept out of the required suite.

- `*.gap.ts`: one entry per browser spec (`tests/browser/<name>.pw.ts`) that only imports it.
  Loaded through `playwright.gaps.config.ts`, the spec registers exactly the cases that
  `tests/browser/scope.json` lists as gaps for `GHOSTTY_REGRESSION_ENGINE`, with their original
  desired assertions. Failures fail the run (non-zero exit); there is no expected-failure
  matching and no pass inversion. Direct controls are never registered here.
- The gap config refuses `GHOSTTY_REQUIRED_CI=1`; required CI runs `playwright.config.ts` only.
- `history/`: the former expected-failure manifests, archived for provenance (findings, reasons,
  recorded signatures). Nothing reads them at runtime.

```bash
GHOSTTY_REGRESSION_ENGINE=web-candidate bunx playwright test -c playwright.gaps.config.ts
```

A gap that starts passing is promoted by a reviewed `scope.json` edit, never automatically.
