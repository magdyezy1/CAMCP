import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {gateway, budgetName, googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {MirrorError} from '../dist/src/errors.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';

/**
 * R2.5 M2 (L5-05, L3-13; owner 2026-11-15: "fail closed on uncertain writes, then reconcile them automatically"). A write
 * that ends uncertain gets a worker job, at its claim time plus 60 seconds, that runs today's read-only reconciliation and
 * stores what it found, so `status` and the website show it. The job reads only. It never changes the review's outcome:
 * a person accepts "applied" or prepares a new review, as before.
 */
before(() => {
  // The two rounds of one reconciliation are 2 s apart in production.
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

const kind = 'write_reconcile';
const status = (f, id, who = f.actor) => f.call('amcp_write', {action: 'status', review_id: id}, who);
const jobs = f =>
  f.store.db
    .prepare(
      'SELECT id,state,available_at,attempts,input,error,result FROM jobs WHERE tenant_id=? AND kind=? ORDER BY created_at',
    )
    .all(f.actor.tenantId, kind)
    .map(row => ({...row, input: JSON.parse(row.input)}));
const claimedAt = (f, id) =>
  f.store.db.prepare('SELECT created_at FROM idempotency WHERE tenant_id=? AND key=?').get(f.actor.tenantId, id)
    .created_at;
/** The worker the server runs, over the fixture's own service. */
const workerOf = f => {
  const overview = new ReportingOverview(f.service);
  return new ReportWorker(
    f.store,
    async () => ({}),
    (tenant, jobKind, input) => overview.work(tenant, jobKind, input),
  );
};
/** Makes the queued reconciliation due now, and runs one worker turn. */
async function runDue(f, worker) {
  f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind=? AND state='queued'").run(kind);
  return worker.once();
}
/**
 * A one-budget create whose response is lost. `applied`: Google created the budget before the response was lost; the
 * created budget is named budgetName(101).
 */
async function uncertainCreate(f, {applied, who} = {}) {
  const prepared = who
    ? await f.call(
        'amcp_write',
        {
          action: 'prepare',
          gateway,
          connection_id: 'g',
          arguments: {
            action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
            account_id: '123',
            payload: {
              operations: [{create: {name: 'Synthetic 0', amountMicros: '50000000', deliveryMethod: 'STANDARD'}}],
            },
          },
        },
        who,
      )
    : await f.creates(1, 50000000);
  assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 400));
  const id = prepared.data.review_id;
  f.hooks.respond = body => {
    if (applied) {
      f.budgets.set(budgetName(101), String(body.operations[0].create.amountMicros));
      f.names.set(budgetName(101), body.operations[0].create.name);
    }
    throw new TypeError('synthetic lost response');
  };
  const refused = who
    ? await f.call('amcp_write', {action: 'execute', review_id: id, confirmed: true, spend_change_confirmed: true}, who)
    : await f.execute(id);
  f.hooks.respond = undefined;
  assert.equal(refused.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(refused).slice(0, 400));
  return id;
}

test('a write that ends uncertain queues one reconcile job for its claim time plus 60 seconds; settled writes queue none', async () => {
  const f = googleBudgetFixture();
  try {
    const id = await uncertainCreate(f, {applied: true});
    const queued = jobs(f);
    assert.equal(queued.length, 1, 'one job for the one uncertain write');
    const [job] = queued;
    assert.equal(job.state, 'queued');
    assert.equal(job.input.review_id, id);
    assert.equal(job.available_at, claimedAt(f, id) + 60000);

    // A write that completed, one the provider refused without applying it (rejected) and one refused before it was
    // sent each leave the queue as it was: only an uncertain claim is reconciled.
    const done = (await f.creates(1, 60000000)).data.review_id;
    assert.equal((await f.execute(done)).success, true);
    const refused = (await f.creates(1, 70000000)).data.review_id;
    f.hooks.respond = () =>
      Response.json(
        {error: {code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT'}},
        {status: 400},
      );
    assert.equal((await f.execute(refused)).error.details.submission, 'rejected');
    f.hooks.respond = undefined;
    const unsent = (await f.creates(1, 80000000)).data.review_id;
    f.store.db
      .prepare(
        "UPDATE documents SET data=json_set(data,'$.expires_at',?) WHERE tenant_id=? AND kind='write_review' AND id=?",
      )
      .run(Date.now() - 1000, f.actor.tenantId, unsent);
    assert.equal((await f.execute(unsent)).error.code, 'REVIEW_EXPIRED');
    assert.equal(jobs(f).length, 1, 'completed, rejected and unsent writes queue no reconciliation');
  } finally {
    f.close();
  }
});

test('the job finds a create the provider applied, stores it for status, sends no write and leaves the outcome to the person', async () => {
  const f = googleBudgetFixture();
  try {
    const id = await uncertainCreate(f, {applied: true});
    const writes = f.writes.length,
      before = f.requests.length;
    assert.equal(await runDue(f, workerOf(f)), true, 'the worker leased the job');

    // Reads only: every request of the job is a search, and no mutation reached the provider.
    const sent = f.requests.slice(before);
    assert.ok(sent.length > 0, 'the job read the provider');
    assert.ok(
      sent.every(r => r.endsWith('/googleAds:search')),
      sent.join(', '),
    );
    assert.equal(f.writes.length, writes, 'the job never sends a write');
    assert.equal(jobs(f)[0].state, 'complete', 'a decided write ends its job');

    const s = await status(f, id);
    assert.equal(s.data.state, 'uncertain', 'the review is still uncertain: the job never decides it');
    assert.equal(f.claim(id).state, 'uncertain');
    assert.equal(s.data.reconciliation.classification, 'appears_applied');
    assert.equal(s.data.reconciliation.automatic, true);
    assert.equal(s.data.reconciliation.attempts, 1);
    assert.deepEqual(s.data.reconciliation.observed_ids, [budgetName(101)]);
    // The one call that settles it is the person's: accept, with the reconciliation they saw.
    assert.deepEqual(s.data.next_call, {
      tool: 'amcp_write',
      arguments: {action: 'reconcile', review_id: id, reconciliation_id: s.data.reconciliation.reconciliation_id},
      add_after_user_approval: {accept_applied: true},
    });
    assert.equal((await f.execute(id)).error.code, 'WRITE_OUTCOME_UNCERTAIN', 'never executed again');
    assert.ok(
      f.audit().some(e => e.event === 'write_reconciliation_inspected' && e.review_id === id && e.automatic === true),
    );

    const accepted = await f.write({
      action: 'reconcile',
      review_id: id,
      accept_applied: true,
      reconciliation_id: s.data.reconciliation.reconciliation_id,
    });
    assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 500));
    assert.equal(f.claim(id).state, 'complete');
    assert.equal(f.writes.length, writes, 'accepting records the observation and sends nothing');
  } finally {
    f.close();
  }
});

test('a create the provider never applied is reported absent, and a new review is left to the person', async () => {
  const f = googleBudgetFixture();
  try {
    const id = await uncertainCreate(f, {applied: false});
    const reviews = f.store.documents(f.actor.tenantId, 'write_review').length,
      claims = f.store.db.prepare('SELECT count(*) AS n FROM idempotency WHERE tenant_id=?').get(f.actor.tenantId).n;
    assert.equal(await runDue(f, workerOf(f)), true, 'the worker leased the job');
    const s = await status(f, id);
    assert.ok(s.data.reconciliation, 'status shows what the check found');
    assert.equal(s.data.reconciliation.classification, 'appears_not_applied');
    assert.equal(s.data.reconciliation.automatic, true);
    assert.equal(s.data.state, 'uncertain');
    assert.equal(s.data.next_call.arguments.action, 'prepare');
    assert.equal(s.data.next_call.arguments.supersedes_review_id, id);
    // Nothing was prepared, claimed or sent on the person's behalf.
    assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, reviews);
    assert.equal(
      f.store.db.prepare('SELECT count(*) AS n FROM idempotency WHERE tenant_id=?').get(f.actor.tenantId).n,
      claims,
    );
    assert.equal(f.writes.length, 1);
    assert.equal(jobs(f)[0].state, 'complete');
  } finally {
    f.close();
  }
});

