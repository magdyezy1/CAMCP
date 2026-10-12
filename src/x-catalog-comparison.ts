import {catalogIngestion, catalogRetirement, retired} from './catalog-ingestion.js';
import {catalogInventoryRequested, catalogSelectionInventory} from './x-catalog-selection-inventory.js';
import {nativeAuthority} from './native-authority.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {ScopeGuard} from './scope.js';
import {MirrorError} from './errors.js';
import {fingerprint} from './workspace-core.js';
import {
  catalogPrice,
  object,
  ownedCatalog,
  text,
  unverified,
  xCatalogComparedFields as fields,
  xCatalogHeldOptional,
  xCatalogOwners,
  xCatalogProducts,
  xCatalogRead,
  xCatalogProductGrouping,
  xCatalogRowView as rowView,
  xSnowflake,
  fail,
} from './x-catalogs.js';
import {assertXCatalogProduct} from './x-catalog-products.js';
import {
  catalogDestinations,
  catalogItemSchemaVersion,
  comparisonItemV2,
  comparisonSummary,
} from './catalog-destinations.js';
import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import type {NativeTransport} from './transport.js';
import type {CredentialProvider} from './auth.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

function unknown(message: string): never {
  return unverified(message);
}
function grouped(row: JsonObject): boolean {
  return xCatalogProductGrouping(row) !== 'individual';
}
/** One bounded read of an X catalog under the selected account and login: every request rechecks authority. */
type XCatalogSession = {
  read: CompiledRequest;
  scope: JsonObject;
  requested_at: number;
  fetch: (page: CompiledRequest) => Promise<TransportResult>;
  requests: () => number;
  /** Authority once more after the last read, and the collection limits. */
  close: () => void;
};
/**
 * The shared read session of the X comparison and of a listed selection (COM-02 B): scope check, credentials, a
 * 180-attempt, 5,000-row, 4 MiB and 60-second collection allowance, and the authority fence on every attempt.
 */
