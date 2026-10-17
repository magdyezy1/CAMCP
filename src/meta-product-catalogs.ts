import {stable} from './security.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {metaPrefix, metaRoute} from './meta-version.js';
import {assertMetaCatalogOfBusiness, assertMetaCatalogScope, optionalMetaRead} from './meta-catalogs.js';
import {fail} from './family-kit.js';

/**
 * Meta product catalogs themselves, opened by the owner on 2026-09-29. Meta's references (read 2026-09-29): "Business
 * Owned Product Catalogs" (POST /{business_id}/owned_product_catalogs creates a catalog: name required, vertical
 * "Default value: commerce", da_display_settings, and settings for other verticals, segments and partners; answers
 * {id}) and "Product Catalog" (POST /{product_catalog_id} updates name, da_display_settings, default_image_url,
 * fallback_image_url and the same settings; DELETE /{product_catalog_id}: "If the catalog has live product sets, the
 * deletion will be blocked by default. Set this parameter [allow_delete_catalog_with_live_product_set] to true to
 * enforce the deletion even if it has live product sets"; "You must be assigned as an admin of this product catalog
 * before you can delete it").
 *
 * AMCP creates commerce catalogs under the selected ad account's business and changes catalogs of that business. It
 * sends name, da_display_settings and the two image addresses only: partner_integration carries an external access
 * token, and store, flight, destination, segment and vertical options stay outside. It never sends
 * allow_delete_catalog_with_live_product_set, so Meta's own block on live product sets holds.
 */
type Kind = 'create' | 'update' | 'delete';
type State = {kind: Kind; catalog?: string; verify?: boolean};
type Page = {catalog?: string};
type Read = CompiledRequest & {metaCatalogState?: State; metaCatalogPage?: Page};
const gateway = 'meta_native_action',
  marker = 'AMCP_META_PRODUCT_CATALOG_READ',
  pageSize = 100,
  maxPages = 3,
  source = 'https://developers.facebook.com/docs/marketing-api/reference/product-catalog/';
