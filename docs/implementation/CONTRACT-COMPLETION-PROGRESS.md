# Provider action implementation progress

Latest resume entry: [2026-09-24 handoff](RESUME-HANDOFF-2026-09-24.md).
Latest incident: [2026-09-24 HTTP startup and DNS](STARTUP-DNS-2026-09-24.md).
Completed follow-on: [2026-09-24 Meta source ownership](META-CREATIVE-OWNERSHIP-2026-09-24.md).
Completed product batch: [2026-09-24 reporting continuation](REPORTING-2026-09-24-PROGRESS.md),
with [machine-readable verification](VERIFICATION-CHECKPOINT-2026-09-24.json).
The [2026-09-20 handoff](RESUME-HANDOFF-2026-09-20.md) retains the provider-contract
roadmap and remaining-action inventory. Earlier numbered checkpoints are historical.

## BC — Website discovery and OAuth authority (2026-09-25)

Operation-local guards cover all 15 website provider discovery paths, Google
reauthorization hierarchy/selected-account reads and late metadata persistence.
OAuth callbacks recheck administrator identity/role, including between Meta token
exchanges. Google resumable chunks and recovery queries also check the original
transfer login and private Drive grant, preserving the byte journal. Forty-five
added website regressions plus compatibility coverage pass: 118
focused tests. The preceding immutable release fails 45 of 76 baseline cases.
Website-only full candidate A passes 1742 main/four capture. Four additional
Google media regressions fail against A and pass after correction; all 70 focused
media tests pass with FFmpeg required. Combined candidate B passes **1746 main
and four capture tests**, zero failures/skips, including all generated-contract
and website checks. Exact post-push CI remains a separate gate. See the
[implementation and original failures](WEBSITE-DISCOVERY-AUTHORITY-2026-09-25.md).
No provider action counts or grant rules change.

## BB — Per-attempt authority and accepted-write receipt preservation (2026-09-25)

Five initial reproductions exposed retries after key revocation; 21 of the 25
expanded regressions fail against the previous sanitized candidate, including
reviewed mutation dispatch after revocation during pacing. Current changes fence
actor, account, scopes and login on each attempt across the shared native read,
review, verification, media and diagnostic paths. Accepted write receipts persist
before delivery is denied. Fresh candidate C passes all 1697 main/four capture
tests with FFmpeg required and zero failures/skips. Candidate A's five failures
remain recorded, with error compatibility and bounded Windows cleanup corrected.
Exact GitHub run #99 also passes, including Docker and both smoke modes. See
[evidence and exact remaining boundaries](RETRY-AUTHORITY-2026-09-25.md).
No inventory count or provider capability is inflated by this hardening.

## BA — Business Profile MCP account/location synchronization (2026-09-25)

The missing sync_assets adapter now uses explicit administrator/identity/scope
checks, fixed native GETs, required read masks and complete paginated collections.
Shared locations retain all discovered parent IDs without granting access.
Metadata/audit commit together; current selections and write grants remain intact.
Preview, per-attempt authority, request/time limits, stale failure, concurrent
selection, lease fencing and restart behavior have focused evidence: 187 tests
passed, including 24 new Business Profile tests and the shared deadline matrix.
Initial failures remain visible in [the implementation record](GOOGLE-BUSINESS-SYNC-2026-09-25.md).
Full fresh candidate A passes 1671 main/four capture tests, zero failures/skips,
required FFmpeg enabled. Exact staged-source evidence is recorded in
[verification](GOOGLE-BUSINESS-SYNC-VERIFICATION-2026-09-25.json); exact GitHub run
#98 also passed the full workflow, including Docker and both smoke modes.

Inventory: 1000 remaining rows, including 886 blocked writes, 79 unmapped,
23 unqualified reads, eight input-dependent and four retired. There are 438
reviewed-family and 83 local workflows. Website Business Profile OAuth/discovery,
MCP OAuth start/exchange/refresh and live provider qualification remain separate.
This checkpoint does not mark those capabilities or every platform complete.

## AZ — Adjust native reporting and the confirmed CI deadline defect (2026-09-25)

Six Adjust workflows now execute local configured bindings and native app/filter,
event, JSON and app-indexed pivot reads. Current permissions are checked on every
attempt; shared budgets/cooldowns span SQLite workers. Exact monetary text, nulls,
warnings, incomplete totals and unsupported shapes remain explicit. Maintained
schemas, discoverable guidance and six executable examples agree with the adapter.

The supplied GitHub #96 failure exposed operation-deadline timeouts being retried.
Five deterministic reproductions failed before correction. The shared transport
now makes a deadline-budget timer terminal while retaining shorter-attempt retry
recovery. The original Criteo assertion is unchanged and passed twenty repetitions.
See [Adjust implementation](ADJUST-REPORTING-2026-09-25.md),
[CI analysis](CI-DEADLINES-2026-09-25.md) and
[combined verification](ADJUST-REPORTING-VERIFICATION-2026-09-25.json).

Fresh candidate B: 1646 main/four capture tests, zero failures/skips, required
FFmpeg enabled. Candidate A's two outdated deployment-guide count assertions and
the original CI failure remain visible. Actual Ubuntu/Docker verification is a
separate post-push check, not inferred from this local result.
Inventory: 438 reviewed-family, 886 blocked writes, 80 unmapped, 23 unqualified
reads; 1001 remaining rows including four retired actions. Adjust adds no write
contract or normalized dashboard. Business Profile sync is next implementation
work; its provisional collector is outside this completed staged batch.

## AY — GA4/Search Console discovery through MCP (2026-09-25)

Completed the two advertised-but-unmapped measurement sync commands. An explicit
administrator/connection previews locally, runs bounded native discovery and
persists complete metadata while preserving account selections and write grants.
Website and MCP share their parser. Current identity/grants, metadata revisions,
SQLite leases, native pagination/details and stale failure states are checked.
No provider mutations or native OAuth exchange are added.

[Implementation](MEASUREMENT-CONNECTION-SYNC-2026-09-25.md) and
[verification](MEASUREMENT-CONNECTION-SYNC-VERIFICATION-2026-09-25.json) retain
initial failures. Final required-FFmpeg check: 1603 main plus four capture,
zero failed/skipped. Inventory: 438 reviewed-family / 886 blocked writes /
86 unmapped / 23 unqualified reads; 1007 remaining rows including retired actions.
Live account qualification and the remaining OAuth/Business Profile paths remain
separate, explicit work.

## AX — Credential-refresh fencing and atomic connection replacement (2026-09-25)

Confirmed and fixed stale refreshes overwriting a newer login across all 14 shared
refresh adapters, stale gateway objects receiving another provider's credentials,
and non-atomic replacement/ownership cleanup. Shared bounded token parsing rejects
invalid UTF-8, oversized responses, invalid Bearer/refresh metadata and overflowing
expiry. Metadata/grant edits still retain valid token rotation and current grants.
No credential, role, scope or provider grant is broadened; no database migration.

[Evidence and limitations](CREDENTIAL-REFRESH-2026-09-25.md) retain 17 original
failures and the failed transaction reproduction. Full fresh required-FFmpeg
check: 1578 main plus four capture, zero failures/skips. The action inventory
does not change. Provider rotation lost before persistence, live authorization
and independently stored replicas remain separate verification/recovery concerns.

## AW — TikTok asynchronous reporting and output completeness (2026-09-25)

Added one scoped reviewed family for four task/async create/cancel aliases and
qualified four status/download aliases. Complete local lifecycle covers exact
advertiser metadata, original-token/task binding, native status, bounded server
CSV parsing, cancellation, quota pacing across SQLite workers, durable claims
and restart recovery. TikTok result projection now reports omitted rows instead
of falsely describing sliced output as complete. No signed URLs or raw report
rows enter the audit log. No new service, schema migration or runtime dependency.

[Implementation/limits](TIKTOK-REPORTS-2026-09-24.md) and
[verification](TIKTOK-REPORTS-VERIFICATION-2026-09-24.json) retain initial failures.
Fresh candidate B passes the complete required-FFmpeg check: 1550 main and four
capture tests, zero failures/skips. The catalog now has 438 reviewed-family
actions, 886 blocked writes and 23 unqualified reads; the remaining CSV contains
1009 rows including four retired actions. Neither live permissions/reporting nor
the remaining provider actions are claimed complete. Existing dashboard and
scheduled CSV/Sheets paths remain intact; async dashboard integration needs its
own semantic crosswalk and resumable schedule contract.

## AV — Reviewed Google shareable previews (2026-09-24)

Both native/legacy v23 preview-generation routes now use one reviewed family.
PMax UI and supported YouTube candidates validate source/parent identities,
projection hashes, native oneofs and per-item results. Private links have encrypted
24-hour recovery; uncertain submissions never retry. The customer-level RPC
colon parsing defect is fixed without accepting foreign customer resources.
See [implementation](GOOGLE-PREVIEWS-2026-09-24.md) and
[verification](GOOGLE-PREVIEWS-VERIFICATION-2026-09-24.json). Full sanitized check:
1520 main plus four capture tests pass, zero fail/skip, required FFmpeg enabled.
Initial two unavailable-contract failures and subsequent fixture/guard failures
remain recorded. Coverage: 434 reviewed-family, 888 blocked writes, 25 unqualified
reads. Preview URLs/rendering/subtype eligibility are not live-qualified.

## AU — Exact financial limits and native cap safeguards (2026-09-24)

[Financial findings and rollout](FINANCIAL-POLICY-2026-09-24.md) and
[machine evidence](FINANCIAL-POLICY-VERIFICATION-2026-09-24.json) retain three
failed decimal-boundary regressions, five failed cap regressions and a large
SQLite-aggregate failure before their corrections. Native decimal strings and
integer micros keep their units; new exact reservation metadata is additive.
Configured numeric owner policies refuse unquantified cap clearing; Snapchat
lifetime caps use the same positive-increase controls as daily budgets. Real
cap changes still invalidate reviews and two SQLite workers cannot overbook.
Final focused run: 97 pass, zero fail/skip. Full required-FFmpeg candidate B:
1502 main and four capture pass, zero failed/skipped; every check stage exits 0.
Action counts remain 432 reviewed-family and 888 blocked writes. No provider,
credential or production configuration changed. Site access is user-confirmed
and corroborated by public HTTP 200 checks; historical DNS observations do not
establish that the app is currently down.

