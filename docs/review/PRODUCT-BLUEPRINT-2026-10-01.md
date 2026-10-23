# AMCP full product, workflow, integration and website blueprint

**1 October 2026 · `magdyezy1/CAMCP` · `Work-here` · reviewed source `c615cb7`.**

**Implementation update:** the owner subsequently authorized work. See the
[dated implementation and qualification matrix](IMPLEMENTATION-2026-10-01.md) for delivered, partial and open
packages. The proposal below describes the baseline review; its original review-only status is historical.

This is the expanded answer to the owner's request for the strongest useful version of AMCP, covering improvement
and expansion as well as fixes. It is a design and engineering proposal. No proposed product changes have been
implemented, committed, pushed or deployed. The original engineering brief supplies context; the owner's current
request to review first controls the work.

## 1. Overall judgment and how to use this review

AMCP has a much stronger execution foundation than its everyday user experience currently reveals. Its next major
advance should be completing useful advertising workflows across the website and MCP, making their outcomes
understandable, and expanding specific provider capabilities where those workflows need them.

The first review was comprehensive by engineering area but weighted toward reliability and defects. It was not a
complete product blueprint. This supplement adds product direction, provider expansion, user journeys, information
architecture, page layouts, reporting and creative workflows, operating requirements, and a delivery backlog.

Read this document for the decisions and sequence. The linked specifications carry the implementation detail:

| Document | What it provides |
|---|---|
| [Engineering review](../archive/REVIEW-2026-10-01.md) | Current architecture, reproduced defects, source-traced findings, measurements, security, testing and deployment assessment |
| [Contract and integration specification](../archive/CONTRACTS-2026-10-01.md) | 18 initiatives, provider-by-provider opportunities, current contract evidence, prerequisites, limits and acceptance criteria |
| [Website and workflow specification](../archive/UX-2026-10-01.md) | Current route map, 12 backend-to-website comparisons, seven navigation groups, ten complete journeys, 21 page/view specifications and 12 design priorities |
| [Campaign, reporting and creative specification](../archive/WORKFLOWS-2026-10-01.md) | Feature matrix and detailed capability initiatives, distinguishing existing engines from interface completion and new work |
| [Evidence record](../archive/REVIEW-2026-10-01-EVIDENCE.json) | Baseline checks, measurements and hashes of the synthetic technical reproduction artifacts |

These specifications overlap intentionally at their interfaces; their initiative counts must not be added together
as a count of distinct projects. The numbered work packages in section 12 are the consolidated delivery sequence.

**Comprehensive scope does not mean every future opportunity has been exhausted.** The review covers every major
product and engineering dimension identified in this checkout. It is not a line-by-line certification, a full vendor
API census, a completed accessibility audit, or live-provider acceptance. Account eligibility and current external
API details must be checked for the particular capability before implementation or release.

## 2. The target product

AMCP should let an operator complete this loop:

**Understand the account → prepare a plan → inspect its effects → approve and execute → verify the outcome →
measure performance → decide the next action → preserve a reusable, auditable record.**

Website and MCP should operate on the same saved objects throughout that loop. A plan created in a conversation
should open at its exact review page. A person should be able to amend it in the website and resume in their AI
client without reconstructing context. A report should point to its definition, source evidence and resulting
proposal. A failed job should open at a safe recovery action, not force the user to repeat their original request.

Five product principles should govern the work:

1. **Complete useful jobs.** Measure successful, verified workflows per account and objective rather than route count.
2. **Make consequences readable.** Show account, money, delivery status, targeting and affected objects before execution.
3. **Carry context forward.** Client defaults, source assets, conversion goals, evidence and receipts travel with the work.
4. **Show what is known.** Implemented, locally tested, account eligible, provider accepted and verified are different states.
5. **Recover deliberately.** Distinguish not submitted, accepted, processing, verified, refused and uncertain outcomes.

The shared object model should be made explicit and versioned:

```text
Workspace and member authority
  └─ Connection → selected account/property → current eligibility evidence
       ├─ Client profile and versioned defaults
       ├─ Source asset → variant → provider upload → usable receipt
       ├─ Campaign plan → revision → review → run → step receipt → verification
       ├─ Report definition → collection → immutable snapshot → analysis
       │                                      └─ schedule → destination → delivery receipt
       └─ Measurement / commerce configuration → inspected state → reviewed change

Each object: identity, version, provenance, status, permitted next actions and deep link.
```

