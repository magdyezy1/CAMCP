import type {
  DelegatedAccount,
  DelegatedHooks,
  DelegatedScopeContext,
  ProviderHooks,
  ScopeContext,
} from './provider-adapter.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {errorObject} from './provider-error-core.js';
import type {ProviderErrorClass, ProviderErrorContext, ProviderErrorInput} from './provider-error-taxonomy.js';
import {authorizePlaceActionDiscovery, placeActionReadKind} from './google-place-action-discovery.js';
import {extendGoogleBusinessTool} from './google-business-extensions.js';

/**
 * Wave 4c (transport and catalog): Business Profile's part of the delegated compiler (src/delegated-native.ts). Its
 * location and lodging reads need an explicit read mask; a request inside the account may be scoped by a location,
 * and the place-action type metadata by exactly one account or one location, the location given as its filter.
 */
const businessDelegated: DelegatedHooks = Object.freeze({
  // These discovery query descriptions and current provider docs require an explicit field selection.
  // Discovery omits the required flag; do not default to all fields or change other routes.
  requiredQuery(operation: string, action: string, key: string) {
    if (
      key !== 'readMask' ||
      !(
        (operation === 'gmb_location_ops' && action === 'GET_LOCATION') ||
        (operation === 'gmb_lodging_ops' && action === 'GET_LODGING')
      )
    )
      return undefined;
    return (value: unknown) => {
      if (typeof value === 'string' && !value.trim())
        throw new MirrorError('INVALID_PARAMETER', 'Choose an explicit nonempty readMask for this resource.', {
          parameter: key,
        });
    };
  },
  scope: Object.freeze({
    refine({route, args, path, query, resourceId}: DelegatedScopeContext, {account, id, match}: DelegatedAccount) {
      const location = resourceId(args.location_id, 'locations'),
        found = path.match(/\/locations\/([^/:]+)/);
      if (location && found && decodeURIComponent(found[1]!) !== location)
        throw new MirrorError(
          'ACCOUNT_SCOPE_MISMATCH',
          'The request resource belongs to a different location.',
          {},
          403,
        );
      if (route.operation === 'gmb_engagement_ops' && route.action === 'LIST_PLACE_ACTION_TYPE_METADATA') {
        if (
          args.location_id !== undefined &&
          (typeof args.location_id !== 'string' || !/^(?:locations\/)?[1-9][0-9]*$/.test(args.location_id))
        )
          throw new MirrorError('INVALID_RESOURCE_NAME', 'Use the exact numeric location ID or locations/{id}.');
        if (account !== undefined && (typeof account !== 'string' || !/^(?:accounts\/)?[1-9][0-9]*$/.test(account)))
          throw new MirrorError('INVALID_RESOURCE_NAME', 'Use the exact numeric account ID or accounts/{id}.');
        const filter =
          typeof query.filter === 'string' ? /^location=(locations\/[1-9][0-9]*)$/.exec(query.filter)?.[1] : undefined;
        if (filter && (id || (location && filter !== 'locations/' + location)))
          throw new MirrorError(
            'ACCOUNT_SCOPE_MISMATCH',
            'Use the exact selected location for location-filtered metadata; do not substitute a broader account.',
            {},
            403,
          );
        if (location && id)
          throw new MirrorError(
            'ACCOUNT_SCOPE_MISMATCH',
            'Choose an account or a location context, not both.',
            {},
            403,
          );
        if (location && query.filter === undefined) query.filter = 'location=locations/' + location;
        return location ? 'locations/' + location : (filter ?? id);
      }
      return (
        id ??
        (match ? decodeURIComponent(match[1]!) : undefined) ??
        (found ? 'locations/' + decodeURIComponent(found[1]!) : undefined)
      );
    },
  }),
});

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
  // Wave 4c (transport and catalog): its tool takes the operations AMCP adds to the captured definition.
  catalog: Object.freeze({tools: Object.freeze({google_business_native_action: extendGoogleBusinessTool})}),
  delegated: businessDelegated,
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
});
