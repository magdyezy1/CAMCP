import test from 'node:test';
import assert from 'node:assert/strict';
import {budgetName, googleBudgetFixture} from './fixtures/google-budget-writes.mjs';

/**
 * WRT-04 Stage C: two reviews of one target, prepared on the same state, used to both send when executed at once
 * (90→100 and 90→120 both applied). Executes of one target now run one at a time: the later one reads the state again
 * after the earlier one was sent and is refused as STATE_CHANGED, or waits too long and is refused as STATE_BUSY.
 * Either way nothing more is sent, and the lock is released on every path.
 */
const locks = f => f.store.db.prepare("SELECT key,owner FROM service_locks WHERE key LIKE 'write-target:%'").all();

test('concurrent reviews of one budget send once; the other is refused as changed state', async () => {
  const f = googleBudgetFixture();
  try {
    const first = (await f.update(100000000)).data,
      second = (await f.update(120000000)).data;
    assert.equal(first.state_hash, second.state_hash, 'both were reviewed on the same state');
    let release;
    const held = new Promise(resolve => (release = resolve));
    f.hooks.beforeWrite = () => held;
    const a = f.execute(first.review_id);
    // The first holds the target while its mutation is in flight; the second waits for it.
    while (!f.writes.length) await new Promise(r => setTimeout(r, 5));
    assert.equal(locks(f).length, 1);
    const b = f.execute(second.review_id);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(f.writes.length, 1, 'the second has not been sent while the first is in flight');
    release();
    const [one, two] = await Promise.all([a, b]);
    assert.equal(one.success, true, JSON.stringify(one).slice(0, 600));
    assert.equal(two.success, false);
    assert.equal(two.error.code, 'STATE_CHANGED', JSON.stringify(two.error));
    assert.equal(f.writes.length, 1, 'no second write');
    assert.equal(f.budgets.get(budgetName(1)), '100000000');
    assert.equal(f.claim(second.review_id), undefined, 'the refused review was never claimed');
    assert.deepEqual(locks(f), [], 'locks are released after success and refusal');
  } finally {
    f.close();
  }
});

test('a target held longer than the wait is refused as STATE_BUSY before anything is claimed', async () => {
  const f = googleBudgetFixture();
  process.env.AMCP_WRITE_TARGET_WAIT_MS = '200';
  try {
    const first = (await f.update(100000000)).data,
      second = (await f.update(120000000)).data;
    let release;
    const held = new Promise(resolve => (release = resolve));
    f.hooks.beforeWrite = () => held;
    const a = f.execute(first.review_id);
    while (!f.writes.length) await new Promise(r => setTimeout(r, 5));
    const busy = await f.execute(second.review_id);
    assert.equal(busy.error.code, 'STATE_BUSY', JSON.stringify(busy.error));
    assert.equal(busy.error.category, 'state');
    assert.match(busy.error.remedy.action, /nothing was sent/);
    assert.equal(f.claim(second.review_id), undefined);
    release();
    assert.equal((await a).success, true);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(locks(f), []);
  } finally {
    delete process.env.AMCP_WRITE_TARGET_WAIT_MS;
    f.close();
  }
});

test('a lock lost before dispatch refuses the write unsent and releases its claim', async () => {
  const f = googleBudgetFixture();
  try {
    const id = (await f.update(100000000)).data.review_id;
    // Another holder took the target after this execute's lock lapsed: the renewal at dispatch fails.
    f.hooks.duringPermit = () => {
      const [lock] = locks(f);
      f.store.db.prepare('UPDATE service_locks SET owner=? WHERE key=?').run('another-execute', lock.key);
    };
    const refused = await f.execute(id);
    assert.equal(refused.error.code, 'STATE_BUSY', JSON.stringify(refused.error));
    assert.equal(refused.error.details.submission, 'not_sent');
    assert.equal(f.writes.length, 0);
    assert.equal(f.claim(id), undefined);
    assert.equal(locks(f).length, 1, 'the other holder keeps its lock');
    f.store.db.prepare('DELETE FROM service_locks').run();
    assert.equal((await f.execute(id)).success, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.close();
  }
});

test('locks are released after an uncertain outcome and after a state refusal', async () => {
  const f = googleBudgetFixture();
  try {
    const lost = (await f.update(100000000)).data.review_id;
    f.hooks.respond = () => {
      throw new TypeError('synthetic lost response');
    };
    assert.equal((await f.execute(lost)).error.code, 'WRITE_OUTCOME_UNCERTAIN');
    assert.deepEqual(locks(f), []);
    f.hooks.respond = undefined;
    const stale = (await f.update(130000000)).data.review_id;
    f.budgets.set(budgetName(1), '95000000');
    assert.equal((await f.execute(stale)).error.code, 'STATE_CHANGED');
    assert.deepEqual(locks(f), []);
  } finally {
    f.close();
  }
});

test('AMCP_WRITE_TARGET_LOCK=false turns serialization off', async () => {
  const f = googleBudgetFixture();
  process.env.AMCP_WRITE_TARGET_LOCK = 'false';
  try {
    const first = (await f.update(100000000)).data.review_id,
      second = (await f.update(120000000)).data.review_id;
    let release;
    const held = new Promise(resolve => (release = resolve));
    f.hooks.beforeWrite = () => held;
    const a = f.execute(first);
    while (!f.writes.length) await new Promise(r => setTimeout(r, 5));
    const b = f.execute(second);
    while (f.writes.length < 2) await new Promise(r => setTimeout(r, 5));
    release();
    await Promise.all([a, b]);
    assert.equal(f.writes.length, 2, 'as before this change, both were sent');
    assert.deepEqual(locks(f), []);
  } finally {
    delete process.env.AMCP_WRITE_TARGET_LOCK;
    f.close();
  }
});
