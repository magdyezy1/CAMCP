import test from 'node:test';
import assert from 'node:assert/strict';
import {linkedinQuery} from '../dist/src/linkedin-restli.js';
import {buildUrl, NativeTransport} from '../dist/src/transport.js';

const fields = 'impressions,clicks,costInLocalCurrency,dateRange,pivotValues';
const connection = {
  id: 'projection-test',
  tenantId: 'projection-tenant',
  gateway: 'linkedin_native_action',
  accounts: ['123'],
  label: 'synthetic',
  enabled: true,
  scopes: [],
};
const plan = {
  gateway: 'linkedin_native_action',
  action: 'linkedin_rest_ad_analytics_get',
  method: 'GET',
  path: '/rest/adAnalytics',
  query: {
    q: 'analytics',
    pivot: 'ACCOUNT',
    timeGranularity: 'DAILY',
    accounts: ['urn:li:sponsoredAccount:123'],
    dateRange: {start: {year: 2026, month: 10, day: 3}, end: {year: 2026, month: 10, day: 3}},
    fields,
  },
  headers: {'LinkedIn-Version': '202608', 'X-Restli-Protocol-Version': '2.0.0'},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  accountId: '123',
  evidence: 'SYNTHETIC',
  warnings: [],
};
const credentials = {accessToken: 'TEST_CREDENTIAL_NOT_REAL'};

test('analytics projection uses native comma-separated selectors at the production URL boundary', () => {
  const url = buildUrl(plan, connection);
  assert.equal(url.origin + url.pathname, 'https://api.linkedin.com/rest/adAnalytics');
  assert.ok(url.href.includes('&fields=' + fields));
  assert.ok(!url.href.includes('impressions%2Cclicks'));
  assert.equal(url.searchParams.get('fields'), fields);
  assert.equal(url.searchParams.get('accounts'), 'List(urn:li:sponsoredAccount:123)');
  assert.ok(url.href.includes('accounts=List(urn%3Ali%3AsponsoredAccount%3A123)'));
  assert.ok(url.href.includes('dateRange=(start:(year:2026,month:10,day:3),end:(year:2026,month:10,day:3))'));
  assert.equal(plan.readOnly, true);
  assert.equal(plan.method, 'GET');
});

test('provider-documented field, child-object and map selectors preserve only projection punctuation', async t => {
  for (const projection of ['id,bar,baz', 'id,baz:(beep)', 'id,baz:($*:(beep))', 'id,baz:($*:(beep,foo))', '*']) {
    await t.test(projection, () => {
      assert.equal(linkedinQuery({fields: projection}), 'fields=' + projection);
      assert.equal(buildUrl({...plan, query: {fields: projection}}, connection).searchParams.get('fields'), projection);
    });
  }
});

test('projection leaves cannot add account filters, fragments, credentials or a new query key', async t => {
  for (const selector of [
    'id&accounts=List(urn:li:sponsoredAccount:999)',
    'id&fields=privateField',
    'id#fragment?accounts=other',
    'id;accounts=other',
    'id\r\nAuthorization:Bearer synthetic',
    'id%26accounts%3DList%28other%29',
  ]) {
    await t.test(JSON.stringify(selector), () => {
      const url = buildUrl({...plan, query: {...plan.query, fields: selector}}, connection);
      assert.equal(url.searchParams.get('fields'), selector);
      assert.equal(url.searchParams.get('accounts'), 'List(urn:li:sponsoredAccount:123)');
      assert.equal(url.searchParams.getAll('accounts').length, 1);
      assert.equal(url.searchParams.getAll('fields').length, 1);
      assert.equal(url.hash, '');
      assert.deepEqual([...url.searchParams.keys()], Object.keys(plan.query));
      assert.equal(url.origin, 'https://api.linkedin.com');
    });
  }
});

test('Unicode and already encoded scalar text retain exactly one URL encoding layer', () => {
  assert.equal(linkedinQuery({fields: 'name,نص'}), 'fields=name,%D9%86%D8%B5');
  assert.equal(linkedinQuery({fields: 'id,opaque%2Cname'}), 'fields=id,opaque%252Cname');
  assert.equal(linkedinQuery({fields: 'id,$name'}), 'fields=id,%24name');
  assert.equal(linkedinQuery({fields: 'id,owner~:(localizedFirstName)'}), 'fields=id,owner~:(localizedFirstName)');
});

