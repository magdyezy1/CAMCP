import {Ajv} from 'ajv';
import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {operationStates} from './operation-types.js';
import {stepsNote} from './campaign-step-help.js';

/**
 * The per-action contracts of AMCP's own tools (MCP-07): what each action of amcp_workspace, amcp_campaign,
 * amcp_reporting, amcp_reporting_overview, amcp_media, amcp_write and amcp_ad_previews takes, what it can do and who may
 * call it. A tool still lists one flat input schema (a per-action oneOf would enlarge tools/list); this table narrows it
 * per action, is served whole by amcp_tool_help {gateway, operation}, and checks each call.
 *
 * - `arguments` are authored from the handler code: an action reads these names and no others. Their JSON Schemas start
 *   from the tool's flat properties; action bounds may narrow limits and supply the handler's defaults and notes.
 * - `effects` are the most a call can do: provider requests (none, read_only, or reviewed_write for a mutation sent after
 *   review), the AMCP records it may save, provider-side jobs, non-advertising remote writes (Google Sheets) and
 *   advertising writes. They describe; the safeguards that enforce them (review gate, spending policy, grants,
 *   idempotency, read-back) stay where they are.
 * - `requires_role` is the least role that can succeed: reader (any member, including a read-only AI client), operator,
 *   admin, or owner (the workspace owner).
 * - `next` are the calls that usually follow.
 *
 * An argument outside its action's list is reported as a meta warning (report-only, this release) and, under
 * MIRROR_FLAGS {"actionArguments":"enforce"}, refused with INVALID_ARGUMENT naming it (see `actionArgumentCheck`).
 * tests/first-party-contracts.test.mjs fails when an enum action has no row, and checks every literal call of these
 * tools in the tests, the website and the guides against its row.
 */
export type ProviderRequests = 'none' | 'read_only' | 'reviewed_write';
export interface ActionEffects {
  provider_requests: ProviderRequests;
  saves: string[];
  remote_jobs: boolean;
  remote_writes: boolean;
  advertising_writes: boolean;
}
export type RequiredRole = 'reader' | 'operator' | 'admin' | 'owner';
export interface FirstPartyContract {
  tool: string;
  /** null for a tool without an action selector (amcp_ad_previews). */
  action: string | null;
  summary: string;
  argumentsSchema: JsonObject;
  effects: ActionEffects;
  requires_role: RequiredRole;
  next: {tool: string; action: string}[];
}
interface ToolLike {
  name: string;
  inputSchema: JsonObject;
}
type ActionBounds = Record<
  string,
  {minimum?: number; maximum?: number; default?: unknown; maxLength?: number; note?: string}
>;
interface Row {
  action: string | null;
  summary: string;
  required: string[];
  optional: string[];
  effects: ActionEffects;
  role: RequiredRole;
  next: [string, string][];
  bounds?: ActionBounds;
}
const effects = (
  provider_requests: ProviderRequests = 'none',
  saves: string[] = [],
  extra: Partial<ActionEffects> = {},
): ActionEffects => ({
  provider_requests,
  saves,
  remote_jobs: false,
  remote_writes: false,
  advertising_writes: false,
  ...extra,
});
const local = effects(),
  saves = (...kinds: string[]) => effects('none', kinds),
  reads = (...kinds: string[]) => effects('read_only', kinds),
  mutation = (...kinds: string[]) => effects('reviewed_write', kinds, {advertising_writes: true});
const row = (
  action: string | null,
  summary: string,
  required: string[],
  optional: string[],
  e: ActionEffects,
  role: RequiredRole,
  next: [string, string][] = [],
  bounds?: ActionBounds,
): Row => ({action, summary, required, optional, effects: e, role, next, bounds});
const helpRow = () =>
  row(
    'help',
    'Full description, argument notes, limits and examples of this tool; read-only.',
    [],
    ['topic'],
    // AMCP's own definitions and guides: no provider request, whatever the tool's other actions do (F-L3-09).
    local,
    'reader',
  );

const W = 'amcp_workspace',
  C = 'amcp_campaign',
  R = 'amcp_reporting',
  O = 'amcp_reporting_overview',
  M = 'amcp_media',
  X = 'amcp_write',
  P = 'amcp_ad_previews';
const scope = ['gateway', 'connection_id', 'account_id'];
const nativeScope = ['gateway', 'account_id', 'connection_id', 'requirements'];

