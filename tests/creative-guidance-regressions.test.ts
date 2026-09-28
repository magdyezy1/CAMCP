import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
const actor = {tenantId: 't', userId: 'u', role: 'admin' as const},
  key = Buffer.alloc(32, 93).toString('base64'),
  policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true};

test('Meta existing Instagram creative uses Instagram identity without a fabricated Facebook story', async () => {
  const store = new Store(':memory:', key),
    c = {
      id: 'c',
      tenantId: 't',
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_management', 'pages_show_list', 'pages_read_engagement', 'instagram_basic'],
    };
  store.putConnection(actor, c, {accessToken: 'synthetic'});
  let writes = 0;
  const s = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      if (init?.method === 'GET') {
        const path = new URL(String(url)).pathname;
        if (path === '/v26.0/act_123') return Response.json({id: 'act_123', currency: 'USD', account_status: 1});
        if (path === '/v26.0/act_123/promote_pages')
          return Response.json({data: [{id: '500', instagram_business_account: {id: '888'}}]});
        if (path === '/v26.0/act_123/instagram_accounts') return Response.json({data: [{id: '888'}]});
        if (path === '/v26.0/500')
          return Response.json({
            id: '500',
            access_token: 'synthetic-page-token',
            instagram_business_account: {id: '888'},
          });
        assert.equal(path, '/v26.0/777');
        assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer synthetic-page-token');
        return Response.json({id: '777', owner: {id: '888'}, media_type: 'VIDEO'});
      }
      writes++;
      const b = new URLSearchParams(String(init?.body));
      assert.equal(b.get('source_instagram_media_id'), '777');
      assert.equal(b.get('instagram_user_id'), '888');
      assert.equal(b.has('object_story_id'), false);
      return Response.json({id: '999'});
    }),
    undefined,
    policy,
  );
  const args = {
    action: 'meta_creative_create',
    account_id: '123',
    payload: {name: 'IG existing Reel', source_instagram_media_id: '777', instagram_user_id: '888'},
  };
  try {
    const p = await s.call('amcp_write', {action: 'prepare', gateway: c.gateway, arguments: args}, actor);
    assert.equal(p.success, true, JSON.stringify(p));
    const e = await s.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
    assert.equal(e.success, true);
    assert.equal(store.ownsResource(c, '123', '999'), true);
    for (const payload of [
      {source_instagram_media_id: '777'},
      {object_story_id: '777'},
      {...args.payload, object_story_id: '1_2'},
    ])
      assert.equal(
        (await s.call('amcp_write', {action: 'prepare', gateway: c.gateway, arguments: {...args, payload}}, actor))
          .success,
        false,
      );
    assert.equal(writes, 1);
  } finally {
    store.close();
  }
});

test('Snapchat creative PATCH reviews exact creative state and ignores delivery status permutations', async () => {
  const store = new Store(':memory:', key),
    c = {
      id: 'c',
      tenantId: 't',
      gateway: 'snapchat_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    };
  store.putConnection(actor, c, {accessToken: 'synthetic'});
  let reads = 0,
    writes = 0;
  const s = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === 'GET') {
        assert.equal(path, '/v1/creatives/creative1');
        reads++;
        return Response.json({
          request_status: 'SUCCESS',
          creatives: [
            {
              sub_request_status: 'SUCCESS',
              creative: {id: 'creative1', name: 'Before', delivery_status: reads % 2 ? ['B', 'A'] : ['A', 'B']},
            },
          ],
        });
      }
      assert.equal(init?.method, 'PATCH');
      assert.equal(path, '/v1/adaccounts/123/creatives/creative1');
      assert.deepEqual(JSON.parse(String(init?.body)), [{op: 'replace', path: '/name', value: 'After'}]);
      writes++;
      return Response.json({
        request_status: 'SUCCESS',
        creatives: [{sub_request_status: 'SUCCESS', creative: {id: 'creative1', name: 'After'}}],
      });
    }),
    undefined,
    policy,
  );
  try {
    store.rememberResource(c, '123', 'creatives/creative1');
    const p = await s.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway: c.gateway,
        arguments: {
          action: 'snapchat_creative_update',
          account_id: '123',
          path_params: {creative_id: 'creative1'},
          payload: [{op: 'replace', path: '/name', value: 'After'}],
        },
      },
      actor,
    );
    assert.equal(p.success, true, JSON.stringify(p));
    assert.deepEqual(p.data.state_reads, [{method: 'GET', path: '/v1/creatives/creative1'}]);
    const e = await s.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
    assert.equal(e.success, true, JSON.stringify(e));
    assert.equal(reads, 2);
    assert.equal(writes, 1);
  } finally {
    store.close();
  }
});
