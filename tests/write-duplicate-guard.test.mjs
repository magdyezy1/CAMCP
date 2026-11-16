import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {at, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {requestIdentity} from '../dist/src/write-duplicates.js';

/**
 * R2.5 M2 (L5-06, owner 2026-11-15: fail closed on an uncertain write): a create whose response was lost may have made its
 * object, so preparing the same create again could make a second one. At prepare, a create identical to one that is uncertain
 * or still being sent (same gateway, account, action and request, minus the keys that differ between two prepares) is refused
 * with DUPLICATE_OF_UNCERTAIN_WRITE, naming the earlier review and the call that settles it. The existing
 * `supersedes_review_id` is the override: it names the one earlier review the new one replaces, which cannot then also run.
 * Within ten minutes of an identical create that completed, the prepare answers with a warning instead.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

const lost = () => {
  throw new TypeError('synthetic lost response');
};

test('two creates are one request only when gateway, account, action, method, path, query and body match; the keys that differ between prepares do not tell them apart', () => {
  const plan = {
    gateway: 'meta_native_action',
    accountId: 'act_1',
    action: 'meta_campaign_create',
    method: 'POST',
    path: '/v26.0/act_1/campaigns',
    query: {},
    body: {name: 'A', daily_budget: 500, request_id: 'r1', nested: {session_id: 9, keep: 1}},
  };
  const same = {
    ...plan,
    accountId: '1',
    body: {nested: {keep: 1, session_id: 10}, daily_budget: 500, name: 'A', request_id: 'r2', idempotencyKey: 'k'},
  };
  assert.equal(requestIdentity(plan), requestIdentity(same), 'request ids, sessions and key order do not matter');
  const changed = {
    gateway: {gateway: 'tiktok_native_action'},
    account: {accountId: '2'},
    action: {action: 'meta_adset_create'},
    method: {method: 'PUT'},
    path: {path: '/v26.0/act_1/adsets'},
    query: {query: {debug: 'true'}},
    body: {body: {...plan.body, daily_budget: 600}},
    'a nested value': {body: {...plan.body, nested: {session_id: 9, keep: 2}}},
  };
  for (const [label, change] of Object.entries(changed))
    assert.notEqual(requestIdentity({...plan, ...change}), requestIdentity(plan), label);
});
const reviews = f => f.store.db.prepare("SELECT count(*) AS n FROM documents WHERE kind='write_review'").get().n;
/** Prepares a one-budget create and executes it with its response lost: the budget was not made, and the key is uncertain. */
async function uncertain(f, amount = 5000000) {
  const prepared = await f.creates(1, amount);
  assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 500));
  f.hooks.respond = lost;
  const refused = await f.execute(prepared.data.review_id);
  f.hooks.respond = undefined;
  assert.equal(refused.error?.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(refused).slice(0, 500));
  return prepared.data.review_id;
}
const reconcile = (f, id) => f.write({action: 'reconcile', review_id: id});

test('a create identical to an uncertain one is refused at prepare, naming that review and the call that settles it', async () => {
  const f = googleBudgetFixture();
  try {
    const id = await uncertain(f);
    const before = {reviews: reviews(f), requests: f.requests.length};
    const again = await f.creates(1, 5000000);
    assert.equal(again.error?.code, 'DUPLICATE_OF_UNCERTAIN_WRITE', JSON.stringify(again).slice(0, 700));
    const details = again.error.details;
    assert.equal(details.earlier_review_id, id);
    assert.equal(details.earlier_state, 'uncertain');
    assert.equal(details.next_call.tool, 'amcp_write');
    assert.equal(details.next_call.arguments.review_id, id);
    assert.ok(['status', 'reconcile'].includes(details.next_call.arguments.action), JSON.stringify(details.next_call));
    assert.match(again.error.message, /supersedes_review_id/, 'it says how to go on');
    // Nothing was stored or read for the refused prepare.
    assert.equal(reviews(f), before.reviews, 'no review was saved');
    assert.equal(f.requests.length, before.requests, 'no provider request was made');
  } finally {
    f.close();
  }
});

