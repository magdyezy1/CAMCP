import type {Store} from './store.js';
import type {JsonObject} from './types.js';
import {stateChangedRefusals, writeAuditEvents} from './audit-repository.js';

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
/** Refusals that wait for a person's decision outside the AI client (WRT-09), reported with the approvals. */
const approvalCodes = ['HUMAN_APPROVAL_REQUIRED', 'CAP_OVERRIDE_OWNER_REQUIRED', 'DESTRUCTIVE_CONFIRMATION_REQUIRED'];
/** Rows read at most; a busier window reports `complete: false`. */
export const frictionScanLimit = 50000;
const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! : null;
const rate = (n: number, prepares: number) => (prepares ? Math.round((n / prepares) * 10000) / 100 : null);
const path = (v: unknown) => (typeof v === 'string' && v.length <= 300 && !/[\u0000-\u001f]/.test(v) ? v : undefined);

/**
 * Audit rows a refusal looks back over, newest first, and the refusals it reads from them: a bound, not a window. A refusal
 * is rare and its read runs on the request path, so it is kept to a few thousand rows (a busy launch writes a few rows per
 * write, so this is hours of one), and the paths that recur are the ones that change on every prepare, not once a month.
 */
export const recurringScanRows = 5000;
const recurringRefusals = 200;
/** How many recurring paths a refusal lists, the most often named first: the top ten of the owner's view. */
export const recurringPathLimit = 10;

/**
 * The paths of a STATE_CHANGED refusal that the workspace's recent refusals of the same provider named too (R25 M1,
 * L5-04): the answer of the friction data to "is this a one-off, or does it change on every prepare". The refusal lists
 * them as `recurring_paths`, and its remedy asks the agent to report them: a field that changes by itself is probably being
 * compared. Paths only, never values, read from the same audit as `state_changed_paths`. The refusal being raised is not
 * in the audit yet, and the review it concerns (`options.review`) is left out, so one review refused twice is one prepare
 * and does not recur. Refusals written before they carried the provider's name are not attributed to any provider.
 *
 * Undefined when the audit cannot be read: recurrence is then unknown, never an empty answer made up.
 */
export function recurringStatePaths(
  store: Store,
  tenant: string,
  gateway: string,
  paths: readonly string[],
  options: {review?: string; now?: number; days?: number} = {},
): string[] | undefined {
  const wanted = new Set(paths);
  if (!wanted.size) return [];
  const now = options.now ?? Date.now();
  let rows: {event: string}[];
  try {
    rows = stateChangedRefusals(
      store,
      tenant,
      now - (options.days ?? 30) * 86400000,
      now,
      recurringScanRows,
      recurringRefusals,
    );
  } catch {
    return undefined;
  }
  const named = new Map<string, number>();
  for (const row of rows) {
    let event: JsonObject;
    try {
      event = JSON.parse(row.event);
    } catch {
      continue;
    }
    const error = event.outcome?.success === false ? event.outcome.error : undefined;
    if (error?.code !== 'STATE_CHANGED' || error.details?.gateway !== gateway) continue;
    if (options.review !== undefined && event.input?.review_id === options.review) continue;
    const fields: unknown[] = Array.isArray(error.details.changed_fields) ? error.details.changed_fields : [];
    for (const field of new Set(fields))
      if (typeof field === 'string' && wanted.has(field)) named.set(field, (named.get(field) ?? 0) + 1);
  }
  return [...named]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, recurringPathLimit)
    .map(([field]) => field);
}

/** The paths named most often, the most first (ties by path), as the owner's view lists them: ten at most. */
const topPaths = (named: ReadonlyMap<string, number>) =>
  [...named]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 10)
    .map(([field, count]) => ({path: field, count}));
/** The refusals of a media review the report counts: an expired review and a changed state (L6-11, R25 M1). */
const mediaCounted = ['REVIEW_EXPIRED', 'STATE_CHANGED'];
/** The changed paths a refusal names, as the report keeps them: paths only, never values. */
const changedPathsOf = (error: JsonObject): string[] =>
  (Array.isArray(error.details?.changed_fields) ? error.details.changed_fields : [])
    .map(path)
    .filter((p: string | undefined): p is string => p !== undefined);
