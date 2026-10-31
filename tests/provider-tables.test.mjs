import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectBackendContractFailures} from '../tools/check-locales.mjs';
import {providerAdapters} from '../dist/src/provider-adapters.js';
import {providerHooks, providerJobFamilies, registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {
  unavailableOperation,
  unavailableOperationNames,
  unavailableOperations,
  unavailableRefusal,
} from '../dist/src/unavailable-operations.js';
import {connectionDiagnosticKind, redactConnectionInput} from '../dist/src/connection-diagnostics.js';
import {
  discoveryOnlyListing,
  discoveryOnlyProgram,
  discoveryOnlyPrograms,
  withheldWriteProgram,
} from '../dist/src/discovery-programs.js';
import {MirrorError} from '../dist/src/errors.js';
import {
  accountAliases,
  encodedBodyGateways,
  nativeFields,
  nativeTopLevel,
  parameterHandling,
} from '../dist/src/parameters.js';
import {providerJobContracts, providerJobGateways, reviewedJobFamily} from '../dist/src/provider-jobs.js';
import {campaignRecipes, recipeGateway} from '../dist/src/campaign-recipes.js';

// ARC-01, wave 4c round 6 (w4c-arc6-tables): the provider rows of the shared tables moved into the adapters, and each
// shared module lists them in the order src/provider-hooks.ts declares. Each table as it was is transcribed below, and
// every gateway is compared with it: the rows, their order and every answer built from them are unchanged.

/** Every gateway a call can name: each provider's, AMCP's own, an unknown one and a name an object answers. */
const gateways = [
  ...providerAdapters.map(a => a.gateway),
  'amcp_native_action',
  'unknown_native_action',
  'constructor',
  '__proto__',
];
const outcome = fn => {
  try {
    return {returns: fn()};
  } catch (error) {
    return {throws: {name: error?.name, code: error?.code, message: error?.message, details: error?.details}};
  }
};

// src/unavailable-operations.ts as it was: the provider rows (AMCP's own operations did not move).
const connections = {
  website_path: '/connections',
  meaning: 'Connect, reconnect or disconnect the provider on the Connections page of the AMCP website.',
};
const adjust = [
  {
    tool: 'adjust_native_action',
    arguments: {operation: 'adjust_reporting'},
    meaning: 'Adjust apps, events, filters, reports and pivots: the Adjust reads AMCP runs.',
  },
  {
    tool: 'adjust_native_action',
    arguments: {operation: 'adjust_list_assets'},
    meaning: 'The Adjust connections and app bindings configured in AMCP.',
  },
];
const connectionOps = (gateway, operation, provider) => ({
  actions: ['start', 'exchange', 'refresh'],
  reason: provider + ' is connected through the AMCP website, not through a tool call.',
  alternatives: [
    connections,
    {
      tool: gateway,
      arguments: {operation, arguments: {action: 'status'}},
      meaning: 'The recorded state of this provider’s connections; the operation’s status, sync and disconnect run.',
    },
  ],
});
const oldProviderOperations = {
  adjust_native_action: {
    adjust_ad_spend: {reason: 'AMCP sends no ad spend to Adjust.', alternatives: adjust},
    adjust_app_automation: {reason: 'AMCP does not manage Adjust apps or app secrets.', alternatives: adjust},
    adjust_campaign_api: {reason: 'AMCP does not read or change Adjust trackers or partners.', alternatives: adjust},
    adjust_deeplinks: {reason: 'AMCP does not read or create Adjust deep links.', alternatives: adjust},
  },
  commerce_native_action: {
    woocommerce_store_ops: {
      reason:
        'AMCP reads WooCommerce products only as catalog sources; store reports, orders and customers are not read. Shopify and Salla have no connection, and WooCommerce expansion is parked.',
      alternatives: [
        {
          tool: 'amcp_workspace',
          arguments: {action: 'catalog_sources'},
          meaning: 'The WooCommerce stores configured as catalog sources.',
        },
        {
          tool: 'amcp_workspace',
          arguments: {action: 'catalog_source'},
          meaning: 'Read the products of one configured store.',
        },
      ],
    },
  },
  ga4_native_action: {ga4_connection_ops: connectionOps('ga4_native_action', 'ga4_connection_ops', 'Google Analytics')},
  google_search_console_native_action: {
    gsc_connection_ops: connectionOps('google_search_console_native_action', 'gsc_connection_ops', 'Search Console'),
  },
  google_business_native_action: {
    gmb_connection_ops: connectionOps('google_business_native_action', 'gmb_connection_ops', 'Business Profile'),
    gmb_engagement_ops: {
      actions: ['LEGACY_V4_REQUEST'],
      reason: 'AMCP sends no request to the retired Business Profile v4 API.',
      alternatives: [
        {
          tool: 'google_business_native_action',
          arguments: {operation: 'gmb_engagement_ops', arguments: {action: 'LIST_PLACE_ACTION_LINKS'}},
          meaning: 'The place-action links of a location; the other actions of this operation run.',
        },
      ],
    },
  },
};
const oldUnavailable = {amcp_native_action: unavailableOperations.amcp_native_action, ...oldProviderOperations};
function oldUnavailableOperation(gateway, operation, action) {
  if (typeof operation !== 'string') return undefined;
  const entry = oldUnavailable[gateway]?.[operation];
  if (!entry || (entry.actions && !(typeof action === 'string' && entry.actions.includes(action)))) return undefined;
  return entry;
}
const oldUnavailableNames = gateway =>
  Object.entries(oldUnavailable[gateway] ?? {})
    .filter(([, entry]) => !entry.actions)
    .map(([operation]) => operation);
function oldUnavailableRefusal(gateway, input) {
  const action = input.arguments && typeof input.arguments === 'object' ? input.arguments.action : undefined,
    entry = oldUnavailableOperation(gateway, input.operation, action);
  if (!entry) return undefined;
  const name = String(input.operation) + (entry.actions ? ' ' + String(action) : '');
  return {
    code: gateway === 'amcp_native_action' ? 'WORKFLOW_UNSUPPORTED' : 'CAPABILITY_UNAVAILABLE',
    message: name + ' is listed for compatibility with the captured catalog, but AMCP cannot run it. ' + entry.reason,
    details: {
      gateway,
      operation: input.operation,
      ...(entry.actions ? {action} : {}),
      status: 'unmapped',
      alternatives: structuredClone(entry.alternatives),
      submission: 'not_sent',
    },
  };
}
const operationNames = [
  ...new Set(Object.values(oldUnavailable).flatMap(operations => Object.keys(operations))),
  'gmb_qanda_ops',
  'unknown_ops',
  'constructor',
  'toString',
  undefined,
  7,
];
const actionValues = [undefined, 'status', 'start', 'exchange', 'refresh', 'LEGACY_V4_REQUEST', 'other', 'constructor'];

test('the unavailable operations table lists the same rows in the same order, as plain rows', () => {
  assert.deepEqual(Object.keys(unavailableOperations), Object.keys(oldUnavailable));
  for (const [gateway, operations] of Object.entries(oldUnavailable)) {
    assert.deepEqual(Object.keys(unavailableOperations[gateway]), Object.keys(operations), gateway);
    assert.deepEqual(unavailableOperations[gateway], operations, gateway);
  }
  // The rows are plain, as they always were; Adjust's rows still share their alternatives, every connection
  // operation the website's Connections page.
  const rows = unavailableOperations.adjust_native_action;
  assert.equal(Object.isFrozen(rows.adjust_ad_spend), false);
  assert.equal(rows.adjust_ad_spend.alternatives, rows.adjust_deeplinks.alternatives);
  assert.equal(
    unavailableOperations.ga4_native_action.ga4_connection_ops.alternatives[0],
    unavailableOperations.amcp_native_action.disconnect_google_reporting.alternatives[0],
  );
  // The providers' declared rows stay frozen in their adapters.
  for (const hooks of registeredProviderHooks)
    for (const part of [hooks.unavailable, hooks.connection]) if (part) assert.ok(Object.isFrozen(part), hooks.gateway);
  assert.ok(
    Object.isFrozen(providerHooks('adjust_native_action').unavailable.adjust_ad_spend.alternatives[0].arguments),
  );
});

test('every gateway finds, names and refuses the same unavailable operations', () => {
  for (const gateway of gateways) {
    assert.deepEqual(unavailableOperationNames(gateway), oldUnavailableNames(gateway), gateway);
    for (const operation of operationNames)
      for (const action of actionValues) {
        const label = gateway + ' ' + String(operation) + ' ' + String(action);
        assert.deepEqual(
          outcome(() => unavailableOperation(gateway, operation, action)),
          outcome(() => oldUnavailableOperation(gateway, operation, action)),
          label,
        );
        for (const input of [{operation, arguments: {action}}, {operation, arguments: 'status'}, {operation}]) {
          const refusal = unavailableRefusal(gateway, input),
            old = oldUnavailableRefusal(gateway, input);
          assert.deepEqual(
            refusal && {code: refusal.code, message: refusal.message, details: refusal.details},
            old,
            label,
          );
        }
      }
  }
});

// src/connection-diagnostics.ts as it was.
const oldConnectionOperations = {
  ga4_native_action: 'ga4_connection_ops',
  google_search_console_native_action: 'gsc_connection_ops',
  google_business_native_action: 'gmb_connection_ops',
};
function oldRedactConnectionInput(gateway, input) {
  if (
    oldConnectionOperations[gateway] !== input.operation ||
    !input.arguments ||
    typeof input.arguments !== 'object' ||
    Array.isArray(input.arguments)
  )
    return input;
  const args = {...input.arguments};
  for (const key of ['code', 'state']) if (Object.hasOwn(args, key)) args[key] = '[REDACTED]';
  return {...input, arguments: args};
}
function oldConnectionDiagnosticKind(gateway, operation, action) {
  if (oldConnectionOperations[gateway] === operation && action === 'status') return 'connection';
  if (
    gateway === 'google_business_native_action' &&
    operation === 'gmb_qanda_ops' &&
    (action === undefined || action === 'status')
  )
    return 'qanda';
}

test('every gateway classifies and redacts its connection diagnostics as before', () => {
  for (const gateway of gateways)
    for (const operation of operationNames)
      for (const action of actionValues) {
        const label = gateway + ' ' + String(operation) + ' ' + String(action);
        assert.equal(
          connectionDiagnosticKind(gateway, operation, action),
          oldConnectionDiagnosticKind(gateway, operation, action),
          label,
        );
        for (const args of [{action, code: 'c', state: 's'}, {code: 'c'}, ['code'], 'code', undefined]) {
          const input = {operation, arguments: args};
          assert.deepEqual(redactConnectionInput(gateway, input), oldRedactConnectionInput(gateway, input), label);
        }
      }
  // Only Business Profile declares a retired Q&A operation; the three connection operations are their providers'.
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.connection).map(h => [h.gateway, h.connection]),
    [
      [
        'google_business_native_action',
        {operation: 'gmb_connection_ops', provider: 'Business Profile', qanda: 'gmb_qanda_ops'},
      ],
      ['ga4_native_action', {operation: 'ga4_connection_ops', provider: 'Google Analytics'}],
      ['google_search_console_native_action', {operation: 'gsc_connection_ops', provider: 'Search Console'}],
    ],
  );
});

