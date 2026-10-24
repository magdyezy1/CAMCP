import type {ReviewedFamily} from './reviewed-family.js';
import {
  redditCreativeKind,
  assertRedditCreative,
  redditCreativeSnapshots,
  redditCreativeOutcome,
  validateRedditCreativePrerequisites,
} from './reddit-creative-writes.js';
import type {CompiledRequest, JsonObject, Connection} from './types.js';
import type {TransportResult} from './transport.js';
import {MirrorError} from './errors.js';
import {familyCodeError, type OneCodeRefusal, readOf} from './family-kit.js';
import {recordedWriteGrant} from './provider-grants.js';
const kinds = ['campaigns', 'ad_groups', 'ads', 'saved_audiences'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const fail: OneCodeRefusal = familyCodeError('INVALID_REDDIT_MUTATION');
const identifier = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export function redditWriteKind(plan: CompiledRequest) {
  if (plan.gateway !== 'reddit_native_action') return;
  const create = /^\/api\/v3\/ad_accounts\/([^/]+)\/(campaigns|ad_groups|ads|saved_audiences)$/.exec(plan.path),
    update = /^\/api\/v3\/(campaigns|ad_groups|ads|saved_audiences)\/([^/]+)$/.exec(plan.path);
  if (plan.method === 'POST' && create) return {kind: create[2]!, create: true};
  if (plan.method === 'PATCH' && update) return {kind: update[1]!, create: false, target: update[2]!};
}
export function assertRedditWrite(plan: CompiledRequest) {
  if (redditCreativeKind(plan)) return assertRedditCreative(plan);
  const route = redditWriteKind(plan);
  if (!route)
    throw new MirrorError(
      'WRITE_CONTRACT_UNAVAILABLE',
      'Reddit execution supports reviewed campaign, ad-group, existing-post ad and saved Reddit-audience creates/updates.',
    );
  if (Object.keys(plan.query).length || plan.specialTransport || Object.keys(plan.headers).length)
    fail('Only native JSON bodies are qualified for Reddit write reviews.');
  const b = plan.body;
  if (!object(b) || Object.keys(b).some(k => k !== 'data') || !object(b.data) || !Object.keys(b.data).length)
    fail('Use the native {data:{...}} request body.');
  const d = b.data;
  const readOnly = [
    'id',
    'created_at',
    'modified_at',
    'updated_at',
    'effective_status',
    'delivery_status',
    'post_url',
    'preview_url',
    'rejection_reason',
    'campaign_objective_type',
    'is_max',
  ];
  if (Object.keys(d).some(k => readOnly.includes(k))) fail('Do not submit server-derived or read-only entity fields.');
  if (d.ad_account_id !== undefined && d.ad_account_id !== plan.accountId)
    fail('ad_account_id must match the selected account.');
  if (
    d.type !== undefined &&
    !(
      (route.kind === 'ad_groups' && d.type === 'MANUAL') ||
      (route.kind === 'ads' && d.type === 'UNSPECIFIED') ||
      (route.kind === 'saved_audiences' && d.type === 'REDDIT_AUDIENCE')
    )
  )
    fail('Reddit Max and customer-list audience workflows need additional contracts.');
  if (route.create) {
    if (typeof d.name !== 'string' || !d.name.trim()) fail('New resources require a name.');
    if (route.kind === 'saved_audiences') {
      if (d.type !== 'REDDIT_AUDIENCE' || !object(d.targeting))
        fail('Saved-audience creation requires type REDDIT_AUDIENCE and native targeting.');
    } else if (d.configured_status !== 'PAUSED')
      throw new MirrorError(
        'PAUSED_CREATION_REQUIRED',
        'New Reddit serving entities must use configured_status: PAUSED.',
      );
    if (route.kind === 'ad_groups' && !identifier(d.campaign_id)) fail('Ad groups require an existing campaign_id.');
    if (route.kind === 'ads' && (!identifier(d.ad_group_id) || !identifier(d.post_id)))
      fail(
        'Reviewed ad creation requires an existing ad_group_id and post_id. Media/Reddit Max templates are separate, unqualified workflows.',
      );
    if (
      (route.kind === 'ad_groups' || (route.kind === 'campaigns' && d.is_campaign_budget_optimization === true)) &&
      !identifier(d.conversion_pixel_id)
    )
      fail('Reddit requires conversion_pixel_id for ad groups and CBO campaigns.');
  } else {
    if (d.campaign_id !== undefined || d.ad_group_id !== undefined || d.type !== undefined)
      fail('A review cannot change an existing resource parent or type.');
    if (route.kind === 'saved_audiences') {
      if (
        Object.keys(d).some(k => !['name', 'targeting', 'status'].includes(k)) ||
        (d.status !== undefined && d.status !== 'DELETED')
      )
        fail('Saved-audience updates support name/targeting or status DELETED.');
    }
  }
  if (d.configured_status !== undefined && !['ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED'].includes(d.configured_status))
    fail('Use a documented configured_status.');
  for (const k of ['bid_value', 'goal_value', 'spend_cap'])
    if (d[k] !== undefined && d[k] !== null && (!Number.isSafeInteger(d[k]) || d[k] < 0))
      fail(k + ' must use a nonnegative safe integer in native provider units.');
  for (const k of [
    'campaign_id',
    'ad_group_id',
    'post_id',
    'profile_id',
    'saved_audience_id',
    'funding_instrument_id',
    'conversion_pixel_id',
  ])
    if (d[k] !== undefined && d[k] !== null && !identifier(d[k])) fail(k + ' must be an existing native identifier.');
}
/**
 * Owner-policy amounts of a Reddit campaign or ad group goal. The pinned Reddit Ads API v3 OpenAPI describes a campaign
 * goal_value as "The goal value (microcurrency)" and an ad group goal_value as "Measured in microcurrency for monetary
 * goal types", where ad group goal_type allows only DAILY_SPEND, LIFETIME_SPEND or null; so goal_value is always a
 * budget here. An update that omits goal_type keeps the reviewed entity's goal type, and the baseline key carries the
 * goal type, so switching between daily and lifetime goals has no comparable baseline.
 * spend_cap is the campaign's lifetime spend cap, "Campaign lifetime spend cap (microcurrency)" in the same OpenAPI:
 * a lifetime amount (owner decision D7) held to max_total_budget_native, else max_budget_native, that may always be
 * lowered. Clearing it (null, or zero) under a numeric policy is one unsupported field beside the goal's checks, never
 * a refusal that hides them (WRT-01: the goal of a request that also set a spend cap used to go unchecked).
 */
export function redditPolicyAmounts(plan: CompiledRequest, before: unknown, policy: JsonObject = {}) {
  const route = redditWriteKind(plan),
    d = object(plan.body) ? plan.body.data : undefined;
  if (!route || !['campaigns', 'ad_groups'].includes(route.kind) || !object(d)) return;
  const goal = d.goal_value !== undefined && d.goal_value !== null,
    cap = d.spend_cap !== undefined;
  if (!goal && !cap) return;
  const current = route.create
    ? undefined
    : (Array.isArray(before) ? before : [])
        .map(s => (object(s) && object(s.data) ? s.data : undefined))
        .find(s => s?.id === route.target);
  const numericPolicy = [
    'max_budget_native',
    'max_budget_increase_percent',
    'max_daily_increase_native',
    'max_total_budget_native',
  ].some(k => policy[k] !== undefined);
  const amounts: {path: string; key: string; amount: number; decimal: string; lifetime?: boolean}[] = [],
    old: {path: string; key: string; amount: number; decimal: string}[] = [],
    unsupported: {field: string; reason: 'cleared'}[] = [];
  if (goal) {
    const type = d.goal_type !== undefined ? d.goal_type : current?.goal_type;
    if (!Number.isSafeInteger(d.goal_value) || d.goal_value < 0)
      fail('goal_value must use a nonnegative safe integer in native provider units.');
    const key = 'goal_value:' + String(type ?? 'unknown'),
      amount = (v: number) => ({path: '/body/data/goal_value', key, amount: v, decimal: String(v)});
    amounts.push(amount(d.goal_value));
    if (current && Number.isSafeInteger(current.goal_value) && (current.goal_type ?? null) === (type ?? null))
      old.push(amount(current.goal_value));
  }
  if (cap) {
    const field = '/body/data/spend_cap';
    if (d.spend_cap === null || d.spend_cap === 0) {
      if (numericPolicy) unsupported.push({field, reason: 'cleared'});
    } else {
      if (!Number.isSafeInteger(d.spend_cap) || d.spend_cap < 0)
        fail('spend_cap must use a nonnegative safe integer in native provider units.');
      const amount = (v: number) => ({path: field, key: 'spend_cap', amount: v, decimal: String(v)});
      amounts.push({...amount(d.spend_cap), lifetime: true});
      if (current && Number.isSafeInteger(current.spend_cap) && current.spend_cap > 0)
        old.push(amount(current.spend_cap));
    }
  }
  return {creating: route.create, amounts, old, ...(unsupported.length ? {unsupported} : {})};
}
export function assertRedditWriteScopes(connection: Connection) {
  // adsread and adsedit, from the one grant registry (CON-03).
  if (recordedWriteGrant({gateway: 'reddit_native_action', scopes: connection.scopes}) !== true)
    throw new MirrorError(
      'INSUFFICIENT_SCOPE',
      'Reddit review and execution require adsread and adsedit on the selected connection.',
      {},
      403,
    );
}
/**
 * The conversion pixel an ad group or CBO campaign names (PRV-06 D). The pinned Reddit Ads API v3 OpenAPI requires a
 * pixel for every ad group and CBO campaign from 2026-07-13 ("List Pixels By Ad Account"), and until now only the
 * pixel ID's format was checked. The review reads the pixels associated with the ad account
 * (GET /api/v3/ad_accounts/{id}/pixels): a pixel the account does not list is refused before anything is sent. Only then
 * is the listed pixel's activity read (GET /api/v3/pixels/{id}/last_fired_at): the impact names the pixel and its last
 * firing and warns when it never fired, or not within redditPixelStaleDays. Activity warns and never refuses: a new
 * pixel has no history yet, and a quiet one may be seasonal.
 *
 * The activity read is created only by followUps, after the account's own list named the pixel; that marked, server-built
 * read is what authorizes reading a pixel outside the ad-account path. Its exact time is shown but not compared at
 * execute (`last_fired_at` is volatile review state); whether the pixel ever fired, and how recently, is.
 */
const pixelAction = 'AMCP_REDDIT_PIXEL_READ';
type PixelRead = CompiledRequest & {redditPixelState?: 'membership' | 'activity'; redditPixelId?: string};
/** A pixel that has not fired within this many days is shown as stale (a local warning threshold). */
export const redditPixelStaleDays = 7;
/** The standard events of Reddit's last-fired report; `custom` covers custom conversion events. */
const pixelEvents = [
  'add_to_cart',
  'add_to_wishlist',
  'custom',
  'lead',
  'page_visit',
  'purchase',
  'search',
  'sign_up',
  'view_content',
];
const pixelRead = (plan: CompiledRequest, state: 'membership' | 'activity', pixel: string): PixelRead =>
  readOf<PixelRead>(
    plan,
    {
      action: pixelAction,
      path:
        state === 'membership'
          ? '/api/v3/ad_accounts/' + plan.accountId + '/pixels'
          : '/api/v3/pixels/' + pixel + '/last_fired_at',
      // One page holds every pixel an account can have in practice; another page is refused as incomplete state.
      query: state === 'membership' ? {'page.size': 1000} : {},
      clears: [],
    },
    {redditPixelState: state, redditPixelId: pixel},
  );
export const isRedditPixelRead = (read: CompiledRequest): boolean =>
  read.gateway === 'reddit_native_action' && read.action === pixelAction && !!(read as PixelRead).redditPixelState;
/** The marked activity read of a pixel the account's list named, for the selected account only. */
export function authorizeRedditPixelRead(read: CompiledRequest, connection: Connection, account: string): boolean {
  const r = read as PixelRead;
  if (!isRedditPixelRead(read) || r.redditPixelState !== 'activity') return false;
  return (
    read.method === 'GET' &&
    read.readOnly &&
    read.accountId === account &&
    identifier(r.redditPixelId) &&
    read.path === '/api/v3/pixels/' + r.redditPixelId + '/last_fired_at' &&
    !Object.keys(read.query).length &&
    connection.scopes.includes('adsread')
  );
}
/** The account's pixel list must name the pixel; the activity report must be readable. */
export function validateRedditPixelState(read: CompiledRequest, result: TransportResult): void {
  const r = read as PixelRead,
    d = (result.data as JsonObject)?.data;
  if (r.redditPixelState === 'membership') {
    if (result.status !== 200 || !Array.isArray(d) || d.some(p => !object(p) || !identifier(p.id)))
      throw new MirrorError(
        'STATE_READ_FAILED',
        'Reddit did not return a complete pixel list for the selected ad account.',
        {},
        502,
      );
    if (!d.some(p => p.id === r.redditPixelId))
      throw new MirrorError(
        'REDDIT_PIXEL_NOT_IN_ACCOUNT',
        'Reddit does not list this conversion pixel for the selected ad account. Choose one of the account’s pixels, or associate this pixel with the account in Reddit Events Manager first.',
        {
          field: 'conversion_pixel_id',
          conversion_pixel_id: r.redditPixelId,
          account_pixel_ids: d.map(p => p.id).slice(0, 50),
        },
      );
    return;
  }
  if (
    result.status !== 200 ||
    !object(d) ||
    Object.entries(d).some(
      ([k, v]) =>
        pixelEvents.includes(k) &&
        v !== null &&
        v !== undefined &&
        (typeof v !== 'string' || !Number.isFinite(Date.parse(v))),
    )
  )
    throw new MirrorError(
      'STATE_READ_FAILED',
      'Reddit did not return a readable last-fired report for this pixel.',
      {},
      502,
    );
}
/** The latest firing of any event of the report, or null when none fired. */
function lastFired(report: JsonObject): string | null {
  const times = [
    ...pixelEvents.map(k => report[k]),
    ...(Array.isArray(report.custom_events)
      ? report.custom_events.map((e: unknown) => object(e) && e.last_fired_at)
      : []),
    ...(object(report.breakdown) ? Object.values(report.breakdown) : []),
  ].filter((v): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)));
  return times.length ? times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null;
}
/** What a review keeps of the pixel reads: the selected pixel, and its activity (its exact time is volatile). */
export function redditPixelSnapshot(read: CompiledRequest, data: JsonObject): JsonObject | undefined {
  if (!isRedditPixelRead(read)) return undefined;
  const r = read as PixelRead;
  if (r.redditPixelState === 'membership') {
    const pixel = (data.data as JsonObject[]).find(p => p.id === r.redditPixelId)!;
    return {
      reddit_pixel: {id: pixel.id, name: typeof pixel.name === 'string' ? pixel.name : null},
    };
  }
  const at = lastFired(object(data.data) ? data.data : {});
  return {
    reddit_pixel_activity: {
      pixel_id: r.redditPixelId,
      last_fired_at: at,
      freshness: !at
        ? 'never_fired'
        : Date.now() - Date.parse(at) > redditPixelStaleDays * 86400000
          ? 'stale'
          : 'recent',
    },
  };
}
/** The pixel the request names, its last firing and a warning when it never fired or is stale. */
export function redditPixelImpact(plan: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const pixel = object(plan.body) && object(plan.body.data) ? plan.body.data.conversion_pixel_id : undefined;
  if (!redditWriteKind(plan) || !identifier(pixel)) return undefined;
  const of = (key: string) =>
      (state as JsonObject[]).map(s => (object(s) ? s[key] : undefined)).find(v => object(v)) as JsonObject | undefined,
    listed = of('reddit_pixel'),
    activity = of('reddit_pixel_activity'),
    freshness = activity?.freshness ?? 'unknown';
  return {
    provider: 'reddit',
    conversion_pixel: {
      id: pixel,
      name: listed?.name ?? null,
      listed_for_account: listed?.id === pixel,
      last_fired_at: activity?.last_fired_at ?? null,
      freshness,
    },
    effect:
      'The ' +
      (redditWriteKind(plan)!.kind === 'campaigns' ? 'CBO campaign' : 'ad group') +
      ' measures and optimizes conversions with this pixel of the selected ad account.',
    ...(freshness === 'never_fired'
      ? {
          warning:
            'Reddit reports no event from this pixel yet. Conversion optimization and reporting need events; check the pixel installation before activating.',
        }
      : freshness === 'stale'
        ? {
            warning:
              'This pixel has not fired in the last ' +
              redditPixelStaleDays +
              ' days. Check that it is still installed before activating.',
          }
        : {}),
    source: 'https://ads-api.reddit.com/api/v3/openapi.json (List Pixels By Ad Account; Get Last Fired At)',
  };
}
export function redditSnapshots(plan: CompiledRequest): CompiledRequest[] {
  if (redditCreativeKind(plan)) return redditCreativeSnapshots(plan);
  const route = redditWriteKind(plan)!,
    d = (plan.body as JsonObject).data;
  const read = (path: string): CompiledRequest =>
    readOf(plan, {action: 'AMCP_STATE_READ', path, query: {}, clears: []});
  const reads = [read('/api/v3/ad_accounts/' + plan.accountId)];
  if (!route.create) reads.push(read(plan.path));
  const parents: Record<string, string> = {
    campaign_id: 'campaigns',
    ad_group_id: 'ad_groups',
    post_id: 'posts',
    profile_id: 'profiles',
    saved_audience_id: 'saved_audiences',
  };
  for (const [field, kind] of Object.entries(parents))
    if (d[field]) reads.push(read('/api/v3/' + kind + '/' + d[field]));
  if (d.post_id)
    reads.push({...read('/api/v3/ad_accounts/' + plan.accountId + '/profiles'), redditProfilesState: true});
  if (d.funding_instrument_id)
    reads.push({
      ...read('/api/v3/ad_accounts/' + plan.accountId + '/funding_instruments'),
      query: {funding_instrument_ids: d.funding_instrument_id, mode: 'ALL'},
    });
  // PRV-06 D: the account's pixel list must name the pixel; its activity is a follow-up of that list (followUps).
  if (identifier(d.conversion_pixel_id)) reads.push(pixelRead(plan, 'membership', d.conversion_pixel_id));
  return reads;
}
export function validateRedditState(plan: CompiledRequest, result: TransportResult) {
  const target = plan.path.split('/').at(-1),
    kind = plan.path.split('/').at(-2),
    d = (result.data as JsonObject)?.data;
  if (target === 'funding_instruments') {
    if (
      result.status !== 200 ||
      !Array.isArray(d) ||
      d.length !== 1 ||
      d[0]?.id !== plan.query.funding_instrument_ids ||
      (d[0]?.ad_account_id !== undefined && d[0].ad_account_id !== plan.accountId)
    )
      throw new MirrorError(
        'STATE_TARGET_MISMATCH',
        'Reddit did not return the selected account funding instrument.',
        {},
        502,
      );
    return;
  }
  if (
    result.status !== 200 ||
    !object(d) ||
    d.id !== target ||
    (d.ad_account_id !== undefined && d.ad_account_id !== plan.accountId) ||
    (kind === 'ad_accounts' && d.id !== plan.accountId)
  )
    throw new MirrorError('STATE_TARGET_MISMATCH', 'Reddit did not return the exact scoped resource.', {}, 502);
  if ([...kinds, 'lead_gen_forms'].includes(kind!) && d.ad_account_id !== plan.accountId)
    throw new MirrorError('STATE_TARGET_MISMATCH', 'Reddit state must confirm the resource account.', {}, 502);
  if (kind === 'saved_audiences' && d.type !== 'REDDIT_AUDIENCE')
    throw new MirrorError(
      'WRITE_CONTRACT_UNAVAILABLE',
      'Only saved Reddit targeting audiences are qualified. Customer-list and retargeting ingestion remain separate.',
    );
  if (d.type === 'AUTOMATED' || d.type === 'DYNAMIC_CREATIVE_AD_TEMPLATE' || d.is_max === true)
    throw new MirrorError('WRITE_CONTRACT_UNAVAILABLE', 'Reddit Max state is outside the reviewed contract.');
}
export function redditOutcome(plan: CompiledRequest, result: TransportResult) {
  if (redditCreativeKind(plan)) return redditCreativeOutcome(plan, result);
  const route = redditWriteKind(plan),
    d = (result.data as JsonObject)?.data,
    b = (plan.body as JsonObject)?.data;
  if (
    !route ||
    result.status !== (route.create ? 201 : 200) ||
    !object(d) ||
    !identifier(d.id) ||
    d.ad_account_id !== plan.accountId
  )
    return false;
  if (!route.create && d.id !== route.target) return false;
  for (const field of ['campaign_id', 'ad_group_id', 'post_id'])
    if (b[field] !== undefined && d[field] !== b[field]) return false;
  return b.configured_status === undefined || d.configured_status === b.configured_status;
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const redditWriteFamily: ReviewedFamily = {
  name: 'reddit_classic',
  files: ['src/reddit-writes.ts', ['tests/reddit-writes.test.ts', 'tests/reddit-pixel-check.test.mjs']],
  kind: redditWriteKind,
  snapshots: redditSnapshots,
  // PRV-06 D: the conversion pixel's account membership and activity.
  authorize: (read, connection, account) => authorizeRedditPixelRead(read, connection, account),
  isRead: isRedditPixelRead,
  validateState: (read, result, gateway) => gateway(validateRedditPixelState),
  snapshotValue: (plan, read, data) => redditPixelSnapshot(read, data),
  followUps: (plan, read) =>
    isRedditPixelRead(read) && (read as PixelRead).redditPixelState === 'membership'
      ? [pixelRead(plan, 'activity', (read as PixelRead).redditPixelId!)]
      : [],
  prerequisites: (plan, state) => validateRedditCreativePrerequisites(plan, state),
  impact: redditPixelImpact,
  outcome: redditOutcome,
  policyAmounts: redditPolicyAmounts,
};