const rows: Record<string, Row[]> = {
  [W]: [
    helpRow(),
    row(
      'dashboard',
      'Counts per provider and account; sections with gateway, connection_id and account_id return bounded detail.',
      [],
      ['view', 'sections', ...scope, 'limit', 'cursor'],
      local,
      'reader',
      [
        [W, 'operations'],
        [W, 'capabilities'],
      ],
    ),
    row(
      'operations',
      'Metadata-only feed of retained work across engines, each with a read-only next_call to its record.',
      [],
      ['kind', 'state', 'search', 'account_id', 'connection_id', 'profile_id', 'limit', 'cursor'],
      local,
      'reader',
      [[W, 'report_run']],
      {'limit': {'minimum': 1, 'maximum': 100, 'default': 30}},
    ),
    row('report_run', 'One workbook report run: its bounded, currently scoped status.', ['id'], [], local, 'reader', [
      [W, 'resume_report_run'],
    ]),
    row(
      'resume_report_run',
      'Requeues a prepared, failed or cancelled read-only workbook report under its original run ID.',
      ['id', 'run_version', 'confirmed'],
      [],
      reads('report_run'),
      'operator',
      [[W, 'report_run']],
    ),
    row(
      'report_schedule',
      'One workbook schedule with its next three clock times and schedule_version.',
      ['id'],
      [],
      local,
      'reader',
      [
        [W, 'preview_report_schedule'],
        [O, 'preview_workbook_move'],
      ],
    ),
    row(
      'preview_report_schedule',
      'Checks proposed schedule settings against the current schedule_version without saving anything.',
      ['id', 'schedule_version'],
      ['active', 'schedule'],
      local,
      'reader',
      [[W, 'save_report_schedule']],
    ),
    row(
      'save_report_schedule',
      'Saves the previewed schedule settings; the query and existing jobs are unchanged.',
      ['id', 'schedule_version', 'confirmed'],
      ['active', 'schedule'],
      saves('workbook_schedule'),
      'operator',
      [[W, 'report_schedule']],
    ),
    row(
      'report_queries',
      'Lists currently authorized workbook query metadata.',
      [],
      ['search', 'account_id', 'connection_id', 'spreadsheet_id', 'offset', 'limit'],
      local,
      'reader',
      [[W, 'report_query']],
      {'limit': {'default': 50}},
    ),
    row('report_query', 'One workbook query and its query_version.', ['id'], [], local, 'reader', [
      [W, 'preview_report_query'],
    ]),
    row(
      'preview_report_query',
      'Reviews a changed query definition (name, query_config) against query_version without saving.',
      ['id', 'query_version', 'query'],
      [],
      local,
      'reader',
      [[W, 'save_report_query']],
    ),
    row(
      'save_report_query',
      'Saves the reviewed query revision, pausing changed schedules and preparing one unsubmitted run.',
      ['id', 'query_version', 'query', 'confirmed'],
      [],
      saves('workbook_query', 'report_run'),
      'operator',
      [[W, 'report_query']],
    ),
    row(
      'preview_report_query_move',
      'Shows the source and target binding, schedule impact and rebinding_version of moving a query.',
      ['id', 'query_version', 'target_binding_id'],
      [],
      local,
      'reader',
      [[W, 'move_report_query']],
    ),
    row(
      'move_report_query',
      'Moves the query and its schedules to another binding, pausing them for separate review.',
      ['id', 'query_version', 'target_binding_id', 'rebinding_version', 'confirmed'],
      [],
      saves('workbook_query', 'workbook_schedule', 'report_run'),
      'operator',
      [[W, 'report_query']],
    ),
    row(
      'report_bindings',
      'Lists scoped local workbook associations (active by default).',
      [],
      ['search', 'spreadsheet_id', 'state', 'offset', 'limit'],
      local,
      'reader',
      [[W, 'report_binding']],
      {'limit': {'default': 20}},
    ),
    row(
      'report_binding',
      'One binding with up to 100 linked queries and binding_version; external access is not verified.',
      ['id'],
      [],
      local,
      'reader',
      [[W, 'preview_report_binding']],
    ),
    row(
      'preview_report_binding',
      'Reviews a binding rename (binding.spreadsheet_name) against binding_version.',
      ['id', 'binding_version', 'binding'],
      [],
      local,
      'reader',
      [[W, 'save_report_binding']],
    ),
    row(
      'save_report_binding',
      'Renames the binding’s local metadata only.',
      ['id', 'binding_version', 'binding', 'confirmed'],
      [],
      saves('workbook_binding'),
      'operator',
      [[W, 'report_binding']],
    ),
    row(
      'preview_report_binding_state',
      'Reviews retiring (active:false) or restoring (active:true) an empty binding.',
      ['id', 'binding_version', 'active'],
      [],
      local,
      'reader',
      [[W, 'save_report_binding_state']],
    ),
    row(
      'save_report_binding_state',
      'Retires or restores an empty binding; nothing is deleted.',
      ['id', 'binding_version', 'active', 'confirmed'],
      [],
      saves('workbook_binding'),
      'operator',
      [[W, 'report_binding']],
    ),
    row(
      'contracts',
      'Read/write/media/blocked classification of every native action and what its route rests on (anchor_status), with no network request.',
      [],
      ['gateway', 'search', 'offset', 'limit'],
      local,
      'reader',
      [[X, 'inspect']],
      {'limit': {'default': 50}},
    ),
    row(
      'capabilities',
      'Workflows with per-account readiness and blockers: a paged summary, or the whole graph with view:"graph".',
      [],
      ['workflow_id', 'gateway', 'connection_id', 'account_id', 'view', 'limit', 'cursor', 'offset'],
      local,
      'reader',
      [
        [W, 'check'],
        [W, 'program_check'],
      ],
      {'limit': {'minimum': 1, 'maximum': 25, 'default': 20}},
    ),
    row(
      'program_check',
      'One conditional program of capabilities: live:false checks contracts and recorded permissions; live:true makes one bounded read.',
      ['workflow_id', 'connection_id', 'account_id'],
      ['live', 'requirements'],
      reads('conditional_program_observation'),
      'reader',
      [[W, 'capabilities']],
    ),
    row(
      'check',
      'Exact account prerequisites of account_id, or of 1–20 account_ids of one login: live:false saves nothing; live:true reads each account and saves its read evidence.',
      ['connection_id'],
      ['account_id', 'account_ids', 'live', 'requirements'],
      reads('readiness', 'account_metadata'),
      'reader',
      [[W, 'capabilities']],
    ),
    row('profiles', 'Lists the approved client profiles.', [], [], local, 'reader', [[W, 'preview_profile']]),
    row(
      'save_profile',
      'Saves an approved client profile (naming, UTM, bindings, defaults, templates); profiles grant no account access.',
      ['profile', 'confirmed'],
      ['id', 'revision'],
      saves('client_profile'),
      'operator',
      [[W, 'profiles']],
    ),
    row(
      'preview_profile',
      'Applies a saved or draft profile to preview values without saving.',
      [],
      ['id', 'profile', 'preview'],
      local,
      'reader',
      [[W, 'save_profile']],
    ),
    row(
      'monitor_notifications',
      'Your email subscription to one monitor and its 20 recent deliveries.',
      ['id'],
      [],
      local,
      'reader',
      [[W, 'set_monitor_notifications']],
    ),
    row(
      'set_monitor_notifications',
      'Turns your verified-email notices for one monitor on or off.',
      ['id', 'enabled', 'subscription_version', 'confirmed'],
      [],
      saves('monitor_subscription'),
      'reader',
      [[W, 'monitor_notifications']],
    ),
    row(
      'retry_monitor_notification',
      'Retries one failed notice with its original recipient and payload within 24 hours.',
      ['notification_id', 'notification_version', 'confirmed'],
      [],
      saves('monitor_notification'),
      'reader',
      [[W, 'monitor_notifications']],
    ),
    row(
      'monitors',
      'Lists report monitors.',
      [],
      ['state', 'search', ...scope, 'offset', 'limit'],
      local,
      'reader',
      [[W, 'monitor']],
      {'limit': {'default': 50}},
    ),
    row('monitor', 'One report monitor.', ['id'], [], local, 'reader', [[W, 'set_monitor_state']]),
    row(
      'save_monitor',
      'Saves a report monitor rule; monitors never change an advertising account.',
      ['monitor', 'confirmed'],
      ['id', 'revision'],
      saves('report_monitor'),
      'operator',
      [[W, 'monitors']],
    ),
    row(
      'set_monitor_state',
      'Pauses or resumes a monitor at its current revision.',
      ['id', 'active', 'revision', 'confirmed'],
      [],
      saves('report_monitor'),
      'operator',
      [[W, 'monitor']],
    ),
    row(
      'incidents',
      'Lists monitor incidents.',
      [],
      ['state', 'search', ...scope, 'offset', 'limit'],
      local,
      'reader',
      [[W, 'incident']],
      {'limit': {'default': 50}},
    ),
    row('incident', 'One monitor incident.', ['id'], [], local, 'reader', [[W, 'acknowledge_incident']]),
    row(
      'acknowledge_incident',
      'Acknowledges an incident at its current revision.',
      ['id', 'revision'],
      ['confirmed'],
      saves('report_incident'),
      'operator',
      [[W, 'incident']],
    ),
    row(
      'snooze_incident',
      'Snoozes an incident for 1–168 hours; a snooze never resolves its evidence.',
      ['id', 'revision', 'snooze_hours'],
      ['confirmed'],
      saves('report_incident'),
      'operator',
      [[W, 'incident']],
    ),
    row(
      'resume_incident',
      'Ends an acknowledgement or snooze at the current revision.',
      ['id', 'revision'],
      ['confirmed'],
      saves('report_incident'),
      'operator',
      [[W, 'incident']],
    ),
    row(
      'evaluate_monitors',
      'Evaluates the monitors of one retained report against its evidence, opening or resolving incidents.',
      ['report_id'],
      [],
      saves('report_incident'),
      'operator',
      [[W, 'incidents']],
    ),
    row(
      'portfolio',
      'One bounded inventory page (campaigns, ad sets/groups, ads) of a Google, Meta, LinkedIn, Snapchat, TikTok, X or Microsoft account.',
      ['gateway', 'account_id'],
      ['connection_id', 'requirements', 'limit', 'cursor'],
      reads(),
      'reader',
      [[W, 'portfolio_reconcile']],
      {'limit': {'minimum': 1, 'maximum': 100, 'default': 50, 'note': 'Snapchat accepts 50–100.'}},
    ),
    row(
      'portfolio_reconcile',
      'Two complete bounded observations of one inventory hierarchy, compared; saves nothing.',
      ['gateway', 'account_id'],
      ['connection_id', 'requirements', 'limit', 'max_entities', 'max_pages'],
      reads(),
      'reader',
      [[W, 'portfolio']],
      {
        'limit': {'minimum': 1, 'maximum': 100, 'default': 50},
        'max_entities': {'minimum': 1, 'maximum': 1000, 'default': 500},
        'max_pages': {'minimum': 1, 'maximum': 25, 'default': 20},
      },
    ),
    row(
      'measurement_audit',
      'Tag Manager workspace configuration and consent evidence for requirements {container_id, workspace_id}.',
      ['account_id', 'requirements'],
      ['gateway', 'connection_id'],
      reads(),
      'reader',
      [[W, 'preview_consent_plan']],
    ),
    row(
      'preview_consent_plan',
      'Reads 1–10 selected tags and previews additional-consent changes for a 10-minute, session-bound window.',
      [...nativeScope],
      [],
      reads('gtm_consent_preview'),
      'operator',
      [[W, 'create_consent_plan']],
    ),
    row(
      'create_consent_plan',
      'Saves the previewed consent changes as one unapproved native UPDATE_TAG plan; nothing is published.',
      ['preview_id', 'preview_hash', 'confirmed'],
      [],
      reads('campaign_run'),
      'operator',
      [[C, 'approval_summary']],
    ),
    row(
      'measurement_events',
      'Recent GA4 realtime event counts for 1–20 exact event names; no event is sent and nothing is saved.',
      [...nativeScope],
      [],
      reads(),
      'reader',
      [[W, 'measurement_event_identity']],
    ),
    row(
      'measurement_event_identity',
      'Counts one synthetic GA4 test identifier through an existing amcp_test_id dimension (core report dates, or mode realtime_user_scope on an owner-marked test property); nothing is saved.',
      [...nativeScope],
      [],
      reads(),
      'reader',
      [[W, 'measurement_events']],
    ),
    row(
      'measurement_conversions',
      'Current LinkedIn conversion rule settings of one account; nothing is saved.',
      ['gateway', 'account_id'],
      ['connection_id', 'requirements'],
      reads(),
      'reader',
      [[W, 'check']],
    ),
    // MSR-02 and MSR-03 measurement reads: bounded provider reads under one fence, nothing saved.
    row(
      'measurement_google_goals',
      'Current Google Ads conversion goals of one customer, read twice under one fence; optional requirements {currency}. Nothing is saved.',
      ['gateway', 'account_id'],
      ['connection_id', 'requirements'],
      reads(),
      'reader',
      [[W, 'measurement_ledger']],
    ),
    row(
      'measurement_ga4_config',
      'One GA4 property configuration (key events, custom definitions, streams, Ads links, retention); optional requirements {sections}.',
      ['gateway', 'account_id'],
      ['connection_id', 'requirements'],
      reads(),
      'reader',
      [[W, 'measurement_ledger']],
    ),
    row(
      'measurement_ledger',
      'Six fixed evidence layers for one Google Ads, GA4, Meta, Snapchat, TikTok, Search Console or Adjust asset; optional requirements {pixel_id}. A failed read leaves its layer unknown. Nothing is saved.',
      ['gateway', 'account_id'],
      ['connection_id', 'requirements'],
      reads(),
      'reader',
      [
        [W, 'measurement_google_goals'],
        [W, 'measurement_ga4_config'],
      ],
    ),
    row(
      'change_history',
      'Google Ads change events of one customer for at most 30 days, newest first, with a per-day timeline; who made a change is not requested. Nothing is saved.',
      ['gateway', 'account_id', 'requirements'],
      ['connection_id'],
      reads(),
      'reader',
      // The current value of a changed resource is in the inventory; change history names only the field.
      [[W, 'portfolio']],
    ),
    row(
      'search_overlap',
      'Search Console queries and Google Ads search terms for the same closed dates, joined approximately on normalized text. Nothing is saved.',
      ['gateway', 'account_id', 'requirements'],
      ['connection_id'],
      reads(),
      'reader',
      // Exact negative keywords come from a retained guided search-term report, through the reviewed exclusion plan.
      [
        [R, 'capture_preset'],
        [R, 'search_exclusion_candidates'],
      ],
    ),
    row(
      'catalog_preview',
      'Locally validates 1–50 selected Meta, X or Snapchat products, or a CSV source (51–500 as a plan group), with exact source prices.',
      ['gateway', 'account_id', 'catalog_id'],
      ['connection_id', 'products', 'allow_upsert', 'name', 'requirements'],
      local,
      'reader',
      [[W, 'catalog_compare']],
    ),
    row(
      'catalog_source',
      'Reads selected WooCommerce products or variations (or, with source_kind:inventory, the published inventory).',
      [...nativeScope],
      [],
      reads(),
      'reader',
      [[W, 'catalog_preview']],
    ),
    row(
      'catalog_sources',
      'Lists configured WooCommerce source connections without credentials or network requests.',
      [],
      [],
      local,
      'reader',
      [[W, 'catalog_source']],
    ),
    row(
      'catalog_compare',
      'Compares supplied products with the current Meta, X or Snapchat (read-only) catalog: new, changed, matching or unknown.',
      ['gateway', 'account_id', 'catalog_id'],
      [
        'connection_id',
        'products',
        'allow_upsert',
        'inspect_other_listed_products',
        'absent_source_policy',
        'name',
        'requirements',
      ],
      reads(),
      'reader',
      [[W, 'catalog_plan']],
    ),
    row(
      'catalog_plan',
      'Saves the supplied products as an unapproved plan with their lineage (51–500 as a plan group); absent products are never deleted.',
      ['gateway', 'account_id', 'catalog_id'],
      ['connection_id', 'products', 'allow_upsert', 'name', 'requirements'],
      saves('campaign_run'),
      'operator',
      [[C, 'approval_summary']],
    ),
    row(
      'catalog_mapping',
      'Reads the saved, versioned CSV column mapping of one account’s Meta, X or Snapchat catalog.',
      ['gateway', 'account_id', 'catalog_id'],
      ['connection_id'],
      local,
      'reader',
      [[W, 'save_catalog_mapping']],
    ),
    row(
      'save_catalog_mapping',
      'Saves the next version of an account catalog’s CSV column mapping; its retailer ID column changes only explicitly.',
      ['gateway', 'account_id', 'catalog_id', 'requirements'],
      ['connection_id', 'revision'],
      saves('catalog_mapping_profile'),
      'operator',
      [[W, 'catalog_preview']],
    ),
    row(
      'preview_catalog_removal',
      'Reads 1–50 explicit X products (supplied retailer_ids, or listed product_keys in requirements) and previews their removal for ten minutes.',
      ['gateway', 'account_id', 'catalog_id'],
      ['connection_id', 'retailer_ids', 'products', 'allow_upsert', 'name', 'requirements'],
      reads('x_catalog_removal_preview'),
      'operator',
      [[W, 'create_catalog_removal']],
    ),
    row(
      'create_catalog_removal',
      'Saves one unapproved single-product DELETE step per previewed product; saving deletes nothing. A listed selection also needs confirmed_count.',
      ['preview_id', 'preview_hash', 'confirmed'],
      ['confirmed_count'],
      reads('campaign_run'),
      'operator',
      [[C, 'approval_summary']],
    ),
    row(
      'delete_profile',
      'Deletes a client profile at its current revision.',
      ['id', 'revision', 'confirmed'],
      [],
      saves('client_profile'),
      'operator',
      [[W, 'profiles']],
    ),
    row('briefs', 'Saved client briefs, newest first, with the workspace limit.', [], [], local, 'reader', [
      [W, 'brief'],
    ]),
    row('brief', 'One saved client brief.', ['id'], [], local, 'reader', [[C, 'preview_recipe']]),
    row(
      'save_brief',
      'Saves a client brief ({name, recipe, profile_id?, business}) for recipes to reuse by brief_id.',
      ['brief'],
      ['id', 'revision'],
      saves('client_brief'),
      'operator',
      [[C, 'preview_recipe']],
    ),
    row(
      'delete_brief',
      'Deletes a saved client brief at its current revision.',
      ['id', 'revision', 'confirmed'],
      [],
      saves('client_brief'),
      'operator',
      [[W, 'briefs']],
    ),
    row(
      'history',
      'Bounded audit metadata of changes (never raw requests or receipts), filtered and paged.',
      [],
      ['search', ...scope, 'profile_id', 'limit', 'cursor'],
      local,
      'reader',
      [[W, 'operations']],
      {'limit': {'minimum': 1, 'maximum': 100, 'default': 100}},
    ),
    row('health', 'Owner (or administrator) health summary of jobs, storage and deliveries.', [], [], local, 'admin', [
      [W, 'support_bundle'],
    ]),
    row('support_bundle', 'The owner’s metadata-only operations bundle for support.', [], [], local, 'owner', [
      [W, 'health'],
    ]),
    row(
      'save_spend_policy',
      'Saves the owner spending policy for the workspace or one account (expected_revision guards against a stale read).',
      ['policy', 'confirmed'],
      ['scope', 'gateway', 'account_id', 'connection_id', 'expected_revision'],
      saves('spend_policy'),
      'owner',
      [[W, 'dashboard']],
    ),
    row(
      'save_retention',
      'Sets how many days (7–365) report records are kept, and optionally when archived campaign plans are deleted.',
      ['confirmed'],
      ['days', 'archived_campaign_plans_days'],
      saves('retention_policy'),
      'owner',
      [[W, 'health']],
      {'days': {'minimum': 7, 'maximum': 365}, 'archived_campaign_plans_days': {'note': '0, or 7–3650.'}},
    ),
    row(
      'save_plan_policy',
      'Sets whether a plan that changes spending or activates a launch needs an approver other than its owner.',
      ['require_distinct_approver', 'confirmed'],
      [],
      saves('plan_policy'),
      'owner',
      [[W, 'health']],
    ),
    row(
      'pause_writes',
      'Pauses every reviewed write of the workspace, with a reason; pause_scope narrows it to advertising writes or to provider report and export jobs.',
      ['reason', 'confirmed'],
      ['pause_scope'],
      saves('write_pause'),
      'owner',
      [[W, 'resume_writes']],
    ),
    row('resume_writes', 'Resumes reviewed writes.', ['confirmed'], [], saves('write_pause'), 'owner', [
      [W, 'dashboard'],
    ]),
    // The handler (src/personal-data-access.ts) finds the account through its connection, which it requires, and takes the
    // gateway from it: the gateway an earlier row required is accepted and not used.
    row(
      'enable_personal_data',
      'Turns personal-data writes (customer lists) on for one ad account of a connection.',
      ['connection_id', 'account_id', 'confirmed'],
      ['gateway'],
      saves('personal_data_setting'),
      'owner',
      [[X, 'inspect']],
      {'gateway': {note: 'Not needed: the connection names the gateway.'}},
    ),
    row(
      'disable_personal_data',
      'Turns personal-data writes off for one ad account.',
      ['gateway', 'account_id', 'confirmed'],
      ['connection_id'],
      saves('personal_data_setting'),
      'owner',
      [[W, 'dashboard']],
    ),
    row(
      'save_ga4_test_property',
      'Marks (enabled true) or unmarks one GA4 property as a test property, which the realtime test-identity read requires; nothing changes in GA4.',
      ['connection_id', 'account_id', 'enabled', 'confirmed'],
      [],
      saves('ga4_test_property'),
      'owner',
      [[W, 'measurement_event_identity']],
    ),
  ],
  [C]: [
    helpRow(),
    row(
      'create',
      'Saves a campaign dependency plan from a name and explicit native steps or an approved template; the brief is optional.',
      ['name'],
      [
        'brief',
        'steps',
        'gateway',
        'connection_id',
        'account_id',
        'profile_id',
        'template',
        'variables',
        'idempotency_key',
        'acknowledge_temporary_sources',
        'allocation_preview_id',
        'allocation_preview_hash',
        'consent_preview_id',
        'consent_preview_hash',
        'catalog_binding',
        'search_exclusion_preview_id',
        'search_exclusion_preview_hash',
        'id',
        'expected_revision',
        'confirmed',
        'detail',
      ],
      saves('campaign_run'),
      'operator',
      [
        [C, 'preflight'],
        [C, 'approval_summary'],
      ],
    ),
    row(
      'get',
      'One plan, compact; step_id returns one step without its request body, topic reads one part of it, detail:"full" the whole plan.',
      ['id'],
      ['step_id', 'detail', 'topic', 'query', 'cursor'],
      local,
      'reader',
      [[C, 'prepare_next']],
    ),
    row(
      'list',
      'Campaign plans you own, administer or collaborate on, newest first, filtered and paged by next_cursor.',
      [],
      [
        'offset',
        'limit',
        'cursor',
        'state',
        'archived',
        'awaiting_approval',
        'search',
        'gateway',
        'account_id',
        'connection_id',
        'profile_id',
      ],
      local,
      'reader',
      [[C, 'get']],
      {'limit': {'minimum': 1, 'maximum': 100, 'default': 50}},
    ),
    row(
      'archive',
      'Sets aside a complete, cancelled or superseded plan; get still returns it and it leaves the 500-plan bound.',
      ['id', 'confirmed'],
      [],
      saves('campaign_run'),
      'operator',
      [[C, 'list']],
    ),
    row('unarchive', 'Restores an archived plan to the default list.', ['id'], [], saves('campaign_run'), 'operator', [
      [C, 'get'],
    ]),
    row(
      'assign',
      'Lists the members a plan can be shared with; with user_id and role names a viewer, editor or approver.',
      ['id'],
      ['user_id', 'role'],
      saves('campaign_run'),
      'operator',
      [[C, 'get']],
    ),
    row('unassign', 'Removes a collaborator from a plan.', ['id', 'user_id'], [], saves('campaign_run'), 'operator', [
      [C, 'get'],
    ]),
    row(
      'confirm_absent',
      'Reads whether a refused step’s resource exists; with confirmed records that it does not, so recover_step may amend it.',
      ['id', 'step_id'],
      ['confirmed'],
      reads('campaign_run'),
      'operator',
      [[C, 'recover_step']],
    ),
    row(
      'continue_as_new',
      'Carries the steps not yet done into a new linked plan that adopts the verified IDs; the original becomes superseded.',
      ['id', 'confirmed'],
      ['changes'],
      saves('campaign_run'),
      'operator',
      [
        [C, 'get'],
        [C, 'approval_summary'],
      ],
    ),
    row(
      'activation_plan',
      'Drafts a separate linked plan that activates a completed paused launch, with its own approval and gates.',
      ['id'],
      [],
      saves('campaign_run'),
      'operator',
      [
        [C, 'preflight'],
        [C, 'approval_summary'],
      ],
    ),
    row(
      'prepare_next',
      'Prepares the native review of the next step whose predecessors are verified.',
      ['id'],
      ['detail'],
      reads('campaign_run', 'write_review'),
      'operator',
      [[C, 'execute_next']],
    ),
    row(
      'execute_next',
      'Executes that exact review after the user’s approval and reads the result back.',
      ['id', 'review_id', 'confirmed'],
      [
        'idempotency_key',
        'spend_change_confirmed',
        'cap_override_confirmed',
        'creative_edit_confirmed',
        'destructive_confirmed',
        'detail',
        'expected_revision',
      ],
      mutation('campaign_run', 'write_receipt'),
      'operator',
      [
        [C, 'verify'],
        [C, 'prepare_next'],
      ],
    ),
    row(
      'verify',
      'Reads back a completed write (a plan step’s or a single reviewed write’s review_id).',
      ['review_id'],
      [],
      reads('write_verification'),
      'reader',
      [[C, 'get']],
    ),
    row(
      'cancel',
      'Cancels a plan; steps already sent stay as created.',
      ['id'],
      ['confirmed', 'detail'],
      saves('campaign_run'),
      'operator',
      [[C, 'get']],
    ),
    row(
      'validate_provider',
      'Has the provider validate one native request without applying it (where the provider offers validate-only).',
      ['gateway', 'arguments'],
      ['connection_id', 'id', 'step_id'],
      reads(),
      'operator',
      [[X, 'prepare']],
    ),
    row(
      'preflight',
      'Read-only prerequisite checks of every step (ownership, references, destinations).',
      ['id'],
      ['detail'],
      reads('campaign_run'),
      'operator',
      [
        [C, 'approval_summary'],
        [C, 'prepare_next'],
      ],
    ),
    row(
      'recover_step',
      'Amends a blocked or not-sent step in place (patch or corrected arguments); nothing is sent until its new review.',
      ['id', 'step_id'],
      ['patch', 'arguments', 'confirmed', 'detail', 'expected_revision'],
      saves('campaign_run'),
      'operator',
      [[C, 'prepare_next']],
    ),
    row(
      'reconcile_step',
      'Reads a mismatched or uncertain step back; accept_observed with actual_hash accepts the observed state.',
      ['id', 'step_id'],
      ['accept_observed', 'actual_hash', 'confirmed', 'detail'],
      reads('campaign_run'),
      'operator',
      [[C, 'get']],
    ),
    // R2.5 field3 (AMCP-07): the summary as a read. Its effects are local: nothing is saved, audited or sent, and no preflight runs.
    row(
      'approval_summary',
      'Read-only: what one approval covers, from the plan and its stored preflight; saves and sends nothing and records no approval.',
      ['id'],
      ['step_id'],
      local,
      'reader',
      [[C, 'approve']],
    ),
    row(
      'approve',
      'Returns what one approval covers; with confirmed, plan_hash and summary_hash it records the approval.',
      ['id'],
      ['confirmed', 'plan_hash', 'summary_hash', 'step_id', 'spend_change_confirmed', 'detail'],
      saves('campaign_run'),
      'operator',
      [[C, 'run']],
    ),
    row(
      'run',
      'Prepares, executes and reads back every step under the plan’s approval, stopping for anything that needs a person; each stop carries run.progress. A progressToken reports each settled step.',
      ['id'],
      ['detail'],
      mutation('campaign_run', 'write_review', 'write_receipt'),
      'operator',
      [
        [C, 'run'],
        [C, 'get'],
      ],
    ),
    row(
      'run_background',
      'Queues an approved plan of media uploads to run on the server; get shows its progress. A progressToken reports it for up to 25 s; a client declaring the tasks extension is answered a task.',
      ['id'],
      ['detail'],
      mutation('campaign_run', 'media_review', 'media_receipt'),
      'operator',
      [[C, 'get']],
    ),
    row('recipes', 'The guided campaign recipes.', [], [], local, 'reader', [[C, 'recipe_context']]),
    // AMCP-06 (R2.5 field3, package r25-field3-recipes): account_id and connection_id narrow the accounts to the one the call works on, gateway is
    // checked against the recipe's, and detail:"full" returns every field of the accounts a default call lists as IDs alone (the v2 profile).
    row(
      'recipe_context',
      'One recipe’s inputs and accepted values, its accounts and the defaults an approved profile supplies; account_id narrows them to one account, connection_id to one login’s accounts.',
      ['recipe'],
      ['profile_id', 'account_id', 'connection_id', 'gateway', 'detail'],
      local,
      'reader',
      [[C, 'recipe_eligibility']],
    ),
    row(
      'recipe_eligibility',
      'Checks a brief (recipe or brief_id) without saving a plan; live:true adds read-only account prerequisites.',
      [],
      [
        'recipe',
        'brief_id',
        'apply_playbook_rules',
        'business',
        'profile_id',
        'live',
        'account_id',
        'connection_id',
        'gateway',
      ],
      reads('recipe_eligibility'),
      'reader',
      [[C, 'preview_recipe']],
    ),
    row(
      'recipe_lookup',
      'Google country or language constants by name or code; microsoft_location: Microsoft location IDs by name, or 1–100 IDs, from its geographical locations file (bounded reads).',
      ['query', 'lookup_kind'],
      ['account_id', 'connection_id'],
      reads(),
      'reader',
      [[C, 'preview_recipe']],
    ),
    row(
      'preview_recipe',
      'Compiles a recipe (or a saved brief_id) and brief into steps locally; nothing is saved.',
      [],
      ['recipe', 'brief_id', 'apply_playbook_rules', 'business', 'profile_id'],
      local,
      'reader',
      [[C, 'create_from_recipe']],
    ),
    row(
      'create_from_recipe',
      'Saves the compiled recipe (or a saved brief_id) as a draft plan; eligibility_ref reuses a matching live check.',
      [],
      [
        'recipe',
        'brief_id',
        'apply_playbook_rules',
        'eligibility_ref',
        'business',
        'profile_id',
        'idempotency_key',
        'acknowledge_temporary_sources',
        'detail',
      ],
      saves('campaign_run'),
      'operator',
      [[C, 'preflight']],
    ),
    row(
      'clone',
      'Copies an existing Snapchat, Google Search, TikTok or LinkedIn campaign into a paused draft plan.',
      ['gateway', 'account_id', 'source', 'name'],
      ['connection_id', 'changes', 'atomic', 'brief', 'idempotency_key', 'detail'],
      reads('campaign_run'),
      'operator',
      [[C, 'approval_summary']],
    ),
  ],
  [R]: [
    helpRow(),
    row(
      'capture',
      'A bounded native read kept with its source hash, under declared semantics and a metric mapping.',
      ['gateway', 'arguments', 'semantics', 'mapping'],
      ['connection_id', 'account_id', 'campaign_id', 'rows_pointer'],
      reads('decision_report'),
      'reader',
      [[R, 'analyze']],
    ),
    row(
      'capture_presets',
      'The guided report presets; with connection_id and account_id together, also the capture target of that account.',
      [],
      ['connection_id', 'account_id'],
      local,
      'reader',
      [[R, 'capture_preset']],
    ),
    row(
      'capture_preset',
      'Captures one guided Google, Meta, LinkedIn, TikTok or Snapchat report.',
      ['preset', 'account_id', 'semantics'],
      [
        'connection_id',
        'campaign_id',
        'result_action_type',
        'attribution_windows',
        'swipe_up_attribution_window',
        'view_attribution_window',
      ],
      reads('decision_report'),
      'reader',
      [[R, 'analyze']],
    ),
    row(
      'overview_sources',
      'The source groups of a completed Overview snapshot, with no provider request.',
      ['id'],
      [],
      local,
      'reader',
      [[R, 'capture_overview']],
    ),
    row(
      'capture_overview',
      'Keeps one Overview source group as analysable evidence, with no provider request.',
      ['id', 'group_id'],
      [],
      saves('decision_report'),
      'reader',
      [[R, 'analyze']],
    ),
    row(
      'get',
      'One captured report with a page of rows (row_query searches them) and its xlsx_path.',
      ['id'],
      ['row_query', 'offset', 'limit'],
      local,
      'reader',
      [[R, 'analyze']],
      {'limit': {'default': 50}},
    ),
    row(
      'list',
      'Captured reports, filtered and paged.',
      [],
      ['search', ...scope, 'preset', 'cursor', 'offset', 'limit'],
      local,
      'reader',
      [[R, 'get']],
      {'limit': {'default': 30, 'note': 'offset must be 0.'}},
    ),
    row(
      'reconcile',
      'Compares a captured report with a declared reference.',
      ['id', 'reference'],
      ['options'],
      local,
      'reader',
      [[R, 'get']],
    ),
    row(
      'reconcile_report',
      'Compares a captured report with another retained report.',
      ['id', 'reference_id'],
      ['options'],
      local,
      'reader',
      [[R, 'get']],
    ),
    row(
      'analyze',
      'Pacing, anomaly, fatigue and search-waste recommendations from retained evidence.',
      ['id'],
      ['baseline_id', 'options'],
      local,
      'reader',
      [[R, 'allocation_candidates']],
    ),
    row(
      'combine',
      'Combines compatible captured reports (same currency, timezone, attribution and definition).',
      ['ids'],
      ['id', 'options'],
      saves('decision_report'),
      'reader',
      [[R, 'analyze']],
    ),
    row('scenarios', 'Budget scenarios from a linear sensitivity model.', ['id', 'options'], [], local, 'reader', [
      [R, 'allocation'],
    ]),
    row(
      'allocation_candidates',
      'Entities of a report that a budget allocation could change.',
      ['id'],
      ['options', 'offset', 'limit'],
      local,
      'reader',
      [[R, 'preview_allocation_plan']],
      {'limit': {'default': 20}},
    ),
    row(
      'calibrate_allocation',
      'Calibrates allocation efficiency from comparable retained reports.',
      ['id', 'ids'],
      ['options'],
      local,
      'reader',
      [[R, 'allocation']],
    ),
    row(
      'allocation',
      'A constrained allocation proposal; never a budget change.',
      ['id', 'options'],
      [],
      local,
      'reader',
      [[R, 'preview_allocation_plan']],
    ),
    row(
      'preview_allocation_plan',
      'Reads current budgets and previews the allocation as draft steps.',
      ['id', 'options'],
      ['conversion'],
      reads('allocation_preview'),
      'operator',
      [[R, 'create_allocation_plan']],
    ),
    row(
      'create_allocation_plan',
      'Saves the previewed allocation as an unapproved campaign plan.',
      ['id', 'preview_id', 'preview_hash', 'confirmed'],
      [],
      reads('campaign_run'),
      'operator',
      [[C, 'approval_summary']],
    ),
    row(
      'allocation_outcome',
      'The outcome review of a verified allocation plan (id): its closed-period window, state and, once captured, realized results beside the proposal.',
      ['id'],
      [],
      saves('allocation_outcome'),
      'reader',
      [[R, 'capture_allocation_outcome']],
    ),
    row(
      'capture_allocation_outcome',
      'After the outcome window closes, captures the same entities with the proposal’s guided preset and saves the observational comparison.',
      ['id'],
      [],
      reads('decision_report', 'allocation_outcome'),
      'reader',
      [[R, 'calibrate_allocation']],
    ),
    row(
      'search_exclusion_candidates',
      'Search terms of a Google report that could be excluded.',
      ['id'],
      ['options', 'offset', 'limit'],
      local,
      'reader',
      [[R, 'preview_search_exclusions']],
      {'limit': {'default': 50}},
    ),
    row(
      'preview_search_exclusions',
      'Reads the original ad groups and previews exact-negative exclusions.',
      ['id', 'ids'],
      ['options'],
      reads('search_exclusion_preview'),
      'operator',
      [[R, 'create_search_exclusion_plan']],
    ),
    row(
      'create_search_exclusion_plan',
      'Saves the previewed exclusions as an unapproved campaign plan.',
      ['id', 'preview_id', 'preview_hash', 'confirmed'],
      [],
      reads('campaign_run'),
      'operator',
      [[C, 'approval_summary']],
    ),
    row(
      'serving_diagnostics',
      'Google primary status, reasons, policy summary and ad strength per level; native symbols, unknowns listed.',
      ['account_id', 'connection_id'],
      ['gateway', 'campaign_id', 'options'],
      reads(),
      'reader',
      [[W, 'portfolio']],
    ),
    row(
      'launch_check',
      'Rule checks of a guided Meta or Snapchat launch from native reads and an optional retained capture.',
      ['id'],
      ['reference_id'],
      reads(),
      'reader',
      [[R, 'capture_preset']],
    ),
  ],
  [O]: [
    helpRow(),
    row(
      'bootstrap',
      'Accounts, metrics, entity levels, saved reports, schedules and destinations for building a report.',
      [],
      ['profile_id'],
      local,
      'reader',
      [[O, 'run']],
    ),
    row(
      'preview_schedule',
      'The next three deliveries of a saved or proposed schedule, with each source’s window.',
      [],
      ['id', 'schedule', 'config'],
      local,
      'reader',
      [[O, 'schedule']],
    ),
    row(
      'report_pack',
      'A snapshot’s summary, source evidence and PDF/XLSX download paths.',
      ['id'],
      [],
      local,
      'reader',
      [[O, 'export']],
    ),
    row(
      'save_presentation',
      'Saves a snapshot’s presentation: brand name, accent colour, footer, layout (standard or compact) and file language.',
      ['id', 'presentation', 'presentation_revision', 'confirmed'],
      [],
      saves('report_presentation'),
      'operator',
      [[O, 'report_pack']],
    ),
    row(
      'presentation_profiles',
      'Client profiles whose report presentation can apply to a snapshot.',
      ['id'],
      ['offset', 'limit'],
      local,
      'reader',
      [[O, 'apply_profile_presentation']],
      {'limit': {'minimum': 1, 'maximum': 100, 'default': 30}},
    ),
    row(
      'apply_profile_presentation',
      'Applies a client profile’s report presentation to a snapshot.',
      ['id', 'profile_id', 'profile_revision', 'presentation_revision', 'confirmed'],
      [],
      saves('report_presentation'),
      'operator',
      [[O, 'report_pack']],
    ),
    row(
      'save',
      'Saves a named client report definition (edits need expected_revision).',
      ['config', 'confirmed'],
      ['id', 'name', 'expected_revision', 'view_id', 'expected_view_revision'],
      saves('overview_view'),
      'operator',
      [[O, 'run']],
    ),
    row(
      'save_template',
      'Saves a reusable report template.',
      ['config', 'confirmed'],
      ['id', 'name', 'expected_revision'],
      saves('overview_template'),
      'operator',
      [[O, 'save']],
    ),
    row(
      'delete_template',
      'Deletes a report template at its revision.',
      ['id', 'confirmed'],
      ['expected_revision'],
      saves('overview_template'),
      'operator',
      [[O, 'bootstrap']],
    ),
    row(
      'delete_view',
      'Deletes a saved report definition at its revision.',
      ['id', 'confirmed'],
      ['expected_revision', 'expected_view_revision'],
      saves('overview_view'),
      'operator',
      [[O, 'bootstrap']],
    ),
    row(
      'delete_report',
      'Deletes a report snapshot, releasing its unconfirmed Sheets deliveries as resolution says.',
      ['id', 'confirmed'],
      ['expected_revision', 'resolution'],
      saves('overview_report'),
      'operator',
      [[O, 'list']],
    ),
    row(
      'update_schedule',
      'Changes a delivery schedule’s settings.',
      ['id', 'schedule', 'confirmed'],
      ['config', 'destination_id', 'view_id', 'expected_revision', 'expected_view_revision'],
      saves('overview_schedule'),
      'operator',
      [[O, 'preview_schedule']],
    ),
    row(
      'remove_schedule',
      'Removes a delivery schedule; its snapshots stay.',
      ['id', 'confirmed'],
      ['expected_revision'],
      saves('overview_schedule'),
      'operator',
      [[O, 'bootstrap']],
    ),
    row(
      'run',
      'Queues a bounded native report snapshot of a saved definition (id) or a config; compare:previous_period also queues the equal previous window as its paired baseline.',
      ['confirmed'],
      ['id', 'config', 'compare'],
      reads('overview_report'),
      'operator',
      [[O, 'get']],
    ),
    row(
      'compare',
      'Compares a finished snapshot with an earlier equal-length snapshot (baseline_id, or its previous-period pair): exact deltas for matching entities, with no provider request.',
      ['id'],
      ['baseline_id', 'offset', 'limit'],
      local,
      'reader',
      [[R, 'capture_overview']],
      {'limit': {'minimum': 1, 'maximum': 500, 'default': 100}},
    ),
    row(
      'compare_candidates',
      'Retained snapshots that could be the baseline of a snapshot, each with the rules it fails.',
      ['id'],
      ['offset', 'limit'],
      local,
      'reader',
      [[O, 'compare']],
      {'limit': {'minimum': 1, 'maximum': 100, 'default': 50}},
    ),
    row(
      'get',
      'One snapshot with a page of rows, its exports and deliveries; platform, level, entity and query narrow the rows.',
      ['id'],
      ['offset', 'limit', 'include', 'platform', 'level', 'entity', 'query', 'cursor'],
      local,
      'reader',
      [[O, 'report_pack']],
      {'limit': {'minimum': 1, 'maximum': 500, 'default': 100}},
    ),
    row(
      'list',
      'Report snapshots you can access, newest first; client, platform and state narrow them.',
      [],
      ['offset', 'limit', 'client', 'platform', 'state', 'cursor'],
      local,
      'reader',
      [[O, 'get']],
      {'limit': {'minimum': 1, 'maximum': 100, 'default': 50}},
    ),
    row(
      'export',
      'Exports a snapshot to its Google Sheets tab (replacing only the AMCP-owned tab) or to retained files. Poll export_status; a progressToken reports progress for 25 s; the tasks extension gets a task.',
      ['report_id', 'destination_id', 'confirmed'],
      ['idempotency_key'],
      effects('none', ['overview_export'], {remote_writes: true}),
      'operator',
      [[O, 'export_status']],
    ),
    row(
      'schedule',
      'Creates a recurring delivery of a saved report.',
      ['schedule', 'confirmed'],
      ['id', 'config', 'destination_id', 'view_id', 'expected_view_revision', 'idempotency_key'],
      saves('overview_schedule'),
      'operator',
      [[O, 'preview_schedule']],
    ),
    row(
      'pause_schedule',
      'Pauses a schedule.',
      ['id', 'confirmed'],
      ['expected_revision'],
      saves('overview_schedule'),
      'operator',
      [[O, 'resume_schedule']],
    ),
    row(
      'delete_schedule',
      'Legacy alias that pauses a schedule.',
      ['id', 'confirmed'],
      ['expected_revision'],
      saves('overview_schedule'),
      'operator',
      [[O, 'remove_schedule']],
    ),
    row(
      'resume_schedule',
      'Resumes a paused schedule.',
      ['id', 'confirmed'],
      ['expected_revision'],
      saves('overview_schedule'),
      'operator',
      [[O, 'preview_schedule']],
    ),
    row(
      'retry',
      'Retries a failed or cancelled report, Sheets export or file export job.',
      ['id', 'confirmed'],
      [],
      effects('read_only', ['overview_report', 'overview_export'], {remote_writes: true}),
      'operator',
      [[O, 'export_status']],
    ),
    row(
      'cancel',
      'Cancels a queued or running report or export job.',
      ['id', 'confirmed'],
      [],
      saves('overview_report'),
      'operator',
      [[O, 'get']],
    ),
    row(
      'create_spreadsheet',
      'Creates a Google spreadsheet for delivery and binds it as a destination.',
      ['connection_id', 'confirmed', 'name', 'idempotency_key'],
      ['tab_name'],
      effects('none', ['sheets_destination'], {remote_writes: true}),
      'admin',
      [[O, 'export']],
    ),
    row(
      'bind_destination',
      'Binds an existing editable Google spreadsheet tab as a destination.',
      ['connection_id', 'confirmed'],
      ['spreadsheet_id', 'spreadsheet_url', 'tab_name', 'name', 'idempotency_key'],
      effects('none', ['sheets_destination'], {remote_writes: true}),
      'operator',
      [[O, 'export']],
      {'tab_name': {'maxLength': 80, 'default': 'AMCP Overview'}},
    ),
    row(
      'bind_file_destination',
      'Binds an encrypted local PDF/XLSX file destination.',
      ['file_destination', 'idempotency_key', 'confirmed'],
      [],
      saves('report_file_destination'),
      'operator',
      [[O, 'export']],
    ),
    row('export_status', 'One export’s state, outcome and retry availability.', ['id'], [], local, 'reader', [
      [O, 'retry'],
    ]),
    row(
      'resolve_delivery',
      'Checks, resends or abandons the unconfirmed Sheets delivery of a destination; resend and abandon open after its settle window.',
      ['destination_id', 'resolution', 'confirmed'],
      ['delivery_id'],
      // check rereads the tab’s delivery marker (a Google Sheets read); resend requeues the export that writes the tab.
      effects('read_only', ['sheets_delivery'], {remote_writes: true}),
      'operator',
      [[O, 'export_status']],
    ),
    row(
      'preview_workbook_move',
      'Dry run of moving a local workbook schedule into an Overview report and schedule, with usable report tabs and blockers.',
      ['id'],
      ['destination_id'],
      local,
      'reader',
      [[O, 'move_workbook_schedule']],
    ),
    row(
      'move_workbook_schedule',
      'Creates the previewed Overview report and schedule and pauses the local workbook schedule; its query is unchanged.',
      ['id', 'destination_id', 'move_version', 'confirmed'],
      [],
      saves('overview_view', 'overview_schedule', 'workbook_schedule'),
      'operator',
      [[O, 'undo_workbook_move']],
    ),
    row(
      'undo_workbook_move',
      'Pauses the Overview schedule a workbook move created and restores the local workbook schedule.',
      ['id', 'confirmed'],
      [],
      saves('overview_schedule', 'workbook_schedule'),
      'operator',
      [[W, 'report_schedule']],
    ),
  ],
  [M]: [
    helpRow(),
    row(
      'prepare',
      'Fetches and encrypts the exact file for a five-minute upload review.',
      ['platform', 'account_id'],
      [
        'connection_id',
        'source_id',
        'source_url',
        'drive_url',
        'drive_connection_id',
        'variant_id',
        'expected_sha256',
        'expected_mime',
        'expected_size',
        'fit_to_platform',
        'reuse_existing',
        'existing_media_id',
        'name',
        'media_type',
        'owner_urn',
        'dv360_target',
        'synthetic_content',
      ],
      saves('media_review'),
      'operator',
      [[M, 'execute']],
    ),
    row(
      'prepare_library',
      'Prepares the review of a library asset’s retained original.',
      ['review_id'],
      [],
      saves('media_review'),
      'operator',
      [[M, 'execute']],
    ),
    row(
      'execute',
      'Uploads the frozen bytes after the user’s explicit confirmation.',
      ['review_id', 'confirmed'],
      ['idempotency_key'],
      mutation('media_receipt'),
      'operator',
      [[M, 'status']],
    ),
    row(
      'resume',
      'Continues an interrupted upload within its original review; never an uncertain part.',
      ['review_id', 'confirmed'],
      ['idempotency_key'],
      mutation('media_receipt'),
      'operator',
      [[M, 'status']],
    ),
    row(
      'execute_async',
      'Queues the confirmed upload as a job.',
      ['review_id', 'confirmed'],
      ['idempotency_key'],
      mutation('media_receipt'),
      'operator',
      [[M, 'job_status']],
    ),
    row('job_status', 'The queued upload’s job state.', ['review_id'], [], local, 'reader', [[M, 'status']]),
    row('status', 'Reads provider processing of an uploaded file.', ['review_id'], [], reads(), 'reader', [
      [M, 'recovery'],
    ]),
    row(
      'recovery',
      'The retained record of an interrupted or uncertain upload and what may continue it.',
      ['review_id'],
      [],
      local,
      'reader',
      [[M, 'resume']],
    ),
    row(
      'cancel',
      'Cancels a review that has not been executed.',
      ['review_id'],
      ['confirmed'],
      saves('media_review'),
      'operator',
      [[M, 'list']],
    ),
    row(
      'variant',
      'Creates a converted copy (preset, fit) of an original for review.',
      ['preset'],
      ['source_id', 'source_url', 'drive_url', 'drive_connection_id', 'fit'],
      saves('media_variant'),
      'operator',
      [[M, 'prepare']],
    ),
    row(
      'inspect_eligibility',
      'Checks a file against a placement preset before any upload; nothing is kept.',
      ['preset'],
      ['source_id', 'source_url', 'drive_url', 'drive_connection_id', 'variant_id'],
      local,
      'operator',
      [[M, 'variant']],
    ),
    row(
      'retain_source',
      'Keeps an imported link or Drive original beyond its 30-minute window (workspace owner).',
      ['source_id', 'expected_sha256', 'confirmed'],
      [],
      saves('media_source'),
      'owner',
      [[M, 'list']],
    ),
    row(
      'remove_source',
      'Removes a retained original (workspace owner).',
      ['source_id', 'expected_sha256', 'confirmed'],
      [],
      saves('media_source'),
      'owner',
      [[M, 'list']],
    ),
    row(
      'list',
      'Upload receipts, recovery reviews, variants, presets and website sources.',
      [],
      ['platform', 'account_id', 'connection_id', 'profile_id', 'offset', 'limit', 'recovery_offset', 'include_assets'],
      local,
      'reader',
      [[M, 'plan']],
      {'limit': {'minimum': 1, 'maximum': 100, 'default': 50}},
    ),
    row(
      'library',
      'Account-scoped retained media metadata.',
      [],
      ['platform', 'account_id', 'connection_id', 'profile_id', 'search', 'tag', 'original_sha256', 'cursor', 'limit'],
      local,
      'reader',
      [[M, 'asset']],
      {'limit': {'minimum': 1, 'maximum': 100, 'default': 30}, 'cursor': {'maxLength': 1024}},
    ),
    row(
      'asset',
      'One retained asset with its versions and verified plan usage.',
      ['asset_id'],
      ['cursor', 'limit'],
      local,
      'reader',
      [[M, 'asset_usage']],
    ),
    row(
      'save_asset_metadata',
      'Saves an asset’s name, tags and notes at its revision.',
      ['asset_id', 'metadata', 'revision', 'confirmed'],
      [],
      saves('creative_asset'),
      'operator',
      [[M, 'asset']],
    ),
    row(
      'asset_performance',
      'Retained ad performance compatible with an asset (plan_id, report_id).',
      ['asset_id'],
      ['plan_id', 'report_id', 'cursor', 'offset', 'limit'],
      local,
      'reader',
      [[M, 'asset']],
      {'limit': {'minimum': 1, 'maximum': 100, 'default': 30}},
    ),
    row(
      'asset_usage',
      'Current Meta, Google image or Snapchat references to an uploaded asset, through an explicit reference_view.',
      ['asset_id'],
      ['reference_view', 'limit', 'cursor'],
      reads(),
      'reader',
      [[M, 'asset']],
      {'limit': {'default': 50, 'note': 'Meta 1–100; Google and Snapchat 1–1000.'}},
    ),
    row(
      'reuse',
      'Reuses an existing upload receipt in an accessible account instead of uploading again.',
      ['asset_id'],
      ['platform', 'account_id', 'connection_id'],
      local,
      'reader',
      [[M, 'asset']],
    ),
    row(
      'plan',
      'Per-account variants and review steps for sending one source to 1–20 accounts.',
      ['source_id', 'destinations'],
      ['fit_to_platform', 'stage_fits'],
      saves('media_variant'),
      'operator',
      [[M, 'prepare']],
    ),
  ],
  [X]: [
    helpRow(),
    row(
      'inspect',
      'Checks local reviewed-write contract support for the exact native arguments, with no credentials, request or save.',
      ['gateway', 'arguments'],
      ['connection_id', 'evidence', 'people', 'personal_data'],
      local,
      'reader',
      [[X, 'prepare']],
    ),
    row(
      'prepare',
      'Reads current state and freezes the request into a five-minute, actor-bound review with before_state, impact and spend.',
      ['gateway', 'arguments'],
      [
        'connection_id',
        'evidence',
        'people',
        'personal_data',
        'provider_check',
        'creative_edit_confirmed',
        'supersedes_review_id',
      ],
      reads('write_review'),
      'operator',
      [[X, 'execute']],
    ),
    row(
      'execute',
      'Sends the reviewed mutation once, after the user’s explicit approval, and reads it back for a few seconds before it answers; a read-back not done by then stays queued.',
      ['review_id', 'confirmed'],
      [
        'idempotency_key',
        'spend_change_confirmed',
        'cap_override_confirmed',
        'creative_edit_confirmed',
        'destructive_confirmed',
        'people',
        'gateway',
        'connection_id',
        'arguments',
        'evidence',
      ],
      mutation('write_receipt', 'write_verification'),
      'operator',
      [
        [C, 'verify'],
        [X, 'status'],
      ],
      {
        'idempotency_key': {'note': 'Defaults to the review_id; any other value is refused.'},
        // r25-m4b-smartpush, S2-2 of the lead's second review: a review that holds a secret-like value kept only its digest, so the one
        // call that sends the value again is a call of this action (`heldValues` in src/write-review.ts). Without this entry every such
        // apply drew ARGUMENT_NOT_USED_BY_ACTION, and `actionArguments:"enforce"` refused it before the action ran.
        'arguments': {
          'note':
            'execute: only for a review that holds a secret-like value, such as a TikTok authorization code that prepare kept as a digest. Send the value again, alone in payload or inside the arguments that prepared the review. Any other review refuses arguments.',
        },
      },
    ),
    row(
      'status',
      'Reads a retained review back without a provider request: its state, claim, receipt, read-back and next call.',
      ['review_id'],
      ['evidence'],
      local,
      'reader',
      [
        [X, 'reconcile'],
        [X, 'execute'],
      ],
    ),
    row(
      'reconcile',
      'Checks an uncertain write with read-only provider lookups, never sending it again; accept_applied records what it saw.',
      ['review_id'],
      ['accept_applied', 'reconciliation_id', 'evidence'],
      reads('write_reconciliation', 'write_receipt'),
      'operator',
      [
        [X, 'status'],
        [X, 'prepare'],
      ],
    ),
  ],
  [P]: [
    helpRow(),
    row(
      null,
      'Bounded native previews of existing ads; nothing is saved.',
      ['platform', 'account_id'],
      ['connection_id', 'ad_ids', 'limit', 'ad_format', 'statuses', 'campaign_ids', 'adset_ids', 'cursor'],
      reads(),
      'reader',
    ),
  ],
};
/**
 * The argument notes moved out of tools/list (MCP-07): per tool, what an argument means for the actions that use it.
 * They ride along in each action's argumentsSchema, where the action reads them.
 */
