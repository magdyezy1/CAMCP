import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {NativeCampaignReports, normalizeNativeRow} from '../src/report-native.js';
import {assertCompatibleBaseline} from '../src/report-references.js';
import type {Actor, JsonObject} from '../src/types.js';

// RPT-04: reporting adapter correctness bundle. Each test names the defect it guards against.
const actor: Actor = {tenantId: 'adapter-correctness', userId: 'owner', role: 'admin'};

/** A store with one enabled connection and a minimal service whose runPlan answers from `answer`. */
function nativeFixture(gateway: string, account: string, answer: (plan: JsonObject) => JsonObject, seed = 61) {
  const store = new Store(':memory:', Buffer.alloc(32, seed).toString('base64'));
  store.putConnection(
    actor,
    {
      id: 'login',
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const plans: JsonObject[] = [];
  const service = {
    store,
    runPlan: async (plan: JsonObject) => {
      plans.push(plan);
      return {success: true, data: answer(plan)};
    },
  };
  return {store, plans, native: new NativeCampaignReports(service as never)};
}

test('RPT-04 item 1: requested metrics ending in date or currency are kept; identity fields never become metrics', () => {
  // Before RPT-04 a suffix filter dropped every key ending in date/id/name/currency/timezone after camel-to-snake
  // conversion, so conversionsByConversionDate never reached formulas.
  const row = normalizeNativeRow('google', {
    campaign: {id: '77', name: 'Search', resourceName: 'customers/1/campaigns/77'},
    customer: {currencyCode: 'EUR', id: '1234567890', timeZone: 'Europe/Berlin'},
    segments: {date: '2026-08-01'},
    metrics: {
      costMicros: '1500000',
      impressions: '10',
      clicks: '2',
      conversionsByConversionDate: 3.5,
      conversionsValueByConversionDate: '12.25',
      costInLocalCurrency: '7',
    },
  });
  assert.equal(row.metrics.native_google_metrics_conversionsByConversionDate, 3.5);
  assert.equal(row.metrics.native_google_metrics_conversionsValueByConversionDate, 12.25);
  assert.equal(row.metrics.native_google_metrics_costInLocalCurrency, 7);
  for (const key of Object.keys(row.metrics))
    assert.doesNotMatch(key, /(_id|_ids|_name|_date|currency_code|time_zone|timezone)$/i, key);
  assert.equal(row.metrics.native_google_campaign_id, undefined, 'a numeric campaign ID is never a metric');
  assert.equal(row.metrics.native_google_customer_id, undefined, 'a numeric customer ID is never a metric');
  const meta = normalizeNativeRow('meta', {
    account_id: '100',
    campaign_id: '101',
    campaign_name: '202',
    date_start: '2026-08-01',
    date_stop: '2026-08-01',
    account_currency: 'USD',
    spend: '10',
  });
  assert.deepEqual(
    Object.keys(meta.metrics).filter(k => k.startsWith('native_meta_')),
    ['native_meta_spend'],
    'Meta identity and context columns stay out of metrics, including a numeric-looking name',
  );
});

test('RPT-04 item 1: a warning names each requested native metric that the provider did not return', async () => {
  const f = nativeFixture('google_ads_native_action', '1234567890', plan => {
    const query = String(plan.body?.query ?? '');
    if (query.includes('FROM customer'))
      return {results: [{customer: {id: '1234567890', currencyCode: 'EUR', timeZone: 'UTC'}}]};
    return {
      results: [
        {
          campaign: {id: '77', name: 'Search'},
          customer: {currencyCode: 'EUR'},
          metrics: {costMicros: '1500000', impressions: '10', clicks: '2', conversionsByConversionDate: 2},
        },
      ],
    };
  });
  try {
    const result = await f.native.collect(
      {
        platform: 'google',
        account_id: '1234567890',
        connection_id: 'login',
        native_metrics: ['metrics.conversions_by_conversion_date', 'metrics.misspelled_field'],
      },
      {since: '2026-08-01', until: '2026-08-07'},
      actor,
    );
    assert.equal(result.rows[0].metrics.native_google_metrics_conversionsByConversionDate, 2);
    const named = result.warnings.filter((w: string) => w.startsWith('Requested native metric'));
    assert.equal(named.length, 1, JSON.stringify(result.warnings));
    assert.match(named[0], /metrics\.misspelled_field/);
  } finally {
    f.store.close();
  }
});

test('RPT-04 item 3: a Search Console site above 10,000 rows keeps its top 10,000 rows as a partial source', async () => {
  // Before RPT-04 Search Console requested 25,000 rows and then failed the whole source with REPORT_ROW_LIMIT.
  const site = 'sc-domain:example.com',
    requested: JsonObject[] = [];
  const f = nativeFixture('google_search_console_native_action', site, plan => {
    requested.push(plan.body);
    return {
      rows: Array.from({length: 10001}, (_, i) => ({
        keys: ['https://example.com/p' + i],
        clicks: 10001 - i,
        impressions: 20000,
        position: 2,
      })),
    };
  });
  try {
    const result = await f.native.collect(
      {platform: 'gsc', account_id: site, connection_id: 'login'},
      {since: '2026-08-01', until: '2026-08-07'},
      actor,
    );
    assert.equal(requested[0]!.rowLimit, 10000);
    assert.equal(result.rows.length, 10000);
    assert.equal(result.rows[0].campaign_id, 'https://example.com/p0', 'the top-ranked rows are kept');
    assert.equal(result.complete, false);
    assert.match(result.warnings.join(' '), /10,000-row request limit/);
  } finally {
    f.store.close();
  }
});

const providerRead = (overrides: JsonObject = {}): JsonObject => ({
  source: 'provider_read',
  gateway: 'google_ads_native_action',
  account_id: '1234567890',
  preset: 'google_campaign',
  grain: 'campaign × day',
  mapping: {entity_id: '/campaign/id', spend: '/metrics/costMicros'},
  source_request: {action: 'google_ads_search', path_params: {}},
  semantics: {complete: true},
  ...overrides,
});

test('RPT-04 item 2: an analyze baseline with another preset, grain, mapping or source is refused', () => {
  // Before RPT-04 analyze accepted any same-account baseline; a search-term capture against a campaign capture turned
  // a grain difference into spend-anomaly and fatigue advice.
  const report = providerRead();
  assert.doesNotThrow(() => assertCompatibleBaseline(report, providerRead({semantics: {complete: false}})));
  for (const [baseline, field] of [
    [providerRead({preset: 'google_search_terms', grain: 'campaign × ad group × search term'}), 'guided native grain'],
    [providerRead({mapping: {entity_id: '/campaign/id', spend: '/metrics/cost'}}), 'native field mapping'],
    [providerRead({source: 'overview_snapshot'}), 'source type'],
  ] as const)
    assert.throws(
      () => assertCompatibleBaseline(report, baseline),
      (e: JsonObject) => e.code === 'REPORT_SEMANTICS_MISMATCH' && e.details.fields.includes(field),
    );
  // Manual captures qualify when they use the same native action and mapping.
  const manual = (action: string) => providerRead({preset: undefined, grain: undefined, source_request: {action}});
  assert.doesNotThrow(() => assertCompatibleBaseline(manual('meta_insights'), manual('meta_insights')));
  assert.throws(
    () => assertCompatibleBaseline(manual('meta_insights'), manual('meta_ad_insights')),
    (e: JsonObject) => e.code === 'REPORT_SEMANTICS_MISMATCH',
  );
  // Overview snapshot baselines compare grouping and mapping.
  const snapshot = (grain: string) =>
    providerRead({source: 'overview_snapshot', source_request: {grain}, mapping: {spend: '/metrics/spend'}});
  assert.doesNotThrow(() => assertCompatibleBaseline(snapshot('daily'), snapshot('daily')));
  assert.throws(
    () => assertCompatibleBaseline(snapshot('daily'), snapshot('total')),
    (e: JsonObject) => e.code === 'REPORT_SEMANTICS_MISMATCH' && e.details.fields.includes('grain'),
  );
});

test('RPT-04 item 2: analyze refuses a mismatched baseline and notes an incomplete one', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 62).toString('base64'));
  try {
    store.putConnection(
      actor,
      {
        id: 'bbbbbbbb-2222-4222-8222-222222222222',
        tenantId: actor.tenantId,
        gateway: 'meta_native_action',
        accounts: ['123'],
        enabled: true,
        label: 'Synthetic',
        scopes: ['ads_read'],
      },
      {accessToken: 'synthetic'},
    );
    const rows = [{campaign_id: '111', spend: '100', clicks: '100', impressions: '2000', term: 'shoes'}];
    const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport((async (url: string) => {
        const u = new URL(String(url));
        if (u.pathname.endsWith('/insights')) return Response.json({data: rows});
        return Response.json({id: 'act_123', currency: 'USD', account_status: 1});
      }) as typeof fetch),
    );
    const capture = (window: [string, string], mapping: JsonObject, complete = true) => ({
      action: 'capture',
      gateway: 'meta_native_action',
      account_id: '123',
      connection_id: 'bbbbbbbb-2222-4222-8222-222222222222',
      arguments: {
        action: 'meta_ad_account_id_insights_get',
        ad_account_id: 'act_123',
        account_id: '123',
        fields: 'campaign_id,spend,impressions,clicks',
      },
      rows_pointer: '/data/data/data',
      mapping,
      semantics: {
        currency: 'USD',
        timezone: 'Etc/UTC',
        date_from: window[0],
        date_to: window[1],
        attribution: '7-day click',
        conversion_definition: 'purchase',
        source_name: 'Synthetic native report',
        complete,
      },
    });
    const ok = async (input: JsonObject) => {
      const out = await service.call('amcp_reporting', input, actor);
      assert.equal(out.success, true, JSON.stringify(out.error));
      return out.data as JsonObject;
    };
    const campaign = {entity_id: '/campaign_id', spend: '/spend', clicks: '/clicks', impressions: '/impressions'},
      searchTerms = {...campaign, search_term: '/term'};
    const current = await ok(capture(['2026-09-08', '2026-09-14'], campaign));
    const mismatched = await ok(capture(['2026-09-01', '2026-09-07'], searchTerms));
    const refused = await service.call(
      'amcp_reporting',
      {action: 'analyze', id: current.id, baseline_id: mismatched.id},
      actor,
    );
    assert.equal(refused.success, false);
    assert.equal(refused.error.code, 'REPORT_SEMANTICS_MISMATCH');
    const matched = await ok(capture(['2026-09-01', '2026-09-07'], campaign));
    const analysis = await ok({action: 'analyze', id: current.id, baseline_id: matched.id});
    assert.equal(analysis.baseline_id, matched.id);
    assert.equal(analysis.data_quality, undefined);
    const incomplete = await ok(capture(['2026-09-01', '2026-09-07'], campaign, false));
    const noted = await ok({action: 'analyze', id: current.id, baseline_id: incomplete.id});
    assert.match(noted.data_quality.join(' '), /baseline window is not declared complete/);
  } finally {
    store.close();
  }
});
