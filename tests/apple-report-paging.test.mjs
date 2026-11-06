import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateCollectionRequests} from '../dist/src/report-request-estimate.js';
import {detailParentsUnavailableWarning} from '../dist/src/overview-parents.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {appleAccount, campaignOf, groupOf, adOf, spendOf} from './helpers/apple-ads.mjs';

// V2-RPT-07 Task 13 / F-L7-02, over an account that answers as Apple's pages show (tests/helpers/apple-ads.mjs): the ad
// group and ad reports of a campaign need its campaign ID, a report and an entity query page by offset with the total beside
// `result`, and a page holds at most the rows the server chooses. Before, the ad group and ad levels sent one report with
// no campaign filter, read a single page of 1,000 rows, refused at 1,000 rows, and asked for parents with a total field no
// Apple page names.
const cents = text => {
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
};
const ids = rows => rows.map(row => row.entity_id);
const pages = reads => reads.map(read => read.body.pagination);
const filterOf = read => read.body.filters;

test('each campaign with activity is read on its own with the campaign ID the report requires; an idle one is not read', async t => {
  const a = appleAccount({campaigns: 3, groups: 2, idle: i => i === 1});
  t.after(() => a.close());
  const result = await a.collect('adset');
  assert.deepEqual(a.violations, [], 'the account never saw a request Apple’s pages forbid');
  assert.equal(a.reads('report:campaigns').length, 1);
  assert.deepEqual(a.reads('report:campaigns')[0].body.filters ?? [], []);
  assert.deepEqual(
    a.reads('report:adgroups').map(filterOf),
    [campaignOf(0), campaignOf(2)].map(id => [{field: 'campaignId', operator: 'EQUALS', value: String(id)}]),
  );
  assert.deepEqual(ids(result.rows), [groupOf(0, 0), groupOf(0, 1), groupOf(2, 0), groupOf(2, 1)].map(String));
  assert.deepEqual(result.rows[0].parent_ids, {campaign_id: String(campaignOf(0)), campaign_name: 'Campaign 0'});
  assert.equal(result.rows[0].entity_name, 'Group 0.0');
  assert.equal(result.complete, true);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(result.quality.population).filter(([key]) =>
        ['basis', 'campaigns_observed', 'rows', 'complete'].includes(key),
      ),
    ),
    {basis: 'campaign_report', campaigns_observed: 2, rows: 4, complete: true},
  );
});

for (const [level, shape] of [
  ['adset', {campaigns: 1, groups: 2500}],
  ['ad', {campaigns: 1, groups: 50, ads: 50}],
])
  test(
    '2,500 ' + (level === 'ad' ? 'ads' : 'ad groups') + ' are read over three pages, none twice and none missed',
    async t => {
      const a = appleAccount(shape);
      t.after(() => a.close());
      const result = await a.collect(level),
        entity = level === 'ad' ? 'ads' : 'adgroups';
      assert.deepEqual(a.violations, []);
      assert.deepEqual(pages(a.reads('report:' + entity)), [
        {offset: 0, pageSize: 1000},
        {offset: 1000, pageSize: 1000},
        {offset: 2000, pageSize: 1000},
      ]);
      assert.equal(result.rows.length, 2500);
      assert.equal(new Set(ids(result.rows)).size, 2500);
      assert.equal(result.complete, true);
      // The exact additive total is the account’s own.
      let expected = 0n;
      for (let k = 0; k < shape.groups; k++)
        for (let j = 0; j < (shape.ads ?? 1); j++) expected += cents(spendOf(level === 'ad' ? k + j : k));
      assert.equal(
        result.rows.reduce((sum, row) => sum + cents(row.native.exact_totals.spend), 0n),
        expected,
      );
      // The parents of every row are read in batches of at most 1,000 IDs, each batch paged under its own total.
      const parents = a.reads('query:' + (level === 'ad' ? 'ads' : 'adgroups'));
      assert.deepEqual(
        parents.map(read => filterOf(read)[0].value.length),
        [1000, 1000, 500],
      );
      for (const read of parents)
        assert.deepEqual(read.body.pagination, {offset: 0, pageSize: 1000, fetchTotalCount: true});
      assert.ok(result.rows.every(row => row.parent_ids.campaign_id === String(campaignOf(0))));
      if (level === 'ad') assert.ok(result.rows.every(row => /^\d+$/.test(row.parent_ids.adset_id)));
    },
  );

