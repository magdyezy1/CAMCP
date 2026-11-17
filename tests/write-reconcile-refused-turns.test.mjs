import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {budgetName, googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {tiktokReconcileFixture} from './helpers/tiktok-reconcile-fixture.mjs';
import {MirrorError} from '../dist/src/errors.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';

/**
 * R2.5 M2, lead re-review N6. (1) A cooldown, an open circuit, the tenant budget, the coordination limit or a provider quota refuses a read
 * before it is sent. Such a turn of the automatic check read nothing, so it is not an attempt: it was recorded as a failed read, used one of
 * the six attempts and was retried on the fixed ladder, so a block longer than about an hour used them all without a single read. It is now
 * rescheduled at the refusal's own retry_after_ms and costs nothing. A request that reached the provider (a provider's own 429, or a turn
 * that read before it was refused) still counts. (2) A check never replaces a decisive record that was written while it was reading.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
});

const kind = 'write_reconcile';
const jobs = f =>
  f.store.db
    .prepare('SELECT id,state,available_at,attempts,input FROM jobs WHERE tenant_id=? AND kind=? ORDER BY created_at')
    .all(f.actor.tenantId, kind);
const workerOf = f => {
  const overview = new ReportingOverview(f.service);
  return new ReportWorker(
    f.store,
    async () => ({}),
    (tenant, jobKind, input) => overview.work(tenant, jobKind, input),
  );
};
async function runDue(f, worker) {
  f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind=? AND state='queued'").run(kind);
  return worker.once();
}
const status = (f, id) => f.call('amcp_write', {action: 'status', review_id: id});
/** A budget create whose response was lost after Google made the budget. */
async function lostCreate(f) {
  const prepared = await f.creates(1, 50000000);
  f.hooks.respond = body => {
    f.budgets.set(budgetName(101), String(body.operations[0].create.amountMicros));
    f.names.set(budgetName(101), body.operations[0].create.name);
    throw new TypeError('synthetic lost response');
  };
  const lost = await f.execute(prepared.data.review_id);
  f.hooks.respond = undefined;
  assert.equal(lost.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(lost).slice(0, 300));
  return prepared.data.review_id;
}
/**
 * Makes the transport refuse the reads of the check. `dispatches`: whether the refusal comes after the request was dispatched (the
 * provider's own answer, as a provider's 429 is) or before it (AMCP's own gate). `passFirst`: how many reads pass first. The returned
 * state turns the refusal off (`on = false`) and counts what it refused.
 */
function refuseReads(f, {code, retryAfterMs = 90000, dispatches = false, passFirst = 0}) {
  const request = f.transport.request.bind(f.transport);
  let passed = 0;
  const state = {on: true, refused: 0};
  f.transport.request = async (plan, connection, credentials, upload, hooks = {}) => {
    if (!state.on || !plan.readOnly || passed++ < passFirst)
      return request(plan, connection, credentials, upload, hooks);
    state.refused++;
    hooks.beforeAttempt?.();
    if (dispatches) hooks.onDispatch?.();
    throw new MirrorError(code, 'Synthetic refusal.', {retry_after_ms: retryAfterMs}, 429, true);
  };
  return state;
}

for (const code of [
  'TENANT_RATE_LIMIT',
  'PLATFORM_RATE_LIMIT',
  'CIRCUIT_OPEN',
  'PROVIDER_COORDINATION_BUSY',
  'PROVIDER_QUOTA_SHARE_EXHAUSTED',
])
  test(
    'a check whose every read ' +
      code +
      ' refused before it was sent is no attempt, and looks again at its retry_after_ms',
    async () => {
      const f = googleBudgetFixture();
      try {
        const id = await lostCreate(f);
        const refusing = refuseReads(f, {code});
        const worker = workerOf(f),
          before = f.requests.length;
        // Eight turns, more than the six attempts there are: none of them read anything, so none of them is one.
        for (let turn = 1; turn <= 8; turn++) {
          assert.equal(await runDue(f, worker), true);
          const [job] = jobs(f);
          assert.equal(job.state, 'queued', 'turn ' + turn + ': still checking');
          assert.equal(job.attempts, 0, 'turn ' + turn + ': not counted');
          const left = job.available_at - Date.now();
          assert.ok(
            left > 85000 && left <= 90000,
            'turn ' + turn + ': the refusal’s own delay, not the ladder: ' + left,
          );
          const shown = (await status(f, id)).data.reconciliation;
          assert.equal(shown.classification, 'indeterminate');
          assert.equal(shown.reason, 'read_failed');
          assert.equal(shown.read_error, code);
          assert.equal(shown.attempts, 0, 'turn ' + turn + ': no attempt used');
          assert.equal(shown.checks_exhausted, undefined);
          assert.equal(typeof shown.next_check_at, 'string');
        }
        assert.equal(f.requests.length, before, 'nothing reached the provider');
        assert.equal(refusing.refused >= 8, true);
        // Once the block lifts, the first read is the first attempt, and it settles the write.
        refusing.on = false;
        assert.equal(await runDue(f, worker), true);
        assert.equal(jobs(f)[0].state, 'complete');
        const shown = (await status(f, id)).data.reconciliation;
        assert.equal(shown.classification, 'appears_applied', JSON.stringify(shown));
        assert.equal(shown.attempts, 1);
        assert.equal(f.writes.length, 1, 'only the lost create was ever sent');
      } finally {
        f.close();
      }
    },
  );

test('a refusal that came after the request was sent (the provider’s own 429) is an attempt, on the ladder', async () => {
  const f = googleBudgetFixture();
  try {
    const id = await lostCreate(f);
    refuseReads(f, {code: 'PLATFORM_RATE_LIMIT', retryAfterMs: 90000, dispatches: true});
    assert.equal(await runDue(f, workerOf(f)), true);
    const [job] = jobs(f);
    assert.equal(job.state, 'queued');
    assert.equal(job.attempts, 1, 'a request reached the provider: it counts');
    const left = job.available_at - Date.now();
    assert.ok(left > 115000 && left <= 120000, 'the first cooldown of the ladder: ' + left);
    const shown = (await status(f, id)).data.reconciliation;
    assert.equal(shown.attempts, 1);
    assert.equal(shown.read_error, 'PLATFORM_RATE_LIMIT');
  } finally {
    f.close();
  }
});

test('a turn that read before a read was refused is an attempt: not every read was refused', async () => {
  const f = googleBudgetFixture();
  try {
    await lostCreate(f);
    // The first round reads; the second round's read is refused before it is sent.
    refuseReads(f, {code: 'TENANT_RATE_LIMIT', passFirst: 1});
    assert.equal(await runDue(f, workerOf(f)), true);
    const [job] = jobs(f);
    assert.equal(job.attempts, 1);
    const left = job.available_at - Date.now();
    assert.ok(left > 115000 && left <= 120000, 'the ladder, not the refusal’s delay: ' + left);
  } finally {
    f.close();
  }
});

test('a refusal that is not one of the gates before dispatch is an attempt (a provider outage)', async () => {
  const f = googleBudgetFixture();
  try {
    await lostCreate(f);
    refuseReads(f, {code: 'UPSTREAM_UNAVAILABLE'});
    assert.equal(await runDue(f, workerOf(f)), true);
    assert.equal(jobs(f)[0].attempts, 1);
  } finally {
    f.close();
  }
});

test('a check never replaces a decisive record that a person wrote while it was reading', async () => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  const f = tiktokReconcileFixture();
  try {
    const {id} = await f.lose('campaign', {applied: true});
    let manual;
    // The worker's check is reading when the person reconciles the same write and gets a decisive answer.
    f.state.hold = async () => {
      manual = await f.call('amcp_write', {action: 'reconcile', review_id: id});
      assert.equal(manual.data.classification, 'appears_applied', JSON.stringify(manual.data).slice(0, 300));
    };
    f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind='write_reconcile' AND state='queued'").run();
    assert.equal(await f.worker.once(), true);
    assert.ok(manual, 'the person reconciled while the check was reading');
    const shown = (await status(f, id)).data.reconciliation;
    assert.equal(
      shown.reconciliation_id,
      manual.data.reconciliation_id,
      'the record the person holds is still the latest',
    );
    assert.notEqual(shown.automatic, true);
    // So the person's accept still meets the reconciliation they saw.
    const accepted = await f.call('amcp_write', {
      action: 'reconcile',
      review_id: id,
      accept_applied: true,
      reconciliation_id: manual.data.reconciliation_id,
    });
    assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 400));
    const dropped = f.store.audit(f.actor.tenantId, 10000).map(row => JSON.parse(row.event));
    assert.ok(
      dropped.some(e => e.event === 'write_reconciliation_dropped' && e.reason === 'newer_check'),
      'the check’s answer is audited as dropped',
    );
  } finally {
    f.close();
  }
});