/**
 * When a path counts as one that changes on many prepares (R25 M1, design item 4 of the plan's idea 1): it explains more
 * than 5 in 100 of a provider's prepares, with at least three reviews refused for it, on a provider with at least twenty
 * prepares. The share is the owner's baseline read as a rate (7 STATE_CHANGED in 313 prepares was 2.2 in 100 over every
 * provider and path, and every one a field that changes by itself); the two minimums keep one refusal of ten prepares from
 * being an alarm. Shown beside the alarms, so a rate is read against its rule.
 *
 * The three numbers are a provisional lead decision, taken on 2026-11-16 (the lead's review of this package, decision 4),
 * and stay so until the owner's post-deploy friction baseline replaces them; they were the implementer's proposal until
 * then, not the owner's.
 */
export const volatilePathRule = Object.freeze({per_100_prepares: 5, minimum_refusals: 3, minimum_prepares: 20});
/** The gateway a prepared review is of: its write's, or its upload's platform. */
const gatewayOf = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-z0-9_]{1,80}$/.test(value) ? value : undefined;
/** The review a refusal row is of: the one its call named, or, for a row written without it, the row itself. */
const reviewOf = (event: JsonObject, row: {request_id: string}): string =>
  typeof event.input?.review_id === 'string' && event.input.review_id ? event.input.review_id : 'row:' + row.request_id;

