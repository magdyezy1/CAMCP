import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingService} from '../dist/src/reporting.js';
import {assertRefused} from './helpers/assert-refused.mjs';

function fixture() {
  const actor = {tenantId: 'workbook', userId: 'operator', role: 'operator'};
  const store = new Store(':memory:', Buffer.alloc(32, 83).toString('base64'));
  const connection = {
    id: 'meta',
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['100'],
    enabled: true,
    label: 'Synthetic',
    scopes: [],
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('No network allowed');
    }),
  );
  const reporting = new ReportingService(store);
  const config = {
    platform: 'meta',
    account_id: 'act_100',
    connection_id: 'meta',
    date_range: {since: '2026-09-01', until: '2026-09-07'},
    private: 'CANARY',
  };
  const enqueue = (extra = {}, availableAt = Number.MAX_SAFE_INTEGER) =>
    store.enqueueReport(
      actor,
      {
        query_id: 'original-query',
        query_revision: 2,
        query_name: 'Original weekly report',
        query_config: config,
        ...extra,
      },
      availableAt,
    );
  const call = (args, as = actor) => service.call('amcp_workspace', args, as);
  const direct = (operation, id, as = actor, extra = {}) => reporting.handle(operation, {run_id: id, ...extra}, as);
  return {actor, store, service, connection, config, enqueue, call, direct};
}

test('workbook runs join the bounded metadata feed and their status excludes inputs, results and raw errors', async () => {
  const f = fixture();
  try {
    const prepared = f.enqueue(),
      failed = f.enqueue({}, Date.now());
    f.store.db
      .prepare("UPDATE jobs SET state='failed',result=?,error=? WHERE id=?")
      .run(
        JSON.stringify({rows: [{private: 'CANARY'}]}),
        JSON.stringify({code: 'JOB_REAUTHORIZATION_REQUIRED', message: 'CANARY', details: {private: 'CANARY'}}),
        failed,
      );
    f.store.document =
      f.store.documents =
      f.store.job =
        () => {
          throw Error('Full payload read forbidden for metadata');
        };
    const response = await f.call({action: 'operations', kind: 'workbook_report', limit: 1});
    assert.equal(response.success, true, JSON.stringify(response));
    assert.equal(response.data.coverage.length, 8);
    assert.equal(response.data.network_requests, 0);
    const next = await f.call({
      action: 'operations',
      kind: 'workbook_report',
      limit: 1,
      cursor: response.data.next_cursor,
    });
    const rows = [...response.data.operations, ...next.data.operations];
    assert.equal(rows.length, 2);
    assert.equal(rows.find(r => r.id === prepared).state, 'prepared');
    assert.equal(rows.find(r => r.id === prepared).category, 'attention');
    for (const row of rows) {
      assert.deepEqual(row.accounts, ['100']);
      assert.equal(row.website_path, '/operations?run_id=' + row.id);
      const detail = await f.call(row.next_call.arguments);
      assert.equal(detail.success, true, JSON.stringify(detail));
      assert.equal(detail.data.record_kind, 'workbook_report');
      assert.equal(detail.data.query_revision, 2);
      assert.equal(detail.data.can_resume, true);
      assert.equal(detail.data.destination, 'local');
      assert.doesNotMatch(JSON.stringify(detail), /CANARY|actor_binding|authority|lease_token|query_config|"result":/);
    }
    const status = f.direct('get_reporting_run_status', failed);
    assert.equal(status.error_code, 'JOB_REAUTHORIZATION_REQUIRED');
    assert.doesNotMatch(JSON.stringify(status), /CANARY|query_config|"input"|"result"/);
  } finally {
    f.store.close();
  }
});

