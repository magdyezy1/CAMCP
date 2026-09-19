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
| GA4, Business Profile and Search Console gaps | Pending | Granular administrative authority and documented local/OAuth routing. |
| Adjust, Commerce, Amazon and other unmapped actions | Pending | Establish actual provider product and executable contracts; do not invent missing specifications. |
| First full regression and branch push | Complete locally; pushed | `95b85ff` pushed to `Codex-branch`. Fresh release: 700 tests passed, one FFmpeg test skipped, four capture tests passed; generation, guidance, web, provider integrity and Railway compatibility checks passed. Container smoke checks require Docker. |

Live advertising mutations, permission changes, production deployment and real
customer-data uploads are outside this implementation authorization. They are
qualification dependencies, not a reason to omit locally implementable code.

## Current checkpoint (2026-09-19)

The working tree now inventories **3,241 actions**, including **383 reviewed-family
rows**. **931 mapped writes, 104 unmapped actions, 31 unqualified reads and eight
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
