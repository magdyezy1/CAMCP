import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {
  budgets,
  claimState,
  door,
  executeNext,
  follow,
  gateTransport,
  holdTargetLock,
  planned,
  show,
  stored,
  tick,
} from './helpers/plan-lifecycle-kit.mjs';

/**
 * r25-planmodel, the second round (M2 and M6 of the independent review of 451169fd): the plan's reads name a call that settles a step left executing, and named it for a step
 * a healthy call was executing as well: following it ended the outcome of that call (the step read uncertain while its request was going out, or ready again while it waited
 * for its target). A step is read, not resumed, while a call is executing it; and what the resume does is said as it is (a review no call claimed is sent by it).
 */

/** Every call the reads of a step name: the plan's get (compact, full, and by step), the review's status and prepare_next. */
async function namedCalls(x, id, review) {
  const results = [
    await x.call('amcp_campaign', {action: 'get', id}),
    await x.call('amcp_campaign', {action: 'get', id, detail: 'full'}),
    await x.call('amcp_campaign', {action: 'get', id, step_id: 'step1'}),
    await x.call('amcp_write', {action: 'status', review_id: review}),
    await x.call('amcp_campaign', {action: 'prepare_next', id}),
  ];
  const calls = new Map();
  for (const result of results) {
    const next = result.data?.next_call ?? result.error?.details?.next_call;
    if (next?.tool && next.arguments) calls.set(JSON.stringify([next.tool, next.arguments]), next);
  }
  return {results, calls: [...calls.values()]};
}
/** The step as the plan holds it, with what a call that settles it would change: its status, error and review. */
const stepNow = (x, id) => {
  const {status, error, review_id} = stored(x, id).steps[0];
  return {status, error: error?.code, review_id};
};
/** Follows every call the reads name, as the person they are for, and says that none of them executes the step again. */
async function followAll(x, id, review, label) {
  const before = stepNow(x, id),
    {results, calls} = await namedCalls(x, id, review);
  assert.ok(calls.length > 0, label + ': the reads name a call');
  for (const call of calls)
    assert.notEqual(
      call.arguments.action,
      'execute_next',
      label + ': a call executes the step: ' + JSON.stringify(call),
    );
  for (const call of calls) {
    const done = await follow(x, call);
    assert.equal(
      done.success,
      true,
      label + ': ' + JSON.stringify(call.arguments) + ' -> ' + JSON.stringify(done.error),
    );
  }
  assert.deepEqual(stepNow(x, id), before, label + ': following the calls the reads name changed the step');
  return results;
}

test('M2 (P1): while a call is sending the request, the reads name the status, never an execute, and following them changes nothing', async () => {
  const {x, id, review} = await planned(budgets(2)),
    gate = gateTransport(x),
    written = door();
  try {
    gate.rules = [{kind: 'write', nth: 1, hold: written.p, when: 'after'}];
    const a = executeNext(x, id, review);
    await gate.arrived();
    assert.equal(claimState(x, review), 'pending');
    const results = await followAll(x, id, review, 'claim pending');
    const get = results[0].data,
      status = results[3].data;
    assert.deepEqual(get.next_call.arguments, {action: 'status', review_id: review});
    assert.deepEqual(status.next_call.arguments, {action: 'status', review_id: review});
    assert.match(
      status.next_safe_action,
      /being sent now\. Read this status again in a moment; never execute it twice/,
    );
    assert.ok(get.retry_read_after_ms > 0, 'and says when to read again');
    // A client that executes the step anyway (an earlier answer's call) is refused as uncertain over the pending claim, and that is not the step's outcome.
    const second = await executeNext(x, id, review);
    assert.equal(second.success, true, JSON.stringify(second.error ?? second).slice(0, 300));
    assert.match(second.data.notice, /changed nothing/);
    assert.deepEqual(stepNow(x, id), {status: 'executing', error: undefined, review_id: review});
    written.open();
    const done = await a;
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
    assert.equal(show(x, id), 'complete [step1=verified]');
    assert.equal(stored(x, id).steps[0].error, undefined, 'a verified step carries no error');
    assert.equal(x.writes(), 1);
  } finally {
    written.open();
    x.store.close();
  }
});

