// meta_object_edits: POST /{custom_audience_id} (Meta Marketing API v26.0, Custom Audience, Updating) renaming an
// audience and rewriting its description. The update replaces both stored values, so the decisive field is the
// audience's current `description`: a description changed in Meta after the review would be silently overwritten.
// (Delivery status is telemetry the review state leaves out by design, so it cannot be the decisive field of a
// deletion; the deletion's own prerequisite, an audience still present, is covered by tests/meta-object-edits.test.mjs.)
import {decode, unsupported, v} from './_meta.mjs';

export default {
  family: 'meta_object_edits',
  risk: 'settings',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management']},
  owned: ['901'],
  request: {
    action: 'meta_custom_audience_id_update',
    params: {custom_audience_id: '901'},
    payload: {name: 'Site visitors (30 days)', description: 'Visited in the last 30 days'},
  },
  seed: () => ({
    audiences: {
      901: {
        id: '901',
        account_id: '123',
        name: 'Site visitors',
        description: 'Last 30 days',
        subtype: 'WEBSITE',
        delivery_status: {code: 200},
      },
    },
  }),
  unpaginated: 'GET /{custom_audience_id} returns one audience node; Meta pages only edges',
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, url, body, state, mode}) {
    const row = state.audiences[path.slice(v.length + 1)];
    if (!row) return unsupported();
    if (method === 'GET')
      return {
        json: Object.fromEntries(
          (url.searchParams.get('fields') ?? '')
            .split(',')
            .filter(f => row[f] !== undefined)
            .map(f => [f, row[f]]),
        ),
      };
    if (method === 'POST') {
      // A partial answer: Meta answers without confirming the update.
      if (mode.partial) return {json: {}};
      Object.assign(row, decode(body));
      return {json: {success: true}};
    }
  },
  decisive: {change: state => (state.audiences[901].description = 'Last 14 days'), field: /description/},
};
