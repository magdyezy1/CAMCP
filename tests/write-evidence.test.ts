import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {NativeTransport} from '../src/transport.js';
import {MirrorService} from '../src/service.js';
import {providerContracts} from '../src/provider-contracts.js';
import {providerContractView, providerContractReference} from '../src/contract-evidence.js';
import type {Actor, JsonObject} from '../src/types.js';

// F-29: inspect and prepare repeat the provider's whole contract (5-7 KB) unless the caller asks for a reference.
const registry = new Registry(),
  key = Buffer.alloc(32, 29).toString('base64'),
  actor: Actor = {tenantId: 'evidence', userId: 'operator', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'},
  policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  connection = 'aaaaaaaa-2929-4929-8929-292929292929';
const campaign = {
  action: 'meta_campaign_create',
  account_id: '123',
  payload: {name: 'Draft', status: 'PAUSED', objective: 'OUTCOME_TRAFFIC', special_ad_categories: []},
};
const write = {gateway: 'meta_native_action', connection_id: connection, arguments: campaign};
function setup() {
  const store = new Store(':memory:', key);
  store.putConnection(
    admin,
    {
      id: connection,
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  const requests: string[] = [];
  let created = 110;
  const transport = new NativeTransport((async (url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push(init!.method + ' ' + path);
    if (init!.method === 'GET') {
      const id = path.split('/').at(-1);
      return Response.json(
        id === 'act_123'
          ? {id: 'act_123', currency: 'USD', account_status: 1}
          : {id, name: 'Draft', status: 'PAUSED', objective: 'OUTCOME_TRAFFIC'},
      );
    }
    return Response.json({id: String(++created)});
  }) as typeof fetch);
  return {store, requests, service: new MirrorService(registry, store, transport, undefined, policy)};
}
async function ok(s: MirrorService, tool: string, input: JsonObject) {
  const r = await s.call(tool, input, actor);
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data as JsonObject;
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

test('inspect and prepare return the whole provider contract by default, and a reference to it with evidence "ref"', async () => {
  const x = setup();
  try {
    for (const action of ['inspect', 'prepare']) {
      const full = await ok(x.service, 'amcp_write', {action, ...write}),
        explicit = await ok(x.service, 'amcp_write', {action, ...write, evidence: 'full'}),
        ref = await ok(x.service, 'amcp_write', {action, ...write, evidence: 'ref'});
      assert.deepEqual(explicit.contract_evidence, full.contract_evidence);
      const {provider: whole, ...common} = full.contract_evidence,
        {provider: reference, ...same} = ref.contract_evidence;
      assert.ok(whole.write_scope && whole.maintenance, action);
      // Only the provider contract becomes a reference; the action's own evidence stays.
      assert.deepEqual(same, common);
      assert.deepEqual(reference, providerContractReference('meta_native_action')!);
      assert.deepEqual(Object.keys(reference).sort(), [
        'api_version',
        'contract_version',
        'full_contract',
        'gateway',
        'id',
        'live_qualification',
        'reviewed_at',
        'reviewed_writes',
        'version_end',
      ]);
      for (const field of Object.keys(reference).filter(k => k !== 'full_contract'))
        assert.deepEqual(reference[field], whole[field], field);
      // Following the reference returns exactly the contract left out.
      const help = await x.service.call(reference.full_contract.tool, reference.full_contract.arguments, actor);
      assert.deepEqual(help[reference.full_contract.result_field], whole);
      assert.ok(bytes(reference) * 8 < bytes(whole), bytes(reference) + ' of ' + bytes(whole) + ' bytes');
      if (action === 'prepare') {
        // The form of the evidence is not part of the review: same request, same state, same fingerprint.
        for (const field of ['request', 'before_state', 'state_hash', 'state_reads', 'spend_policy', 'fingerprint'])
          assert.deepEqual(ref[field], full[field], field);
        const executed = await ok(x.service, 'amcp_write', {
          action: 'execute',
          review_id: ref.review_id,
          confirmed: true,
          ...(ref.execute_requirements.spend_change_confirmed ? {spend_change_confirmed: true} : {}),
        });
        assert.equal(executed.executed, true);
      }
    }
  } finally {
    x.store.close();
  }
});

test('every gateway a review can name has a reference that leads to its whole contract', async () => {
  const x = setup();
  try {
    let followed = 0;
    for (const contract of providerContracts) {
      const gateway = String(contract.gateway),
        whole = providerContractView(gateway)!,
        reference = providerContractReference(gateway)!;
      for (const field of Object.keys(reference).filter(k => k !== 'full_contract'))
        assert.deepEqual(reference[field], whole[field], gateway + ' ' + field);
      // Whatever the provider, the reference stays small; the whole contracts are 1.3-6.6 KB.
      assert.ok(bytes(reference) < 700 && bytes(reference) < bytes(whole), gateway + ': ' + bytes(reference));
      // Drive and Sheets back AMCP's own features; they are no MCP gateway, so no review names them.
      if (!registry.tools.has(gateway)) continue;
      const help = await x.service.call(reference.full_contract.tool, reference.full_contract.arguments, actor);
      assert.deepEqual(help[reference.full_contract.result_field], whole, gateway);
      followed++;
    }
    assert.equal(followed, providerContracts.length - 2);
    assert.equal(providerContractReference('amcp_native_action'), undefined);
  } finally {
    x.store.close();
  }
});

test('an unknown evidence form is refused before any provider read', async () => {
  const x = setup();
  try {
    for (const evidence of ['summary', true, null])
      for (const action of ['inspect', 'prepare']) {
        const r = await x.service.call('amcp_write', {action, ...write, evidence}, actor);
        assert.equal(r.success, false);
        assert.equal(r.error.code, 'INVALID_ARGUMENT', JSON.stringify(r.error));
        assert.match(r.error.message, /evidence/);
      }
    assert.deepEqual(x.requests, []);
  } finally {
    x.store.close();
  }
});

test('a campaign plan keeps a reference to the provider contract in each prepared step', async () => {
  const x = setup();
  try {
    const run = await ok(x.service, 'amcp_campaign', {
      action: 'create',
      name: 'Synthetic launch',
      brief: 'Paused traffic campaign using approved settings.',
      steps: [
        {
          id: 'campaign',
          kind: 'write',
          gateway: 'meta_native_action',
          connection_id: connection,
          account_id: '123',
          arguments: {action: campaign.action, payload: campaign.payload},
          depends_on: [],
        },
      ],
    });
    const next = await ok(x.service, 'amcp_campaign', {action: 'prepare_next', id: run.id}),
      provider = next.review.contract_evidence.provider;
    assert.deepEqual(provider, providerContractReference('meta_native_action')!);
    const stored = await ok(x.service, 'amcp_campaign', {action: 'get', id: run.id});
    assert.deepEqual(stored.steps[0].review.contract_evidence.provider, provider);
    const whole = bytes(providerContractView('meta_native_action'));
    assert.ok(bytes(stored) + whole - bytes(provider) > bytes(stored) * 1.5, String(bytes(stored)));
  } finally {
    x.store.close();
  }
});
