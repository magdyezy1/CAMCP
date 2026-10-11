// CMP-04: multi-step plan recovery. A definitive provider refusal that a family proves applied nothing becomes a
// third claim outcome, rejected, with recovery under a new key; a refusal without that proof is settled by a complete
// read-only absence probe plus the user's attestation; continue_as_new carries the remaining steps into a linked plan;
// a lost response, timeout or 5xx stays uncertain and is never replayed; Google recipes are one all-or-nothing build.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {CampaignRunner} from '../dist/src/campaign-runner.js';
import {campaignRecipe} from '../dist/src/campaign-recipes.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {MirrorError} from '../dist/src/errors.js';
import {nonAppliedRejection} from '../dist/src/write-rejection.js';
import {operationsPage} from '../dist/src/operations-feed.js';
import {googleSearchFixture} from './fixtures/google-search-recipe-data.mjs';

const {cpc_bid, ...shared} = JSON.parse(
  readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
).recipe_business;
const search = {...shared, cpc_bid};
const googleRefusal = {
  error: {code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT'},
};

async function next(f, id) {
  const prepared = await f.call({action: 'prepare_next', id});
  assert.equal(prepared.success, true, JSON.stringify(prepared));
  assert.ok(prepared.data.review?.review_id, JSON.stringify(prepared));
  return f.call({
    action: 'execute_next',
    id,
    review_id: prepared.data.review.review_id,
    idempotency_key: prepared.data.review.review_id,
    confirmed: true,
    spend_change_confirmed: true,
  });
}
const claimState = (f, key) =>
  f.store.db
    .prepare('SELECT state, fingerprint FROM idempotency WHERE tenant_id=? AND key=?')
    .get(f.actor.tenantId, key);
const auditEvents = f =>
  f.store.db
    .prepare('SELECT event FROM audit WHERE tenant_id=?')
    .all(f.actor.tenantId)
    .map(r => JSON.parse(r.event));

test('(e) a compiled Google recipe is one all-or-nothing build, and read-back verifies every resource it created', async t => {
  const plan = campaignRecipe('google_search', search);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].id, 'build');
  assert.equal(plan.steps[0].arguments.action, 'google_ads_v23_google_ads_mutate');
  assert.equal(plan.steps[0].arguments.payload.partial_failure, false);
  assert.equal(plan.steps[0].expected_currency, search.currency);
  assert.deepEqual(plan.recipe.build, {
    all_or_nothing: true,
    steps: ['budget', 'campaign', 'targeting', 'adgroup', 'keywords', 'ad'],
  });
  // atomic: false keeps one step per resource type; any other value is refused.
  assert.equal(campaignRecipe('google_search', {...search, atomic: false}).steps.length, 6);
  assert.throws(() => campaignRecipe('google_search', {...search, atomic: 'yes'}), {code: 'RECIPE_INPUT_INVALID'});
  const f = googleSearchFixture(t, search, {native: true}),
    saved = await f.call({action: 'create_from_recipe', recipe: 'google_search', business: search});
  assert.equal(saved.success, true, JSON.stringify(saved));
  const out = await next(f, saved.data.id);
  assert.equal(out.success, true, JSON.stringify(out));
  const run = f.store.document(f.actor.tenantId, 'campaign_run', saved.data.id),
    ops = plan.steps[0].arguments.payload.mutate_operations.length;
  assert.equal(run.state, 'complete', JSON.stringify(run.steps[0]).slice(0, 1500));
  assert.equal(run.steps[0].status, 'verified');
  assert.equal(f.mutations.length, 1, 'one request for the whole campaign');
  assert.equal(f.resources.size, ops);
  assert.equal(run.steps[0].verification.checks.length, ops);
  assert.ok(run.steps[0].verification.checks.every(c => c.status === 'verified'));
  assert.equal([...f.resources.values()].find(r => r.kind === 'campaign').value.status, 'PAUSED');
});

