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
export const wooCommerceVariationMeaning =
  'Only the selected published WooCommerce variations were read twice under the same repeated variable parent membership and store currency with current authorization. Native variations have no product name: destination titles require explicit operator review. This is sequential source evidence, not a point-in-time or full inventory, tax calculation, sale activation, independently qualified child image, destination eligibility or write approval. No products are changed or deleted.';
const priceFields = ['price', 'regular_price', 'sale_price'],
  productFields =
    'id,sku,name,type,status,parent_id,stock_status,tax_status,virtual,downloadable,images.id,images.src,permalink,date_modified_gmt',
  parentFields = 'id,sku,name,type,status,parent_id,variations,date_modified_gmt',
  variationFields =
    'id,sku,status,stock_status,tax_status,virtual,downloadable,image.id,image.src,attributes.id,attributes.name,attributes.option,permalink,date_modified_gmt',
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
  else if (sku !== sku.trim())
    blockers.push(
      'The native SKU has surrounding whitespace. Correct it in the store before Meta mapping; AMCP preserves it unchanged.',
    );
  if (!name?.trim()) blockers.push('A plain product name of at most 500 characters is required.');
  else if (name !== name.trim())
    blockers.push(
      'The native product name has surrounding whitespace. Correct it in the store before Meta mapping; AMCP preserves it unchanged.',
    );
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

