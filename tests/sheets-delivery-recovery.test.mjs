// EXP-01: an unconfirmed Google Sheets delivery can no longer deadlock its destination tab. Synthetic Google
// fake only (no network): every batch is all-or-nothing, markers carry metadata IDs, and a clock override replaces
// waiting for the 10-minute settle window.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {GoogleSheetsExports, sheetsDeliveryId, sheetsDeliveryLimits, sheetsGateway} from '../dist/src/google-sheets.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {cleanupReports} from '../dist/src/owner-operations.js';
import {jitteredRetryDelay} from '../dist/src/scheduled-work.js';
import {readFileSync} from 'node:fs';
import {Script, createContext} from 'node:vm';

const realNow = Date.now;
const SETTLE = sheetsDeliveryLimits.settle_ms;

/** A minimal all-or-nothing Sheets batchUpdate model for one owned tab (sheetId 7). */
function fakeGoogle() {
  const tab = {markers: [{metadataKey: 'amcp_destination', metadataValue: 'dest', metadataId: 1}], report: null};
  const plan = [],
    late = [],
    log = {reads: 0, writes: 0, batches: []};
  let nextId = 10;
  const apply = body => {
    const markers = tab.markers.map(m => ({...m}));
    let report = tab.report;
    for (const r of body.requests) {
      if (r.addSheet) return false;
      if (r.createDeveloperMetadata)
        markers.push({...r.createDeveloperMetadata.developerMetadata, metadataId: nextId++});
      if (r.updateDeveloperMetadata) {
        const m = markers.find(
          m => m.metadataId === r.updateDeveloperMetadata.dataFilters[0].developerMetadataLookup.metadataId,
        );
        if (!m) return false;
        m.metadataValue = r.updateDeveloperMetadata.developerMetadata.metadataValue;
      }
      if (r.deleteDeveloperMetadata) {
        const key = r.deleteDeveloperMetadata.dataFilter.developerMetadataLookup.metadataKey;
        for (let i = markers.length - 1; i >= 0; i--) if (markers[i].metadataKey === key) markers.splice(i, 1);
      }
      if (r.updateCells) {
        const header = r.updateCells.rows[0].values.map(v => v.userEnteredValue.stringValue),
          index = header.indexOf('Report ID');
        report = r.updateCells.rows[1].values[index].userEnteredValue.stringValue;
      }
    }
    tab.markers = markers;
    tab.report = report;
    return true;
  };
  const fetcher = async (url, init) => {
    if (init.method === 'POST') {
      log.writes++;
      const body = JSON.parse(init.body),
        mode = plan.shift() ?? 'ok';
      log.batches.push(body);
      if (mode === 'ok') {
        if (!apply(body)) return Response.json({error: {code: 400, status: 'INVALID_ARGUMENT'}}, {status: 400});
        return Response.json({spreadsheetId: 'sheet123', replies: body.requests.map(() => ({}))});
      }
      if (mode === 'lost') {
        apply(body);
        throw new TypeError('fetch failed');
      }
      if (mode === 'late-first') {
        // The original batch lands while the resend is in flight; the identical resend then applies again.
        apply(late.shift());
        if (!apply(body)) return Response.json({error: {code: 400, status: 'INVALID_ARGUMENT'}}, {status: 400});
        return Response.json({spreadsheetId: 'sheet123', replies: body.requests.map(() => ({}))});
      }
      if (mode === 'timeout') {
        late.push(body);
        throw new DOMException('The operation timed out.', 'TimeoutError');
      }
      if (mode === 'reset') throw new TypeError('fetch failed', {cause: {code: 'ECONNRESET'}});
      if (mode === '503')
        return Response.json(
          {error: {code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE'}},
          {status: 503},
        );
      if (mode === '500') return new Response('Internal error', {status: 500});
      if (mode === '429')
        return Response.json(
          {error: {code: 429, status: 'RESOURCE_EXHAUSTED'}},
          {status: 429, headers: {'retry-after': '20'}},
        );
      throw Error('Unknown synthetic mode ' + mode);
    }
    log.reads++;
    return Response.json({
      sheets: [
        {
          properties: {sheetId: 7, gridProperties: {rowCount: 100, columnCount: 40}},
          developerMetadata: tab.markers.map(m => ({...m})),
        },
      ],
    });
  };
  return {tab, plan, log, fetcher, applyLate: () => apply(late.shift())};
}

function fixture({tenant = 't', store} = {}) {
  store ??= new Store(':memory:', Buffer.alloc(32, 61).toString('base64'));
  const actor = {tenantId: tenant, userId: 'u', role: 'admin'},
    google = fakeGoogle();
  store.putConnection(
    actor,
    {
      id: 'sheets',
      tenantId: tenant,
      gateway: sheetsGateway,
      enabled: true,
      accounts: ['sheet123'],
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      label: 'Synthetic',
    },
    {accessToken: 'synthetic'},
  );
  store.putConnection(
    actor,
    {
      id: 'meta',
      tenantId: tenant,
      gateway: 'meta_native_action',
      enabled: true,
      accounts: ['123'],
      scopes: ['ads_read'],
      label: 'Synthetic Meta',
    },
    {accessToken: 'synthetic-source'},
  );
  store.putDocument(tenant, 'sheets_destination', 'dest', {
    connection_id: 'sheets',
    spreadsheet_id: 'sheet123',
    sheet_id: 7,
    tab_name: 'Client report',
    name: 'Client sheet',
  });
  const sheets = new GoogleSheetsExports(store, google.fetcher),
    overview = new ReportingOverview(new MirrorService(new Registry(), store), google.fetcher);
  const report = (id, captured_at) => {
    const r = {
      id,
      state: 'complete',
      captured_at,
      created_at: captured_at,
      config: {
        name: 'Synthetic',
        metrics: ['spend'],
        custom_metrics: [],
        sources: [{platform: 'meta', account_id: '123', connection_id: 'meta'}],
      },
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
          metrics: {spend: captured_at},
          recommendation: {decision: 'observe', reason: 'Synthetic'},
          complete: true,
          captured_at,
        },
      ],
    };
    store.putDocument(tenant, 'overview_report', id, r);
    return r;
  };
  const delivery = id => store.document(tenant, 'sheets_delivery', sheetsDeliveryId('dest', id));
  const audits = () => store.audit(tenant, 1000).map(row => JSON.parse(row.event).event);
  const lastDeliveryMarkers = () => google.tab.markers.filter(m => m.metadataKey === 'amcp_last_delivery');
  // No two reports interleave: the tab holds at most one delivery marker and it names the report in the cells.
  const assertConsistent = () => {
    const markers = lastDeliveryMarkers();
    assert.ok(markers.length <= 1, 'a single delivery marker');
    if (markers.length)
      assert.equal(markers[0].metadataValue.split(':')[0], sheetsDeliveryId('dest', google.tab.report));
  };
  return {store, actor, google, sheets, overview, report, delivery, audits, assertConsistent, lastDeliveryMarkers};
}

