// Ruling 17 (NF-1b): what a finished snapshot costs the thread that writes it. Through the real worker, a 25,000-row snapshot
// is one document of about 170 MB; after the job wrote it, its own checks read it back and parsed it five times (the
// monitor evaluation reads it, and every actor check of the job's bound guard reads the report to see that it is still
// current), about 4 s of one synchronous stretch. The guard now reads only the three facts it stands on, from SQLite, and the
// evaluation works from the record the job has just built. These tests pin that nothing the guard refused is allowed now
// (a snapshot job whose report, schedule, member, connection or access set changes while it collects stops as it did), that
// the stored snapshot is not parsed after it is written, and that the evaluation from memory sees what the stored report
// holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';
import {saveAccessSet} from '../dist/src/access-sets.js';
import {sheetsGateway} from '../dist/src/google-sheets.js';
import {monitorOperation} from '../dist/src/report-monitors.js';
import {fingerprint} from '../dist/src/workspace-core.js';
import {WebStore} from '../dist/server/web-store.js';
import {UserAccounts} from '../dist/server/user-accounts.js';
import {row} from './helpers/report-packets.mjs';
import {reportEngine} from './helpers/report-engine.mjs';

const admin = {tenantId: 't1', userId: 'owner', role: 'admin'},
  operator = {tenantId: 't1', userId: 'op', role: 'operator'},
  key = Buffer.alloc(32, 121).toString('base64');
const sources = accounts =>
  accounts.map(account => ({
    platform: 'meta',
    account_id: account,
    connection_id: 'login',
    levels: ['campaign'],
    delivered_only: false,
    report_options: {attribution_windows: ['7d_click', '1d_view']},
  }));
const definition = {
  contract_version: 'overview-config-v4',
  name: 'Guard',
  client_name: 'C',
  sources: sources(['100', '101']),
  date_range: {since: '2026-09-01', until: '2026-09-02'},
  metrics: ['spend', 'clicks'],
  custom_metrics: [],
};
const collected = (source, dates) => ({
  source,
  rows: [
    {
      id: 'c1',
      campaign_id: 'c1',
      campaign_name: 'C1',
      entity_name: 'C1',
      name: 'C1',
      objective: 'OUTCOME_SALES',
      metrics: {spend: '10.5', clicks: '30'},
      result: {value: '2', cost_per_result: '5.25', label: 'Purchases'},
    },
  ],
  currency: 'USD',
  timezone: 'UTC',
  complete: true,
  collection_complete: true,
  source_kind: 'paid',
  date_range: dates,
  warnings: [],
  lineage: [],
  captured_at: Date.now(),
  result_definition: 'S',
  attribution: 'S',
});
const login = (store, tenant, accounts = ['100', '101'], enabled = true) =>
  store.putConnection(
    {tenantId: tenant, userId: 'provisioner', role: 'admin'},
    {id: 'login', tenantId: tenant, gateway: 'meta_native_action', accounts, enabled, scopes: [], label: 'S'},
    {accessToken: 'synthetic'},
  );
const bindings = accounts =>
  accounts.map(account_id => ({gateway: 'meta_native_action', connection_id: 'login', account_id}));

/**
 * One snapshot job over two accounts through the real worker, with `mutate` run while the first account is collected (or,
 * with `afterWrite`, just after the snapshot is committed, before the checks that follow its write), and what became of the
 * report and of its job. `setup` prepares the workspace and returns what `actorOf` and `mutate` need.
 */
