import {bad, fingerprint, obj, type ToolCall} from './workspace-core.js';
import {nestedError} from './errors.js';
import {collectionCheckpoint} from './report-collection-budget.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {tiktokReportPageData} from './tiktok-report-pagination.js';
import {storedLogin} from './connection-authority.js';

const gateway = 'tiktok_native_action';
const nativeId = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const incomplete = (message: string): never => bad(message, 'REPORT_INCOMPLETE');
export function tiktokReportDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?: 00:00:00)?$/.test(value))
    bad('TikTok did not return a native daily date.', 'REPORT_DATE_MISMATCH');
  const date = (value as string).slice(0, 10);
  if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)
    bad('TikTok returned an invalid daily date.', 'REPORT_DATE_MISMATCH');
  return date;
}
export function tiktokDailyRange(semantics: JsonObject) {
  const from = tiktokReportDate(semantics.date_from),
    through = tiktokReportDate(semantics.date_to);
  let today: string;
  try {
    if (typeof semantics.timezone !== 'string') throw Error();
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en', {
        timeZone: semantics.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .formatToParts()
        .map(p => [p.type, p.value]),
    );
    today = `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return bad('Declare the native advertiser IANA timezone.');
  }
  if (
    semantics.complete !== true ||
    through < from ||
    through >= today ||
    Date.parse(through) - Date.parse(from) >= 31 * 86400000
  )
    bad('TikTok guided evidence requires a declared complete window of 1–31 closed days in the advertiser timezone.');
}
function pageRows(data: JsonObject, page: number, size: number) {
  const native = tiktokReportPageData(data, page, size);
  if (native.total > 10000) bad('Narrow the TikTok report to at most 10000 rows.', 'REPORT_COLLECTION_LIMIT');
  return native;
}

/** Standard BASIC auction reports only. Complete pages do not establish a point-in-time provider snapshot. */
export async function collectTikTokDailyReport(
  store: Store,
  call: ToolCall,
  actor: Actor,
  args: JsonObject,
  semantics: JsonObject,
) {
  const account = args.account_id,
    connection = store.resolveConnection(actor, gateway, account, args.connection_id),
    authorization = fingerprint({
      login: storedLogin(store, connection),
      scopes: [...connection.scopes].sort(),
    });
  const current = () => {
    const c = store.resolveConnection(actor, gateway, account, connection.id);
    if (fingerprint({login: storedLogin(store, c), scopes: [...c.scopes].sort()}) !== authorization)
      bad('The TikTok login or permissions changed. Capture a new report.', 'CONNECTION_AUTHORITY_CHANGED');
    collectionCheckpoint();
  };
  const read = async (request: JsonObject) => {
    current();
    const result = await call(gateway, request, actor);
    current();
    if (result.success !== true)
      throw nestedError(result, {code: 'REPORT_FAILED', message: 'TikTok report read failed.'});
    const root = result.data?.data;
    if (
      result.data?.executed === false ||
      result.data?.dry_run ||
      !obj(root) ||
      root.code !== 0 ||
      !obj(root.data) ||
      [result.data, root, root.data].some(
        v =>
          v.error ||
          v.errors ||
          v.truncated ||
          [
            'next_cursor',
            'next_page_token',
            'nextPageToken',
            'next',
            'has_more',
            'hasMore',
            'paging',
            'pagination',
          ].some(key => v[key] !== undefined),
      )
    )
      incomplete('TikTok returned partial or unknown report completion metadata.');
    return {
      data: root.data as JsonObject,
      evidence: {source_request: request, source_hash: fingerprint(result.data), captured_at: Date.now()},
    };
  };
  const accountChecks: JsonObject[] = [];
  const verifyAccount = async () => {
    const {data, evidence} = await read({
      action: 'tiktok_advertiser_info_get',
      account_id: account,
      connection_id: connection.id,
      query: {advertiser_ids: [account], fields: ['advertiser_id', 'currency', 'timezone']},
      aggregate_pages: false,
      dry_run: false,
    });
    if (
      !Array.isArray(data.list) ||
      data.list.length !== 1 ||
      !obj(data.list[0]) ||
      data.list[0].advertiser_id !== account
    )
      bad('TikTok did not return the exact selected advertiser.', 'REPORT_ACCOUNT_MISMATCH');
    if (data.page_info !== undefined) {
      const p = data.page_info;
      if (
        !obj(p) ||
        p.page !== 1 ||
        p.total_number !== 1 ||
        p.total_page !== 1 ||
        !Number.isSafeInteger(p.page_size) ||
        p.page_size < 1
      )
        incomplete('TikTok advertiser metadata was incomplete.');
    }
    if (data.list[0].currency !== semantics.currency)
      bad('The declared currency does not match the current TikTok advertiser.', 'REPORT_CURRENCY_MISMATCH');
    if (data.list[0].timezone !== semantics.timezone)
      bad('The declared timezone does not match the current TikTok advertiser.', 'REPORT_TIMEZONE_MISMATCH');
    accountChecks.push(evidence);
  };
  await verifyAccount();
  const rows: JsonObject[] = [],
    pages: JsonObject[] = [],
    seen = new Set<string>(),
    idField = args.query.dimensions[0];
  let total: number | undefined;
  for (let page = 1; page <= 10; page++) {
    const request = {...args, query: {...args.query, page}},
      {data, evidence} = await read(request),
      native = pageRows(data, page, args.query.page_size);
    if (total !== undefined && total !== native.total)
      incomplete('TikTok report row counts changed during collection. Capture again.');
    total = native.total;
    for (const row of native.rows) {
      if (
        !obj(row) ||
        !obj(row.dimensions) ||
        !obj(row.metrics) ||
        !nativeId(row.dimensions[idField]) ||
        Object.keys(row.dimensions).length !== 2 ||
        !Object.hasOwn(row.dimensions, 'stat_time_day') ||
        (row.advertiser_id !== undefined && row.advertiser_id !== account) ||
        (row.metrics.advertiser_id !== undefined && row.metrics.advertiser_id !== account)
      )
        bad('TikTok returned an unbound or different native entity/day grain.', 'REPORT_SHAPE_CHANGED');
      const date = tiktokReportDate(row.dimensions.stat_time_day);
      if (date < semantics.date_from || date > semantics.date_to)
        bad('TikTok returned a date outside the requested daily window.', 'REPORT_DATE_MISMATCH');
      const key = row.dimensions[idField] + ':' + date;
      if (seen.has(key)) bad('TikTok returned duplicate entity/day rows.', 'REPORT_DUPLICATE_ROWS');
      seen.add(key);
      rows.push(row);
    }
    pages.push({...evidence, page, row_count: native.rows.length, total_rows: native.total});
    if (page >= native.pages) break;
  }
  if (rows.length !== total) incomplete('TikTok did not return every declared report row.');
  await verifyAccount();
  current();
  return {
    source: {success: true, data: {collection_kind: 'tiktok_daily_pages', data: {list: rows}, source_pages: pages}},
    sourcePages: pages,
    nativeAccountEvidence: {
      account_id: account,
      currency: semantics.currency,
      timezone: semantics.timezone,
      checks: accountChecks,
    },
    assertCurrent: current,
  };
}
