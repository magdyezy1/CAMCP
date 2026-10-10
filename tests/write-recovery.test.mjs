import test from 'node:test';
import assert from 'node:assert/strict';
import {gateway, account, budgetAction, budgetName, googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {MirrorError} from '../dist/src/errors.js';

/**
 * WRT-08: standalone reviewed writes are recoverable without the conversation that made them. Before, a review
 * prepared with amcp_write had no record outside the chat: Operations listed 0 rows for it, a lost response left
 * WRITE_OUTCOME_UNCERTAIN with no next call, and nothing could tell whether the change landed. Now each standalone
 * review is retained work (kind `write`), `status` reads it back with no provider request, and `reconcile` classifies an
 * uncertain write with read-only lookups. Nothing is ever sent again, and the key stays uncertain until the user accepts.
 */
const lost = () => {
  throw new TypeError('synthetic lost response');
};
function strip(doc) {
  const {id: _id, revision: _revision, ...data} = doc;
  return data;
}
async function quick(fn) {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
  try {
    return await fn();
  } finally {
    delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
    delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
  }
}
const writes = async (f, who = f.actor) => {
  const page = await f.call('amcp_workspace', {action: 'operations', kind: 'write', limit: 100}, who);
  assert.equal(page.success, true, JSON.stringify(page).slice(0, 800));
  return page.data.operations;
};
const status = (f, id, who = f.actor) => f.call('amcp_write', {action: 'status', review_id: id}, who);

test('standalone reviews are retained work: each state has its category for its owner, and is hidden from other members and revoked accounts', async () => {
  const f = googleBudgetFixture();
  const member = {tenantId: f.actor.tenantId, userId: 'member', role: 'operator'};
  try {
    const prepared = (await f.update(100000000)).data.review_id;
    const expired = (await f.update(110000000)).data.review_id;
    const doc = f.store.document(f.actor.tenantId, 'write_review', expired);
    f.store.putDocument(f.actor.tenantId, 'write_review', expired, {...strip(doc), expires_at: Date.now() - 1000});
    const uncertain = (await f.update(120000000)).data.review_id;
    f.hooks.respond = lost;
    assert.equal((await f.execute(uncertain)).error.code, 'WRITE_OUTCOME_UNCERTAIN');
    f.hooks.respond = undefined;
    const complete = (await f.update(130000000)).data.review_id;
    assert.equal((await f.execute(complete)).success, true);

    const rows = await writes(f);
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    assert.deepEqual(
      [prepared, expired, uncertain, complete].map(id => [byId[id]?.state, byId[id]?.category]),
      [
        ['unsubmitted', 'attention'],
        ['expired', 'attention'],
        ['uncertain', 'attention'],
        ['complete', 'complete'],
      ],
    );
    for (const row of rows) {
      assert.equal(row.kind, 'write');
      assert.deepEqual(row.next_call, {tool: 'amcp_write', arguments: {action: 'status', review_id: row.id}});
      assert.equal(row.website_path, '/operations?write_id=' + row.id);
      assert.equal(row.automatic_retry_of_mutation, false);
      assert.deepEqual(row.accounts, [account]);
    }
    // Metadata only: no frozen request body, receipt or provider text.
    const text = JSON.stringify(rows);
    for (const leaked of ['amountMicros', '120000000', 'resourceName', 'synthetic lost response'])
      assert.equal(text.includes(leaked), false, leaked);
    // The attention filter keeps exactly the three that need a person.
    const attention = await f.call('amcp_workspace', {action: 'operations', state: 'attention', limit: 100});
    assert.deepEqual(
      attention.data.operations
        .filter(o => o.kind === 'write')
        .map(o => o.id)
        .sort(),
      [prepared, expired, uncertain].sort(),
    );
    // Another member sees none of them, and cannot read their status.
    assert.deepEqual(await writes(f, member), []);
    const foreign = await status(f, uncertain, member);
    assert.equal(foreign.error.code, 'FORBIDDEN');
    // A revoked account hides them, also from their owner.
    f.store.putConnection(
      f.actor,
      {
        id: 'g',
        tenantId: f.actor.tenantId,
        gateway,
        accounts: ['999'],
        writeAccounts: [],
        enabled: true,
        label: 'Synthetic Google Ads',
        scopes: ['https://www.googleapis.com/auth/adwords'],
      },
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
    assert.deepEqual(await writes(f), []);
    assert.equal((await status(f, uncertain)).success, false);
  } finally {
    f.close();
  }
});

test('a revoked actor sees no write records', async () => {
  const f = googleBudgetFixture();
  try {
    await f.update(100000000);
    assert.equal((await writes(f)).length, 1);
    const revoked = {...f.actor};
    f.store.bindActorCheck(revoked, () => {
      throw new MirrorError('ACCOUNT_ACCESS_REVOKED', 'Synthetic revocation.', {}, 401);
    });
    const page = await f.call('amcp_workspace', {action: 'operations', kind: 'write'}, revoked);
    assert.equal(page.success, false);
    assert.equal(page.error.code, 'ACCOUNT_ACCESS_REVOKED');
  } finally {
    f.close();
  }
});

test('reviews a campaign plan prepares for its steps stay with the plan and are not listed as standalone writes', async () => {
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
    const prepared = await f.call('amcp_campaign', {action: 'prepare_next', id: created.data.id});
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 600));
    const review = f.store.document(f.actor.tenantId, 'write_review', prepared.data.review.review_id);
    assert.equal(review.origin, 'plan');
    assert.deepEqual(await writes(f), []);
    const standalone = (await f.update(100000000)).data.review_id;
    assert.equal(f.store.document(f.actor.tenantId, 'write_review', standalone).origin, 'standalone');
    assert.deepEqual(
      (await writes(f)).map(r => r.id),
      [standalone],
    );
  } finally {
    f.close();
  }
});