async function collectWhile(t, {setup, actorOf, mutate, schedule = false, afterWrite = false}) {
  const store = new Store(':memory:', key);
  t.after(() => store.close());
  const context = {store, tenant: 't1', actor: operator};
  // A case that prepares its own workspace logs in itself; the others get the login of two accounts.
  if (setup) Object.assign(context, await setup(context));
  else login(store, context.tenant);
  context.actor = actorOf?.(context) ?? context.actor;
  const fetcher = async () => {
    throw new Error('Unexpected provider request');
  };
  const overview = new ReportingOverview(
    new MirrorService(new Registry(), store, new NativeTransport(fetcher, async () => {})),
    fetcher,
  );
  context.overview = overview;
  let first = true;
  overview.native.collect = async (source, dates) => {
    if (first && !afterWrite) {
      first = false;
      await mutate(context);
    }
    return collected(source, dates);
  };
  if (afterWrite) {
    let written = false,
      done = false;
    const put = store.putDocument.bind(store),
      transaction = store.transaction.bind(store);
    store.putDocument = (tenant, kind, id, data, ...rest) => {
      const out = put(tenant, kind, id, data, ...rest);
      if (kind === 'overview_report' && ['complete', 'partial', 'failed'].includes(data?.state)) written = true;
      return out;
    };
    store.transaction = work => {
      const out = transaction(work);
      if (written && !done) {
        done = true;
        mutate(context);
      }
      return out;
    };
  }
  overview.native.verifyAccount = async () => undefined;
  const worker = new ReportWorker(
    store,
    async () => ({}),
    (tenant, kind, input) => overview.work(tenant, kind, input),
  );
  if (schedule) {
    store.putConnection(
      admin,
      {
        id: 'sheets',
        tenantId: 't1',
        gateway: sheetsGateway,
        accounts: ['sheet1'],
        enabled: true,
        label: 'Fixture Sheets',
        scopes: ['https://www.googleapis.com/auth/drive.file'],
      },
      {accessToken: 'synthetic'},
    );
    store.putDocument('t1', 'sheets_destination', 'dest', {spreadsheet_id: 'sheet1', connection_id: 'sheets'});
    context.schedule = await overview.handle(
      {
        action: 'schedule',
        config: {...definition, date_range: {preset: 'last_complete_days', days: 7, timezone: 'UTC'}},
        schedule: {schedule_kind: 'daily', timezone: 'UTC', schedule_config: {hour: 8}, destination_id: 'dest'},
        confirmed: true,
      },
      context.actor,
    );
    const due = store.document('t1', 'overview_schedule', context.schedule.id);
    store.putDocument('t1', 'overview_schedule', due.id, {...due, next_run_at: Date.now() - 60000});
    overview.tick();
    const queued = store.db.prepare("SELECT id, input FROM jobs WHERE kind='report_overview'").get();
    context.run = {id: JSON.parse(queued.input).report_id, job_id: queued.id};
  } else context.run = await overview.handle({action: 'run', confirmed: true, config: definition}, context.actor);
  await worker.once();
  const stored = (() => {
      try {
        const d = store.document(context.tenant, 'overview_report', context.run.id);
        return {state: d.state, rows: d.rows?.length ?? null, error: d.error?.code ?? null};
      } catch (error) {
        return {missing: error.code};
      }
    })(),
    job = store.db.prepare('SELECT state, error FROM jobs WHERE id=?').get(context.run.job_id);
  return {report: stored, job: {state: job.state, code: job.error ? JSON.parse(job.error).code : null}};
}

const patchSchedule =
  patch =>
  ({store, schedule}) => {
    const s = store.document('t1', 'overview_schedule', schedule.id);
    store.putDocument('t1', 'overview_schedule', s.id, {...s, ...patch(s)});
  };
const limitedTo = accounts => ({
  setup: ({store}) => {
    login(store, 't1');
    return {set: saveAccessSet(store, admin, {name: 'client-a', bindings: bindings(accounts)})};
  },
  actorOf: ({set}) => ({...operator, accessSetId: set.id}),
});
const member = {
  setup: ({store}) => {
    const user = new UserAccounts(
      new WebStore(store, {origin: 'https://guard.example.test', masterKey: key, authEnv: {}}),
    ).newUser('Guard member', 'guard@example.test', null, true);
    login(store, user.tenant_id);
    return {
      tenant: user.tenant_id,
      user,
      actor: {tenantId: user.tenant_id, userId: user.id, role: 'admin', ownerUserId: user.id},
    };
  },
};
const deactivate = ({store, tenant, user}) =>
  store.db.prepare('UPDATE workspace_memberships SET active=0 WHERE tenant_id=? AND user_id=?').run(tenant, user.id); // A snapshot job re-checks its authority at every source and after collection (its bound guard reads the report it works
