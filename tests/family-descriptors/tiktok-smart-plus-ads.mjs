// tiktok_smart_plus_ads: POST /v1.3/smart_plus/ad/create/ (API for Business v1.3, "Create an Upgraded Smart+ Ad"),
// a paused Spark Ad from an existing post. The ad serves where its ad group places it, so the decisive field is the ad
// group's `placement_type` in "Get Upgraded Smart+ Ad Groups": placements changed after the review change where the
// reviewed ad would deliver.
import {failed, list, ok} from './_tiktok.mjs';

const url = 'https://shop.example.test/sale?utm_source=tiktok';

export default {
  family: 'tiktok_smart_plus_ads',
  risk: 'settings',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_smart_plus_ad_create',
    payload: {
      adgroup_id: '300',
      ad_name: 'Spark sale',
      operation_status: 'DISABLE',
      creative_list: [
        {
          creative_info: {
            ad_format: 'SINGLE_VIDEO',
            tiktok_item_id: '9001',
            identity_type: 'TT_USER',
            identity_id: 'tt-1',
          },
        },
      ],
      landing_page_url_list: [{landing_page_url: url}],
      ad_configuration: {
        call_to_action_id: '700',
        creative_auto_add_toggle: false,
        creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY'],
        utm_params: [{key: 'utm_source', value: 'tiktok'}],
      },
    },
  },
  seed: () => ({
    groups: {
      300: {
        adgroup_id: '300',
        campaign_id: '80',
        promotion_type: 'WEBSITE',
        optimization_goal: 'CONVERT',
        placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
        operation_status: 'DISABLE',
      },
    },
    ads: {},
  }),
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/smart_plus/ad/create/'),
  provider({method, url: u, path, body, state, mode}) {
    const q = k => u.searchParams.get(k);
    if (method === 'GET' && path.endsWith('/v1.3/smart_plus/adgroup/get/')) {
      const ids = JSON.parse(q('filtering')).adgroup_ids;
      return list(
        ids.filter(id => state.groups[id]).map(id => structuredClone(state.groups[id])),
        mode.paginate,
      );
    }
    if (method === 'GET' && path.endsWith('/v1.3/smart_plus/ad/get/')) {
      const f = JSON.parse(q('filtering'));
      return list(
        Object.values(state.ads)
          .filter(a =>
            f.smart_plus_ad_ids
              ? f.smart_plus_ad_ids.includes(a.smart_plus_ad_id)
              : f.adgroup_ids.includes(a.adgroup_id),
          )
          .map(a => structuredClone(a)),
      );
    }
    if (method === 'GET' && path.endsWith('/v1.3/identity/info/'))
      return ok({
        identity_info: {
          identity_id: q('identity_id'),
          identity_type: q('identity_type'),
          display_name: 'Synthetic',
          available_status: 'AVAILABLE',
          can_pull_video: true,
          is_gpppa: false,
        },
      });
    if (method === 'GET' && path.endsWith('/v1.3/identity/video/info/'))
      return ok({
        video_details: JSON.parse(q('item_ids')).map(id => ({
          item_id: id,
          item_type: 'VIDEO',
          status: 'ITEM_STATUS_HESITATE_RECOMMEND',
          text: 'Synthetic post',
          carousel_info: null,
          video_info: {duration: 12.5, width: 720, height: 1280},
        })),
      });
    if (method === 'GET' && path.endsWith('/v1.3/creative/portfolio/get/'))
      return ok({portfolio_content: [{asset_ids: ['201781'], asset_content: 'learn_more'}]});
    if (method === 'POST' && path.endsWith('/v1.3/smart_plus/ad/create/')) {
      if (mode.partial) return failed('Post is not available for Spark Ads');
      const id = String(5001 + Object.keys(state.ads).length);
      state.ads[id] = {
        smart_plus_ad_id: id,
        adgroup_id: body.adgroup_id,
        ad_name: body.ad_name,
        operation_status: body.operation_status,
        creative_list: body.creative_list.map((c, i) => ({
          ad_material_id: 'm' + i,
          material_operation_status: 'ENABLE',
          creative_info: c.creative_info,
        })),
        landing_page_url_list: body.landing_page_url_list,
        ad_configuration: body.ad_configuration,
      };
      return ok(structuredClone(state.ads[id]));
    }
  },
  decisive: {
    change: state =>
      Object.assign(state.groups[300], {
        placement_type: 'PLACEMENT_TYPE_NORMAL',
        placements: ['PLACEMENT_TIKTOK', 'PLACEMENT_PANGLE'],
      }),
    field: /placement/,
  },
};