async function withClock(start, fn) {
  let now = start;
  Date.now = () => now;
  try {
    return await fn(ms => {
      now += ms;
    });
  } finally {
    Date.now = realNow;
  }
}

test('Sheets 503 UNAVAILABLE is recorded rejected (not applied) and its retry sends again at once', async () => {
  const f = fixture();
  try {
    const r1 = f.report('r1', 100);
    f.google.plan.push('503');
    await assert.rejects(
      () => f.sheets.write(f.actor, 'dest', r1),
      e => e.code === 'SHEETS_REQUEST_FAILED' && e.retryable === true && e.details.google_status === 'UNAVAILABLE',
    );
    assert.equal(f.delivery('r1').state, 'rejected');
    // A rejected batch does not block the tab and does not wait for a settle window.
    const result = await f.sheets.write(f.actor, 'dest', r1);
    assert.equal(result.state, 'complete');
    assert.equal(f.google.log.writes, 2);
    assert.equal(f.delivery('r1').state, 'complete');
    assert.equal(f.delivery('r1').attempts, 2);
    f.assertConsistent();
  } finally {
    f.store.close();
  }
});

for (const mode of ['500', 'timeout', 'reset'])
  test(`Sheets ${mode} stays uncertain, never resends inside the settle window, then resends the identical batch once`, async () => {
    const f = fixture();
    try {
      await withClock(realNow(), async advance => {
        const r1 = f.report('r1', 100),
          r2 = f.report('r2', 200);
        f.google.plan.push(mode);
        await assert.rejects(() => f.sheets.write(f.actor, 'dest', r1));
        assert.equal(f.delivery('r1').state, 'uncertain');
        // The stuck state: polling inside the settle window rereads the marker and never resends.
        for (let i = 0; i < 3; i++) {
          advance(60000);
          await assert.rejects(
            () => f.sheets.write(f.actor, 'dest', r1),
            e => e.code === 'SHEETS_OUTCOME_UNKNOWN' && e.retryable && e.details.retry_after_ms <= 150000,
          );
        }
        // No overtaking: a newer report waits (retryable) while the earlier batch may still land.
        await assert.rejects(
          () => f.sheets.write(f.actor, 'dest', r2),
          e => e.code === 'SHEETS_DELIVERY_UNRESOLVED' && e.retryable === true && e.details.report_id === 'r1',
        );
        assert.equal(f.google.log.writes, 1);
        // Its documented exit: after the settle window the same report resends its identical batch once.
        advance(SETTLE);
        const resent = await f.sheets.write(f.actor, 'dest', r1);
        assert.equal(resent.resent, true);
        assert.equal(f.google.log.writes, 2);
        assert.deepEqual(f.google.log.batches[1], f.google.log.batches[0]);
        assert.equal(f.delivery('r1').state, 'complete');
        assert.ok(f.audits().includes('google_sheets_delivery_resent'));
        f.assertConsistent();
        // The tab is free again: the newer report is delivered.
        await f.sheets.write(f.actor, 'dest', r2);
        assert.equal(f.google.tab.report, 'r2');
        f.assertConsistent();
      });
    } finally {
      f.store.close();
    }
  });

