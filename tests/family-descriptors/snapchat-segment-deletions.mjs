// snapchat_segment_deletions: DELETE /v1/segments/{segment_id} (Snapchat Marketing API v1, Audiences, "Delete a
// Segment"; deleted segments "cannot be retrieved"). The decisive field is the segment's `name` in "Get all audience
// Segments": a segment renamed in Snapchat after the review is a list the reviewer did not approve deleting. (An ad
// squad that starts targeting it after the review is refused at execute as AUDIENCE_IN_USE, before the comparison.)
import {failed, ok, page} from './_snapchat.mjs';

export default {
  family: 'snapchat_segment_deletions',
  risk: 'destructive',
  gateway: 'snapchat_native_action',
  account: 'acct1',
  arguments: {action: 'snapchat_segments_segment_id_delete', ad_account_id: 'acct1', params: {segment_id: 'seg1'}},
  // The segment is listed from the selected ad account first, as a caller does before deleting it.
  prime: ({call, connectionId}) =>
    call('snapchat_native_action', {
      action: 'snapchat_audience_list',
      connection_id: connectionId,
      account_id: 'acct1',
    }),
  seed: () => ({
    segments: {
      seg1: {id: 'seg1', ad_account_id: 'acct1', name: 'Old list', source_type: 'FIRST_PARTY', status: 'ACTIVE'},
    },
    squads: [
      {id: 'sq1', name: 'Prospecting', status: 'ACTIVE', targeting: {geos: [{country_code: 'us'}]}},
      {id: 'sq2', name: 'Lookalikes', status: 'PAUSED', targeting: {segments: [{segment_id: ['lal9']}]}},
    ],
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, state, mode}) {
    if (method === 'GET' && path === '/v1/adaccounts/acct1/segments')
      return page('segments', 'segment', Object.values(state.segments), mode.paginate, url);
    if (method === 'GET' && path === '/v1/adaccounts/acct1/adsquads')
      return page('adsquads', 'adsquad', state.squads, false, url);
    if (method === 'DELETE' && path === '/v1/segments/seg1') {
      if (mode.partial) return failed('segments');
      delete state.segments.seg1;
      return ok({});
    }
  },
  decisive: {change: state => (state.segments.seg1.name = 'Buyers 2026'), field: /segment.*name/},
};