// src/discovery-programs.ts as it was.
const meaning =
  'Listed for discovery only: AMCP makes no request for this program and cannot check it. Its prerequisites are external approvals the provider grants; record the outcome in the provider access register.';
const linkedinAudiencesReason =
  "Needs LinkedIn's rw_dmp_segments permission, which belongs to the Audiences program and \"is not granted automatically as part of the LinkedIn Marketing API Program\" (Matched Audiences pages, read 2026-09-30). AMCP's LinkedIn connection asks for r_ads, r_ads_reporting and rw_ads, so this waits on the owner's decision to request the permission and on LinkedIn's approval of the program.";
const linkedinMediaPlansReason =
  "Needs LinkedIn's rw_media_plans permission, which belongs to the Media Planning API program and \"is not granted automatically as part of the LinkedIn Marketing API Program\" (Manage Media Plans page, read 2026-09-30). AMCP's LinkedIn connection does not ask for it; this waits on the owner's decision and LinkedIn's approval.";
const oldPrograms = [
  {
    id: 'program:linkedin_lead_sync',
    kind: 'discovery_only_program',
    mode: 'discovery_only',
    name: 'LinkedIn Lead Sync',
    gateway: 'linkedin_native_action',
    description: 'Read the lead responses members submit through LinkedIn lead gen forms.',
    effects: 'none',
    provider_requests: 0,
    prerequisites: [
      {
        id: 'lead_sync_program',
        text: 'LinkedIn must approve the application for the Lead Sync API, which is a separate program from the Advertising API.',
      },
      {
        id: 'lead_sync_permission',
        text: 'The connected member must grant r_marketing_leadgen_automation, which AMCP does not request today.',
      },
      {
        id: 'personal_data_policy',
        text: 'Lead responses are personal data: reading them also needs the personal-data policy to open LinkedIn leads.',
      },
    ],
    program: {
      access: 'The Lead Sync page states that the Lead Sync API is a separate program with its own permission.',
      reference: 'https://learn.microsoft.com/en-us/linkedin/marketing/lead-sync/leadsync?view=li-lms-2026-09',
      checked_on: '2026-10-08',
    },
    unlocks: ['LinkedIn lead responses for lead generation reporting'],
    withheld_actions: [],
    personal_data:
      'AMCP never reads lead responses through this entry. Lead forms themselves are reviewed (linkedin_lead_forms); the responses stay behind the personal-data policy.',
    meaning,
  },
  {
    id: 'program:linkedin_matched_audiences',
    kind: 'discovery_only_program',
    mode: 'discovery_only',
    name: 'LinkedIn Matched Audiences',
    gateway: 'linkedin_native_action',
    description: 'Create and change DMP segments, company and contact lists, and page-set audiences.',
    effects: 'none',
    provider_requests: 0,
    prerequisites: [
      {
        id: 'audiences_program',
        text: 'LinkedIn must approve the application for the Audiences program; it is not granted with the Marketing API.',
      },
      {
        id: 'rw_dmp_segments_permission',
        text: 'The connected member must grant rw_dmp_segments, which AMCP does not request today.',
      },
    ],
    program: {
      access:
        'rw_dmp_segments belongs to the Audiences program and is not granted automatically with the LinkedIn Marketing API Program.',
      reference:
        'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/create-and-manage-segments?view=li-lms-2026-09',
      checked_on: '2026-09-30',
    },
    unlocks: ['Reviewed LinkedIn audience writes (DMP segments, page sets and company lists)'],
    withheld_actions: [
      'linkedin_rest_ad_page_sets_post',
      'linkedin_rest_ad_segment_sources_source_urn_li_ad_page_set_id_segment_urn_li_ad_segment_id_put',
      'linkedin_rest_ad_segment_sources_source_urn_li_ad_page_set_id_segment_urn_li_ad_segment_id_delete',
      'linkedin_rest_dmp_segments_segment_id_business_objective_based_audiences_post',
      'linkedin_rest_dmp_segments_segment_id_business_objective_based_audiences_audience_id_post',
      'linkedin_rest_dmp_segments_segment_id_business_objective_based_audiences_audience_id_delete',
      'linkedin_rest_dmp_segments_segment_id_destinations_post',
      'linkedin_rest_dmp_segments_segment_id_companies_post',
      'linkedin_rest_ad_segments_segment_id_post',
    ],
    withheld_reason: linkedinAudiencesReason,
    meaning,
  },
  {
    id: 'program:linkedin_media_plans',
    kind: 'discovery_only_program',
    mode: 'discovery_only',
    name: 'LinkedIn saved media plans',
    gateway: 'linkedin_native_action',
    description: 'Save media plans in Campaign Manager from a forecast.',
    effects: 'none',
    provider_requests: 0,
    prerequisites: [
      {
        id: 'media_planning_program',
        text: 'LinkedIn must provision the Media Planning API product for the application (Advertising API access, an application survey and Technical Sign Off).',
      },
      {
        id: 'rw_media_plans_permission',
        text: 'The connected member must grant rw_media_plans, which AMCP does not request today.',
      },
    ],
    program: {
      access:
        'rw_media_plans belongs to the Media Planning API program and is not granted automatically with the LinkedIn Marketing API Program.',
      reference:
        'https://learn.microsoft.com/en-us/linkedin/marketing/media-planning/media-planning-overview?view=li-lms-2026-09',
      checked_on: '2026-10-08',
    },
    unlocks: ['Reviewed LinkedIn media plan saves'],
    withheld_actions: ['linkedin_rest_media_plans_post'],
    withheld_reason: linkedinMediaPlansReason,
    meaning,
  },
  {
    id: 'program:x_ads_api_access',
    kind: 'discovery_only_program',
    mode: 'discovery_only',
    name: 'X Ads API access',
    gateway: 'x_ads_native_action',
    description: 'Use the X Ads API for an advertiser account: reads, reviewed writes and analytics.',
    effects: 'none',
    provider_requests: 0,
    prerequisites: [
      {
        id: 'ads_api_access_form',
        text: 'X must approve the developer application through the Ads API access form before any Ads API request succeeds.',
      },
      {
        id: 'advertiser_account_access',
        text: 'The connected X user needs access to the advertiser account in X Ads.',
      },
    ],
    program: {
      access: 'The X Ads API needs an approved application through the Ads API access form.',
      reference: 'https://docs.x.com/x-ads-api/introduction',
      checked_on: '2026-10-08',
    },
    unlocks: ['X reporting', 'Reviewed X campaign and catalog writes'],
    withheld_actions: [],
    meaning,
  },
  {
    id: 'program:dv360_bid_manager_reporting',
    kind: 'discovery_only_program',
    mode: 'discovery_only',
    name: 'Display & Video 360 reporting (Bid Manager)',
    gateway: 'dv360_native_action',
    description: 'Run Display & Video 360 reports through the Bid Manager API.',
    effects: 'none',
    provider_requests: 0,
    prerequisites: [
      {
        id: 'bid_manager_scope',
        text: 'The Google identity must grant the Bid Manager OAuth scope, which is separate from the Display & Video 360 scope.',
      },
      {
        id: 'dv360_customer_role',
        text: 'The Google identity needs a Display & Video 360 user profile with access to the partner or advertiser.',
      },
      {
        id: 'reporting_workflow',
        text: 'AMCP has no Bid Manager report workflow yet; reports, query runs and report retrieval are not available.',
      },
    ],
    program: {
      access:
        'Bid Manager reporting uses its own OAuth scope and report workflow; an advertiser read does not establish reporting access.',
      reference: 'https://developers.google.com/bid-manager',
      checked_on: '2026-10-08',
    },
    unlocks: ['Display & Video 360 reporting'],
    withheld_actions: [],
    meaning,
  },
];

