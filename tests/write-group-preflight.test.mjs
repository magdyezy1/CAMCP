import test from 'node:test';
import assert from 'node:assert/strict';
import {googleBudgetFixture} from './fixtures/google-budget-writes.mjs';

/**
 * WRT-04 Stage B: a group review of more than 25 records was checked part by part, so 30 budget creates under a
 * daily cap prepared with no cap acknowledgement, applied part 1 and stopped at part 2, half applied, with a remedy
 * pointing at the provider. The parts are now one change: the caps count them together at prepare and again before
 * part 1, every part is admitted and given time before anything is sent, and a stop names the parts not sent.
 */
const dailyCap = 1400000000,
  each = 50000000;
const groupClaim = (f, id) => f.claim(id);
const pause = f => f.call('amcp_workspace', {action: 'pause_writes', reason: 'Synthetic incident', confirmed: true});
const resume = f => f.call('amcp_workspace', {action: 'resume_writes', confirmed: true});

test('under confirm, a daily cap only the whole group crosses is named at prepare and acknowledged once', async () => {
  const f = googleBudgetFixture();
  try {
    f.spendPolicy({max_daily_increase_native: dailyCap});
    const review = await f.creates(30, each);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 800));
    assert.equal(review.data.group, true);
    assert.deepEqual(
      review.data.parts.map(p => p.records),
      [25, 5],
    );
    // Each part alone fits the cap; together they do not.
    assert.deepEqual(
      review.data.parts.map(p => p.spend_policy.exceeded ?? null),
      [null, null],
    );
    assert.equal(review.data.execute_requirements.cap_override_confirmed, true);
    const reason = review.data.execute_requirements.reasons.find(r => r.flag === 'cap_override_confirmed');
    assert.match(reason.reason, /Together, the parts.*1500000000, above the daily cap of 1400000000/);
    assert.equal(review.data.spend_policy.requested_increase_decimal, '1500000000');
    assert.equal(review.data.spend_policy.exceeded[0].part, 2);
    assert.equal(f.writes.length, 0);
    // Without the acknowledgement nothing is sent and the group stays executable.
    const refused = await f.execute(review.data.review_id);
    assert.equal(refused.error.code, 'CAP_CONFIRMATION_REQUIRED', JSON.stringify(refused.error));
    assert.equal(refused.error.category, 'confirmation');
    assert.equal(f.writes.length, 0);
    assert.equal(groupClaim(f, review.data.review_id), undefined);
    const done = await f.execute(review.data.review_id, {cap_override_confirmed: true});
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
    assert.deepEqual(
      f.writes.map(w => w.operations.length),
      [25, 5],
    );
  } finally {
    f.close();
  }
});

test('under block, a group that crosses the daily cap is refused at prepare with nothing sent', async () => {
  const f = googleBudgetFixture();
  try {
    f.spendPolicy({enforcement: 'block', max_daily_increase_native: dailyCap});
    const refused = await f.creates(30, each);
    assert.equal(refused.success, false);
    assert.equal(refused.error.code, 'POLICY_DAILY_INCREASE_LIMIT', JSON.stringify(refused.error));
    assert.equal(refused.error.details.part, 2);
    assert.equal(refused.error.details.group, true);
    assert.match(refused.error.message, /Together, the parts of this review/);
    assert.equal(refused.error.category, 'policy');
    assert.equal(f.writes.length, 0);
    assert.equal(f.store.documents(f.actor.tenantId, 'write_review_group').length, 0);
  } finally {
    f.close();
  }
});

test('a part whose window is too short for its turn refuses the group before part 1, with nothing sent', async () => {
  const f = googleBudgetFixture();
  try {
    const review = await f.creates(30, each);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
    assert.ok(review.data.time_budget.seconds_per_part >= 3);
    assert.equal(review.data.time_budget.execute_by, review.data.expires_at, 'the group lasts while every part fits');
    // A fake clock: part 2's own window now ends in four seconds, less than the two part durations it needs.
    const part = review.data.parts[1].review_id;
    f.store.db
      .prepare("UPDATE documents SET data=json_set(data,'$.expires_at',?) WHERE kind='write_review' AND id=?")
      .run(Date.now() + 4000, part);
    const late = await f.execute(review.data.review_id);
    assert.equal(late.error.code, 'REVIEW_EXPIRED', JSON.stringify(late.error));
    assert.equal(late.error.details.part, 2);
    assert.ok(late.error.details.needed_seconds > late.error.details.remaining_seconds);
    assert.equal(late.error.details.next_call.arguments.action, 'prepare');
    assert.equal(late.error.details.next_call.arguments.arguments.payload.operations.length, 30);
    assert.equal(f.writes.length, 0);
    assert.equal(groupClaim(f, review.data.review_id), undefined);
  } finally {
    f.close();
  }
});

test('a group whose parts cannot all fit one review window is refused at prepare', async () => {
  const f = googleBudgetFixture();
  process.env.AMCP_WRITE_GROUP_PART_SECONDS = '120';
  try {
    // Three parts of two minutes each cannot fit a five-minute window.
    const refused = await f.creates(60, each);
    assert.equal(refused.error.code, 'WRITE_GROUP_TOO_LONG', JSON.stringify(refused.error));
    assert.equal(refused.error.details.seconds_per_part, 120);
    assert.equal(refused.error.details.parts, 3);
    assert.equal(refused.error.category, 'request');
    assert.equal(f.writes.length, 0);
  } finally {
    delete process.env.AMCP_WRITE_GROUP_PART_SECONDS;
    f.close();
  }
});

