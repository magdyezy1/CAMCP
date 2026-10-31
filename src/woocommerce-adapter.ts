import type {ProviderHooks} from './provider-adapter.js';
import {deepFrozen} from './frozen-facts.js';

/**
 * WooCommerce's provider hooks (ARC-01; registered in src/provider-hooks.ts; the provider is parked by the owner, PRK-01
 * and P9). Its gateway is the Commerce gateway: what tools/list says of it and the store operation AMCP cannot run.
 * AMCP reads WooCommerce products only as catalog sources (src/woocommerce-source.ts).
 */
export const wooCommerceHooks: ProviderHooks = Object.freeze({
  gateway: 'commerce_native_action',
  // Wave 4c round 6 (w4c-arc6-versions): what tools/list and amcp_tool_help say of its gateway (src/tool-notes.ts).
  notes: Object.freeze({
    description:
      'Commerce gateway: woocommerce_list_stores lists the WooCommerce stores configured in AMCP, without a store request; store products are read through amcp_workspace catalog_sources and catalog_source. Shopify and Salla have no AMCP connection, and Shopify, Salla and WooCommerce expansion is parked.',
  }),
  // Wave 4c round 6 (w4c-arc6-tables): its rows of the shared tables (src/provider-hooks.ts orders them). The store
  // operation its captured catalog lists but AMCP cannot run (src/unavailable-operations.ts).
  unavailable: deepFrozen({
    woocommerce_store_ops: {
      reason:
        'AMCP reads WooCommerce products only as catalog sources; store reports, orders and customers are not read. Shopify and Salla have no connection, and WooCommerce expansion is parked.',
      alternatives: [
        {
          tool: 'amcp_workspace',
          arguments: {action: 'catalog_sources'},
          meaning: 'The WooCommerce stores configured as catalog sources.',
        },
        {
          tool: 'amcp_workspace',
          arguments: {action: 'catalog_source'},
          meaning: 'Read the products of one configured store.',
        },
      ],
    },
  }),
});
