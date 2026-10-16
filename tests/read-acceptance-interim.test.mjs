// ACC-06 interim source changes, ahead of the owner-authorized read-only acceptance runs:
// - Reddit: the conversion value divisor (cents) had no cited source and two literal copies; a report that read it gave
//   conversion value and ROAS with no sign that the unit is unverified. Now one named divisor serves both sites, the
//   report says the unit is unverified, and the result definition stays unknown so sales decisions ask for review.
// - X: line items may deliver on PUBLISHER_NETWORK, which reports never request. Before, a campaign X reported as active
//   only there vanished from the totals silently and the source still claimed to be complete.
// - TikTok: no sandbox origin is qualified, and sandbox mode never falls back to the production host.
// Every provider response here is synthetic; nothing reaches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Store} from '../dist/src/store.js';
import {NativeTransport, buildUrl} from '../dist/src/transport.js';
import {NativeCampaignReports, normalizeNativeRow, redditValueUnitWarning} from '../dist/src/report-native.js';
import {metricSources, redditConversionValueDivisor} from '../dist/src/report-metrics.js';
import {xCampaignReport, xPublisherNetwork, xPublisherNetworkWarning} from '../dist/src/x-campaign-report.js';
import {xActiveEntities, xReportPlacements} from '../dist/src/x-active-entities.js';
import {sandboxFetch, validateSandboxFixture} from '../dist/tools/live-sandbox.js';

const actor = {tenantId: 'acc-06', userId: 'owner', role: 'admin'};
const iso = ms => new Date(ms).toISOString();

/** A NativeCampaignReports over a recorded fake runPlan: no transport, no network. */
function reports(gateway, account, reply) {
  const store = new Store(':memory:', Buffer.alloc(32, 61).toString('base64'));
  store.putConnection(
    actor,
    {id: 'conn', tenantId: actor.tenantId, gateway, accounts: [account], enabled: true, label: 'Synthetic', scopes: []},
    {accessToken: 'synthetic'},
  );
  const requests = [];
  const service = {
    store,
    runPlan: async p => {
      requests.push(p);
      return {success: true, data: await reply(p)};
    },
  };
  return {store, requests, native: new NativeCampaignReports(service)};
}

const redditReply = p => {
  // Like Reddit, the fake returns only the fields the report asked for.
  if (p.path.endsWith('/reports'))
    return {
      data: {
        metrics: [
          {
            campaign_id: 'r1',
            SPEND: 2500000,
            CLICKS: 4,
            IMPRESSIONS: 100,
            ...(p.body.data.fields.includes('CONVERSION_PURCHASE_TOTAL_VALUE')
              ? {CONVERSION_PURCHASE_TOTAL_VALUE: 12345}
              : {}),
          },
        ],
      },
    };
  if (p.path.endsWith('/campaigns')) return {data: [{id: 'r1', name: 'Reddit one', objective: 'CONVERSIONS'}]};
  return {data: {id: 't2_acct', name: 'Synthetic Reddit', currency: 'USD', time_zone_id: 'UTC'}};
};

test('ACC-06 Reddit: one cited divisor serves normalizeNativeRow and the metric sources, apart from the spend unit', () => {
  assert.equal(redditConversionValueDivisor, 100, 'cents until the authorized closed-week check says otherwise');
  const row = normalizeNativeRow('reddit', {campaign_id: '1', SPEND: 1e6, CONVERSION_PURCHASE_TOTAL_VALUE: 500});
  assert.equal(row.metrics.conversion_value, 500 / redditConversionValueDivisor);
  assert.equal(row.metrics.spend, 1);
  assert.equal(metricSources.reddit.conversion_value.divisor, redditConversionValueDivisor);
  assert.equal(metricSources.reddit.spend.divisor, 1e6);
  // A missing value stays missing; it never becomes zero.
  assert.equal(normalizeNativeRow('reddit', {campaign_id: '1'}).metrics.conversion_value, null);
});

