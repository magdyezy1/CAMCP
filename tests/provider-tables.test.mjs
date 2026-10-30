import test from 'node:test';
import assert from 'node:assert/strict';
import {providerAdapters} from '../dist/src/provider-adapters.js';
import {providerHooks, registeredProviderHooks} from '../dist/src/provider-hooks.js';
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
