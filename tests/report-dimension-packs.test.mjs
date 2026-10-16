// RPT-07 P1 dimension packs: Google Performance Max search terms and ad network, Meta age/gender, country and
// placement, and the 28d_click / 1d_ev Meta windows. Synthetic provider responses only; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import ExcelJS from 'exceljs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {reportPreset, reportPresets} from '../dist/src/report-presets.js';
import {campaignAttributionProfile, overviewSourceLevel} from '../dist/src/overview-granularity.js';
import {metaWindowsMessage, metaWindowsValid} from '../dist/src/meta-attribution-windows.js';
import {evidenceWorkbook} from '../dist/src/evidence-artifacts.js';
import {googleEvidenceCustomer} from './fixtures/google-evidence-data.mjs';

const actor = {tenantId: 'dimension-packs', userId: 'owner', role: 'admin'};
const semantics = {
  currency: 'USD',
  timezone: 'UTC',
  date_from: '2026-09-01',
  date_to: '2026-09-02',
  attribution: 'unknown',
  conversion_definition: 'unknown',
  source_name: 'Synthetic dimension pack',
  complete: true,
};
const ok = out => {
  assert.equal(out.success, true, JSON.stringify(out.error ?? out));
  return out.data;
};
const refused = (out, code) => {
  assert.equal(out.success, false, JSON.stringify(out.data ?? out));
  assert.equal(out.error.code, code, JSON.stringify(out.error));
};
/** One synthetic provider behind the real gateway, transport and capture path. */
function fixture(gateway, account, respond) {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64')),
    requests = [],
    connection = {
      id: 'aaaaaaaa-2222-4222-8222-' + (gateway === 'meta_native_action' ? '000000000002' : '000000000001'),
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      enabled: true,
      label: 'Synthetic reader',
      scopes: gateway === 'meta_native_action' ? ['ads_read'] : ['https://www.googleapis.com/auth/adwords'],
    };
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init) => {
      const url = new URL(String(raw)),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({url, method: init?.method ?? 'GET', body});
      return Response.json(respond(url, body));
    }),
    undefined,
    {allowWrites: false},
  );
  return {
    store,
    requests,
    connection,
    call: input => service.call('amcp_reporting', {connection_id: connection.id, ...input}, actor),
    saved: () => store.documents(actor.tenantId, 'decision_report'),
    close: () => store.close(),
  };
}

// ---- Google ----
const campaign = '9007199254740993';
const networkRow = (network, date = '2026-09-01', costMicros = '1500000') => ({
  customer: googleEvidenceCustomer(),
  campaign: {id: campaign, resourceName: 'customers/123/campaigns/' + campaign, name: 'Campaign <A>'},
  segments: {date, adNetworkType: network},
  metrics: {costMicros, clicks: '3', impressions: '30', conversions: 1, conversionsValue: 10},
});
const pmaxRow = (term, channel = 'PERFORMANCE_MAX', id = '77') => ({
  customer: googleEvidenceCustomer(),
  campaign: {id, resourceName: 'customers/123/campaigns/' + id, name: 'PMax', advertisingChannelType: channel},
  campaignSearchTermView: {
    resourceName: 'customers/123/campaignSearchTermViews/' + id + '~' + Buffer.from(term).toString('base64url'),
    searchTerm: term,
  },
  metrics: {costMicros: '2500000', clicks: '5', impressions: '50', conversions: 0, conversionsValue: 0},
});
function googleFixture(rows) {
  return fixture('google_ads_native_action', '123', (url, body) => {
    assert.equal(url.pathname, '/v25/customers/123/googleAds:search');
    if (/ FROM customer(?: |$)/.test(body.query))
      return {results: [{customer: googleEvidenceCustomer()}], totalResultsCount: '1'};
    const all = typeof rows === 'function' ? rows(body.query) : rows;
    return {results: all, totalResultsCount: String(all.length)};
  });
}
const googleInput = preset => ({action: 'capture_preset', preset, account_id: '123', semantics});

