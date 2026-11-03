import test from 'node:test';
import assert from 'node:assert/strict';
import * as reporting from '../dist/src/linkedin-reporting.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {markReportWindow} from '../dist/src/report-windows.js';
import {Store} from '../dist/src/store.js';
import {NativeCampaignReports} from '../dist/src/report-native.js';

const range = {since: '2026-09-01', until: '2026-09-07'},
  dayMs = 86400000;
const date = text => {
  const [year, month, day] = text.split('-').map(Number);
  return {year, month, day};
};
const row = (r, extra = {}) => ({
  pivotValues: ['urn:li:sponsoredCampaign:30'],
  dateRange: {start: date(r.since), end: date(r.until)},
  impressions: '10',
  clicks: '1',
  costInLocalCurrency: '0.1',
  approximateMemberReach: '7',
  ...extra,
});
const atCap = r =>
  Array.from({length: 15000}, (_, index) => ({
    ...row(r, {costInLocalCurrency: '999'}),
    pivotValues: ['urn:li:sponsoredCampaign:' + (index + 1)],
  }));

test('01:00 Cairo in winter and summer resolves every LinkedIn position to a complete UTC window', async t => {
  const service = {
    store: {resolveConnection() {}},
    runPlan: async () => ({success: true, data: {timezone_name: 'Africa/Cairo'}}),
  };
  const overview = new ReportingOverview(service);
  for (const [now, utc, cairo] of [
    [Date.UTC(2026, 0, 15, 23), ['2026-01-08', '2026-01-14'], ['2026-01-09', '2026-01-15']],
    [Date.UTC(2026, 6, 15, 22), ['2026-07-08', '2026-07-14'], ['2026-07-09', '2026-07-15']],
  ]) {
    t.mock.timers.enable({apis: ['Date'], now});
    try {
      const config = {
        date_range: {since: cairo[0], until: cairo[1]},
        date_range_rule: {
          preset: 'last_complete_days',
          days: 7,
          timezone: 'Africa/Cairo',
          source_timezone: 'account',
          resolved_at: now,
        },
      };
      for (const level of ['campaign', 'adset', 'ad']) {
        const w = await overview.sourceWindow(
          config,
          {platform: 'linkedin', account_id: '100', connection_id: 'login', level},
          {},
        );
        assert.deepEqual([w.dates.since, w.dates.until], utc);
        assert.equal(w.resolution.timezone, 'UTC');
        assert.equal(markReportWindow({date_range: w.dates, timezone: 'UTC', complete: true}).complete, true);
      }
      const local = await overview.sourceWindow(
        config,
        {platform: 'meta', account_id: '100', connection_id: 'login'},
        {},
      );
      assert.deepEqual([local.dates.since, local.dates.until], cairo);
    } finally {
      t.mock.timers.reset();
    }
  }
});
test('the creative oldest day uses UTC and the current plus five previous calendar months', () => {
  assert.equal(reporting.linkedInCreativeOldestDay(new Date('2026-11-01T00:01:00Z')), '2026-06-01');
  assert.equal(reporting.linkedInCreativeOldestDay(new Date('2026-01-31T23:59:00Z')), '2025-08-01');
});
test('exactly 15000 elements splits 7 days into 3 and 4, retaining only exact additive child totals', async () => {
  assert.equal(reporting.linkedInElementCap, 15000);
  const calls = [];
  const result = await reporting.linkedInSplitRead(range, async r => {
    calls.push(r);
    const days = (Date.parse(r.until) - Date.parse(r.since)) / dayMs + 1;
    return days === 7
      ? atCap(r)
      : [
          row(r, {
            impressions: String(days * 10),
            clicks: String(days),
            costInLocalCurrency: days === 3 ? '0.1' : '0.2',
          }),
        ];
  });
  assert.deepEqual(calls, [
    range,
    {since: '2026-09-01', until: '2026-09-03'},
    {since: '2026-09-04', until: '2026-09-07'},
  ]);
  assert.equal(result.split, true);
  assert.equal(result.partial, null);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].costInLocalCurrency, '0.3');
  assert.equal(result.rows[0].impressions, '70');
  assert.equal(result.rows[0].approximateMemberReach, null);
  assert.deepEqual(result.rows[0].dateRange, {start: date(range.since), end: date(range.until)});
});
test('a single capped day is partial with an explicit missing-rows reason', async () => {
  const single = {since: range.since, until: range.since};
  const result = await reporting.linkedInSplitRead(single, async r => atCap(r));
  assert.equal(
    result.partial,
    'LinkedIn returned 15,000 rows for one day, its response limit; rows beyond it are missing.',
  );
});
test('the 32-request split budget yields partial coverage instead of throwing or making an extra read', async () => {
  const wide = {since: '2026-07-01', until: '2026-09-01'};
  let calls = 0;
  const result = await reporting.linkedInSplitRead(wide, async r => {
    calls++;
    return atCap(r);
  });
  assert.ok(calls <= 32);
  assert.match(result.partial, /32|budget|limit/i);
});
test('a split never adds an unknown ratio field', async () => {
  const result = await reporting.linkedInSplitRead(range, async r =>
    r.since === range.since && r.until === range.until ? atCap(r) : [row(r, {syntheticRatio: '0.5'})],
  );
  assert.equal(result.rows[0].syntheticRatio, null);
});
test('an old creative window is refused before the account read', async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.UTC(2026, 10, 2)});
  t.after(() => t.mock.timers.reset());
  const actor = {tenantId: 'synthetic-linkedin-old-creative', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 125).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: 'login',
      tenantId: actor.tenantId,
      gateway: 'linkedin_native_action',
      accounts: ['100'],
      enabled: true,
      scopes: ['r_ads', 'r_ads_reporting'],
      label: 'Synthetic',
    },
    {accessToken: 'synthetic'},
  );
  let reads = 0;
  const native = new NativeCampaignReports({
    store,
    runPlan: async () => {
      reads++;
      throw new Error('No read expected');
    },
  });
  await assert.rejects(
    () =>
      native.collect(
        {
          platform: 'linkedin',
          account_id: '100',
          connection_id: 'login',
          level: 'ad',
          report_options: {complete_window: true, attribution: 'unknown'},
        },
        {since: '2026-05-01', until: '2026-05-02'},
        actor,
      ),
    error =>
      error.code === 'INVALID_DATE_RANGE' &&
      error.message ===
        'LinkedIn’s creative level covers the current month and the previous five calendar months; choose a later start.',
  );
  assert.equal(reads, 0);
});
test('empty and rounded-date evidence explains the exact requested and returned dates', () => {
  assert.throws(
    () => reporting.linkedInCampaignPeriod({elements: []}, range),
    error =>
      error.code === 'REPORT_EMPTY_AMBIGUOUS' &&
      error.message ===
        'LinkedIn returned no rows for 2026-09-01–2026-09-07. Check that the account delivered in those dates.',
  );
  const rounded = {since: '2026-09-01', until: '2026-09-30'};
  assert.throws(
    () => reporting.linkedInCampaignPeriod({elements: [row(rounded)]}, range),
    error =>
      error.code === 'REPORT_DATE_MISMATCH' &&
      error.message ===
        'LinkedIn returned dates 2026-09-01–2026-09-30 for 2026-09-01–2026-09-07. With whole-period rows LinkedIn rounds dates older than six months to whole months; choose whole calendar months or a recent window.',
  );
});
test('strict guided analytics continue to refuse a capped response', () => {
  assert.throws(
    () => reporting.linkedInAnalyticsRows({elements: atCap(range)}),
    error => error.code === 'REPORT_INCOMPLETE',
  );
});

