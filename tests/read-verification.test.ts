import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {prepareReadProbes, verifyReads} from '../src/read-verification.js';
import type {Actor} from '../src/types.js';
const actor: Actor = {tenantId: 't', userId: 'probe', role: 'reader'};
const read = {
  gateway: 'meta_native_action',
  arguments: {action: 'meta_campaign_list', account_id: '111', query: {fields: 'id,status', limit: 1}},
};

test('verification previews default to no egress and reject a mixed read/write batch before execution', async () => {
  const store = new Store(':memory:');
  let calls = 0;
  try {
    const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport((async () => {
        calls++;
        throw Error();
      }) as typeof fetch),
    );
    assert.throws(
      () =>
        prepareReadProbes(service, [
          read,
          {
            gateway: 'meta_native_action',
            arguments: {action: 'meta_campaign_create', account_id: '111', payload: {name: 'draft'}},
          },
        ]),
      /read/,
    );
    const prepared = prepareReadProbes(service, [read]);
    const result = await verifyReads(service, prepared, actor);
    assert.equal(result.mode, 'local_preview');
    assert.equal(result.results[0].executed, false);
    assert.equal(result.success, true);
    await assert.rejects(verifyReads(service, prepared, {...actor, role: 'admin'}, true), /reader/);
    assert.equal(calls, 0);
  } finally {
    store.close();
  }
});

test('live read verification uses tenant bindings and returns status without vendor response contents', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 12).toString('base64'));
  let calls = 0;
  try {
    store.putConnection(
      {...actor, role: 'admin'},
      {id: 'c', tenantId: 't', gateway: read.gateway, accounts: ['111'], enabled: true, label: 'Mock', scopes: []},
      {accessToken: 'not-real'},
    );
    const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport((async () => {
        calls++;
        return new Response('{"data":[{"id":"555","name":"private campaign"}]}');
      }) as typeof fetch),
    );
    const prepared = prepareReadProbes(service, [read]);
    const result = await verifyReads(service, prepared, actor, true);
    assert.equal(result.success, true);
    assert.equal(result.results[0].executed, true);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(result).includes('private campaign'));
    const denied = await verifyReads(service, prepared, {...actor, tenantId: 'other'}, true);
    assert.equal(denied.success, false);
    assert.equal(denied.results[0].executed, null);
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});
