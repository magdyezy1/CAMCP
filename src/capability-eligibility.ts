import type {Actor, Connection, JsonObject} from './types.js';
import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import {actionContracts} from './action-contracts.js';
import {bad, fingerprint, optional} from './workspace-core.js';
import {normalizeAccount} from './scope.js';

/** Recorded scopes are a local prerequisite only. Current provider permission is checked at execution. */
export const recordedWriteScopes: Record<string, string[]> = {
  meta_native_action: ['ads_management'],
  linkedin_native_action: ['rw_ads'],
  reddit_native_action: ['adsread', 'adsedit'],
  microsoft_ads_native_action: ['https://ads.microsoft.com/msads.manage'],
};
export const readinessLifetimeMs = 15 * 60000;
export const readinessBinding = (connection: Connection) => fingerprint(connection);

export const recipeDependencies: Record<string, JsonObject> = {
  meta_website_traffic: {
    objective: 'website_traffic',
    objects: ['page_identity', 'media_receipt', 'landing_page', 'account_currency'],
    actions: ['meta_campaign_create', 'meta_adset_create', 'meta_creative_create', 'meta_ad_create'],
    effects: 'A PAUSED campaign contains ACTIVE children. Campaign activation is a separate reviewed change.',
  },
  google_search: {
    objective: 'search_acquisition',
    objects: ['location_criteria', 'language_criteria', 'landing_page', 'account_currency'],
    actions: [
      'google_ads_v23_campaign_budget_mutate_campaign_budgets',
      'google_ads_v23_campaign_mutate_campaigns',
      'google_ads_v23_campaign_criterion_mutate_campaign_criteria',
      'google_ads_v23_ad_group_mutate_ad_groups',
      'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
      'google_ads_v23_ad_group_ad_mutate_ad_group_ads',
    ],
    effects: 'A PAUSED Search campaign contains ENABLED children and a dedicated budget. Activation is separate.',
  },
  microsoft_search: {
    objective: 'search_acquisition',
    objects: ['location_targeting_before_activation', 'landing_page', 'account_currency'],
    actions: ['AddCampaigns', 'AddAdGroups', 'AddKeywords', 'AddAds'],
    effects: 'Creates a paused Search campaign. Native location targeting must be supplied before activation.',
  },
};
const campaignLifecycle = [
  {
    stage: 'draft',
    tool: 'amcp_campaign',
    action: 'preview_recipe',
    meaning: 'Validate business inputs without saving or submitting.',
  },
  {
    stage: 'preflight',
    tool: 'amcp_campaign',
    action: 'preflight',
    meaning: 'Read current account, currency and object prerequisites.',
  },
  {
    stage: 'review',
    tool: 'amcp_campaign',
    action: 'prepare_next',
    meaning: 'Freeze each resolved step and inspect its exact effects.',
  },
  {
    stage: 'execute',
    tool: 'amcp_campaign',
    action: 'run',
    meaning: 'Use the current approved plan and required execution confirmations.',
  },
  {
    stage: 'verify',
    tool: 'amcp_campaign',
    action: 'get',
    meaning: 'Inspect provider read-back and original step receipts.',
  },
  {
    stage: 'recover',
    tool: 'amcp_campaign',
    action: 'get',
    meaning: 'Inspect the original plan before resuming; never blindly repeat an uncertain create.',
  },
];