const actions: Record<string, Kind> = {
  meta_business_id_owned_product_catalogs_create: 'create',
  meta_product_catalog_id_update: 'update',
  meta_product_catalog_id_delete: 'delete',
};
const catalogFields =
    'id,name,vertical,business{id},da_display_settings,default_image_url,fallback_image_url,product_count,feed_count',
  transformations = ['background_cropping_and_padding', 'background_padding', 'none'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const account = (v: unknown) => String(v ?? '').replace(/^act_/, '');
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v === v.trim() && v.length > 0 && [...v].length <= max && !/[\u0000-\u001f\u007f]/.test(v);
function invalid(message: string): never {
  return fail('INVALID_META_PRODUCT_CATALOG', message, {source});
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function metaProductCatalogKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport || (p.origin && p.origin !== 'https://graph.facebook.com')) return;
  const kind = actions[p.action];
  if (kind === 'create')
    return p.method === 'POST' && metaRoute('[1-9][0-9]{0,31}/owned_product_catalogs$').test(p.path) ? kind : undefined;
  if (kind === 'update') return p.method === 'POST' && metaRoute('[1-9][0-9]{0,31}$').test(p.path) ? kind : undefined;
  if (kind === 'delete') return p.method === 'DELETE' && metaRoute('[1-9][0-9]{0,31}$').test(p.path) ? kind : undefined;
}
const idOf = (p: CompiledRequest) => p.path.split('/')[2]!;
const body = (p: CompiledRequest): JsonObject => (object(p.body) ? p.body : {});
function httpsUrl(v: unknown): boolean {
  if (typeof v !== 'string' || v.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}
function checkDisplay(v: unknown): void {
  const ad = (x: unknown) =>
    object(x) && Object.keys(x).length === 1 && transformations.includes(String(x.transformation_type));
  if (
    !object(v) ||
    Object.keys(v).some(k => !['carousel_ad', 'single_ad'].includes(k)) ||
    !ad(v.carousel_ad) ||
    !ad(v.single_ad)
  )
    invalid(
      'da_display_settings is {carousel_ad: {transformation_type}, single_ad: {transformation_type}}, each one of ' +
        transformations.join(', ') +
        '.',
    );
}
export function assertMetaProductCatalog(p: CompiledRequest): void {
  const kind = metaProductCatalogKind(p);
  if (!kind) return;
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Catalog writes take their parameters in the body, without query or header overrides.');
  const b = p.body === undefined ? {} : p.body;
  if (!object(b)) invalid('Send the catalog parameters as an object.');
  if (kind === 'delete') {
    if (Object.keys(b).length)
      invalid(
        'Deletion takes only the catalog in the path. AMCP never sends allow_delete_catalog_with_live_product_set: Meta blocks deleting a catalog with live product sets, and that block stays.',
      );
    return;
  }
  if (b.partner_integration !== undefined)
    invalid('partner_integration carries an external access token; credentials never pass through AMCP.');
  const fields =
    kind === 'create'
      ? ['name', 'vertical', 'da_display_settings']
      : ['name', 'da_display_settings', 'default_image_url', 'fallback_image_url'];
  const extra = Object.keys(b).filter(k => !fields.includes(k));
  if (extra.length)
    invalid(
      'A catalog ' +
        (kind === 'create' ? 'creation' : 'update') +
        ' takes ' +
        fields.join(', ') +
        '; store, flight, destination, segment and vertical options stay outside. Unqualified: ' +
        extra.join(', ') +
        '.',
    );
  if (kind === 'update' && !Object.keys(b).length) invalid('Name what changes: ' + fields.join(', ') + '.');
  if ((kind === 'create' || b.name !== undefined) && !text(b.name, 255))
    invalid('name has 1 to 255 characters without surrounding spaces or control characters.');
  if (b.vertical !== undefined && b.vertical !== 'commerce')
    invalid("AMCP creates commerce catalogs (Meta's default); other verticals stay outside.");
  if (b.da_display_settings !== undefined) checkDisplay(b.da_display_settings);
  for (const k of ['default_image_url', 'fallback_image_url'])
    if (b[k] !== undefined && !httpsUrl(b[k])) invalid(k + ' is an HTTPS address without credentials.');
}
const graph = (p: CompiledRequest, path: string, query: JsonObject, page: Page = {}): Read => ({
  ...p,
  metaCatalogState: undefined,
  metaCatalogPage: page,
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
  metaCatalogState: s,
});
export function metaProductCatalogSnapshots(p: CompiledRequest): Read[] {
  const kind = metaProductCatalogKind(p)!;
  return [read(p, kind === 'create' ? {kind} : {kind, catalog: idOf(p)})];
}
export function isMetaProductCatalogRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).metaCatalogState;
}
/** Writes after validation, and the family's reads: the account, and the tagged catalog with its sets and feeds. */
export function authorizeMetaProductCatalog(p: CompiledRequest, c: Connection, selected: string): boolean {
  if (metaProductCatalogKind(p)) {
    assertMetaProductCatalog(p);
    assertMetaCatalogScope(c, true, 'Catalog changes');
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
    !(r.metaCatalogPage || r.metaCatalogState)
  )
    return false;
  assertMetaCatalogScope(c, false, 'Catalog reads');
  const keys = Object.keys(p.query).sort().join(),
    page = r.metaCatalogPage ?? {},
    paged =
      p.query.fields === 'id,name' &&
      String(p.query.limit) === String(pageSize) &&
      ['fields,limit', 'after,fields,limit'].includes(keys);
  if (p.path === metaPrefix + 'act_' + selected) return keys === 'fields' && p.query.fields === 'id,business{id}';
  if (page.catalog && numeric(page.catalog)) {
    if (p.path === metaPrefix + page.catalog) return keys === 'fields' && p.query.fields === catalogFields;
    if (
      p.path === metaPrefix + page.catalog + '/product_sets' ||
      p.path === metaPrefix + page.catalog + '/product_feeds'
    )
      return paged;
  }
  return false;
}
const fallbackView = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : [];
const displayView = (v: unknown): JsonObject | null =>
  object(v)
    ? Object.fromEntries(
        ['carousel_ad', 'single_ad'].map(k => [
          k,
          object(v[k]) ? {transformation_type: (v[k] as JsonObject).transformation_type ?? null} : null,
        ]),
      )
    : null;
/** The catalog as a review shows it. Counts become whether there is any: feeds change them all the time. */
const catalogView = (c: JsonObject | undefined, id: string): JsonObject =>
  c
    ? {
        present: true,
        id: String(c.id),
        name: c.name ?? null,
        vertical: c.vertical ?? null,
        business: object(c.business) && c.business.id !== undefined ? String(c.business.id) : null,
        da_display_settings: displayView(c.da_display_settings),
        default_image_url: c.default_image_url ?? null,
        fallback_image_url: fallbackView(c.fallback_image_url),
        has_products: c.product_count === undefined ? null : Number(c.product_count) > 0,
        has_feeds: c.feed_count === undefined ? null : Number(c.feed_count) > 0,
      }
    : {present: false, id};