## AT — Scoped Criteo auction campaigns (2026-09-24)

Two exact create/update routes now have qualified Campaign request/response
contracts, complete PUT field preservation, fresh account-scoped ownership,
stable campaign/funding/line snapshots, owner policies and durable read-back.
See [implementation and rollout](CRITEO-CAMPAIGNS-2026-09-24.md) and
[machine evidence](CRITEO-CAMPAIGNS-VERIFICATION-2026-09-24.json).
The initial two desired journeys failed with WRITE_CONTRACT_UNAVAILABLE.
Final family: 21 pass. Full sanitized required-FFmpeg suite: 1481 main plus four
capture pass, zero fail/skip. Initial fixture/generator failures remain recorded.
Current inventory: 432 reviewed-family, 888 blocked writes; 1015 remaining rows
including four retired operations. No live/provider/deployment claim is made.
Preferred, retailer-funded, auto-paced and override-bearing campaigns stay outside
this bounded family. Shared decimal spending arithmetic remains a follow-up.

## AS — Scoped Criteo asynchronous DSP reports (2026-09-24)

The [Criteo evidence and rollout](CRITEO-REPORTS-2026-09-24.md) records three
previously unmapped aliases now qualified as reviewed 2026.01 account/campaign/
line-item report jobs. Existing status/output routes now require the retained
original job binding, current account/connection grants and complete metadata.
Retrieval verifies original bytes/MD5, size, count, column and account/date/entity
scope, with stable status checks before/after output. JSON and compact JSON keep
nulls and lossless int64 identities. No advertising configuration is mutated.

Nineteen report tests cover six complete journeys and negative, concurrent,
restart and deadline cases; the expanded report/transport check passes 28 tests.
The full required-FFmpeg run initially passed 1455
tests and failed three legacy assertions for the newly changed mapping inventory.
Their exact counts and incomplete-request assertions are updated; the final full
check, hashes, initial failures and live limits are recorded in the linked report.

Current inventory: 3241 actions, 430 reviewed-family, 890 blocked writes,
88 unmapped, 27 unqualified reads, eight input-dependent and four provider-
unsupported. The separate 1208-method vendor inventory has 451 unmapped methods.
Criteo's 108 pinned methods now all map; 45 Criteo writes still lack qualified
contracts. Website OAuth, dashboard Criteo integration, other native formats,
presets, large/multi-account outputs and 2026.07 migration remain explicit work.

## AR — Client portfolios, native GAQL sortability and real FFmpeg (2026-09-24)

The [portfolio and GAQL evidence](PORTFOLIO-AND-GAQL-2026-09-24.md) records four
new reviewed routes with six qualified schemes, strict native masks/units,
complete campaign/shared-budget state, owner controls, exact receipts/read-back
and concurrency/restart recovery. Query telemetry and unrelated strategy targets
do not change the review. Type changes, manager/cross-customer portfolios,
aligned budgets and deprecated fields remain explicit unqualified variants.

Also fixed the pre-existing bidding-event readers' `ORDER BY resource_name`,
which official v23 field references mark non-sortable. Three strict-provider
regressions fail before the correction and pass afterward. Existing event and
new portfolio fixtures now reject that invalid GAQL. No live query was sent.

Candidate C full check passed: 1440 main tests, zero failed, one optional FFmpeg
skip, plus four capture tests. The skipped media test then passed with real,
checksum-verified portable FFmpeg 9.0.2 in required mode: seven media tests,
zero failed/skipped. No binary is committed or shipped. Initial failures,
commands, candidate manifest and hashes are retained in the linked evidence.

Current action denominator: 3241; 427 reviewed-family, 890 blocked writes,
91 unmapped, 27 unqualified reads, eight input-dependent and four retired
provider-unsupported routes. The refreshed remaining-action ledger and R2–R12
roadmap remain active; this is not complete provider coverage or live qualification.

## AQ — HTTP startup diagnostics and DNS investigation (2026-09-24)

Successful HTTP startup now logs the actual bound address on stdout at info level.
Express 5 bind errors now log a distinct failure and exit nonzero after worker/store
shutdown. Combined sanitized full check: 1417 main tests passed, zero failed,
one optional FFmpeg skip; four capture tests passed, all check stages exit 0.
Final test-only reuse of the safe-port allocator passed 15 compatibility tests in
a second sanitized candidate with identical production files. See the incident
record for exact commands, hashes, initial failures and verification boundaries.

Public read-only probes reproduce recursive NXDOMAIN while both assigned Cloudflare
authorities return records and TLS-verified HTTPS /healthz returns 200 when routed
through those records. One .shop authority returns NXDOMAIN; another times out.
The remaining public resolution issue needs current Hostinger/registry status and
delegation repair, not an application bypass. Exact cause remains unproven; no DNS,
registrar, Cloudflare or Railway settings were changed.

## AP — Direct Meta creative ownership (2026-09-24)

Closed R1's reproduced direct-write Page/Instagram source ownership gap. Preparation
and execution now complete bounded advertiser identity reads, verify Page linkage
and content ownership, recheck current authority through private Page-token reads,
and retain only stable proof in state comparison. Alternate top-level source/actor
fields fail before egress until they have equivalent qualified contracts. Positive
owned-content, media-chain and existing-post workflows remain supported.

Final Meta candidate B: full check exit 0, 1413 main tests passed, zero failed,
one optional FFmpeg skip; four capture tests passed. Concurrency/lost-response,
real content changes, token/counter changes, revoked identities and in-flight
reauthorization are covered. Meta descriptor version 7 and generated contracts/
guidance updated. No DB migration or runtime dependency. Advanced/partnership
variants, new-story media ownership and live acceptance remain separate work.
Native action totals remain unchanged: 3241 / 423 reviewed-family / 894 blocked.

## AO — Independent reporting and X recovery (2026-09-24)

Added named client report/template CRUD, stable revision-checked edits, separate
account/destination/schedule identity, daily/weekly/monthly native data periods,
calendar windows and monthly schedules. Browser controls include new, duplicate,
create from template, edit, delete, pause/resume, destination selection and schedule
management. CSV and Sheets retain period metadata and missing/partial evidence.
Stale requests/jobs cannot overwrite another selection or resurrect a deleted run.

Repaired transport circuits poisoned by terminal provider errors, scoped transient
circuits by connection/account, shared X reset cooldowns, current analytics
placements, native null columns and resumable analytics batches. Preserved the X
creative incomplete-state contract and its underlying provider diagnostics.

Fresh sanitized candidate B: full check exit 0; 1405 main tests passed, zero failed,
one optional FFmpeg skip, plus four capture tests. Focused reporting suite: 92;
X compatibility: 46. Local browser exercised two clients/accounts/Sheets destinations,
weekly/monthly schedules, daily results, CSV download and synthetic Sheets delivery.
No live advertising calls or deployment changes. Exact commands, initial failures,
hashes, boundaries and remaining work are in the linked progress/checkpoint files.

Native inventory remains 3241 actions, 423 reviewed-family and 894 blocked writes;
no native reviewed-write family was added by this product batch. The separate Meta
R1 ownership hypothesis now has two failing local foreign-identity prepare repros;
it remains unfixed here and is not a claim of a successful live provider exploit.

## AN — Google Ads client-account user access (2026-09-20)

User requested finishing only the in-progress batch and documenting all remaining
work before stopping for the usage-limit refresh. No further family was started.

Six mapped writes now share google_user_access: the native user and invitation
mutation RPCs plus CREATE/REMOVE_CUSTOMER_USER_ACCESS_INVITATION and
UPDATE/REMOVE_CUSTOMER_USER_ACCESS. Native singular operation/result, exact mutable
role masks, administrator/test-account checks, current account write grants and
adwords scope are enforced. Client membership and invitation collections are read
completely twice, with semantic projections and bounded pages/bytes/deadlines.
Duplicate recipient, no-op role, pending authorization, nonpending revocation,
manager-wide effects and last-direct-admin removal/demotion are refused explicitly.
New/increased access obeys owner activation policy; removals/demotion obey deletion
policy. POST singular removals now have destructive metadata as well as policy
checks. No invitation or native permission was changed live.

Exact target receipts and independent read-back distinguish a sent PENDING
invitation from accepted account access. No AMCP ownership is inferred. The final
Discovery/proto comparison exposed the optional multiPartyAuthReview receipt field;
it is now validated and retained. Pending native authorization remains inconclusive.
A receipt containing only that review ID without a target remains uncertain and
cannot be resent; approval/rejection and manager-wide recovery are separate gaps.

Tests cover lifecycle, both action surfaces, malformed/native options, masks,
cross-account/workspace access, revocation, owner-policy changes, meaningful state
conflicts versus telemetry, paging/count/response bounds, lost/partial/foreign
receipts, pending authorization, concurrency, review tampering/expiry and SQLite
restart replay. Twenty-five new tests plus existing compatibility/guidance tests:
75 passed, zero failed or skipped. Build, nine-proto evidence regeneration,
contract/action generators and guidance checks passed (88 modules, 14 gateways,
no missing codes/gateways). Initial build narrowing errors are retained in
google-access-build-1.log; build-2/build-3 and final passed. Initial 21 tests passed;
the expanded final suite includes schema-driven receipt and verification cases.
Logs: .runtime/contract-completion-20260919/google-access-*.log.

Provider descriptor Google version 14 and two executable guide examples are
updated. Official evidence URLs/hashes, version constraints and recovery guidance
are in Skills/amcp-campaign-builder/references/google-ads.md,
tests/fixtures/google-user-access-v23.json and tools/google-access-evidence.mjs.
No new runtime dependency or database migration.