for (const lateAt of [40000, 170000])
  test(`Sheets timeout followed by a late apply at ${lateAt / 1000} s is reconciled from its marker without a resend`, async () => {
    const f = fixture();
    try {
      await withClock(realNow(), async advance => {
        const r1 = f.report('r1', 100);
        f.google.plan.push('timeout');
        await assert.rejects(() => f.sheets.write(f.actor, 'dest', r1), {code: 'SHEETS_OUTCOME_UNKNOWN'});
        advance(lateAt);
        assert.equal(f.google.applyLate(), true);
        advance(10000);
        const result = await f.sheets.write(f.actor, 'dest', r1);
        assert.equal(result.reconciled, true);
        assert.equal(f.google.log.writes, 1);
        assert.equal(f.delivery('r1').state, 'complete');
        f.assertConsistent();
      });
    } finally {
      f.store.close();
    }
  });

test('Sheets resend after the settle window is idempotent when the original batch lands right before it', async () => {
  const f = fixture();
  try {
    await withClock(realNow(), async advance => {
      const r1 = f.report('r1', 100);
      // An earlier report owns the tab marker, so the batch updates that marker by its ID.
      await f.sheets.write(f.actor, 'dest', f.report('r0', 50));
      f.google.plan.push('timeout');
      await assert.rejects(() => f.sheets.write(f.actor, 'dest', r1), {code: 'SHEETS_OUTCOME_UNKNOWN'});
      advance(SETTLE + 1000);
      // Applied late before the marker read: confirmed from the marker, never resent.
      f.google.applyLate();
      const result = await f.sheets.write(f.actor, 'dest', r1);
      assert.equal(result.reconciled, true, 'the marker read before the resend confirms the late batch');
      assert.equal(f.google.log.writes, 2);
      assert.equal(f.lastDeliveryMarkers().length, 1);
      f.assertConsistent();
    });
  } finally {
    f.store.close();
  }
});

