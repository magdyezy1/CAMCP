import {stable} from './security.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {metaPrefix, metaRoute} from './meta-version.js';
import {
  assertMetaCatalogOfBusiness,
  assertMetaCatalogScope,
  metaAbsent,
  metaCatalogFields,
  metaCatalogView,
  metaRefusal,
  optionalMetaRead,
} from './meta-catalogs.js';
import {defineFamily, fail, readOf} from './family-kit.js';

/**
 * Product sets of Meta catalogs, opened by the owner on 2026-09-29 ("Product catalogs: make it available").
 * Meta's "Product Catalog Product Sets" reference (read 2026-09-29): POST /{product_catalog_id}/product_sets creates a
 * set from `name` (required), `filter` ("a JSON-encoded rule", at most 500 KiB; empty means every item of the
 * catalog), `retailer_id`, `metadata` and `publish_to_shops`, and answers {id}; error 10803 "Product set with the same
 * filters already exists". "If the filter rules you set result in an empty product set, ads tied to this product set
 * will not deliver." The ProductSet node's update (the same fields) and delete (`allow_live_product_set_deletion`)
 * come from Meta's official Business SDK 26.0.2; the node's reference page is not readable here.
 *
 * AMCP writes only sets of catalogs that belong to the selected ad account's business. It refuses shop publishing and
 * collection metadata (commerce storefronts), and deleting a live set. Before a write it reads the catalog's sets, the
 * products the filter selects, and for a change or deletion the account's ad sets (promoted_object.product_set_id) and
 * creatives (product_set_id) that use the set.
 */
type Kind = 'create' | 'update' | 'delete';
type State = {kind: Kind; catalog?: string; set?: string; filter?: string; verify?: boolean};
/** A server-built read, tagged with the only catalog and set it may name. */
type Page = {catalog?: string; set?: string};
type Read = CompiledRequest & {metaProductSetState?: State; metaProductSetPage?: Page};
const marker = 'AMCP_META_PRODUCT_SET_READ';
const gateway = 'meta_native_action',
  maxPages = 10,
  pageSize = 100,
  maxFilterBytes = 500 * 1024,
  maxDepth = 6,
  maxRules = 200,
  source = 'https://developers.facebook.com/docs/marketing-api/reference/product-catalog/product_sets/';