test('M2 (S5): while a call waits for its target, the reads name the step, never an execute, and a second execute refused as busy changes nothing', async () => {
  const before = process.env.AMCP_WRITE_TARGET_WAIT_MS,
    {x, id, review} = await planned(budgets(2)),
    lock = holdTargetLock(x);
  try {
    // The first call waits long; the second, which a client makes from an earlier answer, waits a moment and is refused as busy.
    process.env.AMCP_WRITE_TARGET_WAIT_MS = '8000';
    const a = executeNext(x, id, review);
    await lock.waiting();
    assert.equal(claimState(x, review), 'none');
    const results = await followAll(x, id, review, 'no claim');
    assert.match(results[0].data.next_call.meaning, /being executed by a call of this plan/);
    assert.deepEqual(results[3].data.next_call.arguments, {action: 'get', id, step_id: 'step1'});
    assert.match(results[3].data.next_safe_action, /executing this step now/);
    process.env.AMCP_WRITE_TARGET_WAIT_MS = '200';
    const second = await executeNext(x, id, review);
    assert.equal(second.success, true, JSON.stringify(second.error ?? second).slice(0, 300));
    assert.match(second.data.notice, /changed nothing \(STATE_BUSY\)/);
    assert.deepEqual(stepNow(x, id), {status: 'executing', error: undefined, review_id: review});
    // The plan cannot be continued as another plan while the call executes: its step may be sent by it.
    const continued = await x.call('amcp_campaign', {action: 'continue_as_new', id, confirmed: true});
    assert.equal(continued.success, false);
    assert.deepEqual(stepNow(x, id), {status: 'executing', error: undefined, review_id: review});
    lock.release();
    const done = await a;
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
    assert.equal(show(x, id), 'complete [step1=verified]');
    assert.equal(x.writes(), 1);
  } finally {
    if (before === undefined) delete process.env.AMCP_WRITE_TARGET_WAIT_MS;
    else process.env.AMCP_WRITE_TARGET_WAIT_MS = before;
    lock.release();
    x.store.close();
  }
});

test('M2: while a call reads the write back, the reads name the step, and following them changes nothing', async () => {
  const {x, id, review} = await planned(budgets(2)),
    transport = x.service.transport,
    real = transport.fetcher,
    als = new AsyncLocalStorage(),
    read = door();
  try {
    let afterWrite = false,
      came = false;
    transport.fetcher = async (url, init) => {
      const isRead = String(url).endsWith('googleAds:search');
      if (isRead && afterWrite && als.getStore() === 'A' && !came) {
        came = true;
        await read.p;
      }
      const out = await real(url, init);
      if (!isRead && !JSON.parse(String(init?.body ?? '{}')).validateOnly) afterWrite = true;
      return out;
    };
    const a = als.run('A', () => executeNext(x, id, review));
    for (let i = 0; i < 1000 && !came; i++) await tick(10);
    assert.ok(came, 'the call came to its read-back');
    assert.equal(claimState(x, review), 'complete');
    await followAll(x, id, review, 'claim complete');
    read.open();
    const done = await a;
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
    assert.equal(show(x, id), 'complete [step1=verified]');
    assert.equal(x.writes(), 1);
  } finally {
    read.open();
    x.store.close();
  }
});

test('M2: run, called while another call is executing the step, waits for it: it executes nothing, sends nothing, and names run again', async () => {
  const {x, id, review} = await planned(budgets(2)),
    gate = gateTransport(x),
    written = door();
  try {
    const shown = await x.call('amcp_campaign', {action: 'approve', id});
    assert.equal((await follow(x, shown.data.next_call)).success, true);
    gate.rules = [{kind: 'write', nth: 1, hold: written.p, when: 'after'}];
    const a = executeNext(x, id, review);
    await gate.arrived();
    assert.equal(x.writes(), 1, 'the first call’s request reached the provider');
    const ran = await x.call('amcp_campaign', {action: 'run', id});
    assert.equal(ran.success, true, JSON.stringify(ran.error ?? ran).slice(0, 300));
    assert.equal(ran.data.run.stopped, 'waiting');
    assert.deepEqual(ran.data.run.executed, [], 'it ran nothing');
    assert.deepEqual(ran.data.next_call.arguments, {action: 'run', id});
    assert.equal(x.writes(), 1, 'and sent nothing');
    assert.deepEqual(stepNow(x, id), {status: 'executing', error: undefined, review_id: review});
    written.open();
    assert.equal((await a).success, true);
    assert.equal(show(x, id), 'complete [step1=verified]');
    assert.equal(x.writes(), 1);
  } finally {
    written.open();
    x.store.close();
  }
});

