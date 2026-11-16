import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {findCreated} from '../dist/src/write-reconciliation.js';
import {account, at, gateway, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';

/**
 * R2.5 M2 (L2-13, L5-05): `reconcile` answered no_read_contract for a Google build, an asset link batch and a listing group
 * tree edit, because each is a reviewed family with its own read-back and `namedTargets` returns nothing for such a family.
 * Each now has a created lookup, by reads only:
 *  - a build (`googleAds:mutate`) is all or nothing, so its named resources (the shared budget, the campaign, its ad groups
 *    and asset groups, whose names Google keeps unique) are looked up by name, and found only as the set the build made:
 *    each child under the parent the build gave it;
 *  - an asset link has a deterministic resource name (customers/x/assetGroupAssets/{group}~{asset}~{FIELD}), so each
 *    create is looked up by name, a REMOVED link counting as no link;
 *  - a listing group tree is compared by shape, as the family's own read-back does: the shape the review expected after the
 *    edit means applied, the shape it read before means not applied, anything else settles nothing.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

const compiler = new Compiler(new Registry()),
  options = {mode: 'strict', flags: {}};
const compile = (action, payload) =>
  applyExecutionRisk(compiler.compile(gateway, {action, account_id: account, payload, dry_run: true}, options));
const claimed = Date.parse('2026-10-10T10:00:00Z'),
  context = (state = []) => ({state, claimedAt: claimed});

// ----- builds -----
const buildAction = 'google_ads_v23_google_ads_mutate';
const budgetOp = (extra = {}) => ({
  campaign_budget_operation: {
    create: {
      resource_name: at('campaignBudgets', '-1'),
      name: 'Reconcile budget',
      amount_micros: '40000000',
      delivery_method: 'STANDARD',
      ...extra,
    },
  },
});
const campaignOp = {
  campaign_operation: {
    create: {
      resource_name: at('campaigns', '-2'),
      name: 'Reconcile campaign',
      status: 'PAUSED',
      advertising_channel_type: 'SEARCH',
      campaign_budget: at('campaignBudgets', '-1'),
      manual_cpc: {},
      network_settings: {target_google_search: true, target_search_network: false, target_content_network: false},
      contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    },
  },
};
const adGroupOp = {
  ad_group_operation: {
    create: {
      resource_name: at('adGroups', '-3'),
      name: 'Reconcile ad group',
      campaign: at('campaigns', '-2'),
      status: 'ENABLED',
      type: 'SEARCH_STANDARD',
      cpc_bid_micros: '1500000',
    },
  },
};
const keywordOp = {
  ad_group_criterion_operation: {
    create: {ad_group: at('adGroups', '-3'), keyword: {text: 'acme', match_type: 'EXACT'}, status: 'ENABLED'},
  },
};
const build = (...ops) => ({mutate_operations: ops.length ? ops : [budgetOp(), campaignOp, adGroupOp, keywordOp]});

test('a build is looked up by the names Google keeps unique, one bounded search for each kind, in the order of its operations', () => {
  const lookup = findCreated(compile(buildAction, build()), context());
  assert.ok(lookup, 'a build has a lookup');
  assert.deepEqual(
    lookup.reads.map(r => [r.method, r.readOnly, r.body.query]),
    [
      [
        'POST',
        true,
        "SELECT campaign_budget.resource_name, campaign_budget.name FROM campaign_budget WHERE campaign_budget.name IN ('Reconcile budget') AND campaign_budget.status != 'REMOVED' LIMIT 100",
      ],
      [
        'POST',
        true,
        "SELECT campaign.resource_name, campaign.name, campaign.campaign_budget FROM campaign WHERE campaign.name IN ('Reconcile campaign') AND campaign.status != 'REMOVED' LIMIT 100",
      ],
      [
        'POST',
        true,
        "SELECT ad_group.resource_name, ad_group.name, ad_group.campaign FROM ad_group WHERE ad_group.name IN ('Reconcile ad group') AND ad_group.status != 'REMOVED' LIMIT 100",
      ],
    ],
  );
  for (const read of lookup.reads) assert.match(read.path, /\/customers\/123\/googleAds:search$/);
  // Names that cannot be put in a query safely, and a build with nothing named to look up, have no lookup.
  assert.equal(
    findCreated(compile(buildAction, build(budgetOp({name: "O'Reilly"}), campaignOp)), context()),
    undefined,
  );
  assert.equal(
    findCreated(
      compile(
        buildAction,
        build({
          ad_group_criterion_operation: {
            create: {ad_group: at('adGroups', '77'), keyword: {text: 'acme', match_type: 'EXACT'}, status: 'ENABLED'},
          },
        }),
      ),
      context(),
    ),
    undefined,
    'a build of unnamed resources under an existing parent has nothing to look up by',
  );
  // An unshared budget takes its name from its campaign, so its own name proves nothing: the campaign is the anchor.
  const unshared = findCreated(
    compile(buildAction, build(budgetOp({explicitly_shared: false}), campaignOp)),
    context(),
  );
  assert.equal(unshared.reads.length, 1);
  assert.match(unshared.reads[0].body.query, / FROM campaign WHERE campaign\.name IN \('Reconcile campaign'\)/);
});

/** What Google answers to one of the build lookup's searches. */
const rowsOf = (entity, rows, extra = {}) => ({status: 200, data: {results: rows.map(r => ({[entity]: r})), ...extra}});
const budgetRow = (id, name = 'Reconcile budget') => ({resourceName: at('campaignBudgets', id), name});
const campaignRow = (id, budget, name = 'Reconcile campaign') => ({
  resourceName: at('campaigns', id),
  name,
  campaignBudget: at('campaignBudgets', budget),
});
const groupRow = (id, campaign, name = 'Reconcile ad group') => ({
  resourceName: at('adGroups', id),
  name,
  campaign: at('campaigns', campaign),
});

test('the build match needs every named resource once, each under the parent the build gave it, and never picks between two', () => {
  const lookup = findCreated(compile(buildAction, build(budgetOp(), campaignOp, adGroupOp)), context());
  assert.ok(lookup, 'a build has a lookup');
  const match = (budgets, campaigns, groups, extra) =>
    lookup.match(
      [rowsOf('campaignBudget', budgets, extra), rowsOf('campaign', campaigns), rowsOf('adGroup', groups)],
      claimed,
    );
  const ids = m => m.found.map(f => f.id);
  // The three, linked as the build linked them: applied, as the set, in the order of the build.
  const applied = match([budgetRow('10')], [campaignRow('20', '10')], [groupRow('30', '20')]);
  assert.deepEqual(ids(applied), [at('campaignBudgets', '10'), at('campaigns', '20'), at('adGroups', '30')]);
  assert.deepEqual(
    applied.found.map(f => f.index),
    [0, 1, 2],
  );
  assert.equal(applied.expected, 3);
  assert.equal(applied.complete, true);
  // Nothing of those names: absent, from a complete read.
  assert.deepEqual(match([], [], []).found, []);
  assert.equal(match([], [], []).complete, true);
  // Some of them: a build is all or nothing, so this is another's, and nothing is claimed.
  const partial = match([budgetRow('10')], [campaignRow('20', '10')], []);
  assert.notEqual(partial.found.length, partial.expected);
  assert.equal(
    partial.found.every(f => f.index === undefined),
    true,
    'a partial set carries no record indexes',
  );
  // A campaign of the name that is linked to another budget is another campaign: not part of this build.
  const foreign = match([budgetRow('10')], [campaignRow('21', '99')], [groupRow('30', '21')]);
  assert.deepEqual(ids(foreign), [at('campaignBudgets', '10')], 'only the budget matches, so the set is partial');
  // An ad group of the name under another campaign is another's.
  assert.deepEqual(ids(match([budgetRow('10')], [campaignRow('20', '10')], [groupRow('31', '88')])), [
    at('campaignBudgets', '10'),
    at('campaigns', '20'),
  ]);
  // Two campaigns of the name, both linked to the budget: both are shown, neither is chosen.
  const twice = match([budgetRow('10')], [campaignRow('20', '10'), campaignRow('22', '10')], [groupRow('30', '20')]);
  assert.equal(twice.found.length > 3 || twice.found.some(f => f.index === undefined), true);
  assert.equal(twice.found.length === twice.expected && twice.found.every((f, i) => f.index === i), false);
  // A page left unread settles nothing.
  assert.equal(match([], [], [], {nextPageToken: 'more'}).complete, false);
  // The receipt names what was found at the operations that made it; the rest of the build's results are unknown.
  const receipt = lookup.receipt(applied.found);
  assert.deepEqual(receipt.mutateOperationResponses, [
    {campaignBudgetResult: {resourceName: at('campaignBudgets', '10')}},
    {campaignResult: {resourceName: at('campaigns', '20')}},
    {adGroupResult: {resourceName: at('adGroups', '30')}},
  ]);
});

const search = f => f.requests.filter(r => r.endsWith('/googleAds:search'));

test('a lost build that Google applied is found as the set it made; accepting records the receipt; nothing is sent', async () => {
  const f = googleReconcileFixture();
  try {
    const {id, refused} = await f.lose(buildAction, build(), {applied: true});
    assert.equal(refused.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(refused).slice(0, 400));
    assert.equal(f.claim(id).state, 'uncertain');
    const before = f.requests.length,
      sent = f.writes.length;
    const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 600));
    assert.equal(r.data.contract, 'create', 'no longer no_read_contract');
    assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data));
    assert.equal(r.data.observed_ids.length, 3);
    // Reads only: every request is a search, and no mutation was sent.
    const seen = f.requests.slice(before);
    assert.ok(seen.length > 0 && seen.every(x => x.endsWith('/googleAds:search')), seen.join(', '));
    assert.equal(f.writes.length, sent);
    assert.equal(r.data.mutation_requests, 0);
    const accepted = await f.call('amcp_write', {
      action: 'reconcile',
      review_id: id,
      accept_applied: true,
      reconciliation_id: r.data.reconciliation_id,
    });
    assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 600));
    assert.equal(f.claim(id).state, 'complete');
    assert.equal(f.writes.length, sent, 'accepting sends nothing');
    assert.equal(search(f).length > 0, true);
    // A lookup by name knows the named resources, not the build's keyword: its read-back verifies the three it can see and
    // says it cannot settle the rest. It never calls an unseen result verified, and never a mismatch.
    const verified = await f.call('amcp_campaign', {action: 'verify', review_id: id});
    assert.equal(verified.data.status, 'inconclusive', JSON.stringify(verified.data).slice(0, 600));
    assert.deepEqual(
      verified.data.checks.filter(c => c.status === 'verified').map(c => c.resource_id),
      r.data.observed_ids,
    );
    assert.equal(
      verified.data.checks.some(c => c.status === 'mismatch'),
      false,
    );
    assert.equal(f.writes.length, sent, 'verifying reads only');
  } finally {
    f.close();
  }
});

