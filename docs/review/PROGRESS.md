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
| Registration and password reset no longer wait on the email provider, so response time does not show whether an address has an account (F-13) | new test in `tests/user-accounts.test.ts` fails before (the response waits for a held delivery) and passes after; the outbox test waits for the started attempt instead of assuming it finished |
| Each single-use challenge kind has its own 10,000 cap, so anonymous social starts cannot block resets, invitations or two-step sign-in (F-12) | red/green test filling the `social` kind |
| A reviewer lists and ends only their own session (F-14) | red/green test with two reviewer sign-ins |
| `MIRROR_FLAGS={"compactSchemas":true}` lists each DV360 action once: the tool schema drops from 17.5 KB to 10.6 KB and the registry listing from 58.7 KB to 51.9 KB; the legacy names stay accepted (F-29, part) | `tests/compact-schemas.test.mjs`: canonical names only, every other tool unchanged, an alias still previews end to end; without the flag the captured schema is listed as captured (`tests/catalog.test.ts`) |
| A replayed authorization code revokes the tokens its first exchange issued, even without the verifier; token issuance prunes expired access grants with their keys and rotated refresh grants, keeping each client's newest refresh grant (F-25, part) | two red/green tests in `tests/claude-oauth.test.ts`; the Claude flow test no longer replays its code mid-flow, since that now ends the access it goes on to use |

Kept wired on purpose, with the reason in `docs/ADDING-A-REVIEWED-FAMILY.md`: TikTok negative keywords, whose
snapshots the generic TikTok branches normalize — registering it would change its state hash.

Full qualification (`.release/batch6-20260928`, up to `b3f8d84`): **2,714 / 2,714** tests and **4 / 4** capture
tests; every generated-artifact check and the Railway check pass. 504 s. The candidate's 1,144 source files equal
`b3f8d84`, apart from the `release-manifest.json` the release tool writes.

## Batch 7 — audit minimisation, provider-text paths and remedies

Findings: F-18 in part, F-22, F-28.

| Change | Evidence |
|---|---|
| A completed read is audited by its status, pages, headers, and the size, SHA-256 and row counts of what the provider returned, never the content: report rows, lead details and ad copy stay in the response (F-18) | `tests/audit-read-minimization.test.mjs` fails before (the lead's address is in the trail) and passes after; the chain still verifies. Rows already written are left alone, because the audit is hash-chained |
| `meta.untrusted_paths` names where provider text can appear: `data` of a successful response, `error.details.upstream`, `error.details.response` (validate-only), or the schema `errors` of a provider response. Validate-only rejections were not labelled at all before. The guide tells an agent that the message, remedy and `next_action` are AMCP's own (F-22) | three tests in `tests/untrusted-content.test.ts` fail before and pass after |
| Refusals of state reads, owner policy, arguments, existing objects, connections, write scope, paused and disabled writes and malformed provider responses name their own next step; none of them says "prepare again" unless that is the step. The generic remedy covers 379 of 1,956 refusal sites, down from 1,436 (F-28) | new test in `tests/error-remedy.test.ts` fails before and passes after; 68 tests across remedy, envelope, workflow, pause, write-review, confirmation and recovery suites pass |

## Batch 8 — formatting (F-62)

| Change | Evidence |
|---|---|
| Prettier 3.9.9 (exact dev dependency) at 120 columns, `.editorconfig` with LF, `npm run format` / `format:check`; the check is the first step of `npm run check`, so CI and the image build enforce it | `package-lock.json` adds only Prettier; `npm prune --omit=dev` keeps it out of the image |
| Three readers of source text accept any whitespace, so formatting cannot quietly weaken them: guidance coverage (error codes, imports), the family-disjointness test, the X metric-mapping test | guidance coverage returns the identical result on the original and the formatted tree: 220 modules, 356 codes, 0 undeclared |
| Nine format-only commits: server/tools/codegen/deploy (61 files), src a–f (52), g–l (69), m–z (144), tests a–l (133), m–z (161), and a second pass for 22 files where one pass does not reach a fixed point | every changed file parses to the same syntax tree before and after (typescript-estree for TypeScript, Babel for `.mjs`; positions, comments, quote style and parentheses ignored): 642 of 642 identical. A `dist/` text comparison is not a proof, since Prettier keeps some input line breaks |
| `src/` is 99,632 lines (32,598 before); lines over 300 characters 1,640 → 61, all long string literals Prettier does not split. `web/` is not formatted yet, because its tests extract functions by text | line counts from `git ls-files` |

Line numbers in the findings table refer to the tree before batch 8.

Full qualification of batches 7 and 8 (`.release/batch8-20260928`, up to `290d30f`): **2,717 / 2,717** tests and
**4 / 4** capture tests; `format:check`, every generated-artifact check and the Railway check pass. 548 s. The
candidate's 1,148 source files equal `290d30f`, apart from the `release-manifest.json` the release tool writes.

## Batch 9 — tool guidance, report tables, compression, hardening summary

Findings: F-30 in part, F-31, F-38 and F-43 in part (report table), F-45.

| Change | Evidence |
|---|---|
| Each AMCP extension tool opens with a "Use this …" sentence naming the neighbouring tool; `amcp_write` stops asking for the optional `idempotency_key` and names `execute_requirements` (F-30, F-31) | `tests/tool-descriptions.test.mjs` fails before and passes after |
| Report rows: `scope="col"` column headers and the campaign cell as row header, the report time zone beside the currency, period and summary dates in the viewer's locale, secondary text from 3.15:1 and 3.84:1 at 10 px to 5.32:1 at 12 px | new test in `tests/report-library-ui.test.mjs` fails before and passes after; `check:web` |
| Text assets served with Brotli or gzip (308 KB → 82 KB with Brotli), per-encoding ETags, `Vary: Accept-Encoding`, 304 revalidation, no new dependency (F-45) | new test in `tests/website-assets.test.mjs` fails before and passes after; traversal and dotfile paths are not served |
| `docs/HARDENING-REVIEW.md` summarises this review and links its records | — |

Full qualification (`.release/batch9-20260928`, up to `0eddae1`): **2,720 / 2,720** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 511 s. The candidate's 1,150
source files equal `0eddae1`, apart from `release-manifest.json`. Pushed as `0eddae1`.

## Batch 10 — owner summary

| Change | Evidence |
|---|---|
| `ExecutionPolicy.maxBudgetChange` is optional and documented as unenforced, naming the owner spending policy as the control (F-23) | type-only; the 215 call sites compile unchanged |
| [SUMMARY.md](SUMMARY.md): what changed, measurements, the decisions that are the owner's, what is still open | — |


Full qualification (`.release/batch10-20260928`, up to `3340f25`): **2,720 / 2,720** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 514 s. The candidate's source
files equal `3340f25`, apart from `release-manifest.json`.

## Batch 11 — the owner's decisions of 2026-09-28

| Change | Evidence |
|---|---|
| The generic spend confirmation reads field names, field paths carried as values (JSON Patch, masks, `$delete`) and Google resource types, never content | the 5,432 recorded `authorizeExecution` calls replay with 0 differences; all 170 recorded generic refusals still match; `tests/spend-field-names.test.mjs` red/green |
| Caps ask instead of refusing: `enforcement: confirm` (default) or `block`; `spend_policy.exceeded`, `exceeded_summary`, `execute_requirements.cap_override_confirmed`, `CAP_CONFIRMATION_REQUIRED` without it, an audit record with it; `max_bid_native`; caps in account currency via `src/budget-units.ts` where the unit is documented; per-platform workspace caps (`per_gateway`) with a warning for a single native default; the owner form offers all of it | `tests/spend-caps-confirm.test.mjs` (5) red/green; 21 policy suites now state `enforcement: 'block'` where they test refusals; the owner form exercised in Chromium |
| A website session ends after 2 hours without a request; security notices for password, email, two-step, recovery-code and sign-in-method changes | two tests in `tests/user-accounts.test.ts`, red on the previous code with only the exported constant added |
| `admin backup` writes the encrypted archive; disconnect deletes the report data read through the login (finished snapshots, captured reports, parsed downloads) and keeps definitions, reviews, receipts and the audit | `tests/operations.test.ts`; a red/green test in `tests/connection-disconnect.test.ts` |
| Accounts created through invitations stay pending unless the instance owner invited them | red/green test in `tests/account-security.test.ts` |
| QR code in two-step setup from the vendored `qrcode-generator` 2.0.4 (integrity recorded) | `tests/mfa-qr.test.mjs`; the rendered QR decodes to the exact `otpauth://` URI with jsQR in Chromium (scratch check) |
| The two approved production settings are documented for the owner to set in Railway | `docs/DEPLOY-RAILWAY.md` |

Full qualification (`.release/batch11-20260928`, up to `4d77183`): **2,734 / 2,734** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 533 s. The candidate's 1,177
source files equal `4d77183`, apart from `release-manifest.json`.

## Batch 12 — media without Google Drive, fit to each platform, push a creative

Findings: F-73, F-74, F-75. The owner's request of 2026-09-28: uploads not dependent on Google Drive, a creative
pushed from the website to chosen accounts, and automatic resizing when pixels exceed a limit (4500 × 4500 → 1080 ×
1080, 4500 × 8000 → 1080 × 1920).

| Change | Evidence |
|---|---|
| The media conversion code shares one bounded workspace (temporary directory, two processes at once), one ffprobe call with the input guard and one conversion call; variants and placement checks use them unchanged | the 54 existing media tests pass before and after, including the real-FFmpeg variant test |
| Uploads in 1 MiB parts into the encrypted staging, with their own quota (four waiting per workspace, eight in all) apart from the two reviews each workspace stages; completion checks every part, the type from the bytes and the SHA-256, then reads the size and a preview frame; uploads belong to their member, administrators can use all, readers and test accounts cannot upload | `tests/media-sources.test.ts`: staging quota, parts, resumable completion, ownership, website routes over HTTP (CSRF, exact part length, content type, test-account refusal) |
| Public-link import (`source_url`, the website's link field, native `url`): HTTPS on port 443 with a host name, every resolved address public, connection to the checked address, each of at most three redirects checked again, host recorded but never the link | the same file: 17 address cases, 9 refused link forms, private resolutions refused through the real HTTPS transport before any connection, redirect rules, the link's token absent from documents and audit |
| `fit_to_platform`: scale down to at most 1080 on the short side and 1920 on the long side, never crop or enlarge; re-encode an image over the platform limit (PNG to JPEG only without transparency); MOV to MP4 for X and LinkedIn (stream copy when already H.264/AAC); EXIF orientation applied by AMCP because FFmpeg 5.1 and later versions differ | 4500 × 4500 JPEG → 1080 × 1080 for LinkedIn, uploaded bytes decoded as 1080 × 1080; 4500 × 8000 PNG → 1080 × 1920 for TikTok; a 6.2 MB PNG → JPEG under TikTok's 5 MiB; EXIF orientations 1–8 in both byte orders give pixel-identical output to FFmpeg's own EXIF handling (scratch check) |
| `amcp_media plan`: for up to 20 destinations, access and the exact file each would receive, without staging or calling a platform; `prepare` takes `expected_sha256` and refuses a different file | plan test: shared conversion, per-platform wording, an unconnected destination reported, nothing staged or uploaded; a different file refused with `MEDIA_CHANGED` |
| *Push a creative* on the Media library page: upload once or import a link, choose accounts, see what each receives and why, confirm once, then each account is prepared and pushed in turn | Chromium against a local server with simulated Meta, TikTok and LinkedIn APIs: upload of a 4500 × 4500 JPEG, three reviews at 1080 × 1080, three uploads with their media IDs, no console errors, no page overflow at 360 px (the table scrolls in its own labelled region) |
| Every refusal new in this batch has its own remedy; the stale media docs are corrected | `tests/error-remedy.test.ts` (5 new codes); `docs/MEDIA-UPLOADS.md`, `docs/WORKSPACE-OPERATIONS.md`, the workspace guide |

A push stages one review at a time, so the workspace's two-review staging limit is unchanged. The first browser run
found that preparing every account before confirming would hit that limit from the third account on; the limit
stays, and the push plans first instead.

Full qualification (`.release/batch12-20260928`, up to `1591ee1`): **2,746 / 2,746** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 532 s. The candidate's 1,172 source
files equal `1591ee1`, apart from `release-manifest.json` (and npm's own run logs under `.runtime/`).

## Batch 13 — ad previews

Finding: F-76. The owner's request of 2026-09-28: a tool that gathers the platforms' preview links.

| Change | Evidence |
|---|---|
| `amcp_ad_previews`: for Meta (placement via `ad_format`), TikTok, Snapchat, LinkedIn and Reddit it lists the account's ads (Snapchat and LinkedIn: creatives), then reads each preview through the platform's own read route; Google Ads returns the reviewed `amcp_write` call that creates a shareable preview; X and platforms without a preview route say so | `tests/ad-previews.test.ts` (7 tests): each platform against a stand-in API, the request each read sends, named ads not in the account never read |
| Only HTTPS links on the platform's own hosts are returned, including an iframe's `src`; markup and other hosts never are. Links are not stored: each read behind them is audited by size and hash | the link filter test (a phishing link and an `http:` link in the same markup are dropped); the audit rule of batch 7 applies to every read |
| LinkedIn ad previews had no ownership rule, so the scope guard refused them: a creative is now previewable for five minutes after the account's creatives list returned it, and the refusal names that list | the LinkedIn test: refused before the list, allowed after, a creative the list did not return stays out |
| *Preview your ads* on the Media library page: choose an account, optionally ad IDs and the Meta placement; each ad's links open in a new tab without a referrer, labelled with the ad's name | Chromium against the local server with simulated Meta and TikTok APIs: links for both platforms, the placement field only for Meta, no console errors |
| Tool counts move from 25/27 to 26/28 in the five places that pin them (including the deployment smoke check) | the affected suites pass |

The Meta, Snapchat and LinkedIn preview responses are not pinned in AMCP's vendor evidence, and the review
environment could not reach the official pages. So AMCP takes the platform-host links it finds rather than named
fields, and `docs/AD-PREVIEWS.md` says so. X's preview route is not called, because its parameters are not pinned.

Full qualification (`.release/batch13-20260928`, up to `85506b1`): **2,753 / 2,753** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 508 s. The candidate's 1,177 source
files equal `85506b1`, apart from `release-manifest.json`.

## Batch 14 — Google Ads v25

Findings: F-49, F-77, F-78, F-79 (and F-80 recorded). The owner's decision of 2026-09-28: upgrade the provider APIs,
Google Ads v25 first. Every difference found is in the
[migration record](../implementation/GOOGLE-ADS-V25-2026-09-28.md).

| Change | Evidence |
|---|---|
| One version module (`src/google-version.ts`): paths, the pinned Discovery contract, catalog records, captured listings and the tool definition follow `googleAdsVersion`; action names keep their captured `google_ads_v23_…` spelling | `tests/google-version.test.mjs` (7 tests): the source, the evidence tools, the descriptors, the routes and the Discovery document agree on v25; every catalog path is at v25; what callers read (tool definition, catalog pages, descriptions) says v25 |
| The v25 Discovery document (revision 20260923) is pinned and sealed; the v23 one is removed; every captured RPC v25 still has maps to exactly one v25 method with its request schema | `tests/google-contracts.test.ts`: 175 methods, 1,489 schemas, 169 routes; the two unrouted RPCs are exactly the retired ones |
| Two server paths outside the catalog kept `/v23/`: account discovery and re-authorisation now build their paths from the version module | the account discovery and diagnostics suites (`tests/google-sync-errors.test.ts`) against v25 paths |
| The legacy adapter's protobuf descriptors are generated: `tools/google-legacy-descriptors.mjs` reproduces the pinned v23 set exactly, then writes v25 | v23 reproduction: 2,206 of 2,206 descriptors, 726 sources and 171 request types equal (9 upstream v23 files changed since pinning, only in comments); v25: 2,297 descriptors, 756 sources, 169 request types |
| What v25 removed is refused by name with its replacement: lifecycle goal configuration and reads (four legacy names, two RPCs) and campaign-level video brand safety | `tests/google-version.test.mjs`; `tests/provider-unavailable-actions.test.mjs`; the contract ledger moves 7 rows to `provider_unsupported` |
| Shareable previews use the v25 request (`operation.shareablePreviews`, `assetGroup` by resource, `previewType` required) and result (`result.previews`, no per-preview errors); a v23-shaped request is refused with the v25 shape in `version_change` | `tests/google-preview-writes.test.ts` (18 tests, rewritten for v25, including the v23 shapes and a v23-shaped receipt); `tests/ad-previews.test.ts` |
| Required request fields recorded at v23 are checked against v25: one rename mapped (`shareable_previews` → `operation`); a missing field is the caller's `MISSING_PARAMETER` (was `INTERNAL_ERROR`) | `tests/google-version.test.mjs` (152 fields); `tests/google-experiment-lifecycle.test.mjs` |
| Proto evidence re-derived from the official v25 protos (previews, user access, portfolios, conversion actions) with shared helpers (`tools/google-protos.mjs`); the conversion field table is its own fixture | the four tools reproduce their fixtures with `--check`; user access and portfolios differ from v23 only in the route version; conversion actions gained 10 types and 1 category |
| The GAQL fields AMCP took from the v23 field reference (626) exist in v25 with the same cardinality | `tests/google-version.test.mjs` |

The official pages on `developers.google.com` are outside the review environment's network policy: v25's sunset date,
the v25 field reference and the release notes were not read. The Discovery document and the googleapis protos are
the evidence. LinkedIn, Meta and Criteo, next in the owner's order, publish their API references on hosts the same
policy blocks, so their upgrades wait for documentation access.

Full qualification (`.release/batch14-20260928`, up to `60e2b65`): **2,760 / 2,760** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 520 s. The candidate's 1,184 source
files equal `60e2b65`, apart from `release-manifest.json`.

## Batch 15 — Meta Graph API v26.0

Finding: F-52. Second in the owner's upgrade order; LinkedIn, the other half of that step, publishes no
machine-readable contract and its reference is blocked here. Every difference found is in the
[migration record](../implementation/META-V26-2026-09-28.md).

| Change | Evidence |
|---|---|
| One version module (`src/meta-version.ts`): paths, route recognition (the current version only), the Facebook Login dialog and token URLs, catalog records and captured listings follow `metaApiVersion` (v26.0); `AMCP_META_API_VERSION=v25.0` moves back, any other value stops start-up | `tests/meta-version.test.mjs` (5 tests): the module, the SDK evidence, the catalog and its listings agree; only the two versions are accepted; routes refuse other versions; the fallback was run once by hand (the catalog lists v25.0 paths) |
| `src/catalog-versions.ts`: one table of gateways sent at a newer version than captured (Google Ads, Meta) replaces batch 14's Google-only hooks in the registry, introspection, the capture verification and the tests | the catalog, compiler, label, verification and Google suites |
| Meta's official SDK at 25.0.3 and 26.0.2 compared over the 250 modules reachable from the catalog's node types: 7 commerce reads, 4 parameters, 23 read fields and 8 enum values removed; nothing AMCP sends or reads among them | `tools/meta-sdk-changes.mjs` and `tests/fixtures/meta-sdk-changes-v26.json`; the version test scans every string of the Meta modules and the catalog's native fields for the 27 removed names |
| 419 of the 591 catalog actions map to an SDK request, and all 419 still exist at 26.0.2 | the same fixture and test |
| The Insights and post extractors share `tools/meta-sdk.mjs` and moved to 26.0.2; rewritten, they first reproduced the v25 fixtures byte for byte at 25.0.3 | the Insights test checks every metric AMCP offers against the v26 model (four Insights metrics were removed; none is offered); the post test checks the post and media fields |

Meta's v26.0 changelog could not be read, so behaviour changes beyond the SDK's schema are not known; reviewed writes
still read back and verify every change.

Full qualification (`.release/batch15-20260928`, up to `9efd7b7`): **2,765 / 2,765** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 514 s. The candidate's 1,191 source
files equal `9efd7b7`, apart from `release-manifest.json`.

## Batch 16 — Criteo 2026-07 prepared

Finding: F-51. Last in the owner's upgrade order. Criteo's 2026-07 OpenAPI document is on `api.criteo.com`, which the
review environment's network policy blocks. The copy bundled in Criteo's official Java SDK is reachable but differs
from the official documents (compared at 2026-01: enum lists, `required` lists, inlined schemas), so it was used only
to compare 2026-01 with 2026-07 and was not pinned as a contract. The
[preparation record](../implementation/CRITEO-2026-07-PREPARATION.md) lists what changes: 98 of AMCP's 108 Criteo
routes are unchanged in structure, the V2 asynchronous reports behind the report job family are removed (the bulk of
the work), and balance reads move to V1. Documentation only; no code changed.

## Batch 17 — one guarded reader (F-61)

Finding: F-61. The families whose state reads bypass the generic reader chain had their own hand-written readers: 14
in the review's `state()` and 17 in the verification. Each repeated the same guard (the read must be read-only; before
the credentials are fetched, after, and after the response, the actor, connection and scopes are checked again and the
scope guard authorizes the read), with small differences between copies.

| Change | Evidence |
|---|---|
| `WriteReviewService.guardedReader` and `WriteVerifier.guardedReader` replace the 31 readers. A family passes its read-only message and, where it had them, an actor check, a connection check, a login binding (`sameLogin`, or the X and TikTok report identities) and an `after` step (the X, Criteo and Meta report observations); messages and error codes are unchanged per family | the suites of the 31 families, unchanged, and the full suite |
| One copy was weaker than the rest: X creative verification re-resolved the connection after the credentials were fetched and after the response, but did not run the scope guard again there. It now does, like every other reader. No outcome changes: for X reads, what the guard checks beyond the connection's accounts depends only on the read, which the first check passed | `tests/x-creative-writes.test.ts`, unchanged |
| 266 lines fewer (`src/write-review.ts` −118, `src/write-verification.ts` −148) | `git diff --numstat` |

The generic state and verification loops still read through the nested family reader chains (F-60), which keep their
own guard.

Full qualification (`.release/batch17-20260928`, up to `f2a7c18`): **2,765 / 2,765** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 527 s. The candidate's 1,192 source
files equal `f2a7c18`, apart from `release-manifest.json`.

## Batch 18 — the administrator and reviewer passwords (F-16)

Finding: F-16. The two passwords configured on the server, the deployment administrator's and the shared reviewer's,
were hashed with Node's scrypt defaults (N=2¹⁴, p=1) and checked synchronously on the event loop. Changing one left
every session it had opened, and the MCP access approved from those sessions, in force.

| Change | Evidence |
|---|---|
| One password-hash module (`server/password-hashes.ts`) serves user accounts and the two passwords, with one limit of four concurrent derivations. New hashes for the two passwords are scrypt-v3 (N=2¹⁵, r=8, p=3), the account parameters; `scrypt$…` hashes from an older environment still work, and start-up warns about them | `tests/door-passwords.test.ts`, first test |
| Sign-in with either password is asynchronous. The attempt is counted before the key is derived, so guesses sent in parallel cannot pass the limit of eight | the same test; the website and account suites |
| `amcp_web_doors` records the hash each password was last opened with. A password from the environment is hashed with a salt derived from the master key, so every process computes the same hash. A process that starts with a new password ends that door's sessions, revokes the MCP access approved from them and records `administrator_password_changed` or `reviewer_password_changed`. The same password keeps them across restarts | second and fourth tests |
| A door's sessions, codes, refreshes and access tokens are usable only while the process's password is the recorded one, checked in the same transaction as each insert. A server still running the old password therefore stops issuing either the moment one with the new password starts. A process without the password (the report worker) changes nothing | third and fourth tests |
| `npm run admin -- password-hash` reads a password from standard input and prints a scrypt-v3 hash | fifth test |
| The account page says the administrator password has no two-step verification and points to owner migration | `node tools/check-web.mjs` |

Tests that sign in with either password now await the sign-in. One test fabricated a reviewer session for an
arbitrary workspace; it now signs in with the reviewer password instead and keeps the same assertion.

Full qualification (`.release/batch18-20260928`, up to `53848b4`): **2,770 / 2,770** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 554 s. The candidate's 1,194 source
files equal `53848b4`, apart from `release-manifest.json`.

## Batch 19 — design tokens, the last contrast failures, right-to-left text

Findings: F-40, F-38, F-47. Measured with the batch 3 Playwright audit (50 page and width combinations: anonymous
visitor, administrator and reviewer at 320, 360 and 1280 px) against a throwaway local site.

| Change | Evidence |
|---|---|
| `web/tokens.css`, loaded first, is the only `:root`. It holds the palette the page already used; app.css's dead green theme and identity.css's `--green` (which held purple) are gone, and `--text-muted` merged into `--muted` | Neutral, proven in Chromium: with every `var()` replaced by its value, the 7,969 declarations of the stylesheets are identical in order, and all 406 computed properties of the root element are equal. `tools/check-web.mjs` requires `tokens.css` first and refuses tokens elsewhere; it fails on the previous files |
| The last 60 texts below 4.5:1: real text darkened within its hue to 4.6:1 or more (`--muted` `#6c697b` → `#696678`; 10px text to 12px); the two homepage mock-ups labelled images; decorative glyphs `aria-hidden` | audit: 60 → 0 below contrast, 0 overflow, 0 unnamed controls, console unchanged (three expected 401s on the anonymous OAuth result page) |
| Text fields, text areas and table cells take their direction from their own text (`unicode-bidi: plaintext`) | Chromium probe: an Arabic cell starts at its right edge; English and number cells at the left |

Full qualification (`.release/batch19-20260928`, up to `7dc5e53`): **2,770 / 2,770** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 577 s. The candidate's 1,195 source
files equal `7dc5e53`, apart from `release-manifest.json`.

## Batch 20 — provider schema drift and end dates

Findings: F-81 (new), F-56. The live drift check compares every pinned vendor document with what its official URL
serves today; it reads public documents only. Four Google documents had changed within their versions. The full
review is in [SCHEMA-DRIFT-2026-09-28](../implementation/SCHEMA-DRIFT-2026-09-28.md).

| Change | Evidence |
|---|---|
| DV360 v4 re-pinned (20260902 → 20260928): the device-type YouTube and partners bid multiplier is writable, and its write needs a spend confirmation; four video fields became output-only. The Demand Gen family's special case for the video availability note is gone, since the pin now marks it output-only | `tests/dv360-ad-group-targeting.test.mjs` (new; refused as output-only under the old pin); the Demand Gen read-back fixture now carries the note |
| GA4 Data v1beta and v1alpha re-pinned (→ 20260924). GA4 now says when it truncated a report. The truncation is kept in source quality, a truncated source is not measurement-complete (so the report is partial with a warning naming the limits), and period comparisons and the website carry it | `tests/audit-report-quality.test.mjs`, `tests/ga4-campaign-report.test.ts` (both new and red before) |
| Business Information v1 re-pinned (→ 20260927): descriptions only | the drift diff |
| `tools/fetch-vendor-specs.mjs --refresh name…` re-pins single documents. Regenerated artifacts are equal in content: 511 vendor routes with no gaps; 173 DV360 routes equal apart from copied vendor records and parameter order; 1,207 ledger records identical, reordered | every generated-artifact check |
| `src/provider-sunsets.ts` records when each version AMCP sends ends: official date, support-period policy, or unknown. `npm run check` fails if it does not match the versions AMCP sends; the weekly provider workflow fails 90 days before a recorded date. The contract view MCP clients read has `version_end`. `CONTRACTS.md` no longer presents v23's 2027-02 sunset as the pinned version's; it states Criteo 2026-01's policy end (2027-01) | `tests/provider-sunsets.test.mjs` (4 tests); `node dist/tools/provider-sunsets.js` |

Criteo, Reddit and the six Microsoft documents could not be fetched from this environment (HTTP 403), so their drift is
unchecked here. The only recorded end dates are Criteo 2026-01's (the 12-month policy, January 2027; the alarm starts
on 2026-10-03) and Microsoft's SOAP retirement (2027-01-31, which does not affect AMCP's JSON transport). The others
could not be read from here and stay unknown.