const argumentNotes: Record<string, Record<string, string>> = {
  [W]: {
    brief:
      'save_brief: {name, recipe, profile_id?, business}, a saved client brief that preview_recipe, recipe_eligibility and create_from_recipe reuse with brief_id (amcp_campaign).',
    archived_campaign_plans_days:
      'save_retention: delete campaign plans archived longer than this many days (7–3650); 0 turns it off.',
    require_distinct_approver:
      'save_plan_policy: true makes a plan that changes spending or activates a launch need an approver other than its owner.',
    expected_revision:
      'save_spend_policy: the revision of the stored policy you read (0 when none). A stale one is refused with REVISION_CONFLICT; without it the save replaces the stored policy and says so.',
    state:
      'operations: ' +
      operationStates.join(', ') +
      '; incidents: all, open, acknowledged, snoozed, resolved, superseded; monitors: all, active, paused; report_bindings: active (default), retired, all.',
    inspect_other_listed_products:
      'catalog_compare only: inspect other bounded listed X products without establishing full store or variant absence.',
    absent_source_policy:
      'catalog_compare only: supplied products do not authorize deleting unselected source inventory.',
    view: 'capabilities: summary (default; at most 25 workflows per page) or graph (the whole dependency graph). dashboard: summary (default) or full (unbounded; the website Overview).',
    sections: 'dashboard only: the bounded detail sections to return instead of the summary.',
    requirements:
      'check: {write, assets, destination_url, native_request}. program_check live:true: the program’s native request (live:false returns requirements_template). portfolio and portfolio_reconcile: the parent IDs of the entity read. measurement_audit: {container_id, workspace_id}. measurement_events, measurement_event_identity, catalog_source and preview_consent_plan: the inputs their summaries name. ' +
      'catalog_preview, catalog_compare, catalog_plan: {retire_retailer_ids: 1–50 supplied retailer IDs, retire_availability: "out of stock"|"discontinued"} retires existing products through the reviewed update (nothing is deleted). ' +
      'catalog_compare (X): {selection_source:"listed_inventory", product_keys: 1–50 listed native keys} reads only those products; preview_catalog_removal adds the listed_inventory_hash of the inspection they were chosen from. Nothing is ever selected because a source lacks it. ' +
      'catalog_preview, catalog_compare, catalog_plan: {source: {kind:"csv", text, columns:"canonical"|"profile", profile_version?}} instead of products: a CSV of at most 192 KiB and 500 rows that AMCP projects with its own product columns or the catalog’s saved mapping (save_catalog_mapping); the preview returns the supplied_products. ' +
      'catalog_plan: {select_retailer_ids: 1–50 source rows to keep}, {comparison_token: the lineage_token of the catalog_compare its products come from (same person, 15 minutes)}, {chunked: true} saves 51–500 source products as plans of at most 50 in one lineage group (catalog_preview with it validates the parts and saves nothing). ' +
      'save_catalog_mapping: {columns: {field: CSV header}, fixed_currency: "" or one ISO code when no currency column, image_mode: "single"|"first_list", replace_identity_column?: true to change the retailer_id column}.',
    revision:
      'The current revision of the record the action changes, as last read. save_catalog_mapping: the mapping version read (0 before the first save); another current version is refused with CATALOG_MAPPING_CHANGED.',
    confirmed_count:
      'create_catalog_removal: the number of products in the preview, typed back by the person; required for a listed selection.',
    account_ids:
      'check only: up to 20 accounts of one connection_id, checked four at a time with the same requirements and live setting; one result per account.',
  },
  [P]: {
    ad_ids:
      'The ads to preview (Snapchat and LinkedIn: creative IDs; Google Ads: asset group IDs or resource names, or adGroupAds resource names of video ads; X: promoted Tweet IDs or the ID of a dark Tweet). Named IDs ignore statuses. Without IDs, the first `limit` matching active ads.',
    campaign_ids: 'Campaign IDs; LinkedIn campaign group IDs, as in reporting.',
    adset_ids: 'Ad set or ad group IDs; Snapchat ad squad IDs; LinkedIn native campaign IDs; X line item IDs.',
    ad_format: 'Meta only: the placement to preview.',
  },
  [C]: {
    steps: stepsNote,
    // R2.5 field fix (call shape, 2026-11-19): create takes the three once, at its top level, as the default of the steps that leave
    // them out (a media step takes the connection and the account only); clone and list read the same names for their own sake.
    gateway:
      'create: the native gateway of every write step that leaves its own out, used only when no step names another, and when its value fits its field. clone: the gateway of the campaign to copy. list: only plans with a step on this gateway.',
    connection_id:
      'create: the connection of every step that leaves its own out (a media step only when its platform is the gateway given at the top level, or none is), used only when no step names another, and when its value fits its field. clone: the connection that holds the login of that account, when it has more than one. list: only plans with a step through this connection.',
    account_id:
      'create: the account of every step that leaves its own out (a media step only when its platform is the gateway given at the top level, or none is), used only when no step names another, and when its value fits its field. clone: the account of the campaign to copy. list: only plans with a step on this account.',
    brief:
      'create: optional, up to 12,000 characters, the purpose of the plan. Left out, it defaults to name (R2.5 T4, owner 2026-11-15); a brief that is sent is saved as sent. clone: optional; left out, it says which campaign the plan copies.',
    acknowledge_temporary_sources:
      'create: true when media steps use temporary files (source_id src-…, an upload or import not retained), deleted 30 minutes after they started; the plan then records and shows their deadline. Without it such a plan is refused.',
    detail:
      'compact (default): the plan header, one row per step, the step this call acted on and the next call, within 12 KB. full: the whole stored plan, as get returns it with this value. get with step_id: compact (default) is the step without its request body, within 12 KB; full is the step whole when it is 25 KB or less (a larger one comes as the compact view with full_omitted_bytes).',
    plan_hash: 'approve with confirmed: the plan_hash of the summary the user approved.',
    spend_change_confirmed:
      'approve with confirmed: the user authorizes the spend effect of every step the summary names in spend_steps, once; run then asks for nothing more for them. A plan approved without it stops once at its first such step, and that stop’s next_call approves the same plan and summary again with it. execute_next: the user approved this one step’s spending, only when its execute_requirements list it.',
    catalog_binding:
      'create, internal: set only by the guarded catalog saves of amcp_workspace (create_catalog_removal and catalog_plan), naming the binding they just stored; any other value is refused.',
    summary_hash:
      'approve with confirmed: the summary_hash of the summary the user was shown (approval_summary returns it, and takes none). A step with many fields is aggregated (truncated: true); approval_summary with its step_id lists every field.',
    accept_observed:
      'reconcile_step: the user accepts the state a mismatched step reads back as its result, with actual_hash. Sends nothing to the provider; audited.',
    actual_hash: 'reconcile_step with accept_observed: the observed state hash accepted.',
    atomic:
      'clone (Google): true (the default) makes the copy one all-or-nothing step, a single googleAds:mutate; false keeps one step per resource type.',
    // The keys after campaign_id are Google Search's (field fix r25-field-gclone, owner 2026-11-19: copy only the ad groups
    // named); the contract's note is served by help, and tools/list carries none.
    source:
      'clone: {campaign_id} of the campaign to copy, in the account_id named. Google Search only, optional: ad_group_ids (1–1,000 numeric ad group IDs) copies only those ad groups of the campaign, and languages (1–100 language constants such as languageConstants/1000 that the campaign targets) only those languages; locations and negative keywords are copied as before. An ID or language the campaign does not have is refused CLONE_SOURCE_NOT_FOUND (details.missing); other platforms refuse both keys with CLONE_UNSUPPORTED. Ad groups are numbered in ID order (adgroup_1 is the lowest ID); clone.ad_groups in the answer maps each step to its source ad group. Any other key of source is ignored; for Google Search it is named in meta.argument_warnings.',
    changes:
      'clone: {set: [{step_id, path, value}], drop: [step_id]}. set changes one field of a step’s arguments by JSON pointer ("/payload/operations/0/create/amount_micros"); drop leaves a step and its dependants out. continue_as_new: {drop: [step_id]} only, with the same rule: it leaves steps nothing was sent for (pending, or review ready) and their dependants out of the new plan, which needs its own approval; a step that reached the provider blocks the continuation as before.',
    patch:
      'recover_step: [{path, value}] changes to fields the step already has, as JSON pointers into its arguments ("/payload/adsquads/0/pixel_id"). Instead of arguments.',
    arguments:
      'recover_step: the corrected arguments of the step, whole, as the native tool input object {"action","payload"} that steps[].arguments of create holds (help create has a worked example); instead of patch. validate_provider: the native tool input {"action","payload"} of the one request the provider validates without applying it.',
    idempotency_key:
      'create, create_from_recipe and clone: an optional stable key (8–100 letters, digits, hyphens or underscores); identical input reuses the original plan. execute_next: the review’s own key.',
    brief_id:
      'preview_recipe, recipe_eligibility, create_from_recipe: a saved client brief (amcp_workspace save_brief) supplying the recipe, profile_id and business inputs; business sent with the call overrides its fields.',
    apply_playbook_rules:
      'preview_recipe, recipe_eligibility, create_from_recipe: false compiles the brief without the selected playbook naming and UTM rules (applied by default when profile_id is set; the provenance records either choice).',
    eligibility_ref:
      'create_from_recipe: the eligibility_ref of a live recipe_eligibility check of this exact brief; its read-only preflight is reused only while person, playbook revision, inputs, steps, login, account grant and write pause all still match.',
    cursor:
      'list: the next_cursor of the previous page, with the same filters. get with step_id and topic: the next_cursor of the previous page of that part; it continues only that read, of that plan revision, by the same caller (INVALID_CURSOR otherwise).',
    // r25-field3-errors (AMCP-11): the part of a step get reads, and the pointer into it. Both are properties of the tool already, so tools/list is not touched.
    topic:
      'get with step_id: the part of the step to read, as canonical JSON text in pages of at most 24 KB: request (the review’s frozen request), arguments, before_state (the state the review read), receipt (the provider’s reply and receipt) or, for a write group, parts (each part’s review_id, state_hash, request size and current state; query /3 is the fourth part). Credential-shaped values are hidden as in the review, and redacted names where. help: the action to explain.',
    query:
      'get with step_id and topic: a JSON pointer into that part, such as /body/mutate_operations/34 for the operation a field path of an error names; only that subtree is returned. recipe_lookup: the name or code to look up.',
    state: 'list: only plans in this state.',
    archived: 'list: true lists only archived plans (default: plans not archived).',
    awaiting_approval: 'list: true lists the plans naming you as approver that wait for an approval.',
    search: 'list: part of a plan name or account ID, or a plan ID.',
    user_id: 'assign/unassign: the workspace member (account ID) to name or remove.',
    role: 'assign: viewer, editor or approver.',
  },
  [M]: {
    stage_fits:
      'plan: keep each changed file as an encrypted copy until its original expires, so the reviews of this push use it instead of converting again. Off by default: plan stages nothing.',
    original_sha256:
      'library: only receipts uploaded from this exact original (its SHA-256, the asset’s original_sha256), across accounts.',
    recovery_offset: 'list: where the page of unfinished-upload recovery reviews starts; defaults to offset.',
    include_assets: 'list: false leaves the upload receipts out, for a page that shows only recovery and sources.',
    source_id:
      'A website upload/import, or an explicitly owner-retained original; list returns them under sources. Computer uploads and their derived copies share an absolute 30-minute deadline and cannot be retained. Only separately imported link/Drive originals may persist as owner-retained lib- sources.',
    source_url: 'A public HTTPS link to one PNG, JPEG, MP4 or MOV file. AMCP downloads it on the server.',
    destinations: 'plan: the accounts an upload (source_id) would go to.',
    expected_sha256:
      'prepare: refuse unless the file to upload has exactly this SHA-256, as plan returned it. retain_source/remove_source: the exact selected original hash, required with confirmed:true.',
    fit_to_platform:
      'Fit the media to the platform before review: scale it down within 1080 × 1920 (never cropped or enlarged), re-encode an image above the platform limit, convert MOV to MP4 for X and LinkedIn.',
    reference_view:
      'asset_usage: explicit provider-specific native view. Snapchat original image/video receipts use snapchat_top_snap; it reads only literal creative.top_snap_media_id and refuses Google views. Google images use the following independent views. ad_images is the default App/Demand Gen/Responsive Search ad-asset view. performance_max reads configured image asset-group links, not individual ads or campaign-level brand-guideline logos. performance_max_brand separately reads campaign-level LOGO/LANDSCAPE_LOGO links with explicitly enabled brand guidelines and exact Performance Max campaign identity. Campaign links are not ads or asset groups. Each view is independently complete within the selected 1–1000 limit.',
    plan_id: 'asset_performance: the retained verified plan linking this asset to an ad.',
    report_id:
      'asset_performance: an accessible guided Meta ad evidence snapshot from the same account and login. Omit to list compatible snapshots. This joins linked ad IDs, not historical image-level attribution.',
    cursor:
      'Opaque exact-view continuation. library/asset retain their 1024-byte cursor limit; Meta asset_usage permits a bounded encrypted native continuation; Google image and Snapchat top-snap asset_usage refuse any cursor and require complete bounded collections.',
    limit:
      'Google image and Snapchat top-snap asset_usage: complete collection limit 1–1000 (default 50), no cursor. Snapchat counts all examined creatives, with separate 1000-row original-media searches. Meta asset_usage: 1–100 ads per page. Other actions retain their own smaller limits.',
    idempotency_key:
      'Optional at execute: defaults to the review_id. When given it must equal the review_id returned by prepare.',
  },
  [X]: {
    accept_applied:
      'reconcile only: the user accepts that an uncertain write was applied, as the latest reconciliation observed (appears_applied). Records the observed result as its receipt; nothing is sent.',
    reconciliation_id: 'reconcile with accept_applied: the reconciliation_id the user saw.',
    supersedes_review_id:
      'prepare only: an uncertain review that a reconciliation found not applied (appears_not_applied) and that this new review replaces. The old review is never sent.',
    idempotency_key:
      'Optional at execute: defaults to the review_id. When given it must equal the review_id returned by prepare.',
    cap_override_confirmed:
      'The user approved going beyond a spending cap the owner set. Needed at execute only when prepare lists it in execute_requirements.',
    destructive_confirmed:
      'The user approved this deletion, where the owner requires it (WRT-09). Needed at execute only when prepare lists it in execute_requirements.',
    creative_edit_confirmed:
      'Explicitly acknowledge a reviewed X card edit/deletion or Tweet rename that may disrupt promoted ads. Freeze this choice during prepare and repeat it during execute.',
    people:
      'Only for a write that sends data about people (a customer list): {schema: key or keys, rows: one value, or one value per key, per person; hashed: true when every value is already SHA-256 hex}. Sent beside arguments at prepare, and again at execute: AMCP hashes them in memory and keeps only their count and digest.',
    personal_data:
      'prepare only, when adding people: {countries: ISO codes of the people in the list, law (for countries AMCP names no law for), consent_confirmed, platform_terms_confirmed, pdpl (for SA: consent, transfer_abroad, withdrawal_removal)}, confirmed by the uploader.',
    provider_check:
      'prepare only: have the provider validate the request without applying it (Google Ads mutate requests; Meta campaign and ad set creates and edits). Google Ads prepares validate by default, so leave it out there; provider_check:false opts out, and Meta validates only with provider_check:true. The result is in provider_check (default:true marks a check AMCP ran for you; status not_run means the provider could not be asked just now and the review is prepared without it); a request the provider rejects cannot be executed and is prepared again once corrected.',
    evidence:
      'inspect and prepare: "full" includes the provider contract whole; "ref" only what identifies it (versions, review date, write status, version end), with full_contract naming the amcp_tool_help call that returns the rest. Omitted: whole the first time a session inspects or prepares for a gateway, then "ref". execute, status and reconcile accept it and ignore it, so one call shape serves every action of a review.',
    // The `redacted` field of an inspect or prepare answer (P2A-02, P2B-05) is described here, in the help, and not in tools/list.
    arguments:
      'inspect and prepare: the answer shows the request whole except credential-shaped values (a password= or token= pair, a Bearer value, the value of a secret key such as api_key). redacted lists the path of each value hidden, never the value, and is absent when nothing was hidden. prepare shows before_state the same way, and its paths start $["before_state"]. Only the answer hides them: the frozen request keeps every value whole.',
    gateway: 'execute: the review’s own gateway, when sent.',
    connection_id: 'execute: the review’s own connection, when sent.',
  },
  // The rules the tool description carried until F-LEAD-01, each with the action it belongs to.
  [O]: {
    config:
      'A report definition: name, grain, date_range and sources (one account each, with the levels, statuses, ID lists and options bootstrap platforms[].reporting_v4 lists for its platform). A level, status or option a source leaves out takes the default bootstrap lists; a v3 definition (one level, no levels) is still accepted.',
    include:
      'get: native:true returns each row whole with its native fields; lineage:true adds each source’s lineage; charts:true adds the charts a v4 snapshot stores with it (an older snapshot has none). Without them rows and sources are compact.',
    platform:
      'get: only the rows of this platform; list: only the snapshots with a source of this platform. A platform ID from bootstrap platforms[].id.',
    level:
      'get: only the rows of this level (campaign, adset or ad); bootstrap platforms[].reporting_v4.levels lists the levels of each platform.',
    entity:
      'get: a native ID as the rows show it (entity_id, or the campaign or ad set above a row): that entity’s row and the rows under it.',
    query:
      'get: text to find, case-insensitive, in the IDs and names of the rows and of the campaign and ad set above them (at most 150 characters); a blank query narrows nothing.',
    client:
      'list: only the snapshots all of whose sources are accounts of this client profile (a profile ID of amcp_workspace profiles).',
    state: 'list: only the snapshots in this state: queued, running, complete, partial, failed or cancelled.',
    cursor:
      'get and list with a filter: the next_cursor of the previous page. It continues only the same read, by the same caller with the same id, filters, limit and include; any other use is refused with INVALID_CURSOR. An offset belongs to an unfiltered read.',
    compare:
      'run: previous_period also queues the equal-length window that ends the day before as a linked baseline snapshot with its own collection limits. Both count toward the 100 active reporting jobs.',
    baseline_id:
      'compare: the earlier retained snapshot to compare with; without it the snapshot’s previous-period pair is used. compare_candidates lists the snapshots that qualify, each with the rule it fails.',
    resolution:
      'resolve_delivery: check rereads the tab’s delivery marker; resend requeues that report’s export once the 10-minute settle window has passed; abandon releases the tab after the same window (audited), and with no unconfirmed delivery it releases a tab with a conflicting marker. delete_report: abandon releases the unconfirmed delivery and deletes the snapshot together; without it the delete is refused.',
    file_destination:
      'bind_file_destination: {name, formats: ["pdf"], ["xlsx"] or both, presentation?: {brand_name, accent_color, footer, template, artifact_language}}. It saves a local encrypted-file destination with no Sheets login and no external recipients; export and schedule accept its destination_id.',
    presentation_revision:
      'save_presentation and apply_profile_presentation: the snapshot’s current presentation_revision, 0 when none has been saved.',
    profile_revision:
      'apply_profile_presentation: the exact revision of the approved client profile, as presentation_profiles lists it.',
    move_version: 'move_workbook_schedule: the move_version that preview_workbook_move returned.',
  },
  [R]: {
    // R25 M0 (owner 2026-11-15, observation 7 of the live checks): the keys took six failed calls to learn. The platforms' own
    // rules and a worked call for each are in the help of capture_preset (`worked_examples`). The note rides in the contract of
    // both actions that read `semantics`, so it says only what both do: capture checks the form of each value and keeps timezone
    // and currency as declared (src/decision-reporting.ts semantic()); only capture_preset's guided collectors compare them with
    // the account they read (review S3-1; tests/capture-preset-help.test.mjs).
    semantics:
      'The declared meaning of the figures, an object with only these keys. date_from and date_to: the window, as calendar dates written YYYY-MM-DD, date_from not after date_to. timezone: the IANA name of the platform account’s own timezone (UTC for LinkedIn); capture_preset checks it against the account, capture keeps it as declared. currency: the account’s 3-letter ISO currency code in capitals; capture_preset checks it against the account, capture keeps it as declared. complete: true when the window has closed and its data is complete, false when it is not; a platform may require true. attribution: text of 1 to 200 characters naming the attribution settings, or unknown when they are not established; a preset that takes attribution windows sets it from them. source_name: text of 1 to 200 characters naming where the figures come from, or unknown. conversion_definition: text that capture requires; capture_preset sets it, so leave it out there. Any other key is refused. capture_preset help lists a worked call for each platform, with its rules.',
  },
};
/** The AMCP tools the table covers. */
export const firstPartyContractTools = Object.keys(rows);
/** The authored row of one action, or undefined. */
function authored(tool: string, action: string | null): Row | undefined {
  return rows[tool]?.find(r => r.action === action);
}
/** The actions a tool's rows are authored for (tests check each is a real action). */
export const authoredContractActions = (tool: string): (string | null)[] => (rows[tool] ?? []).map(r => r.action);
/** The argument names a row is authored with, before narrowing to a listing (tests check each exists). */
export const authoredArguments = (tool: string, action: string | null): string[] => {
  const r = authored(tool, action);
  return r ? [...r.required, ...r.optional] : [];
};
const built = new WeakMap<object, Map<string | null, FirstPartyContract>>();
/**
 * The contract of one action as this deployment lists the tool: its argument schemas are the listed tool's own, so a
 * read-only listing (amcp_write inspect only; amcp_media reads only) narrows them the same way.
 */
