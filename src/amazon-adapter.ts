import type {ProviderHooks, WireHeaders} from './provider-adapter.js';
import {MirrorError} from './errors.js';

/**
 * Amazon Ads' provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts; the provider is parked as
 * unimplemented, CON-06). Its only code is request routing: every request names the client and, for a selected
 * profile, its scope.
 */
export const amazonHooks: ProviderHooks = Object.freeze({
  gateway: 'amazon_native_action',
  // The mandatory profile scope header (below) confines every request to the selected account.
  scope: Object.freeze({resource: () => true}),
  wire: Object.freeze({
    headers({plan, credentials, headers}: WireHeaders) {
      if (!credentials.clientId) throw new MirrorError('CLIENT_ID_REQUIRED', 'Amazon Ads requires a client ID.');
      headers['Amazon-Advertising-API-ClientId'] = credentials.clientId;
      if (plan.accountId) headers['Amazon-Advertising-API-Scope'] = plan.accountId;
    },
  }),
  // Wave 4c round 6 (w4c-arc6-tables): its rows of the shared tables (src/provider-hooks.ts orders them). Its account
  // alias (src/parameters.ts).
  parameters: Object.freeze({accountAliases: Object.freeze(['profile_id'])}),
});