test('the discovery-only programs are the same entries in the same order, with the same keys in the same order', () => {
  assert.deepEqual(discoveryOnlyPrograms, oldPrograms);
  discoveryOnlyPrograms.forEach((program, i) => {
    assert.deepEqual(Object.keys(program), Object.keys(oldPrograms[i]), program.id);
    assert.deepEqual(Object.keys(program.program), Object.keys(oldPrograms[i].program), program.id);
    assert.equal(Object.isFrozen(program) || Object.isFrozen(program.prerequisites), false, program.id);
    assert.deepEqual(discoveryOnlyListing(program), discoveryOnlyListing(oldPrograms[i]), program.id);
    assert.equal(discoveryOnlyProgram(program.id), program);
  });
  assert.equal(discoveryOnlyProgram('program:unknown'), undefined);
  const actions = [...new Set(oldPrograms.flatMap(p => p.withheld_actions)), 'linkedin_rest_ad_accounts_get', ''];
  for (const gateway of gateways)
    for (const action of actions)
      assert.equal(
        withheldWriteProgram(gateway, action)?.id,
        oldPrograms.find(p => p.gateway === gateway && p.withheld_actions.includes(action))?.id,
        gateway + ' ' + action,
      );
  for (const hooks of registeredProviderHooks)
    if (hooks.programs) {
      assert.ok(Object.isFrozen(hooks.programs), hooks.gateway);
      for (const program of hooks.programs) assert.ok(Object.isFrozen(program.prerequisites[0]), program.id);
    }
});

