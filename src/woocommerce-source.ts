import https from 'node:https';
import net from 'node:net';
import {Readable} from 'node:stream';
import {guardedLookup} from './media-link.js';
import {MirrorError} from './errors.js';
import {sha256, stable} from './security.js';
import {bad, fingerprint, obj, validate} from './workspace-core.js';
import type {Store} from './store.js';
import type {Actor, Connection, JsonObject} from './types.js';

export type WooCommerceRequest = (
  url: URL,
  options: {signal: AbortSignal; lookup: net.LookupFunction; headers: Readonly<Record<string, string>>},
) => Promise<Response>;

/** Fixed authenticated GETs only. A fresh socket connects to the public address checked by guardedLookup. */
export const wooCommerceRequest: WooCommerceRequest = (url, {signal, lookup, headers}) =>
  new Promise((resolve, reject) => {
    const request = https.request(url, {method: 'GET', agent: false, lookup, signal, headers}, response => {
      const selected = new Headers();
      for (const name of ['content-type', 'content-length', 'content-encoding', 'x-wp-total', 'x-wp-totalpages']) {
        const value = response.headers[name];
        if (typeof value === 'string') selected.set(name, value);
      }
      const status = response.statusCode ?? 502,
        empty = [204, 205, 304].includes(status);
      if (empty) response.resume();
      resolve(
        new Response(empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), {
          status,
          headers: selected,
        }),
      );
    });
    request.on('error', reject);
    request.end();
  });

export const wooCommerceSourceMeaning =
  'Only the selected published WooCommerce products and price field were read twice with unchanged store currency and current authorization. This is sequential source evidence, not a point-in-time or full inventory, variant, tax calculation, sale activation, destination eligibility or write approval. No products are changed or deleted.';
const priceFields = ['price', 'regular_price', 'sale_price'],
  productFields =
    'id,sku,name,type,status,parent_id,stock_status,tax_status,virtual,downloadable,images.id,images.src,permalink,date_modified_gmt',
  maxBytes = 4 * 1024 * 1024;
const invalid = (message: string): never => bad(message, 'INVALID_WOOCOMMERCE_SOURCE');
const refused = (): never =>
  bad(
    'WooCommerce did not return complete unchanged evidence for the exact selected products and currency.',
    'WOOCOMMERCE_SOURCE_INCOMPLETE',
  );
const changed = (): never => {
  throw new MirrorError(
    'WOOCOMMERCE_SOURCE_CHANGED',
    'The selected store, login or read permission changed. Read its products again with current authorization.',
    {},
    403,
  );
};
const unavailable = (): never => {
  throw new MirrorError(
    'WOOCOMMERCE_SOURCE_UNAVAILABLE',
    'The selected WooCommerce store did not return a bounded authenticated JSON response. Inspect its HTTPS and REST API access.',
    {},
    502,
  );
};

/** Only a configured HTTPS origin can receive this connection's Basic credentials. No caller URL or subdirectory. */
export function wooCommerceOrigin(input: unknown): URL {
  if (typeof input !== 'string' || !input || /[\x00-\x20\x7f\\]/.test(input))
    return invalid('Configure an exact public HTTPS store origin on port 443 for WooCommerce.');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return invalid('Configure an exact public HTTPS store origin on port 443 for WooCommerce.');
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    net.isIP(host.replace(/^\[|\]$/g, '')) ||
    !host.includes('.') ||
    host.endsWith('.')
  )
    return invalid('Configure an exact public HTTPS store origin on port 443 for WooCommerce.');
  return new URL(url.origin);
}

/** Current scoped connection metadata only; neither credentials nor store content is read. */
export function wooCommerceSources(store: Store, actor: Actor) {
  store.assertActorActive(actor);
  const items = store
    .listConnections(actor.tenantId)
    .filter(
      c =>
        c.enabled &&
        c.gateway === 'commerce_native_action' &&
        c.apiVersion === 'wc/v3' &&
        c.accounts.length === 1 &&
        /^[A-Za-z0-9_-]{1,160}$/.test(c.id) &&
        /^[A-Za-z0-9_-]{1,160}$/.test(c.accounts[0]!) &&
        c.scopes.some(s => s === 'read' || s === 'read_write'),
    )
    .flatMap(c => {
      try {
        const origin = wooCommerceOrigin(c.baseUrl);
        return [
          {
            connection_id: c.id,
            account_id: c.accounts[0],
            label: literal(c.label, 200) ?? c.id,
            store_origin: origin.origin,
          },
        ];
      } catch {
        return [];
      }
    });
  return {record_kind: 'catalog_sources', items, network_requests: 0, credentials_disclosed: false};
}

