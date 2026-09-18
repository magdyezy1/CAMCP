# Reviewed-write state projection repair

## Scope and evidence

Baseline: `2673bdc666b1b8704ff82956709cd7525e420fce`, branch `Codex-branch`, remote `https://github.com/magdyezy1/AMCP.git`, initially clean. Implementation root: `C:/Users/abdom/Downloads/AMCP Final With Claude recos - Copy/implementation-Codex-branch`. The separate development checkout and `.release/AMCP` were not edited. Remote and local baseline were rechecked before publication (0/0 divergence).

This review follows every enabled `amcp_write` gateway and every media account-snapshot path. It is a targeted concurrency review, not a new whole-repository audit. Tests use local synthetic accounts, transports and temporary SQLite databases. No supplied advertising account, credentials, live provider mutation or deployment was used. Node 24.19.0, npm 11.17.0, Windows/PowerShell; Python generation uses the existing bundled runtime via `AMCP_SCHEMA_PYTHON`.

## Confirmed defects and corrections

1. **P1 — Google query telemetry blocked unchanged writes.** Both customer and resource reads retained `queryResourceConsumption` in the hash. A changed meter caused `STATE_CHANGED` before mutation. The RPC and legacy campaign surfaces reproduce this with identical configuration. The same defect affected Google media account reviews. This is a release blocker for the affected workflow; it causes refusal, not duplicate or partial mutation. The probability depends on the meter changing, so the evidence does not establish that every possible Google write must always fail.
2. **P2 — Search Console sitemap processing looked like configuration changes.** `lastDownloaded`, processing state and content counters could change without a new submission. Separately, the documented numeric `errors` count was mistaken for an API failure. Both behaviors were reproduced against the previous disposable release's baseline executable sources. The fix distinguishes typed content counts from actual provider errors; submission identity, type, index identity, `lastSubmitted` and unknown configuration remain protected.
3. **Hardening — other encapsulated responses retained request metadata.** TikTok, Snapchat, X, Reddit, Microsoft and Apple now retain only their configuration-bearing containers after raw validation. Synthetic future-envelope metadata tests establish the previous coupling; they do not assert that each provider currently emits the invented test field or is failing live.
4. **Completeness safeguard — validate pagination before discarding envelopes.** Microsoft previously returned from state validation before the shared pagination check. The generic check also missed Reddit's documented-in-code `pagination.next_url`. Validation now reuses the existing provider pagination contracts and retains the recursive incomplete/partial checks. Malformed Microsoft error containers and missing/mistyped TikTok success codes are rejected before their envelopes can be discarded. Synthetic negative cases prove these reads cannot authorize a mutation.

