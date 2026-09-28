import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Snapchat product sets of catalogs, Marketing API v1 (Dynamic Product Ads guide, "Product Set"; checked 2026-09-27).
 * POST /v1/catalogs/{catalog_id}/product_sets creates sets from {product_sets: [{name, filter}]}; PUT on the same path or
 * on /v1/product_sets updates them from {product_sets: [{id, name, filter}]}; DELETE /v1/product_sets/{id} deletes one.
 * Replies list each set with its sub_request_status. Catalogs belong to the organization (at most 200 each), a catalog
 * holds at most 50 sets plus a default set of every product, and a batch carries at most 50. Ad squads name sets in
 * product_properties.product_set_id and targeting.product_audiences[].product_set, dynamic creatives in
 * dynamic_render_properties.product_set_id.
 */
type Kind = 'create' | 'update' | 'delete';
type State = {catalogs: string[]; sets: string[]; byId: boolean; usage: boolean};
type Read = CompiledRequest & {
  snapProductSetState?: State;
  snapProductSetOrg?: string;
  snapProductSetCatalog?: string;
  snapProductSetId?: string;
};
const gateway = 'snapchat_native_action',
  origin = 'https://adsapi.snapchat.com',
  perCatalog = 50,
  maxById = 10,
  pageSize = 1000,
  maxPages = 5;
const enums: Record<string, string[]> = {
  AGE_GROUP: ['NEWBORN', 'INFANT', 'TODDLER', 'KIDS', 'ADULT'],
  AVAILABILITY: ['IN_STOCK', 'OUT_OF_STOCK', 'PREORDER', 'DISCONTINUED', 'AVAILABLE_FOR_ORDER'],
  CONDITION: ['NEW', 'REFURBISHED', 'USED'],
  GENDER: ['MALE', 'FEMALE', 'UNISEX'],
};
const textAttributes = [
  'BRAND',
  'COLOR',
  'CUSTOM_LABEL_0',
  'CUSTOM_LABEL_1',
  'CUSTOM_LABEL_2',
  'CUSTOM_LABEL_3',
  'CUSTOM_LABEL_4',
  'GOOGLE_PRODUCT_CATEGORY',
  'ID',
  'ITEM_GROUP_ID',
  'MATERIAL',
  'PATTERN',
  'PRODUCT_TYPE',
  'SIZE',
  'TITLE',
];
const textOperators = [
  'EQ',
  'NEQ',
  'CONTAINS',
  'NOT_CONTAINS',
  'I_CONTAINS',
  'I_NOT_CONTAINS',
  'STARTS_WITH',
  'I_STARTS_WITH',
];
const listOperators = ['IS_ANY', 'IS_NOT_ANY', 'I_IS_ANY', 'I_IS_NOT_ANY'],
  numberOperators = ['EQ', 'NEQ', 'GT', 'GTE', 'LT', 'LTE'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const snapId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v);
const text = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' &&
  v === v.trim() &&
  [...v].length >= min &&
  [...v].length <= max &&
  !/[\u0000-\u001f\u007f]/.test(v);
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_SNAPCHAT_PRODUCT_SET', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function snapProductSetKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport || (p.origin && p.origin !== origin)) return;
  if (/^\/v1\/catalogs\/[A-Za-z0-9-]{1,64}\/product_sets$/.test(p.path))
    return p.method === 'POST' ? 'create' : p.method === 'PUT' ? 'update' : undefined;
  if (p.method === 'PUT' && p.path === '/v1/product_sets') return 'update';
  if (p.method === 'DELETE' && /^\/v1\/product_sets\/[A-Za-z0-9-]{1,64}$/.test(p.path)) return 'delete';
  return;
}
const catalogOf = (p: CompiledRequest) => /^\/v1\/catalogs\/([A-Za-z0-9-]{1,64})\/product_sets$/.exec(p.path)?.[1];
const setOf = (p: CompiledRequest) => p.path.split('/')[3]!;
const rows = (p: CompiledRequest) =>
  (object(p.body) && Array.isArray(p.body.product_sets) ? p.body.product_sets : []) as JsonObject[];
const named = (p: CompiledRequest) =>
  snapProductSetKind(p) === 'delete'
    ? [setOf(p)]
    : snapProductSetKind(p) === 'update'
      ? rows(p).map(r => String(r.id))
      : [];
