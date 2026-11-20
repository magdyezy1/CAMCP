// R2.5 M3 (r25-m3-trees, G5 route B): the one-service review of a Standard Shopping tree. A mutation of ad group criteria that
// creates a listing group is a tree edit: it reads the ad group with its campaign and the whole tree, checks the tree the request
// leaves, needs the spend confirmation, counts a removal as a deletion and a serving ad group as an activation, and reads the tree
// back by shape. It is served by the registered family google_listing_groups as a second request shape (the family of the
// Performance Max trees; see src/google-listing-groups.ts for why). A synthetic Google answers; nothing reaches Google.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {assertRefused} from './helpers/assert-refused.mjs';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {familyOf} from '../dist/src/reviewed-families.js';
import {reviewedWriteFamily} from '../dist/src/reviewed-routes.js';
import {googleShoppingTreeFields, googleShoppingTreeParentFields} from '../dist/src/google-shopping-tree.js';
import {
  account,
  admin,
  at,
  existingAdGroup,
  existingNode,
  google,
  shoppingCustomer,
  shoppingTree,
  treeEdit,
} from './fixtures/google-shopping-build.mjs';

const plan = (body, path = '/v25/customers/123/adGroupCriteria:mutate') => ({
  gateway: google,
  action: 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
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
const brand = v => ({productBrand: v ? {value: v} : {}});
const node = id => at('adGroupCriteria', '55~' + id);
/** A tree of three nodes that exists: the root and two brand units, one of them the "Other" node. */
const existingTree = () => [
  existingNode(1, 'SUBDIVISION'),
  existingNode(2, 'UNIT', 1, {product_brand: {value: 'Acme'}}, {cpc_bid_micros: '1500000'}),
  existingNode(3, 'UNIT', 1, {product_brand: {}}, {cpc_bid_micros: '700000'}),
];
const treeReads = x => x.queries.filter(q => / FROM ad_group_criterion WHERE /.test(q));
/** A new brand unit under the root of the existing tree (replaces Acme when it comes after its removal). */
const swap = {
  create: {
    adGroup: at('adGroups', '55'),
    listingGroup: {type: 'UNIT', parentAdGroupCriterion: node(1), caseValue: brand('Gamma')},
  },
};

test('the family claims a mutation that creates a listing group, in either spelling; the targeting family keeps every other one', () => {
  const create = {adGroup: at('adGroups', '55'), listingGroup: {type: 'UNIT'}};
  assert.equal(familyOf(plan({operations: [{create}]}))?.name, 'google_listing_groups');
  assert.equal(
    familyOf(plan({operations: [{create: {ad_group: at('adGroups', '55'), listing_group: {type: 'UNIT'}}}]}))?.name,
    'google_listing_groups',
  );
  assert.equal(reviewedWriteFamily(plan(treeEdit())), 'google_listing_groups');
  // No double claim: a keyword create, a removal, a bid update, an empty body (the ledger's own) and another route stay as they were.
  const keyword = {create: {adGroup: at('adGroups', '55'), keyword: {text: 'acme', matchType: 'EXACT'}}};
  for (const body of [
    {operations: [keyword]},
    {operations: [{remove: node(901)}]},
    {operations: [{update: {resourceName: node(2), cpcBidMicros: '1'}, updateMask: 'cpc_bid_micros'}]},
    {},
    {operations: [{create: {...create, listingGroup: undefined}}]},
  ])
    assert.equal(familyOf(plan(body))?.name, 'google_targeting', JSON.stringify(body));
  // A keyword beside a listing group is the tree review's, so that its refusal says so.
  assert.equal(familyOf(plan({operations: [{create}, keyword]}))?.name, 'google_listing_groups');
  // The route of the Performance Max trees is unchanged.
  assert.equal(
    familyOf(plan({operations: []}, '/v25/customers/123/assetGroupListingGroupFilters:mutate'))?.name,
    'google_listing_groups',
  );
});

test('a five-node tree on an existing PAUSED ad group is one review, one mutate request, and is read back by its shape', async t => {
  const x = shoppingCustomer(existingAdGroup());
  t.after(() => x.store.close());
  const p = await x.prepareEdit(treeEdit());
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 1200));
  assert.equal(p.data.state_reads.length, 2, 'the ad group with its campaign, and its whole tree');
  const impact = p.data.creative_impact;
  assert.equal(impact.scope, 'shopping_listing_groups');
  assert.equal(impact.may_affect_serving, false);
  assert.deepEqual(impact.final_tree, [
    'root > productBrand=* [UNIT bid=700000]',
    'root > productBrand=acme [UNIT bid=1500000]',
    'root > productBrand=beta [UNIT bid=900000]',
    'root > productBrand=zeta [UNIT_EXCLUDED]',
    'root [SUBDIVISION]',
  ]);
  // The verification sentence names what the shape compares (R2.5 M3 round 3, N5). Package r25-m3-live (F2) changed this pin, which named "a
  // PAUSED status": a unit's status counts only when Google lists it other than ENABLED, and a subdivision's status and bid are not compared.
  assert.match(
    impact.verification,
    /\(dimension paths, node types, exclusions, the bid of each unit, and a unit Google lists with a status other than ENABLED\)/,
  );
  assert.match(impact.verification, /A subdivision’s status and bid are not compared/);
  assert.equal(p.data.execute_requirements.spend_change_confirmed, true, 'every tree change is a spending change');
  // The gate: without the confirmation nothing is sent.
  assertRefused(await x.execute(p, {spend_change_confirmed: false}), 'SPEND_CONFIRMATION_REQUIRED', {
    writes: x.mutates.length,
  });
  const e = await x.execute(p);
  assert.equal(e.success, true, JSON.stringify(e).slice(0, 1200));
  assert.equal(x.mutates.length, 1);
  assert.equal(x.mutates[0].body.operations.length, 5);
  assert.equal(x.nodes.size, 5);
  const before = x.queries.length;
  const v = await x.verify(p);
  assert.equal(v.data.status, 'verified', JSON.stringify(v.data).slice(0, 1500));
  assert.equal(v.data.checks.length, 1, 'one read of the tree');
  assert.equal(treeReads({queries: x.queries.slice(before)}).length >= 1, true);
  assert.equal((await x.execute(p)).data.replayed, true);
  assert.equal(x.mutates.length, 1);
});