test('a lost build that Google never applied appears not applied, also beside a removed campaign of the same name', async () => {
  const f = googleReconcileFixture();
  try {
    // A removed campaign of the name is no campaign: the name is free again.
    f.row('campaign', {resource_name: at('campaigns', '9'), name: 'Reconcile campaign', status: 'REMOVED'});
    const {id, refused} = await f.lose(buildAction, build(), {applied: false});
    assert.equal(refused.error.code, 'WRITE_OUTCOME_UNCERTAIN');
    const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(r.data.classification, 'appears_not_applied', JSON.stringify(r.data));
    assert.equal(r.data.reason, 'not_found');
    assert.equal(f.writes.length, 1, 'sent once');
  } finally {
    f.close();
  }
});

test('a build whose campaign exists but whose ad group does not settles nothing: it is not claimed applied and not absent', async () => {
  const f = googleReconcileFixture();
  try {
    const {id} = await f.lose(buildAction, build(), {applied: true});
    // Something else removed the ad group (or never let it be made): only the budget and campaign remain.
    f.db.ad_group.length = 0;
    const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(r.data.contract, 'create', 'no longer no_read_contract');
    assert.equal(r.data.classification, 'indeterminate', JSON.stringify(r.data));
    assert.equal(r.data.reason, 'ambiguous', 'some of the set, not all of it');
    assert.equal(r.data.observed_ids, undefined, 'nothing is offered for acceptance');
    assert.ok(r.data.found.length >= 1);
  } finally {
    f.close();
  }
});

