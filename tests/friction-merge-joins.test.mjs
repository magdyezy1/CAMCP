import test from 'node:test';
import assert from 'node:assert/strict';
import {Compiler} from '../dist/src/compiler.js';
import {Introspection} from '../dist/src/introspection.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {Store} from '../dist/src/store.js';
import {NativeTransport} from '../dist/src/transport.js';
import {account, actor, admin, at, google, shoppingResponder} from './fixtures/google-shopping-build.mjs';

/**
 * The joins of the friction release merge (r25-friction-merge): what two packages that pass alone must say together.
 *
 * J-A, r25-fr-listings x r25-fr-verify: a copy of a product tree to many ad groups is one write group of built parts (one part for each target, each a tree of
 * up to 3,050 nodes), and a direct execute now waits a few seconds for the read-back and answers what it found (`verification`, with how many resources it
 * means to read). The answer of a group that the wait ends before counted the group's `records` as the resources to read, and for a built group those are the
 * nodes its parts create (30,490 for the owner's ten ad groups); its read-backs are its parts, one check for each tree.
 *
 * J-B, r25-fr-listings x r25-fr-meta-reads: the two build actions are hidden (callable and described, never listed); the word search of LIST_ACTIONS and
 * the names a refusal of an unknown action offers read the same catalog, and must leave them hidden.
 */
const copy = 'AMCP_COPY_LISTING_GROUPS';
const hidden = [copy, 'AMCP_MATCH_LISTING_GROUPS'];
const targets = ['61', '62', '63'];
const ids = (n, from = 1) => Array.from({length: n}, (_, i) => 'SKU-' + String(from + i).padStart(5, '0'));
const group = id => at('adGroups', id);
const base = 100000;
const node = (g, id, type, parent, caseValue, extra = {}) => ({
  resource_name: at('adGroupCriteria', g + '~' + (base + id)),
  ad_group: group(g),
  criterion_id: String(base + id),
  type: 'LISTING_GROUP',
  negative: false,
  status: 'ENABLED',
  listing_group: {
    type,
    ...(parent
      ? {parent_ad_group_criterion: at('adGroupCriteria', g + '~' + (base + parent)), case_value: caseValue}
      : {}),
  },
  ...extra,
});
/** The flat tree "include these item ids, exclude the rest": the root, one unit with a bid per id, and the excluded "Other". */
const flatTree = (g, items) => [
  node(g, 1, 'SUBDIVISION'),
  ...items.map((sku, i) => node(g, 2 + i, 'UNIT', 1, {product_item_id: {value: sku}}, {cpc_bid_micros: '500000'})),
  node(g, 2 + items.length, 'UNIT', 1, {product_item_id: {}}, {negative: true}),
];
const adGroups = (...groupIds) => ({
  adGroups: Object.fromEntries(
    groupIds.map(g => [group(g), {status: 'PAUSED', type: 'SHOPPING_PRODUCT_ADS', campaign: at('campaigns', '40')}]),
  ),
  campaigns: {
    [at('campaigns', '40')]: {
      status: 'PAUSED',
      advertisingChannelType: 'SHOPPING',
      shoppingSetting: {merchantId: '555'},
      biddingStrategyType: 'MANUAL_CPC',
    },
  },
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A synthetic Google that holds a tree of 30 item ids in ad group 60, three empty Shopping ad groups, and the production policy's inline read-back
 * (`inlineVerifyMs`, which only the production runtime sets). Its reads wait `readMs` once `slow.on` says so, to make a read-back that outlasts the wait.
 */
function builtCustomer({inlineVerifyMs, readMs = 0}) {
  const store = new Store(':memory:', Buffer.alloc(32, 78).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway: google,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const {mutates, queries, fetch} = shoppingResponder({
    ...adGroups('60', ...targets),
    criteria: flatTree('60', ids(30)),
  });
  const slow = {on: false};
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (url, init) => {
        if (slow.on && String(url).endsWith('googleAds:search')) await sleep(readMs);
        return fetch(url, init);
      },
      undefined,
      undefined,
      undefined,
      10000,
    ),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0, inlineVerifyMs},
  );
  const call = (tool, input) => service.call(tool, input, actor);
  return {
    store,
    mutates,
    queries,
    slow,
    call,
    prepare: () =>
      call('amcp_write', {
        action: 'prepare',
        gateway: google,
        arguments: {
          action: copy,
          account_id: account,
          payload: {source: {ad_group_id: '60'}, targets: targets.map(ad_group_id => ({ad_group_id}))},
        },
      }),
    execute: review =>
      call('amcp_write', {
        action: 'execute',
        review_id: review.data.review_id,
        confirmed: true,
        spend_change_confirmed: true,
      }),
  };
}

