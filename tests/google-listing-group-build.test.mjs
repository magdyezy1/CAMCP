// R2.5 r25-fr-listings (the owner's friction report A2 and A3, 2026-11-27): a Google product tree is copied from one ad group or asset
// group to many, or made to match a list of item ids, as ONE reviewed change; the combined mutate that refuses edits names the action
// that takes them; and a review that was sent validateOnly says what validates it. The sizes are the owner's: a list of 3,047 item ids,
// a tree of 3,047 units copied to 10 ad groups, a mixed removal and creation. A synthetic Google answers; nothing reaches Google.
//
// The decisions these tests pin: a tree is one mutate and is never cut; what goes in parts is the set of trees (a write group, one
// part per target); a part the server built may pass the 500 operations of a hand-sent review, up to 10,000 (the owner, 2026-11-27:
// "Yes, 10,000 for built trees", Q28); the answer of a built group carries counts, a sample and hashes, never the 3,000 entries.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {assertRefused} from './helpers/assert-refused.mjs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {chainLimits} from '../dist/src/google-temp-names.js';
import {googleBody, googleJson} from '../dist/src/google-contracts.js';
import {listedShape, treeChange} from '../dist/src/google-tree.js';
import {assertGoogleListingGroups} from '../dist/src/google-listing-groups.js';
import {assertGoogleShoppingTree, shoppingTree} from '../dist/src/google-shopping-tree.js';
import {Introspection} from '../dist/src/introspection.js';
import {
  account,
  actor,
  admin,
  at,
  google,
  shoppingCustomer,
  shoppingResponder,
  treeEdit,
} from './fixtures/google-shopping-build.mjs';

const copy = 'AMCP_COPY_LISTING_GROUPS',
  match = 'AMCP_MATCH_LISTING_GROUPS',
  shoppingRoute = 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
  pmaxRoute = 'google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters';
/** SKU-00001 ... : the item ids of a synthetic feed. */
const ids = (n, from = 1) => Array.from({length: n}, (_, i) => 'SKU-' + String(from + i).padStart(5, '0'));
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const size = value => JSON.stringify(value).length;
const group = id => at('adGroups', id);
/** Existing PAUSED Standard Shopping ad groups of one PAUSED Shopping campaign with a Merchant Center account (Manual CPC). */
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
/**
 * A node of the tree of ad group `g`, as Google lists it. Its criterion ID is `base + id`, above the IDs the synthetic Google gives the nodes it
 * creates (it counts from 100), so that a node created is never one that existed.
 */
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
const flatTree = (g, items, bid = '500000') => [
  node(g, 1, 'SUBDIVISION'),
  ...items.map((sku, i) => node(g, 2 + i, 'UNIT', 1, {product_item_id: {value: sku}}, {cpc_bid_micros: bid})),
  node(g, 2 + items.length, 'UNIT', 1, {product_item_id: {}}, {negative: true}),
];
/** The root of a fresh ad group: the single unit "All products". */
const allProducts = g => [node(g, 1, 'UNIT', undefined, undefined, {cpc_bid_micros: '800000'})];

/** A build prepared the way a caller sends it. */
const build = (x, action, payload, input = {}, extra = {}) =>
  x.call('amcp_write', {
    action: 'prepare',
    gateway: google,
    ...input,
    arguments: {action, account_id: account, payload, ...extra},
  });
const treeReads = (x, g) =>
  x.queries.filter(q => / FROM ad_group_criterion WHERE /.test(q) && q.includes('adGroups/' + g + "'"));

test('the two build actions are catalogued beside the Data Manager ones: known to the registry, owned by the listing group family in the ledger, described, and not listed (tools/list stays as it is)', () => {
  const registry = new Registry();
  const rows = actionContracts(registry);
  for (const name of [copy, match]) {
    const a = registry.action(google, name);
    assert.ok(a, name + ' is a catalog action');
    assert.equal(a.method, 'POST');
    assert.equal(a.read_only, false);
    const row = rows.find(r => r.gateway === google && r.action === name);
    assert.equal(row?.status, 'reviewed_write_family', name);
    assert.equal(row.family, 'google_listing_groups');
    assert.ok(row.tests.includes('tests/google-listing-group-build.test.mjs'), 'the family lists this test');
    // Hidden like the Data Manager actions: the captured catalog's listing does not hold them, so LIST_ACTIONS and tools/list are as before.
    assert.ok(!registry.catalogs.get(google).actions.some(x => x.name === name), name + ' is not listed');
    // A person can still read what one is: DESCRIBE_ACTION answers for it.
    const described = new Introspection(registry).describe(google, {target_action: name});
    assert.equal(JSON.stringify(described).includes(name), true, name + ' is described');
  }
  assert.equal(new Set(rows.map(r => [r.gateway, r.operation ?? '', r.action].join('/'))).size, rows.length);
});

test('inspect of a build action sends nothing and says what prepare will read; no request body is echoed', async t => {
  const x = shoppingCustomer(adGroups('55'));
  t.after(() => x.store.close());
  const r = await x.call('amcp_write', {
    action: 'inspect',
    gateway: google,
    arguments: {
      action: match,
      account_id: account,
      payload: {targets: [{ad_group_id: '55'}], list: {item_ids: ids(3)}},
    },
  });
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 600));
  assert.equal(r.data.executed, false);
  assert.equal(r.data.network_requests, 0);
  assert.equal(r.data.review_contract_supported, true);
  assert.equal(x.queries.length + x.mutates.length, 0);
});

