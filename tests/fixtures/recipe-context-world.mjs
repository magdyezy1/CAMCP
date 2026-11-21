// A synthetic workspace for the tests of recipe_context's scope (R2.5 field3, package r25-field3-recipes, AMCP-06): two logins of each
// advertising platform, the first with two accounts and the second with one, each account with a name, a currency and a time zone that only
// its own client should see, Pages on the Meta logins and two Drive logins with file IDs. Every value is synthetic: Google customers are
// 123, 456 and 789, and no name or ID here belongs to a client.
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {providerById} from '../../dist/src/provider-adapters.js';

export const tenant = 'recipe-scope',
  admin = {tenantId: tenant, userId: 'admin', role: 'admin'},
  operator = {tenantId: tenant, userId: 'operator', role: 'operator'};
/** The one recipe each platform is tested with, and the logins and accounts of that platform. */
export const platforms = {
  google: {
    recipe: 'google_search',
    gateway: 'google_ads_native_action',
    logins: [
      ['c1', ['123', '456']],
      ['c2', ['789']],
    ],
  },
  meta: {
    recipe: 'meta_website_traffic',
    gateway: 'meta_native_action',
    logins: [
      ['m1', ['1110', '2220']],
      ['m2', ['3330']],
    ],
  },
  tiktok: {
    recipe: 'tiktok_website_traffic',
    gateway: 'tiktok_native_action',
    logins: [
      ['t1', ['7110000001', '7110000002']],
      ['t2', ['7220000001']],
    ],
  },
  snapchat: {
    recipe: 'snapchat_website_traffic',
    gateway: 'snapchat_native_action',
    logins: [
      ['s1', ['snap-a1', 'snap-a2']],
      ['s2', ['snap-b1']],
    ],
  },
  linkedin: {
    recipe: 'linkedin_lead_generation',
    gateway: 'linkedin_native_action',
    logins: [
      ['l1', ['5551', '5552']],
      ['l2', ['5553']],
    ],
  },
  microsoft: {
    recipe: 'microsoft_search',
    gateway: 'microsoft_ads_native_action',
    logins: [
      ['ms1', ['4401', '4402']],
      ['ms2', ['4403']],
    ],
  },
};
/** The name a client's account has in its login's last discovery: a marker of the client it belongs to, so a leak is visible. */
export const accountName = (login, account) => 'Client ' + login + ' ' + account + ' shop';
const drives = [
  ['d1', ['drive-file-one', 'drive-file-two']],
  ['d2', ['drive-file-three']],
];

/**
 * The workspace, its service and a call of amcp_campaign as `who`. `profile` adds the client playbook `playbook`: true binds it to the first
 * Google account (login c1, customer 123); a list of [login, account] pairs binds it to those Google accounts.
 */
export function recipeScopeWorld({profile = false} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 97).toString('base64'));
  const driveGateway = providerById('drive')?.gateway;
  const put = (id, gateway, accounts) =>
    store.putConnection(
      admin,
      {
        id,
        tenantId: tenant,
        gateway,
        accounts,
        writeAccounts: [accounts[0]],
        enabled: true,
        label: id + ' login',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
  for (const {gateway, logins} of Object.values(platforms))
    for (const [id, accounts] of logins) put(id, gateway, accounts);
  for (const [id, files] of drives) put(id, driveGateway, files);
  // What each login's last discovery listed: the name, currency and time zone of each account, and the Pages of the Meta logins.
  for (const {logins} of Object.values(platforms))
    for (const [id, accounts] of logins)
      store.putDocument(tenant, 'website_assets', id, {
        groups: [
          {
            kind: 'ad_accounts',
            complete: true,
            checkedAt: 1700000000000,
            assets: accounts.map(a => ({
              id: a,
              kind: 'ad_accounts',
              name: accountName(id, a),
              currency: 'USD',
              timezone: 'Africa/Cairo',
              source: 'vendor',
            })),
          },
          ...(id.startsWith('m')
            ? [{kind: 'pages', complete: true, assets: [{id: 'page-of-' + id, kind: 'pages', name: 'Page of ' + id}]}]
            : []),
        ],
        selected: [],
        lastSync: 1700000000000,
      });
  if (profile)
    store.putDocument(tenant, 'client_profile', 'playbook', {
      name: 'Client one',
      approved_by: admin.userId,
      bindings: (profile === true ? [['c1', '123']] : profile).map(([connection_id, account_id]) => ({
        gateway: platforms.google.gateway,
        connection_id,
        account_id,
      })),
    });
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('No provider call while reading a recipe');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = (input, who = operator) => service.call('amcp_campaign', input, who);
  return {store, service, call};
}
