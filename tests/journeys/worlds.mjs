// The synthetic Google Ads customers and TikTok advertisers of journeys J10 to J24 (R2.5 M4a), each composed from the fixture of the
// package that wrote the journey's feature (tests/fixtures/*): nothing here is copied from them. A journey attaches one to the harness's
// fetcher with `serveGoogle` or `serveTikTok`, which also gives Client A's login for it, and the harness then records every request the
// fake answers like any other provider request. Every ID is synthetic and nothing here reaches a provider.
import {
  existingAssets as retailAssets,
  retailPmaxBuild,
  retailResponder,
} from '../fixtures/google-pmax-retail-tree.mjs';
import {at as shoppingAt, shoppingBuild, shoppingResponder} from '../fixtures/google-shopping-build.mjs';
import {
  demandGenAssetRows,
  demandGenAssets,
  demandGenBuild,
  demandGenBuildArguments,
  demandGenResponder,
} from '../fixtures/google-demand-gen-build.mjs';
import {smartPlusWebAdvertiser, smartPlusWebBriefs} from '../fixtures/tiktok-smart-plus-web.mjs';
import {tiktokSearchAdvertiser, tiktokSearchBrief} from '../fixtures/tiktok-search-build.mjs';
import {smartPlusSearchAdvertiser, smartPlusSearchBriefs} from '../fixtures/tiktok-smart-plus-search.mjs';
import {editsWorld, utcText} from '../fixtures/tiktok-smart-plus-edits.mjs';
import {nativeAdUpdate, nativeAdWorld} from '../fixtures/tiktok-ad-update-native.mjs';

export {utcText};
export const googleGateway = 'google_ads_native_action';
export const tiktokGateway = 'tiktok_native_action';
export const googleConnection = 'aaaaaaaa-5555-4555-8555-00000000000e';
export const tiktokConnection = 'aaaaaaaa-5555-4555-8555-00000000000f';
/** The production execution policy (server/runtime.ts): a Google prepare sends the provider's validate-only request by default. */
export const productionPolicy = Object.freeze({providerCheckByDefault: true});

const login = (f, id, gateway, label, accounts, writeAccounts) =>
  f.store.putConnection(
    f.admin,
    {id, tenantId: f.actor.tenantId, gateway, accounts, writeAccounts, enabled: true, label, scopes: []},
    {accessToken: 'synthetic-' + id.slice(-1)},
  );

/**
 * Google Ads answers every request about a customer it refuses with the permission error Google sends: the twin of Meta's account
 * 456, which the login holds and the provider refuses.
 */
