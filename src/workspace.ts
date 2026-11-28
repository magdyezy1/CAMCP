import {operationKinds} from './operation-types.js';
import {auditHistoryPage} from './audit-history.js';
import {searchOverlap} from './search-overlap.js';
import {nativeAuthority} from './native-authority.js';
import {ownerOperations, writesPausedFor} from './owner-operations.js';
import {withheldWorkbookRecords} from './withheld-workbook-records.js';
import {cachedLegacyAliasUsage} from './legacy-alias-usage.js';
import {providerAccessPanel} from './provider-access.js';
import {actionContractPage} from './action-contracts.js';
import {capabilities} from './capability-graph.js';
import {dashboard, dashboardSections} from './dashboard.js';
import {checkConditionalProgram} from './conditional-programs.js';
import {
  check as readinessCheck,
  notApplicableCheck,
  providerReadFailure,
  readinessBinding,
  readinessContract,
  readinessId,
  recordedScopeCheck,
  sharedEvidence,
} from './readiness.js';
import {previewPlaybook, validatePlaybook} from './client-playbooks.js';
import {profileWithinAccess, visibleProfile} from './client-scope.js';
import {clientBriefs, recipeDeclarationFields, recipeDeclarations, recipeDefaultFields} from './recipe-context.js';
import {monitorActions, monitorOperation} from './report-monitors.js';
import {portfolioPage} from './portfolio.js';
import {reconcilePortfolio} from './portfolio-reconciliation.js';
import {catalogIngestion, catalogRetirement} from './catalog-ingestion.js';
import {workspaceAction, type WooCommerceRequest, type WorkspaceContext} from './provider-workflows.js';
import {catalogComparison} from './catalog-comparison.js';
import {assertCatalogRequirements, catalogRequirement} from './catalog-requirements.js';
import {catalogDestination} from './catalog-destinations.js';
import {catalogMapping, saveCatalogMapping} from './catalog-mapping.js';
import {resolveCatalogSource, suppliedCatalogSource, type CatalogSource} from './catalog-sources.js';
import {
  catalogPlanLimits,
  catalogPlanLineage,
  catalogPlanParts,
  comparisonLineage,
  comparisonLineageToken,
  releaseCatalogLineageBinding,
  storeCatalogLineageBinding,
} from './catalog-lineage.js';
import {activePlanCount, activePlanLimit} from './campaign-inventory.js';
import {operationsPage} from './operations-feed.js';
import {reportRunStatus, resumeReportRun} from './report-runs.js';
import {workbookSchedule, previewWorkbookSchedule, saveWorkbookSchedule} from './workbook-schedules.js';
import {reportQueryPage} from './report-query-access.js';
import {
  workbookQuery,
  previewWorkbookQuery,
  saveWorkbookQuery,
  previewWorkbookQueryMove,
  moveWorkbookQuery,
} from './workbook-queries.js';
import {
  workbookBinding,
  workbookBindingPage,
  previewWorkbookBinding,
  saveWorkbookBinding,
  previewWorkbookBindingState,
  saveWorkbookBindingState,
} from './workbook-bindings.js';
import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {MirrorError} from './errors.js';
import {providerHooks} from './provider-hooks.js';
import {reportSourceError} from './report-errors.js';
import {reportPlatforms} from './report-metrics.js';
import {Registry} from './catalog.js';
import {CredentialProvider} from './auth.js';
import {NativeTransport} from './transport.js';
import {ScopeGuard} from './scope.js';
import {validateState} from './write-state.js';
import {
  audit,
  bad,
  field,
  fingerprint,
  noSecrets,
  noSecretSteps,
  obj,
  optional,
  tool,
  update,
  validate,
  writer,
  type ToolCall,
} from './workspace-core.js';
import type {Actor, CompiledRequest, EnhancementFlags, JsonObject} from './types.js';
import {
  accountName,
  rememberAccountMetadata,
  accountPlan,
  accountMetadata,
  accountCurrency,
  accountTimezone,
} from './account-metadata.js';
export const workspaceTool = tool(
  'amcp_workspace',
  'Use this before planning a change and afterwards for its change history. portfolio_reconcile performs two complete bounded observations of one qualified inventory hierarchy. Use the same gateway/account_id/connection_id/requirements as portfolio, limit 1–100, max_entities 1–1000 (default 500) and max_pages 1–25 (default 20). It shares one 120-attempt, 120-second and 32 MiB collection allowance across both scans, retains original native IDs and fields, and returns observed added/missing/changed records, page references and independent content hashes. Incomplete, conflicting, repeated or changed-authority reads are refused; no partial result becomes a comparison. Matching observations do not prove an atomic snapshot. Missing rows do not establish deletion or authorize removal. It saves no plan, review, report or provider mutation. preview_catalog_removal reads 1–50 explicitly selected individual X products (supplied retailer_ids, or listed product_keys in requirements) under the exact account/login/catalog and keeps a ten-minute session-bound preview. create_catalog_removal takes its preview_id/preview_hash and confirmed:true (a listed selection also confirmed_count), repeats the evidence and saves one unapproved single-product DELETE step per key; saving deletes nothing and each step’s native review rechecks its product. Grouped or unknown products are refused, no absent-source deletion is inferred and scheduled feeds may restore products. preview_consent_plan reads 1–10 explicitly selected Tag Manager tags in one exact account/container/workspace with requirements:{container_id,workspace_id,tag_ids,required_types}. Choose 1–20 distinct literal additional-consent types; existing required types and other tag configuration are preserved. Types outside the seven documented Google consent types need requirements.custom_types_acknowledged:true and are labelled in the draft. Bracketed current native fingerprints, read authorization and bounded requests/bytes/time bind a 10-minute, session-bound metadata preview. create_consent_plan requires its original preview_id/preview_hash and confirmed:true, repeats current evidence and saves one unapproved native UPDATE_TAG plan. No provider update, version creation or publishing occurs in either action. Unsent steps check original tag configuration again before native prepare/execute; existing review/ownership/write-authority/receipt controls still apply. Built-in checks, runtime consent, event delivery and compliance remain unverified. contracts lists the read/write/media/blocked contract class of every local action without network calls; filter by gateway/search and page with offset/limit. history returns bounded safe event metadata, never raw requests or receipts. Use limit 1-100, search (event/action/request reference), gateway/account_id/connection_id and returned cursor. Each page rechecks current access; owners see workspace metadata, other users see currently accessible account events and their own unscoped events. Conflicting scope is withheld. Pagination retains its original sequence ceiling; follow continuation even after an empty page and refresh for newer events. This is retained AMCP history, not complete vendor history or a new integrity verification. operations is a local, metadata-only cross-engine feed: filter kind/state/search/account_id, page with next_cursor, and follow each read-only next_call to the original record. Local workbook report runs (kind workbook_report) stay in AMCP and never write to the spreadsheet; report_run reads a bounded, currently scoped status by id. resume_report_run requires id, the displayed run_version and confirmed:true, requeues only prepared/failed/cancelled read-only reports, and preserves their original run ID. report_schedule inspects a local workbook schedule by id (no spreadsheet delivery; Google Sheets delivery is an amcp_reporting_overview schedule) with three future clock times and schedule_version. preview_report_schedule validates proposed active:boolean and schedule:{name,timezone,schedule_kind,minute,hour,weekday?,day?} against id and schedule_version, returning changes and three proposed clock times without mutation. save_report_schedule accepts those fields with confirmed:true; query identity is unchanged and existing jobs continue. report_queries lists currently authorized query metadata with search/account_id/connection_id/spreadsheet_id and offset/limit; continue with next_offset, even after an empty page. report_query reads one bounded query by id and its query_version. preview_report_query reviews query:{name,query_config} with id and query_version; provider/account/connection stay fixed. save_report_query adds confirmed:true and saves that exact revision, pausing active schedules when the definition changes and creating one prepared, unsubmitted report. Existing jobs retain their configuration. report_bindings lists scoped local workbook associations with search/spreadsheet_id, state active (default)/retired/all and offset/limit; continue next_offset even after an empty page. report_binding inspects one binding by id, returns up to 100 linked queries and binding_version, and does not verify external spreadsheet access. preview_report_binding reviews binding:{spreadsheet_name} with id/binding_version; save_report_binding adds confirmed:true and renames only local metadata. The spreadsheet ID, stored preferences, queries, schedules and report runs remain unchanged. Current access to every linked query is required; empty bindings are creator/admin-only. preview_report_binding_state takes id/binding_version and active:boolean to review retirement (false) or restoration (true) of an empty association. save_report_binding_state adds confirmed:true. Any linked query or schedule, including orphaned schedules, blocks the change. Retirement preserves private settings and IDs, hides the association from active lists and blocks new use until explicit restoration. It does not delete reports or any external spreadsheet. preview_report_query_move takes the original query id/query_version and an existing target_binding_id, returns source/target identity, schedule impact and rebinding_version. move_report_query adds that rebinding_version and confirmed:true. It atomically moves the query and up to 100 linked schedules, pauses all of them for separate review/resume, preserves existing jobs and prepares one unsubmitted local run. Current access to both associations and every linked query is required; no external spreadsheet access is verified. Read-only native configurations require explicit scope and credentials belong in Connections. incidents/monitors support state/search/account filters and offset/limit; incident/monitor read one record. Acknowledge, snooze 1-168 hours, or resume an incident with its current revision; snooze never resolves evidence. monitor_notifications reads only your subscription and 20 recent deliveries for monitor id. set_monitor_notifications requires id, enabled:boolean, current subscription_version and confirmed:true; it opts only your verified personal email into future openings/reopenings/resolutions. Rule revisions, account security and access changes require new confirmation; no arbitrary recipient or historical backfill. retry_monitor_notification requires notification_id, current notification_version and confirmed:true, reusing the original recipient/payload/key within 24 hours; five automatic attempts and one recovery up to ten total. Provider acceptance is separate from inbox delivery. program_check inspects one exact conditional program returned by capabilities, with workflow_id, account_id and connection_id. Default live:false checks local contracts and recorded permissions without a provider request. Explicit live:true takes requirements:{forecast:forecastReaches|forecastImpressions|forecastLeads,request:{native Media Planning fields}} for program:linkedin_forecast, requirements:{request:{native Audience Insights fields}} for program:linkedin_audience_insights or requirements:{} for program:dv360_advertiser. One bounded native read retains exact projected evidence or a typed refusal with its original scope/request/hash/time. live:false also returns requirements_template (JSON Schema) and required_inputs paths. A refusal returns owner_action and next_call:null; do not repeat it until the owner acts. Each live read keeps one timestamped observation (state, codes, request IDs; no payload) for 30 days, not a grant, removed on disconnect. It saves no readiness grant, review or advertising change. Application approval, account access, OAuth scopes, objective eligibility and other program/write access stay separate. capabilities accepts exact workflow_id/account_id/connection_id filters, exposes dependency objects, native contracts and review lifecycle, and reports timestamped account-read evidence separately from unverified objective acceptance. portfolio reads bounded Google, Meta, LinkedIn, Snapchat, TikTok, X or Microsoft inventory pages with gateway/account_id/connection_id, limit 1–100, requirements and an optional returned cursor. Google entities: campaign, ad_group, ad (campaign_id and ad_group_id parents). Google uses account-scoped GAQL with exact returned account/parent/resource checks, a signed five-minute cursor bound to actor/login/permissions/hierarchy/page size, and up to 100 pages. Native int64 IDs and micros remain exact; unselected provider fields are omitted. Configured status is not serving evidence. Meta entities: campaign, adset, ad (campaign_id and adset_id parents); read each parent first with the same login, then follow its children within six hours. Meta cursors bind account/login/entity/page size and expire after five minutes; native money stays unconverted and effective status stays separate. LinkedIn entities: campaign_group, campaign (campaign_group_id parent), creative (campaign_group_id and campaign_id parents). Read each parent in the same login first; observations and signed cursors last five minutes. LinkedIn cursor search covers documented group statuses and test/non-test entities, keeps exact decimal money with currency, and separates creative intended status from observed serving. Inventory is current, not a point-in-time snapshot. Snapchat entities: campaign, adsquad (campaign_id parent), ad (campaign_id and ad_squad_id parents). Use exact UUIDs and a page limit of 50–100. Read qualified portfolio parents first; parent observations and signed scope-bound cursors last five minutes. Snapchat keeps exact micros, current currency/timezone and separate configured status, review status and delivery codes. Only the opaque cursor is reused on a fixed scoped native route; adjacent overlaps, changed hierarchy and malformed continuation fail. TikTok entities: campaign, adgroup (campaign_id parent), ad (campaign_id and adgroup_id parents); 1–100 rows through standard v1.3 advertiser-scoped routes. Signed five-minute cursors bind actor/login/permissions/account/hierarchy/page size, cap traversal at 100 pages and reject changed totals or adjacent overlaps. Native amounts preserve JSON numbers or decimal strings and account-currency units with budget_mode; operation_status and secondary_status stay separate. This does not imply Smart+, GMV Max or specialized-route coverage. X entities: campaign, line_item (campaign_id parent), promoted_tweet (campaign_id and line_item_id parents). Account-scoped v12 GETs verify current parents and returned hierarchy. Native micros and post IDs stay exact; configured/effective status, servability and approval stay separate. Signed five-minute cursors bind actor/login/permissions/hierarchy/page size, cap traversal at 100 pages and reject repeated tokens or adjacent overlapping IDs. Pages exclude deleted/draft entities, post content, scheduled posts, promoted accounts and media creatives. Microsoft entities: campaign, ad_group (campaign_id parent), ad (campaign_id and ad_group_id parents); its reads are unpaged, so each page reads the complete collection (at most 1000 entities, refused above it) with every documented campaign or ad type, a signed five-minute cursor binds its content (PORTFOLIO_CHANGED when it changes between pages) and money is unconverted decimal account currency. measurement_audit with requirements {container_id, workspace_id} returns consent_evidence from the same scoped workspace reads: per tag, the native additional-consent setting, bounded literal required types or unknown interpretation, with workspace identity and a digest of selected evidence. Not set, no additional consent and required additional consent are distinct; built-in checks, defaults, updates, runtime timing and event delivery remain unverified. This is workspace configuration, not a compliance verdict. With versions it adds live_consent_evidence for the published version and a per-tag consent_diff against the draft from the same reads. Unlisted triggers form one finding per trigger ID with counts and sample paths; complete means every read succeeded and finding_list:truncated only shortens the list. measurement_events reads recent GA4 aggregate counts with gateway ga4_native_action, exact numeric property account_id, connection_id and requirements:{event_names:[1–20 exact names],minutes:1–30 (default 30),stream_id?:exact numeric ID}. This is one bounded realtime read, not an event sender; counts remain exact strings, absent rows have null counts, and partial/unknown evidence is refused. Deduplication, consent, attribution, test-event identity and overall health remain unverified; no snapshot is saved. measurement_event_identity inspects one exact synthetic GA4 test identifier using an existing registered event-scoped amcp_test_id custom dimension. Select gateway ga4_native_action, numeric property account_id, connection_id and requirements:{event_name,test_id:amcp-test- followed by 8–64 letters/digits/hyphens,date_from:YYYY-MM-DD,date_to:YYYY-MM-DD,stream_id?:numeric,expected_count?:1–1000 (default 1)}. Dates span at most seven property calendar days. Fresh exact-property metadata brackets one complete native runReport, bounded to three requests, 1000 rows, 2 MiB and 30 seconds with unchanged current authority. Exact counts compare against your declared expectation; absent rows remain null. No custom dimension is registered and no event is sent. This is matching aggregate report identity, not raw-event, deduplication, consent or attribution proof; restricted/sampled/truncated or changed evidence is refused. No snapshot is saved. measurement_conversions reads current LinkedIn conversion rule settings with gateway linkedin_native_action, exact account_id and connection_id. It collects at most 1000 rules across 25 bounded account-filtered native pages with current identity, account currency and authorization checks before/after. The projection retains exact IDs, native configured status/type/model, post-click/post-view days and exact configured value; omitted fields stay null. It keeps account/page source references but saves no snapshot and sends no events or writes. Campaign membership and historical attribution are not established. measurement_google_goals reads current Google Ads conversion goals with gateway google_ads_native_action, exact customer account_id, connection_id and optional requirements:{currency}. It repeats the bounded recipe goal inspection (account-default goals, enabled primary actions, value settings and last reported conversion/tag dates) twice under the same actor, login, credential and write-pause fence; manager and shared-conversion customers are refused and incomplete reads say so. Configuration is not delivery, deduplication, consent or attribution proof; nothing is saved. measurement_ga4_config reads one GA4 property configuration with gateway ga4_native_action, numeric property account_id, connection_id and optional requirements:{sections:[key_events|custom_dimensions|custom_metrics|data_streams|google_ads_links|data_retention]}. Fixed Admin API GETs list every row (10 pages per list, 60 requests, 4 MiB, 60 seconds); foreign, repeated or malformed rows are refused. It reports whether an event-scoped amcp_test_id dimension exists and each stream type and measurement ID; Ads link creator e-mails are never returned and nothing is saved. measurement_ledger reads one asset with its exact native gateway, account_id and connection_id: a Google Ads customer, GA4 property, Meta, Snapchat or TikTok ad account (optional requirements:{pixel_id} picks one listed pixel or dataset, otherwise the only one is read), Search Console site or Adjust app token. It returns six fixed layers (configuration, provider_observed_activity, provider_diagnostics, supplied_runtime_trace, consent, attribution_settings), each observed, unknown, unavailable or not_applicable with a reason code. Google Ads reuses the conversion goals read, then offline conversion upload client summaries and the attribution settings of enabled conversion actions; GA4 reuses the configuration read, then 30-minute realtime counts of its key events. Meta reads the account pixels, 24 hours of pixel stats and Dataset Quality; Snapchat its pixels, 7-day domain stats and Signal Readiness; TikTok its pixels only; Search Console the site, seven final days of search totals and its sitemaps; Adjust the event catalog and seven days of installs and events. A failed, partial or foreign read leaves its layer unknown; an actor, login or access change refuses the ledger. No test event, Conversions API call or validate request is sent. Supplied traces stay in the browser. Bounded to 96 requests, 8 MiB and 150 seconds; nothing is saved and delivery, deduplication, consent and attribution stay unverified. Profiles never grant account access. check with live:false makes no provider request and saves nothing; with live:true it reads the provider account and saves the shared account-read evidence and the account metadata. It never writes to a provider, and unsupported/missing evidence stays explicit. catalog_source also supports requirements:{source_kind:inventory,price_field:price|regular_price|sale_price,absent_source_policy:retain}. This separate read-only mode collects all published top-level products and every reported native variable-parent variation, using status:any for children. It requires two complete scans with identical supported native observations and currency reads before, between and after. Limits are 1,000 combined products/variations per scan, 100 rows per page, 64 total GET requests, 8 MiB and 60 seconds. Exact pagination totals, ascending canonical IDs, disjoint identities and complete parent-reported variation membership are required; incomplete, changed or unsupported responses are refused without a partial inventory. Native price strings, omitted/null values, statuses, tax/digital flags, parent IDs and reported group IDs are retained without conversion or image substitution. No import, review, draft, snapshot, deletion or provider change occurs. Reported grouped memberships are not independently verified; unpublished-parent inventory, a point-in-time snapshot, destination eligibility and live acceptance are unqualified. Never mix inventory with product_ids, parent_product_id or variation_ids. catalog_sources lists only current configured WooCommerce source connection metadata without credentials or network calls. catalog_source reads 1–50 explicit published WooCommerce products with requirements:{product_ids:[canonical decimal strings],price_field}, or selected children of one published variable parent with requirements:{source_kind:variations,parent_product_id:canonical decimal string,variation_ids:[1–50 canonical decimal strings],price_field} (price_field: price, regular_price or sale_price). Never mix the two selectors. Choose the exact commerce_native_action account_id/connection_id. The existing encrypted connection must bind one store account, an exact public HTTPS origin on 443, wc/v3 and recorded read or read_write API-key permission. Four fixed authenticated GETs repeat standalone products and bracket native store currency; six GETs additionally repeat the exact parent and selected variation membership. Current actor/login/scope/origin fences, one 30-second deadline and a combined 4 MiB bound apply throughout; variations collect at most 102 parent/child rows. Basic credentials stay in headers on fresh sockets to checked public addresses; redirects, caller URLs, incomplete counts/IDs/membership and changed evidence are refused. Only supported selected fields and blockers return; no snapshot or mutation is saved. Native variation names are absent: name:null and requires_title_review:true accompany a bounded suggestion, literal attributes and verified parent identity. Explicit eligible child selections need an operator-reviewed title; their exact child SKU and price remain unchanged and the shown native parent SKU becomes the explicitly reviewed Meta retailer_product_group_id. Do not translate native values or represent the suggested title as a native child name. Provider-reported variation images do not prove custom-child origin; no parent image is substituted. Meta catalog_preview/catalog_plan also accept an explicit retailer_product_group_id under the existing qualified native field contract. Tax, digital delivery, full inventory reconciliation and live acceptance remain unqualified. X retains all ten explicit CSV fields and refuses Meta group intent. catalog_preview locally validates 1–50 selected Meta, X or Snapchat (compare-only) products, or a CSV source projected with a saved column mapping (catalog_mapping, save_catalog_mapping), with exact decimal source prices and explicit allow_upsert. X requires all mapped source fields, including HTTPS product links, native availability/condition, brand and plain text description; the existing single-product contract updates matching IDs, so allow_upsert must be true. X early-access entitlement and live acceptance are not established by a preview or saved draft. Each X source SKU maps to one unchanged native JSON step with its own review and receipt. catalog_compare takes the same gateway/account_id/connection_id/catalog_id/products/allow_upsert. Meta reads the supplied retailer IDs through its qualified contract; native numeric filters establish price equality. X scans at most 1,000 listed products twice with bracketed current FULL-promotable-user catalog ownership, sharing scans across 1–50 supplied SKUs and preserving exact supported decimal prices. Both return new/changed/matching/unknown states, blockers, exact source_hash and eligible review_retailer_ids. X blocks grouped/possibly hidden variants and requires explicit upsert; optional native attributes omitted from an update remain uncertain. X bounds are 180 attempts including retries, 5,000 collected rows, 4 MiB and 60 seconds; Meta retains 180 attempts, 150 rows, 2 MiB and 60 seconds. Partial/changed evidence is refused. This is read-only sequential evidence, not a point-in-time or complete variant inventory. Current actor/account/login authority is rechecked throughout; comparison creates no review, draft or mutation. catalog_plan saves the supplied products as an unapproved draft with their lineage (51–500 source products as plans of at most 50); execution still needs fresh native reviews, explicit write authority and per-item read-back. Products absent from the import are never deleted. The owner turns personal-data writes (customer lists) on or off for one ad account with enable_personal_data and disable_personal_data.',
  [
    'help',
    'dashboard',
    'operations',
    'report_run',
    'resume_report_run',
    'report_schedule',
    'preview_report_schedule',
    'save_report_schedule',
    'report_queries',
    'report_query',
    'preview_report_query',
    'save_report_query',
    'preview_report_query_move',
    'move_report_query',
    'report_bindings',
    'report_binding',
    'preview_report_binding',
    'save_report_binding',
    'preview_report_binding_state',
    'save_report_binding_state',
    'contracts',
    'capabilities',
    'program_check',
    'check',
    'profiles',
    'save_profile',
    'preview_profile',
    ...monitorActions,
    'portfolio',
    'portfolio_reconcile',
    'measurement_audit',
    'preview_consent_plan',
    'create_consent_plan',
    'measurement_events',
    'measurement_event_identity',
    'measurement_conversions',
    'measurement_google_goals',
    'measurement_ga4_config',
    'measurement_ledger',
    'change_history',
    'search_overlap',
    'catalog_preview',
    'catalog_source',
    'catalog_sources',
    'catalog_compare',
    'catalog_plan',
    'catalog_mapping',
    'save_catalog_mapping',
    'preview_catalog_removal',
    'create_catalog_removal',
    'delete_profile',
    'briefs',
    'brief',
    'save_brief',
    'delete_brief',
    'history',
    'health',
    'support_bundle',
    'save_spend_policy',
    'save_retention',
    'save_plan_policy',
    'pause_writes',
    'resume_writes',
    'enable_personal_data',
    'disable_personal_data',
    'save_ga4_test_property',
  ],
  {
    topic: {type: 'string', maxLength: 300},
    gateway: field.id,
    workflow_id: field.id,
    reason: {type: 'string', maxLength: 500},
    search: {type: 'string', maxLength: 200},
    offset: {type: 'integer', minimum: 0},
    policy: field.object,
    // Per-action argument notes live in src/first-party-contracts.ts, served by amcp_tool_help (MCP-07).
    expected_revision: {type: 'integer', minimum: 0},
    scope: {type: 'string', enum: ['workspace']},
    // all (the default), advertising or provider_jobs (RPT-06); pause_writes validates it, and the listing had no room
    // (95 KiB, until the owner raised the limit to 256 KiB on 2026-11-23).
    pause_scope: {type: 'string'},
    days: field.integer,
    archived_campaign_plans_days: {type: 'integer', minimum: 0, maximum: 3650},
    require_distinct_approver: field.bool,
    connection_id: field.id,
    account_id: field.id,
    // check only: its argument note is in src/first-party-contracts.ts (amcp_tool_help), not in tools/list.
    account_ids: {type: 'array', items: {type: 'string', maxLength: 200}, minItems: 1, maxItems: 20, uniqueItems: true},
    requirements: field.object,
    live: field.bool,
    id: field.id,
    profile: field.object,
    profile_id: field.id,
    brief: field.object,
    preview: field.object,
    preview_id: field.id,
    preview_hash: field.id,
    monitor: field.object,
    kind: {type: 'string', enum: ['all', ...operationKinds]},
    state: {type: 'string', maxLength: 40},
    snooze_hours: {type: 'integer', minimum: 1, maximum: 168},
    enabled: field.bool,
    subscription_version: field.id,
    notification_id: field.id,
    notification_version: field.id,
    report_id: field.id,
    active: field.bool,
    cursor: field.id,
    catalog_id: field.id,
    products: {type: 'array', items: {type: 'object'}, minItems: 1, maxItems: 50},
    retailer_ids: {
      type: 'array',
      items: {type: 'string', maxLength: 100},
      minItems: 1,
      maxItems: 50,
      uniqueItems: true,
    },
    allow_upsert: field.bool,
    inspect_other_listed_products: field.bool,
    absent_source_policy: {type: 'string', enum: ['retain']},
    // COM-02 B: the typed number of products that saves a listed removal. The other catalog inputs (a listed selection,
    // a retirement, a mapped CSV source, a comparison for lineage) ride in requirements (src/catalog-requirements.ts).
    confirmed_count: field.integer,
    name: {type: 'string', maxLength: 100},
    revision: field.integer,
    confirmed: field.bool,
    run_version: field.id,
    schedule_version: field.id,
    schedule: field.object,
    query_version: field.id,
    target_binding_id: field.id,
    rebinding_version: field.id,
    query: field.object,
    binding_version: field.id,
    binding: field.object,
    spreadsheet_id: {type: 'string', maxLength: 200},
    limit: {type: 'integer', minimum: 1, maximum: 100},
    view: {type: 'string', enum: ['summary', 'graph', 'full']},
    sections: {type: 'array', items: {type: 'string', enum: dashboardSections}, minItems: 1, uniqueItems: true},
    max_entities: {type: 'integer', minimum: 1, maximum: 1000},
    max_pages: {type: 'integer', minimum: 1, maximum: 25},
  },
);
// The account read and its metadata readers live in src/account-metadata.ts, which reporting imports without importing
// this module (ARC-04 stage B: workspace.ts left the reporting import cycle).
export {accountPlan, accountMetadata, accountCurrency, accountTimezone};
/**
 * Readiness reads one exact account. Measurement and Apple accounts have their own exact reads (CON-03): a GA4
 * property, a Tag Manager account, a Search Console site, an Apple Ads ad account and a Business Profile location or
 * account (CON-06), each its provider adapter's readiness read (ARC-01 phase B). Plan preflight and reports keep
 * `accountPlan`, so their reads are unchanged.
 */