test('a group is one retained write; its parts are not listed on their own, and status lists them', async () => {
  const f = googleBudgetFixture();
  try {
    const group = await f.creates(30, 1000000);
    assert.equal(group.data.group, true, JSON.stringify(group).slice(0, 400));
    const rows = await writes(f);
    assert.deepEqual(
      rows.map(r => r.id),
      [group.data.review_id],
    );
    assert.equal(rows[0].state, 'unsubmitted');
    const s = await status(f, group.data.review_id);
    assert.equal(s.data.record_kind, 'write_review_group');
    assert.deepEqual(
      s.data.parts.map(p => [p.part, p.state]),
      [
        [1, 'unsubmitted'],
        [2, 'unsubmitted'],
      ],
    );
    assert.equal(s.meta.workflow.website_path, '/operations?write_id=' + group.data.review_id);
  } finally {
    f.close();
  }
});

test('a review kept before origins were recorded is listed only while uncertain and named by no plan or group', async () => {
  const f = googleBudgetFixture();
  try {
    const id = (await f.update(100000000)).data.review_id;
    f.hooks.respond = lost;
    await f.execute(id);
    f.hooks.respond = undefined;
    const {
      origin: _origin,
      principal: _principal,
      ...legacy
    } = strip(f.store.document(f.actor.tenantId, 'write_review', id));
    f.store.putDocument(f.actor.tenantId, 'write_review', id, legacy);
    assert.deepEqual(
      (await writes(f)).map(r => [r.id, r.state]),
      [[id, 'uncertain']],
    );
    // A legacy review that a plan step names belongs to that plan.
    f.store.putDocument(f.actor.tenantId, 'campaign_run', 'legacy-plan', {
      user_id: f.actor.userId,
      steps: [{id: 'a', review_id: id}],
    });
    assert.deepEqual(await writes(f), []);
  } finally {
    f.close();
  }
});

