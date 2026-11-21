import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {inspectBackendContractFailures} from '../tools/check-locales.mjs';
import {providerAdapters, retiredActionProviders} from '../dist/src/provider-adapters.js';
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
import {effectClass, microsoftReportSubmit, providerJob} from '../dist/src/effect-class.js';
import {microsoftHooks} from '../dist/src/microsoft-adapter.js';
import {campaignRecipes, recipeGateway} from '../dist/src/campaign-recipes.js';
import {
  assertProviderActionAvailable,
  assertProviderAliasAvailable,
  retiredGoogleAdsActions,
  retiredProviderAction,
  retiredProviderActions,
  unsupportedProviderAlias,
  unsupportedProviderAliases,
} from '../dist/src/retired-provider-actions.js';
import {
  providerValidationRequest,
  providerValidationScope,
  runProviderValidation,
  validateProviderRequest,
} from '../dist/src/provider-validation.js';
import {redact} from '../dist/src/security.js';
import {validate, writer} from '../dist/src/workspace-core.js';
import {assertWriteShape} from '../dist/src/write-shape.js';
import {
  dataManagerContract,
  dataManagerContractName,
  discoveryIssues,
  sealedVendorDocument,
  wireContractCheck,
  wireContractResolver,
} from '../dist/src/wire-contracts.js';
import {microsoftWireContract} from '../dist/src/microsoft-wire-contract.js';
import {dataManagerOrigin} from '../dist/src/google-data-manager-routes.js';
import {pinnedJson} from '../dist/src/pinned-json.js';
import {Store} from '../dist/src/store.js';
import {googleAdsRequestActions} from '../dist/src/audit-repository.js';

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
    assert.ok(Object.isFrozen(hooks.jobFamilies), hooks.gateway);
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

// Regression (wave 4c-r7 review): merged with the versions package, whose ProviderHooks.jobs ({submission}) names
// Microsoft's report submission for the effect taxonomy (src/effect-class.ts), this package's job family rows are
// ProviderHooks.jobFamilies. Microsoft's hooks carry both, every hooks entry gives each field one shape, and the report
// submission, compiled as a read, is still a provider job (the owner's job switch, quota and admission).
test('the job family rows and the provider jobs no family declares are two hooks fields, and Microsoft’s hooks carry both', () => {
  assert.equal(providerHooks('microsoft_ads_native_action'), microsoftHooks);
  assert.equal(typeof microsoftHooks.jobs.submission, 'function');
  assert.deepEqual(
    microsoftHooks.jobFamilies.map(job => job.family),
    ['microsoft_reporting_pipeline'],
  );
  for (const hooks of registeredProviderHooks) {
    if ('jobs' in hooks) {
      assert.ok(
        typeof hooks.jobs === 'object' && !Array.isArray(hooks.jobs) && Object.isFrozen(hooks.jobs),
        hooks.gateway,
      );
      assert.equal(typeof hooks.jobs.submission, 'function', hooks.gateway);
    }
    if ('jobFamilies' in hooks)
      assert.ok(
        Array.isArray(hooks.jobFamilies) && hooks.jobFamilies.length > 0 && Object.isFrozen(hooks.jobFamilies),
        hooks.gateway,
      );
  }
  const declaring = field => registeredProviderHooks.filter(hooks => field in hooks).map(hooks => hooks.gateway);
  assert.deepEqual(declaring('jobs'), ['microsoft_ads_native_action']);
  assert.deepEqual(declaring('jobFamilies'), [
    'meta_native_action',
    'tiktok_native_action',
    'x_ads_native_action',
    'microsoft_ads_native_action',
    'dv360_native_action',
    'ga4_native_action',
    'criteo_native_action',
  ]);
  // The rows the job order lists are the jobFamilies rows, each with the hooks entry that declares it.
  for (const {hooks, job} of providerJobFamilies) assert.ok(hooks.jobFamilies.includes(job), job.family);
  assert.deepEqual(
    providerJobFamilies.map(({hooks, job}) => [hooks.gateway, job.family]),
    oldJobContracts.map(row => [row.gateway, row.family]),
  );
  const submit = {
    gateway: 'microsoft_ads_native_action',
    action: 'SubmitGenerateReport',
    method: 'POST',
    path: '/Reporting/v13/GenerateReport/Submit',
    readOnly: true,
    body: {},
  };
  assert.equal(microsoftReportSubmit(submit), true);
  assert.equal(providerJob(submit), true);
  assert.equal(effectClass(submit), 'provider_job');
  assert.equal(microsoftReportSubmit({...submit, action: 'PollGenerateReport'}), false);
  assert.equal(microsoftReportSubmit({...submit, method: 'GET'}), false);
  assert.equal(microsoftReportSubmit({...submit, gateway: 'google_ads_native_action'}), false);
});

