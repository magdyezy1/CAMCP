import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyExecutionRisk,
  bodyDeletion,
  bodyDeletionValues,
  independentlyReadOnly,
} from '../dist/src/execution-risk.js';
import {qualifiedProviderRead} from '../dist/src/provider-read-contracts.js';

// ARC-01 phase B, read classification: src/execution-risk.ts keeps the generic read rules and each provider's
// documented exceptions are its adapter's (src/<provider>-adapter.ts, registered in src/provider-hooks.ts). The cases
// below held before the move, with the classifier's per-gateway branches, and must hold after it.

const plan = (gateway, method, path, fields = {}) => ({
  gateway,
  action: 'native',
  method,
  path,
  query: {},
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  accountId: '123',
  evidence: 'TEST',
  warnings: [],
  ...fields,
});

/** [gateway, method, path, extra fields, read?] */
const cases = [
  // Each provider's documented POST reads, and a POST beside them that is not one.
  ['google_ads_native_action', 'POST', '/v23/customers/123/googleAds:search', {}, true],
  ['google_ads_native_action', 'POST', '/v23:listPlannableLocations', {}, true],
  ['google_ads_native_action', 'POST', '/v23/keywordThemeConstants:suggest', {}, true],
  ['google_ads_native_action', 'POST', '/v23/customers/123/campaigns:mutate', {}, false],
  ['google_ads_native_action', 'POST', '/v23:generateKeywordIdeas', {}, false],
  ['tiktok_native_action', 'POST', '/v1.3/tool/bid/recommend/', {}, true],
  ['tiktok_native_action', 'POST', '/open_api/v1.3/tool/targeting/search/', {}, true],
  ['tiktok_native_action', 'POST', '/v1.3/campaign/create/', {}, false],
  ['snapchat_native_action', 'POST', '/v1/adaccounts/123/get_campaigns_by_ids', {}, true],
  ['snapchat_native_action', 'POST', '/v1/catalogs/9/product_search', {}, true],
  ['snapchat_native_action', 'POST', '/v1/adaccounts/123/campaigns', {}, false],
  ['ga4_native_action', 'POST', '/v1beta/properties/123:runReport', {}, true],
  ['ga4_native_action', 'POST', '/v1alpha/properties/123/reportTasks/7:query', {}, true],
  ['ga4_native_action', 'POST', '/v1beta/properties/123/dataStreams', {}, false],
  ['gtm_native_action', 'POST', '/tagmanager/v2/accounts/1/containers/2/workspaces/3/folders/4:entities', {}, true],
  [
    'google_search_console_native_action',
    'POST',
    '/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query',
    {},
    true,
  ],
  ['google_search_console_native_action', 'POST', '/v1/urlInspection/index:inspect', {}, true],
  ['criteo_native_action', 'POST', '/2026-07/retail-media/accounts/123/search', {}, true],
  ['criteo_native_action', 'POST', '/2026-07/retail-media/retailers/7/cpc-min-bids', {}, true],
  [
    'google_business_native_action',
    'POST',
    '/v1/googleLocations:search',
    {origin: 'https://mybusinessbusinessinformation.googleapis.com'},
    true,
  ],
  ['google_business_native_action', 'POST', '/v1/googleLocations:search', {}, false],
  ['reddit_native_action', 'POST', '/api/v3/ad_accounts/123/reports', {}, true],
  ['reddit_native_action', 'POST', '/api/v3/forecasting/bid_suggestions', {}, true],
  ['reddit_native_action', 'POST', '/api/v3/ad_accounts/123/campaigns', {}, false],
  ['apple_ads_native_action', 'POST', '/v1/campaigns/query', {origin: 'https://api.ads.apple.com'}, true],
  ['apple_ads_native_action', 'POST', '/v1/campaigns/query', {}, false],
  ['meta_native_action', 'POST', '/v26.0/act_123/insights', {}, false],
  ['x_ads_native_action', 'POST', '/12/accounts/abc/campaigns', {}, false],
  ['adjust_native_action', 'POST', '/reports-service/report', {}, false],
  // Search Console's site URL is an identifier: its words are not edits; the same words elsewhere are.
  [
    'google_search_console_native_action',
    'GET',
    '/webmasters/v3/sites/https%3A%2F%2Fupdate.example%2F/sitemaps',
    {},
    true,
  ],
  ['ga4_native_action', 'GET', '/v1beta/properties/123/update', {}, false],
  // A Graph batch is never a read; the same key elsewhere is a parameter.
  ['meta_native_action', 'GET', '/v26.0/act_123/campaigns', {query: {batch: '[]'}}, false],
  ['tiktok_native_action', 'GET', '/v1.3/campaign/get/', {query: {batch: '[]'}}, true],
  // Documented reads whose paths hold mutation-like words.
  ['meta_native_action', 'GET', '/v26.0/act_123/value_rule_set', {}, true],
  ['tiktok_native_action', 'GET', '/v1.3/business/publish/status/', {}, true],
  ['linkedin_native_action', 'GET', '/rest/organizationalEntityCreateShareAuthorizations/x', {}, true],
  ['linkedin_native_action', 'GET', '/rest/organizationalEntityUpdateShareAuthorizations/x', {}, false],
  // A catalog-marked write is a read only where its provider documents a planning read.
  ['tiktok_native_action', 'GET', '/v1.3/campaign/get/', {readOnly: false}, false],
  // Microsoft's contracts decide alone: an unknown action is no read, whatever its method.
  ['microsoft_ads_native_action', 'GET', '/CampaignManagement/v13/Campaigns/QueryByAccountId', {}, false],
];

