import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Store} from '../dist/src/store.js';
import {tiktokTotalsCheck, tiktokTotalsMismatchMessage} from '../dist/src/tiktok-report-pagination.js';
import {collectTikTokDailyReport} from '../dist/src/tiktok-reporting.js';
import {tiktokReportSource} from '../dist/src/tiktok-report-source.js';

const metrics = ['spend', 'impressions', 'clicks', 'conversion'];
const nativeRow = (id, spend = '1') => ({
  dimensions: {campaign_id: String(id), stat_time_day: '2026-09-01'},
  metrics: {campaign_name: 'Synthetic', spend, impressions: '10', clicks: '2', conversion: '1'},
});
const total = count => ({
  spend: String(count),
  impressions: String(count * 10),
  clicks: String(count * 2),
  conversion: String(count),
});

test('matching additive totals are compared as exact native decimals', () => {
  assert.deepEqual(
    tiktokTotalsCheck([nativeRow(1, '0.1'), nativeRow(2, '0.2')], {...total(2), spend: '0.3'}, metrics),
    {verdict: 'match', gaps: []},
  );
  assert.equal(
    tiktokTotalsCheck(
      [nativeRow(1, '9007199254740993.01'), nativeRow(2, '0.02')],
      {spend: '9007199254740993.03'},
      metrics,
    ).verdict,
    'match',
  );
});

test('money matches within half a cent per row and integer counts match exactly', () => {
  const rows = [nativeRow(1, '0.495'), nativeRow(2, '0.495')];
  assert.equal(tiktokTotalsCheck(rows, {spend: '1'}, metrics).verdict, 'match');
  assert.equal(tiktokTotalsCheck(rows, {spend: '1.000000001'}, metrics).verdict, 'gap');
  assert.equal(tiktokTotalsCheck(rows, {clicks: '5'}, metrics).verdict, 'gap');
  assert.equal(tiktokTotalsCheck(rows, {clicks: '4'}, metrics).verdict, 'match');
});

test('the money tolerance is exactly half a cent per row, inclusive, however many rows there are (N5)', () => {
  // Rows of spend 1 each; a total up to count x 0.005 away still matches, one nano-unit further is a gap.
  for (const [count, near, far] of [
    [1, ['1.005', '0.995'], ['1.005000001', '0.994999999']],
    [2, ['2.01', '1.99'], ['2.010000001', '1.989999999']],
    [3, ['3.015', '2.985'], ['3.015000001', '2.984999999']],
    // The slack grows with the rows: a missing 20.00 hides in 4,000 rows' spend, which only the exact integers catch.
    [4000, ['4020', '3980'], ['4020.000000001', '3979.999999999']],
  ]) {
    const rows = Array.from({length: count}, (_, i) => nativeRow(i + 1, '1'));
    for (const spend of near)
      assert.equal(tiktokTotalsCheck(rows, {spend}, metrics).verdict, 'match', count + ' ' + spend);
    for (const spend of far)
      assert.equal(tiktokTotalsCheck(rows, {spend}, metrics).verdict, 'gap', count + ' ' + spend);
  }
  // The same distance in an integer metric is a gap at one unit: counts carry no rounding.
  const rows = Array.from({length: 4000}, (_, i) => nativeRow(i + 1, '1'));
  assert.equal(tiktokTotalsCheck(rows, {clicks: '8001'}, metrics).verdict, 'gap');
  assert.equal(tiktokTotalsCheck(rows, {clicks: '8000'}, metrics).verdict, 'match');
});

test('missing, dash and nonnumeric totals are absent, without inventing a comparison', () => {
  for (const totals of [undefined, '-', null, {spend: '-'}, {spend: 'abc'}, [], {reach: '10'}])
    assert.deepEqual(tiktokTotalsCheck([nativeRow(1)], totals, metrics), {verdict: 'absent', gaps: []});
  for (const value of [null, undefined, '-']) {
    const row = nativeRow(1);
    row.metrics.spend = value;
    assert.equal(tiktokTotalsCheck([row], {spend: '1'}, ['spend']).verdict, 'absent');
  }
});

