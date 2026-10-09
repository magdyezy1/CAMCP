import {operationKinds, operationStates} from './operation-types.js';
import {auditHistoryPage} from './audit-history.js';
import {measurementEvents} from './measurement-events.js';
import {createConsentPlan, previewConsentPlan} from './gtm-consent-plans.js';
import {measurementEventIdentity} from './measurement-event-identity.js';
import {linkedInConversionEvidence} from './linkedin-conversion-evidence.js';
import {nativeAuthority} from './native-authority.js';
import {linkedinVersion} from './linkedin-version.js';
import {ownerOperations, writePause} from './owner-operations.js';
import {workspaceCapabilities} from './capabilities.js';
import {actionContractPage} from './action-contracts.js';
import {capabilityGraph} from './capability-graph.js';
import {checkConditionalProgram} from './conditional-programs.js';
import {readinessBinding, recordedWriteScopes as writeScopes} from './capability-eligibility.js';
import {previewPlaybook, validatePlaybook} from './client-playbooks.js';
import {monitorActions, monitorOperation} from './report-monitors.js';
import {portfolioPage} from './portfolio.js';
import {reconcilePortfolio} from './portfolio-reconciliation.js';
import {catalogIngestion} from './catalog-ingestion.js';
import {wooCommerceSource, wooCommerceSources, type WooCommerceRequest} from './woocommerce-source.js';
import {wooCommerceInventory} from './woocommerce-inventory.js';
import {catalogComparison} from './catalog-comparison.js';
import {createCatalogRemoval, previewCatalogRemoval} from './x-catalog-removal.js';
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
import {reportSourceError} from './report-errors.js';
import {reportPlatforms} from './report-metrics.js';
import {Registry} from './catalog.js';
import {CredentialProvider} from './auth.js';
import {NativeTransport} from './transport.js';
import {ScopeGuard} from './scope.js';
import {validateState} from './write-state.js';
import {microsoftGateway, compileMicrosoft} from './microsoft-native.js';
import {
  audit,
  bad,
  field,
  fingerprint,
  noSecrets,
  obj,
  optional,
  read,
  tool,
  update,
  validate,
  writer,
  type ToolCall,
} from './workspace-core.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {googleAdsCustomers} from './google-version.js';
import {metaPrefix} from './meta-version.js';
import {accountName, rememberAccountMetadata} from './account-metadata.js';
export const workspaceTool = tool(
  'amcp_workspace',
  'Use this before planning a change, to see what an account is ready for and which actions have write contracts, and afterwards for its change history. portfolio_reconcile performs two complete bounded observations of one qualified inventory hierarchy. Use the same gateway/account_id/connection_id/requirements as portfolio, limit 1–100, max_entities 1–1000 (default 500) and max_pages 1–25 (default 20). It shares one 120-attempt, 120-second and 32 MiB collection allowance across both scans, retains original native IDs and fields, and returns observed added/missing/changed records, page references and independent content hashes. Incomplete, conflicting, repeated or changed-authority reads are refused; no partial result becomes a comparison. Matching observations do not prove an atomic snapshot. Missing rows do not establish deletion or authorize removal. It saves no plan, review, report or provider mutation. preview_catalog_removal takes the existing validated X source products with allow_upsert:true and 1–50 explicit retailer_ids. It repeatedly reads current individual products under the exact account/login/catalog, retaining a ten-minute session-bound preview. create_catalog_removal requires its original preview_id/preview_hash and confirmed:true, repeats current selected evidence and saves one unapproved single-product DELETE step per observed key. Saving deletes nothing. Unsent steps check original selected supported evidence before native prepare/execute; accepted effects retain original receipts and keys. Missing, grouped or unknown products are refused, no absent-source deletion is inferred and scheduled feeds may restore products. preview_consent_plan reads 1–10 explicitly selected Tag Manager tags in one exact account/container/workspace with requirements:{container_id,workspace_id,tag_ids,required_types}. Choose 1–20 distinct literal additional-consent types; existing required types and other tag configuration are preserved. Bracketed current native fingerprints, read authorization and bounded requests/bytes/time bind a 10-minute, session-bound metadata preview. create_consent_plan requires its original preview_id/preview_hash and confirmed:true, repeats current evidence and saves one unapproved native UPDATE_TAG plan. No provider update, version creation or publishing occurs in either action. Unsent steps check original tag configuration again before native prepare/execute; existing review/ownership/write-authority/receipt controls still apply. Built-in checks, runtime consent, event delivery and compliance remain unverified. Account readiness, capability evidence, approved client defaults/templates, and campaign change history. contracts lists every local action and its read/write/media/blocked contract classification without network calls; filter by gateway/search and paginate with offset/limit. history returns bounded safe event metadata, never raw requests or receipts. Use limit 1-100, search (event/action/request reference), gateway/account_id/connection_id and returned cursor. Each page rechecks current access; owners see workspace metadata, other users see currently accessible account events and their own unscoped events. Conflicting scope is withheld. Pagination retains its original sequence ceiling; follow continuation even after an empty page and refresh for newer events. This is retained AMCP history, not complete vendor history or a new integrity verification. operations is a local, metadata-only cross-engine feed: filter kind/state/search/account_id, page with next_cursor, and follow each read-only next_call to the original record. Workbook report runs use kind workbook_report; report_run reads a bounded, currently scoped status by id. resume_report_run requires id, the displayed run_version and confirmed:true, requeues only prepared/failed/cancelled read-only reports, and preserves their original run ID. report_schedule inspects a workbook schedule by id with three future clock times and schedule_version. preview_report_schedule validates proposed active:boolean and schedule:{name,timezone,schedule_kind,minute,hour,weekday?,day?} against id and schedule_version, returning changes and three proposed clock times without mutation. save_report_schedule accepts those fields with confirmed:true; query identity is unchanged and existing jobs continue. report_queries lists currently authorized query metadata with search/account_id/connection_id/spreadsheet_id and offset/limit; continue with next_offset, even after an empty page. report_query reads one bounded query by id and its query_version. preview_report_query reviews query:{name,query_config} with id and query_version; provider/account/connection stay fixed. save_report_query adds confirmed:true and saves that exact revision, pausing active schedules when the definition changes and creating one prepared, unsubmitted report. Existing jobs retain their configuration. report_bindings lists scoped local workbook associations with search/spreadsheet_id, state active (default)/retired/all and offset/limit; continue next_offset even after an empty page. report_binding inspects one binding by id, returns up to 100 linked queries and binding_version, and does not verify external spreadsheet access. preview_report_binding reviews binding:{spreadsheet_name} with id/binding_version; save_report_binding adds confirmed:true and renames only local metadata. The spreadsheet ID, stored preferences, queries, schedules and report runs remain unchanged. Current access to every linked query is required; empty bindings are creator/admin-only. preview_report_binding_state takes id/binding_version and active:boolean to review retirement (false) or restoration (true) of an empty association. save_report_binding_state adds confirmed:true. Any linked query or schedule, including orphaned schedules, blocks the change. Retirement preserves private settings and IDs, hides the association from active lists and blocks new use until explicit restoration. It does not delete reports or any external spreadsheet. preview_report_query_move takes the original query id/query_version and an existing target_binding_id, returns source/target identity, schedule impact and rebinding_version. move_report_query adds that rebinding_version and confirmed:true. It atomically moves the query and up to 100 linked schedules, pauses all of them for separate review/resume, preserves existing jobs and prepares one unsubmitted local run. Current access to both associations and every linked query is required; no external spreadsheet access is verified. Read-only native configurations require explicit scope and credentials belong in Connections. incidents/monitors support state/search/account filters and offset/limit; incident/monitor read one record. Acknowledge, snooze 1-168 hours, or resume an incident with its current revision; snooze never resolves evidence. monitor_notifications reads only your subscription and 20 recent deliveries for monitor id. set_monitor_notifications requires id, enabled:boolean, current subscription_version and confirmed:true; it opts only your verified personal email into future openings/reopenings/resolutions. Rule revisions, account security and access changes require new confirmation; no arbitrary recipient or historical backfill. retry_monitor_notification requires notification_id, current notification_version and confirmed:true, reusing the original recipient/payload/key within 24 hours; five automatic attempts and one recovery up to ten total. Provider acceptance is separate from inbox delivery. program_check inspects one exact conditional program returned by capabilities, with workflow_id, account_id and connection_id. Default live:false checks local contracts and recorded permissions without a provider request. Explicit live:true takes requirements:{forecast:forecastReaches|forecastImpressions|forecastLeads,request:{native Media Planning fields}} for program:linkedin_forecast, requirements:{request:{native Audience Insights fields}} for program:linkedin_audience_insights or requirements:{} for program:dv360_advertiser. One bounded native read retains exact projected evidence or a typed refusal, original scope/request/hash/time and a scope-preserving website handoff. It saves no readiness grant, workspace document, review or advertising change. Application approval, account access, OAuth scopes, objective eligibility and other program/write access stay separate. capabilities accepts exact workflow_id/account_id/connection_id filters, exposes dependency objects, native contracts and review lifecycle, and reports timestamped account-read evidence separately from unverified objective acceptance. portfolio reads bounded Google, Meta, LinkedIn, Snapchat, TikTok or X inventory pages with gateway/account_id/connection_id, limit 1–100, requirements and an optional returned cursor. Google entities: campaign, ad_group, ad (campaign_id and ad_group_id parents). Google uses account-scoped GAQL with exact returned account/parent/resource checks, a signed five-minute cursor bound to actor/login/permissions/hierarchy/page size, and up to 100 pages. Native int64 IDs and micros remain exact; unselected provider fields are omitted. Configured status is not serving evidence. Meta entities: campaign, adset, ad (campaign_id and adset_id parents); read each parent first with the same login, then follow its children within five minutes. Meta cursors bind account/login/entity/page size and expire after five minutes; native money stays unconverted and effective status stays separate. LinkedIn entities: campaign_group, campaign (campaign_group_id parent), creative (campaign_group_id and campaign_id parents). Read each parent in the same login first; observations and signed cursors last five minutes. LinkedIn cursor search covers documented group statuses and test/non-test entities, keeps exact decimal money with currency, and separates creative intended status from observed serving. Inventory is current, not a point-in-time snapshot. Snapchat entities: campaign, adsquad (campaign_id parent), ad (campaign_id and ad_squad_id parents). Use exact UUIDs and a page limit of 50–100. Read qualified portfolio parents first; parent observations and signed scope-bound cursors last five minutes. Snapchat keeps exact micros, current currency/timezone and separate configured status, review status and delivery codes. Only the opaque cursor is reused on a fixed scoped native route; adjacent overlaps, changed hierarchy and malformed continuation fail. TikTok entities: campaign, adgroup (campaign_id parent), ad (campaign_id and adgroup_id parents); 1–100 rows through standard v1.3 advertiser-scoped routes. Signed five-minute cursors bind actor/login/permissions/account/hierarchy/page size, cap traversal at 100 pages and reject changed totals or adjacent overlaps. Native amounts preserve JSON numbers or decimal strings and account-currency units with budget_mode; operation_status and secondary_status stay separate. This does not imply Smart+, GMV Max or specialized-route coverage. X entities: campaign, line_item (campaign_id parent), promoted_tweet (campaign_id and line_item_id parents). Account-scoped v12 GETs verify current parents and returned hierarchy. Native micros and post IDs stay exact; configured/effective status, servability and approval stay separate. Signed five-minute cursors bind actor/login/permissions/hierarchy/page size, cap traversal at 100 pages and reject repeated tokens or adjacent overlapping IDs. Pages exclude deleted/draft entities and do not include post content, scheduled posts, promoted accounts or media creatives. measurement_audit with an explicit container_id and workspace_id in requirements returns consent_evidence from the existing scoped workspace reads: each tag has a native additional-consent setting, bounded literal required types or unknown interpretation, with workspace identity and a digest of selected evidence. Not set, no additional consent and required additional consent are distinct; built-in checks, defaults, updates, runtime timing and event delivery remain unverified. This is workspace configuration, not a published-version or compliance verdict. measurement_events reads recent GA4 aggregate counts with gateway ga4_native_action, exact numeric property account_id, connection_id and requirements:{event_names:[1–20 exact names],minutes:1–30 (default 30),stream_id?:exact numeric ID}. This is one bounded realtime read, not an event sender; counts remain exact strings, absent rows have null counts, and partial/unknown evidence is refused. Deduplication, consent, attribution, test-event identity and overall health remain unverified; no snapshot is saved. measurement_event_identity inspects one exact synthetic GA4 test identifier using an existing registered event-scoped amcp_test_id custom dimension. Select gateway ga4_native_action, numeric property account_id, connection_id and requirements:{event_name,test_id:amcp-test- followed by 8–64 letters/digits/hyphens,date_from:YYYY-MM-DD,date_to:YYYY-MM-DD,stream_id?:numeric,expected_count?:1–1000 (default 1)}. Dates span at most seven property calendar days. Fresh exact-property metadata brackets one complete native runReport, bounded to three requests, 1000 rows, 2 MiB and 30 seconds with unchanged current authority. Exact counts compare against your declared expectation; absent rows remain null. No custom dimension is registered and no event is sent. This is matching aggregate report identity, not raw-event, deduplication, consent or attribution proof; restricted/sampled/truncated or changed evidence is refused. No snapshot is saved. The website link preselects the original scope without starting another read. measurement_conversions reads current LinkedIn conversion rule settings with gateway linkedin_native_action, exact account_id and connection_id. It collects at most 1000 rules across 25 bounded account-filtered native pages with current identity, account currency and authorization checks before/after. The projection retains exact IDs, native configured status/type/model, post-click/post-view days and exact configured value; omitted fields stay null. It keeps account/page source references but saves no snapshot and sends no events or writes. Campaign membership and historical attribution are not established. The website handoff preselects the same account without starting another read. Profiles never grant account access. check performs only provider reads; unsupported/missing evidence stays explicit. catalog_source also supports requirements:{source_kind:inventory,price_field:price|regular_price|sale_price,absent_source_policy:retain}. This separate read-only mode collects all published top-level products and every reported native variable-parent variation, using status:any for children. It requires two complete scans with identical supported native observations and currency reads before, between and after. Limits are 1,000 combined products/variations per scan, 100 rows per page, 64 total GET requests, 8 MiB and 60 seconds. Exact pagination totals, ascending canonical IDs, disjoint identities and complete parent-reported variation membership are required; incomplete, changed or unsupported responses are refused without a partial inventory. Native price strings, omitted/null values, statuses, tax/digital flags, parent IDs and reported group IDs are retained without conversion or image substitution. No import, review, draft, snapshot, deletion or provider change occurs. Reported grouped memberships are not independently verified; unpublished-parent inventory, a point-in-time snapshot, destination eligibility and live acceptance are unqualified. The website handoff preselects the original store and price without automatically reading it. Never mix inventory with product_ids, parent_product_id or variation_ids. catalog_sources lists only current configured WooCommerce source connection metadata without credentials or network calls. catalog_source reads 1–50 explicit published WooCommerce products with requirements:{product_ids:[canonical decimal strings],price_field:price|regular_price|sale_price}, or selected children of one published variable parent with requirements:{source_kind:variations,parent_product_id:canonical decimal string,variation_ids:[1–50 canonical decimal strings],price_field:price|regular_price|sale_price}. Never mix the two selectors. Choose the exact commerce_native_action account_id/connection_id. The existing encrypted connection must bind one store account, an exact public HTTPS origin on 443, wc/v3 and recorded read or read_write API-key permission. Four fixed authenticated GETs repeat standalone products and bracket native store currency; six GETs additionally repeat the exact parent and selected variation membership. Current actor/login/scope/origin fences, one 30-second deadline and a combined 4 MiB bound apply throughout; variations collect at most 102 parent/child rows. Basic credentials stay in headers on fresh sockets to checked public addresses; redirects, caller URLs, incomplete counts/IDs/membership and changed evidence are refused. Only supported selected fields and blockers return; no snapshot or mutation is saved. Native variation names are absent: name:null and requires_title_review:true accompany a bounded suggestion, literal attributes and verified parent identity. Explicit eligible child selections need an operator-reviewed title; their exact child SKU and price remain unchanged and the shown native parent SKU becomes the explicitly reviewed Meta retailer_product_group_id. Do not translate native values or represent the suggested title as a native child name. Provider-reported variation images do not prove custom-child origin; no parent image is substituted. Website handoffs preselect the original store, source kind, parent, IDs and price without an automatic read. Meta catalog_preview/catalog_plan also accept an explicit retailer_product_group_id under the existing qualified native field contract. Tax, digital delivery, full inventory reconciliation and live acceptance remain unqualified. X retains all ten explicit CSV fields and refuses Meta group intent. Website Meta canonical CSV and explicit supplier-column mapping accept optional retailer_product_group_id without inferring a group from parent-looking columns; blank optional groups stay omitted. Changing destination clears loaded mappings and old previews, and selected WooCommerce mode hides unrelated CSV layout controls. catalog_preview locally validates 1–50 selected Meta or X products with exact decimal source prices and explicit allow_upsert. X requires all mapped source fields, including HTTPS product links, native availability/condition, brand and plain text description; the existing single-product contract updates matching IDs, so allow_upsert must be true. X early-access entitlement and live acceptance are not established by a preview or saved draft. Each X source SKU maps to one unchanged native JSON step with its own review and receipt. catalog_compare takes the same gateway/account_id/connection_id/catalog_id/products/allow_upsert. Meta reads the supplied retailer IDs through its qualified contract; native numeric filters establish price equality. X scans at most 1,000 listed products twice with bracketed current FULL-promotable-user catalog ownership, sharing scans across 1–50 supplied SKUs and preserving exact supported decimal prices. Both return new/changed/matching/unknown states, blockers, exact source_hash and eligible review_retailer_ids. X blocks grouped/possibly hidden variants and requires explicit upsert; optional native attributes omitted from an update remain uncertain. X bounds are 180 attempts including retries, 5,000 collected rows, 4 MiB and 60 seconds; Meta retains 180 attempts, 150 rows, 2 MiB and 60 seconds. Partial/changed evidence is refused. This is read-only sequential evidence, not a point-in-time or complete variant inventory. Current actor/account/login authority is rechecked throughout; comparison creates no review, draft or mutation. catalog_plan saves the supplied product subset as an unapproved draft, and execution still needs fresh native reviews, explicit write authority and per-item read-back. Products absent from the import are never deleted. The owner turns personal-data writes (customer lists) on or off for one ad account with enable_personal_data and disable_personal_data.',
  [
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
    'catalog_preview',
    'catalog_source',
    'catalog_sources',
    'catalog_compare',
    'catalog_plan',
    'preview_catalog_removal',
    'create_catalog_removal',
    'delete_profile',
    'history',
    'health',
    'support_bundle',
    'save_spend_policy',
    'save_retention',
    'pause_writes',
    'resume_writes',
    'enable_personal_data',
    'disable_personal_data',
  ],
  {
    gateway: field.id,
    workflow_id: field.id,
    reason: {type: 'string', maxLength: 500},
    search: {type: 'string', maxLength: 200},
    offset: {type: 'integer', minimum: 0},
    policy: field.object,
    scope: {type: 'string', enum: ['workspace']},
    days: field.integer,
    connection_id: field.id,
    account_id: field.id,
    requirements: field.object,
    live: field.bool,
    id: field.id,
    profile: field.object,
    preview: field.object,
    preview_id: field.id,
    preview_hash: field.id,
    monitor: field.object,
    kind: {type: 'string', enum: ['all', ...operationKinds]},
    state: {
      type: 'string',
      maxLength: 40,
      description:
        'operations: ' +
        operationStates.join(', ') +
        '; incidents: all, open, acknowledged, snoozed, resolved, superseded; monitors: all, active, paused; report_bindings: active (default), retired, all.',
    },
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
    inspect_other_listed_products: {
      type: 'boolean',
      description:
        'catalog_compare only: inspect other bounded listed X products without establishing full store or variant absence.',
    },
    absent_source_policy: {
      type: 'string',
      enum: ['retain'],
      description: 'catalog_compare only: supplied products do not authorize deleting unselected source inventory.',
    },
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
    max_entities: {type: 'integer', minimum: 1, maximum: 1000},
    max_pages: {type: 'integer', minimum: 1, maximum: 25},
  },
);
export const accountPlan = (gateway: string, id: string): CompiledRequest => {
  const p: CompiledRequest = {
    gateway,
    accountId: id,
    action: 'AMCP_READINESS',
    method: 'GET',
    path: '',
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    evidence: 'AMCP exact account readiness read',
    warnings: [],
  };
  switch (gateway) {
    case 'meta_native_action':
      p.path = metaPrefix + 'act_' + id;
      p.query = {fields: 'id,name,account_status,currency,timezone_name'};
      break;
    case 'snapchat_native_action':
      p.path = '/v1/adaccounts/' + id;
      break;
    case 'tiktok_native_action':
      p.path = '/v1.3/advertiser/info/';
      p.query = {advertiser_ids: [id]};
      break;
    case 'google_ads_native_action':
      p.method = 'POST';
      p.path = googleAdsCustomers + id + '/googleAds:search';
      p.body = {query: 'SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'};
      break;
    case 'linkedin_native_action':
      p.path = '/rest/adAccounts/' + id;
      p.headers = {'LinkedIn-Version': linkedinVersion(), 'X-Restli-Protocol-Version': '2.0.0'};
      break;
    case 'x_ads_native_action':
      p.path = '/12/accounts/' + id;
      break;
    case 'dv360_native_action':
      p.path = '/v4/advertisers/' + id;
      break;
    case 'reddit_native_action':
      p.path = '/api/v3/ad_accounts/' + id;
      break;
    case microsoftGateway:
      return compileMicrosoft({action: 'GetAccount', account_id: id});
    default:
      bad('This provider uses resource-specific readiness checks.', 'READINESS_CONTRACT_UNAVAILABLE');
  }
  return p;
};
/** Native account reads nest the account differently per provider (Snapchat: adaccounts[0].adaccount).
 * Readiness checks, plan preflight and reports share this reader so a currency is never lost to nesting. */