// src/retired-provider-actions.ts as it was: the withdrawn methods and unsupported aliases, and their refusals.
const oldRetired = (() => {
  const tagManagerReplacement =
    'Use the current Google tag management interface and supported list/get workflows; no equivalent API mutation has been established.';
  const lifecycleReplacement =
    'In v25 new customer acquisition is a goal: a NEW_CUSTOMER_ACQUISITION goal (google_ads_v23_goal_mutate_goals) and its campaign settings (google_ads_v23_campaign_goal_config_mutate_campaign_goal_configs). Both are reviewed writes: create the goal with google_ads_v23_goal_mutate_goals, then link each campaign with google_ads_v23_campaign_goal_config_mutate_campaign_goal_configs.';
  /** Official withdrawal overrides a historical catalog or Discovery mapping.
   * Keep these entries discoverable; never turn them into executable contracts. */
  const retiredProviderActions = [
    // X Ads API v5 reached end of life on 2020-03-03 (X Ads API Versioning, read 2026-10-08); AMCP sends v12, yet the
    // captured catalog still routed the two recommendation reads to /5/ (PRV-04, src/provider-deprecations.ts).
    ...[
      ['x_accounts_account_id_recommendations_get', '^/5/accounts/[^/]+/recommendations$'],
      ['x_accounts_account_id_recommendations_recommendation_id_get', '^/5/accounts/[^/]+/recommendations/[^/]+$'],
    ].map(([action, path]) => ({
      gateway: 'x_ads_native_action',
      action,
      method: 'GET',
      path: new RegExp(path),
      source: 'https://docs.x.com/x-ads-api/fundamentals/versioning',
      updated: '2020-03-03',
      checked: '2026-10-08',
      reason: 'X Ads API v5 reached end of life on 2020-03-03; AMCP sends v12, and v12 has no recommendations route.',
      replacement:
        'No current X Ads API equivalent has been established; review the account in X Ads Manager. AMCP does not invent a v12 route.',
    })),
    {
      gateway: 'gtm_native_action',
      action: 'COMBINE_CONTAINERS',
      method: 'POST',
      path: /^\/tagmanager\/v2\/accounts\/[^/]+\/containers\/[^/:]+:combine$/,
      source:
        'https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers/combine',
      updated: '2026-08-25',
    },
    {
      gateway: 'gtm_native_action',
      action: 'MOVE_TAG_ID',
      method: 'POST',
      path: /^\/tagmanager\/v2\/accounts\/[^/]+\/containers\/[^/:]+:move_tag_id$/,
      source:
        'https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers/move_tag_id',
      updated: '2026-08-25',
    },
    {
      gateway: 'gtm_native_action',
      action: 'LINK_DESTINATION',
      method: 'POST',
      path: /^\/tagmanager\/v2\/accounts\/[^/]+\/containers\/[^/:]+\/destinations:link$/,
      source:
        'https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.destinations/link',
      updated: '2026-06-04',
    },
    {
      gateway: 'gtm_native_action',
      action: 'GET_DESTINATION',
      method: 'GET',
      path: /^\/tagmanager\/v2\/accounts\/[^/]+\/containers\/[^/:]+\/destinations\/[^/:]+$/,
      source:
        'https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.destinations/get',
      updated: '2026-06-04',
    },
    // Google Ads API v25 has no lifecycle goal methods, schemas or GAQL rows (pinned v25 Discovery document, revision
    // 20260923, compared with the v23 one); its Goal and CampaignGoalConfig resources gained new customer acquisition.
    ...['customer', 'campaign'].map(kind => ({
      gateway: 'google_ads_native_action',
      action: 'google_ads_v23_' + kind + '_lifecycle_goal_configure_' + kind + '_lifecycle_goals',
      method: 'POST',
      path: new RegExp(
        '^/v\\d+/customers/[^/]+/' +
          kind +
          'LifecycleGoal:configure' +
          (kind === 'customer' ? 'Customer' : 'Campaign') +
          'LifecycleGoals$',
      ),
      source: 'https://googleads.googleapis.com/$discovery/rest?version=v25',
      updated: '2026-09-23',
      reason: 'Google Ads API v25 no longer has lifecycle goal configuration.',
      replacement: lifecycleReplacement,
    })),
    // LinkedIn deprecated its unversioned Marketing APIs on 2024-12-16; the current pages (li-lms-2026-05) for these
    // resources document only the versioned /rest routes, and the Content APIs replace adCreativesV2 (read 2026-09-29).
    // Other /v2 routes stay: geo is still documented under /v2, and me, people, endorsement, shares, ugcPosts and
    // adLiftTestBenchmark were not confirmed withdrawn (F-58).
    ...[
      [
        'ad_campaigns_v2_post',
        'POST',
        '^/v2/adCampaignsV2$',
        'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post',
      ],
      [
        'ad_campaigns_v2_campaign_id_post',
        'POST',
        '^/v2/adCampaignsV2/[^/]+$',
        'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
      ],
      ['ad_creatives_v2_post', 'POST', '^/v2/adCreativesV2$', 'linkedin_rest_ad_accounts_ad_account_id_creatives_post'],
      ['dmp_segments_post', 'POST', '^/v2/dmpSegments$', 'linkedin_rest_dmp_segments_post'],
      [
        'dmp_segments_segment_id_companies_post',
        'POST',
        '^/v2/dmpSegments/[^/]+/companies$',
        'linkedin_rest_dmp_segments_segment_id_companies_post',
      ],
      [
        'dmp_segments_segment_id_users_post',
        'POST',
        '^/v2/dmpSegments/[^/]+/users$',
        'linkedin_rest_dmp_segments_segment_id_users_post',
      ],
      [
        'dmp_segments_segment_id_destinations_destination_id_get',
        'GET',
        '^/v2/dmpSegments/[^/]+/destinations/[^/]+$',
        'linkedin_rest_dmp_segments_segment_id_destinations_destination_id_get',
      ],
      [
        'dmp_segments_dmp_segment_id_list_uploads_list_id_delete',
        'DELETE',
        '^/v2/dmpSegments/[^/]+/listUploads/[^/]+$',
        'linkedin_rest_dmp_segments_dmp_segment_id_list_uploads_list_id_get (read); AMCP’s catalog has no versioned list upload deletion',
      ],
      [
        'organizational_entity_acls_get',
        'GET',
        '^/v2/organizationalEntityAcls$',
        'linkedin_rest_organization_acls_get',
      ],
      [
        'organizational_entity_acls_post',
        'POST',
        '^/v2/organizationalEntityAcls$',
        'linkedin_rest_organization_acls_organization_organization_urn_role_direct_content_poster_role_assignee_person_urn_put (not yet a reviewed write in AMCP)',
      ],
    ].map(([action, method, path, replacement]) => ({
      gateway: 'linkedin_native_action',
      action: 'linkedin_v2_' + action,
      method,
      path: new RegExp(path),
      source: 'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/migrations?view=li-lms-2026-05',
      updated: '2024-12-16',
      reason:
        'LinkedIn deprecated its unversioned Marketing APIs on 2024-12-16; the current documentation has only the versioned /rest route.',
      replacement: 'Use ' + replacement + '.',
    })),
  ];
  /** The catalog actions whose Google Ads method v25 removed; tools/fetch-vendor-specs.mjs keeps the same list. */
  const retiredGoogleAdsActions = retiredProviderActions
    .filter(r => r.gateway === 'google_ads_native_action')
    .map(r => r.action);
  const retiredProviderAction = p =>
    retiredProviderActions.find(r => r.gateway === p.gateway && r.method === p.method && r.path.test(p.path));
  /** Legacy names that do not correspond to an operation of the current provider version: captured aliases that never
   * did, and aliases whose operation a newer version removed. Match the alias, not its shared route. */
  const unsupportedProviderAliases = [
    {
      gateway: 'google_ads_native_action',
      action: 'UPDATE_CUSTOMIZER_ATTRIBUTE',
      version: 'v25',
      source:
        'https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v25/services/customizer_attribute_service.proto (sha256 7eb3650bd6eee98d0ec2d60b785e2934cf91c8dc07ae75a42447bac779c1b2aa)',
      checked_at: '2026-09-28',
      reason:
        'The v25 CustomizerAttributeOperation oneof contains create and remove only. An update_mask field or broad service comment does not define an update operation.',
      replacement:
        'Create a new attribute with the correct name/type. Separately review replacement customizer associations and affected ads before considering removal of the old attribute. AMCP does not automatically migrate or delete it.',
    },
    ...['CUSTOMER', 'CAMPAIGN'].flatMap(kind => [
      {
        gateway: 'google_ads_native_action',
        action: 'CONFIGURE_' + kind + '_LIFECYCLE_GOAL',
        version: 'v25',
        source: 'https://googleads.googleapis.com/$discovery/rest?version=v25',
        checked_at: '2026-09-28',
        reason: 'Google Ads API v25 no longer has lifecycle goal configuration.',
        replacement: lifecycleReplacement,
      },
      {
        gateway: 'google_ads_native_action',
        action: 'LIST_' + kind + '_LIFECYCLE_GOALS',
        version: 'v25',
        source:
          'https://googleads.googleapis.com/$discovery/rest?version=v25 (GoogleAdsRow has no lifecycle goal rows)',
        checked_at: '2026-09-28',
        reason: 'Google Ads API v25 no longer has lifecycle goals to read.',
        replacement:
          'Read goals and their campaign settings with RUN_GAQL_QUERY: FROM goal, and FROM campaign_goal_config.',
      },
    ]),
    {
      gateway: 'google_ads_native_action',
      action: 'SET_CAMPAIGN_BRAND_SAFETY',
      version: 'v25',
      source:
        'https://googleads.googleapis.com/$discovery/rest?version=v25 (Campaign has no videoBrandSafetySuitability)',
      checked_at: '2026-09-28',
      reason:
        'Google Ads API v25 removed the campaign-level video brand safety setting; only the account-level one remains.',
      replacement:
        "Set the account's videoBrandSafetySuitability with a reviewed customer change (google_ads_v23_customer_mutate_customer), or exclude content labels per campaign (SET_CAMPAIGN_CONTENT_LABEL_EXCLUSIONS).",
    },
  ];
  const unsupportedProviderAlias = (gateway, action) =>
    unsupportedProviderAliases.find(r => r.gateway === gateway && r.action === action);
  function assertProviderAliasAvailable(gateway, action) {
    const unavailable = unsupportedProviderAlias(gateway, action);
    if (unavailable) throw new MirrorError('PROVIDER_ACTION_UNSUPPORTED', unavailable.reason, unavailable);
  }
  function assertProviderActionAvailable(p) {
    assertProviderAliasAvailable(p.gateway, p.action);
    const retired = retiredProviderAction(p);
    if (retired)
      throw new MirrorError(
        'PROVIDER_ACTION_UNSUPPORTED',
        retired.reason ??
          'Google documents this method as no longer supported. A historical mapping cannot make it executable.',
        {
          action: retired.action,
          source: retired.source,
          documentation_updated: retired.updated,
          checked_at: retired.checked ?? (retired.gateway === 'google_ads_native_action' ? '2026-09-28' : '2026-09-19'),
          replacement: retired.replacement ?? tagManagerReplacement,
        },
      );
  }
  return {
    retiredProviderActions,
    retiredGoogleAdsActions,
    retiredProviderAction,
    unsupportedProviderAliases,
    unsupportedProviderAlias,
    assertProviderAliasAvailable,
    assertProviderActionAvailable,
  };
})();