This does not require replacing existing stores or engines. Much of the model already exists in separate modules;
the improvement is consistent relationships, contracts and human navigation.

## 3. What already exists, what is incomplete, and what is new

| Area | Current foundation | Highest-value improvement | Nature of work |
|---|---|---|---|
| Provider support | 167 registered reviewed families; 3,247 ledger rows, including aliases | Discover support by business objective, account eligibility and complete lifecycle | Enrich and connect existing metadata |
| Campaign execution | Durable plans, dependency references, preflight, frozen reviews, whole-plan approval/run, verification and recovery | Expose the complete lifecycle coherently in the website | Primarily interface completion |
| Guided creation | Meta image traffic, Google Search and Microsoft Search recipes | More practical objective recipes and reusable launch packs | New recipes over existing reviewed contracts first |
| Cloning | Google Search, Snapchat, TikTok and LinkedIn | Guided source selection, compatibility report, change preview and plan creation | Expose existing bounded capability |
| Creative | Imports, selected Drive access, variants, multi-target push, previews, receipts and recovery | One preparation workspace, eligibility matrix and durable progress | Connect existing functions; extend only demonstrated gaps |
| Reporting | Nine paid Overview adapters plus GA4 and Search Console; native Criteo/Adjust paths separately | Clear report lifecycle, source health, reconciled analysis and usable delivery management | Correct and integrate existing engines |
| Decision support | Pacing, anomaly, creative-fatigue, search-waste, baseline comparison and reconciliation | Put existing analysis beside Overview results and add guided source capture | Mainly integration and presentation |
| Monitoring | Report schedules and bounded provider rule families already exist | Persistent read-only monitors, deduplicated incidents and explicit notification destinations | New monitoring product built on existing collection/analysis |
| Client operations | Revisioned profiles, naming, UTMs, bindings and templates | Typed client playbooks with previews and controlled inheritance | Extend existing profile/template model |
| Measurement | Conversion, GTM, analytics and selected business/mobile measurement capabilities | A connected measurement diagnosis and reviewed repair journey | New workspace over existing and qualified additional contracts |
| Commerce | Meta, Snapchat and X catalog/product/set/feed families | Product ingestion, destination mappings, diffs and item-level reconciliation | New orchestration plus specific missing connectors |
| Human operations | Activity, health, jobs, receipts, policies and diagnostic tools | One attention queue and typed recovery center | Aggregate existing operational state |
| AI interface | Tools, guides, prompts, searchable discovery and structured content | Typed result states, bounded projections and direct website handoff | Contract/interface improvement |

The **800 reviewed action rows are not 800 distinct workflows**: aliases are counted independently, and provider API
coverage is explicitly unknown. Equally, “all examined blocked routes classified” does not mean product development
is finished. Three guided recipes leave substantial room to turn existing depth into useful experiences.

## 4. Complete workflows that should define the product

### A. A new client becomes ready to work

The owner creates a client profile, binds authorized accounts, sets naming/UTM conventions and chooses the relevant
objectives. AMCP checks the exact login, account, currency, scopes, selected assets and measurement prerequisites.
The result is a checklist with a named blocker, its evidence and a correct next action. “Connected” means the login
exists; it must not imply that every campaign objective is available.

The account detail should retain this evidence and its freshness. Reauthorization should return to the interrupted
task. First-time onboarding needs a clear pending-approval/MFA/verification state; established users should land on
their work. Existing readiness and grant machinery supplies the foundation.

### B. A brief becomes a verified campaign

Choose a supported recipe, existing campaign clone, saved playbook or MCP-created plan. Resolve account and client
defaults first, then gather business inputs, creative, audience and measurement. Inspect the dependency plan and
provider-specific assumptions. Save a versioned draft, run preflight, review readable changes and execute through the
existing per-step or whole-plan controls.

The execution view shows each step's receipt and verification. If a step needs correction, edit the allowed fields,
invalidate the affected review and reprepare. If submission may have succeeded, reconcile first. Existing native
activation semantics remain visible: a product must not describe an inherently activating X promotion as paused.

The website currently exposes less of this lifecycle than MCP. Completing whole-plan execution, clone, safe step
amendment and observed-state acceptance is a higher-value first step than building another campaign engine.

### C. Creative goes from source to reusable advertising asset

Choose local, linked or selected Drive sources; inspect file properties and provenance. Select destinations and show
a matrix of output format, dimensions, naming, transform choices and eligibility per account. Preview the exact
variant before review. Execute as durable jobs, showing uploaded versus provider-processing versus usable states.

