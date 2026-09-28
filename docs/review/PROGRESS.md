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