Full qualification (`.release/batch20-20260928`, up to `0ce02ab`): **2,777 / 2,777** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check (now including `providers:sunsets`) and the Railway check pass.
545 s. The candidate's 1,199 source files equal `0ce02ab`, apart from `release-manifest.json`.

## Batch 21 — the website code formatted

Finding: F-62 (its remainder). `web/` was the part of the code base Prettier did not cover: 16 scripts and 6
stylesheets, written with lines averaging over 300 characters.

| Change | Evidence |
|---|---|
| The six stylesheets formatted (125 → 5,817 lines) | Format-only. In Chromium, with every `var()` replaced by its value, the 7,987 declarations of the workspace stylesheets are identical in order, the root element's 406 computed properties and the tokens are equal, and the privacy page's 277 declarations are identical |
| The 15 scripts formatted (1,121 → 4,221 lines; HTML template text is unchanged, so the longest lines are still templates). The vendored QR encoder stays byte for byte (`.prettierignore`), since its digest is recorded | Format-only. Syntax-tree equality with Prettier's own parser: 15 of 15 files identical; `node --check` on every script; the 117 tests that load or read the scripts pass |
| `format` and `format:check` cover `web/**/*.{js,css}`; the website check's pattern for the one allowed synchronous `confirm()` tolerates line breaks | `npm run format:check`; `node tools/check-web.mjs` |

Full qualification (`.release/batch21-20260928`, up to `f6d2f66`): **2,777 / 2,777** tests and **4 / 4** capture
tests; `format:check` (now including `web/`), every generated-artifact check and the Railway check pass. 533 s. The
candidate's 1,199 source files equal `f6d2f66`, apart from `release-manifest.json`.

## Batch 22 — start-up time and memory

Finding: F-64. Every consumer parsed the generated artifacts again: each `Registry` parsed the 5.4 MB registry and
compiled an Ajv validator for every tool and operation, each `MirrorService` and `WriteReviewService` built a compiler
that parsed the 6 MB vendor routes again, a third module parsed them once more, six DV360 modules each parsed the
pinned DV360 document, and two GTM modules the GTM one.

| Change | Evidence |
|---|---|
| `src/pinned-json.ts` reads a generated artifact or pinned vendor document once per process and deep-freezes it; the registry, the compilers, the Google contracts and the DV360 and GTM families share that copy | `tests/pinned-json.test.mjs`. Freezing makes any write throw, and the full suite passes, so no module changed data another reads |
| `Registry` compiles a validator the first time its tool or operation is validated; `compileAll()` compiles them all | the same test compiles every validator, so a schema Ajv cannot compile still fails a test |

Measured on 4 CPUs, median of 5–7 fresh processes, before (`32e2d3b`) and after:

| Measure | Before | After |
|---|---:|---:|
| `createRuntime()` (import + construction) | 860 ms (259 + 610) | 398 ms (252 + 147) |
| Memory after `createRuntime()` (RSS / heap used) | 227 / 121 MB | 146 / 68 MB |
| HTTP server ready (`http_listening`) / RSS | 1,400 ms / 284 MB | 916 ms / 169 MB |
| stdio MCP server answering `initialize` / RSS | 1,012 ms / 211 MB | 544 ms / 161 MB |
| Full test suite (`node --test`, 2,779 tests) | about 530 s | 244 s |

Full qualification (`.release/batch22-20260928`, up to `003b6a3`): **2,779 / 2,779** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 277 s, against 533–577 s for the
previous five qualifications. The candidate's 1,201 source files equal `003b6a3`, apart from `release-manifest.json`.

## Batch 23 — the reviewed-write lifecycle in stage modules

Roadmap P2 item 3. `src/write-review.ts` held every stage of the reviewed-write lifecycle in 3,027 lines, 666 of them
imports.

| Change | Evidence |
|---|---|
| The stages moved verbatim into their own modules: `write-shape.ts` (request shapes, `assertWriteShape`), `write-snapshots.ts` (`snapshotPlans`), `write-state.ts` (`validateState`), `write-outcome.ts` (`writeOutcome`) and the helpers they share in `write-common.ts`; `write-review.ts` keeps the service (1,151 lines) | A move, proven: all 14 top-level declarations have identical syntax trees before and after (an added `export` on the shared helpers aside); none is missing or declared twice; every module imports only specifiers the original imported from the same module, or the new stage modules. `tsc` passes with `noUnusedLocals` |
| Importers (5 modules, 11 tests) import from the stage that holds the function | full suite: 2,779 tests, 2,774 pass, 0 fail, 5 skipped |
| `executeRequirements`' description had drifted above another declaration; it is back above its function | comment only |

Full qualification (`.release/batch23-20260928`, up to `1acb866`): **2,779 / 2,779** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 280 s. The candidate's 1,206 source
files equal `1acb866`, apart from `release-manifest.json`.

## Batch 24 — the verification plan in its own module

| Change | Evidence |
|---|---|
| The verification plan (`verificationReads`, `entity`, and the comparison helpers `normalize`, `differing` and the Snapchat projections) moved verbatim from `write-verification.ts` (1,344 → 723 lines) into `verification-reads.ts` | A move, proven as in batch 23: all 10 top-level declarations have identical syntax trees, none missing or declared twice, and the imports are a subset of the original's. Full suite: 2,779 tests, 2,774 pass, 0 fail, 5 skipped |

