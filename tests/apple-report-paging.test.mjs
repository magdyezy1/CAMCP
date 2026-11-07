import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateCollectionRequests} from '../dist/src/report-request-estimate.js';
import {detailParentsUnavailableWarning} from '../dist/src/overview-parents.js';
import {ReportCollectionBudget, reportCollectionLimits} from '../dist/src/report-collection-budget.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {appleAccount, campaignOf, groupOf, adOf, spendOf} from './helpers/apple-ads.mjs';

// V2-RPT-07 Task 13 / F-L7-02, over an account that answers as Apple's pages show (tests/helpers/apple-ads.mjs): the ad
// group and ad reports of a campaign need its campaign ID, a report and an entity query page by offset with the total beside
// `result`, and a page holds at most the rows the server chooses. Before, the ad group and ad levels sent one report with
// no campaign filter, read a single page of 1,000 rows, refused at 1,000 rows, and asked for parents with a total field no
// Apple page names.
// The sentence a report says when the whole-job allowance ended before every campaign was read: the one Snapchat already says,
// which the website translates through its template. It is spelled out here, so that a changed sentence is a failing test.
const allowanceSentence = (read, total) =>
  read +
  ' of ' +
  total +
  ' campaigns read. The collection allowance for this report ended, so the other campaigns are not in it; the campaigns that were read are kept. Scope the report by campaign IDs to read the rest.';
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

// Package results (levels, found-not-fixed 2 and 3): a report of many campaigns costs a request each, and the whole-job
// allowance is the only bound on how many are read. Before, a hundred and first campaign was refused before any ad group
// report was sent.
test('more than a hundred campaigns are read one at a time: the whole-job allowance is their only bound', async t => {
  const a = appleAccount({campaigns: 150, groups: 1});
  t.after(() => a.close());
  const result = await a.collect('adset');
  assert.equal(result.rows.length, 150);
  assert.equal(result.complete, true);
  assert.deepEqual(a.violations, []);
  assert.equal(a.requests.length, 1 + 1 + 150 + 2, 'the account, the campaigns, one report each, the parents');
  const population = result.quality.population;
  assert.equal(population.campaigns_observed, 150);
  assert.equal(population.campaigns_collected, 150);
  assert.equal(population.collection_complete, true);
  assert.equal(population.stopped, undefined);
  assert.equal(Object.hasOwn(population.bounds, 'campaigns'), false, 'no bound of its own on campaigns');
  assert.deepEqual(Object.keys(population.bounds).sort(), ['ids_per_query', 'page_size', 'pages', 'rows']);
});

// The whole-job allowance (src/report-collection-budget.ts) is what a report of an account of any size runs inside. These
// run the collector inside a smaller one, so the end of it can be reached with a handful of campaigns.
const allowance = (limits, now) =>
  new ReportCollectionBudget(
    undefined,
    'synthetic-apple-definition',
    () => {},
    {...reportCollectionLimits, ...limits},
    now,
  );
const stoppedOf = result => {
  const {collection_complete, campaigns_observed, campaigns_collected, stopped} = result.quality.population;
  return {collection_complete, campaigns_observed, campaigns_collected, stopped};
};

for (const [level, shape, read] of [
  // Request budget 12: the account and the campaign report, then a report each, and the parent reads that must still fit:
  // ad groups and campaigns (2), or ads, ad groups and campaigns (3).
  ['adset', {campaigns: 30, groups: 2}, 8],
  ['ad', {campaigns: 30, groups: 1, ads: 1}, 7],
])
  test(
    'an allowance that ends part-way returns the ' + level + ' campaigns it finished as partial, with every parent',
    async t => {
      const a = appleAccount(shape);
      t.after(() => a.close());
      const result = await allowance({requests: 12}).run(() => a.collect(level));
      assert.deepEqual(a.violations, []);
      assert.equal(a.requests.length, 12, 'the allowance is used to its last request and not past it');
      assert.equal(a.reads('report:' + (level === 'ad' ? 'ads' : 'adgroups')).length, read);
      // Partial, never complete and never failed; the campaigns read are kept whole.
      assert.equal(result.complete, false);
      assert.equal(result.collection_complete, false);
      assert.equal(result.rows.length, read * (shape.groups ?? 1) * (level === 'ad' ? shape.ads : 1));
      assert.ok(result.warnings.includes(allowanceSentence(read, 30)), JSON.stringify(result.warnings));
      assert.deepEqual(stoppedOf(result), {
        collection_complete: false,
        campaigns_observed: 30,
        campaigns_collected: read,
        stopped: {campaigns_read: read, campaigns_selected: 30, dimension: 'requests'},
      });
      // The allowance left room for the parents of what was read, so no row lost them.
      assert.equal(result.warnings.includes(detailParentsUnavailableWarning), false);
      assert.ok(
        result.rows.every(row => row.parent_ids.campaign_id && /^Campaign /.test(row.parent_ids.campaign_name)),
      );
      assert.ok(result.rows.every(row => /^(Group|Ad) /.test(row.entity_name)));
    },
  );