/** One attribute condition: {ATTRIBUTE: {OPERATOR: value}}, with the operators and values the guide lists per attribute. */
function condition(e: unknown, at: string): void {
  if (!object(e) || Object.keys(e).length !== 1)
    invalid(at + ' names one product attribute, such as {"AVAILABILITY": {"EQ": "IN_STOCK"}}.');
  const attribute = Object.keys(e)[0]!,
    c = e[attribute];
  if (!object(c) || Object.keys(c).length !== 1) invalid(at + '.' + attribute + ' takes one operator.');
  const operator = Object.keys(c)[0]!,
    v = c[operator];
  if (enums[attribute]) {
    if (!['EQ', 'NEQ'].includes(operator) || !enums[attribute]!.includes(v as string))
      invalid(at + '.' + attribute + ' takes EQ or NEQ with one of ' + enums[attribute]!.join(', ') + '.');
    return;
  }
  if (attribute === 'PRICE_AMOUNT') {
    if (!numberOperators.includes(operator) || typeof v !== 'string' || !/^\d{1,12}(\.\d{1,2})?$/.test(v))
      invalid(
        at +
          '.PRICE_AMOUNT takes ' +
          numberOperators.join(', ') +
          ' with a number of up to two decimals written as a string, such as "15.50".',
      );
    return;
  }
  if (attribute === 'PRICE_CURRENCY') {
    if (!['EQ', 'NEQ'].includes(operator) || typeof v !== 'string' || !/^[A-Z]{3}$/.test(v))
      invalid(at + '.PRICE_CURRENCY takes EQ or NEQ with an ISO 4217 code such as USD.');
    return;
  }
  if (!textAttributes.includes(attribute))
    invalid(at + ': ' + attribute + ' is not a product attribute a product set can filter on.');
  if (textOperators.includes(operator)) {
    if (!text(v, 1, 255)) invalid(at + '.' + attribute + '.' + operator + ' takes one value of 1–255 characters.');
    return;
  }
  const max = attribute === 'ID' ? 1000 : 10;
  if (!listOperators.includes(operator))
    invalid(at + '.' + attribute + ' takes ' + [...textOperators, ...listOperators].join(', ') + '.');
  if (!Array.isArray(v) || !v.length || v.length > max || v.some(x => !text(x, 1, 255)) || new Set(v).size !== v.length)
    invalid(at + '.' + attribute + '.' + operator + ' lists 1–' + max + ' different values of 1–255 characters.');
}
function filter(f: unknown, at: string): void {
  if (!object(f) || Object.keys(f).length !== 1)
    invalid(at + ' is one condition, or AND or OR with a list of conditions.');
  const key = Object.keys(f)[0]!;
  if (key !== 'AND' && key !== 'OR') {
    condition(f, at);
    return;
  }
  const list = f[key];
  if (!Array.isArray(list) || !list.length || list.length > 10) invalid(at + '.' + key + ' lists 1–10 conditions.');
  (list as unknown[]).forEach((e, i) => {
    if (object(e) && (Object.hasOwn(e, 'AND') || Object.hasOwn(e, 'OR')))
      invalid('A product set filter uses one logical operator; ' + at + '.' + key + '[' + i + '] nests another.');
    condition(e, at + '.' + key + '[' + i + ']');
  });
}
export function assertSnapProductSet(p: CompiledRequest): void {
  const kind = snapProductSetKind(p);
  if (!kind) return;
  if (!snapId(p.accountId))
    fail('ACCOUNT_REQUIRED', 'Select the ad account whose organization owns the catalog.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Product set writes take no query or header overrides.');
  if (kind === 'delete') {
    if (p.body !== undefined && !(object(p.body) && !Object.keys(p.body).length))
      invalid('Deletion takes only the product set in the path.');
    return;
  }
  const b = p.body,
    max = kind === 'update' && !catalogOf(p) ? maxById : perCatalog;
  if (
    !object(b) ||
    Object.keys(b).some(k => k !== 'product_sets') ||
    !Array.isArray(b.product_sets) ||
    !b.product_sets.length ||
    b.product_sets.length > max
  )
    invalid(
      'Send {product_sets: [...]} with 1–' +
        max +
        ' product sets' +
        (max === maxById ? ' (name the catalog in the path for up to ' + perCatalog + ')' : '') +
        '.',
    );
  const names = new Set<string>(),
    ids = new Set<string>(),
    fields = kind === 'create' ? ['name', 'filter'] : ['id', 'name', 'filter'];
  (b.product_sets as unknown[]).forEach((s, i) => {
    const at = 'product_sets[' + i + ']';
    if (!object(s) || Object.keys(s).some(k => !fields.includes(k)) || fields.some(k => !Object.hasOwn(s, k)))
      invalid(at + ' takes ' + fields.join(', ') + '.');
    if (kind === 'update') {
      if (!snapId(s.id)) invalid(at + '.id names the product set to update.');
      if (ids.has(s.id)) invalid('Each product set appears once per request.');
      ids.add(s.id);
    }
    if (!text(s.name, 3, 255))
      invalid(at + '.name has 3–255 characters without surrounding spaces or control characters.');
    if (names.has(s.name.toLowerCase())) invalid('Each product set name appears once per request.');
    names.add(s.name.toLowerCase());
    filter(s.filter, at + '.filter');
  });
}
const read = (
  p: CompiledRequest,
  path: string,
  query: Record<string, string | number>,
  extra: Partial<Read> = {},
): Read =>
  ({
    ...p,
    action: 'AMCP_SNAPCHAT_PRODUCT_SET_READ',
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
    snapProductSetState: undefined,
    snapProductSetOrg: undefined,
    snapProductSetCatalog: undefined,
    snapProductSetId: undefined,
    ...extra,
  }) as Read;
