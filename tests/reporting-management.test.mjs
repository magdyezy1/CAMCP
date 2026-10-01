import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {ReportingService} from '../dist/src/reporting.js';
const actor = {tenantId: 'query-management', userId: 'member', role: 'operator'};
function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 79).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 'meta',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const reporting = new ReportingService(store),
    service = new MirrorService(new Registry(), store);
  const config = account_id => ({
    platform: 'meta',
    connection_id: 'meta',
    account_id,
    date_range: {since: '2026-09-01', until: '2026-09-07'},
  });
  for (const [id, account] of [
    ['allowed', '100'],
    ['denied', '200'],
  ]) {
    store.putDocument(actor.tenantId, 'workbook', 'book-' + id, {
      spreadsheet_id: 'SHEET-' + id,
      created_by: actor.userId,
    });
    store.putDocument(actor.tenantId, 'reporting_query', id, {
      name: 'QUERY-' + id,
      workbook_binding_id: 'book-' + id,
      query_config: config(account),
    });
    store.putDocument(actor.tenantId, 'reporting_schedule', 'schedule-' + id, {
      name: 'SCHEDULE-' + id,
      workbook_binding_id: 'book-' + id,
      schedule_config: {query_id: id},
      actor_binding: 'DO-NOT-DISCLOSE',
      is_active: false,
    });
  }
  const local = (operation, args = {}, user = actor) => reporting.handle(operation, args, user);
  const call = input => service.call('amcp_workspace', input, actor);
  return {store, reporting, service, config, local, call};
}
test('reporting bootstraps respect current scope and requested workbook without exposing other queries or schedules', t => {
  const f = fixture(t);
  for (const operation of [
    'get_reporting_bootstrap',
    'get_reporting_workbook_bootstrap',
    'get_reporting_storage_overview',
  ]) {
    let result = f.local(operation);
    assert.deepEqual(
      result.queries.map(q => q.id),
      ['allowed'],
    );
    assert.deepEqual(
      result.schedules.map(q => q.id),
      ['schedule-allowed'],
    );
    assert.deepEqual(
      result.workbooks.map(q => q.id),
      ['book-allowed'],
    );
    assert.doesNotMatch(JSON.stringify(result), /denied|DO-NOT-DISCLOSE/);
    result = f.local(operation, {spreadsheet_id: 'SHEET-denied'});
    assert.equal(result.queries.length, 0);
    assert.equal(result.schedules.length, 0);
    assert.equal(result.workbooks.length, 0);
  }
});
test('legacy reporting edits and previews cannot read or rebind an inaccessible existing query', t => {
  const f = fixture(t);
  for (const dry_run of [true, false]) {
    assert.throws(
      () =>
        f.local('update_reporting_query', {query_id: 'denied', name: 'Attack', query_config: f.config('100'), dry_run}),
      /authorized connection/,
    );
    assert.throws(
      () =>
        f.local('create_reporting_query', {
          workbook_binding_id: 'book-allowed',
          name: 'No grant',
          query_config: f.config('200'),
          dry_run,
        }),
      /authorized connection/,
    );
    assert.throws(
      () => f.local('save_workbook_preferences', {workbook_binding_id: 'book-denied', preferences: {}, dry_run}),
      /authorized|scope|access/i,
    );
  }
  assert.equal(f.store.document(actor.tenantId, 'reporting_query', 'denied').name, 'QUERY-denied');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
});
test('current query detail and revision-bound editor expose scope and pause affected schedules without changing retained runs', async t => {
  const f = fixture(t);
  const job = f.store.enqueueReport(
    actor,
    {query_id: 'allowed', query_config: f.config('100')},
    Number.MAX_SAFE_INTEGER,
  );
  const schedule = f.store.document(actor.tenantId, 'reporting_schedule', 'schedule-allowed');
  f.store.putDocument(actor.tenantId, 'reporting_schedule', schedule.id, {...schedule, is_active: true});
  let r = await f.call({action: 'report_query', id: 'allowed'});
  assert.equal(r.success, true, JSON.stringify(r));
  const version = r.data.query_version;
  assert.equal(r.data.account_id, '100');
  r = await f.call({
    action: 'preview_report_query',
    id: 'allowed',
    query_version: version,
    query: {
      name: 'Updated',
      query_config: {...f.config('100'), date_range: {since: '2026-09-02', until: '2026-09-07'}},
    },
  });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.data.schedules_to_pause, 1);
  assert.equal(f.store.document(actor.tenantId, 'reporting_query', 'allowed').name, 'QUERY-allowed');
  const input = {
    action: 'save_report_query',
    id: 'allowed',
    query_version: version,
    query: r.data.query,
    confirmed: true,
  };
  r = await f.call(input);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.data.name, 'Updated');
  assert.equal(r.data.schedules_paused, 1);
  assert.equal(f.store.document(actor.tenantId, 'reporting_schedule', schedule.id).is_active, false);
  assert.equal(f.store.job(actor.tenantId, job).input.query_config.date_range.since, '2026-09-01');
  r = await f.call(input);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'STALE_REPORT_QUERY');
});