test('(e) a Google build refused with HTTP 400 is rejected: nothing exists, the key is retired, the build is amended', async t => {
  const f = googleSearchFixture(t, search, {native: true, refuse: {googleAds: {status: 400, body: googleRefusal}}}),
    saved = await f.call({action: 'create_from_recipe', recipe: 'google_search', business: search}),
    id = saved.data.id;
  const refused = await next(f, id);
  assert.equal(refused.data.current.status, 'failed', JSON.stringify(refused));
  const first = f.store.document(f.actor.tenantId, 'campaign_run', id).steps[0];
  assert.equal(first.submission, 'rejected');
  assert.equal(claimState(f, first.review_id).state, 'rejected');
  assert.equal(f.resources.size, 0);
  const blocked = await f.call({action: 'prepare_next', id});
  assert.equal(blocked.data.next_call.arguments.action, 'recover_step', JSON.stringify(blocked.data));
  const amended = await f.call({
    ...blocked.data.next_call.arguments,
    patch: [{path: '/payload/mutate_operations/0/campaign_budget_operation/create/name', value: 'Corrected budget'}],
  });
  assert.equal(amended.success, true, JSON.stringify(amended));
  assert.equal((await next(f, id)).data.state, 'complete');
  assert.equal(f.mutations.length, 2, 'the refused request is never sent again; the corrected one is');
});

const reservations = (f, key) =>
  f.store.db
    .prepare("SELECT count(*) AS n FROM documents WHERE tenant_id=? AND kind='spend_reservation' AND id=?")
    .get(f.actor.tenantId, key).n;
const dailyCap = f =>
  saveSpendPolicy(f.store, f.admin, {
    scope: 'workspace',
    confirmed: true,
    policy: {enforcement: 'block', max_daily_increase_native: 1000000000},
  });

test('(a) a Google per-service refusal (HTTP 400) is rejected: recover_step is offered, the old key retired and its reservation released', async t => {
  const business = {...search, atomic: false},
    f = googleSearchFixture(t, business, {native: true, refuse: {campaignBudgets: {status: 400, body: googleRefusal}}});
  dailyCap(f);
  const saved = await f.call({action: 'create_from_recipe', recipe: 'google_search', business}),
    id = saved.data.id;
  const refused = await next(f, id);
  assert.equal(refused.data.current.step_id, 'budget');
  assert.equal(refused.data.current.status, 'failed');
  const step = f.store.document(f.actor.tenantId, 'campaign_run', id).steps.find(s => s.id === 'budget');
  assert.equal(step.submission, 'rejected');
  const claim = claimState(f, step.review_id);
  assert.equal(claim.state, 'rejected');
  // The day's spend reservation is released for a proven non-applied refusal (owner decision D12).
  assert.equal(reservations(f, step.review_id), 0);
  assert.ok(auditEvents(f).some(e => e.event === 'write_rejected' && e.http_status === 400));
  const journal = f.store.operationJournal(f.actor.tenantId, step.review_id);
  assert.equal(journal.phase, 'rejected');
  // The retired key is refused at claim and at execute: it is never sent again.
  assert.throws(() => f.store.claim(f.actor.tenantId, step.review_id, claim.fingerprint), {code: 'WRITE_REJECTED'});
  const blocked = await f.call({action: 'prepare_next', id});
  assert.match(blocked.data.recovery, /without applying it/);
  assert.equal(blocked.data.next_call.arguments.action, 'recover_step');
  const recovered = await f.call({
    ...blocked.data.next_call.arguments,
    patch: [{path: '/payload/operations/0/create/name', value: 'Corrected budget'}],
    detail: 'full',
  });
  assert.equal(recovered.success, true, JSON.stringify(recovered));
  const attempt = recovered.data.steps.find(s => s.id === 'budget').previous_attempts.at(-1);
  assert.deepEqual(attempt.key_retired, {reason: 'rejected', review_id: step.review_id, http_status: 400});
  assert.ok(auditEvents(f).some(e => e.event === 'campaign_step_recovered_after_rejection' && e.reason === 'rejected'));
  for (let i = 0; i < 6; i++) assert.equal((await next(f, id)).success, true);
  const done = f.store.document(f.actor.tenantId, 'campaign_run', id);
  assert.equal(done.state, 'complete');
  // The corrected budget holds its own reservation; the refused one released its own.
  assert.equal(reservations(f, done.steps[0].review_id), 1);
  assert.equal(f.mutations.filter(m => /campaignBudgets:mutate$/.test(m.path)).length, 2);
});