export function firstPartyContract(tool: ToolLike, action: string | null): FirstPartyContract | undefined {
  let cache = built.get(tool);
  if (!cache) built.set(tool, (cache = new Map()));
  if (cache.has(action)) return cache.get(action);
  const r = authored(tool.name, action);
  if (!r) return undefined;
  const flat: JsonObject = tool.inputSchema.properties ?? {},
    notes = argumentNotes[tool.name] ?? {},
    names = [...(action === null ? [] : ['action']), ...r.required, ...r.optional].filter(k => Object.hasOwn(flat, k)),
    properties = Object.fromEntries(
      names.map(k => {
        if (k === 'action') return [k, {type: 'string', const: action}];
        const {note, ...bounds} = r.bounds?.[k] ?? {},
          description = [notes[k] ?? flat[k].description, note].filter(Boolean).join(' ');
        return [k, {...structuredClone(flat[k]), ...bounds, ...(description ? {description} : {})}];
      }),
    ),
    required = [...(action === null ? [] : ['action']), ...r.required].filter(k => Object.hasOwn(flat, k));
  const contract: FirstPartyContract = {
    tool: tool.name,
    action,
    summary: r.summary,
    argumentsSchema: {type: 'object', properties, required, additionalProperties: false},
    effects: structuredClone(r.effects),
    requires_role: r.role,
    next: r.next.map(([t, a]) => ({tool: t, action: a})),
  };
  cache.set(action, contract);
  return contract;
}
/** Every action of a listed first-party tool, with its contract (undefined when a row is missing). */
export function toolActions(tool: ToolLike): (string | null)[] {
  const actions = tool.inputSchema.properties?.action?.enum;
  return Array.isArray(actions)
    ? [...(tool.inputSchema.required?.includes('action') ? [] : [null]), ...actions]
    : [null];
}
export function firstPartyContracts(tools: ToolLike[]): FirstPartyContract[] {
  return tools
    .filter(t => firstPartyContractTools.includes(t.name))
    .flatMap(t => toolActions(t).map(a => firstPartyContract(t, a)!))
    .filter(Boolean);
}
/** The one-line summaries of a tool's actions, for gateway help. */
export function actionSummaries(tool: ToolLike): JsonObject {
  return Object.fromEntries(
    toolActions(tool)
      .filter((a): a is string => a !== null)
      .map(a => [a, authored(tool.name, a)?.summary ?? null]),
  );
}
const ajv = new Ajv({strict: false, allErrors: true, useDefaults: false, coerceTypes: false, removeAdditional: false});
const validators = new WeakMap<FirstPartyContract, ReturnType<Ajv['compile']>>();
export interface ArgumentFinding {
  field: string;
  /** not_an_argument: the action does not read it (another action's argument); invalid_value: its schema refuses it. */
  kind: 'not_an_argument' | 'invalid_value';
}
/**
 * The arguments of one call that its action's contract does not accept (MCP-07). Only names the action never reads and
 * values its flat schema refuses are findings; a missing required argument is left to the action's own refusal, which
 * names the remedy.
 */
