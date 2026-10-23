# Contract integration and maximum usable capability blueprint

**Archived on 2026-10-22** (DOC-03, owner decision P12): kept as it was written, with links to current addresses.
A 2026-10-01 proposal: its scope is in the [blueprint](../review/PRODUCT-BLUEPRINT-2026-10-01.md) and its outcomes
in [decisions](../DECISIONS.md).

Review-only proposal for `magdyezy1/CAMCP`, branch `Work-here`, source `c615cb7`.
No product code or provider/account state changed. Provider restrictions below describe the evidence recorded in this checkout; this pass did not refresh external vendor documentation or establish live eligibility.

Read alongside the [master product blueprint](../review/PRODUCT-BLUEPRINT-2026-10-01.md) and its consolidated delivery order.

## Product objective and measurable outcome

The target should be an advertising operating system that completes a customer's legitimate job: discover the right account and eligible objects, compile an exact plan, explain impact, prepare and execute within the agreed controls, verify the result, report it correctly, and recover without duplicating an uncertain write.

Route count alone does not measure that outcome. `src/action-contracts.ts:303` deliberately counts advertised aliases independently; `:524` records provider API coverage as unknown. The local ledger's 800 reviewed writes therefore are neither 800 distinct user workflows nor a denominator for a vendor's entire API. The product currently offers three built-in recipes (`src/campaign-recipes.ts:3`): Meta image website traffic, Google Search, and Microsoft Search. Clones cover Snapchat, Google Search, TikTok, and LinkedIn (`src/campaign-clone.ts:886`). There is substantial room to make existing contracts usable without reopening prohibited passthroughs.

Measure progress with eligible workflows completed and verified per account/objective, time and calls to first useful outcome, successful restart/recovery, reports reconciled to native evidence, and the proportion of failures with an accurate safe remedy. Keep local-contract coverage, actual account eligibility, and live acceptance separate.

## Eighteen implementable initiatives

### 1. A machine-readable capability graph instead of prose-only support descriptions

- **Current:** `ActionContract` already carries action, aliases, family, route, implementation, reason, source and tests (`src/action-contracts.ts:36–60`); `amcp_workspace contracts` searches and paginates it. Provider contracts contain substantial detailed scope prose, while workspace capabilities add account-specific evidence (`src/capabilities.ts`).
- **Proposed:** add canonical capability IDs, objective/entity dependencies, conditional eligibility predicates, required scopes/products, read/write/media/verification relationships, provider-version bounds and a structured reason category. Link aliases to canonical actions rather than pretending each is new functionality. Retain the existing free-text evidence.
- **Value:** website, MCP assistant and planner answer the same question: “Can this account complete this workflow, and what exactly is missing?”
- **Effort:** M–L. **Acceptance:** graph facts generated from registered contracts; unknown eligibility remains unknown; no graph edge grants access; every advertised workflow has a complete dependency path or an explicit blocker. Search by objective and entity supplements the existing gateway/text search.

### 2. An account-and-objective eligibility compiler

- **Current:** readiness checks recorded scopes, grants, requested assets, exact account reads and optional native inspect (`src/workspace.ts:288–428`). It explicitly qualifies only the prerequisites requested. Campaign preflight resolves symbolic resource dependencies and checks account/currency and selected assets (`src/campaign-preflight.ts`).
- **Proposed:** a goal request compiles its capability graph into the minimal readiness/read set, returning ready, blocked, needs-user-input, or unknown per dependency; include freshness, evidence source and exact safe remediation. Cache only under identity/version/freshness constraints.
- **Effort:** M. **Acceptance:** one eligibility report detects unsupported objectives, missing scopes, wrong identities, missing pixels/forms/assets and unprotected accounts without creating anything; unknowns cannot become green checks; native prepare remains authoritative.

### 3. A broad recipe library built on the existing campaign runner