test('Google campaign × ad network × day keeps literal native networks; absent networks stay unknown', async () => {
  const f = googleFixture([
    networkRow('SEARCH'),
    networkRow('SEARCH_PARTNERS', '2026-09-01', '500000'),
    networkRow('YOUTUBE', '2026-09-02', '250000'),
  ]);
  try {
    const out = ok(await f.call(googleInput('google_campaign_network')));
    const query = f.requests.find(r => !/ FROM customer/.test(r.body.query)).body.query;
    assert.match(query, /segments\.ad_network_type/);
    assert.match(query, / FROM campaign WHERE segments\.date BETWEEN '2026-09-01' AND '2026-09-02'$/);
    assert.deepEqual(
      out.rows.map(r => [r.entity_id, r.native_ad_network, r.date]),
      [
        ['customers/123/campaigns/' + campaign, 'SEARCH', '2026-09-01'],
        ['customers/123/campaigns/' + campaign, 'SEARCH_PARTNERS', '2026-09-01'],
        ['customers/123/campaigns/' + campaign, 'YOUTUBE', '2026-09-02'],
      ],
    );
    assert.equal(out.totals.spend, '2.25');
    assert.equal(out.grain, 'campaign × native ad network × day');
    // CONTENT and every other network the provider did not return are unknown, never zero rows.
    assert.deepEqual(out.breakdown.observed_values.native_ad_network, ['SEARCH', 'SEARCH_PARTNERS', 'YOUTUBE']);
    assert.equal(out.breakdown.absent_buckets, 'unknown');
    assert.equal(out.breakdown.reconciles_with_parent_totals, false);
    assert.equal(out.rows.length, 3);
    // The literal network is an export column in both languages.
    const saved = f.store.document(actor.tenantId, 'decision_report', out.id);
    for (const language of ['en', 'ar']) {
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(await evidenceWorkbook(saved, language));
      const sheet = book.worksheets[1],
        header = sheet.getRow(1).values.slice(1),
        column = header.indexOf('native_ad_network') + 1;
      assert.ok(column > 0, language);
      assert.deepEqual(
        [2, 3, 4].map(row => sheet.getCell(row, column).value),
        ['SEARCH', 'SEARCH_PARTNERS', 'YOUTUBE'],
      );
    }
    // Retained rows are searchable by the native network value.
    assert.equal(ok(await f.call({action: 'get', id: out.id, row_query: 'partners'})).matched_row_count, 1);
  } finally {
    f.close();
  }
});

test('Google network refusals: undocumented networks, duplicate network/day grain and extra segments save nothing', async () => {
  for (const [rows, code] of [
    [[networkRow('SOCIAL')], 'REPORT_SHAPE_CHANGED'],
    [[networkRow('SEARCH'), networkRow('SEARCH')], 'REPORT_DUPLICATE_ROWS'],
    [
      [{...networkRow('SEARCH'), segments: {date: '2026-09-01', adNetworkType: 'SEARCH', device: 'MOBILE'}}],
      'REPORT_SHAPE_CHANGED',
    ],
    [[{...networkRow('SEARCH'), segments: {date: '2026-09-01'}}], 'REPORT_SHAPE_CHANGED'],
  ]) {
    const f = googleFixture(rows);
    try {
      refused(await f.call(googleInput('google_campaign_network')), code);
      assert.equal(f.saved().length, 0);
    } finally {
      f.close();
    }
  }
  // A mapping that rewrites the network pointer is refused before any provider read.
  const f = googleFixture([networkRow('SEARCH')]);
  try {
    const native = reportPreset({...googleInput('google_campaign_network'), connection_id: f.connection.id});
    refused(
      await f.call({
        ...native,
        action: 'capture',
        mapping: {...native.mapping, native_ad_network: {path: '/segments/adNetworkType', divisor: 1}},
      }),
      'REPORT_SHAPE_CHANGED',
    );
    assert.equal(f.requests.length, 0);
  } finally {
    f.close();
  }
});

