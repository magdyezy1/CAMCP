import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Paused parents cover their new children on Snapchat, Meta and TikTok (the owner's decision of 2026-09-29, after
 * Google's item 6 in google-paused-parents.ts). Each platform's child create already reads its parent in the review
 * (write-snapshots.ts): Snapchat the campaign or ad squad in the path, Meta the campaign_id or adset_id, TikTok the
 * campaign or ad group by ID. A child may start active when that read shows the parent paused: nothing under a
 * paused parent serves, and enabling the parent is its own reviewed activation. An ad whose ad squad, ad set or ad
 * group serves is also covered by a paused campaign: only then does the review read that campaign as well, named by
 * the parent's own record. Under serving parents, or ones the review could not read, the child still starts paused.
 * The check runs on the state read at prepare and again at execute, so a parent enabled in between stops the write.
 * Campaigns always start paused.
 */
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const safeId = (v: unknown) => (typeof v === 'string' || typeof v === 'number') && /^[\w-]{1,64}$/.test(String(v));
interface Level {
  /** What the refusal calls the child and its parent. */
  child: string;
  parent: string;
  /** The status field, its serving value, and the parents' paused value. */
  field: string;
  active: string;
  paused: string;
  statuses: (body: JsonObject) => unknown[];
  /** The parent's record in the review's state, or in the parent read's own result. */
  parentRow: (body: JsonObject, states: unknown[]) => JsonObject | undefined;
  /** For an ad: the campaign above its parent, the read that returns it, and its record in the state. */
  campaign?: {
    id: (parent: JsonObject) => unknown;
    read: (parentRead: CompiledRequest, id: string) => CompiledRequest;
    row: (states: unknown[], id: unknown) => JsonObject | undefined;
  };
}
/** Snapchat wraps each record: {campaigns: [{sub_request_status, campaign}]}. */
const snapRow = (states: unknown[], kind: string, singular: string, id?: unknown): JsonObject | undefined =>
  states
    .flatMap(s => (object(s) && Array.isArray(s[kind]) ? s[kind] : []))
    .map(r => (object(r) && object(r[singular]) ? r[singular] : r))
    .find((r): r is JsonObject => object(r) && (id === undefined || String(r.id) === String(id)));
/** A TikTok campaign or ad group record; an ad group also names its campaign_id, so a campaign is one without an
 * adgroup_id. */
const tiktokRow = (states: unknown[], key: 'campaign_id' | 'adgroup_id', id: unknown): JsonObject | undefined =>
  states
    .flatMap(s => (object(s) && object(s.data) && Array.isArray(s.data.list) ? s.data.list : []))
    .find(
      (r): r is JsonObject =>
        object(r) && String(r[key]) === String(id) && (key === 'adgroup_id' || r.adgroup_id === undefined),
    );
const metaRow = (states: unknown[], id: unknown): JsonObject | undefined =>
  states.find((s): s is JsonObject => object(s) && String(s.id) === String(id));
const statusesOf = (rows: unknown, field: string) =>
  Array.isArray(rows) ? rows.map(r => (object(r) ? r[field] : undefined)) : [];
function levelOf(plan: CompiledRequest): Level | undefined {
  if (plan.method !== 'POST') return undefined;
  if (plan.gateway === 'snapchat_native_action') {
    const squad = /^\/v1\/campaigns\/([^/]+)\/adsquads$/.exec(plan.path)?.[1];
    if (squad !== undefined)
      return {
        child: 'ad squad',
        parent: 'campaign',
        field: 'status',
        active: 'ACTIVE',
        paused: 'PAUSED',
        statuses: b => statusesOf(b.adsquads, 'status'),
        parentRow: (_, s) => snapRow(s, 'campaigns', 'campaign', squad),
      };
    const ad = /^\/v1\/adsquads\/([^/]+)\/ads$/.exec(plan.path)?.[1];
    if (ad !== undefined)
      return {
        child: 'ad',
        parent: 'ad squad',
        field: 'status',
        active: 'ACTIVE',
        paused: 'PAUSED',
        statuses: b => statusesOf(b.ads, 'status'),
        parentRow: (_, s) => snapRow(s, 'adsquads', 'adsquad', ad),
        campaign: {
          id: p => p.campaign_id,
          read: (r, id) => ({...r, path: '/v1/campaigns/' + id}),
          row: (s, id) => snapRow(s, 'campaigns', 'campaign', id),
        },
      };
  }
  if (plan.gateway === 'meta_native_action') {
    const level = /^\/v[^/]+\/act_[^/]+\/(adsets|ads)$/.exec(plan.path)?.[1];
    if (level === 'adsets')
      return {
        child: 'ad set',
        parent: 'campaign',
        field: 'status',
        active: 'ACTIVE',
        paused: 'PAUSED',
        statuses: b => [b.status],
        parentRow: (b, s) => metaRow(s, b.campaign_id),
      };
    if (level === 'ads')
      return {
        child: 'ad',
        parent: 'ad set',
        field: 'status',
        active: 'ACTIVE',
        paused: 'PAUSED',
        statuses: b => [b.status],
        parentRow: (b, s) => metaRow(s, b.adset_id),
        campaign: {
          id: p => p.campaign_id,
          read: (r, id) => ({...r, path: r.path.replace(/[^/]+$/, id), query: {fields: 'id,name,status'}}),
          row: metaRow,
        },
      };
  }
  if (plan.gateway === 'tiktok_native_action') {
    if (plan.path === '/v1.3/adgroup/create/')
      return {
        child: 'ad group',
        parent: 'campaign',
        field: 'operation_status',
        active: 'ENABLE',
        paused: 'DISABLE',
        statuses: b => [b.operation_status],
        parentRow: (b, s) => tiktokRow(s, 'campaign_id', b.campaign_id),
      };
    if (plan.path === '/v1.3/ad/create/')
      return {
        child: 'ad',
        parent: 'ad group',
        field: 'operation_status',
        active: 'ENABLE',
        paused: 'DISABLE',
        statuses: b => statusesOf(b.creatives, 'operation_status'),
        parentRow: (b, s) => tiktokRow(s, 'adgroup_id', b.adgroup_id),
        campaign: {
          id: p => p.campaign_id,
          read: (r, id) => ({
            ...r,
            action: 'tiktok_campaign_get',
            path: '/v1.3/campaign/get/',
            query: {advertiser_id: r.query?.advertiser_id, filtering: {campaign_ids: [id]}, page_size: 100},
          }),
          row: (s, id) => tiktokRow(s, 'campaign_id', id),
        },
      };
  }
  return undefined;
}
/** The status values a child create may carry: paused always, active only under a paused parent (checked below). */
export function pausedParentChildStatuses(plan: CompiledRequest): string[] | undefined {
  const l = levelOf(plan);
  return l ? [l.paused, l.active] : undefined;
}
/** The campaign read an active ad needs when its own parent serves; undefined in every other case. */
export function pausedParentFollowUp(plan: CompiledRequest, read: CompiledRequest, data: unknown) {
  const l = levelOf(plan),
    body = object(plan.body) ? plan.body : {};
  if (!l?.campaign || !l.statuses(body).includes(l.active)) return undefined;
  const parent = l.parentRow(body, [data]);
  if (!parent || parent[l.field] === l.paused) return undefined;
  const id = l.campaign.id(parent);
  return safeId(id) ? l.campaign.read(read, String(id)) : undefined;
}
export function validatePausedParents(plan: CompiledRequest, states: unknown[]) {
  const l = levelOf(plan),
    body = object(plan.body) ? plan.body : {};
  if (!l || !l.statuses(body).includes(l.active)) return;
  const parent = l.parentRow(body, states),
    status = parent?.[l.field],
    campaignId = parent && l.campaign ? l.campaign.id(parent) : undefined,
    campaign = l.campaign && campaignId !== undefined ? l.campaign.row(states, campaignId)?.[l.field] : undefined;
  if (status === l.paused || campaign === l.paused) return;
  const named = (v: unknown) => (typeof v === 'string' ? v : 'unread');
  throw new MirrorError(
    'PARENT_SERVING',
    'A new ' +
      l.child +
      ' must start ' +
      l.paused +
      ' while its ' +
      l.parent +
      (l.campaign ? ' and campaign' : '') +
      ' can serve (' +
      l.parent +
      ' ' +
      named(status) +
      (l.campaign ? ', campaign ' + named(campaign) : '') +
      '). Under a ' +
      l.paused +
      ' ' +
      l.parent +
      (l.campaign ? ' or campaign' : '') +
      ' it may start ' +
      l.active +
      '.',
    {
      field: l.field,
      parent: l.parent,
      parent_status: typeof status === 'string' ? status : null,
      ...(l.campaign ? {campaign_status: typeof campaign === 'string' ? campaign : null} : {}),
      allowed: [l.paused],
    },
  );
}