// for: cancelled, or scheduled and the schedule has gone, ends the job). Each case is a change that happens while the first
// of two accounts is collected; what the job and the report become is what the guard has always refused.
const stops = [
  [
    'nothing changes: the control, a complete snapshot of two rows',
    {mutate: () => {}},
    {state: 'complete', rows: 2, error: null},
    {state: 'complete'},
  ],
  [
    'the report is cancelled',
    {mutate: ({overview, run, actor}) => overview.handle({action: 'cancel', id: run.job_id, confirmed: true}, actor)},
    {state: 'cancelled', rows: 0, error: null},
    {state: 'cancelled'},
  ],
  [
    'the report is deleted',
    {mutate: ({store, run}) => store.deleteDocument('t1', 'overview_report', run.id)},
    {missing: 'NOT_FOUND'},
    {state: 'failed', code: 'NOT_FOUND'},
  ],
  [
    'its schedule is paused',
    {schedule: true, mutate: patchSchedule(() => ({is_active: false}))},
    {state: 'running', rows: 0, error: null},
    {state: 'failed', code: 'JOB_CANCELLED'},
  ],
  [
    'its schedule is edited',
    {schedule: true, mutate: patchSchedule(s => ({definition_version: (s.definition_version ?? 0) + 1}))},
    {state: 'running', rows: 0, error: null},
    {state: 'failed', code: 'JOB_CANCELLED'},
  ],
  [
    'its schedule is removed',
    {schedule: true, mutate: ({store, schedule}) => store.deleteDocument('t1', 'overview_schedule', schedule.id)},
    {state: 'failed', rows: 0, error: 'NOT_FOUND'},
    {state: 'failed', code: 'NOT_FOUND'},
  ],
  [
    'the login is removed',
    {mutate: ({store}) => store.db.prepare('DELETE FROM connections WHERE tenant_id=?').run('t1')},
    {state: 'failed', rows: 0, error: 'CONNECTION_REQUIRED'},
    {state: 'failed', code: 'CONNECTION_REQUIRED'},
  ],
  [
    'the login is disabled',
    {mutate: ({store}) => login(store, 't1', ['100', '101'], false)},
    {state: 'failed', rows: 0, error: 'CONNECTION_REQUIRED'},
    {state: 'failed', code: 'CONNECTION_REQUIRED'},
  ],
  [
    'an account leaves the login',
    {mutate: ({store}) => login(store, 't1', ['101'])},
    {state: 'failed', rows: 0, error: 'CONNECTION_REQUIRED'},
    {state: 'failed', code: 'CONNECTION_REQUIRED'},
  ],
  [
    'the client access set is narrowed',
    {
      ...limitedTo(['100', '101']),
      mutate: ({store, set}) =>
        saveAccessSet(store, admin, {
          id: set.id,
          revision: set.revision,
          name: 'client-a',
          bindings: bindings(['101']),
        }),
    },
    {state: 'failed', rows: 0, error: 'ACCOUNT_SCOPE_RESTRICTED'},
    {state: 'failed', code: 'ACCOUNT_SCOPE_RESTRICTED'},
  ],
  [
    'the client access set is removed',
    {...limitedTo(['100', '101']), mutate: ({store, set}) => store.deleteDocument('t1', 'access_set', set.id)},
    {state: 'failed', rows: 0, error: 'ACCOUNT_SCOPE_RESTRICTED'},
    {state: 'failed', code: 'ACCOUNT_SCOPE_RESTRICTED'},
  ],
  [
    'the member is deactivated',
    {...member, mutate: deactivate},
    {state: 'failed', rows: 0, error: 'MEMBERSHIP_REVOKED'},
    {state: 'failed', code: 'MEMBERSHIP_REVOKED'},
  ],
  // The same changes just after the snapshot is committed: what follows its write (the monitors' checks) is checked too.
  [
    'the member is deactivated just after the snapshot is written',
    {...member, afterWrite: true, mutate: deactivate},
    {state: 'complete', rows: 2, error: null},
    {state: 'failed', code: 'MEMBERSHIP_REVOKED'},
  ],
  [
    'the report is cancelled just after the snapshot is written',
    {
      afterWrite: true,
      mutate: ({store, run}) => {
        const d = store.document('t1', 'overview_report', run.id);
        store.putDocument('t1', 'overview_report', d.id, {...d, state: 'cancelled'});
      },
    },
    {state: 'cancelled', rows: 2, error: null},
    {state: 'failed', code: 'JOB_CANCELLED'},
  ],
  [
    'the report is deleted just after the snapshot is written',
    {afterWrite: true, mutate: ({store, run}) => store.deleteDocument('t1', 'overview_report', run.id)},
    {missing: 'NOT_FOUND'},
    {state: 'failed', code: 'NOT_FOUND'},
  ],
  [
    'its schedule is paused just after the snapshot is written',
    {afterWrite: true, schedule: true, mutate: patchSchedule(() => ({is_active: false}))},
    {state: 'complete', rows: 2, error: null},
    {state: 'failed', code: 'JOB_CANCELLED'},
  ],
];
for (const [what, options, report, job] of stops)
  test(`a snapshot job stops as the guard has always stopped it when ${what}`, async t => {
    const outcome = await collectWhile(t, options);
    assert.deepEqual(outcome.report, report);
    assert.deepEqual(outcome.job, {state: job.state, code: job.code ?? null});
  });