function projectParent(row: unknown, parentId: string, selected: Set<string>): JsonObject {
  if (
    !obj(row) ||
    id(row.id) !== parentId ||
    row.type !== 'variable' ||
    row.status !== 'publish' ||
    id(row.parent_id, true) !== '0' ||
    !Array.isArray(row.variations) ||
    row.variations.length > 1000
  )
    return refused();
  const membership = row.variations.map(value => id(value));
  if (
    new Set(membership).size !== membership.length ||
    membership.includes(parentId) ||
    [...selected].some(value => !membership.includes(value))
  )
    return refused();
  membership.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  return {
    product_id: parentId,
    sku: literal(row.sku, 100),
    name: literal(row.name, 500),
    product_type: 'variable',
    status: 'publish',
    variation_ids: membership,
    date_modified_gmt: literal(row.date_modified_gmt, 40),
  };
}
function projectVariation(row: JsonObject, selected: Set<string>, priceField: string, parent: JsonObject): JsonObject {
  if (
    !obj(row) ||
    row.status !== 'publish' ||
    !selected.has(id(row.id)) ||
    !Array.isArray(row.attributes) ||
    row.attributes.length > 25
  )
    return refused();
  const productId = id(row.id),
    sku = literal(row.sku, 100),
    price = literal(row[priceField], 100),
    image = obj(row.image) ? row.image : undefined,
    firstImage = image ? publicUrl(image.src) : null,
    imageId = firstImage ? id(image!.id, true) : null,
    attributes = row.attributes.map(value => {
      if (!obj(value)) return refused();
      const name = literal(value.name, 200),
        option = literal(value.option, 200);
      if (!name?.trim() || !option?.trim()) return refused();
      return {id: id(value.id, true), name, option};
    }),
    blockers: string[] = [];
  if (
    new Set(attributes.map(value => (value.id === '0' ? 'custom:' + value.name : value.id))).size !== attributes.length
  )
    return refused();
  if (!sku?.trim())
    blockers.push('A stable nonempty SKU of at most 100 characters is required; no retailer ID is invented.');
  else if (sku !== sku.trim())
    blockers.push(
      'The native SKU has surrounding whitespace. Correct it in the store before Meta mapping; AMCP preserves it unchanged.',
    );
  if (!parent.sku?.trim() || parent.sku !== parent.sku.trim())
    blockers.push(
      'The native parent needs a nonempty SKU without surrounding whitespace before explicit Meta group mapping. No group ID is invented.',
    );
  if (sku && sku === parent.sku)
    blockers.push(
      'The selected variation SKU equals its parent SKU. Use distinct native product and group identities before Meta mapping.',
    );
  if (!parent.name?.trim() || parent.name !== parent.name.trim())
    blockers.push(
      'The native parent name is unavailable or has surrounding whitespace. Correct it before reviewing a destination title.',
    );
  if (row.virtual !== false || row.downloadable !== false)
    blockers.push('Digital or unknown delivery configuration requires separate destination qualification.');
  if (!price || !/^\d+(?:\.\d{1,2})?$/.test(price))
    blockers.push(
      'The selected source price must be an exact nonnegative decimal with at most two places for the Meta import. No price is rounded or inferred.',
    );
  else {
    const [whole, fraction = ''] = price.split('.');
    if (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')) > BigInt(Number.MAX_SAFE_INTEGER))
      blockers.push('The source price exceeds the Meta import integer bound.');
  }
  if (!firstImage)
    blockers.push(
      'The provider-reported variation image must be an HTTPS URL without embedded credentials. No parent image is substituted.',
    );
  const suggestion = parent.name
    ? parent.name +
      (attributes.length ? ' — ' + attributes.map(value => value.name + ': ' + value.option).join(', ') : '')
    : null;
  return {
    product_id: productId,
    sku,
    name: null,
    parent_product_id: parent.product_id,
    parent_name: parent.name,
    parent_sku: parent.sku,
    suggested_destination_name: suggestion && suggestion.length <= 500 ? suggestion : null,
    requires_title_review: true,
    attributes,
    status: 'publish',
    selected_price: price,
    stock_status: ['instock', 'outofstock', 'onbackorder'].includes(row.stock_status) ? row.stock_status : null,
    tax_status: ['taxable', 'shipping', 'none'].includes(row.tax_status) ? row.tax_status : null,
    virtual: typeof row.virtual === 'boolean' ? row.virtual : null,
    downloadable: typeof row.downloadable === 'boolean' ? row.downloadable : null,
    first_image_id: imageId,
    first_image_url: firstImage,
    image_origin: 'provider-reported variation image; custom-child origin unverified',
    product_url: publicUrl(row.permalink),
    date_modified_gmt: literal(row.date_modified_gmt, 40),
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
  const variations = requirements.source_kind === 'variations';
  validate(
    requirements,
    variations ? ['source_kind', 'parent_product_id', 'variation_ids', 'price_field'] : ['product_ids', 'price_field'],
  );
  const selectedIds = variations ? requirements.variation_ids : requirements.product_ids;
  if (
    !Array.isArray(selectedIds) ||
    !selectedIds.length ||
    selectedIds.length > 50 ||
    selectedIds.some((v: unknown) => typeof v !== 'string' || !/^[1-9][0-9]{0,19}$/.test(v)) ||
    new Set(selectedIds).size !== selectedIds.length ||
    (variations &&
      (typeof requirements.parent_product_id !== 'string' ||
        !/^[1-9][0-9]{0,19}$/.test(requirements.parent_product_id) ||
        selectedIds.includes(requirements.parent_product_id))) ||
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
    productIds = [...selectedIds].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)),
    selected = new Set<string>(productIds);
  let attempts = 0,
    bytes = 0,
    rows = 0,
    parent: JsonObject | undefined;
  const read = async (kind: 'currency' | 'products' | 'parent' | 'variations') => {
    current();
    if (signal.aborted || ++attempts > (variations ? 6 : 4)) unavailable();
    const url = new URL(
      kind === 'currency'
        ? '/wp-json/wc/v3/settings/general/woocommerce_currency'
        : kind === 'parent'
          ? '/wp-json/wc/v3/products/' + requirements.parent_product_id
          : kind === 'variations'
            ? '/wp-json/wc/v3/products/' + requirements.parent_product_id + '/variations'
            : '/wp-json/wc/v3/products',
      origin,
    );
    url.searchParams.set(
      '_fields',
      kind === 'currency'
        ? 'id,value'
        : kind === 'parent'
          ? parentFields
          : (kind === 'variations' ? variationFields : productFields) + ',' + requirements.price_field,
    );
    if (kind === 'products' || kind === 'variations')
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
    if (kind === 'parent') {
      if ((rows += 1) > 102) return refused();
      return projectParent(data, requirements.parent_product_id, selected);
    }
    if (
      !Array.isArray(data) ||
      data.length !== selected.size ||
      response.headers.get('x-wp-total') !== String(selected.size) ||
      response.headers.get('x-wp-totalpages') !== '1' ||
      (rows += data.length) > (variations ? 102 : 100)
    )
      return refused();
    const items = data.map(row =>
      kind === 'variations'
        ? projectVariation(row, selected, requirements.price_field, parent!)
        : project(row, selected, requirements.price_field),
    );
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
  const currency = await read('currency');
  if (variations) parent = (await read('parent')) as JsonObject;
  const first = await read(variations ? 'variations' : 'products'),
    second = await read(variations ? 'variations' : 'products'),
    finalParent = variations ? await read('parent') : undefined,
    finalCurrency = await read('currency');
  current();
  if (
    currency !== finalCurrency ||
    fingerprint(first) !== fingerprint(second) ||
    (variations && fingerprint(parent) !== fingerprint(finalParent))
  )
    return refused();
  const scope = {
    gateway: input.gateway,
    account_id: input.account_id,
    connection_id: connection.id,
    store_origin: origin.origin,
    api_version: 'wc/v3',
    price_field: requirements.price_field,
    ...(variations ? {source_kind: 'variations', parent_product_id: requirements.parent_product_id} : {}),
  };
  return {
    record_kind: 'catalog_source',
    state: 'complete',
    scope,
    product_ids: productIds,
    native_currency: currency,
    source_hash: fingerprint({scope, native_currency: currency, items: first, ...(variations ? {parent} : {})}),
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
    ...(variations ? {parent} : {}),
    meaning: variations ? wooCommerceVariationMeaning : wooCommerceSourceMeaning,
  };
}
