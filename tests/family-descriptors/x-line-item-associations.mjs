// x_line_item_associations: POST /12/accounts/{account}/media_creatives (X Ads API v12, Media Creatives) adding a
// preroll video to a line item. Media creatives are created ACTIVE and serve at once under an active line item, so the
// decisive field is the line item's `entity_status`: a line item activated or paused in X after the review changes
// whether the new creative starts spending.
import {account, credentials, missing, reply, suffix} from './_x.mjs';

export default {
  family: 'x_line_item_associations',
  risk: 'activation',
  gateway: 'x_ads_native_action',
  account,
  credentials,
  request: {
    action: 'x_accounts_account_id_media_creatives_post',
    payload: {line_item_id: 'li1', account_media_id: 'am1'},
  },
  seed: () => ({
    line: {
      id: 'li1',
      campaign_id: 'camp1',
      product_type: 'MEDIA',
      objective: 'VIDEO_VIEWS_PREROLL',
      entity_status: 'ACTIVE',
      deleted: false,
    },
    campaign: {id: 'camp1', entity_status: 'ACTIVE', deleted: false},
    media: {id: 'am1', creative_type: 'PREROLL', deleted: false},
    creatives: [],
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    const s = suffix(path);
    if (method === 'GET') {
      if (s === '') return reply({id: account, name: 'Account', deleted: false});
      if (s === '/line_items/li1') return reply(state.line);
      if (s === '/campaigns/camp1') return reply(state.campaign);
      if (s === '/account_media/am1') return reply(state.media);
      // The line item's media creatives; another page leaves some unread.
      if (s === '/media_creatives') return reply(state.creatives, mode.paginate ? 'next' : null);
      return missing();
    }
    if (method === 'POST' && s === '/media_creatives') {
      const row = {id: 'mc' + (state.creatives.length + 1), ...body, entity_status: 'ACTIVE', deleted: false};
      // A partial answer: X echoes another account media item than the one sent.
      if (mode.partial) return reply({...row, account_media_id: 'am9'});
      state.creatives.push(row);
      return reply(row);
    }
  },
  decisive: {change: state => (state.line.entity_status = 'PAUSED'), field: /line.*status/},
};
