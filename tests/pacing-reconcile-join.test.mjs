import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';
import {currentQuotaPurpose} from '../dist/src/provider-quota.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * R2.5 M2 merge, the join between r25-m2-refusal's pacing governor and r25-m2-reconcile's automatic check (lead re-review of
 * r25-m2-reconcile, "Merge joins" 3).
 *
 * The governor (Meta's usage headers, AMCP_PROVIDER_PACING_MODE=enforce) refuses a request before it is sent, with PLATFORM_RATE_LIMIT and
 * the wait Meta named, so an uncertain write's check, which reads the provider, can meet it. Its reads are reserved work (the quota class
 * of every reconciliation read) and a read the transport refuses before dispatching it read nothing: the turn is no attempt, it settles
 * nothing and marks nothing, and the job looks again when the refusal says it may. Q20 holds: a write throttled after it was sent stays
 * uncertain, is never made retryable, and is never sent again; only reads wait.
 *
 * Every provider answer is synthetic (Meta's documented headers and error shape); the review lifecycle, the transport, the governor, the
 * lookups and the worker are the real ones.
 */
const meta = 'meta_native_action';
const connection = {
  id: 'm',
  tenantId: 'pacing-reconcile',
  gateway: meta,
  accounts: ['123'],
  writeAccounts: ['123'],
  enabled: true,
  label: 'Synthetic Meta',
  scopes: ['ads_read', 'ads_management'],
};
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});
/** Meta's documented header for a business use case that is blocked: 100 percent, `minutes` to regain access. */
const blocked = (minutes = 12) => ({
  'x-business-use-case-usage': JSON.stringify({
    123: [
      {
        type: 'ads_management',
        call_count: 100,
        total_cputime: 30,
        total_time: 30,
        estimated_time_to_regain_access: minutes,
      },
    ],
  }),
});
/** Meta's throttle of a request, with its usage header: a write answered so was sent. */
const throttled = () =>
  json(
    {error: {code: 17, error_subcode: 2446079, is_transient: true, message: 'Limit', type: 'OAuthException'}},
    400,
    blocked(12),
  );
const pacing = async (value, run) => {
  const before = {
    mode: process.env.AMCP_PROVIDER_PACING_MODE,
    delay: process.env.AMCP_WRITE_RECONCILE_DELAY_MS,
    round: process.env.AMCP_WRITE_RECONCILE_ROUND_MS,
  };
  process.env.AMCP_PROVIDER_PACING_MODE = value;
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
  try {
    return await run();
  } finally {
    for (const [key, saved] of [
      ['AMCP_PROVIDER_PACING_MODE', before.mode],
      ['AMCP_WRITE_RECONCILE_DELAY_MS', before.delay],
      ['AMCP_WRITE_RECONCILE_ROUND_MS', before.round],
    ])
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
  }
};

/**
 * A Meta advertiser behind the real review lifecycle, the real transport and the worker: the account read, a paused campaign create, and
 * the account's campaign list a lookup reads. `state.createAnswer` replaces the answer to the create (a Response, or a thrown error for a
 * response that was lost); `state.applied` says whether the create made the campaign; `state.listHeaders` adds headers to a list read;
 * `state.accountHeaders` adds headers to the next account reads.
 */