Recomputed inventory: 3241 actions; 423 reviewed-family, 894 blocked mapped writes,
91 unmapped, 27 unqualified reads, eight input-dependent, four provider-unsupported,
1704 native reads, 74 local workflows and 16 media workflows. Pinned vendor
denominator: 1208 methods, 454 with no mapped action; Apple 99/58 unmapped.
These totals do not certify all payload variants or live provider behavior.
Candidate AN completed successfully: npm ci --ignore-scripts and npm run check
both exited 0. Main suite: 1380 tests, 1379 passed, zero failed, one optional
FFmpeg skip; four capture tests passed. Every subsequent check stage passed.
Candidate manifest: 533 files, source_tree_hash
59489cbcc71ce291eb451d2b7becf92cac5c4b2bc5fa04bbec8797cf5a03d61c.
Logs: install-an.log and release-check-an.log under
.runtime/contract-completion-20260919. No executable source changed after the
candidate was assembled; only stop/resume documentation was completed.
Required FFmpeg mode, Docker and live provider/permission workflows remain unrun.
The user requested stopping here; remaining scope and exact resumption commands
are in RESUME-HANDOFF-2026-09-20.md, with all 1024 remaining/unsupported action
rows frozen separately. No next family is in progress.


Started 2026-09-19 from `d7f3fad8f4fc499123e6be71f4d0d11408befcd4` on
`Codex-branch`. The development checkout and `.release/AMCP` are separate and
remain untouched. Implementation and pushes are restricted to `Codex-branch`.

The starting ledger contains 3,223 actions: 1,066 mapped writes without reviewed
contracts, 107 unmapped actions, 50 unqualified reads, and eight input-dependent
legacy adapters. The existing 233 write-family rows do not prove every payload
variant or a live provider workflow. The 1,109 pinned vendor methods separately
include 396 without mapped actions. No denominator is silently discarded.

## Acceptance for each operation

- Current official request, response and resource identity evidence.
- Exact selected connection/account and referenced-resource scope before egress.
- Qualified shape, immutable fields, prerequisites and business effects.
- Complete configuration snapshots with telemetry excluded after envelope checks.
- Frozen review, current grants, spending/deletion/activation controls and durable claim.
- Success/partial-failure receipts, exact configuration read-back, and recovery that
  cannot repeat an uncertain mutation.
- Positive lifecycle fixtures plus malformed, cross-account, revoked, concurrent,
  partial and lost-response cases as applicable; examples remain executable.
- Generated action and vendor inventories updated without enabling writes through
  catalog metadata. Synthetic and live evidence remain separate.

## Work ledger

| Work | Status | Evidence / next step |
|---|---|---|
| Recheck checkout, remote and initial action denominator | Complete | Clean branch at the base revision; remote main remains `067871481d79fc59a6cb976d8a13b62d409e283a`. Baseline artifact saved locally under `.runtime/contract-completion-20260919/`. |
| Google configuration and association resources | Implemented; local lifecycle tests pass | 16 explicitly declared resources, 32 additional reviewed action rows. Exact references, meaningful state comparisons, mutation receipts and read-back. Historical immutable UPDATE aliases remain blocked. |
| Google asset-set configuration and links | Implemented for declared variants; focused tests pass | Five additional resource descriptors, 16 additional reviewed rows. Complete bounded native feed membership/content, parent/type checks, semantic label comparison, exact clearing verification. Sync credential and nonselectable configuration variants remain explicit limits. |
| Remaining Google jobs, recommendations, billing, customer data and permissions | Pending | Separate effects, authorization, batch/async receipts and recovery contracts; no universal mutate exemption. |
| Microsoft library/media and remaining service methods | Pending | Exact JSON contracts and polymorphic schemas; WSDL method matches alone are insufficient. |
| Apple child resources and shared budgets | Implemented; local lifecycle tests pass | 18 new native actions. SDK type facts, parent scoping, org/account union authorization, per-account spending policies and read-back. 99 SDK methods are now independently inventoried; 58 remain unmapped. |
| Meta, TikTok, Snapchat, LinkedIn and X remaining operation families | Pending | Exact account/identity binding and lifecycle contracts per family. |
| DV360 advertiser-owned channels, negative-keyword lists and location lists | Implemented; local lifecycle tests pass | 18 additional reviewed actions. Complete bounded membership pagination, scoped receipts, replacement/deletion policy, set verification and uncertain-outcome retention. Partner-owned variants remain blocked. |
| Reddit captured post/classic families | Implemented within explicit limits | 13 reviewed-family rows and 38 native reads; legacy/structured posts, worker polling, verified post-to-ad handoff. Max, private Drive and customer ingestion remain unqualified. |
| Criteo preferred-line-item targeting | Implemented; focused tests pass | Nine scope/member operations. Fresh scoped account/campaign/retailer discovery, audience definition checks, exact set projection and read-back, policy gates and restart-safe claims. Website OAuth and other Criteo families remain pending. |
| Remaining DV360 and Criteo families | Pending | Campaign/line-item creation, reports, billing, audience ingestion, asynchronous/bulk and budget safeguards. |
| GTM reverts, variables, folders, versions, gallery and administrative workflows | Implemented; focused tests pass | 20 additional reviewed actions; administrator role/scopes, complete permission membership, last-admin checks, hashed environment codes and exact read-back. Four officially withdrawn routes retained separately. |
| GTM bulk update, synchronization, quick preview and conflict resolution | Implemented; focused tests pass | All ten Entity kinds, bounded complete workspace/base-version snapshots, unordered bulk receipts, entity fingerprints, explicit clearing, partial sync conflicts and temporary preview verification. Four additional reviewed rows. |
| GTM configuration audit and verification job status | Implemented; full release checks pass | Two formerly unmapped local operations. Read-only scoped discovery and diagnostics; job polling checks tenant, actor, provider and current connection/account access. |
| GA4, Business Profile and Search Console gaps | Partly implemented | Scoped local status and administrator disconnect; Business Profile public links and account notifications. Browser OAuth, asset sync and other provider writes remain pending. |
| Adjust, Commerce, Amazon and other unmapped actions | Pending | Establish actual provider product and executable contracts; do not invent missing specifications. |
| First full regression and branch push | Complete locally; pushed | `95b85ff` pushed to `Codex-branch`. Fresh release: 700 tests passed, one FFmpeg test skipped, four capture tests passed; generation, guidance, web, provider integrity and Railway compatibility checks passed. Container smoke checks require Docker. |

Live advertising mutations, permission changes, production deployment and real
customer-data uploads are outside this implementation authorization. They are
qualification dependencies, not a reason to omit locally implementable code.

## Current checkpoint (2026-09-20)

The working tree now inventories **3,241 actions**, including **408 reviewed-family
rows**. **909 mapped writes, 97 unmapped actions, 27 unqualified reads and eight
input-dependent adapters remain incomplete**. Four routes are now explicitly
**provider_unsupported**, including three previously blocked writes and one read;
these are not counted as implemented. The first batch added 68 reviewed action
rows (50 previously blocked mapped actions and 18 newly mapped Apple actions);
the GTM batch adds 24 more, asset sets add 16, and saved planning adds five. Tag Manager has 64 reviewed-family rows,
38 native reads, four withdrawn methods and two implemented local diagnostics.
No GTM catalog row remains unmapped or blocked solely by absence of a family;
exact payload restrictions, external permissions and live qualification still apply.
The separate vendor denominator grows to **1,208 methods, 454 without a mapped
action** because all 99 official Apple SDK methods are now included. This is an
expanded denominator, not a regression hidden by removing unsupported methods.

First batch: focused 70 passed and full sanitized release check passed, then pushed.
GTM batch: 61 initial focused/new/existing measurement tests passed; then 57 tests
for both new GTM families, withdrawn routes and executable guidance passed. The
first full candidate reported a URL-spelling test failure and retained a listener;
its isolated run and 16 diagnostic reruns passed. A full rerun completed and caught
a missing guide-family example (731 passed, one failed, one FFmpeg skip). Added
both required family examples without weakening coverage. Fresh release validation
and push are pending. Initial failure logs are retained, not replaced by retries.
Candidate C passed 753 tests and four capture tests (one FFmpeg skip), then failed
the documentation-refusal check for VERIFICATION_UNSUPPORTED. Its recovery behavior
is now documented. Candidate D completed the entire check command successfully:
762 tests passed, zero failed, one FFmpeg skip, plus four capture tests passed.
The diagnostic and workspace authorization fixtures exercise actual revocation.
GTM is pushed as `cde2b60`. The following feed batch passed 71 focused tests;
fresh release validation is in progress. Review-family rows do not certify every
variant: the explicit asset-set creation limits remain in the guide and evidence.
See `CONTRACT-COMPLETION-2026-09-19.md` for commands, first failures and scope limits.

Feed candidate E completed 773 passing tests, one failure and one FFmpeg skip.
The failure was Fetch `bad port` in an OS-assigned test listener. Added a bounded
Fetch-compatible loopback helper across HTTP fixtures; all 13 listener, activity
and deployment regressions passed. Candidate F full validation is pending.

Candidate F completed the entire check command: 777 tests passed, zero failed,
one FFmpeg skip; four capture tests passed. All generation, guidance, provider and
contract checks passed, as did Railway configuration validation. The feed batch
is validated for this local synthetic scope, with payload and live limits retained.

The feed batch is pushed as `c2e3410`. Saved Keyword Planner create/update/remove
contracts now cover five more routes. Complete affected hierarchies, inherited bids,
pagination, parent moves, explicit clears, genuine conflicts and negative cases are
implemented; 42 initial, 58 expanded and 55 final focused tests passed. Full candidate
G validation is pending. Planning resources are not serving campaigns; forecast
quality and provider eligibility remain unverified. The broader backlog is open.

Candidate G passed the entire release check: 792 tests passed, zero failures,
one FFmpeg skip and four additional capture tests passed. Source hash and full
command evidence are recorded in the dated implementation report.

