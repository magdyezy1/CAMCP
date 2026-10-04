import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

export const usageImageHash = 'a'.repeat(32),
  usageVideoId = '9007199254740993';
export function metaAssetUsageFixture(t, options = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 131).toString('base64')),
    key = store.createKey({tenantId: 'native-asset-usage', userId: 'reader', role: 'reader'}),
    actor = store.authenticate(key),
    admin = {...actor, role: 'admin'},
    connection = {
      id: '13100000-0000-4000-8000-000000000001',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_read'],
    };
  t.after(() => store.close());
  store.putConnection(admin, connection, {accessToken: 'synthetic'});
  const asset = {
    platform: 'meta',
    account_id: '100',
    connection_id: connection.id,
    media_id: options.video ? usageVideoId : usageImageHash,
    media_type: options.video ? 'video' : 'image',
    name: 'Original <media>',
    sha256: 'b'.repeat(64),
    source: 'amcp_upload',
    source_url: 'PRIVATE-SOURCE',
    ready: true,
  };
  store.putDocument(actor.tenantId, 'workspace_asset', 'asset-131', asset);
  const requests = [];
  let hook = body => body;
  const ad = (id, hash = usageImageHash) => ({
    id,
    account_id: '100',
    name: 'Native <ad> ' + id,
    campaign_id: '301',
    adset_id: '401',
    status: 'PAUSED',
    effective_status: 'CAMPAIGN_PAUSED',
    updated_time: '2026-10-01T00:00:00+0000',
    creative: {
      id: '601' + id,
      account_id: '100',
      image_hash: hash,
      ...(options.video ? {video_id: usageVideoId} : {}),
      body: 'PRIVATE-CREATIVE',
    },
  });
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (raw, init) => {
        const url = new URL(String(raw));
        assert.equal(init.method, 'GET');
        assert.equal(url.origin, 'https://graph.facebook.com');
        requests.push({url, method: init.method});
        let body;
        if (url.pathname === '/v26.0/act_100')
          body = {id: 'act_100', account_id: '100', privatePerson: 'PRIVATE-ACCOUNT'};
        else if (url.pathname === '/v26.0/act_100/ads')
          body = url.searchParams.has('after')
            ? {data: [ad('9007199254740995')], paging: {cursors: {after: 'terminal'}}}
            : {
                data: [
                  ad('501'),
                  ad('502', 'c'.repeat(32)),
                  {
                    id: '503',
                    account_id: '100',
                    name: 'Post-only',
                    campaign_id: '301',
                    adset_id: '401',
                    creative: {id: '603', account_id: '100'},
                  },
                ],
                paging: {
                  cursors: {after: 'next-opaque'},
                  next: 'https://graph.facebook.com/v26.0/act_100/ads?access_token=PRIVATE-URL-TOKEN&after=next-opaque',
                },
              };
        else throw Error('Unexpected native read ' + url.pathname);
        const changed = await hook(body, url, requests.length);
        return changed instanceof Response ? changed : Response.json(changed);
      },
      async () => {},
    ),
    undefined,
    {allowWrites: options.allowWrites ?? true},
  );
  const input = {action: 'asset_usage', asset_id: 'asset-131', limit: 3};
  return {
    store,
    key,
    actor,
    admin,
    connection,
    asset,
    service,
    requests,
    input,
    call: (extra = {}, user = actor) => service.call('amcp_media', {...input, ...extra}, user),
    setHook: value => {
      hook = value;
    },
  };
}
