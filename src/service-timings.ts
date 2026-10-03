import type {Store} from './store.js';
import type {JsonObject} from './types.js';

export const serviceTimingCategories = [
  'workspace',
  'campaign',
  'analysis',
  'overview',
  'preview',
  'media',
  'write',
  'native_other',
] as const;
export type ServiceTimingCategory = (typeof serviceTimingCategories)[number];
const windowMs = 15 * 60 * 1000,
  maxAttempts = 1000000;
const boundsUs = [25000, 100000, 500000, 2000000, 10000000, 60000000];
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const validTime = (n: unknown): n is number => integer(n) && n < 8640000000000000 - windowMs;
const category = (value: unknown): value is ServiceTimingCategory =>
  serviceTimingCategories.includes(value as ServiceTimingCategory);
function counter(raw: JsonObject | undefined, id: string): JsonObject | undefined {
  if (
    !raw ||
    raw.version !== 1 ||
    raw.category !== id ||
    !category(id) ||
    !validTime(raw.window_start_ms) ||
    raw.window_start_ms % windowMs !== 0 ||
    !validTime(raw.first_observed_at) ||
    !validTime(raw.last_observed_at) ||
    raw.first_observed_at < raw.window_start_ms ||
    raw.last_observed_at < raw.first_observed_at ||
    raw.last_observed_at >= raw.window_start_ms + windowMs ||
    !['attempts', 'successes', 'errors', 'total_us', 'omitted_count'].every(key => integer(raw[key])) ||
    raw.attempts > maxAttempts ||
    raw.successes + raw.errors !== raw.attempts ||
    !Array.isArray(raw.buckets) ||
    raw.buckets.length !== boundsUs.length + 1 ||
    raw.buckets.some((n: unknown) => !integer(n)) ||
    raw.buckets.reduce((sum: number, n: number) => sum + n, 0) !== raw.attempts ||
    typeof raw.saturated !== 'boolean' ||
    !['initial', 'new_window', 'clock_changed', 'invalid_counter'].includes(raw.reset_reason)
  )
    return undefined;
  if (
    raw.attempts === 0
      ? raw.min_us !== null || raw.max_us !== null || raw.total_us !== 0
      : !integer(raw.min_us) ||
        !integer(raw.max_us) ||
        raw.min_us > raw.max_us ||
        raw.total_us < raw.min_us * raw.attempts ||
        raw.total_us > raw.max_us * raw.attempts
  )
    return undefined;
  return Object.fromEntries(
    [
      'version',
      'category',
      'window_start_ms',
      'first_observed_at',
      'last_observed_at',
      'attempts',
      'successes',
      'errors',
      'total_us',
      'min_us',
      'max_us',
      'buckets',
      'omitted_count',
      'saturated',
      'reset_reason',
    ].map(key => [key, raw[key]]),
  );
}
function load(data: unknown, id: string) {
  try {
    return counter(typeof data === 'string' ? JSON.parse(data) : undefined, id);
  } catch {
    return undefined;
  }
}
function fresh(id: ServiceTimingCategory, now: number, reason: string): JsonObject {
  return {
    version: 1,
    category: id,
    window_start_ms: Math.floor(now / windowMs) * windowMs,
    first_observed_at: now,
    last_observed_at: now,
    attempts: 0,
    successes: 0,
    errors: 0,
    total_us: 0,
    min_us: null,
    max_us: null,
    buckets: boundsUs.map(() => 0).concat(0),
    omitted_count: 0,
    saturated: false,
    reset_reason: reason,
  };
}
/** One fixed-size record per category/workspace; no input, account, actor, URL, error text or provider response. */
export function recordServiceTiming(
  store: Store,
  tenant: string,
  id: ServiceTimingCategory,
  elapsedMs: number,
  success: boolean,
  now = Date.now(),
) {
  if (!category(id) || !validTime(now) || typeof success !== 'boolean')
    throw TypeError('Invalid timing sample metadata');
  const us =
    typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0
      ? Math.round(elapsedMs * 1000)
      : Number.NaN;
  store.transaction(() => {
    const raw = store.db
      .prepare("SELECT data FROM documents WHERE tenant_id=? AND kind='service_timings' AND id=?")
      .get(tenant, id) as JsonObject | undefined;
    const previous = load(raw?.data, id);
    let next = previous;
    if (!next) next = fresh(id, now, raw ? 'invalid_counter' : 'initial');
    else if (now < next.last_observed_at) next = fresh(id, now, 'clock_changed');
    else if (next.window_start_ms !== Math.floor(now / windowMs) * windowMs) next = fresh(id, now, 'new_window');
    next.last_observed_at = now;
    if (!integer(us) || next.attempts >= maxAttempts || !Number.isSafeInteger(next.total_us + us)) {
      next.omitted_count = Math.min(Number.MAX_SAFE_INTEGER, next.omitted_count + 1);
      next.saturated =
        next.saturated || next.attempts >= maxAttempts || (integer(us) && !Number.isSafeInteger(next.total_us + us));
    } else {
      next.attempts++;
      next[success ? 'successes' : 'errors']++;
      next.total_us += us;
      next.min_us = next.min_us === null ? us : Math.min(next.min_us, us);
      next.max_us = next.max_us === null ? us : Math.max(next.max_us, us);
      const index = boundsUs.findIndex(bound => us <= bound);
      next.buckets[index < 0 ? boundsUs.length : index]++;
    }
    store.putDocument(tenant, 'service_timings', id, next);
  });
}
function percentile(value: JsonObject, fraction: number) {
  if (!value.attempts) return null;
  const target = Math.ceil(value.attempts * fraction);
  let count = 0;
  for (let index = 0; index < value.buckets.length; index++) {
    count += value.buckets[index];
    if (count >= target)
      return {
        lower_ms: index ? boundsUs[index - 1]! / 1000 : 0,
        upper_ms: index === boundsUs.length ? null : boundsUs[index]! / 1000,
      };
  }
  return null;
}
export function serviceTimings(store: Store, tenant: string, now = Date.now()) {
  if (!validTime(now)) throw TypeError('Invalid timing observation clock');
  const records = store.db
    .prepare(
      "SELECT id,data FROM documents WHERE tenant_id=? AND kind='service_timings' AND id IN (" +
        serviceTimingCategories.map(() => '?').join(',') +
        ')',
    )
    .all(tenant, ...serviceTimingCategories) as JsonObject[];
  const items: JsonObject[] = [];
  let unavailable = 0;
  for (const row of records) {
    const value = load(row.data, row.id);
    if (!value) {
      unavailable++;
      continue;
    }
    if (value.window_start_ms !== Math.floor(now / windowMs) * windowMs || now < value.last_observed_at) continue;
    items.push({
      category: row.id,
      attempts: value.attempts,
      successes: value.successes,
      errors: value.errors,
      observed_from: value.first_observed_at,
      observed_to: value.last_observed_at,
      mean_ms: value.attempts ? Math.round(value.total_us / value.attempts) / 1000 : null,
      minimum_ms: value.min_us === null ? null : value.min_us / 1000,
      maximum_ms: value.max_us === null ? null : value.max_us / 1000,
      p50_bucket: percentile(value, 0.5),
      p95_bucket: percentile(value, 0.95),
      omitted_count: value.omitted_count,
      saturated: value.saturated,
      reset_reason: value.reset_reason,
    });
  }
  return {
    version: 1,
    at: now,
    window_start_ms: Math.floor(now / windowMs) * windowMs,
    window_ms: windowMs,
    items,
    unavailable_counters: unavailable,
    persistence_failures_in_this_process: store.serviceTimingFailures,
    scope:
      'Completed tool attempts in this workspace and current fixed 15-minute interval. Timings measure work inside the tool handler, before timing storage and response delivery; HTTP queueing, response serialization and client network delivery are excluded. Internal calls and ownership refresh attempts are included; native HTTP request counts are separate. Current in-flight attempts are excluded. Success and error counts describe response envelopes, not business outcomes. Percentile buckets are bounds, not exact percentile latencies. Counter gaps and omitted measurements are explicit.',
  };
}
