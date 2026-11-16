import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {findCreated} from '../dist/src/write-reconciliation.js';
import {at, gateway as googleGateway, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {account as metaAccount, gateway as metaGateway, metaTime} from './helpers/meta-reconcile-fixture.mjs';

/**
 * R2.5 M2, lead review S2-5: the Google and Meta lookups of a plain create (a campaign, ad set, ad, budget, ad group, asset group)
 * matched by name only. Item 1 of this package runs them unasked, so they must bind what the review froze. Google counted an object
 * REMOVED a long time ago (a name is free again once its object is removed), and neither provider looked at the parent: an ad set
 * "Broad" under another campaign, made in the same minutes (a multi-campaign launch repeats Broad, Retargeting and Ad 1 under several
 * parents), was found at index 0, and accepting it would let a plan create the next ads under another campaign's ad set.
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
const compile = (gateway, action, account, payload) =>
  applyExecutionRisk(compiler.compile(gateway, {action, account_id: account, payload, dry_run: true}, options));
const claimed = Date.parse('2026-10-10T10:00:00Z');
const ids = list => (list ?? []).map(x => x.id);

// ----- Google -----
const budgetAction = 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
  adGroupAction = 'google_ads_v23_ad_group_mutate_ad_groups';
const adGroupCreate = {name: 'Ad group 1', campaign: at('campaigns', '100'), status: 'PAUSED', type: 'SEARCH_STANDARD'};

test('probe D: a removed budget of the same name is not this create’s: the lost create appears not applied, and a live one is found', async () => {
  const f = googleReconcileFixture();
  try {
    f.row('campaign_budget', {resource_name: at('campaignBudgets', '42'), name: 'Relaunch budget', status: 'REMOVED'});
    const create = {name: 'Relaunch budget', amount_micros: '5000000', delivery_method: 'STANDARD'};
    const {id} = await f.lose(budgetAction, {operations: [{create}]}, {applied: false});
    f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind='write_reconcile' AND state='queued'").run();
    assert.equal(await f.worker.once(), true);
    const status = await f.call('amcp_write', {action: 'status', review_id: id});
    assert.equal(
      status.data.reconciliation.classification,
      'appears_not_applied',
      JSON.stringify(status.data.reconciliation),
    );
    assert.equal(status.data.reconciliation.observed_ids, undefined);
    assert.match(
      f.queries.filter(q => q.includes('FROM campaign_budget')).at(-1),
      /campaign_budget\.status != 'REMOVED'/,
    );
    // The same create applied is found, beside the removed one.
    const g = googleReconcileFixture();
    try {
      g.row('campaign_budget', {
        resource_name: at('campaignBudgets', '42'),
        name: 'Relaunch budget',
        status: 'REMOVED',
      });
      const lost = await g.lose(budgetAction, {operations: [{create}]}, {applied: true});
      const r = await g.call('amcp_write', {action: 'reconcile', review_id: lost.id});
      assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data));
      assert.deepEqual(r.data.observed_ids, [g.db.campaign_budget.find(row => row.status !== 'REMOVED').resource_name]);
    } finally {
      g.close();
    }
  } finally {
    f.close();
  }
});

test('a Google ad group of the same name under another campaign is not this create’s; the one under its own campaign is', async () => {
  const f = googleReconcileFixture();
  try {
    f.row('campaign', {resource_name: at('campaigns', '100'), name: 'Mine', status: 'PAUSED'});
    f.row('ad_group', {
      resource_name: at('adGroups', '7000'),
      name: 'Ad group 1',
      status: 'ENABLED',
      campaign: at('campaigns', '999'),
    });
    const {id} = await f.lose(adGroupAction, {operations: [{create: adGroupCreate}]}, {applied: false});
    const absent = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(absent.data.classification, 'appears_not_applied', JSON.stringify(absent.data));
    assert.match(
      f.queries.filter(q => q.includes('FROM ad_group')).at(-1),
      /ad_group\.campaign IN \('customers\/123\/campaigns\/100'\)/,
    );
    const g = googleReconcileFixture();
    try {
      g.row('campaign', {resource_name: at('campaigns', '100'), name: 'Mine', status: 'PAUSED'});
      g.row('ad_group', {
        resource_name: at('adGroups', '7000'),
        name: 'Ad group 1',
        status: 'ENABLED',
        campaign: at('campaigns', '999'),
      });
      const lost = await g.lose(adGroupAction, {operations: [{create: adGroupCreate}]}, {applied: true});
      const r = await g.call('amcp_write', {action: 'reconcile', review_id: lost.id});
      assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data));
      assert.deepEqual(r.data.observed_ids, [
        g.db.ad_group.find(row => row.campaign === at('campaigns', '100')).resource_name,
      ]);
    } finally {
      g.close();
    }
  } finally {
    f.close();
  }
});

test('a Google answer that holds another campaign’s ad group of the name is not trusted to have been filtered: it is not this create’s', () => {
  const lookup = findCreated(compile(googleGateway, adGroupAction, '123', {operations: [{create: adGroupCreate}]}), {
    state: [],
    claimedAt: claimed,
  });
  assert.ok(lookup, 'a named ad group create has a lookup');
  const row = (n, campaign) => ({adGroup: {resourceName: at('adGroups', n), name: 'Ad group 1', campaign}});
  const match = rows => lookup.match([{status: 200, headers: {}, data: {results: rows}}], claimed);
  assert.deepEqual(ids(match([row('1', at('campaigns', '999'))]).found), [], 'another campaign’s');
  assert.deepEqual(ids(match([row('2', at('campaigns', '100'))]).found), [at('adGroups', '2')], 'its own campaign’s');
});
// ----- Meta -----
const metaLookup = (path, body) =>
  findCreated(
    compile(
      metaGateway,
      path.endsWith('adsets') ? 'meta_ad_account_id_adsets_create' : 'meta_ad_account_id_ads_create',
      metaAccount,
      body,
    ),
    {state: [], claimedAt: claimed},
  );
const page = rows => [{status: 200, headers: {}, data: {data: rows}}];

test('probe G: a Meta ad set of the same name under another campaign, made in the same minutes, is not this create’s', () => {
  const lookup = metaLookup('adsets', {name: 'Broad', campaign_id: '111', status: 'PAUSED'});
  assert.ok(lookup, 'an ad set create has a lookup');
  assert.match(lookup.reads[0].query.fields, /campaign_id/, 'the lookup asks for the parent');
  const row = (id, extra = {}) => ({
    id,
    name: 'Broad',
    created_time: metaTime(claimed + 60000),
    status: 'PAUSED',
    ...extra,
  });
  assert.deepEqual(
    ids(lookup.match(page([row('999', {campaign_id: '222'})]), claimed).found),
    [],
    'another campaign’s ad set',
  );
  const other = lookup.match(page([row('999', {campaign_id: '222'})]), claimed);
  assert.deepEqual(
    [other.found.length, (other.undated ?? []).length, other.complete],
    [0, 0, true],
    'it is no doubt either: it is plainly another’s',
  );
  assert.deepEqual(
    ids(lookup.match(page([row('1', {campaign_id: '111'})]), claimed).found),
    ['1'],
    'its own campaign’s',
  );
  const unknown = lookup.match(page([row('2')]), claimed);
  assert.deepEqual(
    [ids(unknown.found), ids(unknown.undated)],
    [[], ['2']],
    'a row that does not name its parent is a doubt',
  );
});

test('a Meta ad of the same name under another ad set is not this create’s', () => {
  const lookup = metaLookup('ads', {name: 'Ad 1', adset_id: '20', creative: {creative_id: '30'}, status: 'PAUSED'});
  assert.ok(lookup, 'an ad create has a lookup');
  assert.match(lookup.reads[0].query.fields, /adset_id/);
  const row = (id, extra = {}) => ({
    id,
    name: 'Ad 1',
    created_time: metaTime(claimed + 5000),
    status: 'PAUSED',
    ...extra,
  });
  assert.deepEqual(ids(lookup.match(page([row('9', {adset_id: '21'})]), claimed).found), []);
  assert.deepEqual(ids(lookup.match(page([row('8', {adset_id: '20'})]), claimed).found), ['8']);
});