// src/provider-validation.ts as it was: which requests the provider validates, how, what its refusal names, and the
// checks before a validation request is sent.
const oldValidation = (() => {
  /** Meta's campaign and ad set edits, by compiled (canonical) action: the meta_campaign_update and meta_adset_update
   * aliases compile to these. Creates are recognized by their account-edge path. */
  const metaValidatedEdits = new Set(['meta_campaign_id_update', 'meta_ad_set_id_update']);
  const providerValidationScope =
    'Google Ads mutate requests, and Meta campaign and ad set creates and edits (meta_campaign_create, meta_adset_create, meta_campaign_id_update, meta_ad_set_id_update)';
  /** The provider's own validation of `plan`, or undefined when the route has no qualified validation path. */
  function providerValidationRequest(plan) {
    if (
      plan.gateway === 'google_ads_native_action' &&
      plan.method === 'POST' &&
      /^\/v\d+\/customers\/\d+\/[A-Za-z]+:mutate$/.test(plan.path)
    ) {
      const body = {...plan.body, validate_only: true};
      delete body.validateOnly;
      return {...plan, body};
    }
    if (
      plan.gateway === 'meta_native_action' &&
      plan.method === 'POST' &&
      (/^\/v[^/]+\/act_\d+\/(?:campaigns|adsets)$/.test(plan.path) ||
        (metaValidatedEdits.has(plan.action) && /^\/v[^/]+\/\d+$/.test(plan.path)))
    )
      return {...plan, body: {...plan.body, execution_options: ['validate_only']}};
    return undefined;
  }
  /** Where the provider refused the request: field paths only, which name the request's own fields. */
  function fieldPaths(gateway, data) {
    const paths = new Set();
    const error = data?.error ?? data;
    if (gateway === 'google_ads_native_action')
      for (const detail of Array.isArray(error?.details) ? error.details : [])
        for (const e of Array.isArray(detail?.errors) ? detail.errors : []) {
          const path = (Array.isArray(e?.location?.fieldPathElements) ? e.location.fieldPathElements : [])
            .map(p => String(p.fieldName) + (Number.isInteger(p.index) ? '[' + p.index + ']' : ''))
            .join('.');
          if (path) paths.add(path);
        }
    if (gateway === 'meta_native_action') {
      const blame = error?.error_data?.blame_field_specs;
      for (const spec of Array.isArray(blame) ? blame : []) paths.add([spec].flat().map(String).join('.'));
    }
    return [...paths].slice(0, 50);
  }

  /**
   * Sends the validation request through `send` (which applies the caller's authority checks) and classifies the reply.
   * A provider refusal of the request itself (HTTP 400 or 422, or an unsuccessful 200 reply) is a rejection; any other
   * failure (permission, rate, outage) is raised unchanged, since it says nothing about the request.
   */
  async function runProviderValidation(plan, request, send) {
    let response;
    try {
      response = await send();
    } catch (e) {
      if (
        e instanceof MirrorError &&
        (e.code === 'PLATFORM_ERROR' || [400, 422].includes(Number(e.details.http_status)))
      )
        return {
          status: 'provider_rejected',
          checked_at: Date.now(),
          field_paths: fieldPaths(plan.gateway, e.details.upstream),
          ...(typeof e.details.http_status === 'number' ? {http_status: e.details.http_status} : {}),
          ...(typeof e.details.request_id === 'string' ? {request_id: e.details.request_id} : {}),
          response: redact(e.details.upstream),
        };
      // The transport words a lost reply to any non-read request as a write whose outcome is uncertain. A validation
      // applies nothing, so its lost reply only means the check did not finish.
      if (e instanceof MirrorError && e.code === 'WRITE_OUTCOME_UNCERTAIN')
        throw new MirrorError(
          'UPSTREAM_UNAVAILABLE',
          'The provider did not answer the validation request. Validation applies nothing, so nothing changed; it can be sent again.',
          {validation_only: true},
          502,
          true,
        );
      throw e;
    }
    const data = response.data;
    if (
      response.status >= 300 ||
      data?.error ||
      data?.partialFailureError ||
      (request.gateway === 'meta_native_action' && data?.success === false)
    )
      return {
        status: 'provider_rejected',
        checked_at: Date.now(),
        field_paths: fieldPaths(plan.gateway, data),
        http_status: response.status,
        response: redact(data),
      };
    return {status: 'provider_validated', checked_at: Date.now()};
  }
  async function validateProviderRequest(service, actor, input) {
    writer(service.store, actor);
    if (!['google_ads_native_action', 'meta_native_action'].includes(input.gateway))
      return {
        status: 'unsupported',
        executed: false,
        reason: 'Provider validation is qualified only for ' + providerValidationScope + '.',
      };
    // A provider request that uses write permission: allowed where reviewed writes are, or by the deployment owner's
    // explicit opt-in (owner decision D18). Refused before any account, credential or network access.
    if (!service.policy.allowWrites && service.policy.providerValidation !== true)
      throw new MirrorError(
        'LIVE_WRITES_DISABLED',
        'This deployment permits reads and dry-run previews only, and its owner has not allowed provider validation (AMCP_PROVIDER_VALIDATION=true). Nothing was sent.',
        {},
        403,
      );
    const args = input.arguments;
    validate(args ?? {}, Object.keys(service.registry.tools.get(input.gateway).inputSchema.properties ?? {}));
    service.registry.validate(input.gateway, args, service.options);
    const plan = service.compiler.compile(input.gateway, args, service.options);
    if (plan.gateway === 'meta_native_action' && plan.body?.execution_options !== undefined)
      throw new MirrorError(
        'INVALID_ARGUMENT',
        'Omit execution_options: provider validation adds validate_only itself.',
        {field: 'execution_options'},
      );
    assertWriteShape(plan);
    const request = providerValidationRequest(plan);
    if (!request)
      throw new MirrorError(
        'PROVIDER_VALIDATION_UNSUPPORTED',
        'Select a supported request: ' + providerValidationScope + '.',
      );
    // Its connection, account, credential and network steps follow, unchanged; the fake service below refuses the
    // connection, so the comparison ends where the provider rules end.
    service.store.resolveConnection(actor, plan.gateway, plan.accountId, input.connection_id ?? args.connection_id);
    throw new Error('The fake service resolves no connection.');
  }
  return {providerValidationScope, providerValidationRequest, runProviderValidation, validateProviderRequest};
})();

