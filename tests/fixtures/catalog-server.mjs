import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

/**
 * The real AMCP catalog workspace behind a website test (COM-03): mapping profiles, server-projected CSV sources,
 * previews and saved plans, for the accounts the website fixture offers (Meta meta-login/001, X x/acct1). It makes no
 * provider request; a test that needs provider reads uses its destination's own fixture.
 */
export function catalogServer({tenant = 'synthetic-website-catalog'} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 41).toString('base64')),
    actor = {tenantId: tenant, userId: 'operator', role: 'operator'},
    admin = {...actor, role: 'admin'};
  store.putConnection(
    admin,
    {
      id: 'meta-login',
      tenantId: tenant,
      gateway: 'meta_native_action',
      accounts: ['001'],
      writeAccounts: ['001'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: [],
    },
    {accessToken: 'synthetic-meta-token'},
  );
  store.putConnection(
    admin,
    {
      id: 'x',
      tenantId: tenant,
      gateway: 'x_ads_native_action',
      accounts: ['acct1'],
      writeAccounts: ['acct1'],
      enabled: true,
      label: 'Synthetic X',
      scopes: [],
    },
    {
      accessToken: 'synthetic-token',
      consumerKey: 'synthetic-key',
      consumerSecret: 'synthetic-secret',
      tokenSecret: 'synthetic-token-secret',
    },
  );
  const transport = new NativeTransport(
    async () => {
      throw Error('A website catalog test made a provider request.');
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  return {
    store,
    service,
    actor,
    /** A website fixture responder: the workspace result, or the refusal the website would raise. */
    respond: async args => {
      const result = await service.call('amcp_workspace', args, actor);
      if (!result.success)
        throw Object.assign(Error(result.error.message), {code: result.error.code, details: result.error.details});
      return result.data;
    },
    close: () => store.close(),
  };
}
