import {normalizeAccount} from './scope.js';
import {hasProviderId, responseData, assertNoMethodOverride, object} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {tiktokAudienceGetPath, tiktokLookalikePath} from './tiktok-paths.js';

/**
 * TikTok lookalike audiences, per API for Business v1.3 "Create a lookalike audience", "Get audience details" and
 * the Audience Management enumerations (checked 2026-09-26). A lookalike is derived from an existing seed audience
 * this advertiser owns; creating one starts no delivery, spends nothing and uploads no customer data. Refresh,
 * update, deletion, sharing and customer-file audiences are outside this contract.
 */
// The routes live in a leaf (src/tiktok-paths.ts) that other modules read while they are evaluated (ARC-04).
export {tiktokLookalikePath, tiktokAudienceGetPath};
const locations = [
  'AE',
  'AU',
  'AZ',
  'BG',
  'BO',
  'CA',
  'CY',
  'DE',
  'DZ',
  'EE',
  'EG',
  'ES',
  'FR',
  'GB',
  'HR',
  'ID',
  'IL',
  'IN',
  'IT',
  'JP',
  'KE',
  'KR',
  'LK',
  'LT',
  'LV',
  'MY',
  'PL',
  'PR',
  'PY',
  'RS',
  'RU',
  'SA',
  'SI',
  'SK',
  'TH',
  'TR',
  'TW',
  'US',
  'VN',
];
// The create reference names the placements "TikTok, TopBuzz & BuzzVideo, Pangle" without a separate enumeration;
// only the two unambiguous wire values are accepted.
const placements = ['TikTok', 'Pangle'];
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const digits = (v: unknown) => typeof v === 'string' && /^\d{1,32}$/.test(v);

export const tiktokLookalikeKind = (p: CompiledRequest) =>
  p.gateway === 'tiktok_native_action' && p.method === 'POST' && p.path === tiktokLookalikePath;

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_LOOKALIKE', message, {field});
}
function only(v: JsonObject, keys: string[], path: string) {
  const extra = Object.keys(v).find(k => !keys.includes(k));
  if (extra) invalid(path + extra, '"' + path + extra + '" is outside the qualified lookalike contract.');
}

/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokLookalike(plan: CompiledRequest, body: JsonObject): void {
  only(body, ['advertiser_id', 'custom_audience_name', 'lookalike_spec'], '');
  if (body.advertiser_id !== undefined && String(body.advertiser_id) !== plan.accountId)
    invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  if (typeof body.custom_audience_name !== 'string' || !body.custom_audience_name.trim())
    invalid('custom_audience_name', 'custom_audience_name must be nonempty text.');
  if ([...body.custom_audience_name].length > 128)
    invalid('custom_audience_name', 'custom_audience_name has a documented maximum of 128 characters.');
  const spec = body.lookalike_spec;
  if (!obj(spec)) invalid('lookalike_spec', 'lookalike_spec must be an object.');
  only(
    spec,
    ['source_audience_id', 'include_source', 'mobile_os', 'placements', 'location_ids', 'audience_size'],
    'lookalike_spec/',
  );
  if (!digits(spec.source_audience_id))
    invalid('lookalike_spec/source_audience_id', 'source_audience_id must be a TikTok audience ID.');
  if (typeof spec.include_source !== 'boolean')
    invalid('lookalike_spec/include_source', 'include_source is required and must be true or false.');
  if (!['ALL', 'IOS', 'ANDROID'].includes(spec.mobile_os))
    invalid('lookalike_spec/mobile_os', 'mobile_os must be ALL, IOS or ANDROID.');
  const list = (field: string, values: string[]) => {
    const v = spec[field];
    if (!Array.isArray(v) || !v.length || new Set(v).size !== v.length || !v.every(x => values.includes(x)))
      invalid('lookalike_spec/' + field, field + ' must list unique values from: ' + values.join(', ') + '.');
  };
  list('placements', placements);
  list('location_ids', locations);
  if (!['NARROW', 'BALANCED', 'BROAD'].includes(spec.audience_size))
    invalid('lookalike_spec/audience_size', 'audience_size must be NARROW, BALANCED or BROAD.');
}

/** The seed audience is read before review and again before execution. */
export const tiktokLookalikeSeed = (plan: CompiledRequest) =>
  String(((plan.body as JsonObject).lookalike_spec as JsonObject).source_audience_id);

/**
 * Review evidence keeps the seed facts this contract depends on. Coverage changes daily, so only whether it meets
 * the documented minimum of 100 is kept; history and messages are dropped. Idempotent, because a saved review's
 * state is projected again at execution.
 */
