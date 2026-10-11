import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {GoogleSheetsExports, sheetsGateway} from '../dist/src/google-sheets.js';
import {MirrorError} from '../dist/src/errors.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {mkdtempSync} from 'node:fs';
import {removeTestDirectory} from '../dist/tests/temp.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertRefused} from './helpers/assert-refused.mjs';

function fixture({change = 'none', at = 'metadata', lost = false, reply, database = ':memory:', once = false} = {}) {
  const store = new Store(database, Buffer.alloc(32, 53).toString('base64')),
    actor = {tenantId: 't', userId: 'u', role: 'admin'};
  const connection = {
    id: 'sheets',
    tenantId: 't',
    gateway: sheetsGateway,
    enabled: true,
    accounts: ['sheet123'],
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    label: 'Synthetic',
  };
  const destination = {connection_id: 'sheets', spreadsheet_id: 'sheet123', sheet_id: 7, tab_name: 'Client report'};
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  store.putDocument('t', 'sheets_destination', 'dest', destination);
  const report = {
    id: 'r1',
    state: 'complete',
    captured_at: 100,
    config: {metrics: ['spend'], custom_metrics: []},
    sources: [],
    rows: [
      {
        platform: 'meta',
        account_id: '123',
        campaign_id: '9',
        campaign_name: 'Synthetic',
        currency: 'USD',
        timezone: 'UTC',
        date_from: '2026-09-01',
        date_to: '2026-09-02',
        metrics: {spend: 5},
        recommendation: {decision: 'observe', reason: 'Synthetic'},
        complete: true,
        captured_at: 100,
      },
    ],
  };
  let revoked = false,
    reads = 0,
    writes = 0;
  const metadata = [{metadataKey: 'amcp_destination', metadataValue: 'dest'}];
  const sourceAccess = () => {
    if (revoked) throw new MirrorError('REPORT_SOURCE_REVOKED', 'Synthetic source withdrawal.', {}, 403);
  };
  let mutations = 0;
  const mutate = () => {
    // `once`: the change happens on the first request only, so a later attempt shows the documented way out.
    if (once && mutations++) return;
    if (change === 'login') store.putConnection(actor, connection, {accessToken: 'replacement'});
    // AMCP's own refresh renews the same login (CON-01); it is not a withdrawal.
    if (change === 'refresh') {
      const current = store.connectionCredentials(connection);
      store.completeCredentialRefresh(connection, current, {...current, accessToken: 'refreshed-by-amcp'});
    }
    if (change === 'source') revoked = true;
    if (change === 'actor')
      store.bindActorCheck(actor, () => {
        throw new MirrorError('UNAUTHORIZED', 'Synthetic actor withdrawal.', {}, 401);
      });
    if (change === 'lease')
      store.db.prepare('UPDATE service_locks SET owner=? WHERE key=?').run('another-worker', 'sheets-export:t:dest');
    if (change === 'destination')
      store.putDocument('t', 'sheets_destination', 'dest', {...destination, spreadsheet_id: 'other123'});
  };
  const sheets = new GoogleSheetsExports(store, async (url, init) => {
    if (init.method === 'POST') {
      writes++;
      if (at === 'write') mutate();
      const body = JSON.parse(init.body);
      if (lost !== 'unapplied')
        for (const request of body.requests) {
          if (request.createDeveloperMetadata)
            metadata.push({...request.createDeveloperMetadata.developerMetadata, metadataId: 13});
          if (request.updateDeveloperMetadata)
            Object.assign(
              metadata.find(m => m.metadataId === 13),
              request.updateDeveloperMetadata.developerMetadata,
            );
        }
      if (lost) throw Error('Synthetic lost delivery response');
      return Response.json(
        reply === undefined ? {spreadsheetId: 'sheet123', replies: body.requests.map(() => ({}))} : reply,
      );
    }
    reads++;
    if (at === 'metadata') mutate();
    return Response.json({
      sheets: [
        {properties: {sheetId: 7, gridProperties: {rowCount: 100, columnCount: 30}}, developerMetadata: metadata},
      ],
    });
  });
  return {
    store,
    actor,
    sheets,
    report,
    sourceAccess,
    counts: () => ({reads, writes}),
    setLost: value => {
      lost = value;
    },
  };
}
for (const change of ['login', 'source', 'lease', 'destination', 'actor'])
  test('Sheets ' + change + ' withdrawal after metadata prevents delivery', async () => {
    const f = fixture({change});
    try {
      await assert.rejects(
        () => f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess),
        e =>
          assertRefused(e, [
            'CONNECTION_AUTHORITY_CHANGED',
            'REPORT_SOURCE_REVOKED',
            'EXPORT_LEASE_LOST',
            'SHEETS_DESTINATION_CHANGED',
            'UNAUTHORIZED',
          ]),
      );
      assert.equal(f.counts().writes, 0);
      assert.equal(f.store.document('t', 'sheets_destination', 'dest').last_report_id, undefined);
    } finally {
      f.store.close();
    }
  });
