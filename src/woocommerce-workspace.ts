import {assertGatewayOffered} from './provider-offering.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {validate} from './workspace-core.js';
import {wooCommerceSources} from './woocommerce-source.js';

/**
 * WooCommerce's parts of the workspace tool (ARC-01 phase B: branches of src/workspace.ts and src/workflow-outcomes.ts
 * until wave 4c; the provider workflows registry, src/provider-workflows.ts, registers them): the configured store
 * sources catalog_sources lists, and the website page of a complete store read.
 */
const gateway = 'commerce_native_action';

/** catalog_sources: the current configured store source connections' metadata, without credentials or network calls. */
export function wooCommerceSourceList(store: Store, actor: Actor, input: JsonObject) {
  validate(input, ['action']);
  // The store sources are WooCommerce's, which is parked (ARC-01, P9) unless AMCP_PROVIDERS names it.
  assertGatewayOffered(gateway);
  return wooCommerceSources(store, actor);
}

/**
 * The website page of a complete WooCommerce store read (MCP-09), which src/workflow-outcomes.ts asks for in its order:
 * a complete collected inventory reopens Commerce with its connection, account and price field, and complete selected
 * products or variations with their IDs as well. Undefined for any other record; an answer without a path for a
 * selected read whose connection or account cannot be linked.
 */
export function wooCommerceSourcePath(data: JsonObject): {readonly path?: string} | undefined {
  if (
    data.record_kind === 'catalog_source_inventory' &&
    data.state === 'complete' &&
    data.complete_collected_inventory === true &&
    data.scope?.gateway === gateway &&
    data.scope.source_kind === 'inventory' &&
    data.scope.absent_source_policy === 'retain' &&
    data.scope.api_version === 'wc/v3' &&
    data.scope.product_status === 'publish' &&
    data.scope.variation_status === 'any' &&
    ['price', 'regular_price', 'sale_price'].includes(data.scope.price_field) &&
    ['connection_id', 'account_id'].every(
      key => typeof data.scope[key] === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(data.scope[key]),
    )
  )
    return {
      path:
        '/commerce?woo_inventory=1&connection_id=' +
        encodeURIComponent(data.scope.connection_id) +
        '&account_id=' +
        encodeURIComponent(data.scope.account_id) +
        '&price_field=' +
        data.scope.price_field,
    };
  if (
    data.record_kind === 'catalog_source' &&
    data.scope?.gateway === gateway &&
    data.complete_selected_evidence === true &&
    Array.isArray(data.product_ids) &&
    data.product_ids.length >= 1 &&
    data.product_ids.length <= 50 &&
    data.product_ids.every((id: unknown) => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id)) &&
    new Set(data.product_ids).size === data.product_ids.length &&
    ['price', 'regular_price', 'sale_price'].includes(data.scope?.price_field)
  ) {
    const query = ['connection_id', 'account_id']
      .filter(key => typeof data.scope?.[key] === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(data.scope[key]))
      .map(key => key + '=' + encodeURIComponent(data.scope[key]));
    if (query.length !== 2) return {};
    return {
      path:
        '/commerce?woo_source=1&' +
        query.join('&') +
        '&product_ids=' +
        encodeURIComponent(data.product_ids.join(',')) +
        '&price_field=' +
        data.scope.price_field +
        (data.scope.source_kind === 'variations' && /^[1-9][0-9]{0,19}$/.test(data.scope.parent_product_id ?? '')
          ? '&source_kind=variations&parent_product_id=' + data.scope.parent_product_id
          : ''),
    };
  }
  return undefined;
}
