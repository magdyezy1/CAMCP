// EXP-04 C: the Sheets tab contract. Version 2 keeps row 1 as stable column identifiers and adds header notes (labels,
// units, currency), per-column number formats, a trailing "Recommendation basis" column, an `amcp_table_version`
// marker and a warning-only protection of the AMCP-owned tab (added once). Values stay the typed cells AMCP wrote.
// A delivery first sent under the unmarked version 1 layout keeps it, and AMCP_SHEETS_TABLE_VERSION=1 rolls back.
// Synthetic all-or-nothing Google fake only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {
  GoogleSheetsExports,
  deliveryProjection,
  exportCsv,
  recommendationBasis,
  sheetsDeliveryId,
  sheetsDeliveryLimits,
  sheetsGateway,
  sheetsPresentationRequests,
  sheetsTabProtection,
  sheetsTableVersionKey,
} from '../dist/src/google-sheets.js';

const realNow = Date.now;

/** One owned tab (sheetId 7). `exists:false` starts without it, so the first delivery creates it. */
function fakeGoogle({exists = true, protectedRanges = []} = {}) {
  const tab = {
    exists,
    metadata: exists ? [{metadataKey: 'amcp_destination', metadataValue: 'dest', metadataId: 1}] : [],
    protectedRanges: [...protectedRanges],
    header: null,
  };
  const plan = [],
    batches = [];
  let nextId = 10;
  const apply = body => {
    for (const r of body.requests) {
      if (r.addSheet) tab.exists = true;
      if (r.createDeveloperMetadata)
        tab.metadata.push({...r.createDeveloperMetadata.developerMetadata, metadataId: nextId++});
      if (r.updateDeveloperMetadata)
        tab.metadata.find(
          m => m.metadataId === r.updateDeveloperMetadata.dataFilters[0].developerMetadataLookup.metadataId,
        ).metadataValue = r.updateDeveloperMetadata.developerMetadata.metadataValue;
      if (r.deleteDeveloperMetadata) {
        const key = r.deleteDeveloperMetadata.dataFilter.developerMetadataLookup.metadataKey;
        tab.metadata = tab.metadata.filter(m => m.metadataKey !== key);
      }
      if (r.addProtectedRange)
        tab.protectedRanges.push({...r.addProtectedRange.protectedRange, protectedRangeId: nextId++});
      if (r.updateCells) tab.header = r.updateCells.rows[0].values.map(v => v.userEnteredValue.stringValue);
    }
  };
  const fetcher = async (_url, init) => {
    if (init.method === 'POST') {
      const body = JSON.parse(init.body),
        mode = plan.shift() ?? 'ok';
      batches.push(body);
      if (mode === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
      apply(body);
      return Response.json({spreadsheetId: 'sheet123', replies: body.requests.map(() => ({}))});
    }
    return Response.json({
      sheets: tab.exists
        ? [
            {
              properties: {sheetId: 7, gridProperties: {rowCount: 100, columnCount: 40}},
              developerMetadata: tab.metadata.map(m => ({...m})),
              protectedRanges: tab.protectedRanges.map(p => ({...p})),
            },
          ]
        : [],
    });
  };
  return {tab, plan, batches, fetcher};
}

function fixture(options) {
  const store = new Store(':memory:', Buffer.alloc(32, 67).toString('base64')),
    actor = {tenantId: 't', userId: 'u', role: 'admin'},
    google = fakeGoogle(options);
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
    tab_name: 'Client report',
    name: 'Client sheet',
  });
  const sheets = new GoogleSheetsExports(store, google.fetcher);
  const delivery = id => store.document('t', 'sheets_delivery', sheetsDeliveryId('dest', id));
  const destination = () => store.document('t', 'sheets_destination', 'dest');
  return {store, actor, google, sheets, delivery, destination};
}