test('the Meta lookup of a create matches the frozen name created after the claim', async () => {
  const {findCreated} = await import('../dist/src/write-reconciliation.js');
  const plan = {
    gateway: 'meta_native_action',
    accountId: 'act_1',
    method: 'POST',
    path: '/v25.0/act_1/campaigns',
    query: {},
    headers: {},
    body: {name: 'Launch', objective: 'OUTCOME_SALES', status: 'PAUSED'},
    action: 'meta_campaign_create',
    warnings: [],
  };
  const lookup = findCreated(plan);
  assert.equal(lookup.reads.length, 1);
  assert.equal(lookup.reads[0].method, 'GET');
  assert.equal(lookup.reads[0].readOnly, true);
  assert.deepEqual(JSON.parse(lookup.reads[0].query.filtering), [{field: 'name', operator: 'EQUAL', value: 'Launch'}]);
  const claimed = Date.parse('2026-10-10T10:00:00Z');
  const rows = data => [{data: {data}}];
  const recent = {id: '9', name: 'Launch', created_time: '2026-10-10T10:00:05+0000'};
  const older = {id: '8', name: 'Launch', created_time: '2026-10-01T10:00:00+0000'};
  const one = lookup.match(rows([recent, older]), claimed);
  assert.deepEqual(
    one.found.map(f => f.id),
    ['9'],
  );
  assert.deepEqual(lookup.receipt(one.found), {id: '9'});
  assert.deepEqual(lookup.match(rows([older]), claimed).found, []);
  assert.equal(lookup.match(rows([recent, {...recent, id: '10'}]), claimed).found.length, 2, 'ambiguous');
  // An update is no create: its target is named, and the verification read contract reads it.
  assert.equal(findCreated({...plan, path: '/v25.0/123'}), undefined);
});

test('prepare names its retained record and an execute call that leaves every acknowledgement to the user', async () => {
  const f = googleBudgetFixture();
  try {
    const review = await f.update(100000000);
    const workflow = review.meta.workflow;
    assert.equal(workflow.state, 'review_required');
    assert.equal(workflow.review_id, review.data.review_id);
    assert.equal(workflow.expires_at, review.data.expires_at);
    assert.equal(workflow.website_path, '/operations?write_id=' + review.data.review_id);
    assert.deepEqual(workflow.next_call.arguments, {action: 'execute', review_id: review.data.review_id});
    assert.equal(workflow.next_call.add_after_user_approval.confirmed, true);
    assert.equal(workflow.next_call.add_after_user_approval.spend_change_confirmed, true);
    assert.ok(workflow.required_acknowledgements.includes('spend_change_confirmed'));
    // inspect saves nothing and names no record.
    const inspected = await f.write({
      action: 'inspect',
      gateway,
      arguments: {
        action: budgetAction,
        account_id: account,
        payload: {
          operations: [{update: {resourceName: budgetName(1), amountMicros: '1'}, updateMask: 'amount_micros'}],
        },
      },
    });
    assert.equal(inspected.meta.workflow, undefined);
  } finally {
    f.close();
  }
});

test('status reads a review back with zero provider requests, the same fingerprint and expiry, and no secrets', async () => {
  const f = googleBudgetFixture();
  try {
    const review = await f.update(100000000),
      id = review.data.review_id,
      before = f.requests.length;
    const s = await status(f, id);
    assert.equal(s.success, true, JSON.stringify(s).slice(0, 600));
    assert.equal(f.requests.length, before, 'status sends nothing to the provider');
    assert.equal(s.data.network_requests, 0);
    assert.equal(s.data.fingerprint, review.data.fingerprint);
    assert.equal(s.data.expires_at, review.data.expires_at);
    assert.equal(s.data.state, 'unsubmitted');
    assert.equal(s.data.claim.state, 'none');
    assert.deepEqual(s.data.next_call.arguments, {action: 'execute', review_id: id});
    assert.equal(s.data.next_call.add_after_user_approval.spend_change_confirmed, true);
    assert.equal(s.meta.workflow.state, 'review_required');
    const text = JSON.stringify(s);
    for (const secret of ['accessToken', 'developerToken', 'access_token', '"synthetic"'])
      assert.equal(text.includes(secret), false, secret);
    assert.equal(text.includes('payload'), false, 'no request body');
    assert.deepEqual(s.data.suggested_reads[0], {method: 'POST', path: s.data.suggested_reads[0].path});
  } finally {
    f.close();
  }
});

