// meta_ad_images: DELETE /act_{id}/adimages?hash= (Meta Marketing API v26.0, Ad Image, Deleting) removing an image from
// the account library. An image reads with status ACTIVE, INTERNAL or DELETED, so the decisive field is the image's
// `status`: an image whose status changed in Meta after the review is no longer the image the owner chose to delete.
// The paginated-snapshot check guards a defect it found: an image missing from a page that names another page read as
// gone, so a deletion could be verified from the first page alone.
import {edge, unsupported, v} from './_meta.mjs';

const hash = 'a'.repeat(32);

export default {
  family: 'meta_ad_images',
  risk: 'destructive',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management']},
  request: {action: 'meta_ad_account_id_adimages_delete', params: {hash}},
  seed: () => ({images: {[hash]: {hash, id: '5001', name: 'hero.png', status: 'ACTIVE', account_id: '123'}}}),
  isWrite: ({method}) => method === 'DELETE',
  provider({method, path, url, state, mode}) {
    if (path !== v + '/act_123/adimages') return unsupported();
    if (method === 'GET') {
      const hashes = JSON.parse(url.searchParams.get('hashes') ?? '[]');
      // Another page: Meta names paging.next beside the images it returned.
      return edge(
        path,
        hashes.filter(h => state.images[h]).map(h => state.images[h]),
        mode.paginate,
      );
    }
    if (method === 'DELETE') {
      // A partial answer: Meta reports the deletion as not done.
      if (mode.partial) return {json: {success: false}};
      state.images[url.searchParams.get('hash')].status = 'DELETED';
      return {json: {success: true}};
    }
  },
  decisive: {change: state => (state.images[hash].status = 'INTERNAL'), field: /status/},
};
