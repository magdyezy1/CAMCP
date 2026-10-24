import {MirrorError} from './errors.js';
import type {Actor, JsonObject} from './types.js';
import {obj, type ToolCall} from './workspace-core.js';
import {read, type Step} from './campaign-clone-core.js';

// TikTok's campaign clone, its adapter's `campaign.clone` (ARC-01 phase B, wave 4c: moved verbatim from
// src/campaign-clone.ts, which keeps the checks every clone passes and the spec's changes).
// TikTok: the create fields of the official SDK models (tiktok-business-api-sdk python_sdk/docs CampaignCreateBody,
// AdgroupCreateBody, AdcreateCreatives, read 2026-09-29), less identity, request IDs and status, which the clone sets.
const tiktokCampaignFields = [
  'app_id',
  'app_promotion_type',
  'bid_type',
  'budget',
  'budget_mode',
  'budget_optimize_on',
  'campaign_app_profile_page_state',
  'campaign_product_source',
  'campaign_type',
  'catalog_enabled',
  'deep_bid_type',
  'disable_skan_campaign',
  'internal_channel',
  'is_advanced_dedicated_campaign',
  'is_search_campaign',
  'objective_type',
  'optimization_goal',
  'plugin_partner',
  'po_number',
  'postback_window_mode',
  'rf_campaign_type',
  'roas_bid',
  'rta_bid_enabled',
  'rta_id',
  'rta_product_selection_enabled',
  'sales_destination',
  'special_industries',
  'virtual_objective_type',
];
const tiktokAdgroupFields = [
  'actions',
  'adgroup_app_profile_page_state',
  'adgroup_name',
  'age_groups',
  'app_config',
  'app_id',
  'attribution_event_count',
  'audience_ids',
  'audience_rule',
  'audience_type',
  'automated_keywords_enabled',
  'bid_display_mode',
  'bid_price',
  'bid_type',
  'billing_event',
  'blocked_pangle_app_ids',
  'brand_safety_partner',
  'brand_safety_type',
  'budget',
  'budget_mode',
  'carrier_ids',
  'catalog_authorized_bc_id',
  'catalog_id',
  'category_exclusion_ids',
  'click_attribution_window',
  'comment_disabled',
  'contextual_tag_ids',
  'conversion_bid_price',
  'creative_material_mode',
  'custom_conversion_id',
  'dayparting',
  'deep_bid_type',
  'deep_cpa_bid',
  'deep_funnel_event_source',
  'deep_funnel_event_source_id',
  'deep_funnel_optimization_event',
  'deep_funnel_optimization_status',
  'device_model_ids',
  'device_price_ranges',
  'engaged_view_attribution_window',
  'excluded_audience_ids',
  'excluded_custom_actions',
  'excluded_pangle_audience_package_ids',
  'frequency',
  'frequency_schedule',
  'gender',
  'household_income',
  'identity_authorized_bc_id',
  'identity_id',
  'identity_type',
  'included_custom_actions',
  'included_pangle_audience_package_ids',
  'interest_category_ids',
  'interest_keyword_ids',
  'ios14_targeting',
  'is_hfss',
  'is_lhf_compliance',
  'isp_ids',
  'languages',
  'location_ids',
  'message_event_set_id',
  'messaging_app_account_id',
  'messaging_app_type',
  'min_android_version',
  'min_ios_version',
  'network_types',
  'next_day_retention',
  'operating_systems',
  'optimization_event',
  'optimization_goal',
  'pacing',
  'phone_number',
  'phone_region_calling_code',
  'phone_region_code',
  'pixel_id',
  'placement_type',
  'placements',
  'product_source',
  'promotion_target_type',
  'promotion_type',
  'promotion_website_type',
  'purchase_intention_keyword_ids',
  'roas_bid',
  'saved_audience_id',
  'schedule_end_time',
  'schedule_start_time',
  'schedule_type',
  'search_keywords',
  'search_result_enabled',
  'secondary_optimization_event',
  'share_disabled',
  'shopping_ads_retargeting_actions_days',
  'shopping_ads_retargeting_custom_audience_relation',
  'shopping_ads_retargeting_type',
  'shopping_ads_type',
  'skip_learning_phase',
  'smart_audience_enabled',
  'smart_interest_behavior_enabled',
  'spending_power',
  'statistic_type',
  'store_authorized_bc_id',
  'store_id',
  'tiktok_subplacements',
  'vbo_window',
  'vertical_sensitivity_id',
  'video_download_disabled',
  'view_attribution_window',
  'zipcode_ids',
];
const tiktokCreativeFields = [
  'ad_format',
  'ad_name',
  'ad_text',
  'ad_texts',
  'aigc_disclosure_type',
  'app_name',
  'auto_disclaimer_types',
  'auto_message_id',
  'avatar_icon_web_uri',
  'brand_safety_postbid_partner',
  'brand_safety_vast_url',
  'call_to_action',
  'call_to_action_id',
  'card_id',
  'carousel_image_index',
  'catalog_id',
  'click_tracking_url',
  'cpp_url',
  'creative_authorized',
  'creative_type',
  'dark_post_status',
  'deeplink',
  'deeplink_format_type',
  'deeplink_type',
  'deeplink_utm_params',
  'disclaimer_clickable_texts',
  'disclaimer_text',
  'disclaimer_type',
  'display_name',
  'dynamic_destination',
  'dynamic_format',
  'end_card_cta',
  'fallback_type',
  'identity_authorized_bc_id',
  'identity_id',
  'identity_type',
  'image_ids',
  'impression_tracking_url',
  'instant_product_page_used',
  'item_duet_status',
  'item_group_ids',
  'item_stitch_status',
  'landing_page_url',
  'music_id',
  'page_id',
  'page_image_index',
  'phone_number',
  'phone_region_calling_code',
  'phone_region_code',
  'playable_url',
  'product_display_field_list',
  'product_set_id',
  'product_specific_type',
  'promotional_music_disabled',
  'schedule_id',
  'shopping_ads_deeplink_type',
  'shopping_ads_fallback_type',
  'shopping_ads_video_package_id',
  'showcase_products',
  'sku_ids',
  'tiktok_item_id',
  'tiktok_page_category',
  'tracking_app_id',
  'tracking_message_event_set_id',
  'tracking_offline_event_set_ids',
  'tracking_pixel_id',
  'utm_params',
  'vehicle_ids',
  'vertical_video_strategy',
  'video_id',
  'video_view_tracking_url',
  'viewability_postbid_partner',
  'viewability_vast_url',
];
const tiktokSystem = [
  'advertiser_id',
  'campaign_id',
  'adgroup_id',
  'ad_id',
  'create_time',
  'modify_time',
  'operation_status',
  'secondary_status',
  'campaign_name',
];
/** A field the source holds: TikTok reads an unset text field as "" and an unset value as null. */
const held = (row: JsonObject, keys: string[]) =>
  Object.fromEntries(keys.filter(k => row[k] !== undefined && row[k] !== null && row[k] !== '').map(k => [k, row[k]]));