test('a build is a write with a review’s authority: a login that may only read the account, lacks the adwords scope or is off is refused before any tree is read, for an ad group and for an asset group', async t => {
  const x = shoppingCustomer({...adGroups('55'), criteria: allProducts('55')});
  t.after(() => x.store.close());
  const login = overrides =>
    x.store.putConnection(
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
        ...overrides,
      },
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
  for (const [overrides, code] of [
    [{writeAccounts: []}, 'WRITE_ACCOUNT_FORBIDDEN'],
    [{scopes: []}, 'INSUFFICIENT_SCOPE'],
    [{enabled: false}, 'CONNECTION_REQUIRED'],
  ])
    for (const [action, payload] of [
      [match, {targets: [{ad_group_id: '55'}], list: {item_ids: ids(3)}}],
      [match, {targets: [{asset_group_id: '9'}], list: {item_ids: ids(3)}}],
      [copy, {source: {ad_group_id: '55'}, targets: [{ad_group_id: '56'}]}],
    ]) {
      login(overrides);
      assertRefused(await build(x, action, payload), code, {writes: x.mutates.length});
      assert.equal(x.queries.length, 0, code + ': nothing was read');
    }
  // With the login restored the same build is prepared: the refusals above were the login’s.
  login({});
  const prepared = await build(x, match, {
    targets: [{ad_group_id: '55'}],
    list: {item_ids: ids(3)},
    cpc_bid_micros: '500000',
  });
  assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 400));
});

test('a built part may pass the 500 operations of a hand-sent review only with the server’s mark, bound to its operations (Q28, the owner 2026-11-27: "Yes, 10,000 for built trees")', () => {
  assert.deepEqual([chainLimits.tree, chainLimits.treeBuild], [500, 10000]);
  const operations = [
    {create: {resourceName: at('adGroupCriteria', '55~-1'), adGroup: group('55'), listingGroup: {type: 'SUBDIVISION'}}},
    ...Array.from({length: 600}, (_, i) => ({
      create: {
        adGroup: group('55'),
        negative: i === 599,
        cpcBidMicros: i === 599 ? undefined : '100000',
        listingGroup: {
          type: 'UNIT',
          parentAdGroupCriterion: at('adGroupCriteria', '55~-1'),
          caseValue: {productItemId: i === 599 ? {} : {value: 'sku-' + i}},
        },
      },
    })),
  ];
  const plan = {
    gateway: google,
    action: shoppingRoute,
    method: 'POST',
    path: '/v25/customers/123/adGroupCriteria:mutate',
    query: {},
    headers: {},
    body: {operations},
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    accountId: account,
    evidence: '',
    warnings: [],
  };
  // Hand-sent: 601 operations are over the review's 500, as before.
  assert.throws(
    () => assertGoogleShoppingTree(plan),
    e => e.code === 'TEMP_ID_CHAIN_TOO_LONG' && e.details.limit === 500,
  );
  // A mark that does not match the operations is refused, and names why.
  for (const mark of [
    {operations: 601, operations_sha256: sha('x'), by: copy},
    {operations: 5, operations_sha256: sha('x'), by: copy},
  ])
    assert.throws(
      () => assertGoogleShoppingTree({...plan, treeBuild: mark}),
      e =>
        e.code === 'INVALID_SHOPPING_LISTING_GROUP' &&
        e.details.mark === 'treeBuild' &&
        /mark of these operations/.test(e.message),
    );
});

test('a caller cannot send the mark: a hand-sent tree review with treeBuild is refused, and one over 500 operations stays refused', async t => {
  const x = shoppingCustomer(adGroups('55'));
  t.after(() => x.store.close());
  const refused = await x.prepareEdit(treeEdit({adGroup: '55'}), {treeBuild: {operations: 5, by: copy}});
  assertRefused(refused, 'UNSUPPORTED_PARAMETER', {writes: x.mutates.length});
  assert.equal(refused.error.details.parameter, 'treeBuild');
  const nodes = [{type: 'SUBDIVISION', name: at('adGroupCriteria', '55~-1')}];
  for (let i = 0; i < 500; i++)
    nodes.push({
      type: 'UNIT',
      name: at('adGroupCriteria', '55~-' + (2 + i)),
      parent: nodes[0].name,
      caseValue: {product_item_id: {value: 'sku-' + i}},
      bid: '100000',
    });
  nodes.push({
    type: 'UNIT',
    name: at('adGroupCriteria', '55~-600'),
    parent: nodes[0].name,
    caseValue: {product_item_id: {}},
    negative: true,
  });
  assertRefused(await x.prepareEdit(treeEdit({adGroup: '55', nodes})), 'TEMP_ID_CHAIN_TOO_LONG', {
    writes: x.mutates.length,
  });
});

