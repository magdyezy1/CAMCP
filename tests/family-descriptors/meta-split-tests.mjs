// meta_split_tests: POST /{ad_study_id} (Meta Marketing API v26.0, Ad Study) moving a running split test's
// `end_time`. The decisive field is the study's current `end_time`, which the update overwrites and which decides until
// when the audience stays split ("you can update end_time to the future time if the study is not yet ended").
import {decode, unsupported, v} from './_meta.mjs';

const now = Math.floor(Date.now() / 1000),
  day = 86400,
  iso = s => new Date(s * 1000).toISOString().replace('.000Z', '+0000');

export default {
  family: 'meta_split_tests',
  risk: 'activation',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management']},
  request: {action: 'meta_ad_study_id_update', params: {ad_study_id: '7001'}, payload: {end_time: now + 20 * day}},
  seed: () => ({
    account: {id: 'act_123', business: {id: '900', name: 'Business'}},
    study: {
      id: '7001',
      name: 'Creative split',
      description: 'Two audiences',
      type: 'SPLIT_TEST',
      start_time: now - 2 * day,
      end_time: now + 10 * day,
      business: {id: '900', name: 'Business'},
    },
    cells: [
      {name: 'A', treatment_percentage: 50, adsets: {data: [{id: '201'}]}},
      {name: 'B', treatment_percentage: 50, adsets: {data: [{id: '202'}]}},
    ],
  }),
  isWrite: ({method}) => method === 'POST',
  provider({method, path, body, state, mode}) {
    if (method === 'GET') {
      if (path === v + '/act_123') return {json: state.account};
      if (path === v + '/7001')
        return {json: {...state.study, start_time: iso(state.study.start_time), end_time: iso(state.study.end_time)}};
      // Another page of cells on every read: the review follows at most six pages, then refuses the study as unread.
      if (path === v + '/7001/cells')
        return {
          json: {
            data: structuredClone(state.cells),
            ...(mode.paginate
              ? {paging: {cursors: {after: 'x'}, next: 'https://graph.facebook.com' + path + '?after=x'}}
              : {}),
          },
        };
      return unsupported();
    }
    if (method === 'POST' && path === v + '/7001') {
      // A failed answer: Meta does not confirm the update.
      if (mode.partial) return {json: {success: false}};
      const b = decode(body);
      if (b.end_time !== undefined) state.study.end_time = Number(b.end_time);
      return {json: {success: true}};
    }
  },
  decisive: {change: state => (state.study.end_time = now + 12 * day), field: /end_time/},
};