async function xCatalogSession<T>(
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  actor: Actor,
  input: JsonObject,
  plan: CompiledRequest,
  key: JsonObject,
  run: (session: XCatalogSession) => Promise<T>,
): Promise<T> {
  const scope: JsonObject = {
    gateway: input.gateway,
    account_id: input.account_id,
    connection_id: input.connection_id,
    catalog_id: input.catalog_id,
  };
  const read = xCatalogRead(plan, '/12/accounts/' + input.account_id + '/promotable_users', {count: 200}),
    connection = store.resolveConnection(actor, input.gateway, input.account_id, input.connection_id);
  scope.connection_id = connection.id;
  new ScopeGuard(registry, store).authorize(read, connection);
  const auth = await credentials.get(connection),
    current = store.resolveConnection(actor, input.gateway, input.account_id, connection.id),
    requested_at = Date.now(),
    budget = new ReportCollectionBudget(undefined, fingerprint({scope, ...key}), () => {}, {
      requests: 180,
      rows: 5000,
      bytes: 4 * 1024 * 1024,
      elapsed_ms: 60000,
    });
  let network_requests = 0;
  try {
    return await budget.run(async () => {
      const fetch = async (page: CompiledRequest) => {
        const access = nativeAuthority(store, registry, actor, page, current, auth),
          response = await transport.request(page, access(), auth, undefined, {
            beforeAttempt: () => {
              access();
              network_requests++;
            },
          });
        access();
        const data = response.data;
        if (object(data) && Array.isArray(data.data)) {
          budget.rows('request-' + network_requests, data.data.length);
          if (
            page.path === '/12/product_catalogs' &&
            data.data.some((r: unknown) => !object(r) || typeof r.id !== 'string' || !xSnowflake.test(r.id))
          )
            unknown('X returned an unrecognized catalog identity.');
          if (page.path.endsWith('/products') && data.data.length > 100)
            unknown('X returned more products than the requested page size.');
        }
        return response;
      };
      return run({
        read,
        scope,
        requested_at,
        fetch,
        requests: () => network_requests,
        close: () => {
          nativeAuthority(store, registry, actor, read, current, auth)();
          budget.check();
        },
      });
    });
  } catch (error) {
    if (error instanceof MirrorError && error.code === 'REPORT_COLLECTION_LIMIT')
      throw new MirrorError(
        'CATALOG_COMPARISON_LIMIT',
        'X catalog comparison reached its collection limit. Read a smaller eligible catalog again; no product changes were submitted.',
        {dimension: error.details.dimension, used: error.details.used, limit: error.details.limit},
        422,
      );
    throw error;
  } finally {
    budget.close();
  }
}
/** Read-only supplied-SKU reconciliation. Reuses existing bounded native catalog reads, never their write lifecycle. */
export async function xCatalogComparison(
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  actor: Actor,
  input: JsonObject,
) {
  const inspect = catalogInventoryRequested(input),
    preview = catalogIngestion(input),
    retire = catalogRetirement(input);
  const first = preview.plan.steps[0]!,
    plan: CompiledRequest = {
      gateway: input.gateway,
      accountId: input.account_id,
      action: first.arguments.action,
      method: 'PUT',
      path: '/12/product_catalogs/' + input.catalog_id + '/products',
      query: {},
      headers: {},
      body: first.arguments.payload,
      readOnly: false,
      destructive: false,
      requiresConfirmation: true,
      evidence: 'Existing qualified X product contract',
      warnings: [],
    };
  assertXCatalogProduct(plan);
  return xCatalogSession(
    store,
    registry,
    transport,
    credentials,
    actor,
    input,
    plan,
    {source_hash: preview.source_hash},
    async ({read, scope, requested_at, fetch, requests, close}) => {
      const owners = await xCatalogOwners(read, fetch),
        catalog = ownedCatalog(owners, input.catalog_id);
      const project = (rows: JsonObject[]) => {
        const byId = new Map<string, JsonObject>(),
          keys = new Set<string>();
        let hidden = false;
        for (const row of rows) {
          if (
            !text(row.id, 100) ||
            typeof row.product_key !== 'string' ||
            !xSnowflake.test(row.product_key) ||
            byId.has(row.id) ||
            keys.has(row.product_key)
          )
            unknown('X returned an unrecognized or repeated product identity.');
          byId.set(row.id, row);
          keys.add(row.product_key);
          hidden = grouped(row) || hidden;
        }
        return input.products.map((supplied: JsonObject, index: number) => {
          // A retired product is compared with its retirement availability (COM-02 B).
          const source = retired(supplied, retire),
            row = byId.get(source.retailer_id),
            before = row ? rowView(row) : {present: hidden ? null : false, price: null},
            // The native product this source becomes (its sale included), from the same projection as the plan.
            native: JsonObject = preview.plan.steps[index]!.arguments.payload.products[0];
          const item: JsonObject = {
            retailer_id: source.retailer_id,
            product_id: row ? row.product_key : null,
            before,
            state: 'new',
            price_matches: null,
            ...(native.sale_price !== undefined ? {sale_price_matches: null} : {}),
            changes: [],
            unknown_fields: [],
            blocked: false,
            blocked_reason: null,
            unsent_fields: [],
          };
          if (!row) {
            if (hidden)
              Object.assign(item, {
                state: 'unknown',
                blocked: true,
                blocked_reason: 'hidden_variant',
                unknown_fields: ['retailer_id'],
              });
            return item;
          }
          item.unsent_fields = xCatalogHeldOptional(row, native);
          if (grouped(row)) {
            Object.assign(item, {
              state: 'unknown',
              blocked: true,
              blocked_reason: xCatalogProductGrouping(row) === 'grouped' ? 'grouped_product' : 'group_status_unknown',
              unknown_fields: ['retailer_id'],
            });
            return item;
          }
          const observed = catalogPrice(row.price),
            proposed = catalogPrice(source.price + ' ' + source.currency)!;
          item.price_matches = observed
            ? observed.units === proposed.units && observed.currency === proposed.currency
            : null;
          for (const key of Object.keys(fields)) {
            if (before[key] === null) item.unknown_fields.push(key);
            else if (before[key] !== source[key])
              item.changes.push({field: key, before: before[key], after: source[key]});
          }
          if (!observed) item.unknown_fields.push('price', 'currency');
          else if (!item.price_matches)
            item.changes.push({
              field: 'price',
              before: row.price,
              after_native_price: source.price + ' ' + source.currency,
            });
          // A supplied sale (COM-02 A): the amount compares exactly, its effective period literally. A product without a
          // current sale shows the sale as a change; an unparseable current sale price stays unknown.
          if (native.sale_price !== undefined) {
            const current = before.sale_price === null ? undefined : catalogPrice(before.sale_price),
              sale = catalogPrice(native.sale_price)!;
            if (before.sale_price !== null && !current) item.unknown_fields.push('sale_price');
            else {
              item.sale_price_matches = !!current && current.units === sale.units && current.currency === sale.currency;
              if (!item.sale_price_matches)
                item.changes.push({
                  field: 'sale_price',
                  before: before.sale_price,
                  after_native_price: native.sale_price,
                });
            }
          }
          if (
            native.sale_price_effective_date !== undefined &&
            before.sale_price_effective_date !== native.sale_price_effective_date
          )
            item.changes.push({
              field: 'sale_price_effective_date',
              before: before.sale_price_effective_date,
              after: native.sale_price_effective_date,
            });
          item.state = item.changes.length ? 'changed' : item.unknown_fields.length ? 'unknown' : 'matching';
          return item;
        });
      };
      const collect = async () => {
        const scan = await xCatalogProducts(read, fetch, input.catalog_id);
        if (!scan.complete)
          fail(
            'CATALOG_SCAN_LIMIT',
            'X comparison requires a complete catalog scan of at most 1,000 listed products. No product changes were submitted.',
            {},
            409,
          );
        return {
          items: project(scan.rows),
          inventory: inspect ? catalogSelectionInventory(scan.rows, input.products) : null,
        };
      };
      const collected = await collect(),
        repeated = await collect(),
        after = ownedCatalog(await xCatalogOwners(read, fetch), input.catalog_id),
        // The shared item v2 (COM-03) beside X's own evidence, once both scans agree.
        items = collected.items.map((item: JsonObject, i: number) =>
          comparisonItemV2(
            item,
            retired(input.products[i], retire),
            catalogDestinations.x_ads_native_action,
            !!retire?.ids.has(item.retailer_id),
          ),
        );
      if (fingerprint(collected.items) !== fingerprint(repeated.items) || fingerprint(catalog) !== fingerprint(after))
        fail(
          'CATALOG_COMPARISON_CHANGED',
          'X catalog ownership or supplied-product evidence changed during comparison. Read the source products again; no product changes were submitted.',
          {},
          409,
        );
      if (inspect && collected.inventory!.material_hash !== repeated.inventory!.material_hash)
        fail(
          'CATALOG_COMPARISON_CHANGED',
          'X listed catalog observations changed during collection. Read them again; no product changes were submitted.',
          {},
          409,
        );
      close();
      const {summary, review_retailer_ids} = comparisonSummary(items);
      const captured_at = Date.now();
      return {
        record_kind: 'catalog_comparison',
        item_schema_version: catalogItemSchemaVersion,
        scope,
        complete: true,
        catalog: {
          id: catalog.id,
          user_id: catalog.user_id,
          name: typeof catalog.name === 'string' && text(catalog.name, 1000) ? catalog.name : null,
        },
        source_hash: preview.source_hash,
        comparison_hash: fingerprint({
          scope,
          source_hash: preview.source_hash,
          items,
          requested_at,
          captured_at,
          ...(inspect ? {listed_inventory_hash: collected.inventory!.material_hash} : {}),
        }),
        requested_at,
        captured_at,
        item_count: items.length,
        summary,
        items,
        review_retailer_ids,
        network_requests: requests(),
        provider_mutations: 0,
        destructive_deletions: 0,
        ...(inspect
          ? {
              listed_inventory: {
                ...collected.inventory!,
                scope,
                source_hash: preview.source_hash,
                requested_at,
                captured_at,
                observations_hash: fingerprint({
                  scope,
                  source_hash: preview.source_hash,
                  material_hash: collected.inventory!.material_hash,
                  requested_at,
                  captured_at,
                }),
              },
            }
          : {}),
        meaning: inspect
          ? 'Products outside this supplied selection are retained. Their store absence is unverified. X listing can hide other variants, so this is not a complete variant inventory or a point-in-time snapshot.'
          : 'Current evidence for supplied X product IDs only, using repeated bounded native reads and exact supported decimal prices. Grouped or potentially hidden variants are blocked. Missing fields stay unknown. This is sequential evidence, not a point-in-time inventory snapshot. Every saved product still requires a fresh native review and independent read-back; products outside the supplied source are not returned or deleted.',
      };
    },
  );
}
/**
 * Current evidence of explicitly selected listed X products (COM-02 B): `catalog_compare` with selection_source
 * listed_inventory and 1–50 native product_keys. Two complete scans must agree on the whole listing (its material hash,
 * as an inspection shows it) and on the selected products, bracketed by catalog ownership. A key that is not listed,
 * grouped or of unknown group status is returned blocked; nothing is selected because of a source's absence.
 */