// src/parameters.ts as it was: its provider tables and the functions that read them, verbatim but for the types.
const oldParameters = (() => {
  const encodedBodyGateways = ['dv360_native_action', 'linkedin_native_action', 'x_ads_native_action'];
  const accountAliases = {
    meta_native_action: ['ad_account_id', 'account_id'],
    tiktok_native_action: ['advertiser_id', 'account_id'],
    snapchat_native_action: ['ad_account_id', 'account_id'],
    google_ads_native_action: ['account_id', 'customer_id'],
    linkedin_native_action: ['account_id', 'ad_account_id'],
    x_ads_native_action: ['account_id'],
    amazon_native_action: ['profile_id'],
    apple_ads_native_action: ['account_id', 'ad_account_id', 'org_id'],
    dv360_native_action: ['advertiserId'],
    reddit_native_action: ['account_id', 'ad_account_id'],
  };
  const controls = new Set([
    'action',
    'params',
    'path_params',
    'pathParams',
    'query',
    'payload',
    'body',
    'connection_id',
    'connectionId',
    'aggregate_pages',
    'max_pages',
    'paginate',
    'allPages',
    'dry_run',
    'confirmed',
    'idempotency_key',
    'before_state',
    'spend_change_confirmed',
    'result_fields',
    'result_ids',
    'fields',
    'max_items',
    'compact',
  ]);
  const catalogOnly = new Set([
    'target_action',
    'search',
    'category',
    'read_only',
    'limit',
    'offset',
    'cursor',
    'service',
    'surface',
  ]);
  const unsupported = {
    campaign: 'Curated campaign preflight is not implemented. Put native request fields in payload.',
    adset: 'Curated ad-set preflight is not implemented. Put native request fields in payload.',
    creative: 'Curated creative preflight is not implemented. Put native request fields in payload.',
    ad: 'Curated ad preflight is not implemented. Put native request fields in payload.',
    assets: 'Curated asset preflight is not implemented.',
    context: 'Curated context preflight is not implemented.',
    skip_preflight: 'Bypassing provider preflight is not supported.',
    override_preflight: 'Bypassing provider preflight is not supported.',
    allowUnsupportedLineItemTypes: 'The DV360 validation escape hatch is not implemented.',
    region: 'Regional Amazon routing is not implemented for captured actions.',
  };
  const platformControls = {
    x_ads_native_action: ['download_report'],
    meta_native_action: ['business_id', 'page_id', 'report_run_id', 'batch', 'adbatch', 'include_headers'],
    tiktok_native_action: ['lead_region', 'comment_scope'],
    linkedin_native_action: ['restli_method', 'http_method_override', 'body_format', 'api_version'],
    dv360_native_action: ['resource', 'method'],
  };
  function parameterHandling(gateway, key) {
    if (controls.has(key)) return 'compiler/service';
    if (catalogOnly.has(key)) return 'introspection only (Snapchat reporting limit is native)';
    if (key in unsupported) return 'explicitly unsupported when enabled';
    if (accountAliases[gateway]?.includes(key)) return 'account scope alias';
    if (platformControls[gateway]?.includes(key)) return 'platform routing or explicit unsupported action';
    return undefined;
  }
  function nativeFields(gateway, action) {
    return gateway === 'meta_native_action' || (action.raw.native_fields ?? []).includes('fields');
  }
  function nativeTopLevel(gateway, action, input) {
    const pathKeys = new Set([...action.path.matchAll(/\{\+?([^{}=]+)(?:=[^{}]+)?\}/g)].map(m => m[1]));
    const nativeKeys = new Set(action.raw.native_fields ?? []);
    if (nativeFields(gateway, action)) nativeKeys.add('fields');
    if (gateway === 'snapchat_native_action' && /stats|report/i.test(action.path)) nativeKeys.add('limit');
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      if (key in unsupported) {
        if (value === false) continue;
        throw new MirrorError('UNSUPPORTED_PARAMETER', unsupported[key], {parameter: key, gateway});
      }
      if (key === 'body_format' && gateway === 'linkedin_native_action' && value !== 'json')
        throw new MirrorError(
          'UNSUPPORTED_PARAMETER',
          'LinkedIn form query tunneling is not implemented; use JSON requests.',
          {parameter: key},
        );
      if (controls.has(key) && key !== 'fields') continue;
      if (pathKeys.has(key) || nativeKeys.has(key)) {
        out[key] =
          gateway === 'meta_native_action' && key === 'fields' && Array.isArray(value) ? value.join(',') : value;
        continue;
      }
      if (gateway === 'x_ads_native_action' && input.download_report === true && ['offset', 'limit'].includes(key))
        continue;
      if (catalogOnly.has(key))
        throw new MirrorError(
          'UNSUPPORTED_PARAMETER',
          key + ' only applies to introspection for this action. Put native API parameters in params or query.',
          {parameter: key},
        );
      if (gateway === 'meta_native_action' && platformControls[gateway].includes(key))
        throw new MirrorError(
          'UNSUPPORTED_PARAMETER',
          key + ' is not routed by this action. Automatic Page Access Token resolution is not implemented.',
          {parameter: key},
        );
      if (!parameterHandling(gateway, key))
        throw new MirrorError(
          'UNSUPPORTED_PARAMETER',
          'Unrecognized top-level parameter. Put native API fields in params, query or payload.',
          {parameter: key},
        );
    }
    return out;
  }
  return {encodedBodyGateways, accountAliases, platformControls, parameterHandling, nativeFields, nativeTopLevel};
})();

