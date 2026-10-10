import test from 'node:test';
import assert from 'node:assert/strict';
import {gateway, account, budgetAction, budgetName, googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {scopeKey} from '../dist/src/security.js';

/**
 * WRT-04 Stage A (owner decision D12): a refusal raised after execute claimed its key but before the mutation left
 * AMCP sent nothing. It used to mark the claim uncertain, so the next execute answered "already submitted" and the
 * approved change had to be prepared and approved again. Such a refusal now releases the claim and the day's spend
 * reservation, audits write_not_sent, and the same review executes once the cause clears. A request that was
 * dispatched stays uncertain exactly as before.
 */
const pause = f =>
  f.call('amcp_workspace', {action: 'pause_writes', reason: 'Synthetic incident', confirmed: true}).then(r => {
    assert.equal(r.success, true, JSON.stringify(r));
  });
const resume = f =>
  f.call('amcp_workspace', {action: 'resume_writes', confirmed: true}).then(r => {
    assert.equal(r.success, true, JSON.stringify(r));
  });
const circuitKey = f => scopeKey(scopeKey(f.actor.tenantId, gateway), 'g', account, 'https://googleads.googleapis.com');
const key = f => scopeKey(f.actor.tenantId, gateway);

/** Each cause: how to raise it inside execute after the claim, and how it clears. */
const causes = {
  'a pause during the state read': {
    code: 'WRITES_PAUSED',
    raise: f => (f.hooks.duringRead = () => pause(f)),
    clear: f => resume(f),
  },
  'a pause during the transport permit wait': {
    code: 'WRITES_PAUSED',
    raise: f => (f.hooks.duringPermit = () => pause(f)),
    clear: f => resume(f),
  },
  'a provider cooldown': {
    code: 'PLATFORM_RATE_LIMIT',
    raise: f => (f.hooks.duringPermit = () => f.transport.cooldowns.set(key(f), performance.now() + 60000)),
    clear: f => f.transport.cooldowns.clear(),
  },
  'the tenant request budget': {
    code: 'TENANT_RATE_LIMIT',
    raise: f =>
      (f.hooks.duringRead = () => f.transport.budgets.set(key(f), {tokens: -1e12, at: performance.now() + 1e9})),
    clear: f => f.transport.budgets.clear(),
  },
  'an open circuit': {
    code: 'CIRCUIT_OPEN',
    raise: f =>
      (f.hooks.duringPermit = () =>
        f.transport.circuits.set(circuitKey(f), {
          failures: 5,
          until: performance.now() + 60000,
          at: performance.now(),
          code: 'UPSTREAM_UNAVAILABLE',
          status: 503,
        })),
    clear: f => f.transport.circuits.clear(),
  },
  'missing credentials': {
    code: 'CREDENTIALS_REQUIRED',
    raise: f => {
      // The state reads keep their login; the mutation reaches the transport without one and is refused there.
      const request = f.transport.request;
      f.transport.request = (plan, connection, credentials, ...rest) =>
        request(plan, connection, plan.readOnly ? credentials : {}, ...rest);
      f.restoreCredentials = () => (f.transport.request = request);
    },
    clear: f => f.restoreCredentials(),
  },
};

for (const [name, cause] of Object.entries(causes))
  test('the claim is released when ' + name + ' refuses the write before it is sent', async () => {
    const f = googleBudgetFixture();
    try {
      f.spendPolicy({max_daily_increase_native: 50000000});
      const review = await f.update(100000000);
      assert.equal(review.success, true, JSON.stringify(review).slice(0, 800));
      const id = review.data.review_id;
      cause.raise(f);
      const refused = await f.execute(id);
      assert.equal(refused.success, false);
      assert.equal(refused.error.code, cause.code, JSON.stringify(refused.error));
      assert.equal(f.writes.length, 0, 'nothing reached the provider');
      assert.equal(refused.error.details.submission, 'not_sent');
      assert.equal(refused.error.details.review_id, id);
      assert.equal(f.claim(id), undefined, 'the idempotency claim is released');
      assert.deepEqual(f.reservations(), [], 'the daily spend reservation is released');
      const events = f.audit().filter(e => e.event === 'write_not_sent');
      assert.equal(events.length, 1);
      assert.equal(events[0].code, cause.code);
      assert.equal(
        f.audit().some(e => e.event === 'write_uncertain'),
        false,
      );
      const journal = f.store.document(f.actor.tenantId, 'operation_journal', id);
      assert.equal(journal.phase, 'not_sent');
      // The same review executes once the cause clears, inside its window.
      await cause.clear(f);
      const done = await f.execute(id);
      assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
      assert.equal(f.writes.length, 1);
      assert.equal(f.budgets.get(budgetName(1)), '100000000');
      assert.equal(f.claim(id).state, 'complete');
      assert.equal(f.reservations().length, 1, 'the executed change reserves its increase');
    } finally {
      f.close();
    }
  });

test('a review that expires during admission is released and refused as expired, with nothing sent', async () => {
  const f = googleBudgetFixture();
  const now = Date.now;
  try {
    f.spendPolicy({max_daily_increase_native: 50000000});
    const review = await f.update(100000000);
    const id = review.data.review_id;
    f.hooks.duringPermit = () => {
      const skew = now() + 301000;
      Date.now = () => skew;
    };
    const refused = await f.execute(id);
    Date.now = now;
    assert.equal(refused.error.code, 'REVIEW_EXPIRED', JSON.stringify(refused.error));
    assert.equal(refused.error.details.submission, 'not_sent');
    assert.ok(refused.error.details.next_call, 'the prepare call that reviews it again');
    assert.equal(f.writes.length, 0);
    assert.equal(f.claim(id), undefined);
    assert.deepEqual(f.reservations(), []);
    assert.equal(f.audit().filter(e => e.event === 'write_not_sent' && e.code === 'REVIEW_EXPIRED').length, 1);
  } finally {
    Date.now = now;
    f.close();
  }
});

const dispatched = {
  'a thrown fetch': () => {
    throw new TypeError('synthetic network failure');
  },
  'a provider 5xx': () => Response.json({error: {code: 500, message: 'Synthetic'}}, {status: 500}),
  // CMP-04: a 4xx is rejected only with the provider's parsed error body; one without it proves nothing.
  'a provider 4xx without a parsed error body': () =>
    new Response('<html>Synthetic gateway refusal</html>', {status: 400, headers: {'content-type': 'text/html'}}),
};
for (const [name, respond] of Object.entries(dispatched))
  test('a write that was dispatched stays uncertain after ' + name, async () => {
    const f = googleBudgetFixture();
    try {
      f.spendPolicy({max_daily_increase_native: 50000000});
      const id = (await f.update(100000000)).data.review_id;
      f.hooks.respond = respond;
      const failed = await f.execute(id);
      assert.equal(failed.success, false);
      assert.equal(f.writes.length, 1);
      assert.notEqual(failed.error.details?.submission, 'not_sent');
      assert.equal(f.claim(id).state, 'uncertain');
      assert.equal(f.reservations().length, 1, 'a dispatched write keeps its reservation');
      assert.equal(
        f.audit().some(e => e.event === 'write_not_sent'),
        false,
      );
      assert.ok(f.audit().some(e => e.event === 'write_uncertain'));
      f.hooks.respond = undefined;
      const again = await f.execute(id);
      assert.equal(again.error.code, 'WRITE_OUTCOME_UNCERTAIN');
      assert.equal(f.writes.length, 1, 'never sent again');
    } finally {
      f.close();
    }
  });

// CMP-04 (owner decision D12): this test replaced "stays uncertain after a provider 4xx", whose expectation encoded the
// dead end. Google documents that a per-service mutate without partial failure applies all of its operations or none,
// so its definitive refusal is rejected: the key is retired and never sent again, and the reservation is released.
test('a Google per-service refusal with its error body is rejected: retired key, released reservation, no resend', async () => {
  const f = googleBudgetFixture();
  try {
    f.spendPolicy({max_daily_increase_native: 50000000});
    const id = (await f.update(100000000)).data.review_id;
    f.hooks.respond = () =>
      Response.json({error: {code: 400, message: 'Synthetic', status: 'INVALID_ARGUMENT'}}, {status: 400});
    const failed = await f.execute(id);
    assert.equal(failed.success, false);
    assert.equal(f.writes.length, 1);
    assert.equal(failed.error.details?.submission, 'rejected');
    assert.equal(failed.error.details?.key_retired, true);
    assert.equal(f.claim(id).state, 'rejected');
    assert.equal(f.reservations().length, 0, 'a proven non-applied refusal releases its reservation');
    assert.ok(f.audit().some(e => e.event === 'write_rejected' && e.http_status === 400));
    assert.equal(
      f.audit().some(e => e.event === 'write_uncertain'),
      false,
    );
    f.hooks.respond = undefined;
    const again = await f.execute(id);
    assert.equal(again.error.code, 'WRITE_REJECTED');
    assert.equal(f.writes.length, 1, 'never sent again');
  } finally {
    f.close();
  }
});

test('two simultaneous executes of one review still dispatch once, and the later one replays the receipt', async () => {
  const f = googleBudgetFixture();
  try {
    const id = (await f.update(100000000)).data.review_id;
    const results = await Promise.all([f.execute(id), f.execute(id)]);
    assert.equal(f.writes.length, 1);
    assert.ok(
      results.every(r => r.success === true),
      JSON.stringify(results.map(r => r.error ?? r.data.replayed)),
    );
    assert.deepEqual(results.map(r => r.data.replayed === true).sort(), [false, true]);
  } finally {
    f.close();
  }
});

test('AMCP_WRITE_NOT_SENT_RELEASE=false restores the always-uncertain outcome', async () => {
  const f = googleBudgetFixture();
  process.env.AMCP_WRITE_NOT_SENT_RELEASE = 'false';
  try {
    const id = (await f.update(100000000)).data.review_id;
    f.hooks.duringRead = () => pause(f);
    const refused = await f.execute(id);
    assert.equal(refused.error.code, 'WRITES_PAUSED');
    assert.equal(f.claim(id).state, 'uncertain');
    assert.equal(f.writes.length, 0);
  } finally {
    delete process.env.AMCP_WRITE_NOT_SENT_RELEASE;
    f.close();
  }
});

test('a plan step paused during execution stays ready and continues after resume without a new plan', async () => {
  const f = googleBudgetFixture();
  try {
    const created = await f.call('amcp_campaign', {
      action: 'create',
      name: 'Budget plan',
      brief: 'Synthetic plan',
      steps: [
        {
          id: 'budget',
          kind: 'write',
          gateway,
          connection_id: 'g',
          account_id: account,
          arguments: {
            action: budgetAction,
            payload: {
              operations: [
                {update: {resourceName: budgetName(1), amountMicros: '100000000'}, updateMask: 'amount_micros'},
              ],
            },
          },
        },
      ],
    });
    assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
    const id = created.data.id;
    const prepared = await f.call('amcp_campaign', {action: 'prepare_next', id});
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 800));
    f.hooks.duringRead = () => pause(f);
    const paused = await f.call('amcp_campaign', {
      ...prepared.data.next_call.arguments,
      ...prepared.data.next_call.add_after_user_approval,
    });
    assert.equal(paused.success, true, JSON.stringify(paused).slice(0, 800));
    const step = paused.data.steps?.find(s => s.id === 'budget') ?? paused.data.step;
    assert.equal(f.writes.length, 0);
    assert.equal(step.status, 'review_ready', JSON.stringify(paused.data).slice(0, 1200));
    await resume(f);
    const again = await f.call('amcp_campaign', {action: 'prepare_next', id});
    assert.equal(again.data.review.review_id, prepared.data.review.review_id, 'the same review, not a new plan');
    const done = await f.call('amcp_campaign', {
      ...again.data.next_call.arguments,
      spend_change_confirmed: true,
    });
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
    assert.equal(f.writes.length, 1);
    assert.equal(f.budgets.get(budgetName(1)), '100000000');
  } finally {
    f.close();
  }
});