test('ordinary REST.li scalar values and query keys retain their previous escaping', () => {
  assert.equal(
    linkedinQuery({fields, name: 'A,B:(C)*', search: {names: ['A,B (en)', 'a&account=999']}}),
    'fields=' + fields + '&name=A%2CB%3A%28C%29%2A&search=(names:List(A%2CB%20%28en%29,a%26account%3D999))',
  );
  assert.equal(linkedinQuery({Fields: 'id,name'}), 'Fields=id%2Cname');
  assert.equal(linkedinQuery({'fields&accounts': 'id,name'}), 'fields%26accounts=id%2Cname');
  assert.equal(linkedinQuery({fields: ['id', 'name']}), 'fields=List(id,name)');
  assert.equal(linkedinQuery({fields: 'List(id,name)'}), 'fields=List(id,name)');
  for (const bad of ['List(a,)', '(a:1,a:2)', '(a:List(x)', 'List(%zz)'])
    assert.throws(() => linkedinQuery({fields: bad}), {code: 'INVALID_RESTLI_QUERY'});
});

test('field selection retains the existing whole-query byte and node limits', () => {
  assert.equal(linkedinQuery({fields: 'a'.repeat(65529)}).length, 65536);
  assert.throws(() => linkedinQuery({fields: 'a'.repeat(65530)}), {code: 'INVALID_RESTLI_QUERY'});
  assert.throws(() => linkedinQuery({fields: 'a'.repeat(65537)}), {code: 'INVALID_RESTLI_QUERY'});
  const query = Object.fromEntries(Array.from({length: 4095}, (_, i) => ['k' + i, 'a']));
  assert.ok(linkedinQuery({...query, fields}).endsWith('fields=' + fields));
  assert.throws(() => linkedinQuery({...query, fields, extra: 'a'}), {code: 'INVALID_RESTLI_QUERY'});
});

test('other provider field selectors continue through their original URL encoding', () => {
  const meta = buildUrl({...plan, gateway: 'meta_native_action', path: '/v26.0/act_123/insights'}, connection);
  const google = buildUrl(
    {...plan, gateway: 'google_ads_native_action', path: '/v25/customers/123/googleAds:search'},
    connection,
  );
  assert.ok(meta.href.includes('fields=impressions%2Cclicks%2C'));
  assert.ok(google.href.includes('fields=impressions%2Cclicks%2C'));
  assert.equal(meta.searchParams.get('fields'), fields);
  assert.equal(google.searchParams.get('fields'), fields);
});

test('actual bounded read retries preserve the corrected selectors and account/date binding', async () => {
  const requests = [];
  const response = {
    elements: [{impressions: 1, clicks: 0, costInLocalCurrency: '0.001', pivotValues: ['urn:li:sponsoredAccount:123']}],
  };
  const transport = new NativeTransport(
    async (url, options) => {
      requests.push({url: String(url), method: options.method, body: options.body});
      return new Response(JSON.stringify(requests.length === 1 ? {message: 'temporary'} : response), {
        status: requests.length === 1 ? 503 : 200,
        headers: {'Content-Type': 'application/json'},
      });
    },
    async () => {},
  );
  const result = await transport.request(plan, connection, credentials);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].body, undefined);
  assert.ok(requests[0].url.endsWith('&fields=' + fields));
  assert.deepEqual(result.data, response);
  assert.equal(transport.metrics.retries, 1);
});

test('provider rejection of an unknown selected field stays explicit and is never retried', async () => {
  let calls = 0;
  const transport = new NativeTransport(
    async () => {
      calls++;
      return new Response(
        JSON.stringify({message: 'Projected field unknownField not present in schema', status: 400}),
        {status: 400},
      );
    },
    async () => {},
  );
  await assert.rejects(
    transport.request({...plan, query: {...plan.query, fields: 'unknownField'}}, connection, credentials),
    error => error.status === 400 && error.details?.http_status === 400,
  );
  assert.equal(calls, 1);
  assert.equal(transport.metrics.retries, 0);
});
