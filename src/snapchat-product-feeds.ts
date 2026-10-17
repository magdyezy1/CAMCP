import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {fail} from './family-kit.js';

/**
 * Product feeds of Snapchat catalogs, opened by the owner on 2026-09-29 ("Product catalogs: make it available").
 * Snapchat's "Dynamic Product Ads" reference (read 2026-09-29): "The relationship between a Catalog and a Product feed
 * is currently 1:1, there can only ever be one Product Feed under a Catalog." POST /v1/catalogs/{catalog_id}/
 * product_feeds creates one from {product_feeds: [{catalog_id, name (max 375), default_currency (ISO 4217, required),
 * status, feed_type, schedule}]}; PUT on the same path updates one (with its id); GET /v1/product_feeds/{id} reads one;
 * DELETE /v1/product_feeds/{id} deletes it. A schedule has url, username and password ("Required if url is password
 * protected"), timezone ("default timezone is UTC"), interval_type HOURLY, DAILY, WEEKLY or MONTHLY, and the attributes
 * the reference's table requires per interval: MONTHLY day_of_month, hour and minute; WEEKLY day_of_week, hour and
 * minute; DAILY hour and minute (interval_count 1-31 optional); HOURLY minute (interval_count 1-23 optional).
 *
 * AMCP keeps credentials out (no username or password), fetches over HTTPS only, creates PRIMARY feeds only (supplemental
 * feeds and feed uploads stay outside), sends a whole feed on update, and writes feeds of catalogs of the selected ad
 * account's organization.
 */
type Kind = 'create' | 'update' | 'delete';
type State = {kind: Kind; catalog?: string; feed?: string; verify?: boolean};
type Read = CompiledRequest & {
  snapFeedState?: State;
  snapFeedOrg?: string;
  snapFeedCatalog?: string;
  snapFeedId?: string;
};
const gateway = 'snapchat_native_action',
  origin = 'https://adsapi.snapchat.com',
  marker = 'AMCP_SNAPCHAT_PRODUCT_FEED_READ',
  source = 'https://developers.snap.com/marketing-api/Ads-API/dynamic-product-ads';
const intervals: Record<string, {required: string[]; optional: string[]; count?: number}> = {
  MONTHLY: {required: ['day_of_month', 'hour', 'minute'], optional: []},
  WEEKLY: {required: ['day_of_week', 'hour', 'minute'], optional: []},
  DAILY: {required: ['hour', 'minute'], optional: ['interval_count'], count: 31},
  HOURLY: {required: ['minute'], optional: ['interval_count'], count: 23},
};
const weekdays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const snapId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v === v.trim() && v.length > 0 && [...v].length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const whole = (v: unknown, min: number, max: number) => {
  const n = typeof v === 'string' && /^\d{1,2}$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max;
};
function invalid(message: string): never {
  return fail('INVALID_SNAPCHAT_PRODUCT_FEED', message, {source});
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function snapProductFeedKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport || (p.origin && p.origin !== origin)) return;
  if (/^\/v1\/catalogs\/[A-Za-z0-9-]{1,64}\/product_feeds$/.test(p.path))
    return p.method === 'POST' ? 'create' : p.method === 'PUT' ? 'update' : undefined;
  if (p.method === 'DELETE' && /^\/v1\/product_feeds\/[A-Za-z0-9-]{1,64}$/.test(p.path)) return 'delete';
}
const catalogOf = (p: CompiledRequest) => /^\/v1\/catalogs\/([A-Za-z0-9-]{1,64})\/product_feeds$/.exec(p.path)?.[1];
const feedOf = (p: CompiledRequest) => p.path.split('/')[3]!;
const item = (p: CompiledRequest): JsonObject =>
  (object(p.body) && Array.isArray(p.body.product_feeds) && object(p.body.product_feeds[0])
    ? p.body.product_feeds[0]
    : {}) as JsonObject;