/** The account's business; the catalog for a change; its product sets and feeds for a deletion. */
export async function readMetaProductCatalogs(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).metaCatalogState;
  if (!s) return fetch(p);
  const catalogRead = (id: string) =>
    optionalMetaRead(fetch, graph(p, id, {fields: catalogFields}, {catalog: id}), 'catalog');
  if (s.verify)
    return {status: 200, headers: {}, data: {catalog: catalogView(await catalogRead(s.catalog!), s.catalog!)}};
  const acct = await optionalMetaRead(
    fetch,
    graph(p, 'act_' + account(p.accountId), {fields: 'id,business{id}'}),
    'ad account',
  );
  if (!acct) unverified('Meta did not return the ad account.');
  const business = object(acct.business) && numeric(String(acct.business.id)) ? String(acct.business.id) : null;
  const out: JsonObject = {account_id: account(p.accountId), business};
  if (s.catalog) {
    const c = catalogView(await catalogRead(s.catalog), s.catalog);
    out.catalog = c;
    if (s.kind === 'delete' && c.present && c.business === business) {
      const list = async (edge: string) => {
        const rows: JsonObject[] = [];
        let q = graph(p, s.catalog + '/' + edge, {fields: 'id,name', limit: pageSize}, {catalog: s.catalog});
        for (let page = 0; ; page++) {
          if (page >= maxPages) unverified('Meta listed more ' + edge + ' than one review reads.');
          const r = await fetch(q),
            d = r.data;
          if (r.status !== 200 || !object(d) || !Array.isArray(d.data))
            unverified('Meta did not list the ' + edge + '.');
          for (const x of d.data as unknown[]) if (object(x)) rows.push({id: String(x.id), name: x.name ?? null});
          const after = object(d.paging) && object(d.paging.cursors) ? d.paging.cursors.after : undefined;
          if (!(object(d.paging) && d.paging.next))
            return rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
          if (typeof after !== 'string' || !after) unverified('Meta listed more ' + edge + ' without a cursor.');
          q = {...q, query: {...q.query, after}};
        }
      };
      out.product_sets = await list('product_sets');
      out.feeds = await list('product_feeds');
    }
  }
  return {status: 200, headers: {}, data: out};
}
export function validateMetaProductCatalogState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).metaCatalogState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || (s.verify ? !object(d.catalog) : !('business' in d)))
    unverified('Missing verified catalog state.');
}
export function metaProductCatalogPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = metaProductCatalogKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s)) unverified('Missing verified catalog state.');
  if (kind === 'create') {
    if (!s.business || s.business !== idOf(p))
      fail(
        'STATE_TARGET_MISMATCH',
        'Business ' +
          idOf(p) +
          " is not the selected ad account's business" +
          (s.business ? ' (' + String(s.business) + ')' : '') +
          '; AMCP creates catalogs only under that business.',
        {business_id: idOf(p)},
        409,
      );
    return;
  }
  assertMetaCatalogOfBusiness(s, idOf(p));
  if (kind === 'delete') {
    if (!Array.isArray(s.product_sets) || !Array.isArray(s.feeds)) unverified('Missing the product sets and feeds.');
    return;
  }
  const c = s.catalog as JsonObject,
    b = body(p);
  const same = (k: string) =>
    k === 'fallback_image_url'
      ? stable(fallbackView(b[k])) === stable(c[k])
      : k === 'da_display_settings'
        ? stable(displayView(b[k])) === stable(c[k])
        : b[k] === c[k];
  if (Object.keys(b).every(same)) invalid('Catalog ' + idOf(p) + ' already has these values.');
}
export function metaProductCatalogImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = metaProductCatalogKind(p);
  if (!kind) return;
  const s: JsonObject = object(state[0]) ? state[0] : {},
    b = body(p),
    c = object(s.catalog) ? s.catalog : null;
  if (kind === 'create')
    return {
      provider: 'meta',
      scope: 'product_catalog',
      operation: 'create',
      business: idOf(p),
      creating: {
        name: b.name,
        vertical: 'commerce',
        ...(b.da_display_settings ? {da_display_settings: b.da_display_settings} : {}),
      },
      may_affect_serving: false,
      effect:
        'Creates an empty commerce catalog owned by the business; feeds and product writes fill it, and ads use it through product sets.',
      note: 'Catalog changes need catalog_management with ads_management, which Meta grants after app review.',
      verification: 'Reads the new catalog and compares name, vertical, business and display settings.',
      source,
    };
  if (kind === 'update')
    return {
      provider: 'meta',
      scope: 'product_catalog',
      operation: 'update',
      business: s.business ?? null,
      before: c ? Object.fromEntries(Object.keys(b).map(k => [k, c[k] ?? null])) : null,
      after: Object.fromEntries(
        Object.keys(b).map(k => [
          k,
          k === 'fallback_image_url' ? fallbackView(b[k]) : k === 'da_display_settings' ? displayView(b[k]) : b[k],
        ]),
      ),
      may_affect_serving: b.da_display_settings !== undefined || b.default_image_url !== undefined,
      effect:
        'Changes what is sent. Display settings decide how product images are cropped or padded in dynamic ads; the default image stands in for products without one.',
      verification: 'Reads the catalog again and compares what was sent.',
      source,
    };
  const sets = (Array.isArray(s.product_sets) ? s.product_sets : []) as JsonObject[],
    feeds = (Array.isArray(s.feeds) ? s.feeds : []) as JsonObject[];
  return {
    provider: 'meta',
    scope: 'product_catalog',
    operation: 'delete',
    business: s.business ?? null,
    deleting: c,
    product_sets: sets,
    feeds,
    warning:
      'The catalog belongs to the business, so other ad accounts of it may use it. Meta blocks the deletion while a product set of it is live, and AMCP never overrides that block.',
    may_affect_serving: true,
    effect:
      'Deletes the catalog' +
      (sets.length || feeds.length
        ? ', with its ' + sets.length + ' product set(s) and ' + feeds.length + ' feed(s)'
        : '') +
      '. Meta requires the deleting user to be an admin of the catalog.',
    verification: 'Reads the catalog again and expects Meta to say it does not exist.',
    source,
  };
}
export function metaProductCatalogOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = metaProductCatalogKind(p)!,
    d = r.data;
  if (r.status !== 200 || !object(d) || d.error) return false;
  if (kind === 'create') return numeric(String(d.id ?? ''));
  return d.success === true || (kind === 'update' && String(d.id ?? '') === idOf(p));
}
export function metaProductCatalogVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = metaProductCatalogKind(p)!,
    id = kind === 'create' ? String(result.data?.id ?? '') : idOf(p);
  if (!numeric(id)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no catalog.');
  const b = body(p);
  const expected: JsonObject =
    kind === 'delete'
      ? {present: false}
      : {
          present: true,
          id,
          ...(b.name !== undefined ? {name: b.name} : {}),
          ...(kind === 'create' ? {vertical: 'commerce', business: idOf(p)} : {}),
          ...(b.da_display_settings !== undefined ? {da_display_settings: displayView(b.da_display_settings)} : {}),
          ...(b.default_image_url !== undefined ? {default_image_url: b.default_image_url} : {}),
          ...(b.fallback_image_url !== undefined ? {fallback_image_url: fallbackView(b.fallback_image_url)} : {}),
        };
  return [{read: read(p, {kind, catalog: id, verify: true}), expected: {catalog: expected}, id: 'catalog ' + id}];
}
export function metaProductCatalogObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {catalog: object(data.catalog) ? data.catalog : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const metaProductCatalogFamily: ReviewedFamily = {
  name: 'meta_product_catalogs',
  files: ['src/meta-product-catalogs.ts', ['tests/meta-product-catalogs.test.mjs']],
  kind: metaProductCatalogKind,
  assert: plan => assertMetaProductCatalog(plan),
  authorize: authorizeMetaProductCatalog,
  snapshots: metaProductCatalogSnapshots,
  isRead: isMetaProductCatalogRead,
  reader: readMetaProductCatalogs,
  validateState: validateMetaProductCatalogState,
  prerequisites: metaProductCatalogPrerequisites,
  impact: metaProductCatalogImpact,
  outcome: metaProductCatalogOutcome,
  verification: metaProductCatalogVerification,
  observed: metaProductCatalogObserved,
  destructive: plan => metaProductCatalogKind(plan) === 'delete',
};
