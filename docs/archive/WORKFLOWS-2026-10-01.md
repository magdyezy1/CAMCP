---
status: archived
tier: engineering
---

# Capability and product expansion audit — reporting, campaigns, media and measurement

**Archived on 2026-10-22** (DOC-03, owner decision P12): kept as it was written, with links to current addresses.
A 2026-10-01 proposal: its scope is in the [blueprint](../review/PRODUCT-BLUEPRINT-2026-10-01.md) and its outcomes
in [decisions](../DECISIONS.md).

Reviewed 2026-10-01, Work-here source baseline c615cb7. This is a review proposal, not an implementation or live-provider qualification. Source inspection and the previously recorded synthetic regressions are the evidence. No provider calls, credentials, live databases or advertising changes were used for this expansion audit. Read alongside the [master product blueprint](../review/PRODUCT-BLUEPRINT-2026-10-01.md).

## Product conclusion

**Delivery update, batch 65:** Arabic campaign/creative creation, approval, upload, recovery, library and preview
controls now retain the same native requests as English. Recipe discovery searches either language. Queued media
remains visibly pending with its original recovery link. See [delivery evidence](../records/DELIVERY-2026-10-01-ARABIC-CAMPAIGNS.md).
The review below remains the original proposal; broader reporting/operations translation and browser acceptance
continue in the implementation matrix.

AMCP has substantially more capability than its task flows make apparent. The strongest direction is a client operations workspace that connects the existing campaign runner, media pipeline, reporting overview, decision-reporting engine, measurement contracts and recovery mechanisms. More raw route coverage alone will not accomplish that. First repair the reproduced correctness/privacy blockers; then make the existing capabilities discoverable and complete; then expand specific, qualified provider workflows.

Existing capabilities must not be described as missing: business-input campaign recipes, approval and dependency plans, four-provider campaign cloning, media transformations and multi-account uploads, native ad previews, source-linked reports, report templates, custom formulas, Sheets exports, report schedules, pacing/anomaly/fatigue/search-waste analysis, account readiness, conversion-management families, and GTM auditing all have implementations. The opportunities below identify the missing connection or depth instead.

## Actual feature coverage, not route counts

Legend: “implemented” means code exists; every provider workflow still needs current account/permission/provider acceptance. “No overview adapter” and “no guided recipe” do not mean no native API functionality. Preview means existing-ad provider preview links; it is separate from viewing an uploaded source.

| Platform | Guided campaign recipe exposed in browser | Campaign clone plan | Reporting overview adapter | Reviewed binary media upload | Existing-ad preview flow |
|---|---|---|---|---|---|
| Google Ads | Search: paused campaign/budget/ad group/exact keywords/geography/language/RSA | Search; atomic by default | Campaign reporting | Images and video pipeline | Shareable preview requires reviewed native write; tool supplies next call |
| Meta | Website traffic with image/Page identity, click optimization | No clone in current clone tool | Campaign reporting | Yes | Native link, placement choices |
| TikTok | No guided recipe | Yes | Campaign reporting | Yes | Native link |
| Snapchat | No guided recipe | Yes | Campaign reporting | Yes | Native creative preview |
| LinkedIn | No guided recipe | Campaign group source | Campaign reporting | Yes; owner binding matters | Native creative preview |
| X Ads | No guided recipe | No clone in current clone tool | Campaign reporting; period-boundary defect reproduced | Yes; library attachment is a separate reviewed step | No preview AMCP can read |
| Microsoft Ads | Search; geography supplied through qualified native steps or set in provider before activation | No clone in current clone tool | Campaign reporting | No AMCP binary adapter | No preview AMCP can read |
| Apple Ads | No guided recipe | No clone in current clone tool | Campaign reporting | No AMCP binary adapter | No preview AMCP can read |
| Reddit Ads | No guided recipe | No clone in current clone tool | Campaign reporting | No AMCP binary adapter | Native link |
| DV360 | No guided recipe | No clone in current clone tool | No overview adapter | Yes; creative assets and specific Demand Gen image target differ | No preview AMCP can read |
| Criteo | No guided recipe | No clone in current clone tool | No overview adapter; native report-job module exists | No AMCP binary adapter | No preview AMCP can read |
| Adjust | Not a guided campaign builder | Not applicable to current clone tool | No overview adapter; native reporting module exists | No AMCP binary adapter | Not in preview tool |
| GA4 / Search Console | Measurement/organic sources, not paid campaign launch recipes | Not applicable | GA4 campaign-context and GSC page-context rows | Not applicable | Not applicable |

