import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {reportPreset} from '../dist/src/report-presets.js';
import {paginate} from '../dist/src/pagination.js';

const actor = {tenantId: 'linkedin-evidence', userId: 'owner', role: 'admin'};
const connectionId = 'aaaaaaaa-1111-4111-8111-111111111111';
const day = offset => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
const nativeDate = date => {
  const [year, month, day] = date.split('-').map(Number);
  return {year, month, day};
};
const input = {
  action: 'capture_preset',
  preset: 'linkedin_campaign',
  account_id: '100',
  connection_id: connectionId,
  semantics: {
    currency: 'USD',
    timezone: 'UTC',
    date_from: day(2),
    date_to: day(1),
    source_name: 'Synthetic LinkedIn',
    attribution: 'unknown',
    complete: true,
  },
};
const nativeRow = (extra = {}) => ({
  pivotValues: ['urn:li:sponsoredCampaign:9007199254740993'],
  dateRange: {start: nativeDate(input.semantics.date_from), end: nativeDate(input.semantics.date_from)},
  costInLocalCurrency: '10.123456789',
  impressions: 100,
  clicks: 12,
  externalWebsiteConversions: 2,
  conversionValueInLocalCurrency: '42.51',
  ...extra,
});
function fixture(
  response = {elements: [nativeRow()], paging: {start: 0, count: 10, links: []}},
  account = {id: 100, currency: 'USD'},
  accountId = '100',
) {
  const store = new Store(':memory:', Buffer.alloc(32, 72).toString('base64')),
    requests = [];
  const connection = {
    id: connectionId,
    tenantId: actor.tenantId,
    gateway: 'linkedin_native_action',
    accounts: [accountId],
    enabled: true,
    label: 'Synthetic',
    scopes: ['r_ads', 'r_ads_reporting'],
  };
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  let onRead = () => {};
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init) => {
      const url = new URL(raw);
      requests.push({url, method: init.method, headers: new Headers(init.headers)});
      assert.equal(init.method, 'GET');
      const result = url.pathname === '/rest/adAccounts/' + accountId ? account : response;
      if (!['/rest/adAccounts/' + accountId, '/rest/adAnalytics'].includes(url.pathname))
        throw Error('Unexpected request');
      onRead(url.pathname);
      return Response.json(result);
    }),
  );
  return {
    store,
    requests,
    connection,
    call: (args = {...input, account_id: accountId}) => service.call('amcp_reporting', args, actor),
    onRead: fn => {
      onRead = fn;
    },
  };
}
test('LinkedIn guided presets request exact native hierarchy and currency-checked UTC evidence with original source lineage', async () => {
  for (const [preset, pivot, kind] of [
    ['campaign_group', 'CAMPAIGN_GROUP', 'sponsoredCampaignGroup'],
    ['campaign', 'CAMPAIGN', 'sponsoredCampaign'],
    ['creative', 'CREATIVE', 'sponsoredCreative'],
  ]) {
    const row = nativeRow({pivotValues: [`urn:li:${kind}:9007199254740993`]}),
      f = fixture({elements: [row]});
    try {
      const out = await f.call({...input, preset: 'linkedin_' + preset});
      assert.equal(out.success, true, JSON.stringify(out));
      assert.equal(out.data.rows[0].entity_id, row.pivotValues[0]);
      assert.equal(out.data.rows[0].entity_name, null);
      assert.equal(out.data.rows[0].date, input.semantics.date_from);
      assert.equal(out.data.totals.spend, '10.123456789');
      assert.equal(out.data.totals.conversions, '2');
      assert.equal(out.data.totals.reach, null);
      assert.equal(out.data.semantics.timezone, 'UTC');
      assert.equal(out.data.semantics.attribution, 'unknown');
      assert.equal(out.data.semantics.conversion_definition, 'externalWebsiteConversions');
      assert.match(out.data.semantics_source, /currency.*UTC/);
      assert.equal(out.data.native_account_evidence.currency, 'USD');
      assert.ok(out.data.native_account_evidence.source_hash);
      assert.deepEqual(
        f.requests.map(r => r.url.pathname),
        ['/rest/adAccounts/100', '/rest/adAnalytics', '/rest/adAccounts/100'],
      );
      const query = f.requests[1].url.searchParams;
      assert.equal(query.get('pivot'), pivot);
      assert.equal(query.get('accounts'), 'List(urn:li:sponsoredAccount:100)');
      assert.equal(query.get('timeGranularity'), 'DAILY');
      assert.equal(query.get('start'), null);
      assert.equal(query.get('count'), null);
      assert.equal(out.data.source_request.query.pivot, pivot);
      assert.equal(f.requests[1].headers.get('linkedin-version'), '202609');
      assert.equal(out.data.collection_usage.requests, 3);
    } finally {
      f.store.close();
    }
  }
});
test('LinkedIn capture refuses ambiguous empty results, partial metadata, malformed or duplicate native grain without saving evidence', async () => {
  for (const response of [
    {elements: []},
    {elements: [nativeRow()], paging: {total: 2}},
    {elements: [nativeRow()], paging: {links: [{rel: 'next', href: 'https://example.invalid/'}]}},
    {elements: [nativeRow()], paging: {start: 1}},
    {elements: [nativeRow()], paging: {total: '1'}},
    {elements: [nativeRow()], metadata: {nextPageToken: 'cursor'}},
    {elements: [nativeRow({dateRange: {start: {year: 2026, month: 9, day: 1}, end: {year: 2026, month: 9, day: 2}}})]},
    {
      elements: [
        nativeRow({dateRange: {start: {year: 2026, month: 2, day: 30}, end: {year: 2026, month: 2, day: 30}}}),
      ],
    },
    {elements: [nativeRow({pivotValues: ['urn:li:sponsoredCreative:5']})]},
    {elements: [nativeRow({pivotValues: ['urn:li:sponsoredCampaign:5', 'urn:li:sponsoredCampaign:6']})]},
    {elements: [nativeRow(), nativeRow()]},
    {elements: [null]},
  ]) {
    const f = fixture(response);
    try {
      const out = await f.call();
      assert.equal(out.success, false, JSON.stringify(response));
      assert.notEqual(out.error.code, 'INTERNAL_ERROR', JSON.stringify(out));
      assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
      assert.equal(f.requests.length, 2, 'the response is refused after a real bound read');
    } finally {
      f.store.close();
    }
  }
});
test('LinkedIn capture verifies native account identity and currency before the analytics request', async () => {
  for (const account of [{id: 999, currency: 'USD'}, {id: 100, currency: 'SAR'}, {id: 100}, {currency: 'USD'}]) {
    const f = fixture(undefined, account);
    try {
      const out = await f.call();
      assert.equal(out.success, false);
      assert.equal(f.requests.length, 1);
      assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('LinkedIn omitted metrics stay unknown and capture rejects invalid settings before any egress', async () => {
  const f = fixture({
    elements: [nativeRow({externalWebsiteConversions: undefined, conversionValueInLocalCurrency: undefined})],
  });
  try {
    const out = await f.call();
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.rows[0].conversions, null);
    assert.equal(out.data.totals.conversions, null);
    assert.equal(out.data.totals.conversion_value, null);
    f.requests.length = 0;
    for (const patch of [
      {timezone: 'Asia/Riyadh'},
      {currency: 'usd'},
      {attribution: ''},
      {date_from: '2026-02-30'},
      {date_from: '2000-01-01'},
      {date_to: day(-2)},
    ]) {
      assert.equal((await f.call({...input, semantics: {...input.semantics, ...patch}})).success, false);
    }
    assert.equal(f.requests.length, 0);
    assert.throws(() => reportPreset({...input, account_id: '100)'}));
  } finally {
    f.store.close();
  }
});
test('LinkedIn evidence rechecks current account access after the native reads', async () => {
  for (const path of ['/rest/adAccounts/100', '/rest/adAnalytics']) {
    const f = fixture();
    try {
      f.onRead(p => {
        if (p === path) f.store.putConnection(actor, {...f.connection, enabled: false}, {accessToken: 'synthetic'});
      });
      assert.equal((await f.call()).success, false);
      assert.ok(f.requests.some(r => r.url.pathname === path));
      assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
    } finally {
      f.store.close();
    }
  }
});

test('LinkedIn guided evidence keeps before/after account checks and a bounded original analytics source reference', async () => {
  const f = fixture(undefined, {id: 100, currency: 'USD', private_billing_field: 'PRIVATE-UNSELECTED'});
  try {
    const out = await f.call();
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.native_account_evidence.checks?.length, 2);
    assert.equal(out.data.source_collection, 'linkedin_analytics');
    assert.equal(out.data.source_pages.length, 1);
    assert.equal(out.data.source_pages[0].row_count, 1);
    assert.equal(out.data.source_pages[0].page, 1);
    assert.deepEqual(out.data.source_pages[0].source_request, out.data.source_request);
    assert.equal(out.data.source_pages[0].source_hash, out.data.source_hash);
    for (const check of out.data.native_account_evidence.checks) {
      assert.equal(check.source_request.account_id, '100');
      assert.match(check.source_hash, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(check.captured_at));
    }
    assert.equal(out.data.collection_usage.requests, 3);
    assert.doesNotMatch(JSON.stringify(out.data), /PRIVATE-UNSELECTED|private_billing_field/);
    assert.deepEqual(
      f.requests.map(r => r.url.pathname),
      ['/rest/adAccounts/100', '/rest/adAnalytics', '/rest/adAccounts/100'],
    );
  } finally {
    f.store.close();
  }
});

test('LinkedIn guided capture refuses changed native account identity or currency before persistence', async () => {
  for (const patch of [{currency: 'SAR'}, {id: 999}]) {
    const account = {id: 100, currency: 'USD'},
      f = fixture(undefined, account);
    try {
      f.onRead(path => {
        if (path === '/rest/adAnalytics') Object.assign(account, patch);
      });
      const out = await f.call();
      assert.equal(out.success, false, JSON.stringify(patch));
      assert.equal(f.requests.length, 3);
      assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
    } finally {
      f.store.close();
    }
  }
});

test('LinkedIn guided capture binds every await to the original login credentials and scopes', async () => {
  for (const path of ['/rest/adAccounts/100', '/rest/adAnalytics'])
    for (const change of ['credentials', 'scopes']) {
      const f = fixture();
      try {
        f.onRead(current => {
          if (current !== path) return;
          f.store.putConnection(
            actor,
            {...f.connection, ...(change === 'scopes' ? {scopes: ['r_ads', 'r_ads_reporting', 'rw_ads']} : {})},
            {accessToken: change === 'credentials' ? 'replacement' : 'synthetic'},
          );
        });
        const out = await f.call();
        assert.equal(out.success, false, path + ' ' + change);
        assert.equal(out.error.code, 'CONNECTION_AUTHORITY_CHANGED');
        assert.equal(f.requests.length, path === '/rest/adAccounts/100' ? 1 : 2);
        assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
      } finally {
        f.store.close();
      }
    }
});

test('LinkedIn guided account checks reject coerced identities and ambiguous native account wrappers', async () => {
  for (const account of [
    {id: [100], currency: 'USD'},
    {id: 100, currency: 'USD', paging: {}},
    {id: 100, currency: 'USD', elements: []},
    {id: 100, currency: 'USD', errors: []},
  ]) {
    const f = fixture(undefined, account);
    try {
      const out = await f.call();
      assert.equal(out.success, false, JSON.stringify(account));
      assert.equal(f.requests.length, 1);
      assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
    } finally {
      f.store.close();
    }
  }
});

test('LinkedIn capture refuses withdrawal during the final account check but accepts unchanged reordered scopes', async () => {
  for (const disabled of [true, false]) {
    const f = fixture();
    let accounts = 0;
    try {
      f.onRead(path => {
        if (path === '/rest/adAccounts/100' && ++accounts === 2)
          f.store.putConnection(
            actor,
            {...f.connection, enabled: !disabled, scopes: [...f.connection.scopes].reverse()},
            {accessToken: 'synthetic'},
          );
      });
      const out = await f.call();
      assert.equal(out.success, !disabled);
      assert.equal(f.requests.length, 3);
      assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, disabled ? 0 : 1);
    } finally {
      f.store.close();
    }
  }
});

test('LinkedIn evidence preserves exact string account IDs and refuses unsafe numeric identities', async () => {
  for (const id of ['9007199254740992', 9007199254740992]) {
    const f = fixture(undefined, {id, currency: 'USD'}, '9007199254740992');
    try {
      const out = await f.call();
      assert.equal(out.success, typeof id === 'string', JSON.stringify(out));
      assert.equal(f.requests.length, typeof id === 'string' ? 3 : 1);
      assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, typeof id === 'string' ? 1 : 0);
    } finally {
      f.store.close();
    }
  }
});

