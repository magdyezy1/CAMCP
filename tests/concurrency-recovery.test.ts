import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {removeTestDirectory} from './temp.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import type {Actor} from '../src/types.js';

/**
 * Everything else in this suite runs in one process, where Node's single thread and the
 * synchronous SQLite binding make genuine contention impossible to reproduce: two callers can
 * never interleave inside one transaction. These tests therefore spawn real processes against a
 * shared database file, which is the only way to exercise `BEGIN IMMEDIATE`, `busy_timeout`,
 * job leases and the spend reservation under the conditions a deployed worker actually meets.
 */

const run = promisify(execFile);
const key = Buffer.alloc(32, 71).toString('base64');
const actor: Actor = {tenantId: 'concurrency', userId: 'operator', role: 'admin'};
const dist = new URL('../src/', import.meta.url).href;

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'amcp-concurrency-'));
  return {
    directory,
    database: join(directory, 'mirror.sqlite'),
    cleanup: () => removeTestDirectory(directory, 'amcp-concurrency-'),
  };
}

/** Runs `body` in `count` separate processes at once and returns what each printed. */
async function race(directory: string, count: number, body: string) {
  const worker = join(directory, 'worker.mjs');
  writeFileSync(
    worker,
    `
import {Store} from ${JSON.stringify(dist + 'store.js')};
import {checkSpendPolicy} from ${JSON.stringify(dist + 'spend-policy.js')};
const [,,database,key,index]=process.argv;
const actor={tenantId:${JSON.stringify(actor.tenantId)},userId:'operator',role:'admin'};
const say=v=>process.stdout.write(JSON.stringify(v));
let store;
try{store=new Store(database,key);${body}}
catch(e){say({error:e&&e.code||String(e&&e.message||e)});}
finally{try{store&&store.close();}catch{}}
`,
  );
  const results = await Promise.all(
    Array.from({length: count}, (_, i) =>
      run(process.execPath, [worker, directory + '/mirror.sqlite', key, String(i)], {timeout: 30000})
        .then(r => JSON.parse(r.stdout || '{}'))
        .catch(e => ({error: 'spawn:' + (e.code ?? e.message)})),
    ),
  );
  return results as Record<string, unknown>[];
}

test('concurrent processes opening the same new database all bootstrap successfully', async () => {
  const w = workspace();
  try {
    // The journal-mode switch is the documented race here: SQLite can skip its busy handler when
    // two processes change it at once, which the store retries deliberately.
    const results = await race(w.directory, 6, `say({ok:store.listTenants().length>=0});`);
    assert.equal(results.filter(r => r.ok === true).length, 6, JSON.stringify(results));
  } finally {
    w.cleanup();
  }
});

test('one idempotency key claimed by many processes admits exactly one writer', async () => {
  const w = workspace();
  try {
    const store = new Store(w.database, key);
    store.ensureTenant(actor.tenantId);
    store.close();
    const results = await race(w.directory, 6, `say(store.claim(actor.tenantId,'shared-key','fingerprint'));`);
    assert.equal(
      results.filter(r => r.fresh === true).length,
      1,
      'exactly one process may execute: ' + JSON.stringify(results),
    );
    // Everyone else is refused, and never told the write is safe to repeat.
    for (const r of results.filter(r => r.fresh !== true))
      assert.ok(['WRITE_OUTCOME_UNCERTAIN', 'IDEMPOTENCY_CONFLICT'].includes(String(r.error)), JSON.stringify(r));
  } finally {
    w.cleanup();
  }
});

test('one queued job leased by many processes runs exactly once, and an expired lease is recovered', async () => {
  const w = workspace();
  try {
    const store = new Store(w.database, key);
    store.ensureTenant(actor.tenantId);
    store.enqueue(actor.tenantId, 'write_verification', {review_id: 'r1'});
    store.close();
    const results = await race(w.directory, 6, `const job=store.leaseJob();say({took:!!job,id:job&&job.id});`);
    const took = results.filter(r => r.took === true);
    assert.equal(took.length, 1, 'a job must not be leased twice: ' + JSON.stringify(results));

    // A worker that dies mid-job leaves the lease behind; the next sweep must return it to the
    // queue rather than stranding the work.
    const after = new Store(w.database, key);
    try {
      after.db.prepare('UPDATE jobs SET lease_until=? WHERE id=?').run(Date.now() - 1, String(took[0]!.id));
      const recovered = after.leaseJob();
      assert.equal(String(recovered?.id), String(took[0]!.id), 'an expired lease must be reclaimable');
      assert.equal(recovered?.attempts, 2, 'the retry must be counted, not hidden');
    } finally {
      after.close();
    }
  } finally {
    w.cleanup();
  }
});

test('the daily spend cap holds when many processes reserve against it at once', async () => {
  const w = workspace();
  try {
    const store = new Store(w.database, key);
    store.putConnection(
      actor,
      {
        id: 'meta_native_action',
        tenantId: actor.tenantId,
        gateway: 'meta_native_action',
        accounts: ['123'],
        writeAccounts: ['123'],
        label: 'Fixture',
        enabled: true,
        scopes: [],
      },
      {accessToken: 'fixture'},
    );
    // Cap 100; eight processes each request 40. At most two can be admitted.
    saveSpendPolicy(store, actor, {
      gateway: 'meta_native_action',
      account_id: '123',
      confirmed: true,
      policy: {max_daily_increase_native: 100},
    });
    store.close();

    const results = await race(
      w.directory,
      8,
      `
   const plan={gateway:'meta_native_action',accountId:'123',action:'meta_adset_update',method:'POST',path:'/v25.0/456',query:{},body:{daily_budget:140},headers:{},readOnly:false,destructive:false,requiresConfirmation:true,evidence:'fixture',warnings:[]};
   say(checkSpendPolicy(store,actor,plan,[{daily_budget:100}],'reserve-'+index));`,
    );

    const admitted = results.filter(r => r.configured === true);
    const refused = results.filter(r => r.error === 'POLICY_DAILY_INCREASE_LIMIT');
    assert.equal(admitted.length + refused.length, 8, 'every process must resolve: ' + JSON.stringify(results));
    assert.ok(
      admitted.length <= 2,
      'the cap was oversubscribed: ' + admitted.length + ' admitted at 40 each against a limit of 100',
    );
    assert.ok(admitted.length >= 1, 'contention must not deadlock every writer');

    // The ledger must agree with what was admitted: no lost or double-counted reservations.
    const store2 = new Store(w.database, key);
    try {
      const total = Number(
        (
          store2.db
            .prepare(
              "SELECT coalesce(sum(json_extract(data,'$.increase_native')),0) AS total FROM documents WHERE tenant_id=? AND kind='spend_reservation'",
            )
            .get(actor.tenantId) as {total: number}
        ).total,
      );
      assert.equal(total, admitted.length * 40, 'reserved total must match admitted writers');
      assert.ok(total <= 100, 'reservations exceeded the owner cap');
    } finally {
      store2.close();
    }
  } finally {
    w.cleanup();
  }
});
