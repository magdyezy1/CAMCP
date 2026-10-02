import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const rule = (id, extra = {}) => ({
  id,
  account: 'urn:li:sponsoredAccount:100',
  name: 'Purchase <img>',
  enabled: true,
  type: 'PURCHASE',
  attributionType: 'LAST_TOUCH_BY_CONVERSION',
  postClickAttributionWindowSize: 30,
  viewThroughAttributionWindowSize: 7,
  valueType: 'FIXED',
  value: {amount: '9007199254740993.123456789', currencyCode: 'USD'},
  imagePixelTag: '<img src="PRIVATE">',
  urlRules: [{matchValue: 'PRIVATE'}],
  ...extra,
});
const page = (rows, start = 0, total = rows.length, next = false) => ({
  elements: rows,
  paging: {
    start,
    count: 100,
    ...(total === null ? {} : {total}),
    links: next ? [{rel: 'next', href: 'https://api.linkedin.com/rest/conversions?start=' + (start + 100)}] : [],
  },
});
function fixture(t) {
  const identity = {tenantId: 'conversion-evidence', userId: 'reader', role: 'reader'},
    store = new Store(':memory:', Buffer.alloc(32, 108).toString('base64'));
  t.after(() => store.close());
  const key = store.createKey(identity),
    actor = store.authenticate(key),
    connection = {
      id: 'aaaaaaaa-1111-4111-8111-111111111111',
      tenantId: actor.tenantId,
      gateway: 'linkedin_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['r_ads'],
    };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  const requests = [];
  let respond = () => page([rule('9007199254740993')]),
    account = () => ({id: 100, currency: 'USD', billing: 'PRIVATE'}),
    onRead = () => {};
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const parsed = new URL(url);
      requests.push({url: parsed, method: init.method});
      assert.equal(init.method, 'GET');
      const data = parsed.pathname === '/rest/adAccounts/100' ? account() : respond(parsed);
      assert.ok(['/rest/adAccounts/100', '/rest/conversions'].includes(parsed.pathname));
      onRead(parsed);
      return Response.json(data);
    }),
  );
  const args = {
    action: 'measurement_conversions',
    gateway: connection.gateway,
    account_id: '100',
    connection_id: connection.id,
  };
  return {
    store,
    actor,
    key,
    connection,
    requests,
    args,
    service,
    call: extra => service.call('amcp_workspace', {...args, ...extra}, actor),
    respond: fn => {
      respond = fn;
    },
    account: fn => {
      account = fn;
    },
    onRead: fn => {
      onRead = fn;
    },
  };
}
const ok = response => {
  assert.equal(response.success, true, JSON.stringify(response));
  return response.data;
};

test('LinkedIn conversion evidence reads only current selected-account configuration and projects exact native settings', async t => {
  const f = fixture(t),
    response = await f.call(),
    out = ok(response);
  assert.equal(out.record_kind, 'conversion_rules');
  assert.equal(out.rule_count, 1);
  assert.equal(out.rules[0].id, '9007199254740993');
  assert.equal(out.rules[0].urn, 'urn:lla:llaPartnerConversion:9007199254740993');
  assert.equal(out.rules[0].post_click_days, 30);
  assert.equal(out.rules[0].post_view_days, 7);
  assert.equal(out.rules[0].attribution_type, 'LAST_TOUCH_BY_CONVERSION');
  assert.deepEqual(out.rules[0].value, {amount: '9007199254740993.123456789', currency: 'USD'});
  assert.equal(out.account_evidence.checks.length, 2);
  assert.equal(out.source_pages.length, 1);
  assert.match(out.source_hash, /^[a-f0-9]{64}$/);
  assert.equal(out.checks.historical_attribution, 'unverified');
  assert.equal(out.checks.event_delivery, 'unverified');
  assert.equal(out.checks.campaign_membership, 'not_collected');
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE|imagePixelTag|urlRules|accessToken/);
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[1].url.searchParams.get('q'), 'account');
  assert.equal(f.requests[1].url.searchParams.get('account'), 'urn:li:sponsoredAccount:100');
  assert.equal(f.requests[1].url.searchParams.get('count'), '100');
  assert.equal(f.store.documents(f.actor.tenantId, 'conversion_rules').length, 0);
  assert.match(response.meta.workflow.website_path, /^\/measurement\?conversion_rules=1&/);
});