Saved planning is pushed as `4b0341a`. Three Reddit creative contracts now cover
comments-only updates to legacy/structured posts and time-limited lead-form creation.
Account profile discovery is refreshed completely, bound to the post author and
projected to the selected profile. Owner policy, read-back, uncertain outcomes and
the September 21 lead-form withdrawal are enforced. Nineteen focused tests pass;
fresh full candidate H is pending. Both post-creation routes remain outstanding.
The remaining mapped, unmapped and unqualified actions are not marked complete.

Candidate H completed the entire release check: 802 passed, zero failures, one
FFmpeg skip; four additional capture tests passed. Strict generated ledgers,
guidance and provider checks passed. Post-creation implementation continues next.

Reddit metadata is pushed as `5cd05ef`. Both post-creation routes now have scoped
review/receipt/read-back contracts, including all documented creative formats,
current profile checks and resumable jobs. Forty-eight expanded lifecycle,
campaign-chain, polling and recovery tests pass; full candidate I is pending.
The 51-row captured Reddit catalog now has 13 reviewed-family and 38 native-read
rows, with no missing family. This does not implement uncataloged Max, audience
ingestion, private Drive transfer or establish live provider eligibility.

Candidate I passed 828 tests, failed one and skipped FFmpeg. The failing guidance
test still required the old statement that post publication was unimplemented.
Updated that assertion to require the new workflow, verified ID handoff, no-retry
warning and remaining capability limits. Fresh candidate J validation follows.

Candidate J completed the full release check: 829 passed, zero failures, one
FFmpeg skip, plus four capture tests passed. Strict generation, guidance, web,
provider and action-ledger checks all passed. Both post creation paths are locally
qualified within their documented limits. No live Reddit publishing was performed.

Reddit creation is pushed as `d2c0e10`. Thirteen previously unqualified GET actions
now have independent read semantics and exact scope contracts (Meta value-rule
sets; eleven TikTok catalog/business/identity diagnostics; LinkedIn dark-post
permission checks). Override headers are checked case-insensitively. Initial 25,
expanded 27 and final 27 focused tests passed. Candidate K full validation follows.
Inventory: 3,241 actions, 351 reviewed families, 963 blocked writes, 105 unmapped,
37 unqualified reads, eight input-dependent adapters and four withdrawn methods.

Candidate K passed the full check: 848 tests passed, zero failed, one FFmpeg skip,
and four capture tests passed. Strict generated action coverage and all release
checks passed. Read-contract source hash is recorded in the dated evidence report.

The read-contract batch is pushed as `2a026d5`. Criteo now has nine qualified
targeting-family rows, 45 blocked writes, 51 native reads and three unmapped rows.
Initial 17 lifecycle tests, 27 expanded/guidance tests and 79 final policy,
envelope and contract regressions passed. Full sanitized candidate L is pending.
All other incomplete action families remain open. No live Criteo mutation occurred.

Candidate L passed 868 tests, failed two deployment-smoke instances and skipped
FFmpeg. Both failures came from the shared HTTP smoke helper still expecting 11
guide resources after Criteo added the twelfth. Updated its exact count and asserted
the Criteo URI. All four deployment/guidance regressions passed. Candidate M follows;
the first failed full-check log remains retained.

Candidate M passed the complete release check: 870 passed, zero failures, one
FFmpeg skip, plus four capture tests passed. All strict generation, guide, action
coverage, web and provider checks passed. Criteo targeting is qualified locally
within the documented bounds; no live Criteo call or deployment was performed.

Criteo targeting is pushed as `7d75bdd`. Six Google legacy/RPC action rows now
have explicit draft-generation read contracts: text, images and construction
recommendations. Required evidence, native oneofs, account selection, Ads scopes,
response validation, no-output metadata and single-attempt quota behavior are
covered. Three machine-checked preview examples are included. Initial 18, expanded
54 and final 40 focused tests passed. Candidate N full validation follows. These
routes neither save assets nor apply recommendations; closed-beta eligibility,
image constraints and a private-Drive-to-generation bridge remain external or
unimplemented capabilities, explicitly documented. All remaining backlog stays open.

Candidate N passed the entire check command: 889 passed, zero failures, one
FFmpeg skip, plus four capture tests passed. All strict generated, provider,
guide, web and lifecycle checks passed. This qualifies draft-generation requests
locally; access to Google's closed beta and image production quality remain unverified.

Google generation is pushed as `4a36ec9`. A ledger defect incorrectly classified
six existing Meta update/delete aliases as blocked because it used the public
alias instead of the compiler's canonical action. Seven focused reproductions
failed at the inventory assertion after successful reviewed execution. The ledger
now uses the actual execution name and retains all alias rows. Thirteen focused
tests pass; counts increase by six reviewed-family rows and decrease by six
blocked rows. This is a coverage-report correction, not six newly implemented
mutations. Existing Meta delete read-back remains unsupported and is not certified
by these receipt/replay tests. A dedicated contract is still required for that gap.

Candidate P passed the full release check: 896 tests passed, zero failures, one
FFmpeg skip; four capture tests passed. All strict generated/ledger and release
checks passed. The alias-report correction preserves the Google legacy immutable
update restriction and changes no native execution permission.

Alias correction pushed as `51cfd52`. Six additional Meta label contracts now
implement creation, renaming, deletion and attachment to ads/campaigns/creatives.
The account label GET route is corrected independently from capture evidence.
Complete bounded account membership, exact target account checks, current Ads
scopes, native receipts, read-back and durable claims are implemented. Unknown
or omitted target membership is refused pending live absence-semantics evidence.
Initial 15, expanded 21, and final 39 focused compatibility/guide tests passed.
Candidate Q must pass the sanitized full release checks before push. The rest
of the backlog remains open; native Meta compatibility is not live-qualified.

Candidate Q failed three capture/conformance assertions (914 passed, one FFmpeg
skip). All stemmed from the route correction mutating the raw metadata shape or
the deliberate one-template difference. The override now preserves captured
raw metadata and separately exposes its effective path. Thirty-four targeted
catalog/compiler/label tests and compatibility replay passed. Candidate R follows;
Q's failed log remains visible and no failed candidate was pushed.

Candidate R passed: 918 tests, zero failures, one FFmpeg skip; four capture tests
also passed. Meta labels are qualified within their documented local bounds.
The separate Google bid-modifier draft is not included in this qualification.

Meta label batch is pushed as `1b82ba0`. Four Google ad-group bid-modifier rows
now implement create/update/remove for device and all five hotel criterion types.
The complete group/campaign/budget/modifier state is read with bounds, current
Ads scope and policy checks, inherited-source-aware deletion verification and
durable recovery. Initial 14 tests passed; malformed bypass fixtures failed
input validation before reaching the intended guard and were corrected to the
real gateway schema. Final 56 focused/compatibility/guide tests passed. Candidate S
full release validation follows. Campaign-level creation, other bidding families,
and live auction/provider compatibility remain open.

Candidate S passed the entire sanitized release check: 939 tests passed, zero
failures, one FFmpeg skip, plus four capture tests passed. Strict generated,
provider, guide, web and lifecycle checks passed. These results qualify the
documented bid-modifier contract locally; live acceptance and auction behavior
remain unverified. Remaining counts are 938 blocked writes, 105 unmapped actions
and 31 unqualified reads; the backlog is not complete.

Google bid modifiers are pushed as `92c261d`. All five captured LinkedIn campaign
conversion association writes now have an exact tuple/batch contract, fresh
campaign/conversion account checks, complete bounded membership, REST.li receipts,
read-back and durable claims. Initial fixture prototype mismatches are preserved
in the evidence; 50 expanded tests pass after correction. Candidate T full checks
are next. No live or installed-tag behavior is claimed. TikTok's separate budget
route remains open for authoritative contract evidence; its public SDK does not
document that route and the portal did not expose its schema.

Candidate T passed the full sanitized release check: 960 passed, zero failures,
one FFmpeg skip, plus four capture tests passed. Final inventory/example checks
passed 34 tests. LinkedIn associations are locally qualified within the documented
bounds. An unregistered Meta Ad Library draft was written afterward and is not
included in this candidate or the LinkedIn commit. Remaining counts stay explicit.

LinkedIn associations are pushed as `981b5f9`. Meta public Ad Library search now
has fixed-route authorization, bounded pagination, explicit geographic coverage,
safe public URLs and a tenant/connection-scoped bounded cache. Initial fixture
failures are preserved; 24 final focused scope, inventory and guide tests pass.
Candidate U full checks follow. One formerly unmapped workflow is implemented;
remaining writes and live provider qualification are still open.

Candidate U passed: 973 tests, zero failures, one FFmpeg skip, plus four capture
tests passed. This qualifies the Meta Ad Library workflow locally. Later LinkedIn
state corrections and conversion-rule drafts are excluded and remain under test.

Meta Ad Library is pushed as `65c7f90`. LinkedIn conversion rules now implement
single/batch creation and partial updates under two captured POST routes. The
same batch corrects native associatedCampaigns records and callback telemetry in
association reviews. Initial 38 tests and expanded 67 tests pass; final guide and
inventory qualification follows. Actual tracking, auto-association and event
ingestion remain separate limits. Candidate V full validation is next.

Candidate V passed its 996 tests and four capture tests (one FFmpeg skip) but
failed the following guidance check: CONVERSION_STATE_UNVERIFIED needed explicit
cause/recovery guidance. The guide is corrected without relaxing the check.
Candidate W will repeat the full command. Google drafts remain excluded.

Candidate W passed the full sanitized check: 996 tests passed, zero failures,
one FFmpeg skip, plus four capture tests passed. Guidance, generated contracts,
provider and lifecycle checks passed. The LinkedIn batch is locally qualified;
Google custom-segment drafts are excluded. Remaining inventory: 931 blocked
writes, 104 unmapped actions and 31 unqualified reads. Live provider acceptance,
FFmpeg-required and container validation remain open.

LinkedIn conversion rules are pushed as `96d8bda`. Google custom audience and
custom interest definitions now have exact native member, update-mask, deletion,
scope and verification contracts. Explicit empty member sets, member ordering,
unknown configuration and native default omission are handled independently.
Initial fixture contamination failed four tests (64 passed); isolated fixtures
then passed 89 compatibility tests. A focused reproduction exposed a generic
policy false positive for budget keywords and unattached ENABLED definitions;
contract-specific effect checks correct it while mixed updates remain protected.
Forty-one expanded tests passed. Final qualification and candidate X follow.