test('3,047 item ids matched onto an ad group that has an "All products" root: one group of one part, one mutate of 3,050 operations, a digest of a few kilobytes, verified; a repeat changes nothing', async t => {
  const x = shoppingCustomer({...adGroups('55'), criteria: allProducts('55'), policy: {providerCheckByDefault: true}});
  t.after(() => x.store.close());
  const list = ids(3047);
  const p = await build(x, match, {targets: [{ad_group_id: '55'}], list: {item_ids: list}, cpc_bid_micros: '500000'});
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 900));
  assert.equal(p.data.group, true);
  assert.equal(p.data.parts.length, 1);
  const [part] = p.data.parts;
  assert.deepEqual(part.target, {ad_group_id: '55'});
  const c = part.tree_change;
  assert.deepEqual([c.operations, c.create, c.remove, c.keep], [3050, 3049, 1, 0]);
  assert.deepEqual([c.subdivisions, c.included, c.excluded], [1, 3047, 1]);
  assert.deepEqual(c.nodes, {before: 1, after: 3049});
  assert.ok(c.added.length >= 1 && c.added.length <= 5 && c.removed.length === 1, JSON.stringify([c.added, c.removed]));
  assert.match(c.tree_sha256, /^[0-9a-f]{64}$/);
  assert.match(c.operations_sha256, /^[0-9a-f]{64}$/);
  assert.equal(p.data.records, 3050);
  // The list: its rows, its set and both hashes (the text as received, and the sorted ids).
  const b = p.data.build;
  assert.equal(b.action, match);
  assert.deepEqual([b.list.rows, b.list.unique, b.list.duplicates], [3047, 3047, 0]);
  assert.equal(
    b.list.ids_sha256,
    sha(
      [...list]
        .map(s => s.toLowerCase())
        .sort()
        .join('\n'),
    ),
  );
  assert.match(b.list.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual([b.targets, b.operations, b.created, b.removed, b.kept], [1, 3050, 3049, 1, 0]);
  assert.match(b.summary, /3,047/);
  // No request, no state, no tree of 3,049 lines: a digest the person approves.
  assert.equal(p.data.request, undefined);
  assert.equal(p.data.before_state, undefined);
  assert.equal(part.request, undefined);
  assert.ok(size(p) < 16 * 1024, 'the answer is ' + size(p) + ' bytes');
  // Spend: a tree change asks for the confirmation, whatever it holds.
  assert.equal(p.data.execute_requirements.spend_change_confirmed, true);
  // The execute the person approves is offered, as a review's prepare offers its own: the acknowledgements are added after the approval, never pre-filled.
  assert.deepEqual(p.data.next_call, {
    tool: 'amcp_write',
    arguments: {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key},
    add_after_user_approval: {confirmed: true, spend_change_confirmed: true},
  });
  // The default validate-only request ran once, with the same operations, and applied nothing.
  assert.equal(x.mutates.length, 0);
  assert.equal(x.validations.length, 1);
  assert.equal(x.validations[0].body.operations.length, 3050);
  assertRefused(await x.execute(p, {spend_change_confirmed: false}), 'SPEND_CONFIRMATION_REQUIRED', {
    writes: x.mutates.length,
  });
  const e = await x.execute(p);
  assert.equal(e.success, true, JSON.stringify(e).slice(0, 900));
  assert.equal(x.mutates.length, 1, 'one mutate request for the one tree');
  assert.equal(x.mutates[0].body.operations.length, 3050);
  assert.equal(x.nodes.size, 3049);
  assert.ok(size(e) < 16 * 1024, 'the receipt is ' + size(e) + ' bytes');
  const v = await x.verify(p);
  assert.equal(v.data.status, 'verified', JSON.stringify(v.data).slice(0, 900));
  assert.equal((await x.execute(p)).data.replayed, true);
  assert.equal(x.mutates.length, 1);
  // What the review keeps stays a digest too: no audit row, no receipt and no status holds the 3,050 operations or the 3,049 lines of the tree.
  const largest = x.store.db.prepare('SELECT max(length(event)) AS n FROM audit').get().n;
  assert.ok(largest < 64 * 1024, 'the largest audit row is ' + largest + ' bytes');
  const kept = x.store.db.prepare('SELECT max(length(result)) AS n FROM idempotency').get().n;
  assert.ok(kept < 64 * 1024, 'the largest receipt is ' + kept + ' bytes');
  const status = await x.call('amcp_write', {action: 'status', review_id: p.data.parts[0].review_id});
  assert.equal(status.success, true, JSON.stringify(status).slice(0, 400));
  assert.ok(size(status) < 32 * 1024, 'the status of a part is ' + size(status) + ' bytes');
  // The same list again: the ad group already has this tree, so nothing is prepared (idempotent by the diff).
  const again = await build(x, match, {
    targets: [{ad_group_id: '55'}],
    list: {item_ids: list},
    cpc_bid_micros: '500000',
  });
  assert.equal(again.success, true, JSON.stringify(again).slice(0, 600));
  assert.equal(again.data.no_change, true);
  assert.equal(again.data.group, undefined);
  assert.equal(again.data.executed, false);
  assert.equal(x.mutates.length, 1);
});

test('the same list against a tree of 3,000 ids that shares 2,990 of them is 67 operations, with the diff counted and sampled; the duplicates and the case of an id are the list’s, not the tree’s', async t => {
  const current = ids(3000),
    wanted = [...current.slice(10), ...Array.from({length: 57}, (_, i) => 'NEW-' + i)];
  assert.equal(wanted.length, 3047);
  const x = shoppingCustomer({...adGroups('55'), criteria: flatTree('55', current)});
  t.after(() => x.store.close());
  // Two spellings of one id and a blank line are the list's: unique counts the set, duplicates the repeats.
  const csv = 'item_id\n' + wanted.join('\n') + '\n' + wanted[0].toLowerCase() + '\n\n';
  const p = await build(x, match, {targets: [{ad_group_id: '55'}], list: {csv}, cpc_bid_micros: '500000'});
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 900));
  const c = p.data.parts[0].tree_change;
  assert.deepEqual([c.operations, c.create, c.remove, c.keep], [67, 57, 10, 2992]);
  assert.deepEqual(c.nodes, {before: 3002, after: 3049});
  assert.deepEqual(
    c.removed,
    ids(5).map(s => 'root > productItemId=' + s.toLowerCase() + ' [UNIT bid=500000]'),
  );
  assert.deepEqual([p.data.build.list.rows, p.data.build.list.unique, p.data.build.list.duplicates], [3048, 3047, 1]);
  assert.equal(p.data.build.list.sha256, sha(csv), 'the SHA-256 of the text as received');
  assert.ok(size(p) < 16 * 1024);
  const e = await x.execute(p);
  assert.equal(e.success, true, JSON.stringify(e).slice(0, 600));
  assert.equal(x.mutates[0].body.operations.length, 67);
  assert.equal(x.nodes.size, 3049);
  assert.equal((await x.verify(p)).data.status, 'verified');
});

