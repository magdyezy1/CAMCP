// snapchat_event_details: POST /v1/adaccounts/{ad_account_id}/event_details (Snapchat Marketing API v1, "Event
// Details"; the entity "is immutable once created"). The review decides against the account's event details listed by
// "Get all Event Details" (names and starts, which a duplicate would repeat), so the decisive field is that list: event
// details another user creates in Snapchat after the review change what the reviewed creation adds to.
import {adAccount, failed, ok, page, rows} from './_snapchat.mjs';

// Event details start in the future, within three years: a start 30 days from now, to the second.
const start = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 19);

export default {
  family: 'snapchat_event_details',
  risk: 'settings',
  gateway: 'snapchat_native_action',
  account: 'acct1',
  arguments: {
    action: 'snapchat_adaccounts_ad_account_id_event_details_create',
    ad_account_id: 'acct1',
    params: {ad_account_id: 'acct1'},
    payload: {
      event_details: [
        {event_name: 'Winter launch', event_time_zone: 'UTC', event_start_time: start, ad_account_id: 'acct1'},
      ],
    },
  },
  seed: () => ({
    events: {
      ev1: {
        id: 'ev1',
        ad_account_id: 'acct1',
        event_name: 'Autumn launch',
        event_time_zone: 'UTC',
        event_start_time: '2026-09-01T09:00:00Z',
      },
    },
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path === '/v1/adaccounts/acct1') return adAccount('acct1');
    if (method === 'GET' && path === '/v1/adaccounts/acct1/event_details')
      return page('event_details', 'event_detail', Object.values(state.events), mode.paginate, url);
    if (method === 'POST' && path === '/v1/adaccounts/acct1/event_details') {
      if (mode.partial) return failed('event_details', body.event_details);
      const created = body.event_details.map((e, i) => {
        const id = 'ev' + (Object.keys(state.events).length + 1 + i);
        return (state.events[id] = {id, ...e});
      });
      return ok({event_details: rows('event_detail', created)});
    }
  },
  decisive: {
    change: state =>
      (state.events.ev9 = {
        id: 'ev9',
        ad_account_id: 'acct1',
        event_name: 'Winter launch',
        event_time_zone: 'UTC',
        event_start_time: '2026-12-24T18:00:00Z',
      }),
    field: /events/,
  },
};
