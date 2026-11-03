import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {NativeCampaignReports} from '../src/report-native.js';
import {MirrorError} from '../src/errors.js';
import {reviewedFamilies} from '../src/reviewed-families.js';
import {effectClass, familyEffect, familyEffects} from '../src/effect-class.js';
import {
  beginProviderJob,
  providerJobContracts,
  providerJobRetentionDays,
  purgeProviderJobReceipts,
  saveReportJobAccess,
  settleProviderJob,
} from '../src/provider-jobs.js';
import {ownerOperations, pauseCovers} from '../src/owner-operations.js';
import {loadConfig} from '../server/config.js';
import {createHttpApp} from '../server/http-app.js';
import {listenForFetch} from './http-listener.js';
import type {Actor, CompiledRequest, Connection, JsonObject} from '../src/types.js';

// RPT-06: provider report and export jobs are their own effect class (owner decision D18): declared by every family,
// gated by the deployment owner's switch, a role and an account grant, admitted, counted and retained with receipts.

const registry = new Registry(),
  gateway = 'x_ads_native_action',
  account = 'abc123',
  jobId = '1120829647711653888',
  tenant = 'provider-jobs-fixture';
const owner: Actor = {tenantId: tenant, userId: 'owner', role: 'admin'},
  operator: Actor = {tenantId: tenant, userId: 'operator', role: 'operator'},
  reader: Actor = {tenantId: tenant, userId: 'reader', role: 'reader'};
const credentials = {
  consumerKey: 'synthetic-app',
  consumerSecret: 'synthetic-secret',
  accessToken: 'synthetic-user',
  tokenSecret: 'synthetic-token-secret',
};
const definition = (): JsonObject => ({
  entity: 'CAMPAIGN',
  entity_ids: 'camp1',
  metric_groups: 'ENGAGEMENT,BILLING',
  placement: 'ALL_ON_TWITTER',
  granularity: 'TOTAL',
  start_time: '2026-08-01T00:00:00Z',
  end_time: '2026-08-03T00:00:00Z',
});

/** A synthetic X Ads API: report job creation, its status, the account and historical entities. Nothing leaves. */
function xFixture(policy: {allowWrites: boolean; providerJobs?: boolean}, grants: {write?: boolean} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 73).toString('base64'));
  const c: Connection = {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: tenant,
    gateway,
    accounts: [account],
    writeAccounts: grants.write ? [account] : [],
    label: 'Synthetic X login',
    enabled: true,
    scopes: [],
  };
  store.putConnection(owner, c, credentials);
  const calls: JsonObject[] = [],
    state: JsonObject = {writes: 0, query: definition()};
  const row = () => ({
    ...state.query,
    entity_ids: String(state.query.entity_ids).split(','),
    metric_groups: String(state.query.metric_groups).split(','),
    segmentation_type: null,
    country: null,
    platform: null,
    account_id: account,
    id_str: jobId,
    id: Number(jobId),
    status: 'PROCESSING',
    url: null,
    expires_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const transport = new NativeTransport(
    async (raw, init) => {
      const u = new URL(String(raw)),
        method = init?.method ?? 'GET';
      assert.equal(u.origin, 'https://ads-api.x.com');
      calls.push({path: u.pathname, method});
      if (method === 'POST') {
        state.writes++;
        state.query = Object.fromEntries(u.searchParams);
        return Response.json({data: row(), request: {params: {}}});
      }
      if (u.pathname === '/12/stats/jobs/accounts/' + account)
        return Response.json({data: [row()], next_cursor: null, request: {params: {job_ids: [Number(jobId)]}}});
      if (u.pathname === '/12/accounts/' + account)
        return Response.json({
          data: {id: account, currency: 'SAR', timezone: 'UTC', deleted: false, name: 'Synthetic', updated_at: '1'},
        });
      return Response.json({
        data: {id: u.pathname.split('/').at(-1), account_id: account, deleted: true, name: 'Historical'},
      });
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: policy.allowWrites,
    requireBeforeState: true,
    maxBudgetChange: 0,
    providerJobs: policy.providerJobs,
  });
  const job = (as: Actor) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action: 'x_stats_jobs_accounts_account_id_post',
          account_id: account,
          connection_id: c.id,
          params: definition(),
        },
      },
      as,
    );
  const execute = (p: JsonObject, as: Actor) =>
    service.call('amcp_write', {action: 'execute', review_id: p.data.review_id, confirmed: true}, as);
  // An advertising write on the same account: a campaign rename.
  const advertising = (as: Actor) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action: 'x_accounts_account_id_campaigns_campaign_id_put',
          account_id: account,
          connection_id: c.id,
          path_params: {campaign_id: '111'},
          payload: {name: 'Renamed'},
        },
      },
      as,
    );
  return {store, service, c, calls, state, job, execute, advertising};
}

