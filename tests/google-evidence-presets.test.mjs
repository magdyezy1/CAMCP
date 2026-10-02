import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {
  googleEvidenceInput as input,
  googleEvidenceRow as row,
  googleEvidenceResponse,
} from './fixtures/google-evidence-data.mjs';
function fixture(t, rows) {
  const actor = {tenantId: 'google-evidence', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 106).toString('base64'));
  t.after(() => store.close());
  const connection = {
      id: input.connection_id,
      tenantId: actor.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    credentials = {accessToken: 'synthetic'};
  store.putConnection(actor, connection, credentials);
  const requests = [];
  let edit = (_body, data) => data;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (raw, init) => {
        const url = new URL(raw),
          body = JSON.parse(init.body);
        assert.equal(url.origin, 'https://googleads.googleapis.com');
        assert.equal(url.pathname, '/v25/customers/123/googleAds:search');
        assert.equal(init.method, 'POST');
        requests.push({url, body, method: init.method});
        return Response.json(edit(body, googleEvidenceResponse(body, rows), requests.length));
      },
      async () => {},
    ),
  );
  return {
    actor,
    store,
    connection,
    credentials,
    requests,
    edit: fn => {
      edit = fn;
    },
    call: (args = input) => service.call('amcp_reporting', args, actor),
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};
const unsaved = f => assert.equal(f.store.documents(f.actor.tenantId, 'decision_report').length, 0);