export function enrichCapabilities(
  store: Store,
  registry: Registry,
  actor: Actor,
  graph: JsonObject,
  input: JsonObject,
) {
  for (const key of ['workflow_id', 'connection_id', 'account_id'])
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key] || input[key].length > 200))
      bad('Use an exact ' + key + ' up to 200 characters.');
  const allContracts = actionContracts(registry),
    now = Date.now(),
    connections = new Map(store.listConnections(actor.tenantId).map(c => [c.id, c])),
    observations = new Map<string, JsonObject | undefined>();
  if (input.workflow_id && !graph.workflows.some((w: JsonObject) => w.id === input.workflow_id))
    bad('Choose an exact workflow_id returned by capabilities.', 'WORKFLOW_NOT_FOUND');
  const nodes = new Map<string, JsonObject>(),
    edges: JsonObject[] = [];
  const workflows: JsonObject[] = graph.workflows
    .filter((w: JsonObject) => !input.workflow_id || w.id === input.workflow_id)
    .map((w: JsonObject) => {
      const recipe = recipeDependencies[w.id.replace(/^recipe:/, '')];
      const contracts = (recipe?.actions ?? []).map((action: string) => {
        const c = allContracts.find(
          r => r.gateway === w.gateway && (r.action === action || r.aliases.includes(action)),
        );
        return c
          ? {
              action,
              canonical_action: registry.action(w.gateway, action)?.canonical_name ?? c.action,
              status: c.status,
              family: c.family ?? null,
              source: c.source,
              tests: c.tests,
              local_supported: c.status === 'reviewed_write_family',
              live_qualification: 'unverified',
            }
          : {
              action,
              status: 'unmapped',
              local_supported: false,
              source: null,
              tests: [],
              live_qualification: 'unverified',
            };
      });
      const dependencies = (
        recipe?.objects ??
        (w.kind === 'media_upload'
          ? ['exact_source_hash', 'destination_account', 'provider_processing_receipt']
          : ['exact_account', 'measurement_context', 'complete_source_evidence'])
      ).map((id: string) => ({
        id,
        status: 'requires_evidence',
        meaning: 'Resolve this prerequisite through the original workflow before execution.',
      }));
      const accounts = w.accounts
        .filter(
          (a: JsonObject) =>
            (!input.connection_id || a.connection_id === input.connection_id) &&
            (!input.account_id ||
              normalizeAccount(w.gateway, a.account_id) === normalizeAccount(w.gateway, input.account_id)),
        )
        .map((a: JsonObject) => {
          const c = connections.get(a.connection_id)!;
          const needed = w.effects === 'reviewed_provider_writes' ? recordedWriteScopes[w.gateway] : undefined;
          const missingScopes = (needed ?? []).filter(
            s => !c.scopes.includes(s) && !(s.endsWith('msads.manage') && c.scopes.includes('msads.manage')),
          );
          const blockers = [
            ...a.blockers,
            ...missingScopes.map(s => 'provider_scope:' + s),
            ...contracts.filter((r: JsonObject) => !r.local_supported).map((r: JsonObject) => 'contract:' + r.action),
          ];
          const observationId = fingerprint([c.id, a.account_id]);
          if (!observations.has(observationId))
            observations.set(observationId, optional(store, actor.tenantId, 'readiness', observationId));
          const observation = observations.get(observationId);
          const valid =
            observation?.connection_fingerprint === readinessBinding(c) &&
            observation?.live_read === true &&
            Number.isSafeInteger(observation.checked_at) &&
            observation.checked_at <= now;
          const evidence = {
            status: !observation
              ? 'missing'
              : !valid
                ? 'not_current'
                : now - observation.checked_at > readinessLifetimeMs
                  ? 'stale'
                  : 'recent_account_read',
            checked_at: valid ? observation.checked_at : null,
            expires_at: valid ? observation.checked_at + readinessLifetimeMs : null,
            meaning:
              'Exact account-read evidence only. Objective, payload, assets and write permission still require current native preflight.',
          };
          return {
            ...a,
            blockers,
            local_state: blockers.length ? 'blocked' : 'ready_for_preflight',
            recorded_scopes: {required: needed ?? [], missing: missingScopes, known: !!needed},
            provider_evidence: evidence,
            unresolved: [...a.unresolved, ...dependencies.map((d: JsonObject) => d.id)],
          };
        });
      const lifecycle =
        w.kind === 'campaign_recipe'
          ? campaignLifecycle
          : w.kind === 'media_upload'
            ? [
                {
                  stage: 'inspect',
                  tool: 'amcp_media',
                  action: 'plan',
                  meaning: 'Inspect source and per-account variants.',
                },
                {
                  stage: 'review',
                  tool: 'amcp_media',
                  action: 'prepare',
                  meaning: 'Prepare the exact source hash and destination.',
                },
                {
                  stage: 'execute',
                  tool: 'amcp_media',
                  action: 'execute',
                  meaning: 'Submit the original reviewed upload.',
                },
                {
                  stage: 'recover',
                  tool: 'amcp_media',
                  action: 'recovery',
                  meaning: 'Inspect retained allocation and receipts before any safe continuation.',
                },
              ]
            : [
                {
                  stage: 'configure',
                  tool: w.kind === 'report_capture' ? 'amcp_reporting' : 'amcp_reporting_overview',
                  action: w.kind === 'report_capture' ? 'capture_presets' : 'bootstrap',
                  meaning: 'Select exact sources, dates and measurement semantics.',
                },
                {
                  stage: 'collect',
                  meaning: 'Read under aggregate collection budgets and retain completeness/provenance.',
                },
                {
                  stage: 'inspect',
                  meaning:
                    'Inspect the immutable snapshot before analysis or export; partial and unavailable remain explicit.',
                },
              ];
      return {
        ...w,
        objective: recipe?.objective ?? (w.kind === 'media_upload' ? 'creative_preparation' : 'measurement'),
        contracts,
        dependencies,
        lifecycle,
        effect_details: recipe?.effects ?? w.description,
        accounts,
      };
    })
    .filter((w: JsonObject) => !(input.connection_id || input.account_id) || w.accounts.length);
  if ((input.account_id || input.connection_id) && !workflows.length)
    bad('Select a currently configured account and login for this workflow.', 'CAPABILITY_ACCOUNT_UNAVAILABLE');
  for (const w of workflows) {
    nodes.set(w.id, {id: w.id, kind: w.kind, name: w.name});
    for (const d of [
      ...w.required_inputs.map((id: string) => ({id, type: 'input'})),
      ...w.dependencies.map((d: JsonObject) => ({id: d.id, type: 'evidence'})),
    ]) {
      const id = w.id + ':' + d.type + ':' + d.id;
      nodes.set(id, {id, kind: d.type, name: d.id});
      edges.push({from: w.id, to: id, relation: 'requires'});
    }
    for (const c of w.contracts) {
      const id = 'contract:' + w.gateway + ':' + (c.canonical_action ?? c.action);
      nodes.set(id, {id, kind: 'contract', ...c});
      edges.push({from: w.id, to: id, relation: 'uses'});
    }
  }
  return {
    ...graph,
    version: 2,
    network_requests: 0,
    workflows,
    nodes: [...nodes.values()],
    edges,
    evidence_lifetime_ms: readinessLifetimeMs,
    selection: {
      workflow_id: input.workflow_id ?? null,
      connection_id: input.connection_id ?? null,
      account_id: input.account_id ?? null,
    },
  };
}
