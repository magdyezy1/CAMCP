import {exportSourceStatus, compactQuality} from './report-quality.js';
import {exportedRecommendation, metricDefinitions} from './report-metrics.js';
import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {CredentialProvider} from './auth.js';
import {MirrorError} from './errors.js';
import {sha256, stable} from './security.js';
import {csvField} from './csv-safety.js';
import type {Actor, Connection, JsonObject} from './types.js';
import {loginStamp, storedLogin} from './connection-authority.js';
export const sheetsGateway = 'google_sheets_native_action';
/**
 * Delivery limits aligned with Google's documented Sheets limits: batchUpdate may process for up to 180 s, so the
 * batch timeout is 190 s under a renewed 240 s destination lock; reads keep 25 s. An unconfirmed batch is resent
 * (identically) only after a settle window well beyond Google's processing ceiling. Shared quota stays below
 * 300 requests per minute per project and key.
 */
export const sheetsDeliveryLimits = {
  settle_ms: 10 * 60 * 1000,
  read_timeout_ms: 25000,
  batch_timeout_ms: 190000,
  lock_ttl_ms: 240000,
  lock_renew_ms: 60000,
  quota: {burst: 30, refillMs: 250},
  cell_limit: 200000,
  payload_bytes: 8 * 1024 * 1024,
} as const;
/** Rollback switch: AMCP_SHEETS_DELIVERY_RECOVERY=off keeps unconfirmed deliveries polling only (no resend/release). */
export const sheetsRecoveryEnabled = () => process.env.AMCP_SHEETS_DELIVERY_RECOVERY !== 'off';
/**
 * Owner decision D11's open sub-choice: after the settle window the export job resends the identical batch of the same
 * report by itself (the implemented default). AMCP_SHEETS_AUTO_RESEND=off waits for an operator's audited resend
 * (resolve_delivery resend) instead; release stays available either way.
 */
export const sheetsAutoResend = () => process.env.AMCP_SHEETS_AUTO_RESEND !== 'off';
export const sheetsDeliveryId = (destinationId: string, reportId: string) =>
  sha256(stable({destinationId, report_id: reportId}));
export const unresolvedStates = ['pending', 'uncertain'];
const destinationBinding = (v: JsonObject) =>
  stable({
    connection_id: v.connection_id,
    spreadsheet_id: v.spreadsheet_id,
    sheet_id: v.sheet_id,
    tab_name: v.tab_name,
  });
const retryAfter = (value: string | null) => {
  if (!value) return undefined;
  const seconds = Number(value),
    ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(3600000, Math.max(1000, Math.round(ms))) : undefined;
};
const settleRemaining = (delivery: JsonObject, now = Date.now()) =>
  Math.max(0, Number(delivery.sent_at ?? 0) + sheetsDeliveryLimits.settle_ms - now);
/** Resend and release need the 10-minute settle window to have passed (and the rollback switch to be on). */
export const assertSheetsSettled = (delivery: JsonObject, now = Date.now()) => {
  if (!sheetsRecoveryEnabled())
    throw new MirrorError(
      'DELIVERY_RECOVERY_DISABLED',
      'Resending or releasing an unconfirmed Sheets delivery is turned off in this deployment.',
      {},
      409,
    );
  const remaining = settleRemaining(delivery, now);
  if (remaining > 0)
    throw new MirrorError(
      'SHEETS_SETTLE_WINDOW',
      'Google may still apply the original batch. Check again, then resend or release the tab after the 10-minute settle window.',
      {
        retry_after_ms: remaining,
        delivery_id: delivery.id,
        unconfirmed_since: delivery.sent_at,
        settle_until: Number(delivery.sent_at) + sheetsDeliveryLimits.settle_ms,
      },
      409,
      true,
    );
};
/** Public, metadata-only projection of a delivery receipt for status and history views. */
export function deliveryProjection(delivery: JsonObject | undefined) {
  if (!delivery) return null;
  const unresolved = unresolvedStates.includes(delivery.state),
    settleUntil = Number(delivery.sent_at ?? 0) + sheetsDeliveryLimits.settle_ms;
  return {
    id: delivery.id,
    state: delivery.state,
    report_id: delivery.report_id,
    destination_id: delivery.destination_id,
    sent_at: delivery.sent_at ?? null,
    first_sent_at: delivery.first_sent_at ?? delivery.sent_at ?? null,
    completed_at: delivery.completed_at ?? null,
    abandoned_at: delivery.abandoned_at ?? null,
    attempts: delivery.attempts ?? (delivery.sent_at ? 1 : 0),
    error_code: delivery.error_code ?? null,
    late_applied: delivery.late_applied === true,
    payload_bytes: delivery.payload_bytes ?? null,
    cells: delivery.cells ?? null,
    duration_ms: delivery.duration_ms ?? null,
    table_version: delivery.table_version === 2 ? 2 : 1,
    ...(unresolved
      ? {
          unconfirmed_since: delivery.sent_at ?? null,
          settle_until: settleUntil,
          recovery_available: sheetsRecoveryEnabled() && Date.now() >= settleUntil,
        }
      : {}),
  };
}
export function unresolvedSheetsDelivery(store: Store, tenant: string, destinationId: string, exceptId = '') {
  const row = store.db
    .prepare(
      "SELECT id,data FROM documents WHERE tenant_id=? AND kind='sheets_delivery' AND id<>? AND json_extract(data,'$.destination_id')=? AND json_extract(data,'$.state') IN ('pending','uncertain') ORDER BY id LIMIT 1",
    )
    .get(tenant, exceptId, destinationId) as JsonObject | undefined;
  return row ? {...JSON.parse(row.data), id: row.id} : undefined;
}
export function sheetsDeliveriesForReport(store: Store, tenant: string, reportId: string, states = unresolvedStates) {
  return (
    store.db
      .prepare(
        "SELECT id,data FROM documents WHERE tenant_id=? AND kind='sheets_delivery' AND json_extract(data,'$.report_id')=? ORDER BY id",
      )
      .all(tenant, reportId) as JsonObject[]
  )
    .map(row => ({...JSON.parse(row.data), id: row.id}))
    .filter(d => states.includes(d.state));
}
/**
 * Audited "release tab": an operator gives up an unconfirmed delivery after the settle window. The destination is
 * then free for newer reports; a late application of the released batch is detected by marker continuity.
 */
export function abandonSheetsDelivery(store: Store, actor: Actor, delivery: JsonObject, reason: string) {
  if (actor.role === 'reader')
    throw new MirrorError('FORBIDDEN', 'An operator role is required to release a report tab.', {}, 403);
  assertSheetsSettled(delivery);
  const lock = 'sheets-export:' + actor.tenantId + ':' + delivery.destination_id,
    owner = randomUUID();
  if (!store.acquireLock(lock, owner, 30000))
    throw new MirrorError(
      'EXPORT_BUSY',
      'Another export is using this destination.',
      {retry_after_ms: 5000},
      503,
      true,
    );
  try {
    return store.transaction(() => {
      const current = store.document(actor.tenantId, 'sheets_delivery', delivery.id);
      if (!unresolvedStates.includes(current.state) || current.sent_at !== delivery.sent_at)
        throw new MirrorError(
          'DELIVERY_CHANGED',
          'This delivery changed while you reviewed it. Refresh its status first.',
          {state: current.state},
          409,
        );
      const {id, revision, ...history} = current,
        abandoned = {...history, state: 'abandoned', abandoned_at: Date.now(), abandoned_by: actor.userId, reason};
      store.putDocument(actor.tenantId, 'sheets_delivery', delivery.id, abandoned);
      store.appendAudit(actor.tenantId, 'export/' + current.report_id, {
        event: 'google_sheets_delivery_abandoned',
        delivery_id: delivery.id,
        report_id: current.report_id,
        destination_id: current.destination_id,
        actor: actor.userId,
        reason,
        vendor_writes: 0,
      });
      return {...abandoned, id: delivery.id};
    });
  } finally {
    store.releaseLock(lock, owner);
  }
}
export function assertReportExportable(report: JsonObject) {
  if (!['complete', 'partial'].includes(report.state))
    throw new MirrorError('REPORT_NOT_READY', 'Wait for a successful report before exporting.', {}, 409);
  if (!Array.isArray(report.rows) || !report.rows.length)
    throw new MirrorError(
      'EMPTY_REPORT',
      'There are no campaign rows to export. Check the account, reporting year and objective filters, then pull the report again.',
      {date_range: report.config?.date_range},
      409,
    );
}
const fileId = (v: unknown) => {
  if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{5,180}$/.test(v))
    throw new MirrorError('INVALID_SPREADSHEET', 'Use a valid Google spreadsheet ID.');
  return v;
};
export function spreadsheetIdFromUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048)
    throw new MirrorError('INVALID_SPREADSHEET_URL', 'Paste the Google Sheets URL from your browser.');
  try {
    const url = new URL(value.trim()),
      match = /^\/spreadsheets(?:\/u\/\d+)?\/d\/([A-Za-z0-9_-]{5,180})(?:\/(?:edit|view|preview|copy))?\/?$/.exec(
        url.pathname,
      );
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'docs.google.com' ||
      url.port ||
      url.username ||
      url.password ||
      !match
    )
      throw Error();
    return fileId(match[1]);
  } catch {
    throw new MirrorError('INVALID_SPREADSHEET_URL', 'Use an https://docs.google.com/spreadsheets/d/... URL.');
  }
}
function destinationTabName(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f:\\/?*\[\]]/.test(value))
    throw new MirrorError('INVALID_TAB_NAME', 'Use a report tab name of 1–80 characters without : \\ / ? * [ or ].');
  return value.trim();
}
/**
 * The Sheets tab contract (EXP-04 C). Version 2 keeps row 1 as the stable column identifiers and adds a trailing
 * "Recommendation basis" column, header notes (labels, units, currency), per-column number formats, an
 * `amcp_table_version` marker on the tab and a warning-only protection of the AMCP-owned tab. Version 1 is the earlier,
 * unmarked layout: a delivery first sent under it keeps it, so its resend stays the identical batch.
 * AMCP_SHEETS_TABLE_VERSION=1 is the rollback for new deliveries.
 */