Evidence: `src/campaign-recipes.ts:3–71`; `src/campaign-runner.ts:25–48`; `src/report-metrics.ts:6–17`; `src/report-native.ts:480,527,774–891`; `src/media-routing.ts:8–54`; `src/ad-previews.ts:20–39`; `src/criteo-report-jobs.ts`; `src/adjust-reporting.ts`. Broad provider catalog availability must not be substituted for these feature-level distinctions.

Measurement already includes Google conversion action/goal, LinkedIn conversion link/rule, Meta custom/offline conversion, Snapchat custom conversion, TikTok custom conversion/edit and GTM entity/workflow/workspace reviewed families. Registration evidence: `src/reviewed-families.ts:225–226,244–246,252–253,274–280,293,312–313`. This does not establish that every measurement operation or every account is supported. GA4 reviewed mutations in `src/measurement-writes.ts:67–75` specifically cover audience-export/report-task creation, not a universal GA4 administration surface. GA4/GSC asset discovery already exists with explicit permission and bound checks (`src/google-measurement-assets.ts:77–126`).

## Current user journeys and discontinuities

1. **Connect → choose accounts → check readiness.** Browser Connections and dashboard support the foundations; `workspaceCapabilities` separates local implementation, timestamped read evidence, validation and verified writes (`src/capabilities.ts:4–104`). It currently lists broad features with `implemented_unverified`, not a complete task-by-platform-by-account catalog. Discovery is not proof of reportability or write permission.
2. **Client profile → campaign recipe/template → preflight → review → execution → verification.** Profiles hold revisioned naming/UTM/defaults/bindings/templates/conversion mappings; browser recipe forms load approved defaults, account targets and targeting lookups. The Campaigns page lists AMCP plans, rather than a browsable live provider portfolio (`web/workspace.js:76–120,136–238`; `web/campaign-recipes.js:64–226`). Backend whole-plan `approve`/`run` and clone are present; the inspected browser plan view exposes the per-step path, reconcile and cancel, but not those complete flows.
3. **Source → variant → reviewed upload → receipt/recovery.** Browser creative push already takes several local/link/selected Drive files and sends to multiple destinations with bounded planning (`web/creative-push.js:22,76–139`). Upload recovery and native previews also exist. The gap is a durable creative inventory connecting originals, variants, provider IDs, actual ad usage and performance. The current library exposes only a first-page view with MCP pagination guidance (`web/workspace.js:239–351`). Source staging is temporary; it should not silently become permanent digital-asset storage.
4. **Report definition → bounded native collection → snapshot → recommendation → CSV/Sheets → scheduled refresh.** Overview supports nine paid providers plus GA4/GSC, total/daily/weekly/monthly grain, named reports/account-free templates/custom formulas and independent delivery frequency (`src/reporting-overview.ts:28–47`; `src/report-library.ts:55–66,155–275`). It deliberately re-queries native periods rather than adding daily reach or ratios (`src/report-periods.ts:30–55`). That protects metric semantics but creates a scaling tradeoff needing an aggregate request budget.
5. **Native capture → declared semantics → reconcile/analyze.** `amcp_reporting` already handles source hashes, decimal totals, compatibility, additive reference reconciliation, pacing, baseline comparison, search waste, possible fatigue and spend anomalies (`src/decision-reporting.ts:5–8,89–120,160–481`). Browser Reports opens/analyzes/reconciles evidence, but tells users to capture through an MCP client (`web/workspace.js:410–478`). The overview and captured-evidence surfaces remain separate journeys.
6. **Configuration audit → measurement change → verification.** GTM diagnostics can audit bounded workspace state (`src/gtm-diagnostics.ts:13,70–81,205–212`); reviewed measurement/conversion writes exist. There is no dedicated measurement workspace among inspected application routes (`web/index.html:3`; `web/app.js:134,582–583`). A configuration read does not prove that real-world events are firing, deduplicated, attributed correctly or compliant with the advertiser's consent decisions.
7. **Schedule → job → destination/recovery.** Report schedules, revisions, pause/resume/delete, cancellation and export idempotency exist. Worker retries distinguish read/report/export cases from uncertain mutations (`src/report-library.ts:40–52,155–323`; `src/worker.ts:94–137`). There is an opportunity for a unified user-facing operations center, not a need to invent background jobs.

