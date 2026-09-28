# Progress log

Newest last. Each batch lists what changed, the red/green evidence, the related suites, and the full qualification
in a fresh sanitized release candidate (`node tools/prepare-public-release.mjs .release/<name>`, `npm ci`,
`npm run check` with FFmpeg, then `node deploy/check-railway.mjs`).

Environment for all runs: Linux container, 4 CPUs, Node.js 24.21.0, TypeScript 7.0.2, FFmpeg N-126905 (static
build), Python 3 for WSDL regeneration. The owner's reference machine is Windows; timings differ.

## Baseline — `03ac8d3`, 2026-09-28

- Build: 5.1 s (`tsc -p tsconfig.json`).
- `npm run check` in `.release/baseline-20260928`: **2,654 / 2,654** tests and **4 / 4** capture tests pass;
  generate, vendor, WSDL and feed checks, report, web check, provider drift/lifecycle (offline), contracts and
  action-ledger checks all pass; `deploy/check-railway.mjs` passes. Wall time 1,431 s, measured while five
  read-only analysis agents ran on the same 4 CPUs, so it overstates the quiet-machine time.
- No flaky failures on Linux. One test (`google-preview-writes`) left its temporary directory behind.
- Cold start to a constructed runtime 1.08–1.14 s; RSS 197 MB, heap 68 MB.
- Parallel experiment (not the qualification): the same suite at `--test-concurrency=8` finished in 357 s; the only
  failures came from an in-progress change, not from shared state.

## Batch 1 — P0 money safety, confirmation model and sign-in hardening

Findings: F-01, F-02, F-03, F-05, F-06, F-07, F-08, F-09, F-10, F-11, F-17, F-34, F-66.

| Change | Red on baseline build | Green |
|---|---|---|
| Structural spend confirmation and numeric statuses (`src/spend-effects.ts`, `src/preflight.ts`, `src/google-contracts.ts`, `src/spend-policy.ts`) | `tests/spend-structural-confirmation.test.mjs`: 13 of 14 fail (the neutral-edit control passes) | 14 / 14 |
| Reddit `goal_value` under the owner policy (`src/reddit-writes.ts`, `src/spend-policy.ts`) | `tests/reddit-spend-policy.test.mjs`: 2 / 2 fail | 2 / 2 |
| `execute_requirements`, no pre-filled spend flag, `native_request` refused in writes (`src/write-review.ts`, `src/campaign-runner.ts`) | `tests/confirmation-model.test.mjs` fails to load (`executeRequirements` missing) | 3 / 3 |
| Sign-in limits, two-step limit, sign-in time on switch, client pruning, headers (`server/*`) | `tests/auth-hardening.test.mjs`: 6 / 6 fail | 6 / 6 |
| Temp-directory cleanup (`tests/*`) | — (Windows-only symptom; not reproducible on Linux) | 147 / 147 in the ten touched files |

Adjusted existing test: `tests/snapchat-workflow-fixes.test.mjs` replayed `next_call` verbatim; it now applies
`next_call.add_after_user_approval` (the synthetic user approving), which is the intended client flow.

Generated artifacts: action ledger and `docs/CONTRACTS.md` unchanged (`--check` passes); guidance coverage counts 215
modules (was 214, `spend-effects.ts` added) and the same 352 refusal codes.

Full qualification (`.release/batch1-20260928`): **2,679 / 2,679** tests and **4 / 4** capture tests; every
generated check passes; Railway check passes. 1,478 s (serial suite). Committed as `5cd7a6f`, `de3841d`, `fe364fe`,
`87881c1`.

## Batch 2 — MCP workflow predictability, transport and secret hardening, faster tests

Findings: F-19, F-20, F-26, F-27, F-28 (part), F-33, F-53 (part), F-65, F-68 (part).

| Change | Red on baseline build | Green |
|---|---|---|
| Plan steps get `account_id` only where the schema accepts it (`Registry.acceptsArgument`, runner, plan preflight) | `tests/mcp-workflow.test.mjs`: 3 / 3 fail | 3 / 3 |
| `REVIEW_EXPIRED` carries `details.next_call`; an expired plan step returns to `pending`; `idempotency_key` defaults to the review id | (same file) | |
| Confirmation remedies say "the review is still valid; execute again with the flag" (`src/errors.ts`) | `tests/security-hardening.test.mjs`: 4 / 4 fail | 4 / 4 |
| AES-GCM opens only 16-byte tags and 12-byte IVs (`src/security.ts`) | (same file) | |
| Transport refuses dot segments, also percent-encoded (`src/transport.ts`) | (same file) | |
| One LinkedIn version source (`workspace.ts`, `report-native.ts`, `owner-operations.ts`, `server/asset-discovery.ts`) | (same file) | |
| `npm test` runs files in parallel (default concurrency); `npm run test:serial` keeps the old mode; `npm run test:related` runs the tests that import changed modules | — | 2,599 passed, 1 skipped, 0 failed via `test:related` at default concurrency (513 s on 4 CPUs) |

