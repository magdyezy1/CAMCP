// x_tracking_tags: PUT /12/accounts/{account}/tracking_tags/{id} (X Ads API v12, Tracking Tags) replacing the partner URL
// of a line item's click tracker; "a broken click tracker can break the way to the landing page". The update replaces
// the URL, so the decisive field is the tag's current `tracking_tag_url`: a URL changed in X after the review would be
// silently overwritten.
import {account, credentials, missing, reply, suffix} from './_x.mjs';

export default {
  family: 'x_tracking_tags',
  risk: 'settings',
  gateway: 'x_ads_native_action',
  account,
  credentials,
  request: {
    action: 'x_accounts_account_id_tracking_tags_tracking_tag_id_put',
    params: {tracking_tag_id: 'tag1'},
    payload: {tracking_tag_url: 'https://ad.doubleclick.net/ddm/trackclk/N1234.5678/B2'},
  },
  seed: () => ({
    line: {id: 'line1', campaign_id: 'camp1', name: 'Line', entity_status: 'ACTIVE', deleted: false},
    tag: {
      id: 'tag1',
      line_item_id: 'line1',
      tracking_tag_type: 'CLICK_TRACKER',
      tracking_tag_url: 'https://ad.doubleclick.net/ddm/trackclk/N1234.5678/B1',
      deleted: false,
    },
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    const s = suffix(path);
    if (method === 'GET') {
      if (s === '') return reply({id: account, name: 'Account', deleted: false});
      if (s === '/tracking_tags/tag1') return reply(state.tag);
      if (s === '/line_items/line1') return reply(state.line);
      // The line item's tags, read in one page. Another page: X names a cursor.
      if (s === '/tracking_tags') return reply([state.tag], mode.paginate ? 'more' : null);
      return missing();
    }
    if (method === 'PUT' && s === '/tracking_tags/tag1') {
      // A partial answer: X echoes the tag with its old URL.
      if (mode.partial) return reply(state.tag);
      Object.assign(state.tag, body);
      return reply(state.tag);
    }
  },
  decisive: {
    change: state => (state.tag.tracking_tag_url = 'https://ad.doubleclick.net/ddm/trackclk/N1234.5678/B9'),
    field: /url/,
  },
};