export async function tiktokClone(call: ToolCall, actor: Actor, input: JsonObject) {
  const account = String(input.account_id),
    id = String(input.source.campaign_id);
  if (!/^\d+$/.test(id))
    throw new MirrorError('INVALID_ARGUMENT', 'source.campaign_id is the numeric TikTok campaign ID.', {
      field: 'source.campaign_id',
    });
  const list = async (action: string) => {
    const d = await read(call, actor, 'tiktok_native_action', {
      action,
      connection_id: input.connection_id,
      account_id: account,
      query: {advertiser_id: account, filtering: {campaign_ids: [id]}, page_size: 100},
      aggregate_pages: true,
    });
    const rows = obj(d) && obj(d.data) && Array.isArray(d.data.list) ? d.data.list : [];
    return (rows as unknown[]).filter(obj).filter(r => String(r.campaign_id) === id);
  };
  const [campaign] = await list('tiktok_campaign_get');
  if (!campaign)
    throw new MirrorError('CLONE_SOURCE_NOT_FOUND', 'Campaign ' + id + ' is not in this advertiser.', {
      field: 'source.campaign_id',
    });
  const adgroups = await list('tiktok_adgroup_get'),
    ads = await list('tiktok_ad_get');
  const step = (sid: string, action: string, payload: JsonObject, depends: string[] = []): Step => ({
    id: sid,
    kind: 'write',
    gateway: 'tiktok_native_action',
    connection_id: input.connection_id,
    account_id: account,
    arguments: {action, payload},
    depends_on: depends,
  });
  const notCopied: JsonObject[] = [];
  const note = (entity: string, row: JsonObject, keys: string[]) => {
    const fields = Object.keys(row).filter(
      k => !keys.includes(k) && !tiktokSystem.includes(k) && row[k] !== null && row[k] !== '',
    );
    if (fields.length) notCopied.push({entity, fields});
  };
  const campaignRef = {$ref: 'campaign#/data/data/campaign_id'};
  const steps: Step[] = [
    step('campaign', 'tiktok_campaign_create', {
      ...held(campaign, tiktokCampaignFields),
      advertiser_id: account,
      campaign_name: input.name,
      operation_status: 'DISABLE',
    }),
  ];
  note('campaign', campaign, tiktokCampaignFields);
  // Children keep their own status under the disabled campaign (paused-parents.ts, the owner's decision 2).
  const status = (row: JsonObject) => (row.operation_status === 'ENABLE' ? 'ENABLE' : 'DISABLE');
  adgroups.forEach((g, i) => {
    const sid = 'adgroup_' + (i + 1);
    steps.push(
      step(
        sid,
        'tiktok_adgroup_create',
        {
          ...held(g, tiktokAdgroupFields),
          advertiser_id: account,
          campaign_id: campaignRef,
          operation_status: status(g),
        },
        ['campaign'],
      ),
    );
    note(sid, g, tiktokAdgroupFields);
    // TikTok reviews one ad per request.
    ads
      .filter(a => String(a.adgroup_id) === String(g.adgroup_id))
      .forEach((a, j) => {
        steps.push(
          step(
            sid + '_ad_' + (j + 1),
            'tiktok_ad_create',
            {
              advertiser_id: account,
              adgroup_id: {$ref: sid + '#/data/data/adgroup_id'},
              creatives: [{...held(a, tiktokCreativeFields), operation_status: status(a)}],
            },
            [sid],
          ),
        );
        note(sid + '_ad_' + (j + 1), a, tiktokCreativeFields);
      });
  });
  return {steps, notCopied, source: {campaign_id: id, ad_groups: adgroups.length, ads: ads.length}};
}