test('a create that differs in its request, and an identical update, are not duplicates', async () => {
  const f = googleBudgetFixture();
  try {
    await uncertain(f);
    // Another amount, another number of budgets: other creates.
    assert.equal((await f.creates(1, 6000000)).success, true, 'another amount');
    assert.equal((await f.creates(2, 5000000)).success, true, 'two budgets');
    // An update that repeats itself is harmless: only a create can make a second object.
    const update = await f.update(100000000);
    f.hooks.respond = lost;
    assert.equal((await f.execute(update.data.review_id)).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
    f.hooks.respond = undefined;
    const again = await f.update(100000000);
    assert.equal(again.success, true, JSON.stringify(again).slice(0, 500));
  } finally {
    f.close();
  }
});

test('a create still being sent counts as unresolved, and is named with the status call', async () => {
  const f = googleBudgetFixture();
  try {
    const prepared = await f.creates(1, 5000000);
    let release;
    const gate = new Promise(resolve => (release = resolve));
    f.hooks.beforeWrite = () => gate;
    const running = f.execute(prepared.data.review_id);
    while (f.writes.length === 0) await new Promise(resolve => setTimeout(resolve, 5));
    const again = await f.creates(1, 5000000);
    assert.equal(again.error?.code, 'DUPLICATE_OF_UNCERTAIN_WRITE', JSON.stringify(again).slice(0, 700));
    assert.equal(again.error.details.earlier_state, 'executing');
    assert.deepEqual(again.error.details.next_call, {
      tool: 'amcp_write',
      arguments: {action: 'status', review_id: prepared.data.review_id},
    });
    release();
    assert.equal((await running).success, true);
    f.hooks.beforeWrite = undefined;
  } finally {
    f.close();
  }
});

test('supersedes_review_id replaces the one earlier create it names, records it, and the old one cannot also run', async () => {
  const f = googleBudgetFixture();
  try {
    const id = await uncertain(f);
    const found = await reconcile(f, id);
    assert.equal(found.data.classification, 'appears_not_applied', JSON.stringify(found.data));
    const replacement = await f.write(found.data.next_call.arguments);
    assert.equal(replacement.success, true, JSON.stringify(replacement).slice(0, 700));
    assert.equal(replacement.data.supersedes_uncertain, id, 'the new review records which one it replaces');
    assert.equal((await f.execute(id)).error?.code, 'WRITE_OUTCOME_UNCERTAIN', 'the old one is never sent');
    assert.equal(f.writes.length, 1, 'only the lost write was ever sent');
    const done = await f.execute(replacement.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 500));
    // The replaced review no longer holds anything unresolved: a later identical create is a warning only.
    const later = await f.creates(1, 5000000);
    assert.equal(later.success, true, JSON.stringify(later).slice(0, 500));
    assert.ok(later.data.duplicate_warning, 'the completed replacement is warned about');
    assert.equal(later.data.duplicate_warning.earlier_review_id, replacement.data.review_id);
  } finally {
    f.close();
  }
});

