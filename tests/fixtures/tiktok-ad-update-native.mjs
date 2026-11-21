/**
 * A synthetic TikTok advertiser for the native `tiktok_ad_update` (R2.5 M4, package r25-m4-classic): the cases of
 * tests/tiktok-ad-update-native.test.mjs run on it, and the M4a merge's journey J18 serves it from the journey harness (an edit of
 * two ads in TikTok's own shape: prepare, execute, and a verify of each ad). Separated from that test by the merge, so that the journey
 * composes the advertiser and does not copy it. Every ID is synthetic and nothing here reaches TikTok.
 *
 * `nativeAdWorld({ignore})` returns the advertiser: `fetch(raw, init)` is a fetcher in the shape NativeTransport takes; it answers the
 * advertiser read, the ad list read and the ad update, and any other request throws. `ads` are the ad rows by ID (400 to 429 in ad group
 * 200, and 450 in 201), `requests` every request ('METHOD path'), `adReads` the ad IDs of each ad list read, and `writes` every update
 * body. An update is incremental (`patch_update`): only the fields a creative restates change, except the ones `ignore` lists, which
 * TikTok does not apply.
 * `nativeAdUpdate(creatives, extra)` is TikTok's native request: the ad IDs are in the creatives alone, and the update is incremental.
 */
export const nativeAdAccount = '123';
/** An ad row as TikTok's ad list returns it (synthetic IDs). */
export const nativeAdRow = (id, group = '200', extra = {}) => ({
  ad_id: id,
  adgroup_id: group,
  campaign_id: '300',
  advertiser_id: nativeAdAccount,
  ad_name: 'Ad ' + id,
  ad_text: 'Text ' + id,
  call_to_action: 'LEARN_MORE',
  landing_page_url: 'https://example.test/' + id,
  identity_type: 'TT_USER',
  identity_id: 'tt-1',
  operation_status: 'DISABLE',
  ...extra,
});
export const nativeAdUpdate = (creatives, extra = {}) => ({
  advertiser_id: nativeAdAccount,
  adgroup_id: '200',
  patch_update: true,
  creatives,
  ...extra,
});

export function nativeAdWorld({ignore = []} = {}) {
  const ads = {};
  for (let n = 400; n <= 429; n++) ads[n] = nativeAdRow(String(n));
  ads[450] = nativeAdRow('450', '201');
  const requests = [],
    adReads = [],
    writes = [];
  let n = 0;
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const fetch = async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET';
    requests.push(method + ' ' + path);
    if (method === 'GET' && path === '/v1.3/advertiser/info/')
      return ok({list: [{advertiser_id: nativeAdAccount, name: 'Synthetic advertiser', status: 'STATUS_ENABLE'}]});
    if (method === 'GET' && path === '/v1.3/ad/get/') {
      const ids = JSON.parse(url.searchParams.get('filtering')).ad_ids;
      adReads.push(ids);
      return ok({list: ids.filter(id => ads[id]).map(id => structuredClone(ads[id]))});
    }
    if (method === 'POST' && path === '/v1.3/ad/update/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      // The ads an update changes: the ones its creatives name, or, for a body that lists its ads at the top level, that list.
      const listed = b.ad_ids ?? (b.ad_id ? [b.ad_id] : []),
        updated = (b.creatives ?? []).map((c, i) => c.ad_id ?? listed[i]);
      // An incremental update (patch_update): only the fields a creative restates change. `ignore` lists fields TikTok does not apply.
      (b.creatives ?? []).forEach((c, i) => {
        const {ad_id, ...fields} = c;
        for (const k of ignore) delete fields[k];
        if (ads[updated[i]]) Object.assign(ads[updated[i]], fields);
      });
      return ok({ad_ids: updated});
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  };
  return {ads, requests, adReads, writes, fetch};
}