const refusingCustomer = (fetch, customer) => async (raw, init) =>
  new URL(String(raw)).pathname.includes('/customers/' + customer + '/')
    ? Response.json(
        {error: {code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission'}},
        {status: 403},
      )
    : fetch(raw, init);

/**
 * TikTok answers every request about an advertiser it refuses with code 40001, the role and asset access denial of its error table (the
 * answer is HTTP 200, as TikTok's are), whether the advertiser is named in the query or in the body.
 */
const refusingAdvertiser = (fetch, advertiser) => async (raw, init) => {
  const url = new URL(String(raw)),
    named = url.searchParams.get('advertiser_id') ?? (init?.body ? JSON.parse(String(init.body)).advertiser_id : null);
  return String(named) === advertiser
    ? Response.json({code: 40001, message: 'No permission to operate this advertiser', request_id: 'r', data: {}})
    : fetch(raw, init);
};

/** Client A's Google Ads login: customer 123 is writable, 456 is read-write on the login and refused by the provider. */
export function serveGoogle(f, fetch) {
  f.providers.attach('googleads.googleapis.com', refusingCustomer(fetch, '456'));
  login(f, googleConnection, googleGateway, 'Client A Google Ads', ['123', '456'], ['123', '456']);
}
/** Client A's TikTok login: advertisers 123 and 7001 are writable, 7002 is held by the login and refused by the provider. */
export function serveTikTok(f, fetch) {
  f.providers.attach('business-api.tiktok.com', refusingAdvertiser(fetch, '7002'));
  login(f, tiktokConnection, tiktokGateway, 'Client A TikTok', ['123', '7001', '7002'], ['123', '7001', '7002']);
}

// ---- J10, J11, J12: Google Ads builds ------------------------------------------------------------------------------------------------

/** J10: a retail Performance Max asset group with its 24-node product tree, in one build (trees' builder and fake Google). */
export function retailWorld(options = {}) {
  return {...retailResponder(options), build: retailPmaxBuild, assets: retailAssets};
}
/** J11: a Standard Shopping campaign with its product tree, in one build (trees' builder and fake Google). */
export function shoppingWorld(options = {}) {
  return {...shoppingResponder(options), build: shoppingBuild};
}
/** J12: a Demand Gen launch (targeting's builder and fake Google, which answers the validate-only request as `validation` says). */
export function demandGenWorld(options = {}) {
  const responder = demandGenResponder(options);
  return {
    ...responder,
    fetch: responder.fetcher,
    build: demandGenBuild,
    arguments: demandGenBuildArguments,
    assets: demandGenAssets,
    assetRows: demandGenAssetRows,
  };
}
/**
 * J11 with its ad group and ad under an existing Shopping campaign whose row does not say whether it serves (the account's read names the campaign
 * and its Shopping settings and no status): the parent is unread, and the ENABLED ad group would serve under a parent AMCP cannot see (join 3 of the
 * M3 merge). The build leaves out the budget, campaign and campaign criteria the full J11 creates.
 */
export function shoppingUnderUnreadCampaign() {
  const parent = shoppingAt('campaigns', '40');
  const build = shoppingBuild({adGroup: {campaign: parent, status: 'ENABLED'}})
    .filter(o => !o.campaign_budget_operation && !o.campaign_operation && !o.campaign_criterion_operation)
    .map(o =>
      o.ad_group_ad_operation
        ? {ad_group_ad_operation: {create: {...o.ad_group_ad_operation.create, status: 'ENABLED'}}}
        : o,
    );
  return {build, campaigns: {[parent]: {advertisingChannelType: 'SHOPPING', shoppingSetting: {merchantId: '555'}}}};
}
/** The `arguments` of a one-request Google Ads build for customer `account`, as `amcp_write` prepare takes them. */
export const googleBuildArguments = (operations, account = '123', extra = {}) => ({
  action: 'google_ads_v23_google_ads_mutate',
  account_id: account,
  payload: {mutate_operations: operations, ...extra},
});
/** A build, or the arguments of one, made for another customer: every resource name of customer 123 names `customer` instead. */
export const forCustomer = (value, customer) =>
  JSON.parse(JSON.stringify(value).replaceAll('customers/123/', 'customers/' + customer + '/'));

// ---- J15, J16, J24: TikTok launches and their go-live ---------------------------------------------------------------------------------

/** J15: the Upgraded Smart+ website packs (smartweb's briefs and advertiser 7001). */
export function smartWebWorld(options = {}) {
  return {...smartPlusWebAdvertiser(options), briefs: smartPlusWebBriefs(tiktokConnection)};
}
/** J16: the guided Search pack (search's brief and advertiser 7001, with its allowlist mode). */
export function searchWorld(options = {}) {
  return {...tiktokSearchAdvertiser(options), brief: tiktokSearchBrief(tiktokConnection)};
}
/** J24: Upgraded Smart+ Search (search2's briefs and advertiser 7001). */
export function smartSearchWorld(options = {}) {
  return {...smartPlusSearchAdvertiser(options), briefs: smartPlusSearchBriefs(tiktokConnection)};
}

// ---- J17, J18: edits of TikTok ads and ad groups --------------------------------------------------------------------------------------

/** J17: smartedits' advertiser 123 (lead and website Spark ads, pixels and ad groups that have not started), served as another provider. */
export function editsAdvertiser(options = {}) {
  const world = editsWorld(options);
  return {...world, fetch: world.handle};
}
/** J18: classic's advertiser 123 for the native `tiktok_ad_update` (ads 400 to 429 in ad group 200, and 450 in 201). */
export function nativeEditsAdvertiser(options = {}) {
  return {...nativeAdWorld(options), update: nativeAdUpdate};
}