export const sheetsTableVersion = (): 1 | 2 => (process.env.AMCP_SHEETS_TABLE_VERSION === '1' ? 1 : 2);
export const sheetsTableVersionKey = 'amcp_table_version';
export const sheetsTabProtection =
  'AMCP report tab. AMCP replaces this tab on every delivery, so edits made here are overwritten. Copy the data to another tab to keep changes.';
const isoTime = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
/**
 * What a row's recommendation rests on (EXP-04 C): its period, as-of time, validity, confidence and limitations. A row
 * without a recommendation has no basis (empty cell).
 */
export function recommendationBasis(row: JsonObject): string {
  if (!row.recommendation || typeof row.recommendation !== 'object' || Array.isArray(row.recommendation)) return '';
  const r: JsonObject = row.recommendation,
    e: JsonObject = r.evidence ?? {},
    asOf = isoTime(r.as_of),
    validUntil = isoTime(r.valid_until),
    parts = [
      r.basis === 'entity_window' && e.date_from && e.date_to
        ? `Based on the entity's whole window ${e.date_from} to ${e.date_to}; every period row of the entity shares it.`
        : 'Based on this row.',
      asOf ? `As of ${asOf}${validUntil ? `; valid until ${validUntil}` : ''}.` : '',
      typeof r.confidence === 'string' ? `Confidence: ${r.confidence}.` : '',
      ...(Array.isArray(r.limitations) ? r.limitations.filter((l: unknown) => typeof l === 'string') : []),
      'Advisory only; AMCP never applies it automatically.',
    ];
  return parts.filter(Boolean).join(' ');
}
/** The metric columns of a report table: selected metrics, then custom metrics, each once. */
function reportTableFields(report: JsonObject): string[] {
  const keys = report.config.metrics ?? ['spend', 'impressions', 'clicks', 'conversions', 'cpa', 'roas'];
  return [...new Set<string>([...keys, ...(report.config.custom_metrics ?? []).map((m: JsonObject) => m.id)])];
}
/**
 * `now` decides whether frozen recommendations are still current or render as expired (DEC-01). `version` is the
 * Sheets tab contract the table follows; CSV and Excel use the current one.
 */
export function reportTable(report: JsonObject, now = Date.now(), version: 1 | 2 = 2) {
  const status = JSON.stringify(exportSourceStatus(report));
  const fields = reportTableFields(report);
  const detailed = report.rows.some((row: JsonObject) => row.entity_level && row.entity_level !== 'campaign');
  const values: any[][] = [
    [
      'Platform',
      'Account ID',
      'Campaign ID',
      'Campaign',
      'Objective',
      'Currency',
      'Timezone',
      'Date from',
      'Date to',
      ...(detailed
        ? ['Entity level', 'Native entity type', 'Entity ID', 'Entity', 'Ad set / ad group ID', 'Ad set / ad group']
        : []),
      ...fields,
      'Recommendation',
      'Reason',
      'Attribution',
      'Primary result',
      'Complete',
      'Captured at',
      'Report ID',
      'Report state',
      'Source status JSON',
      'Source quality JSON',
      'Query fingerprint',
      'Formula version',
      'Formula fingerprint',
      ...(version >= 2 ? ['Recommendation basis'] : []),
    ],
  ];
  for (const r of report.rows)
    values.push([
      r.platform,
      r.account_id,
      r.campaign_id,
      r.campaign_name,
      r.objective_group,
      r.currency ?? '',
      r.timezone ?? '',
      r.date_from,
      r.date_to,
      ...(detailed
        ? [
            r.entity_level ?? 'campaign',
            r.native_entity_type ?? 'campaign_or_resource',
            r.entity_id ?? r.campaign_id,
            r.entity_name ?? r.campaign_name,
            r.parent_ids?.adset_id ?? '',
            r.parent_ids?.adset_name ?? '',
          ]
        : []),
      ...fields.map(k => r.metrics[k] ?? ''),
      ...(advice => [advice.decision, advice.reason])(exportedRecommendation(r, now)),
      r.attribution,
      r.result_definition,
      r.complete ? 'Yes' : 'No',
      new Date(r.captured_at).toISOString(),
      report.id ?? '',
      report.state,
      values.length === 1 ? status : '',
      JSON.stringify(compactQuality(r.quality)),
      r.query_fingerprint ?? '',
      report.config.formula_version ?? 'legacy-unversioned',
      report.config.formula_fingerprint ?? '',
      ...(version >= 2 ? [recommendationBasis(r)] : []),
    ]);
  if (values.some(row => row.some(v => typeof v === 'string' && v.length > 48000)))
    throw new MirrorError(
      'EXPORT_CELL_TOO_LARGE',
      'A cell exceeds the export limit. Download the report evidence separately and narrow the report.',
    );
  return values;
}
export function exportCsv(report: JsonObject) {
  assertReportExportable(report);
  return (
    '\uFEFF' +
    reportTable(report)
      .map(row => row.map(csvField).join(','))
      .join('\r\n')
  );
}
// EXP-04 C: header notes for the fixed columns. Metric columns get theirs from the metric definitions.
const sheetsColumnNotes: Record<string, string> = {
  Platform: 'Platform of the row\u2019s source.',
  'Account ID': 'Native account ID, exactly as the platform reports it.',
  'Campaign ID': 'Native campaign or resource ID, kept as text.',
  Currency: 'ISO 4217 currency of every money column in this row. Rows in different currencies are not added together.',
  Timezone: 'The account\u2019s reporting time zone; the row\u2019s dates are days in this zone.',
  'Date from': 'First report day (YYYY-MM-DD, kept as text) in the row\u2019s time zone.',
  'Date to': 'Last report day (YYYY-MM-DD, kept as text) in the row\u2019s time zone.',
  Recommendation:
    'Advisory decision frozen when the data was captured; \u201Cexpired\u201D once it is no longer current. Never applied automatically.',
  'Recommendation basis':
    'What the recommendation rests on: its period, as-of time, validity, confidence and limitations.',
  Complete: 'Yes when the row\u2019s reporting window and measurement are complete.',
  'Captured at': 'When AMCP collected the row from the platform (UTC, ISO 8601 text).',
  'Report state': 'complete, or partial when some sources or periods failed; failures stay marked in the evidence.',
  'Source status JSON': 'Every selected source\u2019s status, on the first data row only.',
};
/** The display decimals of the rows' currencies (KWD and BHD have three, JPY none); unknown or absent codes use two. */
function currencyDecimals(rows: JsonObject[]) {
  const currencies = [...new Set(rows.map(r => r.currency).filter(c => typeof c === 'string' && c))];
  if (!currencies.length) return 2;
  return Math.max(
    ...currencies.map(currency => {
      try {
        return new Intl.NumberFormat('en', {style: 'currency', currency}).resolvedOptions().maximumFractionDigits ?? 2;
      } catch {
        return 2;
      }
    }),
  );
}
/**
 * A metric column's header note and display pattern (EXP-04 C, with RPT-05's rules). Cell values stay the typed numbers
 * AMCP wrote. Money uses the largest minor units among the rows' currencies (KWD 3, JPY 0; the Currency column names
 * each row's), counts show whole numbers when every value is whole, ratios two decimals, percentages a literal % (the
 * values are already percentages) and ROAS \u00d7. Native fields keep the general format.
 */