test('RPT-06: every reviewed family declares an effect, and the provider-job families are exactly the declared job contracts', () => {
  const declared = new Set<string>();
  for (const family of reviewedFamilies()) {
    assert.ok(
      family.effect === undefined || typeof family.effect === 'function' || familyEffects.includes(family.effect),
      family.name + ' declares an unknown effect',
    );
    if (family.effect !== undefined) declared.add(family.name);
  }
  const jobFamilies = providerJobContracts.filter(j => j.family !== 'microsoft_reporting_pipeline').map(j => j.family);
  assert.deepEqual([...declared].sort(), [...jobFamilies].sort());
  for (const name of jobFamilies) {
    const family = reviewedFamilies().find(f => f.name === name);
    assert.ok(family, name + ' is a registered family');
  }
  // A GA4 audience export lists audience members: it stays a reviewed write; a report task is a job.
  const ga4 = reviewedFamilies().find(f => f.name === 'ga4_export_jobs')!;
  assert.equal(familyEffect(ga4, {action: 'ga4_create_report_task'} as CompiledRequest), 'provider_job');
  assert.equal(familyEffect(ga4, {action: 'ga4_create_audience_export'} as CompiledRequest), 'reviewed_write');
  // Microsoft's report submission is the reporting pipeline's job, though it compiles as a read.
  assert.equal(
    effectClass({
      gateway: 'microsoft_ads_native_action',
      action: 'SubmitGenerateReport',
      method: 'POST',
      path: '/Reporting/v13/GenerateReport/Submit',
      query: {},
      headers: {},
      readOnly: true,
      destructive: false,
      warnings: [],
    } as unknown as CompiledRequest),
    'provider_job',
  );
});

test('RPT-06 matrix: a report job follows the switch, the role and the grants; advertising writes stay refused without writes', async () => {
  for (const allowWrites of [false, true])
    for (const providerJobs of [false, true])
      for (const as of [reader, operator])
        for (const reportGrant of [false, true])
          for (const writeGrant of [false, true]) {
            const label = JSON.stringify({allowWrites, providerJobs, role: as.role, reportGrant, writeGrant});
            const f = xFixture({allowWrites, providerJobs}, {write: writeGrant});
            try {
              if (reportGrant)
                f.store.putDocument(tenant, 'report_job_grant', f.c.id, {connection_id: f.c.id, accounts: [account]});
              const allowed = providerJobs
                ? reportGrant || (allowWrites && as.role !== 'reader' && writeGrant)
                : allowWrites && as.role !== 'reader' && writeGrant;
              const p = await f.job(as);
              if (!allowed) {
                assert.equal(p.success, false, label);
                const expected = providerJobs
                  ? 'REPORT_JOB_GRANT_REQUIRED'
                  : !allowWrites
                    ? 'LIVE_WRITES_DISABLED'
                    : as.role === 'reader'
                      ? 'CONNECTOR_READ_ONLY'
                      : 'WRITE_ACCOUNT_FORBIDDEN';
                assert.equal(p.error.code, expected, label);
                assert.equal(f.calls.length, 0, label + ': nothing reached the provider');
              } else {
                assert.equal(p.success, true, label + ' ' + JSON.stringify(p.error));
                assert.equal(p.data.effect, 'provider_job', label);
                assert.equal(f.state.writes, 0, label);
                const e = await f.execute(p, as);
                assert.equal(e.success, true, label + ' ' + JSON.stringify(e.error));
                assert.equal(f.state.writes, 1, label);
                const receipt = f.store.document(tenant, 'provider_job', p.data.review_id);
                assert.equal(receipt.state, 'accepted', label);
                assert.equal(receipt.source, 'reviewed', label);
                assert.equal(receipt.family, 'x_report_jobs', label);
                assert.equal(receipt.resubmission, 'never_automatic', label);
                // Executing the same review again replays; the job is never sent twice.
                assert.equal((await f.execute(p, as)).data.replayed, true, label);
                assert.equal(f.state.writes, 1, label);
              }
              // Advertising writes: the switch and the report-job grant never open them.
              const before = f.calls.length,
                w = await f.advertising(as);
              if (!allowWrites || as.role === 'reader' || !writeGrant) {
                assert.equal(w.success, false, label + ': advertising write');
                assert.equal(
                  w.error.code,
                  !allowWrites
                    ? 'LIVE_WRITES_DISABLED'
                    : as.role === 'reader'
                      ? 'CONNECTOR_READ_ONLY'
                      : 'WRITE_ACCOUNT_FORBIDDEN',
                  label + ': advertising write',
                );
                assert.equal(f.calls.length, before, label + ': no advertising request was sent');
              }
            } finally {
              f.store.close();
            }
          }
});