test('a dispatched write whose response was lost shows uncertain; its next calls only read, and nothing is sent again', async () => {
  const f = googleBudgetFixture();
  try {
    const id = (await f.update(100000000)).data.review_id;
    f.hooks.respond = lost;
    const failed = await f.execute(id);
    f.hooks.respond = undefined;
    assert.equal(failed.success, false);
    assert.deepEqual(failed.error.details.next_call, {
      tool: 'amcp_write',
      arguments: {action: 'status', review_id: id},
    });
    const uncertain = f.audit().find(e => e.event === 'write_uncertain');
    assert.equal(uncertain.gateway, gateway, 'the uncertain audit names its scope');
    assert.equal(uncertain.account_id, account);
    assert.equal(uncertain.connection_id, 'g');
    const s = await status(f, id);
    assert.equal(s.data.state, 'uncertain');
    assert.equal(s.data.claim.state, 'uncertain');
    assert.deepEqual(s.data.next_call, {tool: 'amcp_write', arguments: {action: 'reconcile', review_id: id}});
    assert.equal(s.meta.workflow.state, 'attention_required');
    // Too early: nothing read, nothing sent.
    const reads = f.requests.length;
    const early = await f.write({action: 'reconcile', review_id: id});
    assert.equal(early.error.code, 'RECONCILIATION_TOO_EARLY');
    assert.ok(early.error.details.retry_after_ms > 0);
    assert.equal(f.requests.length, reads);
    // The reconciliation reads only.
    await quick(async () => {
      const r = await f.write({action: 'reconcile', review_id: id});
      assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
      assert.equal(r.data.mutation_requests, 0);
      assert.ok(r.data.network_requests > 0);
    });
    assert.ok(
      f.requests.slice(reads).every(r => r.endsWith('/googleAds:search')),
      'reconciliation only searches: ' + f.requests.slice(reads),
    );
    assert.equal(f.writes.length, 1, 'never sent again');
    assert.equal(f.claim(id).state, 'uncertain', 'the key stays uncertain until the user accepts');
    assert.equal((await f.execute(id)).error.code, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(f.writes.length, 1);
  } finally {
    f.close();
  }
});

test('an update that landed before its response was lost appears applied; accepting records the observed receipt and verify reads it back', async () => {
  const f = googleBudgetFixture();
  try {
    const id = (await f.update(100000000)).data.review_id;
    f.hooks.respond = body => {
      const op = body.operations[0].update;
      f.budgets.set(op.resourceName ?? op.resource_name, String(op.amountMicros ?? op.amount_micros));
      throw new TypeError('applied, then the response was lost');
    };
    await f.execute(id);
    f.hooks.respond = undefined;
    const r = await quick(() => f.write({action: 'reconcile', review_id: id}));
    assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data));
    assert.deepEqual(r.data.observed_ids, [budgetName(1)]);
    assert.equal(r.data.next_call.add_after_user_approval.accept_applied, true);
    assert.equal(r.meta.workflow.state, 'review_required');
    assert.equal(f.claim(id).state, 'uncertain');
    // The user accepts the outcome they saw; a different reconciliation is refused.
    const wrong = await f.write({action: 'reconcile', review_id: id, accept_applied: true, reconciliation_id: 'x'});
    assert.equal(wrong.error.code, 'RECONCILIATION_CHANGED');
    const accepted = await f.write({
      action: 'reconcile',
      review_id: id,
      accept_applied: true,
      reconciliation_id: r.data.reconciliation_id,
    });
    assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 800));
    assert.equal(accepted.data.state, 'reconciled');
    assert.equal(accepted.data.receipt.reconciled, true);
    assert.equal(f.claim(id).state, 'complete');
    assert.ok(f.audit().some(e => e.event === 'write_reconciled' && e.review_id === id));
    // Execute replays the reconciled receipt and sends nothing.
    const replay = await f.execute(id);
    assert.equal(replay.data.replayed, true);
    assert.equal(f.writes.length, 1);
    const verified = await f.call('amcp_campaign', {action: 'verify', review_id: id});
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified).slice(0, 800));
    const [row] = await writes(f);
    assert.equal(row.state, 'verified');
    assert.equal(row.category, 'complete');
  } finally {
    f.close();
  }
});

