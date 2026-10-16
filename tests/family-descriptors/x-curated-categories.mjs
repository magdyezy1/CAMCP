// x_curated_categories: PUT /12/accounts/{account}/line_item_curated_categories/{id} (X Ads API v12, Line Item Curated
// Categories) replacing the curated category of an active pre-roll line item. The category decides next to which
// publishers the line item runs, so the decisive field is the association's current `curated_category_id`: a category
// replaced in X after the review would be silently overwritten.
import {account, credentials, missing, reply, suffix} from './_x.mjs';

export default {
  family: 'x_curated_categories',
  risk: 'activation',
  gateway: 'x_ads_native_action',
  account,
  credentials,
  request: {
    action: 'x_accounts_account_id_line_item_curated_categories_line_item_curated_category_id_put',
    params: {line_item_curated_category_id: 'lc1'},
    payload: {curated_category_id: 'cat2'},
  },
  seed: () => ({
    line: {
      id: 'pre',
      campaign_id: 'camp1',
      product_type: 'MEDIA',
      objective: 'PREROLL_VIEWS',
      entity_status: 'ACTIVE',
      deleted: false,
    },
    campaign: {id: 'camp1', entity_status: 'ACTIVE', deleted: false},
    categories: {
      cat1: {id: 'cat1', name: 'Basketball', country_codes: ['US']},
      cat2: {id: 'cat2', name: 'Football', country_codes: ['US', 'GB']},
    },
    rows: {lc1: {id: 'lc1', line_item_id: 'pre', curated_category_id: 'cat1', deleted: false}},
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    const s = suffix(path);
    if (method === 'GET') {
      if (s === '') return reply({id: account, name: 'Account', deleted: false});
      if (s === '/line_items/pre') return reply(state.line);
      if (s === '/campaigns/camp1') return reply(state.campaign);
      if (s === '/line_item_curated_categories/lc1') return reply(state.rows.lc1);
      const category = /^\/curated_categories\/(\w+)$/.exec(s ?? '')?.[1];
      if (category && state.categories[category]) return reply(state.categories[category]);
      // Every association of the account. Another page: X names the same cursor again, which never completes.
      if (s === '/line_item_curated_categories') return reply(Object.values(state.rows), mode.paginate ? 'c' : null);
      return missing();
    }
    if (method === 'PUT' && s === '/line_item_curated_categories/lc1') {
      // A partial answer: X echoes the association without the new category.
      if (mode.partial) return reply(state.rows.lc1);
      Object.assign(state.rows.lc1, body);
      return reply(state.rows.lc1);
    }
  },
  decisive: {change: state => (state.rows.lc1.curated_category_id = 'cat3'), field: /categoryId/},
};
