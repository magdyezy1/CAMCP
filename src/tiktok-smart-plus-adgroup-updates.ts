import {assertNoMethodOverride, object} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {defineFamily} from './family-kit.js';
import {
  tiktokSearchKeywordLimit,
  tiktokSearchKeywordRejected,
  tiktokSearchKeywordReviewSet,
  tiktokSearchKeywordSet,
} from './tiktok-search-keywords.js';
import {assertTiktokSmartPlusSearchKeywords} from './tiktok-smart-plus-adgroups.js';

/**
 * Upgraded Smart+ ad group edits, per API for Business v1.3 "Update an Upgraded Smart+ Ad Group" and "Get Upgraded
 * Smart+ Ad Groups" (checked 2026-09-26): name, end time, dayparting, comment and share settings, and the custom bid.
 * Updates are incremental. A bid change on one ad group changes the bid of every ad group in the campaign, so the
 * review reads and shows them. Budgets use the Smart+ ad group budget family; targeting stays unqualified because the
 * documentation does not say whether a partial targeting_spec replaces or merges.
 *
 * R2.5 M4 (package r25-m4-search2), the keywords of a Search ad group (E6): `search_keywords` and `automated_keywords_enabled`, only for an ad
 * group of a Smart+ Search campaign of the qualified shapes (the review reads the group's campaign, `is_search_campaign`). TikTok's update
 * page (read 2026-11-20 by the lead's documentation session, impl/r25-m4-DOCS-EVIDENCE.md, section 4) says the endpoint "supports incremental
 * updates" and gives `creative_list` a full-replacement rule, but records none for `search_keywords`: whether the list an update is given
 * replaces the ad group's or is merged into it is UNVERIFIED (the page, and the keyword rows of the Smart+ Search create page, are unread). So
 * the edit is built to be right in both: the list it sends is always the complete one, every keyword the ad group has and the new ones, and a
 * list that leaves one out is refused with the complete list as `details.fix` and the call that prepares it (`details.next_call`), as
 * package r25-m4-smartedits does for an ad configuration patch: AMCP never sends part of a list that TikTok may take as the whole. The
 * consequence, stated: no keyword is removed through this edit (it would need a TikTok page that says what a list does), and a list that
 * a merging TikTok and a replacing one both store the same way verifies in both. Both keys change where the ad group can serve, so both
 * need spend_change_confirmed, as a bid does.
 */
export const tiktokSmartPlusAdgroupUpdatePath = '/v1.3/smart_plus/adgroup/update/';
const getPath = '/v1.3/smart_plus/adgroup/get/';
const campaignGetPath = '/v1.3/smart_plus/campaign/get/';
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const emoji = /\p{Extended_Pictographic}/u;
const width = (s: string) => [...s].reduce((n, c) => n + (/[぀-ヿ㐀-鿿豈-﫿가-힯]/.test(c) ? 2 : 1), 0);
const time = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const utc = (v: string) => Date.parse(v.replace(' ', 'T') + 'Z');
/** The documented bid field for each optimization goal under a custom bid. */
const bids: Record<string, string[]> = {
  conversion_bid_price: ['CONVERT', 'TRAFFIC_LANDING_PAGE_VIEW', 'INSTALL', 'IN_APP_EVENT'],
  bid_price: ['CLICK'],
};
const editable = [
  'adgroup_name',
  'schedule_end_time',
  'dayparting',
  'comment_disabled',
  'share_disabled',
  'conversion_bid_price',
  'bid_price',
  'search_keywords',
  'automated_keywords_enabled',
];
/** Edits that change when or at what price the ad group can spend, or where it can serve. */
const spending = [
  'schedule_end_time',
  'dayparting',
  'conversion_bid_price',
  'bid_price',
  'search_keywords',
  'automated_keywords_enabled',
];
/** The edits of the keywords of a Search ad group (R2.5 M4): the ones that read the group's campaign. */
const searchKeys = ['search_keywords', 'automated_keywords_enabled'];
const searchEdit = (b: JsonObject) => searchKeys.some(k => b[k] !== undefined);

export const tiktokSmartPlusAdgroupUpdateKind = (p: CompiledRequest) =>
  p.gateway === 'tiktok_native_action' && p.method === 'POST' && p.path === tiktokSmartPlusAdgroupUpdatePath;