test('new native queries require independent reads, unambiguous account anchors and no inline credentials', t => {
  const f = fixture(t);
  const connection = 'aaaaaaaa-1111-4111-8111-111111111111';
  f.store.putConnection(
    {...actor, role: 'admin'},
    {
      id: connection,
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Native synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const native = {
    gateway: 'meta_native_action',
    arguments: {
      action: 'meta_ad_account_id_campaign_attribution_options_get',
      account_id: '100',
      connection_id: connection,
      params: {ad_account_id: 'act_100'},
    },
  };
  const create = query_config =>
    f.local('create_reporting_query', {
      workbook_binding_id: 'book-allowed',
      name: 'Native read',
      query_config,
      dry_run: true,
    });
  assert.equal(create(native).dry_run, true);
  assert.throws(
    () =>
      create({
        ...native,
        arguments: {
          ...native.arguments,
          action: 'meta_campaign_create',
          payload: {name: 'Do not write', status: 'PAUSED'},
        },
      }),
    /read/i,
  );
  assert.throws(
    () => create({...native, arguments: {...native.arguments, params: {ad_account_id: 'act_200'}}}),
    /conflicting|scope/,
  );
  assert.throws(
    () => create({...native, arguments: {...native.arguments, headers: {Authorization: 'Bearer synthetic-secret'}}}),
    /credentials/,
  );
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
});

test('query pages are metadata-only, continue past inaccessible records, filter workbooks and redact legacy secrets', async t => {
  const f = fixture(t);
  for (let i = 0; i < 510; i++)
    f.store.putDocument(actor.tenantId, 'reporting_query', '000-denied-' + String(i).padStart(3, '0'), {
      name: 'PRIVATE-CANARY',
      query_config: f.config('200'),
    });
  let r = await f.call({action: 'report_queries', limit: 1});
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.data.queries.length, 0);
  assert.equal(r.data.next_offset, 500);
  r = await f.call({action: 'report_queries', limit: 1, offset: r.data.next_offset});
  assert.equal(r.data.queries[0].id, 'allowed');
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE-CANARY|date_range/);
  r = await f.call({action: 'report_queries', spreadsheet_id: 'SHEET-allowed', limit: 1});
  assert.equal(r.data.queries[0].id, 'allowed');
  assert.equal(r.data.next_offset, null);
  const q = f.store.document(actor.tenantId, 'reporting_query', 'allowed');
  f.store.putDocument(actor.tenantId, 'reporting_query', q.id, {
    ...q,
    query_config: {...q.query_config, access_token: 'LEGACY-SECRET'},
  });
  r = await f.call({action: 'report_query', id: q.id});
  assert.equal(r.data.configuration_redacted, true);
  assert.doesNotMatch(JSON.stringify(r), /LEGACY-SECRET/);
});

test('oversized legacy definitions stay out of setup/detail; name-only edits preserve active clocks', async t => {
  const f = fixture(t),
    q = f.store.document(actor.tenantId, 'reporting_query', 'allowed');
  f.store.putDocument(actor.tenantId, 'reporting_query', q.id, {
    ...q,
    query_config: {...q.query_config, query: 'LARGE-PRIVATE-CANARY'.repeat(100000)},
  });
  const original = f.store.document.bind(f.store);
  let fullQueryReads = 0;
  f.store.document = (...args) => {
    if (args[1] === 'reporting_query') fullQueryReads++;
    return original(...args);
  };
  const bootstrap = f.local('get_reporting_bootstrap');
  assert.equal(bootstrap.queries[0].configuration_omitted, true);
  let r = await f.call({action: 'report_query', id: q.id});
  assert.equal(r.success, false);
  assert.equal(fullQueryReads, 0);
  f.store.document = original;
  f.store.putDocument(actor.tenantId, 'reporting_query', q.id, q);
  const s = f.store.document(actor.tenantId, 'reporting_schedule', 'schedule-allowed');
  f.store.putDocument(actor.tenantId, 'reporting_schedule', s.id, {...s, is_active: true});
  const renamed = f.local('update_reporting_query', {query_id: q.id, name: 'Name only', dry_run: false});
  assert.equal(renamed.schedules_paused, 0);
  assert.equal(f.store.document(actor.tenantId, 'reporting_schedule', s.id).is_active, true);
});

