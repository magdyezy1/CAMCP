// dv360_sdf_downloads: POST /v4/sdfdownloadtasks (Display & Video 360 API v4, sdfdownloadtasks.create for the selected
// advertiser; "a long-running, asynchronous operation" that changes no entity). The task exports the advertiser's
// entities, so the decisive field is the advertiser's `entityStatus` in advertisers.get: an advertiser archived or
// scheduled for deletion in DV360 after the review is not the export the reviewer approved.
import {notFound, scopes} from './_dv360.mjs';

export default {
  family: 'dv360_sdf_downloads',
  risk: 'settings',
  gateway: 'dv360_native_action',
  account: '123',
  connection: {scopes},
  arguments: {
    action: 'DV360_SDFDOWNLOADTASKS_CREATE',
    params: {},
    body: {
      advertiserId: '123',
      version: 'SDF_VERSION_9',
      parentEntityFilter: {
        fileType: ['FILE_TYPE_LINE_ITEM'],
        filterType: 'FILTER_TYPE_ADVERTISER_ID',
        filterIds: ['123'],
      },
    },
  },
  seed: () => ({
    advertiser: {name: 'advertisers/123', advertiserId: '123', entityStatus: 'ENTITY_STATUS_ACTIVE'},
    operations: {},
    next: 7,
  }),
  unpaginated: 'advertisers.get and sdfdownloadtasks.operations.get return one resource each; DV360 pages lists',
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, state, mode}) {
    if (method === 'GET' && path === '/v4/advertisers/123') return {json: structuredClone(state.advertiser)};
    const op = /^\/v4\/(sdfdownloadtasks\/operations\/\w+)$/.exec(path)?.[1];
    if (method === 'GET' && op && state.operations[op]) return {json: structuredClone(state.operations[op])};
    if (method === 'GET') return notFound();
    if (method === 'POST' && path === '/v4/sdfdownloadtasks') {
      // A failed answer: DV360 names the operation but reports an error in it.
      if (mode.partial)
        return {json: {name: 'sdfdownloadtasks/operations/failed', error: {code: 3, message: 'Synthetic refusal'}}};
      const name = 'sdfdownloadtasks/operations/' + state.next++;
      state.operations[name] = {
        name,
        done: true,
        response: {resourceName: 'download/sdfdownloadtasks/media/' + name.split('/').at(-1)},
      };
      return {json: {name, metadata: {}}};
    }
  },
  decisive: {change: state => (state.advertiser.entityStatus = 'ENTITY_STATUS_ARCHIVED'), field: /entityStatus/},
};