- **Current:** three built-in recipes; durable DAG plans already support references, preflight, frozen reviews, whole-plan approval, run, read-back, and recovery (`src/campaign-runner.ts:29`).
- **Proposed:** add practical objective packages from existing reviewed families: Meta conversion/lead workflows, Snapchat leads/catalog campaigns, TikTok eligible manual and Smart+ website/Instant Form flows, LinkedIn lead/retargeting/experiments, and X website/video promotion. Later add supported Microsoft/Apple/Reddit workflows. Each recipe declares what it creates, reuses, cannot copy and requires externally.
- **Effort:** L, deliver per recipe. **Acceptance:** complete synthetic journey from brief to verified paused build where the provider supports paused creation; X promotion's activation is explicit, never fabricated as paused; interrupted runs reuse verified predecessors; no new native route is implied by recipe support.

### 4. Client operating profiles and versioned reusable playbooks

- **Current:** approved profiles/templates, naming, UTMs, account bindings and revisions already exist (`src/capabilities.ts`; `src/workspace.ts:183–225`).
- **Proposed:** combine these with recipe defaults, explicit geography/language, measurement plan, approval conventions, asset requirements, and reporting definitions. Show the resolved native plan plus deviations from the profile. Add a migration preview when the profile or recipe version changes.
- **Effort:** M. **Acceptance:** profiles never grant authority; account/currency boundaries remain explicit; changed defaults do not silently change an approved plan; exported playbooks omit credentials and private data.

### 5. Typed MCP outcomes and consistent assistant recovery

- **Current:** MCP returns structured content but all tools share a generic result schema with `data: {}` (`server/mcp.ts:32–59`). Guides, one campaign prompt and resource reads already exist. Error remedy and compact contract-reference machinery are established.
- **Proposed:** stable discriminated result types for eligibility, reviews, plan steps, media progress, report rows and verification; schema/guide generation from those contracts; intent-based contract discovery, bounded result projections, and progress/cancellation semantics for safe work. Preserve generic JSON passthrough only for already-authorized native data reads.
- **Effort:** M–L. **Acceptance:** clients can select correct next actions from schema-tested states; cancelled UI or read work never implies a mutation may be resent; tool annotations reflect whole-tool semantics, so a mixed native gateway is not advertised as read-only or idempotent.

### 6. Provider acceptance as an explicit product evidence layer

- **Current:** capabilities separates implementation, readiness, validation and verified writes (`src/capabilities.ts:1–103`). The sandbox runner only accepts X/Microsoft, 1–20 non-delete write steps in one exact account, with no media qualification (`tools/live-sandbox.ts:12–58,126`).
- **Proposed:** an owner-run acceptance matrix keyed by account type, API/contract version, provider products/permissions, objective, family/action, field set, fixture digest, timestamp, original receipt and read-back. Separate read-only probes, non-serving sandbox mutations, and explicitly approved real-account checks. Add invalidation after material version/credential/contract change.
- **Effort:** M–L. **Acceptance:** no blanket provider “verified” badge from one successful action; media qualification separate from campaign sandbox isolation; deterministic fixture inputs and preserved uncertainty; no live tests run autonomously as part of normal development.

### 7. Google: a complete acquisition and measurement workflow

- **Current:** Search recipe/clone and atomic builds; broad goal/asset/targeting families; Data Manager Customer Match and offline click conversions are implemented under approved scope/terms decisions (`COVERAGE.md:168`; `src/google-data-manager.ts`).
- **Proposed:** connect brief → conversion-action/goal selection → keyword/asset plan → paused build → measurement validation → report reconciliation, then add objective templates only for native families already qualified. Productize Data Manager setup diagnostics, upload summaries, request-status tracking and removal workflows under current controls.
- **Boundaries:** Google Data Manager scope/terms decisions are already settled; do not ask them again. Old Customer Match/click-upload routes have been replaced and are not missing capability to resurrect. Call conversions send unhashed caller IDs and conflict with the recorded policy; bid-modifier creation lacks the required documented shape.
- **Effort:** M per workflow, L overall. **Acceptance:** named conversion goal and native fields shown; setup failures identify actual missing provider configuration; no automatic consent; each write/read-back qualified for its actual account.

### 8. Meta: commerce and customer lifecycle as one reviewed workflow

