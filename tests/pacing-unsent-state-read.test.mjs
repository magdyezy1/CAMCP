// Package r25-m2-refusal, the lead's review S3-2 (MT3, L3-01 stage a; owner decision D12): under enforce the usual refusal is the one
// of the execute-time state read. A review is prepared, another request of the same login or account announces a block (a response
// carrying Meta's usage headers, or a throttle), and the review is executed: the transport refuses its state read before anything is
// claimed, with PLATFORM_RATE_LIMIT and the wait. That read runs before the claim and outside the part of execute that marks a refusal
// unsent, so the refusal carried no `submission: "not_sent"` and a plan step failed instead of waiting: the wait then cost a new
// review, and a background run stopped. A refusal of the state read for a cooldown or an open circuit sent no write and claimed
// nothing, so it says so, and the same review executes when the cause clears. Every value is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const meta = 'meta_native_action';
const owner = {tenantId: 'unsent-read', userId: 'owner', role: 'admin'};
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});
const account = {
  id: 'act_123',
  account_id: '123',
  name: 'Synthetic',
  currency: 'USD',
  timezone_name: 'UTC',
  account_status: 1,
  tos_accepted: {custom_audience_tos: 1},
};
/** Meta's documented header for a business use case that is blocked: 100 percent, twelve minutes to regain access. */
const blocked = {
  'x-business-use-case-usage': JSON.stringify({
    123: [
      {type: 'ads_management', call_count: 100, total_cputime: 30, total_time: 30, estimated_time_to_regain_access: 12},
    ],
  }),
};
const mode = async (value, run) => {
  const before = process.env.AMCP_PROVIDER_PACING_MODE;
  if (value === undefined) delete process.env.AMCP_PROVIDER_PACING_MODE;
  else process.env.AMCP_PROVIDER_PACING_MODE = value;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.AMCP_PROVIDER_PACING_MODE;
    else process.env.AMCP_PROVIDER_PACING_MODE = before;
  }
};

/**
 * A Meta advertiser behind the real review lifecycle. `reads(n)` answers the n-th read of the account (headers, or a Response to
 * replace the answer); every create succeeds. `writes` lists the creates that were sent.
 */
function advertiser({reads = () => ({})} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 85).toString('base64')),
    writes = [];
  let read = 0;
  store.putConnection(
    owner,
    {
      id: 'm',
      tenantId: owner.tenantId,
      gateway: meta,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_read', 'ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  const transport = new NativeTransport(
    async (raw, init = {}) => {
      const method = init.method ?? 'GET',
        path = new URL(String(raw)).pathname;
      if (method === 'GET' && path === '/v26.0/act_123') {
        const answer = reads(++read);
        return answer instanceof Response ? answer : json(account, 200, answer);
      }
      if (method === 'POST' && path === '/v26.0/act_123/campaigns') {
        writes.push(String(init.body ?? ''));
        return json({id: String(1000 + writes.length)});
      }
      throw Error('Unexpected synthetic request: ' + method + ' ' + path);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    1000000,
    1,
    1000,
  );
  transport.coordination = store;
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const call = (tool, input) => service.call(tool, input, owner);
  const create = {
    action: 'meta_campaign_create',
    account_id: '123',
    payload: {
      name: 'Draft',
      status: 'PAUSED',
      objective: 'OUTCOME_TRAFFIC',
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false,
    },
  };
  return {
    store,
    transport,
    writes,
    call,
    check: () => call('amcp_workspace', {action: 'check', connection_id: 'm', account_id: '123', live: true}),
    prepare: () => call('amcp_write', {action: 'prepare', gateway: meta, arguments: create}),
    execute: id =>
      call('amcp_write', {
        action: 'execute',
        review_id: id,
        idempotency_key: id,
        confirmed: true,
        spend_change_confirmed: true,
      }),
    plan: input => call('amcp_campaign', input),
    createPlan: () =>
      call('amcp_campaign', {
        action: 'create',
        name: 'Waits for a block',
        brief: 'Synthetic: one paused Meta campaign, whose review waits for a block to end.',
        steps: [
          {id: 'campaign', kind: 'write', gateway: meta, connection_id: 'm', account_id: '123', arguments: create},
        ],
      }),
    claim: id =>
      store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(owner.tenantId, id)?.state,
    /** The block is over: no cooldown remains in this process or in the shared store. */
    unblock: () => {
      transport.cooldowns.clear();
      store.db.exec('DELETE FROM provider_cooldowns');
    },
  };
}

test('an execute whose state read is refused for a block says nothing was sent, claims nothing, and the same review executes when the block ends', async () => {
  await mode('enforce', async () => {
    // The first read is the prepare, the second the live check that announces the block; the execute then meets the cooldown.
    const f = advertiser({reads: n => (n === 2 ? blocked : {})});
    try {
      const prepared = await f.prepare();
      assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 600));
      const id = prepared.data.review_id;
      assert.equal((await f.check()).success, true);
      const refused = await f.execute(id);
      assertRefused(refused, 'PLATFORM_RATE_LIMIT');
      assert.equal(refused.error.details.submission, 'not_sent', JSON.stringify(refused.error.details));
      assert.equal(refused.error.details.review_id, id);
      assert.ok(refused.error.details.retry_after_ms > 11.9 * 60000);
      assert.equal(f.writes.length, 0);
      assert.equal(f.claim(id), undefined, 'nothing was claimed');
      // The block is over: the same review is executed, not prepared again.
      f.unblock();
      const done = await f.execute(id);
      assert.equal(done.success, true, JSON.stringify(done).slice(0, 600));
      assert.equal(f.writes.length, 1);
      assert.equal(f.claim(id), 'complete');
    } finally {
      f.store.close();
    }
  });
});

