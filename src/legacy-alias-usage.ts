import {googleLegacyCoverage} from './google-legacy.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {googleAdsRequestActions} from './audit-repository.js';

const day = 86400000;
/** Audit rows read at most, like the review-friction baseline; a busier window reports `complete: false`. */
export const aliasScanLimit = 50000;
let legacyNames: Set<string> | undefined;
/**
 * The owner's baseline of the legacy Google action names (MCP-10 item 8, owner question Q23): over the last 30 days, how
 * many Google Ads requests this workspace's audit records were planned under one of the 285 legacy alias names rather
 * than a canonical action, and which names. It reads AMCP's own audit (the request plan of each preview and each
 * request sent) and changes nothing; the owner decides on hiding the aliases once the baseline exists.
 */
export function legacyAliasUsage(store: Store, actor: Actor, now = Date.now(), days = 30): JsonObject {
  legacyNames ??= new Set(googleLegacyCoverage().entries.map(e => e.action));
  const since = now - days * day,
    rows = googleAdsRequestActions(store, actor.tenantId, since, aliasScanLimit + 1);
  // One request is counted once, under the action it was planned with, however many events it recorded.
  const requests = new Map<string, string>();
  for (const row of rows.slice(0, aliasScanLimit))
    if (typeof row.action === 'string' && !requests.has(row.request_id)) requests.set(row.request_id, row.action);
  const counts = new Map<string, number>();
  for (const action of requests.values())
    if (legacyNames.has(action)) counts.set(action, (counts.get(action) ?? 0) + 1);
  const legacy = [...counts.values()].reduce((a, b) => a + b, 0);
  return {
    window_days: days,
    since: new Date(since).toISOString(),
    google_requests: requests.size,
    legacy_requests: legacy,
    legacy_share: requests.size ? Math.round((legacy / requests.size) * 10000) / 10000 : null,
    top_legacy_actions: [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))
      .slice(0, 10)
      .map(([action, count]) => ({action, count})),
    legacy_alias_names: legacyNames.size,
    complete: rows.length <= aliasScanLimit,
    computed_at: new Date(now).toISOString(),
    meaning:
      'Google Ads requests planned in this window, and how many used a legacy alias name instead of a canonical action. A baseline for deciding whether to hide the aliases from default listings; nothing is hidden yet.',
  };
}
/** How long owner health reuses a workspace's baseline: it is a 30-day figure, and each scan reads up to 50,000 rows. */
export const aliasUsageCacheMs = 3600000;
const aliasUsageCache = new WeakMap<Store, Map<string, {at: number; value: JsonObject}>>();
/**
 * The baseline as owner health shows it: computed at most once an hour per workspace in this process (computed_at says
 * when), so a busy workspace's health view does not rescan its audit on every load (wave 2 review).
 */
export function cachedLegacyAliasUsage(store: Store, actor: Actor, now = Date.now()): JsonObject {
  let byTenant = aliasUsageCache.get(store);
  if (!byTenant) aliasUsageCache.set(store, (byTenant = new Map()));
  const hit = byTenant.get(actor.tenantId);
  if (hit && now >= hit.at && now - hit.at < aliasUsageCacheMs) return structuredClone(hit.value);
  const value = legacyAliasUsage(store, actor, now);
  byTenant.set(actor.tenantId, {at: now, value});
  return structuredClone(value);
}