const bidField = (b: JsonObject) => Object.keys(bids).find(k => b[k] !== undefined);

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', message, {field});
}

/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokSmartPlusAdgroupUpdate(plan: CompiledRequest, body: JsonObject): void {
  const extra = Object.keys(body).find(k => !['advertiser_id', 'adgroup_id', ...editable].includes(k));
  if (extra)
    invalid(
      extra,
      '"' +
        extra +
        '" is outside the qualified Smart+ ad group edit contract' +
        (extra === 'budget' || extra === 'budget_auto_adjust_strategy'
          ? '; change budgets through the Smart+ ad group budget family.'
          : extra === 'targeting_spec' || extra === 'targeting_optimization_mode'
            ? '; targeting edits are not qualified.'
            : extra === 'operation_status'
              ? '; pause or enable through the Smart+ status family.'
              : '.'),
    );
  if (body.advertiser_id !== undefined && String(body.advertiser_id) !== plan.accountId)
    invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  if (!numeric(body.adgroup_id))
    invalid('adgroup_id', 'adgroup_id must be the numeric ID of an Upgraded Smart+ ad group.');
  if (!editable.some(k => body[k] !== undefined))
    invalid('adgroup_name', 'Send at least one of ' + editable.join(', ') + '.');
  if (
    body.adgroup_name !== undefined &&
    (typeof body.adgroup_name !== 'string' ||
      !body.adgroup_name.trim() ||
      width(body.adgroup_name) > 512 ||
      emoji.test(body.adgroup_name))
  )
    invalid('adgroup_name', 'adgroup_name must be nonempty, at most 512 characters and without emoji.');
  if (
    body.schedule_end_time !== undefined &&
    (typeof body.schedule_end_time !== 'string' ||
      !time.test(body.schedule_end_time) ||
      !Number.isFinite(utc(body.schedule_end_time)) ||
      body.schedule_end_time >= '2038-01-01 00:00:00')
  )
    invalid('schedule_end_time', 'schedule_end_time is "YYYY-MM-DD HH:MM:SS" in UTC, before 2038-01-01 00:00:00.');
  if (body.dayparting !== undefined && (typeof body.dayparting !== 'string' || !/^[01]{336}$/.test(body.dayparting)))
    invalid('dayparting', 'dayparting is 336 characters of 0 and 1, one per half hour from Monday 00:00.');
  for (const k of ['comment_disabled', 'share_disabled'])
    if (body[k] !== undefined && typeof body[k] !== 'boolean') invalid(k, k + ' must be true or false.');
  // The keywords' shape is the create's rule, raised here with this family's code (R2.5 M4); its sentence is the create's, with its Arabic.
  if (body.search_keywords !== undefined)
    try {
      assertTiktokSmartPlusSearchKeywords(body.search_keywords);
    } catch (e) {
      if (e instanceof MirrorError && e.code === 'INVALID_TIKTOK_SMART_PLUS_ADGROUP')
        invalid(String(e.details.field), e.message);
      throw e;
    }
  if (body.automated_keywords_enabled !== undefined && typeof body.automated_keywords_enabled !== 'boolean')
    invalid('automated_keywords_enabled', 'automated_keywords_enabled must be true or false.');
  if (body.conversion_bid_price !== undefined && body.bid_price !== undefined)
    invalid('bid_price', 'Send one bid field: conversion_bid_price or bid_price, according to the optimization goal.');
  const bid = bidField(body);
  if (
    bid &&
    (typeof body[bid] !== 'number' ||
      !Number.isFinite(body[bid]) ||
      body[bid] <= 0 ||
      Math.abs((body[bid] as number) * 100 - Math.round((body[bid] as number) * 100)) > 1e-9)
  )
    invalid(bid, bid + ' must be a positive amount in the account currency with at most two decimals.');
}
export function tiktokSmartPlusAdgroupUpdateRead(plan: CompiledRequest) {
  return {
    path: getPath,
    query: {
      advertiser_id: plan.accountId,
      filtering: {adgroup_ids: [(plan.body as JsonObject).adgroup_id]},
      page_size: 100,
    },
    action: 'tiktok_smart_plus_adgroup_get',
  };
}
/** After the ad group read, a bid edit also reads the campaign's ad groups, whose bids TikTok changes with it. */
export function tiktokSmartPlusAdgroupUpdateSiblingRead(
  plan: CompiledRequest,
  read: CompiledRequest,
  data: unknown,
): CompiledRequest | undefined {
  if (
    !tiktokSmartPlusAdgroupUpdateKind(plan) ||
    !bidField(plan.body as JsonObject) ||
    read.path !== getPath ||
    !Array.isArray((read.query?.filtering as JsonObject | undefined)?.adgroup_ids)
  )
    return;
  const row =
    obj(data) && obj(data.data) && Array.isArray(data.data.list)
      ? data.data.list.find((r: JsonObject) => String(r?.adgroup_id) === (plan.body as JsonObject).adgroup_id)
      : undefined;
  if (!numeric(row?.campaign_id)) return;
  return {
    ...read,
    query: {advertiser_id: plan.accountId, filtering: {campaign_ids: [row.campaign_id]}, page_size: 100},
  };
}
/**
 * After the ad group read, an edit of its keywords also reads the ad group's campaign: its `is_search_campaign`, which TikTok fixes at create,
 * says whether the ad group has keywords to edit at all (R2.5 M4, package r25-m4-search2). The campaign is the ad group's parent, as it is in
 * the create (src/tiktok-smart-plus-adgroups.ts).
 */