for (const [name, options] of [
  ['a server that holds 700 report rows and 300 records a page', {cap: {report: 700, query: 300}}],
  ['a pagination object that echoes the rows returned', {cap: {report: 700, query: 300}, echo: 'returned'}],
])
  test(name + ' is followed to the total at the rows received', async t => {
    const a = appleAccount({campaigns: 1, groups: 2500, ...options});
    t.after(() => a.close());
    const result = await a.collect('adset');
    assert.deepEqual(a.violations, []);
    assert.deepEqual(
      pages(a.reads('report:adgroups')).map(page => page.offset),
      [0, 700, 1400, 2100],
    );
    assert.equal(result.rows.length, 2500);
    assert.equal(new Set(ids(result.rows)).size, 2500);
    // 1,000 IDs a batch, 300 records a page: four pages for each full batch.
    const offsets = a.reads('query:adgroups').map(read => read.body.pagination.offset);
    assert.deepEqual(offsets.slice(0, 4), [0, 300, 600, 900]);
    assert.equal(
      result.rows.filter(row => row.parent_ids.campaign_id === String(campaignOf(0))).length,
      2500,
      'every row has its parent although the records came in short pages',
    );
    assert.equal(result.rows[2499].entity_name, 'Group 0.2499');
  });

for (const total of ['absent', 'results'])
  test(
    total === 'absent'
      ? 'lists with no total are read to an empty page'
      : 'a count under a name no Apple page uses is not a total, so the lists are read to an empty page',
    async t => {
      const a = appleAccount({campaigns: 1, groups: 2500, total});
      t.after(() => a.close());
      const result = await a.collect('adset');
      assert.deepEqual(a.violations, []);
      assert.deepEqual(
        pages(a.reads('report:adgroups')).map(page => page.offset),
        [0, 1000, 2000, 2500],
        'the last request is the empty page that proves the end',
      );
      assert.equal(result.rows.length, 2500);
      assert.equal(result.complete, true);
      assert.equal(a.reads('query:adgroups').length, 2 * 3, 'each of the three batches ends on its own empty page');
    },
  );

test('a campaign’s ad reports are filtered by the campaign and cover only its own ads', async t => {
  const a = appleAccount({campaigns: 3, groups: 3, ads: 2});
  t.after(() => a.close());
  const result = await a.collect('ad');
  assert.deepEqual(a.violations, []);
  assert.equal(a.reads('report:ads').length, 3);
  assert.equal(result.rows.length, 3 * 3 * 2);
  const row = result.rows.find(r => r.entity_id === String(adOf(2, 1, 1)));
  assert.deepEqual(row.parent_ids, {
    campaign_id: String(campaignOf(2)),
    campaign_name: 'Campaign 2',
    adset_id: String(groupOf(2, 1)),
    adset_name: 'Group 2.1',
  });
  assert.equal(row.entity_name, 'Ad 2.1.1');
});

test('a scope of campaign IDs reads those campaigns only, with no campaign report to find them', async t => {
  const a = appleAccount({campaigns: 8, groups: 2});
  t.after(() => a.close());
  const result = await a.collect('adset', {campaign_ids: [String(campaignOf(2)), String(campaignOf(5))]});
  assert.deepEqual(a.violations, []);
  assert.equal(a.reads('report:campaigns').length, 0);
  assert.deepEqual(
    a.reads('report:adgroups').map(filterOf),
    [campaignOf(2), campaignOf(5)].map(id => [{field: 'campaignId', operator: 'EQUALS', value: String(id)}]),
  );
  assert.equal(result.rows.length, 4);
  assert.equal(result.quality.population.basis, 'scope');
  assert.equal(result.quality.population.campaigns_observed, 2);
});

test('a hundred campaigns are read one at a time; a hundred and first is refused before any ad group report is sent', async t => {
  const hundred = appleAccount({campaigns: 100, groups: 1});
  t.after(() => hundred.close());
  const result = await hundred.collect('adset');
  assert.equal(result.rows.length, 100);
  assert.deepEqual(hundred.violations, []);
  assert.equal(hundred.requests.length, 1 + 1 + 100 + 2, 'the account, the campaigns, one report each, the parents');
  const more = appleAccount({campaigns: 101, groups: 1});
  t.after(() => more.close());
  const error = await more.collect('adset').then(
    () => undefined,
    e => e,
  );
  assertRefused(error, 'REPORT_COLLECTION_LIMIT', {
    status: 422,
    message: /covers 101 campaigns; the most a report reads is 100\./,
  });
  assert.match(error.message, /Choose fewer campaigns by campaign ID/, 'it names the remedy');
  assert.equal(more.reads('report:adgroups').length, 0);
  assert.deepEqual(more.violations, []);
});

test('rows past 10,000 across the campaigns refuse as soon as a list shows it, without reading its other pages', async t => {
  const a = appleAccount({campaigns: 3, groups: 4000});
  t.after(() => a.close());
  await assert.rejects(a.collect('adset'), e =>
    assertRefused(e, 'REPORT_COLLECTION_LIMIT', {message: /more than 10,000 ad groups/}),
  );
  const third = a.reads('report:adgroups').filter(read => filterOf(read)[0].value === String(campaignOf(2)));
  assert.equal(third.length, 1, 'the third campaign’s total (4,000) is more than what is left (2,000)');
});