## Seventeen concrete initiatives

Priority is proposed product order after correctness blockers. Effort: S = bounded existing surface; M = several modules/flows; L = new data model or multiple provider qualifications. These are relative estimates, not delivery promises. Success criteria below are proposed acceptance targets, not measured results. “Owner” denotes the implementation responsibility and the user/provider decision that remains outside code authority.

| # | Classification | Exact increment beyond existing implementation |
|---|---|---|
| 1 | Existing engines + new discovery integration | Feature/account/task matrix joining registries and timestamped evidence |
| 2 | Existing native reads + new browser/data integration | Live provider entity explorer and links to reports, previews and plans |
| 3 | Existing engine + incremental browser workflow | Clone, whole-plan approve/run and safe amendment controls |
| 4 | Genuinely new qualified capability | Additional objective/format/provider recipe definitions |
| 5 | Existing profile engine + new information architecture | Structured settings, client links and human-readable template previews |
| 6 | Existing engines + new evidence bridge | Reuse overview snapshots for qualified decision analysis; guided capture |
| 7 | Existing metrics/formulas + incremental tooling | Discoverable definitions, availability and sample-value formula preview |
| 8 | Genuinely new overview capability | Qualified dimensions/entity-grain adapters and compatible metric selection |
| 9 | Existing jobs/checkpoints + new scale controls | Aggregate request budget, backfill and permission-aware inventory caching |
| 10 | Existing comparison/context engines + new integration | Report comparison visualization and verified campaign-change timeline |
| 11 | Genuinely new persistent capability | Monitor policy, incident deduplication/acknowledgment/resolution and notification delivery |
| 12 | Existing exports + new presentation layer | Styled summary/chart packs; future XLSX/PDF is separate new output support |
| 13 | Existing media engine + new lifecycle data model | Paginated asset discovery and source/variant/provider/ad/performance associations |
| 14 | Existing transforms/validation + new qualified checks | Placement readiness and complete ad-concept comparison; no implicit AI edits |
| 15 | Existing measurement engines + new browser integration | Mapping/configuration health journey; observed event-flow verification remains a separate capability |
| 16 | Existing jobs/remedies + incremental operations UI | Unified scoped queue/status/recovery experience with correct retry semantics |
| 17 | Existing tests/contracts/evidence + new release integration | Feature-level acceptance mapping and generated documentation |

### 1. A feature-level task and account capability explorer — P1 / M

**Current:** Contracts/readiness/live evidence exist, but broad capability summaries do not explain whether a particular objective, media type, report grain, preview or recovery action is usable on the selected account (`src/capabilities.ts:8–65`).

**End state:** “I want to launch / report / upload / diagnose” routes to exact qualified options and prerequisites, with implementation state, account selection, last live evidence and a working deep link. Generate this from the same recipe, media, reporting and reviewed-family registries instead of maintaining a marketing list separately.

**Boundary/owner:** Platform integration owner maintains contracts and evidence expiry; frontend owner presents them. Account administrator supplies missing permissions/identity. A readable account cannot be promoted to write-ready automatically.

**Success:** Every matrix cell has an evidence source and route; users can identify why a chosen task is unavailable without opening JSON or retrying a predictably unsupported call; fixture checks detect registry/UI drift.

### 2. Live campaign portfolio and entity drilldown — P1 / L

**Current:** Campaigns means durable AMCP plans. Native workflow discovery/details/insights/audits already exist (`src/workflows.ts`; plan UI `web/workspace.js:136–169`).