Candidate X passed the full sanitized check: 1,018 tests passed, zero failures,
one FFmpeg skip, plus four capture tests passed. Final guide/inventory/segment
qualification passed 31 tests, including 20 dedicated segment tests. All generated,
provider and release checks passed. A later unregistered X draft-workflow file is
excluded from this Google qualification and commit. Live eligibility remains open.

Google custom segments are pushed as `112ee45`. All four X draft routes now have
reviewed contracts for unpublished creation, editing, hard deletion and explicitly
requested device previews. Exact FULL author, registered media, ordered images,
native form encoding, complete absence verification and retained claims are tested.
Preview verification certifies provider acceptance only; device delivery stays
unverified. Initial 17 tests passed and one fixture failed its connection UUID
format before reaching the intended native bypass guard; the fixture now uses a
valid UUID. Expanded compatibility tests passed 54 and final qualification passed
33 (22 dedicated). Candidate Y full release checks follow. No live X call occurred.

Candidate Y passed the full sanitized check: 1,040 tests passed, zero failures,
one FFmpeg skip, plus four capture tests passed. Generated contracts, guidance,
provider and release checks passed. Source manifest SHA-256:
`cc4e8e539c75781e9e1617b3c2fe82a48b456c9d2c125248f9bb34ac60de7332`
(490 files). The X draft batch is locally qualified; preview device delivery,
live provider acceptance, FFmpeg-required and container checks remain unverified.

The X draft batch is pushed as `693c40c`. Google bidding events now have exact
create/update/remove contracts for seasonality adjustments and data exclusions.
Reviews bind client-account timezone, both event histories, old/new campaign scope,
budgets and local portfolio targets/limits. Known sets and telemetry are canonical;
actual configuration, unknown arrays and current grants remain protected. Initial
tests passed 20 and failed one bypass fixture because skip_preflight is rejected
before the review guard. The fixture now asserts both independent protections.
Expanded tests passed 65, including 26 dedicated event tests. Candidate Z follows.

Candidate Z passed the full sanitized check: 1,066 tests passed, zero failures,
one FFmpeg skip, plus four capture tests passed. Final event/inventory/example
qualification passed 37 tests. All subsequent generated, guidance, provider and
release checks passed. Source manifest: 494 files, SHA-256
`fab4c10246634a8bb541b14ec2d0c0b189d13135a7a4556600279f9cd22ee401`.
The later DV360 targeting-search draft is excluded from this Google qualification.
Current inventory: 391 reviewed-family rows, 923 blocked writes, 104 unmapped
actions and 31 unqualified reads. Live, FFmpeg-required and container checks remain open.

Google bidding events are pushed as `ecfa30a`. DV360 targeting search is now
qualified as advertiser-scoped POST discovery for geo regions, POIs and business
chains, with exact native bodies, scopes and truthful bounded pagination. The
gateway now exposes explicit connection selection without altering captured raw
schemas. No targeting assignments or ownership grants follow from search results.
Initial integration fixtures failed on nonexistent gateway fields and an invalid
revoked-connection setup (13 passed, seven failed). Correct fixtures then passed
20 tests; expanded compatibility, inventory and guide examples passed 50 tests,
including 23 dedicated search tests. Candidate AA full validation follows. This
moves one misclassified blocked write to a qualified read, not a new write family.

Candidate AA: 1089 passes, one help-schema equality failure, one FFmpeg skip.
The captured schema stayed unchanged; the old test did not account for the new
independent connection selector in effective help. Updated it to require exactly
that extension and preserve equality for every captured field. Candidate AB follows.

Candidate AB passed the entire sanitized release check: 1090 tests passed, zero
failed, one FFmpeg skip; four capture tests passed. The final schema/search check
passed 29 tests. Manifest: 497 files, SHA-256
`3523764e716ed7679d7097fd0fc47935e5d3a33619f7ab1c09aa22d0f1733492`.
The conversion-goal draft is excluded. Remaining inventory is 922 blocked writes,
104 unmapped actions and 31 unqualified reads; no all-platform completion claim.


DV360 targeting search is pushed as `38b2d96`. Google conversion goals now have
four native reviewed RPC contracts and two legacy aliases. Standard goals/configs
are update-only; custom definitions support create/update/remove. Reviews bind the
complete current non-App graph, local conversion customer/actions and financial
campaign dependencies; read-back verifies inheritance and level switching. A
verified custom goal can feed a separately approved campaign attachment step.
Manager-shared tracking remains explicitly outside this client-account contract.

Initial integration: 26 passed, three fixture errors (two missing policy
confirmation fields; one missing native idempotency key). Correct public fixtures
then passed 29. Expanded lifecycle/capacity/provenance tests passed 37; focused and
compatibility checks passed 80. Field evidence covers all 18 official v23 goal
fields. Public HTTP fetch attempts timed out twice; web-tool extraction succeeded.
Generated inventory: 397 reviewed-family rows, 916 blocked writes, 104 unmapped,
31 unqualified reads. Candidate AC full sanitized release validation follows.


Candidate AC passed the entire sanitized release check: 1,127 tests passed,
zero failed, one FFmpeg skip; all four capture tests passed. Every subsequent
report, web, provider, lifecycle, generated-contract and action-inventory check
exited successfully. The field-evidence regeneration check also passed.
Manifest: 501 files, SHA-256
`9808ca186ac22ce9dc4880717dd7de1e8c01db62e6fdf2be4211ef837d702c18`.
Live Google acceptance, FFmpeg-required and container checks remain unverified.
An evidence-log print hit Windows console encoding; no product check failed.
The conversion-goal batch is ready for the authorized Codex-branch push.


## Meta asynchronous Insights reports (2026-09-20; qualification in progress)

Google conversion goals are pushed as `bc4ffd0`. The next batch adds reviewed
account/campaign/ad-set Insights creation and its account alias: four catalog
rows formerly labeled read-only but correctly refused as side-effecting jobs.
Native creation, exact definition polling, scoped retrieval, partial-page recovery
and worker retry lifecycle are implemented. Completed processing never implies
rows downloaded. Resumed calls distinguish remaining-page completion from complete
first-to-last retrieval. Scoped report receipts grant no generic resource ownership.

Public official Python SDK tag 25.0.3 confirms three creation edges, response
models and the supported native fields/parameters. Five source hashes and a
reproducible extractor are committed as schema evidence; no live Meta acceptance
is claimed. Breakdowns, filters, exports, summary and other parameter families
remain explicitly outside this initial contract. Audience Network reports remain
unqualified. Jobs require an operator, deployment writes and a write grant;
subsequent authorized reads work for readers and read-only deployments.

Initial compiler integration: one pass, 12 failures because Graph field selectors
were flattened to CSV. Async creation now freezes native list parameters before
hashing/transport. The next run had seven passes and six fixture failures because
the stub coerced the native string time_increment to a number; fixed the stub
using the official SDK types. Corrected initial suite: 13/13. Expanded suite:
29/29, including restart/concurrency, worker polling, scope revocation, malformed
HTTP-200 pages/receipts, incomplete downloads, native null/zero handling, limits,
expiry and immutable reviews. Compatibility and guide examples: 73/73.
The initial TypeScript narrowing error was also corrected before those runs.
No assertions or safeguards were relaxed. All original logs remain in
`.runtime/contract-completion-20260919/meta-reports-*.log`.

Commands: `npm.cmd run build`; contract/action generators;
`node tools/meta-insights-evidence.mjs --source-dir .runtime/contract-completion-20260919/meta-sdk --check`;
`node --test dist/tests/meta-insights-jobs.test.js`; the compatibility suite also
ran meta-label-writes, meta-contracts, meta-action-aliases, write-review and all
guide-contract examples. Guidance coverage reports no missing codes or gateways.
Candidate AD will run the complete sanitized release check.

Inventory: 3,241 actions, 401 reviewed-family rows, 916 blocked writes, 104
unmapped, 27 unqualified reads, eight input-dependent adapters and four explicit
provider-unsupported actions. These are catalog rows, not all provider APIs or
all payload variants. FFmpeg-required, container and live checks remain open.


Candidate AD passed the entire sanitized release check: 1,156 tests passed,
zero failed, one FFmpeg skip; four capture tests passed. Generation, report, web,
provider integrity/lifecycle, generated-contract and action-inventory checks all
completed with exit zero. Manifest: 505 files, source-tree SHA-256
`cb5f0baf00cf83a2e7ec2f13395205a185c6e404532fc0568067acde004fa166`.
No live Meta acceptance, required-FFmpeg run or container smoke was performed.
This batch is ready for the authorized Codex-branch push.

## Local connection diagnostics and retired Q&A (2026-09-20)

Implemented the exact status variant of GA4, Search Console and Business Profile
connection operations, plus Business Profile's local Q&A retirement diagnostic.
Four formerly unmapped catalog rows now have executable, tested local workflows.
No OAuth start/exchange/refresh/disconnect or asset synchronization is claimed.
Status performs zero provider requests and does not decrypt credentials. It
checks current actor authority, selects only this tenant/provider's identities,
resolves a unique enabled default, and bounds output with explicit truncation.
Recorded provider scopes, account/write grants and unverified token/provider
health remain distinct. No discovered but ungranted website assets are exposed.
Connection failures also redact OAuth code/state before audit persistence;
ordinary provider diagnostic error codes remain intact.

Google's official sunset and Q&A change-log pages state that Q&A was withdrawn
on 2025-11-03 without replacement (checked 2026-09-20). A successful local status
response explicitly says provider_unsupported; it never claims a Q&A API works.
Guide examples execute all four diagnostics without credentials or egress.

