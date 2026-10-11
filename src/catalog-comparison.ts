import {catalogIngestion} from './catalog-ingestion.js';
import {xCatalogComparison} from './x-catalog-comparison.js';
import {catalogInventoryRequested} from './x-catalog-selection-inventory.js';
import {assertMetaCatalogProduct, metaCatalogProductSnapshots, readMetaCatalogImport} from './meta-catalog-products.js';
import {metaPrefix} from './meta-version.js';
import {nativeAuthority} from './native-authority.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {ScopeGuard} from './scope.js';
import {bad, fingerprint, obj} from './workspace-core.js';
import {MirrorError} from './errors.js';
import {
  catalogDestination,
  catalogDestinations,
  catalogItemSchemaVersion,
  comparisonItemV2,
  comparisonSummary,
  type CatalogGateway,
} from './catalog-destinations.js';
import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import type {NativeTransport} from './transport.js';
import type {CredentialProvider} from './auth.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';

type Comparison = (
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  actor: Actor,
  input: JsonObject,
) => Promise<JsonObject>;
/** Each catalog destination's read-only comparison of supplied products with its current catalog (COM-03). */
const comparisons: Record<CatalogGateway, Comparison> = {
  meta_native_action: metaCatalogComparison,
  x_ads_native_action: xCatalogComparison,
};
export async function catalogComparison(
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  actor: Actor,
  input: JsonObject,
) {
  catalogInventoryRequested(input);
  // A gateway that is not a catalog destination keeps the Meta refusal it had before the destination contract.
  const destination = catalogDestination(input.gateway)?.gateway ?? 'meta_native_action';
  return comparisons[destination](store, registry, transport, credentials, actor, input);
}
/** Meta: reads only the supplied retailer IDs; Meta's own price_amount filter establishes price equality. */
async function metaCatalogComparison(
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  actor: Actor,
  input: JsonObject,
) {
  if (typeof input.catalog_id !== 'string' || !catalogDestinations.meta_native_action.catalogId.test(input.catalog_id))
    bad('Choose an exact positive numeric Meta product catalog ID.');
  const preview = catalogIngestion(input),
    plans: CompiledRequest[] = preview.plan.steps.map(step => ({
      gateway: input.gateway,
      accountId: input.account_id,
      action: step.arguments.action,
      method: 'POST',
      path: metaPrefix + input.catalog_id + '/products',
      query: {},
      headers: {},
      body: step.arguments.payload,
      readOnly: false,
      destructive: false,
      requiresConfirmation: true,
      evidence: 'Existing qualified Meta catalog product contract',
      warnings: [],
    }));
  plans.forEach(assertMetaCatalogProduct);
  const read = metaCatalogProductSnapshots(plans[0]!)[0]!,
    connection = store.resolveConnection(actor, input.gateway, input.account_id, input.connection_id);
  new ScopeGuard(registry, store).authorize(read, connection);
  const auth = await credentials.get(connection),
    current = store.resolveConnection(actor, input.gateway, input.account_id, connection.id),
    scope = {
      gateway: input.gateway,
      account_id: input.account_id,
      connection_id: connection.id,
      catalog_id: input.catalog_id,
    },
    budget = new ReportCollectionBudget(undefined, fingerprint({scope, source_hash: preview.source_hash}), () => {}, {
      requests: 180,
      rows: 150,
      bytes: 2 * 1024 * 1024,
      elapsed_ms: 60000,
    }),
    requested_at = Date.now();
  let network_requests = 0;
  try {
    return await budget.run(async () => {
      const result = await readMetaCatalogImport(
        read,
        plans.map(p => p.body as JsonObject),
        async page => {
          const access = nativeAuthority(store, registry, actor, page, current, auth);
          const response = await transport.request(page, access(), auth, undefined, {
            beforeAttempt: () => {
              access();
              network_requests++;
            },
          });
          access();
          budget.rows(
            'request-' + network_requests,
            obj(response.data) && Array.isArray(response.data.data) ? response.data.data.length : 0,
          );
          return response;
        },
      );
      nativeAuthority(store, registry, actor, read, current, auth)();
      budget.check();
      // The shared item v2 (COM-03): a blocked Meta product is an existing one under a create-only import.
      const items = result.items.map((item, i) =>
          comparisonItemV2(
            {...item, blocked_reason: item.blocked ? 'existing_product_create_only' : null},
            plans[i]!.body as JsonObject,
          ),
        ),
        {summary, review_retailer_ids} = comparisonSummary(items);
      const captured_at = Date.now();
      return {
        record_kind: 'catalog_comparison',
        item_schema_version: catalogItemSchemaVersion,
        scope,
        complete: true,
        catalog: result.state.catalog,
        source_hash: preview.source_hash,
        comparison_hash: fingerprint({scope, source_hash: preview.source_hash, items, requested_at, captured_at}),
        requested_at,
        captured_at,
        item_count: items.length,
        summary,
        items,
        review_retailer_ids,
        network_requests,
        provider_mutations: 0,
        destructive_deletions: 0,
        meaning:
          'Current evidence for the supplied retailer IDs only. Exact price equality uses Meta’s native filter; formatted prices are display text. Missing fields stay unknown. Each product and catalog ownership are checked again during collection, but this is not a point-in-time inventory snapshot. Saving a draft still requires a fresh native review before execution. Products outside the supplied import are not inspected or deleted.',
      };
    });
  } catch (error) {
    if (error instanceof MirrorError && error.code === 'REPORT_COLLECTION_LIMIT')
      throw new MirrorError(
        'CATALOG_COMPARISON_LIMIT',
        'Catalog comparison reached its collection limit. Compare fewer source products and read them again; no product changes were submitted.',
        {dimension: error.details.dimension, used: error.details.used, limit: error.details.limit},
        422,
      );
    throw error;
  } finally {
    budget.close();
  }
}