const recommendation = (captured_at, extra = {}) => ({
  decision: 'maintain',
  reason: 'Synthetic',
  evidence: {},
  confidence: 'moderate',
  limitations: ['Observational evidence does not establish causality or adjust for seasonality.'],
  as_of: captured_at,
  valid_until: captured_at + 48 * 3600000,
  ...extra,
});
function report(id, captured_at, {currency = 'KWD', rows} = {}) {
  return {
    id,
    state: 'complete',
    captured_at,
    config: {
      name: 'Synthetic',
      metrics: ['spend', 'impressions', 'ctr', 'cpa', 'frequency', 'native_thruplays'],
      custom_metrics: [{id: 'cost_per_lead', label: 'Cost per lead', formula: 'spend / leads', format: 'currency'}],
    },
    sources: [],
    rows: rows ?? [
      {
        platform: 'meta',
        account_id: '123456789012345678',
        campaign_id: '9',
        campaign_name: '=UNTRUSTED AD()',
        currency,
        timezone: 'Asia/Kuwait',
        date_from: '2026-09-01',
        date_to: '2026-09-07',
        metrics: {spend: 12.345, impressions: 1000, ctr: 2.5, cpa: 4.115, frequency: 1.4, native_thruplays: 77},
        recommendation: recommendation(captured_at),
        complete: true,
        captured_at,
      },
    ],
  };
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
const kinds = batch => batch.requests.map(r => Object.keys(r)[0]);
const noteFor = (batch, column) =>
  batch.requests.find(
    r =>
      r.repeatCell?.fields === 'note' &&
      r.repeatCell.cell.note &&
      r.repeatCell.range.startRowIndex === 0 &&
      r.repeatCell.range.startColumnIndex === column,
  )?.repeatCell.cell.note;
const patternFor = (batch, column) =>
  batch.requests.find(
    r =>
      r.repeatCell?.fields === 'userEnteredFormat.numberFormat' &&
      r.repeatCell.cell.userEnteredFormat &&
      r.repeatCell.range.startColumnIndex === column,
  )?.repeatCell;

test('EXP-04 C: a new owned tab gets notes, number formats, its table version and a warning-only protection', async () => {
  const f = fixture({exists: false});
  try {
    const r1 = report('r1', Date.UTC(2026, 8, 8));
    const result = await f.sheets.write(f.actor, 'dest', r1);
    assert.equal(result.state, 'complete');
    const [batch] = f.google.batches,
      order = kinds(batch);
    assert.equal(order[0], 'addSheet');
    const cells = batch.requests.find(r => r.updateCells).updateCells.rows,
      header = cells[0].values.map(v => v.userEnteredValue.stringValue),
      at = name => header.indexOf(name);
    // Row 1 stays the stable identifiers; the basis column is appended at the end.
    assert.deepEqual(header.slice(9, 16), [
      'spend',
      'impressions',
      'ctr',
      'cpa',
      'frequency',
      'native_thruplays',
      'cost_per_lead',
    ]);
    assert.equal(header.at(-1), 'Recommendation basis');
    // Typed cells are unchanged: numbers are numbers, IDs and provider text stay text.
    assert.deepEqual(cells[1].values[at('spend')].userEnteredValue, {numberValue: 12.345});
    assert.deepEqual(cells[1].values[at('Account ID')].userEnteredValue, {stringValue: '123456789012345678'});
    assert.deepEqual(cells[1].values[at('Campaign')].userEnteredValue, {stringValue: '=UNTRUSTED AD()'});
    assert.match(cells[1].values.at(-1).userEnteredValue.stringValue, /^Based on this row\. As of 2026-09-08T00:00/);
    // Formats cover the data rows only and follow the metric definitions (KWD has three decimals).
    const clear = batch.requests.find(
      r => r.repeatCell?.fields === 'userEnteredFormat.numberFormat' && !r.repeatCell.cell.userEnteredFormat,
    ).repeatCell;
    assert.deepEqual(clear.range, {
      sheetId: 7,
      startRowIndex: 1,
      endRowIndex: 100,
      startColumnIndex: 0,
      endColumnIndex: header.length,
    });
    for (const [name, pattern] of [
      ['spend', '#,##0.000'],
      ['cpa', '#,##0.000'],
      ['cost_per_lead', '#,##0.000'],
      ['impressions', '#,##0'],
      ['ctr', '0.00"%"'],
      ['frequency', '#,##0.00'],
    ]) {
      const format = patternFor(batch, at(name));
      assert.deepEqual(format.cell.userEnteredFormat.numberFormat, {type: 'NUMBER', pattern}, name);
      assert.deepEqual(format.range, {
        sheetId: 7,
        startRowIndex: 1,
        endRowIndex: 2,
        startColumnIndex: at(name),
        endColumnIndex: at(name) + 1,
      });
    }
    assert.equal(patternFor(batch, at('native_thruplays')), undefined, 'a native field keeps the general format');
    assert.equal(patternFor(batch, at('Account ID')), undefined, 'IDs keep the text they were written as');
    // Header notes give the label, unit and currency; the first note names the tab contract.
    assert.match(noteFor(batch, at('spend')), /^Spend\. Unit: KWD\.$/);
    assert.match(
      noteFor(batch, at('ctr')),
      /Click-through rate\. Unit: percent \(2\.5 means 2\.5%\)\. Formula: clicks/,
    );
    assert.match(noteFor(batch, at('cost_per_lead')), /^Cost per lead\. Custom formula: spend \/ leads\. Unit: KWD\.$/);
    assert.match(noteFor(batch, at('native_thruplays')), /Native field “native_thruplays” as the platform reports it/);
    assert.match(noteFor(batch, at('Currency')), /ISO 4217/);
    assert.match(noteFor(batch, at('Recommendation basis')), /period, as-of time, validity, confidence/);
    assert.match(noteFor(batch, 0), /^AMCP report tab, table version 2\./);
    const clearNotes = order.findIndex((k, i) => k === 'repeatCell' && batch.requests[i].repeatCell.fields === 'note');
    assert.deepEqual(batch.requests[clearNotes].repeatCell.cell, {}, 'old notes are cleared before new ones are set');
    // The tab is marked with its contract and protected with a warning only.
    const version = batch.requests.find(
      r => r.createDeveloperMetadata?.developerMetadata.metadataKey === sheetsTableVersionKey,
    ).createDeveloperMetadata.developerMetadata;
    assert.deepEqual(version, {
      metadataKey: 'amcp_table_version',
      metadataValue: '2',
      location: {sheetId: 7},
      visibility: 'DOCUMENT',
    });
    assert.deepEqual(batch.requests.find(r => r.addProtectedRange).addProtectedRange, {
      protectedRange: {range: {sheetId: 7}, description: sheetsTabProtection, warningOnly: true},
    });
    assert.ok(Buffer.byteLength(JSON.stringify(batch)) < sheetsDeliveryLimits.payload_bytes);
    // The receipt records the contract, and the destination records that its protection is settled.
    assert.equal(f.delivery('r1').table_version, 2);
    assert.equal(deliveryProjection(f.delivery('r1')).table_version, 2);
    assert.equal(f.destination().tab_protection, 'added');
    assert.equal(typeof f.destination().tab_protection_at, 'number');
  } finally {
    f.store.close();
  }
});

test('EXP-04 C: the warning-only protection is added once and an existing protection is left as its users keep it', async () => {
  const f = fixture();
  try {
    await f.sheets.write(f.actor, 'dest', report('r1', 100));
    assert.ok(kinds(f.google.batches[0]).includes('addProtectedRange'), 'an existing tab is protected once');
    assert.equal(f.google.tab.metadata.filter(m => m.metadataKey === sheetsTableVersionKey).length, 1);
    // A collaborator removes the protection: the next delivery respects that and adds no second version marker.
    f.google.tab.protectedRanges = [];
    await f.sheets.write(f.actor, 'dest', report('r2', 200));
    const second = f.google.batches[1];
    assert.ok(!kinds(second).includes('addProtectedRange'));
    assert.ok(
      !second.requests.some(
        r =>
          r.createDeveloperMetadata?.developerMetadata.metadataKey === sheetsTableVersionKey ||
          r.deleteDeveloperMetadata?.dataFilter.developerMetadataLookup.metadataKey === sheetsTableVersionKey,
      ),
      'a tab already marked as version 2 keeps its marker',
    );
    assert.ok(kinds(second).includes('repeatCell'), 'formats and notes are refreshed on every delivery');
  } finally {
    f.store.close();
  }
  const g = fixture({protectedRanges: [{protectedRangeId: 5, range: {sheetId: 7}, description: 'Client lock'}]});
  try {
    await g.sheets.write(g.actor, 'dest', report('r1', 100));
    assert.ok(
      !kinds(g.google.batches[0]).includes('addProtectedRange'),
      'a tab its users protected gets no second one',
    );
    assert.equal(g.destination().tab_protection, 'existing');
    g.google.tab.protectedRanges = [];
    await g.sheets.write(g.actor, 'dest', report('r2', 200));
    assert.ok(!kinds(g.google.batches[1]).includes('addProtectedRange'), 'settled once, never re-added');
  } finally {
    g.store.close();
  }
});

test('EXP-04 C regression: a delivery first sent under the unmarked version 1 layout keeps it after the upgrade', async () => {
  const f = fixture();
  try {
    await withClock(realNow(), async advance => {
      const r1 = report('r1', 100);
      // Sent before the upgrade: version 1 layout, then the batch's outcome is lost.
      process.env.AMCP_SHEETS_TABLE_VERSION = '1';
      f.google.plan.push('timeout');
      try {
        await assert.rejects(() => f.sheets.write(f.actor, 'dest', r1), {code: 'SHEETS_OUTCOME_UNKNOWN'});
      } finally {
        delete process.env.AMCP_SHEETS_TABLE_VERSION;
      }
      // A receipt written by the earlier release has no table_version at all.
      const {id, revision, table_version, ...legacy} = f.delivery('r1');
      assert.equal(table_version, 1);
      f.store.putDocument('t', 'sheets_delivery', id, legacy);
      // After the settle window the upgraded release resends that same version 1 batch, not a version 2 one (a
      // version 2 table would change the delivery fingerprint and refuse the resend as IDEMPOTENCY_CONFLICT).
      advance(sheetsDeliveryLimits.settle_ms);
      const resent = await f.sheets.write(f.actor, 'dest', r1);
      assert.equal(resent.resent, true);
      assert.deepEqual(f.google.batches[1], f.google.batches[0]);
      assert.ok(!f.google.tab.header.includes('Recommendation basis'));
      assert.ok(!kinds(f.google.batches[1]).includes('addProtectedRange'));
      assert.equal(f.google.tab.metadata.filter(m => m.metadataKey === sheetsTableVersionKey).length, 0);
      // Its replay is still recognized as the same delivery.
      const replay = await f.sheets.write(f.actor, 'dest', r1);
      assert.equal(replay.receipt_only, true);
      assert.equal(f.google.batches.length, 2);
      // A newer report uses the current contract.
      await f.sheets.write(f.actor, 'dest', report('r2', 200));
      assert.equal(f.google.tab.header.at(-1), 'Recommendation basis');
      assert.equal(f.delivery('r2').table_version, 2);
      assert.deepEqual(
        f.google.tab.metadata.filter(m => m.metadataKey === sheetsTableVersionKey).map(m => m.metadataValue),
        ['2'],
      );
    });
  } finally {
    f.store.close();
  }
});

test('EXP-04 C: AMCP_SHEETS_TABLE_VERSION=1 rolls new deliveries back to the unmarked layout', async () => {
  const f = fixture();
  try {
    await f.sheets.write(f.actor, 'dest', report('r1', 100));
    process.env.AMCP_SHEETS_TABLE_VERSION = '1';
    try {
      await f.sheets.write(f.actor, 'dest', report('r2', 200));
    } finally {
      delete process.env.AMCP_SHEETS_TABLE_VERSION;
    }
    const rollback = f.google.batches[1];
    assert.ok(!f.google.tab.header.includes('Recommendation basis'));
    assert.ok(!rollback.requests.some(r => r.repeatCell?.fields === 'note'), 'no header notes');
    assert.ok(!rollback.requests.some(r => r.repeatCell?.fields === 'userEnteredFormat.numberFormat'), 'no formats');
    assert.ok(!kinds(rollback).includes('addProtectedRange'));
    // The version 2 marker no longer describes the tab, so it is removed in the same batch.
    assert.equal(f.google.tab.metadata.filter(m => m.metadataKey === sheetsTableVersionKey).length, 0);
    assert.equal(f.delivery('r2').table_version, 1);
  } finally {
    f.store.close();
  }
});

test('EXP-04 C: recommendation basis, currency formats and notes for mixed and zero-decimal currencies', () => {
  const at = Date.UTC(2026, 8, 8);
  assert.equal(recommendationBasis({metrics: {}}), '', 'a row without a recommendation has no basis');
  assert.equal(
    recommendationBasis({
      recommendation: recommendation(at, {
        basis: 'entity_window',
        evidence: {date_from: '2026-09-01', date_to: '2026-09-07', periods: 7},
      }),
    }),
    "Based on the entity's whole window 2026-09-01 to 2026-09-07; every period row of the entity shares it. As of 2026-09-08T00:00:00.000Z; valid until 2026-09-10T00:00:00.000Z. Confidence: moderate. Observational evidence does not establish causality or adjust for seasonality. Advisory only; AMCP never applies it automatically.",
  );
  const row = (currency, spend) => ({
    ...report('x', at).rows[0],
    currency,
    metrics: {...report('x', at).rows[0].metrics, spend},
  });
  const columns = r => {
    const header = ['Platform', ...r.config.metrics],
      table = [header, ...r.rows.map(() => header.map(() => 0))],
      requests = sheetsPresentationRequests(r, table, 7, 100, header.length);
    return {
      pattern: name => patternFor({requests}, header.indexOf(name))?.cell.userEnteredFormat.numberFormat.pattern,
      note: name => noteFor({requests}, header.indexOf(name)),
    };
  };
  const yen = columns(report('jpy', at, {rows: [row('JPY', 1200)]}));
  assert.equal(yen.pattern('spend'), '#,##0');
  assert.equal(yen.note('spend'), 'Spend. Unit: JPY.');
  const mixed = columns(report('mixed', at, {rows: [row('JPY', 1200), row('KWD', 1.5)]}));
  assert.equal(mixed.pattern('spend'), '#,##0.000');
  assert.match(mixed.note('spend'), /Unit: each row’s Currency; rows in different currencies are not added together\./);
  // CSV and Excel share the current table, so the basis column trails them too.
  const csv = exportCsv(report('csv', at));
  assert.match(csv.split('\r\n')[0], /,"?Recommendation basis"?$/);
});