// ----- asset links -----
const linkAction = 'google_ads_v23_asset_group_asset_mutate_asset_group_assets';
const link = asset => ({
  create: {assetGroup: at('assetGroups', '102'), asset: at('assets', asset), fieldType: 'HEADLINE'},
});
const links = (...assets) => ({operations: assets.map(link), partialFailure: false});
function withAssetGroup(f) {
  f.row('campaign', {
    resource_name: at('campaigns', '100'),
    name: 'PMax campaign',
    status: 'PAUSED',
    advertising_channel_type: 'PERFORMANCE_MAX',
    campaign_budget: at('campaignBudgets', '10'),
  });
  f.row('asset_group', {
    resource_name: at('assetGroups', '102'),
    name: 'Asset group',
    status: 'PAUSED',
    campaign: at('campaigns', '100'),
  });
  for (const id of ['300', '301', '302'])
    f.row('asset', {
      resource_name: at('assets', id),
      type: 'TEXT',
      source: 'ADVERTISER',
      text_asset: {text: 'Headline ' + id},
    });
}
const linkName = asset => at('assetGroupAssets', '102~' + asset + '~HEADLINE');

test('an asset link batch is looked up by the deterministic names of its links, live ones only', () => {
  const lookup = findCreated(compile(linkAction, links('300', '301')), context());
  assert.ok(lookup, 'an all-create link batch has a lookup');
  assert.equal(lookup.reads.length, 1);
  assert.equal(
    lookup.reads[0].body.query,
    "SELECT asset_group_asset.resource_name, asset_group_asset.status FROM asset_group_asset WHERE asset_group_asset.resource_name IN ('" +
      linkName('300') +
      "', '" +
      linkName('301') +
      "') AND asset_group_asset.status IN ('ENABLED', 'PAUSED')",
  );
  const match = rows =>
    lookup.match(
      [{status: 200, data: {results: rows.map(n => ({assetGroupAsset: {resourceName: n, status: 'ENABLED'}}))}}],
      claimed,
    );
  assert.deepEqual(
    match([linkName('300'), linkName('301')]).found.map(f => [f.index, f.id]),
    [
      [0, linkName('300')],
      [1, linkName('301')],
    ],
  );
  assert.deepEqual(match([]).found, []);
  assert.equal(match([]).complete, true);
  // One of two: a link batch that applies all or none was changed by someone else, so it is not claimed.
  assert.equal(
    match([linkName('301')]).found.every(f => f.index === undefined),
    true,
  );
  assert.deepEqual(lookup.receipt(match([linkName('300'), linkName('301')]).found), {
    results: [{resourceName: linkName('300')}, {resourceName: linkName('301')}],
  });
  // A batch that updates or removes a link is not a create, and has none.
  const mixed = compile(linkAction, {
    operations: [link('300'), {update: {resourceName: linkName('301'), status: 'PAUSED'}, updateMask: 'status'}],
  });
  assert.equal(findCreated(mixed, context()), undefined);
});