test('J-A: a copy of a tree to three ad groups executed under the inline read-back answers verified, one check for each target, and sends each part once', async t => {
  const x = builtCustomer({inlineVerifyMs: 5000});
  t.after(() => x.store.close());
  const p = await x.prepare();
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 400));
  assert.equal(p.data.group, true);
  assert.equal(p.data.parts.length, 3);
  const e = await x.execute(p);
  assert.equal(e.success, true, JSON.stringify(e).slice(0, 400));
  assert.equal(x.mutates.length, 3, 'one mutate for each target');
  const v = e.data.verification;
  assert.equal(v.status, 'verified', JSON.stringify(v));
  assert.equal(v.inline, true);
  assert.deepEqual([v.checked, v.total], [3, 3]);
  assert.equal(v.differences, undefined);
  // Nothing is read after the answer: the read-back that a plan's step makes was this one, and no part's own job reads again inside the wait.
  const reads = x.queries.length;
  await sleep(300);
  assert.equal(x.queries.length, reads, 'no second read-back');
  assert.equal(x.mutates.length, 3);
});

test('J-A: when the wait ends before the read-back does, the answer counts the group’s read-backs (its targets), not the nodes its parts create, and the read-back still verifies the group', async t => {
  const x = builtCustomer({inlineVerifyMs: 100, readMs: 150});
  t.after(() => x.store.close());
  const p = await x.prepare();
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 400));
  assert.equal(p.data.records, 96, 'the group creates 96 nodes in three parts');
  x.slow.on = true;
  const e = await x.execute(p);
  assert.equal(e.success, true, JSON.stringify(e).slice(0, 400));
  assert.equal(x.mutates.length, 3);
  const v = e.data.verification;
  assert.equal(v.status, 'checking', JSON.stringify(v));
  assert.equal(v.inline, true);
  assert.equal(v.total, 3, 'three targets to read back, not 96 nodes: ' + JSON.stringify(v));
  assert.ok(v.checked <= v.total);
  assert.equal(v.retry_read_after_ms, 5000);
  assert.equal(v.next_call.arguments.action, 'verify');
  // The call it names settles the group.
  x.slow.on = false;
  const settled = await x.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id});
  assert.equal(settled.data.status, 'verified', JSON.stringify(settled.data).slice(0, 400));
  assert.equal(x.mutates.length, 3, 'nothing was sent again');
});

test('J-B: the two build actions stay hidden: the word search never finds them, a refusal of a name next to one never offers them, and each is still described', () => {
  const registry = new Registry(),
    introspection = new Introspection(registry),
    strict = {mode: 'strict', flags: {}},
    list = search => introspection.list(google, {action: 'LIST_ACTIONS', search}, strict),
    names = page => page.actions.map(a => a.name ?? a.action);
  for (const search of ['match listing groups', 'copy listing groups', 'AMCP_MATCH_LISTING_GROUPS', 'listing group']) {
    const found = names(list(search));
    for (const name of hidden) assert.equal(found.includes(name), false, search + ' finds ' + name);
  }
  // The search does find the listing group actions that the capture lists: the filter is the hidden mark, not a search that finds nothing.
  assert.ok(names(list('listing group')).length > 0);
  const compiler = new Compiler(registry);
  for (const typo of ['AMCP_MATCH_LISTING_GROUPZ', 'AMCP_COPY_LISTING_GROUP', 'amcp_match_listing_groups_x']) {
    let refused;
    try {
      compiler.compile(google, {action: typo, account_id: account}, strict);
    } catch (e) {
      refused = e;
    }
    assert.ok(refused, typo + ' is no action');
    const offered = JSON.stringify(refused.details?.did_you_mean ?? []);
    for (const name of hidden) assert.equal(offered.includes(name), false, typo + ' offers ' + name);
  }
  for (const name of hidden) {
    const described = introspection.describe(google, {target_action: name});
    assert.equal(JSON.stringify(described).includes(name), true, name + ' is described');
  }
});