test('a tree of 3,047 units is copied to 10 ad groups as one group of 10 parts: the source is read once, each part is one mutate, the answer and the receipt are digests, and the group verifies', async t => {
  const source = flatTree('60', ids(3047)),
    targets = ['61', '62', '63', '64', '65', '66', '67', '68', '69', '70'];
  const x = shoppingCustomer({...adGroups('60', ...targets), criteria: source});
  t.after(() => x.store.close());
  const p = await build(x, copy, {source: {ad_group_id: '60'}, targets: targets.map(ad_group_id => ({ad_group_id}))});
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 900));
  assert.equal(p.data.group, true);
  assert.equal(p.data.parts.length, 10);
  assert.equal(new Set(p.data.parts.map(q => q.review_id)).size, 10);
  assert.deepEqual(
    p.data.parts.map(q => q.target.ad_group_id),
    targets,
  );
  for (const q of p.data.parts) {
    assert.deepEqual([q.tree_change.create, q.tree_change.remove, q.tree_change.operations], [3049, 0, 3049]);
    assert.equal(q.request, undefined);
  }
  assert.equal(p.data.records, 30490);
  assert.deepEqual([p.data.build.kind, p.data.build.targets, p.data.build.created], ['ad_group', 10, 30490]);
  assert.deepEqual(p.data.build.source, {ad_group_id: '60', nodes: 3049});
  assert.equal(treeReads(x, '60').length, 1, 'the source tree is read once');
  assert.ok(size(p) < 32 * 1024, 'the answer is ' + size(p) + ' bytes');
  assert.equal(p.data.execute_requirements.spend_change_confirmed, true);
  assert.equal(x.mutates.length, 0);
  const e = await x.execute(p);
  assert.equal(e.success, true, JSON.stringify(e).slice(0, 900));
  assert.equal(x.mutates.length, 10);
  assert.ok(x.mutates.every(m => m.body.operations.length === 3049));
  assert.equal(x.nodes.size, 3049 * 11);
  assert.ok(size(e) < 32 * 1024, 'the receipt is ' + size(e) + ' bytes');
  const v = await x.verify(p);
  assert.equal(v.data.status, 'verified', JSON.stringify(v.data).slice(0, 900));
  // Each target now holds the source's shape: a second copy is a no-op for every one of them.
  const again = await build(x, copy, {
    source: {ad_group_id: '60'},
    targets: targets.map(ad_group_id => ({ad_group_id})),
  });
  assert.equal(again.data.no_change, true);
  assert.equal(x.mutates.length, 10);
});

test('a group of trees stops at the first part Google refuses: the earlier parts stand, the later ones are not sent, and preparing again leaves only what is missing', async t => {
  const targets = ['61', '62', '63', '64', '65'];
  const responder = shoppingResponder({...adGroups('60', ...targets), criteria: flatTree('60', ids(120))});
  // Google refuses the fourth tree (ad group 64) outright, and nothing of it is applied.
  const fetch = async (url, init) => {
    const refuse =
      !String(init?.body).includes('validate_only') &&
      new URL(String(url)).pathname.endsWith('adGroupCriteria:mutate') &&
      String(init?.body).includes('adGroups/64');
    return refuse
      ? Response.json(
          {error: {code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.'}},
          {status: 400},
        )
      : responder.fetch(url, init);
  };
  const x = customer(fetch);
  t.after(() => x.store.close());
  const spec = {source: {ad_group_id: '60'}, targets: targets.map(ad_group_id => ({ad_group_id}))};
  const p = await build(x, copy, spec);
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 600));
  assert.equal(p.data.parts.length, 5);
  const e = await x.execute(p);
  assert.equal(e.success, false, JSON.stringify(e).slice(0, 600));
  assert.match(String(e.error.code), /^(WRITE_PARTIAL_OR_FAILED|WRITE_OUTCOME_UNCERTAIN|PROVIDER_REJECTED|[A-Z_]+)$/);
  assert.equal(e.error.details.failed_part, p.data.parts[3].review_id);
  assert.deepEqual(e.error.details.not_sent, [p.data.parts[4].review_id]);
  assert.equal(responder.nodes.size, 122 + 3 * 122, 'parts 1 to 3 were applied; 64 and 65 were not');
  // Preparing again: the targets that have the tree are skipped, the two that do not are the group.
  const second = await build(x, copy, spec);
  assert.equal(second.success, true, JSON.stringify(second).slice(0, 600));
  assert.deepEqual(
    second.data.parts.map(q => q.target.ad_group_id),
    ['64', '65'],
  );
  assert.deepEqual(
    second.data.build.skipped.map(s => s.target.ad_group_id),
    ['61', '62', '63'],
  );
});

test('a target emptied after a copy that completed carries the duplicate warning when the same copy is prepared again within ten minutes, and it still executes: the person may want two', async t => {
  const x = shoppingCustomer({...adGroups('60', '61'), criteria: flatTree('60', ids(40))});
  t.after(() => x.store.close());
  const spec = {source: {ad_group_id: '60'}, targets: [{ad_group_id: '61'}]};
  const first = await build(x, copy, spec);
  assert.equal(first.data.duplicate_warning, undefined);
  assert.equal((await x.execute(first)).success, true);
  for (const [name, n] of [...x.nodes]) if (n.ad_group === group('61')) x.nodes.delete(name);
  const second = await build(x, copy, spec);
  assert.equal(second.success, true, JSON.stringify(second).slice(0, 600));
  assert.ok(second.data.duplicate_warning, 'the repeat of a create that completed is warned');
  assert.deepEqual(
    second.data.duplicate_warning.parts.map(w => w.part),
    [1],
  );
  assert.equal((await x.execute(second)).success, true);
  assert.equal(x.nodes.size, 42 * 2);
});

test('an uncertain part fails closed: a repeat of its creates is refused, and once a reconciliation finds it not applied, supersedes_review_id replaces it for its target only', async t => {
  // A reconciliation waits a minute after the claim before it reads Google; the test does not wait.
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  const x = shoppingCustomer({...adGroups('60', '61', '62'), criteria: flatTree('60', ids(8))});
  t.after(() => {
    delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
    x.store.close();
  });
  const spec = {source: {ad_group_id: '60'}, targets: [{ad_group_id: '61'}, {ad_group_id: '62'}]};
  const first = await build(x, copy, spec);
  assert.equal(first.success, true, JSON.stringify(first).slice(0, 600));
  // Google's answer to the first part is lost and nothing was applied: the outcome is not known, so the group stops and sends nothing more.
  x.mode.lose = true;
  x.mode.applied = false;
  const lost = await x.execute(first);
  assert.equal(lost.success, false);
  assert.equal(lost.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(lost.error).slice(0, 400));
  assert.equal(x.nodes.size, 10, 'nothing was applied, and the second part was not sent');
  x.mode.lose = false;
  x.mode.applied = true;
  const uncertain = first.data.parts[0].review_id;
  // Fail closed: the same copy is not prepared again while a create of it may have been made.
  assertRefused(await build(x, copy, spec), 'DUPLICATE_OF_UNCERTAIN_WRITE', {writes: x.mutates.length - 1});
  // A reviewer reads Google: the tree is not there, so the write is found not applied and may be replaced.
  const reconciled = await x.call('amcp_write', {action: 'reconcile', review_id: uncertain});
  assert.equal(reconciled.success, true, JSON.stringify(reconciled).slice(0, 600));
  assert.match(JSON.stringify(reconciled.data.classification ?? reconciled.data), /not_applied/);
  // A review that was no part of a build for these targets is no replacement.
  assertRefused(await build(x, copy, spec, {supersedes_review_id: 'no-such-review'}), 'INVALID_ARGUMENT');
  const second = await build(x, copy, spec, {supersedes_review_id: uncertain});
  assert.equal(second.success, true, JSON.stringify(second).slice(0, 900));
  assert.deepEqual(
    second.data.parts.map(p => p.target.ad_group_id),
    ['61', '62'],
  );
  const done = await x.execute(second);
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 600));
  assert.equal(x.nodes.size, 10 + 10 + 10);
});