test('a 120-operation tree named with ~-N stays one review and one mutate request: the chain is never cut into parts of 25 (R2.5 M3, G4c; Q28, owner 2026-11-15)', async t => {
  const x = shoppingCustomer(existingAdGroup());
  t.after(() => x.store.close());
  const name = n => at('adGroupCriteria', '55~-' + n),
    nodes = [{type: 'SUBDIVISION', name: name(1)}];
  for (let i = 0; i < 118; i++)
    nodes.push({type: 'UNIT', name: name(2 + i), parent: name(1), caseValue: brand('b' + i), bid: '100000'});
  nodes.push({type: 'UNIT', name: name(500), parent: name(1), caseValue: brand(), bid: '100000'});
  const edit = treeEdit({adGroup: '55', nodes});
  assert.equal(edit.operations.length, 120);
  const p = await x.prepareEdit(edit);
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 600));
  assert.equal(p.data.group, undefined, 'one review, never a group of parts of 25');
  assert.equal(x.mutates.length, 0);
  const e = await x.execute(p);
  assert.equal(e.success, true, JSON.stringify(e).slice(0, 600));
  assert.equal(x.mutates.length, 1, 'one mutate request');
  assert.equal(x.mutates[0].body.operations.length, 120);
  assert.equal(x.nodes.size, 120);
  assert.equal((await x.verify(p)).data.status, 'verified');
});

test('a branch is replaced in one review: leaves first on removal, and a removal before its children is refused', async t => {
  const x = shoppingCustomer(existingAdGroup({criteria: existingTree()}));
  t.after(() => x.store.close());
  const gamma = {create: {...swap.create, cpcBidMicros: '1100000'}};
  const replace = {operations: [{remove: node(2)}, gamma]};
  const p = await x.prepareEdit(replace);
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 1200));
  assert.deepEqual(p.data.creative_impact.final_tree, [
    'root > productBrand=* [UNIT bid=700000]',
    'root > productBrand=gamma [UNIT bid=1100000]',
    'root [SUBDIVISION]',
  ]);
  assert.equal((await x.execute(p)).success, true);
  assert.equal((await x.verify(p)).data.status, 'verified');
  assert.equal(x.nodes.has(node(2)), false);
  assert.equal(x.nodes.size, 3);
  // The root cannot go before the units under it, and the tree cannot be left empty or without its "Other" node.
  const y = shoppingCustomer(existingAdGroup({criteria: existingTree()}));
  t.after(() => y.store.close());
  const early = await y.prepareEdit({operations: [{remove: node(1)}, gamma]});
  assertRefused(early, 'INVALID_SHOPPING_LISTING_GROUP', {writes: y.mutates.length, message: /leaves first/});
  assert.equal(early.error.details.rule, 'remove_before_children');
  // The "Other" node cannot be removed and replaced by a named brand: the root would be left with no "Other".
  const noOther = await y.prepareEdit({operations: [{remove: node(3)}, swap]});
  assertRefused(noOther, 'INVALID_SHOPPING_LISTING_GROUP', {writes: y.mutates.length, message: /exactly one "Other"/});
  assert.equal(noOther.error.details.rule, 'other_missing');
  // A pure removal of nodes is not a tree edit (it has no listing group create): the targeting family keeps it, which has no tree check.
  assert.equal(familyOf(plan({operations: [{remove: node(3)}]}))?.name, 'google_targeting');
  assert.equal(y.mutates.length, 0);
});

test('a removed listing group the fixture keeps as a REMOVED row (Google may; UNVERIFIED until LV-15): the tree read leaves removed criteria out, so a replaced tree is verified (R2.5 M3 round 2, S2-1)', async t => {
  const x = shoppingCustomer(existingAdGroup({criteria: existingTree()}));
  x.mode.keepRemoved = true;
  t.after(() => x.store.close());
  const gamma = {create: {...swap.create, cpcBidMicros: '1100000'}};
  const p = await x.prepareEdit({operations: [{remove: node(2)}, gamma]});
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 800));
  assert.equal((await x.execute(p)).success, true);
  // The removed node is still a row in the fixture, as REMOVED (Google may keep it so); a read that does not say otherwise lists it.
  assert.equal(x.nodes.get(node(2)).status, 'REMOVED');
  const v = await x.verify(p);
  assert.equal(v.data.status, 'verified', JSON.stringify(v.data).slice(0, 1200));
  // Every read of the tree says so: the two at prepare and at execute, and the verification.
  const reads = treeReads(x);
  assert.ok(reads.length >= 3, 'the tree is read at prepare, at execute and to verify');
  for (const q of reads) assert.match(q, / AND ad_group_criterion\.status != 'REMOVED'$/, q);
});

