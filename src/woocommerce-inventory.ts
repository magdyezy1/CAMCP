import type {Store} from './store.js';
import type {Actor, Connection, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {bad, fingerprint, obj, validate} from './workspace-core.js';
import {guardedLookup} from './media-link.js';
import {wooCommerceOrigin, wooCommerceRequest, type WooCommerceRequest} from './woocommerce-source.js';

export const wooCommerceInventoryLimits = Object.freeze({
  items_per_scan: 1000,
  page_size: 100,
  requests: 64,
  bytes: 8 * 1024 * 1024,
  elapsed_ms: 60000,
});
export const wooCommerceInventoryMeaning =
  'All published parent products and every reported variable-parent variation were collected twice within the stated bounds. Native IDs, selected price strings, statuses and reported memberships are preserved. The supported observations and store currency agreed across the sequential scans. This is not a point-in-time snapshot, unpublished-parent inventory, verified grouped-product membership, destination eligibility or write approval. Missing source products are retained; no product, draft or snapshot was changed or saved.';
const prices = ['price', 'regular_price', 'sale_price'];
const parentFields =
  'id,sku,name,type,status,parent_id,variations,grouped_products,stock_status,tax_status,virtual,downloadable,date_modified_gmt';
const variationFields =
  'id,sku,status,stock_status,tax_status,virtual,downloadable,attributes.id,attributes.name,attributes.option,date_modified_gmt';
const incomplete = (): never =>
  bad(
    'WooCommerce inventory is incomplete, malformed or outside its collection bounds. No complete inventory is returned.',
    'WOOCOMMERCE_INVENTORY_INCOMPLETE',
  );
const unavailable = (): never =>
  bad(
    'The WooCommerce inventory read did not return a bounded authenticated JSON response. Inspect the store REST API access.',
    'WOOCOMMERCE_INVENTORY_UNAVAILABLE',
  );
const identifier = (value: unknown, zero = false): string => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !(zero ? /^(0|[1-9][0-9]{0,19})$/ : /^[1-9][0-9]{0,19}$/).test(value)) incomplete();
  return value as string;
};
const literal = (value: unknown, max: number): string | null => {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(value)) incomplete();
  return value as string;
};
const bool = (value: unknown): boolean | null => {
  if (value === undefined) return null;
  if (typeof value !== 'boolean') incomplete();
  return value as boolean;
};
const orderIds = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
const membership = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > wooCommerceInventoryLimits.items_per_scan) incomplete();
  const ids = (value as unknown[]).map(value => identifier(value));
  if (new Set(ids).size !== ids.length) incomplete();
  return ids.sort(orderIds);
};
function project(raw: unknown, field: string, parent?: JsonObject): JsonObject {
  if (!obj(raw)) incomplete();
  const row = raw as JsonObject,
    id = identifier(row.id),
    status = literal(row.status, 40),
    shared = {
      product_id: id,
      sku: literal(row.sku, 100),
      status,
      selected_price: literal(row[field], 100),
      stock_status: literal(row.stock_status, 40),
      tax_status: literal(row.tax_status, 40),
      virtual: bool(row.virtual),
      downloadable: bool(row.downloadable),
      date_modified_gmt: literal(row.date_modified_gmt, 40),
    };
  if (parent) {
    if (
      !['publish', 'draft', 'pending', 'private', 'future'].includes(status ?? '') ||
      !parent.variation_ids.includes(id) ||
      !Array.isArray(row.attributes) ||
      row.attributes.length > 25
    )
      incomplete();
    const attributes = row.attributes.map((attribute: unknown) => {
      if (!obj(attribute)) incomplete();
      const item = attribute as JsonObject,
        name = literal(item.name, 200),
        option = literal(item.option, 200);
      if (name === null || option === null) incomplete();
      return {id: identifier(item.id, true), name, option};
    });
    if (
      new Set(attributes.map((a: JsonObject) => (a.id === '0' ? 'custom:' + a.name : a.id))).size !== attributes.length
    )
      incomplete();
    return {
      ...shared,
      entity_kind: 'variation',
      product_type: 'variation',
      name: null,
      parent_product_id: parent.product_id,
      parent_name: parent.name,
      parent_sku: parent.sku,
      attributes,
      requires_title_review: true,
    };
  }
  const type = literal(row.type, 40),
    variations = membership(row.variations),
    groups = membership(row.grouped_products);
  if (
    status !== 'publish' ||
    identifier(row.parent_id, true) !== '0' ||
    !['simple', 'variable', 'grouped', 'external'].includes(type ?? '') ||
    (type !== 'variable' && variations.length) ||
    (type !== 'grouped' && groups.length) ||
    variations.includes(id) ||
    groups.includes(id)
  )
    incomplete();
  return {
    ...shared,
    entity_kind: 'product',
    product_type: type,
    name: literal(row.name, 500),
    parent_product_id: '0',
    variation_ids: variations,
    reported_grouped_product_ids: groups,
  };
}
async function wait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) unavailable();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(
        new MirrorError(
          'WOOCOMMERCE_INVENTORY_UNAVAILABLE',
          'The WooCommerce inventory read did not return a bounded authenticated JSON response. Inspect the store REST API access.',
        ),
      );
    signal.addEventListener('abort', abort, {once: true});
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Fixed GET collections only. Retention is explicit and inventory observations never authorize a destination change. */
export async function wooCommerceInventory(
  store: Store,
  actor: Actor,
  input: JsonObject,
  request: WooCommerceRequest = wooCommerceRequest,
  environment: 'production' | 'sandbox' = 'production',
) {
  validate(input, ['action', 'gateway', 'account_id', 'connection_id', 'requirements']);
  const requirements = input.requirements;
  if (!obj(requirements)) bad('Choose the WooCommerce inventory mode and one exact native price field.');
  validate(requirements, ['source_kind', 'price_field', 'absent_source_policy']);
  if (
    input.action !== 'catalog_source' ||
    input.gateway !== 'commerce_native_action' ||
    !/^[A-Za-z0-9_-]{1,160}$/.test(input.account_id ?? '') ||
    !/^[A-Za-z0-9_-]{1,160}$/.test(input.connection_id ?? '') ||
    requirements.source_kind !== 'inventory' ||
    !prices.includes(requirements.price_field) ||
    (requirements.absent_source_policy !== undefined && requirements.absent_source_policy !== 'retain')
  )
    bad('Choose the exact WooCommerce inventory scope and price field; absent source products must be retained.');
  if (environment !== 'production')
    bad('WooCommerce inventory has no qualified sandbox route.', 'SANDBOX_ROUTE_UNQUALIFIED');
  store.assertActorActive(actor);
  const connection = store.resolveConnection(actor, input.gateway, input.account_id, input.connection_id),
    origin = wooCommerceOrigin(connection.baseUrl),
    bound = (c: Connection) =>
      c.apiVersion === 'wc/v3' &&
      c.accounts.length === 1 &&
      c.accounts[0] === input.account_id &&
      c.scopes.some(scope => ['read', 'read_write'].includes(scope));
  if (!bound(connection))
    bad('WooCommerce inventory requires one bound store, wc/v3 and an existing Read REST API key.');
  const credentials = store.connectionCredentials(connection);
  if (
    typeof credentials.consumerKey !== 'string' ||
    !/^ck_[A-Za-z0-9]{1,200}$/.test(credentials.consumerKey) ||
    typeof credentials.consumerSecret !== 'string' ||
    !/^cs_[A-Za-z0-9]{1,200}$/.test(credentials.consumerSecret) ||
    (credentials.expiresAt !== undefined &&
      (!Number.isSafeInteger(credentials.expiresAt) || credentials.expiresAt <= Date.now()))
  )
    bad('WooCommerce inventory requires an existing encrypted, unexpired Consumer Key and Consumer Secret.');
  const authority = fingerprint({credentials, scopes: [...connection.scopes].sort()}),
    controller = new AbortController(),
    signal = controller.signal,
    started = performance.now(),
    timer = setTimeout(() => controller.abort(), wooCommerceInventoryLimits.elapsed_ms),
    headers = Object.freeze({
      Accept: 'application/json',
      'User-Agent': 'AMCP WooCommerce inventory',
      Authorization:
        'Basic ' + Buffer.from(credentials.consumerKey + ':' + credentials.consumerSecret).toString('base64'),
    }),
    lookup = guardedLookup();
  timer.unref();
  let requests = 0,
    bytes = 0,
    rows = 0;
  const current = () => {
    store.assertActorActive(actor);
    const c = store.resolveConnection(actor, input.gateway, input.account_id, connection.id);
    if (
      !bound(c) ||
      wooCommerceOrigin(c.baseUrl).origin !== origin.origin ||
      fingerprint({credentials: store.connectionCredentials(c), scopes: [...c.scopes].sort()}) !== authority ||
      (credentials.expiresAt !== undefined && credentials.expiresAt <= Date.now())
    )
      bad(
        'The WooCommerce inventory login, store or permissions changed. Read the inventory again.',
        'WOOCOMMERCE_SOURCE_CHANGED',
      );
    if (signal.aborted || performance.now() - started >= wooCommerceInventoryLimits.elapsed_ms) unavailable();
  };
  const read = async (url: URL) => {
    current();
    if (++requests > wooCommerceInventoryLimits.requests) incomplete();
    let response: Response;
    try {
      response = await wait(request(url, {signal, headers, lookup}), signal);
    } catch {
      current();
      return unavailable();
    }
    const cancel = () => wait(response.body?.cancel() ?? Promise.resolve(), signal).catch(() => {});
    try {
      current();
    } catch (error) {
      await cancel();
      throw error;
    }
    if (
      response.status !== 200 ||
      response.redirected ||
      (response.url && response.url !== url.href) ||
      !/application\/(?:[a-z0-9.+-]*\+)?json(?:;|$)/i.test(response.headers.get('content-type') ?? '') ||
      (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') ||
      !response.body
    ) {
      await cancel();
      return unavailable();
    }
    const declared = response.headers.get('content-length');
    if (
      declared !== null &&
      (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > wooCommerceInventoryLimits.bytes - bytes)
    ) {
      await cancel();
      return incomplete();
    }
    const reader = response.body.getReader(),
      chunks: Buffer[] = [];
    let length = 0,
      empty = 0;
    try {
      for (;;) {
        current();
        const chunk = await wait(reader.read(), signal);
        current();
        if (chunk.done) break;
        const part = Buffer.from(chunk.value);
        if (!part.length && ++empty > 64) incomplete();
        if (part.length) empty = 0;
        bytes += part.length;
        length += part.length;
        if (bytes > wooCommerceInventoryLimits.bytes) incomplete();
        chunks.push(part);
      }
    } catch (error) {
      current();
      if (error instanceof MirrorError) throw error;
      return unavailable();
    } finally {
      await wait(
        reader.cancel().catch(() => {}),
        signal,
      ).catch(() => {});
      reader.releaseLock();
    }
    if (declared !== null && Number(declared) !== length) incomplete();
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)), ((
        _key: string,
        value: unknown,
        context?: {source: string},
      ) =>
        typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)
          ? (context?.source ?? String(value))
          : value) as any);
    } catch {
      return incomplete();
    }
    current();
    return {data, headers: response.headers, source_hash: fingerprint(data), observed_at: Date.now()};
  };
  const currency = async () => {
    const url = new URL('/wp-json/wc/v3/settings/general/woocommerce_currency', origin);
    url.searchParams.set('_fields', 'id,value');
    const result = await read(url);
    if (!obj(result.data) || result.data.id !== 'woocommerce_currency' || !/^[A-Z]{3}$/.test(result.data.value ?? ''))
      incomplete();
    return {
      value: (result.data as JsonObject).value as string,
      source_hash: result.source_hash,
      observed_at: result.observed_at,
    };
  };
  const scan = async () => {
    const items: JsonObject[] = [],
      pages: JsonObject[] = [],
      ids = new Set<string>();
    const collect = async (parent?: JsonObject) => {
      let total: number | undefined,
        totalPages: number | undefined,
        count = 0,
        last = '0';
      for (let page = 1; page <= 10; page++) {
        const url = new URL(
          parent ? '/wp-json/wc/v3/products/' + parent.product_id + '/variations' : '/wp-json/wc/v3/products',
          origin,
        );
        for (const [key, value] of Object.entries({
          context: 'view',
          status: parent ? 'any' : 'publish',
          order: 'asc',
          orderby: 'id',
          page: String(page),
          per_page: '100',
          _fields: (parent ? variationFields : parentFields) + ',' + requirements.price_field,
        }))
          url.searchParams.set(key, value);
        const result = await read(url),
          totalText = result.headers.get('x-wp-total'),
          pagesText = result.headers.get('x-wp-totalpages');
        if (
          !Array.isArray(result.data) ||
          totalText === null ||
          pagesText === null ||
          !/^(0|[1-9][0-9]*)$/.test(totalText) ||
          !/^(0|[1-9][0-9]*)$/.test(pagesText)
        )
          incomplete();
        const foundTotal = Number(totalText),
          foundPages = Number(pagesText);
        if (
          foundTotal > 1000 ||
          foundPages > 10 ||
          (foundTotal ? foundPages !== Math.ceil(foundTotal / 100) : foundPages > 1) ||
          (total !== undefined && (total !== foundTotal || totalPages !== foundPages)) ||
          (parent && foundTotal !== parent.variation_ids.length)
        )
          incomplete();
        total = foundTotal;
        totalPages = foundPages;
        const raw = result.data as unknown[];
        if (
          raw.length !== Math.min(100, total - count) ||
          (rows += raw.length) > 2000 ||
          items.length + raw.length > 1000
        )
          incomplete();
        for (const value of raw) {
          const item = project(value, requirements.price_field, parent);
          if (ids.has(item.product_id) || orderIds(last, item.product_id) >= 0) incomplete();
          last = item.product_id;
          ids.add(last);
          items.push(item);
          count++;
        }
        pages.push({
          entity_kind: parent ? 'variation' : 'product',
          parent_product_id: parent?.product_id ?? null,
          page,
          count: raw.length,
          total,
          total_pages: totalPages,
          source_hash: result.source_hash,
          observed_at: result.observed_at,
        });
        if (count === total) return;
      }
      incomplete();
    };
    await collect();
    const parents = items.filter(item => item.entity_kind === 'product' && item.product_type === 'variable');
    for (const parent of parents) {
      if (parent.variation_ids.some((id: string) => ids.has(id))) incomplete();
      const offset = items.length;
      await collect(parent);
      if (
        fingerprint(
          items
            .slice(offset)
            .map(item => item.product_id)
            .sort(orderIds),
        ) !== fingerprint(parent.variation_ids)
      )
        incomplete();
    }
    return {
      items,
      pages,
      product_count: items.filter(item => item.entity_kind === 'product').length,
      variation_count: items.filter(item => item.entity_kind === 'variation').length,
    };
  };
  try {
    const before = await currency(),
      first = await scan(),
      between = await currency(),
      second = await scan(),
      after = await currency();
    current();
    if (
      before.value !== between.value ||
      before.value !== after.value ||
      fingerprint(first.items) !== fingerprint(second.items)
    )
      bad(
        'WooCommerce inventory or currency changed between complete scans. Read it again; no changes are proposed.',
        'WOOCOMMERCE_INVENTORY_CHANGED',
      );
    const scope = {
      gateway: input.gateway,
      account_id: input.account_id,
      connection_id: connection.id,
      store_origin: origin.origin,
      api_version: 'wc/v3',
      source_kind: 'inventory',
      price_field: requirements.price_field,
      product_status: 'publish',
      variation_status: 'any',
      absent_source_policy: 'retain',
    };
    return {
      record_kind: 'catalog_source_inventory',
      state: 'complete',
      scope,
      complete_collected_inventory: true,
      native_currency: before.value,
      items: first.items,
      item_count: first.items.length,
      product_count: first.product_count,
      variation_count: first.variation_count,
      source_hash: fingerprint({scope, native_currency: before.value, items: first.items}),
      scans: [first, second].map((result, index) => ({
        scan: index + 1,
        item_count: result.items.length,
        source_hash: fingerprint(result.items),
        pages: result.pages,
      })),
      currency_evidence: [before, between, after],
      captured_at: Date.now(),
      native_requests: requests,
      collected_rows: rows,
      collected_bytes: bytes,
      limits: wooCommerceInventoryLimits,
      point_in_time: false,
      unpublished_parents_collected: false,
      grouped_membership: 'not_independently_verified',
      destination_eligibility: 'unverified',
      provider_mutations: 0,
      destructive_deletions: 0,
      saved_drafts: 0,
      source_saved: false,
      meaning: wooCommerceInventoryMeaning,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
