import {googleResponder} from '../../dist/tests/helpers/google-write-fake.js';

/**
 * The synthetic Demand Gen launch of journey J12 (R2.5 M3, G6, L2-12; package r25-m3-targeting), which the M3 merge's journey reuses:
 * the build an agent sends to `google_ads_v23_google_ads_mutate`, the existing image assets its ads link, and a fake Google that
 * answers it, validate-only included. Customer 123 and DNU names only; nothing here is a client's. The build is one all-or-nothing
 * request: a budget, a PAUSED DEMAND_GEN campaign, an ad group with its location and language (on the AD GROUP: Google's Demand Gen
 * pages put them there, and AMCP refuses the campaign-level form), and two multi-asset ads that link the existing images.
 */
export const demandGenAccount = '123';
export const demandGenCampaignName = 'DNU Demand Gen launch';
/** The existing image assets the ads link: 1.91:1 marketing, square marketing and logo images of the account (synthetic IDs). */
export const demandGenAssets = Object.freeze({
  marketing: 'customers/123/assets/9001',
  square: 'customers/123/assets/9002',
  logo: 'customers/123/assets/9003',
});
/** What a search of the account's assets returns of them, as the fake serves it. */
export const demandGenAssetRows = Object.freeze({
  [demandGenAssets.marketing]: {name: 'DNU marketing image', type: 'IMAGE', width: 1200, height: 628},
  [demandGenAssets.square]: {name: 'DNU square image', type: 'IMAGE', width: 1200, height: 1200},
  [demandGenAssets.logo]: {name: 'DNU logo', type: 'IMAGE', width: 128, height: 128},
});
const ad = (name, headline) => ({
  ad_group_ad_operation: {
    create: {
      ad_group: 'customers/123/adGroups/-3',
      status: 'PAUSED',
      ad: {
        name,
        final_urls: ['https://example.test/'],
        demand_gen_multi_asset_ad: {
          business_name: 'DNU Brand',
          headlines: [{text: headline}],
          descriptions: [{text: 'Free returns on every order.'}],
          marketing_images: [{asset: demandGenAssets.marketing}],
          square_marketing_images: [{asset: demandGenAssets.square}],
          logo_images: [{asset: demandGenAssets.logo}],
          call_to_action_text: 'Shop now',
        },
      },
    },
  },
});
/**
 * The J12 build: `mutate_operations` of `google_ads_v23_google_ads_mutate`, nine operations. Location 2818 and language 1000 are the
 * Google constants the White Friday report used; the geography is on the ad group, as a Demand Gen campaign takes it.
 */
export function demandGenBuild({name = demandGenCampaignName} = {}) {
  return [
    {
      campaign_budget_operation: {
        create: {
          resource_name: 'customers/123/campaignBudgets/-1',
          name: name + ' budget',
          amount_micros: '50000000',
          delivery_method: 'STANDARD',
          explicitly_shared: false,
        },
      },
    },
    {
      campaign_operation: {
        create: {
          resource_name: 'customers/123/campaigns/-2',
          name,
          status: 'PAUSED',
          advertising_channel_type: 'DEMAND_GEN',
          campaign_budget: 'customers/123/campaignBudgets/-1',
          maximize_conversions: {},
          contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
        },
      },
    },
    {
      ad_group_operation: {
        create: {
          resource_name: 'customers/123/adGroups/-3',
          name: name + ' ad group',
          campaign: 'customers/123/campaigns/-2',
          status: 'PAUSED',
        },
      },
    },
    {
      ad_group_criterion_operation: {
        create: {ad_group: 'customers/123/adGroups/-3', location: {geo_target_constant: 'geoTargetConstants/2818'}},
      },
    },
    {
      ad_group_criterion_operation: {
        create: {ad_group: 'customers/123/adGroups/-3', language: {language_constant: 'languageConstants/1000'}},
      },
    },
    ad(name + ' ad A', 'Shoes for every run'),
    ad(name + ' ad B', 'New season, new pace'),
  ];
}
/** The arguments of the build's call: `amcp_write` prepare takes them as `arguments`, with the gateway beside them. */
export const demandGenBuildArguments = (build = demandGenBuild()) => ({
  action: 'google_ads_v23_google_ads_mutate',
  account_id: demandGenAccount,
  payload: {mutate_operations: build, partial_failure: false},
});
/**
 * A fake Google that answers the build: its reads of the customer and of the existing assets, the validate-only request (`validation`:
 * pass by default, or reject, outage, rate_limit or forbidden), the one mutate that applies the whole build, and the read-backs of
 * what it created. It is a `fetch` for a transport (`responder.fetcher`), with the log of what it was sent (`responder.log`: kind
 * read, validation or write), the resources it created (`responder.created`) and the validate-only answer to change
 * (`responder.state.validation`).
 */
export function demandGenResponder(options = {}) {
  return googleResponder({world: {assets: {...demandGenAssetRows}}, ...options});
}
