import {MirrorError} from './errors.js';
import type {Actor, JsonObject} from './types.js';
import {bad, obj, type ToolCall} from './workspace-core.js';

/**
 * A campaign plan built from an existing campaign (the owner's item 10, 2026-09-29: "clone this campaign with changes,
 * run from a spec" would have made a rebuild one command). The source is read through the ordinary account-scoped
 * native reads; the result is an ordinary draft plan, reviewed step by step or approved once. Only fields AMCP
 * already sends on create are copied (never guessed); every other field the source has is listed as not copied.
 * The new campaign starts PAUSED; its children keep their own status, which the paused campaign covers (the owner's
 * item 6 on Google, and decision 2 on Snapchat: paused-parents.ts).
 */
type Step = JsonObject;
const pick = (o: JsonObject, keys: string[]) =>
  Object.fromEntries(keys.filter(k => o[k] !== undefined && o[k] !== null).map(k => [k, o[k]]));
const unpicked = (o: JsonObject, keys: string[], skip: string[]) =>
  Object.keys(o).filter(k => !keys.includes(k) && !skip.includes(k));
async function read(call: ToolCall, actor: Actor, gateway: string, input: JsonObject): Promise<unknown> {
  const out = await call(gateway, input, actor);
  if (!out.success)
    throw new MirrorError(out.error.code, 'Reading the source failed: ' + out.error.message, out.error.details);
  if (out.data?.truncated)
    throw new MirrorError(
      'CLONE_SOURCE_TOO_LARGE',
      'The source did not fit in the pages AMCP reads; clone a smaller campaign.',
    );
  return out.data?.data;
}
// Snapchat: fields the repository's fixtures and families send on create.
const snapCampaignFields = [
  'name',
  'ad_account_id',
  'start_time',
  'end_time',
  'buy_model',
  'objective_v2_properties',
  'daily_budget_micro',
  'lifetime_spend_cap_micro',
];
const snapSquadFields = [
  'name',
  'type',
  'status',
  'targeting',
  'billing_event',
  'bid_strategy',
  'bid_micro',
  'daily_budget_micro',
  'lifetime_budget_micro',
  'optimization_goal',
  'pixel_id',
  'start_time',
  'end_time',
  'delivery_constraint',
  'pacing_type',
  'child_ad_type',
];
const snapAdFields = ['name', 'type', 'creative_id'];
const snapSystem = [
  'id',
  'created_at',
  'updated_at',
  'status',
  'campaign_id',
  'ad_squad_id',
  'ad_account_id',
  'delivery_status',
  'creation_state',
  'review_status',
  'review_status_reasons',
  'effective_status',
  'placement',
];
// A child keeps ACTIVE or PAUSED; any other state (a deleted one, say) is created PAUSED.
const snapStatus = (row: JsonObject) => (row.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED');
async function snapchatClone(call: ToolCall, actor: Actor, input: JsonObject) {
  const base = {connection_id: input.connection_id, account_id: input.account_id},
    id = String(input.source.campaign_id);
  const rows = (d: unknown, kind: string) =>
    ((obj(d) && Array.isArray(d[kind]) ? d[kind] : []) as JsonObject[])
      .map(w => w?.[kind.slice(0, -1)] ?? w)
      .filter(obj);
  const campaign = rows(
    await read(call, actor, 'snapchat_native_action', {...base, action: 'snapchat_campaign_list', result_ids: [id]}),
    'campaigns',
  )[0];
  if (!campaign)
    throw new MirrorError('CLONE_SOURCE_NOT_FOUND', 'Campaign ' + id + ' is not in this ad account’s campaign list.', {
      field: 'source.campaign_id',
    });
  const squads = rows(
      await read(call, actor, 'snapchat_native_action', {
        ...base,
        action: 'snapchat_adsquad_list',
        aggregate_pages: true,
      }),
      'adsquads',
    ).filter(s => s.campaign_id === id),
    squadIds = new Set(squads.map(s => s.id)),
    ads = rows(
      await read(call, actor, 'snapchat_native_action', {...base, action: 'snapchat_ad_list', aggregate_pages: true}),
      'ads',
    ).filter(a => squadIds.has(a.ad_squad_id));
  const step = (sid: string, args: JsonObject, depends: string[] = []): Step => ({
    id: sid,
    kind: 'write',
    gateway: 'snapchat_native_action',
    connection_id: input.connection_id,
    account_id: input.account_id,
    arguments: args,
    depends_on: depends,
  });
  const campaignRef = {$ref: 'campaign#/data/campaigns/0/campaign/id'};
  const steps: Step[] = [
    step('campaign', {
      action: 'snapchat_campaign_create',
      payload: {
        campaigns: [
          {...pick(campaign, snapCampaignFields), ad_account_id: input.account_id, name: input.name, status: 'PAUSED'},
        ],
      },
    }),
  ];
  const notCopied: JsonObject[] = [];
  const note = (entity: string, fields: string[]) => {
    if (fields.length) notCopied.push({entity, fields});
  };
  note('campaign', unpicked(campaign, snapCampaignFields, snapSystem));
  squads.forEach((s, i) => {
    const sid = 'squad_' + (i + 1);
    steps.push(
      step(
        sid,
        {
          action: 'snapchat_adsquad_create',
          path_params: {campaign_id: campaignRef},
          payload: {adsquads: [{...pick(s, snapSquadFields), campaign_id: campaignRef, status: snapStatus(s)}]},
        },
        ['campaign'],
      ),
    );
    // Snapchat never returns placement_v2 on GET: the clone uses Snapchat's default unless changes set it.
    note(sid, [...unpicked(s, snapSquadFields, snapSystem), 'placement_v2 (never readable)']);
    const squadRef = {$ref: sid + '#/data/adsquads/0/adsquad/id'},
      own = ads.filter(a => a.ad_squad_id === s.id);
    if (!own.length) return;
    // One step for the squad's ads: a list longer than 25 is reviewed in parts behind one approval.
    steps.push(
      step(
        sid + '_ads',
        {
          action: 'snapchat_ad_create',
          path_params: {ad_squad_id: squadRef},
          payload: {ads: own.map(a => ({...pick(a, snapAdFields), ad_squad_id: squadRef, status: snapStatus(a)}))},
        },
        [sid],
      ),
    );
    note(sid + '_ads', [...new Set(own.flatMap(a => unpicked(a, snapAdFields, snapSystem)))]);
  });
  return {steps, notCopied, source: {campaign_id: id, ad_squads: squads.length, ads: ads.length}};
}
// Google Search: the shapes the Google Search recipe creates (campaign-recipes.ts).
const googleBidding: Record<string, string> = {
  MANUAL_CPC: 'manualCpc',
  MAXIMIZE_CONVERSIONS: 'maximizeConversions',
  MAXIMIZE_CONVERSION_VALUE: 'maximizeConversionValue',
  TARGET_SPEND: 'targetSpend',
};
// An ad text asset's other fields (performance label, policy summary) are Google's output (google-ads-v25.json).
const textFields = ['text', 'pinnedField'];
const snakeKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(snakeKeys)
    : obj(v)
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k.replace(/[A-Z]/g, c => '_' + c.toLowerCase()), snakeKeys(x)]),
        )
      : v;