const accountRead = (p: CompiledRequest, state: State) =>
  read(p, '/v1/adaccounts/' + p.accountId, {}, {snapProductSetState: state});
export function snapProductSetSnapshots(p: CompiledRequest): Read[] {
  const kind = snapProductSetKind(p)!,
    catalog = catalogOf(p);
  return [
    accountRead(p, {catalogs: catalog ? [catalog] : [], sets: named(p), byId: !catalog, usage: kind !== 'create'}),
  ];
}
export function isSnapProductSetRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).snapProductSetState;
}
/** Writes after validation. Internal reads: the account, then the organization, catalogs and sets it leads to. */
export function authorizeSnapProductSet(p: CompiledRequest, _c: Connection, account: string): boolean {
  if (p.gateway !== gateway) return false;
  if (snapProductSetKind(p)) {
    assertSnapProductSet(p);
    if (p.accountId !== account)
      fail('ACCOUNT_SCOPE_MISMATCH', 'Select the ad account whose organization owns the catalog.', {}, 403);
    return true;
  }
  if (p.action !== 'AMCP_SNAPCHAT_PRODUCT_SET_READ' || p.method !== 'GET' || !p.readOnly || p.body !== undefined)
    return false;
  const r = p as Read,
    id = p.path.split('/')[3];
  if (
    [
      '/v1/adaccounts/' + account,
      '/v1/adaccounts/' + account + '/adsquads',
      '/v1/adaccounts/' + account + '/creatives',
    ].includes(p.path)
  )
    return true;
  // Each marker is set only by readSnapProductSets from the account and organization just read.
  if (/^\/v1\/organizations\/[A-Za-z0-9-]{1,64}\/catalogs$/.test(p.path) && r.snapProductSetOrg === id) return true;
  if (/^\/v1\/catalogs\/[A-Za-z0-9-]{1,64}\/product_sets$/.test(p.path) && r.snapProductSetCatalog === id) return true;
  if (/^\/v1\/product_sets\/[A-Za-z0-9-]{1,64}$/.test(p.path) && r.snapProductSetId === id) return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal product set read.', {}, 403);
}
/** Every row of a Snapchat list, following cursors for a bounded number of pages. */
async function all(
  first: Read,
  key: string,
  item: string,
  pages: number,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<JsonObject[]> {
  const out: JsonObject[] = [],
    cursors = new Set<string>();
  let q = first;
  for (let page = 0; ; page++) {
    if (page >= pages) unverified('There are more ' + key.replace('_', ' ') + ' than one review reads.');
    const r = await fetch(q),
      d = r.data;
    if (
      r.status !== 200 ||
      !object(d) ||
      String(d.request_status).toUpperCase() !== 'SUCCESS' ||
      !Array.isArray(d[key])
    )
      unverified('Snapchat did not list the ' + key.replace('_', ' ') + '.');
    for (const row of d[key] as unknown[]) {
      const v = object(row) && object(row[item]) ? row[item] : undefined;
      if (!v || !snapId(v.id)) unverified('A row of the ' + key.replace('_', ' ') + ' is malformed.');
      out.push(v!);
    }
    const link = object(d.paging) ? d.paging.next_link : undefined;
    if (!link) return out;
    let cursor: string | null = null;
    try {
      cursor = new URL(String(link)).searchParams.get('cursor');
    } catch {
      cursor = null;
    }
    if (!cursor || cursors.has(cursor))
      unverified('Snapchat pagination of the ' + key.replace('_', ' ') + ' is repeated or malformed.');
    cursors.add(cursor!);
    q = {...q, query: {...q.query, cursor: cursor!}};
  }
}
const byId = (a: JsonObject, b: JsonObject) => String(a.id).localeCompare(String(b.id));
export async function readSnapProductSets(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).snapProductSetState;
  if (!s) return fetch(p);
  const account = p.accountId!,
    a = await fetch({...(p as Read), snapProductSetState: undefined} as Read),
    ad = a.data;
  const row =
    object(ad) &&
    String(ad.request_status).toUpperCase() === 'SUCCESS' &&
    Array.isArray(ad.adaccounts) &&
    ad.adaccounts.length === 1 &&
    object(ad.adaccounts[0])
      ? ad.adaccounts[0].adaccount
      : undefined;
  if (a.status !== 200 || !object(row) || row.id !== account || !snapId(row.organization_id))
    unverified('Snapchat did not return the selected ad account with its organization.');
  const org = String(row.organization_id),
    catalogs: JsonObject = {};
  for (const c of await all(
    read(p, '/v1/organizations/' + org + '/catalogs', {limit: 100}, {snapProductSetOrg: org}),
    'catalogs',
    'catalog',
    3,
    fetch,
  )) {
    if (c.organization_id !== undefined && c.organization_id !== org)
      fail('STATE_TARGET_MISMATCH', 'Snapchat listed a catalog of another organization.', {}, 409);
    if (Object.hasOwn(catalogs, 'c' + c.id)) unverified('A catalog is listed twice.');
    catalogs['c' + c.id] = {
      id: String(c.id),
      name: c.name ?? null,
      default_product_set_id: c.default_product_set_id ?? null,
    };
  }
  const wanted = new Set(s.catalogs.filter(c => Object.hasOwn(catalogs, 'c' + c)));
  if (s.byId)
    for (const id of s.sets) {
      let set: JsonObject | undefined;
      try {
        const r = await fetch(read(p, '/v1/product_sets/' + id, {}, {snapProductSetId: id})),
          d = r.data;
        if (
          r.status !== 200 ||
          !object(d) ||
          String(d.request_status).toUpperCase() !== 'SUCCESS' ||
          !Array.isArray(d.product_sets)
        )
          unverified('Snapchat did not return product set ' + id + '.');
        const x = (d.product_sets as unknown[])[0];
        set = object(x) && object(x.product_set) && x.product_set.id === id ? x.product_set : undefined;
      } catch (e) {
        if (!(e instanceof MirrorError && (e.status === 404 || e.code === 'NOT_FOUND'))) throw e;
      }
      // A set of a catalog outside the organization is simply not found here.
      if (set && snapId(set.catalog_id) && Object.hasOwn(catalogs, 'c' + set.catalog_id)) wanted.add(set.catalog_id);
    }
  const sets: JsonObject = {};
  for (const c of [...wanted].sort())
    for (const x of await all(
      read(p, '/v1/catalogs/' + c + '/product_sets', {limit: perCatalog}, {snapProductSetCatalog: c}),
      'product_sets',
      'product_set',
      3,
      fetch,
    )) {
      if (x.catalog_id !== undefined && x.catalog_id !== c)
        fail('STATE_TARGET_MISMATCH', 'Snapchat listed a product set of another catalog.', {}, 409);
      if (Object.hasOwn(sets, 's' + x.id)) unverified('A product set is listed twice.');
      sets['s' + x.id] = {
        present: true,
        id: String(x.id),
        catalog_id: c,
        name: x.name ?? null,
        filter: x.filter ?? null,
      };
    }
  for (const id of s.sets) if (!Object.hasOwn(sets, 's' + id)) sets['s' + id] = {present: false, id};
  const out: JsonObject = {ad_account_id: account, organization_id: org, catalogs, sets};
  if (s.usage) {
    const squads = await all(
      read(p, '/v1/adaccounts/' + account + '/adsquads', {limit: pageSize}),
      'adsquads',
      'adsquad',
      maxPages,
      fetch,
    );
    const creatives = await all(
      read(p, '/v1/adaccounts/' + account + '/creatives', {limit: pageSize}),
      'creatives',
      'creative',
      maxPages,
      fetch,
    );
    const used: JsonObject = {};
    for (const id of s.sets) {
      const squadUses = squads.filter(q => {
        const pp = object(q.product_properties) ? q.product_properties : {},
          t = object(q.targeting) ? q.targeting : {};
        return (
          pp.product_set_id === id ||
          (Array.isArray(t.product_audiences) &&
            (t.product_audiences as unknown[]).some(x => object(x) && x.product_set === id))
        );
      });
      const creativeUses = creatives.filter(
        c => object(c.dynamic_render_properties) && c.dynamic_render_properties.product_set_id === id,
      );
      used['s' + id] = {
        ad_squads: squadUses.map(q => ({id: String(q.id), name: q.name ?? null, status: q.status ?? null})).sort(byId),
        creatives: creativeUses.map(c => ({id: String(c.id), name: c.name ?? null})).sort(byId),
      };
    }
    out.used_by = used;
  }
  return {status: 200, headers: {}, data: out};
}
export function validateSnapProductSetState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).snapProductSetState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || !object(d.catalogs) || !object(d.sets) || s.usage !== object(d.used_by))
    unverified('Missing verified product set state.');
}
export function snapProductSetPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = snapProductSetKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.catalogs) || !object(s.sets)) unverified('Missing verified product set state.');
  const catalogs = s.catalogs as JsonObject,
    sets = s.sets as JsonObject,
    catalog = catalogOf(p);
  if (catalog && !object(catalogs['c' + catalog]))
    fail(
      'STATE_NOT_FOUND',
      'Catalog ' + catalog + ' is not a catalog of the organization of the selected ad account.',
      {catalog_id: catalog},
    );
  const present = Object.values(sets).filter((x): x is JsonObject => object(x) && x.present === true);
  if (kind === 'create') {
    const existing = present.filter(x => x.catalog_id === catalog),
      defaults = existing.filter(x => x.id === (catalogs['c' + catalog] as JsonObject).default_product_set_id).length;
    if (existing.length - defaults + rows(p).length > perCatalog)
      invalid(
        'Catalog ' +
          catalog +
          ' has ' +
          (existing.length - defaults) +
          ' product sets besides its default; Snapchat allows ' +
          perCatalog +
          '.',
      );
    const taken = new Set(existing.map(x => String(x.name).toLowerCase()));
    for (const r of rows(p))
      if (taken.has(String(r.name).toLowerCase()))
        fail(
          'CONFIGURATION_EXISTS',
          'Catalog ' + catalog + ' already has a product set named "' + String(r.name) + '".',
          {name: String(r.name)},
        );
    return;
  }
  for (const id of named(p)) {
    const x = sets['s' + id];
    if (!object(x) || x.present !== true || (catalog && x.catalog_id !== catalog))
      fail(
        'STATE_NOT_FOUND',
        'Product set ' +
          id +
          ' is not a product set of ' +
          (catalog ? 'catalog ' + catalog : 'a catalog of the organization of the selected ad account') +
          '.',
        {product_set_id: id},
      );
    const c = catalogs['c' + x.catalog_id];
    if (object(c) && c.default_product_set_id === id)
      invalid(
        'Product set ' +
          id +
          ' is the default set of catalog ' +
          String(x.catalog_id) +
          ', which holds every product; Snapchat maintains it.',
      );
  }
  if (kind === 'delete') {
    const used = object(s.used_by) ? s.used_by['s' + setOf(p)] : undefined;
    if (!object(used) || !Array.isArray(used.ad_squads) || !Array.isArray(used.creatives))
      unverified('Missing product set usage.');
    const squads = used.ad_squads as JsonObject[],
      creatives = used.creatives as JsonObject[];
    if (squads.length || creatives.length)
      fail(
        'PRODUCT_SET_IN_USE',
        'Product set ' +
          setOf(p) +
          ' is used by ' +
          [...squads.map(q => 'ad squad ' + String(q.id)), ...creatives.map(c => 'creative ' + String(c.id))].join(
            ', ',
          ) +
          '; point them at another set first.',
        {ad_squads: squads.map(q => String(q.id)), creatives: creatives.map(c => String(c.id))},
        409,
      );
    return;
  }
  const renamed = new Map(rows(p).map(r => [String(r.id), String(r.name)]));
  for (const r of rows(p)) {
    const x = sets['s' + r.id] as JsonObject,
      name = String(r.name).toLowerCase();
    if (x.name === r.name && stable(x.filter) === stable(r.filter))
      invalid('Product set ' + String(r.id) + ' already has this name and filter.');
    if (
      present.some(
        y =>
          y.catalog_id === x.catalog_id &&
          y.id !== r.id &&
          (renamed.get(String(y.id)) ?? String(y.name)).toLowerCase() === name,
      )
    )
      fail(
        'CONFIGURATION_EXISTS',
        'Catalog ' + String(x.catalog_id) + ' already has a product set named "' + String(r.name) + '".',
        {name: String(r.name)},
      );
  }
}
export function snapProductSetImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = snapProductSetKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    sets: JsonObject = object(s.sets) ? s.sets : {},
    used: JsonObject = object(s.used_by) ? s.used_by : {};
  const usage = named(p).map((id): JsonObject => ({
    id,
    ...(object(used['s' + id]) ? (used['s' + id] as JsonObject) : {}),
  }));
  const serving =
    kind === 'update' &&
    usage.some(
      u =>
        Array.isArray(u.ad_squads) &&
        (u.ad_squads as JsonObject[]).some(q => String(q.status).toUpperCase() === 'ACTIVE'),
    );
  return {
    provider: 'snapchat',
    scope: 'product_set',
    operation: kind,
    ...(catalogOf(p) ? {catalog: catalogOf(p)} : {}),
    ...(kind === 'create'
      ? {creating: rows(p)}
      : kind === 'update'
        ? {updating: rows(p).map(r => ({before: sets['s' + r.id] ?? null, after: r})), used_by: usage}
        : {deleting: sets['s' + setOf(p)] ?? {id: setOf(p)}}),
    may_affect_serving: serving,
    effect:
      kind === 'create'
        ? 'Creates product sets in the catalog; ads show them only once an ad squad and a dynamic creative name them.'
        : kind === 'update'
          ? 'Changes which products the sets select; ad squads and dynamic creatives that use them show the new selection.'
          : 'Deletes the product set; no ad squad or creative of the account uses it.',
    verification:
      kind === 'delete'
        ? "Lists the catalog's product sets again and expects this one to be gone."
        : "Lists the catalog's product sets again and compares each name and filter.",
    source: 'https://developers.snap.com/api/marketing-api/Ads-API/dynamic-product-ads',
  };
}
export function snapProductSetOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = snapProductSetKind(p)!,
    d = r.data;
  if (r.status !== 200 || !object(d) || String(d.request_status).toUpperCase() !== 'SUCCESS') return false;
  if (kind === 'delete') return true;
  const out = d.product_sets,
    sent = rows(p);
  return (
    Array.isArray(out) &&
    out.length === sent.length &&
    out.every(
      (x: unknown, i: number) =>
        object(x) &&
        String(x.sub_request_status).toUpperCase() === 'SUCCESS' &&
        object(x.product_set) &&
        snapId(x.product_set.id) &&
        (kind === 'create' || x.product_set.id === sent[i]!.id),
    )
  );
}
export function snapProductSetVerification(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[] = [],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = snapProductSetKind(p)!,
    b = before[0],
    known: JsonObject = object(b) && object(b.sets) ? b.sets : {};
  const catalogFor = (id: string) => {
    const c = catalogOf(p) ?? (object(known['s' + id]) ? known['s' + id].catalog_id : undefined);
    if (!snapId(c))
      fail('VERIFICATION_UNSUPPORTED', 'The review did not record the catalog of product set ' + id + '.');
    return c;
  };
  if (kind === 'delete')
    return [
      {
        read: accountRead(p, {catalogs: [catalogFor(setOf(p))], sets: [setOf(p)], byId: false, usage: false}),
        expected: {sets: {['s' + setOf(p)]: {present: false}}},
        id: 'product set ' + setOf(p),
      },
    ];
  const expected: JsonObject = {},
    catalogs = new Set<string>();
  rows(p).forEach((r, i) => {
    const id = kind === 'create' ? result.data?.product_sets?.[i]?.product_set?.id : r.id;
    if (!snapId(id)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no product set to verify.');
    expected['s' + id] = {present: true, id, name: r.name, filter: r.filter};
    catalogs.add(catalogFor(id));
  });
  const ids = Object.keys(expected).map(k => k.slice(1));
  return [
    {
      read: accountRead(p, {catalogs: [...catalogs].sort(), sets: ids, byId: false, usage: false}),
      expected: {sets: expected},
      id: ids.join(','),
    },
  ];
}
export function snapProductSetObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {sets: object(data.sets) ? data.sets : {}};
}
