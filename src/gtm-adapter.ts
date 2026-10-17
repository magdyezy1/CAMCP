import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest} from './types.js';

/**
 * Google Tag Manager's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: a
 * folder's entity listing is a POST read.
 */
export const gtmHooks: ProviderHooks = Object.freeze({
  gateway: 'gtm_native_action',
  reads: Object.freeze({
    postRead: (_plan: CompiledRequest, pathname: string) => /\/folders\/[^/:]+:entities$/.test(pathname),
  }),
});