test('RPT-06: with the switch off, a read-only deployment refuses report jobs first, as before', async () => {
  const f = xFixture({allowWrites: false}, {write: true});
  try {
    f.store.putDocument(tenant, 'report_job_grant', f.c.id, {connection_id: f.c.id, accounts: [account]});
    const p = await f.job(operator);
    assert.equal(p.error.code, 'LIVE_WRITES_DISABLED');
    assert.ok(p.error.details.next_call, 'the early refusal still names the inspection');
    assert.equal(f.calls.length, 0);
    const listed = f.service.listTools().find(t => t.name === 'amcp_write')!;
    assert.deepEqual(listed.inputSchema.properties.action.enum, ['help', 'inspect']);
    assert.equal(listed.annotations.readOnlyHint, true);
  } finally {
    f.store.close();
  }
});

test('RPT-06: a read-only deployment with the switch lists job prepare and execute, not annotated read-only', async () => {
  const f = xFixture({allowWrites: false, providerJobs: true});
  try {
    const listed = f.service.listTools().find(t => t.name === 'amcp_write')!;
    assert.deepEqual(listed.inputSchema.properties.action.enum, ['help', 'inspect', 'prepare', 'execute', 'status']);
    assert.notEqual(listed.annotations.readOnlyHint, true);
    // inspect names the job's authority without a network call.
    const i = await f.service.call(
      'amcp_write',
      {
        action: 'inspect',
        gateway,
        arguments: {action: 'x_stats_jobs_accounts_account_id_post', account_id: account, params: definition()},
      },
      reader,
    );
    assert.equal(i.data.effect, 'provider_job');
    assert.equal(i.data.requirements.account_write_grant_required, false);
    assert.equal(i.data.requirements.provider_jobs_switch, 'on');
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});

test('RPT-06 pause scopes: a provider-jobs pause stops jobs only; an advertising pause lets jobs run; all stops both', async () => {
  for (const scope of ['all', 'advertising', 'provider_jobs']) {
    const f = xFixture({allowWrites: false, providerJobs: true});
    try {
      f.store.putDocument(tenant, 'report_job_grant', f.c.id, {connection_id: f.c.id, accounts: [account]});
      const p = await f.job(reader);
      assert.equal(p.success, true, scope);
      ownerOperations(
        f.store,
        {action: 'pause_writes', reason: 'Incident', confirmed: true, pause_scope: scope},
        owner,
      );
      const e = await f.execute(p, reader);
      if (scope === 'advertising') {
        assert.equal(e.success, true, scope);
        assert.equal(f.state.writes, 1);
      } else {
        assert.equal(e.error.code, 'WRITES_PAUSED', scope);
        assert.equal(e.error.details.scope, scope);
        assert.equal(f.state.writes, 0, scope);
      }
    } finally {
      f.store.close();
    }
  }
  assert.equal(pauseCovers({paused: true}, 'provider_jobs'), true, 'a pause saved before scopes stops jobs too');
  assert.equal(pauseCovers({paused: true}, 'advertising'), true);
  const f = xFixture({allowWrites: true});
  try {
    assert.equal(
      (() => {
        try {
          ownerOperations(f.store, {action: 'pause_writes', reason: 'x', confirmed: true, pause_scope: 'some'}, owner);
        } catch (e) {
          return (e as MirrorError).code;
        }
      })(),
      'INVALID_ARGUMENT',
    );
  } finally {
    f.store.close();
  }
});

test('RPT-06: owner health shows the switch, its blocker and the receipts; the capability graph names provider_jobs_disabled', async () => {
  const f = xFixture({allowWrites: false, providerJobs: false});
  try {
    const health = ownerOperations(f.store, {action: 'health'}, owner, {
      providerJobs: {allowWrites: false, enabled: false},
    });
    assert.equal(health.provider_jobs.switch, 'off');
    assert.equal(health.provider_jobs.blocker, 'provider_jobs_disabled');
    const caps = await f.service.call('amcp_workspace', {action: 'capabilities'}, operator);
    assert.equal(caps.data.provider_jobs.switch, 'off');
    assert.ok(caps.data.provider_jobs.blockers.includes('provider_jobs_disabled'));
  } finally {
    f.store.close();
  }
  const on = xFixture({allowWrites: false, providerJobs: true});
  try {
    let caps = await on.service.call('amcp_workspace', {action: 'capabilities'}, reader);
    assert.deepEqual(caps.data.provider_jobs.blockers, ['report_job_grant_required']);
    on.store.putDocument(tenant, 'report_job_grant', on.c.id, {connection_id: on.c.id, accounts: [account]});
    caps = await on.service.call('amcp_workspace', {action: 'capabilities'}, reader);
    assert.equal(caps.data.provider_jobs.state, 'ready_for_preflight');
    const p = await on.job(reader);
    await on.execute(p, reader);
    const health = ownerOperations(on.store, {action: 'health'}, owner, {
      providerJobs: {allowWrites: false, enabled: true},
    });
    assert.equal(health.provider_jobs.switch, 'on');
    assert.equal(health.provider_jobs.receipts.created, 1);
  } finally {
    on.store.close();
  }
});

test('RPT-06: report-job grants need an administrator, the switch, the selected accounts and confirmation; removal always works', () => {
  const f = xFixture({allowWrites: false, providerJobs: true});
  try {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as MirrorError).code;
      }
    };
    assert.equal(
      code(() => saveReportJobAccess(f.store, operator, f.c, {accounts: [account]}, true)),
      'FORBIDDEN',
    );
    assert.equal(
      code(() => saveReportJobAccess(f.store, owner, f.c, {accounts: [account], confirmed: true}, false)),
      'PROVIDER_JOBS_DISABLED',
    );
    assert.equal(
      code(() => saveReportJobAccess(f.store, owner, f.c, {accounts: [account]}, true)),
      'REPORT_JOB_CONFIRMATION_REQUIRED',
    );
    assert.equal(
      code(() => saveReportJobAccess(f.store, owner, f.c, {accounts: ['other'], confirmed: true}, true)),
      'WRITE_ACCOUNT_NOT_SELECTED',
    );
    const saved = saveReportJobAccess(f.store, owner, f.c, {accounts: [account], confirmed: true}, true);
    assert.deepEqual(saved.added, [account]);
    // The switch turned off later: an existing grant can still be removed.
    const removed = saveReportJobAccess(f.store, owner, f.c, {accounts: []}, false);
    assert.deepEqual(removed.removed, [account]);
    const google = {...f.c, id: 'google-login', gateway: 'google_ads_native_action', accounts: ['1']};
    assert.equal(
      code(() => saveReportJobAccess(f.store, owner, google, {accounts: ['1'], confirmed: true}, true)),
      'REPORT_JOBS_UNAVAILABLE',
    );
  } finally {
    f.store.close();
  }
});

