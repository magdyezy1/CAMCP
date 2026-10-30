import type {ProviderHooks} from './provider-adapter.js';
import {providerOf} from './provider-adapters.js';
import {googleAdsHooks} from './google-ads-adapter.js';
import {googleBusinessHooks} from './google-business-adapter.js';
import {metaHooks} from './meta-adapter.js';
import {tiktokHooks} from './tiktok-adapter.js';
import {snapchatHooks} from './snapchat-adapter.js';
import {linkedinHooks} from './linkedin-adapter.js';
import {xHooks} from './x-adapter.js';
import {microsoftHooks} from './microsoft-adapter.js';
import {appleHooks} from './apple-adapter.js';
import {redditHooks} from './reddit-adapter.js';
import {dv360Hooks} from './dv360-adapter.js';
import {ga4Hooks} from './ga4-adapter.js';
import {gtmHooks} from './gtm-adapter.js';
import {searchConsoleHooks} from './google-search-console-adapter.js';
import {criteoHooks} from './criteo-adapter.js';
import {adjustHooks} from './adjust-adapter.js';
import {amazonHooks} from './amazon-adapter.js';
// Wave 4c round 6 (w4c-arc6-tables): WooCommerce's rows of the shared tables.
import {woocommerceHooks} from './woocommerce-adapter.js';
import type {ProviderJobFacts} from './provider-adapter.js';

/**
 * The provider hooks registry (ARC-01 phase B): each provider's behaviour that needs its own modules, from its adapter
 * module (src/<provider>-adapter.ts), by gateway. The leaf registry (src/provider-adapters.ts) holds the facts any
 * module may read; these hooks call provider modules, so the shared modules above them consult this registry instead
 * of importing those modules, and no provider module imports it (that would be an import cycle; the architecture
 * ratchet, tools/architecture-map.mjs, counts this registry with the providers). A hook only supplies a provider fact
 * to the shared stage that asks for it: the stage keeps every rule and decides.
 */
export const registeredProviderHooks: readonly ProviderHooks[] = Object.freeze([
  googleAdsHooks,
  googleBusinessHooks,
  metaHooks,
  tiktokHooks,
  snapchatHooks,
  linkedinHooks,
  xHooks,
  microsoftHooks,
  appleHooks,
  redditHooks,
  dv360Hooks,
  ga4Hooks,
  gtmHooks,
  searchConsoleHooks,
  criteoHooks,
  adjustHooks,
  amazonHooks,
  woocommerceHooks,
]);

const byGateway = new Map<string, ProviderHooks>(),
  authorizerNames = new Set<string>();
for (const hooks of registeredProviderHooks) {
  // A load-time check, like a family declaration's: hooks belong to exactly one provider adapter.
  if (!providerOf(hooks.gateway)) throw new Error('Provider hooks name no provider adapter: ' + hooks.gateway + '.');
  if (byGateway.has(hooks.gateway)) throw new Error('Two provider hooks name ' + hooks.gateway + '.');
  // A readiness read of a provider's own is accepted only when its response names exactly the selected resource.
  if (!hooks.accountRead?.readiness !== !hooks.accountRead?.names)
    throw new Error('Provider hooks of ' + hooks.gateway + ' declare a readiness read without its identity check.');
  // Read authorizers are named once, frozen, and consulted at one of ScopeGuard's two stages.
  for (const authorizer of hooks.scope?.authorizers ?? [])
    if (
      !Object.isFrozen(authorizer) ||
      !['before_families', 'after_families'].includes(authorizer.stage) ||
      authorizerNames.has(authorizer.name)
    )
      throw new Error(
        'Read authorizer ' + authorizer.name + ' of ' + hooks.gateway + ' is not one frozen, staged name.',
      );
    else authorizerNames.add(authorizer.name);
  byGateway.set(hooks.gateway, hooks);
}

/** The hooks of a gateway's provider, or undefined for AMCP's own tools, unknown names and providers without hooks. */
export function providerHooks(gateway: unknown): ProviderHooks | undefined {
  return typeof gateway === 'string' ? byGateway.get(gateway) : undefined;
}

// Wave 4c round 6 (w4c-arc6-tables): the order in which each shared table lists its providers' rows, by provider ID
// (src/provider-adapters.ts). A load-time check, like the grant order's: an order names every hooks entry that declares
// the table's rows exactly once, and no other.
function tableOrder(table: string, ids: readonly string[], declares: (hooks: ProviderHooks) => unknown) {
  const listed = ids.map(id => registeredProviderHooks.find(hooks => providerOf(hooks.gateway)?.id === id));
  if (
    new Set(ids).size !== ids.length ||
    listed.some(hooks => !hooks || !declares(hooks)) ||
    registeredProviderHooks.filter(hooks => declares(hooks)).length !== ids.length
  )
    throw new Error(
      'The ' + table + ' order must name every provider hooks entry that declares its rows exactly once.',
    );
  return Object.freeze(listed as ProviderHooks[]);
}
/** src/unavailable-operations.ts: after AMCP's own, each provider's connection operation and then its own rows. */
export const unavailableOperationProviders: readonly ProviderHooks[] = tableOrder(
  'unavailable operation',
  ['adjust', 'woocommerce', 'ga4', 'gsc', 'google_business'],
  hooks => hooks.connection || hooks.unavailable,
);
/** src/discovery-programs.ts. */
export const discoveryProgramProviders: readonly ProviderHooks[] = tableOrder(
  'discovery program',
  ['linkedin', 'x', 'dv360'],
  hooks => hooks.programs,
);
/** src/parameters.ts accountAliases, whose key order the workbook selectors' SQL shows. */
export const accountAliasProviders: readonly ProviderHooks[] = tableOrder(
  'account alias',
  ['meta', 'tiktok', 'snapchat', 'google', 'linkedin', 'x', 'amazon', 'apple', 'dv360', 'reddit'],
  hooks => hooks.parameters?.accountAliases,
);
/** src/parameters.ts encodedBodyGateways. */
export const encodedBodyProviders: readonly ProviderHooks[] = tableOrder(
  'encoded body',
  ['dv360', 'linkedin', 'x'],
  hooks => hooks.parameters?.encodedBody,
);
/**
 * src/provider-jobs.ts providerJobContracts, whose rows follow the job families' order (a provider's families need not
 * be adjacent): each family with the hooks entry that declares it. Checked at load like the provider orders.
 */
const jobFamilyOrder = [
  'x_report_jobs',
  'tiktok_report_jobs',
  'meta_insights_jobs',
  'dv360_sdf_downloads',
  'criteo_report_jobs',
  'tiktok_change_log_tasks',
  'ga4_export_jobs',
  'microsoft_reporting_pipeline',
];
export const providerJobFamilies: readonly {readonly hooks: ProviderHooks; readonly job: ProviderJobFacts}[] = (() => {
  const declared = registeredProviderHooks.flatMap(hooks => (hooks.jobs ?? []).map(job => ({hooks, job})));
  const listed = jobFamilyOrder.map(family => declared.find(entry => entry.job.family === family));
  if (
    new Set(jobFamilyOrder).size !== jobFamilyOrder.length ||
    listed.some(entry => !entry) ||
    declared.length !== jobFamilyOrder.length
  )
    throw new Error('The provider job order must name every job family the provider hooks declare exactly once.');
  return Object.freeze(listed.map(entry => Object.freeze(entry!)));
})();