export function reviewFriction(store: Store, tenant: string, days = 30, now = Date.now()): JsonObject {
  const since = now - days * 86400000;
  const rows = writeAuditEvents(store, tenant, since, now, frictionScanLimit + 1);
  const complete = rows.length <= frictionScanLimit;
  const prepared = new Map<string, number>(),
    latencies: number[] = [],
    codes: Record<string, number> = Object.fromEntries(counted.map(c => [c, 0])),
    notSent: Record<string, number> = {},
    changedPaths = new Map<string, number>(),
    // L6-11: media reviews, counted apart. A media review executed through amcp_write (a campaign plan's step does) is
    // told by its review id from the media reviews prepared, so it is a media refusal and not a write one.
    mediaReviews = new Set<string>(),
    mediaCodes: Record<string, number> = Object.fromEntries(mediaCounted.map(c => [c, 0])),
    mediaPaths = new Map<string, number>(),
    // The alarm: each provider's prepares (writes and uploads) and, for each path, the reviews a refusal named it for: a
    // review, not a refusal row, so one stale review executed again and again is one prepare refused, as `recurring_paths`
    // counts it (lead review S3-4). A refusal row without its review is a review of its own.
    providerPrepares = new Map<string, number>(),
    providerPaths = new Map<string, Map<string, Set<string>>>(),
    noteProviderPrepare = (gateway: unknown) => {
      const g = gatewayOf(gateway);
      if (g) providerPrepares.set(g, (providerPrepares.get(g) ?? 0) + 1);
    },
    noteProviderPaths = (error: JsonObject, review: string) => {
      const g = gatewayOf(error.details?.gateway);
      if (!g) return;
      const named = providerPaths.get(g) ?? new Map<string, Set<string>>();
      for (const p of new Set(changedPathsOf(error))) named.set(p, (named.get(p) ?? new Set<string>()).add(review));
      providerPaths.set(g, named);
    },
    // WRT-09: website approvals, the time from prepare to a person's approval, and the refusals that wait for one.
    groupPrepared = new Map<string, number>(),
    approvalLatencies: number[] = [],
    approvalRefusals: Record<string, number> = Object.fromEntries(approvalCodes.map(c => [c, 0]));
  let prepares = 0,
    executes = 0,
    mediaPrepares = 0,
    mediaExecutes = 0,
    notSentTotal = 0,
    approvals = 0,
    ownerApprovals = 0;
  for (const row of rows.slice(0, frictionScanLimit)) {
    let event: JsonObject;
    try {
      event = JSON.parse(row.event);
    } catch {
      continue;
    }
    if (event.event === 'media_prepared' || event.event === 'media_library_prepared') {
      mediaPrepares++;
      mediaReviews.add(row.request_id);
      // An upload's platform is its provider's gateway without the suffix (`tiktok` for tiktok_native_action).
      if (typeof event.plan?.platform === 'string') noteProviderPrepare(event.plan.platform + '_native_action');
    } else if (event.event === 'media_uploaded' || event.event === 'media_upload_incomplete')
      // An upload that reached the provider, completed or not: the media analogue of a write's execute.
      mediaExecutes++;
    else if (
      event.outcome?.success === false &&
      (event.tool === 'amcp_media' ||
        (event.tool === 'amcp_write' &&
          typeof event.input?.review_id === 'string' &&
          mediaReviews.has(event.input.review_id)))
    ) {
      const code = event.outcome.error?.code;
      if (typeof code !== 'string' || !mediaCounted.includes(code)) continue;
      mediaCodes[code]!++;
      if (code === 'STATE_CHANGED') {
        for (const p of changedPathsOf(event.outcome.error)) mediaPaths.set(p, (mediaPaths.get(p) ?? 0) + 1);
        noteProviderPaths(event.outcome.error, reviewOf(event, row));
      }
    } else if (event.event === 'write_prepared') {
      prepares++;
      prepared.set(row.request_id, row.created_at);
      noteProviderPrepare(event.request?.gateway);
    } else if (event.event === 'write_group_prepared') groupPrepared.set(row.request_id, row.created_at);
    else if (event.event === 'write_approved') {
      approvals++;
      if (event.approver_is_owner === true) ownerApprovals++;
      const at = prepared.get(row.request_id) ?? groupPrepared.get(row.request_id);
      if (at !== undefined) approvalLatencies.push(row.created_at - at);
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
      if (typeof code === 'string' && Object.hasOwn(approvalRefusals, code)) approvalRefusals[code]!++;
      if (typeof code !== 'string' || !Object.hasOwn(codes, code)) continue;
      codes[code]!++;
      if (code === 'STATE_CHANGED') {
        for (const p of changedPathsOf(event.outcome.error)) changedPaths.set(p, (changedPaths.get(p) ?? 0) + 1);
        noteProviderPaths(event.outcome.error, reviewOf(event, row));
      }
    }
  }
  latencies.sort((a, b) => a - b);
  approvalLatencies.sort((a, b) => a - b);
  const acknowledgements = acknowledgementCodes.reduce((n, c) => n + codes[c]!, 0);
  // The alarm: a path that explains more than the rule's share of its provider's prepares, the worst first.
  const alarms = [...providerPaths]
    .flatMap(([gateway, named]) => {
      const providerPrepared = providerPrepares.get(gateway) ?? 0;
      if (providerPrepared < volatilePathRule.minimum_prepares) return [];
      return [...named]
        .map(([field, reviews]) => [field, reviews.size] as const)
        .filter(
          ([, refusals]) =>
            refusals >= volatilePathRule.minimum_refusals &&
            refusals / providerPrepared > volatilePathRule.per_100_prepares / 100,
        )
        .map(([field, refusals]) => ({
          gateway,
          path: field,
          refusals,
          prepares: providerPrepared,
          per_100_prepares: rate(refusals, providerPrepared),
        }));
    })
    .sort(
      (a, b) => b.refusals / b.prepares - a.refusals / a.prepares || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )
    .slice(0, 10);
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
    // WRT-09: a person's approvals on the website and the refusals that waited for one, against the baseline above.
    approvals: {
      approved: approvals,
      by_owner: ownerApprovals,
      per_100_prepares: rate(approvals, prepares),
      latency_ms: {
        count: approvalLatencies.length,
        p50: percentile(approvalLatencies, 50),
        p90: percentile(approvalLatencies, 90),
        max: approvalLatencies.at(-1) ?? null,
      },
      refusals: approvalRefusals,
    },
    state_changed_paths: topPaths(changedPaths),
    // R25 M1: the paths that explain more than a share of a provider's prepares: probably a field that changes by itself.
    volatile_path_alarms: alarms,
    volatile_path_rule: volatilePathRule,
    // L6-11 (R25 M1): the media reviews of amcp_media, counted as the writes are. Unknown rates stay null, never zero.
    media: {
      prepares: mediaPrepares,
      executes: mediaExecutes,
      counts: mediaCodes,
      per_100_prepares: {
        review_expired: rate(mediaCodes.REVIEW_EXPIRED!, mediaPrepares),
        state_changed: rate(mediaCodes.STATE_CHANGED!, mediaPrepares),
      },
      state_changed_paths: topPaths(mediaPaths),
    },
    meaning:
      'Counts from this workspace’s audit of amcp_write over the window: latency from prepare to the start of execute (nearest-rank percentiles), and refusals per 100 prepares. Media reviews (amcp_media, and a media review executed through amcp_write) are counted apart in media: the reviews prepared, the uploads that reached the provider, and the refusals for an expired review and a changed state. Field paths only, never values. A baseline for the five-minute review window, not a measure of any one review.',
  };
}