test('Sheets unresolved delivery blocks a newer report from overtaking it', async () => {
  const f = fixture({lost: 'unapplied'});
  try {
    await assert.rejects(
      () => f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess),
      error => error.code === 'SHEETS_OUTCOME_UNKNOWN',
    );
    await assert.rejects(
      () => f.sheets.write(f.actor, 'dest', {...f.report, id: 'r2', captured_at: 101}, f.sourceAccess),
      error => error.code === 'SHEETS_DELIVERY_UNRESOLVED' && error.details.report_id === 'r1',
    );
    assert.deepEqual(f.counts(), {reads: 1, writes: 1});
  } finally {
    f.store.close();
  }
});
// QA-02 liveness pairs: each blocked state above has a sibling proving its documented way out.
test('Sheets newer report delivers once the unresolved delivery settles and its identical batch completes (EXP-01 exit)', async () => {
  const f = fixture({lost: 'unapplied'}),
    realNow = Date.now,
    newer = {...f.report, id: 'r2', captured_at: 101};
  let now = realNow();
  Date.now = () => now;
  try {
    await assert.rejects(
      () => f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess),
      e => assertRefused(e, 'SHEETS_OUTCOME_UNKNOWN'),
    );
    await assert.rejects(
      () => f.sheets.write(f.actor, 'dest', newer, f.sourceAccess),
      e => assertRefused(e, 'SHEETS_DELIVERY_UNRESOLVED'),
    );
    now += 10 * 60 * 1000 + 1000;
    f.setLost(false);
    assert.equal((await f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess)).resent, true);
    const delivered = await f.sheets.write(f.actor, 'dest', newer, f.sourceAccess);
    assert.equal(delivered.resent, undefined);
    assert.equal(f.store.document('t', 'sheets_destination', 'dest').last_report_id, 'r2');
    assert.deepEqual(f.counts().writes, 3, 'the lost batch, its one identical resend, then the newer report');
  } finally {
    Date.now = realNow;
    f.store.close();
  }
});
for (const at of ['metadata', 'write'])
  test('Sheets delivery continues when AMCP refreshes the same login during ' + at + ' (CON-01 exit)', async () => {
    const f = fixture({change: 'refresh', at});
    try {
      await f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess);
      assert.equal(f.counts().writes, 1);
      assert.equal(f.store.document('t', 'sheets_destination', 'dest').last_report_id, 'r1');
      assert.equal(f.store.documents('t', 'sheets_delivery')[0].state, 'complete');
    } finally {
      f.store.close();
    }
  });
