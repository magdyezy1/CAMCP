import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {budgetName, googleBudgetFixture} from './fixtures/google-budget-writes.mjs';

/**
 * r25-mf-groups, the audit of 2026-11-25, finding 2: the guard against creating twice dropped every completed claim whose receipt said `success: false`
 * ("a create the provider reported as failed made nothing"), so a create that was answered in part (7 of 10 made) or without confirming the created
 * objects (a 2xx whose reply lacks them) was forgotten, and the same request was sent again with no warning. That receipt does not say nothing was made:
 * the only create AMCP can say made nothing is one the provider refused with a proof (a definitive 4xx: its claim is rejected, its key retired, and it is
 * no earlier create: tests/write-duplicate-guard.test.mjs keeps that case as it was). A partial or unconfirmed one counts as an earlier create that
 * may exist, and warns, as a completed one does: the person may still want it again.
 */
const results = n => Array.from({length: n}, (_, i) => ({resourceName: budgetName(200 + i)}));
const answers = {
  'in part (7 of 10 made)': () => Response.json({results: results(7)}),
  'without the created objects (a 200 whose reply lacks them)': () => Response.json({}),
};
const claim = (f, id) =>
  f.store.db.prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?').get(f.actor.tenantId, id);

for (const [label, answer] of Object.entries(answers)) {
  test(
    'a create answered ' + label + ' may exist: an identical prepare warns, and the person may still want it',
    async () => {
      const f = googleBudgetFixture();
      try {
        const first = await f.creates(10, 5000000);
        f.hooks.respond = answer;
        const refused = await f.execute(first.data.review_id);
        f.hooks.respond = undefined;
        assert.equal(refused.error?.code, 'WRITE_PARTIAL_OR_FAILED', JSON.stringify(refused).slice(0, 400));
        assert.equal(claim(f, first.data.review_id).state, 'complete');
        assert.equal(JSON.parse(claim(f, first.data.review_id).result).outcome, 'partial_or_failed');
        const again = await f.creates(10, 5000000);
        assert.equal(again.success, true, 'a warning, not a refusal: ' + JSON.stringify(again).slice(0, 400));
        const warning = again.data.duplicate_warning;
        assert.ok(warning, 'the prepare carries a warning: ' + JSON.stringify(again.data).slice(0, 300));
        assert.equal(warning.earlier_review_id, first.data.review_id);
        assert.equal(warning.earlier_state, 'complete');
        assert.equal(warning.earlier_outcome, 'partial_or_failed');
        assert.equal(typeof warning.claimed_at, 'string');
        assert.match(warning.message, /in the last 24 hours only in part, or without confirming/);
        assert.match(warning.message, /may already exist/);
        // Another request is no repeat.
        assert.equal((await f.creates(10, 5000000, 'Other')).data.duplicate_warning, undefined);
        // The warning is what the guard asks for: the person who has seen it executes, and the create is sent again.
        const done = await f.execute(again.data.review_id);
        assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 400));
        assert.equal(f.writes.length, 2);
      } finally {
        f.close();
      }
    },
  );
}

test('an identical create prepared before a partial one was answered is refused at execute, nothing sent; prepared again it carries the warning', async () => {
  const f = googleBudgetFixture();
  try {
    const a = (await f.creates(10, 5000000)).data.review_id,
      b = await f.creates(10, 5000000);
    assert.equal(b.data.duplicate_warning, undefined, 'nothing had been answered when it was prepared');
    f.hooks.respond = answers['in part (7 of 10 made)'];
    assert.equal((await f.execute(a)).error?.code, 'WRITE_PARTIAL_OR_FAILED');
    f.hooks.respond = undefined;
    const refused = await f.execute(b.data.review_id);
    assert.equal(refused.error?.code, 'DUPLICATE_OF_COMPLETED_WRITE', JSON.stringify(refused).slice(0, 500));
    assert.equal(refused.error.details.submission, 'not_sent');
    assert.equal(refused.error.details.earlier_review_id, a);
    assert.equal(refused.error.details.earlier_outcome, 'partial_or_failed');
    assert.equal(f.writes.length, 1, 'the same request was not sent again');
    assert.equal(claim(f, b.data.review_id), undefined, 'its claim was not taken');
    const again = await f.write(refused.error.details.next_call.arguments);
    assert.equal(again.data.duplicate_warning.earlier_review_id, a);
    assert.equal((await f.execute(again.data.review_id)).success, true);
    assert.equal(f.writes.length, 2);
  } finally {
    f.close();
  }
});

