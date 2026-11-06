// V2-PRV-03: preserve only the preview read's signed capability; synthetic provider responses only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {providerHooks} from '../dist/src/provider-hooks.js';
import {assertNamesNoProvider} from './helpers/shared-module-seams.mjs';

const actor = {tenantId: 'synthetic-snap-preview', userId: 'owner', role: 'admin'},
  login = 'aaaaaaaa-1111-4111-8111-000000000001';
/** The signed link a Snapchat answer carries, with the given text as its `expires_at` parameter. */
const signedLink = (expiry, extra = '') =>
  'https://adsapi.snapchat.com/media/creative_preview?creative_id=cr1&expires_at=' +
  expiry +
  '&signature=synthetic-signature' +
  extra;
function fixture(t, {preview = {}} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 68).toString('base64')),
    reads = [],
    expires_at = new Date(Date.now() + 90 * 86400000).toISOString(),
    signed =
      'https://adsapi.snapchat.com/media/creative_preview?creative_id=cr1&expires_at=' +
      Date.parse(expires_at) +
      '&signature=synthetic-signature&sig=synthetic-sig&access_token=synthetic-credential';
  t.after(() => store.close());
  const connection = {
    id: login,
    tenantId: actor.tenantId,
    gateway: 'snapchat_native_action',
    accounts: ['100'],
    enabled: true,
    label: 'Synthetic',
    scopes: ['ads_read'],
  };
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  store.rememberResource(connection, '100', 'creatives/cr1');
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async raw => {
      const url = new URL(String(raw));
      reads.push(url.pathname);
      const base = {request_status: 'SUCCESS'};
      if (url.pathname === '/v1/creatives/cr1/creative_preview')
        return Response.json({
          ...base,
          creative_id: 'cr1',
          creative_preview_link: signed,
          expires_at,
          other_url: signed,
          ...preview,
        });
      if (url.pathname === '/v1/creatives/cr1' || url.pathname === '/v1/adaccounts/100/creatives')
        return Response.json({
          ...base,
          creatives: [{creative: {id: 'cr1', ad_account_id: '100', creative_preview_link: signed}}],
        });
      throw Error('Unexpected synthetic Snapchat request ' + url.pathname);
    }),
    undefined,
    {allowWrites: false, requireBeforeState: true, maxBudgetChange: 0},
  );
  return {
    store,
    reads,
    service,
    expires_at,
    native: action =>
      service.call(
        'snapchat_native_action',
        {
          action,
          account_id: '100',
          connection_id: login,
          ...(action === 'snapchat_creative_list' ? {} : {creative_id: 'cr1'}),
        },
        actor,
      ),
  };
}
test('the signed preview field preserves sig and signature on the exact preview read, with credentials still redacted', async t => {
  const f = fixture(t),
    out = await f.native('snapchat_creatives_creative_id_creative_preview_get');
  assert.equal(out.success, true, JSON.stringify(out.error));
  const data = out.data.data;
  assert.match(data.creative_preview_link, /signature=synthetic-signature/);
  assert.match(data.creative_preview_link, /sig=synthetic-sig/);
  assert.doesNotMatch(JSON.stringify(out), /synthetic-credential/);
  assert.doesNotMatch(data.other_url, /synthetic-signature|synthetic-sig/);
  assert.equal(data.expires_at, f.expires_at);
});
test('the same field stays redacted on every other native read', async t => {
  const f = fixture(t);
  for (const action of ['snapchat_creative_get', 'snapchat_creative_list']) {
    const out = await f.native(action);
    assert.equal(out.success, true, JSON.stringify(out.error));
    assert.doesNotMatch(JSON.stringify(out.data), /synthetic-signature|synthetic-sig|synthetic-credential/);
  }
});
test('previews expose the browser preview URL, provider expiry and 90-day note', async t => {
  const f = fixture(t),
    out = await f.service.call(
      'amcp_ad_previews',
      {platform: 'snapchat', account_id: '100', connection_id: login, ad_ids: ['cr1']},
      actor,
    );
  assert.equal(out.success, true, JSON.stringify(out.error));
  const item = out.data.previews[0],
    url = new URL(item.links[0]);
  assert.equal(url.origin, 'https://ad-preview.snapchat.com');
  assert.equal(url.searchParams.get('creative_id'), 'cr1');
  assert.equal(url.searchParams.get('signature'), 'synthetic-signature');
  assert.equal(url.searchParams.has('access_token'), false);
  assert.equal(item.expires_at, f.expires_at);
  assert.equal(item.expires, 'Snapchat keeps this preview link for 90 days.');
});
test('the adapter declares only the exact plain preview GET, and the shared service names no provider', () => {
  const hook = providerHooks('snapchat_native_action'),
    plan = {
      gateway: 'snapchat_native_action',
      method: 'GET',
      path: '/v1/creatives/cr1/creative_preview',
      readOnly: true,
      query: {},
      headers: {},
    };
  assert.deepEqual(hook.signedLinkFields(plan), ['creative_preview_link']);
  for (const extra of [
    {method: 'POST'},
    {readOnly: false},
    {body: {}},
    {specialTransport: 'unexpected'},
    {gateway: 'other_native_action'},
    {path: '/v1/creatives/cr1'},
    {path: '/v1/adaccounts/100/creatives'},
    {origin: 'https://foreign.example'},
  ])
    assert.deepEqual(hook.signedLinkFields({...plan, ...extra}), []);
  assertNamesNoProvider('src/service.ts');
});

