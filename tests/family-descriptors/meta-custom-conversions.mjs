// meta_custom_conversions: POST /act_{id}/customconversions (Meta Marketing API v26.0, Ad Account Customconversions,
// Creating) on a pixel of the account. Meta offers no update or deletion on that edge, so a duplicate cannot be undone
// here; the decisive field is the account's custom conversions by name: one created in Meta after the review under the
// same name makes the family's own prerequisite refuse the creation as the state is read again at execute.
import {decode, paged, unsupported, v} from './_meta.mjs';

export default {
  family: 'meta_custom_conversions',
  risk: 'settings',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management']},
  request: {
    action: 'meta_ad_account_id_customconversions_create',
    payload: {
      name: 'Order confirmed',
      event_source_id: '4001',
      custom_event_type: 'PURCHASE',
      rule: '{"url":{"i_contains":"order-confirmed"}}',
    },
  },
  seed: () => ({
    next: 6100,
    pixels: [
      {id: '4001', name: 'Site pixel'},
      {id: '4002', name: 'Shop pixel'},
    ],
    conversions: [
      {
        id: '6001',
        name: 'Thank you page',
        custom_event_type: 'PURCHASE',
        rule: '{"url":{"i_contains":"thank-you"}}',
        default_conversion_value: 0,
        pixel: {id: '4001'},
        is_archived: false,
      },
      {
        id: '6002',
        name: 'Old lead',
        custom_event_type: 'LEAD',
        rule: '{"url":{"i_contains":"lead"}}',
        pixel: {id: '4001'},
        is_archived: true,
      },
      {
        id: '6003',
        name: 'Sign up',
        custom_event_type: 'COMPLETE_REGISTRATION',
        rule: '{"url":{"i_contains":"welcome"}}',
        pixel: {id: '4002'},
        is_archived: false,
      },
    ],
  }),
  isWrite: ({method}) => method === 'POST',
  provider({method, path, url, body, state, mode}) {
    // Both lists are read to their end in cursor pages. Another page: every page names one more, past the bound.
    if (method === 'GET' && path === v + '/act_123/adspixels') return paged(state.pixels, url, mode.paginate);
    if (method === 'GET' && path === v + '/act_123/customconversions')
      return paged(state.conversions, url, mode.paginate);
    if (method === 'POST' && path === v + '/act_123/customconversions') {
      // A partial answer: Meta answers without the new conversion's ID.
      if (mode.partial) return {json: {is_custom_event_type_predicted: 0}};
      const b = decode(body),
        id = String(state.next++);
      state.conversions.push({
        id,
        name: String(b.name),
        custom_event_type: b.custom_event_type,
        rule: JSON.stringify(b.rule),
        default_conversion_value: 0,
        pixel: {id: String(b.event_source_id)},
        is_archived: false,
      });
      return {json: {id, is_custom_event_type_predicted: 0}};
    }
    return unsupported();
  },
  decisive: {
    change: state =>
      state.conversions.push({
        id: '6004',
        name: 'order confirmed',
        custom_event_type: 'PURCHASE',
        rule: '{"url":{"i_contains":"confirmed"}}',
        pixel: {id: '4002'},
        is_archived: false,
      }),
    field: /conversions/,
    refusal: {
      code: 'CONFIGURATION_EXISTS',
      message: /already has a custom conversion named "order confirmed" \(6004\)/,
    },
  },
};
