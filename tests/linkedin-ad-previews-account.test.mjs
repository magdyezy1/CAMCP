// V2-PRV-02: the documented account parameter and safe, expiring iframe links (synthetic reads only).
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {authorizeLinkedInAdPreview, linkedInPreviewLinks} from '../dist/src/linkedin-ad-previews.js';

const actor = {tenantId: 'synthetic-linkedin-preview', userId: 'owner', role: 'admin'},
  login = 'aaaaaaaa-1111-4111-8111-000000000001';
const docElements = [
  {
    creative: 'urn:li:sponsoredCreative:5',
    preview:
      '<iframe src="https://www.linkedin.com/ads/ad-preview/?d=synthetic&amp;v=1" height=580 width=650></iframe>',
    placement: {linkedin: {placementName: 'FEED', contentPresentationType: 'DESKTOP_WEBSITE'}},
  },
  {
    creative: 'urn:li:sponsoredCreative:5',
    preview: "<iframe src='https://www.linkedin.com/mwlite/ads/ad-preview?d=synthetic' height=375 width=700></iframe>",
    placement: {linkedin: {placementName: 'FEED', contentPresentationType: 'MOBILE_WEBSITE'}},
  },
];
function fixture(t, {error = false} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 67).toString('base64')),
    reads = [];
  t.after(() => store.close());
  const connection = {
    id: login,
    tenantId: actor.tenantId,
    gateway: 'linkedin_native_action',
    accounts: ['100'],
    enabled: true,
    label: 'Synthetic',
    scopes: ['r_ads'],
  };
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  const transport = new NativeTransport(async raw => {
    const url = new URL(String(raw));
    reads.push(url);
    if (url.pathname === '/rest/adAccounts/100/creatives')
      return Response.json({
        elements: [{id: 'urn:li:sponsoredCreative:5', name: 'Synthetic', account: 'urn:li:sponsoredAccount:100'}],
      });
    if (url.pathname === '/rest/adPreviews')
      return error
        ? Response.json(
            {message: 'Synthetic provider preview refusal', status: 400},
            {status: 400, headers: {'x-li-request-id': 'synthetic-preview-request'}},
          )
        : Response.json({elements: docElements});
    throw Error('Unexpected synthetic preview request ' + url.pathname);
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: false,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  return {
    store,
    service,
    connection,
    reads,
    run: () =>
      service.call(
        'amcp_ad_previews',
        {platform: 'linkedin', account_id: '100', connection_id: login, ad_ids: ['5']},
        actor,
      ),
  };
}
const plan = query => ({
  gateway: 'linkedin_native_action',
  action: 'linkedin_rest_ad_previews_get',
  method: 'GET',
  path: '/rest/adPreviews',
  query,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  accountId: '100',
  evidence: 'TEST',
  warnings: [],
});

test('the preview request sends the selected sponsored account URN and preserves placement links', async t => {
  const f = fixture(t),
    now = Date.UTC(2026, 10, 3);
  t.mock.timers.enable({apis: ['Date'], now});
  t.after(() => t.mock.timers.reset());
  const out = await f.run();
  assert.equal(out.success, true, JSON.stringify(out.error));
  const request = f.reads.find(url => url.pathname === '/rest/adPreviews');
  assert.deepEqual(Object.fromEntries(request.searchParams), {
    q: 'creative',
    creative: 'urn:li:sponsoredCreative:5',
    account: 'urn:li:sponsoredAccount:100',
  });
  const item = out.data.previews[0];
  assert.equal(item.links.length, 2);
  assert.equal(item.link, item.links[0]);
  assert.deepEqual(
    item.placements.map(link => link.device),
    ['DESKTOP_WEBSITE', 'MOBILE_WEBSITE'],
  );
  assert.equal(item.expires_at, new Date(now + 3 * 3600000).toISOString());
  assert.equal(item.expires, 'LinkedIn keeps this preview for up to 3 hours.');
});

test('the authorizer requires exactly q, creative and the selected account, plus current creative ownership', t => {
  const f = fixture(t),
    query = {q: 'creative', creative: 'urn:li:sponsoredCreative:5', account: 'urn:li:sponsoredAccount:100'};
  assert.equal(authorizeLinkedInAdPreview(plan(query), f.connection, f.store, '100'), false);
  f.store.rememberResource(f.connection, '100', 'creatives/5');
  assert.equal(authorizeLinkedInAdPreview(plan(query), f.connection, f.store, '100'), true);
  for (const invalid of [
    {q: 'creative', creative: query.creative},
    {...query, account: 'urn:li:sponsoredAccount:200'},
    {...query, extra: 'unexpected'},
    {...query, creative: 'urn:li:sponsoredCreative:6'},
  ])
    assert.equal(authorizeLinkedInAdPreview(plan(invalid), f.connection, f.store, '100'), false);
});

test('only a safe iframe src is returned; unrelated links and hostile preview tags yield no link', () => {
  const now = Date.UTC(2026, 10, 3),
    links = linkedInPreviewLinks(docElements, now);
  assert.equal(links.length, 2);
  assert.equal(links[0].url, 'https://www.linkedin.com/ads/ad-preview/?d=synthetic&v=1');
  for (const preview of [
    '<iframe src="javascript:alert(1)"></iframe>',
    '<iframe src="data:text/html,hello"></iframe>',
    '<iframe src="https://linkedin.com.evil.example/preview"></iframe>',
    '<iframe src="http://www.linkedin.com/preview"></iframe>',
    '<iframe src="https://user:password@www.linkedin.com/preview"></iframe>',
    '<a href="https://www.linkedin.com/preview">Link</a>',
    '<iframe data-src="https://www.linkedin.com/preview"></iframe>',
    '<iframe srcdoc="hello" src="https://www.linkedin.com/preview"></iframe>',
  ])
    assert.deepEqual(linkedInPreviewLinks([{preview}], now), [], preview);
});

test('missing, extra, foreign-account and unowned-creative queries are refused before egress', async t => {
  const f = fixture(t),
    query = {q: 'creative', creative: 'urn:li:sponsoredCreative:5', account: 'urn:li:sponsoredAccount:100'};
  f.store.rememberResource(f.connection, '100', 'creatives/5');
  for (const [invalid, code] of [
    [{q: 'creative', creative: query.creative}, 'RESOURCE_SCOPE_REQUIRED'],
    [{...query, extra: 'unexpected'}, 'RESOURCE_SCOPE_REQUIRED'],
    [{...query, account: 'urn:li:sponsoredAccount:200'}, 'ACCOUNT_SCOPE_MISMATCH'],
    [{...query, creative: 'urn:li:sponsoredCreative:6'}, 'RESOURCE_SCOPE_REQUIRED'],
  ]) {
    const out = await f.service.call(
      'linkedin_native_action',
      {action: 'linkedin_rest_ad_previews_get', account_id: '100', connection_id: login, query: invalid},
      actor,
    );
    assert.equal(out.success, false, JSON.stringify(out));
    assert.equal(out.error.code, code, JSON.stringify(out.error));
    assert.equal(f.reads.length, 0);
  }
});

test('a preview failure preserves the provider message and request ID', async t => {
  const f = fixture(t, {error: true}),
    out = await f.run();
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.deepEqual(out.data.previews[0].links, []);
  assert.equal(out.data.previews[0].error.provider.message, 'Synthetic provider preview refusal');
  assert.equal(out.data.previews[0].error.provider.request_id, 'synthetic-preview-request');
});