function advertiser() {
  const owner = {tenantId: connection.tenantId, userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 79).toString('base64')),
    campaigns = [],
    log = [],
    state = {createAnswer: undefined, applied: true, listHeaders: {}, accountHeaders: {}};
  store.putConnection(owner, connection, {accessToken: 'synthetic'});
  const transport = new NativeTransport(
    async (raw, init = {}) => {
      const method = init.method ?? 'GET',
        url = new URL(String(raw)),
        path = url.pathname;
      log.push(method + ' ' + path);
      if (method === 'GET' && path === '/v26.0/act_123')
        return json(
          {
            id: 'act_123',
            account_id: '123',
            currency: 'USD',
            account_status: 1,
            tos_accepted: {custom_audience_tos: 1},
          },
          200,
          state.accountHeaders,
        );
      if (method === 'GET' && path === '/v26.0/act_123/campaigns') {
        const name = JSON.parse(url.searchParams.get('filtering') ?? '[]')[0]?.value;
        return json({data: campaigns.filter(c => c.name === name)}, 200, state.listHeaders);
      }
      if (method === 'POST' && path === '/v26.0/act_123/campaigns') {
        // Meta takes a create as a form (or JSON); either way the fields are the ones the review froze.
        const raw = String(init.body),
          body = raw.trimStart().startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)),
          row = {
            id: '5' + (campaigns.length + 1),
            name: body.name,
            objective: body.objective,
            status: body.status,
            created_time: new Date().toISOString(),
          };
        if (state.applied) campaigns.push(row);
        const answer = state.createAnswer?.();
        return answer ?? json({id: row.id});
      }
      throw new Error('Unexpected synthetic request: ' + method + ' ' + path);
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
  const call = input => service.call('amcp_write', input, owner),
    overview = new ReportingOverview(service),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (tenant, kind, input) => overview.work(tenant, kind, input),
    ),
    seen = [],
    request = transport.request.bind(transport);
  // What the transport is asked for, with the quota class each request is made under.
  transport.request = (...args) => {
    seen.push({read: args[0].readOnly === true, purpose: currentQuotaPurpose(), path: args[0].path});
    return request(...args);
  };
  const jobs = () =>
    store.db
      .prepare('SELECT id,state,available_at,attempts,input FROM jobs WHERE tenant_id=? AND kind=? ORDER BY created_at')
      .all(owner.tenantId, 'write_reconcile')
      .map(row => ({...row, input: JSON.parse(row.input)}));
  return {
    store,
    transport,
    state,
    log,
    seen,
    jobs,
    worker,
    posts: () => log.filter(line => line === 'POST /v26.0/act_123/campaigns').length,
    gets: () => log.filter(line => line.startsWith('GET ')).length,
    prepare: () =>
      call({
        action: 'prepare',
        gateway: meta,
        arguments: {
          action: 'meta_campaign_create',
          account_id: '123',
          payload: {
            name: 'Draft',
            status: 'PAUSED',
            objective: 'OUTCOME_TRAFFIC',
            special_ad_categories: [],
            is_adset_budget_sharing_enabled: false,
          },
        },
      }),
    execute: id =>
      call({action: 'execute', review_id: id, idempotency_key: id, confirmed: true, spend_change_confirmed: true}),
    status: id => call({action: 'status', review_id: id}),
    call,
    check: () =>
      service.call('amcp_workspace', {action: 'check', connection_id: 'm', account_id: '123', live: true}, owner),
    claim: id =>
      store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(owner.tenantId, id)?.state,
    audit: () =>
      store.db
        .prepare('SELECT event FROM audit WHERE tenant_id=?')
        .all(owner.tenantId)
        .map(r => JSON.parse(r.event).event),
    /** The block is over: no cooldown remains in this process or in the shared store. */
    unblock: () => {
      transport.cooldowns.clear();
      store.db.exec('DELETE FROM provider_cooldowns');
    },
    due: () => store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind='write_reconcile' AND state='queued'").run(),
  };
}

/** What a turn of the worker's check that read nothing leaves behind, and what it does not (the join's whole contract). */
function assertUnsentTurn(f, id, {posts, requests, minWaitMs}) {
  const [job] = f.jobs();
  assert.equal(job.state, 'queued', 'the job looks again: it is not settled');
  assert.equal(job.attempts, 0, 'a turn that read nothing is no attempt');
  const left = job.available_at - Date.now();
  assert.ok(left > minWaitMs && left <= 12 * 60000, 'it waits the block Meta named, not the ladder: ' + left);
  assert.equal(f.claim(id), 'uncertain', 'the claim is not settled');
  assert.equal(f.posts(), posts, 'no write was sent or sent again');
  assert.equal(f.gets(), requests, 'nothing reached the provider: the governor refused every read before it was sent');
  const marks = f.audit();
  assert.equal(marks.includes('write_not_sent'), false, 'nothing is marked unsent: the write was sent');
  assert.equal(marks.includes('write_rejected'), false);
  assert.equal(marks.includes('write_completed'), false);
}

