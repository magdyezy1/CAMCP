import test from 'node:test';
import assert from 'node:assert/strict';
import type {JsonObject} from '../src/types.js';
import {bytes, campaignStep, createPlan, fixture, runAll, squadPlan, squadStep} from './snapchat-plan-fixture.js';

/**
 * Snapchat S1, from the owner's live test on 2026-09-29: execute_next grew by about 11 KB a step, from 25 KB to
 * 132 KB, and 8 of 11 responses overflowed the client, because every response repeated every earlier step's frozen
 * review, receipt, verification and before_state. Plan responses are now a compact view of at most 12 KB whatever
 * the number of steps, and the whole stored plan is one `get` away.
 */
const budget = 12 * 1024;

async function measured(steps: JsonObject[]) {
  const f = fixture();
  const created = await createPlan(f, steps);
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 2000));
  const id = created.data.id,
    responses = [{action: 'create', result: created}, ...(await runAll(f, id))];
  return {f, id, responses};
}
function withinBudget(responses: {action: string; result: JsonObject}[]) {
  const sizes = responses.map(r => ({action: r.action, bytes: bytes(r.result)}));
  const over = sizes.filter(s => s.bytes > budget);
  assert.deepEqual(over, [], 'responses over 12 KB: ' + JSON.stringify(over));
  return sizes;
}

test('every response of an 11-step Snapchat plan fits 12 KB, and later steps are no larger than early ones', async () => {
  const {f, id, responses} = await measured(squadPlan(11));
  try {
    const sizes = withinBudget(responses),
      executes = sizes.filter(s => s.action === 'execute_next').map(s => s.bytes);
    assert.equal(executes.length, 11);
    // A compact response does not grow with the steps before it: the last is within 2 KB of the first.
    assert.ok(executes.at(-1)! - executes[0]! < 2048, 'execute_next sizes ' + executes.join(', '));
    assert.equal(responses.at(-1)!.result.data.state, 'complete');
    for (const action of ['get', 'preflight', 'list'])
      assert.ok(bytes(await f.call('amcp_campaign', {action, id})) <= budget, action);
  } finally {
    f.close();
  }
});

test('every response of a 50-step plan fits 12 KB too', async () => {
  const {f, id, responses} = await measured(squadPlan(50));
  try {
    withinBudget(responses);
    assert.equal(responses.filter(r => r.action === 'execute_next').length, 50);
    assert.ok(bytes(await f.call('amcp_campaign', {action: 'get', id})) <= budget);
  } finally {
    f.close();
  }
});

test('get with detail "full" returns the whole stored plan, and every created resource ID is in the compact rows', async () => {
  const {f, id} = await measured(squadPlan(4));
  try {
    const full = (await f.call('amcp_campaign', {action: 'get', id, detail: 'full'})).data,
      compact = (await f.call('amcp_campaign', {action: 'get', id})).data;
    assert.equal(full.steps.length, 4);
    for (const s of full.steps) {
      assert.equal(s.status, 'verified');
      assert.ok(s.review.before_state, s.id + ' keeps its frozen review');
      assert.ok(s.result.data, s.id + ' keeps its receipt');
      assert.ok(s.verification.checks.length, s.id + ' keeps its verification');
    }
    assert.equal(full.execution_journal.length, 4);
    assert.deepEqual(
      compact.steps.map((s: JsonObject) => [s.id, s.resource_ids]),
      [
        ['campaign', ['camp1']],
        ['squad_1', ['squad1']],
        ['squad_2', ['squad2']],
        ['squad_3', ['squad3']],
      ],
    );
    // One step in full, without the rest.
    const one = (await f.call('amcp_campaign', {action: 'get', id, step_id: 'squad_2'})).data;
    assert.equal(one.step.id, 'squad_2');
    assert.ok(one.step.review.before_state && one.step.result.data && one.step.verification.checks);
    assert.equal(one.execution_journal.length, 1);
    assert.equal((await f.call('amcp_campaign', {action: 'get', id, step_id: 'nope'})).error.code, 'INVALID_ARGUMENT');
  } finally {
    f.close();
  }
});