test('ACC-06 Reddit: a report that reads the purchase value says the unit is unverified and keeps the definition unknown', async () => {
  const f = reports('reddit_native_action', 't2_acct', redditReply);
  try {
    const source = {platform: 'reddit', account_id: 't2_acct', connection_id: 'conn'};
    const withValue = await f.native.collect(
      {...source, native_metrics: ['CONVERSION_PURCHASE_TOTAL_VALUE']},
      {since: '2026-09-01', until: '2026-09-07'},
      actor,
    );
    assert.ok(withValue.warnings.includes(redditValueUnitWarning), withValue.warnings.join(' | '));
    assert.equal(withValue.rows[0].metrics.conversion_value, 12345 / redditConversionValueDivisor);
    // Reddit names no conversion definition AMCP can cite: sales recommendations keep asking for review.
    assert.equal(withValue.result_definition, 'unknown');
    // Without the value field there is no conversion value, so no unit notice either.
    const without = await f.native.collect(source, {since: '2026-09-01', until: '2026-09-07'}, actor);
    assert.ok(!without.warnings.includes(redditValueUnitWarning));
    assert.equal(without.rows[0].metrics.conversion_value, null);
  } finally {
    f.store.close();
  }
});

const day = 86400000,
  start = Date.parse('2026-06-01T00:00:00Z'),
  end = start + 7 * day,
  inventory = ['c1', 'c2', 'c3'].map(id => ({id, name: 'Campaign ' + id, objective: 'WEBSITE_CLICKS'}));
const active = placements => ({
  data: placements.map(([entity_id, list]) => ({
    entity_id,
    activity_start_time: iso(start),
    activity_end_time: iso(end),
    ...(list ? {placements: list} : {}),
  })),
});
const analytics = calls => async q => {
  calls.push(q);
  const hours = (Date.parse(q.end_time) - Date.parse(q.start_time)) / 3600000;
  return {
    data: String(q.entity_ids)
      .split(',')
      .map(id => ({
        id,
        id_data: [
          {
            segment: null,
            metrics: {impressions: Array(hours).fill(1), billed_charge_local_micro: Array(hours).fill(0)},
          },
        ],
      })),
  };
};

test('ACC-06 X: publisher-network activity X reports is named and makes the source partial; it is never requested', async () => {
  const set = await xActiveEntities(start, end, async () =>
    active([
      ['c1', ['ALL_ON_TWITTER']],
      ['c2', ['ALL_ON_TWITTER', xPublisherNetwork]],
      ['c3', [xPublisherNetwork]],
    ]),
  );
  const calls = [];
  const report = await xCampaignReport(inventory, start, end, [], analytics(calls), {active: set});
  assert.ok(report.warnings.includes(xPublisherNetworkWarning(2)), report.warnings.join(' | '));
  assert.match(xPublisherNetworkWarning(1), /^1 X campaign has activity/);
  assert.equal(report.complete, false, 'spend X reported elsewhere is missing, so the totals are not complete');
  // The placement stays outside the request plan until the authorized probe decides the branch.
  assert.ok(calls.length > 0);
  assert.ok(calls.every(q => xReportPlacements.includes(q.placement)));
  assert.ok(!calls.some(q => q.placement === xPublisherNetwork));
  // c3 is active only on the publisher network: it is not a zero row and not a "no activity" campaign either.
  assert.deepEqual(report.rows.map(r => r.id).sort(), ['c1', 'c2']);
  assert.equal(report.no_activity_count, 0);
});

test('ACC-06 X: without publisher-network activity, or when X names no placements, nothing changes', async () => {
  for (const placements of [[['c1', ['ALL_ON_TWITTER', 'SPOTLIGHT']]], [['c1', null]]]) {
    const set = await xActiveEntities(start, end, async () => active(placements));
    const report = await xCampaignReport(inventory, start, end, [], analytics([]), {active: set});
    assert.equal(report.complete, true);
    assert.ok(!report.warnings.some(w => w.includes(xPublisherNetwork)), report.warnings.join(' | '));
  }
});

test('ACC-06 X: the Overview source carries the partial state and the notice to the snapshot', async () => {
  const f = reports('x_ads_native_action', 'abc', p => {
    if (p.path.endsWith('/campaigns')) return {data: inventory};
    // RPT-07: the Overview reads each campaign's objective from the account's line items (one bounded read).
    if (p.path.endsWith('/line_items'))
      return {data: inventory.map(c => ({id: 'li-' + c.id, campaign_id: c.id, objective: 'WEBSITE_CLICKS'}))};
    if (p.path.endsWith('/active_entities'))
      return active([
        ['c1', ['ALL_ON_TWITTER']],
        ['c2', [xPublisherNetwork]],
      ]);
    if (p.path.startsWith('/12/stats/accounts/')) return analytics([])(p.query);
    return {data: {id: 'abc', currency: 'USD', timezone: 'UTC', name: 'X'}};
  });
  try {
    const result = await f.native.collect(
      {platform: 'x', account_id: 'abc', connection_id: 'conn'},
      {since: '2026-06-01', until: '2026-06-07'},
      actor,
    );
    assert.equal(result.complete, false);
    assert.equal(result.collection_complete, false);
    assert.ok(result.warnings.includes(xPublisherNetworkWarning(1)));
    assert.ok(!f.requests.some(p => p.query?.placement === xPublisherNetwork));
  } finally {
    f.store.close();
  }
});

