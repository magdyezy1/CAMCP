import {MirrorError} from './errors.js';
import {tiktokAudienceGetPath} from './tiktok-lookalikes.js';
import {
  validateTiktokTargeting,
  tiktokTargetingProjection,
  assertTiktokOwnedAudiences,
  tiktokNumericId,
} from './tiktok-targeting.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * TikTok saved audiences (reusable targeting), per API for Business v1.3 "Create a Saved Audience", "Get details
 * of Saved Audiences" and the Enumerations appendix (checked 2026-09-26). A saved audience changes no ad group;
 * an ad group uses it only when created with saved_audience_id. At most 400 per advertiser. Deletion and the
 * example-only interest_keyword_language field are outside this contract.
 */
export const tiktokSavedAudiencePath = '/v1.3/dmp/saved_audience/create/';
export const tiktokSavedAudienceListPath = '/v1.3/dmp/saved_audience/list/';
export const tiktokSavedAudienceSource = 'https://business-api.tiktok.com/portal/docs/create-a-saved-audience/v1.3';
const keys = [
  'advertiser_id',
  'saved_audience_name',
  'location_ids',
  'gender',
  'age_groups',
  'languages',
  'audience_ids',
  'excluded_audience_ids',
  'interest_category_ids',
  'interest_keyword_ids',
  'actions',
  'operating_systems',
  'min_android_version',
  'min_ios_version',
  'device_model_ids',
  'network_types',
  'carrier_ids',
  'device_price_ranges',
];
const emoji = /\p{Extended_Pictographic}/u;

export const tiktokSavedAudienceKind = (p: CompiledRequest) =>
  p.gateway === 'tiktok_native_action' && p.method === 'POST' && p.path === tiktokSavedAudiencePath;

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_SAVED_AUDIENCE', message, {field});
}
/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokSavedAudience(plan: CompiledRequest, body: JsonObject): void {
  const extra = Object.keys(body).find(k => !keys.includes(k));
  if (extra) invalid(extra, '"' + extra + '" is outside the qualified saved audience contract.');
  if (body.advertiser_id !== undefined && String(body.advertiser_id) !== plan.accountId)
    invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  const name = body.saved_audience_name;
  if (typeof name !== 'string' || !name.trim() || [...name].length > 512 || emoji.test(name))
    invalid(
      'saved_audience_name',
      'saved_audience_name must be nonempty text of at most 512 characters without emoji.',
    );
  validateTiktokTargeting(body, invalid);
}

/** Referenced custom audiences are read so the review can confirm the advertiser owns them. */
export function tiktokSavedAudienceAudiences(plan: CompiledRequest): string[] {
  const b = plan.body as JsonObject;
  return [...new Set<string>([...(b.audience_ids ?? []), ...(b.excluded_audience_ids ?? [])])].sort();
}
/** Against the normalized review state: every referenced audience is this advertiser's own and available. */
export function tiktokSavedAudienceImpact(plan: CompiledRequest, state: unknown[]): JsonObject {
  const b = plan.body as JsonObject;
  assertTiktokOwnedAudiences(state, tiktokSavedAudienceAudiences(plan), invalid, 'saved audiences');
  return {
    provider: 'tiktok',
    scope: 'saved_audiences',
    may_affect_serving: false,
    effect:
      'Creates a reusable saved audience. No ad group changes; an ad group uses it only when created with saved_audience_id in its own review.',
    saved_audience: {
      name: b.saved_audience_name,
      locations: (b.location_ids as string[]).length,
      included_audiences: (b.audience_ids ?? []).length,
      excluded_audiences: (b.excluded_audience_ids ?? []).length,
      targeting: keys.filter(
        k =>
          !['advertiser_id', 'saved_audience_name', 'location_ids', 'audience_ids', 'excluded_audience_ids'].includes(
            k,
          ) && b[k] !== undefined,
      ),
    },
    limit:
      'TikTok allows 400 saved audiences per advertiser; the list read does not page, so TikTok enforces the limit.',
    source: tiktokSavedAudienceSource,
  };
}

/**
 * The targeting configuration in comparable form: ID lists as sets, price ranges as [lowest, highest] (the list
 * read expands a sent [0, 1000] into every step of 50), actions as a set. Only fields present are projected, and
 * verification compares only the fields that were sent.
 */
export function tiktokSavedAudienceProjection(v: unknown): JsonObject {
  return tiktokTargetingProjection(v, ['saved_audience_id', ...keys.filter(k => k !== 'advertiser_id')]);
}
export function tiktokSavedAudienceVerification(
  plan: CompiledRequest,
  result: JsonObject,
): {path: string; query: JsonObject; expected: JsonObject; id: string}[] {
  const id = result.data?.data?.saved_audience_id,
    b = plan.body as JsonObject;
  if (!tiktokNumericId(id))
    throw new MirrorError('VERIFICATION_UNSUPPORTED', 'The creation receipt has no saved audience ID.');
  return [
    {
      path: tiktokSavedAudienceListPath,
      query: {advertiser_id: plan.accountId, saved_audience_ids: [id]},
      expected: tiktokSavedAudienceProjection({...b, saved_audience_id: id}),
      id,
    },
  ];
}
export const tiktokSavedAudienceRead = (p: CompiledRequest) =>
  p.gateway === 'tiktok_native_action' && p.path === tiktokSavedAudienceListPath;
/** The list read with an ID filter must return exactly the requested saved audience. */
export function validateTiktokSavedAudienceState(
  read: CompiledRequest,
  data: JsonObject,
  sameIds: (actual: unknown[], expected: unknown[]) => void,
): boolean {
  if (read.path !== tiktokSavedAudienceListPath) return false;
  if (data.code !== 0 || !Array.isArray(data.data?.saved_audiences))
    throw new MirrorError(
      'STATE_READ_FAILED',
      'TikTok saved audience details must confirm success and list saved audiences.',
    );
  sameIds(
    data.data.saved_audiences.map((r: JsonObject) => r?.saved_audience_id),
    read.query.saved_audience_ids as unknown[],
  );
  return true;
}
export const tiktokSavedAudienceDependencyPath = tiktokAudienceGetPath;