**End state:** Distinguish “Live campaigns” from “Launch plans”; browse account → campaign → ad group/ad set → ad/creative, display status, dates, budget, measurement definition and reporting freshness, then propose a reviewed change or a clone. Retain provider IDs and deep links.

**Boundary/owner:** Native-read adapter owners supply complete paging/entity relationships; product/frontend supplies browsing. Start with tested providers instead of a universal entity shape. Account-specific live acceptance must prove discovery and ownership before change controls appear.

**Success:** Supported account inventories reconcile with provider exports; pages neither skip nor duplicate entities; a selected campaign can open its report, preview and review without retyping identifiers.

### 3. Complete browser cloning and whole-plan execution — P1 / M

**Current:** `amcp_campaign clone`, `approve`, `run`, `recover_step` and reconciliation exist (`src/campaign-runner.ts:25–48,586–620`); browser favors per-step controls.

**End state:** A clone wizard shows copied/omitted entities, target account/name, explicit changes and paused result; whole-plan approval shows all money/status fields and dependency graph, then progress and stop reason. Add the existing safe amendment path when preflight or a pre-provider failure is correctable.

**Boundary/owner:** Reuse runner ownership, frozen plan hash, reviewed writes and receipts. Initially clone only Google Search/Snapchat/TikTok/LinkedIn within the currently implemented supported scope; account-specific live acceptance remains separate. Operator chooses changes and approval scope; an uncertain create must be reconciled, never blindly repeated.

**Success:** Browser can complete each existing supported clone/approval path end-to-end in fixtures; interrupted execution resumes without duplicate resources; changed plans invalidate approval.

### 4. Expand business-input recipes by objective and format — P2 / L

**Current:** Three useful browser recipes already exist. Meta recipe is image traffic; Google/Microsoft recipes are constrained Search. Microsoft recipe explicitly does not supply geography (`src/campaign-recipes.ts:3–71,487–494`).

**End state:** Prioritize the user's next high-volume launch patterns: e.g. Snapchat/TikTok/LinkedIn campaign briefs, or an additional Meta objective/format. Each recipe declares its exact objective, bidding, identity, targeting, conversion, creative and paused-state coverage, including what must be handled separately.

**Boundary/owner:** Product owner prioritizes real briefs; each provider owner qualifies exact native contracts and account prerequisites. Conversion selection, regulated categories and activation remain explicit advertiser decisions. No “same settings on every platform” adapter.

**Success:** A nontechnical operator completes a qualified brief without native JSON; all generated changes match the preview and verified paused resources; missing identity/conversion/geography is blocked before any dependent write.

### 5. A connected client workspace with understandable templates — P1 / M

**Current:** Profiles already have naming, UTMs, bindings, variables, conversion mappings and templates, but advanced browser fields are JSON (`web/workspace.js:76–105`). Reports/media/plans are separate navigation destinations.

**End state:** Client overview links accounts, goals, approved profile revision, templates, reports, schedules, creative sets and active work. Structured editors preview naming/UTM outputs and validate mapped conversion choices; retain expert native template mode.

**Boundary/owner:** Workspace/model and frontend owners. Client organization must remain distinct from tenant authorization; linking a record to a client never grants provider access. Currency, attribution and conversion mappings require explicit choices.

**Success:** A user can trace any plan/report back to its client/profile revision; template variables and resulting names/URLs preview correctly; editing defaults cannot silently mutate existing reviewed plans or schedules.

### 6. Connect reporting overview with captured-evidence analysis — P1 / M

**Current:** Overview collects/saves/delivers; DecisionReporting captures/compares/reconciles/analyzes. Browser native capture is MCP-first (`web/workspace.js:412`). These are two complementary engines, not one absent engine.

**End state:** “Analyze this snapshot” uses a compatible immutable source-linked evidence record; “Capture detailed evidence” offers qualified native report presets and explicit mappings. Preserve declared attribution/date/timezone/currency, raw source hashes, completeness and access provenance. Do not issue a second provider pull when validated existing evidence is sufficient.

