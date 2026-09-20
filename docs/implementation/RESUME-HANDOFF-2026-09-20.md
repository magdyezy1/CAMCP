# Resume handoff — 2026-09-20

The user requested finishing the in-progress work, documenting everything left,
and stopping until usage limits refresh. This is a deliberate stopping checkpoint,
not completion of the earlier request to implement every provider action.

## Start here

1. Read this file and the latest AN entry in
   [the progress ledger](CONTRACT-COMPLETION-PROGRESS.md).
2. Verify the checkout, branch, remote and current changes before editing.
3. Recompute the action inventory if the branch has changed. Compare the delta
   against this frozen checkpoint instead of replacing its historical evidence.
4. Resume one bounded provider family at a time using the acceptance gate below.
   Do not reopen completed batches merely to rediscover their architecture.

**Final verification and push status:** AN implementation and full local release verification are complete. The final commit/push check is recorded in the task response; use the remote Codex-branch and the commit containing this file to verify the checkpoint. No next family is in progress.

The working tree before AN was `e961eb851add20015849fa10145e8fbf05b43cf4`.
The commit containing AN and this file is discoverable with
`git log -1 --format=fuller -- src/google-user-access.ts`. Do not expect a commit
to contain its own hash; the final task response and remote record it.

## Workspace, authorization and boundaries

- Implementation checkout:
  `C:\Users\abdom\Downloads\AMCP Final With Claude recos - Copy\implementation-Codex-branch`.
- Branch: **Codex-branch only**. Remote: `https://github.com/magdyezy1/AMCP.git`.
  Authorized destination: `HEAD:refs/heads/Codex-branch`.
- The parent development directory and historical `.release/AMCP` checkout are
  separate. They were not edited by this implementation series. This checkout's
  own `git worktree list` shows just itself; that does not inventory independent
  repositories in other directories. Never treat the desktop cwd as the source.
- Series base: `d7f3fad8f4fc499123e6be71f4d0d11408befcd4`.
  Last recorded remote main: `067871481d79fc59a6cb976d8a13b62d409e283a`.
- Runtime verified here: Node **24.19.0**, npm **11.17.0**, Windows PowerShell.
  Use `npm.cmd` to avoid the PowerShell shim execution-policy issue.
- Use `git -c "safe.directory=$taskRoot"` for this checkout. Network push may
  need sandbox escalation; authorization already exists for Codex-branch.
- No live advertising changes, invitations, native permission changes, credential
  changes, provider application submissions, production deployment, account-data
  collection, GitHub main changes or messages to other people are authorized.
- Research public official documentation and use isolated synthetic fixtures.
  Do not read `.env`, credential files, live SQLite files or
  `.mirror/RESULTS/live-read-samples.json`. The release assembler replaces that
  historical account-response file without reading it.
- No subagents, new tasks, automations or usage-credit redemption were requested.
  The latest instruction is to stop after this checkpoint; resume on user request.

## What was finished immediately before stopping

AN implements six previously blocked Google Ads user-access action rows through
`src/google-user-access.ts` and its shared review/verification hooks:

- CREATE_CUSTOMER_USER_ACCESS_INVITATION
- REMOVE_CUSTOMER_USER_ACCESS_INVITATION
- UPDATE_CUSTOMER_USER_ACCESS
- REMOVE_CUSTOMER_USER_ACCESS
- google_ads_v23_customer_user_access_invitation_mutate_customer_user_access_invitation
- google_ads_v23_customer_user_access_mutate_customer_user_access

These are exact client-account permission operations, not a universal mutate gate.
They use singular native `operation` and `result`, exact mutable-role masks,
current workspace administrator checks, selected-account write grants and adwords
scope. Owner activation policy controls invitations/promotions; deletion policy
controls removal/demotion. Singular Google POST removals also now carry destructive
metadata. No native permission was changed during development.

Prepare reads the customer and complete direct members/invitations twice. The
semantic snapshot ignores cost/trace/timestamps/order but preserves identity,
email, role, invitation status and pending authorization. Page/count/byte/time
bounds, duplicate recipients, unknown state, manager-wide changes, no-op roles,
pending changes and last-direct-admin removal/demotion fail explicitly. Exact
receipt and independent read-back are required. A sent invitation is never reported
as accepted access and never creates AMCP ownership grants.