const actions: Record<string, Kind> = {
  meta_product_catalog_id_product_sets_create: 'create',
  meta_product_set_id_update: 'update',
  meta_product_set_id_delete: 'delete',
};
/** The documented operators; "i_* operators can still be used". starts_with is documented for category only. */
const listOperators = ['is_any', 'is_not_any', 'i_is_any', 'i_is_not_any'],
  textOperators = [
    'eq',
    'neq',
    'contains',
    'not_contains',
    'i_contains',
    'i_not_contains',
    'starts_with',
    'i_starts_with',
  ],
  numberOperators = ['lt', 'lte', 'gt', 'gte'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const account = (v: unknown) => String(v ?? '').replace(/^act_/, '');
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v === v.trim() && v.length > 0 && [...v].length <= max && !/[\u0000-\u001f\u007f]/.test(v);
function invalid(message: string, details: JsonObject = {}): never {
  return fail('INVALID_META_PRODUCT_SET', message, {source, ...details});
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function metaProductSetKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport || (p.origin && p.origin !== 'https://graph.facebook.com')) return;
  const kind = actions[p.action];
  if (kind === 'create')
    return p.method === 'POST' && metaRoute('[1-9][0-9]{0,31}/product_sets$').test(p.path) ? kind : undefined;
  if (kind === 'update') return p.method === 'POST' && metaRoute('[1-9][0-9]{0,31}$').test(p.path) ? kind : undefined;
  if (kind === 'delete') return p.method === 'DELETE' && metaRoute('[1-9][0-9]{0,31}$').test(p.path) ? kind : undefined;
}
const idOf = (p: CompiledRequest) => p.path.split('/')[2]!;
const body = (p: CompiledRequest): JsonObject => (object(p.body) ? p.body : {});
/** The filter as sent: an object, or its JSON text. Undefined when the request has none. */
function filterOf(p: CompiledRequest): JsonObject | undefined {
  const f = body(p).filter;
  if (f === undefined) return;
  if (typeof f === 'string') {
    if (!f.trim()) return {};
    try {
      const parsed = JSON.parse(f);
      if (object(parsed)) return parsed;
    } catch {}
    invalid('filter must be a JSON object of rules.');
  }
  if (!object(f)) invalid('filter must be a JSON object of rules.');
  return f;
}
/** One rule: {} (every item), {and|or: [rules]}, or {field: {operator: value}}. */
function checkRule(rule: unknown, depth: number, count: {n: number}): void {
  if (!object(rule)) invalid('Each filter rule is an object.');
  if (++count.n > maxRules) invalid('A filter holds at most ' + maxRules + ' rules.');
  if (depth > maxDepth) invalid('Filter rules nest at most ' + maxDepth + ' levels.');
  const keys = Object.keys(rule);
  if (!keys.length) {
    if (depth > 0) invalid('An empty rule is allowed only as the whole filter (every item of the catalog).');
    return;
  }
  if (keys.length !== 1) invalid('Each rule names one field, or combines rules with and / or.');
  const key = keys[0]!,
    value = rule[key];
  if (key === 'and' || key === 'or') {
    if (!Array.isArray(value) || value.length < 1 || value.length > 50)
      invalid(key + ' takes a list of 1 to 50 rules.');
    for (const r of value) checkRule(r, depth + 1, count);
    return;
  }
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) invalid('"' + key + '" is not a catalog field name.');
  if (!object(value) || Object.keys(value).length !== 1)
    invalid('Field ' + key + ' takes one operator: {"operator": value}.');
  const [op, arg] = Object.entries(value)[0]!;
  if (listOperators.includes(op)) {
    if (
      !Array.isArray(arg) ||
      !arg.length ||
      arg.length > 1000 ||
      !arg.every(x => text(x, 500) || (typeof x === 'number' && Number.isFinite(x)))
    )
      invalid(op + ' on ' + key + ' takes a list of 1 to 1,000 values.');
  } else if (textOperators.includes(op)) {
    if ((op === 'starts_with' || op === 'i_starts_with') && key !== 'category')
      invalid(op + ' is documented for the category field only; use contains.');
    if (!(text(arg, 500) || ((op === 'eq' || op === 'neq') && typeof arg === 'number' && Number.isFinite(arg))))
      invalid(op + ' on ' + key + ' takes one value.');
  } else if (numberOperators.includes(op)) {
    if (typeof arg !== 'number' || !Number.isFinite(arg)) invalid(op + ' on ' + key + ' takes a number.');
  } else
    invalid(
      '"' +
        op +
        '" is not a documented filter operator: ' +
        [...listOperators, ...textOperators, ...numberOperators].join(', ') +
        '.',
    );
}
export function assertMetaProductSet(p: CompiledRequest): void {
  const kind = metaProductSetKind(p);
  if (!kind) return;
  if (!numeric(account(p.accountId))) invalid('Select one Meta ad account.');
  if (Object.keys(p.headers).length) invalid('Product set requests take no header overrides.');
  if (kind === 'delete') {
    if (Object.keys(p.query).length || (p.body !== undefined && !(object(p.body) && !Object.keys(p.body).length)))
      invalid(
        'Deleting a product set takes no parameters. allow_live_product_set_deletion stays refused: a set that live ads use is not deleted.',
      );
    return;
  }
  if (Object.keys(p.query).length) invalid('Send the product set fields in the body.');
  if (!object(p.body)) invalid('Send the product set as a native object.');
  const allowed = ['name', 'filter', 'retailer_id'];
  const extra = Object.keys(p.body).filter(k => !allowed.includes(k));
  if (extra.length)
    invalid(
      'A product set takes name, filter and retailer_id; unqualified fields: ' +
        extra.join(', ') +
        ' (shop publishing and collection metadata stay outside AMCP).',
      {fields: extra},
    );
  const b = p.body;
  if (kind === 'create' && b.name === undefined) invalid('name is required.');
  if (kind === 'update' && !Object.keys(b).length) invalid('Name at least one field to change.');
  if (b.name !== undefined && !text(b.name, 255)) invalid('name has 1 to 255 characters without surrounding spaces.');
  if (b.retailer_id !== undefined && !text(b.retailer_id, 100))
    invalid('retailer_id has 1 to 100 characters without surrounding spaces.');
  const f = filterOf(p);
  if (f !== undefined) {
    if (Buffer.byteLength(JSON.stringify(f)) > maxFilterBytes) invalid('filter is at most 500 KiB.');
    checkRule(f, 0, {n: 0});
  }
}
export function assertMetaProductSetScope(c: Connection, write = false): void {
  assertMetaCatalogScope(c, write, 'Product set changes');
}
const graph = (p: CompiledRequest, path: string, query: JsonObject, page: Page = {}): Read =>
  readOf<Read>(p, {
    before: {metaProductSetState: undefined, metaProductSetPage: page},
    action: marker,
    path: metaPrefix + path,
    query,
  });