Initial TypeScript fixture error used the wrong revokeKey signature. Two initial
focused runs each passed 13 and failed one because the fixture first assigned a
write grant outside an empty account set, then enabled an empty account set.
Both violate existing Store invariants; corrected the fixtures instead of
loosening those guards. Corrected focused run passed 14; the expanded diagnostic,
MCP guidance and executable guide suites passed 23/23. Initial logs are retained
under .runtime/contract-completion-20260919/connection-diagnostics-*.log.
Commands: npm.cmd run build; both contract generators; node --test for
connection-diagnostics, guidance and guide-contract-examples. Candidate AE is the
next sanitized full check. No live provider or credential checks were performed.

Inventory remains 3,241 actions: 401 reviewed-family rows, 916 blocked writes,
100 unmapped, 27 unqualified reads, eight input-dependent adapters, four explicit
provider-unsupported routes, 1,704 native reads, 65 local workflows and 16 media
workflows. The Q&A status row is local; the underlying retired service is not
counted as a newly working provider API.

Candidate AE passed the full sanitized release check: 1,171 tests passed, zero
failed, one FFmpeg skip; four capture tests passed. Generation, report, web,
provider integrity/lifecycle, generated-contract and action-inventory checks
completed with exit zero. Manifest: 507 files, source-tree SHA-256
6caa222f87623f6ae08b150a6584c17976c6d5dfbfbaeb8c8055c76c962b08e5.
Logs: install-ae.log and release-check-ae.log in the local evidence directory.
No required-FFmpeg, Docker or live acceptance is claimed.

## Google campaign call-bid update/removal (2026-09-20)

Three more action rows now have reviewed execution: the campaign bid-modifier
RPC and native UPDATE/REMOVE aliases. The CREATE alias remains blocked, and an
RPC create payload is explicitly rejected: the v23 resource makes campaign
output-only, so creation needs verified native identity semantics rather than
inventing a campaign field or criterion ID. This is not full family coverage.

Existing Search CALLS modifiers use an exact discovered composite resource;
0.1-10 is the native multiplier range, not micros or a percentage. Zero remains
a device-only opt-out. Review reads the client account, complete call modifiers,
selected campaign/budget configuration and client-owned portfolio configuration.
The entire native portfolio configuration field table is independently recorded;
only aggregate campaign counts and redundant ID are excluded. A second parent
read catches changes while dependencies are fetched. Cross-customer portfolios
remain unqualified. State bounds: 25 operations, 25 pages/query, 80 requests,
2100 total rows, 4 MiB/page, 8 MiB total and a 60-second monotonic deadline.

The existing durable claims, immutable reviews, current grants, native scopes,
spend acknowledgement and owner activation/deletion policies remain enforced.
Exact update and complete-collection deletion read-back cannot certify an ignored
write, permission failure or partial response. No created-resource ownership is
inferred. Google bid verification now rechecks OAuth scopes on each in-flight
read as well as before verification; this also protects existing ad-group bids.

Official evidence checked 2026-09-20: v23 CampaignBidModifier; the campaign_bid_modifier
and bidding_strategy field tables (last updated 2026-09-10); the current Manage
Bid Modifiers guide and Google Ads Help interaction adjustment range/eligibility.
URLs are in the maintained Google guide. Reproducible field extraction retains
five modifier fields and 30 portfolio fields with source hashes. No live query
or mutation was performed. Shared manual-bid configuration does not prove auction
effects, call-asset eligibility or that Smart Bidding applies the adjustment.

Initial build failures were a TypeScript unknown-response narrowing and fixture
cleanup signature, then an expanded fixture syntax error; corrected without
loosening checks. First focused run: 33 passed, two fixture failures (spend policy
confirmation/policy nesting and an already-parsed Store document). Corrected run:
35/35. Expanded lifecycle, pagination/byte/time limits and schema evidence: 39/39.
Compatibility with review/state and executable guides: 59/59. The first field
extractor retained 4/5 fields because a web line label was inline; it now handles
inline labels and still requires the complete field counts. Initial logs remain
in .runtime/contract-completion-20260919/campaign-bids-*.log.

Commands: npm.cmd run build; node --test for google-campaign-bid-modifiers,
google-bid-modifiers, write-review, review-state and guide-contract-examples;
node tools/google-bid-field-evidence.mjs .runtime/contract-completion-20260919
2026-09-20 --campaign (and --portfolio, with --check for integrity).
Candidate AF completed the sanitized release check: 1,189 tests passed, zero
failed, one optional FFmpeg test skipped, plus four capture tests passed.
All check stages exited zero. Its 511-file manifest records source-tree SHA256
61f4e9dcb2c69be21217dbf4bfc83627bff91ac9103379f3ffc8e12041e63294.
Evidence: .runtime/contract-completion-20260919/install-af.log and
release-check-af.log. The required-FFmpeg CI mode was not run on this host.

Inventory: 3,241 actions, 404 reviewed-family rows, 913 blocked writes, 100
unmapped, 27 unqualified reads, eight input-dependent adapters and four explicit
provider-unsupported routes. None of the remaining rows is marked completed by
this implementation. Required-FFmpeg, container and live verification remain open.

## 2026-09-20 — Business Profile public action links (candidate AG)

Implemented the exact CREATE/PATCH/DELETE_PLACE_ACTION_LINK contracts under
google_business_native_action / gmb_engagement_ops. This qualifies three more
mapped writes: 407 reviewed-family rows and 910 blocked writes out of 3,241
catalog actions. The 100 unmapped actions, 27 unqualified reads, eight
input-dependent adapters and four provider-unsupported actions remain explicit.

The contract requires an already provisioned business.manage identity and exact
locations/{id} read/write grants. A broader Business Profile account does not
confer location authority. Website OAuth and asset discovery remain unavailable;
the provider descriptor retains those limitations rather than inferring them
from the new guide. No live account, credential or provider mutation was used.

Preparation reads the public business identity/category configuration, native
location-filtered eligible action types and complete link collection, then
repeats the snapshot for consistency. Native envelope/identity validation precedes
projection; localized labels and create/update timestamps are omitted, while
real URI, type, editability, provider, preferences and business identity changes
conflict. Limits: 1,000 links, 25 pages/collection, 80 requests, 4,100 total rows,
2 MiB/page, 8 MiB total and 60 seconds per snapshot.

Creation/editing publishes a public link without a paused state. Owner
allow_activation=false forbids both; allow_deletion=false forbids deletion.
Exact field masks and explicit false clears are enforced. Unique URI/type pairs
and currently editable targets are required. Choosing a preferred link clears
the previous preference of that type; read-back compares the complete expected
collection including that side effect. Unknown/partial/foreign receipts, failed
discovery and lost outcomes never permit another mutation. Verified creation
returns the scoped link identity; it does not grant a global resource binding.

Public destinations are never fetched by AMCP. Private/signed URLs and credentials
are rejected, and rejected URL values are removed from inspect output, failed
receipts, provider error echoes and audit input. The original input remains
immutable. A URL containing "budget" does not falsely require spend confirmation
in this exact non-budget contract. All ordinary review/deployment/grant checks
remain enforced. Read-back does not establish Maps/Search display, public
destination availability, approval or conversions.

Official sources checked 2026-09-20: PlaceActionLink resource, create/patch/delete/
list methods, location-filtered placeActionTypeMetadata and Business Information
location data. URLs and version boundaries are in the maintained
dv360-and-measurement guide. Native field/enum coverage is checked against the
pinned business-place-actions-v1 Discovery artifact; SOLOPRENEUR_APPOINTMENT also
requires current location eligibility. Provider approval and live behavior remain
unverified.

Validation: initial 21/21 lifecycle tests passed. Expanded suite has 24 new tests;
53/53 passed with shared review/state/spending-policy checks, and 39/39 passed
with delegated-native and executable guide checks. Two test compilation failures
during expansion (optional payload narrowing; an extra mock response field) were
corrected without changing assertions; their build logs remain. Bounds tests
assert the specific byte/page/row/deadline failure, not merely any rejection.
Build, contract generators and guidance checks passed (80 traversed modules,
14 reviewed gateways, no missing guide coverage). Evidence:
.runtime/contract-completion-20260919/place-links-*.log.
Candidate AG ran the complete sanitized check; the failure and correction are recorded below.

## 2026-09-20 — Business Profile notification configuration (candidate AH)

Added UPDATE_NOTIFICATION_SETTING under gmb_notification_ops. Both native mutable
fields are covered: pubsubTopic and complete notificationTypes replacement, with
exact masks and unchanged unmasked fields. Disabling explicitly clears both.
The administrator-only contract verifies the exact numeric account grant,
business.manage scope, current actor, account identity and native setting.
Location grants and another login cannot substitute for the frozen connection.

The review explains the account-wide data destination, previous topic, selected
events and future-location effect. Topic provisioning, IAM, subscribers, test
messages and delivery validation are explicitly outside this contract. Pub/Sub
may incur Cloud charges; no advertising budget is edited. Activation policy
protects enablement/changes; clearing is classified as destructive despite PATCH
and respects deletion policy. Existing partial or lost outcomes cannot replay.

The complete state is read twice, bounded to four requests, 1 MiB per response,
4 MiB total and a 30-second monotonic deadline. Notification types are a set;
actual topic/type/account-authority changes remain conflicts. Missing defaults
on a correctly identified setting are empty values; a 404, 403, unknown envelope
or unidentified body is never an empty configuration. Read-back verifies saved
settings, not event delivery, topic IAM, retention or subscriber access.

The current official NotificationSetting reference (updated 2025-11-06) marks
Q&A events retired after 2025-11-03, unlike the captured Discovery enum. All six
current and five retired/deprecated values are accounted for in tests. Existing
old values remain visible for explicit removal/migration but cannot be newly
requested or silently retained when enabling a destination. LOSS_OF_VOICE_OF_MERCHANT
must migrate to VOICE_OF_MERCHANT_UPDATED. Captured vendor evidence was preserved.
Official setup, method, account and Pub/Sub sources checked 2026-09-20 are linked
in the maintained measurement guide; the setup guide resolves the generic field
mask wording using its concrete pubsubTopic mask example.