The final Discovery comparison found optional `multiPartyAuthReview` in native
receipts. A valid scoped target plus that field is accepted as a receipt; current
pending state stays inconclusive. A review-only receipt without a target retains
an uncertain claim. Native approval/rejection and manager recovery are unimplemented
variants, not permission to resend. Google can allow acceptance with a different
email; disappearance/new membership cannot prove that the invitation was accepted.

AN has 25 new tests and two executable guidance examples. The compatibility run
passed 75 tests, zero failures/skips. It covers lifecycle, both action surfaces,
malformed fields, exact scoping, policy changes, telemetry versus real conflicts,
paging, in-flight revocation, pending reviews, partial/lost receipts, concurrency,
review tampering/expiry and SQLite replay. Build, source extraction/regeneration,
contract generation and guidance passed. Google descriptor is now version 14.
No runtime dependency, schema migration or deployment setting was added.

Recent completed/pushed batches to preserve:

| Commit | Completed bounded work | Local release evidence |
|---|---|---|
| e961eb8 | AM: six scoped Meta existing-post read actions; private Page tokens, Page/Instagram ownership, encrypted continuations and creative-reference handoff | 1354 main tests passed, 0 failed, 1 optional FFmpeg skip; 4 capture tests passed; full check exited 0 |
| 298d9fa | AL: Google recommendation dismissal on RPC and legacy surfaces; atomic same-type selections, scoped state and read-back | 1324 main tests passed, 0 failed, 1 optional FFmpeg skip; 4 capture tests passed; full check exited 0 |
| e0c89ec | AK: Business Profile account/admin changes within explicit ownership/recovery limits | See AK entry and original retained release log |
| b752cef | AJ: Business Profile place-action discovery and complete scoped reads | See AJ entry |
| 6fdeed3 | AI: scoped local connection disconnect workflows | See AI entry |
| 06ef4bb | AG/AH: Business Profile public action links and account notifications | See AG/AH entries |
| 137cf76 | Existing Google Search campaign call bid-modifier update/removal | See progress ledger |
| c24be9b | Scoped connection diagnostics and OAuth audit-input protection | See progress ledger |
| f985253 | Meta asynchronous report creation and scoped result retrieval | See progress ledger |
| bc4ffd0 | Google conversion-goal inheritance and custom-goal workflows | See progress ledger |

Earlier implementation families and original failures remain in
[the evidence ledger](CONTRACT-COMPLETION-2026-09-19.md). Historical “pending” text
there describes earlier moments; the later result entry supersedes it.

## Exact remaining denominator

Authoritative generated files:

- [All 3241 action rows as CSV](ACTION-CONTRACT-COVERAGE.csv)
- [All action rows with reasons, implementations and tests as JSON](ACTION-CONTRACT-COVERAGE.json)
- [Pinned vendor method inventory](VENDOR-METHOD-COVERAGE.json)
- [Frozen remaining-action CSV for this stop](REMAINING-ACTIONS-2026-09-20.csv)
- [Machine-readable verification checkpoint](VERIFICATION-CHECKPOINT-2026-09-20.json)

The frozen CSV contains every blocked, unmapped, unqualified, input-dependent and
provider-unsupported action row, with its gateway, operation, exact action, path,
reason and evidence. It is a dated stop snapshot; regenerate the normal inventory
when implementing later work. Snapshot hashes/counts are recorded below.

Frozen rows: **1024** (1020 incomplete + 4 provider-unsupported).

Remaining CSV SHA-256: `c299c396831120721eed015dd47599d6ddea4aa88140dd8e89172dd585f0a1ec`.

Source action JSON SHA-256: `aed876b8184b0f4c33fd4f3deabf1ac7e43aba3fd3730f317bd974e4fe2c255f`.

Current totals: **423 reviewed-family**, **894 blocked mapped writes**, **91 unmapped**,
**27 unqualified reads**, **8 input-dependent**, **4 provider-unsupported**,
**1704 native reads**, **74 local workflows** and **16 media workflows**.
There are **1020 incomplete catalog rows**, plus **4 provider-unsupported rows**
that cannot honestly be implemented through their withdrawn API routes.

`reviewed_write_family` means a declared family exists, not that every payload,
ownership variant, operation or account approval is supported. `native_read` means
the transport/risk path is recognized; it is not end-to-end or live qualification.
Every row's live qualification is unverified. No platform is certified complete.

