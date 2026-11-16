import type {CompiledRequest} from './types.js';
import type {UsageObservation, UsageProfile} from './provider-usage.js';
import {errorObject} from './provider-error-core.js';

// Meta's usage headers (R2.5 M2, package r25-m2-refusal; MT3), which its wire profile reads on every response (src/meta-adapter.ts,
// `wire.usage`). Meta documents three (developers.facebook.com, Graph API "Rate Limiting" and Marketing API "Rate Limiting"):
//  - X-App-Usage, {"call_count": 28, "total_time": 25, "total_cputime": 25}: the percentage of the app's calls, total time and CPU
//    time used, for the app the login belongs to. It is the login's limit, shared by every account of it.
//  - X-Ad-Account-Usage, {"acc_id_util_pct": 9.67, "reset_time_duration": 100, "ads_api_access_tier": "standard_access"}: the
//    percentage of one ad account's allowance used, and the seconds until its usage resets.
//  - X-Business-Use-Case-Usage, {"<business object id>": [{"type": "ads_management", "call_count": 100, "total_cputime": 25,
//    "total_time": 25, "estimated_time_to_regain_access": 19, "ads_api_access_tier": "standard_access"}]}: per business object and
//    rate-limit type, the percentages and, once the object is blocked, the minutes until it is not.
// Meta throttles a bucket when a percentage passes 100: the app's and the ad account's are blocked above 100 (an ad account says
// for how many seconds), and a business use case is blocked when it names the minutes until access is regained, which is the only
// sign Meta gives of it (S3-1 of the lead's review: at 100, or at 100 and beyond with no wait named, nothing is blocked yet). A
// business use case limits the requests of its own type alone: AMCP counts a request in ads_insights where it reads Insights and
// in ads_management otherwise, and any other type Meta lists is shown and never paces. Only the numbers are kept; a type, the one
// word that names a bucket, is kept as a token, and nothing else of a header ever reaches the governor, so provider text can never
// become a scope.

/** A header longer than this, a list longer than this and a figure beyond this are not what Meta sends. */
const maxHeader = 16384;
const maxObjects = 50;
const maxEntries = 50;
const maxPercent = 1000;
const dayMs = 86400000;
const typeToken = /^[a-z][a-z0-9_]{0,63}$/;

function parse(header: string | null): Record<string, any> {
  if (!header || header.length > maxHeader) return {};
  try {
    return errorObject(JSON.parse(header));
  } catch {
    return {};
  }
}
/** A percentage: a finite number from 0 up to what no real bucket reaches. */
const percent = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maxPercent ? value : undefined;
/** The worst of a bucket's percentages, or undefined when it holds none. */
function worst(values: unknown[]): number | undefined {
  const found = values.map(percent).filter((p): p is number => p !== undefined);
  return found.length ? Math.max(...found) : undefined;
}
/** A wait in milliseconds from a figure in `unit` milliseconds, or undefined unless it is a positive, finite figure. */
function wait(value: unknown, unit: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(dayMs, Math.ceil(value * unit))
    : undefined;
}

/**
 * What a Meta response's three usage headers say of the login's app, the ad account the request names and its business use
 * cases. A bucket that is blocked says so, and for how long where Meta names it: a business use case that names minutes, and an ad
 * account over its limit that names seconds (below it the seconds are only the window's reset, which is no wait); the app over its
 * limit names none. A business use case is the request's account's alone: Meta also lists the other objects a call touched, whose
 * limits are not this account's. A header that is not what Meta documents gives nothing and never throws.
 */
export function metaUsageObservations(headers: Headers, plan: CompiledRequest): UsageObservation[] {
  const found: UsageObservation[] = [];
  const app = parse(headers.get('x-app-usage')),
    appUsage = worst([app.call_count, app.total_time, app.total_cputime]);
  if (appUsage !== undefined)
    found.push({
      level: 'login',
      scope: 'app',
      usage_pct: appUsage,
      ...(appUsage > 100 ? {blocked: true as const} : {}),
    });
  const account = parse(headers.get('x-ad-account-usage')),
    accountUsage = percent(account.acc_id_util_pct);
  if (accountUsage !== undefined) {
    const over = accountUsage > 100,
      regain = over ? wait(account.reset_time_duration, 1000) : undefined;
    found.push({
      level: 'account',
      scope: 'ad_account',
      usage_pct: accountUsage,
      ...(regain !== undefined ? {regain_ms: regain} : over ? {blocked: true as const} : {}),
    });
  }
  // The key of an object is the ad account's number, with no act_ prefix.
  const own = plan.accountId?.replace(/^act_/, '');
  if (own) {
    const objects = parse(headers.get('x-business-use-case-usage'));
    for (const [id, entries] of Object.entries(objects).slice(0, maxObjects)) {
      if (id !== own || !Array.isArray(entries)) continue;
      for (const entry of entries.slice(0, maxEntries)) {
        const e = errorObject(entry),
          usage = worst([e.call_count, e.total_cputime, e.total_time]);
        if (usage === undefined) continue;
        const regain = wait(e.estimated_time_to_regain_access, 60000);
        found.push({
          level: 'account',
          scope:
            typeof e.type === 'string' && typeToken.test(e.type) ? 'business_use_case:' + e.type : 'business_use_case',
          usage_pct: usage,
          requestScoped: true,
          ...(regain !== undefined ? {regain_ms: regain} : {}),
        });
      }
    }
  }
  return found;
}

/** Whether a request reads Insights, which Meta counts in its own business use case (src/meta-adapter.ts, `wire.reportData`). */
export const metaInsightsRead = (plan: CompiledRequest): boolean => /\/insights$/.test(plan.path);
/** The business use cases AMCP can tell a request's from: the ones `metaRequestScope` names. */
export const metaRequestScopes: readonly string[] = Object.freeze([
  'business_use_case:ads_insights',
  'business_use_case:ads_management',
]);
/**
 * The business use case a request of an ad account is counted in: Insights reads in ads_insights, every other request in
 * ads_management. A request that names no account is counted in none.
 */
export const metaRequestScope = (plan: CompiledRequest): string | undefined =>
  plan.accountId ? 'business_use_case:' + (metaInsightsRead(plan) ? 'ads_insights' : 'ads_management') : undefined;
/** Meta's wire profile of its usage (src/meta-adapter.ts, `wire.usage`). */
export const metaUsage: UsageProfile = Object.freeze({
  exposed: true,
  read: metaUsageObservations,
  scopeOf: metaRequestScope,
  scopes: metaRequestScopes,
});