export function actionArgumentFindings(tool: ToolLike, input: JsonObject): ArgumentFinding[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const actions = toolActions(tool),
    action = input.action === undefined && actions.includes(null) ? null : input.action;
  if (action !== null && (typeof action !== 'string' || !actions.includes(action))) return [];
  const contract = firstPartyContract(tool, action);
  if (!contract) return [];
  let validate = validators.get(contract);
  if (!validate) validators.set(contract, (validate = ajv.compile(contract.argumentsSchema)));
  if (validate(input)) return [];
  const findings = new Map<string, ArgumentFinding>();
  for (const e of validate.errors ?? []) {
    if (e.keyword === 'required') continue;
    const field =
      e.keyword === 'additionalProperties'
        ? String((e.params as JsonObject).additionalProperty)
        : e.instancePath.slice(1).split('/')[0]!;
    if (!field || findings.has(field)) continue;
    findings.set(field, {field, kind: e.keyword === 'additionalProperties' ? 'not_an_argument' : 'invalid_value'});
  }
  return [...findings.values()];
}
export type ActionArgumentMode = 'report' | 'enforce';
/**
 * Checks a call against its action's contract. In report mode (the default for this release) the findings come back as
 * meta warnings; in enforce mode an argument the action does not read is refused with INVALID_ARGUMENT naming it, before
 * the action runs. Invalid values stay warnings in both modes: the action's own validation refuses them with its remedy.
 */