| Gateway | Total | Reviewed | Blocked | Unmapped | Unqualified | Input-dependent | Unsupported | Native reads | Local | Media |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| adjust_native_action | 29 | 0 | 0 | 29 | 0 | 0 | 0 | 0 | 0 | 0 |
| amazon_native_action | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| amcp_native_action | 77 | 0 | 0 | 15 | 0 | 0 | 0 | 0 | 62 | 0 |
| amcp_platform_workspace | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 0 |
| apple_ads_native_action | 41 | 21 | 0 | 0 | 0 | 0 | 0 | 20 | 0 | 0 |
| commerce_native_action | 31 | 0 | 0 | 31 | 0 | 0 | 0 | 0 | 0 | 0 |
| criteo_native_action | 108 | 9 | 45 | 3 | 0 | 0 | 0 | 51 | 0 | 0 |
| dv360_native_action | 173 | 30 | 62 | 0 | 2 | 0 | 0 | 78 | 0 | 1 |
| ga4_native_action | 24 | 2 | 0 | 4 | 0 | 0 | 0 | 16 | 2 | 0 |
| google_ads_native_action | 456 | 152 | 117 | 0 | 2 | 8 | 0 | 175 | 0 | 2 |
| google_business_native_action | 59 | 11 | 12 | 5 | 0 | 0 | 0 | 28 | 3 | 0 |
| google_search_console_native_action | 16 | 4 | 0 | 4 | 0 | 0 | 0 | 6 | 2 | 0 |
| gtm_native_action | 108 | 64 | 0 | 0 | 0 | 0 | 4 | 38 | 2 | 0 |
| linkedin_native_action | 287 | 18 | 123 | 0 | 0 | 0 | 0 | 146 | 0 | 0 |
| meta_native_action | 591 | 30 | 136 | 0 | 1 | 0 | 0 | 420 | 0 | 4 |
| microsoft_ads_native_action | 28 | 14 | 0 | 0 | 0 | 0 | 0 | 14 | 0 | 0 |
| reddit_native_action | 51 | 13 | 0 | 0 | 0 | 0 | 0 | 38 | 0 | 0 |
| snapchat_native_action | 412 | 23 | 108 | 0 | 8 | 0 | 0 | 269 | 0 | 4 |
| tiktok_native_action | 561 | 12 | 221 | 0 | 14 | 0 | 0 | 310 | 0 | 4 |
| x_ads_native_action | 186 | 20 | 70 | 0 | 0 | 0 | 0 | 95 | 0 | 1 |

The independent vendor denominator has **1208 pinned methods**, **454 with no
mapped action**. This is a separate and overlapping population; do not add 454
to 1020 as if the union were known. Apple has 99 SDK methods, 58 unmapped.
Microsoft's small action catalog conceals a much larger captured WSDL denominator.
Amazon has zero captured actions and unknown API coverage, not “zero work left.”

| Pinned vendor / gateway | Methods | No mapped action |
|---|---:|---:|
| google_business_native_action | 51 | 0 |
| criteo_native_action | 108 | 3 |
| dv360_native_action | 179 | 6 |
| ga4_native_action | 82 | 60 |
| google_ads_native_action | 176 | 3 |
| gtm_native_action | 106 | 0 |
| microsoft_ads_native_action | 291 | 263 |
| reddit_native_action | 105 | 60 |
| google_search_console_native_action | 11 | 1 |
| apple_ads_native_action | 99 | 58 |

## Remaining work by product and provider

The rows and reasons in the CSV are exhaustive for the current catalog. The
following groups explain how to turn those rows into engineering work without
mistaking a generic path match for an implemented workflow.