test('a second edit of a replaced tree prepares, executes and verifies: the removed rows the fixture keeps (Google may) are no part of the tree (R2.5 M3 round 2, S2-1)', async t => {
  const x = shoppingCustomer(existingAdGroup({criteria: existingTree()}));
  x.mode.keepRemoved = true;
  t.after(() => x.store.close());
  // The whole tree is replaced, root included: the fixture then lists the old root, REMOVED, beside the new one.
  const first = await x.prepareEdit(
    treeEdit({adGroup: '55', removes: [node(2), node(3), node(1)], nodes: shoppingTree({adGroup: '55', first: 1})}),
  );
  assert.equal(first.success, true, JSON.stringify(first).slice(0, 800));
  assert.equal((await x.execute(first)).success, true);
  const live = () => [...x.nodes.values()].filter(n => n.status !== 'REMOVED');
  assert.equal(live().length, 5, 'the new tree');
  assert.equal(x.nodes.size, 8, 'and the three removed rows, which the fixture keeps');
  // A second review of the same ad group: Zeta, the excluded unit, goes, and Delta comes.
  const zeta = live().find(n => n.negative === true).resource_name,
    root = live().find(n => !n.listing_group.parent_ad_group_criterion).resource_name;
  const delta = {
    create: {
      adGroup: at('adGroups', '55'),
      listingGroup: {type: 'UNIT', parentAdGroupCriterion: root, caseValue: brand('Delta')},
    },
  };
  const second = await x.prepareEdit({operations: [{remove: zeta}, delta]});
  assert.equal(second.success, true, JSON.stringify(second).slice(0, 1200));
  assert.deepEqual(second.data.creative_impact.final_tree, [
    'root > productBrand=* [UNIT bid=700000]',
    'root > productBrand=acme [UNIT bid=1500000]',
    'root > productBrand=beta [UNIT bid=900000]',
    'root > productBrand=delta [UNIT]',
    'root [SUBDIVISION]',
  ]);
  assert.equal((await x.execute(second)).success, true);
  assert.equal((await x.verify(second)).data.status, 'verified');
  assert.equal(live().length, 5);
});
// Package r25-m3-live (F2) replaced this test, 'a node sent PAUSED is read back with its status: stored PAUSED is verified, stored ENABLED
// is not (R2.5 M3 round 2, S3-3)', which sent a unit PAUSED, prepared it and verified it stored PAUSED. The lead's live runs of 2026-11-20
// show that Google does not keep a listing group's status: a unit sent PAUSED reads back ENABLED. So a create that sends any status but
// ENABLED is refused at prepare, before any request, and the unit sent ENABLED or with no status stays the same node.
test('a node created with a status other than ENABLED is refused at prepare, before any request: Google does not keep a listing group’s status (r25-m3-live, F2)', async t => {
  const refusedAt = async (label, change, operation) => {
    const x = shoppingCustomer(existingAdGroup());
    t.after(() => x.store.close());
    const r = await x.prepareEdit(
      treeEdit({adGroup: '55', nodes: shoppingTree({adGroup: '55', first: 1}).map(change)}),
    );
    assertRefused(r, 'INVALID_SHOPPING_LISTING_GROUP', {
      writes: x.mutates.length,
      message: /^Google does not keep a listing group’s status/,
    });
    assert.deepEqual(
      [r.error.details.rule, r.error.details.operation, r.error.details.field, r.error.details.allowed],
      ['status_value', operation, 'operations[' + operation + '].create.status', ['ENABLED']],
      label,
    );
    assert.deepEqual(
      [x.queries.length, x.validations.length, x.mutates.length],
      [0, 0, 0],
      label + ': no request of any kind, not even a read',
    );
  };
  // The nodes are the root (operation 0), Acme, Beta (operation 2, bid 900000), the excluded Zeta and "Other".
  await refusedAt('a unit created PAUSED', n => (n.bid === '900000' ? {...n, status: 'PAUSED'} : n), 2);
  await refusedAt('the excluded unit created PAUSED', n => (n.negative ? {...n, status: 'PAUSED'} : n), 3);
  await refusedAt('a subdivision created PAUSED', n => (n.type === 'SUBDIVISION' ? {...n, status: 'PAUSED'} : n), 0);
  // A status that does not exist is refused as the same rule, and the ad group is what to pause.
  await refusedAt('a status that does not exist', n => (n.bid === '900000' ? {...n, status: 'REMOVED'} : n), 2);
  // ENABLED, and a status left out, are the same node and are prepared, executed and verified.
  for (const [label, status] of [
    ['sent ENABLED', 'ENABLED'],
    ['with no status', undefined],
  ]) {
    const x = shoppingCustomer(existingAdGroup());
    t.after(() => x.store.close());
    const nodes = shoppingTree({adGroup: '55', first: 1}).map(n => (status ? {...n, status} : n)),
      p = await x.prepareEdit(treeEdit({adGroup: '55', nodes}));
    assert.equal(p.success, true, label + ': ' + JSON.stringify(p).slice(0, 800));
    assert.ok(p.data.creative_impact.final_tree.includes('root > productBrand=beta [UNIT bid=900000]'), label);
    assert.equal((await x.execute(p)).success, true, label);
    assert.equal((await x.verify(p)).data.status, 'verified', label);
  }
});
test('a node Google lists with a status this version cannot name is not verified as the ENABLED node that was sent (R2.5 M3 round 3, N4)', async t => {
  // A node sent without a status reads as ENABLED. A read-back that lists UNKNOWN for "Beta" (a status this version has no name for)
  // is not that node, so the tree is not verified.
  const edit = treeEdit({adGroup: '55'}),
    x = shoppingCustomer(
      existingAdGroup({tamper: record => (record.cpc_bid_micros === '900000' ? {status: 'UNKNOWN'} : {})}),
    );
  t.after(() => x.store.close());
  const p = await x.prepareEdit(edit);
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 800));
  assert.equal((await x.execute(p)).success, true);
  const v = await x.verify(p);
  assert.notEqual(v.data.status, 'verified', JSON.stringify(v.data).slice(0, 800));
  assert.equal(v.data.checks.filter(c => c.status !== 'verified').length, 1, 'the tree is what differs');
  // r25-m3-live (F2): a UNIT's status is still compared, as Google lists it. One it lists PAUSED, which the request never asked for (it can
  // no longer ask), is not the ENABLED unit that was sent either.
  const paused = shoppingCustomer(
    existingAdGroup({tamper: record => (record.cpc_bid_micros === '900000' ? {status: 'PAUSED'} : {})}),
  );
  t.after(() => paused.store.close());
  const pausedReview = await paused.prepareEdit(edit);
  assert.equal((await paused.execute(pausedReview)).success, true);
  const pausedVerified = await paused.verify(pausedReview);
  assert.notEqual(pausedVerified.data.status, 'verified', JSON.stringify(pausedVerified.data).slice(0, 800));
  assert.equal(pausedVerified.data.checks.filter(c => c.status !== 'verified').length, 1, 'the tree is what differs');
  // Nothing else differs: the same edit read back as it was stored is verified.
  const y = shoppingCustomer(existingAdGroup());
  t.after(() => y.store.close());
  const q = await y.prepareEdit(edit);
  assert.equal((await y.execute(q)).success, true);
  assert.equal((await y.verify(q)).data.status, 'verified');
});

