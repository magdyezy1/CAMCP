// dv360_custom_bidding_files: POST /v4/customBiddingAlgorithms/{id}/scripts?advertiserId= (Display & Video 360 API v4,
// customBiddingAlgorithms.scripts.create, registering an uploaded script by its scriptRef). Once accepted, the newest
// accepted script is the one the algorithm scores with, so the decisive field is the algorithm's registered scripts in
// customBiddingAlgorithms.scripts.list: a script registered in DV360 after the review changes what the reviewed one
// supersedes.
import {list, notFound, scopes} from './_dv360.mjs';

const script = (id, ref) => ({
  name: 'customBiddingAlgorithms/801/scripts/' + id,
  customBiddingAlgorithmId: '801',
  customBiddingScriptId: id,
  script: {resourceName: 'customBiddingAlgorithms/801/scriptRef/' + ref},
  state: 'ACCEPTED',
  active: true,
});

export default {
  family: 'dv360_custom_bidding_files',
  risk: 'settings',
  gateway: 'dv360_native_action',
  account: '123',
  connection: {scopes},
  arguments: {
    action: 'DV360_CUSTOM_BIDDING_ALGORITHMS_SCRIPTS_CREATE',
    params: {customBiddingAlgorithmId: '801', advertiserId: '123'},
    body: {script: {resourceName: 'customBiddingAlgorithms/801/scriptRef/new-2'}},
  },
  seed: () => ({
    algorithm: {
      name: 'customBiddingAlgorithms/801',
      customBiddingAlgorithmId: '801',
      advertiserId: '123',
      displayName: 'Conversions model',
      customBiddingAlgorithmType: 'SCRIPT_BASED',
      entityStatus: 'ENTITY_STATUS_ACTIVE',
    },
    scripts: {901: script('901', 'old-1')},
    next: 950,
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (url.searchParams.get('advertiserId') !== '123') return notFound();
    if (method === 'GET' && path === '/v4/customBiddingAlgorithms/801') return {json: structuredClone(state.algorithm)};
    if (method === 'GET' && path === '/v4/customBiddingAlgorithms/801/scripts')
      return list('customBiddingScripts', Object.values(state.scripts), mode.paginate);
    if (method === 'GET') return notFound();
    if (method === 'POST' && path === '/v4/customBiddingAlgorithms/801/scripts') {
      // An unconfirmed answer: HTTP 200 naming no registered script.
      if (mode.partial) return {json: {}};
      const id = String(state.next++);
      state.scripts[id] = {...script(id, 'x'), script: body.script, state: 'PENDING', active: false};
      return {json: structuredClone(state.scripts[id])};
    }
  },
  decisive: {change: state => (state.scripts[940] = script('940', 'other-3')), field: /files/},
};