The library should distinguish source files, transformed variants and provider receipts. Later campaigns should
reuse verified account-bound receipts. A failure in one target must not hide successful others. Pagination and
filtering should expose the complete history rather than first-page counts.

### D. Data becomes a defensible decision

Choose a saved definition or template, exact accounts, dates/grain, metrics and objectives. Collection produces an
immutable snapshot with source freshness, attribution, currency, timezone and completeness. Analysis uses that
snapshot's evidence. A suggestion can create a draft proposal linked to its input data, thresholds and assumptions.

Users must see the distinction between zero, unavailable, partial, stale and failed. Different platforms' conversion
counts are not automatically deduplicated people, and multiple currencies are not silently additive. Targets and
forecasts must say what they assume. Reconciliation compares genuinely comparable totals and explains differences.

Pacing and related analysis already exist; the improvement is bringing them into this joined workflow, making
source capture usable from the website, and preserving the evidence when a recommendation becomes a plan.

### E. A report becomes reliable recurring delivery

Bind an exact spreadsheet/tab to a saved definition, preview replacement scope, choose delivery cadence/timezone and
the independent data window, then inspect upcoming run dates. The schedule list shows the last successful snapshot,
current destination, next run and failures. Users can pause, amend and resume existing schedules in a dedicated view.

Scheduling and Sheets delivery already exist. The missing product quality is visibility, clear destination ownership,
failure recovery and comprehensible timing. Report collection, snapshot creation and destination delivery need
separate statuses so a delivery error does not imply that source data must be recollected.

### F. An operational problem becomes a safe continuation

One attention queue gathers expiring access, failed deliveries, blocked plans, processing media and uncertain
mutations. Each item identifies its workspace/account, original object, stage, receipt and permitted next action.
“Reconnect”, “retry this read”, “amend this unsent step”, “resume this upload” and “inspect observed state” have
different meanings; a generic Retry button should not conceal them.

Support-bundle preview/export should be available beside the error, with sanitized diagnostics and correlation IDs.
Existing errors already contain useful remedies; the website should preserve them.

### G. Measurement and commerce become first-class work

A measurement workspace should connect selected conversion actions, GTM configuration, GA4 properties, site/search
data and mobile attribution evidence to campaign objectives. Start with diagnosis and a documented measurement plan;
proposed configuration changes still pass through existing reviewed execution.

A commerce workspace should map a product source to eligible destination catalogs, validate stable IDs, prices,
currency and required fields, preview item diffs, then reconcile individual results. Empty or failed source feeds
must not imply deletion. These are useful new product journeys, not permission to create undocumented provider APIs.

## 5. Provider contracts and expansion strategy

Move from a flat support list toward a **capability graph**: canonical action, objective, required objects/scopes,
input/output schema, ownership check, effects, limits, verification path, current evidence and lifecycle support.
Aliases point to canonical actions. A workflow is eligible only when its necessary dependencies are satisfied.

The graph should power website forms, MCP discovery, preflight, documentation and an account-specific capability
view. Keep native prepare/execution checks authoritative. Cached readiness is context, not continuing authorization.

| Provider group | Practical next product outcome | Main boundary to resolve |
|---|---|---|
| Google Ads | Complete Search acquisition/measurement journey, richer qualified objective packs, Data Manager diagnostics | Exact goals/assets, upload lifecycle and native acceptance; retain settled scope/terms decisions |
| Meta | Conversion/lead recipes, catalog-to-ad journey, creative refresh and bounded rule management | Objective/identity/catalog prerequisites; visible financial effects; personal-data correctness first |
| TikTok | Usable manual/Smart+ website and Instant Form recipes, identity/CTA discovery | Separate eligible existing flows from missing official evidence and allowlist-dependent products |
| LinkedIn | Audience → campaign → content/form → conversion workflow and guided clone | Organization ownership; additional Audiences/Media Planning programs are conditional expansion |
| Snapchat | Lead, reminder and commerce launch packs with creative/targeting dependencies | Exact pixel/form/catalog ownership and unsupported creative-route evidence |
| X | Research → creative/card → explicit promotion → reconciled report; commerce operations | Promotion means activation; hourly report boundaries; bounded async analytics |
| Microsoft | Complete Search setup including geography, extensions and measurement handoff | Current recipe defers geography; no invented media import support |
| Apple Ads | Keyword/negative workflows and understandable shared-budget changes | Every affected account and policy must be accounted for |
| Reddit | Guided eligible campaign/creative/post/lead journeys | Zero blocked ledger rows does not establish full provider coverage |
| DV360 | Enterprise targeting, creative/line-item and SDF workflows | Performance-report integration needs separate evidence; advertiser and partner scope differ |
| Criteo | Demand-side retail performance and catalog workflow; qualified Overview bridge | Supply-side account model and reporting semantics are distinct |
| GA4/GTM/Search Console | Connected measurement inspection and reviewed configuration repair | Property/container/site identity, event semantics, deliberate publication |
| Business Profile/Adjust | Clear provisioned-connection setup and usable existing native workflows | Website OAuth and normalized/scheduled reporting parity are not universally present |
| WooCommerce / further commerce | Concrete product-source connector when demanded by a complete workflow | Advertised unmapped actions are not an implemented integration |

