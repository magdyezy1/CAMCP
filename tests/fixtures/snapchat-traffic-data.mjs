import {fixture, actor, SNAP} from '../../dist/tests/snapchat-plan-fixture.js';
export {actor};
export const trafficBusiness = {
  name: 'Synthetic Snapchat website traffic',
  account_id: 'acct1',
  connection_id: SNAP,
  currency: 'USD',
  daily_budget: '20.000001',
  country_codes: ['SA'],
  creative_id: '33333333-3333-4333-8333-333333333333',
  regulated_content: false,
  start_time: '2026-11-01T10:00:00+03:00',
};
export function trafficFixture({
  lostAdReceipt = false,
  driftAd = false,
  endlessCreativePages = false,
  beforeCreativeRead,
} = {}) {
  const ads = [],
    adWrites = [],
    creative = {
      id: trafficBusiness.creative_id,
      ad_account_id: 'acct1',
      type: 'WEB_VIEW',
      name: 'Synthetic website creative',
      web_view_properties: {url: 'https://example.com/synthetic-snapchat'},
      review_status: 'APPROVED',
    };
  const wrap = (kind, rows) =>
    Response.json({
      request_status: 'SUCCESS',
      paging: {},
      [kind]: rows.map(row => ({
        sub_request_status: 'SUCCESS',
        [kind === 'adsquads' ? 'adsquad' : kind.slice(0, -1)]: row,
      })),
    });
  const f = fixture({
    routes: (method, path, url, raw) => {
      if (method === 'GET' && path === '/v1/adaccounts/acct1/creatives') {
        if (endlessCreativePages)
          return Response.json({
            request_status: 'SUCCESS',
            creatives: [{sub_request_status: 'SUCCESS', creative}],
            paging: {
              next_link:
                'https://adsapi.snapchat.com/v1/adaccounts/acct1/creatives?cursor=' +
                ((Number(url.searchParams.get('cursor')) || 0) + 1),
            },
          });
        return wrap('creatives', [creative]);
      }
      if (method === 'GET' && path === '/v1/creatives/' + creative.id) {
        beforeCreativeRead?.(f, creative);
        return wrap('creatives', [creative]);
      }
      if (method === 'GET' && path === '/v1/adaccounts/acct1/ads') return wrap('ads', ads);
      let m;
      if (method === 'GET' && (m = /^\/v1\/adsquads\/([^/]+)\/ads$/.exec(path)))
        return wrap(
          'ads',
          ads.filter(a => a.ad_squad_id === m[1]),
        );
      if (method === 'GET' && (m = /^\/v1\/ads\/([^/]+)$/.exec(path)))
        return wrap(
          'ads',
          ads
            .filter(a => a.id === m[1])
            .map(a => (driftAd ? {...a, creative_id: '99999999-9999-4999-8999-999999999999'} : a)),
        );
      if (method === 'POST' && (m = /^\/v1\/adsquads\/([^/]+)\/ads$/.exec(path))) {
        const body = JSON.parse(raw);
        adWrites.push({path, body});
        for (const ad of body.ads) ads.push({...ad, id: 'ad' + (ads.length + 1), ad_squad_id: m[1]});
        if (lostAdReceipt) throw Error('Synthetic lost receipt after accepting the ad');
        return wrap(
          'ads',
          ads.filter(a => a.ad_squad_id === m[1]),
        );
      }
    },
  });
  return {
    ...f,
    ads,
    adWrites,
    creative,
    actor,
    call: input => f.service.call('amcp_campaign', input, actor),
    readCreative: () =>
      f.service.call(
        'snapchat_native_action',
        {
          action: 'snapchat_adaccounts_ad_account_id_creatives_get',
          account_id: 'acct1',
          connection_id: SNAP,
          aggregate_pages: true,
          max_pages: 25,
        },
        actor,
      ),
  };
}
