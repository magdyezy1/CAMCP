import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';
import {packFixture} from './fixtures/report-pack-data.mjs';
import {cleanupReports} from '../dist/src/owner-operations.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

function fixture() {
  const actor = {tenantId: 'local', userId: 'operator', role: 'operator'};
  const store = new Store(':memory:', Buffer.alloc(32, 85).toString('base64'));
  const connection = {
    id: 'meta',
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['00100'],
    enabled: true,
    label: 'Synthetic',
    scopes: [],
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  let network = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      network++;
      throw Error('Unexpected network');
    }),
  );
  const overview = new ReportingOverview(service),
    report = packFixture();
  store.putDocument(actor.tenantId, 'overview_report', report.id, report);
  const call = args => overview.handle(args, actor);
  const bindArgs = {
    action: 'bind_file_destination',
    idempotency_key: 'file-target-1',
    confirmed: true,
    file_destination: {
      name: 'Client pack',
      formats: ['pdf', 'xlsx'],
      presentation: {
        brand_name: 'Example client',
        accent_color: '#354B67',
        footer: 'Retained evidence',
        template: 'standard',
      },
    },
  };
  const bind = () => call(bindArgs);
  const queue = async () =>
    call({action: 'export', report_id: report.id, destination_id: (await bind()).id, confirmed: true});
  const worker = new ReportWorker(
    store,
    async () => {
      throw Error('No legacy reports');
    },
    (t, k, i) => overview.work(t, k, i),
  );
  return {
    actor,
    store,
    connection,
    service,
    overview,
    report,
    call,
    bindArgs,
    bind,
    queue,
    worker,
    network: () => network,
  };
}

test('file destinations require explicit local settings, confirmation and operator access, with stable creation keys', async () => {
  const f = fixture();
  try {
    const d = await f.bind();
    assert.equal(d.kind, 'report_files');
    assert.deepEqual(d.formats, ['pdf', 'xlsx']);
    assert.equal((await f.bind()).id, d.id);
    assert.equal((await f.call({action: 'bootstrap'})).file_destinations.length, 1);
    for (const invalid of [
      {confirmed: false},
      {file_destination: {...f.bindArgs.file_destination, path: 'C:/tmp/out'}},
      {file_destination: {...f.bindArgs.file_destination, formats: ['pdf', 'pdf']}},
      {file_destination: {...f.bindArgs.file_destination, formats: ['html']}},
      {file_destination: {...f.bindArgs.file_destination, name: 'Different'}},
    ])
      await assert.rejects(f.call({...f.bindArgs, ...invalid}));
    await assert.rejects(
      f.overview.handle({...f.bindArgs, idempotency_key: 'reader-target'}, {...f.actor, role: 'reader'}),
    );
    assert.equal(f.network(), 0);
  } finally {
    f.store.close();
  }
});