test('(d) a 5xx after submission stays uncertain: no recovery, no absence probe and no replay', async t => {
  const business = {...search, atomic: false},
    f = googleSearchFixture(t, business, {
      native: true,
      refuse: {campaignBudgets: {status: 500, body: {error: {code: 500, status: 'INTERNAL'}}}},
    });
  dailyCap(f);
  const saved = await f.call({action: 'create_from_recipe', recipe: 'google_search', business}),
    id = saved.data.id;
  const out = await next(f, id);
  const step = f.store.document(f.actor.tenantId, 'campaign_run', id).steps.find(s => s.id === 'budget');
  assert.ok(['failed', 'uncertain'].includes(step.status), JSON.stringify(out.data.current));
  assert.notEqual(step.submission, 'rejected');
  assert.equal(claimState(f, step.review_id).state, 'uncertain');
  // A 5xx may have reached the provider: its reservation stays taken.
  assert.equal(reservations(f, step.review_id), 1);
  // The only next call is WRT-08's read-only reconciliation of that review: never a recovery, probe or resend.
  const blocked = await f.call({action: 'prepare_next', id});
  assert.deepEqual(blocked.data.next_call, {
    tool: 'amcp_write',
    arguments: {action: 'reconcile', review_id: step.review_id},
  });
  for (const action of ['recover_step', 'confirm_absent']) {
    const refused = await f.call({action, id, step_id: 'budget', confirmed: true, arguments: {}});
    assert.equal(refused.error?.code, 'RECOVERY_NOT_SAFE', JSON.stringify(refused));
  }
  const continued = await f.call({action: 'continue_as_new', id, confirmed: true});
  assert.equal(continued.error?.code, 'RECOVERY_NOT_SAFE');
  assert.deepEqual(
    continued.error.details.blocked_steps.map(b => b.step_id),
    ['budget'],
  );
  assert.equal(f.mutations.length, 1, 'the uncertain request is never sent again');
});

test('(d) the rejected outcome has a rollback switch: AMCP_WRITE_REJECTED_OUTCOME=false keeps a 400 uncertain', async t => {
  process.env.AMCP_WRITE_REJECTED_OUTCOME = 'false';
  t.after(() => delete process.env.AMCP_WRITE_REJECTED_OUTCOME);
  const business = {...search, atomic: false},
    f = googleSearchFixture(t, business, {native: true, refuse: {campaignBudgets: {status: 400, body: googleRefusal}}}),
    saved = await f.call({action: 'create_from_recipe', recipe: 'google_search', business});
  await next(f, saved.data.id);
  const step = f.store.document(f.actor.tenantId, 'campaign_run', saved.data.id).steps[0];
  assert.equal(claimState(f, step.review_id).state, 'uncertain');
  const refused = await f.call({
    action: 'recover_step',
    id: saved.data.id,
    step_id: 'budget',
    confirmed: true,
    arguments: {},
  });
  assert.equal(refused.error?.code, 'RECOVERY_NOT_SAFE');
});