Validation: 18 new notification tests plus 24 place-link tests. Initial combined
run: 40 passed / one failed because the place-link inventory test counted every
Business Profile write instead of its engagement operation; scoped that fixture
to its named operation and retained the exact three-action assertion. Notification
and guide fixtures independently require the new family. Expanded compatibility
passed 101/101 across both new families, spending policy, shared state matrix and
executable guides. Guidance check initially reported undocumented ADMIN_REQUIRED;
added its administrator/reviewer remedy, then all 81 modules / 14 reviewed gateways
passed. Source and initial-failure logs are retained as business-notifications-*.log.

Candidate AG evidence is retained: 513 files, source-tree SHA256
056f2e5546d17a0974703548c8e5d45ec47059c46d413e9a0e04d3212f1c07e7.
Its first complete-check attempt failed when spawnSync python reached a broken
Windows shim. Retried with AMCP_SCHEMA_PYTHON set to the configured Python binary.
That attempt ran 1,214 tests: 1,212 passed, one failed, one optional FFmpeg skip.
The failure was the shared gateway snapshot matrix missing the newly enabled
Business Profile gateway. Added its compound-state fixture, preserving the
all-gateway equality assertion; all 38 envelope tests pass. No test was disabled.
Evidence: install-ag.log, release-check-ag.log, release-check-ag-retry.log and
place-links-envelope-fix.log in .runtime/contract-completion-20260919.

Candidate AH completed the sanitized full check with both Business Profile
families and the matrix correction: 1,232 tests passed, zero failed, one optional
FFmpeg skip, plus four capture tests passed. All check stages exited zero.
Its 515-file manifest records source-tree SHA256
25d7448d6910f74591fdc985c5689aa9158e0f309c53f14fd75baae50dd26663.
Evidence: install-ah.log and release-check-ah.log, with AMCP_SCHEMA_PYTHON set
to the configured Python runtime. Inventory now: 3,241 actions, 408
reviewed-family rows, 909 blocked writes, 100 unmapped, 27 unqualified reads,
eight input-dependent adapters and four provider-unsupported actions. Required
FFmpeg mode, Docker and live provider/deployment verification remain unrun.

## 2026-09-20 — Local connection disconnect (candidate AI)

Implemented the three explicit disconnect actions for GA4, Search Console and
Business Profile. A current administrator must name an exact connection UUID.
The default previews the named login and impact; dry_run:false performs the
authorized local disconnection. No implicit/default identity selection, provider
request, credential decryption or provider OAuth revocation occurs. Advertising
deployment write controls do not prevent removing local credential access.

The website and MCP now share one transaction that deletes the credential row,
resource bindings and discovery documents and records a receipt plus audit event.
Reports, reviews, submitted jobs and idempotency claims remain for reconciliation.
A replay returns the original local receipt; an in-flight token refresh cannot
restore a deleted connection. A submitted external mutation may still complete;
disconnect does not cancel it or permit a blind retry. Administrator test accounts
remain restricted to their isolated workspace. No live credentials were changed.

Seventeen new tests cover all three adapters, dry-run defaults, cross-tenant and
cross-gateway IDs, duplicate account identities, concurrent/restarted calls,
disabled connections, read-only deployments, atomic audit-failure rollback,
pending recovery evidence, delayed refresh, test accounts, website compatibility,
redacted labels and executable guide previews. Initial compatibility passed
61/61 tests; expanded diagnostic/disconnect/guidance validation passed 38/38.
Build, both contract generators and guidance checks passed (81 modules and
14 reviewed gateways). Logs: connection-disconnect-*.log under
.runtime/contract-completion-20260919. No failure was hidden or assertion relaxed.

Inventory: 3,241 actions, 408 reviewed-family rows, 909 blocked writes, 97 unmapped,
27 unqualified reads, eight input-dependent, four provider-unsupported and 68
local workflows. Start/exchange/refresh and other unmapped actions remain explicit.
Business Profile website OAuth is not enabled by local connection management.
Candidate AI completed the full sanitized check: 1,249 passed, zero failed,
one optional FFmpeg skip, plus four capture tests passed. All check stages
exited zero. The 517-file manifest records source-tree SHA256
77f1fdef9f032c5a61b28eb862bb4aa7f99e6148635a79cc4ba3a6c33f6ba475.
Exact commands: release assembly, npm.cmd ci --ignore-scripts, npm.cmd run check
with AMCP_SCHEMA_PYTHON set to the configured Python binary. Evidence is retained
in install-ai.log and release-check-ai.log. Required FFmpeg mode, Docker and
live provider/deployment qualification remain unrun.

## 2026-09-20 — Business Profile place-action discovery (candidate AJ)

Closed the public discovery path for LIST_PLACE_ACTION_TYPE_METADATA,
LIST_PLACE_ACTION_LINKS and GET_PLACE_ACTION_LINK. An isolated baseline with a
valid synthetic locations/456 grant reproduced RESOURCE_SCOPE_REQUIRED before
provider egress for location-filtered metadata. The compiler now binds the exact
location filter to that grant; a friendly location_id supplies the filter when
omitted. Global/CLDR-region metadata remains supported but never implies location
eligibility. A broader account cannot substitute for a selected location.

Current grants, selected connection and business.manage scope are checked before
and after every page. Lists follow at most 25 pages / 1000 rows, with 1-100 page
size, 2 MiB/page, 8 MiB total and a 60-second monotonic deadline. Continuations
retain native filter, locale, identity and cursor; resumption never claims prior
pages were included. Native empty lists, unknown/partial/error bodies, foreign
identities, duplicates and token loops stay distinct. Single GETs require their
exact resource identity. No ownership or write grant is inferred from metadata.

Read results retain native fields and timestamps, while private/invalid destination
URLs and error echoes are redacted before client/audit output. Explicit previews
need no credentials or network. Runtime help corrects the captured claim that
reads ignore dry_run; the original captured schema remains unchanged. Three
executable read examples and provider/action descriptors identify the qualified
implementation and its limits. These were already native-read inventory rows;
no action denominator or write backlog is reduced by relabeling them.

Initial 22-test run: 21 passed, one failed. The new negative fixture found that
locations/456/extra was silently shortened to locations/456 by generic resource
parsing. Fixed exact input validation instead of weakening the assertion. Expanded
validation passed 81/81 across 24 new read tests, both Business Profile write
families, delegated routing and all executable guides. Build, generators and
guidance checks passed (83 traversed modules / 14 reviewed gateways).
Evidence: business-place-read-*.log under .runtime/contract-completion-20260919.

Official metadata/list/get references checked 2026-09-20, with reference pages last
updated 2024-10-16; exact URLs are linked in dv360-and-measurement.md. Native field
and enum assertions use the unchanged business-place-actions-v1 Discovery artifact.
Provider approval, live location eligibility and actual public display remain
unverified. Candidate AJ completed the full sanitized check: 1,273 tests passed,
zero failed, one optional FFmpeg skip, plus four capture tests passed. All check
stages exited zero. Its 520-file manifest records source-tree SHA256
09ca0052759354b6e920df6ab3520c9dac2ec1d8a95ce391bc5e3698b9f3c2be.
Evidence: install-aj.log and release-check-aj.log, using npm.cmd ci --ignore-scripts
and npm.cmd run check with the configured AMCP_SCHEMA_PYTHON. Required FFmpeg mode,
Docker and live provider/deployment checks remain unrun.

## 2026-09-20 — Business Profile account and administrator access (candidate AK)

Added seven reviewed gmb_account_ops actions: accountName-only PATCH_ACCOUNT and
CREATE/PATCH/DELETE_ACCOUNT_ADMIN and CREATE/PATCH/DELETE_LOCATION_ADMIN. Current
AMCP administrator status, exact native parent read/write grant, business.manage
and all shared deployment/review/idempotency guards remain mandatory. Reviewer
test accounts cannot change external administrator access. Account administration
also requires a native non-personal business account with owner authority.

Preparation reads the exact parent and complete native membership twice.
accountAdmins and admins are distinct unpaginated wrappers; unknown, empty,
duplicate, foreign, changing or unexpectedly paginated responses fail closed.
Bounds: 1000 members, 2 MiB per response, 8 MiB total, 30-second monotonic deadline.
All prerequisite reads recheck current actor, scopes and grants before/after
credential retrieval and egress, including separately granted invitee groups.
Active display names and verification/vetting telemetry are excluded from state;
pending email, native group, stable ID, role and invitation state remain protected.

Invitation requires exactly one user-approved email or, for a location, a
currently readable LOCATION_GROUP on that same login. Creation receipt must
bind a new native ID to that exact principal/role. Read-back separates pending
acceptance from active access. A verified pending-email receipt permits only
the subsequent acceptance transition; changed roles/groups/other members remain
inconclusive and never report verified access. Role-only masks, exact recipients,
active-primary-owner preservation and immutable fields are enforced. New or
increased access obeys activation policy; deletion/demotion obeys deletion policy.
Account names containing budget terms do not produce false spend confirmation.

Native location lists do not identify the acting Google user: the review explicitly
leaves native owner authority/seven-day restrictions to provider enforcement.
PRIMARY_OWNER transfers, native account creation, invitation acceptance/decline
and validateOnly remain separate unqualified contracts. No live access changes
were attempted. Generic friendly-resource parsing also rejects trailing resource
paths instead of silently truncating them; valid complete GA4 names still work.

Validation: initial build found one test-fixture syntax error, corrected. Initial
25-test execution passed 20 and failed five because fixtures omitted policy
confirmation/nesting, violated Store's write-grant subset invariant, assumed an
in-flight duplicate completed, or expected review gating before the earlier
confirmation gate. Corrected fixtures now assert the exact current contracts and
deterministically hold a provider mutation to verify concurrency. The expanded
run then found a malformed JSON example and an assertion using an internal
resources field instead of public verified_resources; both corrected. All
initial logs remain. No guard or assertion was disabled to pass tests.

Twenty-nine new tests plus related Business Profile/delegated compatibility
passed; the final expanded run passed 133/133 across access, delegated compiler,
GA4/GSC/Apple/GTM measurement writes and executable guide families. Build, both
contract generators and guidance validation passed (84 modules, 14 reviewed
gateways). Evidence: business-access-*.log in .runtime/contract-completion-20260919.
The 100-test intermediate compatibility run also passed before four extra cases.

