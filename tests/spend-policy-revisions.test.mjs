import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {saveSpendPolicy, spendPolicyKey} from '../dist/src/spend-policy.js';

/**
 * WRT-03, server side (owner decision D9): save_spend_policy takes the revision the caller read. A stale one is
 * refused with REVISION_CONFLICT (409) and nothing is saved; 0 means "there was no policy". The website always sends
 * it; an MCP caller may omit it and is told when its save replaced a stored policy unchecked. Before, every save was
 * last-writer-wins, so two owner edits silently overwrote each other.
 */
const owner = {tenantId: 'policy-revisions', userId: 'owner', role: 'admin'},
  gateway = 'google_ads_native_action';
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 33).toString('base64'));
  for (const [id, g, accounts] of [
    ['g', gateway, ['123-456-7890']],
    ['m', 'meta_native_action', ['act_555']],
  ])
    store.putConnection(
      owner,
      {
        id,
        tenantId: owner.tenantId,
        gateway: g,
        accounts,
        writeAccounts: accounts,
        enabled: true,
        label: id,
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
  const save = (policy, extra = {}) =>
    saveSpendPolicy(store, owner, {
      gateway,
      account_id: '123-456-7890',
      connection_id: 'g',
      confirmed: true,
      policy,
      ...extra,
    });
  const audits = () =>
    store.db
      .prepare("SELECT count(*) AS n FROM audit WHERE tenant_id=? AND request_id LIKE 'policy/%'")
      .get(owner.tenantId)?.n;
  return {store, save, audits, id: spendPolicyKey(gateway, '123-456-7890')};
}
const refused = (fn, code) => assert.throws(fn, e => e.code === code, code);

test('a stale expected_revision is refused with 409 and nothing is saved; the current one saves the next revision', () => {
  const f = fixture();
  try {
    const first = f.save({enforcement: 'block', max_budget_currency: 100}, {expected_revision: 0});
    assert.equal(first.revision, 1);
    assert.equal(first.warnings, undefined);
    const second = f.save({enforcement: 'block', max_budget_currency: 80}, {expected_revision: 1});
    assert.equal(second.revision, 2);
    const before = f.store.document(owner.tenantId, 'spend_policy', f.id);
    let error;
    try {
      f.save({enforcement: 'confirm'}, {expected_revision: 1});
    } catch (e) {
      error = e;
    }
    assert.equal(error?.code, 'REVISION_CONFLICT');
    assert.equal(error?.status, 409);
    assert.deepEqual(f.store.document(owner.tenantId, 'spend_policy', f.id), before);
    assert.equal(f.audits(), 2, 'a refused save records no saved event');
    // 0 says there was no policy: refused once one exists.
    refused(() => f.save({enforcement: 'confirm'}, {expected_revision: 0}), 'REVISION_CONFLICT');
    assert.equal(f.store.document(owner.tenantId, 'spend_policy', f.id).enforcement, 'block');
  } finally {
    f.store.close();
  }
});

test('without expected_revision an MCP save still succeeds and says it replaced the stored policy unchecked', () => {
  const f = fixture();
  try {
    const created = f.save({max_bid_currency: 5});
    assert.equal(created.revision, 1);
    assert.equal(created.warnings, undefined, 'nothing was replaced');
    const replaced = f.save({max_bid_currency: 4});
    assert.equal(replaced.revision, 2);
    assert.deepEqual(
      replaced.warnings.map(w => [w.code, w.replaced_revision]),
      [['REVISION_NOT_CHECKED', 1]],
    );
    assert.equal(f.audits(), 2);
  } finally {
    f.store.close();
  }
});

test('expected_revision must be a non-negative integer', () => {
  const f = fixture();
  try {
    for (const bad of [-1, 1.5, '1', null]) refused(() => f.save({}, {expected_revision: bad}), 'INVALID_POLICY');
  } finally {
    f.store.close();
  }
});

test('the workspace default takes the same revision check', () => {
  const f = fixture(),
    save = extra =>
      saveSpendPolicy(f.store, owner, {
        scope: 'workspace',
        confirmed: true,
        policy: {enforcement: 'block', per_gateway: {[gateway]: {max_budget_currency: 50}}},
        ...extra,
      });
  try {
    assert.equal(save({expected_revision: 0}).revision, 1);
    refused(() => save({expected_revision: 0}), 'REVISION_CONFLICT');
    assert.equal(save({expected_revision: 1}).revision, 2);
    assert.equal(save({}).warnings.at(-1).code, 'REVISION_NOT_CHECKED');
  } finally {
    f.store.close();
  }
});

test('amcp_workspace accepts expected_revision, and owner health names the policy of each account by its server key', async () => {
  const f = fixture(),
    service = new MirrorService(new Registry(), f.store);
  try {
    const call = input => service.call('amcp_workspace', input, owner);
    const saved = await call({
      action: 'save_spend_policy',
      gateway: 'meta_native_action',
      connection_id: 'm',
      account_id: 'act_555',
      policy: {allow_deletion: false},
      expected_revision: 0,
      confirmed: true,
    });
    assert.equal(saved.success, true, JSON.stringify(saved));
    const stale = await call({
      action: 'save_spend_policy',
      gateway: 'meta_native_action',
      connection_id: 'm',
      account_id: '555',
      policy: {allow_deletion: true},
      expected_revision: 0,
      confirmed: true,
    });
    assert.equal(stale.error?.code, 'REVISION_CONFLICT', JSON.stringify(stale));
    const health = await call({action: 'health'});
    assert.equal(health.success, true, JSON.stringify(health).slice(0, 400));
    // The Meta account is listed as act_555 but stored under its normalized key: the binding resolves it.
    const binding = health.data.spend_policy_bindings.find(b => b.account_id === 'act_555');
    assert.deepEqual(binding, {
      gateway: 'meta_native_action',
      connection_id: 'm',
      account_id: 'act_555',
      policy_id: spendPolicyKey('meta_native_action', '555'),
    });
    const policy = health.data.policies.find(p => p.id === binding.policy_id);
    assert.equal(policy.allow_deletion, false);
    assert.equal(policy.revision, 1);
  } finally {
    f.store.close();
  }
});