function checkSchedule(s: unknown): void {
  if (!object(s)) invalid('schedule is required: Snapchat fetches the feed from it (file uploads stay outside AMCP).');
  if (s.username !== undefined || s.password !== undefined)
    invalid(
      'The schedule carries no username or password: credentials never pass through AMCP. Use a URL the host serves without them.',
    );
  let url: URL | undefined;
  try {
    url = new URL(String(s.url));
  } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || String(s.url).length > 2048)
    invalid('schedule.url is an HTTPS address without credentials in it.');
  const rule = intervals[String(s.interval_type)];
  if (!rule) invalid('schedule.interval_type is ' + Object.keys(intervals).join(', ') + '.');
  const allowed = ['url', 'timezone', 'interval_type', ...rule.required, ...rule.optional];
  const extra = Object.keys(s).filter(k => !allowed.includes(k));
  if (extra.length)
    invalid('A ' + s.interval_type + ' schedule takes ' + allowed.join(', ') + '; not ' + extra.join(', ') + '.');
  const missing = rule.required.filter(k => s[k] === undefined);
  if (missing.length) invalid('A ' + s.interval_type + ' schedule needs ' + missing.join(', ') + '.');
  if (s.hour !== undefined && !whole(s.hour, 0, 23)) invalid('schedule.hour is 0 to 23.');
  if (s.minute !== undefined && !whole(s.minute, 0, 59)) invalid('schedule.minute is 0 to 59.');
  if (s.day_of_month !== undefined && !whole(s.day_of_month, 1, 31)) invalid('schedule.day_of_month is 1 to 31.');
  if (s.day_of_week !== undefined && !weekdays.includes(s.day_of_week))
    invalid('schedule.day_of_week is a weekday name.');
  if (s.interval_count !== undefined && !whole(s.interval_count, 1, rule.count!))
    invalid('schedule.interval_count is 1 to ' + rule.count + ' for ' + s.interval_type + ' schedules.');
  if (s.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en', {timeZone: String(s.timezone)});
    } catch {
      invalid('schedule.timezone is an IANA time zone such as Asia/Riyadh.');
    }
  }
}
export function assertSnapProductFeed(p: CompiledRequest): void {
  const kind = snapProductFeedKind(p);
  if (!kind) return;
  if (!snapId(p.accountId))
    fail('ACCOUNT_REQUIRED', 'Select the ad account whose organization owns the catalog.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Product feed writes take no query or header overrides.');
  if (kind === 'delete') {
    if (p.body !== undefined && !(object(p.body) && !Object.keys(p.body).length))
      invalid('Deletion takes only the product feed in the path.');
    return;
  }
  const b = p.body;
  if (
    !object(b) ||
    Object.keys(b).some(k => k !== 'product_feeds') ||
    !Array.isArray(b.product_feeds) ||
    b.product_feeds.length !== 1
  )
    invalid('Send {product_feeds: [one feed]}: a catalog holds one product feed.');
  const f = item(p),
    fields = [
      'catalog_id',
      'name',
      'default_currency',
      'status',
      'feed_type',
      'schedule',
      ...(kind === 'update' ? ['id'] : []),
    ];
  const extra = Object.keys(f).filter(k => !fields.includes(k));
  if (extra.length)
    invalid(
      'A product feed takes ' +
        fields.join(', ') +
        '; unqualified: ' +
        extra.join(', ') +
        ' (supplemental feeds stay outside AMCP).',
    );
  if (kind === 'update' && !snapId(f.id)) invalid('id names the product feed to update.');
  if (f.catalog_id !== catalogOf(p)) invalid('catalog_id is the catalog in the path.');
  if (!text(f.name, 375)) invalid('name has 1 to 375 characters without surrounding spaces.');
  if (typeof f.default_currency !== 'string' || !/^[A-Z]{3}$/.test(f.default_currency))
    invalid('default_currency is an ISO 4217 code (required).');
  if (f.status !== undefined && f.status !== 'ACTIVE') invalid('status is ACTIVE, the documented value.');
  if (f.feed_type !== undefined && f.feed_type !== 'PRIMARY') invalid('AMCP writes PRIMARY feeds only.');
  checkSchedule(f.schedule);
}
const read = (
  p: CompiledRequest,
  path: string,
  query: Record<string, string | number>,
  extra: Partial<Read> = {},
): Read =>
  ({
    ...p,
    action: marker,
    method: 'GET',
    path,
    query,
    body: undefined,
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
    snapFeedState: undefined,
    snapFeedOrg: undefined,
    snapFeedCatalog: undefined,
    snapFeedId: undefined,
    ...extra,
  }) as Read;
const accountRead = (p: CompiledRequest, state: State) =>
  read(p, '/v1/adaccounts/' + p.accountId, {}, {snapFeedState: state});