test('supersedes_review_id excuses the review it names and no other: a second unresolved identical create still refuses', async () => {
  const f = googleBudgetFixture();
  try {
    // Both are prepared before either is sent, so neither is refused at prepare. Only the first is executed, and ends uncertain: the
    // second is refused at execute (the execute-time guard, R2.5 M2 rework S2-1). A second unresolved identical create can then exist only
    // as one claimed before that guard did: a legacy double, written here as the claim a pre-guard execute would have left.
    const first = (await f.creates(1, 5000000)).data.review_id,
      second = (await f.creates(1, 5000000)).data.review_id;
    f.hooks.respond = lost;
    assert.equal((await f.execute(first)).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
    f.hooks.respond = undefined;
    f.store.db
      .prepare("INSERT INTO idempotency(tenant_id,key,fingerprint,state,created_at) VALUES(?,?,?,'uncertain',?)")
      .run(f.actor.tenantId, second, 'legacy', Date.now());
    const found = await reconcile(f, first);
    assert.equal(found.data.classification, 'appears_not_applied', JSON.stringify(found.data));
    const refused = await f.write(found.data.next_call.arguments);
    assert.equal(refused.error?.code, 'DUPLICATE_OF_UNCERTAIN_WRITE', JSON.stringify(refused).slice(0, 700));
    assert.equal(refused.error.details.earlier_review_id, second, 'it names the one it was not told about');
  } finally {
    f.close();
  }
});

test('an identical create that completed in the last ten minutes is a warning, and an older one is not', async () => {
  const f = googleBudgetFixture();
  try {
    const first = await f.creates(1, 5000000);
    assert.equal((await f.execute(first.data.review_id)).success, true);
    const again = await f.creates(1, 5000000);
    assert.equal(again.success, true, 'a warning, not a refusal: ' + JSON.stringify(again).slice(0, 400));
    const warning = again.data.duplicate_warning;
    assert.ok(warning, 'the response carries a warning');
    assert.equal(warning.earlier_review_id, first.data.review_id);
    assert.equal(warning.earlier_state, 'complete');
    assert.match(warning.message, /second/);
    assert.equal(typeof warning.claimed_at, 'string');
    // A create that is not identical is no warning, and neither is one from more than ten minutes ago.
    assert.equal((await f.creates(1, 7000000)).data.duplicate_warning, undefined);
    f.store.db
      .prepare('UPDATE idempotency SET created_at=? WHERE tenant_id=? AND key=?')
      .run(Date.now() - 11 * 60000, f.actor.tenantId, first.data.review_id);
    assert.equal((await f.creates(1, 5000000)).data.duplicate_warning, undefined, 'eleven minutes old');
  } finally {
    f.close();
  }
});

// A create the provider refused (a 400, whose claim is retired) and one it answered without confirming it (a 200 whose
// reply lacks the created resource, which AMCP records as complete with success false) both made nothing.
for (const [label, answer, code] of [
  [
    'refused with a 400',
    () => Response.json({error: {code: 400, status: 'INVALID_ARGUMENT', message: 'refused'}}, {status: 400}),
    'UPSTREAM_ERROR',
  ],
  ['answered without confirming it', () => Response.json({}), 'WRITE_PARTIAL_OR_FAILED'],
])
  test('a create the provider ' + label + ' is no earlier create to warn about', async () => {
    const f = googleBudgetFixture();
    try {
      const first = await f.creates(1, 5000000);
      f.hooks.respond = answer;
      const refused = await f.execute(first.data.review_id);
      f.hooks.respond = undefined;
      assert.equal(refused.error?.code, code, JSON.stringify(refused).slice(0, 400));
      const again = await f.creates(1, 5000000);
      assert.equal(again.success, true, JSON.stringify(again).slice(0, 500));
      assert.equal(again.data.duplicate_warning, undefined);
    } finally {
      f.close();
    }
  });

test('another member’s unresolved create refuses without naming their review; an administrator is told which', async () => {
  const f = googleBudgetFixture({role: 'operator'});
  try {
    const id = await uncertain(f);
    const member = {tenantId: f.actor.tenantId, userId: 'member', role: 'operator'},
      admin = {tenantId: f.actor.tenantId, userId: 'administrator', role: 'admin'};
    const prepare = who =>
      f.call(
        'amcp_write',
        {
          action: 'prepare',
          gateway: 'google_ads_native_action',
          connection_id: 'g',
          arguments: {
            action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
            account_id: '123',
            payload: {
              operations: [{create: {name: 'Synthetic 0', amountMicros: '5000000', deliveryMethod: 'STANDARD'}}],
            },
          },
        },
        who,
      );
    const hidden = await prepare(member);
    assert.equal(hidden.error?.code, 'DUPLICATE_OF_UNCERTAIN_WRITE', JSON.stringify(hidden).slice(0, 700));
    assert.equal(hidden.error.details.earlier_review_id, undefined, 'a colleague’s review is not named');
    assert.equal(hidden.error.details.next_call, undefined);
    assert.equal(hidden.error.details.readable, false);
    assert.ok(!JSON.stringify(hidden).includes(id), 'the review id appears nowhere in the refusal');
    const told = await prepare(admin);
    assert.equal(told.error?.code, 'DUPLICATE_OF_UNCERTAIN_WRITE', JSON.stringify(told).slice(0, 700));
    assert.equal(told.error.details.earlier_review_id, id);
  } finally {
    f.close();
  }
});

test('a build is a create too: an identical build is refused while the earlier one is uncertain, though the summary calls it a change', async () => {
  const f = googleReconcileFixture();
  try {
    const operations = [
      {
        campaign_budget_operation: {
          create: {
            resource_name: at('campaignBudgets', '-1'),
            name: 'Guarded budget',
            amount_micros: '40000000',
            delivery_method: 'STANDARD',
          },
        },
      },
      {
        campaign_operation: {
          create: {
            resource_name: at('campaigns', '-2'),
            name: 'Guarded campaign',
            status: 'PAUSED',
            advertising_channel_type: 'SEARCH',
            campaign_budget: at('campaignBudgets', '-1'),
            manual_cpc: {},
            network_settings: {target_google_search: true, target_search_network: false, target_content_network: false},
            contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          },
        },
      },
    ];
    const action = 'google_ads_v23_google_ads_mutate';
    const {id} = await f.lose(action, {mutate_operations: operations}, {applied: false});
    const again = await f.prepare(action, {mutate_operations: operations});
    assert.equal(again.error?.code, 'DUPLICATE_OF_UNCERTAIN_WRITE', JSON.stringify(again).slice(0, 700));
    assert.equal(again.error.details.earlier_review_id, id);
  } finally {
    f.close();
  }
});
