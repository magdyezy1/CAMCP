import type {ReviewedFamily} from './reviewed-family.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {
  authorizeXCatalogRead,
  fail,
  httpsUrl,
  object,
  ownedCatalog,
  unverified,
  xCatalogFeeds,
  xCatalogGateway as gateway,
  xCatalogOwners,
  xCatalogVerificationVersion,
  xCatalogRead,
  xCatalogSource as source,
  xSnowflake,
  type Fetch,
} from './x-catalogs.js';
import {defineFamily} from './family-kit.js';

/**
 * Scheduled feeds of X catalogs, opened by the owner on 2026-09-29. X Ads API v12, "Catalog Management API Reference"
 * (docs.x.com, read 2026-09-29): "Scheduled Feeds configure the file location and frequency with which X ingests product
 * data into a user's catalog. Only one product feed is supported per user. Importing a scheduled feed is an additive
 * action — removing products from the feed does not delete them from the catalog." POST scheduled_feeds takes feed_url,
 * feed_format (CSV, TSV, XML), frequency (HOURLY, DAILY, WEEKLY), repeat ("Required for WEEKLY or HOURLY frequency":
 * MONDAY to SUNDAY, or 1, 2, 3, 4, 6, 8, 12; "DAILY: Do not include this parameter"), start_time (HH:MM) and time_zone
 * (IANA). PUT scheduled_feeds/:id changes any of them; DELETE is "a permanent deletion".
 *
 * AMCP accepts HTTPS feed addresses without credentials, like its other feed families.
 */
type Kind = 'create' | 'update' | 'delete';
type State = {kind: Kind; catalog: string; feed?: string; verify?: boolean};
type Read = CompiledRequest & {xScheduledFeedState?: State};
const fields = ['feed_url', 'feed_format', 'frequency', 'repeat', 'start_time', 'time_zone'],
  weekdays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'],
  hours = ['1', '2', '3', '4', '6', '8', '12'];
function invalid(message: string): never {
  return fail('INVALID_X_SCHEDULED_FEED', message, {source});
}
export function xScheduledFeedKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport) return;
  if (p.method === 'POST' && /^\/12\/product_catalogs\/[1-9][0-9]{0,24}\/scheduled_feeds$/.test(p.path))
    return 'create';
  if (/^\/12\/product_catalogs\/[1-9][0-9]{0,24}\/scheduled_feeds\/[1-9][0-9]{0,24}$/.test(p.path))
    return p.method === 'PUT' ? 'update' : p.method === 'DELETE' ? 'delete' : undefined;
}
const catalogOf = (p: CompiledRequest) => p.path.split('/')[3]!,
  feedOf = (p: CompiledRequest) => p.path.split('/')[5]!;