// Package r25-m3-live (F2), the lead's live run of 2026-11-20 on a Google test account: a route B tree edit removed the "acme" unit and created an
// "acme" subdivision with two units under it. Google reused the removed unit's criterion ID for the new subdivision of the same dimension (and
// left no REMOVED row), listed every subdivision PAUSED, and the new subdivision kept the removed unit's cpc_bid_micros; the verification
// answered VERIFICATION_MISMATCH on the tree although Google had applied exactly what was sent.
const condition = v => ({productCondition: v ? {condition: v} : {}});
/** The edit of the live run: Acme, a unit, becomes a subdivision by condition with a "New" unit and an "Other" unit under it. */
const acmeBecomesSubdivision = () => {
  const sub = at('adGroupCriteria', '55~-10'),
    create = (listingGroup, extra = {}) => ({create: {adGroup: at('adGroups', '55'), listingGroup, ...extra}});
  return {
    operations: [
      {remove: node(2)},
      {
        create: {
          resourceName: sub,
          adGroup: at('adGroups', '55'),
          listingGroup: {type: 'SUBDIVISION', parentAdGroupCriterion: node(1), caseValue: brand('Acme')},
        },
      },
      create({type: 'UNIT', parentAdGroupCriterion: sub, caseValue: condition('NEW')}, {cpcBidMicros: '1200000'}),
      create({type: 'UNIT', parentAdGroupCriterion: sub, caseValue: condition()}, {cpcBidMicros: '800000'}),
    ],
  };
};

test('the review of a tree edit that removes one node and creates three says it removes one resource (r25-m3-live, F5)', async t => {
  const x = shoppingCustomer(existingAdGroup({criteria: existingTree()}));
  t.after(() => x.store.close());
  const p = await x.prepareEdit(acmeBecomesSubdivision());
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 800));
  // This said "removes 4 resources" (one removal and three creates) before.
  assert.equal(
    p.data.execute_requirements.reasons.find(r => r.effect === 'destructive').reason,
    'This deletes or removes 1 resource (POST /v25/customers/123/adGroupCriteria:mutate), and the same request creates 3. It cannot be undone.',
  );
  // One removal and one create, the replacement of a unit: one, as the sentence said "2" before.
  const gamma = {create: {...swap.create, cpcBidMicros: '1100000'}},
    q = await x.prepareEdit({operations: [{remove: node(2)}, gamma]});
  assert.equal(q.success, true, JSON.stringify(q).slice(0, 800));
  assert.match(
    q.data.execute_requirements.reasons.find(r => r.effect === 'destructive').reason,
    /^This deletes or removes 1 resource \(POST [^)]+\), and the same request creates 1\. It cannot be undone\.$/,
  );
});
test('replacing a unit by a subdivision with two units under it is verified when Google answers as it did live: every subdivision PAUSED, the removed unit’s ID and bid reused (r25-m3-live, F2)', async t => {
  const x = shoppingCustomer(existingAdGroup({criteria: existingTree()}));
  x.mode.asGoogleAnswers = true;
  t.after(() => x.store.close());
  const p = await x.prepareEdit(acmeBecomesSubdivision());
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 1200));
  assert.deepEqual(p.data.creative_impact.final_tree, [
    'root > productBrand=* [UNIT bid=700000]',
    'root > productBrand=acme > productCondition=* [UNIT bid=800000]',
    'root > productBrand=acme > productCondition=new [UNIT bid=1200000]',
    'root > productBrand=acme [SUBDIVISION]',
    'root [SUBDIVISION]',
  ]);
  assert.equal((await x.execute(p)).success, true);
  // Google did what the live run saw: the new subdivision has the removed unit's ID and bid, no removed row is left, and a read lists
  // every subdivision PAUSED.
  const subdivision = x.nodes.get(node(2));
  assert.deepEqual(
    [
      subdivision.listing_group.type,
      subdivision.cpc_bid_micros,
      [...x.nodes.values()].some(n => n.status === 'REMOVED'),
    ],
    ['SUBDIVISION', '1500000', false],
  );
  const v = await x.verify(p);
  assert.equal(v.data.status, 'verified', JSON.stringify(v.data).slice(0, 1500));
  // A second edit on the replaced tree prepares, as it did live: the bid Google keeps on a subdivision never fails a review of something else.
  const next = await x.prepareEdit({
    operations: [
      {remove: [...x.nodes.keys()].find(n => x.nodes.get(n).cpc_bid_micros === '1200000')},
      {
        create: {
          adGroup: at('adGroups', '55'),
          listingGroup: {type: 'UNIT', parentAdGroupCriterion: node(2), caseValue: condition('USED')},
          cpcBidMicros: '600000',
        },
      },
    ],
  });
  assert.equal(next.success, true, JSON.stringify(next).slice(0, 800));
});