test('gaps retain exact formatted values, including when rows exceed the platform total', () => {
  assert.deepEqual(tiktokTotalsCheck([nativeRow(1, '1234.50')], {spend: '1300.00'}, metrics), {
    verdict: 'gap',
    gaps: [{metric: 'spend', rows: '1,234.50', total: '1,300.00'}],
  });
  assert.deepEqual(tiktokTotalsCheck([nativeRow(1, '9007199254740993.01')], {spend: '1'}, metrics).gaps, [
    {metric: 'spend', rows: '9,007,199,254,740,993.01', total: '1.00'},
  ]);
});

function campaign(rows, declared, totals) {
  const context = {
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
    run: async plan => ({
      code: 0,
      data: plan.path.includes('/report/integrated/get/')
        ? {
            list: rows,
            total_metrics: totals,
            page_info: {page: 1, page_size: 1000, total_number: declared, total_page: Math.ceil(declared / 1000)},
          }
        : {list: []},
    }),
  };
  return tiktokReportSource.collect(context).then(() => context);
}
async function guided(t, rows, declared, totals, allowPartial = true) {
  const actor = {tenantId: 'synthetic-tiktok-totals', userId: 'owner', role: 'admin'};
  const store = new Store(':memory:', Buffer.alloc(32, 118).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: 'login',
      tenantId: actor.tenantId,
      gateway: 'tiktok_native_action',
      accounts: ['100'],
      enabled: true,
      scopes: [],
      label: 'Synthetic',
    },
    {accessToken: 'synthetic'},
  );
  const call = async (_tool, request) => ({
    success: true,
    data: {
      data: {
        code: 0,
        data:
          request.action === 'tiktok_advertiser_info_get'
            ? {list: [{advertiser_id: '100', currency: 'USD', timezone: 'Etc/GMT'}]}
            : {
                list: rows.slice((request.query.page - 1) * 1000, request.query.page * 1000),
                total_metrics: totals,
                page_info: {
                  page: request.query.page,
                  page_size: 1000,
                  total_number: declared,
                  total_page: Math.ceil(declared / 1000),
                },
              },
      },
    },
  });
  const args = {
    action: 'tiktok_report_integrated_get',
    account_id: '100',
    connection_id: 'login',
    query: {
      dimensions: ['campaign_id', 'stat_time_day'],
      metrics,
      page_size: 1000,
      start_date: '2026-09-01',
      end_date: '2026-09-01',
    },
  };
  const semantics = {
    currency: 'USD',
    timezone: 'Etc/GMT',
    date_from: '2026-09-01',
    date_to: '2026-09-01',
    complete: true,
  };
  return (await collectTikTokDailyReport(store, call, actor, args, semantics, allowPartial ? {allowPartial: true} : {}))
    .collection;
}

test('evidence refuses a native-total gap even when its page counts match', async t => {
  await assert.rejects(
    guided(t, [nativeRow(1)], 1, {...total(1), spend: '2'}, false),
    error =>
      error.code === 'REPORT_INCOMPLETE' &&
      error.message === tiktokTotalsMismatchMessage &&
      error.details.declared_rows === 1 &&
      error.details.returned_rows === 1 &&
      error.details.page_facts.rule === 'totals_mismatch',
  );
});

test('gaps in separate 30-day spans cannot cancel into a complete collection', async t => {
  const actor = {tenantId: 'synthetic-tiktok-total-spans', userId: 'owner', role: 'admin'};
  const store = new Store(':memory:', Buffer.alloc(32, 119).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: 'login',
      tenantId: actor.tenantId,
      gateway: 'tiktok_native_action',
      accounts: ['100'],
      enabled: true,
      scopes: [],
      label: 'Synthetic',
    },
    {accessToken: 'synthetic'},
  );
  let reports = 0;
  const call = async (_tool, request) => {
    const account = request.action === 'tiktok_advertiser_info_get';
    if (!account) reports++;
    const row = nativeRow(1);
    row.dimensions.stat_time_day = request.query.start_date;
    return {
      success: true,
      data: {
        data: {
          code: 0,
          data: account
            ? {list: [{advertiser_id: '100', currency: 'USD', timezone: 'Etc/GMT'}]}
            : {
                list: [row],
                total_metrics: {spend: reports === 1 ? '1.50' : '0.50'},
                page_info: {page: 1, page_size: 1000, total_number: 1, total_page: 1},
              },
        },
      },
    };
  };
  const args = {
    action: 'tiktok_report_integrated_get',
    account_id: '100',
    connection_id: 'login',
    query: {dimensions: ['campaign_id', 'stat_time_day'], metrics, page_size: 1000},
  };
  const result = await collectTikTokDailyReport(
    store,
    call,
    actor,
    args,
    {currency: 'USD', timezone: 'Etc/GMT', complete: true, date_from: '2026-07-01', date_to: '2026-08-01'},
    {allowPartial: true},
  );
  assert.equal(reports, 2);
  assert.equal(result.collection.complete, false);
  assert.equal(result.collection.warnings.length, 2);
  assert.match(result.collection.warnings[0], /spend 1\.00 of 1\.50/);
  assert.match(result.collection.warnings[1], /spend 1\.00 of 0\.50/);
});