test('Google Performance Max search terms keep the exact campaign search term view and refuse other campaigns', async () => {
  // URL-base64 may carry its standard trailing padding ('running shoes' is 13 bytes, so two '=').
  const padded = pmaxRow('running shoes');
  padded.campaignSearchTermView.resourceName += '==';
  const f = googleFixture([pmaxRow('home gym'), padded]);
  try {
    const out = ok(await f.call(googleInput('google_pmax_search_terms')));
    const query = f.requests.find(r => !/ FROM customer/.test(r.body.query)).body.query;
    assert.match(query, /FROM campaign_search_term_view WHERE segments\.date BETWEEN/);
    assert.match(query, /campaign\.advertising_channel_type = 'PERFORMANCE_MAX'/);
    assert.doesNotMatch(
      query.split(' FROM ')[0],
      /segments\./,
      'no keyword or date segment drops Performance Max data',
    );
    assert.deepEqual(
      out.rows.map(r => [r.search_term, r.entity_name, r.date]),
      [
        ['home gym', 'PMax', null],
        ['running shoes', 'PMax', null],
      ],
    );
    assert.equal(out.rows[1].entity_id, padded.campaignSearchTermView.resourceName, 'provider spelling retained');
    assert.equal(out.grain, 'Performance Max campaign × search term');
  } finally {
    f.close();
  }
  const foreignResource = pmaxRow('home gym');
  foreignResource.campaignSearchTermView.resourceName = 'customers/123/campaignSearchTermViews/78~aG9tZSBneW0';
  for (const [rows, code] of [
    [[pmaxRow('home gym', 'SEARCH')], 'REPORT_SHAPE_CHANGED'],
    [[foreignResource], 'REPORT_ACCOUNT_MISMATCH'],
    [[pmaxRow('home gym'), pmaxRow('home gym')], 'REPORT_DUPLICATE_ROWS'],
    [[{...pmaxRow('home gym'), segments: {date: '2026-09-01'}}], 'REPORT_SHAPE_CHANGED'],
  ]) {
    const g = googleFixture(rows);
    try {
      refused(await g.call(googleInput('google_pmax_search_terms')), code);
      assert.equal(g.saved().length, 0);
    } finally {
      g.close();
    }
  }
});

// ---- Meta ----
const metaRow = (extra = {}) => ({
  account_id: '100',
  account_currency: 'USD',
  campaign_id: '10',
  campaign_name: 'Campaign A',
  date_start: '2026-09-01',
  date_stop: '2026-09-01',
  spend: '10.125',
  impressions: '100',
  clicks: '12',
  reach: '80',
  frequency: '1.25',
  actions: [{action_type: 'purchase', value: '2'}],
  action_values: [{action_type: 'purchase', value: '42.5'}],
  ...extra,
});
function metaFixture(rows) {
  return fixture('meta_native_action', '100', url =>
    url.pathname.endsWith('/insights')
      ? {data: rows}
      : {id: 'act_100', account_id: '100', currency: 'USD', timezone_name: 'UTC'},
  );
}
const metaInput = (preset, windows = ['7d_click', '1d_view']) => ({
  action: 'capture_preset',
  preset,
  account_id: '100',
  result_action_type: 'purchase',
  attribution_windows: windows,
  semantics,
});
const insights = f => f.requests.find(r => r.url.pathname.endsWith('/insights')).url.searchParams;

test('Meta campaign × age × gender × day keeps literal buckets, per-bucket reach and the 28-day click and engaged-view windows', async () => {
  const f = metaFixture([
    metaRow({age: '18-24', gender: 'female'}),
    metaRow({age: '18-24', gender: 'male', reach: '70'}),
    metaRow({age: '65+', gender: 'unknown', date_start: '2026-09-02', date_stop: '2026-09-02'}),
  ]);
  try {
    const out = ok(await f.call(metaInput('meta_campaign_age_gender', ['28d_click', '1d_view', '1d_ev'])));
    const query = insights(f);
    assert.deepEqual(JSON.parse(query.get('breakdowns')), ['age', 'gender']);
    assert.deepEqual(JSON.parse(query.get('action_attribution_windows')), ['28d_click', '1d_view', '1d_ev']);
    assert.equal(query.get('level'), 'campaign');
    assert.equal(out.semantics.attribution, 'Meta 28d_click + 1d_view + 1d_ev; impression time');
    assert.deepEqual(
      out.rows.map(r => [r.entity_id, r.native_age, r.native_gender, r.date, r.reach]),
      [
        ['10', '18-24', 'female', '2026-09-01', '80'],
        ['10', '18-24', 'male', '2026-09-01', '70'],
        ['10', '65+', 'unknown', '2026-09-02', '80'],
      ],
    );
    // Additive metrics add up over the returned buckets; reach and frequency never do.
    assert.equal(out.totals.spend, '30.375');
    assert.equal(out.totals.reach, null);
    assert.equal(out.totals.frequency, null);
    // Buckets Meta did not return (25-34, 35-44, ...) are unknown, never zero rows.
    assert.deepEqual(out.breakdown.dimensions, ['native_age', 'native_gender']);
    assert.deepEqual(out.breakdown.observed_values.native_age, ['18-24', '65+']);
    assert.equal(out.rows.length, 3);
  } finally {
    f.close();
  }
});