test('a unit whose bid or exclusion differs in the read-back is still a mismatch, in the same live shape (r25-m3-live, F2)', async t => {
  for (const [label, tamper] of [
    ['a unit’s bid', record => (record.cpc_bid_micros === '1200000' ? {cpc_bid_micros: '1300000'} : {})],
    ['a unit’s exclusion', record => (record.cpc_bid_micros === '800000' ? {negative: true} : {})],
  ]) {
    const x = shoppingCustomer(existingAdGroup({criteria: existingTree(), tamper}));
    x.mode.asGoogleAnswers = true;
    t.after(() => x.store.close());
    const p = await x.prepareEdit(acmeBecomesSubdivision());
    assert.equal(p.success, true, label + ': ' + JSON.stringify(p).slice(0, 800));
    assert.equal((await x.execute(p)).success, true, label);
    const v = await x.verify(p);
    assert.notEqual(v.data.status, 'verified', label + ': ' + JSON.stringify(v.data).slice(0, 800));
    assert.equal(v.data.checks.filter(c => c.status !== 'verified').length, 1, label + ': the tree is what differs');
  }
});
test('a second copy of an executed tree replacement is refused by the nodes it names, although the duplicate guard does not look at a replacement (R2.5 M3 round 2, S4-2)', async t => {
  const x = shoppingCustomer(existingAdGroup({criteria: existingTree()}));
  t.after(() => x.store.close());
  const replace = treeEdit({
    adGroup: '55',
    removes: [node(2), node(3), node(1)],
    nodes: shoppingTree({adGroup: '55', first: 1}),
  });
  const p = await x.prepareEdit(replace);
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 800));
  assert.equal(p.data.duplicate_warning, undefined, 'a replacement is no create for the guard');
  assert.equal((await x.execute(p)).success, true);
  // The same edit again names nodes that are gone.
  const again = await x.prepareEdit(replace);
  assertRefused(again, 'STATE_NOT_FOUND', {writes: x.mutates.length - 1});
});

test('a removal is a deletion for the owner’s switch, and a change under a serving ad group is an activation', async t => {
  const x = shoppingCustomer(existingAdGroup({criteria: existingTree()}));
  t.after(() => x.store.close());
  saveSpendPolicy(x.store, admin, {
    gateway: google,
    account_id: account,
    confirmed: true,
    policy: {allow_deletion: false, allow_activation: true},
  });
  assertRefused(await x.prepareEdit({operations: [{remove: node(2)}, swap]}), 'POLICY_DELETION_FORBIDDEN', {
    writes: x.mutates.length,
  });
  assert.equal((await x.prepareEdit({operations: [swap]})).success, true, 'a create alone is no deletion');
  saveSpendPolicy(x.store, admin, {
    gateway: google,
    account_id: account,
    confirmed: true,
    policy: {allow_deletion: true, allow_activation: false},
  });
  const paused = await x.prepareEdit({operations: [{remove: node(2)}, swap]});
  assert.equal(paused.success, true, JSON.stringify(paused).slice(0, 600));
  assert.equal(paused.data.creative_impact.may_affect_serving, false);
  // The ad group and its campaign serve: the change is live at once, which the switch refuses.
  const y = shoppingCustomer(
    existingAdGroup({
      criteria: existingTree(),
      adGroups: {
        [at('adGroups', '55')]: {status: 'ENABLED', type: 'SHOPPING_PRODUCT_ADS', campaign: at('campaigns', '40')},
      },
      campaigns: {
        [at('campaigns', '40')]: {
          status: 'ENABLED',
          advertisingChannelType: 'SHOPPING',
          shoppingSetting: {merchantId: '555'},
        },
      },
    }),
  );
  t.after(() => y.store.close());
  saveSpendPolicy(y.store, admin, {
    gateway: google,
    account_id: account,
    confirmed: true,
    policy: {allow_deletion: true, allow_activation: false},
  });
  assertRefused(await y.prepareEdit({operations: [{remove: node(2)}, swap]}), 'POLICY_ACTIVATION_FORBIDDEN', {
    writes: y.mutates.length,
  });
  // Without the switch the review is prepared: a tree under a serving ad group is no targeting write that must start PAUSED
  // (TARGETING_PARENT_SERVING), it is this review's activation, and says so.
  saveSpendPolicy(y.store, admin, {
    gateway: google,
    account_id: account,
    confirmed: true,
    policy: {allow_deletion: true, allow_activation: true},
  });
  const live = await y.prepareEdit({operations: [{remove: node(2)}, swap]});
  assert.equal(live.success, true, JSON.stringify(live).slice(0, 700));
  assert.equal(live.data.creative_impact.may_affect_serving, true);
  assert.equal(live.data.execute_requirements.spend_change_confirmed, true);
});