test('a lost link batch that Google applied is found, accepted, and then verified by the family’s own read-back', async () => {
  const f = googleReconcileFixture();
  try {
    withAssetGroup(f);
    const {id, refused} = await f.lose(linkAction, links('300', '301'), {applied: true});
    assert.equal(refused.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(refused).slice(0, 400));
    const sent = f.writes.length;
    const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(r.data.contract, 'create');
    assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data));
    assert.deepEqual(r.data.observed_ids, [linkName('300'), linkName('301')]);
    assert.equal(f.writes.length, sent);
    const accepted = await f.call('amcp_write', {
      action: 'reconcile',
      review_id: id,
      accept_applied: true,
      reconciliation_id: r.data.reconciliation_id,
    });
    assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 500));
    // The receipt is the one Google would have answered, so the family's read-back runs from it.
    const verified = await f.call('amcp_campaign', {action: 'verify', review_id: id});
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 800));
    assert.equal(f.writes.length, sent, 'verifying reads only');
  } finally {
    f.close();
  }
});

test('a lost link batch that Google never applied is absent, and a link that was removed since counts as no link', async () => {
  const f = googleReconcileFixture();
  try {
    withAssetGroup(f);
    // A link that existed and was removed before the review: creating over it is allowed.
    f.row('asset_group_asset', {
      resource_name: linkName('300'),
      status: 'REMOVED',
      asset_group: at('assetGroups', '102'),
      asset: at('assets', '300'),
      field_type: 'HEADLINE',
    });
    const {id} = await f.lose(linkAction, links('300', '301'), {applied: false});
    const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(r.data.classification, 'appears_not_applied', JSON.stringify(r.data));
    assert.equal(r.data.reason, 'not_found');
  } finally {
    f.close();
  }
});