Current inventory: 3241 actions, 415 reviewed-family rows, 902 blocked writes,
97 unmapped, 27 unqualified reads, eight input-dependent, four provider-unsupported,
1704 native reads, 68 local workflows, 16 media workflows. Counts qualify action
families only; permitted payload limits and all live qualification gaps remain.
Official v1 Account/Admin, create/patch/delete/list references checked 2026-09-20
(reference pages updated 2024-10-16), plus owner-permission help. Exact URLs,
pending-versus-accepted behavior and recovery are in dv360-and-measurement.md;
five new inspect examples execute without credentials or network. Provider
descriptor version is 7. Pinned native Discovery is unchanged.

Sanitized candidate AK full verification is pending. Required FFmpeg, Docker,
provider approval and live/deployment behavior are not established by fixtures.
Candidate AK completed the full sanitized check: 1302 passed, zero failed,
one optional FFmpeg skip, plus four capture tests passed. Every check stage
exited zero. The 522-file release manifest records source-tree SHA256
6eb154b00650be00080b925ca15ebbd348c6d0fb496cb880a7f8207e6cf4be02.
Commands: release assembly, npm.cmd ci --ignore-scripts, npm.cmd run check with
the configured AMCP_SCHEMA_PYTHON. Logs: install-ak.log and release-check-ak.log.
Required FFmpeg mode, Docker and live/deployment qualification remain unrun.

## 2026-09-20 — Google Ads recommendation dismissal (candidate AL)

Added the v23 dismissal RPC and legacy DISMISS_RECOMMENDATION reviewed family.
Both accept 1-100 distinct selected-customer resource names in one atomic,
same-native-type batch. Partial-failure execution, invented validation fields,
header/query overrides and implicit replacement recommendations are refused.
Dismissal does not apply suggestions or alter provider auto-apply subscriptions.

Preparation reads the client customer and complete selected recommendations
twice. It freezes dismissal status, type and exact campaign/ad-group/budget
associations. Unordered campaign membership is compared as a set; provider
query cost, request IDs and forecast impact are excluded. No proposed campaign
configuration is executed by this contract. Changed state retains exact field
diagnostics. Failed, duplicate, foreign, moving, count-incomplete, expired or
unexpected results are never accepted as successful empty state.
Bounds: 25 pages/query, 100 total requests, 100 selected rows/collection,
2 MiB/response, 8 MiB total, 60-second monotonic deadline. Native opaque IDs
remain strings; current selected connection, manager routing, grants and adwords
scope are rechecked before and after reads. Owner deletion policy covers POST
dismissal; activation/monetary controls do not misclassify it as a budget edit.

A receipt must name every selected ID exactly once. Verification must actually
read dismissed:true for those IDs with unchanged associations. Expiry/disappearance
after execution remains inconclusive rather than proof of dismissal. Lost or
partial responses preserve the original claim; deterministic concurrency and
SQLite-reopen tests prove a single submission without automatic retries.

Initial test compilation exposed stale fixture assumptions (a nonexistent Store
deleteConnection helper and omitted Compiler options), corrected using the
actual shared disconnect function and compiler contract. Initial runtime:
16/18 passed. One real diagnostic defect placed prerequisites ahead of state
comparison, masking STATE_CHANGED with already-dismissed input advice; separated
preparation prerequisites and reapplied them after the execution comparison.
The other fixture attempted unsupported public fields and expected a later gate;
it now checks that schema refusal and independently asserts WRITE_REVIEW_REQUIRED
for a forged direct runPlan. No guard or assertion was removed.

Expanded compatibility passed 80/80 across dismissal, Business Profile access,
Google schemas, snapshot projection, execution risk, policies and executable
guides. The final 22-test dismissal suite plus the latter shared tests passed
52/52 after adding opaque-ID, manager-routing, native-parent and review-integrity
cases. Build, contract generators and guidance checks passed (85 modules,
14 reviewed gateways). All initial and final logs are retained as
recommendation-dismiss-*.log in .runtime/contract-completion-20260919.

Official v23 request/response references checked 2026-09-20 (updated 2026-02-23),
native recommendation field reference and official retrieval/dismissal guide.
They document the 100-operation same-type atomic constraint, explicit dismissed
field and recommendation expiry. The current sample uses a newer API version;
runtime remains pinned to v23 Discovery, independently checked in tests.
Exact URLs and limitations are in the maintained Google Ads guide and a new
executable no-egress inspect example. Provider contract version is 13.

Inventory: 3241 actions, 417 reviewed-family rows, 900 blocked writes, 97 unmapped,
27 unqualified reads, eight input-dependent, four provider-unsupported, 1704
native reads, 68 local workflows and 16 media workflows. This qualifies only
dismissal; recommendation application/subscriptions remain separate work.
Candidate AL full verification passed: npm ci --ignore-scripts and npm run check
both exited 0 in .release/contract-batch-20260919-al. Main suite: 1324 passed,
zero failed, one optional FFmpeg skip; four capture tests passed. All remaining
check stages passed. Sanitized manifest: 524 files, source_tree_hash
65ee83022b57f31a6b1a068a1761c0b7f397b6c82839bb027a1841a00cb483a3.
Logs: install-al.log and release-check-al.log under
.runtime/contract-completion-20260919. Required FFmpeg mode, Docker and live
Google Ads mutation remain unrun; no provider access or permission was changed.

### Batch AM: scoped Meta existing-post discovery (implementation complete; full check pending)

Six previously unmapped `fetch_meta_existing_posts` actions now have explicit
runtime contracts: GET_PAGE_POSTS, FETCH_PAGE_POSTS, LIST_IG_MEDIA, GET_IG_MEDIA,
GET_POST_BY_ID and LOOKUP_POST_BY_URL. The captured registry remains unchanged;
a maintained runtime extension exposes only executable selection and read fields.
Source: src/meta-existing-posts.ts and src/meta-post-extensions.ts, with service,
catalog, action ledger, provider descriptor (Meta version 6), errors and guidance.

Every live read selects the exact Meta login/ad account, completes its Page
identity discovery, obtains only that Page's ephemeral access token server-side,
and checks native content ownership. Instagram additionally verifies the Page's
professional-account link and the advertiser's Instagram identity list. Current
actor, account grants, read scopes and credential identity are rechecked around
each provider request. Token retrieval races and in-flight reauthorization abort.
The workflow creates no persistent ownership or write grants, publishes nothing,
and returns native creative references accepted by separate local write inspect.
Native advertising eligibility still requires its own reviewed provider workflow.

Canonical user permalinks are parsed, never fetched. Short/share/profile/private
URLs cannot escape fixed Graph endpoints. Token-bearing paging and CDN URLs are
not returned or logged; provider error bodies are omitted to avoid token echoes.
Native cursors stay inside authenticated encrypted 15-minute continuations, bound
to tenant, actor, connection credentials, selection and Page-linked identity.
They survive workers/restarts sharing the master key and allocate no database
rows. Partial and resumed segments never claim global completeness. A partial
URL lookup cannot establish absence. Missing permalink/owner/partial envelopes,
duplicates and pagination loops fail explicitly.

Limits: 1-100 list results/call; URL search 1000 records/25 pages/call; account
identity collections 1000 records/25 pages each; 80 total requests, 2 MiB/response,
8 MiB total, 60-second monotonic deadline. The caller follows the returned
next_call for later segments. `dry_run:true` is no-egress input validation.

Instagram's optional instagram_basic scope is documented through the existing
AMCP_META_SCOPES override; defaults, existing tokens and provider permissions
are not silently changed. Five executable examples reconcile native reference
fields with meta_creative_create inspection. Page versus advertiser access,
reauthorization, app approval and content eligibility remain distinct.

Initial build caught three TypeScript narrowing/recursive return annotations;
fixed before runtime verification. Initial 24 tests passed. Expanded 29 tests
caught one real parser edge: Node base64 decoding accepted trailing data after
padding. Enforced canonical three-part ciphertext encoding and added explicit
padding/extra-segment tests. Final targeted compatibility: 55 passed, zero failed,
including 30 new read/negative/restart tests, Meta contracts/provisioning/library,
OAuth scope controls, inventory and guidance. Initial logs remain under
.runtime/contract-completion-20260919/meta-post-*.log. Build, source fixture
regeneration, contract generators and guidance passed (87 modules, 14 gateways).

Official documentation accessed 2026-09-20: pinned Meta Python SDK 25.0.3 for
Page, PagePost, IGUser, IGMedia and AdAccount; Meta-owned Facebook and Instagram
Postman collections for Page token and linked-account authorization. Direct Meta
documentation returned 429. The source-hashed two-model/four-edge fixture is
regenerated by tools/meta-post-evidence.mjs from public files only; runtime uses
no SDK dependency. Current native field/token acceptance, approval and eligibility
remain unverified live. URLs and research limitations are in the Meta guide.

Current inventory: 3241 actions, 417 reviewed-family, 900 blocked writes,
91 unmapped, 27 unqualified reads, eight input-dependent, four provider-unsupported,
1704 native reads, 74 local workflows and 16 media workflows. Vendor denominator
still contains 1208 pinned methods with 454 unmapped; Apple SDK includes 99 methods
with 58 unmapped. Amazon remains zero captured actions with unknown API coverage.
No provider mutation or permission change occurred.
Candidate AM full verification passed: npm ci --ignore-scripts and npm run check
both exited 0 in .release/contract-batch-20260919-am. Main suite: 1354 passed,
zero failed, one optional FFmpeg skip; four capture tests passed. Every remaining
check stage passed. Sanitized manifest: 529 files, source_tree_hash
a7a3e79e1933d05d0fa9db82d1ca08b0fefccb09b3312e733e34e6c140803b29.
Logs: install-am.log and release-check-am.log under
.runtime/contract-completion-20260919. Required FFmpeg mode, Docker and live
Meta approval/token/content/advertising eligibility checks remain unrun.