The fix is in [review-state.ts:38](../../src/review-state.ts#L38), [write-review.ts:83](../../src/write-review.ts#L83), [media-upload.ts:58](../../src/media-upload.ts#L58) and the error-container check in [microsoft-native.ts:97](../../src/microsoft-native.ts#L97). No review, permission, spending or idempotency gate was removed. No alternate unreviewed write path was enabled.

The previous platform fixtures varied fields already named in the global exclusion list (`request_id`, update time, delivery status, statistics). They never varied Google's documented query-cost field, so green tests missed the defect. The new fixtures vary both real provider metadata and an intentionally unknown envelope field, and separately alter actual resource configuration. This tests the contract boundary instead of only repeating the exclusion list.

## Projection contracts and platform coverage

| Platform / surface | State hashed after raw validation | Review and regression evidence |
| --- | --- | --- |
| Google Ads RPC and legacy | `results` only, including customer reads without `resource_name`; resource rows sorted by validated identity | Exact reported campaign/budget shape with changing cost; budget/currency changes still fail with exact field paths; empty/partial/paginated responses fail; native CRUD and targeting suites |
| Meta | Flat selected account/resource; known telemetry excluded, unknown resource fields retained | Native create/update/delete and media fixtures vary request/time/delivery telemetry; configuration and grant regressions |
| TikTok | `data.list`; envelope message/request/page metadata excluded | Native create/update/status-delete and image/video transfer fixtures; complete-target/pagination gates |
| Snapchat | Requested collection and each native resource; wrapper status/trace metadata excluded | Native create/PUT/PATCH/delete, child-create and media fixtures; partial status checked before projection; creative replacement and impact safeguards retained |
| LinkedIn | Flat account/campaign resources; DSC media retains its existing explicit availability/owner projection | Native create/partial-update/delete; image/video and DSC suites; native versions, resource configuration and ordered content remain meaningful |
| X | `data` on ordinary/targeting reads; specialized creative reader already extracts validated resources and usage | Native CRUD, media/library, targeting and creative-chain regressions; ordered card components and shared-ad usage remain protected |
| Microsoft Advertising | Exact response member declared by the existing operation contract: `Account`, `Campaigns`, `AdGroups`, `Ads`, `Keywords`, `Budgets` | Hierarchy fixture varies `TrackingId`/synthetic envelope cost; existing update/delete, budget, partial-error tests; new incomplete-read refusal |
| Apple Ads | `result`; API errors checked before projection | Campaign create/update/delete with changing envelope metadata; configuration conflict changes the actual `result.name`, not an invented envelope property |
| DV360 | Flat advertiser/resource configuration | Native create/update/delete and media fixture regressions; unknown resource fields, budget/status and ordered values protected |
| GA4 | Flat Analytics Admin property snapshot | Audience-export/report-task reviewed creation, changed property and authorization tests |
| Tag Manager / Google tag | Flat entity/version and explicit workspace-status response | All enabled CRUD/version/publish contracts; native fingerprint, workspace changes, conflicts and optional live-version absence retained |
| Search Console | Site permission/identity; sitemap configuration excluding documented crawl-processing observations | Submit/delete and optional-absence tests; changing crawl observations succeeds, new submission conflicts, API error blocks |
| Drive / Sheets | No provider `state_hash` comparison in their import/export paths | Drive source access is rechecked by media workflow; media account snapshots use the repaired projection. Existing private-media, Sheets delivery/scheduling and export tests remain regression coverage; no direct write support was added |
| Other catalog gateways | No enabled `amcp_write` contract in `writeContractGateways` | Adjust, Amazon, commerce, Criteo and Google Business catalog entries do not acquire execution permission. AMCP workspace/native entries are internal orchestration, not extra qualified providers |

The matrix test compares its provider set against `writeContractGateways`; adding another enabled gateway without a projection regression fails the test. Seven media providers (Google, Meta, TikTok, Snapchat, LinkedIn, X, DV360) exercise image and video prepare → execute → replay with changing metadata.

Allowlisting applies to **response containers**, not a guessed list of all editable resource properties. Inside resources, unknown configuration is retained to protect new budget/targeting fields. Flat resources have no safe generic envelope boundary; their known telemetry exclusions remain explicit. A future unknown field embedded in such a resource may need a provider-specific contract update. Unknown scalar arrays and ordered object arrays remain ordered; duplicates/types are preserved. Only previously qualified scalar sets and Google resource-row ordering are canonicalized. Mutation payloads are never normalized by this projection.

## Stored reviews, recovery and compatibility

- Prepare and execute use the same derived, frozen read plans. Error/partial/completeness/identity checks precede configuration projection.
- A still-valid, unsubmitted older review is reprojected using those plans before comparison. Its normalized state hash can differ from the pre-upgrade hash; the frozen request fingerprint, account, connection, expiry, confirmations and payload do not change.
- Existing completed claims replay the original receipt without provider egress. Uncertain claims still stop; no claim is cleared or automatically retried. Legacy write and media envelope fixtures verify this behavior.
- `STATE_CHANGED` reports configuration-only JSON paths and expected/actual hashes. A real budget conflict submits zero mutations. Telemetry-only changes allow one mutation, and replay submits none.
- Raw provider errors and nonempty next-page indicators are never converted to successful empty/configuration state. Search Console's content-error count exception is restricted to a typed nonnegative integer on its sitemap resource; real error objects remain errors.
- No database migration, dependency, runtime service or deployment-setting change is required. Older application code may reintroduce false conflicts if rolled back; preserve original receipts and idempotency records during rollback.

## Verification ledger

| Check | Evidence |
| --- | --- |
| New regressions against unmodified baseline | `npm.cmd run build`, then `node --test dist/tests/review-envelopes.test.js`: 30 tests, 13 pass / 17 fail. `.runtime/state-projection-before.log` preserves Google false conflicts and noisy changed-field diagnostics. |
| Baseline sitemap reproduction | Previous disposable release has baseline executable sources. Local script confirms processing-only hashes differ and content `errors: "1"` becomes `STATE_READ_FAILED`. `.runtime/state-projection-sitemap-before.log`. |
| First focused implementation | 30/30 passed. A development TypeScript missing-parenthesis error was fixed before this successful build; no assertion relaxed. |
| First expanded platform run | 138 tests, 137 pass / 1 fail. The old Apple conflict fixture altered an envelope property; corrected it to change `result.name`, preserving the `STATE_CHANGED` and zero-mutation assertions. `.runtime/state-projection-platforms.log`. |
| Expanded platform run | 142/142 pass. `.runtime/state-projection-platforms-final.log`. Covers new Google regressions, native platforms, media, Microsoft, Reddit, measurement and existing review-state tests. |
| First full check after pagination integration | 576 tests: 574 pass, 1 fail, 1 FFmpeg skip. One new Microsoft unit fixture omitted the compiled method/query fields needed by the pagination helper; corrected the fixture to match its real POST contract. Initial results retained in `.runtime/state-projection-check.log`. |
| Final envelope-validation focused checks | 75/75 pass: `review-envelopes`, `microsoft` and `write-platforms` suites, including malformed Microsoft error containers and explicit TikTok success codes. `.runtime/state-projection-envelope-validation.log`. |
| First disposable release | `.release/state-projection-20260918`; source hash `66cca1c5cd290b0dbe1af210144970fbba7ce6429128d8285bde504eac410a97`, 413 files. 576 tests: 575 pass, 0 fail, 1 FFmpeg skip; capture 4/4. Overall check failed because importing shared pagination made four previously undocumented refusal codes reachable to the guidance checker. Added their operator recovery guidance rather than exempting them. `.runtime/state-projection-release-check.log`. |
| Second disposable release | `.release/state-projection-20260918-final`; source hash `8fa7ad453050f9764e434e5b6201f5b5587775a62937d0cb8f63027d93a9170a`, 413 files. Full `npm.cmd run check` passed: 577 tests, 576 pass / 0 fail / 1 FFmpeg skip; capture 4/4; generation, guidance, web, lifecycle and contract checks pass. `.runtime/state-projection-final-check.log`. |
| Last malformed-response negative check | 46/46 pass in `review-envelopes` and `measurement-writes`; additionally confirms malformed empty/null/boolean/fractional sitemap counts cannot be hidden by projection. `.runtime/state-projection-final-negative.log`. |
| Final disposable release | `.release/state-projection-20260918-verified`; source hash `2ec2a48c8088fdb233ac68a048fb9d6ba3c985944dc2399ae3b3b9cf33efdbd6`, 413 files. Fresh `npm.cmd ci --ignore-scripts --no-audit --no-fund --cache ../../.runtime/npm-cache` installed 107 packages; `npm.cmd run check` exited 0: **578 tests, 577 pass, 0 fail, 1 FFmpeg skip; capture 4/4**. Generation, guidance, web, provider/lifecycle integrity and generated-contract checks all pass. Logs `.runtime/state-projection-verified-install.log` and `.runtime/state-projection-verified-check.log`. All packaged source hashes still match; only this report was finalized after assembly. |

`node deploy/check-railway.mjs` and `git diff --check` passed. Docker and FFmpeg/ffprobe remain unavailable on this host; no actual container or live advertising-account execution is claimed. HTTP/restart/revocation smoke and synthetic provider flows are exercised by the suite. Remote GitHub CI has not been verified by these local results.

The focused command was `node --test --test-concurrency=1 dist/tests/review-envelopes.test.js dist/tests/review-state.test.js dist/tests/write-platforms.test.js dist/tests/media-upload.test.js dist/tests/microsoft.test.js dist/tests/reddit-writes.test.js dist/tests/measurement-writes.test.js`, following `npm.cmd run build`.

## File review ledger

| Files | Method / scope |
| --- | --- |
| `src/review-state.ts` | Entire helper manually reviewed; envelope/resource boundaries, normalization, hashes and field paths exercised |
| `src/write-review.ts` | Affected validation, snapshot derivation, persistence, execute/replay, permission/spend paths manually traced; existing full-file regressions |
| `src/media-upload.ts` | Account reads, prepare/execute, original claim and library-review paths traced; seven-provider transfer/recovery tests |
| `src/measurement-writes.ts`, `src/microsoft-native.ts`, `src/reddit-writes.ts`, `src/x-creative-writes.ts`, `src/x-targeting-writes.ts`, `src/google-targeting-writes.ts`, `src/pagination.ts` | Applicable state-read shapes, raw response checks, identity/completeness and special projections inspected; unchanged except explicitly listed above |
| `src/write-verification.ts`, `src/spend-policy.ts` | Inspected consumers of retained resource shapes; full regression suite validates read-back and financial controls |
| `tests/review-envelopes.test.ts` | New manually reviewed regression matrix and precise Google RPC/legacy reproductions |
| `tests/write-platforms.test.ts`, `tests/media-upload.test.ts`, `tests/microsoft.test.ts`, `tests/reddit-writes.test.ts`, `tests/measurement-writes.test.ts` | Existing fixtures strengthened to vary metadata; realistic negative configuration changes preserved; new recovery/sitemap cases |
| `docs/WRITE-OPERATIONS.md`, `Skills/amcp-campaign-builder/SKILL.md`, `Skills/amcp-campaign-builder/references/workspace.md`, this report | Updated behavior, compatibility, coverage and recovery guidance reviewed |
| Generated catalogs/vendor snapshots | No changes needed; existing regeneration/integrity checks retained. No new line-by-line vendor audit claimed |
| `.mirror/REPORTS/implementation-status.json` | Mechanically regenerated guidance/implementation inventory; updated reachable-module and documented-refusal counts |

## Official sources and limits

Public research checked 18 September 2026. These sources establish documented contracts, not live account qualification.

- [Google v23 SearchGoogleAdsResponse](https://developers.google.com/google-ads/api/reference/rpc/v23/SearchGoogleAdsResponse) and the checked-in v23 Discovery snapshot distinguish results, pagination and query consumption. [Google query resource management](https://developers.google.com/google-ads/api/docs/productionize/manage-data-efficiently) explicitly describes query-cost dependence on workload and server load. The REST reference URL failed to load through the research tool; the RPC page and local official Discovery schema were usable.
- [Microsoft GetCampaignsByIds](https://learn.microsoft.com/en-us/advertising/campaign-management-service/getcampaignsbyids?view=bingads-13) separates campaign entities, partial errors and tracking information. Existing named JSON operation contracts remain authoritative for AMCP's implemented subset.
- [Snapchat campaigns](https://developers.snap.com/marketing-api/Ads-API/campaigns) shows response/row status wrappers, resource records and pagination separately.
- [Search Console Sitemaps](https://developers.google.com/webmaster-tools/v1/sitemaps), page updated 23 July 2024, describes submission versus download/processing observations and numeric sitemap error counts.
- [TikTok official SDK](https://github.com/tiktok/tiktok-business-api-sdk) and existing captured/native contracts support inspection of advertiser/list response boundaries. The new arbitrary telemetry field is a synthetic forward-compatibility fixture.
- [X documentation index](https://docs.x.com/x-ads-api/llms.txt) was available; specific error/pagination pages failed in the research tool. [Reddit v3 documentation](https://ads-api.reddit.com/docs/v3/) did not yield rendered content. [Apple CampaignResponse](https://developer.apple.com/documentation/apple_ads/campaignresponse) required JavaScript and its linked Markdown fetch failed. Those providers' response/completeness behavior was checked against current implementation, retained schemas/contracts and synthetic fixtures; no new live-provider claim is made.

Release acceptance still requires deployment of this branch's tested revision, normal Linux/container/FFmpeg CI, and an explicitly authorized Google Ads test-account prepare → execute → read-back (including a deliberate real configuration conflict). No production-account execution was attempted to prove the fix. Do not disable concurrency checking if the deployed version still reports telemetry paths; establish which revision is running and inspect the preserved read plans.