/**
 * The parses of the stored snapshot, counted from the moment it is written until `run` ends: every JSON.parse of a text
 * that is at least half the size of the stored report is the report (or nearly all of it) read back.
 */
async function parsedAfterTheWrite(store, run) {
  const original = JSON.parse,
    parsed = [];
  let armed = false;
  const put = store.putDocument.bind(store);
  store.putDocument = (tenant, kind, id, data, ...rest) => {
    const out = put(tenant, kind, id, data, ...rest);
    if (kind === 'overview_report' && ['complete', 'partial', 'failed'].includes(data?.state)) armed = true;
    return out;
  };
  JSON.parse = function (text, reviver) {
    if (armed && typeof text === 'string' && text.length > 20000) parsed.push(text.length);
    return original.call(this, text, reviver);
  };
  try {
    await run();
  } finally {
    JSON.parse = original;
    delete store.putDocument;
  }
  return parsed;
}
const campaigns = () =>
  Array.from({length: 28}, (_, i) => row('campaign', 'c' + i, {spend: '10.5', clicks: '7', conversions: '4'}));
const metrics = ['spend', 'clicks', 'conversions', 'cpa'];
const saveMonitor = (e, summary) =>
  monitorOperation(e.store, e.actor, {
    action: 'save_monitor',
    confirmed: true,
    monitor: {
      name: 'Spend ceiling',
      platform: summary.platform,
      connection_id: 'login',
      account_id: summary.account_id,
      currency: summary.currency,
      timezone: summary.timezone,
      result_definition: summary.result_definition,
      attribution: summary.attribution,
      metric: 'spend',
      comparison: 'above',
      threshold: '200',
      max_age_hours: 24,
    },
  });