function id(input: unknown, zero = false): string {
  const value = typeof input === 'number' && Number.isSafeInteger(input) ? String(input) : input;
  if (typeof value !== 'string' || !(zero ? /^(0|[1-9][0-9]{0,19})$/ : /^[1-9][0-9]{0,19}$/).test(value))
    return refused();
  return value;
}
const literal = (input: unknown, max: number): string | null =>
  typeof input === 'string' && input.length <= max && !/[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(input) ? input : null;
const publicUrl = (input: unknown): string | null => {
  if (!literal(input, 2048) || /\s/.test(input as string)) return null;
  try {
    const u = new URL(input as string);
    return u.protocol === 'https:' && !u.username && !u.password ? (input as string) : null;
  } catch {
    return null;
  }
};
const wait = async <T>(pending: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return unavailable();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(
        new MirrorError(
          'WOOCOMMERCE_SOURCE_UNAVAILABLE',
          'The selected WooCommerce store did not return a bounded authenticated JSON response. Inspect its HTTPS and REST API access.',
          {},
          502,
        ),
      );
    signal.addEventListener('abort', abort, {once: true});
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
};

function project(row: JsonObject, selected: Set<string>, priceField: string): JsonObject {
  if (!obj(row)) return refused();
  const productId = id(row.id);
  if (!selected.has(productId) || row.status !== 'publish') return refused();
  const parent = id(row.parent_id, true),
    sku = literal(row.sku, 100),
    name = literal(row.name, 500),
    productType = literal(row.type, 40),
    price = literal(row[priceField], 100),
    stock = ['instock', 'outofstock', 'onbackorder'].includes(row.stock_status) ? row.stock_status : null,
    tax = ['taxable', 'shipping', 'none'].includes(row.tax_status) ? row.tax_status : null;
  if (!Array.isArray(row.images) || row.images.length > 100) return refused();
  const first = row.images[0],
    firstImage = first === undefined ? null : obj(first) ? publicUrl(first.src) : null,
    firstImageId = firstImage ? id(first.id, true) : null,
    productUrl = publicUrl(row.permalink),
    modified = literal(row.date_modified_gmt, 40),
    blockers: string[] = [];
  if (productType !== 'simple' || parent !== '0')
    blockers.push(
      'Only standalone simple products are mapped. Grouped products and variants require separate reconciliation.',
    );
  if (row.virtual !== false || row.downloadable !== false)
    blockers.push('Digital or unknown delivery configuration requires separate destination qualification.');
  if (!sku?.trim())
    blockers.push('A stable nonempty SKU of at most 100 characters is required; no retailer ID is invented.');
  if (!name?.trim()) blockers.push('A plain product name of at most 500 characters is required.');
  if (!price || !/^\d+(?:\.\d{1,2})?$/.test(price))
    blockers.push(
      'The selected source price must be an exact nonnegative decimal with at most two places for the Meta import. No price is rounded or inferred.',
    );
  if (price && /^\d+(?:\.\d{1,2})?$/.test(price)) {
    const [whole, fraction = ''] = price.split('.');
    if (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')) > BigInt(Number.MAX_SAFE_INTEGER))
      blockers.push('The source price exceeds the Meta import integer bound.');
  }
  if (!firstImage) blockers.push('The first native image must be an HTTPS URL without embedded credentials.');
  return {
    product_id: productId,
    sku,
    name,
    product_type: productType,
    status: 'publish',
    parent_id: parent,
    stock_status: stock,
    tax_status: tax,
    virtual: typeof row.virtual === 'boolean' ? row.virtual : null,
    downloadable: typeof row.downloadable === 'boolean' ? row.downloadable : null,
    selected_price: price,
    first_image_id: firstImageId,
    first_image_url: firstImage,
    product_url: productUrl,
    date_modified_gmt: modified,
    blockers,
  };
}

/** Complete evidence only for 1-50 explicitly selected published products, never an unbounded store scan. */
export async function wooCommerceSource(
  store: Store,
  actor: Actor,
  input: JsonObject,
  request: WooCommerceRequest = wooCommerceRequest,
  environment: 'production' | 'sandbox' = 'production',
) {
  if (environment !== 'production')
    throw new MirrorError(
      'SANDBOX_ROUTE_UNQUALIFIED',
      'WooCommerce product sources have no qualified sandbox route.',
      {},
      403,
    );
  validate(input, ['action', 'gateway', 'account_id', 'connection_id', 'requirements']);
  if (
    input.gateway !== 'commerce_native_action' ||
    !/^[A-Za-z0-9_-]{1,160}$/.test(input.account_id ?? '') ||
    !/^[A-Za-z0-9_-]{1,160}$/.test(input.connection_id ?? '')
  )
    invalid('Choose the exact WooCommerce store account and connection.');
  const requirements = input.requirements;
  if (!obj(requirements))
    invalid('Choose 1–50 exact published WooCommerce product IDs and price, regular_price or sale_price.');
  validate(requirements, ['product_ids', 'price_field']);
  if (
    !Array.isArray(requirements.product_ids) ||
    !requirements.product_ids.length ||
    requirements.product_ids.length > 50 ||
    requirements.product_ids.some((v: unknown) => typeof v !== 'string' || !/^[1-9][0-9]{0,19}$/.test(v)) ||
    new Set(requirements.product_ids).size !== requirements.product_ids.length ||
    !priceFields.includes(requirements.price_field)
  )
    invalid('Choose 1–50 exact published WooCommerce product IDs and price, regular_price or sale_price.');
  store.assertActorActive(actor);
  const connection = store.resolveConnection(actor, input.gateway, input.account_id, input.connection_id),
    origin = wooCommerceOrigin(connection.baseUrl);
  const binding = (current: Connection) =>
    current.apiVersion === 'wc/v3' &&
    current.accounts.length === 1 &&
    current.accounts[0] === input.account_id &&
    current.scopes.some(s => s === 'read' || s === 'read_write');
  if (!binding(connection))
    invalid(
      'The WooCommerce connection must bind one store account, wc/v3 and recorded Read or Read/Write REST API key permission.',
    );
  const credentials = store.connectionCredentials(connection);
  if (
    typeof credentials.consumerKey !== 'string' ||
    !/^ck_[A-Za-z0-9]{1,200}$/.test(credentials.consumerKey) ||
    typeof credentials.consumerSecret !== 'string' ||
    !/^cs_[A-Za-z0-9]{1,200}$/.test(credentials.consumerSecret) ||
    (credentials.expiresAt !== undefined &&
      (!Number.isSafeInteger(credentials.expiresAt) || credentials.expiresAt <= Date.now()))
  )
    invalid(
      'An existing encrypted WooCommerce Consumer Key and Consumer Secret are required for HTTPS Basic authentication.',
    );
  const credentialHash = sha256(stable(credentials)),
    current = () => {
      store.assertActorActive(actor);
      const now = store.resolveConnection(actor, input.gateway, input.account_id, connection.id);
      if (
        !binding(now) ||
        wooCommerceOrigin(now.baseUrl).origin !== origin.origin ||
        connection.scopes.some(s => !now.scopes.includes(s)) ||
        sha256(stable(store.connectionCredentials(now))) !== credentialHash ||
        (credentials.expiresAt !== undefined && credentials.expiresAt <= Date.now())
      )
        changed();
    },
    signal = AbortSignal.timeout(30000),
    lookup = guardedLookup(),
    headers = Object.freeze({
      Accept: 'application/json',
      'User-Agent': 'AMCP WooCommerce product source',
      Authorization:
        'Basic ' + Buffer.from(credentials.consumerKey + ':' + credentials.consumerSecret).toString('base64'),
    }),
    productIds = [...requirements.product_ids].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
    ),
    selected = new Set<string>(productIds);
  let attempts = 0,
    bytes = 0,
    rows = 0;
  const read = async (kind: 'currency' | 'products') => {
    current();
    if (signal.aborted || ++attempts > 4) unavailable();
    const url = new URL(
      kind === 'currency' ? '/wp-json/wc/v3/settings/general/woocommerce_currency' : '/wp-json/wc/v3/products',
      origin,
    );
    url.searchParams.set('_fields', kind === 'currency' ? 'id,value' : productFields + ',' + requirements.price_field);
    if (kind === 'products')
      for (const [key, value] of Object.entries({
        context: 'view',
        include: productIds.join(','),
        status: 'publish',
        order: 'asc',
        orderby: 'id',
        page: '1',
        per_page: '100',
      }))
        url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await wait(request(url, {signal, lookup, headers}), signal);
    } catch {
      current();
      return unavailable();
    }
    current();
    if (
      response.status !== 200 ||
      response.redirected ||
      (response.url && response.url !== url.href) ||
      !/application\/(?:[a-z0-9.+-]*\+)?json(?:;|$)/i.test(response.headers.get('content-type') ?? '') ||
      (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') ||
      !response.body
    ) {
      await response.body?.cancel();
      return unavailable();
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maxBytes - bytes)) {
      await response.body.cancel();
      return refused();
    }
    const reader = response.body.getReader(),
      chunks: Buffer[] = [];
    let length = 0;
    try {
      for (;;) {
        current();
        const chunk = await wait(reader.read(), signal);
        current();
        if (chunk.done) break;
        const part = Buffer.from(chunk.value);
        bytes += part.length;
        length += part.length;
        if (bytes > maxBytes) return refused();
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
    if (declared !== null && Number(declared) !== length) return refused();
    let data: unknown;
    try {
      const text = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks));
      data = JSON.parse(text, ((_key: string, value: unknown, context?: {source: string}) =>
        typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)
          ? (context?.source ?? String(value))
          : value) as any);
    } catch {
      return refused();
    }
    current();
    if (kind === 'currency') {
      if (
        !obj(data) ||
        data.id !== 'woocommerce_currency' ||
        typeof data.value !== 'string' ||
        !/^[A-Z]{3}$/.test(data.value)
      )
        return refused();
      return data.value;
    }
    if (
      !Array.isArray(data) ||
      data.length !== selected.size ||
      response.headers.get('x-wp-total') !== String(selected.size) ||
      response.headers.get('x-wp-totalpages') !== '1' ||
      (rows += data.length) > 100
    )
      return refused();
    const items = data.map(row => project(row, selected, requirements.price_field));
    if (new Set(items.map(row => row.product_id)).size !== selected.size) return refused();
    items.sort((a, b) => (BigInt(a.product_id) < BigInt(b.product_id) ? -1 : 1));
    const skus = items.filter(item => item.sku).map(item => item.sku);
    for (const item of items)
      if (item.sku && skus.filter(sku => sku === item.sku).length > 1)
        item.blockers.push(
          'Selected products have duplicate SKUs. Choose stable unique retailer IDs before importing.',
        );
    return items;
  };
  const currency = await read('currency'),
    first = await read('products'),
    second = await read('products'),
    finalCurrency = await read('currency');
  current();
  if (currency !== finalCurrency || fingerprint(first) !== fingerprint(second)) return refused();
  const scope = {
    gateway: input.gateway,
    account_id: input.account_id,
    connection_id: connection.id,
    store_origin: origin.origin,
    api_version: 'wc/v3',
    price_field: requirements.price_field,
  };
  return {
    record_kind: 'catalog_source',
    state: 'complete',
    scope,
    product_ids: productIds,
    native_currency: currency,
    source_hash: fingerprint({scope, native_currency: currency, items: first}),
    items: first,
    selected_product_count: selected.size,
    native_requests: attempts,
    collected_rows: rows,
    captured_at: Date.now(),
    complete_selected_evidence: true,
    full_inventory: false,
    provider_mutations: 0,
    destructive_deletions: 0,
    tax_calculation: 'unverified',
    source_saved: false,
    meaning: wooCommerceSourceMeaning,
  };
}
