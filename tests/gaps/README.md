# Gap suite — not the required regression baseline

This directory preserves existing bug reproducers and future/parity requirements.
They are **not counted as passing regression coverage**. The required baseline
runs only its explicitly listed, supported cases; every assertion it executes
must pass.

A gap run uses the same strict assertion runner as required tests. A reproduced
bug is a **failure with a nonzero exit status**, not an expected-failure success.
If a gap starts passing, it is an improvement to review and promote, not a reason
to invert the result into a failure. These runs are opt-in and are not required CI
jobs.

## Scope and evidence

- Each lane has a checked-in per-engine scope plan with positive `required` and
  `gaps` lists, and explicit `unsupported` ABI scope. The plan does not contain
  failure signatures or exemptions.
- A case fixed by the native engine stays required there even if it is still a
  gap on the legacy engine. Unsupported ABI cases are not passing tests.
- The previous known-failure JSON records are retained under the lane's history
  directory as evidence/backlog context only. Required execution does not read
  them to determine whether a failing assertion is acceptable.
- Case IDs and desired assertions are preserved. Unknown, duplicate or missing
  cases are errors, not automatic exclusions.

This separation does **not** claim the remaining bugs have been fixed. It makes
CI's meaning precise: a required run is green only when every executed assertion
passes, with no xfail/skip/signature-matching escape hatch.

## Promoting an improvement

1. Reproduce the gap with its original desired assertion.
2. Fix the implementation and verify the gap genuinely passes.
3. Move the affected engine's case membership from `gaps` to `required` in the
   same reviewed change; keep the case ID and its oracle.
4. Run the required core/browser suites and scope checks on both engines.
5. Update the backlog explanation/history as appropriate.

Never move a newly failing required test into the gap suite just to restore green
CI. A supported behavior change needs its own explicit review; a regression needs
a fix. Do not regenerate visual baselines or weaken assertions to match a bug.

See [the test guide](../README.md) for current commands and measured counts.