test('status, result and recovery recheck retained run scope, tenant, job kind and current access', async () => {
  const f = fixture();
  try {
    const id = f.enqueue();
    f.store.putDocument(f.actor.tenantId, 'reporting_query', 'original-query', {
      name: 'Changed definition',
      query_config: {...f.config, account_id: '200'},
    });
    assert.equal(f.direct('get_reporting_run_status', id).account_id, '100');
    assert.equal(f.direct('get_reporting_run', id).input.query_revision, 2);
    assert.throws(
      () => f.direct('get_reporting_run_status', id, {...f.actor, tenantId: 'other'}),
      e => e.code === 'NOT_FOUND',
    );
    const other = f.store.enqueue(f.actor.tenantId, 'media_upload', {private: 'CANARY'});
    for (const operation of ['get_reporting_run', 'get_reporting_run_status', 'execute_reporting_run'])
      assert.throws(
        () => f.direct(operation, other),
        e => e.code === 'INVALID_REPORT_RUN',
      );
    f.store.putConnection({...f.actor, role: 'admin'}, {...f.connection, enabled: false}, {accessToken: 'synthetic'});
    for (const operation of ['get_reporting_run', 'get_reporting_run_status', 'execute_reporting_run'])
      assert.throws(
        () => f.direct(operation, id, f.actor, {dry_run: false}),
        e => e.code === 'CONNECTION_REQUIRED',
      );
    assert.deepEqual((await f.call({action: 'operations'})).data.operations, []);
    assert.equal((await f.call({action: 'report_run', id})).success, false);
    assert.equal(f.store.job(f.actor.tenantId, id).available_at, Number.MAX_SAFE_INTEGER);
  } finally {
    f.store.close();
  }
});

test('website recovery binds the displayed run state, requires confirmation and never restarts completed or running work', async () => {
  const f = fixture();
  try {
    const id = f.enqueue();
    let detail = (await f.call({action: 'report_run', id})).data;
    assert.ok(detail?.run_version, JSON.stringify(detail));
    const resume = {action: 'resume_report_run', id, run_version: detail.run_version};
    assert.equal((await f.call(resume)).success, false);
    assert.equal((await f.call({...resume, confirmed: true}, {...f.actor, role: 'reader'})).success, false);
    assert.equal(f.store.job(f.actor.tenantId, id).available_at, Number.MAX_SAFE_INTEGER);
    const queued = await f.call({...resume, confirmed: true});
    assert.equal(queued.success, true, JSON.stringify(queued));
    assert.equal(queued.data.state, 'queued');
    assert.equal(queued.data.id, id);
    assert.equal(queued.data.can_resume, false);
    assert.equal((await f.call({...resume, confirmed: true})).error.code, 'STALE_REPORT_RUN');
    const leased = f.store.leaseJob();
    assert.equal(leased.id, id);
    detail = (await f.call({action: 'report_run', id})).data;
    assert.equal(
      (await f.call({...resume, run_version: detail.run_version, confirmed: true})).error.code,
      'INVALID_JOB_STATE',
    );
    f.store.finishJob(id, leased.lease_token, {rows: [{spend: 1}]});
    detail = (await f.call({action: 'report_run', id})).data;
    assert.equal(detail.result_available, true);
    assert.equal(detail.can_resume, false);
    assert.equal(
      (await f.call({...resume, run_version: detail.run_version, confirmed: true})).error.code,
      'INVALID_JOB_STATE',
    );
    assert.equal(f.store.leaseJob(), undefined);
  } finally {
    f.store.close();
  }
});

