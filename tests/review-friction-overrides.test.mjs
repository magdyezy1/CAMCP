import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {ownerOperations} from '../dist/src/owner-operations.js';
import {reviewFriction} from '../dist/src/review-friction.js';
import {capOverrides} from '../dist/src/cap-overrides.js';
import {MirrorError} from '../dist/src/errors.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {approveReview} from '../dist/src/write-approval.js';

/**
 * WRT-05 Stages D and F. Under enforcement `confirm` any operator could execute over an owner's cap with
 * cap_override_confirmed, and the audit event it wrote had no reader; nothing measured review friction although the
 * audit has every row. Owner health now lists the executions over a cap (who, which account and rule, which review) and
 * a friction report over the amcp_write audit (latency, expiry, changed state, refusals, uncertain and not-sent rates).
 */
const key = Buffer.alloc(32, 72).toString('base64');

test('an operator execution over a cap appears in the owner health view, and only the owner sees it', async () => {
  const TIKTOK = '14141414-1414-4141-8141-141414141414',
    gateway = 'tiktok_native_action',
    operator = {tenantId: 'overrides', userId: 'operator-1', role: 'operator'},
    owner = {...operator, userId: 'owner-1', role: 'admin'},
    store = new Store(':memory:', key);
  try {
    store.putConnection(
      owner,
      {
        id: TIKTOK,
        tenantId: operator.tenantId,
        gateway,
        accounts: ['123'],
        writeAccounts: ['123'],
        enabled: true,
        label: 'Synthetic TikTok',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    let budget = 1000;
    const transport = new NativeTransport(async (raw, init = {}) => {
      const url = new URL(String(raw));
      if ((init.method ?? 'GET') === 'GET' && url.pathname === '/open_api/v1.3/adgroup/get/')
        return Response.json({
          code: 0,
          message: 'OK',
          request_id: 'r',
          data: {
            list: [
              {
                adgroup_id: '700',
                campaign_id: '70',
                advertiser_id: '123',
                adgroup_name: 'Lifetime A',
                budget_mode: 'BUDGET_MODE_TOTAL',
                budget,
                scheduled_budget: 0,
                campaign_automation_type: 'MANUAL',
                operation_status: 'DISABLE',
              },
            ],
            page_info: {page: 1, page_size: 100, total_number: 1, total_page: 1},
          },
        });
      if (init.method === 'POST' && url.pathname === '/open_api/v1.3/adgroup/budget/update/') {
        budget = JSON.parse(init.body).budget[0].budget;
        return Response.json({code: 0, message: 'OK', request_id: 'w', data: {}});
      }
      throw new Error('Unexpected request ' + url.pathname);
    });
    const service = new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
    });
    saveSpendPolicy(store, owner, {gateway, account_id: '123', confirmed: true, policy: {max_budget_native: 950}});
    const before = ownerOperations(store, {action: 'health'}, owner);
    assert.equal(before.cap_overrides.count, 0);
    assert.equal(before.cap_overrides.needs_attention, false);
    const prepared = await service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        connection_id: TIKTOK,
        arguments: {
          action: 'tiktok_adgroup_budget_update',
          account_id: '123',
          payload: {budget: [{adgroup_id: '700', budget: 1200}]},
        },
      },
      operator,
    );
    assert.equal(prepared.success, true, JSON.stringify(prepared.error));
    // Owner decision P5 (WRT-09): an operator executes beyond a cap only after the owner approved the review on the
    // website (this test used to let any operator go beyond the cap on the acknowledgement alone).
    approveReview(store, owner, prepared.data.review_id, {fingerprint: prepared.data.fingerprint, confirmed: true});
    const done = await service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: prepared.data.review_id,
        confirmed: true,
        spend_change_confirmed: true,
        cap_override_confirmed: true,
      },
      operator,
    );
    assert.equal(done.success, true, JSON.stringify(done.error));
    const health = ownerOperations(store, {action: 'health'}, owner);
    assert.equal(health.cap_overrides.count, 1);
    assert.equal(health.cap_overrides.needs_attention, true);
    assert.deepEqual(health.cap_overrides.latest[0], {
      at: health.cap_overrides.latest[0].at,
      review_id: prepared.data.review_id,
      policy_id: health.cap_overrides.latest[0].policy_id,
      gateway,
      account_id: '123',
      rules: ['POLICY_BUDGET_LIMIT'],
      actor: 'operator-1',
      actor_role: 'operator',
    });
    // The friction report counts the same review: one prepare, one execute, one acknowledgement refusal never sent.
    assert.equal(
      health.review_friction.prepares,
      1,
      JSON.stringify(store.audit(operator.tenantId, 1000).map(r => [r.request_id, JSON.parse(r.event).event])),
    );
    assert.equal(health.review_friction.executes, 1);
    assert.equal(health.review_friction.latency_ms.count, 1);
    assert.throws(() => ownerOperations(store, {action: 'health'}, operator), {name: 'MirrorError'});
  } finally {
    store.close();
  }
});

