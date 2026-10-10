import type {Store} from './store.js';
import type {JsonObject} from './types.js';

/**
 * How much friction reviewed writes meet (WRT-05 Stage F), read from the audit the review service already writes:
 * prepare-to-execute latency and the rates of expired reviews, changed state, refused acknowledgements, uncertain
 * outcomes and requests not sent, per 100 prepares. Read-only and owner-only. It holds codes, counts and field paths,
 * never values: STATE_CHANGED names JSON paths, which name the provider's fields and not their contents. The five-minute
 * review window stays until this baseline has been read (owner decision P5).
 */
const acknowledgementCodes = [
  'CONFIRMATION_REQUIRED',
  'SPEND_CONFIRMATION_REQUIRED',
  'CAP_CONFIRMATION_REQUIRED',
  'CREATIVE_EDIT_CONFIRMATION_REQUIRED',
];
const counted = ['REVIEW_EXPIRED', 'STATE_CHANGED', ...acknowledgementCodes, 'WRITE_OUTCOME_UNCERTAIN'];
/** Rows read at most; a busier window reports `complete: false`. */
export const frictionScanLimit = 50000;
const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! : null;
const rate = (n: number, prepares: number) => (prepares ? Math.round((n / prepares) * 10000) / 100 : null);
const path = (v: unknown) => (typeof v === 'string' && v.length <= 300 && !/[\u0000-\u001f]/.test(v) ? v : undefined);

export function reviewFriction(store: Store, tenant: string, days = 30, now = Date.now()): JsonObject {
  const since = now - days * 86400000;
  const rows = store.db
    .prepare(
      `SELECT request_id, event, created_at FROM audit WHERE tenant_id=? AND created_at>=? AND created_at<=?
        AND (instr(event,'"event":"write_')>0 OR instr(event,'"tool":"amcp_write"')>0) ORDER BY seq LIMIT ?`,
    )
    .all(tenant, since, now, frictionScanLimit + 1) as {request_id: string; event: string; created_at: number}[];
  const complete = rows.length <= frictionScanLimit;
  const prepared = new Map<string, number>(),
    latencies: number[] = [],
    codes: Record<string, number> = Object.fromEntries(counted.map(c => [c, 0])),
    notSent: Record<string, number> = {},
    changedPaths = new Map<string, number>();
  let prepares = 0,
    executes = 0,
    notSentTotal = 0;
  for (const row of rows.slice(0, frictionScanLimit)) {
    let event: JsonObject;
    try {
      event = JSON.parse(row.event);
    } catch {
      continue;
    }
    if (event.event === 'write_prepared') {
      prepares++;
      prepared.set(row.request_id, row.created_at);
    } else if (event.event === 'write_started') {
      executes++;
      const at = prepared.get(row.request_id);
      if (at !== undefined) latencies.push(row.created_at - at);
    } else if (event.event === 'write_not_sent') {
      notSentTotal++;
      const code = typeof event.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(event.code) ? event.code : 'UNKNOWN';
      notSent[code] = (notSent[code] ?? 0) + 1;
    } else if (event.tool === 'amcp_write' && event.outcome?.success === false) {
      const code = event.outcome.error?.code;
      if (typeof code !== 'string' || !Object.hasOwn(codes, code)) continue;
      codes[code]!++;
      if (code === 'STATE_CHANGED')
        for (const field of Array.isArray(event.outcome.error.details?.changed_fields)
          ? event.outcome.error.details.changed_fields
          : []) {
          const p = path(field);
          if (p) changedPaths.set(p, (changedPaths.get(p) ?? 0) + 1);
        }
    }
  }
  latencies.sort((a, b) => a - b);
  const acknowledgements = acknowledgementCodes.reduce((n, c) => n + codes[c]!, 0);
  return {
    window_days: days,
    since,
    until: now,
    complete,
    rows_read: Math.min(rows.length, frictionScanLimit),
    prepares,
    executes,
    latency_ms: {
      count: latencies.length,
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      p99: percentile(latencies, 99),
      max: latencies.at(-1) ?? null,
    },
    counts: {...codes, acknowledgement_refusals: acknowledgements, write_not_sent: notSentTotal},
    per_100_prepares: {
      review_expired: rate(codes.REVIEW_EXPIRED!, prepares),
      state_changed: rate(codes.STATE_CHANGED!, prepares),
      acknowledgement_refusals: rate(acknowledgements, prepares),
      write_outcome_uncertain: rate(codes.WRITE_OUTCOME_UNCERTAIN!, prepares),
      write_not_sent: rate(notSentTotal, prepares),
    },
    not_sent_codes: notSent,
    state_changed_paths: [...changedPaths]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 10)
      .map(([field, count]) => ({path: field, count})),
    meaning:
      'Counts from this workspace’s audit of amcp_write over the window: latency from prepare to the start of execute (nearest-rank percentiles), and refusals per 100 prepares. Field paths only, never values. A baseline for the five-minute review window, not a measure of any one review.',
  };
}