test('reviewed query updates refuse changed schedules, invalid windows, account switches, viewers and missing confirmation', async t => {
  const f = fixture(t);
  let r = await f.call({action: 'report_query', id: 'allowed'});
  const draft = {
    action: 'save_report_query',
    id: 'allowed',
    query_version: r.data.query_version,
    query: {name: 'Changed', query_config: f.config('100')},
  };
  assert.equal((await f.call(draft)).success, false);
  assert.equal(
    (await f.service.call('amcp_workspace', {...draft, confirmed: true}, {...actor, role: 'reader'})).error.code,
    'FORBIDDEN',
  );
  r = await f.call({
    ...draft,
    action: 'preview_report_query',
    query: {
      name: 'Invalid',
      query_config: {...f.config('100'), date_range: {since: '2026-02-30', until: '2026-03-02'}},
    },
  });
  assert.equal(r.success, false);
  r = await f.call({...draft, action: 'preview_report_query', query: {name: 'Foreign', query_config: f.config('200')}});
  assert.equal(r.success, false);
  const s = f.store.document(actor.tenantId, 'reporting_schedule', 'schedule-allowed');
  f.store.putDocument(actor.tenantId, 'reporting_schedule', s.id, {...s, name: 'Concurrent update'});
  r = await f.call({...draft, confirmed: true});
  assert.equal(r.error.code, 'STALE_REPORT_QUERY');
  assert.equal(f.store.document(actor.tenantId, 'reporting_query', 'allowed').name, 'QUERY-allowed');
});

test('legacy bootstrap and edits bound settings before loading bodies and authorize original records first', async t => {
  const f = fixture(t);
  const schedule = f.store.document(actor.tenantId, 'reporting_schedule', 'schedule-allowed');
  f.store.putDocument(actor.tenantId, 'reporting_schedule', schedule.id, {...schedule, padding: 'x'.repeat(100000)});
  const original = f.store.document.bind(f.store),
    reads = [];
  f.store.document = (tenant, kind, id) => {
    reads.push([kind, id]);
    return original(tenant, kind, id);
  };
  let result = f.local('get_reporting_bootstrap');
  assert.equal(result.schedules[0].settings_omitted, true);
  assert.equal(
    reads.some(([kind]) => kind === 'reporting_schedule'),
    false,
  );
  reads.length = 0;
  assert.throws(() => f.local('update_reporting_query', {query_id: 'denied', name: 'Hidden', dry_run: true}));
  assert.equal(
    reads.some(([kind, id]) => kind === 'reporting_query' && id === 'denied'),
    false,
  );
  for (const preferences of [{padding: 'x'.repeat(100000)}, {access_token: 'inline-secret'}])
    assert.throws(() =>
      f.local('save_workbook_preferences', {workbook_binding_id: 'book-allowed', preferences, dry_run: false}),
    );
  assert.equal(original(actor.tenantId, 'workbook', 'book-allowed').preferences, undefined);
  f.store.documents = () => {
    throw Error('Do not load the complete workbook collection');
  };
  result = f.local('bind_reporting_workbook', {spreadsheet_id: 'SHEET-allowed', dry_run: true});
  assert.equal(result.id, 'book-allowed');
  // A valid 64 KiB configuration still fits the separate bounded record envelope.
  const q = original(actor.tenantId, 'reporting_query', 'allowed');
  f.store.putDocument(actor.tenantId, 'reporting_query', q.id, {
    ...q,
    query_config: {...q.query_config, padding: 'x'.repeat(65000)},
  });
  const detail = await f.call({action: 'report_query', id: q.id});
  assert.equal(detail.success, true, JSON.stringify(detail.error));
});
