import test from 'node:test';
import assert from 'node:assert/strict';
import type {JsonObject} from '../src/types.js';
import {
  SNAP,
  account,
  admin,
  campaignStep,
  createPlan,
  fixture,
  gateway,
  runAll,
  squadPlan,
} from './snapchat-plan-fixture.js';

/**
 * Snapchat S8, S9, S10, S12 and S13 from the owner's live tests: account metadata that list_accounts never showed,
 * billing details in every review, a contracts page summarising every gateway, execute refusing restated values
 * without saying what it accepts, and no plan-level notice that nothing caps the plan's budgets.
 */
const billing = [
  'billing_center_id',
  'billing_type',
  'funding_source_ids',
  'cell_ids',
  'client_paying_invoices',
  'agency_representing_client',
];
const accounts = (f: ReturnType<typeof fixture>) =>
  f.call('amcp_native_action', {operation: 'list_accounts', arguments: {}}).then(r => r.data as JsonObject[]);

test('list_accounts shows what a live read found, and before one, says how to get it (S8)', async () => {
  const f = fixture();
  try {
    f.store.putConnection(
      admin,
      {
        id: 'meta',
        tenantId: admin.tenantId,
        gateway: 'meta_native_action',
        accounts: ['act_1'],
        enabled: true,
        label: 'Meta login',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    const before = await accounts(f),
      snap = before.find(r => r.platform === gateway)!;
    assert.equal(snap.name, null, 'the connection label is not the account name');
    assert.equal(snap.connection_label, 'Snapchat login');
    assert.equal(snap.currency, null);
    assert.equal(snap.metadata, null);
    assert.deepEqual(snap.next_call, {
      tool: 'amcp_workspace',
      arguments: {action: 'check', connection_id: SNAP, account_id: 'acct1', live: true},
    });
    // One shape for every platform.
    assert.deepEqual(
      Object.keys(snap).sort(),
      Object.keys(before.find(r => r.platform === 'meta_native_action')!).sort(),
    );
    const check = await f.call('amcp_workspace', {
      action: 'check',
      connection_id: SNAP,
      account_id: 'acct1',
      live: true,
    });
    assert.equal(check.success, true, JSON.stringify(check));
    const after = (await accounts(f)).find(r => r.platform === gateway)!;
    assert.equal(after.name, 'Synthetic Company');
    assert.equal(after.currency, 'USD');
    assert.equal(after.timezone, 'Asia/Riyadh');
    assert.equal(after.metadata.source, 'live_account_read');
    assert.equal(after.metadata.organization_id, 'org1');
    assert.match(after.metadata.checked_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(after.next_call, undefined);
    // After a week the values are marked stale and the live check is suggested again.
    f.store.db
      .prepare("UPDATE documents SET data=json_set(data,'$.checked_at',?) WHERE kind='account_metadata'")
      .run(Date.now() - 8 * 86400000);
    const stale = (await accounts(f)).find(r => r.platform === gateway)!;
    assert.equal(stale.metadata.stale, true);
    assert.equal(stale.currency, 'USD');
    assert.equal(stale.next_call.arguments.live, true);
    assert.equal(f.writes.length, 0);
  } finally {
    f.close();
  }
});

test('reviews keep what a Snapchat write depends on, never the billing and funding details (S9)', async () => {
  const f = fixture();
  try {
    const prepared = await f.call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: SNAP,
      arguments: {...campaignStep().arguments, account_id: 'acct1'},
    });
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    assert.deepEqual(prepared.data.before_state[0].adaccounts[0].adaccount, {
      id: 'acct1',
      name: 'Synthetic Company',
      status: 'ACTIVE',
      currency: 'USD',
      timezone: 'Asia/Riyadh',
      organization_id: 'org1',
      type: 'PARTNER',
    });
    const id = (await createPlan(f, squadPlan(3))).data.id;
    const outputs = [prepared, ...(await runAll(f, id)).map(r => r.result)];
    outputs.push(await f.call('amcp_campaign', {action: 'get', id, detail: 'full'}));
    for (const key of billing)
      assert.equal(
        outputs.some(o => JSON.stringify(o).includes('"' + key + '"')),
        false,
        key + ' appears in a review or plan response',
      );
  } finally {
    f.close();
  }
});

test('the review state hash still catches a currency or status change, and ignores billing (S9)', async () => {
  const f = fixture();
  const original = {...account};
  try {
    const prepare = () =>
      f.call('amcp_write', {
        action: 'prepare',
        gateway,
        connection_id: SNAP,
        arguments: {...campaignStep().arguments, account_id: 'acct1'},
      });
    const execute = (r: JsonObject) =>
      f.call('amcp_write', {action: 'execute', review_id: r.data.review_id, confirmed: true});
    for (const [field, value] of [
      ['currency', 'EUR'],
      ['status', 'DISABLED'],
    ] as const) {
      const r = await prepare();
      (account as JsonObject)[field] = value;
      const refused = await execute(r);
      Object.assign(account, original);
      assert.equal(refused.success, false, field);
      assert.equal(refused.error.code, 'STATE_CHANGED', field + ' ' + JSON.stringify(refused.error));
    }
    const r = await prepare();
    (account as JsonObject).billing_type = 'CREDIT_CARD';
    const done = await execute(r);
    assert.equal(done.success, true, 'a billing change does not invalidate the review: ' + JSON.stringify(done.error));
    assert.equal(f.writes.length, 1);
  } finally {
    Object.assign(account, original);
    f.close();
  }
});

test('a contracts page filtered to one gateway summarises that gateway only (S10)', async () => {
  const f = fixture();
  try {
    const page = await f.call('amcp_workspace', {action: 'contracts', gateway, search: 'adsquad_create', limit: 5});
    assert.deepEqual(
      page.data.summary.map((s: JsonObject) => s.gateway),
      [gateway],
    );
    assert.ok(page.data.actions.every((a: JsonObject) => a.gateway === gateway));
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 4096, String(Buffer.byteLength(JSON.stringify(page))));
    const all = await f.call('amcp_workspace', {action: 'contracts', limit: 1});
    assert.ok(all.data.summary.length > 10, 'unfiltered, every gateway is summarised');
    const unknown = await f.call('amcp_workspace', {action: 'contracts', gateway: 'snap_native_action'});
    assert.equal(unknown.error.code, 'UNKNOWN_GATEWAY');
    assert.match(unknown.error.message, /snap_native_action.*snapchat_native_action/);
  } finally {
    f.close();
  }
});