test('RPT-06: submitting and uncertain receipts are kept a bounded time too, measured from their creation', () => {
  // Regression (wave 3a review): only accepted and rejected receipts were ever purged, so submitting and uncertain ones,
  // which name the account, login and actor of a job, were kept forever.
  const store = new Store(':memory:', Buffer.alloc(32, 79).toString('base64')),
    day = 86400000,
    now = Date.now();
  try {
    store.ensureTenant(tenant);
    const job = (id: string) =>
      beginProviderJob(store, tenant, {
        id,
        gateway,
        account_id: account,
        connection_id: 'login',
        actor: 'operator',
        source: 'reviewed',
      });
    const age = (id: string, days: number) => {
      const {id: _id, revision: _revision, ...data} = store.document(tenant, 'provider_job', id);
      store.putDocument(tenant, 'provider_job', id, {...data, created_at: now - days * day});
    };
    for (const id of ['old-submitting', 'old-uncertain', 'recent-uncertain', 'old-accepted']) job(id);
    settleProviderJob(store, tenant, 'old-uncertain', 'uncertain');
    settleProviderJob(store, tenant, 'recent-uncertain', 'uncertain');
    settleProviderJob(store, tenant, 'old-accepted', 'accepted');
    for (const id of ['old-submitting', 'old-uncertain', 'old-accepted']) age(id, providerJobRetentionDays + 1);
    age('recent-uncertain', providerJobRetentionDays - 1);
    assert.equal(purgeProviderJobReceipts(store, tenant, now), 2);
    assert.deepEqual(
      store
        .documents(tenant, 'provider_job')
        .map(r => String(r.id))
        .sort(),
      ['old-accepted', 'recent-uncertain'],
      'an accepted receipt follows its own retain_until; an unsettled one younger than the period stays',
    );
    // Settled receipts still go once their own retention has passed.
    assert.equal(purgeProviderJobReceipts(store, tenant, now + (providerJobRetentionDays + 1) * day), 2);
    assert.equal(store.documents(tenant, 'provider_job').length, 0);
  } finally {
    store.close();
  }
});