- **Current:** campaigns, creative identity checks, catalogs/products/sets/scheduled feeds, budget schedules, bounded automated rules, customer lists and offline conversions exist (`COVERAGE.md:43–69`; `src/provider-contracts.ts`).
- **Proposed:** catalog-health → product-set selection → eligible creative/ad plan → pacing/reporting; repeatable customer-list and offline-conversion operations with safe diagnostics; bounded experiment and rule management with a visible maximum financial effect. Add vertical catalog/feed-rule/item-batch families only after their own full evidence review.
- **Boundaries:** commerce and automated rules were approved; no need to request broad approval again. Permanent/unreadable changes, generic Graph batches, whole-list replacement sessions, webhook pings and unrelated publishing remain distinct exceptions. A scheduled budget's inability to be cancelled by API must remain visible.
- **Effort:** L, split into M workflows. **Acceptance:** every set/feed/creative dependency is checked, duplicate retailer IDs require explicit upsert, rule worst cases fit policies, and personal-data defects are fixed before expanding upload convenience.

### 9. TikTok: turn existing Smart+ depth into usable campaigns, then close evidence gaps

- **Current:** many reviewed manual/Smart+ entity, targeting, audience, identity, CTA, pixel, preview and library workflows already exist. Forty-plus specific blocked rows include catalog and other requests whose documented effects/responses were unavailable in the recorded review (`src/withheld-writes.ts:70–77,136,214–237`).
- **Proposed:** eligible Smart+ website/Instant Form recipes, guided identity/post/CTA discovery, creative refresh and audience lifecycle first. Create an authenticated-document evidence acquisition track for catalogs, optimizer rules, appeals, split tests and customer files; pin only actual official request/response/limit semantics before implementation.
- **Boundaries:** missing documentation is not provider unsupported; request-field SDK types alone do not prove effect, reversibility or read-back. App/shop/search/allowlist-only variants remain conditional. Automated rules are already approved in principle but still need TikTok evidence.
- **Effort:** M workflows; unknown M–L conditional families. **Acceptance:** users can complete an eligible existing flow without hand-building native bodies; new families remain closed until complete source evidence and verification exist.

### 10. LinkedIn: audience-to-lead workflows and separately gated program expansion

- **Current:** saved/engagement audiences, forms, DSC, tracking, conversions, experiments/lift tests, and cloning exist. Existing creatives can be previewed. Live preview of an uncreated creative lacks account ownership proof; global publisher-list download is an accountless signed-download route (`COVERAGE.md:115–133`; `src/withheld-writes.ts:182–210`).
- **Proposed:** linked audience → campaign → post/media → lead form → conversion tracking → report workflow using current permissions. Qualify campaign-scoped live previews by proving ownership before render. Separately evaluate approved-program DMP company/page/predictive audiences and media plans.
- **Boundaries:** `rw_dmp_segments` and `rw_media_plans` are genuinely additional program/scope choices, not simple toggles. Missing survey-question create bodies are evidence gaps; keep manual Campaign Manager handoff. Do not broaden host allowlists merely to download arbitrary preview/list URLs.
- **Effort:** M current workflow; M–L conditional additions. **Acceptance:** explicit organization/campaign/post ownership, program eligibility, scope and page roles; no false claim that monthly API support means a particular advertiser is eligible.

### 11. Snapchat: creative, lead and catalog launch packs

- **Current:** clones, account-owned forms/media, catalog/feed/set management, dynamic templates, reminders, organic Snap ID claiming, custom conversions and large GEO targeting specs are reviewed (`COVERAGE.md:134`; `src/provider-contracts.ts`).
- **Proposed:** ready-to-review lead, reminder and dynamic-commerce campaign packs with pixel/form/catalog prerequisites, bulk geography inspection, and creative reuse within established organization/account scope. Build an explicit media/creative dependency visualizer before shared edits.
- **Boundaries:** claims by ad code, creative elements, interaction zones and UI render-data requests have recorded evidence/ownership gaps. Access/account/money/publishing remain on-request families rather than blanket expansion.
- **Effort:** M–L. **Acceptance:** parent/pixel ownership verified before writing; shared-creative impact and exact nested partial failures shown; geographic normalization does not alter the intended targeting set.

### 12. X: a coherent research-to-promotion and commerce workflow

