# Provider action implementation progress

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