test('an allowance with room for one campaign reads it, keeps its rows, and says the parents could not be read', async t => {
  const a = appleAccount({campaigns: 30, groups: 2});
  t.after(() => a.close());
  // The account, the campaign report and the first campaign: nothing is left for the parents.
  const result = await allowance({requests: 3}).run(() => a.collect('adset'));
  assert.equal(a.requests.length, 3);
  assert.equal(result.rows.length, 2);
  assert.equal(result.complete, false);
  assert.ok(result.warnings.includes(allowanceSentence(1, 30)));
  assert.ok(result.warnings.includes(detailParentsUnavailableWarning));
  // The campaign is the one the report row itself names; its name and the ad group records are what could not be read.
  assert.deepEqual(result.rows[0].parent_ids, {campaign_id: String(campaignOf(0)), campaign_name: null});
});

test('an allowance that cannot pay for even the first campaign is the real limit error, not an empty report', async t => {
  const a = appleAccount({campaigns: 30, groups: 2});
  t.after(() => a.close());
  await assert.rejects(
    allowance({requests: 2}).run(() => a.collect('adset')),
    e => assertRefused(e, 'REPORT_COLLECTION_LIMIT', {status: 422}) && e.details.dimension === 'requests',
  );
  assert.equal(a.reads('report:adgroups').length, 0);
});

test('a time allowance that ends inside the campaigns keeps the campaigns finished, as partial', async t => {
  let clock = 0;
  // Each answered report or query takes 30 ms of the 100 the whole job may use. The third campaign's answer arrives after the
  // allowance has ended, so that campaign is dropped whole and two are kept.
  const a = appleAccount({
    campaigns: 30,
    groups: 1,
    tamper: (_where, _body, response) => {
      clock += 30;
      return response;
    },
  });
  t.after(() => a.close());
  const result = await allowance({elapsed_ms: 100}, () => clock).run(() => a.collect('adset'));
  assert.equal(result.complete, false);
  assert.deepEqual(stoppedOf(result), {
    collection_complete: false,
    campaigns_observed: 30,
    campaigns_collected: 2,
    stopped: {campaigns_read: 2, campaigns_selected: 30, dimension: 'elapsed_ms'},
  });
  assert.equal(result.rows.length, 2);
  assert.ok(result.warnings.includes(allowanceSentence(2, 30)));
  assert.ok(
    result.warnings.includes(detailParentsUnavailableWarning),
    'the ended allowance cannot pay for the parents',
  );
});

test('through the queue, an account too large for the whole-job allowance ends partial with the campaigns it read', async t => {
  const a = appleAccount({campaigns: 1250, groups: 1});
  t.after(() => a.close());
  const {report} = await a.run('adset');
  assert.equal(report.state, 'partial', JSON.stringify(report.sources));
  assert.equal(report.sources[0].error, undefined);
  const population = report.sources[0].quality.population,
    warning = report.sources[0].level_results[0].warnings.find(text => / campaigns read\./.test(text));
  assert.equal(population.collection_complete, false);
  assert.equal(population.campaigns_observed, 1250);
  assert.ok(
    population.campaigns_collected > 1000 && population.campaigns_collected < 1250,
    String(population.campaigns_collected),
  );
  assert.equal(warning, allowanceSentence(population.campaigns_collected, 1250));
  assert.equal(report.row_count, population.campaigns_collected);
  assert.ok(a.requests.length <= 1200, 'never past the allowance: ' + a.requests.length);
  assert.deepEqual(a.violations, []);
});