**Boundary/owner:** Reporting owner designs a common evidence contract; provider owners qualify capture presets. A bridge must reject semantic incompatibility rather than treating all overview rows as an interchangeable decision report.

**Success:** Supported snapshots can reach comparison/reconciliation without manual JSON or duplicate reads; stale/incomplete/mismatched reports remain visibly ineligible for action; all displayed numbers trace to a stored snapshot and mapping version.

### 7. Metric dictionary and formula workbench — P1 / M

**Current:** Metric definitions, additive/nonadditive distinction, provider metricSources and custom arithmetic already exist (`src/report-metrics.ts:19–79`; `src/report-summary.ts:4–53`). Legitimate native custom metrics fail on empty/sparse rows in reproduced F124.

**End state:** Expose source definition, unit, aggregation, availability, conversion semantics and sample values alongside formula editing. Preview against normal/zero/missing/empty rows and explain incompatible or non-additive formulas. Version formulas and definitions with saved reports.

**Boundary/owner:** Reporting/analytics owner. Preserve unknown as null, weighted-ratio logic and explicit conversion definitions; do not sum reach/users across campaigns or currency amounts across accounts without a separate approved conversion rule.

**Success:** Empty/sparse regressions pass; every common metric has a tested native mapping; invalid formulas show an actionable field-level error before collection; exported formulas/values retain definition provenance.

### 8. Entity and dimension reporting beyond campaign totals — P2 / L

**Current:** Paid overview adapters are campaign-oriented (`src/report-native.ts:480,527`); GSC page and GA4 context differ. Native report/campaign workflows may expose richer dimensions, but there is no uniform overview drilldown contract.

**End state:** Qualified ad group/ad set, ad/creative, placement, device, geography and search-term views where the provider supports the combination; a dimension picker shows compatible metrics, privacy/truncation effects and estimated size. Join by durable provider IDs, not labels.

**Boundary/owner:** Provider report owners and analytics owner. Each dimension changes grain and may change attribution, thresholds or nonadditive metrics. Do not fabricate joins between paid conversions and GA4/GSC totals. Start with one valuable provider/dimension pair.

**Success:** Detail totals reconcile to parent only where mathematically valid; unsupported combinations are unavailable before queueing; exports carry their grain and limits; native reference fixtures verify dimensions and pagination.

### 9. Bounded reporting at portfolio scale — P1 / L

**Current:** Per-source limits, checkpoints, max rows and per-period collection exist. The X period collector can multiply independently bounded analytics calls across many daily periods (`src/report-periods.ts:48–55`; `src/x-campaign-report.ts:31–39`). Cached inventory and a whole-job provider request budget are not established by those per-call bounds.

**End state:** Preflight estimate of accounts × entities × periods × report requests, aggregate request/time/row budget, staged historical backfill, cancellation, fairness and checkpointed continuation. Cache inventory separately from mutable metrics using explicit freshness/permission keys. Preserve native-period queries for nonadditive values.

**Boundary/owner:** Reporting/worker owners; deployment owner chooses resource budget. Any caching requires permission invalidation and provider-specific freshness; re-fetch recent conversion-lag windows rather than declaring historical partitions final without evidence.

**Success:** Worst-case fixtures never exceed declared job budget; resume retains earlier request lineage and no duplicate time buckets; provider throttling does not monopolize the worker; displayed counts explain partial results.

### 10. Time comparisons and campaign-change context — P2 / M

**Current:** Compatible equal-length baseline analysis and manual business context already exist, including recent change, seasonality, tracking, capacity, budget and secondary KPI (`src/decision-reporting.ts:322–481`; `src/recommendation-context.ts:4–92`).

**End state:** In reporting, choose comparable prior period/year/custom baseline, see differences and evidence/sample size, and overlay verified AMCP campaign changes plus user annotations. Recommend investigation with the contributing metrics and guardrails instead of a generic action label.

**Boundary/owner:** Analytics/frontend owners. Change correlation does not prove causal lift; external provider edits require qualified history reads or clear “AMCP-recorded changes only.” Existing X boundary bug must be repaired first.

