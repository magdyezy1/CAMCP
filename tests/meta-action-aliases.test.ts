import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Compiler} from '../src/compiler.js';
import {actionContracts} from '../src/action-contracts.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Connection} from '../src/types.js';

const registry = new Registry(),
  gateway = 'meta_native_action',
  actor = {tenantId: 'meta-alias', userId: 'operator', role: 'operator' as const},
  owner = {...actor, role: 'admin' as const};
const aliases = [
  ['meta_campaign_update', 'meta_campaign_id_update', 'campaign_id'],
  ['meta_campaign_delete', 'meta_campaign_id_delete', 'campaign_id'],
  ['meta_adset_update', 'meta_ad_set_id_update', 'ad_set_id'],
  ['meta_adset_delete', 'meta_ad_set_id_delete', 'ad_set_id'],
  ['meta_ad_update', 'meta_ad_id_update', 'ad_id'],
  ['meta_ad_delete', 'meta_ad_id_delete', 'ad_id'],
];
for (const [alias, canonical, parameter] of aliases)
  test(alias + ' uses the canonical reviewed contract and retains grant, conflict and replay protections', async () => {
    const store = new Store(':memory:', Buffer.alloc(32, 51).toString('base64')),
      c: Connection = {
        id: 'c',
        gateway,
        tenantId: actor.tenantId,
        accounts: ['123'],
        writeAccounts: ['123'],
        enabled: true,
        label: 'Synthetic',
        scopes: ['ads_management'],
        resourceBindings: [{accountId: '123', pathPrefix: '/v26.0/77'}],
      };
    let writes = 0;
    const state = {id: '77', name: 'Before', status: 'PAUSED'},
      deleting = alias!.endsWith('_delete');
    store.putConnection(owner, c, {accessToken: 'synthetic'});
    const service = new MirrorService(
      registry,
      store,
      new NativeTransport(async (url, init) => {
        assert.equal(new URL(String(url)).pathname, '/v26.0/77');
        if (init!.method === 'GET') return Response.json(state);
        writes++;
        assert.equal(init!.method, deleting ? 'DELETE' : 'POST');
        if (deleting) state.status = 'DELETED';
        else state.name = new URLSearchParams(String(init!.body)).get('name')!;
        return Response.json({success: true});
      }),
      undefined,
      {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
    );
    const arguments_ = {
      action: alias,
      account_id: '123',
      params: {[parameter!]: '77'},
      ...(deleting ? {} : {payload: {name: 'After'}}),
    };
    try {
      const compiler = new Compiler(registry),
        p = compiler.compile(gateway, arguments_, {mode: 'strict', flags: {}});
      assert.equal(p.action, canonical);
      const inspected = await service.call('amcp_write', {action: 'inspect', gateway, arguments: arguments_}, actor);
      assert.equal(inspected.data.review_contract_supported, true, JSON.stringify(inspected));
      assert.equal(
        (
          await service.call(
            gateway,
            {...arguments_, dry_run: false, confirmed: true, idempotency_key: 'direct', before_state: state},
            actor,
          )
        ).error.code,
        'WRITE_REVIEW_REQUIRED',
      );
      const prepared = await service.call('amcp_write', {action: 'prepare', gateway, arguments: arguments_}, actor);
      assert.equal(prepared.success, true, JSON.stringify(prepared));
      const execute = {
        action: 'execute',
        review_id: prepared.data.review_id,
        idempotency_key: prepared.data.idempotency_key,
        confirmed: true,
      };
      state.name = 'Concurrent';
      assert.equal((await service.call('amcp_write', execute, actor)).error.code, 'STATE_CHANGED');
      state.name = 'Before';
      store.putConnection(owner, {...c, writeAccounts: []}, {accessToken: 'synthetic'});
      assert.equal((await service.call('amcp_write', execute, actor)).error.code, 'WRITE_ACCOUNT_FORBIDDEN');
      store.putConnection(owner, c, {accessToken: 'synthetic'});
      const results = await Promise.all([
        service.call('amcp_write', execute, actor),
        service.call('amcp_write', execute, actor),
      ]);
      assert.ok(
        results.some(r => r.success),
        JSON.stringify(results),
      );
      assert.equal(writes, 1);
      const replay = await service.call('amcp_write', execute, actor);
      assert.equal(replay.data.replayed, true);
      assert.equal(writes, 1);
      if (!deleting) assert.equal((await service.verifyWrite(actor, prepared.data.review_id)).status, 'verified');
      const rows = actionContracts(registry);
      assert.equal(
        rows.find(r => r.gateway === gateway && r.action === alias)?.status,
        'reviewed_write_family',
        'Inventory must use the same canonical action as the compiler',
      );
    } finally {
      store.close();
    }
  });
test('canonicalizing inventory aliases never enables unrelated Meta creative, audience, access or batch writes', () => {
  const rows = actionContracts(registry);
  assert.equal(
    rows.find(r => r.gateway === 'google_ads_native_action' && r.action === 'UPDATE_CUSTOMIZER_ATTRIBUTE')?.status,
    'provider_unsupported',
    'The v23 operation union has no update; a legacy name cannot enable generic mutation.',
  );
  // The creative and audience rename aliases belong to the reviewed object edit family; the others stay blocked.
  for (const alias of ['meta_creative_update', 'meta_custom_audience_update'])
    assert.equal(rows.find(r => r.gateway === gateway && r.action === alias)?.family, 'meta_object_edits');
  for (const alias of ['meta_business_user_update', 'meta_system_user_create', 'meta_batch_create'])
    assert.equal(rows.find(r => r.gateway === gateway && r.action === alias)?.status, 'blocked_write');
  for (const catalog of registry.catalogs.values())
    for (const a of catalog.actions) {
      if (!a.canonical_name || a.canonical_name === a.name) continue;
      const alias = rows.find(r => r.gateway === catalog.gateway && r.action === a.name),
        canonical = rows.find(r => r.gateway === catalog.gateway && r.action === a.canonical_name);
      if (alias?.method === canonical?.method && alias?.path === canonical?.path) {
        assert.equal(alias?.status, canonical?.status, catalog.gateway + '/' + a.name);
        assert.equal(alias?.family, canonical?.family, catalog.gateway + '/' + a.name);
      }
    }
});