export function tiktokSmartPlusAdgroupUpdateCampaignRead(
  plan: CompiledRequest,
  read: CompiledRequest,
  data: unknown,
): CompiledRequest | undefined {
  if (
    !tiktokSmartPlusAdgroupUpdateKind(plan) ||
    !searchEdit(plan.body as JsonObject) ||
    read.path !== getPath ||
    !Array.isArray((read.query?.filtering as JsonObject | undefined)?.adgroup_ids)
  )
    return;
  const row =
    obj(data) && obj(data.data) && Array.isArray(data.data.list)
      ? data.data.list.find((r: JsonObject) => String(r?.adgroup_id) === (plan.body as JsonObject).adgroup_id)
      : undefined;
  if (!numeric(row?.campaign_id)) return;
  return {
    ...read,
    path: campaignGetPath,
    action: 'tiktok_smart_plus_campaign_get',
    query: {advertiser_id: plan.accountId, filtering: {campaign_ids: [row.campaign_id]}, page_size: 100},
    stateRole: 'parent',
  };
}
/** The campaign's ad groups must all arrive on one page. */
export function validateTiktokSmartPlusAdgroupCampaignState(read: CompiledRequest, data: JsonObject): boolean {
  if (read.gateway !== 'tiktok_native_action' || read.path !== getPath) return false;
  const campaigns = (read.query?.filtering as JsonObject | undefined)?.campaign_ids;
  if (!Array.isArray(campaigns)) return false;
  const list = data.data?.list,
    total = data.data?.page_info?.total_number;
  if (
    data.code !== 0 ||
    !Array.isArray(list) ||
    list.some((r: JsonObject) => String(r?.campaign_id) !== String(campaigns[0])) ||
    (total !== undefined && total !== list.length)
  )
    throw new MirrorError('STATE_READ_FAILED', 'TikTok must return every ad group of the campaign on one page.');
  return true;
}
/**
 * The review state of an ad group read, where it needs one. A read of the campaign's ad groups keeps each one's identity and bid, sorted, so
 * unrelated changes do not count. A read of ad groups by ID keeps the rows as they were read, except that the keywords of a Search ad group
 * are a set (R2.5 M4, package r25-m4-search2): TikTok states no order for them and adds a review status to each (`audit_status`), which moves
 * by itself, so neither is a change a review is refused for between its prepare and its execute. Everything else of a keyword stays, `reject_info`
 * included, so a rejection between the two is a change (tiktokSearchKeywordReviewSet; S2-3 and S3-3, the lead's review of 27528f0e). A read
 * with no keywords keeps the generic state.
 */
