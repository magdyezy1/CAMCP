import {stable} from './security.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {metaPrefix, metaRoute} from './meta-version.js';
import {
  assertMetaCatalogOfBusiness,
  assertMetaCatalogScope,
  metaCatalogFields,
  metaCatalogView,
  optionalMetaRead,
} from './meta-catalogs.js';
import {fail} from './family-kit.js';

/**
 * Scheduled product feeds of Meta catalogs, opened by the owner on 2026-09-29. Meta's references (read 2026-09-29):
 * "Product Catalog Product Feeds" (POST /{product_catalog_id}/product_feeds: name, schedule "a JSON-encoded string
 * representing a recurrent schedule for fetching the feed. Default timezone is America/Los_Angeles", update_schedule
 * ("only update the items in the feed or create new ones. No items would be deleted"), deletion_enabled ("When true,
 * this will remove products from a catalog that are no longer present in a feed ... Once enabled, we do not allow this
 * field to be disabled"; default true), and file options; answers {id}), "Product Feed" (POST /{product_feed_id}
 * updates the same fields and answers {success}; DELETE: "Deleting a product feed effectively disables all ads using
 * products that come from this feed") and "Product Feed Schedule" (interval HOURLY, DAILY, WEEKLY or MONTHLY,
 * interval_count, hour 0-23, minute 0-59, day_of_week, day_of_month, timezone, url, username).
 *
 * AMCP asks the request to choose deletion_enabled itself, keeps credentials out (no username or password: set them in
 * Commerce Manager), fetches over HTTPS only, and writes feeds of catalogs of the selected ad account's business.
 * Supplementary and localized feeds, feed rules and moving items between feeds stay outside.
 */
type Kind = 'create' | 'update' | 'delete';
type State = {kind: Kind; catalog?: string; feed?: string; verify?: boolean};
type Page = {catalog?: string; feed?: string; business?: string};
type Read = CompiledRequest & {metaFeedState?: State; metaFeedPage?: Page};
const gateway = 'meta_native_action',
  marker = 'AMCP_META_PRODUCT_FEED_READ',
  pageSize = 100,
  maxCatalogs = 50,
  maxFeedPages = 3,
  source = 'https://developers.facebook.com/docs/marketing-api/reference/product-feed/';
const actions: Record<string, Kind> = {
  meta_product_catalog_id_product_feeds_create: 'create',
  meta_product_feed_id_update: 'update',
  meta_product_feed_id_delete: 'delete',
};
const feedFields =
  'id,name,schedule,update_schedule,deletion_enabled,default_currency,country,delimiter,encoding,quoted_fields_mode,feed_type,ingestion_source_type,product_count';