// src/wire-contracts.ts as it was: the contract each gateway's requests resolved to.
const oldWire = (() => {
  const record = v => !!v && typeof v === 'object' && !Array.isArray(v);
  // Delegated Google routes (Tag Manager, GA4, Search Console, Business Profile): the route's request schema in
  // generated/vendor-routes.json, whose $refs resolve in the pinned Discovery document it was generated from.
  const delegatedGateways = new Set([
    'gtm_native_action',
    'ga4_native_action',
    'google_search_console_native_action',
    'google_business_native_action',
  ]);
  let delegatedIndex;
  function delegatedRoute(plan) {
    if (!delegatedIndex) {
      delegatedIndex = new Map();
      for (const r of pinnedJson('generated/vendor-routes.json').routes)
        if (delegatedGateways.has(r.gateway) && r.requestSchema)
          delegatedIndex.set(r.gateway + '/' + r.operation + '/' + r.action, r);
    }
    const action = plan.action.includes('/') ? plan.action : plan.action + '/';
    const r = delegatedIndex.get(plan.gateway + '/' + action);
    return r && r.method === plan.method ? r : undefined;
  }
  function discoveryContract(name, vendorMethod, root, label) {
    const pinned = sealedVendorDocument(name);
    if (!pinned) return {contract: name, vendor_method: vendorMethod};
    const schemas = pinned.envelope.document.schemas ?? {};
    return {
      contract: name,
      vendor_method: vendorMethod,
      sealed: pinned.sealed,
      document_sha256: pinned.envelope.document_sha256,
      check: (body, readOnly) =>
        root
          ? discoveryIssues(schemas, root, body, {readOnly, label})
          : record(body) && Object.keys(body).length
            ? [{field: '', reason: 'The vendor method takes no request body'}]
            : [],
    };
  }
  /** Every method of a Discovery document, with a matcher of its flat path. */
  const methodCache = new Map();
  function discoveryMethods(name) {
    if (!methodCache.has(name)) {
      const document = sealedVendorDocument(name)?.envelope.document,
        found = [];
      const visit = r => {
        for (const m of Object.values(r.methods ?? {})) {
          const path = '/' + (document.servicePath ?? '') + (m.flatPath ?? m.path);
          found.push({
            method: m,
            verb: m.httpMethod,
            pattern: new RegExp(
              '^' +
                path
                  .split(/(\{[^}]+\})/)
                  .map(p => (p.startsWith('{') ? '[^/:]+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
                  .join('') +
                '$',
            ),
          });
        }
        for (const nested of Object.values(r.resources ?? {})) visit(nested);
      };
      if (document) visit(document);
      methodCache.set(name, found);
    }
    return methodCache.get(name);
  }
  function dv360Contract(plan) {
    // Media and asset uploads are multipart transports with their own contracts (src/transport.ts).
    if (plan.path.startsWith('/upload/')) return undefined;
    const matches = discoveryMethods('dv360-v4').filter(m => m.verb === plan.method && m.pattern.test(plan.path));
    if (matches.length !== 1) return undefined;
    const m = matches[0].method;
    return discoveryContract('dv360-v4', m.id, m.request, 'Display & Video 360');
  }

  // Data Manager v1 (src/google-data-manager-routes.ts): its methods in the pinned Discovery document.
  const dataManagerMethods = {
    DATA_MANAGER_INGEST_AUDIENCE_MEMBERS: 'datamanager.audienceMembers.ingest',
    DATA_MANAGER_REMOVE_AUDIENCE_MEMBERS: 'datamanager.audienceMembers.remove',
    DATA_MANAGER_INGEST_EVENTS: 'datamanager.events.ingest',
    DATA_MANAGER_RETRIEVE_REQUEST_STATUS: 'datamanager.requestStatus.retrieve',
  };
  const dataManagerContractName = 'datamanager-v1';
  /** The Data Manager contract of `plan`, from `envelope` (tests) or the pinned document. */
  function dataManagerContract(plan, envelope) {
    const vendorMethod = dataManagerMethods[plan.action];
    if (plan.gateway !== 'google_ads_native_action' || plan.origin !== dataManagerOrigin || !vendorMethod)
      return undefined;
    const pinned = envelope
      ? {
          envelope,
          sealed:
            createHash('sha256').update(JSON.stringify(envelope.document)).digest('hex') === envelope.document_sha256,
        }
      : sealedVendorDocument(dataManagerContractName);
    if (!pinned) return {contract: dataManagerContractName, vendor_method: vendorMethod};
    const document = pinned.envelope.document,
      found = [];
    const visit = r => {
      for (const m of Object.values(r.methods ?? {})) found.push(m);
      for (const nested of Object.values(r.resources ?? {})) visit(nested);
    };
    visit(document);
    const method = found.find(m => m.id === vendorMethod);
    const schemas = document.schemas ?? {};
    return {
      contract: dataManagerContractName,
      vendor_method: vendorMethod,
      sealed: pinned.sealed,
      document_sha256: pinned.envelope.document_sha256,
      check: (body, readOnly) =>
        method
          ? method.request
            ? discoveryIssues(schemas, method.request, body, {readOnly, label: 'Data Manager'})
            : []
          : [{field: '', reason: 'The pinned Data Manager document has no method ' + vendorMethod}],
    };
  }
  // Microsoft Advertising: the pinned WSDL type model, moved verbatim to src/microsoft-wire-contract.ts, its gateway
  // check included; the old dispatch's own check stays here as it was.
  const microsoftContract = plan =>
    plan.gateway !== 'microsoft_ads_native_action' ? undefined : microsoftWireContract(plan);
  /** The contract of `plan`'s route, or undefined when no pinned request schema covers it. */
  function resolveContract(plan) {
    if (delegatedGateways.has(plan.gateway)) {
      const r = delegatedRoute(plan);
      return r ? discoveryContract(r.sourceFile, r.vendorMethod, r.requestSchema, 'Google') : undefined;
    }
    if (plan.gateway === 'dv360_native_action') return dv360Contract(plan);
    if (plan.gateway === 'microsoft_ads_native_action') return microsoftContract(plan);
    return dataManagerContract(plan);
  }
  return {resolveContract, dataManagerContract, dataManagerContractName, dataManagerMethods};
})();

// Wave 4c round 7 (w4c-arc6-tables): the four tables below moved too. Answers are compared as JSON text, so every key's
// order counts, and a refusal is compared with its status and retryability.
const text = value => JSON.stringify(value, (key, v) => (v instanceof RegExp ? {regexp: v.source, flags: v.flags} : v));
const thrown = error => ({
  name: error?.name,
  code: error?.code,
  message: error?.message,
  details: error?.details,
  status: error?.status,
  retryable: error?.retryable,
});
const answer = fn => {
  try {
    return text({returns: fn()});
  } catch (error) {
    return text({throws: thrown(error)});
  }
};
const settled = async fn => {
  try {
    const value = await fn();
    return text({returns: value?.checked_at === undefined ? value : {...value, checked_at: typeof value.checked_at}});
  } catch (error) {
    return text({throws: thrown(error)});
  }
};
/** A path a withdrawn method's pattern matches: its parameters filled in. */
const samplePath = pattern => {
  const path = pattern.source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\[\^\\?\/:?\]\+/g, '1')
    .replace(/\\d\+/g, '25')
    .replace(/\\\//g, '/');
  assert.ok(pattern.test(path), pattern.source + ' ' + path);
  return path;
};

test('the withdrawn methods and unsupported aliases are the same rows in the same order, refused as before', () => {
  assert.equal(text(retiredProviderActions), text(oldRetired.retiredProviderActions));
  assert.equal(text(retiredGoogleAdsActions), text(oldRetired.retiredGoogleAdsActions));
  assert.equal(text(unsupportedProviderAliases), text(oldRetired.unsupportedProviderAliases));
  for (const row of [...retiredProviderActions, ...unsupportedProviderAliases]) {
    assert.equal(Object.isFrozen(row), false, row.action);
    assert.equal(Object.getPrototypeOf(row), Object.prototype, row.action);
  }
  for (const row of retiredProviderActions) {
    assert.ok(row.path instanceof RegExp && !row.path.global && !row.path.sticky, row.action);
    assert.equal(Object.isFrozen(row.path), false, row.action);
  }
  // The providers in the table's order, each one's facts frozen in its adapter.
  assert.deepEqual(
    retiredActionProviders.map(a => a.id),
    ['x', 'gtm', 'google', 'linkedin'],
  );
  assert.deepEqual(
    providerAdapters
      .filter(a => a.retired)
      .map(a => a.id)
      .sort(),
    ['google', 'gtm', 'linkedin', 'x'],
  );
  for (const adapter of retiredActionProviders) {
    assert.ok(Object.isFrozen(adapter.retired), adapter.id);
    for (const row of [...(adapter.retired.actions ?? []), ...(adapter.retired.aliases ?? [])])
      assert.ok(Object.isFrozen(row), adapter.id + ' ' + row.action);
  }
  // Every gateway with: each withdrawn method's route under its action, another action and another verb; a longer
  // path; each alias; an alias whose route is also withdrawn (the alias refuses first); and names an object answers.
  const lifecycle = oldRetired.retiredProviderActions.find(r => r.action.includes('_customer_lifecycle_goal_'));
  const plans = [
    ...oldRetired.retiredProviderActions.flatMap(row => [
      {action: row.action, method: row.method, path: samplePath(row.path)},
      {action: 'another_action', method: row.method, path: samplePath(row.path)},
      {action: row.action, method: row.method === 'GET' ? 'POST' : 'GET', path: samplePath(row.path)},
      {action: row.action, method: row.method, path: samplePath(row.path) + '/more'},
    ]),
    ...oldRetired.unsupportedProviderAliases.map(row => ({
      action: row.action,
      method: 'POST',
      path: '/v25/customers/1/campaigns:mutate',
    })),
    {action: 'CONFIGURE_CUSTOMER_LIFECYCLE_GOAL', method: lifecycle.method, path: samplePath(lifecycle.path)},
    ...['constructor', '__proto__', 'toString', 'hasOwnProperty'].map(action => ({action, method: 'GET', path: '/'})),
  ];
  let compared = 0,
    refused = 0;
  for (const gateway of gateways)
    for (const plan of plans) {
      const p = {...plan, gateway},
        label = gateway + ' ' + p.method + ' ' + p.path + ' ' + p.action;
      compared++;
      assert.equal(text(retiredProviderAction(p)), text(oldRetired.retiredProviderAction(p)), label);
      const now = answer(() => assertProviderActionAvailable(p));
      assert.equal(
        now,
        answer(() => oldRetired.assertProviderActionAvailable(p)),
        label,
      );
      if (now.startsWith('{"throws"')) refused++;
      assert.equal(
        text(unsupportedProviderAlias(gateway, p.action)),
        text(oldRetired.unsupportedProviderAlias(gateway, p.action)),
        label,
      );
      assert.equal(
        answer(() => assertProviderAliasAvailable(gateway, p.action)),
        answer(() => oldRetired.assertProviderAliasAvailable(gateway, p.action)),
        label,
      );
    }
  assert.ok(compared > 1900, String(compared));
  // The refusals compared: each withdrawn method under its own and another action, each alias on every route, and the
  // alias whose route is also withdrawn.
  assert.ok(
    refused >= 2 * oldRetired.retiredProviderActions.length + oldRetired.unsupportedProviderAliases.length,
    String(refused),
  );
});

/** A plan as the compiler builds it: no query parameters or headers, and not a read. */
const compiledShape = shape => ({query: {}, headers: {}, readOnly: false, ...shape});
/** Plans of validation's two providers, and others, each under every gateway. */
const validationShapes = [
  {
    method: 'POST',
    path: '/v23/customers/123/campaignBudgets:mutate',
    action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
    accountId: '123',
    body: {operations: [{create: {name: 'B'}}], validateOnly: false},
  },
  {
    method: 'POST',
    path: '/v23/customers/123/campaigns:mutate',
    action: 'CREATE_CAMPAIGN',
    accountId: '123',
    body: {validate_only: false, partial_failure: true},
  },
  {method: 'POST', path: '/v23/customers/abc/campaigns:mutate', action: 'CREATE_CAMPAIGN', accountId: 'abc', body: {}},
  {
    method: 'POST',
    path: '/v23/customers/123/googleAds:search',
    action: 'RUN_GAQL_QUERY',
    accountId: '123',
    body: {query: 'SELECT campaign.id FROM campaign'},
  },
  {method: 'GET', path: '/v23/customers/123/campaigns:mutate', action: 'CREATE_CAMPAIGN', accountId: '123'},
  {
    method: 'POST',
    path: '/v26.0/act_123/campaigns',
    action: 'meta_campaign_create',
    accountId: '123',
    body: {name: 'C', status: 'PAUSED'},
  },
  {
    method: 'POST',
    path: '/v26.0/act_123/adsets',
    action: 'meta_adset_create',
    accountId: '123',
    body: {name: 'A', execution_options: ['include_recommendations']},
  },
  {method: 'POST', path: '/v26.0/act_123/ads', action: 'meta_ad_create', accountId: '123', body: {name: 'Ad'}},
  {method: 'POST', path: '/v26.0/987', action: 'meta_campaign_id_update', accountId: '123', body: {status: 'PAUSED'}},
  {
    method: 'POST',
    path: '/v26.0/987',
    action: 'meta_ad_set_id_update',
    accountId: '123',
    body: {status: 'PAUSED', execution_options: null},
  },
  {method: 'POST', path: '/v26.0/987', action: 'meta_ad_id_update', accountId: '123', body: {status: 'PAUSED'}},
  {method: 'POST', path: '/v26.0/abc', action: 'meta_campaign_id_update', accountId: '123', body: {}},
  {method: 'DELETE', path: '/v26.0/987', action: 'meta_campaign_id_update', accountId: '123'},
  {method: 'POST', path: '/v26.0/act_123/campaigns', action: 'meta_campaign_create', accountId: '123'},
  // Requests as the compiler builds them, with their query and headers (tests/provider-validation-gating.test.mjs): a
  // budget create and a campaign create that pass the write shape, so validation reaches the connection, and an ad
  // edit, a reviewed write that has no validation path. The shapes above fail the write shape's own checks.
  compiledShape({
    method: 'POST',
    path: '/v25/customers/123/campaignBudgets:mutate',
    action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
    accountId: '123',
    body: {operations: [{create: {name: 'Budget', amount_micros: '1000000', delivery_method: 'STANDARD'}}]},
  }),
  compiledShape({
    method: 'POST',
    path: '/v26.0/act_123/campaigns',
    action: 'meta_ad_account_id_campaigns_create',
    accountId: '123',
    body: {
      name: 'Draft',
      status: 'PAUSED',
      objective: 'OUTCOME_TRAFFIC',
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false,
    },
  }),
  compiledShape({
    method: 'POST',
    path: '/v26.0/987',
    action: 'meta_ad_id_update',
    accountId: '123',
    body: {status: 'PAUSED'},
  }),
];
const googleDetails = [
  {
    errors: [
      {
        location: {
          fieldPathElements: [{fieldName: 'operations', index: 0}, {fieldName: 'create'}, {fieldName: 'name'}],
        },
      },
      {location: {fieldPathElements: [{fieldName: 'operations', index: 1.5}, {fieldName: 'update'}]}},
      {location: {fieldPathElements: []}},
      {location: {fieldPathElements: 'operations'}},
      {},
      null,
    ],
  },
  {
    errors: [
      {
        location: {
          fieldPathElements: [{fieldName: 'operations', index: 0}, {fieldName: 'create'}, {fieldName: 'name'}],
        },
      },
    ],
  },
  {errors: 'none'},
  null,
  7,
];
const blame = [['name'], 'daily_budget', [['targeting', 'geo_locations'], 'countries'], 7, null, []];
const manyDetails = Array.from({length: 60}, (_, i) => ({
  errors: [{location: {fieldPathElements: [{fieldName: 'operations', index: i}]}}],
}));
const validationReplies = [
  async () => ({status: 200, data: {results: []}}),
  async () => ({status: 200, data: {success: false}}),
  async () => ({status: 200, data: {success: true}}),
  async () => ({status: 200, data: {success: 'false'}}),
  async () => ({status: 200, data: null}),
  async () => ({status: 200, data: 'accepted'}),
  async () => ({status: 204}),
  async () => ({status: 302, data: {}}),
  async () => ({status: 200, data: {partialFailureError: {code: 3, details: googleDetails}}}),
  async () => ({
    status: 400,
    data: {error: {code: 400, details: googleDetails, error_data: {blame_field_specs: blame}}},
  }),
  async () => ({status: 400, data: {details: googleDetails, error_data: {blame_field_specs: blame}}}),
  async () => ({status: 200, data: {success: false, error_data: {blame_field_specs: blame}}}),
  async () => ({status: 500, data: {error: {details: manyDetails}}}),
  async () => {
    throw new MirrorError('PLATFORM_ERROR', 'Refused.', {
      http_status: 400,
      request_id: 'req-1',
      upstream: {error: {details: googleDetails, error_data: {blame_field_specs: blame}}},
    });
  },
  async () => {
    throw new MirrorError('UPSTREAM_ERROR', 'Refused.', {
      http_status: 422,
      upstream: {error: {error_data: {blame_field_specs: blame}}},
    });
  },
  async () => {
    throw new MirrorError('UPSTREAM_ERROR', 'Refused.', {
      http_status: '400',
      request_id: 7,
      upstream: {details: googleDetails},
    });
  },
  async () => {
    throw new MirrorError('PLATFORM_ERROR', 'Refused.');
  },
  async () => {
    throw new MirrorError('WRITE_OUTCOME_UNCERTAIN', 'Lost.', {http_status: 400});
  },
  async () => {
    throw new MirrorError('WRITE_OUTCOME_UNCERTAIN', 'Lost.');
  },
  async () => {
    throw new MirrorError('RATE_LIMITED', 'Slow down.', {http_status: 429}, 429, true);
  },
  async () => {
    throw new Error('socket hang up');
  },
];
/** A service with no connection: validation's checks before the connection run, and the connection is refused. */
function unconnectedService(policy, plan, lookups) {
  return {
    store: {
      assertActorActive() {},
      resolveConnection(...args) {
        lookups.push(args);
        throw new Error('No connection in this test.');
      },
    },
    policy,
    registry: {tools: {get: () => ({inputSchema: {properties: {connection_id: {}}}})}, validate() {}},
    compiler: {compile: () => structuredClone(plan)},
    options: {},
  };
}

test('provider validation builds, classifies and refuses every gateway’s requests as before', async () => {
  assert.equal(providerValidationScope, oldValidation.providerValidationScope);
  let requests = 0;
  for (const gateway of gateways)
    for (const shape of validationShapes) {
      const plan = {...shape, gateway},
        now = answer(() => providerValidationRequest(plan));
      assert.equal(
        now,
        answer(() => oldValidation.providerValidationRequest(plan)),
        gateway + ' ' + plan.path + ' ' + plan.action,
      );
      if (now !== '{}') requests++;
    }
  // Google's three mutate routes, and Meta's three creates, two edits and a create without a body, under their own
  // gateway.
  assert.equal(requests, 9);
  let replies = 0,
    withRows = 0;
  // r25-field3-errors (AMCP-03, changed on purpose): a rejected check now keeps the provider's rows and its sentence (provider_errors,
  // provider_errors_omitted, provider_message), which the copy above never had. They are taken out of the new answer before it is compared,
  // so everything else (the status, the field paths, the HTTP status, the request reference and the whole answer) is still as before;
  // tests/provider-validation-errors.test.mjs pins the new fields, and the count below shows that some replies do carry them.
  const asBefore = answerText => {
    const value = JSON.parse(answerText);
    if (value.returns?.status === 'provider_rejected')
      for (const key of ['provider_errors', 'provider_errors_omitted', 'provider_message']) delete value.returns[key];
    return JSON.stringify(value);
  };
  for (const planGateway of gateways)
    for (const requestGateway of new Set([
      planGateway,
      'google_ads_native_action',
      'meta_native_action',
      'unknown_native_action',
    ]))
      for (const send of validationReplies) {
        const plan = {...validationShapes[0], gateway: planGateway},
          request = {...plan, gateway: requestGateway},
          now = await settled(() => runProviderValidation(plan, request, send));
        replies++;
        if (now.includes('"provider_errors"')) withRows++;
        assert.equal(
          asBefore(now),
          await settled(() => oldValidation.runProviderValidation(plan, request, send)),
          planGateway + ' ' + requestGateway + ' ' + validationReplies.indexOf(send),
        );
      }
  assert.ok(replies > 1900, String(replies));
  assert.ok(withRows > 0, 'the rows of a rejection reach the check: ' + withRows);
  // validateProviderRequest up to the connection: its gateway gate, the owner's opt-in, the provider's refusal of the
  // plan, the write shape and the validation request, in that order, for every gateway's input and plan.
  const actors = [
    {tenantId: 'validation', userId: 'owner', role: 'admin'},
    {tenantId: 'validation', userId: 'viewer', role: 'reader'},
  ];
  const policies = [
    {allowWrites: false},
    {allowWrites: false, providerValidation: true},
    {allowWrites: false, providerValidation: 'true'},
    {allowWrites: true},
  ];
  const cases = [
    ...gateways.flatMap(gateway =>
      validationShapes.flatMap(shape =>
        policies.flatMap(policy => actors.map(actor => ({input: gateway, plan: {...shape, gateway}, policy, actor}))),
      ),
    ),
    ...['google_ads_native_action', 'meta_native_action'].flatMap(input =>
      gateways.flatMap(gateway =>
        validationShapes.map(shape => ({input, plan: {...shape, gateway}, policy: policies[3], actor: actors[0]})),
      ),
    ),
  ];
  const outcomes = new Map();
  for (const {input, plan, policy, actor} of cases) {
    const lookups = {now: [], then: []},
      args = {
        input: {gateway: input, arguments: {connection_id: 'c1'}},
        label: input + ' ' + plan.gateway + ' ' + plan.path,
      };
    const now = await settled(() =>
      validateProviderRequest(unconnectedService(policy, plan, lookups.now), actor, args.input),
    );
    const then = await settled(() =>
      oldValidation.validateProviderRequest(unconnectedService(policy, plan, lookups.then), actor, args.input),
    );
    assert.equal(now, then, args.label + ' ' + JSON.stringify(policy) + ' ' + actor.role);
    assert.equal(text(lookups.now), text(lookups.then), args.label);
    const kind = JSON.parse(now).throws?.code ?? JSON.parse(now).throws?.message ?? JSON.parse(now).returns?.status;
    outcomes.set(kind, (outcomes.get(kind) ?? 0) + 1);
  }
  // Each refusal and the connection lookup were reached.
  for (const kind of [
    'unsupported',
    'FORBIDDEN',
    'LIVE_WRITES_DISABLED',
    'INVALID_ARGUMENT',
    'PROVIDER_VALIDATION_UNSUPPORTED',
    'No connection in this test.',
  ])
    assert.ok(outcomes.get(kind) > 0, kind + ' ' + JSON.stringify([...outcomes]));
});

test('every gateway’s requests resolve to the same wire contract, checked the same way, as before', () => {
  assert.equal(dataManagerContractName, oldWire.dataManagerContractName);
  // Which kind each provider declares: the old dispatch, provider by provider.
  assert.deepEqual(
    Object.fromEntries(
      registeredProviderHooks.filter(h => h.wireContract).map(h => [h.gateway, Object.keys(h.wireContract)]),
    ),
    {
      gtm_native_action: ['routes'],
      ga4_native_action: ['routes'],
      google_search_console_native_action: ['routes'],
      google_business_native_action: ['routes'],
      dv360_native_action: ['discovery'],
      microsoft_ads_native_action: ['model'],
      google_ads_native_action: ['dataManager'],
    },
  );
  for (const hooks of registeredProviderHooks.filter(h => h.wireContract))
    assert.ok(
      Object.isFrozen(hooks.wireContract) &&
        Object.values(hooks.wireContract).every(v => typeof v === 'function' || Object.isFrozen(v)),
      hooks.gateway,
    );
  const fill = path => String(path ?? '').replace(/\{[^}]+\}/g, '1');
  const routes = pinnedJson('generated/vendor-routes.json').routes;
  const dv360 = sealedVendorDocument('dv360-v4')?.envelope.document;
  const methods = [];
  const visit = r => {
    for (const m of Object.values(r.methods ?? {})) methods.push(m);
    for (const nested of Object.values(r.resources ?? {})) visit(nested);
  };
  if (dv360) visit(dv360);
  const microsoft = pinnedJson('generated/microsoft-contracts.json');
  const dataManagerActions = [
    ...Object.keys(oldWire.dataManagerMethods),
    'DATA_MANAGER_UNKNOWN',
    'constructor',
    'toString',
    '__proto__',
  ];
  const bases = [
    ...routes.map(r => ({
      action: r.action ? r.operation + '/' + r.action : r.operation,
      method: r.method,
      path: fill(r.path),
      origin: r.origin,
      readOnly: r.readOnly === true,
    })),
    ...methods.flatMap(m => [
      {
        action: m.id,
        method: m.httpMethod,
        path: '/' + (dv360.servicePath ?? '') + fill(m.flatPath ?? m.path),
        readOnly: m.httpMethod === 'GET',
      },
      {action: m.id, method: m.httpMethod, path: '/upload/' + fill(m.flatPath ?? m.path), readOnly: false},
    ]),
    ...Object.values(microsoft.services)
      .flatMap(s => Object.keys(s.operations))
      .map(operation => ({
        action: operation,
        method: 'POST',
        path: '/' + operation,
        readOnly: operation.startsWith('Get'),
      })),
    ...dataManagerActions.flatMap(action =>
      [dataManagerOrigin, 'https://googleads.googleapis.com', undefined].map(origin => ({
        action,
        method: 'POST',
        path: '/v1/audienceMembers:ingest',
        origin,
        readOnly: false,
      })),
    ),
  ];
  assert.ok(routes.length > 400 && methods.length > 100, routes.length + ' ' + methods.length);
  const original = wireContractResolver.resolve,
    resolved = new Map();
  let compared = 0;
  try {
    for (const base of bases)
      for (const body of [{bogus_field: 1}, {}])
        for (const gateway of gateways) {
          const plan = {...base, gateway, body};
          const now = text(wireContractCheck(plan, 'shadow'));
          wireContractResolver.resolve = oldWire.resolveContract;
          const then = text(wireContractCheck(plan, 'shadow'));
          wireContractResolver.resolve = original;
          assert.equal(now, then, gateway + ' ' + base.method + ' ' + base.path + ' ' + base.action);
          compared++;
          if (now !== undefined) resolved.set(gateway, (resolved.get(gateway) ?? 0) + 1);
        }
  } finally {
    wireContractResolver.resolve = original;
  }
  assert.ok(compared > 50000, String(compared));
  assert.deepEqual(
    [...resolved.keys()].sort(),
    [
      'dv360_native_action',
      'ga4_native_action',
      'google_ads_native_action',
      'google_business_native_action',
      'google_search_console_native_action',
      'gtm_native_action',
      'microsoft_ads_native_action',
    ].filter(gateway => gateways.includes(gateway)),
  );
  // Regression (wave 4c-r7 review): the moved model keeps the gateway check the function had in src/wire-contracts.ts.
  // Called directly, a plan of any other gateway whose action names a Microsoft operation has no Microsoft contract;
  // the wire contracts' dispatch reaches it with Microsoft's plans only.
  const operations = Object.values(microsoft.services).flatMap(s => Object.keys(s.operations));
  let modelled = 0;
  for (const action of operations)
    for (const gateway of [...gateways, undefined, '']) {
      const plan = {gateway, action, method: 'POST', path: '/' + action, readOnly: false, body: {}};
      if (gateway === 'microsoft_ads_native_action') modelled += microsoftWireContract(plan) ? 1 : 0;
      else assert.equal(microsoftWireContract(plan), undefined, String(gateway) + ' ' + action);
    }
  assert.ok(operations.length > 200 && modelled === operations.length, operations.length + ' ' + modelled);
  // The Data Manager contract from a test's own envelope, sealed or not, and from the pinned document.
  const document = {
    resources: {
      audienceMembers: {
        methods: {
          ingest: {id: 'datamanager.audienceMembers.ingest', request: {$ref: 'Ingest'}},
          remove: {id: 'datamanager.audienceMembers.remove'},
        },
      },
    },
    schemas: {
      Ingest: {
        id: 'Ingest',
        type: 'object',
        properties: {destinations: {type: 'array', items: {type: 'string'}}, validateOnly: {type: 'boolean'}},
      },
    },
  };
  const envelopes = [
    {document, document_sha256: createHash('sha256').update(JSON.stringify(document)).digest('hex')},
    {document, document_sha256: 'f'.repeat(64)},
    undefined,
  ];
  const view = r =>
    text(
      r && {
        ...r,
        check: r.check && [
          r.check({destinations: ['a'], validateOnly: true}, false),
          r.check({bogus: 1}, true),
          r.check({destinations: [1]}, false),
        ],
      },
    );
  for (const envelope of envelopes)
    for (const action of dataManagerActions)
      for (const origin of [dataManagerOrigin, 'https://googleads.googleapis.com', undefined])
        for (const gateway of gateways) {
          const plan = {gateway, action, origin, method: 'POST', path: '/v1/audienceMembers:ingest', readOnly: false};
          assert.equal(
            view(dataManagerContract(plan, envelope)),
            view(oldWire.dataManagerContract(plan, envelope)),
            gateway + ' ' + action,
          );
        }
});

