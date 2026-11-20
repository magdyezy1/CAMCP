// QA-03: the browser fixture's synthetic-writes mode (owner decision D26), checked over the fixture's own HTTP website
// without a browser. The fake provider accepts only the mutation routes it declares and counts them apart from provider
// writes; the provider-write counter the rendered runner requires to stay zero is unchanged and still catches any other
// mutation. Every request stays inside this process: the website is loopback and the provider is an in-process fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import {browserWorkflowSite, syntheticWriteKinds} from './fixtures/browser-workflow-sites.mjs';
import {syntheticMutationGuard} from './fixtures/synthetic-writes-data.mjs';

const call = async (site, tool, body) => {
  const response = await fetch(site.origin + '/api/workspace/' + tool, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: site.origin,
      'x-amcp-csrf': site.csrf,
      cookie: site.cookie.name + '=' + site.cookie.value,
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
};

test('the write journey meets accepted, uncertain and refused outcomes with synthetic writes only (QA-03)', async t => {
  const site = await browserWorkflowSite('write-journey');
  t.after(() => site.close());
  assert.equal(site.syntheticWrites, true);
  const expected = {
    accepted: {status: 'verified', synthetic: 1},
    uncertain: {status: 'uncertain', code: 'WRITE_OUTCOME_UNCERTAIN', synthetic: 2},
    // R25 M1 (r25-m1-diff, L5-04): a step whose review the state check refused is sent back to pending, unsent, with the
    // refusal on it (it ended failed before, which the website offered to "correct" as a broken step). Nothing else changed.
    refused: {status: 'pending', code: 'STATE_CHANGED', synthetic: 2},
  };
  for (const [outcome, want] of Object.entries(expected)) {
    const id = await site.writeJourney.seed(outcome),
      prepared = await call(site, 'campaign', {action: 'prepare_next', id, detail: 'full'});
    assert.equal(prepared.success, true, JSON.stringify(prepared.error));
    const review = prepared.data.review;
    assert.equal(review.execute_requirements.spend_change_confirmed, false, 'a paused create needs only consent');
    if (outcome === 'refused') site.writeJourney.changeAccountState();
    const executed = await call(site, 'campaign', {
      action: 'execute_next',
      id,
      review_id: review.review_id,
      idempotency_key: review.idempotency_key,
      confirmed: true,
    });
    assert.equal(executed.success, true, JSON.stringify(executed.error));
    const step = executed.data.steps.find(s => s.id === 'campaign');
    assert.equal(step.status, want.status, outcome);
    if (want.code) assert.equal(step.error, want.code, outcome);
    assert.deepEqual(
      {synthetic: site.counts().syntheticWrites, writes: site.counts().writes, refused: site.counts().refused},
      {synthetic: want.synthetic, writes: 0, refused: 0},
      outcome,
    );
  }
});

// The rendered runner opens one site per kind and runs the three journeys once for each case (two languages, two
// widths). A second run's create must not repeat the first run's, which is still uncertain: M2's guard (L5-06) would
// refuse it at prepare as DUPLICATE_OF_UNCERTAIN_WRITE, and the case would never reach its review (gate r25-m2, step 5).
test('a second run of the uncertain journey on one site prepares a review, not a duplicate refusal', async t => {
  const site = await browserWorkflowSite('write-journey');
  t.after(() => site.close());
  for (const run of [1, 2]) {
    const id = await site.writeJourney.seed('uncertain'),
      prepared = await call(site, 'campaign', {action: 'prepare_next', id, detail: 'full'});
    assert.equal(prepared.success, true, JSON.stringify(prepared.error));
    assert.equal(
      typeof prepared.data.review?.review_id,
      'string',
      'run ' + run + ': ' + JSON.stringify(prepared.data).slice(0, 600),
    );
    const executed = await call(site, 'campaign', {
      action: 'execute_next',
      id,
      review_id: prepared.data.review.review_id,
      idempotency_key: prepared.data.review.idempotency_key,
      confirmed: true,
    });
    assert.equal(executed.data.steps.find(s => s.id === 'campaign').status, 'uncertain', 'run ' + run);
  }
});

// R2.5 M3 (r25-m3-dupstep): the rendered journey's duplicate phase seeds a plan whose create is identical to the uncertain journey's. The
// default names stay unique per seed (the test above); `identicalTo` repeats the create of the latest seed of an outcome. Checked here over
// the fixture's own HTTP website without a browser: the guard against creating twice refuses the repeat at prepare, and the plan holds the
// step pending, with the plan that holds the earlier create named, instead of failing it.
test('a seed that repeats the uncertain journey’s create is held at prepare as a twin of the uncertain one, and nothing is sent (M3)', async t => {
  const site = await browserWorkflowSite('write-journey');
  t.after(() => site.close());
  const first = await site.writeJourney.seed('uncertain'),
    prepared = await call(site, 'campaign', {action: 'prepare_next', id: first, detail: 'full'});
  assert.equal(prepared.success, true, JSON.stringify(prepared.error));
  const executed = await call(site, 'campaign', {
    action: 'execute_next',
    id: first,
    review_id: prepared.data.review.review_id,
    idempotency_key: prepared.data.review.idempotency_key,
    confirmed: true,
  });
  assert.equal(executed.data.steps.find(s => s.id === 'campaign').status, 'uncertain');
  const written = site.counts();
  const repeat = await site.writeJourney.seed('uncertain', {identicalTo: 'uncertain'});
  assert.notEqual(repeat, first, 'a plan of its own');
  const held = await call(site, 'campaign', {action: 'prepare_next', id: repeat, detail: 'full'});
  assert.equal(held.success, true, JSON.stringify(held.error));
  assert.equal(held.data.review, undefined, 'no review: the guard refused the prepare');
  const step = held.data.steps.find(s => s.id === 'campaign');
  assert.equal(step.status, 'pending', 'the step waits: it is not failed');
  assert.equal(step.error.code, 'DUPLICATE_OF_UNCERTAIN_WRITE');
  assert.equal(step.error.details.earlier_plan_id, first, 'it names the plan that holds the earlier create');
  assert.equal(held.data.blocked, undefined);
  assert.equal(site.counts().syntheticWrites, written.syntheticWrites, 'nothing was sent');
  assert.equal(site.counts().writes, 0);
  // A seed without the option is a create of its own, which prepares a review even while the first is uncertain.
  const other = await site.writeJourney.seed('uncertain'),
    review = await call(site, 'campaign', {action: 'prepare_next', id: other, detail: 'full'});
  assert.equal(typeof review.data.review?.review_id, 'string', JSON.stringify(review.data).slice(0, 400));
  // A repeat names an earlier seed: one that was never made is refused by the fixture, not seeded as a create of its own.
  await assert.rejects(site.writeJourney.seed('accepted', {identicalTo: 'refused'}), /no earlier refused seed/i);
});

test('a mutation outside the declared synthetic routes is a provider write and is refused', async t => {
  const site = await browserWorkflowSite('write-journey');
  t.after(() => site.close());
  const before = site.counts();
  for (const [url, method] of [
    ['https://graph.facebook.com/v26.0/act_999/campaigns', 'POST'],
    ['https://graph.facebook.com/v26.0/act_123/adsets', 'POST'],
    ['https://graph.facebook.com/v26.0/act_123/campaigns', 'DELETE'],
    ['https://synthetic-provider.example.test/v26.0/act_123/campaigns', 'POST'],
  ])
    await assert.rejects(site.writeJourney.transport(url, {method, body: 'name=x'}), /refuses a provider mutation/);
  assert.equal(site.counts().writes - before.writes, 4);
  assert.equal(site.counts().syntheticWrites, before.syntheticWrites, 'refused mutations are never synthetic writes');
});

test('kinds without synthetic-writes mode never report synthetic writes', async t => {
  const site = await browserWorkflowSite('empty');
  t.after(() => site.close());
  assert.equal(site.syntheticWrites, false);
  assert.equal(site.writeJourney, undefined);
  assert.deepEqual(site.counts(), {nativeReads: 0, refused: 0, writes: 0, syntheticWrites: 0});
  assert.deepEqual(syntheticWriteKinds, ['write-journey', 'spend-policy-edit', 'export-outcomes']);
});

test('the synthetic route guard needs exact anchored mutation routes on one https origin', () => {
  for (const route of [
    {method: 'GET', origin: 'https://graph.facebook.com', path: /^\/x$/},
    {method: 'POST', origin: 'http://graph.facebook.com', path: /^\/x$/},
    {method: 'POST', origin: 'https://graph.facebook.com/v26.0', path: /^\/x$/},
    {method: 'POST', origin: 'https://graph.facebook.com', path: /\/x/},
    {method: 'POST', origin: 'https://graph.facebook.com', path: '/x'},
  ])
    // The guard's own assertion refuses the route, never a crash.
    assert.throws(() => syntheticMutationGuard([route]), {code: 'ERR_ASSERTION'});
  const accept = syntheticMutationGuard([{method: 'POST', origin: 'https://graph.facebook.com', path: /^\/x$/}]);
  assert.equal(accept(new URL('https://graph.facebook.com/x'), 'POST'), true);
  assert.equal(accept(new URL('https://graph.facebook.com/x/y'), 'POST'), false);
  assert.equal(accept(new URL('https://graph.facebook.com.example.test/x'), 'POST'), false);
  assert.equal(accept(new URL('https://graph.facebook.com/x'), 'PUT'), false);
});

test('export outcomes: the newer snapshot completes and the older one is superseded without a write (QA-03)', async t => {
  const site = await browserWorkflowSite('export-outcomes');
  t.after(() => site.close());
  const {older, newer, destination} = site.exportOutcomes.seed();
  const exportAndRun = async report_id => {
    const queued = await call(site, 'overview', {
      action: 'export',
      report_id,
      destination_id: destination,
      confirmed: true,
    });
    assert.equal(queued.success, true, JSON.stringify(queued.error));
    assert.equal(await site.exportOutcomes.workOnce(), true);
    const status = await call(site, 'overview', {action: 'export_status', id: queued.data.id});
    assert.equal(status.success, true, JSON.stringify(status.error));
    return status.data;
  };
  const complete = await exportAndRun(newer);
  assert.deepEqual([complete.state, complete.outcome], ['complete', 'complete']);
  assert.equal(site.exportOutcomes.tab.report, newer);
  const written = site.counts().syntheticWrites;
  assert.ok(written >= 1);
  const superseded = await exportAndRun(older);
  assert.deepEqual([superseded.state, superseded.outcome], ['complete', 'superseded']);
  assert.equal(site.exportOutcomes.tab.report, newer, 'the tab keeps the newer snapshot');
  assert.equal(site.counts().syntheticWrites, written, 'a superseded export writes nothing');
  assert.equal(site.counts().writes, 0);
});

test('the spending-policy fixture starts each journey from the seeded policy at the next revision', async t => {
  const site = await browserWorkflowSite('spend-policy-edit');
  t.after(() => site.close());
  const first = await site.spendPolicy.reset(),
    second = await site.spendPolicy.reset();
  assert.equal(second.revision, first.revision + 1);
  for (const [field, value] of Object.entries({
    enforcement: 'block',
    max_budget_increase_percent: 20,
    max_budget_native: 10000,
    max_daily_increase_native: 5000,
    max_bid_native: 500,
    allow_activation: false,
    allow_deletion: false,
  }))
    assert.equal(second[field], value, field);
  assert.deepEqual(site.counts(), {nativeReads: 0, refused: 0, writes: 0, syntheticWrites: 0});
});