test('a confirmed over-cap execution refused before it was sent is not listed as executed', async () => {
  // Regression: the confirmation is audited in the policy check, before dispatch. A refusal after it and before the
  // request left AMCP (here a circuit) releases the claim and sends nothing; the owner view used to count it anyway.
  const TIKTOK = '15151515-1515-4151-8151-151515151515',
    gateway = 'tiktok_native_action',
    operator = {tenantId: 'not-sent-override', userId: 'operator-1', role: 'operator'},
    owner = {...operator, userId: 'owner-1', role: 'admin'},
    store = new Store(':memory:', key);
  try {
    store.putConnection(
      owner,
      {
        id: TIKTOK,
        tenantId: operator.tenantId,
        gateway,
        accounts: ['123'],
        writeAccounts: ['123'],
        enabled: true,
        label: 'Synthetic TikTok',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    let budget = 1000,
      refuse = true,
      posts = 0;
    const transport = new NativeTransport(async (raw, init = {}) => {
      const url = new URL(String(raw));
      if ((init.method ?? 'GET') === 'GET' && url.pathname === '/open_api/v1.3/adgroup/get/')
        return Response.json({
          code: 0,
          message: 'OK',
          request_id: 'r',
          data: {
            list: [
              {
                adgroup_id: '700',
                campaign_id: '70',
                advertiser_id: '123',
                adgroup_name: 'Lifetime A',
                budget_mode: 'BUDGET_MODE_TOTAL',
                budget,
                scheduled_budget: 0,
                campaign_automation_type: 'MANUAL',
                operation_status: 'DISABLE',
              },
            ],
            page_info: {page: 1, page_size: 100, total_number: 1, total_page: 1},
          },
        });
      if (init.method === 'POST' && url.pathname === '/open_api/v1.3/adgroup/budget/update/') {
        posts++;
        budget = JSON.parse(init.body).budget[0].budget;
        return Response.json({code: 0, message: 'OK', request_id: 'w', data: {}});
      }
      throw new Error('Unexpected request ' + url.pathname);
    });
    const send = transport.request.bind(transport);
    // A pre-dispatch refusal of the mutation only: the transport stops before its fetch, as an open circuit does.
    transport.request = (plan, ...rest) =>
      refuse && !plan.readOnly
        ? Promise.reject(new MirrorError('CIRCUIT_OPEN', 'Synthetic open circuit.', {retry_after_ms: 1000}, 503, true))
        : send(plan, ...rest);
    const service = new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
    });
    saveSpendPolicy(store, owner, {gateway, account_id: '123', confirmed: true, policy: {max_budget_native: 950}});
    const prepared = await service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        connection_id: TIKTOK,
        arguments: {
          action: 'tiktok_adgroup_budget_update',
          account_id: '123',
          payload: {budget: [{adgroup_id: '700', budget: 1200}]},
        },
      },
      operator,
    );
    assert.equal(prepared.success, true, JSON.stringify(prepared.error));
    // Owner decision P5 (WRT-09): the owner approves the over-cap review on the website before an operator executes it.
    approveReview(store, owner, prepared.data.review_id, {fingerprint: prepared.data.fingerprint, confirmed: true});
    const execute = () =>
      service.call(
        'amcp_write',
        {
          action: 'execute',
          review_id: prepared.data.review_id,
          confirmed: true,
          spend_change_confirmed: true,
          cap_override_confirmed: true,
        },
        operator,
      );
    const refused = await execute();
    assertRefused(refused, 'CIRCUIT_OPEN');
    assert.equal(posts, 0);
    assert.ok(
      store
        .audit(operator.tenantId, 1000)
        .some(r => JSON.parse(r.event).event === 'spend_cap_exceeded_with_confirmation'),
      'the confirmation was audited before the refusal',
    );
    assert.equal(capOverrides(store, operator.tenantId).count, 0);
    assert.deepEqual(capOverrides(store, operator.tenantId).latest, []);
    // Executed again inside its window and sent: now it is one execution over the cap.
    refuse = false;
    const done = await execute();
    assert.equal(done.success, true, JSON.stringify(done.error));
    assert.equal(posts, 1);
    const o = capOverrides(store, operator.tenantId);
    assert.equal(o.count, 1);
    assert.equal(o.latest[0].review_id, prepared.data.review_id);
  } finally {
    store.close();
  }
});