test('(d) only a parsed, definitive refusal with a declared proof is rejected: a lost response, timeout, rate limit or 5xx stays uncertain', () => {
  const google = {
      gateway: 'google_ads_native_action',
      method: 'POST',
      path: '/v23/customers/1234567890/campaignBudgets:mutate',
      body: {operations: [{create: {name: 'Budget'}}]},
    },
    refusal = (status, details = {}) =>
      new MirrorError('PROVIDER_ERROR', 'Platform returned HTTP ' + status, {
        http_status: status,
        upstream: googleRefusal,
        ...details,
      });
  assert.equal(nonAppliedRejection(google, refusal(400)), true, 'a Google per-service 400 with its error body');
  assert.equal(
    nonAppliedRejection({...google, path: '/v23/customers/1234567890/googleAds:mutate'}, refusal(422)),
    true,
  );
  // A timeout or a rate limit is not a decision; a 5xx may have applied.
  for (const status of [408, 429, 500, 502, 503, 504])
    assert.equal(nonAppliedRejection(google, refusal(status)), false, 'HTTP ' + status);
  assert.equal(nonAppliedRejection(google, refusal(400, {layer: 'rate_limit'})), false);
  assert.equal(nonAppliedRejection(google, refusal(400, {retry_after_ms: 1000})), false);
  // A lost response: no parsed provider body, or not even a provider error.
  assert.equal(nonAppliedRejection(google, refusal(400, {upstream: undefined})), false);
  assert.equal(nonAppliedRejection(google, new TypeError('fetch failed')), false);
  assert.equal(
    nonAppliedRejection(google, new MirrorError('UPSTREAM_TIMEOUT', 'Timed out.', {submission: 'uncertain'})),
    false,
  );
  // Partial failure or validate-only proves nothing about the other operations.
  for (const body of [{partial_failure: true}, {partialFailure: 'true'}, {validate_only: true}, {validateOnly: true}])
    assert.equal(nonAppliedRejection({...google, body: {...google.body, ...body}}, refusal(400)), false);
  // A family without a declared proof (Meta) stays uncertain even for a parsed 400.
  const meta = {gateway: 'meta_native_action', method: 'POST', path: '/v25.0/act_1/adsets', body: {}};
  assert.equal(nonAppliedRejection(meta, refusal(400, {upstream: {error: {code: 100}}})), false);
  assert.equal(nonAppliedRejection(meta, refusal(400), {rejectionIsNonApplied: () => false}), false);
});

// A runner whose provider is a script: Meta refuses the ad set with HTTP 400 after it was submitted, and the absence
// probe returns the pages the test sets.
function metaFixture() {
  const actor = {tenantId: 'meta-recovery', userId: 'operator', role: 'operator'},
    store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64'));
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 'meta',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      writeAccounts: ['100'],
      enabled: true,
      label: 'Meta',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const state = {pages: [{data: []}], reads: [], submissions: [], refuseAdset: true, count: 0};
  const runner = new CampaignRunner(
    store,
    async (name, input) => {
      if (name === 'meta_native_action') {
        state.reads.push(input);
        const page = state.pages[input.query.after ? Number(input.query.after) : 0];
        if (page === 'error') return {success: false, error: {code: 'PROVIDER_ERROR', message: 'Refused.'}};
        return {success: true, data: {success: true, data: page, pages: 1, truncated: page.truncated === true}};
      }
      if (input.action === 'prepare') {
        const id = 'review-' + ++state.count;
        return {
          success: true,
          data: {
            review_id: id,
            idempotency_key: id,
            expires_at: new Date(Date.now() + 300000).toISOString(),
            request: input.arguments,
          },
        };
      }
      state.submissions.push(input.review_id);
      store.claim(actor.tenantId, input.review_id, 'request');
      const step = state.submissions.length;
      if (step === 2 && state.refuseAdset) {
        store.uncertain(actor.tenantId, input.review_id);
        return {
          success: false,
          error: {
            code: 'PROVIDER_ERROR',
            message: 'Platform returned HTTP 400',
            details: {http_status: 400, upstream: {error: {code: 100, message: 'Invalid parameter'}}},
          },
        };
      }
      const result = {data: {id: String(700 + step)}};
      store.complete(actor.tenantId, input.review_id, result);
      return {success: true, data: result};
    },
    async () => ({status: 'verified'}),
    async () => ({}),
    async () => ({status: 'ready', checks: []}),
  );
  const call = input => runner.handle(input, actor);
  return {actor, store, state, runner, call};
}
const metaSteps = [
  {
    id: 'campaign',
    kind: 'write',
    gateway: 'meta_native_action',
    connection_id: 'meta',
    account_id: '100',
    arguments: {action: 'meta_campaign_create', payload: {name: 'Launch', status: 'PAUSED'}},
    depends_on: [],
  },
  {
    id: 'adset',
    kind: 'write',
    gateway: 'meta_native_action',
    connection_id: 'meta',
    account_id: '100',
    arguments: {
      action: 'meta_adset_create',
      payload: {name: 'Launch · traffic', campaign_id: {$ref: 'campaign#/data/id'}, status: 'ACTIVE'},
    },
    depends_on: ['campaign'],
  },
  {
    id: 'ad',
    kind: 'write',
    gateway: 'meta_native_action',
    connection_id: 'meta',
    account_id: '100',
    arguments: {action: 'meta_ad_create', payload: {name: 'Launch · ad', adset_id: {$ref: 'adset#/data/id'}}},
    depends_on: ['adset'],
  },
];
async function stranded(f) {
  const run = await f.call({action: 'create', name: 'Meta launch', brief: 'Synthetic.', steps: metaSteps});
  for (let i = 0; i < 2; i++) {
    const p = await f.call({action: 'prepare_next', id: run.id});
    await f.call({
      action: 'execute_next',
      id: run.id,
      review_id: p.review.review_id,
      idempotency_key: p.review.idempotency_key,
      confirmed: true,
    });
  }
  return run.id;
}

