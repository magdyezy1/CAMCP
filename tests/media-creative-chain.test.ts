import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor, JsonObject} from '../src/types.js';
const registry = new Registry(),
  actor: Actor = {tenantId: 't', userId: 'u', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'};
const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ),
  link = 'https://drive.google.com/file/d/abcdefghijklmno/view';

test('Meta campaign → adset → Drive image → creative → paused ad shares one account grant and immediate ownership', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 39).toString('base64'));
  const connection = {
    id: 'c',
    tenantId: 't',
    gateway: 'meta_native_action',
    enabled: true,
    accounts: ['123'],
    writeAccounts: ['123'],
    scopes: ['ads_management'],
    label: 'Synthetic',
  };
  store.putConnection(admin, connection, {accessToken: 'synthetic'});
  const ids: Record<string, string> = {campaigns: '100', adsets: '200', adcreatives: '300', ads: '400'},
    writes: JsonObject[] = [];
  let downloads = 0;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport((async (input, init) => {
      const u = new URL(String(input));
      assert.equal(u.hostname, 'graph.facebook.com');
      if (init?.method === 'GET') {
        if (u.pathname === '/v26.0/act_123/promote_pages') return Response.json({data: [{id: '500'}]});
        const id = u.pathname.split('/').at(-1);
        return Response.json(
          id === 'act_123' ? {id, account_status: 1, currency: 'USD'} : {id, name: 'Target', status: 'PAUSED'},
        );
      }
      const body = Object.fromEntries(new URLSearchParams(String(init?.body))),
        kind = u.pathname.split('/').at(-1)!;
      writes.push({kind, body});
      if (kind === 'adimages') {
        assert.equal(body.bytes, png.toString('base64'));
        return Response.json({images: {asset: {hash: 'imagehash123'}}});
      }
      if (kind === 'adcreatives') {
        const story = JSON.parse(body.object_story_spec!);
        assert.equal(story.page_id, '500');
        assert.equal(story.link_data.image_hash, 'imagehash123');
        assert.equal(story.link_data.link, 'https://example.com/product');
      }
      if (kind === 'ads') {
        assert.equal(body.adset_id, '200');
        assert.equal(body.status, 'PAUSED');
        assert.equal(JSON.parse(body.creative!).creative_id, '300');
      }
      assert.ok(ids[kind]);
      return Response.json({id: ids[kind]});
    }) as typeof fetch),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
    async () => {
      downloads++;
      return new Response(new Uint8Array(png));
    },
  );
  async function mutate(action: string, payload: JsonObject) {
    const r = await service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway: 'meta_native_action',
        connection_id: 'c',
        arguments: {action, account_id: 'act_123', payload},
      },
      actor,
    );
    assert.equal(r.success, true, JSON.stringify(r));
    const executed = await service.call(
      'amcp_write',
      {action: 'execute', review_id: r.data.review_id, idempotency_key: r.data.idempotency_key, confirmed: true},
      actor,
    );
    assert.equal(executed.success, true, JSON.stringify(executed));
    return executed.data;
  }
  try {
    await mutate('meta_campaign_create', {
      name: 'Draft campaign',
      status: 'PAUSED',
      objective: 'OUTCOME_TRAFFIC',
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false,
    });
    await mutate('meta_adset_create', {name: 'Draft adset', status: 'PAUSED', campaign_id: '100'});
    const uploaded = await mutate('meta_image_upload', {url: link});
    assert.equal(uploaded.image_hash, 'imagehash123');
    assert.equal(uploaded.client_download_required, false);
    const creative = await mutate('meta_creative_create', {
      name: 'Creative',
      object_story_spec: {
        page_id: '500',
        link_data: {image_hash: uploaded.image_hash, link: 'https://example.com/product', message: 'test'},
      },
    });
    assert.equal(creative.data.id, '300');
    assert.equal(store.ownsResource(connection, '123', '300'), true);
    await mutate('meta_ad_create', {
      name: 'test',
      adset_id: '200',
      creative: {creative_id: creative.data.id},
      status: 'PAUSED',
    });
    assert.deepEqual(
      writes.map(x => x.kind),
      ['campaigns', 'adsets', 'adimages', 'adcreatives', 'ads'],
    );
    assert.equal(downloads, 1);
    assert.equal(store.verifyAudit(), true);
    for (const payload of [
      {name: 'Missing identity'},
      {object_story_spec: {link_data: {image_hash: 'imagehash123'}}},
      {object_story_spec: {page_id: '500', link_data: {image_hash: 'imagehash123'}}},
    ]) {
      const denied = await service.call(
        'amcp_write',
        {
          action: 'prepare',
          gateway: 'meta_native_action',
          arguments: {action: 'meta_creative_create', account_id: '123', payload},
        },
        actor,
      );
      assert.equal(denied.error.code, 'CREATIVE_INPUT_REQUIRED');
      assert.ok(denied.error.details.missing_fields.length);
    }
    // This is a connection-level gate, never a separate ad-only permission.
    store.putConnection(admin, {...connection, writeAccounts: []}, {accessToken: 'synthetic'});
    for (const action of [
      'meta_campaign_create',
      'meta_adset_create',
      'meta_ad_create',
      'meta_creative_create',
      'meta_image_upload',
    ]) {
      const payload =
        action === 'meta_image_upload'
          ? {url: link}
          : action === 'meta_creative_create'
            ? {object_story_id: '500_600'}
            : {
                status: 'PAUSED',
                campaign_id: '100',
                adset_id: '200',
                ...(action === 'meta_campaign_create' ? {is_adset_budget_sharing_enabled: false} : {}),
              };
      const denied = await service.call(
        'amcp_write',
        {action: 'prepare', gateway: 'meta_native_action', arguments: {action, account_id: '123', payload}},
        actor,
      );
      assert.equal(denied.error.code, 'WRITE_ACCOUNT_FORBIDDEN', JSON.stringify(denied));
      assert.equal(denied.error.details.connection_id, 'c');
    }
    assert.equal(writes.length, 5);
  } finally {
    store.close();
  }
});

