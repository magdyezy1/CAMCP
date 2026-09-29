import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * LinkedIn planning reads (Microsoft Learn "Audience Insights" and "Media Planning", li-lms-2026-09, read 2026-09-29):
 * POST requests that return aggregated estimates and create nothing, so a reader can run them on a read-only deployment.
 */
const gateway = 'linkedin_native_action',
  account = '123',
  registry = new Registry();
const actor = {tenantId: 'linkedin-planning', userId: 'reader', role: 'reader'},
  owner = {...actor, role: 'admin'};
const insights = 'linkedin_rest_targeting_audience_insights_post',
  planning = 'linkedin_rest_media_planning_post';
const urn = 'urn:li:sponsoredAccount:' + account;
const criteria = {
  include: {
    and: [
      {or: {'urn:li:adTargetingFacet:locations': ['urn:li:geo:105080838']}},
      {or: {'urn:li:adTargetingFacet:skills': ['urn:li:skill:236']}},
    ],
  },
};
const onDay = days => {
  const d = new Date(Date.now() + days * 86400000);
  return {day: d.getUTCDate(), month: d.getUTCMonth() + 1, year: d.getUTCFullYear()};
};
const insightBody = (extra = {}, meta = {sponsoredAccountUrn: urn}) => ({
  request: {
    requestMetaData: meta,
    targetingCriteria: criteria,
    groupBy: 'urn:li:adTargetingFacet:jobFunctions',
    maxReturnCount: 5,
    ...extra,
  },
});
const forecastBody = (extra = {}) => ({
  request: {
    sponsoredAccountUrn: urn,
    targetingCriteria: criteria,
    objectiveType: 'BRAND_AWARENESS',
    targetBudgetMicros: 300000000,
    startDateOn: onDay(2),
    endDateOn: onDay(30),
    ...extra,
  },
});
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 93).toString('base64')),
    connection = {
      id: '34343434-3434-4343-8434-343434343434',
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic LinkedIn',
      scopes: ['r_ads'],
    };
  store.putConnection(owner, connection, {accessToken: 'synthetic'});
  const calls = [];
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      headers = new Headers(init.headers);
    calls.push({
      path: u.pathname,
      method: init.method,
      query: Object.fromEntries(u.searchParams),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      restli: headers.get('x-restli-method'),
    });
    if (u.pathname === '/rest/targetingAudienceInsights')
      return Response.json({
        value: {
          audienceInsight: {
            groupedBy: 'urn:li:adTargetingFacet:jobFunctions',
            segmentations: [{entityCount: 96000, entityPercentage: 23, value: 'urn:li:function:4'}],
          },
          totalAudienceCount: 420000,
        },
      });
    if (u.pathname === '/rest/mediaPlanning')
      return Response.json({
        value: {
          reachCurve: {
            metricCurve: [{metricValue: 21137.18, budgetMicros: 100000000}],
            singlePointMetric: {metricValue: 21137.18, budgetMicros: 100000000},
          },
        },
      });
    throw new Error('Unexpected LinkedIn request ' + u.pathname);
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: false,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const call = (action, payload, extra = {}) =>
    service.call(
      gateway,
      {action, account_id: account, connection_id: connection.id, payload, dry_run: false, ...extra},
      actor,
    );
  return {store, calls, call};
}

test('Audience Insights run as a read for a reader on a read-only deployment, under either documented account field', async () => {
  for (const meta of [{sponsoredAccountUrn: urn}, {sponsoredAccount: urn}]) {
    const f = fixture();
    try {
      const out = await f.call(insights, insightBody({}, meta), {params: {action: 'audienceInsights'}});
      assert.equal(out.success, true, JSON.stringify(out).slice(0, 600));
      assert.equal(f.calls.length, 1);
      assert.deepEqual(
        [f.calls[0].method, f.calls[0].path, f.calls[0].query.action],
        ['POST', '/rest/targetingAudienceInsights', 'audienceInsights'],
      );
      assert.match(JSON.stringify(out), /420000/);
    } finally {
      f.store.close();
    }
  }
});