test('a unit bid above the owner’s bid cap is refused, as a keyword’s bid is', async t => {
  const x = shoppingCustomer(existingAdGroup());
  t.after(() => x.store.close());
  saveSpendPolicy(x.store, admin, {
    gateway: google,
    account_id: account,
    confirmed: true,
    policy: {enforcement: 'block', allow_deletion: true, allow_activation: true, max_bid_native: 1000000},
  });
  // The cap is in Google's native unit, micros: 1,000,000 is 1.00. The tree's highest bid is 1.50.
  const r = await x.prepareEdit(treeEdit());
  assertRefused(r, 'POLICY_BID_LIMIT', {writes: x.mutates.length});
  assert.match(r.error.details.field, /cpc_bid_micros|cpcBidMicros/);
  const ok = await x.prepareEdit(
    treeEdit({nodes: shoppingTree({adGroup: '55', first: 1}).map(n => ({...n, bid: n.bid ? '500000' : undefined}))}),
  );
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 600));
});

test('a bid on a subdivision, and a bid on an excluded unit, that the request creates are refused naming cpcBidMicros, the key of the request (R2.5 M3 round 3, N1)', async t => {
  const x = shoppingCustomer(existingAdGroup());
  t.after(() => x.store.close());
  const nodes = shoppingTree({adGroup: '55', first: 1});
  const refused = async (change, message) => {
    const r = await x.prepareEdit(treeEdit({adGroup: '55', nodes: nodes.map(change)}));
    assertRefused(r, 'INVALID_SHOPPING_LISTING_GROUP', {writes: x.mutates.length, message});
    return r.error.details;
  };
  // The nodes are the root (operation 0), Acme, Beta, the excluded Zeta (operation 3) and "Other".
  const subdivision = await refused(n => (n.type === 'SUBDIVISION' ? {...n, bid: '1500000'} : n), /takes no bid/);
  assert.deepEqual(
    [subdivision.rule, subdivision.operation, subdivision.field],
    ['bid_on_subdivision', 0, 'operations[0].create.cpcBidMicros'],
  );
  const excluded = await refused(n => (n.negative ? {...n, bid: '100000'} : n), /excluded unit takes no bid/);
  assert.deepEqual(
    [excluded.rule, excluded.operation, excluded.field],
    ['bid_on_excluded_unit', 3, 'operations[3].create.cpcBidMicros'],
  );
});

test('a bid or a negative flag Google lists on an existing subdivision never fails a review of something else (R2.5 M3 round 3, N3)', async t => {
  // An inherited bid, say: it is Google's own state, not the request's, so a review that adds a unit under the subdivision is prepared.
  for (const listed of [{cpc_bid_micros: '500000'}, {negative: true}]) {
    const x = shoppingCustomer(
      existingAdGroup({
        criteria: [
          existingNode(1, 'SUBDIVISION', undefined, undefined, listed),
          existingNode(2, 'UNIT', 1, {product_brand: {value: 'Acme'}}, {cpc_bid_micros: '1500000'}),
          existingNode(3, 'UNIT', 1, {product_brand: {}}, {cpc_bid_micros: '700000'}),
        ],
      }),
    );
    t.after(() => x.store.close());
    const p = await x.prepareEdit({operations: [swap]});
    assert.equal(p.success, true, JSON.stringify(listed) + ': ' + JSON.stringify(p).slice(0, 600));
    assert.ok(p.data.creative_impact.final_tree.includes('root [SUBDIVISION]'), JSON.stringify(listed));
  }
});

test('a tree read that has another page, or a row of another ad group, is never a complete tree; a tree changed after review stops execution', async t => {
  for (const mode of ['page', 'foreign']) {
    const x = shoppingCustomer(existingAdGroup({criteria: existingTree()}));
    t.after(() => x.store.close());
    x.mode[mode] = true;
    const r = await x.prepareEdit({operations: [{remove: node(2)}, swap]});
    assertRefused(r, mode === 'page' ? 'INCOMPLETE_STATE' : 'STATE_TARGET_MISMATCH', {writes: x.mutates.length});
  }
  const y = shoppingCustomer(existingAdGroup({criteria: existingTree()}));
  t.after(() => y.store.close());
  const p = await y.prepareEdit({operations: [{remove: node(2)}, swap]});
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
  // Someone adds a brand to the tree in the meantime.
  y.nodes.set(node(9), existingNode(9, 'UNIT', 1, {product_brand: {value: 'Delta'}}));
  assertRefused(await y.execute(p), 'STATE_CHANGED', {writes: y.mutates.length});
  // And a bid change of an existing unit (a field the review kept) is a change too.
  const z = shoppingCustomer(existingAdGroup({criteria: existingTree()}));
  t.after(() => z.store.close());
  const q = await z.prepareEdit({operations: [{remove: node(2)}, swap]});
  z.nodes.get(node(3)).cpc_bid_micros = '800000';
  assertRefused(await z.execute(q), 'STATE_CHANGED', {writes: z.mutates.length});
});