test('an unsettled check is rescheduled under a growing cooldown, and stops when its attempts run out', async () => {
  const f = googleBudgetFixture();
  try {
    const id = await uncertainCreate(f, {applied: true});
    // The provider cannot be read: the transport refuses every read, as it does during an outage.
    const request = f.transport.request.bind(f.transport);
    let outage = true;
    f.transport.request = async (plan, ...rest) => {
      if (outage && plan.readOnly) throw new MirrorError('UPSTREAM_UNAVAILABLE', 'Synthetic outage.', {}, 502, true);
      return request(plan, ...rest);
    };
    const worker = workerOf(f);
    const minutes = [2, 5, 10, 20, 30];
    for (const [i, wait] of minutes.entries()) {
      assert.equal(await runDue(f, worker), true);
      const [job] = jobs(f);
      assert.equal(job.state, 'queued', 'attempt ' + (i + 1) + ' is unsettled, so the job is queued again');
      const left = job.available_at - Date.now();
      assert.ok(left > wait * 60000 - 5000 && left <= wait * 60000, 'cooldown after attempt ' + (i + 1) + ': ' + left);
      const shown = (await status(f, id)).data.reconciliation;
      assert.equal(shown.classification, 'indeterminate');
      assert.equal(shown.reason, 'read_failed');
      assert.equal(shown.attempts, i + 1);
      assert.equal(typeof shown.next_check_at, 'string', 'status says when AMCP looks again');
    }
    // The sixth and last attempt: still unsettled, so the checks stop and say so.
    assert.equal(await runDue(f, worker), true);
    assert.equal(jobs(f).length, 1);
    assert.equal(jobs(f)[0].state, 'complete');
    const last = (await status(f, id)).data;
    assert.equal(last.reconciliation.attempts, 6);
    assert.equal(last.reconciliation.checks_exhausted, true);
    assert.equal(last.reconciliation.next_check_at, undefined);
    assert.deepEqual(last.next_call, {tool: 'amcp_write', arguments: {action: 'reconcile', review_id: id}});
    assert.equal(await runDue(f, worker), false, 'no seventh attempt');
    assert.equal(f.writes.length, 1);

    // The person can still settle it by hand once the provider answers again.
    outage = false;
    process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
    try {
      const manual = await f.write({action: 'reconcile', review_id: id});
      assert.equal(manual.data.classification, 'appears_applied', JSON.stringify(manual).slice(0, 400));
    } finally {
      delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
    }
  } finally {
    f.close();
  }
});

