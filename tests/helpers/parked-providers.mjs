/**
 * Offers parked providers to this test process (ARC-01, P9). A parked provider (src/provider-adapters.ts) is offered
 * only where AMCP_PROVIDERS names it; its code keeps compiling and its tests keep running by naming it here. The
 * names are added to any the environment already sets, and child processes inherit them.
 */
export function offerParkedProviders(...ids) {
  const named = new Set((process.env.AMCP_PROVIDERS ?? '').split(/[\s,]+/).filter(Boolean));
  for (const id of ids) named.add(id);
  process.env.AMCP_PROVIDERS = [...named].join(',');
}

/**
 * The parked providers by the ID AMCP_PROVIDERS names, with the gateway each one offers: Amazon Ads, parked as
 * unimplemented (CON-06), and Criteo and WooCommerce, parked by the owner (ARC-01, P9). The table is the tests' own,
 * not the registry's, so a provider parked or offered by mistake fails the tests that count tools.
 */
export const parkedGateways = Object.freeze({
  amazon: 'amazon_native_action',
  criteo: 'criteo_native_action',
  woocommerce: 'commerce_native_action',
});

/** The parked gateways this process offers: those whose provider AMCP_PROVIDERS names. */
export function offeredParkedGateways(env = process.env) {
  const named = new Set((env.AMCP_PROVIDERS ?? '').split(/[\s,]+/).filter(Boolean));
  return Object.entries(parkedGateways)
    .filter(([id]) => named.has(id))
    .map(([, gateway]) => gateway);
}

/**
 * How many tools tools/list shows in this process: the 25 of a deployment that sets no AMCP_PROVIDERS (a read-only
 * one lists amcp_write with inspect only: owner decision D15, MCP-09) and each parked gateway AMCP_PROVIDERS offers.
 * The whole suite also runs with AMCP_PROVIDERS=criteo,woocommerce (ARC-01 acceptance), where it is 27.
 */
export function listedToolCount(env = process.env) {
  return 25 + offeredParkedGateways(env).length;
}

/**
 * Unsets AMCP_PROVIDERS for the rest of test `t` and restores it when the test ends, for a test that asserts the
 * offering of a deployment that sets none, whatever AMCP_PROVIDERS the suite runs with.
 */
export function withoutParkedProviders(t) {
  const previous = process.env.AMCP_PROVIDERS;
  delete process.env.AMCP_PROVIDERS;
  t.after(() => {
    if (previous === undefined) delete process.env.AMCP_PROVIDERS;
    else process.env.AMCP_PROVIDERS = previous;
  });
}