test('Meta breakdown refusals: undocumented buckets, duplicate bucket/day grain and unrequested breakdowns save nothing', async () => {
  for (const [preset, rows, code] of [
    ['meta_campaign_age_gender', [metaRow({age: '30-40', gender: 'female'})], 'REPORT_SHAPE_CHANGED'],
    ['meta_campaign_age_gender', [metaRow({age: '18-24'})], 'REPORT_SHAPE_CHANGED'],
    [
      'meta_campaign_age_gender',
      [metaRow({age: '18-24', gender: 'female'}), metaRow({age: '18-24', gender: 'female'})],
      'REPORT_DUPLICATE_ROWS',
    ],
    ['meta_campaign_age_gender', [metaRow({age: '18-24', gender: 'female', country: 'US'})], 'REPORT_SHAPE_CHANGED'],
    ['meta_campaign_country', [metaRow({country: 'usa'})], 'REPORT_SHAPE_CHANGED'],
    ['meta_campaign_country', [metaRow({country: 'US'}), metaRow({country: 'US'})], 'REPORT_DUPLICATE_ROWS'],
    [
      'meta_campaign_placement',
      [metaRow({publisher_platform: 'tiktok', platform_position: 'feed'})],
      'REPORT_SHAPE_CHANGED',
    ],
    [
      'meta_campaign_placement',
      [metaRow({publisher_platform: 'instagram', platform_position: 'Instagram Reels'})],
      'REPORT_SHAPE_CHANGED',
    ],
  ]) {
    const f = metaFixture(rows);
    try {
      refused(await f.call(metaInput(preset)), code);
      assert.equal(f.saved().length, 0, preset);
    } finally {
      f.close();
    }
  }
});

test('Meta country and placement packs keep literal native values per campaign and day', async () => {
  const country = metaFixture([metaRow({country: 'SA'}), metaRow({country: 'unknown', spend: '1'})]);
  try {
    const out = ok(await country.call(metaInput('meta_campaign_country')));
    assert.deepEqual(JSON.parse(insights(country).get('breakdowns')), ['country']);
    assert.deepEqual(
      out.rows.map(r => r.native_country),
      ['SA', 'unknown'],
    );
    assert.equal(out.grain, 'campaign × country × day');
  } finally {
    country.close();
  }
  const placement = metaFixture([
    metaRow({publisher_platform: 'instagram', platform_position: 'instagram_reels'}),
    metaRow({publisher_platform: 'facebook', platform_position: 'feed'}),
    metaRow({publisher_platform: 'audience_network', platform_position: 'an_classic'}),
  ]);
  try {
    const out = ok(await placement.call(metaInput('meta_campaign_placement')));
    assert.deepEqual(JSON.parse(insights(placement).get('breakdowns')), ['publisher_platform', 'platform_position']);
    assert.deepEqual(
      out.rows.map(r => [r.native_publisher_platform, r.native_platform_position]),
      [
        ['instagram', 'instagram_reels'],
        ['facebook', 'feed'],
        ['audience_network', 'an_classic'],
      ],
    );
  } finally {
    placement.close();
  }
});

test('breakdown pack queries use only parameters of the pinned Meta Insights model', () => {
  const read = JSON.parse(readFileSync('tests/fixtures/meta-website-recipe-sdk-v26.json', 'utf8')).insights_read;
  for (const preset of ['meta_campaign_age_gender', 'meta_campaign_country', 'meta_campaign_placement']) {
    const query = reportPreset({...metaInput(preset), connection_id: 'c'}).arguments.query;
    for (const key of Object.keys(query)) assert.ok(key in read.params, preset + ': ' + key);
    assert.ok(reportPresets.some(p => p.id === preset && p.gateway === 'meta_native_action'));
  }
});

