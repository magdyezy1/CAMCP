import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rollbackFixture} from './helpers/rollback-fixture.mjs';
import {reportPlatforms} from '../dist/src/report-metrics.js';

// r25-mf-jobs item 5: opening the Reports page (bootstrap) scanned every retained snapshot once for each Snapchat
// account, to offer each its parent campaigns. The scan is the same for every account, so it is made once per page load,
// and not at all by a page with no Snapchat account. The probe counts the statements that read retained snapshots.
const accounts = ['100', '200', '300'];

function readProbe(store) {
  const db = store.sql(),
    prepare = db.prepare.bind(db),
    probe = {watching: false, snapshotReads: 0};
  db.prepare = sql => {
    const statement = prepare(sql);
    return new Proxy(statement, {
      get(target, name) {
        const member = target[name];
        if (typeof member !== 'function') return member;
        return (...args) => {
          if (probe.watching && ['all', 'get', 'iterate'].includes(name) && /overview_report/.test(String(sql)))
            probe.snapshotReads++;
          return member.apply(target, args);
        };
      },
    });
  };
  return probe;
}

function fixture(t, {snapchatAccounts = accounts} = {}) {
  const f = rollbackFixture(t, {platforms: []});
  if (snapchatAccounts.length)
    f.store.putConnection(
      f.actor,
      {
        id: 'login-snapchat',
        tenantId: f.actor.tenantId,
        gateway: reportPlatforms.snapchat.gateway,
        accounts: snapchatAccounts,
        enabled: true,
        scopes: [],
        label: 'Synthetic snapchat',
      },
      {accessToken: 'synthetic'},
    );
  // Each account has its own finished snapshot with two campaigns; older ones and unrelated ones surround them.
  const ids = {};
  let clock = 1_700_000_000_000;
  const snapshot = (accountList, name) => {
    const id = randomUUID();
    f.store.putDocument(f.actor.tenantId, 'overview_report', id, {
      state: 'complete',
      completed_at: ++clock,
      created_at: clock,
      config: {
        name,
        sources: accountList.map(account => ({
          platform: 'snapchat',
          connection_id: 'login-snapchat',
          account_id: account,
          level: 'campaign',
        })),
      },
      rows: accountList.flatMap(account =>
        [1, 2].map(n => ({
          platform: 'snapchat',
          connection_id: 'login-snapchat',
          account_id: account,
          campaign_id: randomUUID(),
          campaign_name: name + ' campaign ' + n,
        })),
      ),
    });
    return id;
  };
  for (const account of accounts) ids[account] = snapshot([account], 'Account ' + account);
  for (let i = 0; i < 20; i++) snapshot([], 'Unrelated ' + i);
  return {f, ids};
}

test('the Reports page reads the retained snapshots once, however many Snapchat accounts it lists', async t => {
  const {f, ids} = fixture(t),
    probe = readProbe(f.store);
  probe.watching = true;
  const page = await f.handle({action: 'bootstrap'});
  probe.watching = false;
  t.diagnostic('the page read retained snapshots ' + probe.snapshotReads + ' times');
  const listed = page.platforms.find(p => p.id === 'snapchat').accounts;
  assert.deepEqual(listed.map(a => a.account_id).sort(), accounts);
  for (const account of listed) {
    assert.equal(account.parent_campaigns.snapshot_id, ids[account.account_id], 'its own newest snapshot');
    assert.deepEqual(account.parent_campaigns.campaigns.map(c => c.name).sort(), [
      'Account ' + account.account_id + ' campaign 1',
      'Account ' + account.account_id + ' campaign 2',
    ]);
  }
  // One scan of the retained snapshots; the campaigns of the chosen snapshot are then read by its id, once per account.
  assert.equal(probe.snapshotReads, 1);
});

test('a page with no Snapchat account reads no retained snapshot, and an account with none offers no parents', async t => {
  const none = fixture(t, {snapchatAccounts: []}),
    probe = readProbe(none.f.store);
  probe.watching = true;
  const page = await none.f.handle({action: 'bootstrap'});
  probe.watching = false;
  assert.equal(probe.snapshotReads, 0);
  assert.deepEqual(page.platforms.find(p => p.id === 'snapchat').accounts, []);
  // An account no retained snapshot names: still null, as before.
  const {f} = fixture(t, {snapchatAccounts: [...accounts, '400']});
  const listed = (await f.handle({action: 'bootstrap'})).platforms.find(p => p.id === 'snapchat').accounts;
  assert.equal(listed.find(a => a.account_id === '400').parent_campaigns, null);
  assert.ok(listed.find(a => a.account_id === '100').parent_campaigns);
});