test('a split reserves reads for both halves even when descendants exhaust its budget', async () => {
  const calls = [];
  const result = await reporting.linkedInSplitRead(
    range,
    async r => {
      calls.push(r);
      return atCap(r);
    },
    4,
  );
  assert.deepEqual(calls, [
    range,
    {since: range.since, until: '2026-09-03'},
    {since: '2026-09-04', until: range.until},
  ]);
  assert.equal(result.partial, reporting.linkedInSplitBudgetWarning);
  assert.equal(result.rows[0].impressions, '20');
});

test('split rounding evidence and D3 omitted cost survive the exact sum', async () => {
  const result = await reporting.linkedInSplitRead(range, async r =>
    r.since === range.since && r.until === range.until
      ? atCap(r)
      : [
          row(r, {
            impressions: '0',
            clicks: '0',
            costInLocalCurrency: undefined,
            oneClickLeads: '0.1234567896',
          }),
        ],
  );
  assert.equal(result.rows[0].costInLocalCurrency, '0');
  assert.deepEqual(result.rows[0].omitted_as_zero, ['spend']);
  assert.equal(result.rows[0].oneClickLeads, '0.24691358');
  assert.equal(result.rounding.oneClickLeads, 2);
});

test('an entity absent from a split period has unknown totals rather than invented zero delivery', async () => {
  const result = await reporting.linkedInSplitRead(range, async r =>
    r.until === range.until && r.since === range.since
      ? atCap(r)
      : [
          row(r, {
            pivotValues: ['urn:li:sponsoredCampaign:' + (r.since === range.since ? '30' : '31')],
          }),
        ],
  );
  assert.equal(result.rows[0].impressions, null);
  assert.equal(result.rows[0].costInLocalCurrency, null);
  assert.match(result.partial, /every entity.*split period/);
});