test('Meta windows: 28d_click and 1d_ev are explicit choices; two click windows and removed view windows are refused', () => {
  for (const windows of [
    ['28d_click'],
    ['28d_click', '1d_view'],
    ['7d_click', '1d_view', '1d_ev'],
    ['1d_ev'],
    ['1d_view'],
  ])
    assert.equal(metaWindowsValid(windows), true, windows.join('+'));
  for (const windows of [
    [],
    ['7d_click', '28d_click'],
    ['1d_click', '7d_click'],
    ['7d_view'],
    ['28d_view'],
    ['1d_click', '1d_click'],
    ['28d_click', '1d_view', '1d_ev', 'dda'],
  ])
    assert.equal(metaWindowsValid(windows), false, windows.join('+'));
  assert.throws(
    () => reportPreset({...metaInput('meta_campaign', ['7d_click', '28d_click']), connection_id: 'c'}),
    /at most one click window/,
  );
  assert.deepEqual(
    reportPreset({...metaInput('meta_ad', ['1d_ev', '28d_click']), connection_id: 'c'}).arguments.query
      .action_attribution_windows,
    ['28d_click', '1d_ev'],
    'sent in canonical order',
  );
  // The Overview's detailed sources and campaign attribution profiles follow the same rule.
  const source = {
    platform: 'meta',
    account_id: '100',
    connection_id: 'c',
    level: 'adset',
    report_options: {
      complete_window: true,
      result_action_type: 'purchase',
      attribution_windows: ['28d_click', '1d_ev'],
    },
  };
  assert.equal(overviewSourceLevel(source).id, 'adset');
  assert.throws(
    () =>
      overviewSourceLevel({
        ...source,
        report_options: {...source.report_options, attribution_windows: ['1d_click', '28d_click']},
      }),
    /at most one click window/,
  );
  assert.deepEqual(
    campaignAttributionProfile({platform: 'meta', report_options: {attribution_windows: ['28d_click', '1d_view']}}),
    {attribution_windows: ['28d_click', '1d_view']},
  );
  assert.throws(
    () => campaignAttributionProfile({platform: 'meta', report_options: {attribution_windows: ['7d_view']}}),
    /at most one click window/,
  );
  // The refusal is one shared constant, which the static Arabic inspectors cannot see; its translation is pinned here.
  const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  assert.match(catalog[metaWindowsMessage], /[؀-ۿ]/u);
  for (const token of ['1d_click', '7d_click', '28d_click', '1d_view', '1d_ev'])
    assert.ok(catalog[metaWindowsMessage].includes(token), token);
});

test('the website names the packs and offers the new Meta windows in English and Arabic', () => {
  const ctx = (locale = 'en') => {
    const c = createContext({document: {addEventListener() {}}, esc: v => String(v ?? '')});
    new Script(readFileSync('web/localization.js', 'utf8')).runInContext(c);
    if (locale === 'ar') {
      c.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
      new Script("uiLocale='ar';uiMessages=new Map(Object.entries(catalog))").runInContext(c);
    }
    return c;
  };
  const extract = (file, name) => {
    const source = readFileSync(file, 'utf8'),
      start = source.indexOf('function ' + name + '(');
    return source.slice(start, source.indexOf('\n}\n', start) + 3);
  };
  for (const locale of ['en', 'ar']) {
    const c = ctx(locale);
    new Script(extract('web/evidence-workflows.js', 'evidencePresetLabel')).runInContext(c);
    for (const id of [
      'google_pmax_search_terms',
      'google_campaign_network',
      'meta_campaign_age_gender',
      'meta_campaign_country',
      'meta_campaign_placement',
    ]) {
      c.preset = {id, name: 'untranslated fallback'};
      const label = new Script('evidencePresetLabel(preset)').runInContext(c);
      assert.notEqual(label, 'untranslated fallback', id);
      if (locale === 'ar') assert.match(label, /[؀-ۿ]/u, id);
    }
  }
  const c = ctx('ar');
  new Script(extract('web/report-library.js', 'overviewGranularityFields')).runInContext(c);
  c.platform = {
    id: 'meta',
    entity_levels: [
      {id: 'campaign', label: 'Campaign'},
      {id: 'adset', label: 'Ad set'},
    ],
  };
  const html = new Script(
    "overviewGranularityFields(platform, {level: 'adset', report_options: {attribution_windows: ['28d_click', '1d_ev']}})",
  ).runInContext(c);
  assert.match(html, /<option value="28d_click" selected>28d_click<\/option>/);
  assert.match(html, /data-report-engaged-view-window="meta" checked> 1d_ev \(مشاهدة تفاعلية\)/);
  const evidence = readFileSync('web/evidence-workflows.js', 'utf8');
  for (const value of ['28d_click', '28d_click,1d_view', '7d_click,1d_view,1d_ev'])
    assert.ok(evidence.includes('<option value="' + value + '">'), value);
});
