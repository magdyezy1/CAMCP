import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

/**
 * TikTok targeting fields shared by saved audiences and Upgraded Smart+ ad groups, per API for Business v1.3
 * "Create a Saved Audience", "Create an Upgraded Smart+ Ad Group" and the Enumerations appendix (checked
 * 2026-09-26). Callers decide which fields a request may carry; this module checks each field present.
 */
export const tiktokTargetingIdLists = [
  'location_ids',
  'audience_ids',
  'excluded_audience_ids',
  'interest_category_ids',
  'interest_keyword_ids',
  'device_model_ids',
  'carrier_ids',
];
const ages = ['AGE_13_17', 'AGE_18_24', 'AGE_25_34', 'AGE_35_44', 'AGE_45_54', 'AGE_55_100'];
const networks = ['WIFI', '2G', '3G', '4G', '5G'];
const sceneActions: Record<string, string[]> = {
  VIDEO_RELATED: ['WATCHED_TO_END', 'LIKED', 'COMMENTED', 'SHARED'],
  CREATOR_RELATED: ['FOLLOWING', 'VIEW_HOMEPAGE'],
  HASHTAG_RELATED: ['VIEW_HASHTAG'],
};
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
export const tiktokNumericId = (v: unknown) => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const sorted = (v: unknown) => (Array.isArray(v) ? [...v].map(String).sort() : v);
type Fail = (field: string, message: string) => never;

/** Checks every targeting field present in `spec`; field names in errors are prefixed with `path`. */
export function validateTiktokTargeting(
  spec: JsonObject,
  fail: Fail,
  {
    path = '',
    requireLocations = true,
    maxAges = ages,
  }: {path?: string; requireLocations?: boolean; maxAges?: string[]} = {},
): void {
  const unique = (
    field: string,
    v: unknown,
    test: (x: unknown) => boolean,
    what: string,
    required = false,
    max = 100,
  ) => {
    if (
      !Array.isArray(v) ||
      (required && !v.length) ||
      v.length > max ||
      !v.every(test) ||
      new Set(v).size !== v.length
    )
      fail(
        path + field,
        field + ' must be ' + (required ? 'a nonempty' : 'an') + ' array of at most ' + max + ' unique ' + what + '.',
      );
  };
  if (requireLocations || spec.location_ids !== undefined)
    unique('location_ids', spec.location_ids, tiktokNumericId, 'numeric location IDs', true);
  for (const field of tiktokTargetingIdLists.slice(1))
    if (spec[field] !== undefined) unique(field, spec[field], tiktokNumericId, 'numeric IDs');
  const excluded = new Set(spec.excluded_audience_ids ?? []);
  if (new Set([...(spec.audience_ids ?? []), ...excluded]).size > 100)
    fail(path + 'audience_ids', 'Review at most 100 included and excluded audiences together.');
  if ((spec.audience_ids ?? []).some((a: string) => excluded.has(a)))
    fail(path + 'excluded_audience_ids', 'An audience cannot be both included and excluded.');
  if (spec.gender !== undefined && !['GENDER_FEMALE', 'GENDER_MALE', 'GENDER_UNLIMITED'].includes(spec.gender))
    fail(path + 'gender', 'gender must be GENDER_FEMALE, GENDER_MALE or GENDER_UNLIMITED.');
  if (spec.age_groups !== undefined)
    unique(
      'age_groups',
      spec.age_groups,
      v => maxAges.includes(v as string),
      'age groups (' + maxAges.join(', ') + ')',
      true,
      maxAges.length,
    );
  if (spec.languages !== undefined)
    unique(
      'languages',
      spec.languages,
      v => typeof v === 'string' && /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,4})?$/.test(v),
      'language codes from /tool/language/',
    );
  if (spec.network_types !== undefined)
    unique(
      'network_types',
      spec.network_types,
      v => networks.includes(v as string),
      'connection types (' + networks.join(', ') + ')',
      true,
      networks.length,
    );
  if (
    spec.operating_systems !== undefined &&
    (!Array.isArray(spec.operating_systems) ||
      spec.operating_systems.length !== 1 ||
      !['ANDROID', 'IOS'].includes(spec.operating_systems[0]))
  )
    fail(path + 'operating_systems', 'operating_systems takes exactly one of ANDROID and IOS.');
  for (const field of ['min_android_version', 'min_ios_version'])
    if (
      spec[field] !== undefined &&
      (typeof spec[field] !== 'string' || !/^(?:NONE|[1-9][0-9]?\.[0-9]{1,2})$/.test(spec[field]))
    )
      fail(path + field, field + ' must be NONE or a version from /tool/os_version/.');
  const prices = spec.device_price_ranges;
  if (prices !== undefined) {
    if (spec.device_model_ids !== undefined)
      fail(path + 'device_price_ranges', 'Device models and device price ranges cannot be set together.');
    if (
      !Array.isArray(prices) ||
      prices.length !== 2 ||
      prices.some(v => !Number.isSafeInteger(v) || v < 0 || v > 10000 || v % 50 !== 0) ||
      prices[0] >= prices[1]
    )
      fail(
        path + 'device_price_ranges',
        'device_price_ranges is [lower, upper]: multiples of 50 from 0 to 10000, lower below upper.',
      );
  }
  const actions = spec.actions;
  if (actions !== undefined) {
    if (!Array.isArray(actions) || !actions.length || actions.length > 20)
      fail(path + 'actions', 'actions must list 1 to 20 action objects.');
    actions.forEach((a: unknown, i: number) => {
      const at = path + 'actions/' + i;
      if (!obj(a)) fail(at, 'Each action must be an object.');
      const bad = Object.keys(a).find(
        k => !['action_category_ids', 'action_scene', 'action_period', 'video_user_actions'].includes(k),
      );
      if (bad) fail(at + '/' + bad, '"' + bad + '" is outside the qualified action contract.');
      if (!Object.hasOwn(sceneActions, a.action_scene))
        fail(at + '/action_scene', 'action_scene must be VIDEO_RELATED, CREATOR_RELATED or HASHTAG_RELATED.');
      if (
        !Array.isArray(a.action_category_ids) ||
        !a.action_category_ids.length ||
        a.action_category_ids.length > 100 ||
        !a.action_category_ids.every(tiktokNumericId) ||
        new Set(a.action_category_ids).size !== a.action_category_ids.length
      )
        fail(
          at + '/action_category_ids',
          'actions/' +
            i +
            '/action_category_ids must be a nonempty array of at most 100 unique numeric action category IDs.',
        );
      // TikTok stores 0 for creator and hashtag actions whatever is sent; requiring 0 keeps read-back exact.
      if (a.action_scene === 'VIDEO_RELATED' ? ![0, 7, 15].includes(a.action_period) : a.action_period !== 0)
        fail(
          at + '/action_period',
          a.action_scene === 'VIDEO_RELATED'
            ? 'action_period must be 0, 7 or 15.'
            : 'action_period must be 0 for creator and hashtag actions.',
        );
      const allowed = sceneActions[a.action_scene]!;
      if (
        !Array.isArray(a.video_user_actions) ||
        !a.video_user_actions.length ||
        a.video_user_actions.length > 100 ||
        !a.video_user_actions.every((v: unknown) => allowed.includes(v as string)) ||
        new Set(a.video_user_actions).size !== a.video_user_actions.length
      )
        fail(
          at + '/video_user_actions',
          'actions/' +
            i +
            '/video_user_actions must be a nonempty array of at most 100 unique ' +
            a.action_scene +
            ' actions (' +
            allowed.join(', ') +
            ').',
        );
    });
  }
}