test('an override recorded before the event named its actor is read through its review', () => {
  const store = new Store(':memory:', key);
  try {
    store.putDocument('t', 'write_review', 'rev-old', {
      user_id: 'operator-0',
      plan: {gateway: 'google_ads_native_action', accountId: '555'},
    });
    store.appendAudit('t', 'rev-old', {
      event: 'spend_cap_exceeded_with_confirmation',
      policy_id: 'p',
      exceeded: [{rule: 'POLICY_DAILY_INCREASE_LIMIT'}, {rule: 'POLICY_DAILY_INCREASE_LIMIT'}],
    });
    const o = capOverrides(store, 't');
    assert.equal(o.count, 1);
    assert.deepEqual(
      {...o.latest[0], at: 0},
      {
        at: 0,
        review_id: 'rev-old',
        policy_id: 'p',
        gateway: 'google_ads_native_action',
        account_id: '555',
        rules: ['POLICY_DAILY_INCREASE_LIMIT'],
        actor: 'operator-0',
        actor_role: null,
      },
    );
  } finally {
    store.close();
  }
});

test('the friction report over synthetic audit rows matches hand counts and holds paths, never values', () => {
  const store = new Store(':memory:', key),
    now = Date.UTC(2026, 9, 9, 12),
    t0 = now - 3600000;
  const insert = (tenant, request, event, at) =>
    store.db
      .prepare('INSERT INTO audit(tenant_id,request_id,event,previous_hash,hash,created_at) VALUES(?,?,?,?,?,?)')
      .run(tenant, request, JSON.stringify(event), 'synthetic', 'synthetic-' + Math.random(), at);
  const failure = (code, details = {}) => ({
    tool: 'amcp_write',
    input: {action: 'execute'},
    outcome: {success: false, error: {code, message: 'Synthetic', details}},
  });
  try {
    for (let i = 1; i <= 10; i++) insert('t', 'r' + i, {event: 'write_prepared'}, t0 + i * 1000);
    [1000, 2000, 3000, 4000, 5000, 60000].forEach((ms, i) =>
      insert('t', 'r' + (i + 1), {event: 'write_started'}, t0 + (i + 1) * 1000 + ms),
    );
    insert('t', 'x1', failure('REVIEW_EXPIRED'), t0 + 70000);
    insert('t', 'x2', failure('REVIEW_EXPIRED'), t0 + 71000);
    insert(
      't',
      'x3',
      failure('STATE_CHANGED', {changed_fields: ['/0/a', '/0/b'], expected: 'secret-value'}),
      t0 + 72000,
    );
    insert('t', 'x4', failure('STATE_CHANGED', {changed_fields: ['/0/a']}), t0 + 73000);
    insert('t', 'x5', failure('STATE_CHANGED', {changed_fields: ['/0/a']}), t0 + 74000);
    insert('t', 'x6', failure('SPEND_CONFIRMATION_REQUIRED'), t0 + 75000);
    insert('t', 'x7', failure('CAP_CONFIRMATION_REQUIRED'), t0 + 76000);
    insert('t', 'x8', failure('WRITE_OUTCOME_UNCERTAIN'), t0 + 77000);
    insert('t', 'x9', failure('INVALID_ARGUMENT'), t0 + 78000);
    insert('t', 'r7', {event: 'write_not_sent', code: 'WRITES_PAUSED'}, t0 + 79000);
    insert('t', 'r8', {event: 'write_not_sent', code: 'STATE_BUSY'}, t0 + 80000);
    // Another workspace and an older window are not counted.
    insert('other', 'o1', {event: 'write_prepared'}, t0 + 1000);
    insert('other', 'o2', failure('REVIEW_EXPIRED'), t0 + 2000);
    insert('t', 'old', failure('REVIEW_EXPIRED'), now - 31 * 86400000);
    const r = reviewFriction(store, 't', 30, now);
    assert.equal(r.complete, true);
    assert.equal(r.prepares, 10);
    assert.equal(r.executes, 6);
    assert.deepEqual(r.latency_ms, {count: 6, p50: 3000, p90: 60000, p99: 60000, max: 60000});
    assert.deepEqual(r.counts, {
      REVIEW_EXPIRED: 2,
      STATE_CHANGED: 3,
      CONFIRMATION_REQUIRED: 0,
      SPEND_CONFIRMATION_REQUIRED: 1,
      CAP_CONFIRMATION_REQUIRED: 1,
      CREATIVE_EDIT_CONFIRMATION_REQUIRED: 0,
      WRITE_OUTCOME_UNCERTAIN: 1,
      acknowledgement_refusals: 2,
      write_not_sent: 2,
    });
    assert.deepEqual(r.per_100_prepares, {
      review_expired: 20,
      state_changed: 30,
      acknowledgement_refusals: 20,
      write_outcome_uncertain: 10,
      write_not_sent: 20,
    });
    assert.deepEqual(r.not_sent_codes, {WRITES_PAUSED: 1, STATE_BUSY: 1});
    assert.deepEqual(r.state_changed_paths, [
      {path: '/0/a', count: 3},
      {path: '/0/b', count: 1},
    ]);
    assert.ok(!JSON.stringify(r).includes('secret-value'), 'values never leave the audit');
    // No prepares: rates are unknown, not zero.
    assert.equal(reviewFriction(store, 'empty', 30, now).per_100_prepares.review_expired, null);
  } finally {
    store.close();
  }
});