test('M2: once the call that was executing has ended, and a lease of two minutes has run out, the reads name the resume, which settles the step', async () => {
  const realNow = Date.now,
    {x, id, review} = await planned(budgets(2)),
    put = x.store.putDocument.bind(x.store);
  try {
    // The call ends after the write, before it saves the outcome (its final save fails): the step is executing, its claim complete.
    let saves = 0;
    x.store.putDocument = (tenant, kind, doc, ...rest) => {
      if (kind === 'campaign_run' && doc === id && ++saves === 2) throw new Error('synthetic failure of the plan save');
      return put(tenant, kind, doc, ...rest);
    };
    assert.equal((await executeNext(x, id, review)).error?.code, 'INTERNAL_ERROR');
    x.store.putDocument = put;
    assert.equal(stored(x, id).steps[0].status, 'executing');
    // Within the lease the call could still be running: the reads name a read.
    let got = await x.call('amcp_campaign', {action: 'get', id});
    assert.deepEqual(got.data.next_call.arguments, {action: 'get', id, step_id: 'step1'});
    // After it, the step is the plan's to settle.
    Date.now = () => realNow() + 2 * 60000 + 1000;
    got = await x.call('amcp_campaign', {action: 'get', id});
    assert.equal(got.data.next_call.arguments.action, 'execute_next');
    assert.match(got.data.next_call.meaning, /replays the receipt/);
    const status = (await x.call('amcp_write', {action: 'status', review_id: review})).data;
    assert.equal(status.next_call.arguments.action, 'execute_next');
    const done = await follow(x, got.data.next_call);
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
    assert.equal(show(x, id), 'complete [step1=verified]');
    assert.equal(x.writes(), 1);
  } finally {
    Date.now = realNow;
    x.store.putDocument = put;
    x.store.close();
  }
});

test('M6 (P5): a step left executing before its review was claimed: the call the reads name says it sends the approved change now, and it does', async () => {
  const realNow = Date.now,
    {x, id, review} = await planned(budgets(2));
  try {
    // The call that was executing the step ended before it claimed the review (the process stopped while it waited for its target).
    const {id: _id, revision, ...data} = stored(x, id);
    data.steps[0].status = 'executing';
    data.steps[0].executing_at = Date.now();
    data.state = 'in_progress';
    x.store.putDocument('google-world', 'campaign_run', id, data, revision);
    assert.equal(claimState(x, review), 'none');
    Date.now = () => realNow() + 2 * 60000 + 1000;
    const got = await x.call('amcp_campaign', {action: 'get', id});
    assert.equal(got.data.next_call.arguments.action, 'execute_next');
    const meaning = got.data.next_call.meaning;
    assert.doesNotMatch(
      meaning,
      /replays|never sends/,
      'nothing was recorded for the review, so there is no receipt to replay: ' + meaning,
    );
    assert.match(meaning, /nothing was sent[\s\S]*sends the change, once/);
    const status = (await x.call('amcp_write', {action: 'status', review_id: review})).data;
    assert.equal(status.state, 'unsubmitted');
    assert.equal(status.next_call.arguments.action, 'execute_next');
    assert.match(status.next_safe_action, /ended before it claimed the review[\s\S]*sends the approved change/);
    assert.equal(x.writes(), 0);
    const done = await follow(x, got.data.next_call);
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
    assert.equal(show(x, id), 'complete [step1=verified]');
    assert.equal(x.writes(), 1, 'the call sent the change, once, as it said');
  } finally {
    Date.now = realNow;
    x.store.close();
  }
});