function sheetsMetricColumn(key: string, report: JsonObject): {note: string; pattern?: string} {
  const rows: JsonObject[] = report.rows,
    custom = (report.config.custom_metrics ?? []).find((m: JsonObject) => m.id === key),
    definition = Object.hasOwn(metricDefinitions, key) ? metricDefinitions[key] : undefined,
    format: unknown = custom?.format ?? definition?.format,
    roas = !custom && key === 'roas',
    currencies = [...new Set(rows.map(r => r.currency).filter(c => typeof c === 'string' && c))],
    numbers = rows.map(r => r.metrics?.[key]).filter(v => typeof v === 'number' && Number.isFinite(v)),
    unit =
      format === 'currency'
        ? currencies.length === 1
          ? `Unit: ${currencies[0]}.`
          : 'Unit: each row\u2019s Currency; rows in different currencies are not added together.'
        : format === 'percent'
          ? 'Unit: percent (2.5 means 2.5%).'
          : format === 'number'
            ? 'Unit: count.'
            : roas
              ? 'Unit: conversion value per unit of spend (2.5\u00d7 returns 2.5 for each 1 spent).'
              : format === 'decimal'
                ? 'Unit: decimal ratio.'
                : '';
  const decimals = currencyDecimals(rows),
    pattern =
      format === 'currency'
        ? '#,##0' + (decimals ? '.' + '0'.repeat(decimals) : '')
        : format === 'percent'
          ? '#,##0.00"%"'
          : format === 'number'
            ? numbers.every(Number.isInteger)
              ? '#,##0'
              : '#,##0.00'
            : roas
              ? '#,##0.00"\u00d7"'
              : format === 'decimal'
                ? '#,##0.00'
                : undefined;
  const note = custom
    ? `${custom.label}. Custom formula: ${custom.formula}. ${unit}`
    : definition
      ? `${definition.label}. ${unit}${definition.formula ? ` Formula: ${definition.formula}.` : ''}`
      : `Native field \u201C${key}\u201D as the platform reports it; its unit and definition follow the platform.`;
  return {note: note.trim(), ...(pattern ? {pattern} : {})};
}
/**
 * The presentation requests of the Sheets tab contract (EXP-04 C): per-column number formats over the data rows and
 * header notes with labels, units and currency, each clearing what an earlier layout left. Values are untouched.
 */