for (const prior of [false, true])
  test(`Sheets identical resend cannot duplicate markers when the original lands during the resend (${prior ? 'update' : 'delete and create'})`, async () => {
    const f = fixture();
    try {
      await withClock(realNow(), async advance => {
        const r1 = f.report('r1', 100);
        if (prior) await f.sheets.write(f.actor, 'dest', f.report('r0', 50));
        f.google.plan.push('timeout', 'late-first');
        await assert.rejects(() => f.sheets.write(f.actor, 'dest', r1), {code: 'SHEETS_OUTCOME_UNKNOWN'});
        advance(SETTLE + 1000);
        const result = await f.sheets.write(f.actor, 'dest', r1);
        assert.equal(result.resent, true);
        if (!prior) assert.ok(f.google.log.batches.at(-1).requests.some(r => r.deleteDeveloperMetadata));
        assert.equal(f.lastDeliveryMarkers().length, 1);
        assert.equal(f.google.tab.report, 'r1');
        assert.equal(f.delivery('r1').state, 'complete');
        f.assertConsistent();
      });
    } finally {
      f.store.close();
    }
  });

test('Sheets duplicate legacy markers block until an audited release, then one marker remains', async () => {
  const f = fixture();
  try {
    f.google.tab.markers.push(
      {metadataKey: 'amcp_last_delivery', metadataValue: 'legacy-a', metadataId: 3},
      {metadataKey: 'amcp_last_delivery', metadataValue: 'legacy-b', metadataId: 4},
    );
    const r1 = f.report('r1', 100);
    await assert.rejects(
      () => f.sheets.write(f.actor, 'dest', r1),
      e => e.code === 'SHEET_OWNERSHIP_CONFLICT' && e.details.release_available === true,
    );
    assert.equal(f.google.log.writes, 0);
    const released = await f.overview.handle(
      {action: 'resolve_delivery', destination_id: 'dest', resolution: 'abandon', confirmed: true},
      f.actor,
    );
    assert.equal(released.state, 'released');
    assert.ok(f.audits().includes('google_sheets_destination_released'));
    await f.sheets.write(f.actor, 'dest', r1);
    assert.equal(f.google.log.writes, 1);
    // The batch deleted every old delivery marker and created exactly one.
    const batch = f.google.log.batches[0].requests;
    assert.ok(batch.some(r => r.deleteDeveloperMetadata));
    assert.equal(f.lastDeliveryMarkers().length, 1);
    f.assertConsistent();
  } finally {
    f.store.close();
  }
});

test('Sheets resolve_delivery check, resend and abandon are audited and refused inside the settle window', async () => {
  const f = fixture();
  try {
    await withClock(realNow(), async advance => {
      const r1 = f.report('r1', 100),
        r2 = f.report('r2', 200);
      f.google.plan.push('500');
      await assert.rejects(() => f.sheets.write(f.actor, 'dest', r1));
      const resolve = resolution =>
        f.overview.handle({action: 'resolve_delivery', destination_id: 'dest', resolution, confirmed: true}, f.actor);
      // The bootstrap names the blocked tab and when recovery becomes available.
      const destination = (await f.overview.handle({action: 'bootstrap'}, f.actor)).destinations[0];
      assert.equal(destination.unresolved_delivery.report_id, 'r1');
      assert.equal(destination.unresolved_delivery.recovery_available, false);
      const checked = await resolve('check');
      assert.equal(checked.reconciled, false);
      assert.ok(f.audits().includes('google_sheets_delivery_checked'));
      await assert.rejects(() => resolve('resend'), {code: 'SHEETS_SETTLE_WINDOW'});
      await assert.rejects(() => resolve('abandon'), {code: 'SHEETS_SETTLE_WINDOW'});
      await assert.rejects(
        () => f.overview.handle({action: 'resolve_delivery', destination_id: 'dest', resolution: 'resend'}, f.actor),
        {code: 'CONFIRMATION_REQUIRED'},
      );
      await assert.rejects(
        () =>
          f.overview.handle(
            {action: 'resolve_delivery', destination_id: 'dest', resolution: 'abandon', confirmed: true},
            {...f.actor, role: 'reader'},
          ),
        {
          code: 'FORBIDDEN',
        },
      );
      advance(SETTLE + 1000);
      // Resend requeues the same report's export as its own job.
      const queued = await resolve('resend');
      assert.equal(queued.state, 'queued');
      assert.equal(f.store.job('t', queued.job_id).kind, 'sheets_export');
      assert.ok(f.audits().includes('google_sheets_delivery_resend_authorized'));
      assert.equal(f.delivery('r1').resend_authorized_by, 'u');
      // An operator may instead release the tab; the queued resend is cancelled and r2 may use the tab.
      const abandoned = await resolve('abandon');
      assert.equal(abandoned.state, 'abandoned');
      assert.equal(f.store.job('t', queued.job_id).state, 'cancelled');
      assert.ok(f.audits().includes('google_sheets_delivery_abandoned'));
      const audit = f.store
        .audit('t', 1000)
        .map(row => JSON.parse(row.event))
        .find(e => e.event === 'google_sheets_delivery_abandoned');
      assert.equal(audit.delivery_id, sheetsDeliveryId('dest', 'r1'));
      assert.equal(audit.report_id, 'r1');
      assert.equal(audit.destination_id, 'dest');
      await assert.rejects(() => f.sheets.write(f.actor, 'dest', r1), {code: 'SHEETS_DELIVERY_ABANDONED'});
      await f.sheets.write(f.actor, 'dest', r2);
      assert.equal(f.google.tab.report, 'r2');
      assert.equal(f.google.log.writes, 2, 'exactly one write per fingerprint without an authorized resend');
      f.assertConsistent();
    });
  } finally {
    f.store.close();
  }
});

