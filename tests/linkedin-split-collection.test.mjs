import test from 'node:test';
import assert from 'node:assert/strict';
import {MirrorError} from '../dist/src/errors.js';
import {NativeCampaignReports} from '../dist/src/report-native.js';
import {reportSourceError} from '../dist/src/report-errors.js';
import {Store} from '../dist/src/store.js';

const range = {since: '2026-09-01', until: '2026-09-07'};
const date = text => {
  const [year, month, day] = text.split('-').map(Number);
  return {year, month, day};
};
const queryRange = query => {
  const parts = [...query.dateRange.matchAll(/year:(\d+),month:(\d+),day:(\d+)/g)];
  const days = parts.map(m => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
  return {since: days[0], until: days[1]};
};
const pivotType = {
  CAMPAIGN_GROUP: 'sponsoredCampaignGroup',
  CAMPAIGN: 'sponsoredCampaign',
  CREATIVE: 'sponsoredCreative',
};
function analytics(query, r, count = 1, extra = {}) {
  const fields = Object.fromEntries(
    query.fields
      .split(',')
      .filter(k => !['pivotValues', 'dateRange'].includes(k))
      .map(k => [k, '1']),
  );
  return {
    elements: Array.from({length: count}, (_, i) => ({
      pivotValues: ['urn:li:' + pivotType[query.pivot] + ':' + (i + 1)],
      dateRange: {start: date(r.since), end: date(r.until)},
      ...fields,
      ...extra,
    })),
  };
}
function fixture(t, read, ownObjective = true) {
  const actor = {tenantId: 'synthetic-linkedin-split', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 126).toString('base64'));
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
  const requests = [];
  const native = new NativeCampaignReports({
    store,
    runPlan: async plan => {
      requests.push(plan);
      let data;
      if (plan.path === '/rest/adAccounts/100') data = {id: 100, currency: 'USD', name: 'Synthetic'};
      else if (plan.path === '/rest/adAnalytics') data = await read(plan.query, queryRange(plan.query));
      else {
        const urns = plan.query.search?.id?.values ?? [];
        data = {
          elements: urns.map(urn => ({
            id: urn.split(':').at(-1),
            account: 'urn:li:sponsoredAccount:100',
            objectiveType: plan.path.endsWith('/adCampaignGroups') && !ownObjective ? undefined : 'LEAD_GENERATION',
            campaignGroup: 'urn:li:sponsoredCampaignGroup:1',
            name: 'Synthetic',
          })),
          metadata: {},
        };
      }
      return {success: true, data};
    },
  });
  return {
    requests,
    collect: (level = 'adset', dates = range, native_metrics = [], lookup = {}) =>
      native.collect(
        {
          platform: 'linkedin',
          account_id: '100',
          connection_id: 'login',
          level,
          native_metrics,
          ...(level === 'campaign' ? {} : {report_options: {complete_window: true, attribution: 'unknown'}}),
        },
        dates,
        actor,
        {},
        () => {},
        lookup,
      ),
  };
}

test('Overview splits a capped native window, sums exact child metrics and discloses unavailable reach', async t => {
  const f = fixture(t, (q, r) =>
    analytics(q, r, r.since === range.since && r.until === range.until ? 15000 : 1, {
      costInLocalCurrency: r.until === '2026-09-03' ? '0.1' : '0.2',
      approximateMemberReach: '7',
    }),
  );
  const out = await f.collect();
  assert.equal(f.requests.filter(p => p.path === '/rest/adAnalytics').length, 3);
  assert.equal(out.complete, true);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].native.exact_totals.spend, '0.3');
  assert.equal(out.rows[0].metrics.reach, null);
  assert.ok(out.warnings.includes('LinkedIn’s 15,000-row limit split this window, so reach is unavailable.'));
});

test('a capped day returns a bounded partial report with bounded metadata instead of crashing', async t => {
  const single = {since: range.since, until: range.since},
    lookup = {};
  const f = fixture(t, (q, r) => analytics(q, r, 15000));
  const out = await f.collect('adset', single, [], lookup);
  assert.equal(out.collection_complete, false);
  assert.equal(out.complete, false);
  assert.equal(out.quality.pages_collected, false);
  assert.equal(out.rows.length, 10000);
  assert.ok(
    out.warnings.includes('LinkedIn returned 15,000 rows for one day, its response limit; rows beyond it are missing.'),
  );
  assert.ok(out.warnings.some(w => /10,000/.test(w)));
  assert.ok(out.warnings.some(w => /2000/.test(w)));
  assert.equal(Object.keys(lookup.linkedinCampaigns.campaigns).length, 2000);
  assert.equal(lookup.linkedinCampaigns.limited, true);
  assert.equal(out.rows[2001].objective, 'unknown');
});