const enums: Record<string, string[]> = {
  delimiter: ['AUTODETECT', 'BAR', 'COMMA', 'TAB', 'TILDE', 'SEMICOLON'],
  encoding: ['AUTODETECT', 'LATIN1', 'UTF8', 'UTF16LE', 'UTF16BE', 'UTF32LE', 'UTF32BE'],
  quoted_fields_mode: ['autodetect', 'on', 'off'],
};
const intervals = ['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'],
  weekdays = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'],
  scheduleKeys = ['url', 'interval', 'interval_count', 'hour', 'minute', 'day_of_week', 'day_of_month', 'timezone'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const account = (v: unknown) => String(v ?? '').replace(/^act_/, '');
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v === v.trim() && v.length > 0 && [...v].length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const int = (v: unknown, min: number, max: number) =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
function invalid(message: string, details: JsonObject = {}): never {
  return fail('INVALID_META_PRODUCT_FEED', message, {source, ...details});
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function metaProductFeedKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport || (p.origin && p.origin !== 'https://graph.facebook.com')) return;
  const kind = actions[p.action];
  if (kind === 'create')
    return p.method === 'POST' && metaRoute('[1-9][0-9]{0,31}/product_feeds$').test(p.path) ? kind : undefined;
  if (kind === 'update') return p.method === 'POST' && metaRoute('[1-9][0-9]{0,31}$').test(p.path) ? kind : undefined;
  if (kind === 'delete') return p.method === 'DELETE' && metaRoute('[1-9][0-9]{0,31}$').test(p.path) ? kind : undefined;
}
const idOf = (p: CompiledRequest) => p.path.split('/')[2]!;
const body = (p: CompiledRequest): JsonObject => (object(p.body) ? p.body : {});
/** A schedule as sent (an object or its JSON text), or undefined. */
function scheduleOf(v: unknown, field: string): JsonObject | undefined {
  if (v === undefined) return;
  let s = v;
  if (typeof v === 'string')
    try {
      s = JSON.parse(v);
    } catch {
      invalid(field + ' must be a JSON object.');
    }
  if (!object(s)) invalid(field + ' must be a JSON object.');
  return s;
}
function checkSchedule(v: unknown, field: string): void {
  const s = scheduleOf(v, field);
  if (!s) return;
  if (s.username !== undefined || s.password !== undefined)
    invalid(
      field + ' carries no username or password: credentials never pass through AMCP; set them in Commerce Manager.',
    );
  const extra = Object.keys(s).filter(k => !scheduleKeys.includes(k));
  if (extra.length) invalid(field + ' takes ' + scheduleKeys.join(', ') + '; unqualified: ' + extra.join(', ') + '.');
  let url: URL | undefined;
  try {
    url = new URL(String(s.url));
  } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || String(s.url).length > 2048)
    invalid(field + '.url is an HTTPS address without credentials in it.');
  if (!intervals.includes(s.interval)) invalid(field + '.interval is ' + intervals.join(', ') + '.');
  if (s.interval_count !== undefined && !int(s.interval_count, 1, 1000))
    invalid(field + '.interval_count is a whole number from 1.');
  if (s.hour !== undefined && !int(Number(s.hour), 0, 23)) invalid(field + '.hour is 0 to 23.');
  if (s.minute !== undefined && !int(Number(s.minute), 0, 59)) invalid(field + '.minute is 0 to 59.');
  if (s.day_of_week !== undefined && (s.interval !== 'WEEKLY' || !weekdays.includes(s.day_of_week)))
    invalid(field + '.day_of_week is a weekday name, for WEEKLY schedules.');
  if (s.day_of_month !== undefined && (s.interval !== 'MONTHLY' || !int(Number(s.day_of_month), 1, 31)))
    invalid(field + '.day_of_month is 1 to 31, for MONTHLY schedules.');
  if (s.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en', {timeZone: String(s.timezone)});
    } catch {
      invalid(field + '.timezone is an IANA time zone.');
    }
  }
}
export function assertMetaProductFeed(p: CompiledRequest): void {
  const kind = metaProductFeedKind(p);
  if (!kind) return;
  if (!numeric(account(p.accountId))) invalid('Select one Meta ad account.');
  if (Object.keys(p.headers).length || Object.keys(p.query).length)
    invalid('Send the feed in the body, without query or header overrides.');
  if (kind === 'delete') {
    if (p.body !== undefined && !(object(p.body) && !Object.keys(p.body).length))
      invalid('Deleting a feed takes no parameters.');
    return;
  }
  if (!object(p.body)) invalid('Send the feed as a native object.');
  const b = p.body;
  const allowed = [
    'name',
    'schedule',
    'update_schedule',
    'deletion_enabled',
    'default_currency',
    'delimiter',
    'encoding',
    'quoted_fields_mode',
    ...(kind === 'create' ? ['country', 'feed_type'] : []),
  ];
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  if (extra.length)
    invalid(
      'Unqualified feed fields: ' +
        extra.join(', ') +
        ' (supplementary and localized feeds, feed rules, file uploads and moving items between feeds stay outside AMCP).',
      {fields: extra},
    );
  if (kind === 'create') {
    for (const k of ['name', 'schedule', 'deletion_enabled'])
      if (b[k] === undefined)
        invalid(
          k +
            ' is required' +
            (k === 'deletion_enabled'
              ? ': Meta turns it on by default and it cannot be turned off, so choose it explicitly.'
              : '.'),
        );
    if (b.feed_type !== undefined && b.feed_type !== 'PRODUCTS') invalid('AMCP creates PRODUCTS feeds only.');
    if (b.country !== undefined && (typeof b.country !== 'string' || !/^[A-Z]{2}$/.test(b.country)))
      invalid('country is a two-letter code.');
  } else if (!Object.keys(b).length) invalid('Name at least one feed field to change.');
  if (b.name !== undefined && !text(b.name, 255)) invalid('name has 1 to 255 characters without surrounding spaces.');
  if (b.deletion_enabled !== undefined && typeof b.deletion_enabled !== 'boolean')
    invalid('deletion_enabled is true or false.');
  if (
    b.default_currency !== undefined &&
    (typeof b.default_currency !== 'string' || !/^[A-Z]{3}$/.test(b.default_currency))
  )
    invalid('default_currency is an ISO 4217 code.');
  for (const [k, values] of Object.entries(enums))
    if (b[k] !== undefined && !values.includes(b[k])) invalid(k + ' is one of: ' + values.join(', ') + '.');
  checkSchedule(b.schedule, 'schedule');
  checkSchedule(b.update_schedule, 'update_schedule');
}
export function assertMetaProductFeedScope(c: Connection, write = false): void {
  assertMetaCatalogScope(c, write, 'Product feed changes');
}
const graph = (p: CompiledRequest, path: string, query: JsonObject, page: Page = {}): Read => ({
  ...p,
  metaFeedState: undefined,
  metaFeedPage: page,
  action: marker,
  method: 'GET',
  path: metaPrefix + path,
  query,
  body: undefined,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  responseControls: undefined,
  specialTransport: undefined,
});
const read = (p: CompiledRequest, s: State): Read => ({
  ...graph(p, 'act_' + account(p.accountId), {fields: 'id,business{id}'}),
  metaFeedState: s,
});
export function metaProductFeedSnapshots(p: CompiledRequest): Read[] {
  const kind = metaProductFeedKind(p)!;
  return [read(p, kind === 'create' ? {kind, catalog: idOf(p)} : {kind, feed: idOf(p)})];
}
export function isMetaProductFeedRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).metaFeedState;
}
/** Writes after validation, and the family's reads: the account, its business's catalogs and the tagged catalog or feed. */
export function authorizeMetaProductFeed(p: CompiledRequest, c: Connection, selected: string): boolean {
  if (metaProductFeedKind(p)) {
    assertMetaProductFeed(p);
    assertMetaProductFeedScope(c, true);
    if (account(p.accountId) !== selected)
      fail('ACCOUNT_SCOPE_MISMATCH', 'Select the ad account whose business owns the catalog.', {}, 403);
    return true;
  }
  const r = p as Read;
  if (
    p.gateway !== gateway ||
    p.action !== marker ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined ||
    account(p.accountId) !== selected ||
    !(r.metaFeedPage || r.metaFeedState)
  )
    return false;
  assertMetaProductFeedScope(c);
  const keys = Object.keys(p.query).sort().join(),
    page = r.metaFeedPage ?? {},
    paged = (fields: string) =>
      p.query.fields === fields &&
      String(p.query.limit) === String(pageSize) &&
      ['fields,limit', 'after,fields,limit'].includes(keys);
  if (p.path === metaPrefix + 'act_' + selected) return keys === 'fields' && p.query.fields === 'id,business{id}';
  if (page.business && numeric(page.business) && p.path === metaPrefix + page.business + '/owned_product_catalogs')
    return paged('id');
  if (page.catalog && numeric(page.catalog)) {
    if (p.path === metaPrefix + page.catalog) return keys === 'fields' && p.query.fields === metaCatalogFields;
    if (p.path === metaPrefix + page.catalog + '/product_feeds') return paged(feedFields);
  }
  if (page.feed && numeric(page.feed) && p.path === metaPrefix + page.feed)
    return keys === 'fields' && p.query.fields === feedFields;
  return false;
}
/** A schedule as Meta reads it back, reduced to what a request sets. */
const scheduleView = (v: unknown): JsonObject | null => {
  const s =
    typeof v === 'string'
      ? (() => {
          try {
            return JSON.parse(v);
          } catch {
            return null;
          }
        })()
      : v;
  if (!object(s)) return null;
  const out: JsonObject = {};
  for (const k of scheduleKeys)
    if (s[k] !== undefined && s[k] !== null)
      out[k] = ['hour', 'minute', 'day_of_month', 'interval_count'].includes(k) ? Number(s[k]) : s[k];
  return out;
};
const feedView = (x: JsonObject): JsonObject => ({
  id: String(x.id),
  name: x.name ?? null,
  schedule: scheduleView(x.schedule),
  update_schedule: scheduleView(x.update_schedule),
  deletion_enabled: x.deletion_enabled ?? null,
  default_currency: x.default_currency ?? null,
  delimiter: x.delimiter ?? null,
  encoding: x.encoding ?? null,
  quoted_fields_mode: x.quoted_fields_mode ?? null,
  feed_type: x.feed_type ?? null,
  ingestion_source_type: x.ingestion_source_type ?? null,
  // Whether the feed holds products, not how many: counts change with every fetch.
  has_products: x.product_count === undefined ? null : Number(x.product_count) > 0,
});
/**
 * The account's business and the catalog: for a new feed the requested catalog and its feeds, for a change the feed and
 * the catalog of the business that holds it (Meta's feed does not name its catalog, so the business's catalogs are read).
 */
