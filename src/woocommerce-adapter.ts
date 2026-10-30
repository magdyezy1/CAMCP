import type {ProviderHooks} from './provider-adapter.js';

/**
 * WooCommerce's provider hooks (ARC-01; registered in src/provider-hooks.ts; the provider is parked by the owner, PRK-01
 * and P9). Its gateway is the Commerce gateway; its only hooks are what tools/list says of it.
 */
export const wooCommerceHooks: ProviderHooks = Object.freeze({
  gateway: 'commerce_native_action',
  // Wave 4c round 6 (w4c-arc6-versions): what tools/list and amcp_tool_help say of its gateway (src/tool-notes.ts).
  notes: Object.freeze({
    description:
      'Commerce gateway: woocommerce_list_stores lists the WooCommerce stores configured in AMCP, without a store request; store products are read through amcp_workspace catalog_sources and catalog_source. Shopify and Salla have no AMCP connection, and Shopify, Salla and WooCommerce expansion is parked.',
  }),
});
