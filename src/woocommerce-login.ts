import type {ProviderLogin} from './provider-login.js';
import type {Store} from './store.js';
import type {Actor} from './types.js';
import {wooCommerceSources} from './woocommerce-source.js';

/**
 * WooCommerce's website login steps (ARC-01 phase B; registered in src/provider-logins.ts with the keyed logins). A
 * WooCommerce login is a store connection an administrator sets up on Commerce with an existing Read key
 * (src/woocommerce-connection.ts, through the service), not a website OAuth platform; its steps list the store sources
 * Commerce shows: the workspace's qualified store connections, without credentials or store requests. They stay listed
 * while WooCommerce is parked, so an administrator can still remove one.
 */
export const wooCommerceLogin: ProviderLogin = Object.freeze({
  gateway: 'commerce_native_action',
  keyed: Object.freeze({sources: (store: Store, actor: Actor) => wooCommerceSources(store, actor).items}),
});