export function tiktokSmartPlusAdgroupCampaignState(read: CompiledRequest, d: JsonObject): JsonObject | undefined {
  if (read.gateway !== 'tiktok_native_action' || read.path !== getPath) return;
  const campaigns = (read.query?.filtering as JsonObject | undefined)?.campaign_ids;
  if (!Array.isArray(campaigns)) {
    const list = d.data?.list;
    return Array.isArray((read.query?.filtering as JsonObject | undefined)?.adgroup_ids) &&
      Array.isArray(list) &&
      list.some((r: JsonObject) => Array.isArray(r?.search_keywords))
      ? {
          data: {
            list: list.map((r: JsonObject) =>
              Array.isArray(r?.search_keywords)
                ? {...r, search_keywords: tiktokSearchKeywordReviewSet(r.search_keywords)}
                : r,
            ),
          },
        }
      : undefined;
  }
  if (obj(d.data) && obj(d.data.campaign_adgroups)) return {data: {campaign_adgroups: d.data.campaign_adgroups}};
  if (!Array.isArray(d.data?.list)) return;
  const adgroups = d.data.list
    .map((r: JsonObject) => ({
      adgroup_id: String(r?.adgroup_id),
      adgroup_name: r?.adgroup_name ?? null,
      bid_type: r?.bid_type ?? null,
      optimization_goal: r?.optimization_goal ?? null,
      conversion_bid_price: r?.conversion_bid_price ?? null,
      bid_price: r?.bid_price ?? null,
    }))
    .sort((a: JsonObject, b: JsonObject) => (a.adgroup_id < b.adgroup_id ? -1 : a.adgroup_id > b.adgroup_id ? 1 : 0));
  return {data: {campaign_adgroups: {campaign_id: String(campaigns[0]), adgroups}}};
}
const rows = (state: unknown[]) =>
  state.flatMap(s => (obj(s) && obj(s.data) && Array.isArray(s.data.list) ? s.data.list : [])) as JsonObject[];
const campaignOf = (state: unknown[]) =>
  state
    .map(s => (obj(s) && obj(s.data) && obj(s.data.campaign_adgroups) ? s.data.campaign_adgroups : undefined))
    .find(Boolean) as JsonObject | undefined;
const targetOf = (plan: CompiledRequest, state: unknown[]) =>
  rows(state).find(r => String(r?.adgroup_id) === (plan.body as JsonObject).adgroup_id);
/** A keyword is its text with its match type: the pair a list holds at most once. */
const pairOf = (k: JsonObject) => JSON.stringify([k.keyword, k.match_type]);
/** The fields of a keyword that are its own or TikTok's record of its review, which a review never reads as a setting that a list would lose. */
const tiktokSearchKeywordOwnFields = ['keyword', 'match_type', 'audit_status', 'reject_info'];
/** A keyword by what a list says of it, without the record of its review (a reason of TikTok's is provider text and stays out of every message). */
const pairShown = (k: JsonObject) => ({keyword: k.keyword, match_type: k.match_type});
const keywordsOf = (g: JsonObject) => (Array.isArray(g.search_keywords) ? (g.search_keywords as JsonObject[]) : []);
/**
 * The refusal of a list that leaves out keywords the ad group has, with the complete list in `details.fix` and the call that prepares it
 * (`details.next_call`), the way package r25-m4-smartedits hands back a merged ad configuration: `fix` is a list of `{path, value}` JSON pointers
 * into the PAYLOAD of this edit (`fix_base` says so), and the call carries none of the options of this one (it has no connection: its
 * `meaning` says to add the connection_id). Nothing partial is ever sent, and nothing was sent.
 */
function handBack(plan: CompiledRequest, left: number, merged: JsonObject[]): never {
  const {advertiser_id: _advertiser, ...rest} = plan.body as JsonObject;
  void _advertiser;
  throw new MirrorError(
    'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE',
    'Ad group ' +
      rest.adgroup_id +
      ' has ' +
      left +
      ' keyword(s) this list leaves out, and TikTok may take a list as the whole one, so AMCP never sends part of one. Send the complete list (details.fix) as search_keywords; details.next_call is that call. Nothing was sent.',
    {
      field: 'search_keywords',
      fix_base: 'payload',
      fix: [{path: '/search_keywords', value: merged}],
      next_call: {
        tool: 'amcp_write',
        arguments: {
          action: 'prepare',
          gateway: plan.gateway,
          arguments: {
            action: 'tiktok_smart_plus_adgroup_update',
            account_id: plan.accountId,
            payload: {...rest, search_keywords: merged},
          },
        },
        meaning:
          'The same edit with the complete keyword list, as an amcp_write prepare. It carries none of the options of this call: add its connection_id and any other it had. details.fix holds the same change as a JSON pointer into this edit’s payload (details.fix_base is "payload").',
      },
    },
  );
}
/**
 * The keyword rules of an edit, against the ad group and campaign the review read (R2.5 M4, package r25-m4-search2): the ad group is in a Smart+
 * Search campaign of the qualified shapes (website conversions with a website destination, or lead generation, and no catalog), and a list
 * of keywords holds every keyword the ad group has: one that leaves some out is handed back whole (`handBack`), and one the ad group could not
 * hold with them is refused. A keyword with settings of its own besides its match type (a keyword bid, set where AMCP cannot) cannot be
 * restated by a list of keywords and match types, so the edit of a list that holds one is refused: a replacing TikTok would drop the setting.
 */
