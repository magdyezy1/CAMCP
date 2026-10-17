import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest} from './types.js';

/**
 * Business Profile's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the
 * Google location search and a location's verification options are POST reads, each on its own API origin.
 */
export const googleBusinessHooks: ProviderHooks = Object.freeze({
  gateway: 'google_business_native_action',
  reads: Object.freeze({
    postRead: (plan: CompiledRequest, pathname: string) =>
      (plan.origin === 'https://mybusinessbusinessinformation.googleapis.com' &&
        pathname === '/v1/googleLocations:search') ||
      (plan.origin === 'https://mybusinessverifications.googleapis.com' &&
        /^\/v1\/locations\/[^/:]+:fetchVerificationOptions$/.test(pathname)),
  }),
});