test('read classification gives each provider its documented reads and nothing beside them', () => {
  for (const [gateway, method, path, fields, read] of cases)
    assert.equal(independentlyReadOnly(plan(gateway, method, path, fields)), read, [gateway, method, path].join(' '));
});

test('the generic rules hold for every provider: method overrides, REST.li methods, unsafe paths and personal data', () => {
  for (const [gateway, path] of [
    ['meta_native_action', '/v26.0/act_123/campaigns'],
    ['google_ads_native_action', '/v23/customers/123/campaigns'],
    ['snapchat_native_action', '/v1/adaccounts/123/campaigns'],
    ['ga4_native_action', '/v1beta/properties/123/dataStreams'],
  ]) {
    const p = plan(gateway, 'GET', path);
    assert.equal(independentlyReadOnly(p), true, gateway);
    assert.equal(independentlyReadOnly({...p, query: {_method: 'DELETE'}}), false, gateway + ' query override');
    assert.equal(independentlyReadOnly({...p, headers: {'X-HTTP-Method-Override': 'POST'}}), false, gateway);
    assert.equal(independentlyReadOnly({...p, headers: {'X-Restli-Method': 'PARTIAL_UPDATE'}}), false, gateway);
    assert.equal(independentlyReadOnly({...p, path: path + '/delete'}), false, gateway + ' mutation word');
    assert.equal(independentlyReadOnly({...p, path: path + '%3Fx'}), false, gateway + ' escaped query');
    assert.equal(independentlyReadOnly({...p, method: 'PUT'}), false, gateway + ' PUT');
  }
  // A qualified read keeps its GET preconditions whatever its provider says.
  const valueRules = plan('meta_native_action', 'GET', '/v26.0/act_123/value_rule_set');
  assert.equal(qualifiedProviderRead(valueRules), true);
  assert.equal(qualifiedProviderRead({...valueRules, body: {}}), false);
  assert.equal(qualifiedProviderRead({...valueRules, readOnly: false}), false);
  assert.equal(qualifiedProviderRead({...valueRules, origin: 'https://attacker.example'}), false);
  assert.equal(qualifiedProviderRead({...valueRules, gateway: 'snapchat_native_action'}), false);
});

test('body deletions are the facts each provider adapter declares, exactly the table execution-risk.ts held', () => {
  // A change here changes what the owner's deletion switch holds; tests/deletion-policy-coverage.test.mjs keeps it
  // against every pinned provider document.
  assert.deepEqual(Object.fromEntries(Object.entries(bodyDeletionValues).map(([g, d]) => [g, d.fields])), {
    google_ads_native_action: {
      status: ['REMOVED'],
      proposal_type: ['REMOVE'],
      asset_detail_operation: ['REMOVE'],
      operator: ['REMOVE'],
    },
    meta_native_action: {status: ['DELETED']},
    tiktok_native_action: {operation_status: ['DELETE']},
    linkedin_native_action: {status: ['PENDING_DELETION', 'REMOVED'], intended_status: ['PENDING_DELETION', 'REMOVED']},
    microsoft_ads_native_action: {status: ['Deleted'], action: ['Delete'], user_life_cycle_status: ['Deleted']},
    reddit_native_action: {configured_status: ['DELETED'], effective_status: ['DELETED'], status: ['DELETED']},
    dv360_native_action: {entity_status: ['ENTITY_STATUS_SCHEDULED_FOR_DELETION']},
  });
  for (const [gateway, d] of Object.entries(bodyDeletionValues)) {
    assert.ok(Object.isFrozen(d) && Object.isFrozen(d.fields), gateway);
    for (const values of Object.values(d.fields)) assert.ok(Object.isFrozen(values), gateway);
    assert.ok(d.source.length > 20, gateway + ' names its source');
  }
  const write = (gateway, path, body) => ({...plan(gateway, 'POST', path), readOnly: false, body});
  assert.equal(
    bodyDeletion(write('tiktok_native_action', '/v1.3/campaign/status/update/', {operation_status: 'DELETE'})),
    '/body/operation_status',
  );
  assert.equal(
    bodyDeletion(write('tiktok_native_action', '/v1.3/campaign/status/update/', {operation_status: 'DISABLE'})),
    undefined,
  );
  assert.equal(
    bodyDeletion(
      write('google_ads_native_action', '/v23/customers/123/campaigns:mutate', {
        operations: [{remove: 'customers/123/campaigns/1'}],
      }),
    ),
    '/body/operations/0/remove',
  );
  // Google Ads :mutate removals are destructive; a remove key elsewhere, or on another provider, is not.
  const google = applyExecutionRisk(
    write('google_ads_native_action', '/v23/customers/123/adGroups:mutate', {operations: [{remove: 'x'}]}),
  );
  assert.equal(google.destructive, true);
  const other = applyExecutionRisk(
    write('snapchat_native_action', '/v1/adaccounts/123/campaigns:mutate', {operations: [{remove: 'x'}]}),
  );
  assert.equal(other.destructive, false);
  assert.equal(bodyDeletion(write('ga4_native_action', '/v1beta/properties/123', {status: 'DELETED'})), undefined);
});