test('the parameter tables and checks answer every gateway, action and top-level parameter as before', () => {
  assert.deepEqual(encodedBodyGateways, oldParameters.encodedBodyGateways);
  assert.equal(Object.isFrozen(encodedBodyGateways), false);
  assert.deepEqual(accountAliases, oldParameters.accountAliases);
  assert.deepEqual(Object.keys(accountAliases), Object.keys(oldParameters.accountAliases));
  assert.equal(Object.getPrototypeOf(accountAliases), Object.prototype);
  for (const aliases of Object.values(accountAliases)) assert.equal(Object.isFrozen(aliases), false);
  const keys = [
    ...new Set([
      ...Object.values(oldParameters.accountAliases).flat(),
      ...Object.values(oldParameters.platformControls).flat(),
      'action',
      'params',
      'payload',
      'fields',
      'result_fields',
      'limit',
      'offset',
      'cursor',
      'search',
      'campaign',
      'region',
      'allowUnsupportedLineItemTypes',
      'id',
      'name',
      'parent',
      'native_only',
      'unknown_key',
      'constructor',
      'toString',
      '__proto__',
      'hasOwnProperty',
    ]),
  ];
  const actions = [
    {path: '/v1/accounts/{account_id}/stats', raw: {}},
    {path: '/v1/{ad_account_id}/reports/summary', raw: {native_fields: ['name']}},
    {path: '/v2/{+parent}/items/{id=*}', raw: {native_fields: ['fields', 'limit']}},
    {path: '/v1/campaigns/{id}', raw: {native_fields: ['offset', 'native_only']}},
    {path: '/rest/adAccounts/{account_id}', raw: {}},
  ];
  const values = [true, false, 'json', 'form', 7, ['a', 'b'], {nested: 1}, null, undefined];
  let compared = 0;
  for (const gateway of gateways) {
    for (const key of keys)
      assert.deepEqual(
        outcome(() => parameterHandling(gateway, key)),
        outcome(() => oldParameters.parameterHandling(gateway, key)),
        gateway + ' ' + key,
      );
    for (const action of actions) {
      assert.equal(nativeFields(gateway, action), oldParameters.nativeFields(gateway, action), gateway + action.path);
      const inputs = [
        {},
        {download_report: true, offset: 1, limit: 2, cursor: 'c'},
        {download_report: false, offset: 1},
        {download_report: 'true', limit: 2},
        {fields: ['a', 'b'], body_format: 'json', account_id: '1'},
        {body_format: 'form', fields: 'a,b'},
        ...keys.flatMap(key => values.map(value => Object.defineProperty({}, key, {value, enumerable: true}))),
      ];
      for (const input of inputs) {
        compared++;
        assert.deepEqual(
          outcome(() => nativeTopLevel(gateway, action, input)),
          outcome(() => oldParameters.nativeTopLevel(gateway, action, input)),
          gateway + ' ' + action.path + ' ' + JSON.stringify(input),
        );
      }
    }
  }
  assert.ok(compared > 40000, String(compared));
  for (const hooks of registeredProviderHooks)
    if (hooks.parameters) {
      assert.ok(Object.isFrozen(hooks.parameters), hooks.gateway);
      for (const list of [hooks.parameters.accountAliases, hooks.parameters.platformControls])
        if (list) assert.ok(Object.isFrozen(list), hooks.gateway);
    }
});

