import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

/**
 * One synthetic Meta login bound to `accounts`, a synthetic Graph API and the real service (r25-fr-meta-reads). `answer(url, init)`
 * returns the Response of the synthetic API (an empty page by default); every request that reaches it is recorded in `requests`,
 * so a refusal that must send nothing says so by `requests.length === 0`. Synthetic IDs only.
 */
export const registry = new Registry();
export const actor = {tenantId: 'meta-reads', userId: 'operator', role: 'operator'};
export const login = 'cccccccc-9999-4999-8999-000000000001';

export function metaService(t, {accounts = ['123', '124'], answer, scopes = ['ads_management']} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64')),
    requests = [];
  t.after(() => store.close());
  store.putConnection(
    {...actor, userId: 'admin', role: 'admin'},
    {
      id: login,
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts,
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic Meta',
      scopes,
    },
    {accessToken: 'synthetic'},
  );
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(
      async (input, init) => {
        const url = new URL(String(input));
        requests.push({method: init?.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams)});
        return answer ? answer(url, init) : Response.json({data: []});
      },
      async () => {},
    ),
    undefined,
    {allowWrites: false},
  );
  return {
    store,
    service,
    requests,
    call: input => service.call('meta_native_action', input, actor),
    callTool: (tool, input) => service.call(tool, input, actor),
  };
}