export async function readMetaProductFeeds(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).metaFeedState;
  if (!s) return fetch(p);
  const list = async (first: Read, label: string, pages: number) => {
    const rows: JsonObject[] = [];
    let q = first;
    for (let page = 0; ; page++) {
      if (page >= pages) unverified('Meta listed more ' + label + ' than one review reads.');
      const r = await fetch(q),
        d = r.data;
      if (r.status !== 200 || !object(d) || !Array.isArray(d.data)) unverified('Meta did not list the ' + label + '.');
      for (const row of d.data as unknown[]) if (object(row)) rows.push(row);
      const after = object(d.paging) && object(d.paging.cursors) ? d.paging.cursors.after : undefined;
      if (!(object(d.paging) && d.paging.next)) return rows;
      if (typeof after !== 'string' || !after) unverified('Meta listed more ' + label + ' without a cursor.');
      q = {...q, query: {...q.query, after}};
    }
  };
  const feedsOf = (catalog: string) =>
    list(graph(p, catalog + '/product_feeds', {fields: feedFields, limit: pageSize}, {catalog}), 'feeds', maxFeedPages);
  if (s.verify) {
    const x = await optionalMetaRead(fetch, graph(p, s.feed!, {fields: feedFields}, {feed: s.feed}), 'feed');
    return {status: 200, headers: {}, data: {feed: x ? {present: true, ...feedView(x)} : {present: false, id: s.feed}}};
  }
  const acct = await optionalMetaRead(
    fetch,
    graph(p, 'act_' + account(p.accountId), {fields: 'id,business{id}'}),
    'ad account',
  );
  if (!acct) unverified('Meta did not return the ad account.');
  const business = object(acct.business) && numeric(String(acct.business.id)) ? String(acct.business.id) : null;
  const out: JsonObject = {account_id: account(p.accountId), business};
  let catalogId = s.catalog;
  if (s.feed) {
    const x = await optionalMetaRead(fetch, graph(p, s.feed, {fields: feedFields}, {feed: s.feed}), 'feed');
    out.feed = x ? {present: true, ...feedView(x)} : {present: false, id: s.feed};
    if (!x) return {status: 200, headers: {}, data: out};
    if (!business) return {status: 200, headers: {}, data: {...out, catalog: {present: false, id: null}}};
    const catalogs = await list(
      graph(p, business + '/owned_product_catalogs', {fields: 'id', limit: pageSize}, {business}),
      'catalogs of the business',
      1,
    );
    if (catalogs.length > maxCatalogs)
      unverified('The business has more catalogs than one review reads (' + maxCatalogs + ').');
    for (const c of catalogs) {
      const id = String(c.id);
      if (!numeric(id)) unverified('Meta listed a malformed catalog.');
      if ((await feedsOf(id)).some(f => String(f.id) === s.feed)) {
        catalogId = id;
        break;
      }
    }
    if (!catalogId) return {status: 200, headers: {}, data: {...out, catalog: {present: false, id: null}}};
  }
  const c = await optionalMetaRead(
    fetch,
    graph(p, catalogId!, {fields: metaCatalogFields}, {catalog: catalogId}),
    'catalog',
  );
  out.catalog = metaCatalogView(c, catalogId!);
  if (c && s.kind === 'create')
    out.feeds = (await feedsOf(catalogId!)).map(feedView).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return {status: 200, headers: {}, data: out};
}
export function validateMetaProductFeedState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).metaFeedState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || (s.verify || s.kind !== 'create' ? !object(d.feed) : !object(d.catalog)))
    unverified('Missing verified product feed state.');
}
export function metaProductFeedPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = metaProductFeedKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s)) unverified('Missing verified product feed state.');
  if (kind !== 'create' && (!object(s.feed) || s.feed.present === false))
    fail('STATE_NOT_FOUND', 'Product feed ' + idOf(p) + ' was not found.', {product_feed_id: idOf(p)}, 404);
  if (kind !== 'create' && object(s.catalog) && s.catalog.present === false && s.catalog.id === null)
    fail(
      'STATE_TARGET_MISMATCH',
      'Product feed ' + idOf(p) + " is not in a catalog of the selected ad account's business.",
      {product_feed_id: idOf(p)},
      409,
    );
  assertMetaCatalogOfBusiness(s, kind === 'create' ? idOf(p) : null);
  const b = body(p);
  if (kind === 'create') {
    if (!Array.isArray(s.feeds)) unverified('Missing the feeds of the catalog.');
    if ((s.feeds as JsonObject[]).some(f => String(f.name).toLowerCase() === String(b.name).toLowerCase()))
      fail('CONFIGURATION_EXISTS', 'The catalog already has a feed named "' + String(b.name) + '".', {
        name: String(b.name),
      });
    return;
  }
  if (kind === 'update') {
    const before = s.feed as JsonObject;
    if (b.deletion_enabled === false && before.deletion_enabled === true)
      invalid('Deletion is on for this feed, and Meta does not allow turning it off once enabled.');
    const same = Object.keys(b).every(k =>
      k === 'schedule' || k === 'update_schedule'
        ? stable(scheduleView(scheduleOf(b[k], k))) === stable(before[k])
        : b[k] === before[k],
    );
    if (same) invalid('Product feed ' + idOf(p) + ' already has these values.');
  }
}
const when = (s: JsonObject | null | undefined) => {
  if (!s) return 'no schedule';
  const at =
    s.hour !== undefined ? ' at ' + String(s.hour).padStart(2, '0') + ':' + String(s.minute ?? 0).padStart(2, '0') : '';
  const every = Number(s.interval_count ?? 1) > 1 ? 'every ' + s.interval_count + ' × ' : '';
  return (
    every +
    String(s.interval) +
    (s.day_of_week ? ' on ' + s.day_of_week : '') +
    (s.day_of_month ? ' on day ' + s.day_of_month : '') +
    at +
    ' (' +
    String(s.timezone ?? "America/Los_Angeles, Meta's default") +
    ') from ' +
    String(s.url)
  );
};
export function metaProductFeedImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = metaProductFeedKind(p);
  if (!kind) return;
  const s: JsonObject = object(state[0]) ? state[0] : {},
    b = body(p),
    before: JsonObject = object(s.feed) ? s.feed : {};
  const schedule = scheduleView(scheduleOf(b.schedule, 'schedule') ?? before.schedule),
    updates = scheduleView(scheduleOf(b.update_schedule, 'update_schedule') ?? before.update_schedule);
  const deletion = b.deletion_enabled ?? before.deletion_enabled;
  return {
    provider: 'meta',
    scope: 'product_feed',
    operation: kind,
    catalog: s.catalog ?? null,
    ...(kind === 'create'
      ? {creating: {...b}}
      : kind === 'update'
        ? {before, after: {...before, ...b}}
        : {deleting: before}),
    ...(kind !== 'delete'
      ? {
          fetches: when(schedule),
          ...(updates ? {updates: when(updates) + ' (updates and new items only; no item is deleted)'} : {}),
          deletion:
            deletion === true
              ? 'On: each fetch removes catalog products that are no longer in the file (Meta: "remove products from a catalog that are no longer present in a feed"). Meta does not allow turning it off once enabled.'
              : 'Off: fetches add and update products; products removed from the file stay in the catalog.',
        }
      : {}),
    may_affect_serving: kind !== 'create' && before.has_products === true,
    effect:
      kind === 'create'
        ? 'Creates a feed that Meta fetches on its schedule into the catalog; ads that use product sets of the catalog show what it brings.'
        : kind === 'update'
          ? 'Changes the feed; its next fetch follows the new settings.'
          : 'Deletes the feed. Meta: "Deleting a product feed effectively disables all ads using products that come from this feed." ' +
            (before.has_products === true ? 'This feed holds products.' : 'Meta listed no product in this feed.') +
            ' A new feed with the same product IDs re-enables those ads.',
    verification:
      kind === 'delete'
        ? 'Reads the feed again and expects it to be gone.'
        : 'Reads the feed again and compares its name, schedules and settings.',
    source,
  };
}
export function metaProductFeedOutcome(p: CompiledRequest, r: TransportResult): boolean {
  if (r.status !== 200 || !object(r.data)) return false;
  return metaProductFeedKind(p) === 'create' ? numeric(String(r.data.id ?? '')) : r.data.success === true;
}
export function metaProductFeedVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = metaProductFeedKind(p)!,
    id = kind === 'create' ? String(result.data?.id ?? '') : idOf(p);
  if (!numeric(id)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no product feed.');
  const b = body(p),
    feed: JsonObject = {present: kind !== 'delete'};
  if (kind !== 'delete')
    for (const [k, v] of Object.entries(b))
      if (k !== 'country' && k !== 'feed_type')
        feed[k] = k === 'schedule' || k === 'update_schedule' ? scheduleView(scheduleOf(v, k)) : v;
  return [{read: read(p, {kind, feed: id, verify: true}), expected: {feed}, id: 'product feed ' + id}];
}
/**
 * Feed-driven deletion (WRT-02 stage C, owner decision D8: allow_deletion:false governs it, judged on the current feed).
 * With deletion_enabled on, "this will remove products from a catalog that are no longer present in a feed", so these
 * requests delete through the feed: a feed DELETE; a create or update that sets deletion_enabled true (Meta does not
 * allow turning it off again); and an update of the URL, interval or interval count of a feed whose deletion is on,
 * because its next fetch removes every product the new file lacks. `before` is the reviewed state, which the owner
 * policy always passes for this family (it reads the feed at prepare and again at execute); the plan alone, as the
 * compiler classifies it, cannot show a schedule change to delete. update_schedule only adds and updates items ("No
 * items would be deleted"), and a name or format change fetches the same file, so neither deletes anything. A feed
 * whose read-back does not state deletion_enabled counts as deletion on, Meta's default.
 */
