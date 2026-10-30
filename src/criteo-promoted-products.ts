import type {ReviewedFamily} from './reviewed-family.js';
import type {Store} from './store.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {assertCriteoLineItemScopes, criteoLineItemStateRead, criteoProductKey} from './criteo-auction-line-items.js';
import {criteoRoute} from './criteo-version.js';
import {defineFamily, fail} from './family-kit.js';

/**
 * Promoted products of Criteo auction line items on Retail Media API 2026-07 (unchanged from 2026-01), per the pinned
 * OpenAPI document (FetchPromotedProducts, AppendPromotedProducts, DeletePromotedProducts, PausePromotedProducts,
 * UnpausePromotedProducts) and the "Promoted Products" guide (checked 2026-09-26).
 * - Append adds catalog products; for a product the line item already promotes it only changes the bid override
 *   (0 removes the override, so the line item's target bid applies).
 * - Delete removes products; once a line item has products, at least one must remain.
 * - Pause and unpause take product IDs only.
 * Products of an active line item serve at once. A line item set to active without products stays in draft until
 * products are appended, and then starts serving.
 */
const gateway = 'criteo_native_action',
  origin = 'https://api.criteo.com';
type Kind = 'append' | 'delete' | 'pause' | 'unpause';
const actions: Record<Kind, string> = {
  append: 'criteo_catalog_ops/APPEND_PROMOTED_PRODUCTS',
  delete: 'criteo_catalog_ops/DELETE_PROMOTED_PRODUCTS',
  pause: 'criteo_catalog_ops/PAUSE_PROMOTED_PRODUCTS',
  unpause: 'criteo_catalog_ops/UNPAUSE_PROMOTED_PRODUCTS',
};
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
/** A retailer catalog product ID: up to 500 characters. */
const sku = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= 500 && v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v);
function invalid(message: string): never {
  return fail('INVALID_CRITEO_PROMOTED_PRODUCTS', message);
}
const list = (ids: string[]) =>
  ids.slice(0, 10).join(', ') + (ids.length > 10 ? ' and ' + (ids.length - 10) + ' more' : '');

export function criteoPromotedProductsKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || (p.origin && p.origin !== origin) || p.specialTransport || p.method !== 'POST') return;
  const m = criteoRoute('/line-items/[1-9][0-9]{0,18}/products/(append|delete|pause|unpause)$').exec(p.path);
  return m && p.action === actions[m[1] as Kind] ? (m[1] as Kind) : undefined;
}
const lineOf = (p: CompiledRequest) => p.path.split('/')[4]!;
const rows = (p: CompiledRequest): JsonObject[] => (p.body as JsonObject).data;
/** The bid override a request sets: 0 removes it, as Criteo reads it back. */
const bid = (r: JsonObject): number | null | undefined =>
  r.attributes?.bidOverride === undefined ? undefined : r.attributes.bidOverride > 0 ? r.attributes.bidOverride : null;