test("each Media Planning forecast runs as a read, carries LinkedIn's required notices and books nothing", async () => {
  for (const action of ['forecastReaches', 'forecastImpressions', 'forecastLeads']) {
    const f = fixture();
    try {
      const out = await f.call(planning, forecastBody(), {params: {action}});
      assert.equal(out.success, true, action + ': ' + JSON.stringify(out).slice(0, 600));
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].query.action, action);
      const preview = await f.call(planning, forecastBody(), {params: {action}, dry_run: true});
      assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 400));
      assert.equal(preview.data.request.readOnly, true);
      assert.match(JSON.stringify(preview.data.request.warnings), /directional estimates/);
      assert.match(JSON.stringify(preview.data.request.warnings), /may not be used to discriminate/);
      assert.equal(f.calls.length, 1);
    } finally {
      f.store.close();
    }
  }
});

test('malformed requests are refused before any request, and another ad account is refused', async () => {
  const cases = [
    ['insights without groupBy', insights, insightBody({groupBy: undefined}), 'audienceInsights'],
    ['undocumented groupBy', insights, insightBody({groupBy: 'urn:li:adTargetingFacet:genders'}), 'audienceInsights'],
    ['too many segments', insights, insightBody({maxReturnCount: 101}), 'audienceInsights'],
    ['unknown order', insights, insightBody({segmentsOrderedBy: 'RANDOM'}), 'audienceInsights'],
    [
      'both account fields',
      insights,
      insightBody({}, {sponsoredAccount: urn, sponsoredAccountUrn: urn}),
      'audienceInsights',
    ],
    ['insights extra field', insights, insightBody({bid: 1}), 'audienceInsights'],
    ['wrong insights action', insights, insightBody(), 'forecastReaches'],
    ['no objective', planning, forecastBody({objectiveType: undefined}), 'forecastReaches'],
    ['unknown objective', planning, forecastBody({objectiveType: 'WEBSITE_VISIT'}), 'forecastReaches'],
    ['unknown optimization', planning, forecastBody({optimizationType: 'MAX_CLICK'}), 'forecastReaches'],
    ['euro forecast', planning, forecastBody({currencyCode: 'EUR'}), 'forecastReaches'],
    ['budget under $100', planning, forecastBody({targetBudgetMicros: 99000000}), 'forecastReaches'],
    ['start today', planning, forecastBody({startDateOn: onDay(0)}), 'forecastReaches'],
    ['over 90 days', planning, forecastBody({endDateOn: onDay(120)}), 'forecastReaches'],
    ['end before start', planning, forecastBody({startDateOn: onDay(20), endDateOn: onDay(10)}), 'forecastReaches'],
    ['impossible date', planning, forecastBody({endDateOn: {day: 31, month: 2, year: 2031}}), 'forecastReaches'],
    [
      'CTV without brand awareness',
      planning,
      forecastBody({ctvOnly: true, objectiveType: 'VIDEO_VIEW'}),
      'forecastReaches',
    ],
    ['unknown forecast action', planning, forecastBody(), 'forecastClicks'],
    [
      'forecast extra field',
      planning,
      forecastBody({campaignGroup: 'urn:li:sponsoredCampaignGroup:1'}),
      'forecastReaches',
    ],
    ['bare body', planning, forecastBody().request, 'forecastReaches'],
  ];
  for (const [label, action, payload, query] of cases) {
    const f = fixture();
    try {
      const out = await f.call(action, JSON.parse(JSON.stringify(payload)), {params: {action: query}});
      assert.equal(out.error?.code, 'INVALID_LINKEDIN_PLANNING_READ', label + ': ' + JSON.stringify(out).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  for (const [action, payload, query] of [
    [insights, insightBody({}, {sponsoredAccountUrn: 'urn:li:sponsoredAccount:999'}), 'audienceInsights'],
    [planning, forecastBody({sponsoredAccountUrn: 'urn:li:sponsoredAccount:999'}), 'forecastReaches'],
  ]) {
    const f = fixture();
    try {
      const out = await f.call(action, payload, {params: {action: query}});
      assert.equal(out.error?.code, 'ACCOUNT_SCOPE_MISMATCH', JSON.stringify(out).slice(0, 300));
      assert.equal(f.calls.length, 0);
    } finally {
      f.store.close();
    }
  }
});

test('both planning routes are native reads in the action ledger, not blocked writes', () => {
  const rows = actionContracts(registry).filter(r => r.gateway === gateway && [insights, planning].includes(r.action));
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.status, 'native_read', row.action);
});
