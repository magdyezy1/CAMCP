import {snapSegmentImpact} from './snapchat-segments.js';
import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
/** PUT resets omitted configuration. Never silently merge live state into the
 * frozen request or treat a sparse update as a complete replacement. */
function assertSnapchatReplacement(plan: CompiledRequest, state: unknown[]) {
  const rows = (plan.body as JsonObject).creatives as JsonObject[];
  for (const row of rows) {
    const before = state
      .flatMap(s => (object(s) ? (s.creatives ?? []) : []))
      .map(r => r.creative)
      .find(r => r?.id === row.id);
    if (!before || before.ad_account_id !== plan.accountId)
      throw new MirrorError(
        'STATE_TARGET_MISMATCH',
        'The creative replacement requires its exact selected-account state.',
      );
    for (const field of ['id', 'ad_account_id', 'type'])
      if (row[field] !== before[field] || row[field] === undefined)
        throw new MirrorError(
          'INVALID_CREATIVE_REPLACEMENT',
          'Preserve the exact creative ID, account and immutable type.',
          {field},
        );
    for (const field of ['skippable', 'collection_properties'])
      if (Object.hasOwn(row, field) && stable(row[field]) !== stable(before[field]))
        throw new MirrorError('INVALID_CREATIVE_REPLACEMENT', 'This creative field is immutable.', {field});
    const missing: string[] = [];
    const check = (old: JsonObject, next: JsonObject, path: string) => {
      for (const [key, value] of Object.entries(old)) {
        if (
          !path &&
          /^(?:created_at|updated_at|packaging_status|review_status(?:_.*)?|rejection(?:_.*)?|approval(?:_.*)?)$/.test(
            key,
          )
        )
          continue;
        if (!Object.hasOwn(next, key)) {
          missing.push(path + '/' + key);
          continue;
        }
        if (object(value) && object(next[key])) check(value, next[key], path + '/' + key);
      }
    };
    check(before, row, '');
    if (missing.length)
      throw new MirrorError(
        'INCOMPLETE_CREATIVE_REPLACEMENT',
        'Snapchat PUT can reset omitted fields; review a complete creative replacement or use the qualified PATCH route.',
        {
          creative_id: row.id,
          missing_fields: missing,
          source: 'https://developers.snap.com/marketing-api/Ads-API/creatives',
          next_action:
            'Read the exact creative, preserve its intended configuration explicitly, remove provider-only status metadata, and prepare a new review. Optional removal must be explicit or use PATCH.',
        },
      );
  }
}
export function writeImpact(
  plan: CompiledRequest,
  state: unknown[],
  override: boolean,
  connectionId: string,
): JsonObject | undefined {
  const family = familyOf(plan),
    familyImpact = family?.impact?.(plan, state, {creativeEditConfirmed: override, connectionId});
  if (familyImpact) return familyImpact;
  if (
    plan.gateway === 'snapchat_native_action' &&
    ['PUT', 'PATCH'].includes(plan.method) &&
    /\/creatives(?:\/[^/]+)?$/.test(plan.path)
  ) {
    if (plan.method === 'PUT') assertSnapchatReplacement(plan, state);
    const rows = (plan.body as JsonObject)?.creatives;
    return {
      provider: 'snapchat',
      effect:
        'All ads referencing an edited creative use the changed creative. Reviewable creative edits can pause delivery during provider re-review. PUT requires a complete replacement; omitted fields can reset to defaults.',
      affected_creative_ids: Array.isArray(rows) ? rows.map(r => r.id) : [plan.path.split('/').at(-1)],
      affected_ad_ids: null,
      enumeration: 'not_available_in_this_contract',
      source: 'https://developers.snap.com/marketing-api/Ads-API/creatives',
      recovery:
        'Inspect the ads sharing this creative before execution. Use a new creative and separately reviewed ad attachment when the change must affect only selected ads. No automatic ad replay is performed.',
    };
  }
  if (
    plan.gateway === 'snapchat_native_action' &&
    plan.method === 'PUT' &&
    /^\/v1\/adaccounts\/[^/]+\/segments$/.test(plan.path)
  )
    return snapSegmentImpact(plan, state);
  return metaCreativeImpact(plan);
}
import {familyOf} from './reviewed-families.js';
import {metaCreativeImpact} from './meta-creative-features.js';
