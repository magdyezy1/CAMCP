import type {DiscoveryContext, DiscoveryParents, ProviderLogin} from './provider-login.js';
import type {JsonObject} from './types.js';
import {googleOAuth} from './google-oauth.js';

/**
 * Display & Video 360's website login steps (ARC-01 phase B; registered in src/provider-logins.ts). Discovery: the
 * advertisers of each partner the login reaches. It authorizes with Google's OAuth steps (src/google-oauth.ts), by
 * default with the shared Google client.
 */
const dv360Parents: DiscoveryParents = Object.freeze({
  parents: () => ({path: '/v4/partners', query: {pageSize: 200}, extract: (d: JsonObject) => d.partners ?? []}),
  parentId: (parent: JsonObject) => String(parent.partnerId ?? ''),
  parentPattern: /^\d{1,20}$/,
  accounts: (id: string) => ({
    path: '/v4/advertisers',
    query: {partnerId: id, pageSize: 200},
    extract: (d: JsonObject) => d.advertisers ?? [],
  }),
  accountId: (row: JsonObject) => row.advertiserId,
  accountParent: (row: JsonObject) => row.partnerId,
  accountPattern: /^\d{1,20}$/,
  fields: (row: JsonObject) => ({
    name: row.displayName,
    currency: row.generalConfig?.currencyCode,
    timezone: row.generalConfig?.timeZone,
    status: row.entityStatus,
  }),
});

export const dv360Login: ProviderLogin = Object.freeze({
  gateway: 'dv360_native_action',
  oauth: googleOAuth,
  discovery: Object.freeze({kind: (kind: string, c: DiscoveryContext) => c.parents(kind, dv360Parents)}),
});