test('a check that a person already settled, or that the review no longer needs, reads nothing', async () => {
  const f = googleBudgetFixture();
  try {
    const accepted = await uncertainCreate(f, {applied: true});
    assert.equal(await runDue(f, workerOf(f)), true, 'the worker leased the job');
    const seen = (await status(f, accepted)).data.reconciliation;
    assert.ok(seen, 'status shows what the check found');
    // The person accepts; a later turn of the job (queued again by a lease expiry, say) has nothing to check.
    await f.write({
      action: 'reconcile',
      review_id: accepted,
      accept_applied: true,
      reconciliation_id: seen.reconciliation_id,
    });
    f.store.db.prepare("UPDATE jobs SET state='queued',available_at=0,lease_token=NULL,lease_until=NULL").run();
    const before = f.requests.length;
    assert.equal(await workerOf(f).once(), true);
    assert.equal(f.requests.length, before, 'an accepted write is not read again');
    assert.equal(jobs(f)[0].state, 'complete');
  } finally {
    f.close();
  }
});

test('a decisive check the person made first is not replaced by the job: the reconciliation they hold stays acceptable', async () => {
  const f = googleBudgetFixture();
  try {
    const id = await uncertainCreate(f, {applied: true});
    process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
    let manual;
    try {
      manual = await f.write({action: 'reconcile', review_id: id});
    } finally {
      delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
    }
    assert.equal(manual.data.classification, 'appears_applied', JSON.stringify(manual).slice(0, 400));
    const before = f.requests.length;
    assert.equal(await runDue(f, workerOf(f)), true);
    assert.equal(f.requests.length, before, 'the job reads nothing: the person already has a fresh answer');
    assert.equal(jobs(f)[0].state, 'complete');
    const shown = (await status(f, id)).data.reconciliation;
    assert.equal(shown.reconciliation_id, manual.data.reconciliation_id, 'the id the person saw is still the latest');
    assert.equal(shown.automatic, undefined);
    const accepted = await f.write({
      action: 'reconcile',
      review_id: id,
      accept_applied: true,
      reconciliation_id: manual.data.reconciliation_id,
    });
    assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 400));
  } finally {
    f.close();
  }
});

