import {assertNoMethodOverride} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {googleAdsCustomers} from './google-version.js';
import {readOf} from './family-kit.js';

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  throw new MirrorError('INVALID_TARGETING_MUTATION', message);
}
function normalized(value: unknown): any {
  if (Array.isArray(value)) return value.map(normalized);
  if (!object(value)) return value;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value)) {
    const key = snake(k);
    if (Object.hasOwn(out, key)) invalid('Conflicting native field aliases: ' + key);
    out[key] = normalized(v);
  }
  return out;
}
const criteria: Record<string, string[]> = {
  keyword: ['text', 'match_type'],
  location: ['geo_target_constant'],
  language: ['language_constant'],
  device: ['type'],
  ad_schedule: ['day_of_week', 'start_hour', 'end_hour', 'start_minute', 'end_minute'],
  age_range: ['type'],
  gender: ['type'],
  income_range: ['type'],
  parental_status: ['type'],
  placement: ['url'],
  topic: ['topic_constant'],
  user_list: ['user_list'],
  user_interest: ['user_interest_category'],
  audience: ['audience'],
};
const campaignKinds = [
  'keyword',
  'location',
  'language',
  'device',
  'ad_schedule',
  'age_range',
  'gender',
  'income_range',
  'parental_status',
  'placement',
  'topic',
  'user_list',
  'user_interest',
];
const groupKinds = [
  'keyword',
  'age_range',
  'gender',
  'income_range',
  'parental_status',
  'placement',
  'topic',
  'user_list',
  'user_interest',
  'audience',
];
const config = {
  campaignCriteria: {
    resource: 'campaign_criterion',
    fields: ['campaign', 'type', 'negative', 'status', 'bid_modifier'],
    mutable: ['status', 'bid_modifier'],
    parent: 'campaign',
    types: campaignKinds,
  },
  adGroupCriteria: {
    resource: 'ad_group_criterion',
    fields: [
      'ad_group',
      'type',
      'negative',
      'status',
      'bid_modifier',
      'cpc_bid_micros',
      'cpm_bid_micros',
      'cpv_bid_micros',
      'percent_cpc_bid_micros',
      'final_urls',
      'final_mobile_urls',
      'final_url_suffix',
      'tracking_url_template',
      'url_custom_parameters',
    ],
    mutable: [
      'status',
      'bid_modifier',
      'cpc_bid_micros',
      'cpm_bid_micros',
      'cpv_bid_micros',
      'percent_cpc_bid_micros',
      'final_urls',
      'final_mobile_urls',
      'final_url_suffix',
      'tracking_url_template',
      'url_custom_parameters',
    ],
    parent: 'ad_group',
    types: groupKinds,
  },
  sharedSets: {resource: 'shared_set', fields: ['name', 'type', 'status'], mutable: ['name'], parent: '', types: []},
  sharedCriteria: {
    resource: 'shared_criterion',
    fields: ['shared_set', 'type', 'keyword.text', 'keyword.match_type', 'placement.url'],
    mutable: [],
    parent: 'shared_set',
    types: ['keyword', 'placement'],
  },
  campaignSharedSets: {
    resource: 'campaign_shared_set',
    fields: ['campaign', 'shared_set', 'status'],
    mutable: [],
    parent: 'campaign',
    types: [],
  },
};
export const googleTargetingKinds = Object.keys(config);
export function googleTargetingKind(plan: CompiledRequest) {
  const kind = plan.path.match(/^\/v\d+\/customers\/\d+\/([^/]+):mutate$/)?.[1];
  return plan.gateway === 'google_ads_native_action' && plan.method === 'POST' && kind && Object.hasOwn(config, kind)
    ? (kind as keyof typeof config)
    : undefined;
}
function resource(value: unknown, account: string, kind: string) {
  const composite = ['campaignCriteria', 'adGroupCriteria', 'sharedCriteria', 'campaignSharedSets'].includes(kind);
  if (
    typeof value !== 'string' ||
    !new RegExp('^customers/' + account + '/' + kind + '/[1-9][0-9]*' + (composite ? '~[1-9][0-9]*' : '') + '$').test(
      value,
    )
  )
    invalid('Expected an existing ' + kind + ' resource in the selected customer.');
  return value;
}
function fieldSet(r: JsonObject, allowed: string[]) {
  for (const k of Object.keys(r)) if (!allowed.includes(k)) invalid('Unqualified or immutable field: ' + k);
}
function criterion(r: JsonObject, kinds: string[], campaign = false, shared = false) {
  const supplied = kinds.filter(k => r[k] !== undefined);
  if (supplied.length !== 1) invalid('Supply exactly one qualified criterion type.');
  const type = supplied[0]!,
    v = r[type];
  if (!object(v)) invalid(type + ' must be a native object.');
  fieldSet(v, criteria[type]!);
  for (const field of criteria[type]!)
    if (type !== 'ad_schedule' && (typeof v[field] !== 'string' || !v[field].trim()))
      invalid(type + '.' + field + ' is required as a native string.');
  if (type === 'keyword') {
    if (
      typeof v.text !== 'string' ||
      !v.text.trim() ||
      Buffer.byteLength(v.text) > 1024 ||
      !['EXACT', 'PHRASE', 'BROAD'].includes(v.match_type)
    )
      invalid('Keywords require text and EXACT, PHRASE or BROAD match_type.');
    if (campaign && r.negative !== true)
      invalid('Campaign-level keywords must be negative. Positive Search keywords belong to an ad group.');
  }
  if (r.negative !== undefined && typeof r.negative !== 'boolean') invalid('negative must be a boolean.');
  if (
    ((campaign && ['age_range', 'gender', 'income_range', 'parental_status'].includes(type)) ||
      (type === 'placement' && !shared)) &&
    r.negative !== true
  )
    invalid(type + ' is only qualified for exclusions in this contract.');
  if (campaign && ['language', 'device', 'ad_schedule'].includes(type) && r.negative === true)
    invalid(type + ' does not support campaign exclusion through this contract.');
  if (type === 'ad_schedule') {
    if (
      !['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].includes(v.day_of_week) ||
      ![v.start_hour, v.end_hour].every(Number.isInteger) ||
      v.start_hour < 0 ||
      v.start_hour > 23 ||
      v.end_hour < 0 ||
      v.end_hour > 24
    )
      invalid('Invalid ad schedule hours or day.');
    const minutes = ['ZERO', 'FIFTEEN', 'THIRTY', 'FORTY_FIVE'];
    if (
      !minutes.includes(v.start_minute) ||
      !minutes.includes(v.end_minute) ||
      (v.end_hour === 24 && v.end_minute !== 'ZERO') ||
      v.start_hour * 60 + minutes.indexOf(v.start_minute) * 15 >= v.end_hour * 60 + minutes.indexOf(v.end_minute) * 15
    )
      invalid('Ad schedules require an increasing same-day interval in quarter hours.');
  }
  const constants: Record<string, [string, string]> = {
    location: ['geo_target_constant', 'geoTargetConstants'],
    language: ['language_constant', 'languageConstants'],
    topic: ['topic_constant', 'topicConstants'],
    user_interest: ['user_interest_category', 'userInterests'],
  };
  if (constants[type]) {
    const [field, collection] = constants[type]!;
    if (typeof v[field] !== 'string' || !new RegExp('^' + collection + '/[1-9][0-9]*$').test(v[field]))
      invalid('Use an existing ' + collection + ' constant.');
  }
  if (
    type === 'placement' &&
    (typeof v.url !== 'string' || !v.url.trim() || v.url.length > 250 || /[\r\n]/.test(v.url))
  )
    invalid('Provide a native placement URL of at most 250 characters.');
  return type;
}
export function assertGoogleTargeting(plan: CompiledRequest) {
  const kind = googleTargetingKind(plan);
  if (!kind) return;
  const cfg = config[kind],
    account = plan.accountId!,
    body = normalized(plan.body),
    seen = new Set<string>();
  for (const op of body.operations) {
    fieldSet(op, ['create', 'update', 'remove', 'update_mask']);
    const r = op.create ?? op.update;
    if (r !== undefined && !object(r)) invalid('Mutation records must be native objects.');
    if (op.remove !== undefined) {
      const id = resource(op.remove, account, kind);
      if (seen.has(id)) invalid('A target cannot appear twice in a mutation.');
      seen.add(id);
      continue;
    }
    if (op.update) {
      const name = resource(r.resource_name, account, kind);
      if (seen.has(name)) invalid('A target cannot appear twice in a mutation.');
      seen.add(name);
      if (typeof op.update_mask !== 'string' || !op.update_mask) invalid('Updates require update_mask.');
      const mask = op.update_mask.split(',').map(snake);
      if (
        !cfg.mutable.length ||
        mask.some((f: string) => !(cfg.mutable as readonly string[]).includes(f)) ||
        new Set(mask).size !== mask.length
      )
        invalid(
          'The mask contains an immutable or unqualified field. Remove and create a criterion to change its identity.',
        );
      fieldSet(r, ['resource_name', ...mask]);
    } else {
      if (op.update_mask !== undefined) invalid('Only updates accept update_mask.');
      fieldSet(r, [
        ...cfg.types,
        ...cfg.mutable,
        ...(cfg.parent ? [cfg.parent] : []),
        ...(kind === 'campaignCriteria' || kind === 'adGroupCriteria' ? ['negative'] : []),
        ...(kind === 'sharedSets' ? ['name', 'type'] : []),
        ...(kind === 'campaignSharedSets' ? ['shared_set'] : []),
      ]);
      if (kind === 'campaignCriteria' || kind === 'adGroupCriteria' || kind === 'sharedCriteria') {
        const t = criterion(r, cfg.types, kind === 'campaignCriteria', kind === 'sharedCriteria');
        if (t === 'user_list') resource(r.user_list.user_list, account, 'userLists');
        if (t === 'audience') resource(r.audience.audience, account, 'audiences');
      }
      if (
        kind === 'sharedSets' &&
        (!['NEGATIVE_KEYWORDS', 'NEGATIVE_PLACEMENTS'].includes(r.type) ||
          typeof r.name !== 'string' ||
          !r.name.trim() ||
          Buffer.byteLength(r.name) > 255)
      )
        invalid('Shared lists require a name and NEGATIVE_KEYWORDS or NEGATIVE_PLACEMENTS type.');
      if (cfg.parent)
        resource(
          r[cfg.parent],
          account,
          cfg.parent === 'campaign' ? 'campaigns' : cfg.parent === 'ad_group' ? 'adGroups' : 'sharedSets',
        );
      if (kind === 'campaignSharedSets') resource(r.shared_set, account, 'sharedSets');
    }
    if (r.status !== undefined && !['ENABLED', 'PAUSED'].includes(r.status))
      invalid('Use ENABLED/PAUSED where supported, or a remove operation.');
    for (const [k, v] of Object.entries(r))
      if (k.endsWith('_micros') && (typeof v !== 'string' || !/^\d+$/.test(v) || BigInt(v) > 9223372036854775807n))
        invalid('Bid micros must be nonnegative signed 64-bit decimal strings.');
    if (
      r.bid_modifier !== undefined &&
      (typeof r.bid_modifier !== 'number' ||
        !Number.isFinite(r.bid_modifier) ||
        r.bid_modifier < 0 ||
        r.bid_modifier > 10)
    )
      invalid('bid_modifier must be between 0 and 10; the provider enforces type-specific limits.');
  }
}
export function googleTargetingSnapshots(plan: CompiledRequest): CompiledRequest[] {
  const kind = googleTargetingKind(plan)!,
    cfg = config[kind],
    account = plan.accountId!,
    body = normalized(plan.body),
    reads: CompiledRequest[] = [],
    seen = new Set<string>();
  const search = (entity: string, fields: string[], names: string[], related: string[] = []) => {
    const query =
      'SELECT ' +
      [...new Set(['resource_name', ...fields])].map(f => entity + '.' + f).join(', ') +
      related.map(f => ', ' + f).join('') +
      ' FROM ' +
      entity +
      ' WHERE ' +
      entity +
      '.resource_name IN (' +
      names.map(n => "'" + n + "'").join(', ') +
      ')';
    if (seen.has(query)) return;
    seen.add(query);
    reads.push(
      readOf(plan, {
        action: 'AMCP_STATE_READ',
        method: 'POST',
        path: googleAdsCustomers + account + '/googleAds:search',
        query: {},
        body: {query},
        clears: [],
      }),
    );
  };
  const fields = [...cfg.fields, ...cfg.types.flatMap(t => (criteria[t] ?? []).map(f => t + '.' + f))],
    targets = body.operations
      .filter((o: JsonObject) => o.update || o.remove)
      .map((o: JsonObject) => o.remove ?? o.update.resource_name);
  if (targets.length) search(cfg.resource, fields, targets);
  if (body.operations.some((o: JsonObject) => o.create))
    reads.push(
      readOf(plan, {
        action: 'AMCP_STATE_READ',
        method: 'POST',
        path: googleAdsCustomers + account + '/googleAds:search',
        query: {},
        body: {query: 'SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'},
        clears: [],
      }),
    );
  for (const op of body.operations) {
    const r = op.create ?? op.update;
    if (!r) continue;
    if (r.campaign) search('campaign', ['name', 'status', 'advertising_channel_type', 'campaign_budget'], [r.campaign]);
    // The campaign's status too: a new keyword may start ENABLED only under a paused parent (owner item 6).
    if (r.ad_group) search('ad_group', ['name', 'status', 'campaign'], [r.ad_group], ['campaign.status']);
    if (r.shared_set) search('shared_set', config.sharedSets.fields, [r.shared_set]);
    if (r.user_list) search('user_list', ['name', 'type', 'membership_status'], [r.user_list.user_list]);
    if (r.audience) search('audience', ['name', 'status', 'scope'], [r.audience.audience]);
  }
  return reads;
}
/**
 * A new positive ad-group criterion serves as soon as it and its ad group and campaign are enabled. It may start
 * ENABLED only while its ad group or campaign is paused, as read for this review: then nothing serves until that
 * parent is enabled, which is its own reviewed activation. Under a serving parent it must start PAUSED. (Owner's
 * item 6, 2026-09-29: requiring PAUSED under a paused campaign added a second pass per keyword set and protected
 * nothing.) A parent the review could not read counts as serving.
 */
function pausedParentsCoverChildren(plan: CompiledRequest, states: unknown[]) {
  if (googleTargetingKind(plan) !== 'adGroupCriteria') return;
  const rows = states.flatMap(s => (s as JsonObject)?.results ?? []).map(r => normalized(r));
  for (const op of normalized(plan.body).operations) {
    const r = op.create;
    if (!r || r.negative === true || r.status === 'PAUSED') continue;
    const row = rows.find(x => x.ad_group?.resource_name === r.ad_group),
      adGroup = row?.ad_group?.status,
      campaign = row?.campaign?.status;
    if (adGroup !== 'PAUSED' && campaign !== 'PAUSED')
      throw new MirrorError(
        'TARGETING_PARENT_SERVING',
        'A new positive ad-group criterion must start PAUSED while its ad group and campaign can serve (ad group ' +
          (adGroup ?? 'unread') +
          ', campaign ' +
          (campaign ?? 'unread') +
          '). Under a paused ad group or campaign it may start ENABLED.',
        {field: 'status', ad_group: r.ad_group, ad_group_status: adGroup ?? null, campaign_status: campaign ?? null},
      );
  }
}
export function validateGoogleTargetingState(plan: CompiledRequest, states: unknown[]) {
  pausedParentsCoverChildren(plan, states);
  if (googleTargetingKind(plan) !== 'sharedCriteria') return;
  const body = normalized(plan.body),
    sets = states
      .flatMap(s => (s as JsonObject)?.results ?? [])
      .map(r => normalized(r).shared_set)
      .filter(Boolean);
  for (const op of body.operations) {
    if (!op.create) continue;
    const r = op.create,
      parent = sets.find(s => s.resource_name === r.shared_set),
      expected = r.keyword ? 'NEGATIVE_KEYWORDS' : 'NEGATIVE_PLACEMENTS';
    if (parent?.type !== expected || parent.status !== 'ENABLED')
      throw new MirrorError(
        'INVALID_TARGETING_PARENT',
        'The shared list must be enabled and match the criterion type.',
        {shared_set: r.shared_set, expected_type: expected},
      );
  }
}

/**
 * AMCP_GOOGLE_NARROWING_EXEMPT=false restores the spend acknowledgement on every Google targeting write (WRT-07 Stage D
 * rollback).
 */
export const narrowingExempt = () => process.env.AMCP_GOOGLE_NARROWING_EXEMPT !== 'false';
/**
 * Whether a Google targeting write can widen delivery, and so needs the spend acknowledgement (WRT-07 Stage D, owner
 * decision P5). Only an exact negative-only create narrows: every operation creates a campaign or ad-group criterion
 * with negative: true, or a shared criterion (its list is a negative keyword or placement list, which the review's
 * state read checks before anything is sent). Any removal, update, positive criterion, list attachment or unrecognised
 * shape still asks; removing a negative widens delivery.
 */
export function googleTargetingWidens(plan: CompiledRequest): boolean {
  if (!narrowingExempt()) return true;
  const kind = googleTargetingKind(plan);
  let body: JsonObject;
  try {
    body = normalized(plan.body);
  } catch {
    return true;
  }
  const ops = object(body) && Array.isArray(body.operations) ? body.operations : [];
  if (!ops.length) return true;
  return !ops.every(
    (op: unknown) =>
      object(op) &&
      Object.keys(op).length === 1 &&
      object(op.create) &&
      (kind === 'sharedCriteria' ||
        ((kind === 'campaignCriteria' || kind === 'adGroupCriteria') && op.create.negative === true)),
  );
}
/**
 * Whether a Google targeting write activates delivery for the owner's "nothing goes live" switch (allow_activation:
 * false): removing an exclusion widens delivery. A removed campaign or ad-group criterion counts unless the review's
 * state shows it positive; a removed shared criterion (a negative list's) or a detached list always counts.
 */
function googleTargetingActivates(plan: CompiledRequest, before: unknown): boolean {
  const kind = googleTargetingKind(plan);
  let body: JsonObject;
  try {
    body = normalized(plan.body);
  } catch {
    return true;
  }
  const removals = (Array.isArray(body?.operations) ? body.operations : [])
    .filter((op: unknown) => object(op) && typeof (op as JsonObject).remove === 'string')
    .map((op: JsonObject) => op.remove as string);
  if (!removals.length) return false;
  if (kind === 'sharedCriteria' || kind === 'campaignSharedSets') return true;
  if (kind !== 'campaignCriteria' && kind !== 'adGroupCriteria') return false;
  const resource = config[kind].resource,
    rows = (Array.isArray(before) ? before : [before])
      .flatMap(s => (object(s) && Array.isArray(s.results) ? s.results : []))
      .map(r => normalized(r)?.[resource])
      .filter(object);
  return removals.some(name => rows.find(r => r.resource_name === name)?.negative !== false);
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleTargetingFamily: ReviewedFamily = {
  name: 'google_targeting',
  files: ['src/google-targeting-writes.ts', ['tests/google-targeting-writes.test.ts']],
  kind: googleTargetingKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertGoogleTargeting(plan);
  },
  snapshots: googleTargetingSnapshots,
  activates: googleTargetingActivates,
  spendConfirmation: {
    needed: googleTargetingWidens,
    message: 'Targeting, serving and shared-list changes require spend_change_confirmed=true.',
  },
};