test('a Meta create throttled after it was sent stays uncertain and is never retryable; the check’s reads wait out the block, uncounted and reserved, and then classify it', async () => {
  await pacing('enforce', async () => {
    const f = advertiser();
    try {
      const id = (await f.prepare()).data.review_id;
      f.state.createAnswer = throttled;
      f.state.applied = false;
      const refused = await f.execute(id);
      f.state.createAnswer = undefined;
      // Q20: after dispatch nothing becomes retryable, whatever the governor does.
      assertRefused(refused, 'PLATFORM_RATE_LIMIT');
      assert.equal(refused.error.retryable, false);
      assert.notEqual(refused.error.details.submission, 'not_sent');
      assert.equal(f.claim(id), 'uncertain');
      assert.equal(f.posts(), 1);
      assert.equal(f.jobs().length, 1, 'the uncertain write is watched');
      assertRefused(await f.execute(id), 'WRITE_OUTCOME_UNCERTAIN', {writes: () => f.posts() - 1});
      assert.equal(f.transport.rateLimit(connection, '123').state, 'cooling');

      // The block is in force: the worker's check is refused before every read, six turns running, and uses none of its attempts.
      const gets = f.gets();
      f.seen.length = 0;
      for (let turn = 1; turn <= 8; turn++) {
        f.due();
        assert.equal(await f.worker.once(), true, 'turn ' + turn);
        assertUnsentTurn(f, id, {posts: 1, requests: gets, minWaitMs: 11 * 60000});
      }
      const reads = f.seen.filter(r => r.read);
      assert.ok(reads.length >= 8, 'the check asked the transport for reads each turn');
      assert.ok(
        reads.every(r => r.purpose === 'reserved') && f.seen.every(r => r.read),
        'every request of the check is a read made as reserved: the governor refuses reserved work too, Meta’s block is Meta’s',
      );
      const shown = (await f.status(id)).data.reconciliation;
      assert.equal(shown.classification, 'indeterminate');
      assert.equal(shown.reason, 'read_failed');
      assert.equal(shown.read_error, 'PLATFORM_RATE_LIMIT');
      assert.equal(shown.attempts, 0);
      assert.equal(shown.checks_exhausted, undefined, 'the attempts did not run out');

      // The block ends: the first read is the first attempt, and it classifies the write (Meta made nothing); the replacement is offered,
      // not made.
      f.unblock();
      f.due();
      assert.equal(await f.worker.once(), true);
      assert.ok(f.gets() > gets, 'the check read the provider');
      const done = (await f.status(id)).data;
      assert.equal(done.reconciliation.classification, 'appears_not_applied', JSON.stringify(done.reconciliation));
      assert.equal(done.reconciliation.attempts, 1);
      assert.equal(done.next_call.arguments.supersedes_review_id, id, 'a replacement is offered');
      assert.equal(f.posts(), 1, 'nothing was ever sent again');
      assert.equal(f.claim(id), 'uncertain', 'the claim is still the person’s to settle');
    } finally {
      f.store.close();
    }
  });
});

test('a block another call announced refuses the check’s reads before they are sent: nothing is settled or marked, and once it ends the check finds the object the lost create made', async () => {
  await pacing('enforce', async () => {
    const f = advertiser();
    try {
      const id = (await f.prepare()).data.review_id;
      // The create is applied and its response is lost.
      f.state.createAnswer = () => {
        throw new TypeError('synthetic lost response');
      };
      const lost = await f.execute(id);
      f.state.createAnswer = undefined;
      assertRefused(lost, 'WRITE_OUTCOME_UNCERTAIN');
      assert.equal(f.claim(id), 'uncertain');
      // Another call, which is no part of the write, reads the account and learns that Meta blocked it.
      f.state.accountHeaders = blocked(12);
      assert.equal((await f.check()).success, true);
      f.state.accountHeaders = {};
      assert.equal(f.transport.rateLimit(connection, '123').state, 'cooling');

      const gets = f.gets();
      f.due();
      assert.equal(await f.worker.once(), true);
      assertUnsentTurn(f, id, {posts: 1, requests: gets, minWaitMs: 11 * 60000});
      // The person's own reconcile is refused the same way and stores nothing over what is there.
      const person = await f.call({action: 'reconcile', review_id: id});
      assertRefused(person, 'PLATFORM_RATE_LIMIT');
      assert.ok(person.error.details.retry_after_ms > 11 * 60000);
      assert.equal(f.gets(), gets);

      f.unblock();
      f.due();
      assert.equal(await f.worker.once(), true);
      const shown = (await f.status(id)).data.reconciliation;
      assert.equal(shown.classification, 'appears_applied', JSON.stringify(shown));
      assert.deepEqual(shown.observed_ids, ['51']);
      assert.equal(shown.attempts, 1);
      assert.equal(f.posts(), 1, 'the check sent nothing');
    } finally {
      f.store.close();
    }
  });
});

test('in observe mode (the default) the same block refuses nothing: the check reads, and its attempts are counted as before', async () => {
  await pacing('observe', async () => {
    const f = advertiser();
    try {
      const id = (await f.prepare()).data.review_id;
      f.state.createAnswer = () => {
        throw new TypeError('synthetic lost response');
      };
      assertRefused(await f.execute(id), 'WRITE_OUTCOME_UNCERTAIN');
      f.state.createAnswer = undefined;
      f.state.accountHeaders = blocked(12);
      assert.equal((await f.check()).success, true);
      f.state.accountHeaders = {};
      const gets = f.gets();
      f.due();
      assert.equal(await f.worker.once(), true);
      assert.ok(f.gets() > gets, 'observe mode sends the check’s reads');
      const shown = (await f.status(id)).data.reconciliation;
      assert.equal(shown.classification, 'appears_applied', JSON.stringify(shown));
      assert.equal(shown.attempts, 1);
    } finally {
      f.store.close();
    }
  });
});
