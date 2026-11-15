import {Registry} from '../../dist/src/catalog.js';
import {actionContracts} from '../../dist/src/action-contracts.js';
import {DelegatedNativeCompiler} from '../../dist/src/delegated-native.js';
import {registeredProviderHooks} from '../../dist/src/provider-hooks.js';
import {reviewedWriteFamily} from '../../dist/src/reviewed-routes.js';

/**
 * The write routes the review accepts, as the action ledger lists them (status reviewed_write_family: a registered family
 * or a provider's entity writes claims them), each with the sample request the ledger classified it by: the route's own
 * template with every path parameter given the shape its documented pattern allows (src/action-contracts.ts builds the
 * same). A request that no family claimed would not be reviewed, so the sample is what a review of the route sees.
 * `matches` is false for a row whose sample the registry claims for another family than the ledger names, which a test
 * reports instead of reading a request the review would never see.
 */
const concrete = (template, parameters = {}) =>
  template.replace(/\{\+?([^{}=]+)(?:=([^{}]+))?\}/g, (_m, key, pattern) => {
    const shape = pattern ?? parameters[key]?.pattern;
    return shape && shape !== '*'
      ? shape
          .replace(/^\^|\$/g, '')
          .replaceAll('[^/]+', '123')
          .replaceAll('[^/]*', '123')
          .replaceAll('**', '123')
          .replaceAll('*', '123')
      : '123';
  });

export function reviewedWriteRoutes(registry = new Registry()) {
  const vendor = new DelegatedNativeCompiler(),
    routes = [...vendor.data.routes, ...registeredProviderHooks.flatMap(h => h.delegated?.routes?.list() ?? [])];
  const out = [];
  for (const row of actionContracts(registry)) {
    if (row.status !== 'reviewed_write_family') continue;
    const route = row.operation
        ? routes.find(
            r => r.gateway === row.gateway && r.operation === row.operation && (r.action || r.operation) === row.action,
          )
        : undefined,
      absolute = row.path.startsWith('https://') ? new URL(concrete(row.path, route?.parameters)) : undefined,
      captured = registry.action(row.gateway, row.action),
      execution = captured?.canonical_name || captured?.name || row.action,
      plan = {
        gateway: row.gateway,
        action: row.operation ? row.operation + (execution !== row.operation ? '/' + execution : '') : execution,
        method: row.method,
        path: absolute?.pathname ?? concrete(row.path.split('?')[0], route?.parameters),
        origin: row.origin ?? absolute?.origin,
        query: Object.fromEntries(
          new URLSearchParams(
            (absolute?.search ?? row.path.split('?')[1] ?? '').replaceAll('{action}', 'initializeUpload'),
          ),
        ),
        body: {},
        headers: {},
        readOnly: false,
        destructive: row.method === 'DELETE',
        requiresConfirmation: false,
        accountId: '123',
        evidence: '',
        warnings: [],
        specialTransport: route?.unsupportedMedia?.length ? 'vendor_media' : captured?.raw?.special_transport,
      };
    out.push({row, plan, matches: reviewedWriteFamily(plan) === row.family});
  }
  return out;
}