test('a receipt missing a result is kept as a failure, never resubmitted and never verified as success', async t => {
  const x = shoppingCustomer(existingAdGroup());
  t.after(() => x.store.close());
  const p = await x.prepareEdit(treeEdit());
  assert.equal(p.success, true);
  x.mode.short = true;
  const first = await x.execute(p);
  assert.equal(first.success, false, JSON.stringify(first).slice(0, 600));
  const again = await x.execute(p);
  assert.equal(again.data?.replayed, true, JSON.stringify(again).slice(0, 900));
  assert.equal(x.mutates.length, 1);
  assertRefused(await x.verify(p), 'WRITE_PARTIAL_OR_FAILED');
});

test('a mix of a tree and another change, an ad group that is not Standard Shopping, and a campaign without a Merchant Center account are refused', async t => {
  const x = shoppingCustomer(existingAdGroup());
  t.after(() => x.store.close());
  const keyword = {create: {adGroup: at('adGroups', '55'), keyword: {text: 'acme', matchType: 'EXACT'}}};
  const mixed = await x.prepareEdit({operations: [...treeEdit().operations, keyword]});
  assertRefused(mixed, 'INVALID_SHOPPING_LISTING_GROUP', {
    writes: x.mutates.length,
    message: /creates and removals only/,
  });
  assert.equal(mixed.error.details.operation, 5);
  assert.equal(x.queries.length, 0, 'refused before any read');
  const update = await x.prepareEdit({
    operations: [
      {update: {resourceName: node(2), cpcBidMicros: '1'}, updateMask: 'cpcBidMicros'},
      ...treeEdit().operations,
    ],
  });
  assertRefused(update, 'INVALID_SHOPPING_LISTING_GROUP', {message: /creates or removes one listing group/});
  // The ad group is a Search one, or its campaign has no Merchant Center account, or is not a Shopping campaign.
  for (const [label, g, c, message] of [
    ['search ad group', {type: 'SEARCH_STANDARD'}, {}, /SHOPPING_PRODUCT_ADS/],
    ['no Merchant Center', {}, {shoppingSetting: {}}, /Merchant Center/],
    ['not a Shopping campaign', {}, {advertisingChannelType: 'SEARCH'}, /SEARCH/],
  ]) {
    const base = existingAdGroup(),
      y = shoppingCustomer({
        adGroups: {[at('adGroups', '55')]: {...base.adGroups[at('adGroups', '55')], ...g}},
        campaigns: {[at('campaigns', '40')]: {...base.campaigns[at('campaigns', '40')], ...c}},
      });
    t.after(() => y.store.close());
    assertRefused(await y.prepareEdit(treeEdit()), 'INVALID_SHOPPING_LISTING_GROUP', {
      writes: y.mutates.length,
      message,
    });
    assert.equal(y.mutates.length, 0, label);
  }
});

test('malformed trees fail locally, before any read, each by its own refusal: the family’s rule, or the vendor check at the field it names (R2.5 M3 round 2, S4-8)', async t => {
  const own = (rule, field, message) => ({code: 'INVALID_SHOPPING_LISTING_GROUP', rule, field, message});
  const vendor = pointer => ({code: 'INVALID_VENDOR_BODY', pointer});
  const cases = [
    [
      'an unknown field',
      treeEdit({extra: {finalUrls: ['https://example.test/']}}),
      own('create_keys', 'operations[0].create', /accepts resourceName, adGroup, listingGroup/),
    ],
    [
      'a subdivision without a temporary name',
      {operations: [{create: {adGroup: at('adGroups', '55'), listingGroup: {type: 'SUBDIVISION'}}}]},
      own('subdivision_unnamed', 'operations[0].create.resourceName', /give it a temporary resourceName/),
    ],
    [
      'a positive name',
      {operations: [{create: {resourceName: node(15), adGroup: at('adGroups', '55'), listingGroup: {type: 'UNIT'}}}]},
      own('node_name', 'operations[0].create.resourceName', /temporary name/),
    ],
    [
      'another ad group',
      {operations: [...treeEdit().operations, {remove: at('adGroupCriteria', '56~9')}]},
      own('one_group', 'operations[5].remove', /one ad group/),
    ],
    [
      // Discovery refuses a bid that is no decimal string before the family reads it.
      'a bid that is not a whole number',
      treeEdit({nodes: shoppingTree({adGroup: '55', first: 1}).map(n => ({...n, bid: n.bid && '1.5'}))}),
      vendor('/operations/1/create/cpcBidMicros'),
    ],
    [
      // The pinned v25 document has no webpage dimension for this field.
      'an unknown dimension',
      {
        operations: [
          {
            create: {
              adGroup: at('adGroups', '55'),
              listingGroup: {type: 'UNIT', parentAdGroupCriterion: node(1), caseValue: {webpage: {}}},
            },
          },
        ],
      },
      vendor('/operations/0/create/listingGroup/caseValue/webpage'),
    ],
    [
      'a root with a case value',
      {operations: [{create: {adGroup: at('adGroups', '55'), listingGroup: {type: 'UNIT', caseValue: brand('a')}}}]},
      own('root_case_value', 'operations[0].create.listingGroup.caseValue', /has no caseValue/),
    ],
    [
      // UNIT_INCLUDED is a Performance Max type: the pinned v25 enum of a criterion's listing group has none.
      'a listing group type that does not exist',
      {operations: [{create: {adGroup: at('adGroups', '55'), listingGroup: {type: 'UNIT_INCLUDED'}}}]},
      vendor('/operations/0/create/listingGroup/type'),
    ],
    [
      'the other customer',
      {operations: [{create: {adGroup: 'customers/999/adGroups/55', listingGroup: {type: 'UNIT'}}}]},
      own('create_group', 'operations[0].create.adGroup', /ad group of the selected customer/),
    ],
  ];
  for (const [label, payload, expected] of cases) {
    const x = shoppingCustomer(existingAdGroup());
    t.after(() => x.store.close());
    const r = await x.prepareEdit(payload);
    assertRefused(r, expected.code, {writes: x.mutates.length});
    if (expected.pointer) {
      assert.equal(r.error.details.errors[0].field, expected.pointer, label + ': the vendor check names the field');
      assert.equal(r.error.details.rule, undefined, label + ': the vendor check has no tree rule');
    } else {
      assert.match(r.error.message, expected.message, label);
      assert.equal(r.error.details.rule, expected.rule, label + ': the family’s own rule');
      assert.equal(r.error.details.field, expected.field, label + ': its field');
    }
    assert.equal(x.queries.length, 0, label + ': refused before any read');
  }
});
test('a lost tree edit that Google applied is found by its shape; one it never applied is absent (the lookup of an uncertain write, by reads alone)', async t => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
  t.after(() => {
    delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
    delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
  });
  for (const applied of [true, false]) {
    const x = shoppingCustomer(existingAdGroup());
    t.after(() => x.store.close());
    const p = await x.prepareEdit(treeEdit());
    x.mode.lose = true;
    x.mode.applied = applied;
    assertRefused(await x.execute(p), 'WRITE_OUTCOME_UNCERTAIN');
    x.mode.lose = false;
    x.mode.applied = true;
    const sent = x.mutates.length;
    const r = await x.call('amcp_write', {action: 'reconcile', review_id: p.data.review_id});
    assert.equal(r.data.contract, 'create', JSON.stringify(r.data).slice(0, 400));
    assert.equal(r.data.classification, applied ? 'appears_applied' : 'appears_not_applied', JSON.stringify(r.data));
    assert.equal(x.mutates.length, sent, 'a lookup reads and never sends the edit again');
  }
});

