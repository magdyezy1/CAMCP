import test from 'node:test';
import assert from 'node:assert/strict';
import {googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {createPlan, on} from './helpers/google-policy-failure.mjs';
import {keywordAction, keywordWorld, keywords} from './helpers/google-keyword-group.mjs';

/**
 * r25-field3-errors, the third re-review of 2026-11-22 (N3-c, S3): the status of a plan-held review that expired names the plan's own call (prepare_next
 * for the step's review or group, the read of the step for a part of its group: the second re-review, N3-b), but the refusal of a direct `amcp_write
 * execute` of that review still named a standalone prepare of the request, the 5 records, the whole 30 or the part's 25. A review prepared that way is held
 * by no step: executed, it is a second change beside the plan's own. The refusal names the call the status names. A review no plan holds keeps its prepare.
 * Synthetic customer 123; a plan of keywords, which the owner's policy does not govern, so a direct execute reaches the refusal.
 */
const T = 'google-world',
  step = operations => ({
    id: 'step1',
    kind: 'write',
    gateway: 'google_ads_native_action',
    connection_id: 'g',
    account_id: '123',
    description: 'step1',
    arguments: {action: 'google_ads_v23_' + keywordAction, payload: {operations}},
  }),
  stored = (x, id) => x.store.document(T, 'campaign_run', id),
  direct = (x, review_id) =>
    x.call('amcp_write', {
      action: 'execute',
      review_id,
      idempotency_key: review_id,
      confirmed: true,
      spend_change_confirmed: true,
    }),
  statusOf = async (x, id) => (await x.call('amcp_write', {action: 'status', review_id: id})).data,
  getStep = id => ({tool: 'amcp_campaign', arguments: {action: 'get', id, step_id: 'step1'}}),
  prepareNext = id => ({tool: 'amcp_campaign', arguments: {action: 'prepare_next', id}}),
  isGroup = (x, id) => !!x.store.db.prepare("SELECT 1 FROM documents WHERE kind='write_review_group' AND id=?").get(id),
  /** The window of a review, or of the group and each part, ended. */
  expire = (x, review, parts) => {
    for (const [kind, id] of [
      [isGroup(x, review) ? 'write_review_group' : 'write_review', review],
      ...parts.map(p => ['write_review', p]),
    ]) {
      const doc = x.store.document(T, kind, id);
      x.store.putDocument(T, kind, id, {...doc, expires_at: 1});
    }
  },
  planned = async n => {
    const x = googleWorld({policy: on, world: keywordWorld()}),
      id = await createPlan(x, [step(keywords(n))]);
    assert.equal((await x.call('amcp_campaign', {action: 'prepare_next', id})).success, true);
    const review = stored(x, id).steps[0].review_id,
      parts = isGroup(x, review) ? x.store.document(T, 'write_review_group', review).parts : [];
    return {x, id, review, parts};
  };

for (const [label, n] of [
  ['a single review', 5],
  ['a write group of 30 and each of its parts', 30],
])
  test(
    'REVIEW_EXPIRED of a plan’s ' + label + ' names the plan’s call the status names, not a standalone prepare',
    async () => {
      const {x, id, review, parts} = await planned(n);
      try {
        expire(x, review, parts);
        // The review itself (a single review, or the group): the plan prepares it again.
        const refused = await direct(x, review);
        assert.equal(refused.error?.code, 'REVIEW_EXPIRED', JSON.stringify(refused.error ?? refused).slice(0, 300));
        assert.deepEqual(refused.error.details.next_call, prepareNext(id), 'the plan’s prepare_next');
        assert.deepEqual(
          refused.error.details.next_call,
          (await statusOf(x, review)).next_call,
          'the call its status names',
        );
        // A part of the group: the step is read in its plan.
        for (const part of parts) {
          const late = await direct(x, part);
          assert.equal(late.error?.code, 'REVIEW_EXPIRED', JSON.stringify(late.error ?? late).slice(0, 300));
          assert.deepEqual(late.error.details.next_call, getStep(id), 'the read of the step');
          assert.deepEqual(late.error.details.next_call, (await statusOf(x, part)).next_call);
        }
        assert.equal(x.writes(), 0, 'nothing was sent');
        for (const response of [refused])
          assert.ok(!JSON.stringify(response.error.details).includes('"action":"prepare"'));
      } finally {
        x.store.close();
      }
    },
  );

test('a plan’s write group with too little of its window left names the plan’s call too, and keeps what it says of the time', async () => {
  const {x, id, review, parts} = await planned(30);
  try {
    const group = x.store.document(T, 'write_review_group', review);
    x.store.putDocument(T, 'write_review_group', review, {
      ...group,
      slowest_prepare_ms: 20000,
      expires_at: Date.now() + 60000,
    });
    const second = x.store.document(T, 'write_review', parts[1]);
    x.store.putDocument(T, 'write_review', parts[1], {...second, expires_at: Date.now() + 20000});
    const short = await direct(x, review);
    assert.equal(short.error?.code, 'REVIEW_EXPIRED', JSON.stringify(short.error ?? short).slice(0, 300));
    assert.match(short.error.message, /Too little of the review window is left/);
    assert.deepEqual(short.error.details.next_call, prepareNext(id));
    assert.equal(short.error.details.part, 2, 'the part that is short of time is still named');
    assert.ok(short.error.details.needed_seconds > 0);
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});

test('STATE_CHANGED of a plan’s review, group or part, executed directly, names the plan’s call the status names too', async () => {
  for (const n of [5, 30]) {
    const {x, id, review, parts} = await planned(n);
    try {
      for (const k of Object.keys(x.world.campaigns)) x.world.campaigns[k].status = 'ENABLED';
      for (const k of Object.keys(x.world.adGroups)) x.world.adGroups[k].status = 'ENABLED';
      const refused = await direct(x, parts[0] ?? review);
      assert.equal(refused.error?.code, 'STATE_CHANGED', JSON.stringify(refused.error ?? refused).slice(0, 300));
      assert.deepEqual(refused.error.details.next_call, (await statusOf(x, parts[0] ?? review)).next_call);
      assert.ok(!JSON.stringify(refused.error.details.next_call).includes('"prepare"'), 'no standalone prepare');
      if (parts.length) {
        const group = await direct(x, review);
        assert.equal(group.error?.code, 'STATE_CHANGED', JSON.stringify(group.error ?? group).slice(0, 300));
        assert.deepEqual(group.error.details.next_call, (await statusOf(x, review)).next_call);
        assert.equal(group.error.details.next_call.arguments.action, 'execute_next');
        assert.equal(group.error.details.next_call.arguments.id, id);
      }
      assert.equal(x.writes(), 0);
    } finally {
      x.store.close();
    }
  }
});

test('a review or a group no plan holds keeps the standalone prepare in the refusal, and its status', async () => {
  const x = googleWorld({policy: on, world: keywordWorld()});
  try {
    for (const n of [5, 30]) {
      const prepared = await x.prepare(keywordAction, keywords(n)),
        review = prepared.data.review_id,
        parts = (prepared.data.parts ?? []).map(p => p.review_id);
      expire(x, review, parts);
      for (const id of [review, ...parts]) {
        const refused = await direct(x, id);
        assert.equal(refused.error?.code, 'REVIEW_EXPIRED', JSON.stringify(refused.error ?? refused).slice(0, 300));
        assert.equal(refused.error.details.next_call.tool, 'amcp_write');
        assert.equal(refused.error.details.next_call.arguments.action, 'prepare');
        assert.deepEqual(refused.error.details.next_call, (await statusOf(x, id)).next_call);
      }
    }
  } finally {
    x.store.close();
  }
});