test('the job runs as the person who executed: when their access is gone it reads nothing and says why', async () => {
  const f = googleBudgetFixture();
  try {
    f.store.db.exec(
      'CREATE TABLE IF NOT EXISTS amcp_users(id TEXT PRIMARY KEY,version INTEGER,approved INTEGER,disabled INTEGER)',
    );
    f.store.db.prepare('INSERT INTO amcp_users VALUES(?,1,1,0)').run('person-1');
    f.store.db
      .prepare('INSERT INTO workspace_memberships VALUES(?,?,?,?,?)')
      .run(f.actor.tenantId, 'person-1', 'admin', 1, Date.now());
    const person = {tenantId: f.actor.tenantId, userId: 'person-key', role: 'admin', ownerUserId: 'person-1'};
    const id = await uncertainCreate(f, {applied: true, who: person});
    f.store.db.prepare('UPDATE amcp_users SET disabled=1 WHERE id=?').run('person-1');
    const before = f.requests.length;
    assert.equal(await runDue(f, workerOf(f)), true);
    assert.equal(f.requests.length, before, 'no provider request after the person lost access');
    assert.notEqual(jobs(f)[0].state, 'queued', 'a lost authority is not retried');
    // Another administrator reads what happened; the person's own access is not needed for that.
    f.store.db.prepare("UPDATE amcp_users SET disabled=0 WHERE id='person-1'").run();
    const s = await status(f, id, person);
    assert.equal(s.data.reconciliation.classification, 'indeterminate');
    assert.equal(s.data.reconciliation.reason, 'access_lost');
    assert.equal(s.data.reconciliation.automatic, true);
    assert.equal(s.data.reconciliation.next_check_at, undefined);
  } finally {
    f.close();
  }
});

test('a stopped check never overwrites a decisive one that already exists', async () => {
  const f = googleBudgetFixture();
  try {
    f.store.db.exec(
      'CREATE TABLE IF NOT EXISTS amcp_users(id TEXT PRIMARY KEY,version INTEGER,approved INTEGER,disabled INTEGER)',
    );
    f.store.db.prepare('INSERT INTO amcp_users VALUES(?,1,1,0)').run('person-2');
    f.store.db
      .prepare('INSERT INTO workspace_memberships VALUES(?,?,?,?,?)')
      .run(f.actor.tenantId, 'person-2', 'admin', 1, Date.now());
    const person = {tenantId: f.actor.tenantId, userId: 'person-key-2', role: 'admin', ownerUserId: 'person-2'};
    const id = await uncertainCreate(f, {applied: true, who: person});
    process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
    let manual;
    try {
      manual = await f.call('amcp_write', {action: 'reconcile', review_id: id}, person);
    } finally {
      delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
    }
    assert.equal(manual.data.classification, 'appears_applied', JSON.stringify(manual).slice(0, 400));
    f.store.db.prepare('UPDATE amcp_users SET disabled=1 WHERE id=?').run('person-2');
    assert.equal(await runDue(f, workerOf(f)), true);
    f.store.db.prepare("UPDATE amcp_users SET disabled=0 WHERE id='person-2'").run();
    const shown = (await status(f, id, person)).data.reconciliation;
    assert.equal(shown.classification, 'appears_applied');
    assert.equal(shown.reconciliation_id, manual.data.reconciliation_id);
  } finally {
    f.close();
  }
});

test('a worker that is stopping returns a running reconcile job to the queue at once, without using up its attempt', async () => {
  const f = googleBudgetFixture();
  try {
    await uncertainCreate(f, {applied: true});
    let open;
    const gate = new Promise(resolve => (open = resolve));
    f.hooks.duringRead = () => gate;
    const worker = workerOf(f);
    f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind=? AND state='queued'").run(kind);
    const running = worker.once();
    // The job only reads from providers, so a shutdown releases it instead of waiting for it.
    assert.deepEqual(worker.drain(), {released: [kind], settling: []});
    assert.equal(jobs(f)[0].state, 'queued');
    assert.equal(jobs(f)[0].attempts, 0);
    open();
    await running;
  } finally {
    f.close();
  }
});

test('the operations feed shows what the automatic check found beside the write it belongs to', async () => {
  const f = googleBudgetFixture();
  try {
    const id = await uncertainCreate(f, {applied: true});
    const feed = async () =>
      (await f.call('amcp_workspace', {action: 'operations', kind: 'write', limit: 100})).data.operations.find(
        o => o.id === id,
      );
    assert.equal((await feed()).reconciliation, undefined, 'nothing is shown before the first check');
    await runDue(f, workerOf(f));
    const row = await feed();
    assert.equal(row.state, 'uncertain');
    assert.deepEqual(row.reconciliation, {classification: 'appears_applied', automatic: true});
  } finally {
    f.close();
  }
});
