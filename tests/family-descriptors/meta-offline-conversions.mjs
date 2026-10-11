// meta_offline_conversions: POST /{pixel_id}/events (Meta Conversions API v26.0, offline events) under the owner's
// personal-data policy. A sent conversion cannot be recalled, and the events belong to the pixel's ad account, so the
// decisive field is the account's pixels: a pixel no longer the account's after the review makes the family's own
// prerequisite refuse the upload as the state is read again at execute.
import {decode, unsupported, v} from './_meta.mjs';

const hours = h => Math.floor(Date.now() / 1000) - h * 3600;
const people = {
  schema: ['EMAIL', 'PHONE'],
  rows: [
    {
      EMAIL: ' Mary@Example.com ',
      PHONE: '+966 50 123 4567',
      event_name: 'Purchase',
      event_time: hours(5),
      action_source: 'physical_store',
      value: 120.5,
      currency: 'SAR',
      event_id: 'order-1001',
    },
    {EMAIL: 'bob@example.org', event_name: 'Lead', event_time: hours(30), action_source: 'phone_call'},
  ],
};

export default {
  family: 'meta_offline_conversions',
  risk: 'settings',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management']},
  // Only the workspace owner executes an upload about people.
  role: 'admin',
  request: {action: 'meta_pixel_id_events_create', params: {pixel_id: '700'}},
  prepareFields: {
    people,
    personal_data: {
      countries: ['SA'],
      consent_confirmed: true,
      platform_terms_confirmed: true,
      pdpl: {consent: true, transfer_abroad: true, withdrawal_removal: true},
    },
  },
  execute: {people},
  // The owner turned personal data on for this account.
  prime: ({call, connectionId}) =>
    call('amcp_workspace', {
      action: 'enable_personal_data',
      connection_id: connectionId,
      account_id: '123',
      confirmed: true,
    }),
  seed: () => ({
    pixels: [
      {id: '700', name: 'Store pixel'},
      {id: '701', name: 'Site pixel'},
    ],
  }),
  isWrite: ({method}) => method === 'POST',
  provider({method, path, url, body, state, mode}) {
    if (method === 'GET' && path === v + '/act_123/adspixels') {
      const at = Number(url.searchParams.get('after') ?? 0);
      // Another page: the pixels go on past the review's page bound, the named one not among those read.
      if (mode.paginate)
        return {
          json: {
            data: [{id: String(800 + at), name: 'Pixel ' + at}],
            paging: {cursors: {after: String(at + 1)}, next: 'https://graph.facebook.com' + path},
          },
        };
      return {json: {data: structuredClone(state.pixels), paging: {cursors: {before: '0', after: '0'}}}};
    }
    if (method === 'POST' && path === v + '/700/events' && state.pixels.some(p => p.id === '700')) {
      // A partial answer: Meta answers without the count of events it received.
      if (mode.partial) return {json: {messages: ['Processing'], fbtrace_id: 'AbCdEf123'}};
      return {json: {events_received: decode(body).data.length, messages: [], fbtrace_id: 'AbCdEf123'}};
    }
    return unsupported();
  },
  decisive: {
    change: state => (state.pixels = state.pixels.filter(p => p.id !== '700')),
    field: /pixel/,
    refusal: {code: 'STATE_TARGET_MISMATCH', message: /Meta pixel 700 is not a pixel of ad account 123/},
  },
};