test('native and delegated report scopes use canonical account anchors and malformed or ambiguous scopes stay hidden', async () => {
  const f = fixture();
  try {
    const direct = f.enqueue({
      query_config: {
        gateway: 'meta_native_action',
        arguments: {action: 'meta_ad_account_id_insights_get', account_id: '100', connection_id: 'meta'},
      },
    });
    const delegated = f.enqueue({
      query_config: {
        gateway: 'meta_native_action',
        arguments: {operation: 'synthetic', arguments: {account_id: '100', connection_id: 'meta'}},
      },
    });
    const invalid = [
      {},
      {platform: 'meta', account_id: ['100'], connection_id: 'meta'},
      {platform: 'meta', account_id: '100', connection_id: 7},
      {platform: 'meta', account_id: 'act_', connection_id: 'meta'},
      {gateway: 'meta_native_action', arguments: {account_id: '100', ad_account_id: '200', connection_id: 'meta'}},
      {
        gateway: 'meta_native_action',
        arguments: {account_id: '100', path_params: {ad_account_id: '200'}, connection_id: 'meta'},
      },
      {gateway: 'meta_native_action', arguments: {account_id: '100', connection_id: 'meta', connectionId: 'other'}},
      {
        gateway: 'meta_native_action',
        platform: 'meta',
        account_id: '100',
        arguments: {action: 'synthetic', account_id: '200', connection_id: 'meta'},
      },
      {
        gateway: 'meta_native_action',
        arguments: {operation: 'synthetic', account_id: '100', arguments: {account_id: '200', connection_id: 'meta'}},
      },
    ].map(query_config => f.enqueue({query_config}));
    const rows = (await f.call({action: 'operations', kind: 'workbook_report'})).data?.operations;
    assert.deepEqual(rows?.map(r => r.id).sort(), [direct, delegated].sort());
    for (const id of invalid)
      assert.throws(
        () => f.direct('get_reporting_run_status', id),
        e => assertRefused(e, ['REPORT_SCOPE_UNAVAILABLE', 'CONNECTION_REQUIRED']),
      );
    const missingConnection = f.enqueue({query_config: {platform: 'meta', account_id: '100'}});
    assert.equal(f.direct('get_reporting_run_status', missingConnection).connection_id, 'meta');
    f.store.putConnection({...f.actor, role: 'admin'}, {...f.connection, id: 'second'}, {accessToken: 'synthetic'});
    assert.throws(
      () => f.direct('get_reporting_run_status', missingConnection),
      e => e.code === 'AMBIGUOUS_CONNECTION',
    );
    const alias = f.enqueue({
      query_config: {
        gateway: 'meta_native_action',
        arguments: {path_params: {ad_account_id: 'act_100'}, connectionId: 'meta'},
      },
    });
    assert.equal(f.direct('get_reporting_run_status', alias).account_id, '100');
    assert.equal(f.direct('get_reporting_run_status', alias).connection_id, 'meta');
  } finally {
    f.store.close();
  }
});

test('status caps metadata and directs a rejected write query to correction without offering a retry', async () => {
  const f = fixture();
  try {
    const id = f.enqueue({query_name: 'N'.repeat(5000), query_id: {private: 'CANARY'}, schedule_id: ['CANARY']});
    f.store.db
      .prepare("UPDATE jobs SET state='failed',error=? WHERE id=?")
      .run(JSON.stringify({code: 'REPORT_WRITE_FORBIDDEN', message: 'CANARY'}), id);
    const detail = f.direct('get_reporting_run_status', id);
    assert.equal(detail.name.length, 200);
    assert.equal(detail.query_id, null);
    assert.equal(detail.schedule_id, null);
    assert.equal(detail.can_resume, false);
    assert.match(detail.next_safe_action, /corrected read-only query/);
    assert.doesNotMatch(JSON.stringify(detail), /CANARY/);
    assert.equal(
      (await f.call({action: 'resume_report_run', id, confirmed: true, run_version: detail.run_version})).success,
      false,
    );
  } finally {
    f.store.close();
  }
});

test('workbook pages continue beyond hidden scans without leaking names and reject a revoked session', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 502; i++) {
      const id = f.enqueue({query_config: {...f.config, account_id: '200'}, query_name: 'CANARY'});
      f.store.db.prepare('UPDATE jobs SET updated_at=100 WHERE id=?').run(id);
    }
    const id = f.enqueue();
    f.store.db.prepare('UPDATE jobs SET updated_at=1 WHERE id=?').run(id);
    let response = await f.call({action: 'operations', kind: 'workbook_report', limit: 1});
    assert.equal(response.success, true, JSON.stringify(response));
    assert.equal(response.data.operations.length, 0);
    assert.equal(response.data.has_more, true);
    response = await f.call({
      action: 'operations',
      kind: 'workbook_report',
      limit: 1,
      cursor: response.data.next_cursor,
    });
    assert.deepEqual(
      response.data.operations.map(r => r.id),
      [id],
    );
    assert.doesNotMatch(JSON.stringify(response), /CANARY/);
    const key = f.store.createKey(f.actor),
      actor = f.store.authenticate(key);
    f.store.bindActorCheck(actor, () => {
      throw Error('synthetic session revoked');
    });
    await assert.rejects(async () => f.direct('get_reporting_run_status', id, actor), /revoked/);
  } finally {
    f.store.close();
  }
});
