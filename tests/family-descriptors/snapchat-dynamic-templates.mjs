// snapchat_dynamic_templates: PUT /v1/adaccounts/{ad_account_id}/dynamic_templates (Snapchat Marketing API v1, "Dynamic
// Product Ads", Dynamic Templates; each template sent whole with its id). The template's `layout` decides how every
// dynamic creative that names it renders its products, and the update overwrites it, so it is the decisive field in
// "Get all Dynamic Templates": a layout changed in Snapchat after the review would be silently replaced.
import {failed, ok, page, rows} from './_snapchat.mjs';

const renderer = 'https://ads-interfaces.sc-cdn.net/adformats/templates/V2/index.html';
const template = {
  ad_account_id: 'acct1',
  name: 'Price card',
  ios_url: renderer,
  android_url: renderer,
  layout: 'FILL_WIDTH',
  text_fields: ['title', 'price'],
  background_color: 'FFFFFF',
};

export default {
  family: 'snapchat_dynamic_templates',
  risk: 'settings',
  gateway: 'snapchat_native_action',
  account: 'acct1',
  request: {
    action: 'snapchat_adaccounts_ad_account_id_dynamic_templates_update',
    params: {ad_account_id: 'acct1'},
    payload: {dynamic_templates: [{id: 'dt-1', ...template, text_fields: ['title', 'salePrice']}]},
  },
  seed: () => ({
    templates: {'dt-1': {id: 'dt-1', ...structuredClone(template)}},
    creatives: [{id: 'cr1', name: 'Catalog ad', dynamic_render_properties: {dynamic_template_id: 'dt-1'}}],
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path === '/v1/adaccounts/acct1/dynamic_templates')
      return page('dynamic_templates', 'dynamic_template', Object.values(state.templates), mode.paginate, url);
    if (method === 'GET' && path === '/v1/adaccounts/acct1/creatives')
      return page('creatives', 'creative', state.creatives, false, url);
    if (method === 'PUT' && path === '/v1/adaccounts/acct1/dynamic_templates') {
      if (mode.partial) return failed('dynamic_templates', body.dynamic_templates);
      for (const t of body.dynamic_templates) Object.assign(state.templates[t.id], t);
      return ok({
        dynamic_templates: rows(
          'dynamic_template',
          body.dynamic_templates.map(t => state.templates[t.id]),
        ),
      });
    }
  },
  decisive: {change: state => (state.templates['dt-1'].layout = 'CAROUSEL'), field: /dt-1.*layout/},
};