export function actionArgumentCheck(
  tool: ToolLike,
  input: JsonObject,
  mode: ActionArgumentMode = 'report',
): JsonObject[] {
  const findings = actionArgumentFindings(tool, input);
  if (!findings.length) return [];
  const action = input.action === undefined && toolActions(tool).includes(null) ? null : String(input.action),
    contract = firstPartyContract(tool, action)!,
    accepted = Object.keys(contract.argumentsSchema.properties),
    help = {tool: tool.name, arguments: {action: 'help', ...(action ? {topic: action} : {})}},
    foreign = findings.find(f => f.kind === 'not_an_argument');
  if (mode === 'enforce' && foreign)
    throw new MirrorError(
      'INVALID_ARGUMENT',
      foreign.field + ' is not an argument of ' + tool.name + (action ? ' ' + action : '') + '.',
      {field: foreign.field, ...(action ? {action} : {}), accepted, help_call: help},
    );
  return findings.map(f => ({
    code: f.kind === 'not_an_argument' ? 'ARGUMENT_NOT_USED_BY_ACTION' : 'ARGUMENT_VALUE_INVALID',
    field: f.field,
    message:
      f.kind === 'not_an_argument'
        ? f.field +
          ' is not an argument of ' +
          tool.name +
          (action ? ' ' + action : '') +
          '; this action does not use it. A later release refuses it with INVALID_ARGUMENT.'
        : f.field + ' does not satisfy its schema; the action decides whether to refuse it.',
    help_call: help,
  }));
}
/** The markers of the generated action reference in the workspace guide (tools/action-contracts.ts writes it). */
export const contractsGuideMarkers = [
  '<!-- first-party-contracts:start (generated by npm run contracts:actions; do not edit) -->',
  '<!-- first-party-contracts:end -->',
] as const;
const effectText = (e: ActionEffects) =>
  [
    e.provider_requests === 'none'
      ? 'no provider request'
      : e.provider_requests === 'read_only'
        ? 'provider reads'
        : 'reviewed provider write',
    ...(e.saves.length ? ['saves ' + e.saves.join(', ')] : []),
    ...(e.remote_jobs ? ['provider job'] : []),
    ...(e.remote_writes ? ['Google Sheets write'] : []),
    ...(e.advertising_writes ? ['changes an advertising account'] : []),
  ].join('; ');
