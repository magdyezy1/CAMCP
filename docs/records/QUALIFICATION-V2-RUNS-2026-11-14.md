---
status: record
tier: engineering
---

# V2 qualification runs to date — 2026-11-14

A dated list of the gate and integration runs of the V2 work, newest first, with the revision each ran on and what it covered.
It adds no run of its own: every row is what that run's own record or integration report states, and the numbers are copied,
not recomputed. The status page reads its table of runs from the newest qualification record, and the focused checkpoints of
2026-11-05 had none (F-L10-09), so the gates of Round 1, the SDK foundation and the dependency patch appeared nowhere on it.

## Runs

| Run | Revision | Result |
| --- | --- | --- |
| Round 2 closing gate on the final tree (every test file with FFmpeg, the full browser matrix, container-layout parity, `eval:mcp`) | not run yet | The last full browser matrix and the last container-layout parity ran at `3b950b2d`; read their 1,392 cases and 8,688 tests as last run there, not as current (F-L10-03). F-L10-04 asks for the full-profile stages of Wave 4c round 7 to return to this gate. |
| sec-followup-2: differential review part 2b | `4d215294` | Every test file (1,162): 10,338 tests, 10,316 pass, 1 fails (the test that needs FFmpeg, absent from the host), 21 skipped. `npm run check:fast` passed. `mcp-eval --check` 64 runs, 0 regressions (profile v2: 1 improvement, the listing). Browser `granular-reporting`, `period-comparison` and `report-pdf-export` over `--https`: 34 of 34 passed, no WCAG violation, 0 provider writes. Pre-push scan clean. |
| linkedin-windows merged into the integration | `8a3131b3` | Every test file (1,159): 10,342 tests, only the two expected failures (the FFmpeg test; `en /reporting-overview` over its route budget before its re-record). `npm run check:fast` passed. `mcp-eval --check` 64 runs, 0 regressions. Browser kinds empty, components, granular-reporting, period-comparison, ad-previews and shell over `--https`: 434 of 434 passed. |
| The integration with closing-small, website-get, mcp-surface and sec-followup | `f7f43b54` | Every test file (1,156, run before its route-budget commit): 10,311 tests, 10,287 pass, 21 skipped, 3 fail (the FFmpeg test and two route-byte tests, green after the commit). `npm run check:fast` passed, also at this head. `mcp-eval --check` 64 runs, 0 regressions on both profiles. Browser, the same six kinds: 434 of 434 passed; `export-outcomes`, which makes synthetic writes, 4 of 4. |
| Round 2 checkpoint of Task 12 (X and Snapchat levels) | `cfdbf507` | A related selection, not a full gate: 8,451 of 8,451 tests in 939 files; a focused four-case synthetic browser run (`full_qualification: false`). |
| Dependency remediation gate (seven package versions) | `f32c79b1` | 8,689 main tests and 4 capture tests passed, no failure or skip, every check stage in 483 s. It does not extend the SDK browser and container runs to the patched dependencies. |
| SDK v2 foundation: container-layout parity | `3b950b2d` | 8,688 passed, one POSIX-shell skip, 0 failed of 8,689, with required FFmpeg and two workers. A layout check outside Git, not a Docker or Linux-image run. |
| SDK v2 foundation: browser qualification | `3b950b2d` | 1,392 of 1,392 cases passed in 57.83 minutes (120 scenarios, 70 kinds, 22 variants); no automated axe violation, no external request, no provider write. |
| SDK v2 foundation: full gate | `3b950b2d` | 8,685 main tests and 4 capture tests passed, no failure or skip, every check stage in 590 s. |
| Round 1 closing gate `wave5-r1-gate-2`, with the container-layout parity, the evaluation and the browser run `wave5-r1-browser-3` | `1a7d7722` | 8,679 of 8,679 main tests and 4 of 4 capture tests passed with FFmpeg required (515 s; the first run's one failure was fixed in `d0566cd7`). Container-layout parity 8,682 passed, one skip, 8,683 with capture. `eval:mcp` 60 runs, 0 regressions. Browser 1,392 of 1,392 in 52.09 minutes. |
| Live checks of every ticket (reads and writes on provider accounts, the deployed site) | none | Blocked: no staging (D20). Provider use is not permitted during development. No row above claims a live read, a live write or a deployment. |

## What the rows rest on

The first three rows after the closing gate are the integration of the V2 remediation packages, each run by an integration agent
on its own worktree, with every test file in batches of 60 at four at a time, and the integration report of each head records the
numbers. The earlier rows are the records of the qualification and implementation work of Round 1 and Round 2 (links below). A
related selection runs the tests that import a changed file; only the rows that say "every test file" ran the whole suite.

- [Round 1 qualification](QUALIFICATION-V2-R1-2026-11-03.md)
- [SDK v2 foundation](QUALIFICATION-V2-R2-SDK-2026-11-04.md)
- [Dependency remediation](QUALIFICATION-V2-R2-DEPENDENCIES-2026-11-04.md)
- [Round 2 report editor checkpoint](QUALIFICATION-V2-R2-WEBSITE-REPORTING-2026-11-05.md) and its siblings of that day