// The Opus review of r25-mf-groups (S3-4; owner decision 2026-11-25): what a partial or unconfirmed create may have made is not known until someone looks,
// and a warning only asks the person, so it is warned about for 24 hours; a completed create, which made what it said, for ten minutes.
test('a partial create is warned about for 24 hours, a completed one for ten minutes', async () => {
  const f = googleBudgetFixture(),
    hour = 3600000,
    aged = (id, ms) =>
      f.store.db
        .prepare('UPDATE idempotency SET created_at=? WHERE tenant_id=? AND key=?')
        .run(Date.now() - ms, f.actor.tenantId, id);
  try {
    const partial = await f.creates(10, 5000000);
    f.hooks.respond = answers['in part (7 of 10 made)'];
    assert.equal((await f.execute(partial.data.review_id)).error?.code, 'WRITE_PARTIAL_OR_FAILED');
    f.hooks.respond = undefined;
    const completed = await f.creates(10, 5000000, 'Done');
    assert.equal((await f.execute(completed.data.review_id)).success, true);
    for (const [ms, warned] of [
      [11 * 60000, true],
      [23 * hour, true],
      [25 * hour, false],
    ]) {
      aged(partial.data.review_id, ms);
      const again = await f.creates(10, 5000000);
      assert.equal(
        again.data.duplicate_warning?.earlier_review_id,
        warned ? partial.data.review_id : undefined,
        'a partial create ' + Math.round(ms / 60000) + ' minutes old',
      );
    }
    // A completed create keeps its ten minutes: eleven minutes old, it is no earlier create (the case of write-duplicate-guard.test.mjs).
    aged(completed.data.review_id, 11 * 60000);
    assert.equal((await f.creates(10, 5000000, 'Done')).data.duplicate_warning, undefined);
  } finally {
    f.close();
  }
});

test('a review warned about a partial twin still executes once the twin is older than 24 hours: it is no reason to refuse', async () => {
  const f = googleBudgetFixture();
  try {
    const first = await f.creates(10, 5000000);
    f.hooks.respond = answers['in part (7 of 10 made)'];
    assert.equal((await f.execute(first.data.review_id)).error?.code, 'WRITE_PARTIAL_OR_FAILED');
    f.hooks.respond = undefined;
    const warned = await f.creates(10, 5000000);
    assert.ok(warned.data.duplicate_warning);
    f.store.db
      .prepare('UPDATE idempotency SET created_at=? WHERE tenant_id=? AND key=?')
      .run(Date.now() - 25 * 3600000, f.actor.tenantId, first.data.review_id);
    const done = await f.execute(warned.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 400));
    assert.equal(f.writes.length, 2);
  } finally {
    f.close();
  }
});

test('a group whose second part was answered in part warns on both parts when it is repeated, and says how the second ended', async () => {
  const f = googleBudgetFixture();
  try {
    const first = await f.creates(30, 5000000);
    assert.equal(first.data.group, true);
    // Part 1 (25) applies; part 2 (5) is answered with 3 results: the group stops at it.
    f.hooks.respond = () => (f.writes.length === 2 ? Response.json({results: results(3)}) : undefined);
    const stopped = await f.execute(first.data.review_id);
    f.hooks.respond = undefined;
    // The group stops at a part that was sent and not confirmed: its outcome is not known, whatever the part's own code.
    assert.equal(stopped.error?.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(stopped.error).slice(0, 400));
    assert.equal(stopped.error.details.part_error, 'WRITE_PARTIAL_OR_FAILED');
    assert.equal(f.writes.length, 2);
    const [one, two] = first.data.parts.map(p => p.review_id),
      again = await f.creates(30, 5000000);
    assert.equal(again.success, true, JSON.stringify(again).slice(0, 400));
    assert.deepEqual(again.data.duplicate_warning?.parts, [1, 2]);
    assert.equal(again.data.parts[0].duplicate_warning.earlier_review_id, one);
    assert.equal(again.data.parts[0].duplicate_warning.earlier_outcome, undefined, 'part 1 applied');
    assert.equal(again.data.parts[1].duplicate_warning.earlier_review_id, two);
    assert.equal(again.data.parts[1].duplicate_warning.earlier_outcome, 'partial_or_failed', 'part 2 did not');
  } finally {
    f.close();
  }
});