export function sheetsPresentationRequests(
  report: JsonObject,
  table: unknown[][],
  sheetId: number,
  rowCount: number,
  columnCount: number,
): JsonObject[] {
  const header = table[0] as string[],
    height = table.length,
    metrics = new Set(reportTableFields(report)),
    columns = header.map(name =>
      metrics.has(name) ? sheetsMetricColumn(name, report) : {note: sheetsColumnNotes[name]},
    );
  const tab =
    'AMCP report tab, table version 2. AMCP replaces this tab on every delivery, so edits made here are overwritten. Row 1 holds stable column identifiers; these notes give labels and units.';
  const requests: JsonObject[] = [
    {
      repeatCell: {
        range: {sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: columnCount},
        cell: {},
        fields: 'userEnteredFormat.numberFormat',
      },
    },
  ];
  columns.forEach((column: JsonObject, index) => {
    if (column.pattern && height > 1)
      requests.push({
        repeatCell: {
          range: {sheetId, startRowIndex: 1, endRowIndex: height, startColumnIndex: index, endColumnIndex: index + 1},
          cell: {userEnteredFormat: {numberFormat: {type: 'NUMBER', pattern: column.pattern}}},
          fields: 'userEnteredFormat.numberFormat',
        },
      });
  });
  requests.push({
    repeatCell: {
      range: {sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columnCount},
      cell: {},
      fields: 'note',
    },
  });
  columns.forEach((column: JsonObject, index) => {
    const note = index === 0 ? [tab, column.note].filter(Boolean).join('\n\n') : column.note;
    if (note)
      requests.push({
        repeatCell: {
          range: {sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: index, endColumnIndex: index + 1},
          cell: {note},
          fields: 'note',
        },
      });
  });
  return requests;
}
export class GoogleSheetsExports {
  readonly credentials: CredentialProvider;
  constructor(
    readonly store: Store,
    readonly fetcher: typeof fetch = fetch,
  ) {
    this.credentials = new CredentialProvider(store, fetcher);
  }
  private connection(actor: Actor, id: string, creating = false): Connection {
    this.store.assertActorActive(actor);
    const c = this.store.listConnections(actor.tenantId).find(c => c.id === id && c.gateway === sheetsGateway);
    if (!c || (!c.enabled && !(creating && c.accounts.length === 0)))
      throw new MirrorError(
        'SHEETS_CONNECTION_REQUIRED',
        'Connect Google Sheets and select the destination spreadsheet.',
        {},
        409,
      );
    if (
      !c.scopes.includes('https://www.googleapis.com/auth/drive.file') &&
      !c.scopes.includes('https://www.googleapis.com/auth/spreadsheets')
    )
      throw new MirrorError(
        'SHEETS_SCOPE_REQUIRED',
        'Reconnect Google Sheets with permission to edit exported reports.',
        {},
        403,
      );
    return c;
  }
  private async request(
    actor: Actor,
    connectionId: string,
    url: string,
    body?: JsonObject,
    creating = false,
    selectedForBinding?: string,
    context: {
      check?: () => void;
      beforeSend?: () => void;
      accepted?: (data: JsonObject) => void;
      captureAuthority?: (check: () => void) => void;
    } = {},
  ): Promise<JsonObject> {
    context.check?.();
    const c = this.connection(actor, connectionId, creating),
      parsed = new URL(url),
      target = parsed.hostname === 'sheets.googleapis.com' ? parsed.pathname.split('/')[3]?.split(':')[0] : undefined;
    const bindingRead = actor.role === 'admin' && creating && !body && target === selectedForBinding;
    const selected = () => {
      const current = this.connection(actor, connectionId, creating);
      if (target && !current.accounts.includes(target) && !bindingRead)
        throw new MirrorError(
          'SPREADSHEET_SCOPE_REQUIRED',
          'The destination spreadsheet is no longer selected.',
          {},
          403,
        );
      return current;
    };
    selected();
    const token = await this.credentials.get(c),
      fingerprint = loginStamp(token);
    if (!token.accessToken) throw new MirrorError('REAUTHORIZATION_REQUIRED', 'Reconnect Google Sheets.', {}, 401);
    const access = () => {
      context.check?.();
      const current = selected();
      if (storedLogin(this.store, current) !== fingerprint)
        throw new MirrorError(
          'CONNECTION_AUTHORITY_CHANGED',
          'The Google Sheets login changed during this operation. Preserve its delivery receipt and retry with the current login.',
          {},
          409,
        );
    };
    context.captureAuthority?.(access);
    access();
    // One shared project budget per API and direction, honoured by every tenant and worker. A refusal happens
    // before beforeSend, so no pending delivery is recorded for a request that was never sent.
    const quotaKey =
        (parsed.hostname === 'sheets.googleapis.com' ? 'google-sheets-' : 'google-drive-') + (body ? 'write' : 'read'),
      batch = !!body && parsed.pathname.endsWith(':batchUpdate');
    this.store.providerPermit(quotaKey, sheetsDeliveryLimits.quota);
    context.beforeSend?.();
    let r: Response;
    try {
      r = await this.fetcher(url, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: 'Bearer ' + token.accessToken,
          Accept: 'application/json',
          ...(body ? {'Content-Type': 'application/json'} : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(
          batch ? sheetsDeliveryLimits.batch_timeout_ms : sheetsDeliveryLimits.read_timeout_ms,
        ),
      });
    } catch {
      throw new MirrorError(
        body ? 'SHEETS_OUTCOME_UNKNOWN' : 'SHEETS_UNAVAILABLE',
        body
          ? 'Google did not confirm this request. AMCP will reconcile its result before retrying.'
          : 'Google Sheets is temporarily unavailable.',
        {},
        503,
        true,
      );
    }
    const chunks: Uint8Array[] = [],
      reader = r.body?.getReader();
    let size = 0;
    if (reader)
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 8 * 1024 * 1024) {
            await reader.cancel();
            throw new MirrorError('SHEETS_RESPONSE_TOO_LARGE', 'Google returned an oversized response.', {}, 502);
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
    let data: JsonObject | undefined;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error();
    } catch {
      // A failed HTTP status stays classified by its status even when Google sent no JSON error body.
      if (r.ok) throw new MirrorError('SHEETS_RESPONSE_INVALID', 'Google returned an invalid response.', {}, 502);
      data = undefined;
    }
    if (!r.ok) {
      const googleStatus = typeof data?.error?.status === 'string' && /^[A-Z_]{1,40}$/.test(data.error.status),
        wait = retryAfter(r.headers.get('retry-after'));
      if (r.status === 429) this.store.providerCooldown(quotaKey, wait ?? 15000);
      throw new MirrorError(
        r.status === 403 ? 'SHEETS_PERMISSION_DENIED' : 'SHEETS_REQUEST_FAILED',
        'Google Sheets rejected the request. Check file permissions or reconnect.',
        {
          status: r.status,
          ...(googleStatus ? {google_status: data!.error.status} : {}),
          // Without a Retry-After header the worker applies truncated exponential backoff with jitter.
          ...(wait === undefined ? {} : {retry_after_ms: wait}),
        },
        r.status,
        [429, 500, 502, 503, 504].includes(r.status),
      );
    }
    data = data!;
    if (
      data.error ||
      (parsed.hostname === 'sheets.googleapis.com' &&
        parsed.pathname.endsWith(':batchUpdate') &&
        (r.status !== 200 ||
          data.spreadsheetId !== target ||
          !Array.isArray(data.replies) ||
          data.replies.length !== body?.requests?.length))
    )
      throw new MirrorError(
        'SHEETS_RESPONSE_INVALID',
        'Google did not confirm the exact spreadsheet batch. Reconcile its original delivery marker.',
        {},
        502,
      );
    // Record confirmed external effects before a late withdrawal can withhold their result.
    context.accepted?.(data);
    access();
    return data;
  }
  async create(actor: Actor, input: JsonObject) {
    if (actor.role !== 'admin' || input.confirmed !== true)
      throw new MirrorError('FORBIDDEN', 'An administrator must confirm spreadsheet creation.', {}, 403);
    if (
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 100 ||
      typeof input.idempotency_key !== 'string' ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(input.idempotency_key)
    )
      throw new MirrorError('INVALID_DESTINATION', 'Provide a spreadsheet name and a stable creation key.');
    const connectionId = String(input.connection_id);
    this.connection(actor, connectionId, true);
    const id = sha256(connectionId + ':' + input.idempotency_key),
      lock = 'sheets-create:' + actor.tenantId + ':' + id,
      owner = randomUUID();
    if (!this.store.acquireLock(lock, owner, 180000))
      throw new MirrorError('EXPORT_BUSY', 'This spreadsheet is being created.', {}, 409, true);
    try {
      const record = this.store.documents(actor.tenantId, 'sheets_creation').find(d => d.id === id);
      if (record?.name !== undefined && record.name !== input.name)
        throw new MirrorError('IDEMPOTENCY_CONFLICT', 'This key belongs to a different spreadsheet creation.');
      const check = () => {
        this.connection(actor, connectionId, true);
        const lease = this.store.db.prepare('SELECT owner,expires_at FROM service_locks WHERE key=?').get(lock) as
          JsonObject | undefined;
        if (!lease || lease.owner !== owner || lease.expires_at <= Date.now())
          throw new MirrorError(
            'EXPORT_LEASE_LOST',
            'Spreadsheet creation lost its lock. Reconcile its original creation key.',
            {},
            409,
          );
      };
      let commitAccess: () => void = check;
      const context = {
        check,
        captureAuthority: (access: () => void) => {
          commitAccess = access;
        },
      };
      const validate = (file: JsonObject) => {
        if (
          typeof file?.id !== 'string' ||
          !/^[a-zA-Z0-9_-]{5,180}$/.test(file.id) ||
          file.mimeType !== 'application/vnd.google-apps.spreadsheet'
        )
          throw new MirrorError('SHEETS_RESPONSE_INVALID', 'Google did not confirm a spreadsheet file.', {}, 502);
      };
      const accepted = (file: JsonObject) => {
        validate(file);
        this.store.putDocument(actor.tenantId, 'sheets_creation', id, {
          name: input.name,
          connection_id: connectionId,
          spreadsheet_id: file.id,
          state: 'complete',
        });
      };
      let file: JsonObject;
      if (record?.spreadsheet_id) {
        file = await this.request(
          actor,
          connectionId,
          'https://www.googleapis.com/drive/v3/files/' + fileId(record.spreadsheet_id) + '?fields=id,name,mimeType',
          undefined,
          true,
          undefined,
          context,
        );
        if (file.id !== record.spreadsheet_id)
          throw new MirrorError(
            'SHEETS_RESPONSE_INVALID',
            'Google returned another file for the retained creation.',
            {},
            502,
          );
      } else if (record) {
        const query = new URLSearchParams({
          q: "trashed = false and appProperties has { key='amcp_creation' and value='" + id + "' }",
          fields: 'files(id,name,mimeType),incompleteSearch',
          pageSize: '10',
        });
        const data = await this.request(
          actor,
          connectionId,
          'https://www.googleapis.com/drive/v3/files?' + query,
          undefined,
          true,
          undefined,
          context,
        );
        if (data.incompleteSearch || !Array.isArray(data.files) || data.files.length !== 1)
          throw new MirrorError(
            'SHEETS_CREATION_UNCONFIRMED',
            'Creation was interrupted. Check Google Drive for the AMCP spreadsheet and bind its ID; AMCP will not create a possible duplicate.',
            {creation_id: id},
            409,
          );
        file = data.files[0];
      } else {
        check();
        this.store.putDocument(actor.tenantId, 'sheets_creation', id, {
          name: input.name,
          connection_id: connectionId,
          state: 'creating',
          created_at: Date.now(),
        });
        file = await this.request(
          actor,
          connectionId,
          'https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType',
          {name: input.name, mimeType: 'application/vnd.google-apps.spreadsheet', appProperties: {amcp_creation: id}},
          true,
          undefined,
          {...context, accepted},
        );
      }
      validate(file);
      commitAccess();
      this.store.transaction(() => {
        commitAccess();
        accepted(file);
        const c = this.connection(actor, connectionId, true);
        this.store.updateConnection(actor, {...c, enabled: true, accounts: [...new Set([...c.accounts, file.id])]});
      });
      return {
        spreadsheet_id: file.id,
        name: file.name,
        url: 'https://docs.google.com/spreadsheets/d/' + file.id + '/edit',
        connection_id: connectionId,
      };
    } finally {
      this.store.releaseLock(lock, owner);
    }
  }
  async bind(actor: Actor, input: JsonObject): Promise<JsonObject> {
    if (actor.role === 'reader' || input.confirmed !== true)
      throw new MirrorError('FORBIDDEN', 'Confirm the spreadsheet destination with an operator account.', {}, 403);
    const pasted = input.spreadsheet_url !== undefined,
      spreadsheetId = pasted ? spreadsheetIdFromUrl(input.spreadsheet_url) : fileId(input.spreadsheet_id);
    if (pasted && input.spreadsheet_id !== undefined && input.spreadsheet_id !== spreadsheetId)
      throw new MirrorError('INVALID_SPREADSHEET', 'The spreadsheet ID and URL do not match.');
    const title = destinationTabName(input.tab_name ?? 'AMCP Overview');
    if (
      input.idempotency_key !== undefined &&
      (typeof input.idempotency_key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.idempotency_key))
    )
      throw new MirrorError('INVALID_DESTINATION', 'Use a stable destination creation key.');
    const c = this.connection(actor, String(input.connection_id), pasted && actor.role === 'admin'),
      selected = c.accounts.includes(spreadsheetId),
      allowSelection = pasted && actor.role === 'admin' && !selected;
    if (!selected && !allowSelection)
      throw new MirrorError(
        'SPREADSHEET_SCOPE_REQUIRED',
        'Ask a workspace administrator to add this spreadsheet URL, or choose an already selected spreadsheet.',
        {},
        403,
      );
    const id = input.idempotency_key ? sha256(c.id + ':' + input.idempotency_key) : randomUUID();
    const prior = this.store.documents(actor.tenantId, 'sheets_destination').find(d => d.id === id);
    if (prior && (prior.spreadsheet_id !== spreadsheetId || prior.requested_tab_name !== title))
      throw new MirrorError(
        'IDEMPOTENCY_CONFLICT',
        'This destination key belongs to a different spreadsheet or report tab.',
      );
    let d: JsonObject,
      commitAccess: () => void = () => {
        this.connection(actor, c.id, allowSelection);
      };
    try {
      d = await this.request(
        actor,
        c.id,
        'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '?fields=spreadsheetId,properties(title)',
        undefined,
        allowSelection,
        allowSelection ? spreadsheetId : undefined,
        {
          captureAuthority: check => {
            commitAccess = check;
          },
        },
      );
    } catch (e) {
      if (
        pasted &&
        e instanceof MirrorError &&
        [403, 404].includes(Number(e.details.status)) &&
        !c.scopes.includes('https://www.googleapis.com/auth/spreadsheets')
      )
        throw new MirrorError(
          'SHEETS_RECONNECT_REQUIRED',
          'Connect Google Sheets again and allow spreadsheet access to use pasted URLs. Then retry this URL.',
          {},
          403,
        );
      throw e;
    }
    if (d.spreadsheetId !== spreadsheetId || typeof d.properties?.title !== 'string')
      throw new MirrorError('SHEETS_RESPONSE_INVALID', 'Google did not confirm the selected spreadsheet.', {}, 502);
    // The URL is only an identifier. A successful authenticated read precedes this explicit local grant.
    const record = prior ?? {
      connection_id: c.id,
      spreadsheet_id: spreadsheetId,
      name: d.properties?.title ?? spreadsheetId,
      sheet_id: parseInt(sha256(id).slice(0, 7), 16),
      tab_name: title + ' ' + id.slice(0, 8),
      requested_tab_name: title,
      created_at: Date.now(),
    };
    this.store.transaction(() => {
      const existing = this.store
        .documents(actor.tenantId, 'sheets_destination')
        .find(destination => destination.id === id);
      if (existing && (existing.spreadsheet_id !== spreadsheetId || existing.requested_tab_name !== title))
        throw new MirrorError(
          'IDEMPOTENCY_CONFLICT',
          'This destination key belongs to a different spreadsheet or report tab.',
        );
      commitAccess();
      const latest = this.connection(actor, c.id, allowSelection);
      if (!latest.accounts.includes(spreadsheetId)) {
        if (!allowSelection)
          throw new MirrorError(
            'SPREADSHEET_SCOPE_REQUIRED',
            'The destination spreadsheet is no longer selected.',
            {},
            403,
          );
        this.store.updateConnection(actor, {
          ...latest,
          enabled: true,
          accounts: [...new Set([...latest.accounts, spreadsheetId])],
        });
        let assets: JsonObject = {groups: [], selected: []};
        try {
          assets = this.store.document(actor.tenantId, 'website_assets', c.id);
        } catch (e) {
          if (!(e instanceof MirrorError && e.code === 'NOT_FOUND')) throw e;
        }
        const groups: JsonObject[] = assets.groups ?? [],
          group = groups.find(g => g.kind === 'spreadsheets');
        const asset = {id: spreadsheetId, kind: 'spreadsheets', name: d.properties.title, source: 'vendor'};
        if (group) group.assets = [...(group.assets ?? []).filter((a: JsonObject) => a.id !== spreadsheetId), asset];
        else groups.push({kind: 'spreadsheets', complete: false, assets: [asset]});
        this.store.putDocument(actor.tenantId, 'website_assets', c.id, {
          ...assets,
          groups,
          selected: [...new Set([...(assets.selected ?? []), 'spreadsheets:' + spreadsheetId])],
        });
        this.store.appendAudit(actor.tenantId, randomUUID(), {
          event: 'sheets_destination_selected',
          connection_id: c.id,
          spreadsheet_id: spreadsheetId,
          vendor_writes: 0,
        });
      }
      if (!existing) this.store.putDocument(actor.tenantId, 'sheets_destination', id, record);
    });
    return {
      ...record,
      id,
      url: 'https://docs.google.com/spreadsheets/d/' + spreadsheetId + '/edit#gid=' + record.sheet_id,
    };
  }
  private destinationAuthority(
    actor: Actor,
    destinationId: string,
    assertSource: () => void,
    lock: string,
    owner: string,
  ) {
    const d = this.store.document(actor.tenantId, 'sheets_destination', destinationId),
      frozenBinding = destinationBinding(d);
    let credentialFingerprint: string | undefined;
    const check = () => {
      assertSource();
      const c = this.connection(actor, d.connection_id);
      if (!c.accounts.includes(d.spreadsheet_id))
        throw new MirrorError(
          'SPREADSHEET_SCOPE_REQUIRED',
          'The destination spreadsheet is no longer selected.',
          {},
          403,
        );
      if (
        destinationBinding(this.store.document(actor.tenantId, 'sheets_destination', destinationId)) !== frozenBinding
      )
        throw new MirrorError(
          'SHEETS_DESTINATION_CHANGED',
          'The destination changed during export. Use its current report settings.',
          {},
          409,
        );
      const lease = this.store.db.prepare('SELECT owner,expires_at FROM service_locks WHERE key=?').get(lock) as
        JsonObject | undefined;
      if (!lease || lease.owner !== owner || lease.expires_at <= Date.now())
        throw new MirrorError(
          'EXPORT_LEASE_LOST',
          'This export lost its destination lock. Reconcile the original delivery before retrying.',
          {},
          409,
        );
      if (credentialFingerprint && storedLogin(this.store, c) !== credentialFingerprint)
        throw new MirrorError(
          'CONNECTION_AUTHORITY_CHANGED',
          'The Google Sheets login changed during export. Preserve the original delivery receipt.',
          {},
          409,
        );
    };
    const pinCredentials = async () => {
      const credentials = await this.credentials.get(this.connection(actor, d.connection_id));
      credentialFingerprint = loginStamp(credentials);
      check();
    };
    return {d, frozenBinding, check, pinCredentials};
  }
  /** Reads the destination tab inventory: AMCP ownership metadata and the current delivery marker(s). */
  private async inventory(actor: Actor, d: JsonObject, destinationId: string, check: () => void) {
    const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + fileId(d.spreadsheet_id);
    const meta = await this.request(
      actor,
      d.connection_id,
      url + '?fields=sheets(properties,developerMetadata,protectedRanges)',
      undefined,
      false,
      undefined,
      {check},
    );
    check();
    if (!Array.isArray(meta.sheets))
      throw new MirrorError(
        'SHEETS_RESPONSE_INVALID',
        'Google did not return the destination sheet inventory.',
        {},
        502,
      );
    const existing = meta.sheets.find((s: JsonObject) => s.properties?.sheetId === d.sheet_id);
    if (
      existing &&
      !(existing.developerMetadata ?? []).some(
        (m: JsonObject) => m.metadataKey === 'amcp_destination' && m.metadataValue === destinationId,
      )
    )
      throw new MirrorError(
        'SHEET_OWNERSHIP_CONFLICT',
        'This tab is not marked as the AMCP export destination. Bind a new destination.',
      );
    const markers: JsonObject[] = (existing?.developerMetadata ?? []).filter(
      (m: JsonObject) => m.metadataKey === 'amcp_last_delivery',
    );
    return {url, existing, markers, values: markers.map(m => String(m.metadataValue ?? '')).sort()};
  }
  /** Records a delivery the destination confirms, keeping its send history and the destination's last marker. */
  private delivered(
    tenant: string,
    destinationId: string,
    deliveryId: string,
    record: JsonObject,
    marker: string,
    frozenBinding: string,
    sentAt: number,
    reconciled = false,
  ) {
    this.store.transaction(() => {
      let saved: JsonObject = {};
      try {
        saved = this.store.document(tenant, 'sheets_delivery', deliveryId);
      } catch (e) {
        if (!(e instanceof MirrorError && e.code === 'NOT_FOUND')) throw e;
      }
      const now = Date.now(),
        {id, revision, error_code, ...history} = saved,
        duration = sentAt ? now - sentAt : undefined;
      this.store.putDocument(tenant, 'sheets_delivery', deliveryId, {
        ...history,
        ...record,
        state: 'complete',
        completed_at: now,
        ...(duration === undefined ? {} : {duration_ms: duration}),
        ...(reconciled ? {reconciled: true} : {}),
      });
      this.store.journal(tenant, 'export:' + record.report_id + ':' + destinationId, 'delivered', {
        report_id: record.report_id,
        rows: record.rows,
      });
      const latest = this.store.document(tenant, 'sheets_destination', destinationId);
      if (destinationBinding(latest) === frozenBinding) {
        const {id: _, revision: __, marker_release, ...destination} = latest;
        this.store.putDocument(tenant, 'sheets_destination', destinationId, {
          ...destination,
          last_marker: marker,
          ...(!(latest.last_captured_at > record.captured_at)
            ? {last_captured_at: record.captured_at, last_report_id: record.report_id, last_export_at: now}
            : {}),
          // EXP-04 C: the tab's warning-only protection is settled once (added by AMCP, or already present); a later
          // removal by its users is respected.
          ...(['added', 'existing'].includes(record.tab_protection) && !latest.tab_protection_at
            ? {tab_protection_at: now, tab_protection: record.tab_protection}
            : {}),
        });
      }
      this.store.appendAudit(tenant, 'export/' + record.report_id, {
        event: 'google_sheets_exported',
        destination_id: destinationId,
        report_id: record.report_id,
        row_count: record.rows,
        cells: record.cells ?? history.cells ?? null,
        payload_bytes: history.payload_bytes ?? null,
        duration_ms: duration ?? null,
        ...(reconciled ? {reconciled: true} : {}),
      });
    });
  }
  /**
   * Marker continuity: the tab must still carry the last confirmed marker. A marker of another known delivery to
   * this destination means a released or resent batch landed late; record that truth (the tab holds that report)
   * so the next delivery repairs it. An unknown marker blocks until an operator releases the tab.
   */
  private lateApplication(actor: Actor, destinationId: string, current: string, frozenBinding: string) {
    const [lateId, lateFingerprint] = current.split(':');
    let late: JsonObject | undefined;
    if (lateId && /^[a-f0-9]{64}$/.test(lateId))
      try {
        late = this.store.document(actor.tenantId, 'sheets_delivery', lateId);
      } catch (e) {
        if (!(e instanceof MirrorError && e.code === 'NOT_FOUND')) throw e;
      }
    if (!late || late.destination_id !== destinationId || late.fingerprint !== lateFingerprint)
      throw new MirrorError(
        'SHEETS_MARKER_MISMATCH',
        'This tab’s delivery marker differs from AMCP’s last confirmed delivery. Inspect the tab, then release it before exporting again.',
        {destination_id: destinationId, release_available: true},
        409,
      );
    return this.store.transaction(() => {
      const now = Date.now(),
        {id, revision, error_code, ...history} = late!;
      if (late!.state !== 'complete')
        this.store.putDocument(actor.tenantId, 'sheets_delivery', lateId!, {
          ...history,
          state: 'complete',
          late_applied: true,
          completed_at: now,
        });
      const latest = this.store.document(actor.tenantId, 'sheets_destination', destinationId);
      if (destinationBinding(latest) === frozenBinding) {
        const {id: _, revision: __, ...destination} = latest;
        this.store.putDocument(actor.tenantId, 'sheets_destination', destinationId, {
          ...destination,
          last_marker: current,
          last_report_id: late!.report_id,
          last_captured_at: late!.captured_at,
          late_apply_detected_at: now,
        });
      }
      this.store.appendAudit(actor.tenantId, 'export/' + late!.report_id, {
        event: 'google_sheets_late_apply_detected',
        delivery_id: lateId,
        report_id: late!.report_id,
        destination_id: destinationId,
        replaced_report_id: latest.last_report_id ?? null,
        prior_state: late!.state,
        vendor_writes: 0,
      });
      return late!;
    });
  }
  async write(actor: Actor, destinationId: string, report: JsonObject, assertSource: () => void = () => {}) {
    if (actor.role === 'reader')
      throw new MirrorError('FORBIDDEN', 'An operator role is required to export reports.', {}, 403);
    assertReportExportable(report);
    if (typeof report.id !== 'string' || !report.id)
      throw new MirrorError('INVALID_REPORT', 'Export a saved report with a stable identifier.');
    if (report.state === 'partial' && report.config?.partial_delivery === 'complete_only')
      throw new MirrorError(
        'PARTIAL_DELIVERY_BLOCKED',
        'This schedule accepts complete reports only. Review failed or limited sources; the destination tab was left unchanged.',
        {},
        409,
      );
    const lock = 'sheets-export:' + actor.tenantId + ':' + destinationId,
      owner = randomUUID();
    if (!this.store.acquireLock(lock, owner, sheetsDeliveryLimits.lock_ttl_ms))
      throw new MirrorError(
        'EXPORT_BUSY',
        'Another export is using this destination.',
        {retry_after_ms: 5000},
        503,
        true,
      );
    // A large batch may run up to Google's processing ceiling; renew the lease while it is in flight.
    // check() still fails closed when the lease is lost.
    const renewal = setInterval(() => {
      try {
        this.store.renewLock(lock, owner, sheetsDeliveryLimits.lock_ttl_ms);
      } catch {
        // The next authority check reports a lost lease.
      }
    }, sheetsDeliveryLimits.lock_renew_ms);
    renewal.unref?.();
    try {
      const {d, frozenBinding, check, pinCredentials} = this.destinationAuthority(
        actor,
        destinationId,
        assertSource,
        lock,
        owner,
      );
      check();
      const deliveryId = sheetsDeliveryId(destinationId, report.id);
      let prior: JsonObject | undefined;
      try {
        prior = this.store.document(actor.tenantId, 'sheets_delivery', deliveryId);
      } catch (e) {
        if (!(e instanceof MirrorError && e.code === 'NOT_FOUND')) throw e;
      }
      // EXP-04 C: a delivery keeps the tab contract it was first sent with, so a replay is recognized and a resend of
      // an unconfirmed batch stays identical across an upgrade; a new delivery uses the current contract.
      const tableVersion: 1 | 2 = prior ? (prior.table_version === 2 ? 2 : 1) : sheetsTableVersion();
      const table = reportTable(report, Date.now(), tableVersion),
        width = table[0]!.length,
        height = table.length,
        cells = height * width;
      if (cells > sheetsDeliveryLimits.cell_limit)
        throw new MirrorError(
          'EXPORT_TOO_LARGE',
          'This export exceeds 200,000 cells. Select fewer metrics or split the report.',
        );
      const fingerprint = sha256(
          stable({
            version: tableVersion,
            destination: frozenBinding,
            report_id: report.id,
            captured_at: report.captured_at,
            // Delivery identity uses the snapshot as captured, so a retry or replay after its recommendations
            // expire is still the same delivery; the written cells show the expiry at write time (DEC-01).
            table: reportTable(report, report.captured_at, tableVersion),
          }),
        ),
        marker = deliveryId + ':' + fingerprint;
      if (prior && prior.fingerprint !== fingerprint)
        throw new MirrorError(
          'IDEMPOTENCY_CONFLICT',
          'This report delivery has different content or a different destination. Create a new report run.',
          {},
          409,
        );
      const result = {
        state: 'complete',
        rows: height - 1,
        url: 'https://docs.google.com/spreadsheets/d/' + d.spreadsheet_id + '/edit#gid=' + d.sheet_id,
      };
      if (prior?.state === 'complete') return {...result, replayed: true, receipt_only: true};
      if (prior?.state === 'abandoned')
        throw new MirrorError(
          'SHEETS_DELIVERY_ABANDONED',
          'An operator released this tab from this report’s unconfirmed delivery. Pull a new report or export to a new tab.',
          {delivery_id: deliveryId, destination_id: destinationId},
          409,
        );
      const superseded = (newer: JsonObject) => ({
        state: 'superseded',
        message: 'A newer report is already exported.',
        newer_report_id: newer.last_report_id ?? newer.report_id ?? null,
        newer_captured_at: newer.last_captured_at ?? newer.captured_at ?? null,
      });
      // An older snapshot never replaces a newer one, so it is superseded (not written) before any unresolved delivery
      // of a newer report to this tab could block it (EXP-03 review).
      if (d.last_captured_at > report.captured_at) return superseded(d);
      const unresolved = unresolvedSheetsDelivery(this.store, actor.tenantId, destinationId, deliveryId);
      if (unresolved && unresolved.captured_at > report.captured_at) return superseded(unresolved);
      if (unresolved) {
        // No overtaking: a newer report waits while an earlier one may still land. Recovery of that earlier report
        // is automatic after its settle window; afterwards an operator resolves it.
        const settleUntil = Number(unresolved.sent_at ?? 0) + sheetsDeliveryLimits.settle_ms,
          recovery = sheetsRecoveryEnabled(),
          automatic = recovery && sheetsAutoResend() && Date.now() < settleUntil + 300000;
        throw new MirrorError(
          'SHEETS_DELIVERY_UNRESOLVED',
          !recovery
            ? 'An earlier report delivery is uncertain. Export that original report to this destination again to reconcile its marker before sending a newer report.'
            : automatic
              ? 'An earlier report delivery to this tab is not yet confirmed. AMCP checks it again and, after the settle window, resends that same report before a newer report uses this tab.'
              : 'An earlier report delivery to this tab is still unconfirmed. Check it again, resend that same report, or release the tab from its delivery history.',
          {
            report_id: unresolved.report_id,
            delivery_id: unresolved.id,
            destination_id: destinationId,
            unconfirmed_since: unresolved.sent_at ?? null,
            settle_until: settleUntil,
            ...(automatic ? {retry_after_ms: Math.max(5000, settleUntil + 60000 - Date.now())} : {}),
          },
          409,
          automatic,
        );
      }
      await pinCredentials();
      // A shared write cooldown (for example after a 429 for any tenant) refuses before spending a read.
      this.store.assertProviderCooldown('google-sheets-write');
      const {url, existing, markers, values} = await this.inventory(actor, d, destinationId, check),
        released = !!d.marker_release && stable(values) === stable(d.marker_release.markers ?? []);
      if (markers.length > 1 && !released)
        throw new MirrorError(
          'SHEET_OWNERSHIP_CONFLICT',
          'This tab has conflicting delivery metadata. Inspect the destination before exporting.',
          {destination_id: destinationId, release_available: true},
        );
      // EXP-04 C: the owned tab is protected (warning only) when AMCP creates it, and once for a tab created earlier;
      // a tab that already carries protection, or whose protection was settled before, is left as its users keep it.
      const protectionSettled = tableVersion !== 2 || !!d.tab_protection_at,
        protectedAlready = (existing?.protectedRanges ?? []).some(
          (p: JsonObject) => (p.range?.sheetId ?? d.sheet_id) === d.sheet_id,
        ),
        protect = !protectionSettled && !protectedAlready;
      const record = {
        destination_id: destinationId,
        report_id: report.id,
        fingerprint,
        captured_at: report.captured_at,
        rows: height - 1,
        cells,
        spreadsheet_id: d.spreadsheet_id,
        sheet_id: d.sheet_id,
        table_version: tableVersion,
        ...(protectionSettled ? {} : {tab_protection: protect ? 'added' : 'existing'}),
      };
      let sentAt = 0;
      const accepted = () =>
        this.delivered(actor.tenantId, destinationId, deliveryId, record, marker, frozenBinding, sentAt);
      const current = markers.length === 1 ? values[0] : undefined;
      if (current === marker) {
        // The identical batch is already in the tab (lost response or late application): record it, never resend.
        this.delivered(actor.tenantId, destinationId, deliveryId, record, marker, frozenBinding, 0, true);
        check();
        return {...result, replayed: !!prior, reconciled: true};
      }
      if (!released && current !== undefined && d.last_marker && current !== d.last_marker) {
        const late = this.lateApplication(actor, destinationId, current, frozenBinding);
        if (late.captured_at > report.captured_at) return superseded(late);
      }
      let resend = false;
      if (prior && unresolvedStates.includes(prior.state)) {
        const recovery = sheetsRecoveryEnabled(),
          remaining = settleRemaining(prior);
        if (!recovery || remaining > 0)
          throw new MirrorError(
            'SHEETS_OUTCOME_UNKNOWN',
            recovery
              ? 'The original delivery is not yet confirmed in the destination. AMCP checks its marker again and resends this identical report only after the 10-minute settle window.'
              : 'The original delivery is not confirmed in the destination. AMCP will check its marker again without resending the report.',
            {
              // Re-check the marker every 150 s at most, so an applied batch with a lost response is confirmed early
              // and the bounded job attempts still reach the settle window.
              retry_after_ms: recovery ? Math.max(5000, Math.min(remaining, 150000)) : 5000,
              delivery_id: deliveryId,
              unconfirmed_since: prior.sent_at ?? null,
              settle_until: Number(prior.sent_at ?? 0) + sheetsDeliveryLimits.settle_ms,
            },
            503,
            true,
          );
        if (!sheetsAutoResend() && !prior.resend_authorized_by)
          throw new MirrorError(
            'SHEETS_RESEND_CONFIRMATION_REQUIRED',
            'The settle window has passed and this deployment resends an unconfirmed delivery only after an operator confirms it. Resend this report or release the tab from its delivery history.',
            {delivery_id: deliveryId, destination_id: destinationId, unconfirmed_since: prior.sent_at ?? null},
            409,
          );
        // Google never applied it within the settle window: send the identical, marker-idempotent batch once more.
        resend = true;
      }
      const rows = table.map(row => ({
        values: row.map(v => ({
          userEnteredValue:
            typeof v === 'number' && Number.isFinite(v) ? {numberValue: v} : {stringValue: String(v ?? '')},
        })),
      }));
      const requests: JsonObject[] = existing
        ? []
        : [
            {addSheet: {properties: {sheetId: d.sheet_id, title: d.tab_name}}},
            {
              createDeveloperMetadata: {
                developerMetadata: {
                  metadataKey: 'amcp_destination',
                  metadataValue: destinationId,
                  location: {sheetId: d.sheet_id},
                  visibility: 'DOCUMENT',
                },
              },
            },
          ];
      const rowCount = Math.max(100, height, existing?.properties.gridProperties?.rowCount ?? 0),
        columnCount = Math.max(width, existing?.properties.gridProperties?.columnCount ?? 0);
      requests.push(
        {
          updateSheetProperties: {
            properties: {sheetId: d.sheet_id, gridProperties: {rowCount, columnCount, frozenRowCount: 1}},
            fields: 'gridProperties',
          },
        },
        {
          updateCells: {
            range: {
              sheetId: d.sheet_id,
              startRowIndex: 0,
              startColumnIndex: 0,
              endRowIndex: rowCount,
              endColumnIndex: columnCount,
            },
            rows,
            fields: 'userEnteredValue',
          },
        },
        {
          repeatCell: {
            range: {sheetId: d.sheet_id, startRowIndex: 0, endRowIndex: 1},
            cell: {
              userEnteredFormat: {
                backgroundColor: {red: 0.16, green: 0.12, blue: 0.3},
                textFormat: {bold: true, foregroundColor: {red: 1, green: 1, blue: 1}},
              },
            },
            fields: 'userEnteredFormat',
          },
        },
        {
          setBasicFilter: {
            filter: {
              range: {
                sheetId: d.sheet_id,
                startRowIndex: 0,
                endRowIndex: height,
                startColumnIndex: 0,
                endColumnIndex: width,
              },
            },
          },
        },
      );
      if (tableVersion === 2)
        requests.push(...sheetsPresentationRequests(report, table, d.sheet_id, rowCount, columnCount));
      if (markers.length === 1 && !released) {
        if (!Number.isSafeInteger(markers[0]!.metadataId) || markers[0]!.metadataId < 0)
          throw new MirrorError(
            'SHEETS_RESPONSE_INVALID',
            'Google returned an invalid delivery metadata identifier.',
            {},
            502,
          );
        requests.push({
          updateDeveloperMetadata: {
            dataFilters: [{developerMetadataLookup: {metadataId: markers[0]!.metadataId}}],
            developerMetadata: {metadataValue: marker},
            fields: 'metadataValue',
          },
        });
      } else {
        // Idempotent per fingerprint: an existing tab first loses every delivery marker in the same atomic batch, so
        // resending (or a late original) can never leave two markers.
        if (existing)
          requests.push({
            deleteDeveloperMetadata: {
              dataFilter: {
                developerMetadataLookup: {metadataKey: 'amcp_last_delivery', metadataLocation: {sheetId: d.sheet_id}},
              },
            },
          });
        requests.push({
          createDeveloperMetadata: {
            developerMetadata: {
              metadataKey: 'amcp_last_delivery',
              metadataValue: marker,
              location: {sheetId: d.sheet_id},
              visibility: 'DOCUMENT',
            },
          },
        });
      }
      // EXP-04 C: the tab names the contract its cells follow (`amcp_table_version` "2"), so a reader can tell layouts
      // apart. The unmarked version 1 layout (a delivery first sent under it, or the rollback) carries no marker, so a
      // marker a version 2 delivery left is removed in the same atomic batch.
      const versions: JsonObject[] = (existing?.developerMetadata ?? []).filter(
        (m: JsonObject) => m.metadataKey === sheetsTableVersionKey,
      );
      if (!(tableVersion === 2 && versions.length === 1 && versions[0]!.metadataValue === '2')) {
        if (versions.length)
          requests.push({
            deleteDeveloperMetadata: {
              dataFilter: {
                developerMetadataLookup: {metadataKey: sheetsTableVersionKey, metadataLocation: {sheetId: d.sheet_id}},
              },
            },
          });
        if (tableVersion === 2)
          requests.push({
            createDeveloperMetadata: {
              developerMetadata: {
                metadataKey: sheetsTableVersionKey,
                metadataValue: '2',
                location: {sheetId: d.sheet_id},
                visibility: 'DOCUMENT',
              },
            },
          });
      }
      if (protect)
        requests.push({
          addProtectedRange: {
            protectedRange: {range: {sheetId: d.sheet_id}, description: sheetsTabProtection, warningOnly: true},
          },
        });
      const payloadBytes = Buffer.byteLength(JSON.stringify({requests}));
      if (payloadBytes > sheetsDeliveryLimits.payload_bytes)
        throw new MirrorError('EXPORT_TOO_LARGE', 'Split this report into smaller exports.');
      try {
        await this.request(actor, d.connection_id, url + ':batchUpdate', {requests}, false, undefined, {
          check,
          accepted,
          beforeSend: () => {
            check();
            sentAt = Date.now();
            this.store.transaction(() => {
              this.store.putDocument(actor.tenantId, 'sheets_delivery', deliveryId, {
                ...record,
                state: 'pending',
                sent_at: sentAt,
                first_sent_at: prior?.first_sent_at ?? prior?.sent_at ?? sentAt,
                attempts: (prior?.attempts ?? (prior?.sent_at ? 1 : 0)) + 1,
                payload_bytes: payloadBytes,
                ...(prior?.resend_authorized_by
                  ? {resend_authorized_by: prior.resend_authorized_by, resend_authorized_at: prior.resend_authorized_at}
                  : {}),
                ...(resend ? {resent_at: sentAt} : {}),
              });
              this.store.journal(actor.tenantId, 'export:' + report.id + ':' + destinationId, 'delivering', {
                report_id: report.id,
                rows: height - 1,
              });
              if (resend)
                this.store.appendAudit(actor.tenantId, 'export/' + report.id, {
                  event: 'google_sheets_delivery_resent',
                  delivery_id: deliveryId,
                  report_id: report.id,
                  destination_id: destinationId,
                  unconfirmed_since: prior!.sent_at ?? null,
                  authorized_by: prior!.resend_authorized_by ? 'operator' : 'settle_window',
                  actor: actor.userId,
                  payload_bytes: payloadBytes,
                });
            });
          },
        });
      } catch (e) {
        let saved: JsonObject | undefined;
        try {
          saved = this.store.document(actor.tenantId, 'sheets_delivery', deliveryId);
        } catch (error) {
          if (!(error instanceof MirrorError && error.code === 'NOT_FOUND')) throw error;
        }
        if (saved?.state === 'pending') {
          // Definitive refusals (and Google's UNAVAILABLE, which batchUpdate never partially applies) are not
          // applied. A 5xx without UNAVAILABLE, a timeout or a lost connection stays uncertain.
          const status = e instanceof MirrorError ? Number(e.details.status) : NaN,
            rejected =
              e instanceof MirrorError &&
              ([400, 401, 403, 404, 413, 429].includes(status) ||
                (status >= 500 && status <= 599 && e.details.google_status === 'UNAVAILABLE'));
          this.store.putDocument(actor.tenantId, 'sheets_delivery', deliveryId, {
            ...saved,
            state: rejected ? 'rejected' : 'uncertain',
            error_code: e instanceof MirrorError ? e.code : 'SHEETS_OUTCOME_UNKNOWN',
            duration_ms: Date.now() - Number(saved.sent_at ?? Date.now()),
          });
        }
        throw e;
      }
      return {...result, ...(resend ? {resent: true} : {})};
    } finally {
      clearInterval(renewal);
      this.store.releaseLock(lock, owner);
    }
  }
  /** Check again: one inventory read; a matching marker confirms the delivery, otherwise nothing changes. */
  async checkDelivery(actor: Actor, destinationId: string, deliveryId: string) {
    if (actor.role === 'reader')
      throw new MirrorError('FORBIDDEN', 'An operator role is required to check a delivery.', {}, 403);
    const lock = 'sheets-export:' + actor.tenantId + ':' + destinationId,
      owner = randomUUID();
    if (!this.store.acquireLock(lock, owner, sheetsDeliveryLimits.lock_ttl_ms))
      throw new MirrorError(
        'EXPORT_BUSY',
        'Another export is using this destination.',
        {retry_after_ms: 5000},
        503,
        true,
      );
    try {
      const {d, frozenBinding, check, pinCredentials} = this.destinationAuthority(
        actor,
        destinationId,
        () => {},
        lock,
        owner,
      );
      check();
      const delivery = this.store.document(actor.tenantId, 'sheets_delivery', deliveryId);
      if (delivery.destination_id !== destinationId)
        throw new MirrorError('NOT_FOUND', 'Delivery not found for this destination.', {}, 404);
      if (!unresolvedStates.includes(delivery.state))
        return {state: delivery.state, delivery: deliveryProjection(delivery)};
      await pinCredentials();
      const {values} = await this.inventory(actor, d, destinationId, check),
        marker = deliveryId + ':' + delivery.fingerprint;
      if (values.length === 1 && values[0] === marker) {
        const {id, revision, state, error_code, ...record} = delivery;
        this.delivered(actor.tenantId, destinationId, deliveryId, record, marker, frozenBinding, 0, true);
        check();
        return {
          state: 'complete',
          reconciled: true,
          delivery: deliveryProjection(this.store.document(actor.tenantId, 'sheets_delivery', deliveryId)),
          network_requests: 1,
        };
      }
      this.store.appendAudit(actor.tenantId, 'export/' + delivery.report_id, {
        event: 'google_sheets_delivery_checked',
        delivery_id: deliveryId,
        report_id: delivery.report_id,
        destination_id: destinationId,
        marker: values.length ? 'other' : 'absent',
        actor: actor.userId,
        vendor_writes: 0,
      });
      return {state: delivery.state, reconciled: false, delivery: deliveryProjection(delivery), network_requests: 1};
    } finally {
      this.store.releaseLock(lock, owner);
    }
  }
  /**
   * Release a tab whose marker no longer matches AMCP's last confirmed delivery (unknown or duplicate markers).
   * The observed marker set becomes the accepted baseline; the next delivery replaces it with exactly one marker.
   */
  async releaseDestination(actor: Actor, destinationId: string) {
    if (actor.role === 'reader')
      throw new MirrorError('FORBIDDEN', 'An operator role is required to release a report tab.', {}, 403);
    if (!sheetsRecoveryEnabled())
      throw new MirrorError(
        'DELIVERY_RECOVERY_DISABLED',
        'Resending or releasing an unconfirmed Sheets delivery is turned off in this deployment.',
        {},
        409,
      );
    const lock = 'sheets-export:' + actor.tenantId + ':' + destinationId,
      owner = randomUUID();
    if (!this.store.acquireLock(lock, owner, sheetsDeliveryLimits.lock_ttl_ms))
      throw new MirrorError(
        'EXPORT_BUSY',
        'Another export is using this destination.',
        {retry_after_ms: 5000},
        503,
        true,
      );
    try {
      if (unresolvedSheetsDelivery(this.store, actor.tenantId, destinationId))
        throw new MirrorError(
          'SHEETS_DELIVERY_UNRESOLVED',
          'Resolve the unconfirmed delivery to this tab first.',
          {destination_id: destinationId},
          409,
        );
      const {d, frozenBinding, check, pinCredentials} = this.destinationAuthority(
        actor,
        destinationId,
        () => {},
        lock,
        owner,
      );
      check();
      await pinCredentials();
      const {values} = await this.inventory(actor, d, destinationId, check);
      if (!(values.length > 1 || (values.length === 1 && d.last_marker && values[0] !== d.last_marker)))
        throw new MirrorError(
          'NOTHING_TO_RELEASE',
          'This tab has no unconfirmed delivery or conflicting marker. It is ready for the next export.',
          {destination_id: destinationId},
          409,
        );
      this.store.transaction(() => {
        check();
        const latest = this.store.document(actor.tenantId, 'sheets_destination', destinationId);
        if (destinationBinding(latest) !== frozenBinding)
          throw new MirrorError('SHEETS_DESTINATION_CHANGED', 'The destination changed. Refresh it first.', {}, 409);
        const {id, revision, ...destination} = latest;
        this.store.putDocument(actor.tenantId, 'sheets_destination', destinationId, {
          ...destination,
          marker_release: {markers: values, released_at: Date.now(), released_by: actor.userId},
        });
        this.store.appendAudit(actor.tenantId, 'sheets-destination/' + destinationId, {
          event: 'google_sheets_destination_released',
          destination_id: destinationId,
          markers: values.length,
          actor: actor.userId,
          vendor_writes: 0,
        });
      });
      return {destination_id: destinationId, state: 'released', markers: values.length, network_requests: 1};
    } finally {
      this.store.releaseLock(lock, owner);
    }
  }
}