test('Sheets operator resend runs the identical batch through the export job after the settle window', async () => {
  const f = fixture();
  try {
    await withClock(realNow(), async advance => {
      f.report('r1', 100);
      const exported = await f.overview.handle(
        {action: 'export', report_id: 'r1', destination_id: 'dest', confirmed: true},
        f.actor,
      );
      f.google.plan.push('reset');
      await assert.rejects(() => f.overview.work('t', 'sheets_export', {report_id: 'r1', export_id: exported.id}));
      assert.equal(f.delivery('r1').state, 'uncertain');
      advance(SETTLE + 1000);
      const queued = await f.overview.handle(
        {action: 'resolve_delivery', destination_id: 'dest', resolution: 'resend', confirmed: true},
        f.actor,
      );
      assert.equal(queued.job_id, exported.job_id);
      const result = await f.overview.work('t', 'sheets_export', {report_id: 'r1', export_id: exported.id});
      assert.equal(result.resent, true);
      assert.equal(f.delivery('r1').state, 'complete');
      assert.equal(f.google.log.writes, 2);
      const resent = f.store
        .audit('t', 1000)
        .map(row => JSON.parse(row.event))
        .find(e => e.event === 'google_sheets_delivery_resent');
      assert.equal(resent.authorized_by, 'operator');
      f.assertConsistent();
    });
  } finally {
    f.store.close();
  }
});

test('Sheets marker continuity records a released batch that landed after a newer delivery', async () => {
  const f = fixture();
  try {
    await withClock(realNow(), async advance => {
      const r1 = f.report('r1', 100),
        r2 = f.report('r2', 200),
        r3 = f.report('r3', 300);
      await f.sheets.write(f.actor, 'dest', r1);
      f.google.plan.push('timeout');
      await assert.rejects(() => f.sheets.write(f.actor, 'dest', r2));
      advance(SETTLE + 1000);
      await f.overview.handle(
        {action: 'resolve_delivery', destination_id: 'dest', resolution: 'abandon', confirmed: true},
        f.actor,
      );
      // The released r2 batch lands late, after the tab was released (and before the next export).
      f.google.applyLate();
      await f.sheets.write(f.actor, 'dest', r3);
      assert.ok(f.audits().includes('google_sheets_late_apply_detected'));
      assert.equal(f.delivery('r2').state, 'complete');
      assert.equal(f.delivery('r2').late_applied, true);
      assert.equal(f.google.tab.report, 'r3');
      f.assertConsistent();
    });
  } finally {
    f.store.close();
  }
});

test('Sheets unknown marker blocks delivery until the tab is released', async () => {
  const f = fixture();
  try {
    await f.sheets.write(f.actor, 'dest', f.report('r1', 100));
    f.google.tab.markers.find(m => m.metadataKey === 'amcp_last_delivery').metadataValue = 'edited-by-someone';
    await assert.rejects(
      () => f.sheets.write(f.actor, 'dest', f.report('r2', 200)),
      e => e.code === 'SHEETS_MARKER_MISMATCH' && e.details.release_available === true,
    );
    assert.equal(f.google.log.writes, 1);
    await f.overview.handle(
      {action: 'resolve_delivery', destination_id: 'dest', resolution: 'abandon', confirmed: true},
      f.actor,
    );
    await f.sheets.write(f.actor, 'dest', f.report('r2', 200));
    assert.equal(f.google.tab.report, 'r2');
    f.assertConsistent();
  } finally {
    f.store.close();
  }
});

