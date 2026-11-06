import test from 'node:test';
import assert from 'node:assert/strict';
import {tiktokReportSource} from '../dist/src/tiktok-report-source.js';

/**
 * The campaign report source's management reads (audit note N8): the campaign inventory that names each row's
 * objective, and the ad group read that names each campaign's optimization events.
 */
const page = list => ({
  code: 0,
  data: {list, page_info: {page: 1, page_size: 1000, total_number: list.length, total_page: 1}},
});
const reportRow = id => ({
  dimensions: {campaign_id: String(id)},
  metrics: {campaign_name: 'Campaign ' + id, spend: '1', impressions: '10', clicks: '2', conversion: '1'},
});
/** The collection context the source reads; `read(plan)` answers each provider read. */
function collection({report, inventory = [], adgroups = [], respond}) {
  const plans = [];
  const c = {
    account: '100',
    connection: 'login',
    source: {platform: 'tiktok'},
    range: {since: '2026-09-01', until: '2026-09-01'},
    extra: [],
    warnings: [],
    lineage: [],
    context: {},
    lookup: {},
    raw: [],
    complete: true,
    collectionComplete: true,
    plan: (path, query) => ({path, query}),
    run: async plan => {
      plans.push(plan);
      if (plan.path === '/v1.3/report/integrated/get/') return page(report);
      if (plan.path === '/v1.3/campaign/get/') return page(inventory);
      if (plan.path === '/v1.3/adgroup/get/') return respond ? respond(plan) : page(adgroups);
      throw Error('Unexpected route ' + plan.path);
    },
  };
  return {c, plans};
}

test('the ad group events read includes deleted ad groups, so a campaign that spent on two events is mixed (N8)', async () => {
  // STATUS_ALL brings deleted campaigns' spend into the report, so their ad groups must name their events too.
  const live = {
      adgroup_id: '10',
      campaign_id: '1',
      optimization_goal: 'CONVERT',
      optimization_event: 'COMPLETE_PAYMENT',
    },
    deleted = {adgroup_id: '11', campaign_id: '1', optimization_goal: 'CONVERT', optimization_event: 'ADD_TO_CART'},
    read = plan => page(plan.query.filtering?.primary_status === 'STATUS_ALL' ? [live, deleted] : [live]),
    {c, plans} = collection({
      report: [reportRow(1)],
      inventory: [{campaign_id: '1', objective_type: 'WEB_CONVERSIONS'}],
      respond: read,
    });
  await tiktokReportSource.collect(c);
  const request = plans.find(plan => plan.path === '/v1.3/adgroup/get/');
  assert.deepEqual(request.query.filtering, {primary_status: 'STATUS_ALL'});
  assert.deepEqual(c.raw[0].optimization_events, ['CONVERT / ADD_TO_CART', 'CONVERT / COMPLETE_PAYMENT']);
  const row = tiktokReportSource.normalize(c.raw[0], {value: v => v});
  assert.equal(row.mixedResult, true, 'two events are never added into one result');
});

test('every campaign row finds its inventory entry through one lookup, first entry first (N8)', async () => {
  // 300 report rows against a 300-entry inventory: scanning the inventory for each row reads ~45,000 ids.
  let reads = 0;
  const entry = (id, objective) => ({
    get campaign_id() {
      reads++;
      return String(id);
    },
    objective_type: objective,
  });
  const ids = Array.from({length: 300}, (_, i) => i + 1),
    inventory = [...ids.map(id => entry(id, 'TRAFFIC')), entry(7, 'REACH')],
    {c} = collection({report: ids.map(reportRow), inventory});
  await tiktokReportSource.collect(c);
  assert.ok(reads <= 4 * inventory.length, 'inventory ids read ' + reads + ' times');
  assert.equal(c.raw.length, 300);
  assert.ok(
    c.raw.every(row => row.objective_type === 'TRAFFIC'),
    'a repeated id keeps the first entry',
  );
  // An id the inventory holds as a number still names its row's objective, as String comparison always did.
  const numeric = collection({
    report: [reportRow(5)],
    inventory: [{campaign_id: 5, objective_type: 'LEAD_GENERATION'}],
  });
  await tiktokReportSource.collect(numeric.c);
  assert.equal(numeric.c.raw[0].objective_type, 'LEAD_GENERATION');
  const unknown = collection({report: [reportRow(9)], inventory: [{campaign_id: '8', objective_type: 'REACH'}]});
  await tiktokReportSource.collect(unknown.c);
  assert.equal(unknown.c.raw[0].objective_type, undefined, 'a campaign missing from the inventory has no objective');
});