test('Sheets busy destination refuses before any request, then delivers once the other export releases it or its lock lapses', async () => {
  const f = fixture(),
    lock = 'sheets-export:t:dest';
  try {
    assert.equal(f.store.acquireLock(lock, 'another-export', 60000), true);
    await assert.rejects(
      () => f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess),
      e => assertRefused(e, 'EXPORT_BUSY', {status: 503}) && e.retryable === true && e.details.retry_after_ms > 0,
    );
    assert.deepEqual(f.counts(), {reads: 0, writes: 0});
    f.store.releaseLock(lock, 'another-export');
    await f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess);
    assert.equal(f.counts().writes, 1);
    // A holder that died leaves a lock that lapses; the next export takes over without an operator.
    f.store.db
      .prepare('INSERT INTO service_locks(key,owner,expires_at) VALUES(?,?,?)')
      .run(lock, 'dead-export', Date.now() - 1);
    await f.sheets.write(f.actor, 'dest', {...f.report, id: 'r2', captured_at: 101}, f.sourceAccess);
    assert.equal(f.store.document('t', 'sheets_destination', 'dest').last_report_id, 'r2');
  } finally {
    f.store.close();
  }
});
test('Sheets lost destination lease sends nothing, and the retried export delivers under its own lease', async () => {
  const f = fixture({change: 'lease', once: true});
  try {
    await assert.rejects(
      () => f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess),
      e => assertRefused(e, 'EXPORT_LEASE_LOST', {writes: () => f.counts().writes}),
    );
    // The other worker finishes and frees the tab; the job's retry then delivers once.
    f.store.db.prepare('DELETE FROM service_locks WHERE key=?').run('sheets-export:t:dest');
    await f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess);
    assert.equal(f.counts().writes, 1);
    assert.equal(f.store.document('t', 'sheets_destination', 'dest').last_report_id, 'r1');
  } finally {
    f.store.close();
  }
});
for (const change of ['source', 'schedule'])
  test('Sheets worker stops a queued export after ' + change + ' withdrawal during metadata', async () => {
    const f = fixture();
    try {
      const native = {
        id: 'meta',
        tenantId: 't',
        gateway: 'meta_native_action',
        accounts: ['123'],
        enabled: true,
        label: 'Synthetic Meta',
        scopes: ['ads_read'],
      };
      f.store.putConnection(f.actor, native, {accessToken: 'synthetic-source'});
      const report = {
        ...f.report,
        schedule_id: 'schedule',
        schedule_version: 1,
        config: {...f.report.config, sources: [{platform: 'meta', account_id: '123', connection_id: 'meta'}]},
      };
      f.store.putDocument('t', 'overview_report', 'r1', report);
      f.store.putDocument('t', 'overview_schedule', 'schedule', {is_active: true, definition_version: 1});
      // QA-02: the export names its report, as every queued export does. Without report_id the worker crashed on the
      // SQLite lookup (ERR_INVALID_ARG_TYPE) and the former bare assert.rejects passed without reaching the check.
      f.store.putDocument('t', 'overview_export', 'export1', {
        report_id: 'r1',
        destination_id: 'dest',
        actor_binding: f.store.bindJobActor(f.actor, 'export1'),
      });
      let withdrawn = false;
      const overview = new ReportingOverview(new MirrorService(new Registry(), f.store), async (url, init) => {
        const response = await f.sheets.fetcher(url, init);
        if (init.method === 'GET' && !withdrawn) {
          // A real withdrawal: the source login loses account 123. An empty binding is refused by the store, and that
          // throw inside the fake fetch used to read as a Sheets outage (SHEETS_UNAVAILABLE) instead.
          if (change === 'source')
            f.store.putConnection(f.actor, {...native, accounts: ['999']}, {accessToken: 'synthetic-source'});
          else f.store.putDocument('t', 'overview_schedule', 'schedule', {is_active: false, definition_version: 1});
          withdrawn = true;
        }
        return response;
      });
      await assert.rejects(
        () => overview.work('t', 'sheets_export', {report_id: 'r1', export_id: 'export1'}),
        e => assertRefused(e, change === 'source' ? 'CONNECTION_REQUIRED' : 'JOB_CANCELLED'),
      );
      assert.equal(withdrawn, true);
      assert.equal(f.counts().writes, 0);
    } finally {
      f.store.close();
    }
  });
