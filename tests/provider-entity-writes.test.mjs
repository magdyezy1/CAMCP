import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {familyOf, reviewedFamilies} from '../dist/src/reviewed-families.js';
import {providerAdapters, providerOf} from '../dist/src/provider-adapters.js';
import {reviewedWriteFamily} from '../dist/src/reviewed-routes.js';

// ARC-01 phase B, the entity writes: each platform's generic entity writes (the creations, edits and deletions of its
// campaigns, ad groups, ads and creatives no registered family claims) left src/reviewed-routes.ts for its provider
// adapter's facts (`entityWrites`, src/provider-adapters.ts). reviewedWriteFamily keeps the read-only and
// special-transport exclusions and the registered families first. Loading the catalog first evaluates the registry, as
// entry points do.
const registry = new Registry();

/** reviewed-routes.ts before the move: its gateway branches, transcribed as they were written. */
function copiedRoute(p) {
  const route = p.path,
    method = p.method;
  if (p.readOnly || p.specialTransport) return;
  const family = familyOf(p);
  if (family) return family.name;
  if (p.gateway === 'google_ads_native_action')
    return method === 'POST' &&
      /^\/v\d+\/customers\/[^/]+\/(campaigns|adGroups|adGroupAds|campaignBudgets|ads|assetGroups|assets):mutate$/.test(
        route,
      )
      ? 'google_entities'
      : undefined;
  if (p.gateway === 'meta_native_action')
    return (method === 'POST' && /^\/v[^/]+\/act_[^/]+\/(campaigns|adsets|ads|adcreatives)$/.test(route)) ||
      (['POST', 'DELETE'].includes(method) && /^meta_(campaign_id|ad_set_id|ad_id)_(update|delete)$/.test(p.action))
      ? 'meta_entities'
      : undefined;
  if (p.gateway === 'snapchat_native_action')
    return (method === 'POST' &&
      /^\/v1\/(adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives|lead_generation_forms|segments)|campaigns\/[^/]+\/adsquads|adsquads\/[^/]+\/ads)$/.test(
        route,
      )) ||
      (method === 'PUT' && /^\/v1\/adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives|segments)$/.test(route)) ||
      (method === 'PATCH' && /^\/v1\/adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives)\/[^/]+$/.test(route)) ||
      (method === 'DELETE' && /^\/v1\/(campaigns|adsquads|ads)\/[^/]+$/.test(route))
      ? 'snapchat_entities'
      : undefined;
  if (p.gateway === 'tiktok_native_action')
    return method === 'POST' && /^\/v1\.3\/(campaign|adgroup|ad)\/(create|update)\/$/.test(route)
      ? 'tiktok_entities'
      : undefined;
  if (p.gateway === 'x_ads_native_action') {
    return (method === 'POST' && /^\/12\/accounts\/[^/]+\/(campaigns|line_items|targeting_criteria)$/.test(route)) ||
      (['PUT', 'DELETE'].includes(method) && /^\/12\/accounts\/[^/]+\/(campaigns|line_items)\/[^/]+$/.test(route)) ||
      (method === 'DELETE' && /^\/12\/accounts\/[^/]+\/(targeting_criteria|promoted_tweets)\/[^/]+$/.test(route))
      ? 'x_entities'
      : undefined;
  }
  if (p.gateway === 'linkedin_native_action')
    return (method === 'POST' && /^\/rest\/adAccounts\/[^/]+\/(adCampaigns|adCampaignGroups|creatives)$/.test(route)) ||
      (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) &&
        /^\/rest\/adAccounts\/[^/]+\/(adCampaigns|adCampaignGroups|creatives)\/[^/]+$/.test(route))
      ? 'linkedin_entities'
      : undefined;
  if (p.gateway === 'dv360_native_action')
    return (method === 'POST' &&
      /^\/v\d+\/advertisers\/[^/]+\/(campaigns|insertionOrders|lineItems|creatives)$/.test(route)) ||
      (['PATCH', 'DELETE'].includes(method) &&
        /^\/v\d+\/advertisers\/[^/]+\/(campaigns|insertionOrders|lineItems|creatives)\/[^/]+$/.test(route))
      ? 'dv360_entities'
      : undefined;
}

const plan = (gateway, method, path, action, extra = {}) => ({
  gateway,
  action,
  method,
  path,
  query: {},
  body: {},
  headers: {},
  readOnly: false,
  destructive: method === 'DELETE',
  requiresConfirmation: false,
  accountId: '123',
  evidence: '',
  warnings: [],
  ...extra,
});
const pathOf = r =>
  r.path.startsWith('https://')
    ? new URL(r.path.replace(/\{[^}]+\}/g, '123')).pathname
    : r.path.split('?')[0].replace(/\{[^}]+\}/g, '123');
