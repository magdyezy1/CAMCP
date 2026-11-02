import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {MirrorError} from '../dist/src/errors.js';
import {NativeCampaignReports} from '../dist/src/report-native.js';
import {DecisionReporting} from '../dist/src/decision-reporting.js';
import {reportPreset} from '../dist/src/report-presets.js';
import {collectTikTokDailyReport, tiktokDailyRange} from '../dist/src/tiktok-reporting.js';
import {
  tiktokDailySpans,
  tiktokStatusFilter,
  tiktokStatusFilterRefusedWarning,
} from '../dist/src/tiktok-report-request.js';

const dayMs = 86400000;
const actor = {tenantId: 'synthetic-tiktok-spans', userId: 'owner', role: 'admin'};
const connection = 'ffffffff-1111-4111-8111-111111111116';
const source = {platform: 'tiktok', account_id: '100', connection_id: connection};
const semantics = {
  currency: 'USD',
  timezone: 'Etc/GMT',
  date_from: '2026-07-01',
  date_to: '2026-09-03',
  complete: true,
  attribution: 'unknown',
  source_name: 'Synthetic spans',
};
function fixture(t, {refuseFilter = false, dash = false, otherFailure = false, inputFailure = false} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 117).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: connection,
      tenantId: actor.tenantId,
      gateway: 'tiktok_native_action',
      accounts: ['100'],
      scopes: [],
      enabled: true,
      label: 'Synthetic',
    },
    {accessToken: 'synthetic'},
  );
  const requests = [];
  const answer = (path, query) => {
    requests.push({path, query: structuredClone(query)});
    if (path.includes('/advertiser/info/'))
      return {code: 0, data: {list: [{advertiser_id: '100', currency: 'USD', timezone: 'Etc/GMT'}]}};
    if (!path.includes('/report/integrated/get/')) return {code: 0, data: {list: []}};
    if (otherFailure) throw new MirrorError('UPSTREAM_ERROR', 'The platform is unavailable.', {}, 503);
    if (inputFailure) throw new MirrorError('INVALID_ARGUMENT', 'Unknown filtering argument.');
    if (refuseFilter && query.filtering)
      throw new MirrorError('UPSTREAM_ERROR', 'Invalid filtering field_name campaign_status.', {http_status: 400}, 400);
    const field = query.dimensions[0];
    return {
      code: 0,
      data: {
        list: [
          {
            dimensions: {
              [field]: '1',
              ...(query.dimensions.includes('stat_time_day') ? {stat_time_day: query.start_date} : {}),
            },
            metrics: {
              campaign_name: 'Synthetic',
              spend: '1',
              impressions: '10',
              clicks: '2',
              conversion: dash ? '-' : '1',
            },
          },
        ],
        page_info: {page: query.page, page_size: query.page_size, total_number: 1, total_page: 1},
      },
    };
  };
  const call = async (_tool, args) => {
    try {
      return {
        success: true,
        data: {
          data: answer(
            args.action === 'tiktok_advertiser_info_get' ? '/advertiser/info/' : '/report/integrated/get/',
            args.query,
          ),
        },
      };
    } catch (error) {
      return {success: false, error: {code: error.code, message: error.message, details: error.details}};
    }
  };
  const service = {store, call, runPlan: async plan => ({success: true, data: answer(plan.path, plan.query)})};
  return {
    store,
    requests,
    call,
    native: new NativeCampaignReports(service),
    reporting: new DecisionReporting(store, call),
  };
}
const preset = (sem = semantics) => {
  const request = reportPreset({
    preset: 'tiktok_campaign',
    account_id: '100',
    connection_id: connection,
    semantics: sem,
  });
  // DecisionReporting binds these before calling its provider collector.
  Object.assign(request.arguments, {account_id: '100', connection_id: connection});
  return request;
};
const reportReads = f => f.requests.filter(request => request.path.includes('/report/integrated/get/'));