function searchPrerequisites(plan: CompiledRequest, g: JsonObject, values: unknown[], reads: CompiledRequest[]): void {
  const b = plan.body as JsonObject,
    id = b.adgroup_id,
    key = b.search_keywords !== undefined ? 'search_keywords' : 'automated_keywords_enabled',
    at = reads.findIndex(r => r.path === campaignGetPath);
  // The campaign row is the one without an ad group ID: an ad group's row names its campaign too.
  const campaign =
    at < 0
      ? undefined
      : rows([values[at]]).find(
          r => !Object.hasOwn(r, 'adgroup_id') && String(r.campaign_id) === String(g.campaign_id),
        );
  if (!campaign) throw new MirrorError('STATE_READ_FAILED', 'The campaign of ad group ' + id + ' was not read.');
  if (
    campaign.is_search_campaign !== true ||
    campaign.catalog_enabled === true ||
    !(
      campaign.objective_type === 'LEAD_GENERATION' ||
      (campaign.objective_type === 'WEB_CONVERSIONS' && campaign.sales_destination === 'WEBSITE')
    )
  )
    invalid(
      key,
      'Ad group ' +
        id +
        ' is not in a Smart+ Search campaign of the qualified shapes (website conversions with a website destination, or lead generation), so its keywords are not edited here.',
    );
  if (b.search_keywords === undefined) return;
  const current = keywordsOf(g),
    sent = b.search_keywords as JsonObject[],
    sentPairs = new Set(sent.map(pairOf)),
    held = new Set(current.map(pairOf)),
    left = current.filter(k => !sentPairs.has(pairOf(k)));
  // TikTok's own record of a keyword is no setting of it: `audit_status` (volatile, so already out of the state) and `reject_info` (S2-3: the
  // Smart+ keyword item is keyword, match_type, audit_status and reject_info, and the remedy of a rejected keyword is this very edit, P14, P15, P17).
  // Any other field is fail closed, since a list of keywords and match types cannot restate it.
  const own = current.find(k => Object.keys(k).some(f => !tiktokSearchKeywordOwnFields.includes(f)));
  if (own)
    invalid(
      'search_keywords',
      'Ad group ' +
        id +
        ' has a keyword that carries a setting this edit does not know (TikTok documents none for a Smart+ keyword besides its review status), which a list of keywords and match types cannot restate, so this edit would lose it. Edit its keywords where the setting was made.',
    );
  if (!left.length) return;
  const merged = [
    ...current.map(k => ({keyword: k.keyword, match_type: k.match_type})),
    ...sent.filter(k => !held.has(pairOf(k))),
  ];
  if (merged.length > tiktokSearchKeywordLimit)
    invalid(
      'search_keywords',
      'Ad group ' +
        id +
        ' has ' +
        left.length +
        ' keyword(s) this list leaves out, and with them the list would exceed the 1,000 keywords TikTok allows, so no complete list can be sent.',
    );
  handBack(plan, left.length, merged);
}
/** Checked against the state read before review and again before execution. */
export function tiktokSmartPlusAdgroupUpdatePrerequisites(
  plan: CompiledRequest,
  values: unknown[],
  reads: CompiledRequest[] = [],
): void {
  if (!tiktokSmartPlusAdgroupUpdateKind(plan)) return;
  const b = plan.body as JsonObject,
    g = targetOf(plan, values),
    id = b.adgroup_id;
  if (!g)
    throw new MirrorError(
      'STATE_TARGET_MISMATCH',
      'Smart+ ad group ' + id + ' was not returned for the selected advertiser.',
      {adgroup_id: id},
    );
  if (searchEdit(b)) searchPrerequisites(plan, g, values, reads);
  const bid = bidField(b);
  if (bid) {
    if (g.bid_type !== 'BID_TYPE_CUSTOM' || !bids[bid]!.includes(g.optimization_goal))
      invalid(
        bid,
        'Ad group ' +
          id +
          ' has ' +
          (g.bid_type ?? 'no bid type') +
          ' with optimization goal ' +
          (g.optimization_goal ?? 'none') +
          '; ' +
          bid +
          ' applies only to a custom bid with ' +
          bids[bid]!.join(', ') +
          '.',
      );
    if (
      g.budget_mode !== 'BUDGET_MODE_INFINITE' &&
      typeof g.budget === 'number' &&
      g.budget > 0 &&
      (b[bid] as number) >= g.budget
    )
      invalid(bid, bid + ' must be lower than the ad group budget (' + g.budget + ').');
    const campaign = campaignOf(values);
    if (
      !campaign ||
      campaign.campaign_id !== String(g.campaign_id) ||
      !(campaign.adgroups as JsonObject[]).some(r => r.adgroup_id === id)
    )
      throw new MirrorError('STATE_READ_FAILED', 'The ad groups of campaign ' + g.campaign_id + ' were not read.');
  }
  if (b.schedule_end_time !== undefined) {
    if (g.schedule_type !== 'SCHEDULE_START_END')
      invalid(
        'schedule_end_time',
        'Ad group ' +
          id +
          ' runs continuously (' +
          (g.schedule_type ?? 'no schedule type') +
          '); an end time applies only to SCHEDULE_START_END.',
      );
    const end = utc(b.schedule_end_time as string);
    if (end <= Date.now() || (typeof g.schedule_start_time === 'string' && end <= utc(g.schedule_start_time)))
      invalid(
        'schedule_end_time',
        'schedule_end_time must be in the future and after the start time' +
          (typeof g.schedule_start_time === 'string' ? ' (' + g.schedule_start_time + ')' : '') +
          '.',
      );
  }
}
const keywordsEffect =
  'Changes the keywords this Search ad group can serve on, or its automated keywords, so where it can show. TikTok sends every keyword of the ad group back to review and AMCP does not wait for the review; if TikTok rejects all of them, the campaign does not deliver.';