// Paths at the edges of each platform's entity routes: the routes themselves, their neighbours and near misses.
const edges = {
  google_ads_native_action: [
    '/v25/customers/123/campaigns:mutate',
    '/v19/customers/1-2/assets:mutate',
    '/v25/customers/123/assetGroupAssets:mutate',
    '/v25/customers/123/campaigns:mutateX',
    '/v25/customers/123/campaigns',
    '/vX/customers/123/ads:mutate',
    '/v25/customers//ads:mutate',
  ],
  meta_native_action: [
    '/v26.0/act_1/campaigns',
    '/v26.0/act_1/adsets',
    '/v26.0/act_1/ads',
    '/v26.0/act_1/adcreatives',
    '/v26.0/act_1/adcreatives/2',
    '/v26.0/1/campaigns',
    '/act_1/ads',
  ],
  snapchat_native_action: [
    '/v1/adaccounts/1/campaigns',
    '/v1/adaccounts/1/lead_generation_forms',
    '/v1/adaccounts/1/segments',
    '/v1/campaigns/2/adsquads',
    '/v1/adsquads/3/ads',
    '/v1/adaccounts/1/campaigns/4',
    '/v1/campaigns/4',
    '/v1/ads/5',
    '/v1/creatives/6',
    '/v1/adaccounts/1/media',
  ],
  tiktok_native_action: [
    '/v1.3/campaign/create/',
    '/v1.3/adgroup/update/',
    '/v1.3/ad/update/',
    '/v1.3/ad/status/update/',
    '/v1.3/campaign/create',
    '/v1x3/ad/create/',
  ],
  x_ads_native_action: [
    '/12/accounts/a/campaigns',
    '/12/accounts/a/line_items',
    '/12/accounts/a/targeting_criteria',
    '/12/accounts/a/campaigns/1',
    '/12/accounts/a/line_items/2',
    '/12/accounts/a/targeting_criteria/3',
    '/12/accounts/a/promoted_tweets/4',
    '/12/accounts/a/promoted_tweets',
    '/11/accounts/a/campaigns',
  ],
  linkedin_native_action: [
    '/rest/adAccounts/1/adCampaigns',
    '/rest/adAccounts/1/adCampaignGroups',
    '/rest/adAccounts/1/creatives',
    '/rest/adAccounts/1/adCampaigns/2',
    '/rest/adAccounts/1/creatives/urn%3Ali%3AsponsoredCreative%3A3',
    '/rest/adAccounts/1/adCampaigns/2/x',
    '/rest/adCampaigns/2',
  ],
  dv360_native_action: [
    '/v4/advertisers/1/campaigns',
    '/v4/advertisers/1/insertionOrders',
    '/v4/advertisers/1/lineItems/2',
    '/v3/advertisers/1/creatives/3',
    '/v4/advertisers/1/lineItems:bulkUpdate',
    '/v4/partners/1/campaigns',
  ],
};
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', undefined];
const metaActions = [
  'meta_campaign_id_update',
  'meta_ad_set_id_delete',
  'meta_ad_id_update',
  'meta_ad_creative_id_update',
  'meta_campaign_id_get',
];

test('every reviewed route is the one reviewed-routes.ts gave: every ledger route, method and edge case', () => {
  const rows = actionContracts(registry).filter(r => r.method && r.path);
  assert.ok(rows.length > 2000);
  const plans = [];
  for (const r of rows) {
    const action = r.operation ? r.operation + (r.action !== r.operation ? '/' + r.action : '') : r.action;
    for (const method of methods) plans.push(plan(r.gateway, method, pathOf(r), action, {origin: r.origin}));
  }
  for (const [gateway, paths] of Object.entries(edges))
    for (const path of paths)
      for (const method of methods)
        for (const action of gateway === 'meta_native_action' ? [...metaActions, 'meta_write'] : [gateway + '_write'])
          plans.push(plan(gateway, method, path, action));
  // The exclusions come first, whatever the route: a read and a special transport have no reviewed route.
  const base = plans.length;
  for (let i = 0; i < base; i += 97) {
    plans.push({...plans[i], readOnly: true});
    plans.push({...plans[i], specialTransport: 'upload'});
  }
  // A gateway no adapter declares entity writes for, and a name that is no gateway.
  plans.push(plan('reddit_native_action', 'POST', '/api/v3/ad_accounts/1/campaigns', 'reddit_write'));
  plans.push(plan('no_such_native_action', 'POST', '/v1/adaccounts/1/campaigns', 'x'));
  plans.push(plan(undefined, 'POST', '/v25/customers/1/ads:mutate', 'x'));
  // A refusal (two families claiming a request) is an outcome too, compared like a route.
  const run = f => {
    try {
      return {route: f()};
    } catch (error) {
      return {refused: error.code ?? String(error)};
    }
  };
  const registered = new Set(reviewedFamilies().map(f => f.name)),
    named = new Map();
  for (const p of plans) {
    const expected = run(() => copiedRoute(p));
    assert.deepEqual(
      run(() => reviewedWriteFamily(p)),
      expected,
      JSON.stringify([p.gateway, p.method, p.path, p.action]),
    );
    if (expected.route && !registered.has(expected.route))
      named.set(expected.route, (named.get(expected.route) ?? 0) + 1);
  }
  // Each platform's entity route was reached, so a branch that stopped matching would show.
  assert.deepEqual([...named.keys()].sort(), [
    'dv360_entities',
    'google_entities',
    'linkedin_entities',
    'meta_entities',
    'snapchat_entities',
    'tiktok_entities',
    'x_entities',
  ]);
});

test('seven adapters declare entity writes, frozen; reviewed-routes.ts names no gateway', () => {
  const declared = providerAdapters.filter(a => a.entityWrites);
  assert.deepEqual(
    declared.map(a => [a.gateway, a.entityWrites.family]),
    [
      ['google_ads_native_action', 'google_entities'],
      ['meta_native_action', 'meta_entities'],
      ['tiktok_native_action', 'tiktok_entities'],
      ['snapchat_native_action', 'snapchat_entities'],
      ['linkedin_native_action', 'linkedin_entities'],
      ['x_ads_native_action', 'x_entities'],
      ['dv360_native_action', 'dv360_entities'],
    ],
  );
  for (const a of declared) {
    assert.ok(Object.isFrozen(a.entityWrites), a.id);
    assert.equal(providerOf(a.gateway), a);
    // An entity route belongs to its adapter: the family prefix is the provider's own.
    assert.ok(
      a.familyPrefixes.some(prefix => a.entityWrites.family.startsWith(prefix)),
      a.id,
    );
  }
  // The regression this guards: a provider branch back in the shared route membership.
  assert.doesNotMatch(fs.readFileSync('src/reviewed-routes.ts', 'utf8'), /_native_action/);
});