test('an update that did not land appears not applied; a replacement records supersedes_uncertain and the old key is never sent', async () => {
  const f = googleBudgetFixture();
  try {
    const id = (await f.update(100000000)).data.review_id;
    f.hooks.respond = lost;
    await f.execute(id);
    f.hooks.respond = undefined;
    const r = await quick(() => f.write({action: 'reconcile', review_id: id}));
    assert.equal(r.data.classification, 'appears_not_applied', JSON.stringify(r.data));
    assert.equal(r.data.state_unchanged_since_review, true);
    assert.equal(r.data.next_call.arguments.supersedes_review_id, id);
    const refused = await f.write({
      action: 'reconcile',
      review_id: id,
      accept_applied: true,
      reconciliation_id: r.data.reconciliation_id,
    });
    assert.equal(refused.error.code, 'RECOVERY_NOT_SAFE');
    const replacement = await f.write(r.data.next_call.arguments);
    assert.equal(replacement.success, true, JSON.stringify(replacement).slice(0, 800));
    assert.equal(replacement.data.supersedes_uncertain, id);
    const old = await status(f, id);
    assert.equal(old.data.state, 'superseded');
    assert.equal(old.data.reconciliation.superseded_by, replacement.data.review_id);
    assert.equal(f.claim(id).state, 'uncertain', 'the old key is never reset');
    assert.equal((await f.execute(id)).error.code, 'WRITE_OUTCOME_UNCERTAIN');
    const done = await f.execute(replacement.data.review_id);
    assert.equal(done.success, true);
    assert.equal(f.writes.length, 2, 'the old request once, the replacement once');
    assert.equal(f.budgets.get(budgetName(1)), '100000000');
    const rows = Object.fromEntries((await writes(f)).map(o => [o.id, o]));
    assert.equal(rows[id].category, 'complete');
    // A review that is not uncertain cannot be replaced this way.
    const again = await f.write({...r.data.next_call.arguments});
    assert.equal(again.error.code, 'RECONCILIATION_UNAVAILABLE');
  } finally {
    f.close();
  }
});

test('a create whose response was lost is found through the Google lookup; one that was not created appears not applied', async () => {
  const f = googleBudgetFixture();
  try {
    const landed = (await f.creates(1, 50000000)).data.review_id;
    // The provider creates the budget, then the response is lost.
    f.hooks.respond = body => {
      f.budgets.set(budgetName(101), String(body.operations[0].create.amountMicros));
      f.names.set(budgetName(101), body.operations[0].create.name);
      throw new TypeError('created, then lost');
    };
    await f.execute(landed);
    f.hooks.respond = undefined;
    assert.equal(f.claim(landed).state, 'uncertain');
    const found = await quick(() => f.write({action: 'reconcile', review_id: landed}));
    assert.equal(found.data.classification, 'appears_applied', JSON.stringify(found.data));
    assert.deepEqual(found.data.observed_ids, [budgetName(101)]);
    assert.ok(f.reads.some(q => /campaign_budget\.name IN \('Synthetic 0'\)/.test(q)));

    const missing = (await f.creates(1, 50000000)).data.review_id;
    f.hooks.respond = lost;
    await f.execute(missing);
    f.hooks.respond = undefined;
    // Only the first create exists; its budget is removed so this lookup by the same frozen name finds nothing.
    f.names.delete(budgetName(101));
    const absent = await quick(() => f.write({action: 'reconcile', review_id: missing}));
    assert.equal(absent.data.classification, 'appears_not_applied', JSON.stringify(absent.data));
    assert.equal(f.writes.length, 2, 'each create was sent once');
  } finally {
    f.close();
  }
});