test('a spec that is wrong is refused before anything is read: no target, too many, mixed kinds, the source as a target, a bad list', async t => {
  const x = shoppingCustomer(adGroups('55', '56'));
  t.after(() => x.store.close());
  const refused = async (action, payload, field, extra = {}) => {
    const r = await build(x, action, payload);
    assertRefused(r, 'INVALID_ARGUMENT', {writes: x.mutates.length});
    assert.equal(r.error.details.field, field, JSON.stringify(r.error.details));
    for (const [k, v] of Object.entries(extra)) assert.deepEqual(r.error.details[k], v, k);
    assert.equal(x.queries.length, 0, 'nothing was read');
  };
  await refused(match, {list: {item_ids: ids(2)}}, 'payload.targets');
  await refused(match, {targets: [], list: {item_ids: ids(2)}}, 'payload.targets');
  await refused(
    match,
    {targets: Array.from({length: 41}, (_, i) => ({ad_group_id: String(100 + i)})), list: {item_ids: ids(2)}},
    'payload.targets',
    {limit: 40},
  );
  await refused(
    match,
    {targets: [{ad_group_id: '55'}, {asset_group_id: '9'}], list: {item_ids: ids(2)}},
    'payload.targets',
  );
  await refused(
    match,
    {targets: [{ad_group_id: '55'}, {ad_group_id: '55'}], list: {item_ids: ids(2)}},
    'payload.targets',
  );
  await refused(copy, {source: {ad_group_id: '55'}, targets: [{ad_group_id: '55'}]}, 'payload.targets');
  await refused(copy, {targets: [{ad_group_id: '55'}]}, 'payload.source');
  await refused(copy, {source: {asset_group_id: '9'}, targets: [{ad_group_id: '55'}]}, 'payload.targets');
  await refused(match, {targets: [{ad_group_id: '55'}]}, 'payload.list');
  await refused(match, {targets: [{ad_group_id: '55'}], list: {item_ids: []}}, 'payload.list');
  await refused(match, {targets: [{ad_group_id: '55'}], list: {item_ids: ['ok', '  ']}}, 'payload.list');
  await refused(match, {targets: [{ad_group_id: '55'}], list: {item_ids: ['x'.repeat(101)]}}, 'payload.list');
  await refused(match, {targets: [{ad_group_id: '55'}], list: {item_ids: ids(4999)}}, 'payload.list', {limit: 4998});
  await refused(match, {targets: [{ad_group_id: '55'}], list: {item_ids: ids(2), csv: 'a\nb'}}, 'payload.list');
  await refused(
    match,
    {targets: [{ad_group_id: '55'}], list: {item_ids: ids(2)}, cpc_bid_micros: '1.5'},
    'payload.cpc_bid_micros',
  );
});

test('the gates of a tree review stay: a removal under a no-deletion policy, a serving ad group under a no-activation policy, a bid over the cap, and an ad group that is not a Shopping ad group are each refused, and nothing is sent', async t => {
  const x = shoppingCustomer({...adGroups('55', '56'), criteria: flatTree('55', ids(5))});
  t.after(() => x.store.close());
  const policy = p =>
    saveSpendPolicy(x.store, admin, {gateway: google, account_id: account, confirmed: true, policy: p});
  const spec = {targets: [{ad_group_id: '55'}], list: {item_ids: ids(5, 3)}, cpc_bid_micros: '500000'};
  policy({enforcement: 'block', allow_deletion: false, allow_activation: true});
  assertRefused(await build(x, match, spec), 'POLICY_DELETION_FORBIDDEN', {writes: x.mutates.length});
  // A list that only adds is no deletion.
  const adds = await build(x, match, {...spec, list: {item_ids: [...ids(5), 'EXTRA-1']}});
  assert.equal(adds.success, true, JSON.stringify(adds).slice(0, 600));
  policy({enforcement: 'block', allow_deletion: true, allow_activation: true, max_bid_native: 400000});
  assertRefused(await build(x, match, {...spec, list: {item_ids: ids(3, 20)}}), 'POLICY_BID_LIMIT', {
    writes: x.mutates.length,
  });
  // Under the cap and with no deletion left to refuse, the review is prepared; the confirmation is still asked at execute.
  const ok = await build(x, match, {
    targets: [{ad_group_id: '56'}],
    list: {item_ids: ids(3)},
    cpc_bid_micros: '300000',
  });
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 600));
  assert.equal(ok.data.execute_requirements.spend_change_confirmed, true);
  // A serving ad group is an activation: ENABLED ad group of an ENABLED campaign under allow_activation false.
  const live = shoppingCustomer({
    adGroups: {[group('77')]: {status: 'ENABLED', type: 'SHOPPING_PRODUCT_ADS', campaign: at('campaigns', '41')}},
    campaigns: {
      [at('campaigns', '41')]: {
        status: 'ENABLED',
        advertisingChannelType: 'SHOPPING',
        shoppingSetting: {merchantId: '555'},
        biddingStrategyType: 'MANUAL_CPC',
      },
    },
    criteria: allProducts('77'),
  });
  t.after(() => live.store.close());
  saveSpendPolicy(live.store, admin, {
    gateway: google,
    account_id: account,
    confirmed: true,
    policy: {enforcement: 'block', allow_deletion: true, allow_activation: false},
  });
  assertRefused(
    await build(live, match, {targets: [{ad_group_id: '77'}], list: {item_ids: ids(3)}, cpc_bid_micros: '300000'}),
    'POLICY_ACTIVATION_FORBIDDEN',
    {writes: live.mutates.length},
  );
  // An ad group of another type has no product tree.
  const other = shoppingCustomer({
    adGroups: {[group('88')]: {status: 'PAUSED', type: 'SEARCH_STANDARD', campaign: at('campaigns', '40')}},
    campaigns: adGroups().campaigns,
  });
  t.after(() => other.store.close());
  assertRefused(
    await build(other, match, {targets: [{ad_group_id: '88'}], list: {item_ids: ids(3)}, cpc_bid_micros: '300000'}),
    'INVALID_SHOPPING_LISTING_GROUP',
    {writes: other.mutates.length},
  );
});

