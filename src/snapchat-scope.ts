import type {JsonObject} from './types.js';

/**
 * The Snapchat paths a scoped resource is read by (a leaf: src/scope.ts re-exports these, and Snapchat's scope hooks in
 * src/snapchat-adapter.ts read them; moved from src/scope.ts, ARC-01 phase B).
 */

/** The organization of GET /v1/organizations/{id}/pixels: the only organization read an account binding reaches. */
export function snapchatOrganizationPixels(path: string): string | undefined {
  return /^\/v1\/organizations\/([\w-]{1,64})\/pixels$/.exec(path)?.[1];
}
/** The global Snapchat entity that scopes a path (campaigns/<id>, adsquads/<id>, …), as held in resource ownership. */
export function snapchatScopedResource(path: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  return /^\/v1\/(campaigns|adsquads|ads|creatives|media|pixels|lead_generation_forms|segments)\/([^/]+)/
    .exec(decoded)
    ?.slice(1)
    .join('/');
}

const plain = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
const records = (v: unknown): JsonObject[] => (Array.isArray(v) ? v.map(plain) : []);
/**
 * The other resources a refused Snapchat call needs owned, besides the one its refusal names (r25-field-snap, the field
 * report of 2026-11-19, #8), as the paths their reads use, campaigns first, then ad squads, ads and creatives. An edit or a
 * create reads its ad squad, the ad squad's campaign and the ad it changes, and each read needs its own ownership
 * observation, which lapses after five minutes on its own: the call names the ad squad, the ad and the creatives its ad
 * records reference (its path parameters and records), and the ad squad the first renewal returned names the campaign.
 * This only says where to look: MirrorService renews one of these only when this login observed it and the observation
 * lapsed, from the account's own list narrowed to its ID, so an ID a caller invents, or another login's, renews nothing.
 */
export function snapchatRenewalChain(call: JsonObject, rows: unknown): string[] {
  const named: Record<'campaigns' | 'adsquads' | 'ads' | 'creatives', Set<string>> = {
      campaigns: new Set(),
      adsquads: new Set(),
      ads: new Set(),
      creatives: new Set(),
    },
    add = (kind: keyof typeof named, id: unknown) => {
      if (typeof id === 'string' && /^[\w-]{1,64}$/.test(id)) named[kind].add(id);
    };
  const params = plain(call.path_params),
    payload = plain(call.payload);
  add('campaigns', params.campaign_id);
  add('adsquads', params.ad_squad_id);
  add('ads', params.ad_id);
  for (const squad of records(payload.adsquads)) add('adsquads', squad.id);
  for (const ad of records(payload.ads)) {
    add('ads', ad.id);
    add('creatives', ad.creative_id);
  }
  // The campaign of each ad squad the account list returned: an ad's review reads it as well.
  for (const wrapped of records(plain(rows).adsquads)) add('campaigns', plain(wrapped.adsquad ?? wrapped).campaign_id);
  return Object.entries(named).flatMap(([kind, ids]) => [...ids].map(id => '/v1/' + kind + '/' + id));
}