const setFields = 'id,name,filter,retailer_id,product_catalog{id}',
  catalogFields = metaCatalogFields,
  adSetFields = 'id,name,status,promoted_object',
  creativeFields = 'id,name,status,product_set_id';
const read = (p: CompiledRequest, s: State): Read => ({
  ...graph(p, 'act_' + account(p.accountId), {fields: 'id,business{id}'}),
  metaProductSetState: s,
});
/**
 * Writes after validation, and the family's own reads: the selected account, its ad sets and creatives, and the one
 * catalog or set each read is tagged with (from the validated request or Meta's reply naming the set's catalog).
 */
export function authorizeMetaProductSet(p: CompiledRequest, c: Connection, selected: string): boolean {
  if (metaProductSetKind(p)) {
    assertMetaProductSet(p);
    assertMetaProductSetScope(c, true);
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
    !(r.metaProductSetPage || r.metaProductSetState)
  )
    return false;
  assertMetaProductSetScope(c);
  const keys = Object.keys(p.query).sort().join(),
    page = r.metaProductSetPage ?? {},
    paged = (fields: string) =>
      p.query.fields === fields &&
      String(p.query.limit) === String(pageSize) &&
      ['fields,limit', 'after,fields,limit'].includes(keys);
  const act = metaPrefix + 'act_' + selected;
  if (p.path === act) return keys === 'fields' && p.query.fields === 'id,business{id}';
  if (p.path === act + '/adsets') return paged(adSetFields);
  if (p.path === act + '/adcreatives') return paged(creativeFields);
  if (page.set && numeric(page.set) && p.path === metaPrefix + page.set)
    return keys === 'fields' && p.query.fields === setFields;
  if (page.catalog && numeric(page.catalog)) {
    const catalog = metaPrefix + page.catalog;
    if (p.path === catalog) return keys === 'fields' && p.query.fields === catalogFields;
    if (p.path === catalog + '/product_sets') return paged(setFields);
    if (p.path === catalog + '/products')
      return (
        keys === 'fields,filter,limit' &&
        p.query.fields === 'id' &&
        String(p.query.limit) === '1' &&
        typeof p.query.filter === 'string'
      );
  }
  return false;
}
export function metaProductSetSnapshots(p: CompiledRequest): Read[] {
  const kind = metaProductSetKind(p)!,
    f = filterOf(p);
  return [
    read(p, {
      kind,
      ...(kind === 'create' ? {catalog: idOf(p)} : {set: idOf(p)}),
      ...(f !== undefined ? {filter: stable(f)} : {}),
    }),
  ];
}
export function isMetaProductSetRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).metaProductSetState;
}
/**
 * The first page of the product sets of a create's catalog, tagged with the catalog as the family's own state read tags its
 * pages, so that this family's authorizer claims it (R2.5 M2: the created lookup lists what the catalog holds now).
 */
export const metaProductSetListRead = (p: CompiledRequest): CompiledRequest =>
  graph(p, idOf(p) + '/product_sets', {fields: setFields, limit: pageSize}, {catalog: idOf(p)});
const filterValue = (v: unknown): unknown => {
  if (typeof v !== 'string') return object(v) ? v : v === undefined || v === null ? null : v;
  if (!v.trim()) return {};
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};
const setView = (x: JsonObject) => ({
  id: String(x.id),
  name: x.name ?? null,
  filter: filterValue(x.filter),
  retailer_id: x.retailer_id ?? null,
  catalog_id: object(x.product_catalog) && x.product_catalog.id !== undefined ? String(x.product_catalog.id) : null,
});
/**
 * The account's business, the catalog and its sets, the products the new filter selects, and for a change or deletion
 * the set and the account's ad sets and creatives that use it. Verification reads the set alone.
 */
