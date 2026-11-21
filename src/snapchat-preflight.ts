import type {MirrorService} from './service.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import type {CampaignPreflight} from './provider-adapter.js';
import {snapAdPrerequisites} from './snapchat-ad-prerequisites.js';

// Snapchat's part of a campaign plan's preflight, its adapter's `campaign.preflight` (ARC-01 phase B, wave 4c: moved
// verbatim from src/campaign-preflight.ts, which keeps every check a step passes and their order).

/**
 * The placeholder of a predecessor's ID while a contract is checked: a UUID whose last twelve hex digits are the number of the result the
 * reference names (src/plan-reference-standins.ts; R2.5 r25-field3-refs, AMCP-01), so that two different results are two different IDs.
 */
const snapSymbolicPrefix = '00000000-0000-4000-8000-';
export const snapSymbolicId = (ordinal: number): string => snapSymbolicPrefix + ordinal.toString(16).padStart(12, '0');
// Snapchat rejects an ad squad pixel the ad account does not own (E2405) only when the ad squad is
// written. Compare with that account's own pixel list first. null = list unreadable (deferred).
async function snapchatPixelsOwned(
  service: MirrorService,
  actor: Actor,
  plan: CompiledRequest,
  connectionId: string,
  account: string,
  cache: Map<string, Set<string> | null>,
): Promise<boolean | null | undefined> {
  if (!/^\/v1\/campaigns\/[^/]+\/adsquads$/.test(plan.path)) return undefined;
  const rows = (plan.body as JsonObject | undefined)?.adsquads,
    wanted = [
      ...new Set(
        (Array.isArray(rows) ? rows : [])
          .map((r: JsonObject) => r?.pixel_id)
          .filter((id: unknown): id is string => typeof id === 'string' && !id.startsWith(snapSymbolicPrefix)),
      ),
    ];
  if (!wanted.length) return undefined;
  const key = connectionId + ':' + account;
  if (!cache.has(key)) {
    const read: CompiledRequest = {
      gateway: plan.gateway,
      accountId: account,
      action: 'AMCP_PREFLIGHT_PIXELS',
      method: 'GET',
      path: '/v1/adaccounts/' + account + '/pixels',
      query: {},
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'AMCP ad account pixel ownership read',
      warnings: [],
    };
    try {
      const out = (await service.runPlan(
          read,
          {connection_id: connectionId, aggregate_pages: true, max_pages: 25},
          actor,
        )) as JsonObject,
        d = out.data ?? {};
      cache.set(
        key,
        out.truncated || !Array.isArray(d.pixels)
          ? null
          : new Set(
              d.pixels
                .map((w: JsonObject) => w?.pixel?.id)
                .filter((id: unknown): id is string => typeof id === 'string'),
            ),
      );
    } catch (e) {
      if (!(e instanceof MirrorError)) throw e;
      cache.set(key, null);
    }
  }
  const owned = cache.get(key);
  if (!owned) return null;
  const missing = wanted.filter(id => !owned.has(id));
  if (missing.length)
    throw new MirrorError(
      'SNAPCHAT_PIXEL_NOT_OWNED',
      'Snapchat accepts only pixels owned by this ad account. Use an owned pixel, or share this pixel to the ad account in Snapchat Business Manager first.',
      {pixel_ids: missing, owned_pixel_ids: [...owned].sort()},
    );
  return true;
}
/**
 * A predecessor's ID is the symbolic UUID while the contract is checked; an ad squad's pixels must be the ad
 * account's (a pixel list that cannot be read defers the check to the ad squad's review); an ad's creatives are read.
 */
export const snapchatPreflight: CampaignPreflight = Object.freeze<CampaignPreflight>({
  reference: ({ordinal}) => snapSymbolicId(ordinal),
  async contract(plan: CompiledRequest, {service, actor, connectionId, account, cache}) {
    if (
      (await snapchatPixelsOwned(
        service,
        actor,
        plan,
        connectionId,
        account,
        cache as Map<string, Set<string> | null>,
      )) === null
    )
      return {
        fields: ['pixel_id'],
        reason:
          'The ad account pixel list could not be read; Snapchat validates pixel ownership when the ad squad is written.',
      };
    return undefined;
  },
  prerequisites: (plan: CompiledRequest, {service, actor, connectionId, validateState}, refs: string[]) =>
    snapAdPrerequisites(service, actor, plan, connectionId, refs, validateState),
});