test('the Google Ads request query reads the same audit rows, through the same index, as the query that named it', () => {
  // src/audit-repository.ts as it was: its query named the gateway twice; the gateway is bound to it now.
  const old =
    "SELECT request_id, json_extract(event,'$.request.action') AS action FROM audit WHERE tenant_id=? AND created_at>=? AND instr(event,'google_ads_native_action')>0 AND json_extract(event,'$.request.gateway')='google_ads_native_action' ORDER BY seq LIMIT ?";
  const store = new Store(':memory:', Buffer.alloc(32, 41).toString('base64'));
  const events = [
    ...gateways.map(gateway => ({event: 'native_request', request: {gateway, action: 'ACTION_OF_' + gateway}})),
    {event: 'native_request', request: {gateway: 'google_ads_native_action'}},
    {event: 'native_request', request: {gateway: 'google_ads_native_action', action: 7}},
    {event: 'native_request', request: {gateway: 'google_ads_native_action', action: {nested: true}}},
    {event: 'native_request', request: {gateway: 'meta_native_action', action: 'A', note: 'google_ads_native_action'}},
    {event: 'native_request', gateway: 'google_ads_native_action', request: {action: 'B'}},
    {event: 'native_request', request: {gateway: 'GOOGLE_ADS_NATIVE_ACTION', action: 'C'}},
    {event: 'native_request', request: {gateway: 'google_ads_native_action ', action: 'D'}},
    {event: 'native_request', request: [{gateway: 'google_ads_native_action'}]},
    'google_ads_native_action',
    {event: 'native_request', request: {gateway: 'google_ads_native_action', action: 'LAST'}},
  ];
  for (const tenant of ['first', 'second'])
    events.forEach((event, i) => store.appendAudit(tenant, tenant + '-' + i, event));
  let rows = 0;
  for (const tenant of ['first', 'second', 'none'])
    for (const since of [0, Date.now() - 600000, Date.now() + 600000])
      for (const limit of [1, 2, 3, 1000]) {
        const now = googleAdsRequestActions(store, tenant, since, limit);
        assert.equal(
          text(now),
          text(store.sql().prepare(old).all(tenant, since, limit)),
          tenant + ' ' + since + ' ' + limit,
        );
        rows += now.length;
      }
  assert.ok(rows > 0);
  // The same query plan: the gateway, bound or named, reaches no index.
  const prepared = [];
  googleAdsRequestActions(
    {
      sql: () => ({
        prepare: sql => {
          const statement = store.sql().prepare(sql);
          return {all: (...params) => (prepared.push({sql, params}), statement.all(...params))};
        },
      }),
    },
    'first',
    0,
    1000,
  );
  const plan = (sql, params) =>
    store
      .sql()
      .prepare('EXPLAIN QUERY PLAN ' + sql)
      .all(...params)
      .map(row => row.detail);
  assert.equal(prepared.length, 1);
  assert.deepEqual(plan(prepared[0].sql, prepared[0].params), plan(old, ['first', 0, 1000]));
});