Not changed, recorded: Snapchat `lifetime_budget_micro` stays refused under numeric policies (F-55) because no pinned
or captured vendor document names the field; the refusal is fail-closed.

Full qualification (`.release/batch2-20260928`): **2,686 / 2,686** tests and **4 / 4** capture tests; every
generated check passes; Railway check passes. **531 s** with the parallel suite (batch 1: 1,478 s serial). Committed
as `808824f`, `a5977a1`, `4c9cb97`.

## Batch 3 — website accessibility, confirmations, reporting view, asset caching

Findings: F-35, F-36, F-37, F-38 (part), F-39 (part), F-43 (part), F-44, F-45 (part), F-46, F-48, plus the owner's
request to improve reporting on the website.

| Change | Red on baseline | Green |
|---|---|---|
| `tools/check-web.mjs` now checks CSP compliance, shipped assets, stylesheet order, the live region, the confirmation dialog and native `confirm()` | 6 violations on the `03ac8d3` web files | passes |
| `/assets` revalidate with the ETag (`no-cache`) instead of `no-store` (`server/website.ts`) | `tests/website-assets.test.mjs` fails | passes |
| Accessibility layer, page-level errors, confirmations, dialog names, `aria-current`, reporting formulas and table region (`web/*`) | audit: 271 low-contrast texts, 3 overflowing pages, 47 whole-page live regions | 60, 0, 0 ([ACCESSIBILITY.md](ACCESSIBILITY.md)) |

Not changed, recorded: 60 low-contrast labels remain, mostly inside the landing-page illustration and a few
workspace captions; F-40 (one token set) covers them. Focus restoration after partial re-renders (F-39) is still open.

Full qualification (`.release/batch3-20260928`): **2,687 / 2,687** tests and **4 / 4** capture tests; every
generated check passes; `check:web` passes on 12 scripts and 2 pages; Railway check passes. 537 s.

## Batch 4 — family registry (pass 1), metric sources, write pause, Drive inspection, platform report

Findings: F-21, F-24, F-71, and F-59, F-60, F-63 in part, plus the owner's requests for per-platform reporting and
a platform-by-platform review ([PLATFORMS.md](PLATFORMS.md)).

| Change | Evidence |
|---|---|
| `ReviewedFamily` (`src/reviewed-family.ts`) declared by 41 family modules and listed in `src/reviewed-families.ts`; the ten lifecycle modules consult the registry once per stage and lose 734 lines of wiring (45 added, including pointer comments); reader chains 83 → 42 and 80 → 39 levels | the unchanged 2,687 tests pass on the migrated build; action ledger and `CONTRACTS.md` unchanged (`--check`); differential replay below |
| `familyOf` / `familyOfRead` refuse a request or read two registered families claim (`REVIEWED_FAMILY_CONFLICT`, before anything is sent) | `tests/reviewed-families.test.mjs` (5 tests): completeness, no ledger route claimed twice among registered and still-wired families, the conflict refusal, reader pass-through, no lifecycle module naming a registered family |
| Drive inspection hashes while streaming and keeps 64 bytes; one inspection per workspace, four per process (`src/media-routing.ts`, F-21) | `tests/drive-inspection.test.mjs`: the concurrency test fails on `2360a9c`; the digest-equivalence test passes before and after |
| Owner `pause_writes` / `resume_writes` (`src/owner-operations.ts`), refused at every execute and media upload with `WRITES_PAUSED`, shown in the dashboard, readiness check and owner page; plan steps stay `review_ready` (F-24) | `tests/write-pause.test.mjs`: 3 of 4 fail on `2360a9c` (the cross-workspace control passes on both) |
| `metricSources` (`src/report-metrics.ts`): the native field or rule behind every shared metric on every report platform, shown in the reporting view and the evidence download | `tests/report-metric-sources.test.mjs` (5 tests) derives each value from the declared field through `normalizeNativeRow`; `tests/report-library-ui.test.mjs` renders the panel; both fail to load on `2360a9c` |

Registry cost: `reviewedWriteFamily` over the 3,071 ledger routes takes 8.4 µs per call instead of 6.2 µs, because
every registered `kind` is evaluated to detect conflicts.

Equivalence: the move keeps each chain's remaining lines in order and consults the registry at the position of the
first line it replaced, so a registered family only moves past other families' own predicates (all disjoint over
the ledger routes). To test the claim beyond the assertions of the suite, the pre-refactor build (`2360a9c`) was
instrumented to record the inputs and outputs of nine lifecycle functions (`reviewedWriteFamily`,
`assertWriteShape`, `snapshotPlans`, `validateState`, `normalizeSnapshot`, `writeImpact`, `writeOutcome`,
`applyExecutionRisk`, `authorizeExecution`) while it ran the whole suite; every distinct call was then replayed
against the new build.

