# Historical core known-failure manifest (evidence only)

`core-known-failures-2026-10-10.json` is the frozen manifest that the core lane
used before the strict baseline split. It is kept byte-for-byte (sha256
`7f5425a8a755e8799db669b7c12f4cced73adbca292b4e0abde66300a73a87e0`) as
evidence of each gap's finding, reason and the failure signature observed
on 2026-10-10. Those signatures came from legacy `0789394…` and candidate
`8b218c0…`.

Nothing executes or reads this file. Expected failures are no longer
accepted anywhere:

- Membership now lives in `tests/regression/core/scope.json`, which lists
  required, gap and unsupported cases explicitly for each engine.
- The required lane (`bun test`) runs only the plan's required cases.
- The explicit gap lane (`bun test ./tests/gaps/core/core.gap.ts`) runs the
  original assertions and fails while a bug reproduces.

The 54 `web-pinned` entries became legacy gaps. The 33 `web-candidate`
entries, identical JS-layer failures on both engines, became native gaps.
The other 19 legacy entries were fixed by the native core, so they are
required on `web-candidate`.

`scrollback.limit-is-lines` is now a legacy-ABI case, so it is unsupported
on native. Native retention is covered by the required
`scrollback.native-retention-matches-upstream` case.
