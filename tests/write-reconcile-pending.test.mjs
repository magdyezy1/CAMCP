import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {gateway, budgetName, googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {scopeKey} from '../dist/src/security.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';

/**
 * R2.5 M2, lead review S3-4: a write that a crash or a deploy left `pending` never got the reconcile job, which was queued only
 * in the uncertain catch of the executing process. Status calls such a claim uncertain after ten minutes and `reconcile` accepts
 * it, but nothing queued the check, and every push redeploys production. The executor's authority exists only in the executing
 * process, so the watch is queued with the claim: due when the claim would count as uncertain, dropped the moment the write
 * settles, and moved up to claim + 60 s when the write ends uncertain.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

const kind = 'write_reconcile',
  tenMinutes = 10 * 60000;
const jobs = f =>
  f.store.db
    .prepare('SELECT id,state,available_at,input FROM jobs WHERE tenant_id=? AND kind=? ORDER BY created_at')
    .all(f.actor.tenantId, kind)
    .map(row => ({...row, input: JSON.parse(row.input)}));
const claim = (f, id) =>
  f.store.db.prepare('SELECT state,created_at FROM idempotency WHERE tenant_id=? AND key=?').get(f.actor.tenantId, id);
const workerOf = f => {
  const overview = new ReportingOverview(f.service);
  return new ReportWorker(
    f.store,
    async () => ({}),
    (tenant, jobKind, input) => overview.work(tenant, jobKind, input),
  );
};
const until = async (condition, what) => {
  for (let i = 0; i < 300 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(condition(), what);
};
/**
 * Executes a one-budget create whose request is still in flight: the provider has applied it (or not) and has not answered.
 * `end.complete()` lets the answer arrive; `end.die()` makes the transport fail as a lost connection does.
 */
async function inFlight(f, {applied = true} = {}) {
  const prepared = await f.creates(1, 50000000);
  assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 400));
  const id = prepared.data.review_id,
    end = {};
  f.hooks.respond = body => {
    if (applied) {
      f.budgets.set(budgetName(101), String(body.operations[0].create.amountMicros));
      f.names.set(budgetName(101), body.operations[0].create.name);
    }
    return new Promise((resolve, reject) => {
      end.complete = () => resolve(undefined);
      end.die = () => reject(new TypeError('synthetic lost connection'));
    });
  };
  const running = f.execute(id);
  await until(() => f.writes.length === 1 && claim(f, id)?.state === 'pending', 'the request is in flight');
  f.hooks.respond = undefined;
  return {id, end, running};
}

test('a write in flight is watched from its claim: one reconcile job, due when the claim would count as uncertain, dropped when the write settles', async () => {
  const f = googleBudgetFixture();
  try {
    const {id, end, running} = await inFlight(f);
    const watch = jobs(f);
    assert.equal(watch.length, 1, 'the claim queued one job');
    assert.equal(watch[0].state, 'queued');
    assert.equal(watch[0].input.review_id, id);
    assert.equal(
      watch[0].available_at,
      claim(f, id).created_at + tenMinutes,
      'due at claim + 10 minutes, when status already calls the pending claim uncertain',
    );
    assert.equal(await workerOf(f).once(), false, 'nothing is due while the write is young');

    // The answer arrives: the write completed, so nothing is left to check.
    end.complete();
    const done = await running;
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 300));
    assert.equal(jobs(f).length, 0, 'a settled write leaves no job behind');
  } finally {
    f.close();
  }
});