test('file exports preserve exact bytes encrypted at rest and return scoped download receipts without another collection', async () => {
  const f = fixture();
  try {
    const queued = await f.queue();
    assert.equal((await f.queue()).job_id, queued.job_id);
    const destination = await f.bind();
    f.store.putDocument(f.actor.tenantId, 'report_file_destination', destination.id, {
      ...destination,
      presentation: {...destination.presentation, brand_name: 'Later branding'},
    });
    assert.equal(f.store.job(f.actor.tenantId, queued.job_id).kind, 'report_file_export');
    await f.worker.once();
    const status = await f.call({action: 'export_status', id: queued.id});
    assert.equal(status.state, 'complete', JSON.stringify(status));
    assert.equal(status.files.length, 2);
    assert.equal(status.presentation.brand_name, 'Example client');
    for (const receipt of status.files) {
      const download = f.overview.files.download(f.actor, queued.id, receipt.format);
      assert.equal(download.bytes.length, receipt.size_bytes);
      assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
      if (receipt.format === 'pdf') assert.equal(download.bytes.subarray(0, 5).toString(), '%PDF-');
      else assert.equal(download.bytes.subarray(0, 2).toString(), 'PK');
      const stored = f.store.document(f.actor.tenantId, 'report_file', receipt.id);
      assert.equal(stored.bytes, undefined);
      assert.equal(typeof stored.sealed, 'string');
      assert.doesNotMatch(stored.sealed, /%PDF-|Example client/);
    }
    assert.doesNotMatch(JSON.stringify(status), /sealed|actor_binding|\"bytes\":/);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM jobs').get().n, 1);
    assert.equal(f.network(), 0);
  } finally {
    f.store.close();
  }
});

test('a failed second format keeps its first receipt and retries the original job without regenerating accepted files', async () => {
  const f = fixture();
  try {
    const queued = await f.queue();
    let attempts = 0;
    f.overview.files.render = async (_t, _r, format) => {
      attempts++;
      if (format === 'xlsx') throw Error('Synthetic render failure');
      return Buffer.from('%PDF-synthetic');
    };
    await f.worker.once();
    const failed = await f.call({action: 'export_status', id: queued.id});
    assert.equal(failed.state, 'failed');
    assert.equal(failed.files.length, 1);
    const first = failed.files[0];
    f.overview.files.render = async (_t, _r, format) => {
      attempts++;
      assert.equal(format, 'xlsx');
      return Buffer.from('PK synthetic workbook');
    };
    await f.call({action: 'retry', id: queued.job_id, confirmed: true});
    await f.worker.once();
    const done = await f.call({action: 'export_status', id: queued.id});
    assert.equal(done.state, 'complete', JSON.stringify(done));
    assert.equal(done.files.length, 2);
    assert.deepEqual(done.files[0], first);
    assert.equal(attempts, 3);
    assert.equal(f.network(), 0);
  } finally {
    f.store.close();
  }
});

test('file work and downloads recheck current grants, source identity and worker lease around rendering', async () => {
  for (const reason of ['access', 'source', 'lease']) {
    const f = fixture();
    try {
      const queued = await f.queue();
      f.overview.files.render = async () => {
        if (reason === 'access')
          f.store.putConnection(
            {...f.actor, role: 'admin'},
            {...f.connection, enabled: false},
            {accessToken: 'synthetic'},
          );
        if (reason === 'source')
          f.store.putDocument(f.actor.tenantId, 'overview_report', f.report.id, {
            ...f.report,
            config: {...f.report.config, name: 'Changed'},
          });
        if (reason === 'lease')
          f.store.db.prepare("UPDATE jobs SET state='cancelled',lease_token=NULL WHERE id=?").run(queued.job_id);
        return Buffer.from('%PDF-never retained');
      };
      await f.worker.once();
      assert.equal(f.store.documents(f.actor.tenantId, 'report_file').length, 0, reason);
      assert.notEqual(f.store.job(f.actor.tenantId, queued.job_id).state, 'complete');
    } finally {
      f.store.close();
    }
  }
});

test('local file schedules need no Sheets login, freeze branding, and retain existing schedule cancellation rules', async () => {
  const f = fixture();
  try {
    const d = await f.bind();
    const config = {
      ...f.report.config,
      date_range: {preset: 'last_complete_days', days: 7, timezone: 'UTC'},
      partial_delivery: 'allow_marked',
    };
    const scheduled = await f.call({
      action: 'schedule',
      idempotency_key: 'file-schedule-1',
      config,
      schedule: {schedule_kind: 'daily', timezone: 'UTC', schedule_config: {hour: 8}, destination_id: d.id},
      confirmed: true,
    });
    const saved = f.store.document(f.actor.tenantId, 'overview_schedule', scheduled.id);
    f.store.putDocument(f.actor.tenantId, 'overview_schedule', saved.id, {...saved, next_run_at: Date.now() - 1000});
    f.overview.tick();
    const current = f.store.document(f.actor.tenantId, 'overview_schedule', saved.id);
    const report = f.store.document(f.actor.tenantId, 'overview_report', current.last_report_id);
    assert.equal(report.destination_id, d.id);
    await f.call({action: 'pause_schedule', id: saved.id, expected_revision: current.revision, confirmed: true});
    assert.equal(f.store.job(f.actor.tenantId, report.job_id).state, 'cancelled');
    assert.equal(f.network(), 0);
  } finally {
    f.store.close();
  }
});

test('file deletion follows its snapshot and complete-only policy never publishes partial evidence', async () => {
  const f = fixture();
  try {
    await f.bind();
    f.store.putDocument(f.actor.tenantId, 'overview_report', f.report.id, {
      ...f.report,
      config: {...f.report.config, partial_delivery: 'complete_only'},
    });
    await assert.rejects(f.queue(), e => e.code === 'PARTIAL_DELIVERY_BLOCKED');
    f.store.putDocument(f.actor.tenantId, 'overview_report', f.report.id, f.report);
    const queued = await f.queue();
    f.overview.files.render = async (_t, _r, format) =>
      Buffer.from(format === 'pdf' ? '%PDF-synthetic' : 'PK synthetic');
    await f.worker.once();
    assert.equal((await f.call({action: 'export_status', id: queued.id})).files.length, 2);
    await assert.rejects(async () => f.overview.files.download({...f.actor, tenantId: 'other'}, queued.id, 'pdf'));
    await f.call({action: 'delete_report', id: f.report.id, confirmed: true});
    assert.equal(f.store.documents(f.actor.tenantId, 'report_file').length, 0);
    assert.throws(() => f.overview.files.download(f.actor, queued.id, 'pdf'));
  } finally {
    f.store.close();
  }
});

test('file quota and snapshot retention bound encrypted output without returning ciphertext in metadata', async () => {
  const f = fixture();
  try {
    const queued = await f.queue();
    f.overview.files.render = async () => Buffer.from('%PDF-test');
    f.store.putDocument(f.actor.tenantId, 'report_file', 'quota-marker', {
      report_id: f.report.id,
      storage_bytes: 256 * 1024 * 1024,
    });
    await f.worker.once();
    assert.equal(f.store.job(f.actor.tenantId, queued.job_id).error.code, 'REPORT_FILE_QUOTA');
    assert.equal((await f.call({action: 'export_status', id: queued.id})).files.length, 0);
    const old = {...f.report, created_at: Date.now() - 50 * 86400000};
    f.store.putDocument(f.actor.tenantId, 'overview_report', f.report.id, old);
    f.store.putDocument(f.actor.tenantId, 'retention_policy', 'reports', {days: 30});
    cleanupReports(f.store);
    assert.equal(f.store.documents(f.actor.tenantId, 'report_file').length, 0);
  } finally {
    f.store.close();
  }
});

test('retained file HTTP downloads require a live session and current source account access', async () => {
  const f = fixture();
  let listener;
  try {
    const queued = await f.queue();
    f.overview.files.render = async (_t, _r, format) => Buffer.from(format === 'pdf' ? '%PDF-fixture' : 'PK fixture');
    await f.worker.once();
    const origin = 'https://amcp.shop';
    listener = await listenForFetch(
      createHttpApp(f.service, f.store, {
        website: {origin, masterKey: Buffer.alloc(32, 85).toString('base64'), adminPassword: 'synthetic-test-password'},
      }),
    );
    const base = 'http://127.0.0.1:' + listener.address().port,
      path = '/api/reporting-files/' + queued.id + '.pdf';
    let response = await fetch(base + path);
    await response.arrayBuffer();
    assert.equal(response.status, 401);
    const login = await fetch(base + '/api/session', {
      method: 'POST',
      headers: {Origin: origin, 'Content-Type': 'application/json'},
      body: JSON.stringify({password: 'synthetic-test-password'}),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    await login.arrayBuffer();
    response = await fetch(base + path, {headers: {Cookie: cookie}});
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '%PDF-fixture');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-disposition'), /attachment/);
    f.store.putConnection({...f.actor, role: 'admin'}, {...f.connection, enabled: false}, {accessToken: 'synthetic'});
    response = await fetch(base + path, {headers: {Cookie: cookie}});
    await response.arrayBuffer();
    assert.notEqual(response.status, 200);
    assert.equal(f.network(), 0);
  } finally {
    await listener?.close();
    f.store.close();
  }
});

test('a scheduled collection queues one separate file job, whose completion and replay never recollect sources', async () => {
  const f = fixture();
  try {
    const d = await f.bind(),
      config = {
        ...f.report.config,
        grain: 'total',
        date_range: {preset: 'last_complete_days', days: 7, timezone: 'UTC'},
      };
    const scheduled = await f.call({
      action: 'schedule',
      config,
      schedule: {schedule_kind: 'daily', timezone: 'UTC', schedule_config: {hour: 8}, destination_id: d.id},
      confirmed: true,
    });
    const s = f.store.document(f.actor.tenantId, 'overview_schedule', scheduled.id);
    f.store.putDocument(f.actor.tenantId, 'overview_schedule', s.id, {...s, next_run_at: Date.now() - 1000});
    f.overview.tick();
    let collections = 0;
    f.overview.native.collect = async (source, range) => {
      collections++;
      return {
        source,
        rows: f.report.rows.map(row => ({...row, date_from: range.since, date_to: range.until, complete: true})),
        complete: true,
        currency: 'USD',
        timezone: 'UTC',
        attribution: '7-day click',
        result_definition: 'purchase',
        query_fingerprint: 'synthetic',
      };
    };
    f.overview.files.render = async (_t, _r, format) =>
      Buffer.from(format === 'pdf' ? '%PDF-scheduled' : 'PK scheduled');
    await f.worker.once();
    const run = f.store.document(
      f.actor.tenantId,
      'overview_report',
      f.store.document(f.actor.tenantId, 'overview_schedule', s.id).last_report_id,
    );
    assert.equal(f.store.job(f.actor.tenantId, run.job_id).state, 'complete');
    assert.equal(run.export.state, 'queued');
    assert.equal(collections, 1);
    await f.worker.once();
    const delivered = await f.call({action: 'export_status', id: run.export.id});
    assert.equal(delivered.state, 'complete', JSON.stringify(delivered));
    assert.equal(delivered.files.length, 2);
    assert.equal(collections, 1);
    const replay = await f.call({action: 'export', report_id: run.id, destination_id: d.id, confirmed: true});
    assert.equal(replay.id, delivered.id);
    assert.equal(replay.state, 'complete');
    assert.equal(await f.worker.once(), false);
    assert.equal(collections, 1);
  } finally {
    f.store.close();
  }
});

test('file workers reject another job and a corrupted retained receipt before rendering more formats', async () => {
  const f = fixture();
  try {
    const queued = await f.queue();
    let renders = 0;
    f.overview.files.render = async (_t, _r, format) => {
      renders++;
      return Buffer.from(format === 'pdf' ? '%PDF-check' : 'PK check');
    };
    await assert.rejects(
      f.overview.files.work(
        f.actor.tenantId,
        {export_id: queued.id, report_id: f.report.id, __job_id: 'different-job'},
        () => {},
      ),
      {code: 'INVALID_FILE_EXPORT'},
    );
    assert.equal(renders, 0);
    f.store.putDocument(f.actor.tenantId, 'report_file', queued.id + '.pdf', {
      export_id: queued.id,
      report_id: f.report.id,
      source_hash: 'changed',
      format: 'pdf',
    });
    await f.worker.once();
    assert.equal(f.store.job(f.actor.tenantId, queued.job_id).error.code, 'REPORT_FILE_INTEGRITY');
    assert.equal(renders, 0);
  } finally {
    f.store.close();
  }
});
