import {Registry} from '../../dist/src/catalog.js';
import {Store} from '../../dist/src/store.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

/**
 * A synthetic workspace for the plan-shape tests of amcp_campaign create (Round 2.5, package r25-m0-review, T4): one
 * connection, one account, a service that refuses every provider request (nothing here is sent anywhere), and the
 * helpers those tests share. Every value is synthetic.
 */
export const CONNECTION = '22222222-2222-4222-8222-222222222222';
export const operator = {tenantId: 'synthetic-steps', userId: 'operator', role: 'operator'};
export const admin = {...operator, role: 'admin'};
const registry = new Registry();

export function harness(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 52).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    admin,
    {
      id: CONNECTION,
      tenantId: operator.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic login',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  let requests = 0;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async () => {
      requests++;
      throw new Error('Provider egress is forbidden in plan-shape tests');
    }),
    {mode: 'strict', flags: {}},
    {allowWrites: true},
  );
  return {
    service,
    requests: () => requests,
    call: (args, actor = operator) => service.call('amcp_campaign', args, actor),
  };
}
/** A valid step of a plan, each field as create takes it. */
export const step = (id = 'campaign', extra = {}) => ({
  id,
  kind: 'write',
  gateway: 'meta_native_action',
  connection_id: CONNECTION,
  account_id: '123',
  arguments: {action: 'meta_campaign_create', payload: {name: 'Synthetic campaign', status: 'PAUSED'}},
  ...extra,
});