// ----- listing group trees -----
const treeAction = 'google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters';
const node = id => at('assetGroupListingGroupFilters', '102~' + id);
const tree = () => ({
  operations: [
    {
      create: {
        resourceName: node('-1'),
        assetGroup: at('assetGroups', '102'),
        type: 'SUBDIVISION',
        listingSource: 'SHOPPING',
      },
    },
    {
      create: {
        assetGroup: at('assetGroups', '102'),
        type: 'UNIT_INCLUDED',
        listingSource: 'SHOPPING',
        parentListingGroupFilter: node('-1'),
        caseValue: {productBrand: {value: 'Acme'}},
      },
    },
    {
      create: {
        assetGroup: at('assetGroups', '102'),
        type: 'UNIT_EXCLUDED',
        listingSource: 'SHOPPING',
        parentListingGroupFilter: node('-1'),
        caseValue: {productBrand: {}},
      },
    },
  ],
});
function withRetailAssetGroup(f) {
  f.row('campaign', {
    resource_name: at('campaigns', '100'),
    name: 'Retail PMax',
    status: 'PAUSED',
    advertising_channel_type: 'PERFORMANCE_MAX',
    shopping_setting: {merchant_id: '555'},
    campaign_budget: at('campaignBudgets', '10'),
  });
  f.row('asset_group', {
    resource_name: at('assetGroups', '102'),
    name: 'Asset group',
    status: 'PAUSED',
    campaign: at('campaigns', '100'),
  });
}
/** A tree as Google lists it: nodes with their names, types, parents and case values. */
const listed = nodes => ({
  status: 200,
  data: {
    results: nodes.map(n => ({
      assetGroupListingGroupFilter: {
        resourceName: node(n.id),
        assetGroup: at('assetGroups', '102'),
        type: n.type,
        listingSource: 'SHOPPING',
        ...(n.parent ? {parentListingGroupFilter: node(n.parent)} : {}),
        ...(n.value !== undefined ? {caseValue: {productBrand: n.value ? {value: n.value} : {}}} : {}),
      },
    })),
  },
});
const finalTree = [
  {id: '1', type: 'SUBDIVISION'},
  {id: '2', type: 'UNIT_INCLUDED', parent: '1', value: 'Acme'},
  {id: '3', type: 'UNIT_EXCLUDED', parent: '1', value: ''},
];