This table summarizes repository evidence, not newly verified vendor promises. The contract appendix identifies
specific evidence gaps and permissions. Classify each prospective addition as one of:

- implemented but poorly exposed;
- an implementation gap within already settled owner decisions;
- missing or stale official evidence;
- a genuinely new provider permission/product;
- a deliberately prohibited design;
- replaced, retired or provider-unsupported functionality.

That classification avoids both unnecessary refusal and reckless expansion. Do not ask again for already settled
commerce, automated-rule or Google Data Manager decisions. The previously declined extra spending-approval layer
remains declined. Existing per-account personal-data controls, including current removal behavior, remain intact.

## 6. Website design, navigation and layout

### What the current rendering tells us

A local synthetic fixture was rendered for the public home, sign-in/administrator entry, dashboard, campaign
composer and Reporting Overview. It used fake connections and an in-memory store, with unexpected provider egress
rejected. This is fresh but limited visual evidence, not production/browser-matrix qualification.

The purple, ink and warm-neutral identity is coherent. The public homepage has a clear hero and visually consistent
entry points. Keep that identity. The working application needs more emphasis on operational information:

- The desktop dashboard places a large welcome illustration and generic call to action above readiness and work state.
- Campaigns opens with a long recipe form; saved plans and a second plan-creation form follow it.
- Reporting places library controls and configuration on one long surface; “Reporting overview” and “Reports” sit
  beside each other without conveying their underlying difference clearly enough.
- The desktop sidebar itself scrolls in the observed height; grouping and role-relevant secondary navigation would
  make the structure easier to scan.

These are design judgments grounded in the observed layout, not measured usability-study results. One initial direct
Reporting Overview load showed an undefined-renderer error; subsequent authenticated navigation worked. Treat that
as a bootstrap investigation, not an additional confirmed defect.

### Proposed information architecture

Use seven primary task groups, with existing pages reorganized beneath them:

| Group | Main views |
|---|---|
| Home | Needs attention, recent/resumable work, readiness |
| Campaigns | Plans, new plan, plan detail; later an account-object explorer |
| Creative | Library, prepare & push, previews |
| Reporting | Report library, builder/results, evidence & analysis, schedules |
| Clients & templates | Profiles, defaults, campaign/report playbooks |
| Connections | Platforms/accounts, account readiness, AI tools |
| Operations | Jobs/recovery, activity, capability reference |

Keep Team, Account policies, Retention and instance-owner Deployment setup in a secondary management group. Put
personal security and sessions under the avatar. Keep the active workspace name and role visible; client filters
organize authorized work and never confer access.

### Three core layout specifications

These wireframes describe proposed hierarchy; they are not screenshots of implemented changes. The UX appendix
specifies 21 views and their mobile, empty, busy, error and permission states.

