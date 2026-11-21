import test from 'node:test';
import assert from 'node:assert/strict';
import {stable} from '../dist/src/security.js';
import {amendmentCall} from '../dist/src/campaign-amendment.js';
import {planViewBudget} from '../dist/src/campaign-view.js';
import {googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {
  action,
  createPlan,
  expectedRow,
  on,
  planStep,
  rejecting,
  signals,
  world,
} from './helpers/google-policy-failure.mjs';

/**
 * r25-field3-errors (AMCP-11, the owner's report of 2026-11-21): `get` with a step_id returned the stored step whole, about 56,000 characters
 * for a Performance Max build: the request body three times (the step's arguments, its resolved copy and the review's request), the before
 * state, the provider's reply, and no error. The default step view leaves the request body out (sizes and hashes), carries the last error with
 * the provider's rows, the receipt and the verification, and stays within the plan views' 11 KB. One part comes only on request, in pages of at
 * most 24 KB or as the subtree of a JSON pointer, and `detail: "full"` keeps the old whole step for a step of 30 KB or less. tools/list is not
 * touched: the opt-in reuses `topic` (the part), `query` (the pointer) and `cursor`. Synthetic customer 123 throughout.
 */
const kb = 1024,
  size = value => Buffer.byteLength(JSON.stringify(value));
const stored = (x, id) => x.store.document('google-world', 'campaign_run', id);
const get = (x, id, extra = {}, actor) =>
  actor
    ? x.service.call('amcp_campaign', {action: 'get', id, step_id: 'signals', ...extra}, actor)
    : x.call('amcp_campaign', {action: 'get', id, step_id: 'signals', ...extra});
/** A request of about 60 KB: sixty-six operations of a build, each of some 900 bytes. */
const bigBody = () => ({
  mutate_operations: Array.from({length: 66}, (_, i) => ({
    asset_group_signal_operation: {
      create: {
        asset_group: 'customers/123/assetGroups/200',
        search_theme: {text: 'synthetic theme ' + i},
        notes: 'n'.repeat(820),
      },
    },
  })),
});
/**
 * A plan with one write step, saved by the service (so its hash is right), whose stored step is then given what a verified build of the owner's
 * size holds: the request three times (arguments, resolved, review.request), a before state, the provider's reply and a read-back of 300 checks.
 * Nothing but the review, the result, the verification and the copies that the plan's hash does not read is changed.
 */
async function bigStep(options = {}) {
  const x = googleWorld({policy: on, world: world()}),
    id = await createPlan(x, [planStep()]),
    {id: _id, revision, ...run} = stored(x, id),
    body = options.body ?? bigBody();
  Object.assign(run.steps[0], {
    status: 'verified',
    resolved: {action: 'google_ads_v23_' + action, payload: body},
    review_id: 'review-1',
    review: {
      review_id: 'review-1',
      idempotency_key: 'review-1',
      expires_at: new Date(Date.now() + 300000).toISOString(),
      summary: {operation: 'create', entity: 'asset group signals', count: 66},
      effects: {destructive: false},
      execute_requirements: {confirmed: true, spend_change_confirmed: false},
      state_hash: 'a'.repeat(64),
      state_reads: Array.from({length: 30}, (_, i) => ({
        method: 'POST',
        path: '/v25/customers/123/googleAds:search' + i,
      })),
      request: {method: 'POST', path: '/v25/customers/123/googleAds:mutate', body, headers: options.headers ?? {}},
      before_state: [{results: Array.from({length: 40}, (_, i) => ({row: i, text: 'b'.repeat(900)}))}],
      provider_check: {status: 'provider_validated', checked_at: 1},
    },
    result: {
      success: true,
      outcome: 'succeeded',
      review_id: 'review-1',
      headers: {'x-synthetic': '1'},
      fingerprint: 'f'.repeat(64),
      data: {mutateOperationResponses: Array.from({length: 40}, (_, i) => ({row: i, name: 'r'.repeat(700)}))},
    },
    verification: {
      status: 'verified',
      checked_at: 1,
      checks: Array.from({length: 300}, (_, i) => ({
        resource_id: 'customers/123/assetGroupSignals/' + i,
        status: 'verified',
        diff: {field: 'x'.repeat(60)},
      })),
    },
    native_requests: {prepare: {reads: 3, writes: 0}, execute: {reads: 0, writes: 1}},
    previous_attempts: Array.from({length: 5}, (_, i) => ({
      at: i,
      review_id: 'old-' + i,
      error: {code: 'PROVIDER_VALIDATION_FAILED'},
      previous_arguments: {payload: body},
      patch: [{path: '/payload/x' + i, from: 'a', to: 'b'}],
    })),
  });
  x.store.putDocument('google-world', 'campaign_run', id, run, revision);
  return {x, id, body};
}

test('the default step view of a build of 60 KB leaves the request body out, keeps the receipt and the verification, and fits 11 KB', async () => {
  const {x, id} = await bigStep();
  try {
    const whole = stored(x, id).steps[0];
    assert.ok(size(whole) > 150 * kb, 'the stored step is large: ' + size(whole));
    const out = await get(x, id);
    assert.equal(out.success, true, JSON.stringify(out).slice(0, 600));
    const view = out.data;
    assert.ok(size(out.data) <= planViewBudget, 'the view is ' + size(out.data) + ' bytes');
    assert.ok(size(out) <= 12 * kb, 'the answer is ' + size(out) + ' bytes');
    assert.equal(view.view, 'step');
    const step = view.step;
    assert.equal(step.id, 'signals');
    assert.equal(step.status, 'verified');
    assert.equal(step.gateway, 'google_ads_native_action');
    assert.equal(step.account_id, '123');
    assert.equal(step.action, 'google_ads_v23_' + action);
    // The bodies are sizes and hashes.
    assert.deepEqual(Object.keys(step.arguments).sort(), ['bytes', 'sha256']);
    assert.equal(step.arguments.bytes, size(whole.arguments));
    assert.match(step.arguments.sha256, /^[0-9a-f]{64}$/);
    assert.equal(step.resolved, undefined);
    assert.equal(step.review.request.body, undefined);
    assert.equal(step.review.request.method, 'POST');
    assert.equal(step.review.request.path, '/v25/customers/123/googleAds:mutate');
    assert.equal(step.review.request.body_bytes, size(whole.review.request.body));
    assert.equal(step.review.before_state, undefined);
    assert.equal(step.review.review_id, 'review-1');
    assert.equal(step.review.state_reads.length, 20, 'at most 20 state reads');
    assert.deepEqual(Object.keys(step.review.state_reads[0]).sort(), ['method', 'path']);
    assert.equal(step.review.provider_check.status, 'provider_validated');
    // The receipt and the verification are there, the provider's reply is a size.
    assert.equal(step.receipt.outcome, 'succeeded');
    assert.equal(step.receipt.data, undefined);
    assert.ok(step.receipt.data_omitted_bytes > 20 * kb);
    assert.equal(step.verification.status, 'verified');
    assert.deepEqual(step.native_requests, whole.native_requests);
    // The earlier attempts: the last three, without their bodies, and how many there were.
    assert.equal(step.previous_attempts.length, 3);
    assert.deepEqual(Object.keys(step.previous_attempts[0]).sort(), [
      'at',
      'error_code',
      'patch_paths',
      'previous_arguments',
      'review_id',
    ]);
    assert.deepEqual(step.previous_attempts[0].patch_paths, ['/payload/x2']);
    assert.deepEqual(Object.keys(step.previous_attempts[0].previous_arguments).sort(), ['bytes', 'sha256']);
    assert.equal(step.previous_attempts_count, 5);
    assert.equal(view.execution_journal.length, 1);
    // What was left out is one call away.
    for (const part of ['request', 'arguments', 'before_state', 'receipt'])
      assert.deepEqual(step.include[part].arguments, {action: 'get', id, step_id: 'signals', topic: part}, part);
    assert.ok(!JSON.stringify(view).includes('nnnnnnnn'), 'no body text is in the view');
  } finally {
    x.store.close();
  }
});

test('a step the provider rejected at validate-only carries last_error with the rows, and its view holds no provider answer', async () => {
  const x = rejecting();
  try {
    const id = await createPlan(x, [planStep()]);
    await x.call('amcp_campaign', {action: 'prepare_next', id});
    const step = (await get(x, id)).data.step;
    assert.equal(step.status, 'failed');
    assert.equal(step.submission, 'not_submitted');
    assert.equal(step.last_error.code, 'PROVIDER_VALIDATION_FAILED');
    assert.equal(step.last_error.category, 'request');
    assert.match(step.last_error.remedy.action, /details\.provider_errors/);
    assert.deepEqual(step.last_error.details.provider_errors, [expectedRow]);
    assert.deepEqual(step.last_error.details.field_paths, ['operations[0].create.search_theme.text']);
    assert.equal(step.last_error.details.provider_message, 'The search theme violates a policy.');
    assert.equal(step.last_error.details.http_status, 400);
    assert.equal(step.last_error.details.review_id, step.review.review_id);
    assert.equal(step.review.provider_check.status, 'provider_rejected');
    assert.equal(step.review.provider_check.response, undefined);
    assert.deepEqual(step.review.provider_check.provider_errors, [expectedRow]);
    assert.equal(step.error, undefined, 'the stored error is not repeated beside last_error');
  } finally {
    x.store.close();
  }
});

test('detail full returns a small step whole, as it always did, and a large one as the default view with the size it left out', async () => {
  const small = googleWorld({policy: on, world: world()});
  try {
    const id = await createPlan(small, [planStep()]);
    await small.call('amcp_campaign', {action: 'prepare_next', id});
    const out = await get(small, id, {detail: 'full'}),
      stepAsStored = stored(small, id).steps[0];
    assert.deepEqual(out.data.step, stepAsStored, 'the step whole, byte for byte');
    assert.equal(out.data.full_omitted_bytes, undefined);
  } finally {
    small.store.close();
  }
  const {x, id} = await bigStep();
  try {
    const out = await get(x, id, {detail: 'full'}),
      whole = stored(x, id).steps[0];
    assert.ok(size(out) <= 30 * kb, 'the answer is ' + size(out) + ' bytes');
    assert.equal(out.data.full_omitted_bytes, size(whole));
    assert.deepEqual(Object.keys(out.data.step.arguments).sort(), ['bytes', 'sha256']);
    assert.deepEqual(out.data.step.include.request.arguments.topic, 'request');
    // The whole plan with detail full is unchanged: the website reads it.
    const plan = (await x.call('amcp_campaign', {action: 'get', id, detail: 'full'})).data;
    assert.equal(plan.steps[0].review.request.body.mutate_operations.length, 66);
  } finally {
    x.store.close();
  }
});

/** The pages of one part, in order, from the first call to the last. */
async function pages(x, id, extra) {
  const out = [];
  let cursor;
  for (let i = 0; i < 40; i++) {
    const page = await get(x, id, {...extra, ...(cursor ? {cursor} : {})});
    assert.equal(page.success, true, JSON.stringify(page).slice(0, 500));
    assert.ok(size(page) <= 24 * kb, 'a page is ' + size(page) + ' bytes');
    out.push(page);
    cursor = page.data.next_cursor;
    if (!cursor) return out;
  }
  assert.fail('more than 40 pages');
}

test('topic request pages reassemble to the stored request byte for byte, none over 24 KB, and a pointer returns one operation', async () => {
  const {x, id, body} = await bigStep();
  try {
    const request = stored(x, id).steps[0].review.request,
      list = await pages(x, id, {topic: 'request'});
    assert.ok(list.length >= 3, 'a request of 60 KB is several pages: ' + list.length);
    assert.equal(list[0].data.part, 'request');
    assert.equal(list[0].data.pages, list.length);
    assert.deepEqual(
      list.map(p => p.data.page),
      list.map((_, i) => i + 1),
    );
    assert.equal(list.at(-1).data.next_cursor, undefined);
    const text = list.map(p => p.data.text).join('');
    assert.equal(text, stable(request), 'byte for byte, in canonical form');
    assert.deepEqual(JSON.parse(text), request);
    // The operation a field path of the error names, by its JSON pointer.
    const one = await get(x, id, {topic: 'request', query: '/body/mutate_operations/34'});
    assert.equal(one.success, true, JSON.stringify(one).slice(0, 500));
    assert.equal(one.data.pointer, '/body/mutate_operations/34');
    assert.equal(one.data.pages, 1);
    assert.deepEqual(JSON.parse(one.data.text), body.mutate_operations[34]);
    // The other parts, whole: the step's arguments, its before state, its receipt.
    assert.deepEqual(
      JSON.parse((await pages(x, id, {topic: 'arguments'})).map(p => p.data.text).join('')),
      stored(x, id).steps[0].arguments,
    );
    assert.equal(
      (await pages(x, id, {topic: 'before_state'})).map(p => p.data.text).join(''),
      stable(stored(x, id).steps[0].review.before_state),
    );
    assert.equal(
      (await pages(x, id, {topic: 'receipt'})).map(p => p.data.text).join(''),
      stable(stored(x, id).steps[0].result),
    );
  } finally {
    x.store.close();
  }
});

test('an opt-in that cannot be answered is refused with its own message: an unknown part, a missing pointer, a part the step lacks', async () => {
  const {x, id} = await bigStep();
  try {
    const unknown = await get(x, id, {topic: 'requests'});
    assertRefused(unknown, 'INVALID_ARGUMENT');
    assert.deepEqual(unknown.error.details.allowed, ['request', 'arguments', 'before_state', 'receipt']);
    assertRefused(await get(x, id, {topic: 'request', query: '/body/nothing/here'}), 'INVALID_ARGUMENT');
    assertRefused(await get(x, id, {topic: 'request', query: 'body'}), 'INVALID_ARGUMENT');
    // A step that has no request yet (nothing prepared) has nothing to read.
    const fresh = googleWorld({policy: on, world: world()}),
      freshId = await createPlan(fresh, [planStep()]);
    assertRefused(await get(fresh, freshId, {topic: 'request'}), 'INVALID_ARGUMENT');
    fresh.store.close();
  } finally {
    x.store.close();
  }
});

test('the opt-in is a read of the plan: another person’s plan is refused as get is, a cursor from another revision is refused, and nothing is sent', async () => {
  const {x, id} = await bigStep();
  try {
    const first = await get(x, id, {topic: 'request'}),
      cursor = first.data.next_cursor;
    assert.ok(cursor);
    // Another person, in the same workspace, with no right to the plan.
    const other = {tenantId: 'google-world', userId: 'someone-else', role: 'operator'};
    assertRefused(await get(x, id, {topic: 'request'}, other), 'FORBIDDEN');
    // The plan moved on (its revision changed): the cursor of the earlier read is no continuation of it.
    const {id: _id, revision, ...run} = stored(x, id);
    x.store.putDocument('google-world', 'campaign_run', id, {...run, name: 'DNU renamed'}, revision);
    assertRefused(await get(x, id, {topic: 'request', cursor}), 'INVALID_CURSOR');
    // A cursor of another part is no continuation either.
    const again = await get(x, id, {topic: 'request'});
    assertRefused(await get(x, id, {topic: 'arguments', cursor: again.data.next_cursor}), 'INVALID_CURSOR');
    assert.equal(x.writes() + x.validations(), 0);
  } finally {
    x.store.close();
  }
});

test('credential-shaped values are hidden in what a part returns, as in the review, and the answer says where', async () => {
  const secret = 'abcdefghij0123456789klmnopqrstuv',
    {x, id} = await bigStep({
      body: {mutate_operations: [{note: 'synthetic'}]},
      headers: {Authorization: 'Bearer ' + secret},
    });
  try {
    const out = await get(x, id, {topic: 'request'});
    assert.equal(out.success, true, JSON.stringify(out).slice(0, 500));
    assert.ok(!JSON.stringify(out).includes(secret), 'the secret is not in the answer');
    assert.match(out.data.text, /\[REDACTED\]/);
    assert.deepEqual(out.data.redacted, [{path: '$["headers"]["Authorization"]'}]);
  } finally {
    x.store.close();
  }
});

test('a correction template is labelled a correction and bounded: the arguments are repeated up to 4 KB, and above it only their size and the call that reads them', () => {
  const step = args => ({id: 's1', kind: 'write', arguments: args}),
    error = {code: 'PROVIDER_VALIDATION_FAILED', details: {field_paths: ['operations[0].create.x']}};
  const small = amendmentCall('plan-1', step({payload: {name: 'x'}}), error);
  assert.equal(small.kind, 'correction');
  assert.deepEqual(small.arguments, {action: 'recover_step', id: 'plan-1', step_id: 's1', confirmed: true});
  assert.deepEqual(small.add_after_correction, {arguments: {payload: {name: 'x'}}});
  const big = {payload: {name: 'x'.repeat(5000)}},
    large = amendmentCall('plan-1', step(big), error);
  assert.equal(large.kind, 'correction');
  assert.equal(large.add_after_correction.arguments, undefined, 'the step is not repeated');
  assert.equal(large.add_after_correction.arguments_omitted.bytes, size(big));
  assert.match(large.add_after_correction.arguments_omitted.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(large.add_after_correction.arguments_omitted.read, {
    tool: 'amcp_campaign',
    arguments: {action: 'get', id: 'plan-1', step_id: 's1', topic: 'arguments'},
  });
  assert.match(large.add_after_correction.arguments_omitted.how, /patch/);
  assert.equal(large.correct, small.correct, 'the sentence a person reads is the same');
  assert.ok(size(large) < 1200, 'the template is small: ' + size(large));
  // A refusal that names a field to choose keeps its own shape, and is a correction too.
  const choice = amendmentCall(
    'plan-1',
    {id: 's1', kind: 'write', arguments: {payload: {adsquads: [{pixel_id: 'p1'}]}}},
    {code: 'SNAPCHAT_PIXEL_NOT_OWNED', details: {pixel_ids: ['p1'], owned_pixel_ids: ['p2']}},
  );
  assert.equal(choice.kind, 'correction');
  assert.equal(choice.add_after_user_choice.patch[0].path, '/payload/adsquads/0/pixel_id');
});

test('the default view of a step that holds a build and a verification larger than the budget degrades but keeps the error and the rows', async () => {
  const {x, id} = await bigStep();
  try {
    // 5,000 checks of a read-back: more than any view holds, and the answer stays within the view's budget.
    const {id: _id, revision, ...run} = stored(x, id);
    run.steps[0].verification.checks = Array.from({length: 5000}, (_, i) => ({
      resource_id: 'customers/123/assetGroupSignals/' + i,
      status: i === 7 ? 'mismatch' : 'verified',
      diff: {field: 'y'.repeat(80)},
    }));
    run.steps[0].error = {
      code: 'PROVIDER_VALIDATION_FAILED',
      message: 'm',
      category: 'request',
      remedy: {action: 'a'},
      details: {provider_errors: [expectedRow], field_paths: ['operations[0].create.x']},
    };
    x.store.putDocument('google-world', 'campaign_run', id, run, revision);
    const out = await get(x, id);
    assert.ok(size(out.data) <= planViewBudget, 'the view is ' + size(out.data) + ' bytes');
    assert.deepEqual(out.data.step.last_error.details.provider_errors, [expectedRow]);
    assert.equal(out.data.step.verification.status, 'verified');
    assert.ok(JSON.stringify(out.data.step.verification).includes('mismatch'), 'the check that did not match stays');
  } finally {
    x.store.close();
  }
});
