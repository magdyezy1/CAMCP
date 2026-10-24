import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {MirrorError} from '../dist/src/errors.js';
import {providerHooks, registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {isProviderModule, providerRegistries} from '../tools/architecture-map.mjs';
import {assertRedditWriteScopes} from '../dist/src/reddit-writes.js';
import {
  assertMeasurementScopes,
  optionalMissingState as measurementOptionalMissing,
} from '../dist/src/measurement-writes.js';
import {optionalMissingState} from '../dist/src/write-common.js';
import {snapAdLeadFormFollowUps} from '../dist/src/snapchat-ad-creatives.js';
import {assertSnapCreativeReferences} from '../dist/src/snapchat-lead-forms.js';
import {snapchatAffectedAdsDisclosure} from '../dist/src/snapchat-affected-ad-pages.js';
import {tiktokInstantFormFollowUps, tiktokInstantFormRead} from '../dist/src/tiktok-instant-forms.js';
import {placeActionSafe} from '../dist/src/google-place-action-links.js';
import {metaAdSetAudienceChoice} from '../dist/src/meta-contracts.js';
import {metaCreativeCreate} from '../dist/src/meta-creative-state.js';
import {validateXTargetingState} from '../dist/src/x-targeting-writes.js';
import {stateRead} from '../dist/src/write-snapshots.js';

// ARC-01 phase B (wave 4c), the review: src/write-review.ts named each provider where its own part of a reviewed write
// ran (Apple's shared budget, Reddit's write scopes, Microsoft's grant, the measurement providers' permissions, Meta's
// creative identity, Snapchat's observation, lead forms, creative references and affected ads, TikTok's Instant Form
// pages and prerequisites, Google's targeting and paused parents, Meta's audience choice, X's paused line item,
// Business Profile's safe request and Tag Manager's fingerprint). Those parts are now its adapter's `writes` hooks; the
// review keeps every generic rule and its order, and asks the provider where it named it. The call-replay proof of the
// move is in docs/review/ARCHITECTURE.md (section 9).

const plan = (gateway, method, path, fields = {}) => ({
  gateway,
  action: 'native',
  method,
  path,
  query: {},
  headers: {},
  body: {},
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  accountId: '123',
  evidence: 'TEST',
  warnings: [],
  ...fields,
});
const refusal = (run, code, message) => {
  try {
    run();
  } catch (error) {
    if (!(error instanceof MirrorError)) throw error;
    assert.equal(error.code, code, error.message);
    if (message) assert.match(error.message, message);
    return;
  }
  assert.fail('expected ' + code + ', but the check accepted the request');
};
const writes = gateway => providerHooks(gateway)?.writes;

test('the review names no provider and imports no provider module', () => {
  const source = fs.readFileSync(new URL('../src/write-review.ts', import.meta.url), 'utf8');
  assert.deepEqual(
    [...source.matchAll(/['"]([a-z0-9_]+_native_action)['"]/g)].map(m => m[1]),
    [],
  );
  assert.deepEqual(
    [...source.matchAll(/from '\.\/([^']+)\.js'/g)]
      .map(m => 'src/' + m[1] + '.ts')
      .filter(f => isProviderModule(f) && !providerRegistries.includes(f)),
    [],
  );
});

test('each provider declares exactly the review hooks of the parts the review named it for, frozen', () => {
  const declared = Object.fromEntries(
    registeredProviderHooks.filter(h => h.writes).map(h => [h.gateway, Object.keys(h.writes).sort()]),
  );
  assert.deepEqual(declared, {
    google_ads_native_action: ['prerequisites'],
    google_business_native_action: ['shownRequest'],
    meta_native_action: ['ownState', 'parentChecks'],
    tiktok_native_action: ['morePages', 'prerequisites'],
    snapchat_native_action: ['affectedAds', 'dependentReads', 'observeState', 'ownedReferences', 'prerequisites'],
    x_ads_native_action: ['parentChecks'],
    microsoft_ads_native_action: ['writeGrant'],
    apple_ads_native_action: ['prerequisites', 'sharedAccounts', 'sharedState', 'writePermission'],
    reddit_native_action: ['writeScopes'],
    ga4_native_action: ['writePermission'],
    gtm_native_action: ['concurrency', 'writePermission'],
    google_search_console_native_action: ['writePermission'],
  });
  for (const hooks of registeredProviderHooks)
    for (const part of [hooks.writes, hooks.writes?.ownState])
      if (part) assert.ok(Object.isFrozen(part), hooks.gateway);
});

test('the hooks are the providers’ own checks, unchanged', () => {
  assert.equal(writes('reddit_native_action').writeScopes, assertRedditWriteScopes);
  for (const gateway of [
    'ga4_native_action',
    'gtm_native_action',
    'google_search_console_native_action',
    'apple_ads_native_action',
  ])
    assert.equal(writes(gateway).writePermission, assertMeasurementScopes, gateway);
  assert.equal(writes('snapchat_native_action').dependentReads, snapAdLeadFormFollowUps);
  assert.equal(writes('snapchat_native_action').ownedReferences, assertSnapCreativeReferences);
  assert.equal(writes('snapchat_native_action').affectedAds, snapchatAffectedAdsDisclosure);
  assert.equal(writes('tiktok_native_action').morePages, tiktokInstantFormFollowUps);
  assert.equal(writes('google_business_native_action').shownRequest, placeActionSafe);
  assert.equal(writes('meta_native_action').ownState.claims, metaCreativeCreate);
  assert.equal(writes('meta_native_action').parentChecks, metaAdSetAudienceChoice);
  assert.equal(writes('x_ads_native_action').parentChecks, validateXTargetingState);
  // The optional-state rule every family's AMCP_STATE_OPTIONAL reads use is the lifecycle's, re-exported where it was.
  assert.equal(measurementOptionalMissing, optionalMissingState);
  const optional = plan('ga4_native_action', 'GET', '/v1beta/properties/1/x', {action: 'AMCP_STATE_OPTIONAL'}),
    missing = new MirrorError('UPSTREAM_ERROR', 'Not found.', {}, 404);
  assert.deepEqual(optionalMissingState(optional, missing), {
    data: {amcp_absent: true, path: optional.path},
    status: 404,
    headers: {},
  });
  assert.equal(optionalMissingState({...optional, action: 'AMCP_STATE_READ'}, missing), undefined);
  assert.equal(optionalMissingState(optional, new MirrorError('UPSTREAM_ERROR', 'Denied.', {}, 403)), undefined);
});

test('Microsoft’s write grant refuses a connection without msads.manage, and accepts one with it', () => {
  const grant = writes('microsoft_ads_native_action').writeGrant,
    connection = scopes => ({id: 'c', gateway: 'microsoft_ads_native_action', accounts: ['123'], scopes});
  refusal(() => grant(connection(['openid'])), 'INSUFFICIENT_SCOPE', /msads\.manage/);
  assert.doesNotThrow(() => grant(connection(['https://ads.microsoft.com/msads.manage'])));
});

test('Tag Manager’s concurrency takes the state’s fingerprint for a route that takes one, and refuses a stale one', () => {
  const concurrency = writes('gtm_native_action').concurrency,
    routes = [{gateway: 'gtm_native_action', operation: 'tags', action: 'update', parameters: {fingerprint: {}}}],
    tag = (query = {}) =>
      plan('gtm_native_action', 'PUT', '/tagmanager/v2/accounts/1/x', {action: 'tags/update', query});
  const fresh = tag();
  concurrency(fresh, [{fingerprint: 'f1'}], routes);
  assert.equal(fresh.query.fingerprint, 'f1');
  const same = tag({fingerprint: 'f1'});
  concurrency(same, [{fingerprint: 'f1'}], routes);
  assert.equal(same.query.fingerprint, 'f1');
  refusal(() => concurrency(tag({fingerprint: 'f0'}), [{fingerprint: 'f1'}], routes), 'STATE_CHANGED', /stale/);
  // A route without the parameter, or a state without a fingerprint, leaves the request as it is.
  const other = tag();
  concurrency(other, [{fingerprint: 'f1'}], [{...routes[0], parameters: {}}]);
  concurrency(other, [{}], routes);
  assert.deepEqual(other.query, {});
});

test('Apple’s shared budget binds every account its read shows, reads each once, and freezes its organization', () => {
  const hooks = writes('apple_ads_native_action'),
    budget = plan('apple_ads_native_action', 'PUT', '/v1/shared-budgets/77', {
      action: 'apple_ads_v1_shared_budget_update',
      origin: 'https://api.ads.apple.com',
      body: {name: 'Shared'},
    });
  // Another Apple write changes no other account.
  assert.deepEqual(hooks.sharedAccounts({...budget, action: 'apple_ads_v1_campaign_update'}), []);
  assert.deepEqual(hooks.sharedAccounts(budget), ['123']);
  const reads = [{path: budget.path}],
    bound = [],
    context = {bind: account => bound.push(account), reads};
  // Only the budget's own read names its accounts.
  hooks.sharedState(budget, {path: '/v1/ad-accounts/123'}, {result: {id: 123}}, context);
  assert.deepEqual([bound, reads.length], [[], 1]);
  hooks.sharedState(budget, {path: budget.path}, {result: {id: 77, adAccountIds: [456, 123]}}, context);
  assert.deepEqual(bound, ['123', '456']);
  assert.deepEqual(budget.scopeContext.appleSharedAccountIds, ['123', '456']);
  assert.deepEqual(
    reads.map(r => [r.path, r.accountId, r.method, r.readOnly]),
    [
      [budget.path, undefined, undefined, undefined],
      ['/v1/ad-accounts/123', '123', 'GET', true],
      ['/v1/ad-accounts/456', '456', 'GET', true],
    ],
  );
  // Once frozen, a later read of the budget binds its accounts again and adds no read.
  hooks.sharedState(budget, {path: budget.path}, {result: {id: 77, adAccountIds: [123, 456]}}, context);
  assert.deepEqual([bound, reads.length], [['123', '456', '123', '456'], 3]);
  // A membership that leaves out the selected account is refused.
  refusal(
    () => hooks.sharedState(budget, {path: budget.path}, {result: {id: 77, adAccountIds: [456]}}, context),
    'STATE_TARGET_MISMATCH',
  );
  hooks.prerequisites(budget, [{result: {id: 77, adAccountIds: [123, 456]}}, {result: {id: 123, orgId: 9}}], reads);
  assert.deepEqual(budget.scopeContext, {
    appleSharedAccountIds: ['123', '456'],
    appleSharedOrgId: '9',
    appleSharedResultAccounts: ['123', '456'],
  });
});
test('TikTok’s more pages are only those of its own Instant Form reads', () => {
  const morePages = writes('tiktok_native_action').morePages,
    form = {
      ...plan('tiktok_native_action', 'GET', '/', {readOnly: true, body: undefined}),
      ...tiktokInstantFormRead('123'),
    },
    firstPage = {data: {list: [], page_info: {page: 1, total_page: 3}}};
  assert.deepEqual(
    morePages(form, firstPage).map(r => r.query.page),
    [2, 3],
  );
  assert.deepEqual(morePages({...form, gateway: 'meta_native_action'}, firstPage), []);
  assert.deepEqual(morePages({...form, query: {...form.query, page: 2}}, firstPage), []);
});

test('Snapchat’s disclosure leaves the affected ads unknown on a provider failure and raises an authority failure', async () => {
  const disclosure = writes('snapchat_native_action').affectedAds,
    edit = plan('snapchat_native_action', 'PUT', '/v1/adaccounts/123/creatives');
  const failed = await disclosure(
    edit,
    ['cr1'],
    async () => {
      throw new MirrorError('UPSTREAM_ERROR', 'Unavailable.', {http_status: 503}, 502);
    },
    stateRead,
  );
  assert.deepEqual(failed, {
    affected_ad_ids: null,
    affected_ads: null,
    incomplete: true,
    enumeration: 'read_failed',
    read_error: 'UPSTREAM_ERROR',
  });
  await assert.rejects(
    disclosure(
      edit,
      ['cr1'],
      async () => {
        throw new MirrorError('CONNECTION_AUTHORITY_CHANGED', 'The login changed.', {}, 409);
      },
      stateRead,
    ),
    e => e.code === 'CONNECTION_AUTHORITY_CHANGED',
  );
  // The pages are the review's state reads of the account's ads collection.
  const requests = [];
  const listed = await disclosure(
    edit,
    ['cr1'],
    async request => {
      requests.push(request);
      return {
        status: 200,
        headers: {},
        data: {request_status: 'SUCCESS', ads: [{sub_request_status: 'SUCCESS', ad: {id: 'a1', creative_id: 'cr1'}}]},
      };
    },
    stateRead,
  );
  assert.deepEqual(listed.affected_ad_ids, ['a1']);
  assert.deepEqual(
    requests.map(r => [r.action, r.method, r.path, r.query, r.readOnly]),
    [['AMCP_STATE_READ', 'GET', '/v1/adaccounts/123/ads', {limit: '1000'}, true]],
  );
});