export function snapProductFeedSnapshots(p: CompiledRequest): Read[] {
  const kind = snapProductFeedKind(p)!;
  return [accountRead(p, kind === 'delete' ? {kind, feed: feedOf(p)} : {kind, catalog: catalogOf(p)})];
}
export function isSnapProductFeedRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).snapFeedState;
}
/** Writes after validation. Internal reads: the account, then the organization, catalog and feed it leads to. */
export function authorizeSnapProductFeed(p: CompiledRequest, _c: Connection, account: string): boolean {
  if (p.gateway !== gateway) return false;
  if (snapProductFeedKind(p)) {
    assertSnapProductFeed(p);
    if (p.accountId !== account)
      fail('ACCOUNT_SCOPE_MISMATCH', 'Select the ad account whose organization owns the catalog.', {}, 403);
    return true;
  }
  if (p.action !== marker || p.method !== 'GET' || !p.readOnly || p.body !== undefined || p.accountId !== account)
    return false;
  const r = p as Read,
    id = p.path.split('/')[3];
  if (p.path === '/v1/adaccounts/' + account && !Object.keys(p.query).length) return true;
  // Each marker is set only by readSnapProductFeeds from the account, organization or feed just read.
  if (/^\/v1\/organizations\/[A-Za-z0-9-]{1,64}\/catalogs$/.test(p.path) && r.snapFeedOrg === id) return true;
  if (/^\/v1\/catalogs\/[A-Za-z0-9-]{1,64}\/product_feeds$/.test(p.path) && r.snapFeedCatalog === id) return true;
  if (/^\/v1\/product_feeds\/[A-Za-z0-9-]{1,64}$/.test(p.path) && r.snapFeedId === id) return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal product feed read.', {}, 403);
}
/** Every row of a Snapchat list, following cursors for a bounded number of pages (also used by snapchat-catalogs.ts). */
export async function all(
  first: CompiledRequest,
  key: string,
  row: string,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
) {
  const out: JsonObject[] = [],
    cursors = new Set<string>();
  let q = first;
  for (let page = 0; ; page++) {
    if (page >= 3) unverified('There are more ' + key.replace('_', ' ') + ' than one review reads.');
    const r = await fetch(q),
      d = r.data;
    if (
      r.status !== 200 ||
      !object(d) ||
      String(d.request_status).toUpperCase() !== 'SUCCESS' ||
      !Array.isArray(d[key])
    )
      unverified('Snapchat did not list the ' + key.replace('_', ' ') + '.');
    for (const x of d[key] as unknown[]) {
      const v = object(x) && object(x[row]) ? x[row] : undefined;
      if (!v || !snapId(v.id)) unverified('A row of the ' + key.replace('_', ' ') + ' is malformed.');
      out.push(v!);
    }
    const link = object(d.paging) ? d.paging.next_link : undefined;
    if (!link) return out;
    let cursor: string | null = null;
    try {
      cursor = new URL(String(link)).searchParams.get('cursor');
    } catch {}
    if (!cursor || cursors.has(cursor))
      unverified('Snapchat pagination of the ' + key.replace('_', ' ') + ' is malformed.');
    cursors.add(cursor!);
    q = {...q, query: {...q.query, cursor: cursor!}};
  }
}
const scheduleView = (v: unknown): JsonObject | null => {
  if (!object(v)) return null;
  const out: JsonObject = {};
  for (const [k, x] of Object.entries(v))
    if (!['username', 'password'].includes(k) && x !== null && x !== undefined)
      out[k] = ['hour', 'minute', 'day_of_month', 'interval_count'].includes(k) ? Number(x) : x;
  return out;
};
const feedView = (f: JsonObject): JsonObject => ({
  id: String(f.id),
  catalog_id: f.catalog_id ?? null,
  name: f.name ?? null,
  default_currency: f.default_currency ?? null,
  status: f.status ?? null,
  feed_type: f.feed_type ?? 'PRIMARY',
  schedule: scheduleView(f.schedule),
});
/** One feed by ID, or absent. */
async function oneFeed(p: CompiledRequest, id: string, fetch: (p: CompiledRequest) => Promise<TransportResult>) {
  try {
    const r = await fetch(read(p, '/v1/product_feeds/' + id, {}, {snapFeedId: id})),
      d = r.data;
    if (
      r.status !== 200 ||
      !object(d) ||
      String(d.request_status).toUpperCase() !== 'SUCCESS' ||
      !Array.isArray(d.product_feeds)
    )
      unverified('Snapchat did not return product feed ' + id + '.');
    const x = (d.product_feeds as unknown[])[0];
    return object(x) && object(x.product_feed) && x.product_feed.id === id ? (x.product_feed as JsonObject) : undefined;
  } catch (e) {
    if (e instanceof MirrorError && (e.status === 404 || e.code === 'NOT_FOUND')) return undefined;
    throw e;
  }
}
/** The account's organization and catalogs, the target catalog's feeds, and for a deletion the feed. */
export async function readSnapProductFeeds(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).snapFeedState;
  if (!s) return fetch(p);
  if (s.verify) {
    const f = await oneFeed(p, s.feed!, fetch);
    return {status: 200, headers: {}, data: {feed: f ? {present: true, ...feedView(f)} : {present: false, id: s.feed}}};
  }
  const account = p.accountId!,
    a = await fetch({...(p as Read), snapFeedState: undefined} as Read),
    ad = a.data;
  const row =
    object(ad) &&
    String(ad.request_status).toUpperCase() === 'SUCCESS' &&
    Array.isArray(ad.adaccounts) &&
    object(ad.adaccounts[0])
      ? ad.adaccounts[0].adaccount
      : undefined;
  if (a.status !== 200 || !object(row) || row.id !== account || !snapId(row.organization_id))
    unverified('Snapchat did not return the selected ad account with its organization.');
  const org = String(row.organization_id),
    catalogs: JsonObject = {};
  for (const c of await all(
    read(p, '/v1/organizations/' + org + '/catalogs', {limit: 100}, {snapFeedOrg: org}),
    'catalogs',
    'catalog',
    fetch,
  )) {
    if (c.organization_id !== undefined && c.organization_id !== org)
      fail('STATE_TARGET_MISMATCH', 'Snapchat listed a catalog of another organization.', {}, 409);
    catalogs['c' + c.id] = {id: String(c.id), name: c.name ?? null, vertical: c.vertical ?? null};
  }
  const out: JsonObject = {ad_account_id: account, organization_id: org, catalogs};
  let catalog = s.catalog;
  if (s.feed) {
    const f = await oneFeed(p, s.feed, fetch);
    out.feed = f ? {present: true, ...feedView(f)} : {present: false, id: s.feed};
    catalog = f && snapId(f.catalog_id) ? String(f.catalog_id) : undefined;
  }
  if (catalog && Object.hasOwn(catalogs, 'c' + catalog))
    out.feeds = (
      await all(
        read(p, '/v1/catalogs/' + catalog + '/product_feeds', {}, {snapFeedCatalog: catalog}),
        'product_feeds',
        'product_feed',
        fetch,
      )
    )
      .map(feedView)
      .sort((x, y) => String(x.id).localeCompare(String(y.id)));
  return {status: 200, headers: {}, data: out};
}
export function validateSnapProductFeedState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).snapFeedState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || (s.verify ? !object(d.feed) : !object(d.catalogs)))
    unverified('Missing verified product feed state.');
}
export function snapProductFeedPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = snapProductFeedKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.catalogs)) unverified('Missing verified product feed state.');
  const catalogs = s.catalogs as JsonObject;
  if (kind === 'delete') {
    if (!object(s.feed) || s.feed.present === false)
      fail('STATE_NOT_FOUND', 'Product feed ' + feedOf(p) + ' was not found.', {product_feed_id: feedOf(p)}, 404);
    if (!Object.hasOwn(catalogs, 'c' + String(s.feed.catalog_id)))
      fail('STATE_TARGET_MISMATCH', "The feed's catalog does not belong to the ad account's organization.", {}, 409);
    return;
  }
  const catalog = catalogOf(p)!;
  if (!Object.hasOwn(catalogs, 'c' + catalog))
    fail(
      'STATE_TARGET_MISMATCH',
      'Catalog ' + catalog + " does not belong to the ad account's organization.",
      {catalog_id: catalog},
      409,
    );
  if (!Array.isArray(s.feeds)) unverified('Missing the feeds of the catalog.');
  const feeds = s.feeds as JsonObject[],
    f = item(p);
  if (kind === 'create') {
    if (feeds.some(x => x.feed_type !== 'SUPPLEMENTAL'))
      fail(
        'CONFIGURATION_EXISTS',
        'Catalog ' +
          catalog +
          ' already has its product feed ("there can only ever be one Product Feed under a Catalog"). Update it instead.',
        {product_feed_id: String(feeds.find(x => x.feed_type !== 'SUPPLEMENTAL')!.id)},
      );
    return;
  }
  const before = feeds.find(x => x.id === f.id);
  if (!before) fail('STATE_NOT_FOUND', 'Product feed ' + String(f.id) + ' is not in catalog ' + catalog + '.', {}, 404);
  const after = feedView({...f, feed_type: f.feed_type ?? 'PRIMARY'});
  if (
    ['name', 'default_currency', 'schedule'].every(k => stable(after[k]) === stable(before[k])) &&
    (f.status === undefined || f.status === before.status)
  )
    invalid('Product feed ' + String(f.id) + ' already has these values.');
}
const when = (s: JsonObject | null | undefined) => {
  if (!s) return 'no schedule';
  const at =
    s.hour !== undefined
      ? ' at ' + String(s.hour).padStart(2, '0') + ':' + String(s.minute ?? 0).padStart(2, '0')
      : s.minute !== undefined
        ? ' at minute ' + s.minute
        : '';
  return (
    (Number(s.interval_count ?? 1) > 1 ? 'every ' + s.interval_count + ' × ' : '') +
    String(s.interval_type) +
    (s.day_of_week ? ' on ' + s.day_of_week : '') +
    (s.day_of_month ? ' on day ' + s.day_of_month : '') +
    at +
    ' (' +
    String(s.timezone ?? "UTC, Snapchat's default") +
    ') from ' +
    String(s.url)
  );
};
export function snapProductFeedImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = snapProductFeedKind(p);
  if (!kind) return;
  const s: JsonObject = object(state[0]) ? state[0] : {},
    catalogs: JsonObject = object(s.catalogs) ? s.catalogs : {},
    f = item(p);
  const catalogId = kind === 'delete' ? (object(s.feed) ? String(s.feed.catalog_id) : '') : catalogOf(p)!;
  const before =
    kind === 'delete'
      ? s.feed
      : Array.isArray(s.feeds)
        ? (s.feeds as JsonObject[]).find(x => x.id === f.id)
        : undefined;
  return {
    provider: 'snapchat',
    scope: 'product_feed',
    operation: kind,
    catalog: catalogs['c' + catalogId] ?? {id: catalogId},
    ...(kind === 'create'
      ? {creating: feedView({...f, id: 'new'})}
      : kind === 'update'
        ? {before, after: feedView(f)}
        : {deleting: before}),
    ...(kind !== 'delete' ? {fetches: when(scheduleView(f.schedule))} : {}),
    may_affect_serving: kind !== 'create',
    effect:
      kind === 'create'
        ? "Creates the catalog's product feed; Snapchat fetches it on its schedule, and product sets of the catalog show what it brings."
        : kind === 'update'
          ? "Changes the catalog's product feed; its next fetch follows the new settings."
          : "Deletes the catalog's product feed. Snapchat's reference does not say what becomes of the products it brought; product sets and dynamic ads of the catalog use them.",
    verification:
      kind === 'delete'
        ? 'Reads the feed again and expects it to be gone.'
        : 'Reads the feed again and compares its name, currency and schedule.',
    source,
  };
}
export function snapProductFeedOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const d = r.data;
  if (r.status !== 200 || !object(d) || String(d.request_status).toUpperCase() !== 'SUCCESS') return false;
  if (snapProductFeedKind(p) === 'delete') return true;
  const x = Array.isArray(d.product_feeds) ? (d.product_feeds as unknown[])[0] : undefined;
  return (
    object(x) &&
    String(x.sub_request_status).toUpperCase() === 'SUCCESS' &&
    object(x.product_feed) &&
    snapId(x.product_feed.id)
  );
}
export function snapProductFeedVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = snapProductFeedKind(p)!,
    x = Array.isArray(result.data?.product_feeds) ? result.data.product_feeds[0] : undefined,
    id = kind === 'delete' ? feedOf(p) : String(object(x) && object(x.product_feed) ? x.product_feed.id : '');
  if (!snapId(id)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no product feed.');
  const f = item(p),
    expected: JsonObject =
      kind === 'delete'
        ? {feed: {present: false}}
        : {
            feed: {
              present: true,
              catalog_id: f.catalog_id,
              name: f.name,
              default_currency: f.default_currency,
              schedule: scheduleView(f.schedule),
            },
          };
  return [{read: accountRead(p, {kind, feed: id, verify: true}), expected, id: 'product feed ' + id}];
}
export function snapProductFeedObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  const x = object(data.feed) ? data.feed : {};
  return x.present ? {feed: x} : {feed: {present: false}};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const snapProductFeedFamily: ReviewedFamily = {
  name: 'snapchat_product_feeds',
  files: ['src/snapchat-product-feeds.ts', ['tests/snapchat-product-feeds.test.mjs']],
  kind: snapProductFeedKind,
  assert: plan => assertSnapProductFeed(plan),
  authorize: authorizeSnapProductFeed,
  snapshots: snapProductFeedSnapshots,
  isRead: isSnapProductFeedRead,
  reader: readSnapProductFeeds,
  validateState: validateSnapProductFeedState,
  prerequisites: snapProductFeedPrerequisites,
  impact: snapProductFeedImpact,
  outcome: snapProductFeedOutcome,
  verification: snapProductFeedVerification,
  observed: snapProductFeedObserved,
  destructive: plan => snapProductFeedKind(plan) === 'delete',
};