test('LinkedIn conversion evidence completes bounded native offset pages without following links or defaulting absent settings', async t => {
  const f = fixture(t);
  f.respond(url =>
    Number(url.searchParams.get('start')) === 0
      ? page(
          Array.from({length: 100}, (_, i) => rule(String(i + 1))),
          0,
          101,
          true,
        )
      : page(
          [
            rule('101', {
              enabled: undefined,
              attributionType: undefined,
              postClickAttributionWindowSize: undefined,
              viewThroughAttributionWindowSize: undefined,
              value: undefined,
            }),
          ],
          100,
          101,
        ),
  );
  const out = ok(await f.call());
  assert.equal(out.rule_count, 101);
  assert.equal(out.source_pages.length, 2);
  assert.equal(out.rules.at(-1).enabled, null);
  assert.equal(out.rules.at(-1).post_click_days, null);
  assert.equal(out.rules.at(-1).post_view_days, null);
  assert.equal(out.rules.at(-1).attribution_type, null);
  assert.equal(out.rules.at(-1).value, null);
  assert.equal(f.requests.length, 4);
  assert.equal(f.requests[2].url.searchParams.get('account'), 'urn:li:sponsoredAccount:100');
  assert.equal(f.requests[2].url.searchParams.get('start'), '100');
});

test('LinkedIn configuration can be explicitly empty, while a full page without total requires an empty terminal probe', async t => {
  const f = fixture(t);
  f.respond(() => page([]));
  assert.equal(ok(await f.call()).rule_count, 0);
  f.requests.length = 0;
  f.respond(url =>
    Number(url.searchParams.get('start')) === 0
      ? page(
          Array.from({length: 100}, (_, i) => rule(String(i + 1))),
          0,
          null,
        )
      : page([], 100, null),
  );
  assert.equal(ok(await f.call()).rule_count, 100);
  assert.equal(f.requests.length, 4);
});

test('LinkedIn conversion evidence rejects foreign or duplicate rules, imprecise IDs, malformed settings and inconsistent completion', async t => {
  const f = fixture(t);
  const responses = [
    page([rule('1', {account: 'urn:li:sponsoredAccount:999'})]),
    page([rule('1'), rule('1')]),
    page([rule(9007199254740992)]),
    page([rule('1', {postClickAttributionWindowSize: '30'})]),
    page([rule('1', {value: {amount: 0.1, currencyCode: 'USD'}})]),
    page([rule('1')], 1),
    page([rule('1')], 0, 2),
    {...page([rule('1')]), paging: undefined},
    {...page([rule('1')]), errors: []},
    {
      ...page([rule('1')]),
      paging: {start: 0, count: 100, total: 1, links: [{rel: 'next', href: 'https://example.invalid/'}]},
    },
  ];
  for (const response of responses) {
    f.respond(() => response);
    const out = await f.call();
    assert.equal(out.success, false, JSON.stringify(response));
    assert.equal(out.data, undefined);
  }
});

test('LinkedIn conversion evidence refuses changed access and never returns a partial table after revocation', async t => {
  for (const kind of ['credentials', 'scope', 'binding', 'actor']) {
    const f = fixture(t);
    f.onRead(url => {
      if (url.pathname !== '/rest/conversions') return;
      if (kind === 'actor') f.store.revokeKey(f.key);
      else
        f.store.putConnection(
          {...f.actor, role: 'admin'},
          {...f.connection, ...(kind === 'scope' ? {scopes: []} : {}), ...(kind === 'binding' ? {accounts: []} : {})},
          {accessToken: kind === 'credentials' ? 'replaced' : 'synthetic'},
        );
    });
    const out = await f.call();
    assert.equal(out.success, false, kind);
    assert.equal(out.data, undefined);
    assert.equal(f.requests.length, 2);
  }
});

