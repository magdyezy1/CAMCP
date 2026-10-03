import {bad, fingerprint, obj, type ToolCall} from './workspace-core.js';
import {collectionCheckpoint} from './report-collection-budget.js';
import {zonedMidnight} from './workflows.js';
import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';

const gateway = 'snapchat_native_action';
export const snapchatReportId = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const success = (v: unknown) => typeof v === 'string' && v.toUpperCase() === 'SUCCESS';
const incomplete = (message: string): never => bad(message, 'REPORT_INCOMPLETE');
const shape = (message: string): never => bad(message, 'REPORT_SHAPE_CHANGED');
function instant(v: unknown): number {
  if (
    typeof v !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v.slice(0, 10)).toISOString().slice(0, 10) !== v.slice(0, 10)
  )
    return bad('Snapchat returned an invalid native report timestamp.', 'REPORT_DATE_MISMATCH');
  return Date.parse(v);
}
export function snapchatDailyRange(sem: JsonObject) {
  for (const key of ['date_from', 'date_to'])
    if (
      typeof sem[key] !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(sem[key]) ||
      !Number.isFinite(Date.parse(sem[key])) ||
      new Date(sem[key]).toISOString().slice(0, 10) !== sem[key]
    )
      bad('Choose valid Snapchat report dates.', 'REPORT_DATE_MISMATCH');
  if (typeof sem.timezone !== 'string') bad('Declare the native Snapchat IANA timezone.');
  let today: string;
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: sem.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(Date.now());
    today = ['year', 'month', 'day'].map(key => parts.find(p => p.type === key)!.value).join('-');
  } catch {
    return bad('Declare the native Snapchat IANA timezone.', 'INVALID_TIMEZONE');
  }
  const start = Date.parse(sem.date_from),
    end = Date.parse(sem.date_to);
  if (sem.complete !== true || end < start || end - start >= 31 * 86400000 || sem.date_to >= today)
    bad('Snapchat guided evidence requires 1–31 closed days and an explicit complete-window declaration.');
  const days: {date: string; start: number; end: number}[] = [];
  for (let at = start; at <= end; at += 86400000) {
    const date = new Date(at).toISOString().slice(0, 10),
      next = new Date(at + 86400000).toISOString().slice(0, 10),
      from = zonedMidnight(date, sem.timezone, true),
      through = zonedMidnight(next, sem.timezone, true);
    if (from % 3600000 || through % 3600000)
      bad(
        'Snapchat stats require whole-hour boundaries; this account midnight has a fractional-hour offset.',
        'UNSUPPORTED_TIMEZONE_OFFSET',
      );
    days.push({date, start: from, end: through});
  }
  return days;
}
function metadata(v: JsonObject) {
  if (
    v.error !== undefined ||
    v.errors !== undefined ||
    v.truncated === true ||
    (v.sub_request_status !== undefined && !success(v.sub_request_status)) ||
    ['nextPageToken', 'next_page_token', 'next_cursor', 'has_more', 'hasMore', 'pagination'].some(
      k => v[k] !== undefined,
    ) ||
    (v.split_results !== undefined && (!Array.isArray(v.split_results) || v.split_results.length)) ||
    v.dimension_stats !== undefined ||
    v.report_dimension !== undefined
  )
    incomplete('Snapchat returned partial, split or unrequested report dimensions.');
}
function nextCursor(data: JsonObject, path: string, query: JsonObject) {
  if (data.paging === undefined) return undefined;
  if (!obj(data.paging) || Object.keys(data.paging).some(k => k !== 'next_link'))
    incomplete('Snapchat returned unknown report paging metadata.');
  if (data.paging.next_link === undefined) return undefined;
  try {
    const link = data.paging.next_link;
    if (typeof link !== 'string' || !link || link.length > 8192) throw Error();
    const u = new URL(link),
      token = u.searchParams.get('cursor');
    if (
      u.origin !== 'https://adsapi.snapchat.com' ||
      u.username ||
      u.password ||
      u.hash ||
      u.pathname !== path ||
      [...u.searchParams.keys()].some(
        k =>
          u.searchParams.getAll(k).length !== 1 ||
          (k !== 'cursor' && (!Object.hasOwn(query, k) || u.searchParams.get(k) !== String(query[k]))),
      ) ||
      typeof token !== 'string' ||
      !token ||
      token.length > 4096 ||
      /[\x00-\x20\x7f]/.test(token)
    )
      throw Error();
    return token;
  } catch {
    return incomplete('Snapchat continuation changed the account, report settings or authorized route.');
  }
}