async function googleClone(call: ToolCall, actor: Actor, input: JsonObject) {
  const account = String(input.account_id).replace(/-/g, ''),
    id = String(input.source.campaign_id);
  if (!/^\d+$/.test(id))
    throw new MirrorError('INVALID_ARGUMENT', 'source.campaign_id is the numeric Google campaign ID.', {
      field: 'source.campaign_id',
    });
  const campaignName = 'customers/' + account + '/campaigns/' + id;
  const search = async (query: string) => {
    const d = await read(call, actor, 'google_ads_native_action', {
      action: 'google_ads_v23_google_ads_search',
      connection_id: input.connection_id,
      account_id: input.account_id,
      payload: {query},
      aggregate_pages: true,
    });
    return (obj(d) && Array.isArray(d.results) ? d.results : []) as JsonObject[];
  };
  const where = " WHERE campaign.resource_name = '" + campaignName + "'";
  const [source] = await search(
    'SELECT campaign.resource_name, campaign.name, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.contains_eu_political_advertising, campaign.network_settings.target_google_search, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network, campaign.network_settings.target_partner_search_network, campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas, campaign.target_spend.cpc_bid_ceiling_micros, campaign_budget.amount_micros, campaign_budget.delivery_method, campaign_budget.explicitly_shared FROM campaign' +
      where,
  );
  const c = source?.campaign as JsonObject | undefined;
  if (!c)
    throw new MirrorError('CLONE_SOURCE_NOT_FOUND', 'Campaign ' + id + ' is not in this customer.', {
      field: 'source.campaign_id',
    });
  if (c.advertisingChannelType !== 'SEARCH')
    throw new MirrorError(
      'CLONE_UNSUPPORTED',
      'AMCP clones Google Search campaigns; this one is ' + c.advertisingChannelType + '.',
      {
        field: 'source.campaign_id',
      },
    );
  const bidding = googleBidding[String(c.biddingStrategyType)];
  if (!bidding)
    throw new MirrorError(
      'CLONE_UNSUPPORTED',
      'AMCP clones manual CPC, maximize conversions, maximize conversion value and maximize clicks bidding; this campaign uses ' +
        c.biddingStrategyType +
        '.',
      {field: 'source.campaign_id', supported: Object.keys(googleBidding)},
    );
  const budget = (source!.campaignBudget ?? {}) as JsonObject;
  const criteria = await search(
    'SELECT campaign_criterion.type, campaign_criterion.negative, campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion' +
      where +
      " AND campaign_criterion.status != 'REMOVED'",
  );
  const groups = await search(
    'SELECT ad_group.resource_name, ad_group.name, ad_group.type, ad_group.cpc_bid_micros, ad_group.status FROM ad_group' +
      where +
      " AND ad_group.status != 'REMOVED'",
  );
  const keywords = await search(
    'SELECT ad_group_criterion.ad_group, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.negative, ad_group_criterion.cpc_bid_micros, ad_group_criterion.status FROM ad_group_criterion' +
      where +
      " AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'",
  );
  const ads = await search(
    'SELECT ad_group_ad.ad_group, ad_group_ad.status, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2 FROM ad_group_ad' +
      where +
      " AND ad_group_ad.status != 'REMOVED' AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'",
  );
  const response = '/data/results/0/resourceName',
    ref = (sid: string) => ({$ref: sid + '#' + response});
  const step = (sid: string, action: string, operations: JsonObject[], depends: string[] = []): Step => ({
    id: sid,
    kind: 'write',
    gateway: 'google_ads_native_action',
    connection_id: input.connection_id,
    account_id: input.account_id,
    arguments: {action, payload: {operations}},
    depends_on: depends,
  });
  const network = snakeKeys(c.networkSettings ?? {}) as JsonObject,
    strategy = snakeKeys((c as JsonObject)[bidding] ?? {}) as JsonObject;
  const steps: Step[] = [
    step('budget', 'google_ads_v23_campaign_budget_mutate_campaign_budgets', [
      {
        create: {
          name: input.name + ' budget',
          amount_micros: budget.amountMicros,
          delivery_method: budget.deliveryMethod ?? 'STANDARD',
          explicitly_shared: false,
        },
      },
    ]),
    step(
      'campaign',
      'google_ads_v23_campaign_mutate_campaigns',
      [
        {
          create: {
            name: input.name,
            status: 'PAUSED',
            advertising_channel_type: 'SEARCH',
            campaign_budget: ref('budget'),
            [bidding.replace(/[A-Z]/g, ch => '_' + ch.toLowerCase())]: strategy,
            network_settings: network,
            contains_eu_political_advertising: c.containsEuPoliticalAdvertising,
          },
        },
      ],
      ['budget'],
    ),
  ];
  const notCopied: JsonObject[] = [],
    skipped = new Set<string>();
  if (budget.explicitlyShared)
    notCopied.push({entity: 'budget', fields: ['explicitly_shared (the copy has its own budget of the same amount)']});
  const targeting = criteria.flatMap((r): JsonObject[] => {
    const k = r.campaignCriterion as JsonObject;
    if (k.type === 'LOCATION')
      return [
        {
          create: {
            campaign: ref('campaign'),
            location: {geo_target_constant: k.location?.geoTargetConstant},
            ...(k.negative ? {negative: true} : {}),
          },
        },
      ];
    if (k.type === 'LANGUAGE')
      return [{create: {campaign: ref('campaign'), language: {language_constant: k.language?.languageConstant}}}];
    if (k.type === 'KEYWORD' && k.negative)
      return [
        {
          create: {
            campaign: ref('campaign'),
            negative: true,
            keyword: {text: k.keyword?.text, match_type: k.keyword?.matchType},
          },
        },
      ];
    skipped.add(String(k.type) + (k.negative ? ' (negative)' : '') + ' criteria');
    return [];
  });
  if (skipped.size) notCopied.push({entity: 'targeting', fields: [...skipped]});
  if (targeting.length)
    steps.push(
      step('targeting', 'google_ads_v23_campaign_criterion_mutate_campaign_criteria', targeting, ['campaign']),
    );
  groups.forEach((g, i) => {
    const group = g.adGroup as JsonObject,
      sid = 'adgroup_' + (i + 1);
    steps.push(
      step(
        sid,
        'google_ads_v23_ad_group_mutate_ad_groups',
        [
          {
            create: {
              name: group.name,
              campaign: ref('campaign'),
              status: group.status,
              type: group.type,
              ...(group.cpcBidMicros !== undefined ? {cpc_bid_micros: String(group.cpcBidMicros)} : {}),
            },
          },
        ],
        ['campaign'],
      ),
    );
    const kws = keywords
      .map(k => k.adGroupCriterion as JsonObject)
      .filter(k => k.adGroup === group.resourceName)
      .map(k => ({
        create: {
          ad_group: ref(sid),
          ...(k.negative ? {negative: true} : {status: k.status}),
          keyword: {text: k.keyword?.text, match_type: k.keyword?.matchType},
          ...(k.cpcBidMicros !== undefined && !k.negative ? {cpc_bid_micros: String(k.cpcBidMicros)} : {}),
        },
      }));
    if (kws.length)
      steps.push(step(sid + '_keywords', 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria', kws, [sid]));
    const rsas = ads
      .map(a => a.adGroupAd as JsonObject)
      .filter(a => a.adGroup === group.resourceName)
      .map(a => ({
        create: {
          ad_group: ref(sid),
          status: a.status,
          ad: {
            responsive_search_ad: {
              ...pick(a.ad?.responsiveSearchAd ?? {}, ['path1', 'path2']),
              ...Object.fromEntries(
                (['headlines', 'descriptions'] as const).map(k => [
                  k,
                  ((a.ad?.responsiveSearchAd?.[k] ?? []) as JsonObject[]).map(t => snakeKeys(pick(t, textFields))),
                ]),
              ),
            },
            final_urls: a.ad?.finalUrls ?? [],
          },
        },
      }));
    if (rsas.length) steps.push(step(sid + '_ads', 'google_ads_v23_ad_group_ad_mutate_ad_group_ads', rsas, [sid]));
  });
  return {
    steps,
    notCopied,
    source: {campaign_id: id, ad_groups: groups.length, keywords: keywords.length, ads: ads.length},
  };
}
/** The steps of a plan that recreates the source campaign under the new name. */
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
async function tiktokClone(call: ToolCall, actor: Actor, input: JsonObject) {
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
// LinkedIn: the writable fields of the campaign group, campaign and creative schemas (Microsoft Learn, "Create and
// manage campaign groups / campaigns / creatives", li-lms-2026-05, read 2026-09-29), less the account, parent, name
// and status, which the clone sets. A creative keeps its content as read: a sponsored post is reused by reference.
const linkedinGroupFields = [
  'runSchedule',
  'totalBudget',
  'dailyBudget',
  'objectiveType',
  'budgetOptimization',
  'buyingType',
  'beneficiaryReference',
  'billingReference',
  'billingParentReference',
];
const linkedinCampaignFields = [
  'associatedEntity',
  'audienceExpansionEnabled',
  'costType',
  'creativeSelection',
  'dailyBudget',
  'locale',
  'objectiveType',
  'offsiteDeliveryEnabled',
  'offsitePreferences',
  'runSchedule',
  'targetingCriteria',
  'totalBudget',
  'type',
  'unitCost',
  'optimizationTargetType',
  'format',
  'pacingStrategy',
  'connectedTelevisionOnly',
  'optimizationPreference',
  'politicalIntent',
];
const linkedinCreativeFields = ['content', 'name', 'leadgenCallToAction'];
const linkedinSystem = [
  'id',
  'account',
  'accountInfo',
  'backfilled',
  'servingStatuses',
  'status',
  'test',
  'allowedCampaignTypes',
  'campaignGroup',
  'campaignGroupInfo',
  'associatedEntityInfo',
  'version',
  'versionTag',
  'isTest',
  'name',
  'campaign',
  'intendedStatus',
  'isServing',
  'review',
  'createdAt',
  'createdBy',
  'lastModifiedAt',
  'lastModifiedBy',
  'servingHoldReasons',
  'changeAuditStamps',
];
async function linkedinClone(call: ToolCall, actor: Actor, input: JsonObject) {
  const account = String(input.account_id),
    id = String(input.source.campaign_id);
  if (!/^[1-9][0-9]{0,19}$/.test(id))
    throw new MirrorError('INVALID_ARGUMENT', 'source.campaign_id is the numeric LinkedIn campaign group ID.', {
      field: 'source.campaign_id',
    });
  const base = {connection_id: input.connection_id, account_id: account},
    groupUrn = 'urn:li:sponsoredCampaignGroup:' + id;
  // The group is read under the selected account's path: LinkedIn answers 404 for a group the account does not hold.
  const group = await read(call, actor, 'linkedin_native_action', {
    ...base,
    action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaign_groups_ad_campaign_groups_id_get',
    path_params: {ad_campaign_groups_id: id},
  }).catch(e => {
    if (e instanceof MirrorError && e.details.http_status === 404) return undefined;
    throw e;
  });
  if (!obj(group) || String(group.id) !== id)
    throw new MirrorError('CLONE_SOURCE_NOT_FOUND', 'Campaign group ' + id + ' is not in this ad account.', {
      field: 'source.campaign_id',
    });
  const elements = (d: unknown) => (obj(d) && Array.isArray(d.elements) ? d.elements : []).filter(obj) as JsonObject[];
  const campaigns = elements(
    await read(call, actor, 'linkedin_native_action', {
      ...base,
      action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_get',
      restli_method: 'FINDER',
      query: {q: 'search', search: {campaignGroup: {values: [groupUrn]}}, pageSize: 100},
      aggregate_pages: true,
    }),
  ).filter(c => c.campaignGroup === groupUrn);
  const urns = campaigns.map(c => 'urn:li:sponsoredCampaign:' + c.id);
  const creatives = urns.length
    ? elements(
        await read(call, actor, 'linkedin_native_action', {
          ...base,
          action: 'linkedin_rest_ad_accounts_ad_account_id_creatives_get',
          restli_method: 'FINDER',
          query: {q: 'criteria', campaigns: urns, pageSize: 100},
          aggregate_pages: true,
        }),
      ).filter(c => urns.includes(String(c.campaign)))
    : [];
  const step = (sid: string, action: string, payload: JsonObject, depends: string[] = []): Step => ({
    id: sid,
    kind: 'write',
    gateway: 'linkedin_native_action',
    connection_id: input.connection_id,
    account_id: account,
    arguments: {action, payload},
    depends_on: depends,
  });
  const notCopied: JsonObject[] = [];
  const note = (entity: string, row: JsonObject, keys: string[]) => {
    const fields = Object.keys(row).filter(k => !keys.includes(k) && !linkedinSystem.includes(k));
    if (fields.length) notCopied.push({entity, fields});
  };
  // LinkedIn returns a new ID in x-restli-id (the receipt's created_id); children name their parent by URN.
  const steps: Step[] = [
    step('group', 'linkedin_rest_ad_accounts_ad_account_id_ad_campaign_groups_post', {
      ...pick(group, linkedinGroupFields),
      account: 'urn:li:sponsoredAccount:' + account,
      name: input.name,
      status: 'PAUSED',
    }),
  ];
  note('group', group, linkedinGroupFields);
  campaigns.forEach((c, i) => {
    const sid = 'campaign_' + (i + 1);
    steps.push(
      step(
        sid,
        'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post',
        {
          ...pick(c, linkedinCampaignFields),
          account: 'urn:li:sponsoredAccount:' + account,
          campaignGroup: {$ref: 'group#/created_id', prefix: 'urn:li:sponsoredCampaignGroup:'},
          name: c.name,
          status: 'PAUSED',
        },
        ['group'],
      ),
    );
    note(sid, c, linkedinCampaignFields);
    const own = creatives.filter(cr => cr.campaign === 'urn:li:sponsoredCampaign:' + c.id);
    for (const cr of own.filter(cr => !obj(cr.content)))
      notCopied.push({entity: String(cr.id), fields: ['the whole creative: LinkedIn returned no content to reuse']});
    own
      .filter(cr => obj(cr.content))
      .forEach((cr, j) => {
        steps.push(
          step(
            sid + '_creative_' + (j + 1),
            'linkedin_rest_ad_accounts_ad_account_id_creatives_post',
            {
              ...pick(cr, linkedinCreativeFields),
              campaign: {$ref: sid + '#/created_id', prefix: 'urn:li:sponsoredCampaign:'},
              intendedStatus: 'PAUSED',
            },
            [sid],
          ),
        );
        note(sid + '_creative_' + (j + 1), cr, linkedinCreativeFields);
      });
  });
  return {
    steps,
    notCopied,
    source: {campaign_id: id, campaigns: campaigns.length, creatives: creatives.length},
  };
}
const cloneGateways = [
  'snapchat_native_action',
  'google_ads_native_action',
  'tiktok_native_action',
  'linkedin_native_action',
];
/** Checked before any connection is resolved, so an unsupported platform is named as such. */
export function assertCloneGateway(gateway: unknown) {
  if (!cloneGateways.includes(gateway as string))
    throw new MirrorError(
      'CLONE_UNSUPPORTED',
      'AMCP clones Snapchat, Google Search, TikTok and LinkedIn campaigns. Meta copies campaigns natively (meta copies); other platforms take explicit steps.',
      {field: 'gateway', supported: cloneGateways},
    );
}
export async function clonePlan(call: ToolCall, actor: Actor, input: JsonObject) {
  if (
    !obj(input.source) ||
    (typeof input.source.campaign_id !== 'string' && typeof input.source.campaign_id !== 'number')
  )
    throw new MirrorError('INVALID_ARGUMENT', 'Name the campaign to clone as source: {campaign_id}.', {
      field: 'source',
    });
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100)
    throw new MirrorError('INVALID_ARGUMENT', 'Give the new campaign a name of 1–100 characters.', {field: 'name'});
  const cloned =
    input.gateway === 'snapchat_native_action'
      ? await snapchatClone(call, actor, input)
      : input.gateway === 'google_ads_native_action'
        ? await googleClone(call, actor, input)
        : input.gateway === 'tiktok_native_action'
          ? await tiktokClone(call, actor, input)
          : input.gateway === 'linkedin_native_action'
            ? await linkedinClone(call, actor, input)
            : undefined;
  if (!cloned) return assertCloneGateway(input.gateway) as never;
  // Steps whose uncopied fields are the same are listed once.
  const groups = new Map<string, JsonObject>();
  for (const n of cloned.notCopied) {
    const key = JSON.stringify(n.fields);
    const g = groups.get(key) ?? {fields: n.fields, steps: []};
    g.steps.push(n.entity);
    groups.set(key, g);
  }
  return {...cloned, notCopied: [...groups.values()]};
}
const isRef = (v: unknown) => obj(v) && Object.hasOwn(v, '$ref');
/**
 * The spec's changes. set: [{step_id, path, value}] sets one field of a step's arguments, by JSON pointer, including
 * a field the source did not have (such as placement_v2) when its parent exists; never the action or a $ref.
 * drop: [step_id] leaves a step out, with every step that depends on it. Nothing here is sent anywhere: each step
 * is still reviewed with every check before it is written.
 */
export function applyCloneChanges(steps: Step[], changes: unknown) {
  if (changes === undefined) return {steps, set: [] as JsonObject[], dropped: [] as string[]};
  if (!obj(changes) || Object.keys(changes).some(k => !['set', 'drop'].includes(k)))
    bad('changes is {set: [{step_id, path, value}], drop: [step_id]}.', 'INVALID_ARGUMENT', {field: 'changes'});
  const ids = steps.map(s => s.id as string),
    drop: unknown = changes.drop ?? [];
  if (!Array.isArray(drop) || drop.some(d => !ids.includes(d)))
    bad('changes.drop lists step IDs of this clone.', 'INVALID_ARGUMENT', {field: 'changes.drop', allowed: ids});
  const gone = new Set<string>(drop as string[]);
  // Steps are in dependency order, so one pass reaches every dependant.
  for (const s of steps) if ((s.depends_on as string[]).some(d => gone.has(d))) gone.add(s.id);
  const kept = steps.filter(s => !gone.has(s.id));
  if (!kept.length) bad('changes.drop leaves nothing to create.', 'INVALID_ARGUMENT', {field: 'changes.drop'});
  const set: unknown = changes.set ?? [];
  if (!Array.isArray(set) || set.length > 50)
    bad('changes.set is a list of at most 50 {step_id, path, value}.', 'INVALID_ARGUMENT', {field: 'changes.set'});
  const applied = (set as unknown[]).map((c, i) => {
    const where = 'changes.set[' + i + ']';
    if (!obj(c) || Object.keys(c).sort().join() !== 'path,step_id,value')
      bad(where + ' must be exactly {step_id, path, value}.', 'INVALID_ARGUMENT', {field: where});
    const step = kept.find(s => s.id === c.step_id);
    if (!step)
      bad(where + '.step_id ' + JSON.stringify(c.step_id) + ' is not a step of this clone.', 'INVALID_ARGUMENT', {
        field: where + '.step_id',
        allowed: kept.map(s => s.id),
      });
    const keys =
      typeof c.path === 'string' && /^(\/[^/]+)+$/.test(c.path)
        ? c.path
            .slice(1)
            .split('/')
            .map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'))
        : [];
    if (!keys.length || keys[0] === 'action' || keys.some(k => ['__proto__', 'prototype', 'constructor'].includes(k)))
      bad(
        where +
          '.path must be a JSON pointer into the step’s arguments other than its action, such as "/payload/operations/0/create/amount_micros".',
        'INVALID_ARGUMENT',
        {field: where + '.path'},
      );
    if (JSON.stringify(c.value ?? null).includes('"$ref"'))
      bad(where + '.value contains a $ref. Dependencies stay as the clone declares them.', 'INVALID_ARGUMENT', {
        field: where + '.value',
      });
    let parent: any = step.arguments;
    for (const k of keys.slice(0, -1)) {
      if (isRef(parent)) break;
      parent = Array.isArray(parent) ? (/^(0|[1-9][0-9]*)$/.test(k) ? parent[Number(k)] : undefined) : parent?.[k];
    }
    const last = keys.at(-1)!;
    if (isRef(parent) || JSON.stringify(parent?.[last] ?? null).includes('"$ref"'))
      bad(
        where + '.path ' + c.path + ' is, or holds, a $ref to a predecessor’s verified result; it cannot be set.',
        'INVALID_ARGUMENT',
        {
          field: where + '.path',
        },
      );
    const fits = Array.isArray(parent) ? /^(0|[1-9][0-9]*)$/.test(last) && Number(last) < parent.length : obj(parent);
    if (!fits)
      bad(
        where +
          '.path ' +
          c.path +
          ' does not lead into step ' +
          JSON.stringify(step.id) +
          '’s arguments: its parent must exist.',
        'INVALID_ARGUMENT',
        {field: where + '.path'},
      );
    const added = !Array.isArray(parent) && !Object.hasOwn(parent, last);
    parent[last] = structuredClone(c.value);
    return {step_id: step.id, path: c.path, ...(added ? {added: true} : {})};
  });
  return {steps: kept, set: applied, dropped: steps.filter(s => gone.has(s.id)).map(s => s.id as string)};
}
// A Google copy is one all-or-nothing step built by the shared composer (CMP-04 moved it to google-atomic-builds.ts).
export {composeGoogleBuild} from './google-atomic-builds.js';
