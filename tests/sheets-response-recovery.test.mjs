import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {GoogleSheetsExports, sheetsGateway} from '../dist/src/google-sheets.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';

function fixture(response, failOn = 'GET') {
  const store = new Store(':memory:', Buffer.alloc(32, 75).toString('base64')),
    actor = {tenantId: 't', userId: 'u', role: 'admin'},
    report = {
      id: 'report',
      state: 'complete',
      captured_at: 100,
      config: {metrics: ['spend'], custom_metrics: []},
      sources: [],
      rows: [
        {
          platform: 'meta',
          account_id: '100',
          campaign_id: '101',
          campaign_name: 'Synthetic',
          date_from: '2026-09-01',
          date_to: '2026-09-02',
          metrics: {spend: 5},
          recommendation: {decision: 'observe', reason: 'Synthetic'},
          complete: true,
          captured_at: 100,
        },
      ],
    },
    metadata = [{metadataKey: 'amcp_destination', metadataValue: 'dest'}];
  store.putConnection(
    actor,
    {
      id: 'sheets',
      tenantId: 't',
      gateway: sheetsGateway,
      enabled: true,
      accounts: ['sheet123'],
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      label: 'Synthetic',
    },
    {accessToken: 'synthetic'},
  );
  store.putDocument('t', 'sheets_destination', 'dest', {
    connection_id: 'sheets',
    spreadsheet_id: 'sheet123',
    sheet_id: 7,
    tab_name: 'Synthetic report',
  });
  let reads = 0,
    writes = 0,
    failed = false;
  const sheets = new GoogleSheetsExports(store, async (_url, init) => {
    if (init.method === 'POST') {
      writes++;
      const body = JSON.parse(init.body);
      for (const request of body.requests)
        if (request.createDeveloperMetadata)
          metadata.push({...request.createDeveloperMetadata.developerMetadata, metadataId: 13});
      if (!failed && failOn === 'POST') {
        failed = true;
        return response();
      }
      return Response.json({spreadsheetId: 'sheet123', replies: body.requests.map(() => ({}))});
    }
    reads++;
    if (!failed && failOn === 'GET') {
      failed = true;
      return response();
    }
    return Response.json({
      sheets: [
        {properties: {sheetId: 7, gridProperties: {rowCount: 100, columnCount: 30}}, developerMetadata: metadata},
      ],
    });
  });
  return {store, actor, report, sheets, counts: () => ({reads, writes})};
}

const brokenBody = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(Error('Synthetic body failure with private provider text'));
      },
    }),
  );

test('Sheets metadata body failure is retryable and cannot send an export', async () => {
  const f = fixture(brokenBody);
  try {
    await assert.rejects(
      () => f.sheets.write(f.actor, 'dest', f.report),
      e => e.code === 'SHEETS_UNAVAILABLE' && e.retryable && !e.message.includes('private provider text'),
    );
    assert.equal(f.counts().writes, 0);
    assert.equal((await f.sheets.write(f.actor, 'dest', f.report)).state, 'complete');
    assert.equal(f.counts().writes, 1);
  } finally {
    f.store.close();
  }
});

test('Sheets lost response body reconciles the original marker without sending twice', async () => {
  const f = fixture(brokenBody, 'POST');
  try {
    await assert.rejects(
      () => f.sheets.write(f.actor, 'dest', f.report),
      e => e.code === 'SHEETS_OUTCOME_UNKNOWN' && e.retryable,
    );
    assert.equal(f.store.documents('t', 'sheets_delivery')[0].state, 'uncertain');
    assert.equal((await f.sheets.write(f.actor, 'dest', f.report)).reconciled, true);
    assert.equal(f.counts().writes, 1);
  } finally {
    f.store.close();
  }
});