- **Current:** audience estimation, line items/targeting, cards/Tweets/scheduled promotion, scoped typed batches, catalog/set/feed/product families and bounded async analytics jobs exist.
- **Proposed:** eligible audience/creative comparison → draft/card/media preparation → explicit promotion approval → reconciled analytics; commerce setup and scheduled-feed health; lower-friction per-entity bulk edits through existing typed batch contracts.
- **Boundaries:** promotion is activation, not a fake PAUSED creative. Targeting PUT duplicates a delete/create workflow. Analytics-job deletion lacks documented evidence. Do Not Reach customer exclusions are a personal-data family expansion, not merely a harmless arbitrary list write.
- **Effort:** M–L. **Acceptance:** fix boundary-hour reconciliation first; bounded polling/download/quota use; all promoted identities and media owned; catalog/set usage that cannot be checked remains explicitly unknown.

### 13. DV360 and Criteo: enterprise workflow bridges rather than misleading dashboard parity

- **Current:** DV360 has extensive entity/targeting/asset/custom-bidding/SDF families. Criteo has native asynchronous reporting and demand-side campaign/product capabilities. Neither is marked Overview reporting-supported in `src/provider-contracts.ts:257–271`.
- **Proposed:** expose reliable native enterprise workflows in a first-class workspace: targeting and inventory review, creative/line-item preparation, SDF/export handoffs, Criteo retail performance and catalog diagnostics. Bridge Criteo's supported native reports into the normalized Overview only with proven dimensions/metrics/attribution. Treat DV360 performance-report integration as separately researched evidence/permission work.
- **Boundaries:** DV360 YouTube associations are allowlist-only; partner-level Floodlight changes exceed a selected-advertiser boundary. Criteo retailer/supply-side keyword reviews and supply reports are a different account/product model. No generalized partner/admin bypass.
- **Effort:** L. **Acceptance:** advertiser/demand-account scope explicit; async receipts and original-login read-back survive restart; no SDF configuration export marketed as measured advertising performance.

### 14. Microsoft, Apple and Reddit: complete the narrow surfaces before enlarging them

- **Current:** Microsoft has a Search recipe and REST contract evidence but no media import; its recipe explicitly defers geography. Apple has entity/keyword/shared-budget families. Reddit has scoped entity/creative/post/lead workflows; zero blocked ledger rows does not mean full vendor coverage.
- **Proposed:** Microsoft Search location/extension/measurement checklist and complete report handoff; Apple keyword/negative management and shared-budget change previews spanning every affected account; Reddit eligible ad/post/lead journeys with transparent objective/creative requirements. Add exact missing families only when a requested workflow demonstrates the gap.
- **Effort:** M per provider. **Acceptance:** Microsoft geography is qualified before activation; Apple checks every shared-budget account grant/policy; Reddit shows account eligibility and paused/activation semantics; no invented media or universal API completeness claims.

### 15. Measurement workspace: GA4, GTM, Search Console, Business Profile and Adjust

- **Current:** GA4/GSC Overview reporting, GTM workspace/version/diagnostic families, provisioned Business Profile reads/writes/sync, and Adjust token-based native reporting exist. Business Profile website OAuth and Adjust normalized dashboard/scheduled export remain unavailable in provider contracts.
- **Proposed:** a read-first measurement plan and diagnostic workspace joining tracking configuration, event definitions, site/property identity, source freshness and campaign reporting. Add owner-visible provisioned-connection setup for Business Profile/Adjust; integrate Adjust reporting into scheduled normalized outputs only after attribution/unit/dimension qualification.
- **Boundaries:** do not automatically publish GTM or modify public business settings; use the existing reviewed families for deliberate changes. Do not infer paid conversions from Search Console or treat mobile attribution systems as deduplicated truth. Retired Business Profile Q&A has no replacement API recorded; do not recreate it through an undocumented route.
- **Effort:** L. **Acceptance:** exact property/container/site/location/app boundaries; explicit publication approvals; no cross-source attribution promises without evidence; read-only audits remain usable independently of write permissions.

### 16. Commerce ingestion and vertical catalog expansion