**Success:** All comparison views enforce semantic compatibility; lag/staleness/recent changes visibly affect confidence; annotations and verified edits appear at correct timezone boundaries; half/quarter-hour timezone totals reconcile.

### 11. Persistent pacing and anomaly monitoring — P2 / L

**Current:** Pacing, anomalies, fatigue/search-waste suggestions and report schedules exist; a persistent alert incident/deduplication lifecycle is not present in the inspected decision engine/worker paths.

**End state:** Save a read-only monitoring policy with thresholds, comparison window, freshness/lag, account scope and owner; evaluate after complete snapshots; show opened/acknowledged/resolved incidents and evidence history. Start with in-product notifications, then user-configured external delivery.

**Boundary/owner:** Analytics/job owners, workspace administrator for destinations. Notification permission is separate from advertising-write permission. Suggestions do not auto-change budgets or pause ads; any later automation requires explicit reviewed policy and qualified execution semantics.

**Success:** One persistent incident per condition instead of repeated alerts; incomplete/stale data cannot create false performance alarms; known fixture sequences open/resolve correctly; every alert links to exact snapshot and rule revision.

### 12. Presentation-ready report packs built on existing exports — P2 / M

**Current:** CSV and confirmed Google Sheets exports/schedules already exist. The reporting foundation retains evidence and avoids unowned-tab replacement.

**End state:** Optional client-facing summary tab with clear dates, currency, objectives, target comparisons, charts and commentary next to a stable raw-data/evidence tab. Reusable layouts and column formatting; an export preview shows what will change. Consider XLSX/PDF only after choosing an explicit artifact/renderer lifecycle.

**Boundary/owner:** Reporting/export/frontend owners. Preserve destination ownership and safe retries; users choose any new external destination. Do not blend currencies, hide incomplete sources, or replace a person's unrelated sheet. Formatting must not become the only copy of evidence.

**Success:** Styled and raw totals reconcile; numeric/date types survive export; retries do not duplicate content; an empty collection preserves prior output with a clear freshness message; rendered charts/print layouts are checked for representative sizes.

### 13. Creative inventory from source to performance — P1 / L

**Current:** Temporary sources, transformations, receipts, reusable upload checks, multi-file pushes and recovery exist. The UI does not provide a full paginated searchable creative lifecycle with ad usage/performance joins.

**End state:** Original → variant → upload/account → creative/ad usage → performance, with thumbnails, tags, naming, dimensions, revision history, provider availability and expiry. Search/filter/page the existing library first; then add durable metadata joins and reuse suggestions. Show existing-ad previews within this context.

**Boundary/owner:** Media and reporting owners. Original-binary retention is a product/storage/privacy decision, not implied by current staging. Ad association and performance reads require their own account-bound contracts; identical bytes do not prove identical creative/copy/landing-page meaning.

**Success:** Users can locate an existing usable asset without re-uploading; every variant/receipt retains source hash and transform settings; deleted/expired sources cannot resurrect (F126); unknown ad usage is labeled rather than guessed.

### 14. Placement-aware creative readiness and version review — P2 / L

**Current:** Geometry/type/size constraints, transform presets, explicit crop/contain, provider creative contracts and preview tools already exist (`src/media-routing.ts:19–54`; `src/creative-validation.ts:24–82`).

**End state:** Before upload, a placement matrix explains fit, dimensions, duration/codec and safe-area considerations using qualified specifications; compare original/variant, approve crop and inspect copy/identity/destination as a complete ad concept. Optional brand-rule checks are advisory with explicit user overrides where the provider allows them.

**Boundary/owner:** Media/creative contract owners; advertiser approves visual/copy changes. A technical pass is not ad-policy approval or guaranteed delivery. Platform specification/version changes require fresh qualification; no silent generative alteration.

**Success:** Known invalid media fails before provider upload; crop is always inspectable and explicit; required identity/destination fields are complete before ad review; every output identifies the exact preset/spec version used.

### 15. Measurement health and conversion mapping workspace — P1 / L

**Current:** GTM audit/configuration operations, measurement asset discovery and many reviewed conversion families exist. Profile conversion mappings and report source definitions are also present; they lack a consolidated browser journey.