for (const status of [429, 503])
  test('Sheets HTTP ' + status + ' stays retryable with an HTML or empty error body', async () => {
    const f = fixture(
      () =>
        new Response(status === 429 ? '<html>temporarily limited</html>' : null, {
          status,
          headers: {'Retry-After': '5'},
        }),
    );
    try {
      await assert.rejects(
        () => f.sheets.write(f.actor, 'dest', f.report),
        e =>
          e.code === 'SHEETS_REQUEST_FAILED' &&
          e.retryable &&
          e.details.status === status &&
          e.details.retry_after_ms === 5000,
      );
      assert.equal(f.counts().writes, 0);
    } finally {
      f.store.close();
    }
  });

test('Sheets HTML permission denial remains terminal and cannot send an export', async () => {
  const f = fixture(() => new Response('<html>denied</html>', {status: 403}));
  try {
    await assert.rejects(
      () => f.sheets.write(f.actor, 'dest', f.report),
      e => e.code === 'SHEETS_PERMISSION_DENIED' && !e.retryable && e.details.status === 403,
    );
    assert.equal(f.counts().writes, 0);
  } finally {
    f.store.close();
  }
});

for (const header of ['not-a-delay', new Date(Date.now() + 90000).toUTCString()])
  test(
    'Sheets Retry-After ' +
      (header === 'not-a-delay' ? 'malformed value uses a finite fallback' : 'HTTP date is respected'),
    async () => {
      const f = fixture(() =>
        Response.json({error: {message: 'Synthetic'}}, {status: 429, headers: {'Retry-After': header}}),
      );
      try {
        await assert.rejects(
          () => f.sheets.write(f.actor, 'dest', f.report),
          e => {
            assert.equal(e.code, 'SHEETS_REQUEST_FAILED');
            assert.ok(Number.isFinite(e.details.retry_after_ms));
            if (header === 'not-a-delay') assert.equal(e.details.retry_after_ms, 30000);
            else assert.ok(e.details.retry_after_ms > 80000 && e.details.retry_after_ms <= 90000);
            return true;
          },
        );
      } finally {
        f.store.close();
      }
    },
  );

test('queued Sheets export recovers a response body failure by reconciling its marker once', async () => {
  const f = fixture(brokenBody, 'POST');
  try {
    f.store.putConnection(
      f.actor,
      {
        id: 'meta',
        tenantId: 't',
        gateway: 'meta_native_action',
        enabled: true,
        accounts: ['100'],
        scopes: ['ads_read'],
        label: 'Synthetic Meta',
      },
      {accessToken: 'synthetic'},
    );
    f.store.putDocument('t', 'overview_report', 'report', {
      ...f.report,
      config: {...f.report.config, sources: [{platform: 'meta', connection_id: 'meta', account_id: '100'}]},
    });
    f.store.putDocument('t', 'overview_export', 'export', {
      destination_id: 'dest',
      actor_binding: f.store.bindJobActor(f.actor, 'export'),
    });
    const overview = new ReportingOverview(new MirrorService(new Registry(), f.store), f.sheets.fetcher),
      worker = new ReportWorker(
        f.store,
        async () => {
          throw Error('Unexpected legacy report');
        },
        (tenant, kind, input) => overview.work(tenant, kind, input),
      ),
      id = f.store.enqueue('t', 'sheets_export', {report_id: 'report', export_id: 'export'});
    assert.equal(await worker.once(), true);
    const queued = f.store.db.prepare('SELECT state,error,available_at FROM jobs WHERE id=?').get(id);
    assert.equal(queued.state, 'queued');
    assert.equal(JSON.parse(queued.error).code, 'SHEETS_OUTCOME_UNKNOWN');
    assert.ok(Number.isFinite(queued.available_at) && queued.available_at > Date.now());
    f.store.db.prepare('UPDATE jobs SET available_at=0 WHERE id=?').run(id);
    assert.equal(await worker.once(), true);
    assert.equal(f.store.db.prepare('SELECT state FROM jobs WHERE id=?').get(id).state, 'complete');
    assert.equal(f.store.document('t', 'overview_export', 'export').reconciled, true);
    assert.equal(f.counts().writes, 1);
  } finally {
    f.store.close();
  }
});