export async function readMetaProductSets(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).metaProductSetState;
  if (!s) return fetch(p);
  const get = async (q: CompiledRequest, label: string) => {
    const r = await fetch(q);
    if (r.status !== 200 || !object(r.data) || r.data.error) unverified('Meta did not return the ' + label + '.');
    return r.data as JsonObject;
  };
  const all = async (first: CompiledRequest, label: string) => {
    const rows: JsonObject[] = [];
    let q = first;
    for (let page = 0; ; page++) {
      if (page >= maxPages)
        unverified('Meta listed more ' + label + ' than one review reads (' + maxPages * pageSize + ').');
      const d = await get(q, label);
      if (!Array.isArray(d.data)) unverified('Meta did not list the ' + label + '.');
      for (const row of d.data as unknown[]) if (object(row)) rows.push(row);
      const after = object(d.paging) && object(d.paging.cursors) ? d.paging.cursors.after : undefined;
      if (!(object(d.paging) && d.paging.next)) return rows;
      if (typeof after !== 'string' || !after) unverified('Meta listed more ' + label + ' without a cursor.');
      q = {...q, query: {...q.query, after}};
    }
  };
  if (s.verify) {
    const x = await optionalMetaRead(fetch, graph(p, s.set!, {fields: setFields}, {set: s.set}), 'product set');
    return {status: 200, headers: {}, data: {set: x ? {present: true, ...setView(x)} : {present: false, id: s.set}}};
  }
  const acct = await get(graph(p, 'act_' + account(p.accountId), {fields: 'id,business{id}'}), 'ad account');
  const business = object(acct.business) && numeric(String(acct.business.id)) ? String(acct.business.id) : null;
  let set: JsonObject | null = null,
    catalogId = s.catalog;
  if (s.set) {
    const x = await optionalMetaRead(fetch, graph(p, s.set, {fields: setFields}, {set: s.set}), 'product set');
    if (x) {
      set = setView(x);
      if (set.id !== s.set) unverified('Meta returned a different product set.');
      catalogId = set.catalog_id ?? undefined;
      if (!catalogId) unverified('Meta did not name the catalog of the product set.');
    }
  }
  const out: JsonObject = {account_id: account(p.accountId), business, set: set ?? {present: false, id: s.set ?? null}};
  if (!catalogId) return {status: 200, headers: {}, data: out};
  const c = await optionalMetaRead(
    fetch,
    graph(p, catalogId, {fields: catalogFields}, {catalog: catalogId}),
    'catalog',
  );
  out.catalog = metaCatalogView(c, catalogId);
  if (!c) return {status: 200, headers: {}, data: out};
  out.sets = (
    await all(
      graph(p, catalogId + '/product_sets', {fields: setFields, limit: pageSize}, {catalog: catalogId}),
      'product sets',
    )
  )
    .map(setView)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (s.filter !== undefined) {
    // The products the new filter selects: Meta's own reading of the rule, before anything changes.
    let r: TransportResult | undefined;
    try {
      r = await fetch(
        graph(
          p,
          catalogId + '/products',
          {filter: JSON.stringify(JSON.parse(s.filter)), fields: 'id', limit: 1},
          {catalog: catalogId},
        ),
      );
    } catch (e) {
      const err = metaRefusal(e);
      if (!err || metaAbsent(e)) throw e;
      out.filter_refused = String(err.error_user_msg ?? err.message ?? 'Meta refused the filter.').slice(0, 500);
    }
    if (r) {
      if (r.status !== 200 || !object(r.data) || !Array.isArray(r.data.data))
        unverified('Meta did not list the matching products.');
      // Whether the filter selects anything, not how much: counts change as feeds run, and the review compares its
      // state again before it executes.
      out.matching = {any: (r.data.data as unknown[]).length > 0};
    }
  }
  if (s.kind !== 'create' && set) {
    const adsets = await all(
      graph(p, 'act_' + account(p.accountId) + '/adsets', {fields: adSetFields, limit: pageSize}),
      'ad sets',
    );
    const creatives = await all(
      graph(p, 'act_' + account(p.accountId) + '/adcreatives', {fields: creativeFields, limit: pageSize}),
      'creatives',
    );
    out.used_by = {
      ad_sets: adsets
        .filter(a => object(a.promoted_object) && String(a.promoted_object.product_set_id ?? '') === s.set)
        .map(a => ({id: String(a.id), name: a.name ?? null, status: a.status ?? null}))
        .sort((a, b) => a.id.localeCompare(b.id)),
      creatives: creatives
        .filter(c => c.status !== 'DELETED' && String(c.product_set_id ?? '') === s.set)
        .map(c => String(c.id))
        .sort(),
    };
  }
  return {status: 200, headers: {}, data: out};
}
export function validateMetaProductSetState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).metaProductSetState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || !object(d.set)) unverified('Missing verified product set state.');
}
const matchesNone = (m: unknown) => object(m) && m.any === false;
export function metaProductSetPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = metaProductSetKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.set)) unverified('Missing verified product set state.');
  if (kind !== 'create' && s.set.present === false)
    fail('STATE_NOT_FOUND', 'Product set ' + idOf(p) + ' was not found.', {product_set_id: idOf(p)}, 404);
  assertMetaCatalogOfBusiness(s, kind === 'create' ? idOf(p) : null);
  if (!Array.isArray(s.sets)) unverified('Missing the product sets of the catalog.');
  if (typeof s.filter_refused === 'string')
    invalid('Meta refused this filter: ' + s.filter_refused, {meta_message: s.filter_refused});
  const used = object(s.used_by) ? s.used_by : undefined;
  if (kind === 'delete') {
    if (!used || !Array.isArray(used.ad_sets) || !Array.isArray(used.creatives))
      unverified('Missing product set usage.');
    const adSets = used.ad_sets as JsonObject[],
      creatives = used.creatives as string[];
    if (adSets.length || creatives.length)
      fail(
        'PRODUCT_SET_IN_USE',
        'Product set ' +
          idOf(p) +
          ' is used by ' +
          [...adSets.map(a => 'ad set ' + String(a.id)), ...creatives.map(c => 'creative ' + c)].join(', ') +
          '; point them at another set first.',
        {ad_sets: adSets.map(a => String(a.id)), creatives},
        409,
      );
    return;
  }
  const b = body(p),
    before = s.set as JsonObject,
    filter = filterOf(p);
  const name = b.name ?? before.name,
    others = (s.sets as JsonObject[]).filter(x => x.id !== idOf(p));
  if (kind === 'update') {
    const same =
      (b.name === undefined || b.name === before.name) &&
      (b.retailer_id === undefined || b.retailer_id === before.retailer_id) &&
      (filter === undefined || stable(filter) === stable(before.filter));
    if (same) invalid('Product set ' + idOf(p) + ' already has these values.');
  }
  if (others.some(x => String(x.name).toLowerCase() === String(name).toLowerCase()))
    fail('CONFIGURATION_EXISTS', 'The catalog already has a product set named "' + String(name) + '".', {
      name: String(name),
    });
  if (filter !== undefined) {
    const twin = others.find(x => stable(x.filter) === stable(filter));
    if (twin)
      fail('CONFIGURATION_EXISTS', 'Product set ' + String(twin.id) + ' already has this filter (Meta error 10803).', {
        product_set_id: String(twin.id),
      });
    if (kind === 'update' && matchesNone(s.matching)) {
      const live =
        used && Array.isArray(used.ad_sets) ? (used.ad_sets as JsonObject[]).filter(a => a.status === 'ACTIVE') : [];
      if (live.length)
        fail(
          'PRODUCT_SET_EMPTY',
          'The new filter selects no product, and ' +
            live.map(a => 'ad set ' + String(a.id)).join(', ') +
            ' deliver from this set: "ads tied to this product set will not deliver". Fix the filter, or pause them first.',
          {ad_sets: live.map(a => String(a.id))},
          409,
        );
    }
  }
}
export function metaProductSetImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = metaProductSetKind(p);
  if (!kind) return;
  const s: JsonObject = object(state[0]) ? state[0] : {},
    b = body(p),
    filter = filterOf(p),
    before: JsonObject = object(s.set) ? s.set : {},
    used: JsonObject = object(s.used_by) ? s.used_by : {};
  const live = Array.isArray(used.ad_sets) ? (used.ad_sets as JsonObject[]).filter(a => a.status === 'ACTIVE') : [];
  const after =
    kind === 'delete'
      ? null
      : {
          name: b.name ?? before.name ?? null,
          filter: filter ?? before.filter ?? {},
          retailer_id: b.retailer_id ?? before.retailer_id ?? null,
        };
  const matching = s.matching;
  return {
    provider: 'meta',
    scope: 'product_set',
    operation: kind,
    catalog: s.catalog ?? null,
    ...(kind === 'create' ? {creating: after} : kind === 'update' ? {before: s.set, after} : {deleting: s.set}),
    ...(filter !== undefined
      ? {
          selects:
            object(filter) && !Object.keys(filter).length
              ? 'Every item of the catalog.'
              : matchesNone(matching)
                ? 'No product of the catalog today.'
                : 'Products of the catalog today (Meta found at least one).',
        }
      : {}),
    ...(kind !== 'create' ? {used_by: s.used_by ?? null} : {}),
    ...(kind === 'create' && matchesNone(matching)
      ? {warning: 'The filter selects no product today: ads tied to an empty product set do not deliver.'}
      : {}),
    may_affect_serving: kind === 'update' && live.length > 0,
    effect:
      kind === 'create'
        ? 'Creates a product set in the catalog; ads show it only once an ad set and a creative name it.'
        : kind === 'update'
          ? 'Changes the set; ad sets and creatives that use it show the new selection' +
            (live.length ? ' (' + live.length + ' delivering ad set(s) of this account).' : '.')
          : 'Deletes the product set; no ad set or creative of the selected account uses it.',
    note:
      kind === 'create'
        ? undefined
        : 'AMCP reads the selected ad account only; other ad accounts that share the catalog may use this set, and Meta refuses to delete a set that live ads use.',
    verification:
      kind === 'delete'
        ? 'Reads the product set again and expects it to be gone.'
        : 'Reads the product set again and compares its name, filter, retailer ID and catalog.',
    source,
  };
}
export function metaProductSetOutcome(p: CompiledRequest, r: TransportResult): boolean {
  if (r.status !== 200 || !object(r.data)) return false;
  return metaProductSetKind(p) === 'create' ? numeric(String(r.data.id ?? '')) : r.data.success === true;
}
export function metaProductSetVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = metaProductSetKind(p)!,
    id = kind === 'create' ? String(result.data?.id ?? '') : idOf(p);
  if (!numeric(id)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no product set.');
  const b = body(p),
    filter = filterOf(p);
  const expected =
    kind === 'delete'
      ? {set: {present: false}}
      : {
          set: {
            present: true,
            ...(b.name !== undefined ? {name: b.name} : {}),
            ...(filter !== undefined ? {filter: stable(filter)} : {}),
            ...(b.retailer_id !== undefined ? {retailer_id: b.retailer_id} : {}),
            ...(kind === 'create' ? {catalog_id: idOf(p)} : {}),
          },
        };
  return [{read: read(p, {kind, set: id, verify: true}), expected, id: 'product set ' + id}];
}
export function metaProductSetObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const x = object(data.set) ? data.set : {},
    expected = (read as Read).metaProductSetState;
  if (!x.present || !expected) return {set: {present: x.present === true}};
  return {
    set: {
      present: true,
      name: x.name,
      filter: stable(x.filter ?? {}),
      retailer_id: x.retailer_id,
      catalog_id: x.catalog_id,
    },
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const metaProductSetFamily: ReviewedFamily = defineFamily({
  name: 'meta_product_sets',
  files: ['src/meta-product-sets.ts', ['tests/meta-product-sets.test.mjs']],
  kind: metaProductSetKind,
  assert: assertMetaProductSet,
  scope: assertMetaProductSetScope,
  authorize: authorizeMetaProductSet,
  snapshots: metaProductSetSnapshots,
  isRead: isMetaProductSetRead,
  reader: readMetaProductSets,
  validateState: validateMetaProductSetState,
  prerequisites: metaProductSetPrerequisites,
  impact: metaProductSetImpact,
  outcome: metaProductSetOutcome,
  verification: metaProductSetVerification,
  observed: metaProductSetObserved,
  destructive: plan => metaProductSetKind(plan) === 'delete',
});