test('Sheets 429 sets a shared write cooldown that another tenant honours before any request', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 62).toString('base64'));
  const a = fixture({tenant: 'a', store}),
    b = fixture({tenant: 'b', store});
  try {
    a.google.plan.push('429');
    await assert.rejects(
      () => a.sheets.write(a.actor, 'dest', a.report('r1', 100)),
      e => e.details.status === 429 && e.details.retry_after_ms === 20000,
    );
    assert.equal(a.delivery('r1').state, 'rejected');
    await assert.rejects(() => b.sheets.write(b.actor, 'dest', b.report('r1', 100)), {code: 'PLATFORM_RATE_LIMIT'});
    assert.deepEqual([b.google.log.reads, b.google.log.writes], [0, 0]);
    assert.throws(() => b.delivery('r1'), {code: 'NOT_FOUND'});
  } finally {
    store.close();
  }
});

test('Sheets deliveries record payload bytes, cells and duration before any limit changes', async () => {
  const f = fixture();
  try {
    await f.sheets.write(f.actor, 'dest', f.report('r1', 100));
    const d = f.delivery('r1');
    assert.ok(d.payload_bytes > 0);
    assert.ok(d.cells > 0);
    assert.equal(typeof d.duration_ms, 'number');
    const audit = f.store
      .audit('t', 1000)
      .map(row => JSON.parse(row.event))
      .find(e => e.event === 'google_sheets_exported');
    assert.equal(audit.payload_bytes, d.payload_bytes);
    assert.equal(audit.cells, d.cells);
    // Batch writes may use Google's processing ceiling; reads keep the short timeout.
    assert.ok(sheetsDeliveryLimits.batch_timeout_ms >= 180000);
    assert.ok(sheetsDeliveryLimits.lock_ttl_ms > sheetsDeliveryLimits.batch_timeout_ms);
    assert.equal(sheetsDeliveryLimits.read_timeout_ms, 25000);
    assert.ok(sheetsDeliveryLimits.settle_ms >= 10 * 60 * 1000);
    // The shared budget stays below 300 requests per minute.
    assert.ok(60000 / sheetsDeliveryLimits.quota.refillMs < 300);
  } finally {
    f.store.close();
  }
});

test('Sheets job retries use truncated exponential backoff with up to one second of jitter', () => {
  assert.equal(
    jitteredRetryDelay(1, undefined, () => 0),
    10000,
  );
  assert.equal(
    jitteredRetryDelay(20, undefined, () => 0),
    300000,
  );
  assert.equal(
    jitteredRetryDelay(1, undefined, () => 0.9999),
    10999,
  );
  assert.equal(
    jitteredRetryDelay(3, 20000, () => 0.5),
    20500,
  );
});

test('Retention keeps a snapshot whose Sheets delivery is unconfirmed and deletion needs an audited release', async () => {
  const f = fixture();
  try {
    await withClock(realNow(), async advance => {
      f.report('r1', 100);
      f.store.putDocument('t', 'overview_report', 'r1', {
        ...f.store.document('t', 'overview_report', 'r1'),
        created_at: 1,
      });
      f.store.putDocument('t', 'retention_policy', 'reports', {days: 7});
      f.google.plan.push('500');
      await assert.rejects(() => f.sheets.write(f.actor, 'dest', f.store.document('t', 'overview_report', 'r1')));
      cleanupReports(f.store);
      assert.equal(
        f.store.document('t', 'overview_report', 'r1').id,
        'r1',
        'retention keeps the report recovery needs',
      );
      await assert.rejects(
        () => f.overview.handle({action: 'delete_report', id: 'r1', confirmed: true}, f.actor),
        e => e.code === 'SHEETS_DELIVERY_UNRESOLVED' && e.details.resolution_required === 'abandon',
      );
      await assert.rejects(
        () => f.overview.handle({action: 'delete_report', id: 'r1', resolution: 'abandon', confirmed: true}, f.actor),
        {code: 'SHEETS_SETTLE_WINDOW'},
      );
      advance(SETTLE + 1000);
      const deleted = await f.overview.handle(
        {action: 'delete_report', id: 'r1', resolution: 'abandon', confirmed: true},
        f.actor,
      );
      assert.equal(deleted.deleted, true);
      assert.equal(f.delivery('r1').state, 'abandoned');
      const audit = f.store
        .audit('t', 1000)
        .map(row => JSON.parse(row.event))
        .find(e => e.event === 'google_sheets_delivery_abandoned');
      assert.equal(audit.reason, 'report_deleted');
      // The tab is free for the next report.
      await f.sheets.write(f.actor, 'dest', f.report('r2', 200));
      assert.equal(f.google.tab.report, 'r2');
    });
    // Terminal receipts of deleted snapshots age out with the retention period.
    await withClock(realNow() + 8 * 86400000, async () => cleanupReports(f.store));
    assert.throws(() => f.delivery('r1'), {code: 'NOT_FOUND'});
  } finally {
    f.store.close();
  }
});

