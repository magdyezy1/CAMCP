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

test('the review and its state reads name no provider and import no provider module', () => {
  for (const file of ['src/write-review.ts', 'src/write-snapshots.ts']) {
    const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.deepEqual(
      [...source.matchAll(/['"]([a-z0-9_]+_native_action)['"]/g)].map(m => m[1]),
      [],
      file,
    );
    assert.deepEqual(
      [...source.matchAll(/from '\.\/([^']+)\.js'/g)]
        .map(m => 'src/' + m[1] + '.ts')
        .filter(f => isProviderModule(f) && !providerRegistries.includes(f)),
      [],
      file,
    );
  }
});

test('each provider declares exactly the review hooks of the parts the review named it for, frozen', () => {
  const declared = Object.fromEntries(
    registeredProviderHooks.filter(h => h.writes).map(h => [h.gateway, Object.keys(h.writes).sort()]),
  );
  assert.deepEqual(declared, {
    google_ads_native_action: ['batch', 'confirms', 'prerequisites', 'rejectionIsNonApplied', 'snapshots'],
    google_business_native_action: ['publishesLive', 'shownRequest'],
    meta_native_action: ['confirms', 'impact', 'ownState', 'parentChecks', 'snapshots'],
    tiktok_native_action: ['confirms', 'deletes', 'morePages', 'prerequisites', 'snapshots'],
    snapchat_native_action: [
      'accountPath',
      'accountSnapshots',
      'affectedAds',
      'batch',
      'confirms',
      'dependentReads',
      'impact',
      'observeState',
      'ownedReferences',
      'prerequisites',
      'recordCount',
      'snapshots',
    ],
    x_ads_native_action: ['accountPath', 'confirms', 'parentChecks', 'snapshots'],
    linkedin_native_action: ['accountPath', 'confirms'],
    dv360_native_action: ['accountPath', 'confirms'],
    microsoft_ads_native_action: ['emptyErrors', 'writeGrant'],
    apple_ads_native_action: ['prerequisites', 'sharedAccounts', 'sharedState', 'writePermission'],
    reddit_native_action: ['writeScopes'],
    ga4_native_action: ['verificationPhase', 'writePermission'],
    gtm_native_action: ['concurrency', 'outcomeData', 'publishesLive', 'writePermission'],
    google_search_console_native_action: ['publishesLive', 'writePermission'],
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

test('the state reads ask each provider where the stage named it, and keep only LinkedIn’s versioning headers', () => {
  // The account paths the stage's table held, now each provider's.
  assert.deepEqual(
    Object.fromEntries(
      registeredProviderHooks.filter(h => h.writes?.accountPath).map(h => [h.gateway, String(h.writes.accountPath)]),
    ),
    {
      snapchat_native_action: String(/^\/v1\/adaccounts\/[^/]+/),
      linkedin_native_action: String(/^\/rest\/adAccounts\/[^/]+/),
      x_ads_native_action: String(/^\/12\/accounts\/[^/]+/),
      dv360_native_action: String(/^\/v\d+\/advertisers\/[^/]+/),
    },
  );
  const base = (path, query = {}) => ({path, query});
  // X reads its own targeting criteria only; another X write is left to the stage.
  assert.equal(
    writes('x_ads_native_action').snapshots(plan('x_ads_native_action', 'PUT', '/12/accounts/123/campaigns/1'), base),
    undefined,
  );
  // Meta leaves a write that is neither an account-edge creation nor a node edit to the stage.
  assert.equal(
    writes('meta_native_action').snapshots(plan('meta_native_action', 'DELETE', '/v26.0/987/adlabels'), base),
    undefined,
  );
  // Snapchat: a create outside an account reads its parent collection; on the account, the account; else the stage.
  const snapchat = writes('snapchat_native_action');
  assert.deepEqual(
    snapchat.accountSnapshots(plan('snapchat_native_action', 'POST', '/v1/campaigns/c1/adsquads'), base, undefined),
    [{path: '/v1/campaigns/c1', query: {}}],
  );
  assert.deepEqual(
    snapchat.accountSnapshots(
      plan('snapchat_native_action', 'POST', '/v1/adaccounts/123/campaigns'),
      base,
      '/v1/adaccounts/123',
    ),
    [{path: '/v1/adaccounts/123', query: {}}],
  );
  assert.equal(
    snapchat.accountSnapshots(
      plan('snapchat_native_action', 'PUT', '/v1/adaccounts/123/campaigns'),
      base,
      '/v1/adaccounts/123',
    ),
    undefined,
  );
  // Google Ads and TikTok refuse a write whose state they cannot read.
  refusal(
    () =>
      writes('google_ads_native_action').snapshots(
        plan('google_ads_native_action', 'POST', '/v23/customers/123/labels:mutate'),
        base,
      ),
    'WRITE_CONTRACT_UNAVAILABLE',
    /no implemented state-read contract/,
  );
  refusal(
    () => writes('tiktok_native_action').snapshots(plan('tiktok_native_action', 'POST', '/v1.3/pixel/create/'), base),
    'WRITE_CONTRACT_UNAVAILABLE',
    /no implemented state-read contract/,
  );
  const headers = {
    'LinkedIn-Version': '202509',
    'X-Restli-Protocol-Version': '2.0.0',
    'X-RestLi-Method': 'PARTIAL_UPDATE',
  };
  assert.deepEqual(
    stateRead(plan('linkedin_native_action', 'POST', '/rest/adAccounts/123/adCampaigns/1', {headers}), '/x').headers,
    {
      'LinkedIn-Version': '202509',
      'X-Restli-Protocol-Version': '2.0.0',
    },
  );
  assert.deepEqual(stateRead(plan('meta_native_action', 'POST', '/v26.0/987', {headers}), '/x').headers, {});
});

test('the disclosures ask the provider after the family: what publishes live, how many records, what deletes, the impact', async () => {
  for (const file of ['src/write-effects.ts', 'src/write-impact.ts']) {
    const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.deepEqual(
      [...source.matchAll(/['"]([a-z0-9_]+_native_action)['"]/g)].map(m => m[1]),
      [],
      file,
    );
  }
  const {writeEffects, effectReasons} = await import('../dist/src/write-effects.js');
  const {writeImpact} = await import('../dist/src/write-impact.js');
  const {metaCreativeImpact} = await import('../dist/src/meta-creative-features.js');
  const {snapchatWriteImpact} = await import('../dist/src/snapchat-write-impact.js');
  assert.equal(writes('snapchat_native_action').impact, snapchatWriteImpact);
  // A provider's live publish, and the same route on another provider publishes nothing.
  const publish = plan('gtm_native_action', 'POST', '/tagmanager/v2/accounts/1/containers/2/versions/3:publish');
  assert.deepEqual(writeEffects(publish, []), {
    destructive: false,
    irreversible: false,
    publishes_live: true,
    stops_delivery: false,
  });
  assert.equal(writeEffects({...publish, gateway: 'meta_native_action'}, []), undefined);
  assert.equal(
    writeEffects(plan('google_search_console_native_action', 'PUT', '/webmasters/v3/sites/x/sitemaps/y'), [])
      ?.publishes_live,
    true,
  );
  assert.equal(
    writeEffects(plan('google_business_native_action', 'PATCH', '/v1/locations/1/placeActionLinks/2'), [])
      ?.publishes_live,
    true,
  );
  // TikTok's status update to DELETE deletes, as a boolean effect; another status update does not.
  const status = body => plan('tiktok_native_action', 'POST', '/v1.3/campaign/status/update/', {body});
  assert.deepEqual(writeEffects(status({operation_status: 'DELETE'}), [])?.destructive, true);
  assert.equal(writeEffects(status({operation_status: 'ENABLE'}), []), undefined);
  // A Snapchat record list names its count instead of one target.
  const list = plan('snapchat_native_action', 'DELETE', '/v1/adaccounts/123/campaigns', {
    destructive: true,
    body: {campaigns: [{id: 'a'}, {id: 'b'}]},
  });
  assert.match(effectReasons(list, [], writeEffects(list, []))[0].reason, /^This deletes or removes 2 resources/);
  // The impact: a Snapchat creative edit lists its creatives for the review's affected-ads read; Meta's is its module's.
  const edit = plan('snapchat_native_action', 'PATCH', '/v1/adaccounts/123/creatives/cr1', {body: [{op: 'replace'}]});
  assert.deepEqual(
    [writeImpact(edit, [], false, 'c')?.provider, writeImpact(edit, [], false, 'c')?.affected_creative_ids],
    ['snapchat', ['cr1']],
  );
  const creative = plan('meta_native_action', 'POST', '/v26.0/act_123/adcreatives', {
    body: {name: 'C', destination_spec: {destination_type: 'WEBSITE_AND_SHOP_OPT_OUT'}},
  });
  assert.deepEqual(writeImpact(creative, [], false, 'c'), metaCreativeImpact(creative));
  assert.equal(
    writeImpact(plan('x_ads_native_action', 'PUT', '/12/accounts/123/line_items/1'), [], false, 'c'),
    undefined,
  );
});

test('the outcome asks the provider for its response contract, its empty error lists and what it shows', async () => {
  const source = fs.readFileSync(new URL('../src/write-outcome.ts', import.meta.url), 'utf8');
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
  const {writeOutcome} = await import('../dist/src/write-outcome.js');
  const {gtmSafeConfiguration} = await import('../dist/src/gtm-workflow-writes.js');
  assert.equal(writes('gtm_native_action').outcomeData, gtmSafeConfiguration);
  const response = (data, status = 200, headers = {}) => ({status, headers, data});
  // Microsoft's batch PartialErrors whose slots are all null hold no error; another provider's do, and so do objects.
  const microsoft = plan('microsoft_ads_native_action', 'POST', '/UpdateCampaigns');
  const nullSlots = writeOutcome(response({CampaignIds: ['1'], PartialErrors: [null]}));
  assert.equal(nullSlots.success, false);
  assert.deepEqual(nullSlots.failures, [{path: '$.PartialErrors', value: [null]}]);
  assert.equal(writes('microsoft_ads_native_action').emptyErrors('PartialErrors', [null, null]), true);
  assert.equal(writes('microsoft_ads_native_action').emptyErrors('PartialErrors', [{Code: 1}]), false);
  assert.equal(writes('microsoft_ads_native_action').emptyErrors('Errors', [null]), false);
  // A provider's own response contract confirms its mutation; one without a contract confirms nothing.
  const meta = plan('meta_native_action', 'POST', '/v26.0/act_123/campaigns');
  assert.equal(writeOutcome(response({id: '42'}), meta).success, true);
  assert.equal(writeOutcome(response({success: true}), meta).success, false);
  const linkedin = plan('linkedin_native_action', 'POST', '/rest/adAccounts/123/adCampaigns');
  assert.equal(writeOutcome(response(null, 201, {'x-restli-id': '7'}), linkedin).success, true);
  assert.deepEqual(writeOutcome(response({}, 200), plan('reddit_native_action', 'POST', '/api/v3/x')).failures, [
    {path: '$', value: 'The response does not confirm every mutation under this provider response contract.'},
  ]);
  // Microsoft's null slots are no failure; its synthetic route has no family contract, so only the mutation is unconfirmed.
  assert.deepEqual(
    writeOutcome(response({CampaignIds: ['1'], PartialErrors: [null]}), microsoft).failures.map(f => f.path),
    ['$'],
  );
});

test('a long request is split along its provider record list: Google operations, one Snapchat list', async () => {
  const source = fs.readFileSync(new URL('../src/write-groups.ts', import.meta.url), 'utf8');
  assert.deepEqual(
    [...source.matchAll(/['"]([a-z0-9_]+_native_action)['"]/g)].map(m => m[1]),
    [],
  );
  const {splittableBatch, needsGroup, groupParts} = await import('../dist/src/write-groups.js');
  const operations = Array.from({length: 30}, (_, i) => ({create: {name: 'k' + i}}));
  assert.deepEqual(splittableBatch('google_ads_native_action', {payload: {operations}}), {
    key: 'operations',
    items: operations,
  });
  // Temporary resource IDs link the operations of one request: it is not split.
  const linked = [{create: {resource_name: 'customers/1/campaigns/-1'}}, ...operations];
  assert.equal(splittableBatch('google_ads_native_action', {payload: {operations: linked}}), undefined);
  assert.equal(splittableBatch('google_ads_native_action', {payload: {ads: operations}}), undefined);
  const ads = Array.from({length: 26}, (_, i) => ({name: 'ad' + i}));
  assert.deepEqual(splittableBatch('snapchat_native_action', {payload: {ads}}), {key: 'ads', items: ads});
  assert.equal(splittableBatch('snapchat_native_action', {payload: {ads, campaigns: []}}), undefined);
  // Another provider's list, and arguments without a payload object, are never split.
  for (const [gateway, args] of [
    ['meta_native_action', {payload: {operations}}],
    ['tiktok_native_action', {payload: {ads}}],
    ['google_ads_native_action', {payload: [operations]}],
    ['google_ads_native_action', undefined],
  ])
    assert.equal(splittableBatch(gateway, args), undefined, gateway);
  assert.equal(needsGroup('snapchat_native_action', {payload: {ads}}), true);
  assert.deepEqual(
    groupParts('snapchat_native_action', {action: 'x', payload: {ads}}).map(p => p.payload.ads.length),
    [25, 1],
  );
});

// The stage modules of wave 4c's last round: each names no gateway and imports no provider module.
const assertProviderFree = file => {
  const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  assert.deepEqual(
    [...source.matchAll(/['"]([a-z0-9_]+_native_action)['"]/g)].map(m => m[1]),
    [],
    file,
  );
  assert.deepEqual(
    [...source.matchAll(/from '\.\/([^']+)\.js'/g)]
      .map(m => 'src/' + m[1] + '.ts')
      .filter(f => isProviderModule(f) && !providerRegistries.includes(f)),
    [],
    file,
  );
};

test('a refusal after dispatch asks the provider for its proof after the family: Google’s per-service rule', async () => {
  assertProviderFree('src/write-rejection.ts');
  const {nonAppliedRejection, definitiveRefusalStatuses} = await import('../dist/src/write-rejection.js');
  const core = await import('../dist/src/write-rejection-core.js');
  const {googleRejectionIsNonApplied} = await import('../dist/src/google-write-rejection.js');
  // Only Google Ads declares a proof, its module's own; the statuses keep their import path.
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.writes?.rejectionIsNonApplied).map(h => h.gateway),
    ['google_ads_native_action'],
  );
  assert.equal(writes('google_ads_native_action').rejectionIsNonApplied, googleRejectionIsNonApplied);
  assert.equal(definitiveRefusalStatuses, core.definitiveRefusalStatuses);
  const refused = (status, details = {}) =>
    new MirrorError('UPSTREAM_ERROR', 'Refused.', {http_status: status, upstream: {error: {code: 3}}, ...details});
  const google = plan('google_ads_native_action', 'POST', '/v23/customers/123/campaignBudgets:mutate', {
    body: {operations: [{create: {name: 'b'}}]},
  });
  assert.equal(nonAppliedRejection(google, refused(400)), true);
  // A family's proof decides first, even where Google's rule would prove the refusal.
  assert.equal(nonAppliedRejection(google, refused(400), {rejectionIsNonApplied: () => false}), false);
  // Partial failure, validate-only, a status that is not definitive and another provider's refusal prove nothing.
  assert.equal(nonAppliedRejection({...google, body: {partial_failure: true}}, refused(400)), false);
  assert.equal(nonAppliedRejection({...google, body: {validateOnly: 'true'}}, refused(400)), false);
  assert.equal(nonAppliedRejection(google, refused(429)), false);
  for (const gateway of ['meta_native_action', 'snapchat_native_action', 'microsoft_ads_native_action'])
    assert.equal(nonAppliedRejection({...google, gateway}, refused(400)), false, gateway);
});

test('a verification asks the provider for the accounts its write changes and the phase its reads show', async () => {
  assertProviderFree('src/write-verification.ts');
  const {measurementVerificationPhase} = await import('../dist/src/measurement-writes.js');
  // Only GA4 declares a phase, its measurement module's: a provider job running is pending, a failed one failed.
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.writes?.verificationPhase).map(h => h.gateway),
    ['ga4_native_action'],
  );
  assert.equal(writes('ga4_native_action').verificationPhase, measurementVerificationPhase);
  const task = plan('ga4_native_action', 'GET', '/v1beta/properties/1/reportTasks/2'),
    phase = state => writes('ga4_native_action').verificationPhase(task, state);
  assert.equal(phase({report_metadata: {state: 'ACTIVE'}}), 'verified');
  assert.equal(phase({report_metadata: {state: 'CREATING'}}), 'pending');
  assert.equal(phase({report_metadata: {state: 'FAILED'}}), 'failed');
  // Only Apple names the other accounts a write changes (its shared budgets); another write names none.
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.writes?.sharedAccounts).map(h => h.gateway),
    ['apple_ads_native_action'],
  );
  assert.deepEqual(
    writes('apple_ads_native_action').sharedAccounts(plan('apple_ads_native_action', 'PUT', '/v1/x')),
    [],
  );
});