/** Runs `body` with the person's reconcile allowed at once (the delay after the claim is zero). */
async function withNoDelay(body) {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  try {
    return await body();
  } finally {
    delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  }
}

test('a person’s reconcile whose every read was refused before it was sent raises the refusal, and the decisive record stands', async () => {
  const f = googleBudgetFixture();
  try {
    const id = await lostCreate(f);
    // The worker's check found the write applied, and status offers the accept.
    assert.equal(await runDue(f, workerOf(f)), true);
    const held = (await status(f, id)).data.reconciliation;
    assert.equal(held.classification, 'appears_applied', JSON.stringify(held));
    // The provider is then cooling down: the person's reconcile is refused before any read is sent (lead re-review 2, F4).
    const refusing = refuseReads(f, {code: 'PLATFORM_RATE_LIMIT', retryAfterMs: 90000});
    const refused = await withNoDelay(() => f.call('amcp_write', {action: 'reconcile', review_id: id}));
    assert.equal(refused.error?.code, 'PLATFORM_RATE_LIMIT', JSON.stringify(refused).slice(0, 500));
    assert.equal(refused.error.details.retry_after_ms, 90000);
    assert.ok(refusing.refused > 0);
    // Nothing was stored over the record the person was offered: its id, its answer and its accept are as they were.
    const after = (await status(f, id)).data;
    assert.equal(after.reconciliation.reconciliation_id, held.reconciliation_id);
    assert.equal(after.reconciliation.classification, 'appears_applied');
    refusing.on = false;
    const accepted = await f.call('amcp_write', {
      action: 'reconcile',
      review_id: id,
      accept_applied: true,
      reconciliation_id: held.reconciliation_id,
    });
    assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 400));
    assert.equal(f.claim(id).state, 'complete');
    assert.equal(f.writes.length, 1, 'only the lost create was ever sent');
  } finally {
    f.close();
  }
});