test('Sheets lost-response reconciliation survives closing and reopening SQLite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amcp-sheets-recovery-')),
    database = join(directory, 'store.sqlite'),
    f = fixture({lost: true, database});
  let reopened;
  try {
    await assert.rejects(
      () => f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess),
      error => error.code === 'SHEETS_OUTCOME_UNKNOWN',
    );
    f.store.close();
    reopened = new Store(database, Buffer.alloc(32, 53).toString('base64'));
    const sheets = new GoogleSheetsExports(reopened, f.sheets.fetcher),
      result = await sheets.write(f.actor, 'dest', f.report, f.sourceAccess);
    assert.equal(result.reconciled, true);
    assert.equal(f.counts().writes, 1);
    assert.equal(reopened.documents('t', 'sheets_delivery')[0].state, 'complete');
  } finally {
    if (reopened) reopened.close();
    else f.store.close();
    removeTestDirectory(directory, 'amcp-sheets-recovery-');
  }
});
for (const [label, reply] of [
  ['wrong spreadsheet', {spreadsheetId: 'other123', replies: []}],
  ['empty envelope', {}],
  ['embedded error', {error: {code: 403, message: 'Synthetic'}}],
  ['missing replies', {spreadsheetId: 'sheet123'}],
  ['incomplete replies', {spreadsheetId: 'sheet123', replies: []}],
])
  test('Sheets rejects ' + label + ' in HTTP 200 instead of claiming delivery', async () => {
    const f = fixture({reply});
    try {
      await assert.rejects(
        () => f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess),
        error => error.code === 'SHEETS_RESPONSE_INVALID',
      );
      assert.equal(f.store.document('t', 'sheets_destination', 'dest').last_report_id, undefined);
      assert.equal(f.store.documents('t', 'sheets_delivery')[0].state, 'uncertain');
    } finally {
      f.store.close();
    }
  });