test('Google guided presets verify customer settings and retain exact resource identity and source checks', async t => {
  for (const [preset, kind] of [
    ['google_campaign', 'campaign'],
    ['google_adset', 'ad_group'],
    ['google_ad', 'ad_group_ad'],
    ['google_search_terms', 'search_term_view'],
  ]) {
    const f = fixture(t),
      out = ok(await f.call({...input, preset}));
    assert.equal(out.totals.spend, '9007199254.740993');
    assert.equal(
      out.rows[0].entity_id,
      kind === 'ad_group_ad'
        ? row(kind).adGroupAd.resourceName
        : kind === 'search_term_view'
          ? row(kind).searchTermView.resourceName
          : '9007199254740993',
    );
    assert.equal(out.native_account_evidence.checks.length, 2);
    assert.equal(out.native_account_evidence.account_id, '123');
    assert.equal(out.native_account_evidence.timezone, 'UTC');
    assert.equal(out.source_collection, 'google_search_pages');
    assert.equal(out.source_pages[0].row_count, 1);
    assert.equal(out.collection_usage.requests, 3);
    assert.match(out.source_pages[0].source_hash, /^[0-9a-f]{64}$/);
    assert.equal(out.semantics.conversion_definition, 'metrics.conversions');
    assert.match(out.semantics_source, /declared/);
    assert.match(f.requests[1].body.query, /customer.id/);
    assert.equal(f.requests[1].body.searchSettings.returnTotalResultsCount, true);
    assert.equal(f.requests[1].body.pageSize, undefined);
    assert.equal(f.requests.length, 3);
    assert.doesNotMatch(JSON.stringify(out), /PRIVATE|accessToken|synthetic-secret/);
  }
});
test('Google guided evidence rejects foreign customer, currency, timezone, identity and date rows before persistence', async t => {
  const changes = [
    [r => (r.customer.id = '999'), 'REPORT_ACCOUNT_MISMATCH'],
    [r => (r.customer.resourceName = 'customers/999'), 'REPORT_ACCOUNT_MISMATCH'],
    [r => (r.customer.currencyCode = 'EUR'), 'REPORT_CURRENCY_MISMATCH'],
    [r => (r.customer.timeZone = 'Europe/Paris'), 'REPORT_TIMEZONE_MISMATCH'],
    [r => delete r.campaign.id, 'REPORT_SHAPE_CHANGED'],
    [r => (r.campaign.id = 9007199254740992), 'REPORT_SHAPE_CHANGED'],
    [r => (r.campaign.resourceName = 'customers/999/campaigns/' + r.campaign.id), 'REPORT_ACCOUNT_MISMATCH'],
    [r => (r.segments.date = '2020-01-01'), 'REPORT_DATE_MISMATCH'],
    [r => (r.segments.date = '2026-02-30'), 'REPORT_DATE_MISMATCH'],
    [r => (r.segments.device = 'MOBILE'), 'REPORT_SHAPE_CHANGED'],
    [r => (r.metrics = null), 'REPORT_SHAPE_CHANGED'],
  ];
  for (const [change, code] of changes) {
    const r = row();
    change(r);
    const f = fixture(t, [r]),
      out = await f.call();
    assert.equal(out.success, false, code);
    assert.equal(out.error.code, code, JSON.stringify(out));
    unsaved(f);
  }
  const f = fixture(t, [row(), row()]);
  assert.equal((await f.call()).error.code, 'REPORT_DUPLICATE_ROWS');
  unsaved(f);
});
test('Google customer checks reject changed or missing settings before and after reporting, including empty reports', async t => {
  for (const n of [1, 3])
    for (const change of [
      {id: '999'},
      {currencyCode: 'SAR'},
      {timeZone: 'Asia/Riyadh'},
      {id: 123},
      {resourceName: 'customers/999'},
    ]) {
      const f = fixture(t, []);
      f.edit((_b, d, count) => {
        if (count === n) Object.assign(d.results[0].customer, change);
        return d;
      });
      const out = await f.call();
      assert.equal(out.success, false, JSON.stringify(change));
      assert.equal(f.requests.length, n);
      unsaved(f);
    }
});
test('Google guided evidence refuses absent, partial, malformed or drifting result completion', async t => {
  for (const change of [
    d => delete d.totalResultsCount,
    d => (d.totalResultsCount = '2'),
    d => (d.totalResultsCount = '-1'),
    d => (d.totalResultsCount = '1e3'),
    d => (d.totalResultsCount = Number.MAX_SAFE_INTEGER + 1),
    d => (d.has_more = true),
    d => (d.nextPageToken = {}),
    d => (d.summaryRow = {}),
    d => (d.error = {code: 500}),
    d => (d.results = null),
  ]) {
    const f = fixture(t);
    f.edit((b, d) => {
      if (!b.query.includes('FROM customer')) change(d);
      return d;
    });
    const out = await f.call();
    assert.equal(out.success, false);
    assert.notEqual(out.error.code, 'INTERNAL_ERROR');
    unsaved(f);
  }
});
test('Google guided pages retain each request and reject duplicate rows, changed totals and repeated tokens', async t => {
  for (const mode of ['valid', 'duplicate', 'total', 'token']) {
    const f = fixture(t);
    f.edit((b, d) => {
      if (b.query.includes('FROM customer')) return d;
      if (!b.pageToken)
        return {
          results: [row('campaign', '1')],
          totalResultsCount: mode === 'token' ? '3' : '2',
          nextPageToken: 'opaque-first',
        };
      return {
        results: [row('campaign', mode === 'duplicate' ? '1' : '2')],
        totalResultsCount: mode === 'total' ? '3' : mode === 'token' ? '3' : '2',
        ...(mode === 'token' ? {nextPageToken: 'opaque-first'} : {}),
      };
    });
    const out = await f.call();
    if (mode === 'valid') {
      const report = ok(out);
      assert.equal(report.row_count, 2);
      assert.equal(report.source_pages.length, 2);
      assert.equal(report.collection_usage.requests, 4);
      assert.equal(f.requests[2].body.pageToken, 'opaque-first');
      assert.equal(f.requests[2].body.query, f.requests[1].body.query);
    } else {
      assert.equal(out.success, false, mode);
      unsaved(f);
    }
  }
});
test('Google ad and search-term identities remain distinct across native parents and malformed parent chains fail', async t => {
  for (const [preset, kind] of [
    ['google_ad', 'ad_group_ad'],
    ['google_search_terms', 'search_term_view'],
  ]) {
    const f = fixture(t, [row(kind, '3', '2'), row(kind, '3', '4')]),
      out = ok(await f.call({...input, preset}));
    assert.notEqual(out.rows[0].entity_id, out.rows[1].entity_id);
    for (const change of [
      r => (r.adGroup.resourceName = 'customers/999/adGroups/2'),
      r => (r.adGroup.id = '5'),
      r => (r.campaign.id = 1),
      r => {
        if (kind === 'ad_group_ad') r.adGroupAd.resourceName = 'customers/123/adGroupAds/9~3';
        else r.searchTermView.resourceName = 'customers/123/searchTermViews/9~2~aG9tZQ';
      },
      r => {
        if (kind === 'ad_group_ad') delete r.adGroupAd.ad.id;
        else r.searchTermView.searchTerm = 'different';
      },
    ]) {
      const r = row(kind, '3');
      change(r);
      const bad = fixture(t, [r]),
        result = await bad.call({...input, preset});
      assert.equal(result.success, false);
      unsaved(bad);
    }
  }
});
test('Google evidence binds each awaited read and persistence to current login, scopes and account access', async t => {
  for (const n of [1, 2, 3])
    for (const change of ['disable', 'credentials', 'scopes']) {
      const f = fixture(t);
      f.edit((_b, d, count) => {
        if (count === n)
          f.store.putConnection(
            f.actor,
            {
              ...f.connection,
              ...(change === 'disable' ? {enabled: false} : {}),
              ...(change === 'scopes' ? {scopes: ['changed']} : {}),
            },
            change === 'credentials' ? {accessToken: 'different'} : f.credentials,
          );
        return d;
      });
      const out = await f.call();
      assert.equal(out.success, false);
      assert.equal(f.requests.length, n);
      unsaved(f);
    }
});
test('Google empty defaults and missing metrics stay distinct, and collection respects the 10000-row bound', async t => {
  for (const defaults of [false, true]) {
    const f = fixture(t, []);
    if (defaults) f.edit((b, d) => (b.query.includes('FROM customer') ? d : {}));
    const out = ok(await f.call());
    assert.equal(out.row_count, 0);
    assert.equal(out.totals.spend, '0');
    assert.equal(out.native_account_evidence.checks.length, 2);
  }
  const r = row();
  delete r.metrics.conversions;
  const f = fixture(t, [r]),
    out = ok(await f.call());
  assert.equal(out.totals.conversions, null);
  assert.equal(out.coverage.conversions, 'partial');
  const large = fixture(t);
  large.edit((b, d) => {
    if (!b.query.includes('FROM customer')) d.totalResultsCount = '10001';
    return d;
  });
  assert.equal((await large.call()).error.code, 'REPORT_COLLECTION_LIMIT');
  unsaved(large);
  const bound = fixture(
      t,
      Array.from({length: 10000}, (_, i) => row('campaign', String(i + 1))),
    ),
    report = ok(await bound.call());
  assert.equal(report.row_count, 10000);
  assert.equal(report.collection_usage.requests, 3);
});