test('the refusal a moved parameter rule raises is still a reason the localization inventory owns', () => {
  // Regression (wave 4c round 6): LinkedIn's body-format refusal left src/parameters.ts as a string fact, which the
  // inventory of directly owned reasons (and so its Arabic check) no longer saw; its adapter constructs it now.
  const reason = 'LinkedIn form query tunneling is not implemented; use JSON requests.';
  const owned = file => inspectBackendContractFailures(fs.readFileSync(file, 'utf8'), file);
  assert.ok(owned('src/linkedin-adapter.ts').has(reason));
  assert.ok(!owned('src/parameters.ts').has(reason));
  const refused = outcome(() =>
    nativeTopLevel('linkedin_native_action', {path: '/rest/adAccounts/{account_id}', raw: {}}, {body_format: 'form'}),
  );
  assert.deepEqual(refused.throws, {
    name: 'MirrorError',
    code: 'UNSUPPORTED_PARAMETER',
    message: reason,
    details: {parameter: 'body_format'},
  });
});

// src/provider-jobs.ts as it was: the job families' contract, and the reviewed families' gateways.
const oldJobContracts = Object.freeze([
  {
    family: 'x_report_jobs',
    gateway: 'x_ads_native_action',
    provider: 'x',
    kind: 'report',
    admission: 'At most 100 unresolved jobs per account (admitXReport).',
    lost_response: 'Uncertain; the original job is polled by its ID and never replaced.',
    retrieval: 'download_report on the original job: a bounded gzip from the pinned X download host.',
  },
  {
    family: 'tiktok_report_jobs',
    gateway: 'tiktok_native_action',
    provider: 'tiktok',
    kind: 'report',
    admission: 'One per second and 500 per hour per app and account (admitTiktokReport).',
    lost_response: 'Uncertain; the original task is checked, never resubmitted.',
    retrieval: 'The original task is checked and its bounded file downloaded with the same login.',
  },
  {
    family: 'meta_insights_jobs',
    gateway: 'meta_native_action',
    provider: 'meta',
    kind: 'report',
    admission: 'The deployment-wide hourly bound per account (admitProviderJob).',
    lost_response: 'Uncertain; the original report run is read by its ID, never resubmitted.',
    retrieval: 'Bounded pages of the original report run.',
  },
  {
    family: 'dv360_sdf_downloads',
    gateway: 'dv360_native_action',
    provider: 'dv360',
    kind: 'export',
    admission: 'The deployment-wide hourly bound per account (admitProviderJob).',
    lost_response: 'Uncertain; the original operation is read by its name, never resubmitted.',
    retrieval: 'The original operation is read until done; its files are then downloaded with media.download.',
  },
  {
    family: 'criteo_report_jobs',
    gateway: 'criteo_native_action',
    provider: 'criteo',
    kind: 'report',
    admission: 'The deployment-wide hourly bound per account (admitProviderJob).',
    lost_response: 'Uncertain; the original report is read by its ID, never resubmitted.',
    retrieval: 'The original report’s bounded output.',
  },
  {
    family: 'tiktok_change_log_tasks',
    gateway: 'tiktok_native_action',
    provider: 'tiktok',
    kind: 'change_log',
    admission: 'The deployment-wide hourly bound per account (admitProviderJob).',
    lost_response: 'Uncertain; the original task is checked, never resubmitted.',
    retrieval: 'The original task’s status and bounded download.',
  },
  {
    family: 'ga4_export_jobs',
    gateway: 'ga4_native_action',
    provider: 'ga4',
    kind: 'report',
    admission: 'The deployment-wide hourly bound per property (admitProviderJob); report tasks only.',
    lost_response: 'Uncertain; the original report task is read by its name, never resubmitted.',
    retrieval: 'Bounded pages of the original report task.',
  },
  {
    family: 'microsoft_reporting_pipeline',
    gateway: 'microsoft_ads_native_action',
    provider: 'microsoft',
    kind: 'report',
    admission: 'The deployment-wide hourly bound per account (admitProviderJob).',
    lost_response:
      'Uncertain; the Overview never submits it again (PROVIDER_JOB_UNCERTAIN), and a new snapshot submits a new job.',
    retrieval: 'PollGenerateReport on the original ReportRequestId, a bounded ZIP and CSV.',
  },
]);
const oldJobGateways = [
  ...new Set(oldJobContracts.filter(j => j.family !== 'microsoft_reporting_pipeline').map(j => j.gateway)),
];
// src/capability-graph.ts as it was: a recipe's gateway.
const oldRecipeGateways = {google: 'google_ads_native_action', microsoft: 'microsoft_ads_native_action'};