```text
HOME
┌───────────────┬─────────────────────────────────────────────────────────┐
│ Workspace     │ Client filter        Search work        Account / role   │
│               ├─────────────────────────────────────────────────────────┤
│ Home          │ Work needing attention             New plan ▾           │
│ Campaigns     │ [Blocked plan] [Delivery failure] [Connection action]    │
│ Creative      ├────────────────────────────┬────────────────────────────┤
│ Reporting     │ Continue recent work       │ Account readiness          │
│ Clients       │ Plan/report/job + next step│ Exact blocker + remedy     │
│ Connections   │ Updated time and owner     │ Evidence freshness         │
│ Operations    ├────────────────────────────┴────────────────────────────┤
│               │ Latest outcomes / scheduled deliveries                  │
│ Management    │ Verified result, date, account and link to evidence     │
└───────────────┴─────────────────────────────────────────────────────────┘

PLAN DETAIL
┌─────────────────────────────────────────────────────────────────────────┐
│ Plan name / revision · Client · exact account · currency · status         │
├─────────────────┬───────────────────────────────────┬───────────────────┤
│ Dependency steps│ Selected change                   │ Review summary    │
│ ✓ verified      │ Before → after                    │ Money / delivery  │
│ → ready         │ Audience / creative / dates       │ Affected objects  │
│ ! needs input   │ Source/default provenance         │ Exact requirements│
│ … waiting       │ Blocker + allowed amendment       │ Approve / run     │
├─────────────────┴───────────────────────────────────┴───────────────────┤
│ Execution journal: sent → accepted → processing → verified / uncertain   │
│ Original receipts, read-back, next safe action and support diagnostics   │
└─────────────────────────────────────────────────────────────────────────┘

REPORT RESULT
┌─────────────────────────────────────────────────────────────────────────┐
│ Report / snapshot · collected at · date window · definition revision      │
│ Source health: complete / partial / failed / stale + exact affected data  │
├─────────────────────────────────────────────────────────────────────────┤
│ Currency-separated summaries       Comparison window / metric meanings  │
│ Data table: source → account → campaign → period; configurable columns   │
├───────────────────────────────────┬─────────────────────────────────────┤
│ Evidence-linked analysis          │ Reconciliation / assumptions         │
│ Threshold and confidence limits   │ Native totals and explained variance │
├───────────────────────────────────┴─────────────────────────────────────┤
│ Save setup · Export this snapshot · Schedule · Draft reviewed proposal    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Visual and interaction system

Retain the existing token system, then specify reusable page headers, dense/comfortable data tables, field groups,
review diffs, status timelines, source-health strips, drawers and empty states. Use purple for primary interaction,
with semantic status colors always accompanied by text or icons. Keep marketing illustration mainly on public and
empty/onboarding surfaces; working views should prioritize data and next actions.

Use consistent spacing and typography hierarchies, tabular numerals for amounts, and readable identifiers with copy
controls. Primary actions should be predictable in location and wording. Technical JSON belongs in an advanced
disclosure; common campaign, profile and report tasks need typed forms and explanatory previews.

At narrow widths, change three-column detail views into ordered sections with the account/status summary retained.
Do not squeeze wide tables into unreadable cards; offer labelled horizontal scrolling and focused column choices.
Every dialog needs focus entry/return, keyboard dismissal where appropriate, an accessible name and a clear save
state. Async updates should announce meaningful outcomes without repeatedly interrupting assistive technology.

Arabic localization should be a full product track: reviewed translations, RTL layout, bilingual content entry,
logical CSS, date/number formatting and mixed-direction identifiers/URLs. RTL styling alone is not localization.
Theme support is secondary to readable contrast, consistent states and complete workflows.

## 7. MCP and human–AI collaboration

The AI surface should help an assistant select the smallest correct next operation. Existing search/pagination and
guidance should be retained. Improve typed outputs so eligibility, review, progress, partial report and recovery
states carry predictable fields and safe next actions rather than a generic unconstrained data object.

An intent-oriented entry can resolve a requested objective into relevant contracts and prerequisites without
turning into an unrestricted execution gateway. Return compact summaries by default where compatible, with explicit
projections or evidence references for details. Include stable object IDs, revision/hash, account identity and website
deep links. Clearly distinguish provider-supplied text from operational instructions.

Improve prompts/examples around actual jobs: diagnose readiness, build an eligible recipe, inspect a reviewed change,
recover uncertain execution, interpret partial reports and reuse a verified asset. Add evaluation tasks that check
outcomes and authority preservation, not exact model wording. Measure correct tool choice, unnecessary calls,
repeated refused calls and successful handoff to the website. Do not increase autonomy by weakening approvals.

## 8. Reporting, insight and creative expansion beyond the current UI

The detailed workflow appendix specifies the implementation candidates. These are the principal product investments:

- **One reporting journey:** bridge Overview snapshots into existing source-linked analysis; preserve native metric
  definitions, null behavior, attribution and time windows. Add browser-guided capture for sources that currently
  require MCP, with clear report-type compatibility.
- **Objective-aware analysis:** make existing pacing/fatigue/search-waste recommendations visible where decisions
  happen. Show thresholds, sample/lag limitations, comparable baselines and the source snapshot. Keep explainable
  rules before speculative optimization claims.
- **Persistent read-only monitors:** evaluate saved conditions on successful snapshots, deduplicate repeated incidents,
  show recovery and acknowledge/snooze states. Start in-product; external notification destinations are explicit.
  Report scheduling already exists; an incident lifecycle is additional work.
- **What-if planning:** add transparent scenario comparisons for budget distribution, dates or target assumptions,
  using deterministic arithmetic and existing preflight. Label assumptions and sensitivity; do not market an
  uncalibrated scenario as a provider delivery forecast or guaranteed performance.
- **Creative performance lineage:** associate source/variant/upload/creative/ad/report where real IDs establish the
  relationship. Compare variants only under stated attribution and comparable periods. Missing links remain unknown.
- **Creative QA and reuse:** expose per-target requirements and eligibility before upload, preserve variants and
  receipts, show shared-asset dependencies before edits, and support measured bulk workflows with partial recovery.
- **Measurement diagnosis:** connect configuration evidence to observed event/report behavior. A GTM configuration
  check is not proof that real conversions are arriving; the UI must distinguish those evidence levels.
- **Controlled bulk operations:** compile typed changes, show per-account effects and per-item outcomes, persist the
  exact approved job, limit concurrency and recover original receipts. Cancellation stops only work not yet sent.

Do not rush into autonomous spend optimization. A stronger first product generates evidence-linked draft proposals
that a user can inspect through the existing review system. Revisit more automation only after reporting fidelity,
scope, stop conditions and measured outcomes support it.

## 9. Architecture, quality, privacy and operations

The engineering review remains the detailed source for defects and technical measurements. Product expansion must
include these supporting investments:

| Dimension | Improvement and completion evidence |
|---|---|
| State ownership | Scope caches/drafts/jobs to identity and workspace; generation-aware navigation; cover recipe drafts as well as reporting; old responses cannot repaint a new session |
| Dispatch authority | Recheck current pause, policy and account controls immediately before unsent work; keep receipts for accepted writes; verify chunked media and waiting admission paths |
| Personal data | Repair redaction on keys and rejected/error paths before improving upload convenience; minimize audit data; verify support exports remain sanitized |
| Error contracts | Preserve code, remedy, correlation ID and allowed next action across backend, MCP and website; no unsafe generic retry |
| Maintainability | Extract stable seams from large modules by lifecycle responsibility; reuse registered-family contracts and semantic types; avoid a wholesale rewrite without evidence |
| Performance | Benchmark real journeys and network request counts; bound aggregate report cost; introduce measured concurrency, batching, caching and selective browser loading |
| Long-running work | Durable progress, retry/read-back distinctions, quota-aware queues, lease/restart recovery and explicit cancellation semantics |
| Accessibility | Keyboard task completion, focus, live regions, reflow, zoom, contrast and screen-reader evidence on representative workflows; automated checks alone are insufficient |
| Testing | Keep deterministic failure/race tests; add browser journeys, provider contract drift fixtures, report invariants, representative volume tests and restart scenarios |
| Release operations | Reproducible build and dependency records, actual container/FFmpeg smoke, migration/rollback exercise, backup restore drill and post-deploy health verification |
| Observability | Sanitized structured events and useful job failures; latency/error/queue/refresh indicators with bounded labels; correlate plan, request and provider receipt |
| Documentation | One generated current capability view, dated evidence, practical runbooks and upgrade/deprecation guidance; separate history from current support |

Multi-worker database/queue behavior and tenant isolation deserve load and adversarial scenario qualification before
claiming scale. Choose a storage migration only after profiling identifies a need. Stronger operational visibility
and honest limits are preferable to an unmeasured distributed rewrite.

The current local baseline passed with five FFmpeg-related skips; container smoke, deployed behavior and current live
provider acceptance remain unverified. The product blueprint does not turn that evidence into a production-readiness
claim.

## 10. Capability qualification and release gates

Every meaningful workflow should have a capability card containing:

1. The user outcome and exact supported provider/account/objective combinations.
2. Required permissions, objects, fields, units and limits, with dated official evidence.
3. Native effects, activation/removal semantics and what cannot be reversed or verified.
4. Input, result, partial-failure and safe-recovery contracts.
5. Synthetic positive/negative/race fixtures and a complete browser/MCP journey.
6. Container/CI results, followed separately by explicitly authorized account-specific live acceptance.
7. Receipts/read-back, evidence expiry/invalidation and a support runbook.

The current sandbox runner is limited to X/Microsoft, bounded non-delete steps and no media qualification. Extend
the harness as a deliberate project; do not imply that its present scope certifies the whole product. One accepted
action never creates a provider-wide green badge. New permissions, changed contracts or API versions can invalidate
previous evidence.

## 11. Success measures

Collect a baseline before setting numerical improvement promises. These are proposed measures and hard acceptance
properties, not claimed current performance or completed user research.

| Outcome | Measure |
|---|---|
| Faster first value | Time, screens and calls from authorized login to correct readiness result and first useful report/plan |
| Better campaign completion | Eligible plans reaching verified intended state; abandonment by stage; recipes requiring raw native JSON |
| Understandable review | Can a representative user correctly identify account, budget/currency, activation and affected objects before execution? |
| Reliable recovery | Time to diagnose and continue; duplicate/ambiguous resubmissions; successful restart and navigation recovery |
| Correct reporting | Reconciliation error for comparable periods; zero/null/partial correctness; complete versus failed deliveries |
| Useful insight | Recommendations with traceable data and valid thresholds; accepted draft proposals and measured follow-up outcomes |
| Creative efficiency | Source-to-usable-receipt time; avoidable rejection rate; verified receipt reuse; failed target recovery |
| Accessible workflow | Keyboard and assistive-technology completion of each critical journey; mobile/zoom task success |
| Integration quality | Complete qualified workflows by account/objective; evidence age; unresolved required lifecycle stages |
| Operating cost | Calls, bytes, queue delay, peak RSS and p50/p95 journey latency under a specified workload |

Non-negotiable acceptance properties include no cross-identity draft disclosure, no silent currency combination, no
automatic replay of an uncertain mutation, and no “verified” label without the corresponding evidence.

## 12. Consolidated implementation backlog and sequence

**S / M / L are relative sizes, not calendar estimates.** S is a bounded surface or contract change; M spans a
workflow and tests; L crosses engines/providers or adds a new product subsystem. Dependencies can change effort.
P0 is release-blocking correctness, P1 high-value completion, P2 expansion, P3 conditional/later investment.

| ID | Priority / size | Deliverable | Depends on | Demonstrable acceptance |
|---|---|---|---|---|
| B01 | P0 / M | Privacy and final dispatch-authority repairs | Existing engineering findings | Reproduced leakage/pause/revocation cases fail safely; accepted receipts survive |
| B02 | P0 / M | Identity-safe drafts and navigation | — | Logout/switch/401 and leave-return races cannot show another context |
| B03 | P0 / M | Reporting arithmetic/null/pagination correctness | — | Adjacent periods reconcile; valid empty/sparse metrics remain usable |
| B04 | P1 / M | Media/report recovery and useful errors | B01–03 | Each partial/uncertain outcome has the correct resumable state and remedy |
| B05 | P1 / M | Requirements-driven readable review | B01–02 | Exact money/status changes and required cap/spend acknowledgements are actionable |
| B06 | P1 / M | Campaign list/detail, whole-plan run and journal | B05 | Existing approved plan can complete from the website and be resumed in MCP |
| B07 | P1 / M | Guided clone, step amendment and observed-state comparison | B06 | Supported clones and recovery work without native JSON or blind resubmission |
| B08 | P1 / M | Capability graph and account/objective eligibility | Existing contracts | Each advertised workflow resolves prerequisites or names the precise unknown/blocker |
| B09 | P1 / M | Task-oriented Home, navigation and deep links | B02, B06 | Operators resume exact work; onboarding and operational content adapt to state |
| B10 | P1 / M | Creative library, preparation matrix and durable progress | B04 | Every output/account is previewed; jobs and paginated receipts survive navigation |
| B11 | P1 / M–L | Report library/builder/results, analysis bridge and whole-job collection bounds | B03–04 | Definitions/snapshots remain distinct; aggregate request/time/row budgets and resumed lineage are enforced |
| B12 | P1 / M | Schedule index, timing preview and delivery recovery | B11 | Next window/destination is understandable; failed delivery recovers; broad scheduling respects collection budgets and worker fairness |
| B13 | P1 / M | Operations/recovery center and support bundle UI | B04, B06, B10–12 | Attention items expose current stage, original receipt and a safe next action |
| B14 | P1 / M | Typed client playbooks and template preview | B08 | Resolved naming/UTMs/defaults are visible, versioned and account-bound |
| B15 | P1 / M–L | Typed MCP outcomes and workflow evaluations | B08, B13 | Clients choose correct next actions with fewer unnecessary calls; UI links preserve identity |
| B16 | P1 / M–L | Browser, container, accessibility and acceptance qualification | Each slice | Separate reproducible local/CI/container/live evidence for the shipped workflow |
| B17 | P2 / M per recipe | First additional objective launch packs | B05–08, B10, B14 | Complete qualified campaign journey from brief to verified outcome |
| B18 | P2 / M | Guided native report capture and richer reconciliation | B11 | User can capture supported sources and explain comparable variance without MCP-only setup |
| B19 | P2 / L | Read-only monitors and incident lifecycle | B03, B11–13 including aggregate collection bounds | Deduplicated evidence-linked alerts, bounded evaluation, recovery states and explicit delivery destinations |
| B20 | P2 / L | Measurement diagnostics workspace | B08, B11, B13 | Exact property/container/event evidence distinguishes setup from actual measurement |
| B21 | P2 / L | Commerce ingestion and destination reconciliation | B08, B13 | Typed item diff, explicit destructive intent and per-item destination outcome |
| B22 | P2 / M–L | Controlled bulk jobs and creative performance lineage | B06, B10–11 | Bounded jobs retain per-item receipts; lineage uses actual IDs and comparable evidence |
| B23 | P2 / M | Measured scaling, caching and module simplification | Journey benchmarks | Better measured cost/latency with unchanged contract classification and authority |
| B24 | P2 / L | Full Arabic localization | Stable components; runs alongside slices | Complete translated critical journeys with RTL/formatting/keyboard verification |
| B25 | P3 / M–L each | Conditional provider programs and enterprise/reporting bridges | Official evidence, actual eligibility | A specific requested workflow qualifies; no blanket provider-support claim |
| B26 | P3 / M–L | Scenario planning and more advanced optimization proposals | Reliable reporting/baselines | Assumptions and uncertainty explicit; proposals remain inspectable before reviewed action |
| B27 | P2 / L | Live account portfolio and qualified entity/dimension reporting | B03, B08, B11 | Provider inventory pages reconcile; supported detail views retain grain, limits and valid parent comparisons |
| B28 | P2 / M | Client-facing report packs | B11–12 | Styled summaries/charts reconcile to retained raw evidence; preview protects destination scope |

Start B01–04 together where independent. Follow with a **complete campaign slice** (B05–09) and a **complete data/
creative slice** (B10–13), while B08/B14/B15 unify their contracts. Qualification B16 and accessibility are part of
each slice, not an end-stage cleanup. Then choose the first B17 recipes from actual customer demand and eligible
accounts; Meta leads/conversions and a qualified TikTok or Snapchat pack are strong candidates, not predetermined
claims of eligibility. Expand measurement, commerce and monitoring after those foundations hold.

This sequence is a recommendation. It is not authorization to implement all packages, contact users, change
provider permissions, mutate advertising accounts or deploy. The current deliverable is the full review.

## 13. Coverage check and remaining discovery

| Requested dimension | Where addressed |
|---|---|
| More capability, not just fixes | Sections 2–5, 7–8 and B17–28; provider and workflow appendices |
| Workflow improvement | Seven connected journeys here; ten detailed journeys in the UX specification |
| Contract integration | Capability graph, eligibility, typed outcomes, evidence/versioning; 18 contract initiatives |
| Website design and layout | Rendered observations, navigation, three wireframes, 21 page specifications, shared design system |
| Reporting and measurement | Source semantics, analysis bridge, reconciliation, schedules, monitors and measurement workspace |
| Campaigns and creative | Recipes, clone, full execution, recovery, variants, previews, durable progress and lineage |
| Security and privacy | Engineering findings, final dispatch authority, state ownership, redaction and existing account controls |
| Performance and scalability | Measurements in engineering review; aggregate budgets, queues, benchmarks and B23 |
| Testing, deployment and maintenance | Engineering baseline, qualification cards, release/restore checks, observability and docs |
| Localization and accessibility | Interaction contract, RTL/translation plan, task-based verification and B16/B24 |
| Priorities and proof of improvement | Consolidated backlog, dependencies, acceptance properties and outcome measures |

The remaining discovery is concrete: representative users performing the critical journeys; a broader browser/
viewport/assistive-technology matrix; account-specific provider qualification; current official evidence for each
conditional API addition; real workload/hosting measurements; and prioritization of the first expansion recipes by
observed demand. These are the next sources of evidence, not reasons to stop improving the product.

The strongest direction is a coherent advertising workspace whose existing depth becomes easy to use, whose new
capabilities solve complete jobs, and whose website and AI interface share one trustworthy execution and evidence
model.