test('a listing group tree edit is looked up by the tree’s shape: the reviewed result means applied, the tree read before means not applied', () => {
  const group = {
    asset_group: {resource_name: at('assetGroups', '102'), status: 'PAUSED', campaign: at('campaigns', '100')},
    campaign: {},
  };
  const lookup = findCreated(compile(treeAction, tree()), context([group, {nodes: []}]));
  assert.ok(lookup, 'a tree edit has a lookup');
  assert.equal(lookup.reads.length, 1);
  assert.match(
    lookup.reads[0].body.query,
    / FROM asset_group_listing_group_filter WHERE asset_group_listing_group_filter\.asset_group = 'customers\/123\/assetGroups\/102'$/,
  );
  // The edit applied: the tree now has the shape the reviewed request gives it, whatever IDs Google assigned.
  const applied = lookup.match([listed(finalTree)], claimed);
  assert.equal(applied.found.length, 1);
  assert.equal(applied.found[0].index, 0);
  assert.equal(applied.complete, true);
  assert.deepEqual(lookup.receipt(applied.found), {
    results: [{resourceName: node('1')}, {resourceName: node('2')}, {resourceName: node('3')}],
  });
  // Not applied: the tree is as it was read before (empty).
  const absent = lookup.match([listed([])], claimed);
  assert.deepEqual(absent.found, []);
  assert.equal(absent.complete, true);
  // Neither: the tree was changed by someone else, or half of it exists. Nothing is claimed, and nothing is called absent.
  const other = lookup.match([listed(finalTree.slice(0, 2))], claimed);
  assert.deepEqual(other.found, []);
  assert.equal(other.complete, false);
  // The same number of nodes with another brand is another tree, not this edit's.
  const rebranded = lookup.match(
    [listed([finalTree[0], {...finalTree[1], value: 'Another brand'}, finalTree[2]])],
    claimed,
  );
  assert.deepEqual(rebranded.found, []);
  assert.equal(rebranded.complete, false);
  assert.equal(
    lookup.match([{status: 200, data: {results: [], nextPageToken: 'more'}}], claimed).complete,
    false,
    'an unread page settles nothing',
  );
});

test('a lost tree edit that Google applied is found by its shape; one it never applied is absent', async () => {
  const f = googleReconcileFixture();
  try {
    withRetailAssetGroup(f);
    const lost = await f.lose(treeAction, tree(), {applied: true});
    assert.equal(lost.refused.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(lost.refused).slice(0, 400));
    const sent = f.writes.length;
    const r = await f.call('amcp_write', {action: 'reconcile', review_id: lost.id});
    assert.equal(r.data.contract, 'create');
    assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data));
    assert.equal(f.writes.length, sent);

    const g = googleReconcileFixture();
    try {
      withRetailAssetGroup(g);
      const none = await g.lose(treeAction, tree(), {applied: false});
      const a = await g.call('amcp_write', {action: 'reconcile', review_id: none.id});
      assert.equal(a.data.classification, 'appears_not_applied', JSON.stringify(a.data));
    } finally {
      g.close();
    }
  } finally {
    f.close();
  }
});

test('the worker’s automatic check finds a lost Google build too', async () => {
  const f = googleReconcileFixture();
  try {
    const {id} = await f.lose(buildAction, build(), {applied: true});
    f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind='write_reconcile' AND state='queued'").run();
    assert.equal(await f.worker.once(), true);
    const s = await f.call('amcp_write', {action: 'status', review_id: id});
    assert.equal(s.data.reconciliation.classification, 'appears_applied', JSON.stringify(s.data.reconciliation));
    assert.equal(s.data.reconciliation.automatic, true);
  } finally {
    f.close();
  }
});