test('split rounding and omitted-cost qualifiers reach the final native detail envelope', async t => {
  const f = fixture(t, (q, r) =>
    analytics(q, r, r.since === range.since && r.until === range.until ? 15000 : 1, {
      impressions: '0',
      clicks: '0',
      costInLocalCurrency: undefined,
      oneClickLeads: '0.1234567896',
    }),
  );
  const out = await f.collect();
  assert.equal(out.rows[0].native.exact_totals.spend, '0');
  assert.deepEqual(out.rows[0].omitted_as_zero, ['spend']);
  assert.equal(out.rows[0].native.exact_totals.conversions, '0.24691358');
  assert.equal(out.quality.metric_rounding.native_linkedin_oneClickLeads.rows_rounded, 2);
});

test('metric fragments retain exact entity joins after independent subdivisions', async t => {
  const extra = [
    'likes',
    'comments',
    'shares',
    'videoCompletions',
    'externalWebsitePostClickConversions',
    'externalWebsitePostViewConversions',
    'syntheticRatio',
    'syntheticCount',
  ];
  const f = fixture(t, (q, r) => analytics(q, r, r.since === range.since && r.until === range.until ? 15000 : 1));
  const out = await f.collect('campaign', range, extra);
  assert.equal(f.requests.filter(p => p.path === '/rest/adAnalytics').length, 12);
  assert.equal(out.complete, true);
  assert.equal(out.rows[0].metrics.spend, 2);
});

test('incomplete campaign companion rows cannot establish a group objective from a subset', async t => {
  const single = {since: range.since, until: range.since};
  const f = fixture(t, (q, r) => analytics(q, r, q.pivot === 'CAMPAIGN' ? 15000 : 1), false);
  const out = await f.collect('campaign', single);
  assert.equal(out.collection_complete, false);
  assert.ok(f.requests.some(p => p.query?.pivot === 'CAMPAIGN'));
  assert.equal(out.rows[0].objective, 'unknown');
});

test('DATE_TOO_EARLY gets plain retention guidance while preserving the exact provider diagnostic', async t => {
  const details = {
    http_status: 400,
    request_id: 'synthetic-retention',
    upstream: {code: 'DATE_TOO_EARLY', message: 'DATE_TOO_EARLY'},
  };
  const f = fixture(t, () => {
    throw new MirrorError('UPSTREAM_ERROR', 'Synthetic provider refusal.', details, 400);
  });
  await assert.rejects(
    () => f.collect(),
    error => {
      assert.equal(error.code, 'INVALID_DATE_RANGE');
      assert.equal(
        error.message,
        'LinkedIn keeps this data for a limited time, and this window starts too early. Choose a later start.',
      );
      const diagnostic = reportSourceError(error, {platform: 'linkedin', account_id: '100'});
      assert.equal(diagnostic.provider.code, 'DATE_TOO_EARLY');
      assert.equal(diagnostic.provider.message, 'DATE_TOO_EARLY');
      assert.equal(diagnostic.provider.request_id, 'synthetic-retention');
      assert.equal(diagnostic.request.path, '/rest/adAnalytics');
      return true;
    },
  );
});

test('a permission denial mentioning retention is never relabelled as a date error', async t => {
  const f = fixture(t, () => {
    throw new MirrorError(
      'PROVIDER_ACCESS_DENIED',
      'Synthetic permission refusal.',
      {
        http_status: 403,
        upstream: {code: 'DATE_TOO_EARLY', message: 'Check DATE_TOO_EARLY permissions'},
      },
      403,
    );
  });
  await assert.rejects(() => f.collect(), {code: 'PROVIDER_ACCESS_DENIED', message: 'Synthetic permission refusal.'});
});

test('a split budget preserves partial Overview output without an unbounded analytics read', async t => {
  const f = fixture(t, (q, r) => analytics(q, r, 15000));
  const out = await f.collect('adset', {since: '2026-07-01', until: '2026-09-01'});
  assert.ok(f.requests.filter(p => p.path === '/rest/adAnalytics').length <= 32);
  assert.equal(out.collection_complete, false);
  assert.equal(out.complete, false);
  assert.ok(out.warnings.includes('LinkedIn’s split request limit was reached; some periods are missing.'));
});

test('an empty split period stays ambiguous instead of contributing invented zeros', async t => {
  const f = fixture(t, (q, r) =>
    r.since === range.since && r.until === range.until ? analytics(q, r, 15000) : {elements: []},
  );
  await assert.rejects(() => f.collect(), {
    code: 'REPORT_EMPTY_AMBIGUOUS',
    message: 'LinkedIn returned no rows for 2026-09-01–2026-09-03. Check that the account delivered in those dates.',
  });
});
