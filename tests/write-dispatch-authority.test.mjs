import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const registry = new Registry(),
  gateway = 'meta_native_action',
  owner = {tenantId: 'dispatch-authority', userId: 'owner', role: 'admin'};

function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 52).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'm',
      tenantId: owner.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  let writes = 0,
    onRead,
    onMutationPermit,
    mutationWaiting = false,
    intercepted = 0;
  const transport = new NativeTransport(
    async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init.method === 'GET') {
        const hook = onRead;
        onRead = undefined;
        if (hook) {
          intercepted++;
          await hook();
        }
        if (path === '/v26.0/act_123')
          return Response.json({
            id: 'act_123',
            account_id: '123',
            currency: 'USD',
            account_status: 1,
            tos_accepted: {custom_audience_tos: 1},
          });
        if (path === '/v26.0/456')
          return Response.json({
            id: '456',
            account_id: '123',
            name: 'Customers',
            subtype: 'CUSTOM',
            is_value_based: false,
            operation_status: {code: 200},
            delivery_status: {code: 200},
          });
      }
      if (init.method === 'POST') {
        writes++;
        if (path === '/v26.0/act_123/campaigns') return Response.json({id: '111'});
        if (path === '/v26.0/456/users')
          return Response.json({audience_id: '456', session_id: '1', num_received: 1, num_invalid_entries: 0});
      }
      throw Error('Unexpected synthetic request: ' + init.method + ' ' + path);
    },
    async () => {
      if (mutationWaiting && onMutationPermit) {
        const hook = onMutationPermit;
        onMutationPermit = undefined;
        intercepted++;
        await hook();
      }
    },
    30000,
    8 * 1024 * 1024,
    0,
    1000000,
    1000000000,
  );
  const request = transport.request.bind(transport);
  transport.request = async (...args) => {
    mutationWaiting = !args[0].readOnly;
    return request(...args);
  };
  const service = new MirrorService(registry, store, transport, undefined, {
      allowWrites: true,
      maxBudgetChange: 0,
      requireBeforeState: true,
    }),
    workspace = input => service.call('amcp_workspace', input, owner),
    pause = async () => {
      const result = await workspace({action: 'pause_writes', reason: 'Synthetic concurrent pause', confirmed: true});
      assert.equal(result.success, true, JSON.stringify(result));
    },
    call = input => service.call('amcp_write', input, owner),
    campaign = () =>
      call({
        action: 'prepare',
        gateway,
        arguments: {
          action: 'meta_campaign_create',
          account_id: '123',
          payload: {name: 'Draft', status: 'PAUSED', objective: 'OUTCOME_TRAFFIC', special_ad_categories: []},
        },
      });
  return {
    store,
    workspace,
    pause,
    call,
    campaign,
    writes: () => writes,
    intercepted: () => intercepted,
    duringRead: hook => (onRead = hook),
    duringMutationPermit: hook => (onMutationPermit = hook),
  };
}

for (const wait of ['state read', 'transport permit'])
  test('a workspace pause during the execute ' + wait + ' prevents mutation dispatch', async () => {
    const f = fixture();
    try {
      const prepared = await f.campaign();
      assert.equal(prepared.success, true, JSON.stringify(prepared));
      if (wait === 'state read') f.duringRead(f.pause);
      else f.duringMutationPermit(f.pause);
      const result = await f.call({action: 'execute', review_id: prepared.data.review_id, confirmed: true});
      assert.equal(f.intercepted(), 1, 'The owner paused writes inside the intended asynchronous wait');
      assert.equal(f.writes(), 0, 'A mutation was dispatched after the owner paused writes');
      assert.equal(result.error?.code, 'WRITES_PAUSED', JSON.stringify(result));
    } finally {
      f.store.close();
    }
  });