test('conversion discovery rejects unsupported providers, wrong accounts and undocumented native collection filters before egress', async t => {
  const f = fixture(t);
  for (const extra of [{gateway: 'meta_native_action'}, {account_id: '999'}, {requirements: {campaign_id: '1'}}])
    assert.equal((await f.call(extra)).success, false);
  const base = {
    action: 'linkedin_rest_conversions_get',
    connection_id: f.connection.id,
    account_id: '100',
    aggregate_pages: false,
    dry_run: false,
  };
  for (const query of [
    {q: 'account', account: 'urn:li:sponsoredAccount:999'},
    {q: 'account', account: 'urn:li:sponsoredAccount:100', fields: 'private'},
    {q: 'other', account: 'urn:li:sponsoredAccount:100'},
  ])
    assert.equal((await f.service.call('linkedin_native_action', {...base, query}, f.actor)).success, false);
  assert.equal(f.requests.length, 0);
  const out = await f.service.call(
    'linkedin_native_action',
    {...base, query: {q: 'account', account: 'urn:li:sponsoredAccount:100', start: 0, count: 100}},
    f.actor,
  );
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(f.requests.length, 1);
});

test('conversion account finder preserves explicitly provisioned reads outside its qualified shape', async t => {
  const f = fixture(t);
  f.store.putConnection(
    {...f.actor, role: 'admin'},
    {
      ...f.connection,
      resourceBindings: [
        {
          accountId: '100',
          pathPrefix: '/rest/conversions',
          query: {q: 'account', account: 'urn:li:sponsoredAccount:100'},
        },
      ],
    },
    {accessToken: 'synthetic'},
  );
  const out = await f.service.call(
    'linkedin_native_action',
    {
      action: 'linkedin_rest_conversions_get',
      account_id: '100',
      connection_id: f.connection.id,
      query: {q: 'account', account: 'urn:li:sponsoredAccount:100', fields: 'id,account'},
      aggregate_pages: false,
      dry_run: false,
    },
    f.actor,
  );
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url.searchParams.get('fields'), 'id,account');
});

test('conversion collection keeps all 1000 exact rules and refuses excess, changing totals and cross-page duplicates', async t => {
  const f = fixture(t);
  const batch = start => Array.from({length: 100}, (_, i) => rule(String(9007199254740993n + BigInt(start + i))));
  f.respond(url => {
    const start = Number(url.searchParams.get('start'));
    return page(batch(start), start, 1000, start < 900);
  });
  const out = ok(await f.call());
  assert.equal(out.rule_count, 1000);
  assert.equal(out.rules.at(-1).id, '9007199254741992');
  assert.equal(out.rules.at(-1).value.amount, '9007199254740993.123456789');
  assert.equal(out.source_pages.length, 10);
  assert.equal(f.requests.length, 12);
  for (const kind of ['declared excess', 'undeclared excess', 'changed total', 'changed count presence', 'duplicate']) {
    f.requests.length = 0;
    f.respond(url => {
      const start = Number(url.searchParams.get('start'));
      if (kind === 'declared excess') return page(batch(start), start, 1001);
      if (kind === 'undeclared excess') return page(start < 1000 ? batch(start) : [rule('1')], start, null);
      if (!start) return page(batch(0), 0, 101, true);
      if (kind === 'duplicate') return page([batch(0)[0]], start, 101);
      return page([rule('1')], start, kind === 'changed total' ? 102 : null);
    });
    const result = await f.call();
    assert.equal(result.success, false, kind);
    assert.equal(result.data, undefined, kind);
    assert.equal(f.requests.filter(r => r.url.pathname === '/rest/adAccounts/100').length, 1, kind);
  }
});

test('conversion evidence refuses changed closing account and bounded continuation conflicts', async t => {
  const f = fixture(t);
  let reads = 0;
  f.account(() => ({id: 100, currency: ++reads === 1 ? 'USD' : 'EUR'}));
  assert.equal((await f.call()).success, false);
  assert.equal(f.requests.length, 3);
  f.account(() => ({id: '100', currency: 'USD'}));
  for (const href of [
    'https://api.linkedin.com/rest/conversions?start=100&count=50',
    'https://api.linkedin.com/rest/conversions?start=100&account=urn:li:sponsoredAccount:999',
    'https://api.linkedin.com/rest/conversions?start=100&start=100',
  ]) {
    f.requests.length = 0;
    f.respond(url =>
      Number(url.searchParams.get('start')) === 0
        ? {
            elements: Array.from({length: 100}, (_, i) => rule(String(i + 1))),
            paging: {start: 0, count: 100, total: 101, links: [{rel: 'next', href}]},
          }
        : page([rule('101')], 100, 101),
    );
    const result = await f.call();
    assert.equal(result.success, false, href);
    assert.equal(result.data, undefined);
    assert.equal(f.requests.length, 2);
  }
});