/** Bid, end time, dayparting and keyword edits change what the ad group can spend, or where it can serve. */
export const tiktokSmartPlusAdgroupUpdateServing = (plan: CompiledRequest) =>
  tiktokSmartPlusAdgroupUpdateKind(plan) && spending.some(k => (plan.body as JsonObject)[k] !== undefined);
export function tiktokSmartPlusAdgroupUpdateImpact(plan: CompiledRequest, state: unknown[]): JsonObject {
  const b = plan.body as JsonObject,
    g = targetOf(plan, state) ?? {},
    changes: JsonObject = {},
    bid = bidField(b);
  for (const k of editable) if (b[k] !== undefined) changes[k] = {before: g[k] ?? null, after: b[k]};
  // A keyword list is shown as what changes in it, not as two whole lists: what is added, what is left out (nothing: an edit never leaves one
  // out, see searchPrerequisites) and the counts (R2.5 M4, package r25-m4-search2).
  if (b.search_keywords !== undefined) {
    const current = keywordsOf(g),
      sent = b.search_keywords as JsonObject[],
      held = new Set(current.map(pairOf)),
      sentPairs = new Set(sent.map(pairOf));
    changes.search_keywords = {
      before_count: current.length,
      after_count: sent.length,
      added: sent.filter(k => !held.has(pairOf(k))),
      removed: current.filter(k => !sentPairs.has(pairOf(k))).map(pairShown),
      // The keywords TikTok rejected, by their pairs: the record of a rejection (its reasons) is provider text and stays out of the review.
      rejected: current.filter(tiktokSearchKeywordRejected).map(pairShown),
    };
  }
  const siblings = bid
    ? ((campaignOf(state)?.adgroups as JsonObject[] | undefined) ?? [])
        .filter(r => r.adgroup_id !== b.adgroup_id)
        .map(r => ({adgroup_id: r.adgroup_id, adgroup_name: r.adgroup_name, [bid]: {before: r[bid], after: b[bid]}}))
    : [];
  const serving = spending.some(k => b[k] !== undefined);
  return {
    provider: 'tiktok',
    scope: 'smart_plus_adgroup_edits',
    may_affect_serving: serving && g.operation_status === 'ENABLE',
    effect: serving
      ? bid && siblings.length
        ? 'Changes the bid of this ad group and, as TikTok documents, of ' +
          siblings.length +
          ' other ad group(s) in the campaign.' +
          (searchEdit(b) ? ' ' + keywordsEffect : '')
        : searchEdit(b) && !bid && b.schedule_end_time === undefined && b.dayparting === undefined
          ? keywordsEffect
          : 'Changes when or at what price the ad group can spend.' + (searchEdit(b) ? ' ' + keywordsEffect : '')
      : 'Changes the name or comment and share settings; delivery is unchanged.',
    ...(b.automated_keywords_enabled === true
      ? {
          // S4-1: the manual Search page lists an allowlist for automated keywords; the Smart+ pages say none, so TikTok's answer decides.
          automated_keywords:
            'TikTok’s manual Search pages list automated keywords as allowlisted and its Smart+ pages do not say so (the option is off by default and recommended): TikTok’s answer decides, and an advertiser it refuses gets code 40118 with nothing changed.',
        }
      : {}),
    adgroup: {
      adgroup_id: b.adgroup_id,
      campaign_id: g.campaign_id ?? null,
      operation_status: g.operation_status ?? null,
      bid_type: g.bid_type ?? null,
      optimization_goal: g.optimization_goal ?? null,
    },
    changes,
    ...(bid ? {campaign_bid_changes: siblings} : {}),
    source: 'https://business-api.tiktok.com/portal/docs/update-an-upgraded-smart-ad-group/v1.3',
  };
}
export function tiktokSmartPlusAdgroupUpdateVerification(plan: CompiledRequest) {
  const b = plan.body as JsonObject,
    expected: JsonObject = {adgroup_id: b.adgroup_id};
  for (const k of editable) if (b[k] !== undefined) expected[k] = b[k];
  // The keywords are a set, read back as one without TikTok's review status of each (src/tiktok-search-keywords.ts).
  if (b.search_keywords !== undefined)
    expected.search_keywords = tiktokSearchKeywordSet(b.search_keywords as unknown[]);
  return [
    {
      path: getPath,
      query: {advertiser_id: plan.accountId, filtering: {adgroup_ids: [b.adgroup_id]}, page_size: 100},
      expected,
      id: b.adgroup_id as string,
    },
  ];
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokSmartPlusAdgroupUpdateFamily: ReviewedFamily = defineFamily({
  name: 'tiktok_smart_plus_adgroup_edits',
  files: ['src/tiktok-smart-plus-adgroup-updates.ts', ['tests/tiktok-smart-plus-adgroup-updates.test.mjs']],
  kind: tiktokSmartPlusAdgroupUpdateKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertTiktokSmartPlusAdgroupUpdate(plan, object(plan.body));
  },
  snapshots: (plan, stateRead) => {
    const r = tiktokSmartPlusAdgroupUpdateRead(plan),
      read = stateRead(r.path, r.query);
    read.action = r.action;
    return [read];
  },
  followUps: (plan, read, data) => {
    const sibling = tiktokSmartPlusAdgroupUpdateSiblingRead(plan, read, data),
      campaign = tiktokSmartPlusAdgroupUpdateCampaignRead(plan, read, data);
    return [sibling, campaign].filter((r): r is CompiledRequest => !!r);
  },
  prerequisites: (plan, state, reads) => tiktokSmartPlusAdgroupUpdatePrerequisites(plan, state, reads),
  impact: tiktokSmartPlusAdgroupUpdateImpact,
  verification: (plan, result, before, verificationRead) =>
    tiktokSmartPlusAdgroupUpdateVerification(plan).map(v => ({
      ...v,
      read: {...verificationRead(v.path, v.query), action: 'tiktok_smart_plus_adgroup_get'},
    })),
  spendConfirmation: {
    needed: plan => !!tiktokSmartPlusAdgroupUpdateServing(plan),
    message:
      'Bid, end time, dayparting and keyword edits change when, at what price and where the ad group spends, and a bid edit also changes the other ad groups of the campaign. Review them, then provide spend_change_confirmed=true.',
  },
});