test('disabling personal data during transport admission prevents the pending upload', async () => {
  const f = fixture(),
    people = {schema: 'EMAIL', rows: ['person@example.org']};
  try {
    const enabled = await f.workspace({
      action: 'enable_personal_data',
      connection_id: 'm',
      account_id: '123',
      confirmed: true,
    });
    assert.equal(enabled.success, true, JSON.stringify(enabled));
    const prepared = await f.call({
      action: 'prepare',
      gateway,
      arguments: {
        action: 'meta_custom_audience_id_users_create',
        account_id: '123',
        params: {custom_audience_id: '456'},
      },
      people,
      personal_data: {countries: ['DE'], consent_confirmed: true, platform_terms_confirmed: true},
    });
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    f.duringMutationPermit(async () => {
      const disabled = await f.workspace({action: 'disable_personal_data', gateway, account_id: '123'});
      assert.equal(disabled.success, true, JSON.stringify(disabled));
    });
    const result = await f.call({action: 'execute', review_id: prepared.data.review_id, confirmed: true, people});
    assert.equal(f.intercepted(), 1, 'The owner disabled personal data during transport admission');
    assert.equal(f.writes(), 0, 'The upload was dispatched after the owner disabled personal data');
    assert.equal(result.error?.code, 'PERSONAL_DATA_OFF', JSON.stringify(result));
  } finally {
    f.store.close();
  }
});

test('pausing a multipart media upload retains its confirmed boundary and prevents later chunks', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 53).toString('base64')),
    bytes = Buffer.alloc(5 * 1024 * 1024);
  bytes.write('ftypisom', 4);
  store.putConnection(
    owner,
    {
      id: 'g',
      tenantId: owner.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Google',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  let chunks = 0,
    queries = 0;
  const transport = new NativeTransport(async (raw, init) => {
      const url = new URL(String(raw)),
        headers = new Headers(init.headers);
      if (url.pathname.endsWith('/googleAds:search'))
        return Response.json({results: [{customer: {id: '123', currencyCode: 'USD'}}]});
      if (headers.get('X-Goog-Upload-Command') === 'start')
        return new Response(null, {
          headers: {
            'x-goog-upload-url': 'https://googleads.googleapis.com/resumable/upload/v25/session?upload_id=synthetic',
          },
        });
      if (headers.get('X-Goog-Upload-Command') === 'query') {
        queries++;
        return new Response(null, {headers: {'x-goog-upload-size-received': '4194304'}});
      }
      if (++chunks === 1) {
        const paused = await service.call(
          'amcp_workspace',
          {action: 'pause_writes', reason: 'Synthetic pause after accepted chunk', confirmed: true},
          owner,
        );
        assert.equal(paused.success, true, JSON.stringify(paused));
        return new Response(null);
      }
      return Response.json({resourceName: 'customers/123/youTubeVideoUploads/456'});
    }),
    service = new MirrorService(
      registry,
      store,
      transport,
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
      async () => new Response(bytes),
    );
  try {
    const prepared = await service.call(
      'amcp_media',
      {
        action: 'prepare',
        platform: 'google_ads',
        account_id: '123',
        connection_id: 'g',
        drive_url: 'https://drive.google.com/file/d/abcdefghijklmno/view',
      },
      owner,
    );
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    const result = await service.call(
      'amcp_media',
      {
        action: 'execute',
        review_id: prepared.data.review_id,
        idempotency_key: prepared.data.review_id,
        confirmed: true,
      },
      owner,
    );
    assert.equal(chunks, 1, 'A later chunk was dispatched after the owner paused writes');
    assert.equal(queries, 0);
    assert.equal(result.error?.code, 'WRITES_PAUSED', JSON.stringify(result));
    assert.equal(store.uploadSession(owner.tenantId, prepared.data.review_id).finalization_started, undefined);
    assert.equal(
      store.document(owner.tenantId, 'media_review', prepared.data.review_id).progress.bytes_confirmed,
      4194304,
    );
    assert.equal(store.stagedMedia(owner.tenantId, prepared.data.review_id).length, bytes.length);
    assert.equal(
      store.db
        .prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?')
        .get(owner.tenantId, prepared.data.review_id).state,
      'uncertain',
    );
  } finally {
    store.close();
  }
});