export function assertCriteoPromotedProducts(p: CompiledRequest): void {
  const kind = criteoPromotedProductsKind(p);
  if (!kind) return;
  if (!id(p.accountId) || Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Use one numeric Criteo account without query or header overrides.');
  const b = p.body;
  if (
    !obj(b) ||
    Object.keys(b).some(k => k !== 'data') ||
    !Array.isArray(b.data) ||
    !b.data.length ||
    b.data.length > 500
  )
    invalid('Provide {data: [...]} with 1–500 products.');
  const seen = new Set<string>();
  for (const r of b.data) {
    if (!obj(r) || Object.keys(r).some(k => !['id', 'type', 'attributes'].includes(k)) || !sku(r.id))
      invalid('Each product is {id, type, attributes} with its catalog product ID (1–500 characters).');
    if (r.type !== undefined && r.type !== 'RetailMediaPromotedProduct')
      invalid('type is RetailMediaPromotedProduct when given.');
    if (seen.has(r.id)) invalid('Product ' + r.id + ' is listed twice.');
    seen.add(r.id);
    if (kind !== 'append') {
      if (r.attributes !== undefined)
        invalid('Deleting, pausing and unpausing take product IDs only; leave attributes out.');
      continue;
    }
    const a = r.attributes;
    if (a === undefined) continue;
    if (!obj(a) || Object.keys(a).some(k => !['id', 'bidOverride'].includes(k)))
      invalid(
        obj(a) && Object.hasOwn(a, 'status')
          ? 'Append adds products; pause or unpause them with their own actions.'
          : 'Appended product attributes are id and bidOverride only.',
      );
    if (a.id !== undefined && a.id !== r.id) invalid('attributes.id must match the product id.');
    if (
      a.bidOverride !== undefined &&
      !(
        typeof a.bidOverride === 'number' &&
        Number.isFinite(a.bidOverride) &&
        a.bidOverride >= 0 &&
        a.bidOverride <= Number.MAX_SAFE_INTEGER
      )
    )
      invalid('bidOverride is a nonnegative amount in the account currency; 0 removes the override.');
  }
}
/** Ownership of the line item comes from the account's line item list or its verified creation through AMCP. */
export function authorizeCriteoPromotedProducts(
  p: CompiledRequest,
  c: Connection,
  store: Store,
  account: string,
): boolean {
  if (!criteoPromotedProductsKind(p)) return false;
  assertCriteoPromotedProducts(p);
  assertCriteoLineItemScopes(c, true);
  if (!store.ownsResource(c, account, 'criteo-report-target/line-items/' + lineOf(p)))
    fail(
      'RESOURCE_SCOPE_REQUIRED',
      'List the line item in this account first (GET_LINE_ITEMS_BY_ACCOUNT_ID with limitToId), or create it through AMCP. Preparation rereads the current membership.',
      {},
      403,
    );
  return true;
}
export function criteoPromotedProductsReads(p: CompiledRequest): CompiledRequest[] {
  return [criteoLineItemStateRead(p, {lineItemId: lineOf(p), siblings: false, products: true})];
}

const products = (state: unknown): Map<string, JsonObject> =>
  new Map(obj(state) && Array.isArray(state.products) ? state.products.filter(obj).map(x => [x.id, x]) : []);
export function validateCriteoPromotedProductsPrerequisites(plan: CompiledRequest, states: unknown[]): void {
  const kind = criteoPromotedProductsKind(plan);
  if (!kind) return;
  const s = states[0];
  if (!obj(s) || !obj(s.line) || !Array.isArray(s.products))
    fail('INCOMPLETE_STATE', 'Missing verified Criteo line item products.', {}, 502);
  if (s.line.status === 'archived') invalid('Line item ' + s.line.id + ' is archived and cannot be changed.');
  const current = products(s),
    requested = rows(plan);
  if (kind === 'append') {
    for (const r of requested) {
      const c = current.get(r.id);
      if (!c) continue;
      if (bid(r) === undefined)
        fail(
          'CONFIGURATION_EXISTS',
          'Line item ' +
            s.line.id +
            ' already promotes product ' +
            r.id +
            '. Send its bidOverride to change it, or leave the product out.',
          {product_id: r.id},
        );
      if (bid(r) === c.bidOverride) invalid('Product ' + r.id + ' already has this bid override.');
    }
    if (current.size + requested.filter(r => !current.has(r.id)).length > 1500)
      invalid('This contract keeps a line item within 1500 products, the limit Criteo suggests.');
    return;
  }
  const missing = requested.filter(r => !current.has(r.id)).map(r => r.id);
  if (missing.length)
    fail(
      'STATE_TARGET_MISMATCH',
      'Line item ' + s.line.id + ' does not promote ' + list(missing) + '.',
      {product_ids: missing.slice(0, 50)},
      409,
    );
  if (kind === 'delete' && current.size - requested.length < 1)
    invalid('Criteo keeps at least one product on a line item that has products; pause the last product instead.');
  const wrong = requested
    .filter(r =>
      kind === 'pause'
        ? current.get(r.id)!.status !== 'active'
        : kind === 'unpause'
          ? current.get(r.id)!.status !== 'paused'
          : false,
    )
    .map(r => r.id);
  if (wrong.length)
    invalid(
      (kind === 'pause' ? 'Only active products can be paused: ' : 'Only paused products can be unpaused: ') +
        list(wrong) +
        '.',
    );
}
/** Adding products or unpausing them lets a line item that is not paused serve them. */
export function criteoPromotedProductsServing(plan: CompiledRequest, before: unknown): boolean {
  const kind = criteoPromotedProductsKind(plan);
  if (kind !== 'append' && kind !== 'unpause') return false;
  const s = Array.isArray(before) ? before[0] : undefined;
  if (!obj(s) || !obj(s.line)) return true;
  if (kind === 'append' && !rows(plan).some(r => !products(s).has(r.id))) return false;
  return s.line.status !== 'paused';
}
export function criteoPromotedProductsImpact(plan: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = criteoPromotedProductsKind(plan);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = obj(first) ? first : {},
    line = obj(s.line) ? s.line : undefined,
    current = products(s),
    requested = rows(plan),
    ids = requested.map(r => r.id);
  const added = kind === 'append' ? ids.filter(x => !current.has(x)) : [];
  const status = line?.status;
  const serving =
    status === 'paused'
      ? 'The line item is paused; the products serve once it is active.'
      : status === 'draft'
        ? 'The line item is in draft; with products it can serve once it is set to active, and at once if it already is.'
        : 'The line item is active, so the change applies to delivery at once.';
  return {
    provider: 'criteo',
    scope: 'promoted_products',
    operation: kind,
    line_item: line
      ? {id: line.id, name: line.name, status, target_bid: line.targetBid, campaign_id: line.campaignId}
      : null,
    currency: s.account?.currency ?? null,
    products_before: current.size,
    products_after:
      kind === 'append' ? current.size + added.length : kind === 'delete' ? current.size - ids.length : current.size,
    added,
    bid_overrides:
      kind === 'append'
        ? requested
            .filter(r => current.has(r.id))
            .map(r => ({id: r.id, before: current.get(r.id)!.bidOverride, after: bid(r)}))
        : [],
    removed: kind === 'delete' ? ids : [],
    paused: kind === 'pause' ? ids : [],
    unpaused: kind === 'unpause' ? ids : [],
    may_affect_serving: true,
    effect:
      {
        append: 'Adds products to the line item and changes the bid overrides of products it already promotes. ',
        delete: 'Removes products from the line item. ',
        pause: 'Stops advertising the products on this line item. ',
        unpause: 'Advertises the paused products again. ',
      }[kind] + serving,
    units:
      "bidOverride is an amount in the account currency, excluding platform fees, and must meet each product's minimum bid; 0 removes the override so the line item target bid applies.",
    verification: 'Reads every product of the line item again and compares each product in the request.',
    source: 'https://developers.criteo.com/retail-media/docs/promoted-products',
  };
}
export function criteoPromotedProductsOutcome(_plan: CompiledRequest, r: TransportResult): boolean {
  const d = r.data;
  if (r.status === 204) return d == null || d === '' || (obj(d) && !Object.keys(d).length);
  return (
    r.status === 200 &&
    obj(d) &&
    d.error === undefined &&
    ['errors', 'warnings'].every(k => d[k] == null || (Array.isArray(d[k]) && !d[k].length))
  );
}
export function criteoPromotedProductsVerification(
  plan: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = criteoPromotedProductsKind(plan)!,
    expected: JsonObject = {};
  for (const r of rows(plan)) {
    const key = criteoProductKey(r.id);
    // Presence is compared explicitly, so a missing product never matches an expected empty bid override.
    expected[key] =
      kind === 'delete'
        ? null
        : kind === 'append'
          ? {present: true, ...(bid(r) === undefined ? {} : {bidOverride: bid(r)})}
          : {present: true, status: kind === 'pause' ? 'paused' : 'active'};
  }
  return [
    {
      read: criteoPromotedProductsReads(plan)[0]!,
      expected: {products: expected},
      id: 'promoted products of line item ' + lineOf(plan),
    },
  ];
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const criteoPromotedProductsFamily: ReviewedFamily = defineFamily({
  name: 'criteo_promoted_products',
  files: ['src/criteo-promoted-products.ts', ['tests/criteo-promoted-products.test.mjs']],
  kind: criteoPromotedProductsKind,
  assert: assertCriteoPromotedProducts,
  authorize: (p, c, account, store) => authorizeCriteoPromotedProducts(p, c, store, account),
  snapshots: criteoPromotedProductsReads,
  prerequisites: validateCriteoPromotedProductsPrerequisites,
  impact: criteoPromotedProductsImpact,
  outcome: criteoPromotedProductsOutcome,
  verification: criteoPromotedProductsVerification,
  scope: (c, write) => assertCriteoLineItemScopes(c, write),
  spendConfirmation: {
    needed: p => ['append', 'unpause'].includes(criteoPromotedProductsKind(p) as string),
    message:
      'Appending or unpausing promoted products, and changing their bid overrides, changes what the line item advertises and at what price. Review the products and provide spend_change_confirmed=true.',
  },
  activates: criteoPromotedProductsServing,
  destructive: p => criteoPromotedProductsKind(p) === 'delete',
  exemptFromSpendTextMatch: true,
});