test('the provider job contracts, their gateways and the job capability filter are the same rows in the same order', () => {
  assert.deepEqual(providerJobContracts, oldJobContracts);
  assert.ok(Object.isFrozen(providerJobContracts));
  providerJobContracts.forEach((row, i) => {
    assert.deepEqual(Object.keys(row), Object.keys(oldJobContracts[i]), row.family);
    assert.equal(Object.isFrozen(row), false, row.family);
    assert.equal(Object.getPrototypeOf(row), Object.prototype, row.family);
  });
  assert.deepEqual(providerJobGateways, oldJobGateways);
  assert.ok(Object.isFrozen(providerJobGateways));
  const families = [...oldJobContracts.map(j => j.family), 'unknown_jobs', '', 'constructor', '__proto__', 'toString'];
  for (const family of families)
    assert.equal(reviewedJobFamily(family), family !== 'microsoft_reporting_pipeline', family);
  // providerJobCapability's filter of the job families, for every gateway and none (offering aside, which is shared).
  for (const gateway of [...gateways, undefined])
    assert.deepEqual(
      providerJobContracts.filter(j => reviewedJobFamily(j.family) && (!gateway || j.gateway === gateway)),
      oldJobContracts.filter(j => j.family !== 'microsoft_reporting_pipeline' && (!gateway || j.gateway === gateway)),
      String(gateway),
    );
  assert.ok(Object.isFrozen(providerJobFamilies));
  for (const {hooks, job} of providerJobFamilies) {
    assert.ok(Object.isFrozen(job), job.family);
    assert.ok(Object.isFrozen(hooks.jobs), hooks.gateway);
  }
  // capabilityGraph's recipe gateways: each recipe's gateway as the old map and naming rule gave it.
  assert.ok(campaignRecipes.length > 0);
  for (const recipe of campaignRecipes)
    assert.equal(
      recipeGateway(recipe.id),
      oldRecipeGateways[recipe.platform] ?? recipe.platform + '_native_action',
      recipe.id,
    );
});
