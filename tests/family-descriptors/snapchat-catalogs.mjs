// snapchat_catalogs: PUT /v1/organizations/{organization_id}/catalogs (Snapchat Marketing API v1, "Dynamic Product
// Ads", Update a Catalog: "The API expects the entire object when updating any fields"; name and event_sources can be
// updated). The update renames the catalog and sends its whole event source list, so the decisive field is the
// catalog's `event_sources` in "Get all Catalogs": a pixel added in Snapchat after the review would be dropped by it.
import {adAccount, failed, ok, page, rows} from './_snapchat.mjs';

const catalog = () => ({
  id: 'cat-1',
  organization_id: 'org-1',
  name: 'Store',
  vertical: 'COMMERCE',
  event_sources: [{id: 'px-1', type: 'PIXEL'}],
  default_product_set_id: 'ps-default',
});

export default {
  family: 'snapchat_catalogs',
  risk: 'settings',
  gateway: 'snapchat_native_action',
  account: 'acct1',
  request: {
    action: 'snapchat_organizations_organization_id_catalogs_update',
    params: {organization_id: 'org-1'},
    payload: {
      catalogs: [
        {
          id: 'cat-1',
          organization_id: 'org-1',
          name: 'Store KSA',
          vertical: 'COMMERCE',
          event_sources: [{id: 'px-1', type: 'PIXEL'}],
        },
      ],
    },
  },
  seed: () => ({
    catalogs: {'cat-1': catalog()},
    pixels: [
      {id: 'px-1', ad_account_id: 'acct1', name: 'Site pixel'},
      {id: 'px-2', ad_account_id: 'acct1', name: 'App pixel'},
    ],
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path === '/v1/adaccounts/acct1') return adAccount('acct1');
    if (method === 'GET' && path === '/v1/organizations/org-1/catalogs')
      return page('catalogs', 'catalog', Object.values(state.catalogs), mode.paginate, url);
    if (method === 'GET' && path === '/v1/adaccounts/acct1/pixels') return page('pixels', 'pixel', state.pixels);
    const one = /^\/v1\/catalogs\/([\w-]+)$/.exec(path)?.[1];
    if (method === 'GET' && one && state.catalogs[one]) return ok({catalogs: rows('catalog', [state.catalogs[one]])});
    if (method === 'PUT' && path === '/v1/organizations/org-1/catalogs') {
      if (mode.partial) return failed('catalogs', body.catalogs);
      const c = body.catalogs[0];
      Object.assign(state.catalogs[c.id], c);
      return ok({catalogs: rows('catalog', [state.catalogs[c.id]])});
    }
  },
  decisive: {
    change: state => state.catalogs['cat-1'].event_sources.push({id: 'px-2', type: 'PIXEL'}),
    field: /event_sources/,
  },
};
