// A valid brief for every recipe of the catalog, from the guide's own synthetic examples (Skills/amcp-campaign-builder/examples/contracts.json).
// Shared by the tests of what each recipe declares and accepts (R2.5 field3, package r25-field3-recipes). Synthetic values only.
import {readFileSync} from 'node:fs';

const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
const {cpc_bid: _cpcBid, ...googleShared} = examples.recipe_business;
const goals = {conversion_goal_policy: 'ACCOUNT_DEFAULT'},
  values = {...goals, conversion_value_policy: 'ACCOUNT_RECORDED_VALUES'},
  metaConversion = {pixel_id: '456', click_attribution_days: '7', view_attribution_days: '1'};

export const recipeExamples = examples;
export const recipeBriefs = {
  google_search: {...googleShared, cpc_bid: '1.25'},
  google_search_clicks: {...googleShared, cpc_bid_ceiling: '1.25'},
  google_search_conversions: {...googleShared, ...goals},
  google_search_target_cpa: {...googleShared, ...goals, target_cpa: '15'},
  google_search_conversion_value: {...googleShared, ...values},
  google_search_target_roas: {...googleShared, ...values, target_roas: '3.5'},
  google_performance_max: examples.google_pmax_business,
  meta_website_traffic: examples.recipe_business,
  meta_website_sales: {...examples.recipe_business, ...metaConversion},
  meta_website_leads: {...examples.recipe_business, ...metaConversion},
  microsoft_search: examples.recipe_business,
  snapchat_website_traffic: examples.snapchat_traffic_business,
  snapchat_lead_generation: examples.snapchat_lead_business,
  tiktok_website_traffic: examples.tiktok_traffic_business,
  tiktok_website_conversions: examples.tiktok_conversion_business,
  tiktok_search_traffic: examples.tiktok_search_business,
  tiktok_smart_plus_website_traffic: examples.tiktok_smart_plus_traffic_business,
  tiktok_smart_plus_website_conversions: examples.tiktok_smart_plus_conversion_business,
  tiktok_smart_plus_search_website: examples.tiktok_smart_plus_search_business,
  linkedin_lead_generation: examples.linkedin_lead_business,
};