export async function xCatalogListedSelection(
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  actor: Actor,
  input: JsonObject,
  keys: string[],
) {
  // The deletion contract of the first key authorizes the reads, exactly as a removal review would.
  const plan: CompiledRequest = {
    gateway: input.gateway,
    accountId: input.account_id,
    action: 'x_product_catalogs_product_catalog_id_products_delete',
    method: 'DELETE',
    path: '/12/product_catalogs/' + input.catalog_id + '/products',
    query: {},
    headers: {},
    body: {product_keys: [keys[0]]},
    readOnly: false,
    destructive: true,
    requiresConfirmation: true,
    evidence: 'Existing qualified X product contract',
    warnings: [],
  };
  assertXCatalogProduct(plan);
  return xCatalogSession(
    store,
    registry,
    transport,
    credentials,
    actor,
    input,
    plan,
    {product_keys: keys},
    async ({read, scope, requested_at, fetch, requests, close}) => {
      const catalog = ownedCatalog(await xCatalogOwners(read, fetch), input.catalog_id);
      const collect = async () => {
        const scan = await xCatalogProducts(read, fetch, input.catalog_id);
        if (!scan.complete)
          fail(
            'CATALOG_SCAN_LIMIT',
            'X comparison requires a complete catalog scan of at most 1,000 listed products. No product changes were submitted.',
            {},
            409,
          );
        const byKey = new Map(scan.rows.map(row => [row.product_key as string, row]));
        return {
          material_hash: catalogSelectionInventory(scan.rows, []).material_hash,
          listed: scan.rows.length,
          items: keys.map(key => {
            const row = byKey.get(key);
            if (!row)
              return {
                retailer_id: null,
                product_id: key,
                group_status: null,
                before: null,
                unsent_fields: [],
                blocked: true,
                blocked_reason: 'not_listed',
              };
            const grouping = xCatalogProductGrouping(row);
            return {
              retailer_id: row.id,
              product_id: key,
              group_status: grouping,
              before: rowView(row),
              unsent_fields: xCatalogHeldOptional(row),
              blocked: grouping !== 'individual',
              blocked_reason:
                grouping === 'individual' ? null : grouping === 'grouped' ? 'grouped_product' : 'group_status_unknown',
            };
          }),
        };
      };
      const collected = await collect(),
        repeated = await collect(),
        after = ownedCatalog(await xCatalogOwners(read, fetch), input.catalog_id);
      if (fingerprint(collected) !== fingerprint(repeated) || fingerprint(catalog) !== fingerprint(after))
        fail(
          'CATALOG_COMPARISON_CHANGED',
          'X listed catalog observations changed during collection. Read them again; no product changes were submitted.',
          {},
          409,
        );
      close();
      const captured_at = Date.now();
      return {
        record_kind: 'x_catalog_listed_selection',
        selection_source: 'listed_inventory',
        scope,
        complete: true,
        catalog: {
          id: catalog.id,
          user_id: catalog.user_id,
          name: typeof catalog.name === 'string' && text(catalog.name, 1000) ? catalog.name : null,
        },
        listed_inventory_hash: collected.material_hash,
        listed_product_count: collected.listed,
        source_absence_established: false,
        item_count: collected.items.length,
        items: collected.items,
        requested_at,
        captured_at,
        network_requests: requests(),
        provider_mutations: 0,
        destructive_deletions: 0,
        meaning:
          'Current evidence of explicitly selected listed X products only. Nothing is selected because it is absent from a source; products that are not listed, grouped or of unknown group status cannot be removed here. This is sequential evidence, not a point-in-time inventory snapshot.',
      };
    },
  );
}