**End state:** Select a client/account → inspect linked GA4/GTM/site/pixel/conversion resources → see mappings and configuration findings → prepare a bounded fix → verify configuration. Link landing-page/UTM QA and reporting measurement caveats; show configuration evidence separately from observed event flow.

**Boundary/owner:** Measurement/integration owners. User selects primary conversion/bidding semantics and grants access; changes retain reviewed ownership and publish controls. Real event reception, consent and deduplication require separate explicit evidence/tests rather than inference from configuration.

**Success:** A report's primary conversion can be traced to a selected definition; mismatch/absent bindings appear before launch; GTM findings link to exact resource/version; reviewed changes are read back; “tracking healthy” is never based only on a successful configuration GET.

### 16. A unified operations and recovery center — P1 / M

**Current:** Campaign steps, media recovery, report/export jobs, scheduling revisions and worker retries each have useful state and remedies; users encounter them in different surfaces (`web/workspace.js:168–209,307–350`; `src/worker.ts:94–137`).

**End state:** Filter by client/account/job type; show queued/running/provider processing/verification/needs attention/completed, timestamps, attempt history, retained provider IDs and allowed next action. Connect source-specific errors to reauthorization, configuration correction, safe continuation or reconciliation.

**Boundary/owner:** Worker/frontend owner; support/administrator gets only scoped diagnostics. Reads, idempotent export retries and uncertain advertising mutations require different controls. Existing jobs and leases should be reused, not duplicated in another queue.

**Success:** Every interrupted representative workflow presents a meaningful next step; no retry repeats an unknown-outcome create; source failures retain actionable provider context without credentials; schedules expose next run and last successful delivery separately.

### 17. Feature qualification and release acceptance matrix — P1 / M

**Current:** Source contracts, reviewed-family tests and timestamped capability evidence are strong foundations, but aggregate route/test counts do not establish a complete end-to-end user capability.

**End state:** For every feature-matrix cell maintain contract version, local fixture coverage, browser journey test, required scopes/account type, optional validation-only check and explicitly authorized live acceptance record. Generate documentation from registries and make unsupported/unknown states first-class.

**Boundary/owner:** Integration owner and release owner; account owner authorizes limited provider tests. Native live writes, deployment and CI status remain separate evidence categories. No automated live spending or campaign activation to fill a green matrix.

**Success:** Each advertised task has an end-to-end test and qualified scope; reviewed docs cannot say “all platforms” based on route counts; a release identifies exact unverified cells and version changes; failed qualification disables the affected action instead of falsely certifying the platform.

## Suggested sequencing and validation boundaries

1. Repair reproduced blockers and protect the report source contract: F124 empty/sparse formulas, F125 X overlap, F126 media deletion/finalization, plus the engineering review's privacy/session issues. These are defects, not optional roadmap items.
2. Make existing capability usable: initiatives 1, 3, 5, 6, 7 and 16. They provide product value mostly by reusing existing contracts and reduce pressure to bypass MCP or raw JSON flows.
3. Add depth with controlled scope: choose one provider for live portfolio drilldown, one creative lifecycle join and one measurement-health journey, then qualify them (2, 13, 15, 17).
4. Expand only from measured demand and stable evidence: extra recipes, dimensions, monitors, report packs and richer comparisons/placement checks (4, 8, 10–12, 14), with reporting scale work (9) before broad scheduled use.

Additional source-traced investigations remain hypotheses until regression/provider evidence is added: resumed-report lineage retention; aggregate request multiplication; malformed response collections vs provider-allowed empty shapes; legacy report retry parity; body-stream failure handling in Sheets export. The earlier deferred inspection race and X reporting overlap have standalone synthetic reproductions in `.runtime/review-20261001/reporting-media-reproductions.mjs` and `.log`. A temporary native-metric proposal was preserved in `reporting-proposed.patch`; source and tests were restored at the user's review-first direction.

No current provider/API limits or UI permissions were inferred from old external documentation. The matrix is a current local-code inventory, not an assertion of current live acceptance. External API/version/spec research is a required next step for any expansion implementation, using official provider sources and controlled account evidence.
