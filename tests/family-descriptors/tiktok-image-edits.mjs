// tiktok_image_edits: POST /v1.3/creative/image/edit/ (API for Business v1.3, "Edit an image"), cropping a library
// image to a new size. The edit is computed from the source image, so the decisive field is the source's `width` in
// "Search for images": a source replaced or resized after the review gives a different copy than the reviewed one.
import {failed, ok} from './_tiktok.mjs';

const source = 'ad-site-i18n-sg/source1';

export default {
  family: 'tiktok_image_edits',
  risk: 'settings',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    // TikTok's catalog names this POST route with a _get suffix.
    action: 'tiktok_creative_image_edit_get',
    payload: {advertiser_id: '123', image_id: source, width: 720, height: 1280, edit_method: 'fix_size'},
  },
  seed: () => ({
    images: {[source]: {image_id: source, file_name: 'Hero', width: 1080, height: 1920, format: 'jpeg'}},
    edits: 0,
  }),
  unpaginated:
    'GET /v1.3/file/image/ad/search/ is filtered to the one named image_id, so a second page cannot hold it ' +
    '(a row for any other image is refused as a target mismatch)',
  partialCodes: ['PLATFORM_ERROR', 'WRITE_REJECTED'],
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/creative/image/edit/'),
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/file/image/ad/search/')) {
      const ids = JSON.parse(url.searchParams.get('filtering')).image_ids,
        list = ids.filter(id => state.images[id]).map(id => ({...state.images[id]}));
      return ok({list, page_info: {page: 1, page_size: 20, total_number: list.length, total_page: 1}});
    }
    if (method === 'POST' && path.endsWith('/v1.3/creative/image/edit/')) {
      if (mode.partial) return failed('The image cannot be cropped to this size');
      const id = 'ad-site-i18n-sg/edit' + ++state.edits;
      state.images[id] = {image_id: id, file_name: 'Hero copy', width: body.width, height: body.height, format: 'jpeg'};
      return ok({image_id: id, width: body.width, height: body.height, format: 'jpeg', file_name: 'Hero copy'});
    }
  },
  decisive: {change: state => (state.images[source].width = 1200), field: /width/},
};
