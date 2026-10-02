import {auditHistoryPage} from './audit-history.js';
import {measurementEvents} from './measurement-events.js';
import {nativeAuthority} from './native-authority.js';
import {linkedinVersion} from './linkedin-version.js';
import {ownerOperations, writePause} from './owner-operations.js';
import {workspaceCapabilities} from './capabilities.js';
import {actionContractPage} from './action-contracts.js';
import {capabilityGraph} from './capability-graph.js';
import {readinessBinding, recordedWriteScopes} from './capability-eligibility.js';
import {previewPlaybook, validatePlaybook} from './client-playbooks.js';
import {monitorActions, monitorOperation} from './report-monitors.js';
import {portfolioPage} from './portfolio.js';
import {catalogIngestion} from './catalog-ingestion.js';
import {operationsPage, operationKinds, operationStates} from './operations-feed.js';
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
  'Use this before planning a change, to see what an account is ready for and which actions have write contracts, and afterwards for its change history. Account readiness, capability evidence, approved client defaults/templates, and campaign change history. contracts lists every local action and its read/write/media/blocked contract classification without network calls; filter by gateway/search and paginate with offset/limit. history returns bounded safe event metadata, never raw requests or receipts. Use limit 1-100, search (event/action/request reference), gateway/account_id/connection_id and returned cursor. Each page rechecks current access; owners see workspace metadata, other users see currently accessible account events and their own unscoped events. Conflicting scope is withheld. Pagination retains its original sequence ceiling; follow continuation even after an empty page and refresh for newer events. This is retained AMCP history, not complete vendor history or a new integrity verification. operations is a local, metadata-only cross-engine feed: filter kind/state/search/account_id, page with next_cursor, and follow each read-only next_call to the original record. Workbook report runs use kind workbook_report; report_run reads a bounded, currently scoped status by id. resume_report_run requires id, the displayed run_version and confirmed:true, requeues only prepared/failed/cancelled read-only reports, and preserves their original run ID. report_schedule inspects a workbook schedule by id with three future clock times and schedule_version. preview_report_schedule validates proposed active:boolean and schedule:{name,timezone,schedule_kind,minute,hour,weekday?,day?} against id and schedule_version, returning changes and three proposed clock times without mutation. save_report_schedule accepts those fields with confirmed:true; query identity is unchanged and existing jobs continue. report_queries lists currently authorized query metadata with search/account_id/connection_id/spreadsheet_id and offset/limit; continue with next_offset, even after an empty page. report_query reads one bounded query by id and its query_version. preview_report_query reviews query:{name,query_config} with id and query_version; provider/account/connection stay fixed. save_report_query adds confirmed:true and saves that exact revision, pausing active schedules when the definition changes and creating one prepared, unsubmitted report. Existing jobs retain their configuration. report_bindings lists scoped local workbook associations with search/spreadsheet_id, state active (default)/retired/all and offset/limit; continue next_offset even after an empty page. report_binding inspects one binding by id, returns up to 100 linked queries and binding_version, and does not verify external spreadsheet access. preview_report_binding reviews binding:{spreadsheet_name} with id/binding_version; save_report_binding adds confirmed:true and renames only local metadata. The spreadsheet ID, stored preferences, queries, schedules and report runs remain unchanged. Current access to every linked query is required; empty bindings are creator/admin-only. preview_report_binding_state takes id/binding_version and active:boolean to review retirement (false) or restoration (true) of an empty association. save_report_binding_state adds confirmed:true. Any linked query or schedule, including orphaned schedules, blocks the change. Retirement preserves private settings and IDs, hides the association from active lists and blocks new use until explicit restoration. It does not delete reports or any external spreadsheet. preview_report_query_move takes the original query id/query_version and an existing target_binding_id, returns source/target identity, schedule impact and rebinding_version. move_report_query adds that rebinding_version and confirmed:true. It atomically moves the query and up to 100 linked schedules, pauses all of them for separate review/resume, preserves existing jobs and prepares one unsubmitted local run. Current access to both associations and every linked query is required; no external spreadsheet access is verified. Read-only native configurations require explicit scope and credentials belong in Connections. incidents/monitors support state/search/account filters and offset/limit; incident/monitor read one record. Acknowledge, snooze 1-168 hours, or resume an incident with its current revision; snooze never resolves evidence. monitor_notifications reads only your subscription and 20 recent deliveries for monitor id. set_monitor_notifications requires id, enabled:boolean, current subscription_version and confirmed:true; it opts only your verified personal email into future openings/reopenings/resolutions. Rule revisions, account security and access changes require new confirmation; no arbitrary recipient or historical backfill. retry_monitor_notification requires notification_id, current notification_version and confirmed:true, reusing the original recipient/payload/key within 24 hours; five automatic attempts and one recovery up to ten total. Provider acceptance is separate from inbox delivery. capabilities accepts exact workflow_id/account_id/connection_id filters, exposes dependency objects, native contracts and review lifecycle, and reports timestamped account-read evidence separately from unverified objective acceptance. portfolio reads bounded Google, Meta, LinkedIn or Snapchat inventory pages with gateway/account_id/connection_id, limit 1–100, requirements and an optional returned cursor. Google entities: campaign, ad_group, ad (campaign_id and ad_group_id parents). Meta entities: campaign, adset, ad (campaign_id and adset_id parents); read each parent first with the same login, then follow its children within five minutes. Meta cursors bind account/login/entity/page size and expire after five minutes; native money stays unconverted and effective status stays separate. LinkedIn entities: campaign_group, campaign (campaign_group_id parent), creative (campaign_group_id and campaign_id parents). Read each parent in the same login first; observations and signed cursors last five minutes. LinkedIn cursor search covers documented group statuses and test/non-test entities, keeps exact decimal money with currency, and separates creative intended status from observed serving. Inventory is current, not a point-in-time snapshot. Snapchat entities: campaign, adsquad (campaign_id parent), ad (campaign_id and ad_squad_id parents). Use exact UUIDs and a page limit of 50–100. Read qualified portfolio parents first; parent observations and signed scope-bound cursors last five minutes. Snapchat keeps exact micros, current currency/timezone and separate configured status, review status and delivery codes. Only the opaque cursor is reused on a fixed scoped native route; adjacent overlaps, changed hierarchy and malformed continuation fail. measurement_events reads recent GA4 aggregate counts with gateway ga4_native_action, exact numeric property account_id, connection_id and requirements:{event_names:[1–20 exact names],minutes:1–30 (default 30),stream_id?:exact numeric ID}. This is one bounded realtime read, not an event sender; counts remain exact strings, absent rows have null counts, and partial/unknown evidence is refused. Deduplication, consent, attribution, test-event identity and overall health remain unverified; no snapshot is saved. Profiles never grant account access. check performs only provider reads; unsupported/missing evidence stays explicit. The owner turns personal-data writes (customer lists) on or off for one ad account with enable_personal_data and disable_personal_data.',
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
    'check',
    'profiles',
    'save_profile',
    'preview_profile',
    ...monitorActions,
    'portfolio',
    'measurement_audit',
    'measurement_events',
    'catalog_preview',
    'catalog_plan',
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
    allow_upsert: field.bool,
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
const writeScopes = recordedWriteScopes;
export class WorkspaceService {
  constructor(
    private store: Store,
    private registry: Registry,
    private transport: NativeTransport,
    private credentials: CredentialProvider,
    private call: ToolCall,
    private allowWrites: boolean,
  ) {}
  async handle(input: JsonObject, actor: Actor): Promise<JsonObject> {
    validate(input, Object.keys(workspaceTool.inputSchema.properties));
    this.store.assertActorActive(actor);
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
    if (input.action === 'measurement_events') return measurementEvents(this.store, this.call, actor, input);
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
        check(
          'provider_read',
          false,
          e instanceof MirrorError ? e.message : 'Provider account read failed.',
          'Reconnect or resolve the provider account permission.',
        );
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