/** The action reference of the AMCP tools as guide Markdown, generated from the table (MCP-07). */
const boundsText = (bounds: ActionBounds[string] | undefined): string => {
  if (!bounds) return '';
  const parts: string[] = [];
  if (bounds.minimum !== undefined && bounds.maximum !== undefined) parts.push(bounds.minimum + '–' + bounds.maximum);
  else {
    if (bounds.minimum !== undefined) parts.push('minimum ' + bounds.minimum);
    if (bounds.maximum !== undefined) parts.push('maximum ' + bounds.maximum);
  }
  if (bounds.maxLength !== undefined) parts.push('maxLength ' + bounds.maxLength);
  if (bounds.default !== undefined) parts.push('default ' + JSON.stringify(bounds.default));
  if (bounds.note) parts.push(bounds.note);
  return parts.length ? ' (' + parts.join(', ') + ')' : '';
};
export function contractsMarkdown(tools: ToolLike[]): string {
  const lines = [
    contractsGuideMarkers[0],
    '',
    '## AMCP tool actions',
    '',
    'Generated from `src/first-party-contracts.ts`; `<tool> {action:"help", topic:"<action>"}` returns',
    'one row whole, with each argument’s JSON Schema. Arguments in bold are required. An argument an action does not',
    'list is reported under `meta.argument_warnings` by default. It is refused with `INVALID_ARGUMENT` only with',
    '`MIRROR_FLAGS {"actionArguments":"enforce"}`. Effects are the most a',
    'call can do; roles are the least that can succeed (reader, operator, admin, owner).',
  ];
  for (const tool of tools.filter(t => firstPartyContractTools.includes(t.name))) {
    lines.push(
      '',
      '### ' + tool.name,
      '',
      '| Action | What it does | Arguments | Effects | Role |',
      '|---|---|---|---|---|',
    );
    for (const action of toolActions(tool)) {
      const c = firstPartyContract(tool, action)!,
        required = new Set<string>(c.argumentsSchema.required),
        names = Object.keys(c.argumentsSchema.properties).filter(k => k !== 'action'),
        args =
          names
            .map(
              k =>
                (required.has(k) ? '**`' + k + '`**' : '`' + k + '`') +
                boundsText(authored(tool.name, action)?.bounds?.[k]),
            )
            .join(', ') || '—';
      lines.push(
        '| ' +
          [action === null ? '—' : '`' + action + '`', c.summary, args, effectText(c.effects), c.requires_role].join(
            ' | ',
          ) +
          ' |',
      );
    }
  }
  lines.push('', contractsGuideMarkers[1]);
  return lines.join('\n');
}
/** The guide text with its generated action reference replaced (or appended when the markers are absent). */
export function withContractsGuide(guide: string, tools: ToolLike[]): string {
  const [start, end] = contractsGuideMarkers,
    a = guide.indexOf(start),
    b = guide.indexOf(end);
  const generated = contractsMarkdown(tools);
  if (a < 0 || b < a) return guide.replace(/\n*$/, '\n\n') + generated + '\n';
  return guide.slice(0, a) + generated + guide.slice(b + end.length);
}