test('LinkedIn keeps all 10,000 unique native rows and refuses larger single responses without another account read', async () => {
  for (const count of [10000, 10001]) {
    const rows = Array.from({length: count}, (_, i) =>
        nativeRow({pivotValues: ['urn:li:sponsoredCampaign:' + (9007199254740993n + BigInt(i))]}),
      ),
      f = fixture({elements: rows});
    try {
      const out = await f.call();
      assert.equal(out.success, count === 10000, out.error?.message);
      assert.equal(f.requests.length, count === 10000 ? 3 : 2);
      if (out.success) {
        assert.equal(out.data.row_count, 10000);
        assert.equal(out.data.totals.spend, '101234.56789');
        const last = await f.call({action: 'get', id: out.data.id, offset: 9950, limit: 50});
        assert.equal(last.data.rows.at(-1).entity_id, rows.at(-1).pivotValues[0]);
        assert.equal(f.requests.length, 3);
      } else assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
    } finally {
      f.store.close();
    }
  }
});

test('LinkedIn adAnalytics never invents an offset page from REST.li metadata and refuses advertised truncation', async () => {
  const plan = {gateway: 'linkedin_native_action', path: '/rest/adAnalytics', method: 'GET', query: {q: 'analytics'}};
  let calls = 0;
  const out = await paginate(
    plan,
    async () => {
      calls++;
      return {elements: [nativeRow()], paging: {start: 0, count: 10, links: []}};
    },
    5,
  );
  assert.equal(calls, 1);
  assert.equal(out.truncated, false);
  for (const response of [
    {elements: [nativeRow()], paging: {total: 2}},
    {elements: Array.from({length: 15000}, () => nativeRow())},
  ]) {
    await assert.rejects(
      paginate(plan, async () => response, 5),
      /incomplete|limit|partial/i,
    );
  }
});