// The audit's own reproduction (Snapchat, two campaigns): a PARTIAL answer with one made, and a SUCCESS answer whose second campaign has no id.
const actor = {tenantId: 't', userId: 'owner', role: 'admin'};
async function snapchat(respond) {
  const store = new Store(':memory:', Buffer.alloc(32, 70).toString('base64'));
  store.putConnection(
    actor,
    {
      id: 'login',
      tenantId: 't',
      gateway: 'snapchat_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'S',
      scopes: [],
    },
    {accessToken: 'x'},
  );
  let writes = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (input, init) => {
        if (init.method !== 'GET') {
          writes++;
          return respond(JSON.parse(init.body));
        }
        const id = new URL(String(input)).pathname.split('/').at(-1);
        return new Response(
          JSON.stringify({
            request_status: 'SUCCESS',
            adaccounts: [
              {sub_request_status: 'SUCCESS', adaccount: {id, name: 'a', status: 'ACTIVE', currency: 'USD'}},
            ],
          }),
        );
      },
      undefined,
      30000,
      8388608,
      1000,
      1,
    ),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  const campaign = name => ({name, ad_account_id: '123', status: 'PAUSED', start_time: '2027-01-01T00:00:00Z'}),
    prepare = () =>
      service.call(
        'amcp_write',
        {
          action: 'prepare',
          gateway: 'snapchat_native_action',
          arguments: {
            action: 'snapchat_campaign_create',
            account_id: '123',
            payload: {campaigns: [campaign('A'), campaign('B')]},
          },
        },
        actor,
      ),
    execute = review =>
      service.call(
        'amcp_write',
        {action: 'execute', review_id: review.data.review_id, confirmed: true, spend_change_confirmed: true},
        actor,
      );
  return {store, prepare, execute, writes: () => writes};
}
const made = (id, name) => ({
  sub_request_status: 'SUCCESS',
  campaign: {id, name, ad_account_id: '123', status: 'PAUSED'},
});
for (const [label, body] of Object.entries({
  'a PARTIAL answer with one of two made': {
    request_status: 'PARTIAL',
    campaigns: [
      made('11111111-1111-4111-8111-111111111111', 'A'),
      {sub_request_status: 'ERROR', sub_request_error_reason: 'x'},
    ],
  },
  'a SUCCESS answer whose second campaign has no id': {
    request_status: 'SUCCESS',
    campaigns: [
      made('11111111-1111-4111-8111-111111111111', 'A'),
      {sub_request_status: 'SUCCESS', campaign: {name: 'B'}},
    ],
  },
}))
  test('Snapchat: ' + label + ' is an earlier create that may exist, and the same request warns', async () => {
    const s = await snapchat(() => new Response(JSON.stringify(body)));
    try {
      const first = await s.prepare();
      assert.equal((await s.execute(first)).error?.code, 'WRITE_PARTIAL_OR_FAILED');
      const again = await s.prepare();
      assert.equal(again.success, true, JSON.stringify(again).slice(0, 400));
      assert.equal(again.data.duplicate_warning?.earlier_review_id, first.data.review_id);
      assert.equal(again.data.duplicate_warning.earlier_outcome, 'partial_or_failed');
      assert.equal(s.writes(), 1);
    } finally {
      s.store.close();
    }
  });
