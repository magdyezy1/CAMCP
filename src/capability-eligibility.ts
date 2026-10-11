import type {Actor, Connection, JsonObject} from './types.js';
import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import {actionContracts} from './action-contracts.js';
import {bad, fingerprint, optional} from './workspace-core.js';
import {normalizeAccount} from './scope.js';
import {accountMetadataView, resolveAccountMetadata, type ResolvedAccountMetadata} from './account-metadata.js';
import {conditionalProgram, programObservation} from './conditional-programs.js';
import {readinessBinding, readinessLifetimeMs, recordedGrants} from './readiness.js';
import {dv360Scope, missingScopes, providerGrant, requirementScopes, type ScopeRequirement} from './provider-grants.js';

/**
 * Recorded scopes are a local prerequisite only; current provider permission is checked at execution. Requirements
 * come from the one grant registry (src/provider-grants.ts): write scopes for reviewed-write workflows, read scopes
 * for read workflows (CON-03).
 */
export {readinessBinding, readinessLifetimeMs} from './readiness.js';

export const recipeDependencies: Record<string, JsonObject> = {
  snapchat_lead_generation: {
    objective: 'lead_generation',
    objects: [
      'existing_lead_creative',
      'existing_lead_form',
      'lead_form_policy_acceptance',
      'account_currency',
      'country_targeting',
      'lead_optimization_goal',
    ],
    actions: ['snapchat_campaign_create', 'snapchat_adsquad_create', 'snapchat_ad_create'],
    effects:
      'Creates three PAUSED entities with an existing lead creative and its original form. Account-owned configuration is inspected; provider eligibility, privacy and consent acceptance remain unverified. Activation is separate.',
  },
  snapchat_website_traffic: {
    objective: 'website_traffic',
    objects: [
      'existing_website_creative',
      'landing_page',
      'account_currency',
      'country_targeting',
      'automatic_swipe_bidding',
    ],
    actions: ['snapchat_campaign_create', 'snapchat_adsquad_create', 'snapchat_ad_create'],
    effects:
      'Creates a PAUSED auction campaign, daily-budget ad squad and website ad with an existing creative. Destination, creative approval and objective eligibility need native inspection. Activation is separate.',
  },
  meta_website_traffic: {
    objective: 'website_traffic',
    objects: ['page_identity', 'media_receipt', 'landing_page', 'account_currency'],
    actions: ['meta_campaign_create', 'meta_adset_create', 'meta_creative_create', 'meta_ad_create'],
    effects: 'A PAUSED campaign contains ACTIVE children. Campaign activation is a separate reviewed change.',
  },
  ...Object.fromEntries(
    ['meta_website_sales', 'meta_website_leads'].map(id => [
      id,
      {
        objective: id === 'meta_website_sales' ? 'website_purchases' : 'website_leads',
        objects: [
          'page_identity',
          'media_receipt',
          'landing_page',
          'account_currency',
          'account_owned_pixel',
          'conversion_event_delivery',
          'attribution_window',
        ],
        actions: ['meta_campaign_create', 'meta_adset_create', 'meta_creative_create', 'meta_ad_create'],
        effects:
          'Creates a PAUSED conversion campaign with ACTIVE children and explicit pixel/event/attribution. Pixel access does not establish event delivery or objective acceptance. Activation is separate.',
      },
    ]),
  ),
  ...Object.fromEntries(
    [
      'google_search',
      'google_search_clicks',
      'google_search_conversions',
      'google_search_target_cpa',
      'google_search_conversion_value',
      'google_search_target_roas',
    ].map(id => [
      id,
      {
        objective:
          id === 'google_search'
            ? 'search_acquisition'
            : id === 'google_search_clicks'
              ? 'search_clicks'
              : ['google_search_conversion_value', 'google_search_target_roas'].includes(id)
                ? 'search_conversion_value'
                : 'search_conversions',
        objects: [
          'location_criteria',
          'language_criteria',
          'landing_page',
          'account_currency',
          ...(id === 'google_search_clicks' ? ['campaign_cpc_ceiling'] : []),
          ...([
            'google_search_conversions',
            'google_search_target_cpa',
            'google_search_conversion_value',
            'google_search_target_roas',
          ].includes(id)
            ? [
                'account_default_conversion_goals',
                'primary_conversion_actions',
                'conversion_event_delivery',
                ...(id === 'google_search_target_cpa' ? ['campaign_target_cpa'] : []),
                ...(['google_search_conversion_value', 'google_search_target_roas'].includes(id)
                  ? [
                      'conversion_value_policy',
                      'conversion_value_configuration',
                      'reported_conversion_activity',
                      'conversion_value_delivery',
                      'conversion_history_eligibility',
                    ]
                  : []),
                ...(id === 'google_search_target_roas' ? ['campaign_target_roas'] : []),
              ]
            : []),
        ],
        actions: [
          'google_ads_v23_campaign_budget_mutate_campaign_budgets',
          'google_ads_v23_campaign_mutate_campaigns',
          'google_ads_v23_campaign_criterion_mutate_campaign_criteria',
          'google_ads_v23_ad_group_mutate_ad_groups',
          'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
          'google_ads_v23_ad_group_ad_mutate_ad_group_ads',
        ],
        effects: ['google_search_conversion_value', 'google_search_target_roas'].includes(id)
          ? 'A PAUSED Search campaign uses Maximize Conversion Value, recorded conversion values, account-default goals and a dedicated budget. Children are ENABLED. A ROAS target is an average ratio, not guaranteed return. Values and goals remain unchanged; activation is separate.'
          : ['google_search_conversions', 'google_search_target_cpa'].includes(id)
            ? 'A PAUSED Search campaign uses Maximize Conversions, explicit account-default goals and a dedicated budget. Its children are ENABLED. Goal settings and event delivery remain unverified; no goals are changed. Activation is separate.'
            : id === 'google_search'
              ? 'A PAUSED Search campaign contains ENABLED children and a dedicated budget. Activation is separate.'
              : 'A PAUSED Search campaign uses Maximize Clicks with an explicit campaign CPC ceiling and dedicated budget. Children are ENABLED under it. Click optimization does not establish conversion performance; activation is separate.',
      },
    ]),
  ),
  microsoft_search: {
    objective: 'search_acquisition',
    objects: ['location_targeting_before_activation', 'landing_page', 'account_currency'],
    actions: ['AddCampaigns', 'AddAdGroups', 'AddKeywords', 'AddAds'],
    effects: 'Creates a paused Search campaign. Native location targeting must be supplied before activation.',
  },
};
const campaignLifecycle = [
  {
    stage: 'eligibility',
    tool: 'amcp_campaign',
    action: 'recipe_eligibility',
    meaning:
      'Inspect the current brief and account prerequisites without saving a plan. live:true adds native read-only preflight; objective acceptance remains unverified.',
  },
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

/**
 * Capability graph version 3 (CON-03) resolves every dependency or names its class. `AMCP_CAPABILITY_GRAPH_VERSION=2`
 * keeps the version 2 placeholders (`requires_evidence`) for a client that still needs them.
 */
export const capabilityGraphVersion = (env: NodeJS.ProcessEnv = process.env) =>
  env.AMCP_CAPABILITY_GRAPH_VERSION === '2' ? 2 : 3;
/** How a dependency is resolved: from local evidence, from the caller's inputs, at collection, or only natively. */
export type DependencyResolution = 'resolved_locally' | 'user_input' | 'collection_time' | 'native_review_only';
const locallyResolved = new Set([
  'exact_account',
  'destination_account',
  'account_currency',
  'member_account_access',
  'exact_advertiser_access',
  'display_video_oauth_scope',
]);
const atCollection = new Set(['complete_source_evidence', 'provider_processing_receipt']);
const nativeReviewOnly = new Set([
  'provider_objective_acceptance',
  'conversion_event_delivery',
  'conversion_value_delivery',
  'conversion_history_eligibility',
  'lead_form_policy_acceptance',
  'private_application_product',
  'dv360_customer_role',
]);
export function dependencyResolution(id: string): DependencyResolution {
  return locallyResolved.has(id)
    ? 'resolved_locally'
    : atCollection.has(id)
      ? 'collection_time'
      : nativeReviewOnly.has(id)
        ? 'native_review_only'
        : 'user_input';
}
/** What each resolution class means; graph version 3 states it once instead of on every dependency. */
export const dependencyResolutions: Record<DependencyResolution, string> = {
  resolved_locally: 'Resolved from this account’s recent read, write grant and recorded permissions.',
  user_input:
    'Needs the exact inputs of a brief, source or request; the resolver checks them without a provider request.',
  collection_time: 'Known only when the report is collected or the provider processes the upload.',
  native_review_only:
    'Only the provider decides this, during native preparation, review or execution. It is never ready in advance.',
};
/** One workflow dependency with its status, resolution class and, where one exists, the call that resolves it. */
function workflowDependency(w: JsonObject, id: string, recipeId?: string): JsonObject {
  const resolution = dependencyResolution(id);
  const resolver_call =
    resolution === 'user_input'
      ? recipeId
        ? {tool: 'amcp_campaign', arguments: {action: 'recipe_eligibility', recipe: recipeId, live: false}}
        : w.kind === 'conditional_program'
          ? {tool: 'amcp_workspace', arguments: {action: 'program_check', workflow_id: w.id}}
          : w.kind === 'media_upload'
            ? {tool: 'amcp_media', arguments: {action: 'plan'}}
            : {
                tool: w.kind === 'report_capture' ? 'amcp_reporting' : 'amcp_reporting_overview',
                arguments: {action: w.kind === 'report_capture' ? 'capture_presets' : 'bootstrap'},
              }
      : resolution === 'native_review_only' && w.kind === 'conditional_program'
        ? {tool: 'amcp_workspace', arguments: {action: 'program_check', workflow_id: w.id, live: true}}
        : undefined;
  return {
    id,
    status:
      resolution === 'user_input' ? 'needs_user_input' : resolution === 'resolved_locally' ? 'per_account' : 'unknown',
    resolution,
    ...(resolver_call ? {resolver_call} : {}),
  };
}
/** An account-scoped dependency of one selected account. Account-read evidence never implies objective readiness. */
function accountDependency(
  id: string,
  f: {connection: JsonObject; account: string; recent: boolean; currency: string | null},
): JsonObject {
  const check = {
      tool: 'amcp_workspace',
      arguments: {action: 'check', connection_id: f.connection.id, account_id: f.account, live: true},
    },
    connections = {website_path: '/connections'};
  if (id === 'display_video_oauth_scope') {
    const ready = f.connection.scopes.includes(dv360Scope);
    return {id, status: ready ? 'ready' : 'blocked', ...(ready ? {} : {resolver_call: connections})};
  }
  if (id === 'destination_account' && !f.connection.writeAccounts?.includes(f.account))
    return {id, status: 'blocked', reason: 'account_write_grant_required', resolver_call: connections};
  const ready = f.recent && (id !== 'account_currency' || typeof f.currency === 'string');
  return {id, status: ready ? 'ready' : 'blocked', ...(ready ? {} : {resolver_call: check})};
}
/**
 * The member's LinkedIn role on the account as discovery last observed it (PRV-02): evidence for the program's
 * member_account_access prerequisite, with its observation time. It is not current access; LinkedIn decides each request.
 */
function memberRole(store: Store, actor: Actor, c: Connection, account: string): JsonObject {
  const assets = optional(store, actor.tenantId, 'website_assets', c.id),
    asset = (assets?.groups ?? [])
      .flatMap((g: JsonObject) => (g.kind === 'ad_accounts' && Array.isArray(g.assets) ? g.assets : []))
      .find((x: JsonObject) => x.id === account);
  return typeof asset?.linkedinRole === 'string' && Number.isSafeInteger(asset.linkedinRoleObservedAt)
    ? {
        status: 'observed_at_discovery',
        role: asset.linkedinRole,
        observed_at: asset.linkedinRoleObservedAt,
        meaning:
          'The member role LinkedIn listed for this account at the last discovery. It is not current access; LinkedIn decides each program request.',
      }
    : {
        status: 'not_observed',
        role: null,
        observed_at: null,
        meaning: 'No member role is recorded for this account. Sync the LinkedIn login in Connections to record it.',
      };
}
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
    version = capabilityGraphVersion(),
    now = Date.now(),
    connections = new Map(store.listConnections(actor.tenantId).map(c => [c.id, c])),
    observations = new Map<string, JsonObject | undefined>(),
    names = new Map<string, ResolvedAccountMetadata>();
  if (input.workflow_id && !graph.workflows.some((w: JsonObject) => w.id === input.workflow_id))
    bad('Choose an exact workflow_id returned by capabilities.', 'WORKFLOW_NOT_FOUND');
  const nodes = new Map<string, JsonObject>(),
    edges: JsonObject[] = [];
  const workflows: JsonObject[] = graph.workflows
    .filter((w: JsonObject) => !input.workflow_id || w.id === input.workflow_id)
    .map((w: JsonObject) => {
      const recipe = recipeDependencies[w.id.replace(/^recipe:/, '')],
        program = conditionalProgram(w.id);
      const contracts = (recipe?.actions ?? program?.actions ?? []).map((action: string) => {
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
              local_supported: c.status === (program ? 'native_read' : 'reviewed_write_family'),
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
      const ids: string[] =
        recipe?.objects ??
        program?.prerequisite_ids ??
        (w.kind === 'media_upload'
          ? ['exact_source_hash', 'destination_account', 'provider_processing_receipt']
          : ['exact_account', 'measurement_context', 'complete_source_evidence']);
      const dependencies: JsonObject[] =
        version === 2
          ? ids.map(id => ({
              id,
              status: 'requires_evidence',
              meaning: 'Resolve this prerequisite through the original workflow before execution.',
            }))
          : [...ids, ...(recipe || program ? ['provider_objective_acceptance'] : [])].map(id =>
              workflowDependency(w, id, recipe ? w.id.replace(/^recipe:/, '') : undefined),
            );
      const accounts = w.accounts
        .filter(
          (a: JsonObject) =>
            (!input.connection_id || a.connection_id === input.connection_id) &&
            (!input.account_id ||
              normalizeAccount(w.gateway, a.account_id) === normalizeAccount(w.gateway, input.account_id)),
        )
        .map((a: JsonObject) => {
          const c = connections.get(a.connection_id)!;
          const grant = providerGrant(w.gateway),
            needed: ScopeRequirement | null = program
              ? {all: program.recorded_scopes}
              : ((w.effects === 'reviewed_provider_writes' ? grant?.write : grant?.read) ?? null),
            grants = recordedGrants(store, c),
            // A scope never recorded is missing. A recorded Meta scope counts as granted only after AMCP read Meta's
            // granted permissions; until then the requirement is not known to be met (CON-03).
            missing = needed ? missingScopes(needed, c.scopes) : [],
            known =
              !!needed &&
              (missing.length > 0 ||
                !!program ||
                grant?.grantSource !== 'permissions_endpoint' ||
                grants?.known === true),
            declined = Array.isArray(grants?.declined) ? (grants.declined as string[]) : [];
          const blockers = [
            ...a.blockers,
            ...missing.map(s => (declined.includes(s) ? 'provider_scope_declined:' : 'provider_scope:') + s),
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
          // Account-scoped prerequisites resolve from this account's own evidence and grants (graph version 3).
          const resolved =
            version === 2
              ? undefined
              : dependencies
                  .filter(d => d.resolution === 'resolved_locally')
                  .map(d =>
                    accountDependency(d.id, {
                      connection: c,
                      account: a.account_id,
                      recent: evidence.status === 'recent_account_read',
                      currency: valid ? (observation!.account?.currency ?? null) : null,
                    }),
                  );
          const lastProgramRead = program && programObservation(store, actor.tenantId, w.id, c.id, a.account_id);
          // The same name and source as list_accounts and recipe context (CON-05), resolved once per account.
          const metadataKey = c.id + '\n' + a.account_id;
          if (!names.has(metadataKey))
            names.set(metadataKey, resolveAccountMetadata(store, actor.tenantId, c, a.account_id));
          const metadata = names.get(metadataKey)!;
          return {
            ...a,
            name: metadata.name,
            metadata: accountMetadataView(metadata),
            blockers,
            local_state: blockers.length ? 'blocked' : 'ready_for_preflight',
            ...(resolved ? {dependencies: resolved} : {}),
            recorded_scopes: {required: requirementScopes(needed), missing, known},
            provider_evidence: evidence,
            ...(program
              ? {
                  program_evidence: {
                    status: 'unverified',
                    meaning:
                      'An account read does not qualify this conditional product. Inspect one exact program request.',
                    ...(program.prerequisite_ids.includes('member_account_access')
                      ? {member_account_access: memberRole(store, actor, c, a.account_id)}
                      : {}),
                    // The last retained program read (D20, CON-04): timestamped, never a grant.
                    ...(lastProgramRead ? {last_observation: lastProgramRead} : {}),
                  },
                }
              : {}),
            unresolved: [
              ...a.unresolved,
              ...dependencies
                .filter(d => (resolved?.find(r => r.id === d.id) ?? d).status !== 'ready')
                .map((d: JsonObject) => d.id),
            ],
          };
        });
      // A workflow-level account dependency has one status only when exactly one account is in view.
      if (version === 3)
        for (const d of dependencies.filter(d => d.resolution === 'resolved_locally')) {
          const statuses = accounts.map((a: JsonObject) => a.dependencies.find((r: JsonObject) => r.id === d.id));
          d.status = statuses.length === 1 ? statuses[0].status : statuses.length ? 'per_account' : 'unknown';
          if (statuses.length === 1 && statuses[0].resolver_call) d.resolver_call = statuses[0].resolver_call;
        }
      const lifecycle = program
        ? [
            {
              stage: 'inspect',
              tool: 'amcp_workspace',
              action: 'program_check',
              meaning: 'Inspect recorded prerequisites and official product requirements without a provider request.',
            },
            {
              stage: 'qualify',
              tool: 'amcp_workspace',
              action: 'program_check',
              meaning:
                'Choose live:true and the exact inputs for one bounded read-only program request. Application and account eligibility remain specific to that request.',
            },
            {
              stage: 'inspect',
              meaning:
                'Retain the original native result or refusal and its observation time. Do not infer broader program or write access.',
            },
          ]
        : w.kind === 'campaign_recipe'
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
        objective:
          recipe?.objective ??
          program?.objective ??
          (w.kind === 'media_upload' ? 'creative_preparation' : 'measurement'),
        contracts,
        dependencies,
        lifecycle,
        effect_details: recipe?.effects ?? program?.effect_details ?? w.description,
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
    version,
    network_requests: 0,
    workflows,
    nodes: [...nodes.values()],
    edges,
    evidence_lifetime_ms: readinessLifetimeMs,
    ...(version === 3 ? {dependency_resolutions: dependencyResolutions} : {}),
    selection: {
      workflow_id: input.workflow_id ?? null,
      connection_id: input.connection_id ?? null,
      account_id: input.account_id ?? null,
    },
  };
}
