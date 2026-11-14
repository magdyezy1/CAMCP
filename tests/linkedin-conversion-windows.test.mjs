// RPT-07 (B18): LinkedIn attribution windows verified per conversion rule instead of declared. Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {linkedInConversionWindows} from '../dist/src/linkedin-conversion-windows.js';
import {compareDeclaredReference} from '../dist/src/report-references.js';

const actor = {tenantId: 'linkedin-windows', userId: 'owner', role: 'admin'};
const connectionId = 'aaaaaaaa-1111-4111-8111-111111111111';
const day = offset => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
const nativeDate = date => {
  const [year, month, d] = date.split('-').map(Number);
  return {year, month, day: d};
};
const input = {
  action: 'capture_preset',
  preset: 'linkedin_campaign_conversion',
  account_id: '100',
  connection_id: connectionId,
  semantics: {
    currency: 'USD',
    timezone: 'UTC',
    date_from: day(2),
    date_to: day(1),
    source_name: 'Synthetic LinkedIn conversions',
    attribution: 'verified_per_rule',
    complete: true,
  },
};
const row = (campaign, conversion, date = input.semantics.date_from, extra = {}) => ({
  pivotValues: ['urn:li:sponsoredCampaign:' + campaign, 'urn:lla:llaPartnerConversion:' + conversion],
  dateRange: {start: nativeDate(date), end: nativeDate(date)},
  externalWebsiteConversions: 3,
  externalWebsitePostClickConversions: 2,
  externalWebsitePostViewConversions: 1,
  conversionValueInLocalCurrency: '12.5',
  ...extra,
});
const rule = (id, click = 30, view = 7) => ({
  id,
  account: 'urn:li:sponsoredAccount:100',
  name: 'Rule ' + id,
  enabled: true,
  type: 'PURCHASE',
  attributionType: 'LAST_TOUCH_BY_CONVERSION',
  postClickAttributionWindowSize: click,
  viewThroughAttributionWindowSize: view,
});
const rulesPage = rules => ({elements: rules, paging: {start: 0, count: 100, total: rules.length, links: []}});

function fixture(analytics, rules, {currency = 'USD'} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64')),
    requests = [];
  const connection = {
    id: connectionId,
    tenantId: actor.tenantId,
    gateway: 'linkedin_native_action',
    accounts: ['100'],
    enabled: true,
    label: 'Synthetic',
    scopes: ['r_ads', 'r_ads_reporting'],
  };
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init) => {
      const url = new URL(raw);
      requests.push(url);
      assert.equal(init.method, 'GET', 'only reads are sent');
      if (url.pathname === '/rest/adAccounts/100') return Response.json({id: 100, currency});
      if (url.pathname === '/rest/adAnalytics') return Response.json(analytics);
      if (url.pathname === '/rest/conversions') return Response.json(rulesPage(rules));
      throw Error('Unexpected request ' + url.pathname);
    }),
  );
  return {store, requests, call: (args = input) => service.call('amcp_reporting', args, actor)};
}

test('uniform rule windows are verified per rule in the same bracket as the campaign × conversion analytics', async () => {
  const f = fixture({elements: [row(11, 501), row(12, 502), row(11, 502)]}, [rule('501'), rule('502')]);
  try {
    const out = await f.call();
    assert.equal(out.success, true, JSON.stringify(out));
    const query = f.requests.find(u => u.pathname === '/rest/adAnalytics').searchParams;
    assert.equal(query.get('q'), 'statistics');
    assert.equal(query.get('pivots'), 'List(CAMPAIGN,CONVERSION)');
    assert.equal(query.get('timeGranularity'), 'DAILY');
    assert.match(query.get('fields'), /externalWebsitePostClickConversions/);
    assert.match(query.get('fields'), /externalWebsitePostViewConversions/);
    // Account check, analytics, account check, then the rule read inside the same authorization bracket.
    assert.deepEqual(
      f.requests.map(u => u.pathname),
      [
        '/rest/adAccounts/100',
        '/rest/adAnalytics',
        '/rest/adAccounts/100',
        '/rest/adAccounts/100',
        '/rest/conversions',
        '/rest/adAccounts/100',
      ],
    );
    assert.equal(out.data.conversion_windows.status, 'verified_per_rule');
    assert.deepEqual(out.data.conversion_windows.single_window, {post_click_days: 30, post_view_days: 7});
    assert.equal(
      out.data.semantics.attribution,
      'LinkedIn conversion rules: 30-day post-click / 7-day post-view (verified per rule)',
    );
    assert.equal(out.data.semantics.conversion_definition, 'externalWebsiteConversions by conversion rule');
    assert.equal(out.data.rows[0].native_conversion, 'urn:lla:llaPartnerConversion:501');
    assert.equal(out.data.totals.conversions, '9');
    assert.equal(out.data.totals.post_click_conversions, '6');
    assert.equal(out.data.totals.post_view_conversions, '3');
    // Spend is not split by conversion: it stays unmapped, never zero.
    assert.equal(out.data.totals.spend, null);
    assert.equal(out.data.coverage.spend, 'unmapped');
    assert.equal(out.data.coverage.post_click_conversions, 'mapped');
    assert.equal(out.data.grain, 'campaign × conversion × day');
    assert.match(out.data.semantics_source, /current conversion rules/);
  } finally {
    f.store.close();
  }
});