test('a write left pending by a crash is checked once its claim is ten minutes old, by reads only', async () => {
  const f = googleBudgetFixture();
  try {
    const {id, end, running} = await inFlight(f, {applied: true});
    const before = f.requests.length,
      sent = f.writes.length;
    // The process stops here: no catch ever runs. Ten and a bit minutes later the worker's turn comes.
    const aged = tenMinutes + 60000;
    f.store.db
      .prepare('UPDATE idempotency SET created_at=created_at-? WHERE tenant_id=? AND key=?')
      .run(aged, f.actor.tenantId, id);
    f.store.db.prepare("UPDATE jobs SET available_at=available_at-? WHERE kind='write_reconcile'").run(aged);
    const worker = workerOf(f);
    assert.equal(await worker.once(), true, 'the worker leased the watch');

    const reads = f.requests.slice(before);
    assert.ok(reads.length > 0, 'it read the provider');
    assert.ok(
      reads.every(r => r.endsWith('/googleAds:search')),
      reads.join(', '),
    );
    assert.equal(f.writes.length, sent, 'it sent no write');
    const status = await f.call('amcp_write', {action: 'status', review_id: id});
    assert.equal(status.data.reconciliation.classification, 'appears_applied', JSON.stringify(status.data));
    assert.equal(status.data.reconciliation.automatic, true);
    assert.equal(jobs(f)[0].state, 'complete', 'a decided write ends its job');
    assert.equal(claim(f, id).state, 'pending', 'the claim itself is the person’s to settle: accept_applied');

    // The process was not dead after all and the connection failed: the write ends uncertain as it always did.
    end.die();
    const lost = await running;
    assert.equal(lost.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(lost).slice(0, 300));
  } finally {
    f.close();
  }
});

test('a check that cannot be queued is audited (lead review S4-4), and what the caller is told does not change', async () => {
  const f = googleBudgetFixture();
  try {
    const id = (await f.creates(1, 50000000)).data.review_id;
    f.hooks.respond = () => {
      // The queue fails once the write was sent: nothing is waiting for the claim and nothing more can be queued.
      f.store.db.prepare("DELETE FROM jobs WHERE kind='write_reconcile'").run();
      f.store.enqueue = () => {
        throw new Error('synthetic queue failure');
      };
      throw new TypeError('synthetic lost response');
    };
    const lost = await f.execute(id);
    assert.equal(lost.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(lost).slice(0, 300));
    assert.equal(claim(f, id).state, 'uncertain');
    const event = f.audit().find(e => e.event === 'write_reconcile_not_queued');
    assert.ok(event, 'the audit says the automatic check was not queued');
    assert.equal(event.code, 'INTERNAL_ERROR');
    assert.equal(event.gateway, 'google_ads_native_action');
    assert.equal(jobs(f).length, 0);
  } finally {
    f.close();
  }
});

test('a write that ends uncertain moves its watch up to claim + 60 seconds, and a write that is not sent leaves none', async () => {
  const f = googleBudgetFixture();
  try {
    const {id, end, running} = await inFlight(f);
    end.die();
    const lost = await running;
    assert.equal(lost.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(lost).slice(0, 300));
    const watch = jobs(f);
    assert.equal(watch.length, 1, 'one job, not two');
    assert.equal(watch[0].available_at, claim(f, id).created_at + 60000);

    // Refused after its claim and before it was sent (a provider cooldown met while it waited for admission): the claim is
    // released and the watch goes with it.
    const unsent = (await f.creates(1, 80000000)).data.review_id;
    let watched;
    f.hooks.duringPermit = () => {
      watched = jobs(f).length;
      f.transport.cooldowns.set(scopeKey(f.actor.tenantId, gateway), performance.now() + 60000);
    };
    assert.equal((await f.execute(unsent)).error.code, 'PLATFORM_RATE_LIMIT');
    f.transport.cooldowns.clear();
    assert.equal(watched, 2, 'the watch was there while the write waited for admission');
    assert.equal(claim(f, unsent), undefined, 'the claim was released');
    assert.equal(jobs(f).length, 1, 'only the uncertain write has a job');

    // Refused by the provider without being applied: rejected, and the watch goes too.
    const refused = (await f.creates(1, 70000000)).data.review_id;
    f.hooks.respond = () =>
      Response.json(
        {error: {code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT'}},
        {status: 400},
      );
    assert.equal((await f.execute(refused)).error.details.submission, 'rejected');
    f.hooks.respond = undefined;
    assert.equal(jobs(f).length, 1, 'a rejected write has none either');
  } finally {
    f.close();
  }
});