/**
 * Targeting in comparable form: ID lists and enum lists as sets, price ranges as [lowest, highest] (TikTok returns a
 * sent [0, 1000] as every step of 50), actions as a set. Only the listed keys present in `v` are projected.
 */
export function tiktokTargetingProjection(v: unknown, keys: string[]): JsonObject {
  if (!obj(v)) return {};
  const out: JsonObject = {};
  for (const key of keys) {
    if (v[key] === undefined) continue;
    const value = v[key];
    if (
      tiktokTargetingIdLists.includes(key) ||
      ['age_groups', 'languages', 'network_types', 'operating_systems', 'placements'].includes(key)
    )
      out[key] = sorted(value);
    else if (key === 'device_price_ranges')
      out[key] = Array.isArray(value) && value.length ? [Math.min(...value), Math.max(...value)] : value;
    else if (key === 'actions')
      out[key] = Array.isArray(value)
        ? value
            .filter(obj)
            .map(a => ({
              action_scene: a.action_scene,
              action_period: a.action_period,
              action_category_ids: sorted(a.action_category_ids),
              video_user_actions: sorted(a.video_user_actions),
            }))
            .sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1))
        : value;
    else out[key] = value;
  }
  return out;
}

/** Referenced custom audiences must be returned for the advertiser, owned by it and available. */
export function assertTiktokOwnedAudiences(state: unknown[], wanted: string[], fail: Fail, use: string): void {
  const rows = state
    .flatMap(s => (obj(s) && obj(s.data) && Array.isArray(s.data.list) ? s.data.list : []))
    .map((r: JsonObject) => r?.audience_details)
    .filter(obj) as JsonObject[];
  for (const audience of wanted) {
    const a = rows.find(r => String(r.audience_id) === audience);
    if (!a)
      throw new MirrorError(
        'STATE_TARGET_MISMATCH',
        'Audience ' + audience + ' was not returned for the selected advertiser.',
        {audience_id: audience},
      );
    if (a.is_creator !== true)
      fail(
        'audience_ids',
        'Audience ' +
          audience +
          ' is shared with this advertiser, not owned by it; ' +
          use +
          ' are qualified with owned audiences only.',
      );
    if (a.is_valid !== true)
      fail(
        'audience_ids',
        'Audience ' + audience + ' is not available yet; TikTok can take up to 48 hours to prepare an audience.',
      );
  }
}