Full qualification (`.release/batch24-20260928`, up to `f5c7ce6`): **2,779 / 2,779** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 274 s. The candidate's 1,207 source
files equal `f5c7ce6`, apart from `release-manifest.json`.

## Batch 25 — contract evidence by reference (F-29)

Every `amcp_write` inspect and prepare carried the provider's whole contract in `contract_evidence.provider`: 1.3 KB
(Amazon) to 6.6 KB (Google Ads), the same for every review of a gateway. `amcp_campaign` stored each prepared step's
review in the run and returned it again, so a run repeated it once per step.

| Change | Evidence |
|---|---|
| `amcp_write` takes `evidence: "full"` (the default, unchanged) or `"ref"`. With `"ref"`, inspect and prepare return a reference in place of the provider contract: its id, gateway, versions, review date, write status, live qualification and version end, and `full_contract`, the `amcp_tool_help` call whose `amcp_contract` is the whole contract (`providerContractReference`) | `tests/write-evidence.test.ts`, red before the change (the parameter was refused as unknown): the rest of `contract_evidence` is unchanged; following `full_contract` returns exactly the contract left out, for all 17 gateways a review can name; every reference is under 700 bytes |
| The form is not part of the review: the same request, before-state, state hash, spending policy and fingerprint, and the review executes as any other | same test |
| Any other value is refused on every `amcp_write` route, media included, before a provider read | same test: `"summary"`, `true` and `null` are refused with `INVALID_ARGUMENT` for inspect and prepare, with no request sent |
| `amcp_campaign` prepares its steps with `evidence: "ref"` | same test: the prepared step and the stored run hold the reference |

A Meta campaign prepare response drops from 7,171 to 2,660 bytes (its evidence from 5,290 to 781). A three-step Meta
campaign run once its first step is prepared drops from 9,264 to 4,755 bytes, and each further prepared step saves
about 4.5 KB more.

Full qualification (`.release/batch25-20260928`, up to `cab5ae2`): **2,783 / 2,783** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 282 s. The candidate's 1,208 source
files equal `cab5ae2`, apart from `release-manifest.json`.

## Batch 26 — a map of the documentation, and argument names by gateway

| Change | Evidence |
|---|---|
| `docs/README.md` maps all 203 documents: the guides and reviews by section, and the implementation records by platform, newest first, each beside its verification file. It is generated from the documents' own titles (`npm run docs:index`) and linked from the repository README (F-68) | `npm run docs:index:check`, now part of `npm run check`, failed before the map existed and passes after. It also fails on a guide or review not placed in a section (tried with a new `docs/ZZ-NEW-GUIDE.md`) and on a record without a title |
| `docs/CONTRACTS.md` lists each direct gateway's argument names: the account, path, query and body values, how to follow provider pages, and the connection (F-32). The captured names stay, so clients written for the captured interface keep working | generated with the contract guide (`contracts:check`). The generator refuses a name the gateway's schema lacks, an alias the schema does not call an alias, and a direct gateway left out (each tried: `region_code` on Amazon, Meta's alias reversed, Microsoft's row removed) |
| `docs/ADDING-A-REVIEWED-FAMILY.md` names `npm run docs:index` among the regeneration steps | — |

## Batch 27 — WCAG 2.2 target size