- **Current:** Meta/Snapchat/X catalog families are real; 31 WooCommerce advertised actions are unmapped (`COVERAGE.md:17`). The owner approved commerce, but that does not create missing schemas or safe batch semantics.
- **Proposed:** a typed product ingestion pipeline with schema validation, currency/price precision, stable source IDs, diff preview, conflict handling, per-destination mapping and reconciliation. Begin with current generic products and scheduled feeds; later evaluate supported verticals, supplementary feeds and a concrete WooCommerce connector.
- **Effort:** L. **Acceptance:** source inventory never silently overwrites destination data; zero-row/failed feeds cannot trigger implicit deletion; upserts/deletes are explicit; each destination item has a receipt/read-back state; no generic batch passthrough.

### 17. Safe high-volume operations and lifecycle coverage

- **Current:** Google atomic builds, write groups and provider-specific typed batches exist. Generic async/batch passthroughs are deliberately closed (`COVERAGE.md:62`). Some provider creates lack update/delete/read-back parity.
- **Proposed:** high-volume jobs compile exact typed per-item operations and shared approval summaries, with bounded concurrency, quota admission, durable progress, per-item receipts, recovery and cancellation of only unsent work. Add a lifecycle completeness score per workflow: discover/create/update/pause/remove/read-back, with provider limitations visible.
- **Effort:** M–L. **Acceptance:** an ambiguous item is never replayed under a new key; partial results don't imply atomicity; job approval is invalidated by a changed plan; no claim of deletion/reversal when the API lacks it.

### 18. Extensibility, evidence freshness and performance as product constraints

- **Current:** 167 registered families, one-owner conflict detection, guarded readers and generated ledgers are a strong extension base. `familyOf` scans all families and reader composition walks registered readers (`src/reviewed-families.ts:369–394`); pinned JSON is process-cached. Contract `reviewed_at` is manually selected in provider metadata (`src/provider-contracts.ts:226`).
- **Proposed:** versioned family manifests, generated evidence dates/digests and machine-tested input/output/eligibility contracts; fixture templates for new report/media/family modules; benchmark complete user journeys and introduce gateway candidate indexes or prebuilt reader pipelines only when measured. Add aggregate call/byte/time budgets across report periods and sources, not just per-request limits.
- **Effort:** M–L. **Acceptance:** indexed dispatch produces the same classification and conflict errors as the complete scan across all fixtures/ledger routes; dynamic exact-payload checks still run; no credential-sensitive cache leakage; improvements demonstrate bounded RSS/calls/latency and unchanged write semantics.

## Provider expansion gates that should remain visible

1. **Already implemented but under-productized:** recipes, clone/readiness/verification, native Criteo/Adjust reporting, typed batches, catalogs and account diagnostics. Package these first.
2. **Implementation gap with settled approval:** commerce expansion and automated rules are already approved in principle; each new typed family still needs official fields/effects/limits and read-back. Google Data Manager scope/terms decisions are settled.
3. **Evidence blocked:** TikTok catalog/rule/other docs, LinkedIn survey-question creation, X analytics-job deletion and selected Snapchat creative routes. Refresh official evidence; do not guess from SDK input shapes.
4. **New provider permission/product:** LinkedIn Audiences/Media Planning programs; DV360 informed-subset features; separate supply-side Criteo account model. These are explicit conditional projects with real prerequisites.
5. **User-requested narrow owner decision:** access, billing/funds, publishing and account setup stay closed generally but can be evaluated as individual requested families. No need to ask the blanket question again.
6. **Deliberately prohibited design:** generic write passthroughs, arbitrary account escapes, unbounded batch/async APIs and blind mutation retries remain closed.
7. **Replaced/retired/unsupported:** old Google personal-data endpoints, undocumented placeholder routes and retired Business Profile Q&A are not useful route-count targets. Route users to supported alternatives or an honest manual handoff.
8. **Unmapped advertised catalog names:** WooCommerce/Adjust/other helper rows need actual implementation or honest presentation; their existence is not an integration.

## Recommended sequence

First repair the confirmed privacy, dispatch, identity-state and reporting correctness defects. Then deliver initiatives 1–6 as shared product infrastructure alongside two high-value recipes from 7–12. Expand enterprise/measurement/commerce from 13–16 only on measured customer demand and proven native semantics. Use 17–18 to scale successful workflows. Every batch should improve a demonstrable user outcome and record local, CI/container and live-account evidence separately.

This blueprint does not revive the declined out-of-band spending-approval requirement, change the existing personal-data removal switch semantics, or authorize live provider changes.
