---
status: record
tier: engineering
---

# Implementation verification

The authorized destination is `magdyezy1/AMCP`, branch `Codex-branch`, based on `067871481d79fc59a6cb976d8a13b62d409e283a`. Work was isolated from the existing development checkout and older release checkout. No live advertising requests or production changes were used. See PROGRESS.md for every audit ticket and OPERATIONS.md for migration and qualification boundaries.

## Local release evidence — 2026-09-12

Environment: Windows/PowerShell, Node 24.19.0, npm 11.17.0, TypeScript 7.0.2. Each candidate used an independent lockfile installation. Tests ran with a sanitized environment and a global fetch guard refusing non-loopback egress; provider fixtures used explicitly injected synthetic transports. Docker and FFmpeg were not installed locally.

| Check | Exact command, inside the fresh candidate unless stated | Result |
|---|---|---|
| Assembly | `node tools/prepare-public-release.mjs .release/verified-candidate` in source checkout | 366 files; source tree hash `67db778e5cec82e513fcc0f88b0073ebaba434303d85c08d7d08e00be63ea055` |
| Independent install | `npm ci --ignore-scripts --no-audit --no-fund` | 107 packages, success |
| Whole artifact | `npm run check` | 487 tests: 486 passed, 0 failed, 1 FFmpeg skip; 4 additional capture tests passed; generation, vendor generation, guidance/report and all 10 browser scripts passed |
| Deployment configuration | `node deploy/check-railway.mjs` | Passed |
| Public capture integrity | `npm run providers:check` | All 14 locally captured public schemas validated; no live schema download |
| Recovery delta | `node --test --test-concurrency=1 tests/campaign-reconciliation.test.mjs tests/google-upload-restart.test.mjs` | 5 passed, subsequently included in whole-artifact result |
| Whitespace | `git diff --check` | Passed |

After this artifact test, the final delta adds only this evidence documentation and CI evidence packaging: public-capture integrity is appended to the check script, and CI retains the test/smoke logs and built image ID. The branch CI assembles and tests the exact committed tree with FFmpeg required and both Docker smoke modes. Its commit-bound manifest and results supersede the local candidate hash; do not mistake a source hash for a production deployment.

CI explicitly selects `shell: bash`, enabling pipeline failure propagation while test and smoke output are captured with `tee`. An unspecified Linux shell does not enable the same pipeline behavior. This was corrected during the final gate review; see [GitHub's shell contract](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#defaultsrun), checked 2026-09-12. Final verification relies on the actual test totals and smoke output as well as the job conclusion.

## Initial failures retained

The first 468-test run had 445 passes, 22 failures and one FFmpeg skip. The failures exposed test fixtures that treated an invented `target_labels` array as unordered configuration. Positive reorder fixtures now vary only telemetry/known sets; meaningful and unknown ordered configurations retain conflict tests. A later 482-test run had 479 passes, two failures and one skip because two isolated browser VM harnesses omitted the new report-quality script. The harnesses now load the same scripts as the website; assertions were not weakened. An initial report-generation failure for the new job-authority refusal was corrected by documenting its recovery contract. Original logs remain in the isolated local `.implementation` evidence directory; they are excluded from the product artifact.

An early browser fixture provided the wrong summary shape and inconsistent job/report state. Correcting that synthetic fixture enabled the intended report view; those fixture errors are not product findings.

## Exercised workflows and boundaries

Local browser: public Privacy direct/footer/back/forward; owner sign-in; all three guided recipes saved paused plans without JSON; invalid budget input retained with a useful correction; report row and escaped provider text; CSV and source-evidence navigation; pasted Sheets destination and independent schedule form; partial-delivery policy; mobile and desktop page widths; Escape/focus restoration; unfinished upload recovery with no retry for an uncertain image and focus moved to the diagnostic view. No browser JavaScript errors remained. Real provider account setup and delivery were not exercised.

Synthetic HTTP/backend: pending social approval for Google/Apple/Facebook; MCP authorization/refresh, workspace and account revocation; reviewed request/state/idempotency controls; all seven media adapters; private Drive; Meta media → creative → paused-ad verification; Google/Microsoft recipe contracts; Apple/GA4 reporting, formulas and CSV/typed-Sheets reconciliation; independent scheduling and delivery ownership; unknown-response recovery; two-worker fencing/fairness; clock changes; encrypted backup restoration.

The maximum 128 MiB media fixture streamed to encrypted chunks and reconstructed its immutable bytes. In the latest candidate it added approximately 219 MiB RSS under a conservative 768 MiB shared reservation. This is a synthetic single-host observation, not a guarantee for live upload encoding, FFmpeg or arbitrary concurrent workloads.

Live provider acceptance, permissions/approvals, account-specific quotas and routing, deployed proxy/volume behavior, production backup objectives and privacy operating commitments require the external evidence or owner decisions identified in OPERATIONS.md. Catalog counts and synthetic tests do not establish live readiness.

A final computed-style browser check found muted helper text at 4.40:1 on the page background. The shared muted token was darkened from #747184 to #6c697b; the browser now reports 4.95:1 on that background. This small CSS correction is included in the final branch CI; it is not a claim of a complete accessibility certification.

## Test-account connection follow-up, 2026-09-12

Base: `6fcb5bcd4b0c557e16e38ead27f4d43643f0040d`, in the independent `implementation-Codex-branch` checkout on `Codex-branch`. Node 24.19.0, npm 11.17.0, Windows; in-memory test databases, synthetic provider credentials and injected provider responses. The local runner removes application environment variables and blocks unmocked non-loopback fetches. See [test-account scope](../TEST-ACCOUNTS.md) for the changed behavior and preserved boundaries.

| Command | Result |
|---|---|
| `npm run build` | Passed |
| `node --test --test-concurrency=1 dist/tests/test-account-connections.test.js dist/tests/test-account-scope.test.js dist/tests/user-accounts.test.js dist/tests/website.test.js dist/tests/google-reauthorization.test.js` | 51 passed, no failures or skips |
| `npm run check` | 497 tests: 496 passed, no failures, one local FFmpeg skip; all 4 capture tests, generated catalogs/vendor metadata, guidance/report, 10 browser script syntax checks and 14 public-capture integrity checks passed |
| `node deploy/check-railway.mjs` | Passed; configuration inspection only |
| `git diff --check` | Passed |

Exact invocations and original output are retained in the ignored local `.implementation/checks.jsonl` and `*-test-connections-*.log` files. Initial failures remain visible: the first build rejected a new fixture's inferred optional header values; the first focused run passed 50 of 51 tests because a saved-report expectation omitted the store-added ID and revision. The header fixture now has an explicit string-value type, and the report preservation test compares the complete persisted document before and after reauthorization, including its revision. No production assertion or safeguard was weakened.

New HTTP journeys verify shared and named test accounts, complete Meta authorization and account selection, additional logins, sync, default switching, disconnect, all 14 browser OAuth initiation paths, Google reauthorization, partial-discovery recovery and rejected state replay/cross-session/cross-workspace/CSRF/role/revocation cases. The invited-user suite also verifies connection initiation after email setup and password login. No new live provider flow or browser consent was performed. The branch CI tests its exact assembled committed tree with FFmpeg required and both Docker smoke modes; its run and artifacts provide the commit-bound container evidence.
