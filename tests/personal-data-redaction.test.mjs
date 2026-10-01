import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const registry = new Registry(),
  gateway = 'meta_native_action',
  owner = {tenantId: 'personal-redaction', userId: 'owner', role: 'admin'},
  email = 'person@example.org',
  hash = createHash('sha256').update(email).digest('hex'),
  phone = '+12025550123';

function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 51).toString('base64'));
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
  let writes = 0;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init.method === 'GET') {
        if (path === '/v26.0/act_123')
          return Response.json({id: 'act_123', account_id: '123', tos_accepted: {custom_audience_tos: 1}});
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
      if (init.method === 'POST' && path === '/v26.0/456/users') {
        writes++;
        return Response.json(
          {
            error: {
              code: 100,
              message: 'Invalid entries',
              invalid_entry_samples: {[hash]: 'Invalid', [email]: 'Invalid'},
            },
          },
          {status: 400},
        );
      }
      throw Error('Unexpected synthetic request: ' + init.method + ' ' + path);
    }),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  const call = input => service.call('amcp_write', input, owner),
    prepare = extra =>
      call({
        action: 'prepare',
        gateway,
        arguments: {
          action: 'meta_custom_audience_id_users_create',
          account_id: '123',
          params: {custom_audience_id: '456'},
          ...extra?.arguments,
        },
        people: {schema: 'EMAIL', rows: [email]},
        personal_data: {countries: ['DE'], consent_confirmed: true, platform_terms_confirmed: true},
        ...Object.fromEntries(Object.entries(extra ?? {}).filter(([key]) => key !== 'arguments')),
      }),
    kept = () =>
      JSON.stringify([
        store.db.prepare('SELECT data FROM documents').all(),
        store.db.prepare('SELECT event FROM audit').all(),
        store.db.prepare('SELECT result FROM idempotency').all(),
        store.db.prepare('SELECT input,result,error FROM jobs').all(),
      ]);
  return {store, service, call, prepare, kept, writes: () => writes};
}

test('rejected personal-data uploads remove identifying object keys from returned errors and stored audits', async () => {
  const f = fixture();
  try {
    const enabled = await f.service.call(
      'amcp_workspace',
      {action: 'enable_personal_data', connection_id: 'm', account_id: '123', confirmed: true},
      owner,
    );
    assert.equal(enabled.success, true, JSON.stringify(enabled));
    const prepared = await f.prepare();
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    const rejected = await f.call({
      action: 'execute',
      review_id: prepared.data.review_id,
      confirmed: true,
      people: {schema: 'EMAIL', rows: [email]},
    });
    assert.equal(rejected.success, false);
    assert.equal(f.writes(), 1);
    for (const [label, text] of [
      ['returned error', JSON.stringify(rejected)],
      ['stored records', f.kept()],
    ])
      for (const value of [hash, email]) assert.equal(text.includes(value), false, label + ' retains a person');
  } finally {
    f.store.close();
  }
});

test('rejected inline personal-data payloads do not persist raw phone values in error audits', async () => {
  const f = fixture();
  try {
    const rejected = await f.prepare({
      arguments: {payload: {schema: 'PHONE', data: [[phone]]}},
      people: undefined,
      personal_data: undefined,
    });
    assert.equal(rejected.success, false);
    assert.equal(f.writes(), 0);
    assert.equal(f.kept().includes(phone), false, 'The rejected inline phone reached persistent audit storage');
  } finally {
    f.store.close();
  }
});