test('the compact view: a header, one short row per step, the step this call acted on and the next call', async () => {
  const f = fixture();
  try {
    const created = await createPlan(f, squadPlan(3)),
      id = created.data.id;
    assert.deepEqual(Object.keys(created.data).sort(), [
      'id',
      'name',
      'plan_hash',
      'revision',
      'state',
      'steps',
      'view',
    ]);
    assert.equal(created.data.view, 'compact');
    assert.deepEqual(created.data.steps[1], {id: 'squad_1', kind: 'write', status: 'pending'});
    const prepared = (await f.call('amcp_campaign', {action: 'prepare_next', id})).data;
    assert.deepEqual(Object.keys(prepared).sort(), [
      'campaign_id',
      'execute_requirements',
      'next_call',
      'review',
      'revision',
      'step_id',
      'view',
    ]);
    // The review says what will be written and what was read, without the raw provider snapshots.
    const review = prepared.review;
    assert.equal(review.before_state, undefined);
    assert.equal(review.request.method, 'POST');
    assert.equal(review.request.body.campaigns[0].name, 'AMCP view test | campaign');
    assert.match(review.state_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(review.state_summary[0].read, 'GET /v1/adaccounts/acct1');
    assert.equal(review.state_summary[0].record.currency, 'USD');
    assert.deepEqual(review.detail, {tool: 'amcp_campaign', arguments: {action: 'get', id, step_id: 'campaign'}});
    const executed = (
      await f.call('amcp_campaign', {...prepared.next_call.arguments, ...prepared.next_call.add_after_user_approval})
    ).data;
    assert.deepEqual(Object.keys(executed).sort(), [
      'current',
      'id',
      'name',
      'next_call',
      'plan_hash',
      'revision',
      'state',
      'steps',
      'view',
    ]);
    assert.deepEqual(executed.steps[0], {
      id: 'campaign',
      kind: 'write',
      status: 'verified',
      resource_ids: ['camp1'],
      verification: 'verified',
    });
    // The step this call acted on keeps its receipt and verification.
    const current = executed.current;
    assert.equal(current.step_id, 'campaign');
    assert.equal(current.receipt.review_id, prepared.review.review_id);
    assert.equal(current.receipt.outcome, 'succeeded');
    assert.equal(current.receipt.data.campaigns[0].campaign.id, 'camp1');
    assert.equal(current.verification.status, 'verified');
    assert.equal(current.verification.checks[0].resource_id, 'camp1');
    assert.deepEqual(executed.next_call, {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id}});
  } finally {
    f.close();
  }
});

test('the compact view never omits the error of a failed step', async () => {
  const f = fixture({
    reject: body =>
      body.name.includes('squad 2')
        ? {request_status: 'ERROR', request_id: 'rx', debug_message: 'E2405: synthetic refusal of ad squad 2'}
        : undefined,
  });
  try {
    const created = await createPlan(f, squadPlan(4)),
      id = created.data.id;
    let last: JsonObject | undefined;
    for (let i = 0; i < 8; i++) {
      const prepared = await f.call('amcp_campaign', {action: 'prepare_next', id});
      if (!prepared.data?.review) break;
      last = await f.call('amcp_campaign', {
        ...prepared.data.next_call.arguments,
        ...prepared.data.next_call.add_after_user_approval,
      });
      if (last.data.current?.error) break;
    }
    const view = last!.data,
      failed = view.steps.find((s: JsonObject) => s.id === 'squad_2');
    assert.ok(['failed', 'uncertain'].includes(failed.status), failed.status);
    assert.equal(typeof failed.error, 'string');
    assert.equal(view.current.step_id, 'squad_2');
    assert.equal(view.current.error.code, failed.error);
    assert.ok(bytes(last) <= budget);
    // The plan's own get names the failed step's error as well.
    const got = (await f.call('amcp_campaign', {action: 'get', id})).data;
    assert.equal(got.steps.find((s: JsonObject) => s.id === 'squad_2').error, failed.error);
  } finally {
    f.close();
  }
});

test('responses stay compact when a step creates many resources or a review is large', async () => {
  const f = fixture();
  try {
    const big = squadStep(1, {}, {name: 'AMCP view test | ' + 'x'.repeat(300)}),
      created = await createPlan(f, [campaignStep(), big]);
    const responses = await runAll(f, created.data.id);
    withinBudget(responses);
    assert.equal(responses.at(-1)!.result.data.state, 'complete');
  } finally {
    f.close();
  }
});
