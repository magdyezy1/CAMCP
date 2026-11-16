import type {CompiledRequest} from './types.js';
import type {UsageObservation} from './provider-usage.js';
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
// Meta throttles a bucket when a percentage passes 100. Only the numbers are kept; a type, the one word that names a bucket, is
// kept as a token, and nothing else of a header ever reaches the governor, so provider text can never become a scope.

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
 * cases. A bucket that is blocked says for how long: a business use case that names minutes, and an ad account at its limit that
 * names seconds (below its limit the seconds are only the window's reset, which is no wait). A business use case is the request's
 * account's alone: Meta also lists the other objects a call touched, whose limits are not this account's. A header that is not
 * what Meta documents gives nothing and never throws.
 */
export function metaUsageObservations(headers: Headers, plan: CompiledRequest): UsageObservation[] {
  const found: UsageObservation[] = [];
  const app = parse(headers.get('x-app-usage')),
    appUsage = worst([app.call_count, app.total_time, app.total_cputime]);
  if (appUsage !== undefined) found.push({level: 'login', scope: 'app', usage_pct: appUsage});
  const account = parse(headers.get('x-ad-account-usage')),
    accountUsage = percent(account.acc_id_util_pct);
  if (accountUsage !== undefined) {
    const regain = accountUsage >= 100 ? wait(account.reset_time_duration, 1000) : undefined;
    found.push({
      level: 'account',
      scope: 'ad_account',
      usage_pct: accountUsage,
      ...(regain !== undefined ? {regain_ms: regain} : {}),
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
          ...(regain !== undefined ? {regain_ms: regain} : {}),
        });
      }
    }
  }
  return found;
}