| Area | Work still needed / implementation shape | Critical proof and dependencies |
|---|---|---|
| Google Ads | 117 blocked writes: portfolio strategy mutations; conversion actions/value rules and lifecycle goals; customer/user lists and audience graphs; asset listing-group trees; drafts/experiments; batch and offline jobs; conversion uploads; product/account/data links; billing/reservations/incentives; manager/customer configuration; native multi-party approval; recommendation application/subscriptions; automatic-asset removal and YouTube-upload changes. Eight shorthand adapters need actual discriminator inputs; two shareable-preview actions remain unqualified. | Per-family native masks/IDs, complete affected graph and monetary units, exact atomic/partial/LRO receipts and persistent recovery. Never enable arbitrary googleAds:mutate as a bypass. Provider eligibility and consent vary. |
| Meta | 136 blocked writes and one unqualified ad-network analytics job. Continue from completed existing-post discovery and Insights jobs into remaining account/business, audience, catalog/product, pixel/event, creative/ad and other object-specific families in the CSV. | Fixed Graph edges, Page/IG/business ownership separate from account grants, scoped tokens, native error envelopes, permissions/app review, media/creative identity eligibility and async completion. |
| TikTok | 221 blocked writes, 14 unqualified reads; async reports, preview/generation and Smart/GMV/commerce/business-centre operations require separate contracts. Some “read” names mutate rules or create jobs. | Reclassify from documented semantics; inspect advertiser/business-centre/shop identities, native success codes, job IDs, serving effects, exact ownership and app access. No HTTP-method-only safety decision. |
| Snapchat | 108 blocked writes and 8 unqualified actions, including leads jobs and event-validation routes. | Full account/organization/asset ancestry, lead-data permissions/retention, async report completeness, native upload processing, event PII and side effects; do not call validation harmless without evidence. |
| LinkedIn | 123 blocked writes beyond completed selected campaign/creative/organization/conversion families. | Version headers and REST.li batch/partial-update semantics, exact sponsored-account and organization identity, spend deltas under patches, UGC/content owner, empty success and per-element errors. |
| X | 70 blocked writes beyond completed drafts/creatives and other declared routes. | Distinguish draft/preview from publishing/promotion; OAuth1 signatures and encoded bodies, account/handle/card ownership, async media state, spend and duplicate-post recovery. |
| DV360 | 62 blocked writes, 2 unqualified upload-rule/script operations and 6 pinned methods unmapped. Partner channels are still blocked; advertiser channels/lists already work within their guide limits. | Partner access must cover all affected advertisers. Bulk/line-item/budget/targeting/audience and script upload operations require their own state/provenance/receipt contracts. Do not broaden advertiser regexes to partners. |
| Criteo | 45 blocked writes, 3 unmapped async report actions. Preferred-line-item targeting is implemented within its limits. | Retailer/account/campaign attribution and budget units; persistent async report state; native partial errors; website connection flow and provider authorization remain distinct work. |
| Google Business Profile | 12 blocked writes, 5 unmapped actions: browser connection start/exchange/refresh, asset synchronization and legacy-v4 generic request. | Already-complete local status/disconnect/admin/place-link/notification work must be reused. Transfers, verification and legacy generic requests require exact effects and permission contracts, not blanket passthrough. |
| GA4 | 4 unmapped connection/property-sync operations; 60 pinned methods lack mappings despite few catalog gaps. | Reuse secure OAuth implementation with state/PKCE/identity and separate Analytics scopes; qualify admin/data methods individually; reporting semantics and cardinality/thresholds remain distinct from route coverage. |
| Search Console | 4 unmapped connection/site-sync operations and 1 pinned unmapped method. | Exact site/property identity, current scopes/owner rights and URL-prefix/domain-property semantics; don't conflate site visibility with verified ownership. |
| GTM / Google tag | Four withdrawn methods are explicitly provider_unsupported: COMBINE_CONTAINERS, GET_DESTINATION, LINK_DESTINATION, MOVE_TAG_ID. All other captured rows have declared families/reads/local workflows, with payload restrictions. | Keep withdrawn operations visibly unsupported with documented alternatives. Do not fabricate an implementation for unavailable native methods. Live permissions, approval and complete journey qualification remain open. |
| Microsoft Ads | 28 mapped actions have declared reads/families; 263 of 291 pinned WSDL methods remain unmapped. | Exact JSON/service contracts, polymorphic types, customer/account scope, per-element errors, library/media/bulk/report jobs and durable download/upload recovery. WSDL method presence alone is insufficient. |
| Apple Ads | 41 mapped actions; 58 of 99 SDK methods unmapped. | Reuse explicit SDK model extraction; org-wide/shared-budget writes must prove all affected account grants and policies. Catalog completion is not full SDK coverage. |
| Reddit | 51 catalog rows have declared reads/families; 60 pinned methods unmapped. Max, customer ingestion and private Drive upload remain unqualified variants. | Preserve classic/structured post jobs and verified post-to-ad handoff. Separate consent/PII uploads, current Max schemas, private-file transport, ownership and result polling. |
| Adjust | All 29 captured actions unmapped: application automation, tracker/deeplink APIs, reports and ad-spend ingestion. | Verify official product/API versions, entitlement and authentication. Separate reporting from secret revocation or ad-spend writes. Do not invent requests from action labels. |
| Commerce | All 31 WooCommerce/store operations unmapped. | Account/store ownership, SSRF-safe configured store origins, WordPress/WooCommerce versions and reporting-plugin dependencies, pagination, order/customer PII and field semantics. |
| Amazon | Zero captured actions; coverage unknown. | Identify actual Ads product/region/API and approved integration; public documentation research is implementable now, live approval/access requires the owner/provider. |
| AMCP delegated workflows | 15 unmapped: Google-reporting start/exchange/disconnect; cross-platform transfer; creative download/content/design/payload; targeting suggestions; six openai_ads_ops. | Specify input/output and provider contracts first. Reuse existing connection/media/review services, avoid exposing credentials/private URLs or making the LLM relay media. Unknown external API operations need official evidence, not a invented adapter. |

