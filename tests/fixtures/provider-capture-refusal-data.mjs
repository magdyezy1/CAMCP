import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
const accountUUID = '11111111-1111-4111-8111-111111111111';
export const providerRefusalMessages = {
  meta: 'Meta did not return the exact selected advertising account.',
  linkedin: 'LinkedIn did not return the exact selected advertising account.',
  tiktok: 'TikTok did not return the exact selected advertiser.',
  snapchat: 'Snapchat did not return the exact selected account.',
};
/** Exact fixed account-mismatch responses only; no alternate route or provider egress. */
export function providerCaptureRefusalFixture(provider) {
  assert.ok(Object.hasOwn(providerRefusalMessages, provider));
  const owner = {tenantId: 'capture-refusal-' + provider, userId: 'fixture-owner', role: 'admin'};
  const keyByte = 166,
    store = new Store(':memory:', Buffer.alloc(32, keyByte).toString('base64'));
  const account = provider === 'snapchat' ? accountUUID : '100',
    connectionId = 'aaaaaaaa-1111-4111-8111-111111111111',
    requests = [];
  const scopes = {
    meta: ['ads_read'],
    linkedin: ['r_ads', 'r_ads_reporting'],
    tiktok: [],
    snapchat: ['snapchat-marketing-api'],
  }[provider];
  store.putConnection(
    owner,
    {
      id: connectionId,
      tenantId: owner.tenantId,
      gateway: provider + '_native_action',
      accounts: [account],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic ' + provider + ' reader',
      scopes,
    },
    {accessToken: 'synthetic-refusal-secret'},
  );
  const key = store.createKey({...owner, userId: 'fixture-reader', role: 'viewer'}),
    actor = store.authenticate(key);
  const day = offset => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
  const input = {
    action: 'capture_preset',
    preset: provider + '_campaign',
    account_id: account,
    connection_id: connectionId,
    semantics: {
      currency: 'USD',
      timezone: provider === 'snapchat' ? 'Asia/Riyadh' : 'UTC',
      date_from: day(2),
      date_to: day(1),
      source_name: 'Synthetic ' + provider + ' source',
      attribution: 'unknown',
      complete: true,
    },
    ...(provider === 'meta'
      ? {result_action_type: 'offsite_conversion.fb_pixel_purchase', attribution_windows: ['7d_click', '1d_view']}
      : {}),
  };
  if (provider === 'tiktok') input.semantics.timezone = 'Etc/GMT';
  if (provider === 'snapchat') {
    input.swipe_up_attribution_window = '7_DAY';
    input.view_attribution_window = '1_DAY';
  }
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init) => {
      assert.equal(init.method, 'GET', 'Only native reads are allowed');
      const url = new URL(raw);
      requests.push({url: String(raw), method: init.method});
      let body;
      if (provider === 'meta') {
        assert.equal(url.pathname, '/v26.0/act_100');
        body = {id: 'act_999', account_id: '999', currency: 'USD', timezone_name: 'UTC'};
      }
      if (provider === 'linkedin') {
        assert.equal(url.pathname, '/rest/adAccounts/100');
        body = {id: 999, currency: 'USD'};
      }
      if (provider === 'tiktok') {
        assert.equal(url.pathname, '/open_api/v1.3/advertiser/info/');
        body = {code: 0, message: 'OK', data: {list: [{advertiser_id: '999', currency: 'USD', timezone: 'Etc/GMT'}]}};
      }
      if (provider === 'snapchat') {
        assert.equal(url.pathname, '/v1/adaccounts/' + account);
        body = {
          request_status: 'SUCCESS',
          adaccounts: [
            {
              sub_request_status: 'SUCCESS',
              adaccount: {id: '99999999-1111-4111-8111-111111111111', currency: 'USD', timezone: 'Asia/Riyadh'},
            },
          ],
        };
      }
      return Response.json(body);
    }),
  );
  return {owner, actor, store, service, key, keyByte, input, requests, close: () => store.close()};
}