Result: **40,624 distinct calls, 0 differences** — the same return values and the same refusals (code, message and
status), including 1,867 `assertWriteShape`, 1,021 `authorizeExecution`, 97 `validateState` and 49 `writeImpact`
refusals. Distinct calls per function: `applyExecutionRisk` 8,834, `authorizeExecution` 5,432, `assertWriteShape`
4,985, `reviewedWriteFamily` 4,665, `normalizeSnapshot` 4,487, `validateState` 4,347, `writeOutcome` 3,202,
`writeImpact` 2,559, `snapshotPlans` 2,113. A sensitivity run with one family's route name and one family's
assertion deliberately altered reported all 31 affected calls. Verification reads, `ScopeGuard` and the reader
composition are not exported pure functions; for them the evidence is the unchanged suite. (Two stdio tests fail
only in the instrumented run, because their child process starts without the recorder.)

Full qualification (`.release/batch4-20260928`, commits up to `42bd81e`): **2,704 / 2,704** tests and **4 / 4**
capture tests; every generated check passes; `check:web` passes; guidance covers 356 refusals across 219 modules;
Railway check passes. 495 s.

## Batch 5 — ownership hints, checked report, sealed vendor documents, contract text, unused code

Findings: F-54, F-69, F-72, part of F-70 and F-28 (the ownership stumper in
[MCP-SECURITY-CALIBRATION.md](MCP-SECURITY-CALIBRATION.md)), and the lint half of F-62.

| Change | Red on `2360a9c` | Green |
|---|---|---|
| `RESOURCE_SCOPE_REQUIRED` lists the collection reads that establish ownership (`details.ownership_reads`, and `next_call` when one fits) | `tests/ownership-reads.test.mjs`: 3 / 3 fail | 3 / 3, each hint followed end to end |
| `npm run check` runs `report --check`; the stale `.mirror/PARITY.md` and `implementation-status.json` are regenerated | `report --check` names both files | passes; two runs are byte-identical |
| Every pinned vendor document sealed with `document_sha256`; the vendor tools require the seal | `tests/vendor-integrity.test.mjs` fails without the seals | passes; vendor routes unchanged, the ledger records the new file digests |
| `CONTRACTS.md` states Reddit's lead-form withdrawal instead of offering it | — (text) | regenerated; every generated check passes |
| 32 unused declarations removed (4 dead helpers, none a missing check); `noUnusedLocals` on | `tsc --noUnusedLocals`: 32 errors | 0 |

Full qualification (`.release/batch5-20260928`, up to `9bd24e4`): **2,708 / 2,708** tests and **4 / 4** capture
tests. The first run stopped at `report --check`, because a public release does not ship the status report files;
`9bd24e4` compares only files present, and the remaining checks (`report --check`, `check:web`, provider drift and
lifecycle, contracts, action ledger) then passed in the same candidate with the fixed tool. Railway check passes.
479 s. The candidate's files equal `9bd24e4` for all 125 files changed since `2360a9c`.

## Batch 6 — registry pass 2, website focus, MFA setup and team removal

Findings: F-39, F-42, part of F-41, and F-59, F-60, F-63 in part.

| Change | Evidence |
|---|---|
| 16 more families registered (57 in all); the lifecycle modules lose another 310 lines (16 added); reader chains 42 → 26 and 39 → 23 levels. Verification hooks receive `before`, scope hooks the plan; a spend message may depend on the request; new `snapshotState` (DV360 Demand Gen ad groups) and `verifiedResources` (Criteo preferred line items) hooks; the DV360 display-video write scope is the `assertDV360WriteScope` hook of the six registered DV360 families | the 2,708 existing tests; the ledger and `CONTRACTS.md` unchanged; the 40,624 recorded calls of the pre-refactor build replay with **0 differences**; `tests/reviewed-families.test.mjs` now allows no lifecycle module to name a registered family |
| Keyboard focus returns to the control after an action, or to its section, or to the page heading (`authBind`, F-39) | Chromium probe on the settings page |
| MFA setup steps, open-in-authenticator link, grouped copyable key, copy and download of recovery codes (F-41) | `check:web`; 57 tests loading web scripts |
| Member removal is a confirmed button of its own; success messages are notices (F-42) | same |

Kept wired on purpose, with the reason in `docs/ADDING-A-REVIEWED-FAMILY.md`: TikTok negative keywords, whose
snapshots the generic TikTok branches normalize — registering it would change its state hash.