for (const [name, tamper, message] of [
  [
    'another campaign than the one asked for',
    rows => (rows[0].metadata.campaignId = campaignOf(9)),
    /another campaign than the one requested/,
  ],
  ['another advertising account', rows => (rows[0].metadata.adAccountId = 999), /another advertising account/],
])
  test('a report row of ' + name + ' is refused', async t => {
    const a = appleAccount({
      campaigns: 2,
      groups: 2,
      tamper: (where, _body, response) => {
        if (where === 'report:adgroups') tamper(response.result.rows);
        return response;
      },
    });
    t.after(() => a.close());
    await assert.rejects(a.collect('adset'), e => assertRefused(e, 'REPORT_ACCOUNT_MISMATCH', {message}));
  });

test('a parent read Apple refuses leaves the rows with unknown parents and says so', async t => {
  const a = appleAccount({
    campaigns: 1,
    groups: 3,
    tamper: (where, _body, response) =>
      where === 'query:adgroups'
        ? Response.json({error: {errors: [{messageCode: 'FORBIDDEN'}]}}, {status: 403})
        : response,
  });
  t.after(() => a.close());
  const result = await a.collect('adset');
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows[0].parent_ids, {});
  assert.ok(result.warnings.includes(detailParentsUnavailableWarning));
});

test('a v4 campaign report names the metadata of more than 1,000 campaigns, read in batches', async t => {
  const a = appleAccount({campaigns: 1200});
  t.after(() => a.close());
  const result = await a.collect('campaign');
  assert.deepEqual(a.violations, []);
  assert.equal(result.rows.length, 1200);
  const batches = a.reads('query:campaigns');
  assert.deepEqual(
    batches.map(read => filterOf(read)[0].value.length),
    [1000, 200],
  );
  for (const read of batches)
    assert.deepEqual(read.body.pagination, {offset: 0, pageSize: 1000, fetchTotalCount: true});
  assert.equal(
    result.rows.filter(row => row.native.entity_metadata?.id !== undefined).length,
    1200,
    'every campaign past the first thousand has its metadata too',
  );
});

test('the queue-time estimate follows the campaigns a scope names, and an unscoped estimate says it is a lower bound', async t => {
  const a = appleAccount({campaigns: 6, groups: 1, ads: 1});
  t.after(() => a.close());
  // The estimate of the stored configuration, as the queue makes it before any egress.
  const entry = async (level, changes) => {
    const {queued, report} = await a.run(level, changes);
    assert.equal(report.state, 'complete', JSON.stringify(report.sources));
    const found = estimateCollectionRequests(report.config).sources.find(source => source.platform === 'apple');
    assert.equal(queued.estimated_requests, found.requests, 'the queue and the estimate agree');
    return found;
  };
  const scope = [0, 1, 2, 3, 4].map(i => String(campaignOf(i)));
  // The account, one report a campaign, and the parents: ad groups and campaigns, or ads, ad groups and campaigns.
  const scopedGroups = await entry('adset', {campaign_ids: scope}),
    scopedAds = await entry('ad', {campaign_ids: scope});
  assert.equal(scopedGroups.requests, 1 + 5 + 2);
  assert.equal(scopedAds.requests, 1 + 5 + 3);
  assert.equal(scopedGroups.lower_bound, undefined);
  // Unscoped: the campaign report too, and one campaign assumed, as the size of the account is not known yet.
  const groups = await entry('adset'),
    ads = await entry('ad'),
    campaigns = await entry('campaign');
  assert.equal(groups.requests, 1 + 1 + 1 + 2);
  assert.equal(ads.requests, 1 + 1 + 1 + 3);
  assert.equal(groups.lower_bound, true);
  assert.equal(ads.lower_bound, true);
  assert.equal(campaigns.lower_bound, undefined);
  assert.equal(campaigns.requests, 3);
});

test('through the queue, an account of thirty campaigns costs a request each and a handful; a weekly grain repeats it by period', async t => {
  const a = appleAccount({campaigns: 30, groups: 2});
  t.after(() => a.close());
  const total = await a.run('adset');
  assert.equal(total.report.state, 'complete', JSON.stringify(total.report.sources));
  assert.equal(total.report.rows.length, 60);
  assert.equal(a.requests.length, 1 + 1 + 30 + 2);
  assert.equal(total.queued.estimated_requests, 5, 'the queue-time figure is a lower bound');
  const population = total.report.sources[0].quality.population;
  assert.equal(population.campaigns_observed, 30);
  assert.equal(population.report_pages, 1 + 30);
  assert.equal(population.parent_pages, 2);
  assert.deepEqual(a.violations, []);
  const before = a.requests.length,
    // Two calendar weeks, Monday 3 to Sunday 16 August 2026.
    weekly = await a.run('adset', {grain: 'weekly', range: {since: '2026-08-03', until: '2026-08-16'}});
  assert.equal(weekly.report.state, 'complete', JSON.stringify(weekly.report.sources));
  assert.equal(weekly.report.rows.length, 2 * 60);
  assert.equal(a.requests.length - before, 2 * (1 + 1 + 30 + 2), 'each calendar week reads the account again');
});