test('Snapchat uploaded media can feed a reviewed creative immediately, without a forced PAUSED field', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 41).toString('base64')),
    connection = {
      id: 'c',
      tenantId: 't',
      gateway: 'snapchat_native_action',
      enabled: true,
      accounts: ['123'],
      writeAccounts: ['123'],
      scopes: [],
      label: 'Synthetic',
    };
  store.putConnection(admin, connection, {accessToken: 'synthetic'});
  let mediaAllocations = 0;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport((async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === 'GET') {
        if (path === '/v1/media/456')
          return Response.json({
            request_status: 'SUCCESS',
            media: [
              {
                sub_request_status: 'SUCCESS',
                media: {id: '456', ad_account_id: '123', type: 'IMAGE', media_status: 'READY'},
              },
            ],
          });
        return Response.json({
          request_status: 'SUCCESS',
          adaccounts: [{sub_request_status: 'SUCCESS', adaccount: {id: '123'}}],
        });
      }
      if (path.endsWith('/media')) {
        mediaAllocations++;
        return Response.json({
          request_status: 'SUCCESS',
          media: [{sub_request_status: 'SUCCESS', media: {id: '456', ad_account_id: '123'}}],
        });
      }
      if (path.endsWith('/upload'))
        return Response.json({
          request_status: 'SUCCESS',
          result: {id: '456', ad_account_id: '123', media_status: 'READY'},
        });
      assert.ok(path.endsWith('/creatives'));
      const body = JSON.parse(String(init?.body));
      assert.equal(body.creatives[0].top_snap_media_id, '456');
      assert.equal(body.creatives[0].status, undefined);
      return Response.json({
        request_status: 'SUCCESS',
        creatives: [{sub_request_status: 'SUCCESS', creative: {id: '789', ad_account_id: '123'}}],
      });
    }) as typeof fetch),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
    async () => new Response(new Uint8Array(png)),
  );
  const execute = async (r: JsonObject) => {
    assert.equal(r.success, true, JSON.stringify(r));
    const out = await service.call(
      'amcp_write',
      {action: 'execute', review_id: r.data.review_id, idempotency_key: r.data.idempotency_key, confirmed: true},
      actor,
    );
    assert.equal(out.success, true, JSON.stringify(out));
    return out.data;
  };
  try {
    const media = await execute(
      await service.call(
        'amcp_media',
        {action: 'prepare', platform: 'snapchat', account_id: '123', drive_url: link},
        actor,
      ),
    );
    const action = registry.catalogs
      .get('snapchat_native_action')!
      .actions.find(a => a.method === 'POST' && a.path === '/v1/adaccounts/{ad_account_id}/creatives')!.name;
    await execute(
      await service.call(
        'amcp_write',
        {
          action: 'prepare',
          gateway: 'snapchat_native_action',
          arguments: {
            action,
            account_id: '123',
            payload: {
              creatives: [
                {
                  name: 'Creative',
                  ad_account_id: '123',
                  type: 'WEB_VIEW',
                  top_snap_media_id: media.media_id,
                  web_view_properties: {url: 'https://example.com'},
                },
              ],
            },
          },
        },
        actor,
      ),
    );
    assert.equal(store.ownsResource(connection, '123', 'creatives/789'), true);
    await execute(
      await service.call(
        'amcp_write',
        {
          action: 'prepare',
          gateway: 'snapchat_native_action',
          arguments: {
            action: 'snapchat_media_upload',
            account_id: '123',
            params: {media_id: '456'},
            payload: {url: link},
          },
        },
        actor,
      ),
    );
    assert.equal(mediaAllocations, 1);
  } finally {
    store.close();
  }
});