test('different rule windows are labelled mixed and refuse any single declared window', async () => {
  const f = fixture({elements: [row(11, 501), row(11, 502)]}, [rule('501', 30, 7), rule('502', 7, 1)]);
  try {
    const out = await f.call();
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.conversion_windows.status, 'mixed');
    assert.equal(out.data.conversion_windows.single_window, null);
    assert.deepEqual(out.data.conversion_windows.distinct_windows, ['30d click / 7d view', '7d click / 1d view']);
    assert.match(out.data.semantics.attribution, /mixed windows, no single window/);
    // A declared reference naming one window (even the report's own label) is refused for mixed windows.
    const report = {...out.data, source: 'provider_read', preset: 'linkedin_campaign_conversion'};
    assert.throws(
      () =>
        compareDeclaredReference(report, {
          context: {
            gateway: 'linkedin_native_action',
            account_id: '100',
            currency: 'USD',
            timezone: 'UTC',
            date_from: input.semantics.date_from,
            date_to: input.semantics.date_to,
            attribution: out.data.semantics.attribution,
            conversion_definition: out.data.semantics.conversion_definition,
            grain: 'campaign × conversion × day',
            complete: true,
            same_entities_and_filters: true,
          },
        }),
      e => e.code === 'REPORT_SEMANTICS_MISMATCH' && e.details.fields.includes('attribution'),
    );
  } finally {
    f.store.close();
  }
});

test('a conversion without a current rule (deleted) keeps its window unknown', async () => {
  const f = fixture({elements: [row(11, 501), row(11, 777)]}, [rule('501')]);
  try {
    const out = await f.call();
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.conversion_windows.status, 'unknown');
    assert.equal(out.data.semantics.attribution, 'unknown');
    assert.deepEqual(out.data.conversion_windows.unknown_conversions, ['urn:lla:llaPartnerConversion:777']);
    const deleted = out.data.conversion_windows.windows.find(w => w.conversion.endsWith(':777'));
    assert.equal(deleted.reason, 'rule_not_found');
    assert.equal(deleted.post_click_days, null);
  } finally {
    f.store.close();
  }
});

test('element-limit, empty, malformed pivots and duplicate grain are refused before evidence is saved', async () => {
  const many = Array.from({length: 15000}, (_, i) => row(11, 501, input.semantics.date_from, {pivotValues: []}));
  for (const [analytics, code] of [
    [{elements: many}, 'REPORT_INCOMPLETE'],
    [{elements: []}, 'REPORT_EMPTY_AMBIGUOUS'],
    [{elements: [row(11, 501, undefined, {pivotValues: ['urn:li:sponsoredCampaign:11']})]}, 'REPORT_SHAPE_CHANGED'],
    [
      {
        elements: [
          row(11, 501, undefined, {pivotValues: ['urn:li:sponsoredCampaign:11', 'urn:li:sponsoredCreative:5']}),
        ],
      },
      'REPORT_SHAPE_CHANGED',
    ],
    [{elements: [row(11, 501), row(11, 501)]}, 'REPORT_DUPLICATE_ROWS'],
  ]) {
    const f = fixture(analytics, [rule('501')]);
    try {
      const out = await f.call();
      assert.equal(out.success, false);
      assert.equal(out.error.code, code, JSON.stringify(out.error));
      assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
      assert.ok(!f.requests.some(u => u.pathname === '/rest/conversions'), 'no rule read after a refused response');
    } finally {
      f.store.close();
    }
  }
});