test('(b) a Meta 400 offers confirm_absent; an incomplete probe or a match refuses; a complete empty probe plus attestation allows recover_step', async () => {
  const f = metaFixture();
  try {
    const id = await stranded(f);
    const blocked = await f.call({action: 'prepare_next', id});
    assert.equal(blocked.blocked, true);
    assert.deepEqual(blocked.next_call, {
      tool: 'amcp_campaign',
      arguments: {action: 'confirm_absent', id, step_id: 'adset'},
    });
    // Without proof the key stays uncertain and recover_step is refused.
    await assert.rejects(() => f.call({action: 'recover_step', id, step_id: 'adset', confirmed: true, arguments: {}}), {
      code: 'RECOVERY_NOT_SAFE',
    });
    // An incomplete probe: a next page without a cursor, a truncated page, or a refused read.
    for (const pages of [
      [{data: [], paging: {next: 'https://graph.example/next'}}],
      [{data: [], truncated: true}],
      ['error'],
    ]) {
      f.state.pages = pages;
      await assert.rejects(
        () => f.call({action: 'confirm_absent', id, step_id: 'adset', confirmed: true}),
        e => {
          assert.equal(e.code, 'RECOVERY_NOT_SAFE');
          assert.equal(e.details.reason, 'absence_probe_incomplete');
          return true;
        },
      );
    }
    // A match on the second page: an ad set of the step's name created since the claim.
    f.state.pages = [
      {
        data: [{id: '1', name: 'Other', created_time: new Date().toISOString(), campaign_id: '701'}],
        paging: {next: 'x', cursors: {after: '1'}},
      },
      {data: [{id: '2', name: 'Launch · traffic', created_time: new Date().toISOString(), campaign_id: '701'}]},
    ];
    await assert.rejects(
      () => f.call({action: 'confirm_absent', id, step_id: 'adset', confirmed: true}),
      e => {
        assert.equal(e.details.reason, 'resource_may_exist');
        assert.deepEqual(
          e.details.probe.matches.map(m => m.id),
          ['2'],
        );
        return true;
      },
    );
    // The probe reads the verified parent's children only, read-only.
    assert.ok(
      f.state.reads.every(r => r.action === 'meta_campaign_id_adsets_get' && r.path_params.campaign_id === '701'),
    );
    // A complete probe without a match: the same name created long before the claim is not this step's resource.
    f.state.pages = [
      {data: [{id: '3', name: 'Launch · traffic', created_time: '2020-01-01T00:00:00+0000', campaign_id: '701'}]},
    ];
    const probe = await f.call({action: 'confirm_absent', id, step_id: 'adset'});
    assert.equal(probe.probe.complete, true);
    assert.deepEqual(probe.probe.matches, []);
    assert.deepEqual(probe.next_call.add_after_user_approval, {confirmed: true});
    assert.equal(f.store.document(f.actor.tenantId, 'campaign_run', id).steps[1].absence, undefined);
    const attested = await f.call({...probe.next_call.arguments, confirmed: true});
    assert.equal(attested.next_call.arguments.action, 'recover_step');
    const saved = f.store.document(f.actor.tenantId, 'campaign_run', id).steps[1];
    assert.equal(saved.absence.attested, true);
    assert.equal(saved.absence.by, 'operator');
    const events = f.store.db
      .prepare('SELECT event FROM audit WHERE tenant_id=?')
      .all(f.actor.tenantId)
      .map(r => JSON.parse(r.event));
    assert.ok(events.some(e => e.event === 'campaign_step_absence_confirmed' && e.step_id === 'adset'));
    const recovered = await f.call({
      action: 'recover_step',
      id,
      step_id: 'adset',
      confirmed: true,
      patch: [{path: '/payload/name', value: 'Launch · traffic 2'}],
      detail: 'full',
    });
    const attempt = recovered.steps[1].previous_attempts.at(-1);
    assert.equal(attempt.key_retired.reason, 'confirmed_absent');
    assert.equal(attempt.absence.probe.complete, true);
    // The old key stays uncertain and is never sent again; the amended step is reviewed under a new key.
    assert.equal(
      f.store.db
        .prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?')
        .get(f.actor.tenantId, saved.review_id).state,
      'uncertain',
    );
    f.state.refuseAdset = false;
    const p = await f.call({action: 'prepare_next', id});
    assert.notEqual(p.review.review_id, saved.review_id);
  } finally {
    f.store.close();
  }
});

