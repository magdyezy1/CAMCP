import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Business Profile's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the
 * Google location search and a location's verification options are POST reads, each on its own API origin. Readiness
 * (CON-06) reads a selected location with a fixed mask and a selected business account by itself (any other ID is no
 * resource it reads, which readiness refuses); a location is named by its title and an account by accountName (`name`
 * is the resource name).
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
  accountRead: Object.freeze({
    readiness(id: string, read: (path: string, origin: string) => CompiledRequest) {
      if (/^locations\/[1-9][0-9]{0,39}$/.test(id))
        return {
          ...read('/v1/' + id, 'https://mybusinessbusinessinformation.googleapis.com'),
          query: {readMask: 'name,title,storeCode'},
        };
      if (/^[1-9][0-9]{0,39}$/.test(id))
        return read('/v1/accounts/' + id, 'https://mybusinessaccountmanagement.googleapis.com');
      return undefined;
    },
    names: (id: string, data: JsonObject) => data.name === (id.startsWith('locations/') ? id : 'accounts/' + id),
    account(data: JsonObject) {
      const title = data.title ?? data.accountName;
      return typeof title === 'string' ? {name: title} : {};
    },
  }),
});
