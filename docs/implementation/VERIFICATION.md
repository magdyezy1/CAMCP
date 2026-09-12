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

## Initial failures retained

The first 468-test run had 445 passes, 22 failures and one FFmpeg skip. The failures exposed test fixtures that treated an invented `target_labels` array as unordered configuration. Positive reorder fixtures now vary only telemetry/known sets; meaningful and unknown ordered configurations retain conflict tests. A later 482-test run had 479 passes, two failures and one skip because two isolated browser VM harnesses omitted the new report-quality script. The harnesses now load the same scripts as the website; assertions were not weakened. An initial report-generation failure for the new job-authority refusal was corrected by documenting its recovery contract. Original logs remain in the isolated local `.implementation` evidence directory; they are excluded from the product artifact.

An early browser fixture provided the wrong summary shape and inconsistent job/report state. Correcting that synthetic fixture enabled the intended report view; those fixture errors are not product findings.

## Exercised workflows and boundaries

Local browser: public Privacy direct/footer/back/forward; owner sign-in; all three guided recipes saved paused plans without JSON; invalid budget input retained with a useful correction; report row and escaped provider text; CSV and source-evidence navigation; pasted Sheets destination and independent schedule form; partial-delivery policy; mobile and desktop page widths; Escape/focus restoration; unfinished upload recovery with no retry for an uncertain image and focus moved to the diagnostic view. No browser JavaScript errors remained. Real provider account setup and delivery were not exercised.

Synthetic HTTP/backend: pending social approval for Google/Apple/Facebook; MCP authorization/refresh, workspace and account revocation; reviewed request/state/idempotency controls; all seven media adapters; private Drive; Meta media → creative → paused-ad verification; Google/Microsoft recipe contracts; Apple/GA4 reporting, formulas and CSV/typed-Sheets reconciliation; independent scheduling and delivery ownership; unknown-response recovery; two-worker fencing/fairness; clock changes; encrypted backup restoration.

The maximum 128 MiB media fixture streamed to encrypted chunks and reconstructed its immutable bytes. In the latest candidate it added approximately 219 MiB RSS under a conservative 768 MiB shared reservation. This is a synthetic single-host observation, not a guarantee for live upload encoding, FFmpeg or arbitrary concurrent workloads.

Live provider acceptance, permissions/approvals, account-specific quotas and routing, deployed proxy/volume behavior, production backup objectives and privacy operating commitments require the external evidence or owner decisions identified in OPERATIONS.md. Catalog counts and synthetic tests do not establish live readiness.
