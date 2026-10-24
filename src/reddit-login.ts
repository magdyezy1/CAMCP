import type {DiscoveryContext, DiscoveryParents, ProviderLogin} from './provider-login.js';
import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';

/**
 * Reddit's website login steps (ARC-01 phase B; registered in src/provider-logins.ts). Discovery: the ad accounts of
 * each business the login reaches, whose next links may change only their cursor. Reddit's list-by-business
 * intentionally omits ad accounts shared into a business, which a complete listing says.
 */
const redditParents: DiscoveryParents = Object.freeze({
  parents: () => ({path: '/api/v3/me/businesses', query: {}, extract: (d: JsonObject) => d.data}),
  parentId: (parent: JsonObject) => String(parent.id ?? ''),
  parentPattern: /^[A-Za-z0-9_-]{1,100}$/,
  accounts: (id: string) => ({
    path: '/api/v3/businesses/' + id + '/ad_accounts',
    query: {},
    extract: (d: JsonObject) => d.data,
  }),
  accountId: (row: JsonObject) => row.id,
  accountParent: (row: JsonObject) => row.business_id,
  accountPattern: /^a2_[A-Za-z0-9]+$/,
  fields: (row: JsonObject) => ({name: row.name, currency: row.currency, timezone: row.timezone, status: row.status}),
  coverage: () => [
    {
      code: 'DISCOVERY_COVERAGE',
      message:
        'Owned business ad accounts discovered. Reddit does not return shared-in accounts from this endpoint. Provider visibility does not establish write permission.',
    },
  ],
});
/** A next link may change only its cursor: no filter changes and no repeated parameters. */
function redditNextLink(next: URL, original: URL, cursorKey: string) {
  for (const [k, v] of next.searchParams) {
    if (next.searchParams.getAll(k).length !== 1 || (k !== cursorKey && original.searchParams.get(k) !== v))
      throw new MirrorError(
        'UNSAFE_PAGINATION',
        'Reddit pagination changed filters or supplied duplicate parameters.',
        {},
        502,
      );
  }
}

export const redditLogin: ProviderLogin = Object.freeze({
  gateway: 'reddit_native_action',
  discovery: Object.freeze({
    kind: (kind: string, c: DiscoveryContext) => c.parents(kind, redditParents),
    nextLink: redditNextLink,
  }),
});
