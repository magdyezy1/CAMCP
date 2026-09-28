import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Upgraded Smart+ ad group edits, per API for Business v1.3 "Update an Upgraded Smart+ Ad Group" and "Get Upgraded
 * Smart+ Ad Groups" (checked 2026-09-26): name, end time, dayparting, comment and share settings, and the custom bid.
 * Updates are incremental. A bid change on one ad group changes the bid of every ad group in the campaign, so the
 * review reads and shows them. Budgets use the Smart+ ad group budget family; targeting stays unqualified because the
 * documentation does not say whether a partial targeting_spec replaces or merges.
 */
export const tiktokSmartPlusAdgroupUpdatePath = '/v1.3/smart_plus/adgroup/update/';
const getPath = '/v1.3/smart_plus/adgroup/get/';
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
];
/** Edits that change when or at what price the ad group can spend. */
const spending = ['schedule_end_time', 'dayparting', 'conversion_bid_price', 'bid_price'];

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
/** The campaign read's review state: each ad group's identity and bid, sorted, so unrelated changes do not count. */
export function tiktokSmartPlusAdgroupCampaignState(read: CompiledRequest, d: JsonObject): JsonObject | undefined {
  if (read.gateway !== 'tiktok_native_action' || read.path !== getPath) return;
  const campaigns = (read.query?.filtering as JsonObject | undefined)?.campaign_ids;
  if (!Array.isArray(campaigns)) return;
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
/** Checked against the state read before review and again before execution. */
export function tiktokSmartPlusAdgroupUpdatePrerequisites(plan: CompiledRequest, values: unknown[]): void {
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
/** Bid, end time and dayparting edits change what the ad group can spend. */
export const tiktokSmartPlusAdgroupUpdateServing = (plan: CompiledRequest) =>
  tiktokSmartPlusAdgroupUpdateKind(plan) && spending.some(k => (plan.body as JsonObject)[k] !== undefined);
export function tiktokSmartPlusAdgroupUpdateImpact(plan: CompiledRequest, state: unknown[]): JsonObject {
  const b = plan.body as JsonObject,
    g = targetOf(plan, state) ?? {},
    changes: JsonObject = {},
    bid = bidField(b);
  for (const k of editable) if (b[k] !== undefined) changes[k] = {before: g[k] ?? null, after: b[k]};
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
          ' other ad group(s) in the campaign.'
        : 'Changes when or at what price the ad group can spend.'
      : 'Changes the name or comment and share settings; delivery is unchanged.',
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
  return [
    {
      path: getPath,
      query: {advertiser_id: plan.accountId, filtering: {adgroup_ids: [b.adgroup_id]}, page_size: 100},
      expected,
      id: b.adgroup_id as string,
    },
  ];
}