test('(c) continue_as_new carries the remaining steps with adopted predecessor IDs, linked both ways', async () => {
  const f = metaFixture();
  try {
    const id = await stranded(f);
    // Not while the refused step's outcome is unsettled.
    await assert.rejects(
      () => f.call({action: 'continue_as_new', id, confirmed: true}),
      e => {
        assert.equal(e.code, 'RECOVERY_NOT_SAFE');
        assert.deepEqual(
          e.details.blocked_steps.map(b => [b.step_id, b.next_call?.arguments?.action]),
          [['adset', 'confirm_absent']],
        );
        return true;
      },
    );
    f.state.pages = [{data: []}];
    await f.call({action: 'confirm_absent', id, step_id: 'adset', confirmed: true});
    await assert.rejects(() => f.call({action: 'continue_as_new', id}), {code: 'INVALID_ARGUMENT'});
    const next = await f.call({action: 'continue_as_new', id, confirmed: true, detail: 'full'});
    assert.notEqual(next.id, id);
    assert.equal(next.supersedes.id, id);
    assert.deepEqual(
      next.steps.map(s => s.id),
      ['adset', 'ad'],
    );
    const adset = next.steps[0];
    assert.equal(adset.arguments.payload.campaign_id, '701', 'the verified campaign is adopted as a literal ID');
    assert.deepEqual(adset.depends_on, []);
    assert.equal(adset.adopted_from.length, 1);
    assert.equal(adset.adopted_from[0].run_id, id);
    assert.equal(adset.adopted_from[0].step_id, 'campaign');
    assert.equal(typeof adset.adopted_from[0].review_id, 'string');
    assert.deepEqual(next.steps[1].arguments.payload.adset_id, {$ref: 'adset#/data/id'});
    assert.deepEqual(next.steps[1].depends_on, ['adset']);
    assert.equal(next.state, 'draft');
    const old = f.store.document(f.actor.tenantId, 'campaign_run', id);
    assert.equal(old.state, 'superseded');
    assert.equal(old.superseded_by.id, next.id);
    // The superseded plan sends nothing more and points to its successor; asking again returns the same successor.
    await assert.rejects(
      () => f.call({action: 'prepare_next', id}),
      e => {
        assert.equal(e.details.superseded_by, next.id);
        return true;
      },
    );
    const again = await f.call({action: 'continue_as_new', id, confirmed: true});
    assert.equal(again.id, next.id);
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 2);
    // The superseded plan needs nothing more in the operations feed; its successor is the one to act on.
    const feed = operationsPage(f.store, f.actor, {kind: 'campaign'}, true).operations;
    assert.equal(feed.find(o => o.id === id).category, 'complete');
    assert.notEqual(feed.find(o => o.id === next.id).category, 'complete');
    // The new plan runs its first step under a fresh review: the old plan's refused key is never reused.
    f.state.refuseAdset = false;
    const p = await f.call({action: 'prepare_next', id: next.id});
    assert.equal(p.step_id, 'adset');
    assert.equal(f.state.submissions.length, 2);
  } finally {
    f.store.close();
  }
});