test('in a plan the step waits: it stays review_ready with the refusal, run continues it when the block ends, and the same review is the one sent', async () => {
  await mode('enforce', async () => {
    const f = advertiser({reads: n => (n === 2 ? blocked : {})});
    try {
      const created = await f.createPlan();
      assert.equal(created.success, true, JSON.stringify(created).slice(0, 600));
      const id = created.data.id,
        summary = (await f.plan({action: 'approve', id})).data,
        approved = await f.plan({...summary.next_call.arguments, ...(summary.next_call.add_after_user_approval ?? {})});
      assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 600));
      const prepared = await f.plan({action: 'prepare_next', id});
      assert.ok(prepared.data?.review?.review_id, JSON.stringify(prepared).slice(0, 600));
      const review = prepared.data.review.review_id;
      assert.equal((await f.check()).success, true, 'a call that is no step of the plan announces the block');
      const execute = {
        action: 'execute_next',
        id,
        review_id: review,
        idempotency_key: review,
        confirmed: true,
        spend_change_confirmed: true,
      };
      const waiting = await f.plan(execute);
      const step = f.store.document(owner.tenantId, 'campaign_run', id).steps[0];
      assert.equal(step.status, 'review_ready', JSON.stringify(waiting).slice(0, 600) + JSON.stringify(step.error));
      assert.equal(step.error.code, 'PLATFORM_RATE_LIMIT');
      assert.equal(step.error.details.submission, 'not_sent');
      assert.equal(step.review_id, review, 'the step keeps its review');
      assert.equal(f.writes.length, 0);
      // run does not send it into the block, and says it waits.
      const stopped = await f.plan({action: 'run', id});
      assert.equal(
        stopped.data?.run?.stopped ?? stopped.run?.stopped,
        'not_sent',
        JSON.stringify(stopped).slice(0, 600),
      );
      assert.equal(f.writes.length, 0);
      // The block ends: run executes the same review under the same key, and the step is verified.
      f.unblock();
      const ran = await f.plan({action: 'run', id});
      assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 600));
      assert.equal(f.writes.length, 1);
      const after = f.store.document(owner.tenantId, 'campaign_run', id).steps[0];
      assert.equal(after.review_id, review, 'no new review was prepared');
      assert.equal(f.claim(review), 'complete');
      assert.notEqual(after.status, 'failed');
    } finally {
      f.store.close();
    }
  });
});

test('a refusal of the state read that is not a block or an open circuit is not marked unsent: a provider error on the read keeps what it was', async () => {
  await mode('enforce', async () => {
    const f = advertiser({reads: n => (n === 2 ? json({error: {message: 'Invalid parameter', code: 100}}, 400) : {})});
    try {
      const id = (await f.prepare()).data.review_id,
        refused = await f.execute(id);
      assertRefused(refused, 'UPSTREAM_ERROR');
      assert.notEqual(refused.error.details.submission, 'not_sent');
      assert.equal(f.writes.length, 0);
    } finally {
      f.store.close();
    }
  });
});

test('an open circuit refuses the state read of an execute as unsent too', async () => {
  await mode('enforce', async () => {
    // Reads of the account fail with a transient error after the prepare: five failures open the circuit, which then refuses.
    const f = advertiser({reads: n => (n === 1 ? {} : json({error: {message: 'Temporarily unavailable'}}, 503))});
    try {
      const id = (await f.prepare()).data.review_id;
      let refused;
      for (let i = 0; i < 8 && refused?.error?.code !== 'CIRCUIT_OPEN'; i++) refused = await f.execute(id);
      assertRefused(refused, 'CIRCUIT_OPEN');
      assert.equal(refused.error.details.submission, 'not_sent', JSON.stringify(refused.error.details));
      assert.equal(f.writes.length, 0);
      assert.equal(f.claim(id), undefined);
    } finally {
      f.store.close();
    }
  });
});
