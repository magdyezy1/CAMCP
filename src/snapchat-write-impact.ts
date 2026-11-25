import {snapSegmentImpact} from './snapchat-segments.js';
import {MirrorError} from './errors.js';
import {stable} from './security.js';
import {isReviewVolatile} from './review-state-core.js';
import {snapchatReviewVolatile} from './snapchat-review-volatile.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * What a Snapchat write changes beyond its target (ARC-01 phase B, wave 4c: its adapter's `writes.impact`, moved
 * verbatim from src/write-impact.ts, which asks it after a family's own impact, where it named Snapchat): a creative
 * edit changes every ad that uses the creative, and a PUT must be a complete replacement; a segment replacement's
 * impact is the segment module's.
 */
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
        // A creative's creation time never changes, and its update time, media packaging and review are Snapchat's own
        // telemetry (its review table): a complete PUT need not carry them.
        if (!path && (key === 'created_at' || isReviewVolatile(snapchatReviewVolatile, key))) continue;
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
/**
 * The money a campaign PUT clears by leaving it out (its adapter's `writes.omittedMoney`, r25-mf-caps). PUT /v1/adaccounts/{id}/campaigns
 * replaces whole records, and the repository's contract for every Snapchat PUT is that it can reset what it omits (ad squads and ads refuse
 * it, INCOMPLETE_SNAPCHAT_REPLACEMENT; creatives, above; segments). The audit could not confirm that Snapchat clears an omitted cap, so one
 * the reviewed campaign holds is judged as cleared, which fails closed whichever it does. A record the state does not show is judged as holding
 * both caps. shortcut: only the two money caps are judged, not every omitted setting; upgrade when campaign PUTs get a family that reads
 * the whole record, as ad squads have.
 */
const campaignCaps = ['daily_budget_micro', 'lifetime_spend_cap_micro'];
export function snapchatOmittedMoney(plan: CompiledRequest, state: unknown): string[] {
  if (plan.method !== 'PUT' || !/^\/v1\/adaccounts\/[^/]+\/campaigns$/.test(plan.path)) return [];
  const rows: unknown[] = object(plan.body) && Array.isArray(plan.body.campaigns) ? plan.body.campaigns : [],
    held = (Array.isArray(state) ? state : [])
      .flatMap(s => (object(s) && Array.isArray(s.campaigns) ? s.campaigns : []))
      .map(wrapped => (object(wrapped) && object(wrapped.campaign) ? wrapped.campaign : wrapped));
  return rows.flatMap((row, i) => {
    const current = object(row) ? held.find(c => object(c) && c.id === row.id) : undefined;
    return campaignCaps
      .filter(field => !(object(row) && Object.hasOwn(row, field)))
      .filter(field => !current || (current[field] !== undefined && current[field] !== null))
      .map(field => '/body/campaigns/' + i + '/' + field);
  });
}
/** The impact of a Snapchat creative edit or segment replacement, or undefined for another Snapchat write. */
export function snapchatWriteImpact(plan: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (['PUT', 'PATCH'].includes(plan.method) && /\/creatives(?:\/[^/]+)?$/.test(plan.path)) {
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
  if (plan.method === 'PUT' && /^\/v1\/adaccounts\/[^/]+\/segments$/.test(plan.path))
    return snapSegmentImpact(plan, state);
  return undefined;
}