// Package results (levels, found-not-fixed 1): the entity queries leave a deleted ad group or ad out (Q3), but its report row
// names its own campaign and, for an ad, its ad group (R5), so the row keeps those parents and a campaign scope keeps the row.
test('a deleted ad group keeps its campaign from its own report row, and a campaign scope keeps it', async t => {
  const deletedGroup = (kind, i, k) => kind === 'adgroup' && i === 0 && k === 1,
    a = appleAccount({campaigns: 2, groups: 3, deleted: deletedGroup});
  t.after(() => a.close());
  const result = await a.collect('adset'),
    gone = result.rows.find(row => row.entity_id === String(groupOf(0, 1)));
  assert.ok(gone, 'the deleted ad group has report rows');
  assert.deepEqual(gone.parent_ids, {campaign_id: String(campaignOf(0)), campaign_name: 'Campaign 0'});
  assert.equal(gone.entity_name, 'Group 0.1', 'named by its own report row');
  // The ones the account still holds are unchanged.
  assert.deepEqual(result.rows.find(row => row.entity_id === String(groupOf(0, 0))).parent_ids, gone.parent_ids);
  // A campaign scope selects by the campaign the parents name: the deleted ad group is in the report, not dropped as unknown.
  const scoped = await a.run('adset', {campaign_ids: [String(campaignOf(0))]});
  assert.equal(scoped.report.state, 'complete', JSON.stringify(scoped.report.sources));
  assert.deepEqual(
    scoped.report.rows.map(row => row.entity_id).sort(),
    [groupOf(0, 0), groupOf(0, 1), groupOf(0, 2)].map(String),
  );
  assert.equal(scoped.report.sources[0].level_results[0].scope.excluded_unknown_rows, 0);
});

test('a deleted ad keeps its campaign and its ad group from its own report row', async t => {
  // The ad (0, 1, 1) is deleted; the ad group (0, 2) is deleted with its ad (0, 2, 0).
  const a = appleAccount({
    campaigns: 1,
    groups: 3,
    ads: 2,
    deleted: (kind, i, k, j) =>
      (kind === 'ad' && i === 0 && ((k === 1 && j === 1) || k === 2)) || (kind === 'adgroup' && i === 0 && k === 2),
  });
  t.after(() => a.close());
  const result = await a.collect('ad'),
    parentsOf = ad => result.rows.find(row => row.entity_id === String(ad)).parent_ids,
    campaign = {campaign_id: String(campaignOf(0)), campaign_name: 'Campaign 0'};
  assert.deepEqual(parentsOf(adOf(0, 1, 1)), {
    ...campaign,
    adset_id: String(groupOf(0, 1)),
    adset_name: 'Group 0.1',
  });
  // Its ad group is deleted too: the ad group is still the one the ad row names, with no name to give.
  assert.deepEqual(parentsOf(adOf(0, 2, 0)), {...campaign, adset_id: String(groupOf(0, 2)), adset_name: null});
  assert.deepEqual(parentsOf(adOf(0, 0, 0)), {
    ...campaign,
    adset_id: String(groupOf(0, 0)),
    adset_name: 'Group 0.0',
  });
  assert.equal(result.rows.length, 6);
});

test('a record that names another campaign than the report row does is refused, not preferred', async t => {
  const a = appleAccount({
    campaigns: 2,
    groups: 2,
    tamper: (where, _body, response) => {
      if (where === 'query:adgroups') response.result[0].campaignId = campaignOf(1);
      return response;
    },
  });
  t.after(() => a.close());
  await assert.rejects(a.collect('adset'), e =>
    assertRefused(e, 'REPORT_ACCOUNT_MISMATCH', {message: /changed native parents/}),
  );
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
  // Package results: a row also names its own campaign (R5), so a refused parent read leaves the campaign ID, not nothing;
  // the names and the ad group records are what stay unknown. This assertion read {} before.
  assert.deepEqual(result.rows[0].parent_ids, {campaign_id: String(campaignOf(0)), campaign_name: null});
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

test('an account with no activity in the window is a complete empty report after the campaign report', async t => {
  const a = appleAccount({campaigns: 3, groups: 2, idle: () => true});
  t.after(() => a.close());
  const result = await a.collect('adset');
  assert.deepEqual(result.rows, []);
  assert.equal(result.complete, true);
  assert.equal(a.requests.length, 2, 'the account and the campaign report, nothing else');
  assert.equal(result.quality.population.campaigns_observed, 0);
  assert.deepEqual(a.violations, []);
});

test('a campaign report Apple refuses fails the source; it is not an optional read', async t => {
  const a = appleAccount({
    campaigns: 2,
    tamper: (where, _body, response) =>
      where === 'report:campaigns'
        ? Response.json({error: {errors: [{messageCode: 'FORBIDDEN'}]}}, {status: 403})
        : response,
  });
  t.after(() => a.close());
  await assert.rejects(a.collect('adset'), e => e.status === 403 || e.details?.http_status === 403);
  assert.equal(a.reads('report:adgroups').length, 0);
});