test('expired, foreign or inconsistent preview capabilities yield no browser link', async t => {
  for (const preview of [
    // F-L3-04: the link's own expiry decides. Expired in the link (epoch seconds and milliseconds), whatever the JSON says.
    {creative_preview_link: signedLink(946684800)},
    {creative_preview_link: signedLink(946684800000), expires_at: '2999-01-01T00:00:00Z'},
    {creative_id: 'foreign-creative'},
    {creative_preview_link: 'https://foreign.example/preview?creative_id=cr1&signature=synthetic'},
    {
      creative_preview_link:
        'https://adsapi.snapchat.com/media/creative_preview?creative_id=cr1&expires_at=123&signature=one&signature=two',
    },
  ]) {
    const f = fixture(t, {preview}),
      out = await f.service.call(
        'amcp_ad_previews',
        {platform: 'snapchat', account_id: '100', connection_id: login, ad_ids: ['cr1']},
        actor,
      );
    assert.equal(out.success, true, JSON.stringify(out.error));
    assert.deepEqual(out.data.previews[0].links, []);
    assert.equal(out.data.previews[0].note, 'Snapchat returned an expired or invalid preview link.');
  }
});

// F-L3-04: Snapchat's documentation names the parameters of the link and its 90 days, not the format of the timestamp
// (provider-docs.md), so the rule that two of them had to agree in one unverified way dropped every link if the real
// answer differed. The link's own value decides, as epoch seconds or milliseconds; the real shape is captured at the
// live check (docs/AD-PREVIEWS.md).
const ask = async (t, preview) => {
  const f = fixture(t, {preview}),
    out = await f.service.call(
      'amcp_ad_previews',
      {platform: 'snapchat', account_id: '100', connection_id: login, ad_ids: ['cr1']},
      actor,
    );
  assert.equal(out.success, true, JSON.stringify(out.error));
  return {item: out.data.previews[0], f};
};
test('F-L3-04: a link whose expiry is in epoch seconds is returned, with the value as Snapchat wrote it', async t => {
  const seconds = Math.floor(Date.UTC(2999, 0, 1) / 1000),
    {item} = await ask(t, {creative_preview_link: signedLink(seconds)});
  assert.equal(item.links.length, 1);
  const url = new URL(item.links[0]);
  assert.equal(url.origin, 'https://ad-preview.snapchat.com');
  assert.equal(url.searchParams.get('expires_at'), String(seconds));
  assert.equal(url.searchParams.get('signature'), 'synthetic-signature');
  assert.equal(item.expires_at, '2999-01-01T00:00:00.000Z');
  assert.equal(item.note, undefined);
});
test('F-L3-04: a link whose expiry is in epoch milliseconds is returned', async t => {
  const millis = Date.UTC(2999, 0, 1),
    {item} = await ask(t, {creative_preview_link: signedLink(millis)});
  assert.equal(item.links.length, 1);
  assert.equal(new URL(item.links[0]).searchParams.get('expires_at'), String(millis));
  assert.equal(item.expires_at, '2999-01-01T00:00:00.000Z');
});
test('F-L3-04: a link that differs from the JSON timestamp is still a valid link, and its own expiry is the one shown', async t => {
  const later = Date.UTC(2999, 0, 2);
  for (const json of [
    {expires_at: '2999-01-01T00:00:00Z'},
    {expires_at: '2000-01-01T00:00:00Z'},
    {expires_at: 32503680000},
    {expires_at: undefined},
  ]) {
    const {item} = await ask(t, {creative_preview_link: signedLink(later), ...json});
    assert.equal(item.links.length, 1, JSON.stringify(json));
    assert.equal(item.expires_at, '2999-01-02T00:00:00.000Z', JSON.stringify(json));
  }
});
test('F-L3-04: a link whose expiry is not epoch seconds or milliseconds yields no link', async t => {
  for (const expiry of [
    'abc',
    '',
    '2999-01-01T00:00:00Z',
    '1e12',
    '-5',
    '3.5',
    '0x10',
    // Microseconds and nanoseconds are neither seconds nor milliseconds, even for a time ahead.
    '32503680000000000',
    '1776000000000000',
    '1776000000000000000',
  ]) {
    const {item} = await ask(t, {creative_preview_link: signedLink(expiry)});
    assert.deepEqual(item.links, [], 'expires_at=' + expiry);
    assert.equal(item.note, 'Snapchat returned an expired or invalid preview link.', 'expires_at=' + expiry);
  }
  // The expiry is one parameter, once.
  const {item} = await ask(t, {creative_preview_link: signedLink(Date.UTC(2999, 0, 1), '&expires_at=1')});
  assert.deepEqual(item.links, []);
});