export function accountMetadata(gateway: string, data: unknown): JsonObject {
  const d = (data && typeof data === 'object' ? data : {}) as JsonObject;
  const m =
    gateway === 'google_ads_native_action'
      ? d.results?.[0]?.customer
      : gateway === 'meta_native_action'
        ? d
        : gateway === 'tiktok_native_action'
          ? d.data?.list?.[0]
          : gateway === 'snapchat_native_action'
            ? d.adaccounts?.[0]?.adaccount
            : gateway === microsoftGateway
              ? d.Account
              : (d.data ?? d);
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}
export const accountCurrency = (gateway: string, data: unknown): string | null => {
  const m = accountMetadata(gateway, data);
  return m.currency ?? m.currencyCode ?? m.CurrencyCode ?? null;
};
export const accountTimezone = (gateway: string, data: unknown): string | null => {
  const m = accountMetadata(gateway, data);
  return m.timezone_name ?? m.timezone ?? m.timeZone ?? m.TimeZone ?? null;
};
export class WorkspaceService {
  constructor(
    private store: Store,
    private registry: Registry,
    private transport: NativeTransport,
    private credentials: CredentialProvider,
    private call: ToolCall,
    private allowWrites: boolean,
    private wooCommerceRequest?: WooCommerceRequest,
  ) {}
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
    if (input.action === 'measurement_events') return measurementEvents(this.store, this.call, actor, input);
    if (input.action === 'preview_consent_plan') return previewConsentPlan(this.store, this.call, actor, input);
    if (input.action === 'create_consent_plan') return createConsentPlan(this.store, this.call, actor, input);
    if (input.action === 'measurement_event_identity')
      return measurementEventIdentity(this.store, this.call, actor, input);
    if (input.action === 'measurement_conversions')
      return linkedInConversionEvidence(this.store, this.call, actor, input);
    if (input.action === 'catalog_compare')
      return catalogComparison(this.store, this.registry, this.transport, this.credentials, actor, input);
    if (input.action === 'catalog_source') {
      if (input.requirements?.source_kind === 'inventory')
        return wooCommerceInventory(
          this.store,
          actor,
          input,
          this.wooCommerceRequest,
          this.transport.commerceSourceEnvironment(),
        );
      return wooCommerceSource(
        this.store,
        actor,
        input,
        this.wooCommerceRequest,
        this.transport.commerceSourceEnvironment(),
      );
    }
    if (input.action === 'catalog_sources') {
      validate(input, ['action']);
      return wooCommerceSources(this.store, actor);
    }
    if (input.action === 'preview_catalog_removal') return previewCatalogRemoval(this.store, this.call, actor, input);
    if (input.action === 'create_catalog_removal') return createCatalogRemoval(this.store, this.call, actor, input);
    if (['catalog_preview', 'catalog_plan'].includes(input.action)) {
      this.store.resolveConnection(actor, input.gateway, input.account_id, input.connection_id);
      const result = catalogIngestion(input);
      if (input.action === 'catalog_preview') return result;
      const created = await this.call('amcp_campaign', result.plan, actor);
      if (!created.success)
        bad(created.error?.message ?? 'Catalog plan failed.', created.error?.code ?? 'CATALOG_PLAN_FAILED');
      return {...created.data, source_hash: result.source_hash, item_count: result.item_count};
    }
    if (input.action === 'measurement_audit') {
      const requirements = input.requirements ?? {};
      validate(requirements, ['container_id', 'workspace_id']);
      const connection = this.store.resolveConnection(
        actor,
        'gtm_native_action',
        input.account_id,
        input.connection_id,
      );
      const result = await this.call(
        'gtm_native_action',
        {
          operation: 'gtm_audit_ops',
          arguments: {
            connection_id: connection.id,
            account_id: input.account_id,
            ...requirements,
            include_versions: true,
            include_resources: false,
          },
        },
        actor,
      );
      if (!result.success)
        bad(result.error?.message ?? 'Measurement audit failed.', result.error?.code ?? 'MEASUREMENT_AUDIT_FAILED');
      this.store.resolveConnection(actor, 'gtm_native_action', input.account_id, connection.id);
      return {
        record_kind: 'measurement_audit',
        scope: {connection_id: connection.id, account_id: input.account_id ?? null, ...requirements},
        configuration: result.data,
        event_delivery: 'not_measured',
        meaning:
          'Configuration evidence only. This audit does not establish that real events fire, deduplicate, satisfy consent or attribute correctly.',
        advertising_writes: 0,
      };
    }
    if (input.action === 'contracts') return actionContractPage(this.registry, input);
    if (input.action === 'capabilities')
      return capabilityGraph(this.store, this.registry, actor, this.allowWrites, input.gateway, input);
    if (input.action === 'program_check')
      return checkConditionalProgram(this.store, this.registry, this.call, actor, input);
    if (
      [
        'health',
        'support_bundle',
        'save_spend_policy',
        'save_retention',
        'pause_writes',
        'resume_writes',
        'enable_personal_data',
        'disable_personal_data',
      ].includes(input.action)
    )
      return ownerOperations(this.store, input, actor);
    if (input.action === 'profiles') return {profiles: this.store.documents(actor.tenantId, 'client_profile')};
    if (input.action === 'preview_profile') {
      const profile = input.id ? read(this.store, actor, 'client_profile', input.id) : input.profile;
      if (!obj(profile)) bad('Supply a saved profile or a draft profile.');
      validatePlaybook(profile);
      for (const binding of profile.bindings ?? [])
        this.store.resolveConnection(actor, binding.gateway, binding.account_id, binding.connection_id);
      return previewPlaybook(profile, input.preview ?? {});
    }
    if (input.action === 'save_profile') {
      writer(this.store, actor);
      if (input.confirmed !== true || !obj(input.profile)) bad('Review and confirm the client profile.');
      const p = input.profile;
      validatePlaybook(p);
      noSecrets(p);
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
      const p = read(this.store, actor, 'client_profile', input.id);
      if (input.revision !== p.revision) bad('Reload the current profile.', 'REVISION_CONFLICT');
      this.store.db
        .prepare('DELETE FROM documents WHERE tenant_id=? AND kind=? AND id=? AND revision=?')
        .run(actor.tenantId, 'client_profile', p.id, p.revision);
      audit(this.store, actor, 'client_profile_deleted', {id: p.id});
      return {deleted: true};
    }
    if (input.action === 'history') return auditHistoryPage(this.store, actor, input);
    if (input.action === 'dashboard') {
      const checks = this.store.documents(actor.tenantId, 'readiness'),
        receipts = this.store.documents(actor.tenantId, 'write_verification');
      return {
        capabilities: workspaceCapabilities(this.store, actor),
        at: Date.now(),
        writes_enabled: this.allowWrites,
        writes_paused: writePause(this.store, actor.tenantId) ?? null,
        connections: this.store.listConnections(actor.tenantId).map(c => ({
          id: c.id,
          gateway: c.gateway,
          label: c.label,
          enabled: c.enabled,
          accounts: c.accounts,
          write_accounts: c.writeAccounts ?? [],
          accounts_status: c.accounts.map(account => ({
            account_id: account,
            check: checks.find(x => x.connection_id === c.id && x.account_id === account) ?? null,
            verified_writes: receipts
              .filter(r => r.connection_id === c.id && r.account_id === account)
              .map(r => ({review_id: r.id, at: r.checked_at, status: r.status, action: r.action})),
          })),
        })),
        campaigns: this.store
          .documents(actor.tenantId, 'campaign_run')
          .filter(r => r.user_id === actor.userId || actor.role === 'admin')
          .map(r => ({
            id: r.id,
            name: r.name,
            state: r.state,
            updated_at: r.updated_at,
            steps: r.steps.map((s: JsonObject) => ({id: s.id, status: s.status, error: s.error})),
          })),
        levels: ['implemented', 'locally_tested', 'provider_read_checked', 'provider_validated', 'write_verified'],
        limitations:
          'A connection check is not validation of every workflow. No live badge is inferred from catalog coverage.',
      };
    }
    if (input.action !== 'check') bad('Unknown workspace action.');
    const c = this.store.listConnections(actor.tenantId).find(c => c.id === input.connection_id);
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
    const check = (key: string, pass: boolean | null, message: string, next?: string) =>
      checks.push({
        key,
        status: pass === null ? 'unknown' : pass ? 'passed' : 'blocked',
        message,
        ...(next ? {next_step: next} : {}),
      });
    check(
      'connection',
      c.enabled,
      c.enabled ? 'Connection enabled.' : 'Connection disabled.',
      'Reconnect or select assets in Connections.',
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
        !writePause(this.store, actor.tenantId),
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
      const required = writeScopes[c.gateway];
      check(
        'provider_scopes',
        required
          ? required.every(
              s => c.scopes.includes(s) || (s.endsWith('msads.manage') && c.scopes.includes('msads.manage')),
            )
          : null,
        required ? 'Required recorded OAuth scopes.' : 'This provider requires live permission verification.',
        'Reconnect with the required provider permissions.',
      );
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
    let liveAccount: JsonObject | undefined;
    if (input.live === true && c.enabled) {
      try {
        const p = accountPlan(c.gateway, id);
        new ScopeGuard(this.registry, this.store).authorize(p, c);
        const auth = await this.credentials.get(c);
        this.store.assertActorActive(actor);
        const current = this.store.resolveConnection(actor, c.gateway, id, c.id),
          access = nativeAuthority(this.store, this.registry, actor, p, current, auth),
          r = await this.transport.request(p, access(), auth, undefined, {beforeAttempt: access});
        access();
        validateState(p, r);
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
        check('provider_read', true, 'Provider confirmed the exact selected account.');
      } catch (e) {
        // The provider's own diagnosis (PRV-01): its code, request ID and the layer that must act, with the next step
        // for that layer. A bare refusal is not relabeled as a reconnect.
        const diagnostic =
          e instanceof MirrorError
            ? reportSourceError(e, {
                platform: Object.entries(reportPlatforms).find(([, p]) => p.gateway === c.gateway)?.[0] ?? c.gateway,
                account_id: id,
                connection_id: c.id,
              })
            : undefined;
        check(
          'provider_read',
          false,
          e instanceof MirrorError ? e.message : 'Provider account read failed.',
          typeof diagnostic?.next_action === 'string'
            ? diagnostic.next_action
            : 'Reconnect or resolve the provider account permission.',
        );
        if (diagnostic) checks[checks.length - 1]!.diagnostic = diagnostic;
      }
    } else check('provider_read', null, 'No provider request was made.');
    this.store.assertActorActive(actor);
    const result = {
      connection_id: c.id,
      account_id: id,
      connection_fingerprint: readinessBinding(c),
      checked_at: Date.now(),
      requirements,
      checks,
      ready: checks.every(c => c.status === 'passed'),
      blocked: checks.some(c => c.status === 'blocked'),
      live_read: checks.some(c => c.key === 'provider_read' && c.status === 'passed'),
      ...(liveAccount ? {account: liveAccount} : {}),
      coverage: 'Exact requested prerequisites only; unknown checks are not passed.',
    };
    this.store.putDocument(actor.tenantId, 'readiness', fingerprint([c.id, id]), result);
    return result;
  }
}