test('a bid cap that every one of 3,047 units breaches is one line of the answer, not 3,047: the rows are counted and the first few shown', async t => {
  const x = shoppingCustomer({...adGroups('55'), criteria: allProducts('55')});
  t.after(() => x.store.close());
  saveSpendPolicy(x.store, admin, {
    gateway: google,
    account_id: account,
    confirmed: true,
    policy: {enforcement: 'confirm', allow_deletion: true, allow_activation: true, max_bid_native: 100000},
  });
  const p = await build(x, match, {
    targets: [{ad_group_id: '55'}],
    list: {item_ids: ids(3047)},
    cpc_bid_micros: '500000',
  });
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 600));
  assert.equal(p.data.execute_requirements.cap_override_confirmed, true);
  assert.ok(size(p) < 32 * 1024, 'the answer is ' + size(p) + ' bytes');
  assert.equal(p.data.spend_policy.exceeded_count, 3047);
  assert.ok(p.data.spend_policy.exceeded.length <= 5);
});

test('the combined mutate names the action that takes an edit: a remove or an update in a build is refused as before, now with the route and the kind (and still no rule)', async t => {
  const x = shoppingCustomer({...adGroups('55'), criteria: flatTree('55', ids(3))});
  t.after(() => x.store.close());
  const refusedAt = async (operations, kind, route) => {
    const r = await x.prepare(operations);
    assertRefused(r, 'INVALID_GOOGLE_BUILD', {writes: x.mutates.length});
    const d = r.error.details;
    assert.deepEqual([d.kind, d.route, d.operation], [kind, route, operations.length - 1], JSON.stringify(d));
    assert.equal(d.rule, undefined, 'a refusal of one operation of a build has no rule, as before');
    assert.match(r.error.message, new RegExp(route));
    assert.match(d.field, /^mutate_operations\[\d+\]\.[a-z_]+$/);
  };
  // A keyword the build may create under an ad group that exists, and the removal of the one it replaces: the mix the owner sent four times.
  const create = {
    ad_group_criterion_operation: {create: {ad_group: group('55'), keyword: {text: 'acme', match_type: 'EXACT'}}},
  };
  await refusedAt(
    [create, {ad_group_criterion_operation: {remove: at('adGroupCriteria', '55~3')}}],
    'remove',
    shoppingRoute,
  );
  await refusedAt(
    [
      {
        ad_group_criterion_operation: {
          update: {resource_name: at('adGroupCriteria', '55~3'), cpc_bid_micros: '1'},
          update_mask: 'cpc_bid_micros',
        },
      },
    ],
    'update',
    shoppingRoute,
  );
  await refusedAt(
    [{asset_group_listing_group_filter_operation: {remove: at('assetGroupListingGroupFilters', '9~3')}}],
    'remove',
    pmaxRoute,
  );
  await refusedAt(
    [{campaign_operation: {remove: at('campaigns', '40')}}],
    'remove',
    'google_ads_v23_campaign_mutate_campaigns',
  );
  // What a build refused before it still refuses: a partial failure, and a validation-only request (which names provider_check).
  const sent = payload =>
    x.call('amcp_write', {
      action: 'prepare',
      gateway: google,
      arguments: {
        action: 'google_ads_v23_google_ads_mutate',
        account_id: account,
        payload: {mutate_operations: [create], ...payload},
      },
    });
  assertRefused(await sent({partial_failure: true}), 'INVALID_GOOGLE_BUILD', {writes: x.mutates.length});
  const only = await sent({validate_only: true});
  assertRefused(only, 'INVALID_GOOGLE_BUILD', {writes: x.mutates.length, message: /provider_check/});
  assert.equal(only.error.details.instead, 'provider_check');
});

test('the tree review takes the same mix in one request: 12 removals and 40 creations are one review, one mutate', async t => {
  const x = shoppingCustomer({...adGroups('55'), criteria: flatTree('55', ids(30))});
  t.after(() => x.store.close());
  const removes = flatTree('55', ids(30))
    .slice(2, 14)
    .map(n => n.resource_name);
  const unit = i => ({
    create: {
      adGroup: group('55'),
      cpcBidMicros: '500000',
      listingGroup: {
        type: 'UNIT',
        parentAdGroupCriterion: at('adGroupCriteria', '55~' + (base + 1)),
        caseValue: {productItemId: {value: 'MIX-' + i}},
      },
    },
  });
  const edit = {operations: [...removes.map(remove => ({remove})), ...Array.from({length: 40}, (_, i) => unit(i))]};
  const p = await x.prepareEdit(edit);
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 900));
  const e = await x.execute(p);
  assert.equal(e.success, true, JSON.stringify(e).slice(0, 600));
  assert.equal(x.mutates.length, 1);
  assert.equal(x.mutates[0].body.operations.length, 52);
  assert.equal(x.nodes.size, 32 - 12 + 40);
});

