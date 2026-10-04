import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

export const snapUsageIds = {
  account: '14700000-0000-4000-8000-000000000001',
  media: '14700000-0000-4000-8000-000000000002',
  other: '14700000-0000-4000-8000-000000000003',
  creative: '14700000-0000-4000-8000-000000000004',
};
export function snapchatAssetUsageFixture(t, options = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 147).toString('base64')),
    key = store.createKey({tenantId: 'synthetic-snapchat-top-snap', userId: 'reader', role: 'reader'}),
    actor = store.authenticate(key),
    admin = {...actor, role: 'admin'},
    connection = {
      id: '14700000-0000-4000-8000-000000000005',
      tenantId: actor.tenantId,
      gateway: 'snapchat_native_action',
      accounts: [snapUsageIds.account],
      writeAccounts: [],
      enabled: true,
      scopes: ['snapchat-marketing-api'],
      label: 'Synthetic Snapchat',
    },
    asset = {
      platform: 'snapchat',
      account_id: snapUsageIds.account,
      connection_id: connection.id,
      media_id: snapUsageIds.media,
      media_type: 'image',
      sha256: 'e'.repeat(64),
      name: 'Original <image>',
      source: 'amcp_upload',
      source_url: 'PRIVATE-SOURCE',
      ...options.asset,
    },
    media = {
      id: snapUsageIds.media,
      ad_account_id: snapUsageIds.account,
      type: asset.media_type.toUpperCase(),
      media_status: 'READY',
      download_link: 'PRIVATE-DOWNLOAD',
    },
    creative = (id = snapUsageIds.creative, mediaId = snapUsageIds.media) => ({
      id,
      ad_account_id: snapUsageIds.account,
      name: 'Native <img onerror=bad>',
      type: 'WEB_VIEW',
      top_snap_media_id: mediaId,
      packaging_status: 'SUCCESS',
      review_status: 'APPROVED',
      web_view_properties: {url: 'PRIVATE-LANDING-URL'},
      headline: 'PRIVATE-HEADLINE',
    }),
    rows = options.rows ?? [creative()],
    requests = [],
    passes = new Map();
  t.after(() => store.close());
  store.putConnection(admin, connection, {accessToken: 'synthetic-snapchat'});
  store.putDocument(actor.tenantId, 'workspace_asset', 'asset-147', asset);
  let hook = ({body}) => body;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init) => {
      const url = new URL(String(raw)),
        base = '/v1/adaccounts/' + snapUsageIds.account,
        kind =
          url.pathname === base
            ? 'adaccounts'
            : url.pathname === base + '/media'
              ? 'media'
              : url.pathname === base + '/creatives'
                ? 'creatives'
                : undefined;
      assert.equal(init.method, 'GET');
      assert.equal(url.origin, 'https://adsapi.snapchat.com');
      assert.equal(init.redirect, 'error');
      assert.ok(kind, 'Only synthetic original-account reads are permitted');
      assert.equal(url.searchParams.get('limit'), kind === 'adaccounts' ? null : '50');
      assert.ok([...url.searchParams.keys()].every(k => ['limit', 'cursor'].includes(k)));
      assert.equal(init.headers.Authorization, 'Bearer synthetic-snapchat');
      const cursor = url.searchParams.get('cursor'),
        firstPage = cursor === null;
      if (firstPage) passes.set(kind, (passes.get(kind) ?? 0) + 1);
      const pass = passes.get(kind);
      requests.push({kind, pass, path: url.pathname, query: Object.fromEntries(url.searchParams)});
      const entity = kind === 'adaccounts' ? 'adaccount' : kind === 'media' ? 'media' : 'creative',
        selected = kind === 'adaccounts' ? [{id: snapUsageIds.account}] : kind === 'media' ? [media] : rows,
        body = {
          request_status: 'SUCCESS',
          paging: {},
          [kind]: structuredClone(selected).map(value => ({sub_request_status: 'SUCCESS', [entity]: value})),
        },
        out = await hook({kind, pass, cursor, body, url, store, actor, admin, connection, asset, init});
      return out instanceof Response ? out : Response.json(out ?? body);
    }),
    undefined,
    {allowWrites: false},
  );
  const input = {action: 'asset_usage', asset_id: 'asset-147', limit: 50};
  return {
    store,
    key,
    actor,
    admin,
    connection,
    asset,
    media,
    creative,
    rows,
    requests,
    service,
    input,
    call: (extra = {}, user = actor) => service.call('amcp_media', {...input, ...extra}, user),
    setHook: value => {
      hook = value;
    },
  };
}
