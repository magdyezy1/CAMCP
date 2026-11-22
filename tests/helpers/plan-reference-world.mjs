// A plan preflight over synthetic logins of several providers, for the tests of package r25-field3-refs (the owner's second Google
// report of 2026-11-21, AMCP-01 and AMCP-02). It is the real MirrorService with one stored login for each provider it is given and a
// transport that refuses every request, so nothing leaves the process. The accounts' own reads are answered as "this provider has no
// exact account read" (READINESS_CONTRACT_UNAVAILABLE), which the preflight accepts as it does for a provider that has none: what the
// tests look at is how each step's contract is checked once its references to earlier steps have stand-ins. Every value is invented.
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {MirrorError} from '../../dist/src/errors.js';
import {campaignPreflight} from '../../dist/src/campaign-preflight.js';

/** The synthetic accounts: the provider's gateway, its account and the scopes its login records. */
export const accounts = {
  microsoft_ads_native_action: {account: '123', scopes: ['https://ads.microsoft.com/msads.manage']},
  tiktok_native_action: {account: '123', scopes: []},
  linkedin_native_action: {account: '123', scopes: ['rw_ads']},
  snapchat_native_action: {account: 'acct1', scopes: ['snapchat-marketing-api']},
  x_ads_native_action: {account: 'abc12', scopes: []},
};
let tenants = 0;

/** A write step as a saved plan holds it. */
export const step = (gateway, id, args, depends_on = []) => ({
  id,
  kind: 'write',
  gateway,
  connection_id: gateway.split('_')[0],
  account_id: accounts[gateway].account,
  description: id,
  arguments: args,
  depends_on,
});

export function world(gateways = Object.keys(accounts)) {
  const tenant = 'plan-reference-' + ++tenants,
    actor = {tenantId: tenant, userId: 'operator', role: 'operator'},
    owner = {...actor, userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 94).toString('base64'));
  for (const gateway of gateways)
    store.putConnection(
      owner,
      {
        id: gateway.split('_')[0],
        tenantId: tenant,
        gateway,
        accounts: [accounts[gateway].account],
        writeAccounts: [accounts[gateway].account],
        enabled: true,
        label: 'Synthetic ' + gateway,
        scopes: accounts[gateway].scopes,
      },
      {accessToken: 'synthetic'},
    );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw new Error('Synthetic world: no request may leave the process.');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  service.runPlan = async () => {
    throw new MirrorError('READINESS_CONTRACT_UNAVAILABLE', 'The synthetic world has no account read.');
  };
  return {
    service,
    actor,
    store,
    /** The preflight of these steps, as the plan runner makes it. */
    preflight: steps => campaignPreflight(service, actor, steps),
    close: () => store.close(),
  };
}

/** The check a preflight made of one step. */
export const checkOf = (out, id) => out.checks.find(c => c.step === id);
