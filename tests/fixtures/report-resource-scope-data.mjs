import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {ReportingService} from '../../dist/src/reporting.js';

export const resourceScopeConnections = {
  ga4_native_action: '44444444-4444-4444-8444-444444444444',
  google_search_console_native_action: '55555555-5555-4555-8555-555555555555',
};
export function ga4ResourceConfig(selector = {property: 'properties/100'}) {
  return {
    gateway: 'ga4_native_action',
    arguments: {
      operation: 'ga4_run_report',
      arguments: {
        connection_id: resourceScopeConnections.ga4_native_action,
        ...selector,
        request: {dateRanges: [{startDate: '2026-09-01', endDate: '2026-09-02'}], metrics: [{name: 'sessions'}]},
      },
    },
  };
}
export function gscResourceConfig(selector = {site_url: 'sc-domain:example.com'}) {
  return {
    gateway: 'google_search_console_native_action',
    arguments: {
      operation: 'gsc_analytics_ops',
      arguments: {
        action: 'QUERY_SEARCH_ANALYTICS',
        connection_id: resourceScopeConnections.google_search_console_native_action,
        ...selector,
        payload: {startDate: '2026-09-01', endDate: '2026-09-02'},
      },
    },
  };
}
/** Synthetic retained definitions/results only; native HTTP is forbidden. */
export function resourceScopeFixture(options = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 102).toString('base64')),
    identity = {tenantId: 'resource-scope', userId: 'operator', role: options.role ?? 'operator'},
    key = store.createKey(identity),
    actor = store.authenticate(key),
    admin = {...actor, role: 'admin'};
  for (const [gateway, id] of Object.entries(resourceScopeConnections))
    store.putConnection(
      admin,
      {
        id,
        tenantId: actor.tenantId,
        gateway,
        accounts: gateway === 'ga4_native_action' ? ['100'] : ['sc-domain:example.com', 'https://example.com/'],
        writeAccounts: [],
        enabled: true,
        label: gateway === 'ga4_native_action' ? 'Synthetic GA4' : 'Synthetic Search Console',
        scopes:
          gateway === 'ga4_native_action'
            ? ['https://www.googleapis.com/auth/analytics.readonly']
            : ['https://www.googleapis.com/auth/webmasters.readonly'],
      },
      {accessToken: 'synthetic'},
    );
  let attempts = 0;
  const fetcher = async () => {
      attempts++;
      throw Error('Native egress is forbidden in this metadata fixture');
    },
    service = new MirrorService(new Registry(), store, new NativeTransport(fetcher), undefined, {allowWrites: false}),
    reporting = new ReportingService(store);
  return {store, key, actor, admin, service, reporting, fetcher, attempts: () => attempts};
}