test('reconcile refuses a write whose outcome is not uncertain, and accept refuses a stale reconciliation', async () => {
  const f = googleBudgetFixture();
  try {
    const id = (await f.update(100000000)).data.review_id;
    const unsent = await f.write({action: 'reconcile', review_id: id});
    assert.equal(unsent.error.code, 'RECONCILIATION_UNAVAILABLE');
    assert.deepEqual(unsent.error.details.next_call.arguments, {action: 'status', review_id: id});
    f.hooks.respond = lost;
    await f.execute(id);
    f.hooks.respond = undefined;
    const r = await quick(() => f.write({action: 'reconcile', review_id: id}));
    const record = f.store.document(f.actor.tenantId, 'write_reconciliation', id);
    f.store.putDocument(f.actor.tenantId, 'write_reconciliation', id, {
      ...strip(record),
      classification: 'appears_applied',
      checked_at: Date.now() - 16 * 60000,
    });
    const stale = await f.write({
      action: 'reconcile',
      review_id: id,
      accept_applied: true,
      reconciliation_id: r.data.reconciliation_id,
    });
    assert.equal(stale.error.code, 'RECONCILIATION_STALE');
    assert.equal(f.claim(id).state, 'uncertain');
    const extra = await f.write({action: 'status', review_id: id, confirmed: true});
    assert.equal(extra.error.code, 'INVALID_ARGUMENT');
  } finally {
    f.close();
  }
});

test('an uncertain plan step is reconciled read-only and, once accepted, reconcile_step continues the plan', async () => {
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
    const plan = created.data.id;
    const prepared = await f.call('amcp_campaign', {action: 'prepare_next', id: plan});
    f.hooks.respond = body => {
      f.budgets.set(budgetName(1), String(body.operations[0].update.amountMicros));
      throw new TypeError('applied, then lost');
    };
    const stopped = await f.call('amcp_campaign', {...prepared.data.next_call.arguments, spend_change_confirmed: true});
    f.hooks.respond = undefined;
    assert.equal(stopped.data.current.status, 'uncertain');
    const reviewId = prepared.data.review.review_id;
    // The plan's next call was null ("check in the provider"); it is now the read-only reconciliation.
    const blocked = await f.call('amcp_campaign', {action: 'prepare_next', id: plan});
    assert.deepEqual(blocked.data.next_call, {
      tool: 'amcp_write',
      arguments: {action: 'reconcile', review_id: reviewId},
    });
    const r = await quick(() => f.write({action: 'reconcile', review_id: reviewId}));
    assert.equal(r.data.classification, 'appears_applied');
    await f.write({
      action: 'reconcile',
      review_id: reviewId,
      accept_applied: true,
      reconciliation_id: r.data.reconciliation_id,
    });
    const continued = await f.call('amcp_campaign', {action: 'reconcile_step', id: plan, step_id: 'budget'});
    assert.equal(continued.success, true, JSON.stringify(continued).slice(0, 800));
    const step = (await f.call('amcp_campaign', {action: 'get', id: plan, detail: 'full'})).data.steps.find(
      s => s.id === 'budget',
    );
    assert.equal(step.status, 'verified');
    assert.equal(f.writes.length, 1);
  } finally {
    f.close();
  }
});
