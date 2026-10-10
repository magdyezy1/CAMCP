import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {
  tiktokEvidenceInput as input,
  tiktokEvidenceDay as day,
  tiktokEvidenceRow as row,
  tiktokEvidenceResponse,
} from './fixtures/tiktok-evidence-data.mjs';

function fixture(t, rows) {
  const actor = {tenantId: 'tiktok-evidence', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 105).toString('base64'));
  t.after(() => store.close());
  const connection = {
      id: input.connection_id,
      tenantId: actor.tenantId,
      gateway: 'tiktok_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    },
    credentials = {accessToken: 'synthetic'};
  store.putConnection(actor, connection, credentials);
  let edit = (_u, d) => d;
  const requests = [],
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(
        async (raw, init) => {
          const url = new URL(raw);
          requests.push({url, method: init.method});
          assert.equal(init.method, 'GET');
          return Response.json(edit(url, tiktokEvidenceResponse(raw, rows), requests.length));
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
const ok = result => {
  assert.equal(result.success, true, JSON.stringify(result));
  return result.data;
};
const unsaved = f => assert.equal(f.store.documents(f.actor.tenantId, 'decision_report').length, 0);

test('TikTok guided daily presets retain all three native grains, exact decimals and account/page source lineage', async t => {
  for (const entity of ['campaign', 'adgroup', 'ad']) {
    const f = fixture(t),
      report = ok(await f.call({...input, preset: 'tiktok_' + entity}));
    assert.equal(report.rows[0].entity_id, '9007199254740993');
    assert.equal(report.rows[0].entity_name, 'Home <img>');
    assert.equal(report.rows[0].date, input.semantics.date_from);
    assert.equal(report.totals.spend, '10.123456789');
    assert.equal(report.totals.conversions, '2');
    assert.equal(report.totals.conversion_value, null);
    assert.equal(report.totals.reach, null);
    assert.equal(report.semantics.conversion_definition, 'conversion (optimization goal)');
    assert.equal(report.semantics.attribution, 'unknown');
    assert.match(report.semantics_source, /currency.*timezone.*declared/);
    assert.equal(report.native_account_evidence.checks.length, 2);
    assert.equal(report.native_account_evidence.timezone, 'Etc/GMT');
    assert.equal(report.source_pages.length, 1);
    assert.equal(report.source_pages[0].row_count, 1);
    assert.match(report.source_pages[0].source_hash, /^[0-9a-f]{64}$/);
    assert.equal(report.collection_usage.requests, 3);
    const query = f.requests[1].url.searchParams;
    assert.equal(query.get('advertiser_id'), input.account_id);
    assert.equal(query.get('report_type'), 'BASIC');
    assert.equal(query.get('data_level'), 'AUCTION_' + entity.toUpperCase());
    assert.deepEqual(JSON.parse(query.get('dimensions')), [entity + '_id', 'stat_time_day']);
    assert.deepEqual(JSON.parse(query.get('metrics')), [
      entity + '_name',
      'spend',
      'impressions',
      'clicks',
      'conversion',
    ]);
    assert.equal(query.get('query_lifetime'), 'false');
    assert.equal(query.get('multi_adv_report_in_utc_time'), 'false');
    assert.equal(report.source_request.query.page, 1);
    assert.equal(report.source_pages[0].source_request.query.page, 1);
    assert.equal(f.requests.length, 3);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|accessToken|synthetic-secret/);
  }
});
test('TikTok guided evidence collects complete native pages before retaining rows and refuses changed counts or overlap', async t => {
  const rows = Array.from({length: 1001}, (_, i) => row('campaign', String(9007199254740993n + BigInt(i))));
  const f = fixture(t, rows),
    report = ok(await f.call());
  assert.equal(report.row_count, 1001);
  assert.equal(report.rows.length, 50);
  assert.equal(report.totals.spend, '10133.580245789');
  assert.deepEqual(
    report.source_pages.map(p => [p.page, p.row_count]),
    [
      [1, 1000],
      [2, 1],
    ],
  );
  assert.equal(report.collection_usage.requests, 4);
  const last = ok(await f.call({action: 'get', id: report.id, offset: 1000}));
  assert.equal(last.rows[0].entity_id, rows[1000].dimensions.campaign_id);
  for (const mutation of [
    d => {
      d.data.page_info.total_number = 1002;
      d.data.list.push(row('campaign', '8'));
    },
    d => {
      d.data.list[0] = rows[0];
    },
  ]) {
    const bad = fixture(t, rows);
    bad.edit((u, d) => {
      if (u.searchParams.get('page') === '2') mutation(d);
      return d;
    });
    const result = await bad.call();
    assert.equal(result.success, false);
    assert.ok(['REPORT_INCOMPLETE', 'REPORT_DUPLICATE_ROWS'].includes(result.error.code), JSON.stringify(result));
    assert.equal(bad.requests.length, 3);
    unsaved(bad);
  }
});
test('TikTok guided evidence refuses missing, partial or inconsistent native completion metadata', async t => {
  for (const mutation of [
    d => {
      delete d.data.page_info;
    },
    d => {
      d.data.page_info.page = 2;
    },
    d => {
      d.data.page_info.page_size = 10;
    },
    d => {
      d.data.page_info.total_number = '1';
    },
    d => {
      d.data.page_info.total_page = 2;
    },
    d => {
      d.data.list = [];
    },
    d => {
      d.data.has_more = false;
    },
    d => {
      d.data.paging = {next: 'https://example.invalid'};
    },
    d => {
      d.truncated = true;
    },
  ]) {
    const f = fixture(t);
    f.edit((u, d) => {
      if (u.pathname.endsWith('/report/integrated/get/')) mutation(d);
      return d;
    });
    const result = await f.call();
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'REPORT_INCOMPLETE', JSON.stringify(result));
    assert.equal(f.requests.length, 2);
    unsaved(f);
  }
});
test('TikTok guided evidence rejects foreign or malformed row identity, daily grain, duplicate rows and unsafe money', async t => {
  for (const mutation of [
    r => {
      r.dimensions.campaign_id = 9007199254740992;
    },
    r => {
      r.dimensions.campaign_id = '1e5';
    },
    r => {
      r.dimensions.advertiser_id = '999';
    },
    r => {
      r.dimensions.stat_time_hour = day(2) + ' 01:00:00';
    },
    r => {
      r.dimensions.stat_time_day = day(2) + ' 01:00:00';
    },
    r => {
      r.dimensions.stat_time_day = '2026-02-30';
    },
    r => {
      r.dimensions.stat_time_day = day(3);
    },
    r => {
      r.metrics.advertiser_id = '999';
    },
    r => {
      r.metrics.spend = Number.MAX_SAFE_INTEGER + 1;
    },
    r => {
      r.metrics.spend = '-1';
    },
    r => {
      r.metrics.spend = 'ten';
    },
    r => {
      r.metrics = null;
    },
  ]) {
    const r = row();
    mutation(r);
    const f = fixture(t, [r]),
      result = await f.call();
    assert.equal(result.success, false);
    assert.notEqual(result.error.code, 'INTERNAL_ERROR');
    assert.equal(f.requests.length >= 2, true, JSON.stringify(result));
    unsaved(f);
  }
  // RPT-01 / owner decision D10: long provider decimals and exponent text used to be refused like caller input. They
  // are lossless provider values now, rounded half to even at nine places with the rounding recorded in evidence.
  for (const [spend, total, rounded] of [
    ['0.1234567891', '0.123456789', 1],
    ['1e5', '100000', undefined],
  ]) {
    const r = row();
    r.metrics.spend = spend;
    const report = ok(await fixture(t, [r]).call());
    assert.equal(report.totals.spend, total);
    assert.equal(report.semantics.metric_rounding?.spend?.rows_rounded, rounded);
  }
  const f = fixture(t, [row(), row()]),
    result = await f.call();
  assert.equal(result.error.code, 'REPORT_DUPLICATE_ROWS');
  unsaved(f);
});
test('TikTok guided capture verifies account identity, currency and timezone before and after collection', async t => {
  for (const readNumber of [1, 3])
    for (const change of [{advertiser_id: '999'}, {currency: 'SAR'}, {timezone: 'Asia/Riyadh'}, {timezone: null}]) {
      const f = fixture(t);
      f.edit((_u, d, n) => {
        if (n === readNumber) Object.assign(d.data.list[0], change);
        return d;
      });
      const result = await f.call();
      assert.equal(result.success, false);
      assert.equal(f.requests.length, readNumber);
      assert.ok(
        ['REPORT_ACCOUNT_MISMATCH', 'REPORT_CURRENCY_MISMATCH', 'REPORT_TIMEZONE_MISMATCH'].includes(result.error.code),
        JSON.stringify(result),
      );
      unsaved(f);
    }
});
test('TikTok guided capture binds every read and persistence to current access, login and scopes', async t => {
  for (const readNumber of [1, 2, 3])
    for (const change of ['disable', 'credentials', 'scopes']) {
      const f = fixture(t);
      f.edit((_u, d, n) => {
        if (n === readNumber)
          f.store.putConnection(
            f.actor,
            {
              ...f.connection,
              ...(change === 'disable' ? {enabled: false} : {}),
              ...(change === 'scopes' ? {scopes: ['changed']} : {}),
            },
            change === 'credentials' ? {accessToken: 'different-login'} : f.credentials,
          );
        return d;
      });
      const result = await f.call();
      assert.equal(result.success, false);
      assert.equal(f.requests.length, readNumber);
      unsaved(f);
    }
});
test('TikTok guided capture preserves missing metrics as unknown and distinguishes qualified empty responses', async t => {
  const r = row();
  delete r.metrics.conversion;
  r.metrics.spend = '9007199254740993.123456789';
  const f = fixture(t, [r]),
    out = ok(await f.call());
  assert.equal(out.totals.conversions, null);
  assert.equal(out.coverage.conversions, 'partial');
  assert.equal(out.totals.spend, r.metrics.spend);
  for (const totalPage of [0, 1]) {
    const empty = fixture(t, []);
    empty.edit((u, d) => {
      if (u.pathname.endsWith('/report/integrated/get/')) d.data.page_info.total_page = totalPage;
      return d;
    });
    const report = ok(await empty.call());
    assert.equal(report.row_count, 0);
    assert.equal(report.totals.spend, '0');
    assert.equal(report.totals.conversion_value, null);
    assert.equal(report.source_pages[0].row_count, 0);
    assert.equal(empty.requests.length, 3);
  }
});
test('TikTok daily presets reject unfinished or overlong windows before egress and stop oversized collections', async t => {
  const f = fixture(t),
    presets = ok(await f.call({action: 'capture_presets'})).presets;
  assert.equal(presets.filter(p => p.id.startsWith('tiktok_')).length, 3);
  for (const semantics of [
    {date_from: day(33)},
    {date_to: day(0)},
    {date_to: day(-1)},
    {date_from: '2026-02-30'},
    {complete: false},
  ]) {
    const result = await f.call({...input, semantics: {...input.semantics, ...semantics}});
    assert.equal(result.success, false);
    assert.equal(f.requests.length, 0);
    unsaved(f);
  }
  const large = fixture(
    t,
    Array.from({length: 1000}, (_, i) => row('campaign', String(i + 1))),
  );
  large.edit((u, d) => {
    if (u.pathname.endsWith('/report/integrated/get/'))
      Object.assign(d.data.page_info, {total_number: 10001, total_page: 11});
    return d;
  });
  const result = await large.call();
  assert.equal(result.error.code, 'REPORT_COLLECTION_LIMIT');
  assert.equal(large.requests.length, 2);
  unsaved(large);
  const bound = fixture(
      t,
      Array.from({length: 10000}, (_, i) => row('campaign', String(i + 1))),
    ),
    report = ok(await bound.call());
  assert.equal(report.row_count, 10000);
  assert.equal(report.source_pages.length, 10);
  assert.equal(report.collection_usage.requests, 12);
  assert.equal(bound.requests.length, 12);
});