test('validateOnly on a listing group review is refused with one sentence that names provider_check, in both families and in the combined mutate, and provider_check: true validates a 3,050-operation part without applying it', async t => {
  const plan = (path, body) => ({
    gateway: google,
    action: path.includes('assetGroup') ? pmaxRoute : shoppingRoute,
    method: 'POST',
    path,
    query: {},
    headers: {},
    body,
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    accountId: account,
    evidence: '',
    warnings: [],
  });
  const create = {assetGroup: at('assetGroups', '9'), type: 'UNIT_INCLUDED', listingSource: 'SHOPPING'};
  for (const [call, code] of [
    [
      () =>
        assertGoogleListingGroups(
          plan('/v25/customers/123/assetGroupListingGroupFilters:mutate', {operations: [{create}], validateOnly: true}),
        ),
      'INVALID_LISTING_GROUP',
    ],
    [
      () =>
        assertGoogleShoppingTree(
          plan('/v25/customers/123/adGroupCriteria:mutate', {
            operations: [{create: {adGroup: group('55'), listingGroup: {type: 'UNIT'}}}],
            validateOnly: true,
          }),
        ),
      'INVALID_SHOPPING_LISTING_GROUP',
    ],
  ])
    assert.throws(
      call,
      e =>
        e.code === code &&
        e.details.instead === 'provider_check' &&
        /provider_check/.test(e.message) &&
        e.details.field === 'validateOnly',
    );
  // provider_check: true asks Google to validate the whole part, once, with the same operations; it applies nothing.
  const x = shoppingCustomer({...adGroups('55'), criteria: allProducts('55')});
  t.after(() => x.store.close());
  const p = await build(
    x,
    match,
    {targets: [{ad_group_id: '55'}], list: {item_ids: ids(3047)}, cpc_bid_micros: '500000'},
    {provider_check: true},
  );
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 600));
  assert.equal(x.validations.length, 1);
  assert.equal(x.validations[0].body.operations.length, 3050);
  assert.equal(x.validations[0].body.validate_only, true);
  assert.equal(x.mutates.length, 0);
});

test('the shared conversion of a Google body keeps its answers while it is faster: snake_case to camelCase, the masks, a conflict refused, a key named __proto__ kept as data; a body is converted once for each body object', () => {
  const body = {
    operations: [
      {update: {resource_name: 'x', cpc_bid_micros: '5'}, update_mask: 'cpc_bid_micros,resource_name'},
      {
        create: {
          ad_group: 'g',
          listing_group: {parent_ad_group_criterion: 'p', case_value: {product_item_id: {value: 'a_b'}}},
        },
      },
    ],
  };
  const expected = {
    operations: [
      {update: {resourceName: 'x', cpcBidMicros: '5'}, updateMask: 'cpcBidMicros,resourceName'},
      {create: {adGroup: 'g', listingGroup: {parentAdGroupCriterion: 'p', caseValue: {productItemId: {value: 'a_b'}}}}},
    ],
  };
  assert.deepEqual(googleJson(body), expected);
  assert.deepEqual(googleJson(googleJson(body)), expected, 'camelCase stays as it is');
  assert.throws(
    () => googleJson({ad_group: 'a', adGroup: 'b'}),
    e => e.code === 'CONFLICTING_PARAMETER' && e.details.field === 'adGroup',
  );
  const hostile = googleJson(JSON.parse('{"__proto__": {"polluted": true}, "a_b": 2}'));
  assert.equal(Object.getPrototypeOf(hostile), Object.prototype);
  assert.equal(
    Object.hasOwn(hostile, '_Proto__'),
    true,
    'the conversion turns the _p of __proto__ into P, so it is data, not a prototype',
  );
  assert.equal(hostile.polluted, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(hostile.aB, 2);
  // Once for each body object, the same answer every time; a new body object is converted again.
  assert.equal(googleBody(body), googleBody(body));
  assert.deepEqual(googleBody(body), expected);
  assert.notEqual(googleBody(structuredClone(body)), googleBody(body));
  assert.equal(googleBody('text'), 'text');
});

test('what a tree edit changes is counted by shape, and a built tree lists its first lines and counts the rest', () => {
  const root = {name: 'root', type: 'SUBDIVISION'},
    unit = (name, value, extra = {}) => ({
      name,
      type: 'UNIT',
      parent: 'root',
      caseValue: {productBrand: value ? {value} : {}},
      ...extra,
    }),
    current = [root, unit('a', 'acme', {bid: '1'}), unit('o', undefined, {negative: true})],
    ops = [
      {remove: 'a'},
      ...Array.from({length: 30}, (_, i) => ({
        create: unit('n' + i, 'brand-' + String(i).padStart(2, '0'), {bid: '2'}),
        op: i,
      })),
    ];
  const change = treeChange(shoppingTree, current, ops);
  assert.deepEqual(
    [
      change.operations,
      change.create,
      change.remove,
      change.keep,
      change.subdivisions,
      change.included,
      change.excluded,
    ],
    [31, 30, 1, 2, 1, 30, 1],
  );
  assert.deepEqual(change.nodes, {before: 3, after: 32});
  assert.deepEqual(change.removed, ['root > productBrand=acme [UNIT bid=1]']);
  assert.equal(change.added.length, 5);
  assert.match(change.tree_sha256, /^[0-9a-f]{64}$/);
  const lines = Array.from({length: 40}, (_, i) => 'line ' + i);
  assert.deepEqual(listedShape({}, lines), {final_tree: lines}, 'a review of a hand-sent tree lists every line');
  const built = listedShape({treeBuild: {by: copy, operations: 1, operations_sha256: sha('x')}}, lines);
  assert.equal(built.final_tree.length, 25);
  assert.equal(built.final_tree_omitted, 15);
  assert.equal(built.final_tree_sha256, sha(lines.join('\n')));
  assert.deepEqual(listedShape({treeBuild: {}}, lines.slice(0, 25)), {final_tree: lines.slice(0, 25)});
});

// ---- Performance Max: the same actions on asset groups, with a synthetic Google of their own -------------------------------------
const asset = id => at('assetGroups', id);
const filter = (g, id) => at('assetGroupListingGroupFilters', g + '~' + id);
function pmaxGoogle({trees = {}} = {}) {
  const nodes = new Map(),
    mutates = [],
    validations = [];
  for (const [g, list] of Object.entries(trees))
    for (const n of list) nodes.set(n.resourceName, {...n, assetGroup: asset(g)});
  let next = 1000;
  const fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)),
      path = new URL(String(url)).pathname;
    if (path.endsWith('googleAds:search')) {
      const q = String(body.query),
        name = /'(customers\/[^']+)'/.exec(q)?.[1];
      if (/ FROM customer /.test(q + ' '))
        return Response.json({results: [{customer: {id: account, currencyCode: 'USD', timeZone: 'UTC'}}]});
      if (/ FROM asset_group_listing_group_filter /.test(q))
        return Response.json({
          results: [...nodes.values()].filter(n => n.assetGroup === name).map(n => ({assetGroupListingGroupFilter: n})),
        });
      if (/ FROM asset_group /.test(q))
        return Response.json({
          results: [
            {
              assetGroup: {resourceName: name, status: 'PAUSED', campaign: at('campaigns', '40')},
              campaign: {
                resourceName: at('campaigns', '40'),
                status: 'PAUSED',
                advertisingChannelType: 'PERFORMANCE_MAX',
                shoppingSetting: {merchantId: '555'},
              },
            },
          ],
        });
      return Response.json({results: []});
    }
    if (body.validateOnly === true || body.validate_only === true) {
      validations.push({path, body});
      return Response.json({});
    }
    mutates.push({path, body});
    const temp = new Map(),
      results = [];
    for (const op of body.operations) {
      if (op.remove) {
        assert.ok(![...nodes.values()].some(n => n.parentListingGroupFilter === op.remove), 'children first');
        nodes.delete(op.remove);
        results.push({resourceName: op.remove});
        continue;
      }
      const c = op.create,
        g = String(c.assetGroup).split('/').at(-1),
        name = filter(g, String(next++));
      if (c.resourceName) temp.set(c.resourceName, name);
      nodes.set(name, {
        resourceName: name,
        assetGroup: c.assetGroup,
        type: c.type,
        listingSource: c.listingSource ?? 'SHOPPING',
        ...(c.parentListingGroupFilter
          ? {parentListingGroupFilter: temp.get(c.parentListingGroupFilter) ?? c.parentListingGroupFilter}
          : {}),
        ...(c.caseValue ? {caseValue: c.caseValue} : {}),
      });
      results.push({resourceName: name});
    }
    return Response.json({results});
  };
  return {nodes, mutates, validations, fetch};
}
/** A synthetic customer for a fetcher: the service, its store and the calls a review takes. */
function customer(fetch, policy = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 79).toString('base64'));
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
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(fetch, undefined, undefined, undefined, 10000),
    undefined,
    {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
      ...policy,
    },
  );
  const call = (tool, input) => service.call(tool, input, actor);
  const execute = (review, extra = {}) =>
    call('amcp_write', {
      action: 'execute',
      review_id: review.data.review_id,
      confirmed: true,
      spend_change_confirmed: true,
      ...extra,
    });
  return {
    store,
    call,
    execute,
    verify: review => call('amcp_campaign', {action: 'verify', review_id: review.data.review_id}),
    queries: [],
    mutates: [],
    nodes: new Map(),
    validations: [],
  };
}
// The nodes of a Performance Max tree as Google lists them, with the retail listing source; the IDs are above the ones the synthetic Google gives.
const pmaxNode = (g, id, type, extra = {}) => ({
  resourceName: filter(g, base + id),
  type,
  listingSource: 'SHOPPING',
  ...extra,
});
const pmaxTree = (g, items) => [
  pmaxNode(g, 1, 'SUBDIVISION'),
  ...items.map((sku, i) =>
    pmaxNode(g, 2 + i, 'UNIT_INCLUDED', {
      parentListingGroupFilter: filter(g, base + 1),
      caseValue: {productItemId: {value: sku}},
    }),
  ),
  pmaxNode(g, 2 + items.length, 'UNIT_EXCLUDED', {
    parentListingGroupFilter: filter(g, base + 1),
    caseValue: {productItemId: {}},
  }),
];