test('Sheets recovery rollback switch keeps an unconfirmed delivery polling without resend or release', async () => {
  const f = fixture();
  process.env.AMCP_SHEETS_DELIVERY_RECOVERY = 'off';
  try {
    await withClock(realNow(), async advance => {
      const r1 = f.report('r1', 100);
      f.google.plan.push('500');
      await assert.rejects(() => f.sheets.write(f.actor, 'dest', r1));
      advance(SETTLE * 3);
      await assert.rejects(() => f.sheets.write(f.actor, 'dest', r1), {code: 'SHEETS_OUTCOME_UNKNOWN'});
      await assert.rejects(
        () =>
          f.overview.handle(
            {action: 'resolve_delivery', destination_id: 'dest', resolution: 'abandon', confirmed: true},
            f.actor,
          ),
        {code: 'DELIVERY_RECOVERY_DISABLED'},
      );
      assert.equal(f.google.log.writes, 1);
    });
  } finally {
    delete process.env.AMCP_SHEETS_DELIVERY_RECOVERY;
    f.store.close();
  }
});

test('website delivery panel offers Check again and opens resend and release only after the settle window', () => {
  const esc = v =>
    String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const context = createContext({
    esc,
    Intl,
    URLSearchParams,
    date: v => 'at-' + v,
    session: {workspaceRole: 'operator'},
    document: {querySelector: () => null, addEventListener() {}},
    location: {pathname: '/'},
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/reporting-overview.js', 'utf8')).runInContext(context);
  const render = deliveries => {
    context.r = {sheets_deliveries: deliveries};
    return new Script('renderSheetsDeliveryRecovery(r)').runInContext(context);
  };
  const waiting = {
    id: 'd1',
    state: 'uncertain',
    destination_id: 'dest',
    unconfirmed_since: 1,
    settle_until: 2,
    recovery_available: false,
  };
  const button = (html, resolution) =>
    new RegExp(`<button[^>]*data-delivery-resolve="${resolution}"[^>]*>`).exec(html)[0];
  let html = render([waiting]);
  assert.match(html, /Unconfirmed since at-1/);
  assert.match(html, /available after at-2/);
  assert.doesNotMatch(button(html, 'check'), /disabled/);
  assert.match(button(html, 'resend'), /disabled/);
  assert.match(button(html, 'abandon'), /disabled/);
  html = render([{...waiting, recovery_available: true}]);
  assert.doesNotMatch(button(html, 'resend'), /disabled/);
  assert.doesNotMatch(button(html, 'abandon'), /disabled/);
  assert.equal(render([{...waiting, state: 'complete'}]), '');
  context.session.workspaceRole = 'viewer';
  assert.match(button(render([{...waiting, recovery_available: true}]), 'check'), /disabled/);
  // The same panel in Arabic.
  context.session.workspaceRole = 'operator';
  const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  new Script('uiMessages = new Map(Object.entries(catalog))').runInContext(Object.assign(context, {catalog}));
  html = render([{...waiting, recovery_available: true}]);
  for (const message of ['Unconfirmed Google Sheets delivery', 'Check again', 'Resend same report', 'Release tab'])
    assert.ok(html.includes(esc(catalog[message])), message);
});