test('RPT-06: AMCP_PROVIDER_JOBS accepts only true or false and defaults off', () => {
  assert.equal(loadConfig({}, 'stdio').providerJobs, false);
  assert.equal(loadConfig({AMCP_PROVIDER_JOBS: 'true'}, 'stdio').providerJobs, true);
  assert.throws(() => loadConfig({AMCP_PROVIDER_JOBS: 'yes'}, 'stdio'), /AMCP_PROVIDER_JOBS must be true or false/);
});

// Microsoft's report submission through the reporting pipeline (the Overview).
const msActor: Actor = {tenantId: 'microsoft-jobs', userId: 'owner', role: 'admin'};
function microsoftFixture(answer: (plan: JsonObject) => JsonObject) {
  const store = new Store(':memory:', Buffer.alloc(32, 67).toString('base64'));
  store.putConnection(
    msActor,
    {
      id: 'login',
      tenantId: msActor.tenantId,
      gateway: 'microsoft_ads_native_action',
      accounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const plans: JsonObject[] = [];
  const service = {
    store,
    runPlan: async (plan: JsonObject) => {
      plans.push(plan);
      return {success: true, data: answer(plan)};
    },
  };
  let checkpoint: JsonObject = {};
  const native = new NativeCampaignReports(service as never);
  const collect = (resume: JsonObject = checkpoint) =>
    native.collect(
      {platform: 'microsoft', account_id: '123', connection_id: 'login'},
      {since: '2026-08-01', until: '2026-08-07'},
      msActor,
      resume,
      v => {
        checkpoint = v;
      },
    );
  const submits = () => plans.filter(p => p.action === 'SubmitGenerateReport').length;
  const receipts = () => store.documents(msActor.tenantId, 'provider_job');
  return {store, plans, collect, submits, receipts, checkpoint: () => checkpoint};
}
const account123 = {Account: {Id: '123', Name: 'Synthetic', CurrencyCode: 'AED', TimeZone: 'AbuDhabiMuscat'}};
const done = {
  ReportRequestStatus: {Status: 'Success'},
  download_complete: true,
  potentially_incomplete: false,
  has_more: false,
  rows: [{AccountId: '123', CampaignId: '9', CampaignName: 'Search', CurrencyCode: 'AED', Spend: '12.5'}],
};

test('RPT-06: Microsoft report submission is admitted and receipted; a resumed Overview reuses the receipt and job', async () => {
  let pending = true;
  const f = microsoftFixture(plan => {
    if (plan.action === 'GetAccount') return account123;
    if (plan.action === 'SubmitGenerateReport') return {ReportRequestId: 'r1'};
    return pending ? {ReportRequestStatus: {Status: 'Pending'}} : done;
  });
  try {
    await assert.rejects(f.collect(), (e: JsonObject) => e.code === 'REPORT_PENDING');
    assert.equal(f.submits(), 1);
    const [receipt] = f.receipts();
    assert.equal(receipt!.state, 'accepted');
    assert.equal(receipt!.source, 'reporting_pipeline');
    assert.equal(receipt!.job_id, 'r1');
    assert.equal(f.checkpoint().provider_job_receipt, receipt!.id);
    assert.equal(f.checkpoint().report_id, 'r1');
    pending = false;
    const result = await f.collect();
    assert.equal(result.complete, true);
    assert.equal(f.submits(), 1, 'the resumed Overview polled the original job');
    assert.equal(f.receipts().length, 1);
  } finally {
    f.store.close();
  }
});

test('RPT-06: a lost Microsoft submission response is never resubmitted when the Overview resumes', async () => {
  // Before RPT-06 the checkpoint was saved only after a response, so a resume submitted a second report job.
  let lose = true;
  const f = microsoftFixture(plan => {
    if (plan.action === 'GetAccount') return account123;
    if (plan.action === 'SubmitGenerateReport') {
      if (lose) throw new MirrorError('UPSTREAM_TIMEOUT', 'The provider did not answer in time.', {}, 504, true);
      return {ReportRequestId: 'r2'};
    }
    return done;
  });
  try {
    await assert.rejects(f.collect(), (e: JsonObject) => e.code === 'UPSTREAM_TIMEOUT');
    assert.equal(f.receipts()[0]!.state, 'uncertain');
    lose = false;
    await assert.rejects(
      f.collect(),
      (e: JsonObject) => e.code === 'PROVIDER_JOB_UNCERTAIN' && e.details.resubmission === 'never_automatic',
    );
    assert.equal(f.submits(), 1, 'the lost job was not submitted again');
  } finally {
    f.store.close();
  }
});

test('RPT-06: a Microsoft refusal that created nothing (2004) may be submitted again; admission bounds jobs per hour', async () => {
  let refuse = true;
  const f = microsoftFixture(plan => {
    if (plan.action === 'GetAccount') return account123;
    if (plan.action === 'SubmitGenerateReport') {
      if (refuse)
        throw new MirrorError(
          'UPSTREAM_ERROR',
          'Microsoft rejected the request.',
          {upstream: {OperationErrors: [{Code: 2004, Message: 'Synthetic incomplete data'}], Type: 'ApiFaultDetail'}},
          400,
        );
      return {ReportRequestId: 'r3'};
    }
    return done;
  });
  const previous = process.env.AMCP_PROVIDER_JOB_HOURLY_LIMIT;
  process.env.AMCP_PROVIDER_JOB_HOURLY_LIMIT = '2';
  try {
    await assert.rejects(f.collect(), (e: JsonObject) => e.code === 'REPORT_PENDING');
    assert.equal(f.receipts()[0]!.state, 'rejected');
    refuse = false;
    assert.equal((await f.collect()).complete, true);
    assert.equal(f.submits(), 2);
    // The hourly bound is full: a new snapshot is refused before anything is sent.
    await assert.rejects(f.collect({}), (e: JsonObject) => e.code === 'PROVIDER_JOB_QUOTA' && e.retryable === true);
    assert.equal(f.submits(), 2);
  } finally {
    if (previous === undefined) delete process.env.AMCP_PROVIDER_JOB_HOURLY_LIMIT;
    else process.env.AMCP_PROVIDER_JOB_HOURLY_LIMIT = previous;
    f.store.close();
  }
});

test('RPT-06: a pause covering provider jobs stops the Microsoft submission; an advertising pause does not', async () => {
  for (const scope of ['all', 'provider_jobs', 'advertising']) {
    const f = microsoftFixture(plan => {
      if (plan.action === 'GetAccount') return account123;
      if (plan.action === 'SubmitGenerateReport') return {ReportRequestId: 'r4'};
      return done;
    });
    try {
      ownerOperations(
        f.store,
        {action: 'pause_writes', reason: 'Incident', confirmed: true, pause_scope: scope},
        msActor,
      );
      if (scope === 'advertising') assert.equal((await f.collect()).complete, true);
      else {
        await assert.rejects(f.collect(), (e: JsonObject) => e.code === 'WRITES_PAUSED');
        assert.equal(f.submits(), 0, scope);
      }
    } finally {
      f.store.close();
    }
  }
});

const reviewerPassword = 'synthetic-report-job-reviewer-password';
async function website(providerJobs: boolean) {
  const origin = 'https://amcp.shop',
    master = Buffer.alloc(32, 81).toString('base64'),
    password = 'synthetic-report-job-password';
  const store = new Store(':memory:', master),
    service = new MirrorService(new Registry(), store, undefined, undefined, {
      allowWrites: false,
      maxBudgetChange: 0,
      requireBeforeState: true,
      providerJobs,
    });
  const blocked: typeof fetch = async () => {
    throw Error('No vendor network requests are permitted in access tests.');
  };
  const listener = await listenForFetch(
    createHttpApp(service, store, {
      website: {origin, masterKey: master, adminPassword: password, testPassword: reviewerPassword, fetcher: blocked},
    }),
  );
  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  const request = (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {Origin: origin, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = await request('/api/session', 'POST', {password}),
    session = await login.json();
  const headers = {Cookie: login.headers.get('set-cookie')!.split(';')[0]!, 'X-AMCP-CSRF': session.csrf as string};
  const admin: Actor = {tenantId: 'local', userId: 'test', role: 'admin'};
  store.putConnection(
    admin,
    {
      id: 'x-login',
      tenantId: 'local',
      gateway,
      accounts: [account, 'other'],
      label: 'Synthetic X login',
      enabled: true,
      scopes: [],
    },
    credentials,
  );
  return {
    store,
    request,
    headers,
    close: async () => {
      await new Promise<void>(resolve => listener.close(() => resolve()));
      store.close();
    },
  };
}

test('RPT-06 website: an administrator grants report jobs only under the switch, with confirmation, and can always revoke', async () => {
  const s = await website(true);
  try {
    const state = await (await s.request('/api/session', 'GET', undefined, s.headers)).json();
    assert.equal(state.providerJobs, true);
    assert.equal(state.writesEnabled, false);
    const route = '/api/connections/x-login/report-job-access';
    assert.equal((await s.request(route, 'PATCH', {accounts: [account], confirmed: true})).status, 401);
    assert.equal((await s.request(route, 'PATCH', {accounts: [account]}, s.headers)).status, 400);
    assert.equal((await s.request(route, 'PATCH', {accounts: ['missing'], confirmed: true}, s.headers)).status, 403);
    const saved = await s.request(route, 'PATCH', {accounts: [account], confirmed: true}, s.headers);
    assert.equal(saved.status, 200);
    const body = await saved.json();
    assert.deepEqual(body.reportJobAccounts, [account]);
    assert.equal(body.reportJobsAvailable, true);
    assert.deepEqual(body.writeAccounts, [], 'a report-job grant is not a write grant');
    assert.equal((await s.request(route, 'PATCH', {accounts: []}, s.headers)).status, 200);
    assert.equal(
      (s.store.audit('local', 1000) as JsonObject[]).filter(
        a => JSON.parse(a.event).event === 'report_job_access_changed',
      ).length,
      2,
    );
  } finally {
    await s.close();
  }
  const off = await website(false);
  try {
    const route = '/api/connections/x-login/report-job-access';
    const refused = await off.request(route, 'PATCH', {accounts: [account], confirmed: true}, off.headers);
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error.code, 'PROVIDER_JOBS_DISABLED');
  } finally {
    await off.close();
  }
});

test('RPT-06 website: a test account’s session never offers report jobs, even where the deployment allows them', async () => {
  // Provider jobs stay outside a test account's scope (docs/TEST-ACCOUNTS.md): the gate refuses report-job access,
  // so its pages must not offer it. Before, its session reported the deployment's switch like everyone else's.
  const s = await website(true);
  try {
    const login = await s.request('/api/session/test', 'POST', {password: reviewerPassword});
    assert.equal(login.status, 200);
    const reviewer = {Cookie: login.headers.get('set-cookie')!.split(';')[0]!};
    const state = await (await s.request('/api/session', 'GET', undefined, reviewer)).json();
    assert.equal(state.testAccount, true);
    assert.equal(state.providerJobs, false);
    const owner = await (await s.request('/api/session', 'GET', undefined, s.headers)).json();
    assert.equal(owner.providerJobs, true, 'the administrator still sees the deployment switch');
  } finally {
    await s.close();
  }
});