test('30-day spans cover leap days and month/year ends without a gap or overlap', () => {
  assert.deepEqual(tiktokDailySpans('2028-02-01', '2028-03-31'), [
    {from: '2028-02-01', to: '2028-03-01'},
    {from: '2028-03-02', to: '2028-03-31'},
  ]);
  assert.deepEqual(tiktokDailySpans('2026-01-15', '2026-03-20'), [
    {from: '2026-01-15', to: '2026-02-13'},
    {from: '2026-02-14', to: '2026-03-15'},
    {from: '2026-03-16', to: '2026-03-20'},
  ]);
  assert.deepEqual(tiktokDailySpans('2026-12-17', '2027-01-16'), [
    {from: '2026-12-17', to: '2027-01-15'},
    {from: '2027-01-16', to: '2027-01-16'},
  ]);
  for (let seed = 1; seed <= 200; seed++) {
    const start = Date.UTC(2024, 0, 1) + ((seed * 67) % 1000) * dayMs;
    const days = ((seed * 41) % 366) + 1;
    const end = start + (days - 1) * dayMs;
    const spans = tiktokDailySpans(
      new Date(start).toISOString().slice(0, 10),
      new Date(end).toISOString().slice(0, 10),
    );
    let next = start;
    for (const span of spans) {
      assert.equal(Date.parse(span.from), next);
      assert.ok(Date.parse(span.to) >= next && Date.parse(span.to) - next < 30 * dayMs);
      next = Date.parse(span.to) + dayMs;
    }
    assert.equal(next, end + dayMs);
  }
});

test('the declared daily window closes in the advertiser zone and allows at most 366 days', t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.UTC(2026, 5, 30, 11)});
  assert.doesNotThrow(() =>
    tiktokDailyRange({...semantics, timezone: 'Pacific/Kiritimati', date_from: '2026-06-01', date_to: '2026-06-30'}),
  );
  assert.throws(
    () =>
      tiktokDailyRange({...semantics, timezone: 'America/Los_Angeles', date_from: '2026-06-01', date_to: '2026-06-30'}),
    {code: 'INVALID_DATE_RANGE'},
  );
  assert.doesNotThrow(() => tiktokDailyRange({...semantics, date_from: '2025-06-29', date_to: '2026-06-29'}));
  assert.throws(() => tiktokDailyRange({...semantics, date_from: '2025-06-28', date_to: '2026-06-29'}), {
    code: 'INVALID_DATE_RANGE',
  });
});

test('guided spans and campaign reports request totals and all statuses', async t => {
  const f = fixture(t);
  const request = preset();
  await collectTikTokDailyReport(f.store, f.call, actor, request.arguments, semantics);
  assert.equal(reportReads(f).length, 3);
  for (const {query} of reportReads(f)) {
    assert.equal(query.enable_total_metrics, true);
    assert.deepEqual(query.filtering, tiktokStatusFilter('campaign'));
    assert.ok(Date.parse(query.end_date) - Date.parse(query.start_date) < 30 * dayMs);
  }
  const campaign = fixture(t);
  await campaign.native.collect(source, {since: '2026-09-01', until: '2026-09-03'}, actor);
  assert.equal(reportReads(campaign)[0].query.enable_total_metrics, true);
  assert.deepEqual(reportReads(campaign)[0].query.filtering, tiktokStatusFilter('campaign'));
});

test('a refused status filter retries once and remains disabled for later spans and periods of the job', async t => {
  const f = fixture(t, {refuseFilter: true});
  const lookup = {};
  const request = preset();
  const result = await collectTikTokDailyReport(f.store, f.call, actor, request.arguments, semantics, {
    allowPartial: true,
    lookup,
  });
  assert.equal(reportReads(f).length, 4);
  assert.ok(reportReads(f)[0].query.filtering);
  assert.ok(
    reportReads(f)
      .slice(1)
      .every(read => !read.query.filtering),
  );
  assert.ok(result.collection.warnings.includes(tiktokStatusFilterRefusedWarning));
  assert.equal(lookup.tiktokStatusFilter, 'refused');
  const oneDay = {...semantics, date_to: semantics.date_from};
  await collectTikTokDailyReport(f.store, f.call, actor, preset(oneDay).arguments, oneDay, {
    allowPartial: true,
    lookup,
  });
  assert.ok(!reportReads(f).at(-1).query.filtering);
  const campaign = fixture(t, {refuseFilter: true});
  const cached = {};
  const first = await campaign.native.collect(
    source,
    {since: '2026-09-01', until: '2026-09-01'},
    actor,
    {},
    () => {},
    cached,
  );
  await campaign.native.collect(source, {since: '2026-09-02', until: '2026-09-02'}, actor, {}, () => {}, cached);
  assert.equal(reportReads(campaign).length, 3);
  assert.ok(first.warnings.includes(tiktokStatusFilterRefusedWarning));
});