test('only the criterion has a status that a tree read must leave REMOVED out of: the Performance Max filter has none in the pinned v25 document (R2.5 M3 round 2, S2-1)', () => {
  const doc = JSON.parse(fs.readFileSync('.mirror/VENDOR/google-ads-v25.json', 'utf8')),
    schemas = (doc.document ?? doc).schemas;
  const status = name => schemas['GoogleAdsGoogleadsV25Resources__' + name].properties.status;
  assert.deepEqual(status('AdGroupCriterion').enum, ['UNSPECIFIED', 'UNKNOWN', 'ENABLED', 'PAUSED', 'REMOVED']);
  assert.equal(
    status('AssetGroupListingGroupFilter'),
    undefined,
    'a removed filter is gone, so its read needs no filter',
  );
});

test('every field the review reads is one the pinned v25 document lists for the criterion and the ad group', () => {
  const doc = JSON.parse(fs.readFileSync('.mirror/VENDOR/google-ads-v25.json', 'utf8')),
    schemas = (doc.document ?? doc).schemas;
  const camel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  /** Walks the field's path through the document's schemas to a leaf property. */
  const listed = (schema, path) => {
    let s = schemas[schema];
    for (const part of path.split('.')) {
      const property = s?.properties?.[camel(part)];
      if (!property) return false;
      s = property.$ref ? schemas[property.$ref] : property;
    }
    return true;
  };
  for (const f of googleShoppingTreeFields)
    assert.equal(listed('GoogleAdsGoogleadsV25Resources__AdGroupCriterion', f), true, 'ad_group_criterion.' + f);
  const parents = {
    ad_group: 'GoogleAdsGoogleadsV25Resources__AdGroup',
    campaign: 'GoogleAdsGoogleadsV25Resources__Campaign',
  };
  for (const f of googleShoppingTreeParentFields) {
    const [resource, ...rest] = f.split('.');
    assert.equal(listed(parents[resource], rest.join('.')), true, f);
  }
});

test('a pure removal of a subdivision, which the targeting family keeps, says in its impact that Google removes the whole subtree (the trees review’s S4-7, the M3 merge)', async t => {
  const keyword = {
    resource_name: at('adGroupCriteria', '55~900'),
    ad_group: at('adGroups', '55'),
    criterion_id: '900',
    type: 'KEYWORD',
    negative: false,
    status: 'ENABLED',
    keyword: {text: 'acme', match_type: 'EXACT'},
  };
  const x = shoppingCustomer(existingAdGroup({criteria: [...existingTree(), keyword]}));
  t.after(() => x.store.close());
  const remove = name =>
    x.call('amcp_write', {
      action: 'prepare',
      gateway: google,
      arguments: {
        action: 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
        account_id: account,
        payload: {operations: [{remove: name}]},
      },
    });
  // A listing group: the whole subtree goes with a subdivision, and the review says what Google does when it cannot.
  const root = await remove(node(1));
  assert.equal(root.success, true, JSON.stringify(root).slice(0, 700));
  assert.equal(root.data.creative_impact.scope, 'listing_group_removal');
  assert.deepEqual(root.data.creative_impact.removes, [node(1)]);
  assert.match(
    root.data.creative_impact.subtree,
    /whole subtree[\s\S]*LISTING_GROUP_CANNOT_BE_REMOVED[\s\S]*Recursive removal failed/,
  );
  // Any other criterion is a removal as it was: no such impact.
  const other = await remove(keyword.resource_name);
  assert.equal(other.success, true, JSON.stringify(other).slice(0, 700));
  assert.equal(other.data.creative_impact, undefined);
  assert.equal(x.mutates.length, 0, 'preparing sends nothing');
});
