import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {providerContracts, effectiveProviderContract} from '../src/provider-contracts.js';
import {providerContractView} from '../src/contract-evidence.js';
import {workspaceCapabilities} from '../src/capabilities.js';
import type {Actor} from '../src/types.js';

// The owner, from live use: "Anything not proven against a live account should be marked unverified, not listed as
// supported. A tool that overstates what it can do does more damage than one with a missing feature." (F-87)
const levels = ['discovery', 'native_reads', 'overview_reporting', 'reviewed_writes', 'media_import'];
const actor: Actor = {tenantId: 'honest', userId: 'owner', role: 'admin'};

test('no provider capability reads as supported without live proof', () => {
  for (const c of providerContracts) {
    const effective = effectiveProviderContract(String(c.id))!;
    for (const level of levels)
      assert.match(
        String(effective[level]),
        /^(?:unsupported|implemented_unverified|partial_unverified)$/,
        c.id + ' ' + level,
      );
    const view = providerContractView(String(c.gateway))!;
    assert.match(String(view.status_meaning), /not proven against a live account/);
    if (effective.write_scope)
      assert.match(String(view.write_scope), /^Implemented and tested locally; not verified against a live account: /);
  }
});

test('the contract guide says the reviewed scope is not verified live', () => {
  const guide = fs.readFileSync('docs/CONTRACTS.md', 'utf8');
  assert.match(guide, /\| Platform \| Pinned API \| Reviewed scope \(implemented, not verified live\) \|/);
});

test("a workspace's own verified writes are its live evidence, per provider; nothing else counts", async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 87).toString('base64')),
    connection = 'aaaaaaaa-8787-4787-8787-878787878787';
  try {
    store.putConnection(
      actor,
      {
        id: connection,
        tenantId: actor.tenantId,
        gateway: 'google_ads_native_action',
        accounts: ['1234567890'],
        writeAccounts: ['1234567890'],
        enabled: true,
        label: 'Google',
        scopes: ['https://www.googleapis.com/auth/adwords'],
      },
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
    const action = 'google_ads_v23_customer_conversion_goal_mutate_customer_conversion_goals',
      receipt = (id: string, status: string) =>
        store.putDocument(actor.tenantId, 'write_verification', id, {
          review_id: id,
          connection_id: connection,
          account_id: '1234567890',
          action,
          status,
          checks: [],
          checked_at: Date.parse('2026-09-29T10:00:00Z'),
        });
    const provider = (id: string) => workspaceCapabilities(store, actor).providers.find((p: any) => p.id === id)!;
    assert.deepEqual(provider('google').live_verified, []);
    receipt('r-inconclusive', 'inconclusive');
    receipt('r-verified', 'verified');
    assert.deepEqual(provider('google').live_verified, [
      {action, account_id: '1234567890', verified_at: '2026-09-29T10:00:00.000Z', review_id: 'r-verified'},
    ]);
    // Google's evidence says nothing about another provider.
    assert.deepEqual(provider('meta').live_verified, []);
    // The same view through MCP.
    const r = await new MirrorService(new Registry(), store).call('amcp_workspace', {action: 'dashboard'}, actor);
    assert.equal(r.success, true, JSON.stringify(r.error));
    const google = r.data.capabilities.providers.find((p: any) => p.id === 'google');
    assert.equal(google.reviewed_writes, 'partial_unverified');
    assert.equal(google.live_verified.length, 1);
  } finally {
    store.close();
  }
});