export function tiktokAudienceState(data: JsonObject): JsonObject {
  return {
    list: (Array.isArray(data.data?.list) ? data.data.list : []).map((r: JsonObject) => {
      const a = obj(r?.audience_details) ? r.audience_details : {};
      return {
        audience_details: {
          audience_id: a.audience_id,
          type: a.type,
          is_creator: a.is_creator,
          owner_id: a.owner_id,
          is_valid: a.is_valid,
          cover_at_least_100:
            typeof a.cover_num === 'number'
              ? a.cover_num >= 100
              : typeof a.cover_at_least_100 === 'boolean'
                ? a.cover_at_least_100
                : null,
        },
      };
    }),
  };
}

/** Against the normalized review state: the seed must be this advertiser's own, available, non-lookalike audience of at least 100 people. */
export function tiktokLookalikeImpact(plan: CompiledRequest, state: unknown[]): JsonObject {
  const seed = tiktokLookalikeSeed(plan),
    rows = state
      .flatMap(s => (obj(s) && obj(s.data) && Array.isArray(s.data.list) ? s.data.list : []))
      .map((r: JsonObject) => r?.audience_details)
      .filter((a: JsonObject) => obj(a) && String(a.audience_id) === seed);
  if (rows.length !== 1)
    throw new MirrorError('STATE_TARGET_MISMATCH', 'The seed audience was not returned for the selected advertiser.', {
      source_audience_id: seed,
    });
  const a = rows[0] as JsonObject;
  if (a.is_creator !== true || String(a.owner_id) !== plan.accountId)
    throw new MirrorError(
      'STATE_TARGET_MISMATCH',
      'The seed audience must be owned by the selected advertiser, not shared from another.',
      {source_audience_id: seed, owner_id: a.owner_id ?? null},
    );
  if (a.type === 'Lookalike Audience')
    invalid('lookalike_spec/source_audience_id', 'TikTok does not accept a lookalike audience as a seed.');
  if (a.is_valid !== true)
    invalid(
      'lookalike_spec/source_audience_id',
      'The seed audience is not yet available (is_valid is false); TikTok can take up to 48 hours to process an audience.',
    );
  if (a.cover_at_least_100 === false)
    invalid(
      'lookalike_spec/source_audience_id',
      'TikTok requires a seed of at least 100 people; this one covers fewer.',
    );
  const spec = (plan.body as JsonObject).lookalike_spec as JsonObject;
  return {
    provider: 'tiktok',
    effect:
      'Creates a lookalike audience from an owned seed. It starts no delivery; ad groups use it only when it is added to their targeting. TikTok can take up to 48 hours to process it.',
    seed: {audience_id: seed, type: a.type ?? null, cover_at_least_100: a.cover_at_least_100 ?? null},
    audience_size: spec.audience_size,
    location_ids: spec.location_ids,
    source: 'https://business-api.tiktok.com/portal/docs/create-a-lookalike-audience/v1.3',
  };
}

/**
 * Audience details confirm the name, type and ownership of the new audience. The documented example returns
 * lookalike_spec as null even for a lookalike, so the sent spec is listed as unobservable rather than compared.
 */
export function tiktokLookalikeVerification(
  plan: CompiledRequest,
  result: JsonObject,
): {path: string; query: JsonObject; expected: JsonObject; id: string; unobservable: string[]}[] {
  const id = obj(result.data) && obj(result.data.data) ? result.data.data.custom_audience_id : undefined;
  if (!digits(id)) return [];
  const b = plan.body as JsonObject;
  return [
    {
      path: tiktokAudienceGetPath,
      query: {advertiser_id: plan.accountId, custom_audience_ids: [id]},
      expected: {audience_id: id, name: b.custom_audience_name, type: 'Lookalike Audience', is_creator: true},
      id: id as string,
      unobservable: ['lookalike_spec'],
    },
  ];
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokLookalikeFamily: ReviewedFamily = {
  name: 'tiktok_lookalikes',
  files: ['src/tiktok-lookalikes.ts', ['tests/tiktok-lookalikes.test.mjs']],
  kind: tiktokLookalikeKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertTiktokLookalike(plan, object(plan.body));
  },
  snapshots: (plan, stateRead) => {
    const id = normalizeAccount(plan.gateway, plan.accountId!);
    const seed = stateRead(tiktokAudienceGetPath, {
      advertiser_id: id,
      custom_audience_ids: [tiktokLookalikeSeed(plan)],
    });
    seed.action = 'tiktok_dmp_custom_audience_get';
    return [stateRead('/v1.3/advertiser/info/', {advertiser_ids: [id]}), seed];
  },
  impact: tiktokLookalikeImpact,
  outcome: (plan, result) => {
    const d = responseData(result);
    return d.code === 0 && hasProviderId(responseData(d).custom_audience_id);
  },
  verification: (plan, result, before, verificationRead) =>
    tiktokLookalikeVerification(plan, result).map(v => ({
      ...v,
      read: {...verificationRead(v.path, v.query), action: 'tiktok_dmp_custom_audience_get'},
    })),
};