const body = (p: CompiledRequest): JsonObject => (object(p.body) ? p.body : {});
function zone(v: unknown): boolean {
  if (typeof v !== 'string' || !(v === 'UTC' || /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/.test(v))) return false;
  try {
    new Intl.DateTimeFormat('en', {timeZone: v});
    return true;
  } catch {
    return false;
  }
}
function checkField(k: string, v: unknown): void {
  if (k === 'feed_url' && !httpsUrl(v))
    invalid('feed_url is an HTTPS address without credentials in it, at most 2048 characters.');
  if (k === 'feed_format' && !['CSV', 'TSV', 'XML'].includes(String(v))) invalid('feed_format is CSV, TSV or XML.');
  if (k === 'frequency' && !['HOURLY', 'DAILY', 'WEEKLY'].includes(String(v)))
    invalid('frequency is HOURLY, DAILY or WEEKLY.');
  if (k === 'start_time' && !(typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)))
    invalid('start_time is the import time as HH:MM, such as "01:30".');
  if (k === 'time_zone' && !zone(v)) invalid('time_zone is an IANA time zone such as Asia/Riyadh.');
  if (k === 'repeat' && typeof v !== 'string') invalid('repeat is a string: a weekday name, or "1" to "12" hours.');
}
/** X's repeat rule for the schedule as it will stand. */
function checkRepeat(frequency: unknown, repeat: unknown): void {
  if (frequency === 'DAILY' && repeat !== undefined && repeat !== null)
    invalid('A DAILY feed takes no repeat ("DAILY: Do not include this parameter").');
  if (frequency === 'WEEKLY' && !weekdays.includes(String(repeat)))
    invalid('A WEEKLY feed needs repeat: the weekday, MONDAY to SUNDAY.');
  if (frequency === 'HOURLY' && !hours.includes(String(repeat)))
    invalid('An HOURLY feed needs repeat: "' + hours.join('", "') + '".');
}
export function assertXScheduledFeed(p: CompiledRequest): void {
  const kind = xScheduledFeedKind(p);
  if (!kind) return;
  if (typeof p.accountId !== 'string' || !p.accountId)
    fail('ACCOUNT_REQUIRED', 'Select the ad account whose promotable user owns the catalog.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Feed writes take their parameters in the body, without query or header overrides.');
  if (kind === 'delete') {
    if (p.body !== undefined && !(object(p.body) && !Object.keys(p.body).length))
      invalid('Deletion takes only the catalog and feed in the path.');
    return;
  }
  const b = p.body;
  if (!object(b)) invalid('Send the feed as {' + fields.join(', ') + '}.');
  if (b.username !== undefined || b.password !== undefined)
    invalid('Credentials never pass through AMCP. Use a feed address the host serves without them.');
  const extra = Object.keys(b).filter(k => !fields.includes(k));
  if (extra.length) invalid('A feed takes ' + fields.join(', ') + '; unqualified: ' + extra.join(', ') + '.');
  if (kind === 'create') {
    const missing = fields.filter(k => k !== 'repeat' && b[k] === undefined);
    if (missing.length) invalid('A new feed needs ' + missing.join(', ') + '.');
  } else if (!Object.keys(b).length) invalid('Name what changes: ' + fields.join(', ') + '.');
  for (const [k, v] of Object.entries(b)) checkField(k, v);
  if (kind === 'create') checkRepeat(b.frequency, b.repeat);
}
const stateRead = (p: CompiledRequest, state: State): Read => ({
  ...(xCatalogRead(p, '/12/accounts/' + p.accountId + '/promotable_users', {count: 200}) as Read),
  xScheduledFeedState: state,
});
export function xScheduledFeedSnapshots(p: CompiledRequest): Read[] {
  const kind = xScheduledFeedKind(p)!;
  return [stateRead(p, {kind, catalog: catalogOf(p), ...(kind === 'create' ? {} : {feed: feedOf(p)})})];
}
export function isXScheduledFeedRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).xScheduledFeedState;
}
export function authorizeXScheduledFeed(p: CompiledRequest, _c: Connection, account: string): boolean {
  if (p.gateway !== gateway) return false;
  if (xScheduledFeedKind(p)) {
    assertXScheduledFeed(p);
    if (p.accountId !== account)
      fail('ACCOUNT_SCOPE_MISMATCH', 'Select the ad account whose promotable user owns the catalog.', {}, 403);
    return true;
  }
  return authorizeXCatalogRead(p, account);
}
const feedView = (f: JsonObject): JsonObject => ({
  id: f.id,
  feed_url: f.feed_url ?? null,
  feed_format: f.feed_format ?? null,
  frequency: f.frequency ?? null,
  repeat: f.repeat === undefined || f.repeat === null ? null : String(f.repeat),
  start_time: f.start_time ?? null,
  time_zone: f.time_zone ?? null,
});
export async function readXScheduledFeeds(p: CompiledRequest, fetch: Fetch): Promise<TransportResult> {
  const s = (p as Read).xScheduledFeedState;
  if (!s) return fetch(p);
  const owners = await xCatalogOwners(p, fetch),
    found = owners.catalogs.some(c => c.id === s.catalog),
    feeds = found ? (await xCatalogFeeds(p, fetch, s.catalog)).map(feedView) : [];
  if (s.verify) {
    const f = feeds.find(x => x.id === s.feed);
    return {status: 200, headers: {}, data: {feed: f ? {present: true, ...f} : {present: false, id: s.feed}}};
  }
  return {
    status: 200,
    headers: {},
    data: {users: owners.users, catalogs: owners.catalogs, ...(found ? {feeds} : {})},
  };
}
export function validateXScheduledFeedState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).xScheduledFeedState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || (s.verify ? !object(d.feed) : !Array.isArray(d.catalogs)))
    unverified('Missing verified feed state.');
}
export function xScheduledFeedPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = xScheduledFeedKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !Array.isArray(s.catalogs)) unverified('Missing verified feed state.');
  ownedCatalog(s, catalogOf(p));
  if (!Array.isArray(s.feeds)) unverified('Missing the scheduled feeds of the catalog.');
  const feeds = s.feeds as JsonObject[];
  if (kind === 'create') {
    if (feeds.length)
      fail(
        'CONFIGURATION_EXISTS',
        'Catalog ' +
          catalogOf(p) +
          ' already has scheduled feed ' +
          String(feeds[0]!.id) +
          ': X supports one product feed per user. Update that feed instead.',
        {scheduled_feed_id: String(feeds[0]!.id)},
        409,
      );
    return;
  }
  const before = feeds.find(f => f.id === feedOf(p));
  if (!before)
    fail('STATE_NOT_FOUND', 'Scheduled feed ' + feedOf(p) + ' is not a feed of catalog ' + catalogOf(p) + '.', {}, 404);
  if (kind === 'delete') return;
  const b = body(p),
    frequency = b.frequency ?? before.frequency;
  if (b.frequency !== undefined && b.frequency !== before.frequency) {
    if (frequency === 'DAILY' && before.repeat !== null && b.repeat === undefined)
      invalid(
        'X documents no way to clear repeat, which a DAILY feed must not have: delete this feed and create a DAILY one.',
      );
    if (frequency !== 'DAILY' && b.repeat === undefined)
      invalid('A change to ' + String(frequency) + ' names its repeat as well.');
  }
  checkRepeat(frequency, b.repeat !== undefined ? b.repeat : frequency === 'DAILY' ? undefined : before.repeat);
  if (Object.entries(b).every(([k, v]) => String(v) === String(before[k])))
    invalid('Scheduled feed ' + feedOf(p) + ' already has these values.');
}
const fetches = (f: JsonObject) =>
  String(f.frequency) +
  (f.frequency === 'WEEKLY'
    ? ' on ' + String(f.repeat)
    : f.frequency === 'HOURLY'
      ? ', repeat ' + String(f.repeat)
      : '') +
  ' at ' +
  String(f.start_time) +
  ' (' +
  String(f.time_zone) +
  ') from ' +
  String(f.feed_url);
