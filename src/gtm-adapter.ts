import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Google Tag Manager's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: a
 * folder's entity listing is a POST read. Readiness reads the selected Tag Manager account (CON-03).
 */
export const gtmHooks: ProviderHooks = Object.freeze({
  gateway: 'gtm_native_action',
  reads: Object.freeze({
    postRead: (_plan: CompiledRequest, pathname: string) => /\/folders\/[^/:]+:entities$/.test(pathname),
  }),
  accountRead: Object.freeze({
    readiness: (id: string, read: (path: string, origin: string) => CompiledRequest) =>
      read('/tagmanager/v2/accounts/' + id, 'https://tagmanager.googleapis.com'),
    names: (id: string, data: JsonObject) => String(data.accountId) === id,
  }),
});
