import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {findCreated} from '../dist/src/write-reconciliation.js';
import {at, gateway, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';

/**
 * R2.5 M2, lead review S2-4: a lookup never answers "absent" from a capped read. Google answers a search capped by its LIMIT with
 * no page token, so "no next page" does not say the answer is whole: a build whose name search met 100 other ad groups of the same
 * name (they repeat across campaigns) answered "not found" and offered a replacement that would have duplicated the ad group and its
 * keyword (probe A). The parent the review froze is in the query where it is an existing resource, and an answer with as many rows
 * as its LIMIT is not whole: it settles nothing.
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
  applyExecutionRisk(compiler.compile(gateway, {action, account_id: '123', payload, dry_run: true}, options));
const claimed = Date.parse('2026-10-10T10:00:00Z');
const adGroupBuild = {
  mutate_operations: [
    {
      ad_group_operation: {
        create: {
          resource_name: at('adGroups', '-3'),
          name: 'Ad group 1',
          campaign: at('campaigns', '100'),
          status: 'PAUSED',
          type: 'SEARCH_STANDARD',
          cpc_bid_micros: '1500000',
        },
      },
    },
    {
      ad_group_criterion_operation: {
        create: {ad_group: at('adGroups', '-3'), keyword: {text: 'acme', match_type: 'EXACT'}, status: 'ENABLED'},
      },
    },
  ],
};
const seedAccount = f => {
  f.row('campaign_budget', {resource_name: at('campaignBudgets', '10'), name: 'Existing budget', status: 'ENABLED'});
  f.row('campaign', {
    resource_name: at('campaigns', '100'),
    name: 'Existing campaign',
    status: 'PAUSED',
    advertising_channel_type: 'SEARCH',
    campaign_budget: at('campaignBudgets', '10'),
  });
  // Google's own default names repeat across campaigns: 100 other ad groups are named alike.
  for (let i = 0; i < 100; i++)
    f.row('ad_group', {
      resource_name: at('adGroups', String(7000 + i)),
      name: 'Ad group 1',
      status: 'ENABLED',
      campaign: at('campaigns', String(9000 + i)),
    });
};

test('probe A: a build that added an ad group to an existing campaign is found beside 100 other ad groups of the same name', async () => {
  const f = googleReconcileFixture();
  try {
    seedAccount(f);
    const {id, refused} = await f.lose('google_ads_v23_google_ads_mutate', adGroupBuild, {applied: true});
    assert.equal(refused.error?.code, 'WRITE_OUTCOME_UNCERTAIN');
    const made = f.db.ad_group.filter(r => r.campaign === at('campaigns', '100'));
    assert.equal(made.length, 1, 'the ad group exists in the existing campaign');
    const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data));
    assert.deepEqual(r.data.observed_ids, [made[0].resource_name]);
    // The search asked for the parent the review froze, not for every ad group of the name.
    const search = f.queries.filter(q => q.includes('FROM ad_group')).at(-1);
    assert.match(search, /ad_group\.campaign IN \('customers\/123\/campaigns\/100'\)/);
    assert.equal(f.writes.length, 1, 'nothing was sent again');
  } finally {
    f.close();
  }
});

test('a build whose ad group is absent is absent: the parent in the query makes the answer small and whole', async () => {
  const f = googleReconcileFixture();
  try {
    seedAccount(f);
    const {id} = await f.lose('google_ads_v23_google_ads_mutate', adGroupBuild, {applied: false});
    const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(r.data.classification, 'appears_not_applied', JSON.stringify(r.data));
    assert.equal(r.data.reason, 'not_found');
  } finally {
    f.close();
  }
});

test('an answer with as many rows as its LIMIT is not whole, for a build and for a named create alike', () => {
  const row = (entity, n, extra = {}) => ({
    [entity]: {
      resourceName: 'customers/123/' + entity + 's/' + n,
      name: 'Ad group 1',
      campaign: at('campaigns', String(n)),
      ...extra,
    },
  });
  const answer = results => [{status: 200, headers: {}, data: {results}}];
  // However the ad groups of the name were asked for, as many rows as the LIMIT may be the first of more.
  const build = findCreated(compile('google_ads_v23_google_ads_mutate', adGroupBuild), {state: [], claimedAt: claimed});
  assert.ok(build, 'a build has a lookup');
  const rows = n => Array.from({length: n}, (_, i) => row('adGroup', i));
  assert.equal(
    build.match(answer(rows(100)), claimed).complete,
    false,
    'as many rows as the LIMIT: the right one may be the next',
  );
  assert.equal(build.match(answer(rows(99)), claimed).complete, true, 'fewer rows: the answer is whole');
  const named = findCreated(
    compile('google_ads_v23_ad_group_mutate_ad_groups', {
      operations: [
        {create: {name: 'Ad group 1', campaign: at('campaigns', '100'), status: 'PAUSED', type: 'SEARCH_STANDARD'}},
      ],
    }),
    {state: [], claimedAt: claimed},
  );
  assert.ok(named, 'a named ad group create has a lookup');
  const normalized = n =>
    Array.from({length: n}, (_, i) => ({adGroup: {resourceName: 'customers/123/adGroups/' + i, name: 'Ad group 1'}}));
  assert.equal(named.match(answer(normalized(100)), claimed).complete, false);
  assert.equal(named.match(answer(normalized(99)), claimed).complete, true);
});