export function xScheduledFeedImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = xScheduledFeedKind(p);
  if (!kind) return;
  const s: JsonObject = object(state[0]) ? state[0] : {},
    feeds = (Array.isArray(s.feeds) ? s.feeds : []) as JsonObject[],
    before = kind === 'create' ? undefined : feeds.find(f => f.id === feedOf(p)),
    after = kind === 'delete' ? null : {...(before ?? {}), ...body(p)};
  return {
    provider: 'x',
    scope: 'scheduled_feed',
    operation: kind,
    product_catalog_id: catalogOf(p),
    ...(kind === 'create' ? {creating: after} : kind === 'update' ? {before, after} : {deleting: before ?? null}),
    ...(after ? {fetches: fetches(after)} : {}),
    // An import adds or updates products that dynamic ads can show; a deletion leaves them in the catalog.
    may_affect_serving: kind !== 'delete',
    effect:
      kind === 'delete'
        ? 'X stops fetching the file ("This is a permanent deletion"). X documents imports as additive, and does not say that deleting the feed removes the products it brought.'
        : 'X fetches the file on this schedule and adds or updates the products it lists. Imports are additive: "removing products from the feed does not delete them from the catalog."',
    verification:
      kind === 'delete'
        ? "Lists the catalog's scheduled feeds again and expects this one to be gone."
        : "Lists the catalog's scheduled feeds again and compares address, format and schedule.",
    source,
  };
}
export function xScheduledFeedOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = xScheduledFeedKind(p)!,
    d = r.data,
    t = object(d) && object(d.data) ? d.data : undefined;
  if (
    ![200, 201].includes(r.status) ||
    !t ||
    typeof t.id !== 'string' ||
    !xSnowflake.test(t.id) ||
    (Array.isArray((d as JsonObject).errors) && (d as JsonObject).errors.length)
  )
    return false;
  if (kind !== 'create' && t.id !== feedOf(p)) return false;
  return kind === 'delete' || Object.entries(body(p)).every(([k, v]) => String(t[k]) === String(v));
}
export function xScheduledFeedVerification(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = xScheduledFeedKind(p)!,
    id = kind === 'create' ? result.data?.data?.id : feedOf(p);
  if (typeof id !== 'string' || !xSnowflake.test(id))
    unverified(
      'The original feed receipt has no exact generated string identity. Preserve the original receipt; no mutation is repeated.',
    );
  const s: JsonObject = object(before[0]) ? before[0] : {},
    prior = (Array.isArray(s.feeds) ? (s.feeds as JsonObject[]) : []).find(f => f.id === id) ?? {},
    merged = {...prior, ...body(p)};
  const expected =
    kind === 'delete'
      ? {present: false}
      : {
          present: true,
          id,
          ...Object.fromEntries(fields.filter(k => k !== 'repeat').map(k => [k, merged[k] ?? null])),
          repeat: merged.frequency === 'DAILY' ? null : String(merged.repeat),
        };
  return [
    {
      read: stateRead(p, {kind, catalog: catalogOf(p), feed: id, verify: true}),
      expected: {feed: expected},
      id: 'scheduled feed ' + id,
    },
  ];
}
export function xScheduledFeedObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {feed: object(data.feed) ? data.feed : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const xScheduledFeedFamily: ReviewedFamily = defineFamily({
  name: 'x_scheduled_feeds',
  verificationCacheVersion: xCatalogVerificationVersion,
  files: ['src/x-scheduled-feeds.ts', ['tests/x-scheduled-feeds.test.mjs']],
  kind: xScheduledFeedKind,
  assert: plan => assertXScheduledFeed(plan),
  authorize: authorizeXScheduledFeed,
  snapshots: xScheduledFeedSnapshots,
  isRead: isXScheduledFeedRead,
  reader: readXScheduledFeeds,
  validateState: validateXScheduledFeedState,
  prerequisites: xScheduledFeedPrerequisites,
  impact: xScheduledFeedImpact,
  outcome: xScheduledFeedOutcome,
  verification: xScheduledFeedVerification,
  observed: xScheduledFeedObserved,
  destructive: plan => xScheduledFeedKind(plan) === 'delete',
});