test('NF-1b: once a snapshot is written the job does not read it back, its monitors still evaluate it, and they see what the stored report holds', async t => {
  const e = reportEngine(t, {rowsFor: () => campaigns(), accounts: ['100', '101']}),
    changes = {sources: sources(['100', '101']).map(s => ({...s, report_options: {complete_window: true}})), metrics},
    first = await e.go(['campaign'], changes),
    summary = first.stored.summary.find(s => s.account_id === '100');
  saveMonitor(e, summary);
  const queued = await e.queue(['campaign'], changes),
    parsed = await parsedAfterTheWrite(e.store, () => e.worker.once()),
    stored = e.stored(queued.id),
    size = e.store.db
      .prepare("SELECT length(data) AS n FROM documents WHERE kind='overview_report' AND id=?")
      .get(queued.id).n;
  assert.equal(stored.state, 'complete');
  assert.ok(size > 40000, 'the snapshot is big enough to tell a read of it from a read of anything else: ' + size);
  // Before the change: five reads of the report, two by the monitor evaluation and one for each of the checks that run
  // between its steps (an actor check reads the report the job works for, to see that it is still current).
  assert.deepEqual(
    parsed.filter(length => length >= size / 2),
    [],
    'the stored snapshot was parsed after it was written',
  );
  // The evaluation ran, from the record in memory: the rule opened its incident with the exact decimal.
  const [incident] = e.store.documents(e.actor.tenantId, 'report_incident');
  assert.equal(incident.state, 'open');
  assert.equal(incident.value, '294');
  assert.equal(incident.last_report_id, queued.id);
  // And it saw what the stored report holds: the hash of the evidence is the hash of the stored summary it stands on.
  const group = stored.summary.find(s => s.account_id === '100');
  assert.equal(incident.evidence.at(-1).source_hash, fingerprint({...group, observed_at: incident.observed_at}));
  assert.equal(e.store.documents(e.actor.tenantId, 'report_monitor')[0].last_evaluation.status, 'incident_active');
});

test('NF-1b: a document’s top-level facts are read by SQLite, without parsing the document, and a missing document is NOT_FOUND as before', t => {
  const store = new Store(':memory:', key);
  t.after(() => store.close());
  store.putDocument('t1', 'overview_report', 'r1', {
    state: 'running',
    schedule_id: 'sched-1',
    schedule_version: 3,
    config: {sources: [{state: 'decoy'}]},
    rows: Array.from({length: 4000}, (_, i) => ({row_key: 'k' + i, state: 'cancelled', metrics: {spend: String(i)}})),
  });
  store.putDocument('t1', 'overview_report', 'r2', {state: 'complete'});
  const original = JSON.parse,
    parsed = [];
  JSON.parse = function (text, reviver) {
    if (typeof text === 'string' && text.length > 20000) parsed.push(text.length);
    return original.call(this, text, reviver);
  };
  let first, second, other;
  try {
    first = store.documentFields('t1', 'overview_report', 'r1', ['state', 'schedule_id', 'schedule_version']);
    second = store.documentFields('t1', 'overview_report', 'r2', ['state', 'schedule_id', 'schedule_version']);
    other = (() => {
      try {
        return store.documentFields('t1', 'overview_report', 'gone', ['state']);
      } catch (error) {
        return error;
      }
    })();
  } finally {
    JSON.parse = original;
  }
  assert.deepEqual(parsed, [], 'nothing was parsed in JavaScript');
  // Top-level fields only: the decoy `state` inside the config and in the rows is not the document's.
  assert.deepEqual(first, {state: 'running', schedule_id: 'sched-1', schedule_version: 3});
  assert.deepEqual(second, {state: 'complete', schedule_id: null, schedule_version: null});
  assert.equal(other.code, 'NOT_FOUND');
  assert.equal(other.status, 404);
  assert.equal(other.message, 'Document not found in this tenant.');
  assert.throws(
    () => store.documentFields('t1', 'overview_report', 'r1', ['state) FROM documents; --']),
    /Invalid document field/,
  );
  // Another workspace's document is not found either.
  assert.throws(
    () => store.documentFields('t2', 'overview_report', 'r1', ['state']),
    error => error.code === 'NOT_FOUND',
  );
});