test('Sheets creation retains an accepted file ID before late actor withdrawal without granting it', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 54).toString('base64')),
    actor = {tenantId: 't', userId: 'u', role: 'admin'},
    connection = {
      id: 'sheets',
      tenantId: 't',
      gateway: sheetsGateway,
      enabled: false,
      accounts: [],
      scopes: ['https://www.googleapis.com/auth/drive.file'],
      label: 'Synthetic',
    };
  try {
    store.putConnection(actor, connection, {accessToken: 'synthetic'});
    const sheets = new GoogleSheetsExports(store, async () => {
      store.bindActorCheck(actor, () => {
        throw new MirrorError('UNAUTHORIZED', 'Synthetic withdrawal.', {}, 401);
      });
      return Response.json({id: 'created123', name: 'Client', mimeType: 'application/vnd.google-apps.spreadsheet'});
    });
    await assert.rejects(
      () =>
        sheets.create(actor, {
          connection_id: 'sheets',
          name: 'Client',
          idempotency_key: 'creation-key',
          confirmed: true,
        }),
      error => error.code === 'UNAUTHORIZED',
    );
    assert.equal(store.documents('t', 'sheets_creation')[0].spreadsheet_id, 'created123');
    assert.deepEqual(store.listConnections('t')[0].accounts, []);
  } finally {
    store.close();
  }
});
test('Sheets pasted-URL selection rejects login replacement between read and local grant commit', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 55).toString('base64')),
    actor = {tenantId: 't', userId: 'u', role: 'admin'},
    connection = {
      id: 'sheets',
      tenantId: 't',
      gateway: sheetsGateway,
      enabled: false,
      accounts: [],
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      label: 'Synthetic',
    };
  try {
    store.putConnection(actor, connection, {accessToken: 'synthetic'});
    let responseReturned = false,
      queued = false;
    store.bindActorCheck(actor, () => {
      if (responseReturned && !queued) {
        queued = true;
        queueMicrotask(() => store.putConnection(actor, connection, {accessToken: 'replacement'}));
      }
    });
    const sheets = new GoogleSheetsExports(store, async () => {
      responseReturned = true;
      return Response.json({spreadsheetId: 'sheet123', properties: {title: 'Client'}});
    });
    await assert.rejects(
      () =>
        sheets.bind(actor, {
          connection_id: 'sheets',
          spreadsheet_url: 'https://docs.google.com/spreadsheets/d/sheet123/edit',
          confirmed: true,
        }),
      error => error.code === 'CONNECTION_AUTHORITY_CHANGED',
    );
    assert.deepEqual(store.listConnections('t')[0].accounts, []);
    assert.equal(store.documents('t', 'sheets_destination').length, 0);
  } finally {
    store.close();
  }
});
test('Sheets reconciles an accepted lost response using its atomic provider marker', async () => {
  const f = fixture({lost: true});
  try {
    await assert.rejects(
      () => f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess),
      error => error.code === 'SHEETS_OUTCOME_UNKNOWN',
    );
    const result = await f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess);
    assert.equal(result.reconciled, true);
    assert.equal(result.replayed, true);
    assert.equal(f.counts().writes, 1);
    assert.equal(f.store.documents('t', 'sheets_delivery')[0].state, 'complete');
  } finally {
    f.store.close();
  }
});
// EXP-01 / QA-02 liveness pair. This used to assert that an unconfirmed delivery stays uncertain forever (the
// deadlock). The stuck state remains inside the settle window; its documented exit resends the identical batch once.
test('Sheets unconfirmed delivery polls without resending inside the settle window', async () => {
  const f = fixture({lost: 'unapplied'});
  try {
    for (let i = 0; i < 3; i++)
      await assert.rejects(
        () => f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess),
        error => error.code === 'SHEETS_OUTCOME_UNKNOWN',
      );
    assert.deepEqual(f.counts(), {reads: 3, writes: 1});
    assert.equal(f.store.documents('t', 'sheets_delivery')[0].state, 'uncertain');
  } finally {
    f.store.close();
  }
});
test('Sheets unconfirmed delivery resends its identical batch once after the settle window and completes', async () => {
  const f = fixture({lost: 'unapplied'}),
    realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await assert.rejects(
      () => f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess),
      error => error.code === 'SHEETS_OUTCOME_UNKNOWN',
    );
    now += 10 * 60 * 1000 + 1000;
    f.setLost(false);
    const result = await f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess);
    assert.equal(result.resent, true);
    assert.deepEqual(f.counts(), {reads: 2, writes: 2});
    assert.equal(f.store.documents('t', 'sheets_delivery')[0].state, 'complete');
    assert.equal(f.store.document('t', 'sheets_destination', 'dest').last_report_id, 'r1');
  } finally {
    Date.now = realNow;
    f.store.close();
  }
});
test('Sheets refreshes the same destination delivery marker for a new report', async () => {
  const f = fixture();
  try {
    await f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess);
    const next = {...f.report, id: 'r2', captured_at: 101};
    await f.sheets.write(f.actor, 'dest', next, f.sourceAccess);
    assert.deepEqual(f.counts(), {reads: 2, writes: 2});
    assert.equal(f.store.document('t', 'sheets_destination', 'dest').last_report_id, 'r2');
  } finally {
    f.store.close();
  }
});
for (const change of ['login', 'source', 'actor'])
  test('Sheets retains accepted delivery before late ' + change + ' denial', async () => {
    const f = fixture({change, at: 'write'});
    try {
      await assert.rejects(
        () => f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess),
        e => assertRefused(e, ['CONNECTION_AUTHORITY_CHANGED', 'REPORT_SOURCE_REVOKED', 'UNAUTHORIZED']),
      );
      assert.equal(f.counts().writes, 1);
      assert.equal(f.store.document('t', 'sheets_destination', 'dest').last_report_id, 'r1');
      const deliveries = f.store.documents('t', 'sheets_delivery');
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].state, 'complete');
    } finally {
      f.store.close();
    }
  });
test('Sheets completed delivery replays locally but rejects a changed report under its original ID', async () => {
  const f = fixture();
  try {
    assert.equal((await f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess)).state, 'complete');
    assert.equal((await f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess)).replayed, true);
    const changed = structuredClone(f.report);
    changed.rows[0].metrics.spend = 99;
    await assert.rejects(
      () => f.sheets.write(f.actor, 'dest', changed, f.sourceAccess),
      error => error.code === 'IDEMPOTENCY_CONFLICT',
    );
    assert.deepEqual(f.counts(), {reads: 1, writes: 1});
  } finally {
    f.store.close();
  }
});
test('Sheets lost delivery response remains explicit and has no automatic HTTP retry', async () => {
  const f = fixture({lost: true});
  try {
    await assert.rejects(
      () => f.sheets.write(f.actor, 'dest', f.report, f.sourceAccess),
      error => error.code === 'SHEETS_OUTCOME_UNKNOWN',
    );
    assert.equal(f.counts().writes, 1);
    assert.equal(f.store.document('t', 'sheets_destination', 'dest').last_report_id, undefined);
  } finally {
    f.store.close();
  }
});
