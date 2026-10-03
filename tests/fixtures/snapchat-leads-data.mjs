import {fixture, actor, SNAP} from '../../dist/tests/snapchat-plan-fixture.js';
import {trafficBusiness} from './snapchat-traffic-data.mjs';
export {actor, SNAP};
export const leadBusiness = {
  ...trafficBusiness,
  name: 'Synthetic Snapchat lead generation',
  optimization_goal: 'LEAD_FORM_SUBMISSIONS',
};
export function leadFixture(options = {}) {
  const creative = {
      id: leadBusiness.creative_id,
      ad_account_id: 'acct1',
      name: 'Synthetic lead creative',
      type: 'LEAD_GENERATION',
      lead_generation_form_id: 'form1',
      review_status: 'APPROVED',
    },
    form = {
      id: 'form1',
      ad_account_id: 'acct1',
      name: 'Synthetic lead form',
      title: 'Synthetic contact request',
      description: 'Synthetic test form description',
      privacy_policy_url: 'https://example.test/privacy',
      form_fields: [{type: 'EMAIL'}],
      legal_disclosures: {text: 'Synthetic consent statement'},
    },
    ads = [],
    adWrites = [];
  const wrap = (kind, rows) =>
    Response.json({
      request_status: 'SUCCESS',
      paging: {},
      [kind]: rows.map(row => ({sub_request_status: 'SUCCESS', [kind.slice(0, -1)]: row})),
    });
  const f = fixture({
    routes: (method, path, url, raw) => {
      if (method === 'GET' && path === '/v1/adaccounts/acct1/creatives') return wrap('creatives', [creative]);
      if (method === 'GET' && path === '/v1/creatives/' + creative.id) {
        options.beforeCreativeRead?.(f, creative);
        return wrap('creatives', [creative]);
      }
      if (method === 'GET' && path === '/v1/adaccounts/acct1/lead_generation_forms') {
        if (options.partialForms)
          return Response.json({
            request_status: 'SUCCESS',
            lead_generation_forms: [{sub_request_status: 'SUCCESS', lead_generation_form: form}],
            paging: {
              next_link:
                'https://adsapi.snapchat.com/v1/adaccounts/acct1/lead_generation_forms?cursor=' +
                ((Number(url.searchParams.get('cursor')) || 0) + 1),
            },
          });
        return wrap(
          'lead_generation_forms',
          options.missingForm ? [] : [{...form, ad_account_id: options.listFormOwner ?? form.ad_account_id}],
        );
      }
      if (method === 'GET' && path === '/v1/lead_generation_forms/' + form.id) {
        options.beforeFormRead?.(f, form);
        return wrap('lead_generation_forms', [form]);
      }
      if (method === 'GET' && path === '/v1/adaccounts/acct1/ads') return wrap('ads', ads);
      let m;
      if (method === 'GET' && (m = /^\/v1\/ads\/([^/]+)$/.exec(path)))
        return wrap(
          'ads',
          ads.filter(a => a.id === m[1]),
        );
      if (method === 'GET' && (m = /^\/v1\/adsquads\/([^/]+)\/ads$/.exec(path)))
        return wrap(
          'ads',
          ads.filter(a => a.ad_squad_id === m[1]),
        );
      if (method === 'POST' && (m = /^\/v1\/adsquads\/([^/]+)\/ads$/.exec(path))) {
        const body = JSON.parse(raw);
        adWrites.push({method, path, body});
        for (const ad of body.ads)
          ads.push({...ad, id: 'ad' + (ads.length + 1), ad_squad_id: m[1], ad_account_id: 'acct1'});
        if (options.lostAdReceipt) throw Error('Synthetic lost accepted ad receipt');
        return wrap(
          'ads',
          ads.filter(a => a.ad_squad_id === m[1]),
        );
      }
    },
  });
  return {
    ...f,
    creative,
    form,
    ads,
    adWrites,
    campaign: input => f.service.call('amcp_campaign', input, actor),
    write: input => f.service.call('amcp_write', input, actor),
    inspect: async () => {
      for (const action of ['snapchat_creative_list', 'snapchat_lead_generation_forms_list']) {
        const out = await f.service.call(
          'snapchat_native_action',
          {action, account_id: 'acct1', connection_id: SNAP, aggregate_pages: true, max_pages: 25},
          actor,
        );
        if (!out.success) throw Error(JSON.stringify(out.error));
      }
      const c = f.store.resolveConnection(actor, 'snapchat_native_action', 'acct1', SNAP);
      f.squads.set('squad-existing', {
        id: 'squad-existing',
        campaign_id: 'campaign-existing',
        ad_account_id: 'acct1',
        status: 'PAUSED',
        type: 'SNAP_ADS',
        child_ad_type: 'LEAD_GENERATION',
      });
      f.store.rememberResource(c, 'acct1', 'adsquads/squad-existing');
    },
  };
}
export const nativeAd = {
  gateway: 'snapchat_native_action',
  connection_id: SNAP,
  arguments: {
    account_id: 'acct1',
    action: 'snapchat_ad_create',
    path_params: {ad_squad_id: 'squad-existing'},
    payload: {
      ads: [
        {
          name: 'Synthetic lead ad',
          ad_squad_id: 'squad-existing',
          creative_id: leadBusiness.creative_id,
          type: 'LEAD_GENERATION',
          status: 'PAUSED',
        },
      ],
    },
  },
};