/** The reporting page's source-warning renderer, in English or Arabic. */
function warningRenderer(locale) {
  const context = createContext({
    Intl,
    Date,
    document: {addEventListener() {}, querySelector: () => null, querySelectorAll: () => []},
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(readFileSync('web/report-quality.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  return value => {
    context.value = value;
    return run('uiSourceWarning(value)');
  };
}

test('ACC-06: the unit-unverified and publisher-network notices render in English and in Arabic', () => {
  const en = warningRenderer('en'),
    ar = warningRenderer('ar');
  assert.equal(en(redditValueUnitWarning), redditValueUnitWarning);
  assert.equal(en(xPublisherNetworkWarning(3)), xPublisherNetworkWarning(3));
  const reddit = ar(redditValueUnitWarning);
  assert.notEqual(reddit, redditValueUnitWarning);
  assert.match(reddit, /CONVERSION_PURCHASE_TOTAL_VALUE/, 'the native field name stays literal');
  assert.match(reddit, /100/);
  assert.match(reddit, /Reddit/);
  const x = ar(xPublisherNetworkWarning(3));
  assert.notEqual(x, xPublisherNetworkWarning(3));
  assert.match(x, /PUBLISHER_NETWORK/);
  assert.match(x, /: 3\./, 'the count is filled into the translated template');
  assert.match(x, /شبكة الناشرين/);
});

test('ACC-06 TikTok: sandbox mode has no qualified TikTok origin and never falls back to production', async () => {
  const plan = {
    gateway: 'tiktok_native_action',
    accountId: '7000000000000000001',
    action: 'tiktok_advertiser_info_get',
    method: 'GET',
    path: '/v1.3/advertiser/info/',
    query: {advertiser_ids: ['7000000000000000001']},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    evidence: 'synthetic',
    warnings: [],
  };
  const connection = {
    id: 'conn',
    tenantId: actor.tenantId,
    gateway: 'tiktok_native_action',
    accounts: [plan.accountId],
    enabled: true,
    label: 'Synthetic',
    scopes: [],
  };
  // Production keeps the production origin; sandbox refuses before any URL exists.
  assert.equal(buildUrl(plan, connection).origin, 'https://business-api.tiktok.com');
  assert.throws(
    () => buildUrl(plan, connection, 'sandbox'),
    e => e.code === 'SANDBOX_ROUTE_UNQUALIFIED',
  );
  let fetches = 0;
  const transport = new NativeTransport(
    async () => {
      fetches++;
      return Response.json({code: 0, data: {}});
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    'sandbox',
  );
  await assert.rejects(
    () => transport.request(plan, connection, {accessToken: 'synthetic'}),
    e => e.code === 'SANDBOX_ROUTE_UNQUALIFIED',
  );
  assert.equal(fetches, 0);
  // The sandbox runner's own egress guard refuses TikTok's production host and the unconfirmed sandbox host.
  for (const host of [
    'https://business-api.tiktok.com/open_api/v1.3/advertiser/info/',
    'https://sandbox-ads.tiktok.com/open_api/v1.3/advertiser/info/',
  ])
    await assert.rejects(
      () => sandboxFetch(async () => Response.json({}))(host),
      e => e.code === 'SANDBOX_ROUTE_UNQUALIFIED',
    );
  assert.throws(
    () =>
      validateSandboxFixture({
        gateway: 'tiktok_native_action',
        account_id: plan.accountId,
        steps: [
          {
            kind: 'write',
            gateway: 'tiktok_native_action',
            account_id: plan.accountId,
            connection_id: 'sandbox',
            arguments: {action: 'tiktok_campaign_create'},
          },
        ],
      }),
    /Google\/TikTok account isolation is not yet qualified/,
  );
});
