import {bad, fingerprint, obj, type ToolCall} from './workspace-core.js';
import {collectionCheckpoint} from './report-collection-budget.js';
import {zonedMidnight} from './workflows.js';
import type {Actor, JsonObject} from './types.js';
import {snapchatScope} from './provider-grants.js';
import type {Store} from './store.js';
import {storedLogin} from './connection-authority.js';
import {MirrorError, nestedError} from './errors.js';
import {snapchatContinuation} from './snapchat-paging.js';
import {snapchatUnconfirmedEmptyWarning} from './snapchat-report-finalization.js';
import type {GuidedCollectionState} from './report-source.js';

const gateway = 'snapchat_native_action';
export const snapchatReportId = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const success = (v: unknown) => typeof v === 'string' && v.toUpperCase() === 'SUCCESS';
const incomplete = (message: string): never => bad(message, 'REPORT_INCOMPLETE');
const shape = (message: string): never => bad(message, 'REPORT_SHAPE_CHANGED');
/**
 * The timestamps of a stats answer that `instant` reads. A refusal names the one that failed, from this closed set and never
 * from the answer, so its remedy can say which (r12-fix item 3, V2-RPT-05; error 1 of the live checks of 2026-11-16).
 */
type TimestampField = 'start_time' | 'end_time' | 'finalized_data_end_time' | 'conversion_data_processed_end_time';
function instant(v: unknown, field: TimestampField): number {
  if (
    typeof v !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v.slice(0, 10)).toISOString().slice(0, 10) !== v.slice(0, 10)
  )
    return bad('Snapchat returned an invalid native report timestamp.', 'REPORT_DATE_MISMATCH', {
      timestamp_field: field,
    });
  return Date.parse(v);
}
export function snapchatDailyRange(sem: JsonObject, allowUndeclared = false) {
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
  if (end < start || end - start >= 31 * 86400000 || sem.date_to >= today) {
    // The Overview allows an undeclared window, so its refusal does not speak of a declaration (F-L7-13).
    if (allowUndeclared) bad('Snapchat evidence requires 1–31 closed days.');
    bad('Snapchat guided evidence requires 1–31 closed days and an explicit complete-window declaration.');
  }
  // R25 M0 (owner 2026-11-15, error 4 of the live checks, which TikTok's capture shares): a closed window that is not
  // declared so is refused with the key to set. The window is checked first: declaring complete a window that is not
  // closed would not be accepted.
  if (!allowUndeclared && sem.complete !== true)
    bad('Set semantics.complete to true for a closed window of 1–31 days in the account timezone.');
  const days: {date: string; start: number; end: number}[] = [];
  for (let at = start; at <= end; at += 86400000) {
    const date = new Date(at).toISOString().slice(0, 10),
      next = new Date(at + 86400000).toISOString().slice(0, 10),
      from = zonedMidnight(date, sem.timezone, true),
      through = zonedMidnight(next, sem.timezone, true);
    if (from % 3600000 || through % 3600000)
      throw new MirrorError(
        'UNSUPPORTED_TIMEZONE_OFFSET',
        'Snapchat stats require whole-hour boundaries; the account timezone {zone} has a fractional-hour offset.',
        {},
        400,
        false,
        {zone: sem.timezone},
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
export {metadata as assertSnapchatReportMetadata};
export function snapchatNextCursor(data: JsonObject, path: string, query: JsonObject) {
  // The check itself is shared with the previews tool (src/snapchat-paging.ts); the refusals are this reader's.
  const next = snapchatContinuation(data, path, query);
  if (next.refused === 'metadata') incomplete('Snapchat returned unknown report paging metadata.');
  if (next.refused === 'link')
    incomplete('Snapchat continuation changed the account, report settings or authorized route.');
  return next.token;
}

/**
 * The attribution windows a guided Snapchat capture can ask for (the closed sets of the guided presets,
 * src/snapchat-guided-reports.ts). A refusal names a window only when it is one of these, so it never echoes text the
 * provider chose and every value it names is one the agent can send back.
 */
const swipeWindows: readonly unknown[] = ['1_DAY', '7_DAY', '28_DAY'];
const viewWindows: readonly unknown[] = ['none', '1_HOUR', '3_HOUR', '6_HOUR', '1_DAY', '7_DAY'];
/**
 * Whether a guided Snapchat preset takes this pair of attribution windows: each in its closed set, and a seven-day view
 * window with at least a seven-day swipe window (the rule of src/snapchat-guided-reports.ts presetRequest, which asks this).
 */
export function snapchatWindowsTaken(swipe: unknown, view: unknown): boolean {
  return swipeWindows.includes(swipe) && viewWindows.includes(view) && !(view === '7_DAY' && swipe === '1_DAY');
}
/**
 * The refusal of a stats read that used other attribution windows than the request (R25 M0, owner 2026-11-15, error 13 of
 * the live checks): it names the swipe-up and view windows Snapchat used and the ones asked for, so the agent can ask for
 * the pair Snapchat used. A pair the presets do not take, a window outside the closed sets, or none keeps the earlier
 * sentence and names no value (review S4-3: the advice must be a request the presets accept).
 */
function attributionRefusal(stat: JsonObject, query: JsonObject): never {
  const returned = {swipe: stat.swipe_up_attribution_window, view: stat.view_attribution_window},
    requested = {swipe: query.swipe_up_attribution_window, view: query.view_attribution_window};
  if (snapchatWindowsTaken(returned.swipe, returned.view) && snapchatWindowsTaken(requested.swipe, requested.view))
    throw new MirrorError(
      'REPORT_SEMANTICS_MISMATCH',
      'Snapchat reported a swipe-up window of {swipe} and a view window of {view}, not the {requestedSwipe} and {requestedView} requested. Capture again with swipe_up_attribution_window {swipe} and view_attribution_window {view} to match it.',
      {
        requested: {swipe_up_attribution_window: requested.swipe, view_attribution_window: requested.view},
        returned: {swipe_up_attribution_window: returned.swipe, view_attribution_window: returned.view},
      },
      400,
      false,
      {swipe: returned.swipe, view: returned.view, requestedSwipe: requested.swipe, requestedView: requested.view},
    );
  return bad('Snapchat returned different attribution settings.', 'REPORT_SEMANTICS_MISMATCH');
}

/** What the evidence keeps of a parent campaign: its name and its objective (the v2 value when the campaign has one). */
export function campaignFacts(campaign: JsonObject): JsonObject {
  const objective = campaign.objective_v2_properties?.objective_v2_type ?? campaign.objective;
  return {
    ...(typeof campaign.name === 'string' && campaign.name.length <= 1000 ? {name: campaign.name} : {}),
    ...(typeof objective === 'string' ? {objective} : {}),
  };
}

/** Bounded daily account breakdowns. Per-page finalization is not an atomic account snapshot. */
export async function collectSnapchatEvidence(
  store: Store,
  call: ToolCall,
  actor: Actor,
  args: JsonObject,
  sem: JsonObject,
  context: {
    allowPartial?: true;
    overviewV4?: true;
    /**
     * The campaigns of the account that a complete population read of this job proved (V2-RPT-07). A parent campaign in it
     * is known to be in the account, so its stats are read without a read of the account or of the campaign around
     * them; the population collector brackets the whole job with the account reads. Without it every check is kept.
     */
    population?: ReadonlyMap<string, JsonObject>;
  } = {},
) {
  const account = args.account_id,
    connection = store.resolveConnection(actor, gateway, account, args.connection_id),
    authorization = fingerprint({
      login: storedLogin(store, connection),
      scopes: [...connection.scopes].sort(),
    }),
    days = snapchatDailyRange(sem, context.allowPartial === true),
    from = days[0]!.start,
    through = days.at(-1)!.end,
    level = args.query.breakdown,
    nativeLeads = args.query.fields === 'spend,impressions,swipes,native_leads',
    parentId = ['adsquad', 'ad'].includes(level) ? args.path_params?.campaign_id : undefined,
    path = parentId ? '/v1/campaigns/' + parentId + '/stats' : '/v1/adaccounts/' + account + '/stats',
    proven = parentId ? context.population?.get(parentId) : undefined;
  const current = () => {
    store.assertActorActive(actor);
    const c = store.resolveConnection(actor, gateway, account, connection.id);
    if (!c.scopes.includes(snapchatScope))
      bad('This login requires Snapchat Marketing API permission.', 'INSUFFICIENT_SCOPE');
    if (fingerprint({login: storedLogin(store, c), scopes: [...c.scopes].sort()}) !== authorization)
      bad('The Snapchat login or permissions changed. Capture a new report.', 'CONNECTION_AUTHORITY_CHANGED');
    collectionCheckpoint();
  };
  const read = async (request: JsonObject) => {
    current();
    const result = await call(gateway, request, actor);
    current();
    if (result.success !== true)
      throw nestedError(result, {code: 'REPORT_FAILED', message: 'Snapchat report read failed.'});
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
  let parentMetadata: JsonObject = {};
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
      query = context.overviewV4 ? {limit: 100, read_deleted_entities: true} : {limit: 100, sort: 'created_at-desc'},
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
        next = snapchatNextCursor(data, listPath, query);
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
      ...(context.overviewV4 ? {query: {read_deleted_entities: true}} : {}),
      aggregate_pages: false,
      dry_run: false,
    });
    const rows = parentRows(data, 1);
    if (rows.length !== 1 || rows[0]!.id !== parentId || snapchatNextCursor(data, '/v1/campaigns/' + parentId, {}))
      bad('Snapchat did not confirm the exact parent campaign.', 'REPORT_ACCOUNT_MISMATCH');
    parentMetadata = campaignFacts(rows[0]!);
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
      snapchatNextCursor(data, path, {}) ||
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
  if (proven) parentMetadata = campaignFacts(proven);
  else {
    await verifyAccount();
    if (parentId) {
      await establishParent();
      await verifyParent();
    }
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
      instant(stat.start_time, 'start_time') !== from ||
      instant(stat.end_time, 'end_time') !== through
    )
      bad('Snapchat returned a different reporting window or grain.', 'REPORT_DATE_MISMATCH');
    if (
      !nativeLeads &&
      ['swipe_up_attribution_window', 'view_attribution_window'].some(key => stat[key] !== args.query[key])
    )
      attributionRefusal(stat, args.query);
    for (const key of nativeLeads ? [] : ['action_report_time', 'conversion_source_types'])
      if (stat[key] !== undefined && stat[key] !== args.query[key])
        bad('Snapchat returned a different conversion definition.', 'REPORT_SEMANTICS_MISMATCH');
    // An answer with no entities (a campaign that did not deliver in the window) has nothing to finalize, and Snapchat leaves
    // both finalization times out of it (r12-fix item 1, V2-RPT-07; O-4 of the live checks of 2026-11-16). Such an answer may
    // omit them, and counts as no rows for this campaign. Only an absent time is accepted, and only there: a time it does
    // carry is checked as ever, and an answer with entities needs both, with an offset.
    const none =
      obj(stat.breakdown_stats) &&
      Object.keys(stat.breakdown_stats).length === 1 &&
      Array.isArray(stat.breakdown_stats[level]) &&
      stat.breakdown_stats[level].length === 0;
    const notFinalized = (time: unknown, field: TimestampField) =>
      !(none && time === undefined) && instant(time, field) < through;
    if (notFinalized(stat.finalized_data_end_time, 'finalized_data_end_time'))
      incomplete('Snapchat has not finalized non-conversion metrics through the selected window.');
    if (!nativeLeads && notFinalized(stat.conversion_data_processed_end_time, 'conversion_data_processed_end_time'))
      incomplete('Snapchat has not finalized conversion-time data through the selected window.');
    // An answer with no entities that does not state, by itself, the times that "no rows" needs (both, for the presets that read
    // conversions) is marked: it is "no rows" only when a finalization time of the same read covers the end of its window (r12-fix,
    // the lead's ruling on item 1, decision 2, 2026-11-16: unknown stays unknown, never zero). The read decides that, below.
    const unstated =
      none &&
      (stat.finalized_data_end_time === undefined ||
        (!nativeLeads && stat.conversion_data_processed_end_time === undefined));
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
        instant(entity.start_time, 'start_time') !== from ||
        instant(entity.end_time, 'end_time') !== through ||
        !Array.isArray(entity.timeseries) ||
        entity.timeseries.length !== days.length
      )
        incomplete('Snapchat did not return the complete requested daily window for an entity.');
      const seenDays = new Set<string>();
      for (const row of entity.timeseries) {
        if (!obj(row) || !obj(row.stats)) shape('Snapchat returned a malformed daily metric row.');
        metadata(row);
        metadata(row.stats);
        const day = days.find(
          d => d.start === instant(row.start_time, 'start_time') && d.end === instant(row.end_time, 'end_time'),
        );
        if (!day) bad('Snapchat returned a different native day boundary.', 'REPORT_DATE_MISMATCH');
        if (seenDays.has(day.date)) bad('Snapchat repeated a native entity/day row.', 'REPORT_DUPLICATE_ROWS');
        seenDays.add(day.date);
        for (const key of ['spend', 'impressions', 'swipes', nativeLeads ? 'native_leads' : 'conversion_purchases']) {
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
      // The page keeps the times Snapchat gave; an answer with no entities may have given neither.
      ...(stat.finalized_data_end_time !== undefined ? {finalized_data_end_time: stat.finalized_data_end_time} : {}),
      ...(stat.conversion_data_processed_end_time !== undefined
        ? {conversion_data_processed_end_time: stat.conversion_data_processed_end_time}
        : {}),
      ...(unstated ? {finalization_stated: false} : {}),
    });
    after = snapchatNextCursor(data, path, args.query);
    if (after === undefined) break;
    if (!entities.length || seenCursors.has(after) || page === 100)
      incomplete('Snapchat continuation is empty, repeats or exceeds 100 pages.');
    seenCursors.add(after);
  }
  if (!proven) {
    if (parentId) await verifyParent();
    await verifyAccount();
  }
  current();
  // The all-campaign read of the Overview (a parent of its proven population) judges a marked page against the finalization times of
  // the whole collection (src/snapchat-report-finalization.ts). Any other read is one answer, with no other to be judged by: the
  // capture refuses it, and the Overview keeps it as a source that is partial, with the reason. Nothing is saved as zero.
  const collection: GuidedCollectionState | undefined =
    !proven && pages.some(page => page.finalization_stated === false)
      ? {complete: false, declared: null, returned: rows.length, warnings: [snapchatUnconfirmedEmptyWarning]}
      : undefined;
  if (collection && !context.allowPartial)
    incomplete(
      'Snapchat returned no rows and did not say that its data is final through the end of the window, so AMCP cannot tell no delivery from data Snapchat has not processed yet. Capture it again once Snapchat has finalized the window, or choose an earlier window.',
    );
  return {
    source: {success: true, data: {collection_kind: 'snapchat_daily_pages', data: {rows}, source_pages: pages}},
    sourcePages: pages,
    ...(collection ? {collection} : {}),
    nativeAccountEvidence: {
      account_id: account,
      currency: sem.currency,
      timezone: sem.timezone,
      checks,
      ...(parentId
        ? {parent_campaign: {id: parentId, account_id: account, ...parentMetadata, checks: parentChecks}}
        : {}),
    },
    assertCurrent: current,
  };
}