test('other failures are never retried as a refused filter', async t => {
  const f = fixture(t, {otherFailure: true});
  await assert.rejects(collectTikTokDailyReport(f.store, f.call, actor, preset().arguments, semantics), {
    code: 'UPSTREAM_ERROR',
  });
  assert.equal(reportReads(f).length, 1);
});

test('AMCP input refusals naming filtering are never retried as provider refusals', async t => {
  const f = fixture(t, {inputFailure: true});
  await assert.rejects(collectTikTokDailyReport(f.store, f.call, actor, preset().arguments, semantics), {
    code: 'INVALID_ARGUMENT',
  });
  assert.equal(reportReads(f).length, 1);
});

test('the internal Overview collector carries its filter decision across reporting periods', async t => {
  const f = fixture(t, {refuseFilter: true});
  const lookup = {};
  const oneDay = {...semantics, date_to: semantics.date_from};
  const input = {preset: 'tiktok_campaign', account_id: '100', connection_id: connection, semantics: oneDay};
  await f.reporting.collectGuided(input, actor, lookup);
  await f.reporting.collectGuided(input, actor, lookup);
  assert.equal(reportReads(f).length, 3);
  assert.ok(!reportReads(f).at(-1).query.filtering);
  assert.equal(lookup.tiktokStatusFilter, 'refused');
});

test('the 120-request preset limit holds across a 366-day daily collection', async t => {
  const f = fixture(t);
  let calls = 0;
  const call = async (tool, request) => {
    calls++;
    if (request.action === 'tiktok_advertiser_info_get') return f.call(tool, request);
    const list = Array.from({length: 1000}, (_, i) => ({
      dimensions: {
        campaign_id: String((request.query.page - 1) * 1000 + i + 1),
        stat_time_day: request.query.start_date,
      },
      metrics: {spend: '1', impressions: '10', clicks: '2', conversion: '1'},
    }));
    return {
      success: true,
      data: {
        data: {
          code: 0,
          data: {list, page_info: {page: request.query.page, page_size: 1000, total_number: 10000, total_page: 10}},
        },
      },
    };
  };
  const sem = {...semantics, date_from: '2025-09-01', date_to: '2026-09-01'};
  await assert.rejects(collectTikTokDailyReport(f.store, call, actor, preset(sem).arguments, sem), {
    code: 'REPORT_COLLECTION_LIMIT',
  });
  assert.equal(calls, 120);
});

test('a campaign window beyond 365 days is refused before any provider read', async t => {
  const f = fixture(t);
  await assert.rejects(f.native.collect(source, {since: '2025-01-01', until: '2026-01-01'}, actor), {
    code: 'INVALID_DATE_RANGE',
  });
  assert.equal(f.requests.length, 0);
});

test('dash metrics remain unknown on both the guided mapping and campaign path', async t => {
  const f = fixture(t, {dash: true});
  const oneDay = {...semantics, date_to: semantics.date_from};
  const captured = await f.reporting.collectGuided(
    {preset: 'tiktok_campaign', account_id: '100', connection_id: connection, semantics: oneDay},
    actor,
  );
  assert.equal(captured.rows[0].conversions, null);
  const campaign = fixture(t, {dash: true});
  const result = await campaign.native.collect(source, {since: '2026-09-01', until: '2026-09-01'}, actor);
  assert.equal(result.rows[0].metrics.conversions, null);
});