test('Arabic total-gap warnings translate the metric and comparison while retaining Latin values', async () => {
  const result = await campaign([nativeRow(1, '1234.50')], 1, {spend: '1300'});
  const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  const context = createContext({document: {addEventListener() {}}});
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/report-quality.js', 'utf8')).runInContext(context);
  context.catalog = catalog;
  context.warning = result.warnings[0];
  new Script('uiLocale = "ar"; uiMessages = new Map(Object.entries(catalog));').runInContext(context);
  const text = new Script('uiSourceWarning(warning)').runInContext(context);
  assert.match(text, /[\u0600-\u06ff]/);
  assert.match(text, /1,234\.50/);
  assert.match(text, /1,300\.00/);
  assert.doesNotMatch(text, /\bof\b|\bspend\b/);
  assert.match(catalog[tiktokTotalsMismatchMessage], /[\u0600-\u06ff]/);
});
for (const path of ['guided', 'campaign']) {
  const collect = (t, rows, declared, totals) =>
    path === 'guided' ? guided(t, rows, declared, totals) : campaign(rows, declared, totals);
  const complete = result => (path === 'guided' ? result.complete : result.collectionComplete);
  test(path + ': matching totals win over short page counts', async t => {
    const rows = Array.from({length: 1300}, (_, i) => nativeRow(i + 1));
    const result = await collect(t, rows, 1500, total(1300));
    assert.equal(complete(result), true);
    assert.ok(
      result.warnings.includes(
        'TikTok’s page counts disagreed with its rows; its totals match, so the collection is complete.',
      ),
    );
    // F-L1-02: the reader still sees both counts beside the totals sentence.
    assert.ok(result.warnings.includes('TikTok declared 1,500 rows and returned 1,300.'));
  });
  test(path + ': differing totals remain partial with the actual gap', async t => {
    const rows = Array.from({length: 1300}, (_, i) => nativeRow(i + 1));
    const result = await collect(t, rows, 1300, {...total(1300), spend: '1500'});
    assert.equal(complete(result), false);
    assert.match(result.warnings.join(' '), /spend 1,300\.00 of 1,500\.00/);
    assert.ok(!result.warnings.some(w => w.startsWith('TikTok declared')), 'equal counts add no counts sentence');
  });
  test(path + ': a totals gap on a short collection names the gap and both counts (F-L1-02, D2)', async t => {
    const rows = Array.from({length: 1300}, (_, i) => nativeRow(i + 1));
    const result = await collect(t, rows, 1500, {...total(1300), spend: '1450.00'});
    assert.equal(complete(result), false);
    assert.ok(result.warnings.some(w => /spend 1,300\.00 of 1,450\.00/.test(w)));
    assert.ok(result.warnings.includes('TikTok declared 1,500 rows and returned 1,300.'));
  });
  test(path + ': absent totals fall back to equal or short counts', async t => {
    const rows = [nativeRow(1)];
    for (const totals of [undefined, '-', {spend: '-'}, {spend: 'abc'}, null]) {
      assert.equal(complete(await collect(t, rows, 1, totals)), true);
      const short = await collect(t, rows, 2, totals);
      assert.equal(complete(short), false);
      assert.ok(short.warnings.includes('TikTok declared 2 rows and returned 1.'));
    }
  });
}
