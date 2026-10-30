import type {ProviderHooks, ScopeContext} from './provider-adapter.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import {errorObject} from './provider-error-core.js';
import type {ProviderErrorClass, ProviderErrorContext, ProviderErrorInput} from './provider-error-taxonomy.js';
import {authorizePlaceActionDiscovery, placeActionReadKind} from './google-place-action-discovery.js';
// Writes and campaigns (wave 4c).
import {placeActionSafe} from './google-place-action-links.js';
import {assertBusinessAccessPolicy} from './google-business-access.js';

/**
 * Business Profile's resource scope, after the account path: a business account's path names it, and a location's
 * path names a location the selected location grant is.
 */
function businessResourceScope(_plan: CompiledRequest, _c: Connection, id: string, {decoded, compare}: ScopeContext) {
  const account = /\/accounts\/([^/:]+)/.exec(decoded)?.[1];
  if (account) {
    compare(account, 'path');
    return true;
  }
  const location = /\/locations\/([^/:]+)/.exec(decoded)?.[1];
  if (location && id.startsWith('locations/')) {
    compare('locations/' + location, 'path');
    return true;
  }
  return false;
}

/**
 * Business Profile's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the
 * Google location search and a location's verification options are POST reads, each on its own API origin. Readiness
 * (CON-06) reads a selected location with a fixed mask and a selected business account by itself (any other ID is no
 * resource it reads, which readiness refuses); a location is named by its title and an account by accountName (`name`
 * is the resource name).
 */
export const googleBusinessHooks: ProviderHooks = Object.freeze({
  gateway: 'google_business_native_action',
  scope: Object.freeze({
    authorizers: Object.freeze([
      Object.freeze({
        name: 'google_business_place_action_discovery',
        stage: 'before_families' as const,
        claims: (p: CompiledRequest) => !!placeActionReadKind(p),
        authorize: authorizePlaceActionDiscovery,
      }),
    ]),
    resource: businessResourceScope,
  }),
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
  wire: Object.freeze({
    // A business asset sync read carries the sync's deadline.
    deadline: (plan: CompiledRequest) =>
      plan.action === 'AMCP_BUSINESS_ASSET_SYNC' && plan.readOnly && plan.method === 'GET'
        ? plan.measurementSyncDeadline
        : undefined,
    // Google answers a Cloud project it has not approved for the Business Profile APIs with a quota of 0 requests per
    // minute (google.rpc.ErrorInfo metadata quota_limit_value "0"), and one without the APIs enabled with
    // SERVICE_DISABLED (developers.google.com/my-business/content/prereqs, read 2026-10-08). Retrying or reconnecting
    // cannot help; the deployment owner must act (CON-06).
    errors: Object.freeze({
      classify(input: ProviderErrorInput, {base}: ProviderErrorContext): ProviderErrorClass | undefined {
        const {status} = input;
        if (input.inBody || ![403, 429].includes(status)) return undefined;
        const error = errorObject(errorObject(input.body).error);
        for (const detail of Array.isArray(error.details) ? error.details.slice(0, 10) : []) {
          const d = errorObject(detail),
            quota = errorObject(d.metadata).quota_limit_value;
          if ((status === 429 && quota === '0') || (status === 403 && d.reason === 'SERVICE_DISABLED'))
            return {
              ...base,
              code: 'BUSINESS_PROFILE_API_NOT_APPROVED',
              layer: 'app_eligibility',
              retryable: false,
              providerCode: status === 429 ? 'RESOURCE_EXHAUSTED' : 'SERVICE_DISABLED',
              documented: true,
            };
        }
        return undefined;
      },
    }),
  }),
  // Writes and campaigns (wave 4c): a review shows and returns a place action's request with its links made safe
  // (src/write-review.ts).
  writes: Object.freeze({
    shownRequest: placeActionSafe,
    // A place action link is live for everyone once written (src/write-effects.ts).
    publishesLive: (plan: CompiledRequest) =>
      ['POST', 'PATCH'].includes(plan.method) && /\/placeActionLinks(?:\/[^/]+)?$/.test(plan.path),
    // The owner's spending policy (src/spend-policy.ts): its switches over the administrator access a write grants.
    accessPolicy: assertBusinessAccessPolicy,
  }),
});