test('a pause before execute refuses the whole group before part 1', async () => {
  const f = googleBudgetFixture();
  try {
    const review = await f.creates(30, each);
    await pause(f);
    const refused = await f.execute(review.data.review_id);
    assert.equal(refused.error.code, 'WRITES_PAUSED');
    assert.equal(f.writes.length, 0);
    await resume(f);
    assert.equal((await f.execute(review.data.review_id)).success, true);
    assert.equal(f.writes.length, 2);
  } finally {
    f.close();
  }
});

// The second re-review's S4-d: the execute of a group checked the owner's caps for every part, the parts already applied included. An applied part's
// reservation is kept (it counts as reserved today), so on a resume its increase was counted twice and a change that fits the cap was asked for as if it
// crossed it. Only the parts still to send are counted now.
test('a resume does not count the parts already applied against the owner’s cap a second time', async () => {
  const f = googleBudgetFixture();
  try {
    // The whole group (30 budgets of 50,000,000, 1,500,000,000) fits the daily cap; part 1 is 1,250,000,000 of it.
    f.spendPolicy({max_daily_increase_native: 2000000000});
    const review = await f.creates(30, each);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 600));
    assert.equal(review.data.execute_requirements.cap_override_confirmed, undefined, 'no cap is crossed');
    // Part 1 is sent alone, as after a crash between the parts, and its reservation is kept.
    assert.equal((await f.execute(review.data.parts[0].review_id)).success, true);
    assert.equal(f.writes.length, 1);
    const resumed = await f.execute(review.data.review_id);
    assert.equal(resumed.success, true, JSON.stringify(resumed.error ?? resumed).slice(0, 600));
    assert.deepEqual(
      f.writes.map(w => w.operations.length),
      [25, 5],
      'part 1 replayed, part 2 sent once',
    );
  } finally {
    f.close();
  }
});

test('a resume still asks for the cap acknowledgement when the parts not sent cross the cap', async () => {
  const f = googleBudgetFixture();
  try {
    // 1,250,000,000 are reserved by part 1; the five budgets of part 2 take the day to 1,500,000,000, above the cap of 1,400,000,000.
    f.spendPolicy({max_daily_increase_native: dailyCap});
    const review = await f.creates(30, each);
    assert.equal(review.data.execute_requirements.cap_override_confirmed, true);
    assert.equal((await f.execute(review.data.parts[0].review_id)).success, true);
    const refused = await f.execute(review.data.review_id);
    assert.equal(refused.error.code, 'CAP_CONFIRMATION_REQUIRED', JSON.stringify(refused.error).slice(0, 600));
    assert.equal(refused.error.details.exceeded[0].part, 2, 'the part is named by its place in the group');
    assert.equal(f.writes.length, 1, 'nothing was sent');
    const resumed = await f.execute(review.data.review_id, {cap_override_confirmed: true});
    assert.equal(resumed.success, true, JSON.stringify(resumed.error ?? resumed).slice(0, 600));
    assert.equal(f.writes.length, 2);
  } finally {
    f.close();
  }
});

test('a group stopped by a refusal before a later part was sent names that part and how to send it', async () => {
  const f = googleBudgetFixture();
  try {
    const review = await f.creates(30, each);
    // The owner pauses writes while part 1 is in flight: part 1 applies, part 2 is refused before it is sent.
    f.hooks.beforeWrite = async () => {
      f.hooks.beforeWrite = undefined;
      await pause(f);
    };
    const stopped = await f.execute(review.data.review_id);
    assert.equal(stopped.error.code, 'WRITE_PARTIAL_OR_FAILED', JSON.stringify(stopped.error).slice(0, 800));
    assert.match(
      stopped.error.message,
      /Part 2 of 2 did not succeed \(WRITES_PAUSED\): parts 1–1 were applied; it was not sent/,
    );
    assert.equal(stopped.error.details.part_error, 'WRITES_PAUSED');
    assert.equal(stopped.error.details.part_submitted, false);
    // The remedy is the part's own (the owner's pause), not a provider problem.
    assert.equal(stopped.error.category, 'policy');
    assert.equal(stopped.error.remedy.owner, 'workspace_owner');
    const next = stopped.error.details.next_call;
    assert.equal(next.arguments.action, 'execute');
    assert.equal(next.arguments.review_id, review.data.parts[1].review_id);
    assert.deepEqual(next.add_after_user_approval, {spend_change_confirmed: true});
    assert.equal(stopped.error.details.not_sent_parts.length, 1);
    assert.equal(f.writes.length, 1);
    // The group is never run again; the unsent part is sent on its own once the owner resumes.
    assert.equal((await f.execute(review.data.review_id)).error.code, 'WRITE_OUTCOME_UNCERTAIN');
    await resume(f);
    const sent = await f.write({...next.arguments, ...next.add_after_user_approval});
    assert.equal(sent.success, true, JSON.stringify(sent).slice(0, 600));
    assert.deepEqual(
      f.writes.map(w => w.operations.length),
      [25, 5],
    );
  } finally {
    f.close();
  }
});