The accessibility audit now evaluates WCAG 2.2 success criterion 2.5.8 with its exceptions (a control and its label
are one target; links in a sentence are exempt; a smaller target passes when a 24 px circle centred on it meets no
other target and no other small target's circle), over the same 49 page/width combinations as batch 19.

| Change | Evidence |
|---|---|
| Plain disclosure summaries gain 3 px above and below (18 → 24 px); the native-metrics summary, text links and selects without their own sizing are at least 24 px tall (`web/accessibility.css`) (F-82) | before: 197 targets under 24 px, 54 failing (summaries within 12 px of a form field, "Manage connections ↗" links under the platform header, an unstyled select). After: 116 under 24 px, 45 in sentences and 71 spaced as the criterion allows, **0 failing**. Both measured on fresh local sites built from the same code, one serving the web assets of `e21ec88`; every page lists the same targets before and after (1,368) |
| The Sheets delivery policy on the reporting page is styled and aligned like the report's other fields (F-83) | seen in the element screenshots before and after |
| — | the full audit afterwards: 0 texts below contrast, no overflow, no unnamed control, no duplicate id; the only console errors are the three expected 401s of the anonymous OAuth result page, as in batch 19. Pages grow by 0–28 px, the reporting page by up to 239 px at 360 px with every platform open |

Full qualification of batches 26 and 27 (`.release/batch27-20260929`, up to `d8926a3`): **2,783 / 2,783** tests and
**4 / 4** capture tests; `format:check`, every generated-artifact check including the new `docs:index:check`, and the
Railway check pass. 283 s. The candidate's 1,210 source files equal `d8926a3`, apart from `release-manifest.json`.

## Batch 28 — the owner's list from live Google Ads use

On 2026-09-29 the owner reported ten problems found while running a Google Ads rebuild through AMCP, and asked for the
same improvements on every other platform. Each is fixed below with local evidence. The live deployment still runs
the previous code, so live confirmation follows the next deployment.

| Change | Evidence |
|---|---|
| **1. Conversion goals.** Goal names follow the pinned contract: `customers/{id}/customerConversionGoals/{category}~{origin}` and `…/campaignConversionGoals/{campaign_id}~{category}~{origin}`, with the category and origin values the contract lists (UNSPECIFIED and UNKNOWN excluded). A goal Google reports under a name that contradicts its own category or origin is refused as unverified state (F-84) | red first: with the fixtures moved to Google's names, 55 of 72 goal and conversion-action tests failed with the owner's error ("Use an exact customerConversionGoals resource"); green after. The owner's case as a test: three non-purchase goals set non-biddable in one review, executed once, verified by read-back, purchases still biddable. Numeric, unknown, reversed, lower-case and UNKNOWN names are refused before any read |
| **9. Keyword Planner and Audience Insights.** `audienceInsights:listInsightsEligibleDates` and `keywordThemeConstants:suggest` sit under a service rather than a customer, and the scope guard refused them. One rule now recognises every documented planning read outside a customer, for the read classification and the scope guard alike (F-85) | `tests/google-planning-reads.test.ts`, red before (the two routes refused), green after: all 28 Keyword Planner, Audience Insights, Reach Planner, benchmark, brand, creator and theme reads, with requests shaped from the pinned contract, and their 17 legacy names, each reach Google once at its documented path, for a reader, with writes off. With the current code the other planning reads already worked; the live failures predate the v25 path work |
| **8. Errors that name the problem.** Workspace tools refuse an unknown argument by naming it and listing the accepted ones, and an oversized request by its size and the limit, instead of "Unsupported arguments or request too large". Every refusal's message now names the field, parameter or missing value its details identify (for example `Missing required Google request field: GenerateReachForecastRequest.campaign_duration`), on every platform; details echoing a provider's reply are never quoted. The search-waste analyzer's format is documented in the workspace guide and the tool description (F-86) | `tests/search-waste-format.test.ts`: the documented Google capture and analyze calls flag the zero-conversion term with enough clicks; `report_id` for `id`, `min_clicks` for `minimum_clicks`, inline rows, a wrong semantics field and an oversized request are each refused by name (red against the old check, which answered all of them alike); the shared message step is tested directly. Full suite: 2,790 tests, 0 failures |
| **2. Capabilities that match reality.** Every provider capability level is `unsupported`, `implemented_unverified` or `partial_unverified`; nothing reads as supported without live proof. The reviewed scope reads "Implemented and tested locally; not verified against a live account", and the contract view explains the statuses. A workspace's live evidence is its own: the dashboard lists, per provider, the reviewed writes it verified by reading them back from the provider (`live_verified`), and no other provider gains from them (F-87) | `tests/capability-honesty.test.ts`, red before: no level reads as supported; `CONTRACTS.md` says the scope is not verified live; an inconclusive verification does not count, a verified one appears with its account and time, through `amcp_workspace dashboard` too. Five older assertions updated to the new values |
| **3. Staying connected, and a health check that tells the truth.** `/healthz` checks the database (a read and a write lock), the disk, and the offline help through a real MCP client and server in memory, the call that failed on 09-24; it answers 503 naming only the failed check, and a result lasts ten seconds. Refusals before MCP are JSON-RPC errors with their reason (a refused browser origin names itself and `AMCP_MCP_ALLOWED_ORIGINS`), every refused or failed `/mcp` request writes one log line without the token, and idle keep-alive connections last 65 s. `AMCP_MCP_ALLOWED_ORIGINS` (empty by default) lets the owner accept an exact browser origin (F-88) | `tests/mcp-availability.test.ts`: the healthy report; a closed database turns it to 503 after the ten-second window, not before; 401, 403 and 400 refusals in JSON-RPC shape with their log lines, the token in none; an allowed origin completes the MCP handshake and help call while another stays refused; the listener's timeouts. The HTTP, OAuth, website, startup and deployment suites pass (50 tests); the Railway check passes |
| **7. Slimmer responses (first part).** A caller that does not choose an `evidence` form receives each provider's contract whole the first time its session inspects or prepares for that gateway, and a reference afterwards: the versions, review date and status, with the `amcp_tool_help` call that returns the rest. An explicit `evidence` still wins; a refused request does not count as delivery; the memory is process-local, lasts 12 hours and holds at most 10,000 sessions keyed by a hash of the credential (F-89). The plan responses are compacted separately (Snapchat S1) | `tests/write-evidence.test.ts`: the second prepare in a session carries the reference and the first carries the whole contract; a prepare that was refused leaves the next one whole; the explicit forms are unchanged. Targeted suites 17 of 17; full suite 2,800 tests, 0 failures, 5 skipped |

## Batch 29 — the owner's Snapchat brief, and Google items 4, 5, 6 and 10

On 2026-09-29 the owner sent findings S1–S14 from two live Snapchat tests (25 and 29 September) that cloned a
LEADS campaign as a paused copy. Step zero: the error text the brief could not find (`details.ownership_reads`,
"Page through the collection") comes from commit 67a4f01 (batch 5) on `Codex-branch`, pushed before the 29 September
test; the brief compared against an older local copy (03ac8d3). The deployed build is therefore a push of this branch
and needs no reconciliation. Every item is built against synthetic fixtures; nothing touched a live account. The
rows after S14 finish the Google list of batch 28 (items 4, 5, 6 and 10); `docs/implementation/GOOGLE-BRIEF-2026-09-29.md`
and `SNAPCHAT-BRIEF-2026-09-29.md` record both lists item by item.

| Change | Evidence |
|---|---|
| **S1. Compact plan responses.** Every `amcp_campaign` response is the plan header, one row per step (`id`, `kind`, `status`, `resource_ids`, `verification`, `error`), the step the call acted on (`current`, with its receipt, verification and error) and `next_call`, within 12 KB. `prepare_next` returns the review's request, state hash, a summary of each state read and the spend policy instead of the raw before-state. When a view would exceed the budget it gives up detail in a fixed order (the provider reply in the receipt, error details, all but one resource ID per row, repeated refusals, then verified rows). `get` with `step_id` returns one step whole, `detail:"full"` the whole plan; `list` pages 50 at a time. The website asks for the full form, since a person approves each step there (F-90) | `tests/campaign-plan-views.test.ts`, red first: an 11-step Snapchat plan's `execute_next` grew 21.6 → 89 KB and a 50-step plan's reached 410 KB; green after: 11 steps 2.5–3.6 KB, 50 steps at most 7.7 KB, `prepare_next` at most 4.3 KB, `preflight` 7.3 KB and `get` 5.9 KB at 50 steps. Also covered: the compact shape, every created resource ID in the rows, a failed step's error in `current` and in its row, a long review within budget, `get` with `step_id` and `detail:"full"`. Thirteen older assertions in eight files now read the same values through `current`, `get` with `step_id` or `detail:"full"`; `create_from_recipe` keeps the recipe's field provenance in its compact response. Full suite: 2,806 tests, 1 failure (the recipe provenance, fixed and rerun green) |
| **S2. Amending a blocked step.** Every step preflight blocks, and the plan itself, carries a `next_call` to `recover_step`. When the refusal names a field (a foreign Snapchat pixel), `choose` gives the field, its current value and the owned pixels, and `add_after_user_choice` the patch with a placeholder the server refuses: AMCP never picks the pixel. `patch` (`[{path, value}]`, JSON pointers into the step's arguments) changes fields the step already has and never a dependency reference; corrected `arguments` still work, unchanged ones are refused. `previous_attempts` keeps each attempt with its refusal and change (at most ten). A step that failed before reaching the provider gets the same call; one whose write reached the provider does not, and says why. The pixel remedy and the blocked-plan text no longer send the agent to a dead end (F-91) | `tests/campaign-plan-amendment.test.ts`, red first (5 of 5), green after: the owner's sequence (blocked, amended through `next_call`, preflight passes, plan completes, no cancel, nothing sent before), patch refusals (missing field, index out of range, outside the arguments, empty or relative pointer, the placeholder, extra keys, `$ref` value or target, patch with arguments, unchanged arguments), a progressed step and its predecessor refused, dependants waiting on an amended step, and 49 blocked ad squads answered within 12 KB with identical refusals stated once |
| **S11. Refusals that name the field.** `recover_step` checks that the step can be amended before it asks for `confirmed: true`, names an unknown step with the plan's steps, and a plan step's `RECOVERY_NOT_SAFE` has its own remedy instead of the media-upload one. `cancel` names `confirmed: true`. `amcp_workspace check` names an unknown requirement key with the accepted ones, and for `currency` says it comes back with `live: true` and is pinned by a plan's `expected_currency`. Plan creation already listed the allowed `kind` values (F-92) | The ordering and naming cases in `tests/campaign-plan-amendment.test.ts`; `tests/snapchat-refusals.test.ts`, red before (the generic message), green after. Full suite with S2: 2,813 tests, 0 failures, 5 skipped |
| **S5. A way out of a read-back that never agrees.** When every read of two verification rounds returns the same differing state, verification says `mismatch` (`VERIFICATION_MISMATCH`) with a `diff` of each field (sent and held values) and the observed `actual_hash`; one round is not enough, so a slow propagation stays inconclusive and is read again. No response suggests a read that cannot change the answer. With the user's agreement, `reconcile_step` with `accept_observed: true` and that hash reads once more and either refuses a state that moved (`STATE_CHANGED` with the new hash) or marks the step `verified_with_acceptance`, writes an audit entry and lets its dependants continue; nothing is sent. A mismatch now holds only its dependants, like an inconclusive step, while failed and uncertain steps still stop the plan (F-93) | `tests/campaign-plan-mismatch.test.ts`, red first (4 of 5; the transient case already passed), green after: a stable normalisation reaches `mismatch` with its diff and no verify loop; acceptance by hash, audited, sends nothing and lets the dependant complete; a state changed since the diff is refused with the new hash; a difference that clears on the next read verifies normally; acceptance needs the hash and a disagreeing step. Two older tests now expect `mismatch` for their stable disagreement; their dependants still wait and independent steps still run |
| **S7. Health for each role.** Each owner action names itself in its refusal ("Only the workspace owner can export the support bundle."), and `OWNER_REQUIRED` has a permission remedy: ask the workspace owner. An administrator who does not own the workspace gets a reduced health view: each connection's status and account count and the job queues, without labels, policies, e-mail, storage or backups. The default remedy no longer says "prepare again" on reads (F-94) | `tests/owner-health-access.test.ts`, red before, green after: owner, administrator, member and reviewer test account against each of the six owner actions, and the administrator view's exact keys |
| **S8. Account names, currencies and timezones.** A live check, and a plan's preflight account read, record the account's name, currency, timezone and organization with `checked_at`. `list_accounts` returns them with their source, keeps the label as `connection_label`, and before a live read, or a week after one, returns nulls with a `next_call` for the live check (F-95) | `tests/snapchat-workspace-views.test.ts`: before and after the check, stale after a week, one shape per platform; red before |
| **S9. Reviews without billing details.** A Snapchat review keeps the ad account's `id`, `name`, `status`, `currency`, `timezone`, `organization_id` and `type` only, at prepare and at execute alike; the state hash covers them (F-96) | The same file: no billing or funding key in a review, a plan run or the full plan; a currency or status change still refuses execution with `STATE_CHANGED`, a billing change does not; red before |
| **S10, S12, S13.** A contracts page filtered to one gateway summarises only that gateway, and an unknown gateway is named with the valid ones (F-97). Execute accepts the review's own gateway and connection, names a different one by field with the accepted fields, and lists what execute takes when it is sent `arguments` (F-98). Preflight lists the plan's accounts that no spending policy protects once, with the owner's `save_spend_policy` as the next call; it never blocks, and spend confirmation is unchanged (F-99) | The same file, red before (all six), green after. Full suite with S5 and S7–S13: 2,826 tests, 0 failures, 5 skipped |
| **S3. Known creatives by ID.** `result_ids` on a Snapchat account list pages through it and returns only the records asked for, with `result_ids: {requested, found, missing, pages_read, complete}`; listed IDs are owned for five minutes, unlisted ones stay unreadable and are never sent to Snapchat. A scope refusal suggests the list narrowed to the refused ID (F-100) | `tests/snapchat-reads.test.ts`, red first (5 of 5 with S4 and S6), green after: four creatives from a 312-creative, four-page list in one call under 10 KB, then readable one by one; an ID of another account missing and still refused with no request; a bounded search that says how far it looked; `result_ids` validated before any request; the five-minute ownership lifetime unchanged. Full suite: 2,831 tests, 1 failure, the ownership-read test that pinned the old whole-list suggestion; updated to the narrowed read and rerun green |
| **S4. The by-ID reads.** The five `get_*_by_ids` reads, under both of their names, are refused before any request: their body is undocumented and guessed bodies failed live. The refusal says they are POSTs and names the `result_ids` read; the contract inventory lists them as unsupported (F-101) | The same file: all ten names refused with no request; the contracts page classifies them; the regenerated coverage ledger shows 10 unsupported Snapchat actions |
| **S6. Pixels and the organization.** Pixels the account lists are readable one by one, campaign eligibility included (already true; now tested). The organization's pixel list is readable once the account's own read names the organization; other organizations and other organization paths stay refused (F-102) | The same file: unlisted, listed and another account's pixel; the organization before and after the account read, another organization, and its funding sources |
| **S14. Documentation.** The Snapchat guide covers the compact and full plan views, the amendment path, mismatches and acceptance, reading records by ID, the by-ID reads' status, organization pixels, account metadata, review projection and the spending notice; the `amcp_campaign` description covers the views and amendment. Every example is a call a test makes. `SNAPCHAT-BRIEF-2026-09-29.md` records the brief item by item | `Skills/amcp-campaign-builder/references/tiktok-snapchat.md`, `workspace.md`, `docs/WRITE-OPERATIONS.md` |
| **Google 6. Paused parents cover their children.** The owner asked for this loosening. A new positive ad-group keyword may start ENABLED when the review reads its ad group or campaign as PAUSED; the state check runs at prepare and again at execute, so a campaign enabled in between stops it. Under a serving ad group and campaign, or a parent the review could not read, it still starts PAUSED (`TARGETING_PARENT_SERVING`, naming both statuses). The Google Search recipe's keywords start ENABLED under its paused ad group, so enabling the campaign and ad group is the only activation left (F-103) | `tests/google-paused-parents.test.ts`, red first (4 of 4), green after: ENABLED under a paused campaign in one reviewed step; a paused ad group covers too; serving parents refuse ENABLED and accept PAUSED; a campaign enabled between review and execution stops the write. One case in `tests/google-targeting-writes.test.ts` that pinned the old refusal before any read is removed there; the new file covers it after the read. Full suite: 2,835 tests, 0 failures, 5 skipped |
| **Google 4. One approval for long lists.** A Google Ads mutation or Snapchat batch of more than 25 records (up to 1,000) is prepared as one review of parts of 25 (`group: true`), each part an ordinary review with its own state reads, state hash, idempotency key, spending check and read-back. One approval executes the group: every part's review window is checked first, the parts run in order, and execution stops at the first that does not succeed (`WRITE_OUTCOME_UNCERTAIN` if it was sent, `WRITE_PARTIAL_OR_FAILED` if it was refused after earlier parts applied), listing the parts not sent. A stopped group is never run again, and a completed one replays. `amcp_campaign verify` reads every part back; in a plan the list is one step, and preflight checks each part as it will be sent. Operations linked by temporary IDs are not split (F-104) | `tests/grouped-reviews.test.ts`, red first (5 of 5), green after: 84 negative keywords as four parts approved and executed once, each keyword sent once, a replay sending nothing, all 84 verified; a failed second part stopping the group with two parts unsent and never re-sent; a group refused before its first part leaving no record, and an expired group sending nothing; temporary IDs not split and the 1,000-record limit named; 30 Snapchat ad squads as one plan step of two parts, verified, with responses within 12 KB. A request is tried whole first, so families with larger native limits (100 recommendations, 500 listing groups, 100 customer types) are unchanged; the Snapchat replace test that refused a 26th ad now refuses 1,001 before any read. Full suite: 2,845 tests, 0 failures, 5 skipped |
| **Google 5. One approval for a whole build.** `approve` returns what the approval covers: each step's action and account and the budget, bid and status fields it sets. `approve` with `confirmed: true` and that summary's `plan_hash` records the user's approval (with `spend_change_confirmed` if they approve the spending effects), audited as `campaign_plan_approved`. `run` then prepares and executes every step in order under it; each step is still a frozen review of the state it reads, executed once with its own key and read back, and IDs pass between steps as before. It stops for anything that needs a person (a spending acknowledgement the approval did not give, an owner cap override, a creative edit, a failure, a mismatch, a read-back still settling) and returns within about 25 seconds. Amending a step voids the approval; it lapses after a day. It is not all-or-nothing: nothing is rolled back, and Google's atomic multi-resource mutate would need its own reviewed family (F-105) | `tests/campaign-plan-approval.test.ts`, red first (5 of 5), green after: an 11-step plan approved once and run in one call (11 writes, response within 12 KB, audited, a second run sends nothing); run refused without an approval and approve refused with a stale hash; an approval without the spending acknowledgement stopping at the first budget with its review; an amendment voiding the approval; a mismatch stopping the run with the acceptance as the next call. Full suite with item 4: 2,845 tests, 0 failures |
| **Google 6, continued: ad groups and ads.** New ad groups and asset groups may start ENABLED under a campaign the review reads as PAUSED, and new ads under a paused ad group or campaign (the ad-group parent read now includes `campaign.status`); otherwise `PARENT_SERVING` names the statuses. A new campaign still starts PAUSED. The Google Search recipe creates its ad group, keywords and ad ENABLED under its paused campaign, so enabling the campaign is the only activation left (F-103) | `tests/google-paused-parents.test.ts`: ad group and ad ENABLED under a paused campaign, refused under serving parents and accepted PAUSED; the ad-group read asks for the campaign status; red first. Full suite: 2,846 tests, 0 failures, 5 skipped |
| **Google 10. Clone a campaign from a spec.** `amcp_campaign clone` with `source: {campaign_id}`, a new `name` and optional `changes` reads the source through the account's own reads and creates a draft plan. Google Search: budget, the campaign PAUSED (four bidding strategies, network settings, EU political declaration), location, language and negative keyword criteria, then per ad group its keywords and responsive search ads, children keeping their status under the paused campaign. Snapchat: the campaign, each ad squad and one step for its ads, all PAUSED, creatives reused by ID. Only fields AMCP sends on create are copied; `not_copied` lists the rest by step. `changes.set` sets a field by JSON pointer (a new field needs an existing parent; never the action, a `$ref` or a prototype key) and `changes.drop` leaves steps out with their dependants. The response's `next_call` is `approve`; nothing is sent until then. Other types and platforms: `CLONE_UNSUPPORTED` (F-106) | `tests/campaign-clone.test.ts`, red first (6 of 6 on the previous runner), green after: a Snapchat clone of two squads and three ads with two changes, only reads sent, audited; approved once and run to completion (five writes, every entity PAUSED, response within 12 KB); a drop taking its dependants; thirteen malformed specs refused by field with no plan created (the action, a `$ref` or a subtree holding one, a prototype key, a missing parent, unknown steps) and another platform named before any connection lookup; a Google Search clone with every step and `$ref` checked, the ad text assets' output-only fields left out, a shared budget and an ad-schedule criterion listed as not copied; Performance Max and target impression share refused. Full suite: 2,852 tests, 0 failures, 5 skipped; after the review fixes the clone, campaign, Google, Snapchat, schema and guide suites pass (668 tests) |

Full qualification of batches 28 and 29 (`.release/batch29`, up to `5a7f1f3`): **2,852 / 2,852** tests and **4 / 4**
capture tests; `format:check`, every generated-artifact check and the Railway check pass. 295 s. The candidate's
1,236 source files equal `5a7f1f3`, apart from `release-manifest.json`.

## Batch 30 — the owner's decisions of 2026-09-29

The owner answered the seven open questions with "do what you think is the best way forward and continue". Each
recommendation is applied below; where it loosened a check, the recommendation the owner accepted is quoted.

| Change | Evidence |
|---|---|
| **Decision 2. Paused parents on Snapchat, Meta and TikTok** ("yes for Snapchat, whose child reviews already read the parent; Meta and TikTok once their reviews are shown to read it"). All three child creates read the parent in the review (`write-snapshots.ts`: Snapchat the campaign or squad in the path, Meta `campaign_id` or `adset_id`, TikTok the campaign or ad group by ID), so the rule applies to all three: an ad squad, ad set or ad group may start active under a campaign the review reads as paused, and an ad under a paused ad squad, ad set or ad group. An ad whose parent serves is also covered by a paused campaign: only then does the review read the campaign that parent names (the Meta ad set read now asks for `campaign_id`). Checked at prepare and at execute; `PARENT_SERVING` names the parent and campaign statuses. Campaigns still start paused; `allow_activation: false` still refuses any active create. The Snapchat clone keeps each squad's and ad's own status, and the Meta recipe creates its ad set and ad active under the paused campaign (F-107) | `tests/paused-parents-platforms.test.ts`, red first (6 of 7: every child level refused with `PAUSED_CREATION_REQUIRED`; the campaign guard passing), green after (11 of 11): each child level of each platform accepted active under a paused parent, refused under serving parents and accepted paused; a Snapchat squad reviewed under a paused campaign not sent once the campaign serves; campaigns refused active on all three; an active ad under a serving parent covered by a paused campaign, with the campaign read present only then. The test caught a TikTok lookup that took the ad group row for its campaign. `tests/creative-chain-audit.test.ts` pinned the old TikTok refusal of an `ENABLE` creative; that case is now accepted under its disabled ad group, and the two unsafe shapes stay refused before any read. `tests/campaign-clone.test.ts` now expects the source's statuses |
| **Decision 1. All-or-nothing Google builds** ("yes, if atomic builds matter more than a bigger review"; the owner's item 5 asked for all or nothing). `google_ads_v23_google_ads_mutate` is the reviewed family `google_atomic_builds`: up to 1,000 creates of campaign budgets, campaigns, campaign criteria, ad groups, ad group criteria and ad group ads in one request, `partial_failure` false, which Google applies completely or not at all (pinned v25 GoogleAdsService.Mutate). Temporary names only on budgets, campaigns and ad groups and only in parent fields, each created before use. Each operation is checked as its own service's one-operation request; existing parents are read at prepare and execute; paused-parent rules apply to the build's own records; spend confirmation is always required, `allow_activation: false` refuses enabled creates and the new budgets count against budget caps; the outcome needs one typed result per operation; every created resource is read back. A Google clone composes its steps into one `build` step by default (`atomic: false` keeps them), changes and drops applied first (F-108) | `tests/google-atomic-builds.test.ts`, red with the family unregistered (5 of 5), green after (5 of 5): a nine-resource build reviewed, refused without the spending acknowledgement, sent once, replayed without sending, all nine verified under the names Google returned; a refused build leaving nothing and never resent; a serving existing campaign refusing an enabled ad group after reading it; ten malformed builds refused before any read; activation and budget-cap policies refusing. `tests/campaign-clone.test.ts`: the default Google clone as one composed build, then approved once and run as one request, eleven resources verified. Ledger, contracts and report regenerated |
| **Decision 5. A refused all-or-nothing build.** Where a provider's contract proves a refused request applied nothing, the plan no longer has to be cancelled: a `googleAds:mutate` build with `partial_failure` false that Google refuses with HTTP 400, 401, 403, 404, 409, 412 or 422 (the pinned contract applies it "if and only if" every operation is valid) is amended with `recover_step` and reviewed under a new key, audited as `campaign_step_recovered_after_rejection`; the old key stays uncertain and is never sent again. A lost response, a timeout, an HTTP 5xx and every other family's refusal after submission still stop the plan, because their documentation does not establish that nothing was applied (F-109) | `tests/campaign-clone.test.ts`, red on the previous runner (the 400 case), green after: a refused build leaves nothing, its plan names the recovery, is amended (a new budget), approved and run under a new key with all eleven resources verified, the refused request never resent, its key still `uncertain`, the recovery audited; a build answered with HTTP 500 is refused `recover_step` and not resent, before and after |
| **Decision 7. Lapsed ownership renews itself (F-70).** A read, or a write's prepare or inspect, refused because an ownership observation this login made has expired, and whose refusal names the account list narrowed to that one ID, now runs that read and retries once; `meta.ownership_refreshed` names it. An ID the account no longer lists stays refused and no request names it; an ID never observed, or whose observations re-provisioning cleared (a login withdrawn mid-call), still needs the explicit read; execute is never retried; observations still last five minutes | `tests/ownership-refresh.test.ts`, red first (3 of 3), green after (4 of 4): a lapsed creative read in one call (the narrowed list, then the read); an ID the account no longer lists refused with no request naming it and one list read; a never-observed ID refused with no request; a prepare under a lapsed ad squad returning its review. A first version renewed any refusal and broke the in-flight login-withdrawal tests (a withdrawn login must stop the call); the renewal is now limited to observations that expired. The Snapchat, ownership, security, plan and review suites pass (274 tests) |
| **Decisions 3, 4 and 6.** Decision 3: an owner policy with `allow_activation: false` still refuses any active create, under a paused parent too; its refusal now says to keep the status paused or ask the workspace owner. Decision 4: `AMCP_MCP_ALLOWED_ORIGINS` stays empty; `docs/DEPLOY-RAILWAY.md` recommends adding an origin only when the refusal log shows that client refused (a Railway change, not made here). Decision 6: health visibility, mismatch acceptance, the S3 read and the local S4 refusal are kept as built | `tests/google-atomic-builds.test.ts`: the activation refusal names the status and the owner; the spending-policy suites pass (80 tests with it) |

Full qualification of batch 30 (`.release/batch30`, up to `dfaeda8`): **2,876 / 2,876** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 314 s. The candidate's 1,242 source
files equal `dfaeda8`, apart from `release-manifest.json`.

## Batch 31 — the rest of what AMCP could do on its own

On 2026-09-29 the owner asked for the remaining work that needs neither a decision nor live access, and opened the
vendor documentation hosts (Snapchat, Microsoft Learn, Criteo, TikTok, Meta and Google developer sites now answer).

| Change | Evidence |
|---|---|
| **Google lifecycle goals (F-80).** v25 replaced lifecycle goal configuration with goals and campaign goal configs; AMCP now reviews both (`google_lifecycle_goals`). The live Discovery document (revision 20260923) confirms the capitalised `Goals:mutate` and `CampaignGoalConfigs:mutate` paths. A goal is created or updated with exactly one settings block (its type), at most one per type (`GOOGLE_GOAL_EXISTS` names the existing one), never removed; high lifetime values and multipliers need their base and must exceed it. A config links one campaign to one goal with the settings block of the goal's type, is updated by exactly the masked fields, or removed; new customer acquisition with `TARGET_SPECIFIC` takes no overrides. The review reads every goal of the customer and, for configs, the campaigns and their existing configs, validating those reads itself (one page, this customer, only what was asked). Every change needs `spend_change_confirmed`; a removal is a deletion under an owner policy; each result is read back | `tests/google-lifecycle-goals.test.ts`, red first (3 of 3, `WRITE_CONTRACT_UNAVAILABLE`), green after: a goal created and read back, refused without the spending acknowledgement, a second of the type refused, an update of exactly the masked value and one breaking the documented relation refused; a campaign linked, a duplicate link refused, the link updated, a removal refused under `allow_deletion: false` and then removed and verified absent; thirteen documented error shapes refused before any read; type, campaign and goal mismatches refused after reading. Guide examples, the registry, the provider-unavailable notices and the Google suites pass (551 tests) |
| **Remedies by code family (F-28).** 293 refusal codes that no rule names fell to the generic "correct what the message names and send the call again". They now get a remedy by what their name says happened: an unverified state read (retry once, never resubmit an uncertain write), media still processing (`amcp_media status`), media not fetched (link or Drive sharing), a staged upload lost, media the platform does not accept (`inspect_eligibility`), recipe inputs (`recipe_context`), limits (narrow), existing objects (update instead), missing objects (the account's own list), objects in use (remove their uses first), mismatches, reports (never presented as complete), inconsistent pagination, busy jobs, backups, unapproved hosts, changed logins, missing scopes, paused parents, a changed plan (approve again), an unavailable provider, whole-record replacements, revoked access, an open circuit, provider errors, conflicts, forbidden parameters, unavailable routes and invalid values. Rules that name exact codes still win | `tests/error-remedy.test.ts`: 32 representative codes, red first, then each with its own category and next step and none with the generic text; the existing remedy tests unchanged. The same scan of 2,330 refusal sites in `src/`: the generic remedy covered 523 sites (293 codes) before, 38 (33 one-off codes) after. Full suite: 2,880 tests, 0 failures, 5 skipped |
| **Clone for TikTok and LinkedIn (F-110).** `amcp_campaign clone` now reads a TikTok campaign with its ad groups and ads (one ad per step, the fields of TikTok's official create models from its Business API SDK, the campaign DISABLE and its children keeping their status) and a LinkedIn campaign group with its campaigns and creatives (the writable fields of the li-lms-2026-05 schemas, every entity PAUSED, a creative keeping its content). LinkedIn returns a new ID only in `x-restli-id`, while a child names its parent by URN, so a plan reference may now carry `prefix`: only a LinkedIn URN prefix, only over a bare numeric ID, otherwise `INVALID_REFERENCE` before anything is sent. Preflight lists prefixed references as deferred like any other. A 404 for the source group is `CLONE_SOURCE_NOT_FOUND`; a creative returned without content is named in `not_copied` and left out | `tests/campaign-clone-tiktok.test.ts` and `tests/campaign-clone-linkedin.test.ts`, red first on the previous commit (TikTok 4 of 4 `CLONE_UNSUPPORTED`; the LinkedIn file did not compile without `planReference`), green after: the plans' steps and payloads, approve and run completing with every entity read back and each child naming its new parent, sources not found or malformed refused with nothing created, a non-Spark identity on automatic placement stopping at its review, prefixes other than `urn:li:<type>:` refused and a URN-valued reference stopping the run before its step is prepared. All clone suites: 18 tests. Full suite: 2,888 tests, 0 failures, 5 skipped |
| **LinkedIn pages by cursor (F-111).** Found while building the LinkedIn clone: LinkedIn's search and criteria finders return the next page's cursor in `metadata.nextPageToken`, and AMCP followed LinkedIn pages only by `paging.total`, so a list longer than one page came back as its first page, marked complete. `aggregate_pages` now follows the cursor until a page has none; a cursor on a read paged by offset, a malformed or a repeated cursor is refused; offset finders are unchanged. The workspace creative read (`fetch_ads`) used a `q=search` finder the versioned creatives API does not document; it now uses the documented `q=criteria` finder | `tests/pagination.test.ts` and `tests/workflows.test.ts`, red first (2 of 2 on the previous code: one page returned of three; `q=search` sent), green after: three cursor pages merged in order and never given an offset, offset paging unchanged, a repeated cursor refused; the creatives read by campaign and for the account with `X-RestLi-Method: FINDER`, campaign reads still on `q=search`. Full suite: 2,891 tests, 2,885 passed, 5 skipped; the one failure was the tool description test added next (F-30), run before its change was built |
| **Tool descriptions say what AMCP does (F-30).** The captured gateway descriptions stay verbatim for parity, and an AMCP note now follows each one that names a tool, a behaviour or a version AMCP does not have: Meta, TikTok and Snapchat's "prefer named tools such as create campaign…" names `amcp_campaign`, `amcp_write`, `amcp_media` and `amcp_reporting`; DV360's `dv360_reporting_ops` does not exist; every direct tool with `dry_run` writes nothing, whatever `dry_run` says (a write returns its compiled request as a preview, an upload a review); the captured parameters AMCP refuses unless false are named per tool; Google Ads sends v25 although its text says v23. `amcp_tool_help` shows the same description; the listed schemas stay the captured ones, which the parity test still pins | `tests/tool-descriptions.test.mjs`, red first (the new test failed in the previous full suite, before the change was built), green after: the captured text first and verbatim, each note present where its trigger is, help equal to the listing, the captured `skip_preflight` schema unchanged, and the notes' claims checked against behaviour (`skip_preflight: true` refused with `UNSUPPORTED_PARAMETER`; a Meta write with `dry_run: false` and `confirmed: true` not sent). The catalog parity, parameter, media, HTTP and stdio suites pass. Full suite: 2,891 tests, 0 failures, 5 skipped |
| **Ledger re-triage (F-58, part).** Ten unversioned LinkedIn Marketing routes are withdrawn: Microsoft Learn's migrations page records the unversioned Marketing APIs as deprecated on 2024-12-16 and the Content APIs as replacing `adCreativesV2`, and the current pages for campaigns, DMP segments and organization access document only `/rest` (all read 2026-09-29). Each refusal names its versioned action; `/v2/geo` (still documented), `me`, `people`, `endorsement`, `shares`, `ugcPosts` and `adLiftTestBenchmark` stay. Snapchat's raw multipart ADD and FINALIZE are ledgered as steps of the chunked upload `amcp_media` performs, and stay refused. The four family candidates remain | `tests/retired-provider-actions.test.ts`, red first on the previous code (the routes were `blocked_write` or `native_read`), green after: each route refused with `PROVIDER_ACTION_UNSUPPORTED` and its source before any request, each replacement naming an action the catalog has, the ledger marking all ten `provider_unsupported`, and `me`, `geo` and `ugcPosts` unchanged. `tests/snapchat-chunked-media.test.mjs`: the ledger test red first, green after, the raw ADD still refused with `WRITE_CONTRACT_UNAVAILABLE`. Ledger: LinkedIn `provider_unsupported` 0 → 10. Full suite: 2,892 tests, 0 failures, 5 skipped |
| **Website structure (F-43) and the token fold (F-40).** Rendering every route signed in and out in Chromium showed: the Terms and Data deletion pages (and every sign-in page) marked Connections as the current page, because the router defaulted to it; the OAuth pages were titled "Oauth/result"; Settings and Reporting overview skipped from h1 to h3; the owner panels on Settings were inserted above the page title; the sign-in pages' story tagline was an h2 before the h1; the report delivery dialog had no name. All fixed: only /connections and the OAuth flow count as Connections; the platform names and section labels became h2 with CSS that keeps their look; the owner panels follow the page heading; the tagline is display text. `#fff` in the workspace stylesheets is `var(--white)`; `privacy.css` keeps it, since the privacy page does not load the tokens | The audit script (headless Chromium, 19 routes × signed out/in): before, 2 routes skipped a level, 5 began with an h2 and 1 dialog was unnamed; after, none. Screenshots before and after: 29 of 38 pixel-identical, 4 differ between identical runs anyway (timestamps), and the 5 that changed are the intended ones (Terms and Data deletion breadcrumbs, the Settings title first); after the token fold every deterministic page is pixel-identical. `check-web`, red first on the previous files (5 problems: two `content.prepend()`, two headings in the story column, one unnamed dialog; and `#fff` as `var(--white)`), green after. Full suite: 2,892 tests, 0 failures, 5 skipped |
| **Registry pass 3 (F-59, F-60, F-63).** Twelve more families are declared in their modules and listed in `src/reviewed-families.ts` instead of being wired into the lifecycle modules: the seven Snapchat families with their own reviews (offer disclaimers, segment deletions, custom conversions, product sets, dynamic templates, event details, pixel names), DV360 ad assets, Demand Gen ads and SDF downloads, Criteo catalog requests and promoted products. Their spend confirmations, owner-policy effects, scope checks and remembered resources became `spendConfirmation`, `activates`, `destructive`, `scope` and `verifiedResources` hooks, and their named spend-text exemptions became declarations. 71 families are registered, 20 are still named in the exemption, and the lifecycle modules lost 522 lines (27 → 17 and 23 → 13 nested readers). Two recorded differences, both in how a connection that lost a scope between execute and verification is treated: a Criteo brand or seller export now also needs Campaign_Manage before its catalog becomes readable (the registry re-checks the write scope, as for every family), and a DV360 SDF task refuses with `PROVIDER_WRITE_SCOPE_REQUIRED` instead of `INSUFFICIENT_SCOPE` | Neutrality: the full suite ran on the previous commit with eleven lifecycle functions recorded (`applyExecutionRisk`, `authorizeExecution`, `normalizeSnapshot`, `reviewedWriteFamily`, `writeImpact`, `writeOutcome`, `validateState`, `assertWriteShape`, `snapshotPlans`, `verificationReads`, `entity`): 46,187 distinct calls, 2,298 of them touching the Snapchat families. The replay tool first reproduced the baseline build exactly (0 differences), then showed 0 differences for each pass. Authorization order, which the replay does not cover, was checked by hand: each authorizer the moved ones now follow returns false for their requests and reads (guarded by another gateway, kind or read marker). The families' own suites (50 tests) and `tests/reviewed-families.test.mjs` pass; its sanity bound is now that registered and still-wired families together stay at least the 115 counted before, stronger than the old 'more than 50 wired'. Full suite: 2,892 tests, 0 failures, 5 skipped |

Not done here, recorded: the four remaining F-58 candidates (Google customer labels, Meta ad video deletion, TikTok
creative portfolio deletion, X analytics job deletion) are new reviewed families, each to the full standard; 20
families are still named in the spend-text exemption (F-63); folding the 525 one-off tints into a palette changes
pixels, an owner design decision (F-40). Vendor documentation read this batch also shows LinkedIn sunsetting Marketing
version 202510 on 2026-10-15; AMCP sends 202605.

Full qualification of batch 31 (`.release/batch31`, up to `af45263`): **2,892 / 2,892** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 312 s. The candidate's 1,246 source
files equal `af45263`, apart from `release-manifest.json` and npm's own cache logs.

## Batch 32 — work the vendor documentation now allows

On 2026-09-29 the owner asked for the work that had waited on vendor documentation this environment could not reach:
Snapchat's by-ID reads, the LinkedIn version, Criteo 2026-07, Microsoft's move away from SOAP and the sunset dates.

| Change | Evidence |
|---|---|
| **Snapchat by-ID reads (F-101).** Snapchat's "Fetch Multiple" sections for campaigns, ad squads, ads, creatives and media document `POST /v1/adaccounts/{ad_account_id}/get_<entities>_by_ids` with `{"entity_ids": [{"id": …}]}`, up to 2,000 records of the same ad account. The five reads, under both of their names, now send exactly that; any other body is refused before the request with the documented one; a returned record that names another ad account is refused; the reads never make IDs owned (only the account's lists do). The undocumented-route refusal they replaced is gone | `tests/snapchat-reads.test.ts`: the documented body sent once, byte for byte, under both names; seven guessed shapes and 2,001 IDs refused with no request; a record of another account refused; the ledger lists them as reads. On the previous code the documented body itself was refused (`PROVIDER_ACTION_UNSUPPORTED`) |
| **LinkedIn 202609 (F-53).** AMCP sends `LinkedIn-Version: 202609` instead of 202605. LinkedIn's "Recent Marketing API changes" for 202606–202609 are additive for what AMCP sends and reads: campaign group billing, beneficiary and buying type (202608; earlier versions refuse them with 422, which the LinkedIn clone copies), account-level UTM parameters (202608), `CREATIVE_NAME` (202606), new response fields and enum values that AMCP's state checks do not reject (a Campaign Manager conversation's `NOT_INTERESTED` reply option passes the tree checks). The Insight Tag conversion-rule page is unchanged (1, 7 or 30-day windows, the same eight types); the 180-day window and new types belong to Conversions API rules AMCP does not write. Sunset registry: 202609 by LinkedIn's one-year policy, 2027-09 | LinkedIn suites (212 tests) pass with the new header; the tracking-parameter version gates are tested at an explicit 202605 (both refusals) and 202608 (both allowed) instead of relying on the default. The captured evidence fixtures keep the version they record |
| **Criteo 2026-07 (F-51).** Criteo's official 2026-07 OpenAPI document, reachable now, is pinned in place of 2026-01, and one constant (`src/criteo-version.ts`) gives every module the version. Compared operation by operation with the official 2026-01 document: 97 of AMCP's 108 actions are unchanged; the account, campaign and line item reports are replaced by one performance report scoped by `filters.accountIds`, `campaignIds` or `lineItemIds` (Criteo's migration guide), which the three report actions now use with their own scope, renamed dimensions, filter lists, match levels, 100 days for every scope and the 10,000,000-row limit; the campaign family reads balances through the V1 page (`limit-to-id`, `offset`, `limit`; lowercase `spendType`); eight renamed operations are bound by alias to the replacements Criteo's changelog names. Sunset registry: 2026-07 by the 12-month policy, 2027-07 ([the upgrade](../implementation/CRITEO-2026-07-2026-09-29.md)) | Criteo suites (167 tests with the shared delegated, envelope, deadline and sunset suites) pass on 2026-07 paths. The report fixture accepts only the performance report: before the family moved, 17 of the 20 report tests failed (all six journeys among them); 31 inputs are refused (every 2026-01 shape among them) and five 2026-07 inputs accepted. The balance fixture serves only the V1 page: the previous code failed the query test and the review-invalidation test; a 2026-01 spend type, a foreign balance and an incomplete page are refused. Vendor routes regenerate with no gaps |
| **Microsoft REST evidence (F-50).** Microsoft's "Migrate to REST" guide (read 2026-09-29) confirms new features go to REST only from 2026-10-01 and SOAP is deprecated on 2027-01-31, and tells direct API users to take REST URLs and request formats from each operation's reference page. `tools/microsoft-rest.mjs` pins, from those pages' REST sections, the method, production and sandbox URLs and JSON request and response templates of all 28 operations AMCP sends (`.mirror/VENDOR/microsoft-rest-v13.json`, sealed). `microsoftEvidence` now refuses a compiled request whose method, URL or top-level fields differ from its REST page, and adds the REST evidence to the request's contract evidence; the WSDLs remain the type model. All 28 operations already matched: AMCP sent REST, not SOAP | `tests/microsoft-rest-evidence.test.mjs`: the pin is sealed and covers exactly AMCP's operations (the tool's `--check` runs too); each operation's method, URL, request fields and result field match its page; a wrong method, URL, host or an undocumented field is refused with `VENDOR_SCHEMA_UNAVAILABLE`; compiled requests carry the evidence. Before the change three of the four tests failed |
| **Pinned documents in the runtime image (F-112).** The Dockerfile's runtime stage copied `dist`, `generated`, `web` and `Skills` but not `.mirror/VENDOR`, which DV360 (six families), GTM (two) and the Google Ads goal models read at run time; the new Microsoft check reads it for every Microsoft request. The runtime stage now copies `.mirror/VENDOR` (17 MB) | `tests/runtime-image-files.test.mjs` collects every path read through `pinnedJson` and requires the runtime stage to copy it: it failed on `dv360-v4.json` before the Dockerfile change |
| **Sunset dates from the official pages.** Google's "Sunset dates" timetable gives v25 (released 2026-07-22) a sunset of August 2027, now recorded as `official` (the 90-day alarm starts 2027-05-03). Meta's Versions page gives Graph API v26.0 "TBD" and v25.0, the fallback, 2028-07-29 (its Marketing API table does not list v26.0 yet); X Ads API 12 is "TBD" with a six-month deprecation window once a successor is announced; DV360 v4 has no deprecation announced. These stay `unknown` with what the pages say and the date read. Meta's v26.0 changelog adds behavior the SDK comparison of batch 15 could not show: creatives of an advertiser with a shop default to `WEBSITE_AND_SHOP` unless opted out, the Explore placement and poll components are refused, and housing, employment and financial ad sets with relaxable targeting need an explicit `advantage_audience`. These are now in the Meta guide and the contract traps. AMCP's own requests use none of the removed protocol features (`date_format`, root `?ids=`) | `tests/provider-sunsets.test.mjs`: Google's entry is `official` with 2027-08 and the contracts page says so; the basis checks now build a dated `unknown` entry and an undated `official` one explicitly (both still refused), since Google's entry has a date. The sunset tool reports no alarm |

Full qualification of batch 32 (`.release/batch32`, up to `259337e`): **2,901 / 2,901** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 302 s. The candidate's 1,253 source
files equal `259337e`, apart from `release-manifest.json`. Live acceptance by Snapchat, LinkedIn, Criteo and Microsoft
of the changed requests is unverified: no provider was called.

## Batch 33 — the owner's list of 2026-09-29

The owner asked for everything AMCP could do from its side: finish the family registry, Snapchat lifetime budgets,
the four F-58 candidates, Meta's v26.0 changes, the refusal question, the remaining end dates, stale roadmap lines,
and a plan for coverage platform by platform.

| Change | Evidence |
|---|---|
| **Registry finished (F-59, F-60, F-63).** The last 72 families are declared next to their implementation: all 143 are registered, the fifteen lifecycle modules consult the registry once per stage and name no family, the two nested reader chains are composed readers, and the 20 families of the generic spend text match declare their exemption. 4,467 wiring lines removed. Two intended changes: preview and X report redaction run inside the outcome step, and the LinkedIn conversion-link and conversion-rule spend refusals name `spend_change_confirmed=true` | Replay of 46,614 distinct lifecycle calls captured from the full suite on the previous commit: 0 unintended differences, the 130 others the two intended changes recomputed from the baseline; no generic authorizer matches a family request in the capture; `tests/reviewed-families.test.mjs` covers the stage modules and every hook |
| **Snapchat ad squad lifetime budgets (F-55).** `lifetime_budget_micro` is held to the owner's caps in native micros, the unit of Snapchat's ad squad reference | `tests/spend-policy-caps.test.ts`: a lifetime budget above the cap is refused, one within it passes; red before |
| **Meta v26.0 (F-113).** From the v26.0 changelog: the Instagram Explore placement (`META_PLACEMENT_UNAVAILABLE`) and poll components (`META_POLL_UNAVAILABLE`, also at v25.0 from 2026-10-27) are refused before any request; a new Housing, Employment or Financial ad set with relaxable targeting needs `advantage_audience` 0 or 1 (`META_ADVANTAGE_AUDIENCE_REQUIRED`; the review now reads the campaign's `special_ad_categories`); a creative without a destination says in the review that shops default to `WEBSITE_AND_SHOP`, and the creative contract accepts `destination_spec: {destination_type: WEBSITE_AND_SHOP_OPT_OUT}` and no other destination | `tests/meta-v26-rules.test.mjs` (6 tests, red before); the version gates are tested at v25.0 and around 2026-10-27 |
| **Two F-58 families.** `google_customer_labels` removes 1–100 labels from the customer (all or nothing) after reading them under the login customer, and verifies each gone; applying a label stays refused, since v25 marks both `CustomerLabel` fields output only and gives a create no resource name. `meta_ad_videos` removes a video from the ad account library (Meta: "dissociate") after reading every library video and creative, refusing one any creative names (`MEDIA_IN_USE`). TikTok portfolio deletion and X analytics job deletion stay blocked, with the missing evidence named in the ledger | `tests/google-customer-labels.test.mjs` and `tests/meta-ad-videos.test.mjs` (8 tests, red before); the ledger lists both writes under their families |
| **Refusals after submission.** Checked for Snapchat, Meta and TikTok: Snapchat documents multi-record requests as not atomic, Meta's error guide is silent, TikTok's pages are unreadable here. A refused step of these platforms keeps stopping the plan; only Google's all-or-nothing builds recover (F-109) | ROADMAP P6 records the sources; no code change |
| **End dates and stale lines.** Ten more providers carry a checked note in the sunset registry (Snapchat, Apple, Reddit, GA4, GTM, Search Console, Drive, Sheets, Adjust, Business Profile); the platform table's counts, lifecycle cells and the LinkedIn and DV360 notes are brought up to date | `providers:sunsets` passes with no alarm |
| **Coverage plan.** [COVERAGE.md](COVERAGE.md) sorts the 562 blocked writes by the decision each needs, with a recommendation per kind, and orders the 92 candidates by platform. Reading the evidence already removed DV360's five: YouTube asset associations are allowlist-only | Counts reconciled with the ledger per platform |

The first qualification run (`.release/batch33`, up to `5fda403`) failed one test: the guide's contract examples did
not name the two new families; `aa50e6a` adds them. Full qualification of batch 33 (`.release/batch33`, up to
`924fc08`): **2,916 / 2,916** tests and **4 / 4** capture tests; `format:check`, every generated-artifact check and the
Railway check pass. 323 s. The candidate's 1,259 source files equal `924fc08`, apart from `release-manifest.json`. Live
acceptance of the changed requests is unverified: no provider was called.

## Batch 34 — write coverage, first platform pass

The first coverage batch the owner asked for, following [COVERAGE.md](COVERAGE.md).

| Change | Evidence |
|---|---|
| **TikTok pixels (`tiktok_pixels`).** Creation (`pixel_name`, optional `pixel_category`) and renaming of pixels the advertiser owns, from the request fields of TikTok's official Business API SDK and the documented pixel list. Every pixel page is read (up to 200); a name another pixel uses, in any case, is `CONFIGURATION_EXISTS`, which also lets verification find a new pixel by name when the receipt names none; shared pixels are `STATE_TARGET_MISMATCH`. `partner_name` and `advanced_matching_fields` stay outside the contract | `tests/tiktok-pixels.test.mjs` (5 tests, red before) |
| **LinkedIn planning reads.** Audience Insights (`action=audienceInsights`) and Media Planning (`forecastReaches`, `forecastImpressions`, `forecastLeads`) compile as reads a reader can run with writes disabled: the documented fields, facets, objectives and limits, the account in the body as the read scope (`ACCOUNT_SCOPE_MISMATCH` otherwise), and LinkedIn's two required notices in `warnings` | `tests/linkedin-planning-reads.test.mjs` (4 tests, 20 refusals before any request, red before); the catalog-wide compile test gives both routes valid bodies; both are native reads in the ledger |
| **Recorded reasons.** `src/withheld-writes.ts` gives eleven blocked rows their own ledger reason and puts it in the refusal: LinkedIn's unscoped `/rest/creatives` and `/rest/adCampaigns` (six) name the account-scoped actions; X's targeting criterion PUT (X documents no update) says delete and create; Snapchat's per-ID creative PUT names the collection PUT and the JSON Patch; Meta's `DELETE act_{id}/campaigns` deletes by rule, not by ID; and the two F-58 writes blocked on evidence | `tests/withheld-writes.test.mjs` (every case: the inspect carries the reason with no request, and the ledger row matches) |
| **Coverage plan.** 558 blocked writes, 79 candidates; DV360's YouTube asset associations are allowlist-only, so DV360 has no candidate left | Counts reconciled with the regenerated ledger per platform |

Full qualification of batch 34 (`.release/batch34`, up to `a9016a9`): **2,927 / 2,927** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 336 s. The candidate's 1,265 source
files equal `a9016a9`, apart from `release-manifest.json`. Live acceptance is unverified: no provider was called.

## Batch 35 — the owner's decisions and the X report fix

The owner's message of 2026-09-29: decisions on the coverage plan, the X report failure, and the conditions for
Meta's shop opt-out and budget schedules. The decisions are recorded in [COVERAGE.md](COVERAGE.md).

| Change | Evidence |
|---|---|
| **X reports (F-114).** Every X report on the website failed with `PROVIDER_REPORT_FAILED`. AMCP sent analytics times with fractional seconds (`2026-09-21T21:00:00.000Z`), and X refuses them. X times are now whole hours in ISO 8601 without fractional seconds. A range is widened to whole hours with a warning, and the workflow assigns each hour by its midpoint | `tests/x-analytics-time.test.mjs` (red before) |
| **Meta shop opt-out, on the owner's conditions.** Only `{destination_type: "WEBSITE_AND_SHOP_OPT_OUT"}` is accepted, and only from Graph API v26.0. The source is Meta's v26.0 changelog; the SDK types the field as a free string. AMCP never sets it; the review says "People go to your website only, not your Meta shop". It is verified on read-back, or against the write response when the read omits it (inconclusive, never passed silently). **F-115:** new ads and ad updates name an existing creative as `{creative_id}` only, since an inline creative skipped the creative contract | `tests/meta-shop-opt-out.test.mjs` (4 tests, red before); `tests/meta-v26-rules.test.mjs` updated |
| **Meta budget schedules (`meta_budget_schedules`, F-116), on the owner's conditions.** A spending policy is required (`POLICY_REQUIRED`). The peak, including periods already scheduled over part of the new one, is held against the caps at prepare. The review gives the account time zone (never assumed) and the maximum extra spend, and says that Meta documents no API update or deletion. `spend_change_confirmed` is required, and the schedule list is read back. Meta's limits are checked before any write. `budget_schedule_specs` on campaign and ad set requests is refused | `tests/meta-budget-schedules.test.mjs` (8 tests, red before) |
| **Decisions recorded and personal-data policy drafted.** COVERAGE.md records each decision with its date and state. [PERSONAL-DATA-POLICY.md](PERSONAL-DATA-POLICY.md) is a one-page draft for approval: hashing in memory, counts only, owner-only and off per account, consent and platform terms, removal, and the law of the people in the list (Saudi PDPL). Nothing is opened | Platform facts from Google Ads v25 discovery and Meta's Business SDK 26.0.2 |

The first qualification of batch 35 failed one test (2,942 / 2,943): the v26.0 removed-names check found
`time_start` in the budget schedule module. v26.0 removed `AdSet.time_start`, the ad set's own field, while the
parameter of `/budget_schedules` stays in SDK 26.0.2. The test now asserts that no removed parameter is on that edge and
allows the name only from that module (`b062124`).

Full qualification of batch 35 (`.release/batch35b`, up to `b062124`): **2,943 / 2,943** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 314 s. The candidate's 1,270 source
files equal `b062124`, apart from `release-manifest.json`. Live acceptance is unverified: no provider was called.

## Batch 36 — the owner's media and navigation requests

The owner's message of 2026-09-29, item 7: choose several images and videos at once, bring in Google Drive files and
folders, name accounts by name and ID instead of "linkedin 55864214", and send to several platforms at once, for
uploads and Drive alike.

| Change | Evidence |
|---|---|
| **Several files at once.** *Push creatives* takes several files in one choice and uploads them one after another. It adds files from a link, a recent upload or Drive, and reviews every file for every chosen account (files × accounts, at most 200, planned 20 destinations at a time). Each file keeps its own name when there are several | Chromium against a local server with synthetic data (scratchpad `push-smoke.mjs`): two files uploaded in one choice, two Drive folder files imported, 4 files × 2 Meta accounts = 8 review rows ready, no console errors, no page overflow at 360 px |
| **Waiting uploads bounded by bytes.** The four-per-workspace count would have stopped a multi-file push at its fifth file. The bound is now bytes: four times the media limit per workspace and eight in all, with 25 and 50 files at most. A finished upload counts its size and one still arriving counts the whole limit, so the worst case is unchanged | `tests/media-sources.test.ts` (25 small finished uploads fit, the 26th and a fourth unfinished upload are refused; red before); the earlier four/eight test passes unchanged |
| **Google Drive files and folders.** A Drive login may select folders as well as files. The panel lists a selected folder's downloadable media (Drive `files.list`, `'<folder>' in parents`, at most 500) and imports a file only after Drive's metadata names the folder among its parents. Imports land in the same encrypted upload store, through two POST routes with the session's CSRF and origin checks. A sync of one kind never drops the other's selection | `tests/drive-folders.test.mjs` (4 tests: listing, refusals before any request, parent check, import as an upload; red before); `tests/drive-folder-selection.test.mjs` (selection, file-only sync keeps folders, other platforms keep one kind; red before); `tests/private-media.test.ts` unchanged and passing |
| **Several platforms at once.** Accounts are grouped by platform, each group with an "Every <platform> account" box, in one selection for uploads and Drive files alike | The smoke run checks both Meta accounts through the platform box |
| **Account names (F-117).** LinkedIn discovery reads each account's own name; the website shows "Name (ID)" wherever it lists accounts | `tests/account-names.test.mjs` (red before); `tests/website.test.ts` pagination fixture answers the per-account read |

Full qualification of batch 36 (`.release/batch36`, up to `0ac51f4`): **2,951 / 2,951** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 315 s. The candidate's 1,273 source
files equal `0ac51f4`, apart from `release-manifest.json`. Live acceptance is unverified: no provider was called, and
the Drive and LinkedIn reads were exercised against synthetic replies only.

## Batch 37 — Meta catalogs

The owner's decision of 2026-09-29: "Product catalogs: make it available". Meta first. Every family writes only
catalogs of the selected ad account's business and needs `catalog_management` (Meta app review) with
`ads_management`. The defaults of the Meta login are unchanged: the owner adds the scopes to `AMCP_META_SCOPES`.

| Change | Evidence |
|---|---|
| **Product sets (`meta_product_sets`).** Create, change and delete, from the "Product Catalog Product Sets" reference and SDK 26.0.2. The filter grammar is checked, then Meta is asked whether the filter selects any product; a filter Meta refuses stops the review with Meta's message. A set that the account's ad sets or creatives use is not deleted, and a change that would empty a set active ad sets use is refused (`PRODUCT_SET_EMPTY`) | `tests/meta-product-sets.test.mjs` (6 tests; 5 fail with the family unregistered) |
| **Catalog products (`meta_catalog_products`).** One product at a time. Meta's `allow_upsert` defaults to true, silently replacing an existing `retailer_id`; AMCP replaces one only with an explicit `allow_upsert: true` and shows before and after, prices in currency units. Prices read back as formatted text, so Meta confirms the price through its numeric `price_amount` filter | `tests/meta-catalog-products.test.mjs` (5 tests, including a price Meta did not keep while every text field matched) |
| **Product feeds (`meta_product_feeds`).** Create, change and delete scheduled feeds. `deletion_enabled` must be chosen, since Meta turns it on by default and it cannot be turned off. HTTPS schedules carry no credentials. Deleting quotes Meta: "effectively disables all ads using products that come from this feed" | `tests/meta-product-feeds.test.mjs` (6 tests) |
| **No counts in review state.** A review compares its state again before it executes, and feed runs change catalog counts. The reviews keep the catalog's name, vertical and business, and whether a filter selects anything | Product set test: counts change between prepare and execute, and it still executes |

Full qualification of batch 37 (`.release/batch37`, up to `cb7a849`): **2,968 / 2,968** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 324 s. The candidate's 1,280 source
files equal `cb7a849`, apart from `release-manifest.json`. Live acceptance is unverified: no provider was called, and
catalog writes need `catalog_management`, which Meta grants only after app review.

## Batch 38 — Snapchat catalogs; why TikTok catalogs wait

The owner's decision of 2026-09-29, continued. Evidence: Snapchat's "Dynamic Product Ads" reference, read 2026-09-29.

| Change | Evidence |
|---|---|
| **Snapchat catalogs (`snapchat_catalogs`).** Create, update and delete COMMERCE catalogs of the ad account's organization, one at a time, with pixels of the ad account as event sources. An update sends the whole object, keeps the vertical and names any event source it drops. An organization holds at most 200 catalogs (`CONFIGURATION_LIMIT`). The reference does not say what deleting a catalog does to its feed, sets and ads, so only an empty catalog is deleted (`CATALOG_NOT_EMPTY`, with its own remedy) | `tests/snapchat-catalogs.test.mjs` (5 tests) |
| **Snapchat product feeds (`snapchat_product_feeds`).** A catalog's one feed: create, whole update and delete. Schedules follow the reference's interval table, over HTTPS and without credentials. Supplemental feeds and feed uploads stay refused; the deletion review says the reference does not state what becomes of the feed's products | `tests/snapchat-product-feeds.test.mjs` (4 tests) |
| **TikTok catalogs blocked on evidence.** TikTok's docs portal, rendered in Chromium, shows only Reporting and Authentication without signing in, and the official SDK gives request fields without responses or meaning. The twenty catalog writes carry that reason in the ledger and in their refusal | `tests/withheld-writes.test.mjs` (two TikTok catalog cases) |
| **Two test fixes.** The budget schedule test failed late in the UTC evening, when its 6-hour period crossed midnight in Riyadh and correctly touched two days; it now starts at 06:00 Riyadh. The Meta feed family compared schedules as JSON text, which depends on key order; it now compares stable forms | `tests/meta-budget-schedules.test.mjs` 8/8 at an hour that failed before; `tests/meta-product-feeds.test.mjs` 6/6 |

Full qualification of batch 38 (`.release/batch38`, up to `03f78b3`): **2,977 / 2,977** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 317 s. The candidate's 1,284 source
files equal `03f78b3`, apart from `release-manifest.json`. Live acceptance is unverified: no provider was called, and
the Snapchat catalog writes need an Organization Admin.

## Batch 39 — X catalogs; Meta catalogs themselves

The owner's decision of 2026-09-29, continued. Evidence: X's "Catalog Management" overview and API reference
(docs.x.com, read 2026-09-29, with parameter names from the raw reference); Meta's "Business Owned Product Catalogs"
and "Product Catalog" references, v26.0, read 2026-09-29.

| Change | Evidence |
|---|---|
| **X catalog scope.** An X catalog is "associated with the user's handle", one per user. AMCP reads the account's promotable users, then each FULL user's catalogs. It writes only those catalogs, through internal reads limited to the exact shapes its readers build | `tests/x-product-catalogs.test.mjs` (5 tests, including the read shapes that are refused) |
| **X catalogs (`x_product_catalogs`).** Created for a promotable user without one (`CONFIGURATION_EXISTS` otherwise) and renamed. Deleted only when empty (`CATALOG_NOT_EMPTY`), since X does not say what deletion does to the contents | as above |
| **X product sets (`x_product_sets`).** Filtered sets take 1 to 30 filters from the documented attributes and operators. Manual sets take 1 to 50 product keys, shown by title. Only manual sets are updated. Changes and deletions warn that X documents no link between ads and sets | `tests/x-product-sets.test.mjs` (6 tests) |
| **X scheduled feeds (`x_scheduled_feeds`).** One feed per user, with X's repeat rules, HTTPS without credentials. A change to DAILY is refused, since X documents no way to clear `repeat`. The deletion review quotes X's additive import rule | `tests/x-scheduled-feeds.test.mjs` (4 tests) |
| **X products (`x_catalog_products`).** One product per request: create or replace by id, delete by key. The review says which, and lists attributes with a value that the request does not send. Variants stay outside, since X lists one product of a group. X has no lookup by id, so AMCP finds products within the first 1,000 (`CATALOG_SCAN_LIMIT`, with its own remedy) | `tests/x-catalog-products.test.mjs` (4 tests) |
| **X JSON bodies.** Product and product set writes are sent as JSON, as X's reference says; catalogs and feeds keep form parameters | The product, set and feed tests check the content type sent |
| **Meta catalogs (`meta_product_catalogs`).** Commerce catalogs are created under the account's business, changed (name, display settings, images) and deleted. AMCP never sends `allow_delete_catalog_with_live_product_set`, and refuses `partner_integration`, which carries an access token | `tests/meta-product-catalogs.test.mjs` (4 tests) |

Red before: with the families unregistered, 18 of the 19 X tests and all 4 Meta tests fail. The X test that still
passes is a shape refusal, which holds either way. The ledger moves exactly the eleven X catalog routes and the three
Meta catalog routes (771 reviewed, 526 blocked).

Full qualification of batch 39 (`.release/batch39`, up to `c75f138`): **3,000 / 3,000** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 317 s. The candidate's 1,296 source
files equal `c75f138`, apart from `release-manifest.json`. Live acceptance is unverified: no provider was called. X's
catalog endpoints are early access, and Meta's catalog writes need `catalog_management` after app review.

## Batch 40 — Criteo creatives; reasons for the remaining Criteo, DV360, Google and Business Profile candidates

| Change | Evidence |
|---|---|
| **Criteo creatives (`criteo_creatives`).** Create, and whole update keeping retailer and template, from the pinned 2026-07 document (Criteo's Creatives guide page has no text). AMCP reads the retailer among the account's retailers and the template. The template read is the only one outside the account, allowed only for the retailer the search returned. Every value is checked against the template, including variables that a chosen option unlocks. Updates name the line items that use the creative | `tests/criteo-creatives.test.mjs` (5 tests; 4 fail with the family unregistered) |
| **Google campaign bid modifier creation: reason recorded.** The v25 discovery document marks `campaign` output-only and expects no resource name on create, and Google's code samples show no campaign bid modifier creation. The family's own comment already kept creation out; the refusal now says why | `tests/withheld-writes.test.mjs` |
| **DV360: reasons recorded.** The YouTube asset association writes are allowlist-only ("only available to an informed subset of users"). A Floodlight group patch needs a partner context and governs conversion counting for every advertiser in the group | as above |
| **Criteo supply side: reasons recorded.** Keyword review is the retailer reviewer's step ("not applicable for demand accounts"), and the fill rate, revenue and unfilled placement reports belong to Supply Side Reporting | as above, with a Criteo test of the refusal and the ledger |
| **Business Profile verification completion: reason recorded.** Account setup, which the owner kept blocked. The key is the compiled `gmb_verification_ops/COMPLETE_VERIFICATION`, found by logging the ledger's compiled action | as above |

The ledger holds 773 reviewed and 524 blocked writes; 42 blocked writes carry a recorded reason, and 66 candidates
remain (LinkedIn 28, TikTok 22, Meta 7, Snapchat 7, X 2).

Full qualification of batch 40 (`.release/batch40`, up to `8233c11`): **3,006 / 3,006** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 319 s. The candidate's 1,298 source
files equal `8233c11`, apart from `release-manifest.json`. Live acceptance is unverified: no provider was called.

## Batch 41 — reasons for the remaining TikTok, X and Meta candidates

| Change | Evidence |
|---|---|
| **31 reasons recorded.** Nineteen TikTok writes blocked on evidence, as the catalogs were. Automated rules (Meta and TikTok), unreviewable by design. Meta recommendations, applied by signature. Meta account tracking specs and business event source groups, with no update or deletion. X Do Not Reach lists and TikTok pixel events, personal data. Meta `POST adpreviews` (not in the SDK), Meta user-level ad studies (outside the account's business) and LinkedIn `/rest/example` (not documented) | `tests/withheld-writes.test.mjs` (a new test checks all 31 ledger reasons, counts 40 TikTok evidence reasons, and inspects one refusal before any request); the ledger changes exactly 31 reasons and no status |

73 blocked writes carry a recorded reason, and 35 candidates remain (LinkedIn 27, Snapchat 7, Meta 1).

Full qualification of batch 41 (`.release/batch41`, up to `60a4632`): **3,007 / 3,007** tests and **4 / 4** capture
tests; `format:check`, every generated-artifact check and the Railway check pass. 319 s. The candidate's 1,298 source
files equal `60a4632`, apart from `release-manifest.json`.

## Batch 42 — Meta automated rules (owner decision of 2026-09-30)

The owner unblocked automated rules and approved the personal-data policy on 2026-09-30 ("unblock, approved";
"Approved"). Evidence: Meta's Ad Rules Engine pages (overview, evaluation, execution and change specs, schedule-based
and trigger-based rules, rebalancing, API calls), read 2026-09-30.

| Change | Evidence |
|---|---|
| **Meta automated rules (`meta_ad_rules`).** Create, full or status-only update, and delete. Filters, triggers, actions, execution options and schedules are checked against Meta's references; PING_ENDPOINT is refused. A rule that can raise spend or delivery names its objects of the account with an `id` filter, carries `change_spec.limit` for increases, needs a spending policy whose caps bound each object's worst case, and needs `spend_change_confirmed`. Read back by rule | `tests/meta-ad-rules.test.mjs` (4 tests, all red with the family unregistered) |
| **Rule update and delete routes.** The captured catalog maps only creation; AMCP adds Meta's documented `POST` and `DELETE /{ad_rule_id}` so a rule AMCP creates can be stopped through AMCP | as above, with the ledger rows |
| **TikTok rules stay blocked on evidence.** TikTok's rule pages cannot be read without signing in, so no review could bound a TikTok rule | `tests/withheld-writes.test.mjs` |

The ledger holds 776 reviewed and 523 blocked writes.

## Batch 43 — personal-data foundation; Meta customer lists

Under the personal-data policy the owner approved on 2026-09-30. Evidence: Meta's Custom Audience Users, Customer File
Custom Audiences, Custom Audience Terms Of Service and CustomAudience pages, read 2026-09-30; Google Ads API
deprecations and the Customer Match guide, and the Data Manager API v1 reference and discovery document, read
2026-09-30.

| Change | Evidence |
|---|---|
| **People beside the request, hashed in memory.** `amcp_write` takes `people` at prepare and again at execute, never inside `arguments`. Emails are trimmed and lower-cased; phones must be E.164. Pre-hashed values must be SHA-256 hex. Invalid rows are refused and counted, and duplicates removed. One upload holds at most 10,000 rows | `tests/meta-customer-lists.test.mjs` (7 tests, all red with the family unregistered) |
| **The review keeps counts and a digest, never the people.** Execution hashes the people again and refuses another batch (`PERSONAL_DATA_CHANGED`). The test searches every document, audit row, idempotency record and job for the emails and their hashes after prepare, execution, verification, refusals and a platform error, and finds none | as above |
| **Error audit and replies scrubbed.** The catch-all error audit keeps only the number of rows, and scrubs the arguments of a request that carries people. Replies and errors are scrubbed of hashes and e-mail addresses. Meta's `invalid_entry_samples` are dropped | as above (a Meta error quoting a hash and an email) |
| **The owner's switch and approval.** `amcp_workspace enable_personal_data` / `disable_personal_data`, one ad account at a time, off by default. Turning one off stops reviews already prepared. An operator prepares an upload and only the owner executes it; the owner may execute a personal-data review a member prepared. The integrity fingerprint is now bound to the preparer, which is the executing actor for every other review. An operator may run a removal | as above |
| **Confirmations for adding people.** Countries of the people (a list with none is refused), the law AMCP names for SA, AE, the EEA and GB or the uploader names elsewhere, consent, the platform's terms, and the PDPL's three confirmations for SA | as above |
| **Meta customer lists (`meta_customer_lists`).** Empty CUSTOM lists are created; people are added and removed with `EMAIL_SHA256`, `PHONE_SHA256` or the multi-key form in a one-batch session. Meta's `tos_accepted` and the list are read first: a list of the account, subtype CUSTOM, not value-based, not flagged (471), replacing (414) or orphaned (470). Verification uses Meta's counts, the approximate size and `delivery_status` | as above; `tests/meta-lookalikes.test.mjs` now expects a CUSTOM body to be refused by this family, still before any request |
| **Reasons recorded.** Google Customer Match (seven routes) is refused by Google since 2026-04-01 for projects new to it, and its replacement needs owner decisions. DV360, LinkedIn and TikTok customer lists wait their turn. Meta `usersreplace` is a 90-minute session | `tests/withheld-writes.test.mjs` (a new test of the ten reasons) and `tests/meta-customer-lists.test.mjs` (`usersreplace`); the ledger changes exactly these reasons and the two Meta people routes |

The ledger holds 778 reviewed and 521 blocked writes; 83 blocked writes carry a recorded reason. Live acceptance is
unverified: no provider was called.

Full qualification of batches 42 and 43 (`.release/batch43`, up to `808712b`): **3,019 / 3,019** tests and **4 / 4**
capture tests; `format:check`, every generated-artifact check and the Railway check pass. 342 s. The candidate's 1,305
source files equal `808712b`, apart from `release-manifest.json`.

## Batch 44 — Meta offline conversions

Under the personal-data policy the owner approved on 2026-09-30, conversions after customer lists. Evidence: Meta's
Using the Conversions API, Server Event, Customer Information and Custom Data parameter pages and the Meta Pixel
reference, read 2026-09-30.

| Change | Evidence |
|---|---|
| **Rows that carry an event.** A family may declare fields beside the people's keys. Each row is then an object; the fields are validated, sent as they are and kept only inside the digest. A family may also refuse rows that do not go together, check the batch against the time at prepare and execution, and show an aggregate in the review | `tests/meta-offline-conversions.test.mjs` (3 tests, all red with the family unregistered) |
| **Meta offline conversions (`meta_offline_conversions`).** Standard events from email, phone, chat, store, system, messaging or other sources, with value and currency (required for Purchase) and event_id. Sent as `user_data` em and ph hashes, up to 1,000 per request, to a pixel of the account read first (`STATE_TARGET_MISMATCH`). Events older than 7 days (62 for store events) or in the future stop the upload. The review shows counts by event and source, value by currency and the time range. It says a conversion cannot be recalled. Verified by Meta's `events_received` | as above; the test searches every document, audit row, idempotency record and job for the people after prepare, execution, verification, refusals and a rejected batch |
| **Inspect checks the contract, not the clock.** The time window is checked at prepare and execution, so the guide's inspection example does not age out | as above, and `tests/guide-contract-examples.test.mjs` |

The ledger holds 780 reviewed and 519 blocked writes. Live acceptance is unverified: no provider was called.


Full qualification of batch 44 (`.release/batch44`, up to `a88d408`): **3,022 / 3,022** tests and **4 / 4** capture tests;
`format:check`, every generated-artifact check and the Railway check pass. 329 s. The candidate's 1,307 source files
equal `a88d408`, apart from `release-manifest.json`.

## Batch 45 — Snapchat claim media; reasons for Google conversions and four Snapchat candidates

Evidence: Snap's Claim Media, Creative Elements, Interaction Zones, Campaigns and Public Profile API Profiles pages;
Google Ads API deprecations and the v25 discovery document; all read 2026-09-30.

| Change | Evidence |
|---|---|
| **Snapchat claim media (`snapchat_claim_media`).** An organic Snap claimed into the selected ad account by its Snap ID, the only parameter. The ad account is read first. Verification reads the new media and checks its ad account. Both catalog names of the route are covered | `tests/snapchat-claim-media.test.mjs` (3 tests, all red with the family unregistered) |
| **Google conversion reasons.** Click conversions are refused by Google since 2026-06-15 for projects new to offline conversion uploads, and the Data Manager API needs the owner's decision on its OAuth scope. Call conversions send the caller's phone number unhashed, which the personal-data policy forbids | `tests/withheld-writes.test.mjs` |
| **Snapchat reasons.** Claims by ad code (brand profiles live on Snap's Business API host), creative elements (no documented read), interaction zones (built from those elements) and ad squad UI render data (no documented request) | `tests/snapchat-claim-media.test.mjs` |

The ledger holds 782 reviewed and 517 blocked writes; 91 blocked writes carry a recorded reason. Candidates left:
LinkedIn 27, Snapchat 1 and Meta 1. Live acceptance is unverified: no provider was called.


Full qualification of batch 45 (`.release/batch45`, up to `5fb45f2`): **3,025 / 3,025** tests and **4 / 4** capture tests;
`format:check`, every generated-artifact check and the Railway check pass. 327 s. The candidate's 1,309 source files
equal `5fb45f2`, apart from `release-manifest.json`.

## Batch 46 — Google Customer Match and offline click conversions (owner decision of 2026-09-30)

The owner answered both Google questions ("Confirm on google"). AMCP asks for Google's `datamanager` permission, and
sends the uploader's own confirmation of Google's Customer Match terms as the upload's terms field, never its own.

Evidence: Google's Data Manager API v1 reference (audienceMembers.ingest and remove, events.ingest,
requestStatus.retrieve, Destination), its discovery document, the formatting, consent and request-status guides, and
the Google Ads API deprecations and Customer Match guides; all read 2026-09-30.

| Change | Evidence |
|---|---|
| **Google Customer Match (`google_customer_match`).** People added to and removed from a Customer Match list through the Data Manager API, up to 10,000 per request, with emails and phones formatted as Google's guide says (gmail.com dots and `+` suffixes removed, E.164 phones with the plus sign). The list is read first through the Google Ads API: Customer Match, contact information, not read-only, open for additions, under a client customer. Additions need Google's consent from the uploader and the owner at execution. The terms field is sent only with `platform_terms_confirmed`. Removals take neither | `tests/google-data-manager.test.mjs` (5 tests, 4 red with the families unregistered; the fifth checks the normalizers) |
| **Google offline click conversions (`google_offline_conversions`).** Events by hashed email or phone, or by one click ID, up to 2,000 per request, to an enabled UPLOAD_CLICKS conversion action of the customer read first. Value and currency go together. Events older than 90 days or in the future stop the upload. The review shows the events in aggregate and says a conversion cannot be recalled | as above |
| **One request, built by AMCP.** The body comes from the reviewed people and settings, and a body that differs is refused. The manager login travels in each destination (`loginAccount`) instead of Google Ads headers, and the developer token is not sent to the Data Manager API. The reply is kept as the request ID and a warning count | as above; the test searches every document, audit row, idempotency record and job for the people |
| **Verification by request status.** `pending` while Google processes. `verified` when Google reports success for every record sent. Otherwise failed or unverified, with Google's error counts and, for lists, its match-rate range | as above |
| **Privacy page.** It now says what customer-list and offline-conversion uploads do: people hashed with SHA-256 in memory and sent to the platform, and only counts, a digest and the confirmations kept. It also names the `datamanager` permission. Google's OAuth verification of that scope reads the policy. The owner, with counsel, should confirm the wording before submitting | `tests/privacy-policy.test.ts` (red without the disclosure) |
| **Permission and origin.** The `datamanager` scope is requested for Google only when writes are enabled. Both scopes are needed (`INSUFFICIENT_SCOPE` names the missing one). The Data Manager origin is allowed for Google only, and a direct request-status read is refused without a resource binding | as above, and `tests/withheld-writes.test.mjs` (the nine replaced Google Ads API routes name their replacement) |

The ledger holds 785 reviewed and 517 blocked writes, and one more read. Live acceptance is unverified: no provider
was called. Before the first upload, the owner does four things outside AMCP:

- Enable the Data Manager API in the Google Cloud project.
- Add the scope to the project's data access. It is a sensitive scope, so Google's OAuth verification is needed.
- Make sure Google's Customer Match terms are accepted for the account.
- Reconnect Google in AMCP.

Full qualification of batch 46 (`.release/batch46`, up to `5df595f`): **3,030 / 3,030** tests and **4 / 4** capture tests;
`format:check`, every generated-artifact check and the Railway check pass. 329 s. The candidate's 1,312 source files
equal `5df595f`, apart from `release-manifest.json`.

## Batch 47 — LinkedIn brand lift tests; reasons for LinkedIn audience and media plan writes

Evidence: LinkedIn's Brand Lift Testing pages (Overview, Lift Test Management API, Lift Test Survey Management API),
Matched Audiences pages (Getting Access, DMP Segments, Destinations, Companies, Ad Segments, Website Retargeting,
Predictive Audiences), Engagement Retargeting, Manage Media Plans (Microsoft Learn, li-lms-2026-09), and Meta's
Business SDK for v26.0; all read 2026-09-30.

| Change | Evidence |
|---|---|
| **LinkedIn brand lift tests (`linkedin_lift_tests`).** A test is created as DRAFT on the selected account or 1–50 of its campaign groups (202511 and later), scheduled from 00:00 to 23:45 UTC, 3 to 90 days within 180. It is updated by execution state: before scheduling everything but the account; afterwards only name, description, schedule with the same start, and userState. ENDED and CANCELED tests are immutable. READY needs one to six survey questions (read first), spending confirmation, and counts as activation; the review lists the account's resumable tests it ends. CANCELED warns that it cannot be undone. Tests and their survey questions are deleted only before scheduling, and both count as deletions under owner policies. Everything is read back. LinkedIn names the deletable state PENDING, which is not among its documented execution states, so AMCP accepts CREATED or PENDING | `tests/linkedin-lift-tests.test.mjs` (5 tests, all red with the family unregistered) |
| **LinkedIn reasons.** Seven writes need `rw_dmp_segments`, an Audiences program permission "not granted automatically": page sets, segment sources, predictive audiences and destinations. Company lists need it too, and are customer lists under the personal-data policy. Ad segment updates wait with them, because the pages disagree on their permission. Media plans need `rw_media_plans`. Creating lift test survey questions has no documented body | `tests/withheld-writes.test.mjs` (red without the reasons), `tests/linkedin-lift-tests.test.mjs` |
| **Meta ad place page sets.** Created and read only (SDK 26.0), with no update or deletion, so permanent through the API | `tests/withheld-writes.test.mjs` |

The ledger holds 792 reviewed and 510 blocked writes; 103 blocked writes carry a recorded reason. Candidates left:
LinkedIn 9 and Snapchat 1.

- LinkedIn: engagement retargeting through DMP segments and engagement rules, which needs only `rw_ads` per its page,
  and two POST reads.
- Snapchat: the ad squad targeting specs.

Owner decisions this batch raises: whether AMCP should request LinkedIn's `rw_dmp_segments` (Audiences program) and
`rw_media_plans` (Media Planning program), each also needing LinkedIn's approval. Live acceptance is unverified: no
provider was called.

Full qualification of batch 47 (`.release/batch47`, up to `df65103`): **3,036 / 3,036** tests and **4 / 4** capture tests;
`format:check`, every generated-artifact check and the Railway check pass. 343 s. The candidate's 1,314 source files
equal `df65103`, apart from `release-manifest.json`.

## Batch 48 — LinkedIn engagement retargeting audiences

Evidence: LinkedIn's Engagement Retargeting and DMP Segments pages (Microsoft Learn, li-lms-2026-09), read 2026-09-30.
Engagement Retargeting names `rw_ads`; DMP Segments names `rw_dmp_segments`. AMCP requests `rw_ads`, and the guide
says what a permission refusal would mean.

| Change | Evidence |
|---|---|
| **LinkedIn engagement retargeting audiences (`linkedin_engagement_audiences`).** DMP segments of type USER that collect ad engagement (video, lead form, single image, document and conversation ads) with the LINKEDIN destination: created, renamed (name, description and sourceSegmentId, the only fields LinkedIn updates) and deleted singly or in batches of up to 25. Engagement rules take a campaign of the account as the source, the documented triggers of the segment's source type and a lookback of 30–365 days, one trigger and lookback per segment and each source once; they are added and removed singly or in batches. Segments of uploaded people stay blocked under the personal-data policy, as do company, event and website sources | `tests/linkedin-engagement-audiences.test.mjs` (5 tests, all red with the family unregistered) |
| **No audience deleted from under a campaign.** LinkedIn deletes a segment's ad segment with it. AMCP reads the account's live campaigns first (active, paused and draft; up to 5,000) and refuses while any targets that ad segment | as above |
| **No judgement on part of a list.** Engagement rules are read a page of 100 at a time. A segment with a full page stays unverified, rather than being checked against part of its rules | as above (red without the check) |

The ledger holds 799 reviewed and 503 blocked writes. Candidates left: LinkedIn 2 (two POST reads) and Snapchat 1
(targeting specs). Live acceptance is unverified: no provider was called.

Full qualification of batch 48 (`.release/batch48`, up to `6f3caec`): **3,041 / 3,041** tests and **4 / 4** capture tests;
`format:check`, every generated-artifact check and the Railway check pass. 329 s. The candidate's 1,316 source files
equal `6f3caec`, apart from `release-manifest.json`.

## Batch 49 — Snapchat targeting specs; the last LinkedIn candidates

Evidence: Snap's Audience Targeting page ("Targeting Specs - Greater than 500 rows"), LinkedIn's Manage Audience
Restrictions and Ad Preview pages; all read 2026-09-30.

| Change | Evidence |
|---|---|
| **Snapchat targeting specs (`snapchat_targeting_specs`).** The one GEO spec of an ad squad with more than 500 criteria is replaced. Geo entries name a country and its operation, with at most one list of regions, metros or postal codes; there are at most 4,000 criteria and at least one inclusion. The ad squad (owned through the account's list), its campaign (the selected account) and the current spec are read first. The ad squad is active or paused, and keeps a GEO spec with that ID. The same locations in another order or case are unchanged. The review shows criteria before and after, countries, and entries added, removed and kept. Execution needs spending confirmation. The read-back compares locations in any order and case | `tests/snapchat-targeting-specs.test.mjs` (4 tests, all red with the family unregistered) |
| **LinkedIn reasons.** `globalPublisherList` is a read of the global publisher list through a signed download on www.linkedin.com, naming no account. `adPreviews?action=livePreviewForCreative` previews a creative not yet created, named by a campaign AMCP does not track for reads | `tests/withheld-writes.test.mjs` |

The ledger holds 800 reviewed and 502 blocked writes, and 105 blocked writes carry a recorded reason. No candidate
is left: every blocked write waits on an owner decision by kind, or carries its own reason. Live acceptance is
unverified: no provider was called.

Full qualification of batch 49 (`.release/batch49`, up to `11b40d6`): **3,045 / 3,045** tests and **4 / 4** capture tests;
`format:check`, every generated-artifact check and the Railway check pass. 329 s. The candidate's 1,318 source files
equal `11b40d6`, apart from `release-manifest.json`.

## Batch 50 — personal-data error boundaries and current platform review

Branch: `Codes-final-branch`; baseline `c615cb7`. No provider, credential, production, Railway or DNS change.

- F-118: personal-data error audits withhold the entire native arguments object for known personal-data actions
  and for any `amcp_write` request carrying `people`. Unchecked `personal_data` confirmation objects are also withheld in error audits. This covers raw phones/names misplaced in arguments even
  when compilation refuses them. The recursive response scrubber drops email/hash object keys, and shared
  validators no longer echo arbitrary people/confirmation field names. Ordinary write audit behavior remains.
- Red evidence: five unit regressions fail against the baseline release build; the service-level database
  audit regression separately fails against the original root build. A seventh service regression fails after
  the first fix because malformed confirmation objects still leaked into the audit, and passes once those
  unchecked objects are withheld too. All seven new regressions then pass.
  Focused suites: **22 / 22** (`personal-data-redaction`, `meta-customer-lists`, `meta-offline-conversions`,
  `google-data-manager`).
- Root `npm run check`: **3,050 / 3,050**, four capture tests, zero skips, test phase 125.0 s. The last
  confirmation-field regression was added afterward and passes in the focused suites; the fresh candidate
  must include it (expected 3,052 tests). No concurrent root rebuild ran during that suite.
- F-119: platform review refreshed from the batch-49 ledger; current unique ledger-family counts explicitly
  include gateway entity families. Registry and sunset recommendations that were already completed are removed.
- Initial review: `REVIEW-2026-09-30.md` lists the evidence, safety calibration and prioritized next investigations;
  fake-transport measurements cover help, contract pages, inspect and prepare, with timings and JSON byte sizes.
- Regenerated action ledger, contracts, implementation report and docs index. The ledger and contract artifacts
  are unchanged byte-for-byte: **1,712 native reads, 800 reviewed writes, 502 blocked writes**. No row moved.
- Live acceptance remains unverified. Historical records are not purged or inspected by this change. The fix
  adds no scope and loosens no safety control; no new owner decision is required.

Fresh candidate qualification (`.release/batch50-final`): **3,052 / 3,052** tests, **4 / 4** capture tests,
zero failures/skips, 122.6 s test phase. All formatting, generated-artifact, web, provider, contract and
documentation checks pass, as does `node deploy/check-railway.mjs`. FFmpeg-dependent suites did not skip;
the commands used the available default binaries without adding a required-FFmpeg override.

The checkout intentionally omits tracked `.env.example`, including
its Git object. Assembly used an isolated temporary Git index omitting only that absent non-runtime template.
All **1,318 included source files** match the committed tree by Git blob hash, with zero differences. The
qualification note was finalized after the successful check and copied into the candidate; the documentation
index was rechecked and all included files compared again with final HEAD. No tested code changed during
that documentation-only finalization. The excluded example is a disclosed checkout
constraint, not a template substitution. Environment/credential files and live-read samples are not inspected.

## Batch 51 — reporting delivery and media restart recovery (2026-09-30)

Continued the broader review after the initial batch. Fault injection confirmed Sheets response-stream failures lose
retry classification, HTML/empty HTTP errors lose their status, and malformed/date Retry-After headers produce
non-finite diagnostics. Seven red regressions reproduce these cases. The fix preserves status before decoding,
classifies interrupted reads/writes, and shares the existing finite retry parser in `src/provider-retry.ts` without
changing native-transport behavior. An eighth integration test runs the real export worker: the first applied batch
loses its body, the job queues a retry, and reconciliation completes it with **one** mutation in total.

Media inspection now resumes after a restart between finalizing chunks and publishing the source record. Finalized
chunks remain immutable; completion rechecks every chunk's size, total and SHA-256 against the existing manifest.
A durable lock serializes inspection; stale completion cannot discard a replacement's staging. Actor, source,
expiry, lock and manifest are checked after asynchronous inspection, including the final import commit. Six red
regressions covered restart, concurrency, integrity and late withdrawal; a seventh red regression caught stale
cleanup during the implementation and now passes. No advertising writes, authority grants or safety controls are
loosened. Missing parts can still arrive; invalid media/integrity is discarded.

Focused evidence: 59 Sheets/reporting/transport tests and 23 media tests passed before the final stale-lease
regression; all **15** new recovery tests now pass together. The source changes introduce no provider fields,
endpoints or scopes. Ledger totals remain **1,712 reads / 800 reviewed writes / 502 blocked writes** (3,247 actions).
Full local check and fresh sanitized release qualification are recorded below when complete. Browser review is
continuing separately against the synthetic fixture; browser setup and walkthrough are not provider acceptance.

Local full check: **3,067 / 3,067** tests, **4 / 4** capture tests, zero failures/skips; 124.7 s test phase,
Node 24.19.0 with `AMCP_REQUIRE_FFMPEG=true`. Formatting, generated artifacts, report, web, provider/version,
contracts and documentation checks all pass. Guidance now accounts for 420 refusals across 274 reachable modules
(273 documented in guides); the additional media busy code and shared retry helper explain those changes.

Fresh qualification (`.release/batch51-final`): **3,067 / 3,067** tests and **4 / 4** capture tests, zero failures
or skips; 125.9 s test phase with FFmpeg required. Every `npm run check` stage and the Railway Dockerfile check
passes. All **1,321 included source files** match the committed tree by Git blob hash. As in batch 50, an isolated
assembly index excludes only the absent `.env.example`; no replacement was invented and no credential/environment
files or live-read samples were inspected. The final qualification note was copied into the candidate after the
suite, the docs index rechecked, and source equality verified again against final HEAD. No tested code changed.

## Batch 52 — website navigation, keyboard actions and narrow pages (2026-09-30)

F-124: a render sequence fences delayed API results, HTTP errors, body-decoding failures and network rejections.
An expired session opens sign-in without the old renderer replacing it; an old route's 401 cannot sign out the
current route. Nested connector/callback handlers propagate cancellation. Media execute/resume recovery cannot
start a fresh read after leaving the page; cancelled report pagination and report/delivery polls stay quiet.
The fence changes client presentation only: it does not cancel or resubmit server mutations, change execution
authority, or assert that a submitted operation was undone.

F-125: workspace actions reuse the existing auth action helper instead of a duplicate binder without focus or
busy-state support. Replacement controls regain keyboard focus, busy state is announced and removed, forms use
their submit button when an event has no submitter, and actions do not move focus into another route.
F-126/F-127: shrinkable form tracks, wrapping action rows/buttons and existing muted/iris colors fix 320 px owner
overflow and low-contrast reporting history/connection-health text. Homepage illustration text was improved too.

Red evidence: eight renderer/API failures against the previous scripts; four focus/busy/cancellation/form failures
in a corrected DOM harness replaying the committed batch-51 scripts; two media recovery, one report-poll and two
pagination regressions fail before their fixes. The browser regression fixture initially fails dashboard/account
reflow and readiness focus. The matched 51-combination axe/overflow baseline detects two overflowing pages and
nine combinations with contrast violations. Test-harness setup errors and unsuccessful browser-download attempts
are not counted as product defects. One further red regression ensures a cancelled action cannot steal focus
when navigation returns to the same pathname; it now passes.

All **18 new unit regressions** pass; the three focused website suites pass **23 / 23**. The optional browser
regression fixture passes **6 / 6** checks. The final Chromium 153 / axe 4.11.0 audit passes **68 / 68** page/viewport
combinations at 320, 360, 430 and 1280 px, with zero detected violations, horizontal overflow or uncaught errors.
Four synthetic journeys pass: administrator sign-in, saving a client report, collection/CSV download (1,591 bytes)
and exporting to a selected synthetic Sheet. Narrow screenshots were inspected. Repeatable browser fixtures are
committed; Playwright/axe/Chromium were isolated local tooling, with no production dependency change or provider
traffic. ACCESSIBILITY.md states the audit limits and commands.

MCP probes now include exact o200k_base token counts as well as JSON bytes and fake-transport latency. Full versus
reference evidence reduces measured inspect/prepare bytes by 79.1%/75.6%, tokens by 75.1%/68.5%. The existing
contract-once/reference-afterward default is retained. Twenty complete paused-campaign probes each use four MCP
calls, three fake reads and one fake mutation, ending in verified read-back. REVIEW-2026-09-30.md records methods,
values and the larger workflows still unmeasured. Individually gzipped JS/CSS totals grow by 362 bytes.

Ledger and contracts are regenerated before full qualification. No provider field, endpoint, scope, advertising
write capability or authority grant changed; no new owner decision is requested. Full local and fresh candidate
qualification are recorded below when complete.

Local full check: **3,085 / 3,085** tests and **4 / 4** capture tests, zero failures/skips; 126.5 s test phase,
Node 24.19.0 with `AMCP_REQUIRE_FFMPEG=true`. All formatting, generated-artifact, report, web/CSP,
provider/version, contracts and documentation checks pass. Regenerated ledger, contracts and implementation
report are byte-for-byte unchanged: **1,712 reads / 800 reviewed writes / 502 blocked writes**. No row moved.

Fresh qualification (`.release/batch52-final`): **3,085 / 3,085** tests and **4 / 4** capture tests, zero failures
or skips; 124.6 s test phase with FFmpeg required. Every `npm run check` stage and the Railway Dockerfile check
passes. The same candidate also passes the six browser regressions, 68-combination axe/reflow audit and four
synthetic reporting journeys. All **1,325 included source files** match the committed tree by Git blob hash.

Assembly again uses an isolated temporary index excluding only the absent non-runtime `.env.example`; there is
no replacement template or credential/environment/live-sample inspection. The qualification record is finalized
after those checks and copied into the candidate, preserving the original assembly revision/hash in its manifest.
The documentation index and final included-source equality are rechecked before the branch update. No tested code
changes during that documentation-only finalization. Live acceptance and the remaining profiling/journeys stay
explicit in the review; nothing is deployed and no safety decision is newly requested.