test('a typed single window is refused before any provider read', async () => {
  const f = fixture({elements: [row(11, 501)]}, [rule('501')]);
  try {
    for (const attribution of ['30-day click / 7-day view', 'unknown']) {
      const out = await f.call({...input, semantics: {...input.semantics, attribution}});
      assert.equal(out.success, false);
      assert.equal(out.error.code, 'REPORT_ATTRIBUTION_DECLARED');
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('a changed account currency during the rule read refuses the capture', async () => {
  let reads = 0;
  const store = new Store(':memory:', Buffer.alloc(32, 92).toString('base64'));
  store.putConnection(
    actor,
    {
      id: connectionId,
      tenantId: actor.tenantId,
      gateway: 'linkedin_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['r_ads', 'r_ads_reporting'],
    },
    {accessToken: 'synthetic'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async raw => {
      const url = new URL(raw);
      if (url.pathname === '/rest/adAccounts/100')
        return Response.json({id: 100, currency: ++reads > 2 ? 'EUR' : 'USD'});
      if (url.pathname === '/rest/adAnalytics') return Response.json({elements: [row(11, 501)]});
      return Response.json(rulesPage([rule('501')]));
    }),
  );
  try {
    const out = await service.call('amcp_reporting', input, actor);
    assert.equal(out.success, false);
    assert.equal(out.error.code, 'REPORT_CURRENCY_MISMATCH');
    assert.equal(store.documents(actor.tenantId, 'decision_report').length, 0);
  } finally {
    store.close();
  }
});

test('the window join is pure and never inherits a window for a missing rule', () => {
  const rules = [
    {id: '1', urn: 'urn:lla:llaPartnerConversion:1', post_click_days: 30, post_view_days: 7},
    {id: '2', urn: 'urn:lla:llaPartnerConversion:2', post_click_days: 30, post_view_days: null},
  ];
  assert.equal(linkedInConversionWindows(rules, ['urn:lla:llaPartnerConversion:1']).status, 'verified_per_rule');
  const missingWindow = linkedInConversionWindows(rules, ['urn:lla:llaPartnerConversion:2']);
  assert.equal(missingWindow.status, 'unknown');
  assert.equal(missingWindow.windows[0].reason, 'rule_window_missing');
  assert.throws(() => linkedInConversionWindows(rules, ['urn:li:sponsoredCreative:1']), {code: 'REPORT_SHAPE_CHANGED'});
});

// P2B-08 (c): the Overview joins the account's own rules, not the conversions its analytics counted (they are not split by
// conversion), so it cannot say the windows are verified per rule: the same join says what it read. The guided join, which
// looks up each conversion it reports, keeps its words byte for byte.
test('the join over the account’s own rules claims those rules, never a verification per rule, and the guided join keeps its words', () => {
  const stated = (id, click, view) => ({
      id,
      urn: 'urn:lla:llaPartnerConversion:' + id,
      post_click_days: click,
      post_view_days: view,
    }),
    one = [stated('1', 30, 7), stated('2', 30, 7)],
    urns = rules => rules.map(r => r.urn),
    guided = linkedInConversionWindows(one, urns(one)),
    own = linkedInConversionWindows(one, urns(one), 'account_rules');
  assert.equal(guided.status, 'verified_per_rule');
  assert.equal(
    guided.attribution,
    'LinkedIn conversion rules: 30-day post-click / 7-day post-view (verified per rule)',
  );
  assert.equal(own.status, 'single_window');
  assert.equal(own.attribution, 'LinkedIn conversion rules: 30-day post-click / 7-day post-view (per account rules)');
  assert.deepEqual(own.single_window, {post_click_days: 30, post_view_days: 7});
  assert.doesNotMatch(JSON.stringify(own), /verif/i);
  // Different pairs and a rule without a window say what they said before, with no verification in the words either.
  const mixed = [stated('1', 30, 7), stated('2', 7, 1)],
    unknown = [stated('1', 30, 7), stated('2', 30, null)];
  for (const [rules, status, attribution] of [
    [
      mixed,
      'mixed',
      'LinkedIn conversion rules with mixed windows, no single window: 30d click / 7d view; 7d click / 1d view',
    ],
    [unknown, 'unknown', 'unknown'],
  ]) {
    const kept = linkedInConversionWindows(rules, urns(rules)),
      said = linkedInConversionWindows(rules, urns(rules), 'account_rules');
    assert.deepEqual([said.status, said.attribution], [status, attribution]);
    assert.deepEqual([kept.status, kept.attribution], [status, attribution]);
    assert.doesNotMatch(JSON.stringify(said), /verif/i);
  }
});
