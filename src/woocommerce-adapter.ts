import type {ProviderHooks} from './provider-adapter.js';
import {deepFrozen} from './frozen-facts.js';

/**
 * WooCommerce's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts; the provider is parked, PRK-01).
 * AMCP reads WooCommerce products only as catalog sources (src/woocommerce-source.ts).
 */
export const woocommerceHooks: ProviderHooks = Object.freeze({
  gateway: 'commerce_native_action',
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