export function metaProductFeedDeletes(p: CompiledRequest, before?: unknown): boolean {
  const kind = metaProductFeedKind(p);
  if (!kind) return false;
  if (kind === 'delete') return true;
  const b = body(p);
  if (b.deletion_enabled === true) return true;
  if (kind === 'create' || b.schedule === undefined) return false;
  const s = Array.isArray(before) && object(before[0]) ? before[0] : undefined,
    feed = s && object(s.feed) ? s.feed : undefined;
  if (!feed || feed.present === false || feed.deletion_enabled === false) return false;
  let next: JsonObject | null = null;
  try {
    next = scheduleView(scheduleOf(b.schedule, 'schedule'));
  } catch {
    return true;
  }
  const current = object(feed.schedule) ? feed.schedule : {};
  return (
    !next ||
    String(next.url ?? '') !== String(current.url ?? '') ||
    String(next.interval ?? '') !== String(current.interval ?? '') ||
    Number(next.interval_count ?? 1) !== Number(current.interval_count ?? 1)
  );
}
export function metaProductFeedObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  const x = object(data.feed) ? data.feed : {};
  if (!x.present) return {feed: {present: false}};
  const {has_products: _count, id: _id, ...rest} = x;
  return {feed: rest};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const metaProductFeedFamily: ReviewedFamily = {
  name: 'meta_product_feeds',
  files: ['src/meta-product-feeds.ts', ['tests/meta-product-feeds.test.mjs']],
  kind: metaProductFeedKind,
  assert: assertMetaProductFeed,
  scope: assertMetaProductFeedScope,
  authorize: authorizeMetaProductFeed,
  snapshots: metaProductFeedSnapshots,
  isRead: isMetaProductFeedRead,
  reader: readMetaProductFeeds,
  validateState: validateMetaProductFeedState,
  prerequisites: metaProductFeedPrerequisites,
  impact: metaProductFeedImpact,
  outcome: metaProductFeedOutcome,
  verification: metaProductFeedVerification,
  observed: metaProductFeedObserved,
  destructive: metaProductFeedDeletes,
};