export const readinessPlan = (gateway: string, id: string): CompiledRequest => {
  const read = (path: string, origin: string): CompiledRequest => ({
    gateway,
    accountId: id,
    action: 'AMCP_READINESS',
    method: 'GET',
    path,
    origin,
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    evidence: 'AMCP exact account readiness read',
    warnings: [],
  });
  const readiness = providerHooks(gateway)?.accountRead?.readiness;
  if (!readiness) return accountPlan(gateway, id);
  // Business Profile reads a location (locations/{id}) or a business account; any other ID is no resource it reads.
  return (
    readiness(id, read) ??
    bad('Select a Business Profile location (locations/{id}) or business account.', 'ASSET_ID_INVALID')
  );
};
/**
 * A readiness read of a provider's own (`readinessPlan`) must name exactly the selected resource, as its adapter
 * decides; every other account read gets the state checks of a write's before-state.
 */
function validateReadinessRead(p: CompiledRequest, r: {status: number; headers: JsonObject; data: unknown}) {
  const names = providerHooks(p.gateway)?.accountRead?.names;
  if (!names) return validateState(p, r as never);
  const d = (r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {}) as JsonObject,
    id = p.accountId!,
    exact = names(id, d);
  if (r.status !== 200 || !exact)
    throw new MirrorError('STATE_TARGET_MISMATCH', 'Provider state did not identify the exact selected resource.');
}
export class WorkspaceService {
  constructor(
    private store: Store,
    private registry: Registry,
    private transport: NativeTransport,
    private credentials: CredentialProvider,
    private call: ToolCall,
    private allowWrites: boolean,
    private wooCommerceRequest?: WooCommerceRequest,
    private flags: EnhancementFlags = {},
    /** The deployment owner's provider-job switch (AMCP_PROVIDER_JOBS, RPT-06), shown in capabilities and health. */
    private providerJobs = false,
    /**
     * The steps of a saved template that apply a secret-like value, such as a creator's authorization code, by step ID (r25-m4b-smartpush, the
     * lead's review S1-2, src/campaign-spend-effects.ts `stepsWithSecretFields`): a template is stored as it is written, so it is refused. It
     * comes AFTER `providerJobs`; absent, no step is refused for it.
     */
    private secretSteps?: (steps: JsonObject[]) => string[],
  ) {}
  /** A saved template is a list of plan steps; none may apply a secret-like value (S1-2). */
  private noSecretTemplates(profile: JsonObject): void {
    for (const steps of Object.values(profile.templates ?? {}))
      noSecretSteps(this.secretSteps?.(steps as JsonObject[]) ?? []);
  }
  /** What a provider's action of this tool is given (src/provider-workflows.ts). */
  private workspaceContext(): WorkspaceContext {
    const {store, registry, transport, credentials, call, wooCommerceRequest} = this;
    return {store, registry, transport, credentials, call, wooCommerceRequest};
  }
  async handle(input: JsonObject, actor: Actor): Promise<JsonObject> {
    validate(input, Object.keys(workspaceTool.inputSchema.properties));
    this.store.assertActorActive(actor);
    if (input.action !== 'portfolio_reconcile' && (input.max_entities !== undefined || input.max_pages !== undefined))
      bad('Inventory collection limits apply only to portfolio_reconcile.');
    if (
      input.action !== 'catalog_compare' &&
      (input.inspect_other_listed_products !== undefined || input.absent_source_policy !== undefined)
    )
      bad('Catalog inventory inspection arguments apply only to catalog_compare.', 'INVALID_CATALOG_INVENTORY');
    if (input.action !== 'create_catalog_removal' && input.confirmed_count !== undefined)
      bad('The typed product count applies to create_catalog_removal only.', 'INVALID_CATALOG_INVENTORY');
    // Catalog inputs in requirements (COM-02, COM-03): each catalog action reads only its own keys.
    assertCatalogRequirements(input);
    if (
      (input.view !== undefined && !['capabilities', 'dashboard'].includes(input.action)) ||
      (input.sections !== undefined && input.action !== 'dashboard')
    )
      bad('view applies to capabilities and dashboard; sections to dashboard only.', 'INVALID_ARGUMENT', {
        field: input.sections !== undefined && input.action !== 'dashboard' ? 'sections' : 'view',
      });
    if (input.account_ids !== undefined && input.action !== 'check')
      bad('account_ids applies to check only.', 'INVALID_ARGUMENT', {field: 'account_ids'});
    if (input.action === 'operations') return operationsPage(this.store, actor, input, this.allowWrites);
    if (input.action === 'report_run') return reportRunStatus(this.store, actor, input.id);
    if (input.action === 'resume_report_run') return resumeReportRun(this.store, actor, input);
    if (input.action === 'report_schedule') return workbookSchedule(this.store, actor, input.id);
    if (input.action === 'preview_report_schedule') return previewWorkbookSchedule(this.store, actor, input);
    if (input.action === 'save_report_schedule') return saveWorkbookSchedule(this.store, actor, input);
    if (input.action === 'report_queries') return reportQueryPage(this.store, actor, input);
    if (input.action === 'report_query') return workbookQuery(this.store, actor, input.id);
    if (input.action === 'preview_report_query') return previewWorkbookQuery(this.store, actor, input);
    if (input.action === 'save_report_query') return saveWorkbookQuery(this.store, actor, input);
    if (input.action === 'report_bindings') return workbookBindingPage(this.store, actor, input);
    if (input.action === 'report_binding') return workbookBinding(this.store, actor, input.id);
    if (input.action === 'preview_report_binding') return previewWorkbookBinding(this.store, actor, input);
    if (input.action === 'save_report_binding') return saveWorkbookBinding(this.store, actor, input);
    if (input.action === 'preview_report_binding_state') return previewWorkbookBindingState(this.store, actor, input);
    if (input.action === 'save_report_binding_state') return saveWorkbookBindingState(this.store, actor, input);
    if (input.action === 'preview_report_query_move') return previewWorkbookQueryMove(this.store, actor, input);
    if (input.action === 'move_report_query') return moveWorkbookQuery(this.store, actor, input);
    if (monitorActions.includes(input.action)) return monitorOperation(this.store, actor, input);
    if (input.action === 'portfolio')
      return {record_kind: 'portfolio', ...(await portfolioPage(this.store, this.call, actor, input))};
    if (input.action === 'portfolio_reconcile') return reconcilePortfolio(this.store, this.call, actor, input);
    // The providers' actions (ARC-01 phase B): Tag Manager's, GA4's, Google Ads', LinkedIn's, WooCommerce's and X's,
    // and the measurement ledger, from the provider workflows registry (src/provider-workflows.ts). No branch of this
    // method names them and none before or after their branches acted on another action, so each keeps its checks.
    const providerAction = workspaceAction(input.action);
    if (providerAction) return providerAction(this.workspaceContext(), actor, input);
    // PRV-07: a bounded read-only diagnosis read; nothing is saved.
    if (input.action === 'search_overlap') return searchOverlap(this.store, this.call, actor, input);
    // COM-03: a CSV source is projected on the server into supplied products; its lineage follows them.
    let catalogSource: CatalogSource | undefined;
    if (['catalog_preview', 'catalog_compare', 'catalog_plan'].includes(input.action)) {
      const resolved = resolveCatalogSource(this.store, actor, input);
      if (resolved) {
        input = {...input, products: resolved.products};
        catalogSource = resolved.source;
      }
    }
    if (input.action === 'catalog_mapping') return catalogMapping(this.store, actor, input);
    if (input.action === 'save_catalog_mapping') return saveCatalogMapping(this.store, actor, input);
    if (input.action === 'catalog_compare') {
      const out = await catalogComparison(this.store, this.registry, this.transport, this.credentials, actor, input);
      // A comparison a plan can be saved from returns a sealed reference for that plan's lineage (COM-03).
      if (out.record_kind !== 'catalog_comparison' || catalogDestination(input.gateway)?.writes !== 'reviewed_steps')
        return out;
      const source = catalogSource ?? suppliedCatalogSource(input.products),
        token = comparisonLineageToken(this.store, actor, out, input.products, source);
      return {...out, ...(catalogSource ? {source: catalogSource} : {}), ...(token ? {lineage_token: token} : {})};
    }
    if (['catalog_preview', 'catalog_plan'].includes(input.action)) {
      const connection = this.store.resolveConnection(actor, input.gateway, input.account_id, input.connection_id);
      const source = catalogSource ?? suppliedCatalogSource(Array.isArray(input.products) ? input.products : []),
        chunked = catalogRequirement(input, 'chunked');
      if (chunked !== undefined && chunked !== true)
        bad(
          'Set chunked to true to save more than 50 source products as one plan group.',
          'INVALID_CATALOG_PLAN_GROUP',
        );
      if (chunked) return this.catalogPlanGroup(actor, input, connection.id, source);
      const result = catalogIngestion(input);
      // A CSV source returns the rows it supplied, so they can be reviewed exactly (COM-03).
      if (input.action === 'catalog_preview')
        return catalogSource ? {...result, supplied_products: input.products, source: catalogSource} : result;
      // COM-02 D: a feed-only destination (Snapchat) is compared read-only; nothing can be saved for it.
      if (catalogDestination(input.gateway)?.writes === 'feed_only')
        bad(
          'Snapchat products change only through product feeds. Compare them, then fix differences in the feed; no draft is saved.',
          'CATALOG_FEED_ONLY',
        );
      // The plan's lineage (COM-03): its source, mapping and, when named, the comparison its products come from.
      const lineage = catalogPlanLineage(
        source,
        input.products,
        comparisonLineage(this.store, actor, input, input.products, connection.id),
      );
      // A retirement only updates existing products: the plan names them, and each native review refuses a missing one.
      const retire = catalogRetirement(input),
        created = await this.createCatalogPlan(
          actor,
          result.plan,
          lineage,
          retire ? {retailer_ids: [...retire.ids], availability: retire.availability} : undefined,
        );
      return {...created, source_hash: result.source_hash, item_count: result.item_count, lineage};
    }
    if (input.action === 'contracts') return actionContractPage(this.registry, input);
    if (input.action === 'capabilities')
      return capabilities(
        this.store,
        this.registry,
        actor,
        this.allowWrites,
        input,
        this.flags.capabilitiesGraphDefault === true,
        this.providerJobs,
      );
    if (input.action === 'program_check')
      return checkConditionalProgram(this.store, this.registry, this.call, actor, input);
    if (
      [
        'health',
        'support_bundle',
        'save_spend_policy',
        'save_retention',
        'save_plan_policy',
        'pause_writes',
        'resume_writes',
        'enable_personal_data',
        'disable_personal_data',
        'save_ga4_test_property',
      ].includes(input.action)
    )
      return ownerOperations(this.store, input, actor, {
        withheldWorkbookRecords,
        legacyAliasUsage: (store, a) => cachedLegacyAliasUsage(store, a),
        providerJobs: {allowWrites: this.allowWrites, enabled: this.providerJobs},
        providerAccess: (store, a) => providerAccessPanel(store, a),
      });
    if (input.action === 'profiles')
      return {
        // By name, so a client is found in the same place on every load (CMP-06); IDs are random.
        profiles: this.store
          .documents(actor.tenantId, 'client_profile')
          // Access limited to a client access set (SEC-08) sees only the profiles whose bindings stay within it.
          .filter(p => profileWithinAccess(this.store, actor, p))
          .sort(
            (a, b) =>
              String(a.name ?? '').localeCompare(String(b.name ?? ''), 'en', {sensitivity: 'base'}) ||
              String(a.id).localeCompare(String(b.id)),
          ),
        recipe_defaults: recipeDefaultFields(),
        recipe_declarations: recipeDeclarationFields(),
      };
    if (input.action === 'preview_profile') {
      const profile = input.id ? visibleProfile(this.store, actor, input.id) : input.profile;
      if (!obj(profile)) bad('Supply a saved profile or a draft profile.');
      // A draft is checked for declarations like a profile that is saved; a stored one is previewed as it is, and its declarations are never applied.
      validatePlaybook(profile, input.id ? undefined : recipeDeclarations);
      this.noSecretTemplates(profile);
      for (const binding of profile.bindings ?? [])
        this.store.resolveConnection(actor, binding.gateway, binding.account_id, binding.connection_id);
      return previewPlaybook(profile, input.preview ?? {}, recipeDeclarations);
    }
    if (input.action === 'save_profile') {
      writer(this.store, actor);
      if (input.confirmed !== true || !obj(input.profile)) bad('Review and confirm the client profile.');
      const p = input.profile;
      validatePlaybook(p, recipeDeclarations);
      noSecrets(p);
      this.noSecretTemplates(p);
      validate(p, [
        'name',
        'naming',
        'utm',
        'bindings',
        'defaults',
        'templates',
        'variables',
        'conversion_mappings',
        'report_presentation',
      ]);
      if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100)
        bad('Profile name must be 1–100 characters.');
      if (p.bindings !== undefined && !Array.isArray(p.bindings)) bad('bindings must be an array.');
      for (const binding of p.bindings ?? []) {
        validate(binding, ['gateway', 'connection_id', 'account_id']);
        this.store.resolveConnection(actor, binding.gateway, binding.account_id, binding.connection_id);
      }
      const id = input.id ?? randomUUID();
      if (input.id !== undefined && optional(this.store, actor.tenantId, 'client_profile', id))
        visibleProfile(this.store, actor, id);
      if (
        !optional(this.store, actor.tenantId, 'client_profile', id) &&
        this.store.documents(actor.tenantId, 'client_profile').length >= 100
      )
        bad('Limit reached: 100 client profiles.');
      const record = update(
        this.store,
        actor,
        'client_profile',
        id,
        {...p, approved_by: actor.userId, approved_at: Date.now()},
        input.revision,
      );
      audit(this.store, actor, 'client_profile_saved', {id, revision: record.revision});
      return record;
    }
    if (input.action === 'delete_profile') {
      writer(this.store, actor);
      if (input.confirmed !== true) bad('Confirm profile deletion.');
      const p = visibleProfile(this.store, actor, input.id);
      if (input.revision !== p.revision) bad('Reload the current profile.', 'REVISION_CONFLICT');
      this.store.db
        .prepare('DELETE FROM documents WHERE tenant_id=? AND kind=? AND id=? AND revision=?')
        .run(actor.tenantId, 'client_profile', p.id, p.revision);
      audit(this.store, actor, 'client_profile_deleted', {id: p.id});
      return {deleted: true};
    }
    if (['briefs', 'brief', 'save_brief', 'delete_brief'].includes(input.action))
      return clientBriefs(this.store, actor, input);
    if (input.action === 'history') return auditHistoryPage(this.store, actor, input);
    if (input.action === 'dashboard') return dashboard(this.store, actor, this.allowWrites, input);
    if (input.action !== 'check') bad('Unknown workspace action.');
    if (input.account_ids !== undefined) return this.checkAccounts(input, actor);
    return this.checkAccount(input, actor);
  }
  /** Saves one catalog plan with its lineage, through a binding only this workflow can name (COM-03). */
  private async createCatalogPlan(
    actor: Actor,
    plan: JsonObject,
    lineage: JsonObject,
    retirement?: {retailer_ids: string[]; availability: string},
  ): Promise<JsonObject> {
    const binding = storeCatalogLineageBinding(this.store, actor, plan, lineage, retirement);
    try {
      const created = await this.call('amcp_campaign', {...plan, catalog_binding: binding}, actor);
      if (!created.success)
        bad(created.error?.message ?? 'Catalog plan failed.', created.error?.code ?? 'CATALOG_PLAN_FAILED');
      return created.data;
    } finally {
      releaseCatalogLineageBinding(this.store, actor, binding);
    }
  }
  /**
   * catalog_plan with requirements.chunked (COM-03 Phase 3): 51–500 source products saved as consecutive unapproved
   * plans of at most 50, one lineage group. Every part is validated before the first is saved; each part has its own
   * creation key, so repeating the same request after a failure saves only the parts that are missing. catalog_preview
   * with the same requirements validates the same parts and saves nothing.
   */
  private async catalogPlanGroup(
    actor: Actor,
    input: JsonObject,
    connectionId: string,
    source: CatalogSource,
  ): Promise<JsonObject> {
    const save = input.action === 'catalog_plan';
    if (save) writer(this.store, actor);
    if (catalogDestination(input.gateway)?.writes === 'feed_only')
      bad(
        'Snapchat products change only through product feeds. Compare them, then fix differences in the feed; no draft is saved.',
        'CATALOG_FEED_ONLY',
      );
    if (catalogRequirement(input, 'comparison_token') !== undefined)
      bad(
        'A plan group is saved from its whole source. To name a comparison, compare and save at most 50 products as one plan.',
        'INVALID_CATALOG_PLAN_GROUP',
      );
    if (['retire_retailer_ids', 'retire_availability'].some(k => catalogRequirement(input, k) !== undefined))
      bad('Retire at most 50 products, in one plan.', 'INVALID_CATALOG_PLAN_GROUP');
    const products: JsonObject[] = Array.isArray(input.products) ? input.products : [];
    if (products.length <= catalogPlanLimits.plan || products.length > catalogPlanLimits.group)
      bad('A plan group takes 51–500 source products; save 1–50 products as one plan.', 'CATALOG_IMPORT_LIMIT');
    const ids = products.map(p => p?.retailer_id);
    if (new Set(ids).size !== ids.length) bad('Product retailer IDs must be unique.', 'INVALID_CATALOG_PLAN_GROUP');
    const parts = catalogPlanParts(products),
      group_source_hash = fingerprint(products),
      lineage_group_id = fingerprint({
        kind: 'catalog-plan-group',
        tenant: actor.tenantId,
        user: actor.userId,
        scope: {
          gateway: input.gateway,
          account_id: input.account_id,
          connection_id: connectionId,
          catalog_id: input.catalog_id,
        },
        group_source_hash,
        source,
        allow_upsert: input.allow_upsert ?? null,
        name: input.name ?? null,
      });
    // Every part is projected and validated first, so a refused product saves no part.
    const projections = parts.map(part => catalogIngestion({...input, products: part}));
    if (!save)
      return {
        record_kind: 'catalog_plan_group_preview',
        lineage_group_id,
        parts: parts.length,
        item_count: products.length,
        group_source_hash,
        source,
        // One row per part (its products are listed by the plan it becomes), in source order.
        plans: parts.map((part, i) => ({
          part: i + 1,
          item_count: part.length,
          source_hash: projections[i]!.source_hash,
          first_retailer_id: part[0]!.retailer_id,
          last_retailer_id: part.at(-1)!.retailer_id,
        })),
        ...((projections[0] as JsonObject).destination_limitations
          ? {destination_limitations: (projections[0] as JsonObject).destination_limitations}
          : {}),
        network_requests: 0,
        provider_mutations: 0,
        destructive_deletions: 0,
        meaning:
          'Preview validates every product of this plan group from the source; nothing is saved. Saving creates one unapproved plan of at most 50 products per part, and every product still needs its own native review and read-back. Products the source lacks are never deleted.',
      };
    const keys = parts.map((_, i) => 'catalog-plan-' + lineage_group_id.slice(0, 40) + '-' + (i + 1)),
      saved = keys.filter(key =>
        optional(
          this.store,
          actor.tenantId,
          'campaign_run',
          fingerprint({kind: 'campaign-create', tenant: actor.tenantId, user: actor.userId, key}),
        ),
      ).length;
    // An upfront check, so a group that cannot fit saves no part. It is not a reservation: each part's campaign create
    // checks the plan limit again when it saves (assertPlanRoom), so two groups saved at once can stop part-way with
    // PLAN_LIMIT_REACHED (the error names the saved parts, and the same request saves the missing ones later).
    if (activePlanCount(this.store, actor.tenantId) + parts.length - saved > activePlanLimit)
      bad(
        'Limit reached: 500 campaign plans that are not archived. Archive complete, cancelled or superseded plans to make room; archived plans stay readable.',
        'PLAN_LIMIT_REACHED',
        {limit: activePlanLimit, parts: parts.length},
      );
    const plans: JsonObject[] = [];
    for (let i = 0; i < parts.length; i++) {
      const suffix = ' (part ' + (i + 1) + ' of ' + parts.length + ')',
        base = projections[i]!.plan,
        plan = {...base, name: String(base.name).slice(0, 100 - suffix.length) + suffix, idempotency_key: keys[i]},
        lineage = catalogPlanLineage(source, parts[i]!, null, {
          id: lineage_group_id,
          part: i + 1,
          parts: parts.length,
          group_source_hash,
          group_products: products.length,
        });
      let created: JsonObject;
      try {
        created = await this.createCatalogPlan(actor, plan, lineage);
      } catch (error) {
        // The parts saved so far stay; the same request saves only the missing ones.
        if (error instanceof MirrorError)
          throw new MirrorError(
            error.code,
            error.message,
            {...error.details, lineage_group_id, failed_part: i + 1, saved_plans: plans.map(p => p.id)},
            error.status,
          );
        throw error;
      }
      plans.push({
        id: created.id,
        part: i + 1,
        item_count: parts[i]!.length,
        source_hash: lineage.source_hash,
        website_path: '/campaigns?id=' + encodeURIComponent(created.id),
      });
    }
    return {
      record_kind: 'catalog_plan_group',
      lineage_group_id,
      parts: parts.length,
      item_count: products.length,
      group_source_hash,
      source,
      plans,
      provider_mutations: 0,
      approval_required: true,
      meaning:
        'Each part is its own unapproved plan of at most 50 products in one lineage group; approve and run each part separately. Every product still needs its own native review and read-back, and products the source lacks are never deleted.',
    };
  }
  /**
   * check for up to 20 accounts of one connection (CON-05): each account gets exactly the single-account check and its
   * per-account readiness record, four at a time. Every account must be granted to the connection before any is read.
   */
  private async checkAccounts(input: JsonObject, actor: Actor): Promise<JsonObject> {
    const ids = input.account_ids;
    if (input.account_id !== undefined)
      bad('Use account_id for one account or account_ids for up to 20, not both.', 'INVALID_ARGUMENT', {
        field: 'account_ids',
      });
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 20 ||
      ids.some(id => typeof id !== 'string' || !id || id.length > 200) ||
      new Set(ids).size !== ids.length
    )
      bad('account_ids takes 1 to 20 distinct account IDs.', 'INVALID_ARGUMENT', {field: 'account_ids'});
    const c = this.store.connectionsFor(actor).find(c => c.id === input.connection_id);
    if (!c) bad('Select a connection in this workspace.', 'CONNECTION_NOT_FOUND');
    const foreign = (ids as string[]).filter(id => !c.accounts.includes(id));
    if (foreign.length)
      bad('Select accounts granted to this connection.', 'ACCOUNT_FORBIDDEN', {account_ids: foreign.slice(0, 20)});
    const results: JsonObject[] = [],
      concurrency = Math.min(4, ids.length);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const index = next++;
        results[index] = await this.checkAccount({...input, account_ids: undefined, account_id: ids[index]}, actor);
      }
    };
    await Promise.all(Array.from({length: concurrency}, worker));
    return {
      record_kind: 'readiness_batch',
      connection_id: c.id,
      checked: results.length,
      concurrency,
      ready: results.filter(r => r.ready === true).length,
      results,
      coverage: 'Exact requested prerequisites only, one result per account; unknown checks are not passed.',
    };
  }
  private async checkAccount(input: JsonObject, actor: Actor): Promise<JsonObject> {
    const c = this.store.connectionsFor(actor).find(c => c.id === input.connection_id);
    if (!c) bad('Select a connection in this workspace.', 'CONNECTION_NOT_FOUND');
    const id = input.account_id;
    if (typeof id !== 'string' || !c.accounts.includes(id))
      bad('Select an account granted to this connection.', 'ACCOUNT_FORBIDDEN');
    const requirements = input.requirements ?? {};
    // The owner's agent asked for requirements.currency (Snapchat S11): name where the currency is checked instead.
    if (obj(requirements) && Object.hasOwn(requirements, 'currency'))
      bad(
        'requirements.currency is not a readiness requirement. With live: true, check returns the account currency and timezone under account; a campaign plan step pins it with expected_currency.',
        'INVALID_ARGUMENT',
        {field: 'requirements.currency'},
      );
    validate(requirements, ['write', 'assets', 'destination_url', 'native_request'], 262144, 'requirements key');
    const checks: JsonObject[] = [];
    const check = (key: string, pass: boolean | null, message: string, next?: string, extra?: JsonObject) =>
      checks.push(readinessCheck(key, pass, message, next, extra));
    check(
      'connection',
      c.enabled,
      c.enabled ? 'Connection enabled.' : 'Connection disabled.',
      'Select accounts for this login in Connections.',
    );
    if (requirements.write) {
      check(
        'deployment_writes',
        this.allowWrites,
        'Deployment write setting.',
        'Enable reviewed writes in server configuration.',
      );
      check(
        'writes_not_paused',
        !writesPausedFor(this.store, actor.tenantId, 'advertising'),
        'Owner write pause.',
        'An owner paused reviewed writes of this workspace; ask an owner to resume them.',
      );
      check('operator', actor.role !== 'reader', 'MCP operator role.', 'Use an operator connector.');
      check(
        'account_grant',
        c.writeAccounts?.includes(id) === true,
        'Account write grant.',
        'Grant this account write access in Connections.',
      );
      // The one grant registry decides; unknown is reported, never passed (CON-03).
      checks.push(recordedScopeCheck(this.store, c, 'write'));
    }
    if (requirements.destination_url !== undefined) {
      let valid = false;
      try {
        const u = new URL(requirements.destination_url);
        valid = ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password;
      } catch {}
      check('destination_url', valid, 'Destination URL syntax; reachability and tracking are not inferred.');
    }
    const assets = optional(this.store, actor.tenantId, 'website_assets', c.id);
    if (requirements.assets !== undefined && !Array.isArray(requirements.assets)) bad('assets must be an array.');
    for (const a of requirements.assets ?? []) {
      validate(a, ['kind', 'id']);
      const group = assets?.groups?.find((g: JsonObject) => g.kind === a.kind),
        found = group?.assets?.some((r: JsonObject) => r.id === a.id);
      check(
        'asset:' + a.kind + ':' + a.id,
        found && group?.checkedAt && Date.now() - group.checkedAt < 86400000
          ? true
          : group?.complete === true && !found
            ? false
            : null,
        found
          ? 'Found in inventory; only a sync within 24 hours passes this check.'
          : 'Required asset is not verified in this login.',
        'Sync ' + a.kind + ' and select an accessible asset.',
      );
    }
    if (requirements.native_request) {
      const r = await this.call(
        'amcp_write',
        {action: 'inspect', gateway: c.gateway, connection_id: c.id, arguments: requirements.native_request},
        actor,
      );
      check(
        'write_contract',
        r.success && r.data?.review_contract_supported === true,
        r.data?.error?.message ?? r.error?.message ?? 'Local execution contract checked.',
      );
    }
    let liveAccount: JsonObject | undefined, evidence: JsonObject | undefined;
    if (!readinessContract(c.gateway)) checks.push(notApplicableCheck());
    else if (input.live === true && c.enabled) {
      let read: JsonObject;
      try {
        const p = readinessPlan(c.gateway, id);
        new ScopeGuard(this.registry, this.store).authorize(p, c);
        const auth = await this.credentials.get(c);
        this.store.assertActorActive(actor);
        const current = this.store.resolveConnection(actor, c.gateway, id, c.id),
          access = nativeAuthority(this.store, this.registry, actor, p, current, auth),
          r = await this.transport.request(p, access(), auth, undefined, {beforeAttempt: access});
        access();
        validateReadinessRead(p, r);
        this.store.resolveConnection(actor, c.gateway, id, c.id);
        const currency = accountCurrency(c.gateway, r.data),
          timezone = accountTimezone(c.gateway, r.data),
          meta = accountMetadata(c.gateway, r.data);
        liveAccount = {currency, timezone};
        rememberAccountMetadata(this.store, actor.tenantId, c.id, id, {
          currency,
          timezone,
          name: accountName(meta),
          organization_id: meta.organization_id,
        });
        read = readinessCheck('provider_read', true, 'Provider confirmed the exact selected account.');
        evidence = sharedEvidence(c, id, read as never, liveAccount);
      } catch (e) {
        // Advice follows the cause: only an authentication failure asks for reauthorization (CON-03). The provider's own
        // diagnosis (PRV-01) rides along: its code, request ID and the layer that must act. The advice stays the
        // readiness next step, so the report-oriented next_action is left out.
        const failure = providerReadFailure(e);
        read = failure.check;
        if (e instanceof MirrorError && failure.check.reason !== 'not_applicable') {
          const {next_action: _report, ...diagnostic} = reportSourceError(e, {
            platform: Object.entries(reportPlatforms).find(([, p]) => p.gateway === c.gateway)?.[0] ?? c.gateway,
            account_id: id,
            connection_id: c.id,
          });
          read.diagnostic = diagnostic;
        }
        if (failure.shared) evidence = sharedEvidence(c, id, failure.check, undefined);
      }
      checks.push(read);
    } else check('provider_read', null, 'No provider request was made.');
    this.store.assertActorActive(actor);
    const result = {
      connection_id: c.id,
      account_id: id,
      connection_fingerprint: readinessBinding(c),
      checked_at: Date.now(),
      requirements,
      checks,
      ready: readinessContract(c.gateway) && checks.every(c => c.status === 'passed'),
      blocked: checks.some(c => c.status === 'blocked'),
      live_read: checks.some(c => c.key === 'provider_read' && c.status === 'passed'),
      readiness: readinessContract(c.gateway) ? 'account_read' : 'not_applicable',
      ...(liveAccount ? {account: liveAccount} : {}),
      // What the provider has said of its rate limit for this account, after the live read above, which carries its headers
      // (R2.5 M2, MT3; src/provider-usage.ts): ok with the worst usage seen, cooling with when it ends, unknown before it has
      // said any, and not exposed for a provider that sends none. It is local state: the check sends nothing for it.
      rate_limit: this.transport.rateLimit(c, id),
      coverage: 'Exact requested prerequisites only; unknown checks are not passed.',
      shared_evidence: evidence
        ? 'The exact account read was saved for every member; role, grants and permissions are evaluated for each viewer.'
        : 'Nothing was saved for other members.',
    };
    // Only the actor-independent account read is shared; a caller's role and requirements never are (CON-03).
    if (evidence) this.store.putDocument(actor.tenantId, 'readiness', readinessId(c.id, id), evidence);
    return result;
  }
}