/** Bounded daily account breakdowns. Per-page finalization is not an atomic account snapshot. */
export async function collectSnapchatEvidence(
  store: Store,
  call: ToolCall,
  actor: Actor,
  args: JsonObject,
  sem: JsonObject,
) {
  const account = args.account_id,
    connection = store.resolveConnection(actor, gateway, account, args.connection_id),
    authorization = fingerprint({
      credentials: store.connectionCredentials(connection),
      scopes: [...connection.scopes].sort(),
    }),
    days = snapchatDailyRange(sem),
    from = days[0]!.start,
    through = days.at(-1)!.end,
    level = args.query.breakdown,
    parentId = level === 'adsquad' ? args.path_params?.campaign_id : undefined,
    path = parentId ? '/v1/campaigns/' + parentId + '/stats' : '/v1/adaccounts/' + account + '/stats';
  const current = () => {
    store.assertActorActive(actor);
    const c = store.resolveConnection(actor, gateway, account, connection.id);
    if (!c.scopes.includes('snapchat-marketing-api'))
      bad('This login requires Snapchat Marketing API permission.', 'INSUFFICIENT_SCOPE');
    if (fingerprint({credentials: store.connectionCredentials(c), scopes: [...c.scopes].sort()}) !== authorization)
      bad('The Snapchat login or permissions changed. Capture a new report.', 'REAUTHORIZATION_REQUIRED');
    collectionCheckpoint();
  };
  const read = async (request: JsonObject) => {
    current();
    const result = await call(gateway, request, actor);
    current();
    if (result.success !== true)
      bad(result.error?.message ?? 'Snapchat report read failed.', result.error?.code ?? 'REPORT_FAILED');
    const data = result.data?.data;
    if (result.data?.executed === false || result.data?.dry_run || !obj(data) || !success(data.request_status))
      incomplete('Snapchat did not return a successful native read.');
    metadata(result.data);
    metadata(data);
    return {
      data: data as JsonObject,
      evidence: {source_request: request, source_hash: fingerprint(result.data), captured_at: Date.now()},
    };
  };
  const checks: JsonObject[] = [],
    parentChecks: JsonObject[] = [];
  const parentRows = (data: JsonObject, limit: number): JsonObject[] => {
    if (!Array.isArray(data.campaigns) || data.campaigns.length > limit)
      shape('Snapchat did not return a bounded parent campaign collection.');
    const ids = new Set<string>();
    return data.campaigns.map((wrapped: JsonObject) => {
      if (!obj(wrapped) || !success(wrapped.sub_request_status) || !obj(wrapped.campaign))
        incomplete('Snapchat returned failed or malformed parent campaign evidence.');
      metadata(wrapped);
      const campaign = wrapped.campaign;
      metadata(campaign);
      if (!snapchatReportId(campaign.id) || campaign.ad_account_id !== account || ids.has(campaign.id))
        bad('Snapchat parent evidence has another account or malformed identity.', 'REPORT_ACCOUNT_MISMATCH');
      ids.add(campaign.id);
      return campaign as JsonObject;
    });
  };
  const establishParent = async () => {
    const listPath = '/v1/adaccounts/' + account + '/campaigns',
      query = {limit: 100, sort: 'created_at-desc'},
      seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 1; page <= 100; page++) {
      const {data, evidence} = await read({
        action: 'snapchat_campaign_list',
        account_id: account,
        connection_id: connection.id,
        path_params: {ad_account_id: account},
        query: {...query, ...(cursor ? {cursor} : {})},
        aggregate_pages: false,
        dry_run: false,
      });
      const rows = parentRows(data, query.limit),
        next = nextCursor(data, listPath, query);
      parentChecks.push({...evidence, page, campaign_count: rows.length});
      if (rows.some(row => row.id === parentId)) return;
      if (next === undefined) break;
      if (!rows.length || seen.has(next) || page === 100)
        incomplete('Snapchat parent lookup repeated or exceeded its bounded account collection.');
      seen.add(next);
      cursor = next;
    }
    bad('The selected campaign was not observed in this account collection.', 'REPORT_PARENT_REQUIRED');
  };
  const verifyParent = async () => {
    const {data, evidence} = await read({
      action: 'snapchat_campaign_get',
      account_id: account,
      connection_id: connection.id,
      path_params: {campaign_id: parentId},
      aggregate_pages: false,
      dry_run: false,
    });
    const rows = parentRows(data, 1);
    if (rows.length !== 1 || rows[0]!.id !== parentId || nextCursor(data, '/v1/campaigns/' + parentId, {}))
      bad('Snapchat did not confirm the exact parent campaign.', 'REPORT_ACCOUNT_MISMATCH');
    parentChecks.push(evidence);
  };
  const verifyAccount = async () => {
    const {data, evidence} = await read({
      action: 'snapchat_account_get',
      account_id: account,
      connection_id: connection.id,
      path_params: {ad_account_id: account},
      aggregate_pages: false,
      dry_run: false,
    });
    if (
      nextCursor(data, path, {}) ||
      !Array.isArray(data.adaccounts) ||
      data.adaccounts.length !== 1 ||
      !obj(data.adaccounts[0]) ||
      !success(data.adaccounts[0].sub_request_status) ||
      !obj(data.adaccounts[0].adaccount) ||
      data.adaccounts[0].adaccount.id !== account
    )
      bad('Snapchat did not return the exact selected account.', 'REPORT_ACCOUNT_MISMATCH');
    metadata(data.adaccounts[0]);
    const a = data.adaccounts[0].adaccount;
    metadata(a);
    if (a.currency !== sem.currency)
      bad('The declared currency does not match the Snapchat account.', 'REPORT_CURRENCY_MISMATCH');
    if (a.timezone !== sem.timezone)
      bad('The declared timezone does not match the Snapchat account.', 'REPORT_TIMEZONE_MISMATCH');
    checks.push(evidence);
  };
  await verifyAccount();
  if (parentId) {
    await establishParent();
    await verifyParent();
  }
  const rows: JsonObject[] = [],
    pages: JsonObject[] = [],
    seenEntities = new Set<string>(),
    seenCursors = new Set<string>();
  let after: string | undefined;
  for (let page = 1; page <= 100; page++) {
    const request = {...args, aggregate_pages: false, query: {...args.query, ...(after ? {cursor: after} : {})}},
      {data, evidence} = await read(request),
      wrappers = data.timeseries_stats;
    if (
      !Array.isArray(wrappers) ||
      wrappers.length !== 1 ||
      !obj(wrappers[0]) ||
      !success(wrappers[0].sub_request_status) ||
      !obj(wrappers[0].timeseries_stat)
    )
      shape('Snapchat did not return one successful account daily breakdown.');
    const wrapper = wrappers[0],
      stat = wrapper.timeseries_stat;
    metadata(wrapper);
    metadata(stat);
    if (stat.id !== (parentId ?? account) || stat.type !== (parentId ? 'CAMPAIGN' : 'AD_ACCOUNT'))
      bad('Snapchat returned another report account or parent.', 'REPORT_ACCOUNT_MISMATCH');
    if (
      (stat.granularity !== undefined && stat.granularity !== 'DAY') ||
      instant(stat.start_time) !== from ||
      instant(stat.end_time) !== through
    )
      bad('Snapchat returned a different reporting window or grain.', 'REPORT_DATE_MISMATCH');
    for (const key of ['swipe_up_attribution_window', 'view_attribution_window'])
      if (stat[key] !== args.query[key])
        bad('Snapchat returned different attribution settings.', 'REPORT_SEMANTICS_MISMATCH');
    for (const key of ['action_report_time', 'conversion_source_types'])
      if (stat[key] !== undefined && stat[key] !== args.query[key])
        bad('Snapchat returned a different conversion definition.', 'REPORT_SEMANTICS_MISMATCH');
    if (instant(stat.finalized_data_end_time) < through || instant(stat.conversion_data_processed_end_time) < through)
      incomplete('Snapchat has not finalized delivery and conversion-time data through the selected window.');
    if (
      !obj(stat.breakdown_stats) ||
      Object.keys(stat.breakdown_stats).length !== 1 ||
      !Array.isArray(stat.breakdown_stats[level])
    )
      shape('Snapchat did not return the requested entity breakdown.');
    const entities = stat.breakdown_stats[level];
    if (entities.length > args.query.limit) incomplete('Snapchat exceeded the requested entity page size.');
    const before = rows.length;
    for (const entity of entities) {
      if (
        !obj(entity) ||
        !snapchatReportId(entity.id) ||
        entity.type !== (level === 'adsquad' ? 'AD_SQUAD' : level.toUpperCase()) ||
        entity.granularity !== 'DAY'
      )
        shape('Snapchat returned a malformed or different native entity.');
      metadata(entity);
      if (seenEntities.has(entity.id)) bad('Snapchat repeated an entity across report pages.', 'REPORT_DUPLICATE_ROWS');
      seenEntities.add(entity.id);
      if (
        instant(entity.start_time) !== from ||
        instant(entity.end_time) !== through ||
        !Array.isArray(entity.timeseries) ||
        entity.timeseries.length !== days.length
      )
        incomplete('Snapchat did not return the complete requested daily window for an entity.');
      const seenDays = new Set<string>();
      for (const row of entity.timeseries) {
        if (!obj(row) || !obj(row.stats)) shape('Snapchat returned a malformed daily metric row.');
        metadata(row);
        metadata(row.stats);
        const day = days.find(d => d.start === instant(row.start_time) && d.end === instant(row.end_time));
        if (!day) bad('Snapchat returned a different native day boundary.', 'REPORT_DATE_MISMATCH');
        if (seenDays.has(day.date)) bad('Snapchat repeated a native entity/day row.', 'REPORT_DUPLICATE_ROWS');
        seenDays.add(day.date);
        for (const key of ['spend', 'impressions', 'swipes', 'conversion_purchases']) {
          const value = row.stats[key];
          if (
            value !== undefined &&
            value !== null &&
            !(
              (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
              (typeof value === 'string' && /^\d{1,30}$/.test(value))
            )
          )
            shape('Snapchat returned a metric without an exact nonnegative native integer.');
        }
        if (rows.length >= 10000)
          bad('Narrow the Snapchat evidence to at most 10000 daily rows.', 'REPORT_COLLECTION_LIMIT');
        rows.push({entity_id: entity.id, date: day.date, stats: row.stats});
      }
    }
    pages.push({
      ...evidence,
      page,
      entity_count: entities.length,
      row_count: rows.length - before,
      finalized_data_end_time: stat.finalized_data_end_time,
      conversion_data_processed_end_time: stat.conversion_data_processed_end_time,
    });
    after = nextCursor(data, path, args.query);
    if (after === undefined) break;
    if (!entities.length || seenCursors.has(after) || page === 100)
      incomplete('Snapchat continuation is empty, repeats or exceeds 100 pages.');
    seenCursors.add(after);
  }
  if (parentId) await verifyParent();
  await verifyAccount();
  current();
  return {
    source: {success: true, data: {collection_kind: 'snapchat_daily_pages', data: {rows}, source_pages: pages}},
    sourcePages: pages,
    nativeAccountEvidence: {
      account_id: account,
      currency: sem.currency,
      timezone: sem.timezone,
      checks,
      ...(parentId ? {parent_campaign: {id: parentId, account_id: account, checks: parentChecks}} : {}),
    },
    assertCurrent: current,
  };
}
