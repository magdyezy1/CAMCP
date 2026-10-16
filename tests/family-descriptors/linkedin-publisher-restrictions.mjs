// linkedin_publisher_restrictions: PUT /rest/adAccountTrustPreferences/{account} (LinkedIn Manage Audience Restrictions,
// li-lms-2026-09) replacing the account's Audience Network allow and block lists: with an allowlist "only ads on these
// domains/apps will be served". The PUT replaces both lists, so the decisive field is the account's current
// preferences: a list added in Campaign Manager after the review would be silently dropped.
import {account, empty, restliError} from './_linkedin.mjs';

const file = (id, type) => ({id, entity: account, fileName: 'list-' + id + '.csv', type, dataId: 'urn:li:media:' + id});

export default {
  family: 'linkedin_publisher_restrictions',
  risk: 'activation',
  gateway: 'linkedin_native_action',
  account: '507',
  connection: {scopes: ['rw_ads']},
  request: {
    action: 'linkedin_rest_ad_account_trust_preferences_account_id_put',
    path_params: {account_id: '507'},
    payload: {
      offsiteAccountPreferences: {
        publisherRestrictionFiles: {include: [], exclude: ['urn:li:adPublisherFile:31', 'urn:li:adPublisherFile:32']},
      },
    },
  },
  seed: () => ({
    files: [
      {...file(31, 'BLOCKLIST'), status: 'SUCCESS'},
      {...file(32, 'BLOCKLIST'), status: 'SUCCESS'},
      {...file(33, 'ALLOWLIST'), status: 'SUCCESS'},
    ],
    preferences: {
      offsiteAccountPreferences: {publisherRestrictionFiles: {include: [], exclude: ['urn:li:adPublisherFile:31']}},
    },
  }),
  isWrite: ({method}) => method === 'PUT',
  provider({method, path, url, body, state, mode}) {
    if (method === 'GET') {
      if (path === '/rest/adAccounts/507') return {json: {id: 507, status: 'ACTIVE', currency: 'SAR'}};
      if (path === '/rest/adAccountTrustPreferences/507') return {json: structuredClone(state.preferences)};
      if (path === '/rest/adPublisherRestrictions') {
        const start = Number(url.searchParams.get('start') ?? 0);
        // Another page: the account lists full pages of publisher lists past the review's page bound.
        if (mode.paginate)
          return {
            json: {
              elements: Array.from({length: 100}, (_, i) => ({
                ...file(1000 + start + i, 'BLOCKLIST'),
                status: 'SUCCESS',
              })),
              paging: {start, count: 100, total: 5000, links: []},
            },
          };
        return {
          json: {
            elements: structuredClone(state.files.slice(start, start + 100)),
            paging: {start, count: 100, total: state.files.length, links: []},
          },
        };
      }
      return restliError(404, 'Not found');
    }
    if (method === 'PUT' && path === '/rest/adAccountTrustPreferences/507') {
      // A failed answer: LinkedIn refuses the preferences.
      if (mode.partial) return restliError(400, 'Publisher list is not processed');
      state.preferences = structuredClone(body);
      return empty();
    }
  },
  partialCodes: ['UPSTREAM_ERROR', 'WRITE_PARTIAL_OR_FAILED', 'WRITE_OUTCOME_UNCERTAIN'],
  decisive: {
    change: state =>
      state.preferences.offsiteAccountPreferences.publisherRestrictionFiles.include.push('urn:li:adPublisherFile:33'),
    field: /include/,
  },
};