test('Performance Max: 3,047 item ids matched onto an asset group, and its tree copied to another, are the same builds on asset groups: one mutate each, included units and an excluded "Other"', async t => {
  const world = pmaxGoogle({trees: {9: [pmaxNode('9', 1, 'UNIT_INCLUDED')], 10: pmaxTree('10', ids(47))}});
  const x = customer(world.fetch, {providerCheckByDefault: true});
  t.after(() => x.store.close());
  const p = await build(x, match, {targets: [{asset_group_id: '9'}], list: {item_ids: ids(3047)}});
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 900));
  assert.deepEqual(p.data.parts[0].target, {asset_group_id: '9'});
  const c = p.data.parts[0].tree_change;
  assert.deepEqual(
    [c.operations, c.create, c.remove, c.included, c.excluded, c.subdivisions],
    [3050, 3049, 1, 3047, 1, 1],
  );
  assert.ok(size(p) < 16 * 1024);
  const e = await x.execute(p);
  assert.equal(e.success, true, JSON.stringify(e).slice(0, 900));
  assert.equal(world.mutates.length, 1);
  assert.equal(world.mutates[0].body.operations.length, 3050);
  assert.equal([...world.nodes.values()].filter(n => n.assetGroup === asset('9')).length, 3049);
  assert.equal((await x.verify(p)).data.status, 'verified');
  // The tree of asset group 9 (3,049 nodes) copied onto asset group 10, which has 49 nodes of its own: the diff only.
  const q = await build(x, copy, {source: {asset_group_id: '9'}, targets: [{asset_group_id: '10'}]});
  assert.equal(q.success, true, JSON.stringify(q).slice(0, 900));
  const d = q.data.parts[0].tree_change;
  assert.equal(d.nodes.after, 3049);
  assert.equal(d.create, 3000);
  assert.equal(d.remove, 0);
  assert.equal((await x.execute(q)).success, true);
  assert.equal(world.mutates.length, 2);
  assert.equal([...world.nodes.values()].filter(n => n.assetGroup === asset('10')).length, 3049);
});