test('a person’s reconcile whose reads were refused after a send, or failed for another reason, still stores read_failed', async () => {
  for (const options of [
    {code: 'PLATFORM_RATE_LIMIT', retryAfterMs: 90000, dispatches: true},
    {code: 'UPSTREAM_UNAVAILABLE'},
  ]) {
    const f = googleBudgetFixture();
    try {
      const id = await lostCreate(f);
      refuseReads(f, options);
      const r = await withNoDelay(() => f.call('amcp_write', {action: 'reconcile', review_id: id}));
      assert.equal(r.data?.classification, 'indeterminate', JSON.stringify(r).slice(0, 400));
      assert.equal(r.data.reason, 'read_failed');
      assert.equal(r.data.read_error, options.code);
      assert.equal((await status(f, id)).data.reconciliation.reason, 'read_failed');
    } finally {
      f.close();
    }
  }
});

test('a check still replaces an older record that was not decisive', async () => {
  const f = googleBudgetFixture();
  try {
    const id = await lostCreate(f);
    // The first turn cannot read (an outage), the second can: the later answer replaces the earlier indeterminate one.
    const outage = refuseReads(f, {code: 'UPSTREAM_UNAVAILABLE'});
    const worker = workerOf(f);
    assert.equal(await runDue(f, worker), true);
    assert.equal((await status(f, id)).data.reconciliation.classification, 'indeterminate');
    outage.on = false;
    assert.equal(await runDue(f, worker), true);
    const shown = (await status(f, id)).data.reconciliation;
    assert.equal(shown.classification, 'appears_applied', JSON.stringify(shown));
    assert.equal(shown.attempts, 2);
  } finally {
    f.close();
  }
});