## Research already done but not implemented

### Google campaign drafts and experiment promotion

Official v23 campaign_draft resource/service protos confirm the composite resource
`customers/{id}/campaignDrafts/{baseCampaignId}~{draftId}`. Create selects an exact
base campaign/name; update changes the name; remove is separate. Native PROPOSED
draft status differs from normal campaign ENABLED/PAUSED. Promotion returns a
long-running operation; done alone does not prove successful promoted state.

Next contract must freeze the complete copied base-campaign hierarchy, budgets,
bidding and relevant targeting, project the draft state and interpret final native
errors/status. Do not reuse a generic campaign descriptor whose status enum rejects
PROPOSED. The four mutation action rows and two promotion rows remain blocked.
Sources: [resource proto](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/resources/campaign_draft.proto),
[service proto](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/services/campaign_draft_service.proto),
[v23 fields](https://developers.google.com/google-ads/api/fields/v23/campaign_draft).
These are research notes, not a finished patch or live observation.

### Google automatic recommendation subscriptions

Four action rows remain blocked: native subscription mutate, SUBSCRIBE_RECOMMENDATION,
UNSUBSCRIBE_RECOMMENDATION and UPDATE_RECOMMENDATION_SUBSCRIPTION. Native subscription
resources key by recommendation type; create/update use ENABLED/PAUSED, not remove.
The legacy unsubscribe alias must mean the exact paused-state operation.
Enabling subscriptions permits future provider changes outside individual AMCP
reviews. A type-specific owner policy and explicit future-effect review are needed
before supporting it; do not bypass financial safeguards. Recheck supported and
deprecated recommendation types against current official docs.
Source: [automatic recommendations](https://developers.google.com/google-ads/api/docs/recommendations#automatically_apply_recommendations).
Recommendation dismissal is already implemented and is a different effect.

### Immutable or unavailable native variants

UPDATE_CUSTOMIZER_ATTRIBUTE may be impossible because the native attribute is
immutable. Verify the exact v23 operation message before implementing or moving it
to an explicitly unsupported category. Existing GTM retirement rules are evidence
for those four GTM routes only, not a generic permission to delete catalog gaps.
CREATE_CAMPAIGN_BID_MODIFIER also needs fresh official qualification; existing
update/removal coverage deliberately does not claim create support.

### Shared resource ownership and native multi-party authorization

DV360 partner-channel actions need explicit partner grants and all affected
advertiser impact. Google manager-wide user access and last-direct-admin removal
need descendant-account/recovery-owner proof. Google native multi-party resolution
needs review-resource identity, old/new principals, operation/status binding and
read-back. AN accepts scoped target receipts but does not implement approval or
claim a review-only response proves a target exists. These are separate families.

### Hypothesis requiring investigation, not a confirmed defect

Meta campaign preflight checks Page/Instagram prerequisites. Direct creative
review may rely on different validation. Trace guessed source_instagram_media_id
and instagram_user_id through direct amcp_write to prove current owner/advertiser
binding, including after grants change. New existing-post reads validate ownership
but create no persistent write ownership. Relevant modules:
`src/creative-validation.ts`, `src/campaign-preflight.ts`, `src/write-review.ts`,
`src/meta-existing-posts.ts`. Add a failing cross-account synthetic reproduction
before calling this a confirmed gap; do not assume it is safe or unsafe from names.

## Implementation order and acceptance tickets

Effort is relative: S = one bounded contract/fixture change, M = multiple related
contracts or a browser flow, L = async/multi-resource workflow. These estimates
assume official schemas are accessible; native approval and live qualification
are separate dependencies. This is planning priority, not inflated bug severity.

| Ticket / priority | Implementable next step | Acceptance / proof | Dependencies and compatibility |
|---|---|---|---|
| R1 / P1 / M | Investigate direct Meta creative ownership hypothesis above; repair only a demonstrated mismatch | Guessed foreign post/media and in-flight revoked binding cannot submit; valid existing-post-to-creative fixture succeeds; no persistent grant from an unverified receipt | Current Meta identity contracts and synthetic fixtures. Preserve public existing-post interfaces. |
| R2 / P1 / M | Qualify one remaining advertiser-scoped core write family at a time, prioritizing actual campaign blockers from the frozen CSV | Exact payload inspect, scoped prepare/execute/read-back, negative grant/money/telemetry tests; no generic gateway exemption; action counts change only for exercised rows | Current official provider docs; native app/account permissions still live-dependent. Additive family gates allow rollback by reverting the new family. |
| R3 / P2 / M | Finish scoped async reporting/preview families for Criteo, TikTok and Snapchat before catalog-read reclassification | Failures/partial reports remain visible; jobs bind actor/account/definition; restart/polling/download tests; one request creates at most one job after lost response | Reuse Meta/Reddit durable job patterns, not a new queue unless measured necessary. Privacy and rate limits differ per provider. |
| R4 / P2 / M | Connect remaining GA4/Search Console/Business Profile and Google-reporting delegated routes to existing OAuth/session services | State/PKCE/resource/client binding, replay, public/confidential clients, reconnect races and exact selection tested; no social-sign-in scope substitution | Browser user interaction and provider approval required for live proof; preserve website flow and stored grants. |
| R5 / P2 / L | Implement Google draft/experiment graph and promotion recovery | Composite IDs, copied graph, PROPOSED state, budget effects, partial LRO failure, crashes/restart and independent final-state verification | Build on existing campaign jobs/reviews; don't activate copied campaigns implicitly. Versioned job schema if persisted state changes; maintain old job readers. |
| R6 / P1 / L | Add manager/partner/native approval contracts only with complete affected-resource and recovery-owner evidence | Cross-account/tenant isolation, owner policies on every affected account, no last-owner loss, explicit asynchronous approval status | Business rule on delegation/owner authority plus provider documentation/live permissions. Keep excluded variants blocked until qualified. |
| R7 / P2 / L | Add recommendation auto-apply policy and consent/PII/offline-upload workflow contracts separately | Exact type consent and bounded future-effect policy; PII handling and hashing rules; per-record errors, durable batches and no replay under a new key | Owner/product decision for future automatic changes and customer-data processing. Preserve per-write review for direct mutations. |
| R8 / P2 / M-L | Expand Microsoft/Apple/Reddit and other pinned vendor methods using the independent denominator | Every newly mapped method links an exact native request/receipt/schema fixture and negative lifecycle test; unsupported variants remain explicit | Preserve runtime dependencies and native versions unless a migration is separately justified. Method count is not completion evidence. |
| R9 / P2 / M | Establish Adjust/Commerce/Amazon and unknown delegated API specifications | Verified provider/product/version/auth and task inputs before adapter code; executable no-egress inspect; unsupported or external-blocked state visible | Entitlements and private documentation may require user/provider; local public research and deterministic parsers can proceed now. |
| R10 / P1 / M | Complete release-environment and deployment qualification after contract batches | Required FFmpeg suite and container smoke pass in provisioned disposable runtime; health/storage/non-root/graceful restart; restore/rollback exercised | FFmpeg/ffprobe/Docker and authorized deployment/staging access. No production changes implied by this ticket. |
| R11 / P2 / M | Reconcile product journeys across UI, backend, CSV, Sheets and campaign recovery | One fixture retains IDs, dates/timezones, currency, metric provenance and partial-source status across surfaces; schedules independent; input/reconnect/error states tested | Existing reporting/scheduling behavior must survive. Baseline meaningful UI fixtures before refactoring. |
| R12 / P2 / S-M | Keep capability and guidance evidence synchronized | CI verifies every family has executable examples, official evidence provenance and explicit unsupported variants; test negative scope/receipt behavior | Reuse current generators and code gates; no rewrite/framework/database migration needed to qualify another family. |

For each family: capture versioned official evidence; define exact supported and
unsupported forms; compile without credentials; prove prerequisite/ownership
reads; implement immutable reviewed execution and policy checks; handle native
success/partial/error/async results; verify actual state; exercise concurrency,
lost responses, expiry/revocation and restart; add executable guidance; regenerate
both denominators; run focused tests and the sanitized full release check; commit
and push only Codex-branch. Never lower a failing assertion to reach green.

Rollback is normally a revert of the additive family and its capability/guidance
entries. Retain durable review/job receipts and version-aware readers; do not clear
idempotency records or resubmit previously uncertain work. AN requires no migration.

## Broader audit and product work still not certified by these batches

The original audit scope also includes password/recovery/MFA/invitations/sessions,
MCP OAuth including client_secret_post and resource binding, session/CSRF/CORS/CSP,
SSRF/redirect/DNS/media security, privacy-policy accuracy, SQLite migration/backup
and restore, multi-replica pacing/leases, deployment readiness, browser accessibility
and real campaign/reporting/media task completion. Existing tests and earlier
reviews are evidence, not a claim that these whole subsystems were freshly audited
in AN. Preserve [the earlier integration review](PLATFORM-CONTRACTS-2026-09-18.md),
[verification notes](VERIFICATION.md), [X creative evidence](X-CREATIVE-VERIFICATION.md)
and the prior product recommendations. Reconcile their unresolved items against
current code when returning to the comprehensive audit. Do not silently treat the
action ledger as the original audit's per-file coverage ledger.

Methodology improvements remain: reusable business-input profiles and account
groups, task plans with explicit prerequisites and recovery, native metric semantic
compatibility and confidence, provider deprecation tracking and contract drift,
credential/approval/quota health, retention/deletion controls and measurable staging
acceptance. Implement the smallest change backed by a demonstrated workflow issue;
a new framework, database, queue or service is not a prerequisite.

## Verification evidence and exact resumption commands

Local runtime directories contain synthetic logs/public source evidence, not
committed test outputs. Preserve initial failed logs alongside successful reruns.
AN initial build had seven TypeScript narrowing errors, corrected before runtime
tests. Initial 21 tests passed; the final expanded 25 passed within the 75-test
compatibility run. Optional native review receipt support was added after the final
Discovery comparison, then covered by negative and lifecycle tests.

Full candidate AN: `.release/contract-batch-20260919-an`.
Sanitized source manifest: **533 files**,
`source_tree_hash=59489cbcc71ce291eb451d2b7becf92cac5c4b2bc5fa04bbec8797cf5a03d61c`.
The manifest revision is pre-commit e961eb8 because it records the source checkout
before AN is committed; file hashes capture the uncommitted implementation.
This handoff/frozen CSV and final result paragraphs were written while/after the
check ran; compare executable source hashes to confirm no code delta afterward.

Logs under `.runtime/contract-completion-20260919/`:

- `google-access-build-1.log`, `google-access-build-2.log`, `google-access-build-3.log`
- `google-access-build-final.log`, `google-access-tests-1.log`
- `google-access-targeted-final.log` — 75 passed / 0 failed / 0 skipped
- `install-an.log` — npm ci --ignore-scripts exited 0
- `release-check-an.log` — full check exited 0; main suite 1379 passed / 0 failed / 1 optional FFmpeg skip; 4 capture tests passed
- `release-check-am.log`, `release-check-al.log` — retained earlier full runs
- `google-user-access-protos/` — nine public v23 protos; not customer data

No Docker, FFmpeg or ffprobe was installed/available in this environment. Required
FFmpeg mode and Docker smoke were not run. Optional FFmpeg skip must stay visible.
Do not reinterpret a normal full check as the earlier CI command
`AMCP_REQUIRE_FFMPEG=true npm run check`. The latter needs provisioned binaries.

Start with metadata only:

```powershell
$taskRoot = 'C:\Users\abdom\Downloads\AMCP Final With Claude recos - Copy\implementation-Codex-branch'
Set-Location -LiteralPath $taskRoot
git -c "safe.directory=$taskRoot" status --short
git -c "safe.directory=$taskRoot" branch --show-current
git -c "safe.directory=$taskRoot" rev-parse HEAD
git -c "safe.directory=$taskRoot" remote get-url origin
if ((git -c "safe.directory=$taskRoot" branch --show-current) -ne 'Codex-branch') { throw 'Unexpected branch' }
```

Build, regenerate and inspect the current incomplete population:

```powershell
npm.cmd run build
node dist/tools/generate-contracts.js
node dist/tools/action-contracts.js
node tools/google-access-evidence.mjs --source-dir .runtime/contract-completion-20260919/google-user-access-protos --check
$actionLedger = Get-Content docs/implementation/ACTION-CONTRACT-COVERAGE.json -Raw | ConvertFrom-Json
$actionLedger.actions | Where-Object { $_.status -in @('blocked_write','unmapped','unqualified_read','adapter_requires_input') } | Group-Object gateway,status | Select-Object Count,Name
```

The proto extraction command requires the nine public sources named/hashed in the
fixture. Fetch those official files if resuming elsewhere; never fetch credentials.
Provider specifications can change, so inspect a hash mismatch rather than blindly
regenerating expected evidence.

AN focused command (run build first):

```powershell
node --test --test-concurrency=1 dist/tests/google-user-access.test.js dist/tests/google-contracts.test.js dist/tests/google-legacy.test.js dist/tests/write-review.test.js dist/tests/review-state.test.js dist/tests/spend-policy.test.js dist/tests/action-contracts.test.js tests/guide-contract-examples.test.mjs
```

Before adding filenames to a command, verify them with `rg --files tests`.
Some guessed test paths in exploratory commands did not exist; they are not
evidence of checks. The complete fresh build/test run is the authoritative suite.

Full checks must run in a **new** sanitized candidate, never against private
historical captures in the implementation directory:

```powershell
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'safe.directory'
$env:GIT_CONFIG_VALUE_0 = $taskRoot
# Choose the next unused candidate name; never overwrite AN.
node tools/prepare-public-release.mjs .release/contract-batch-resume-ao
Set-Location -LiteralPath (Join-Path $taskRoot '.release/contract-batch-resume-ao')
$env:AMCP_SCHEMA_PYTHON = 'C:/Users/abdom/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
npm.cmd ci --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'Install failed' }
npm.cmd run check
if ($LASTEXITCODE -ne 0) { throw 'Release check failed' }
```

The complete script checks catalog/vendor/WSDL/feed generation; builds and runs
built-in Node tests; capture tests; report/guidance; website checks; provider drift
and lifecycle; generated contracts and action inventories. It uses local evidence
and fixtures, not live account qualification. See package.json for current script
contents rather than assuming historic test totals remain current.

On later commits, stage only reviewed files, run `git diff --check`, verify the
branch again, commit with the repository's configured identity or the existing
Codex identity, and push `origin HEAD:refs/heads/Codex-branch`. Verify the returned
remote commit and clean status. Do not force-push, merge main, or push all branches.

## What requires external input or evidence

- Live credentials and account authorization for actual provider read/write
  acceptance, scoped discovery, native errors, uploads/processing and billing units.
- Provider application review, access tiers, product entitlements and quotas.
  HTTP 403 alone does not identify which is missing.
- Explicit authorization for live sandbox writes, invitations/native permission
  changes, customer-data uploads or any production deployment.
- Business decisions on automatic recommendation subscriptions, delegated/shared
  authority, customer-data consent/retention, reporting attribution/targets and
  intended coverage of unavailable or unknown products.
- Authorized staging/deployment access and provisioned media/container tools for
  required FFmpeg, Docker, proxy/edge policy, volumes, backups/restore and multi-worker
  behavior. Source assertions cannot prove operational retention or restore ability.

None of those dependencies justify fabricating supported actions. Continue local
contracts/tests that have sufficient public evidence, label the blocked variants
precisely, and keep live qualification distinct from synthetic success.

## Suggested next user message

“Resume from docs/implementation/RESUME-HANDOFF-2026-09-20.md in
implementation-Codex-branch. Verify the checkout and delta, then continue the
remaining provider contracts one qualified family at a time. Edit and push only
Codex-branch. Preserve reviewed-write, account-scope and spending controls. No live
advertising or permission changes. Keep the progress and action ledgers current.”