test('execute accepts the review’s own gateway and connection, and names what it accepts otherwise (S12)', async () => {
  const f = fixture();
  try {
    const prepare = () =>
      f.call('amcp_write', {
        action: 'prepare',
        gateway,
        connection_id: SNAP,
        arguments: {...campaignStep().arguments, account_id: 'acct1'},
      });
    const r = await prepare(),
      execute = (extra: JsonObject) =>
        f.call('amcp_write', {action: 'execute', review_id: r.data.review_id, confirmed: true, ...extra});
    const other = await execute({connection_id: '22222222-2222-4222-8222-222222222222'});
    assert.equal(other.error.code, 'INVALID_ARGUMENT');
    assert.equal(other.error.details.field, 'connection_id');
    assert.match(other.error.message, /repeating the same ones is accepted/);
    const args = await execute({arguments: {}});
    assert.match(args.error.message, /Remove arguments.*review_id, idempotency_key, confirmed.*spend_change_confirmed/);
    assert.equal(f.writes.length, 0);
    const same = await execute({gateway, connection_id: SNAP});
    assert.equal(same.success, true, JSON.stringify(same.error));
    assert.equal(f.writes.length, 1);
  } finally {
    f.close();
  }
});

test('an unprotected account gets one plan-level notice at preflight, which never blocks (S13)', async () => {
  const f = fixture();
  try {
    const id = (await createPlan(f, squadPlan(3))).data.id;
    const checked = (await f.call('amcp_campaign', {action: 'preflight', id})).data;
    assert.equal(checked.preflight.status, 'ready');
    assert.equal(checked.blocked, false);
    assert.equal(checked.preflight.warnings.length, 1);
    const warning = checked.preflight.warnings[0];
    assert.equal(warning.code, 'SPEND_POLICY_MISSING');
    assert.deepEqual(warning.accounts, [{gateway, account_id: 'acct1'}]);
    assert.equal(warning.next_call.arguments.action, 'save_spend_policy');
    assert.equal(warning.next_call.owner_only, true);
    const done = await runAll(f, id);
    assert.equal(done.at(-1)!.result.data.state, 'complete', 'the notice never blocks');
    // Once the owner sets a workspace default, the notice is gone.
    const saved = await f.service.call(
      'amcp_workspace',
      {action: 'save_spend_policy', scope: 'workspace', confirmed: true, policy: {allow_activation: false}},
      admin,
    );
    assert.equal(saved.success, true, JSON.stringify(saved));
    const second = (await createPlan(f, squadPlan(2))).data.id;
    assert.equal((await f.call('amcp_campaign', {action: 'preflight', id: second})).data.preflight.warnings, undefined);
  } finally {
    f.close();
  }
});
