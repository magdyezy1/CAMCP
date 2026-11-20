import type {JsonObject} from './types.js';
import {metaCreativeFields} from './creative-validation.js';
import {providerVersions} from './provider-hooks.js';
import {sha256, stable} from './security.js';
import manifest from './provider-contract-manifest.json' with {type: 'json'};

export interface ProviderContractRecord {
  contract_version: number;
  reviewed_at: string;
  contract_digest: string;
}
/** Each provider's recorded contract version, review date and the digest of the content they were recorded for. */
export const providerContractRecords: Record<string, ProviderContractRecord> = manifest.providers;
function contractRecord(id: string): ProviderContractRecord {
  const record = providerContractRecords[id];
  if (!record) throw Error('src/provider-contract-manifest.json has no record for provider ' + id);
  return record;
}
/** Keys that describe a contract's record rather than its content: contract_digest leaves them out (ACC-05). */
const recordKeys = new Set([
  'contract_version',
  'reviewed_at',
  'contract_digest',
  'owner_role',
  'live_qualification',
  'fixture_evidence',
]);
/**
 * The digest of a provider contract's content (ACC-05): every field except its record metadata and its test lists. A
 * change to write_scope, api_version or any other stated boundary changes it; adding a test or a review date does not.
 */
export function contractDigest(contract: JsonObject): string {
  const content = Object.fromEntries(
    Object.entries(contract).filter(([key]) => !recordKeys.has(key) && !/(?:^|_)tests$/.test(key)),
  );
  return 'sha256:' + sha256(stable(content));
}

/** The version AMCP sends a provider's requests at, as its adapter declares it (src/<provider>-adapter.ts versions). */
const sentAt = (id: string): string => providerVersions(id)!.current();
/** Maintained contract boundaries, not inferred from generated action counts. */
export const providerContracts: JsonObject[] = [
  [
    'google',
    'google_ads',
    sentAt('google'),
    'google-ads',
    'google-ads',
    'campaigns, budgets, targeting, ads; Demand Gen ad-group location and language targeting (exclusions, and location and language at the campaign level of a Demand Gen campaign, stay unqualified); ad groups, asset groups, ads and ad-group criteria created ENABLED under a parent the review reads as serving, with spending confirmation, refused under an activation-forbidding policy and when a parent cannot be read; campaign/ad-group/customer/asset-group asset links; declared labels, customizers, ad parameters, campaign groups, conversion variables, remarketing actions, signals and exclusions; qualified asset sets, complete feed membership, saved Keyword Planner hierarchies and complete ad-group device/hotel bid-modifier reviews plus exact existing Search campaign call-modifier update/removal with client-owned portfolio dependencies; customer-scoped audience signals (demographic dimensions and customer-owned segments; asset-group audiences stay unqualified); rule-based remarketing user lists from Google tag parameters with explicit lookback windows (Customer Match, lookalike, logical and basic lists and list removal stay unqualified); conversion value rules (ADD and MULTIPLY with audience, device and location conditions) and ordered rule sets for the account or a campaign, with each rule checked against the set dimensions (SET actions, itineraries, store-visit categories and NO_CONDITION sets stay unqualified); reusable custom audience and custom interest definitions with complete member replacement and exact native deletion; client-owned portfolio creation, exact immutable-type updates and unassociated removal with complete campaign/shared-budget dependencies; client-account bidding seasonality adjustments and data exclusions with full event history, account-local dates and current campaign/budget/portfolio dependencies; client-owned manual conversion definition create/update/remove with full goal dependencies, exact value units and automatic standard-goal verification; client-owned conversion goals with standard biddability, custom membership, campaign inheritance and verified follow-up attachment; atomic same-type recommendation dismissal with complete target/state verification, without applying suggestions or changing subscriptions; administrator-only client-account user invitations, revocation, role changes and removal with complete membership snapshots, policy checks and native pending-authorization handling; Performance Max asset groups with their text assets and links created under an existing Performance Max campaign in one all-or-nothing build, with minimums checked before anything is sent and every created resource read back; Performance Max retail listing group trees (create and remove, leaves first, up to 10 asset groups per review) and Standard Shopping listing group trees of one ad group per review (create and remove, bids on units), with complete tree reads, structural validation and read-back by shape, and either tree inside an all-or-nothing build with its new asset group or ad group (webpage listing groups stay unqualified); Performance Max brand guideline enablement (irreversible, 1-10 campaigns) with campaign, asset and brand link reads, asset requirement checks, spending confirmation and read-back of links, colors and font; user list customer types (attach and remove) with list eligibility, conflict and conversion tracking checks; campaign drafts (create, rename, remove, and promotion with confirmation and asynchronous read-back); system-managed experiments and their arms in SETUP (create, edit, remove) with name, status, control campaign and traffic split checks and read-back; experiment scheduling, ending, promotion and graduation with status, arm, campaign and budget checks, spending confirmation for serving changes and asynchronous read-back; account settings (auto-tagging, tracking template, final URL suffix, name, call reporting, video suitability) with read-back; removal of automatically created ad and campaign assets with source checks; YouTube upload privacy and removal with video asset usage reads; auto-apply recommendation subscriptions (create, enable, pause) with spending confirmation to enable; Smart campaign settings (landing page, phone, language, business) with read-back; applying keyword and campaign budget recommendations with recommendation, budget and keyword reads, spending confirmation and read-back; removing labels from the customer account with customer label reads under the login customer and read-back (applying a label to a customer stays unqualified); Customer Match people added and removed and offline click conversions sent through the Data Manager API on accounts the owner turned on, hashed in memory with only counts and a digest kept, with the list or conversion action read first, consent taken from the uploader, the Customer Match terms field sent only on the uploader confirmation, and verification by request status',
    'google-legacy',
    'https://developers.google.com/google-ads/api/docs/start',
  ],
  [
    'meta',
    'meta',
    sentAt('meta'),
    'meta',
    'meta',
    'campaigns, ad sets, creatives, ads; paused native copies of campaigns and ad sets (with at most three children) and ads into owned targets, with copied campaign and ad set budgets checked as new budgets (override and asynchronous copies stay unqualified); lookalike audiences from an owned, unflagged seed audience (customer-file, website, engagement and conversion lookalikes stay unqualified); creative creation rechecks advertiser/Page/Instagram identity and existing native content ownership at prepare and execute; complete account-label creation, renaming, deletion and existing-label attachment to ads, campaigns and creatives; bounded asynchronous account/campaign/ad-set Insights jobs with scoped polling and result retrieval; value rule sets (create, complete update, delete) checked against the account list; Advantage+ account controls and empty publisher block list creation; renaming and deleting ad creatives and custom audiences of the account with object reads and read-back; deleting unused library images and creating custom conversions on account pixels with list reads and read-back; removing library videos no creative of the account uses, with complete video and creative list reads and read-back; creating an account pixel and renaming pixels of its own business with pixel list reads and read-back (matching and data use settings stay unqualified); ad account name, EU payor and beneficiary defaults and notifications with account read-back (spending caps stay unqualified); split tests of ad sets or campaigns of the selected account on its business, and study name, description and end changes, with account, object, study and cell reads, spending confirmation and read-back (lift studies and creative tests stay unqualified); scheduled budget increases (high demand periods) of daily-budget campaigns and ad sets on accounts with a spending policy, with the full increase held against its caps, account time zone and maximum extra spend in the review, spending confirmation and read-back of the schedule list (Meta documents no API update or deletion of a period); creatives that opt out of the v26.0 WEBSITE_AND_SHOP destination only when asked, verified on read-back or against the write response; creatives that choose Advantage+ creative features one by one (an explicit OPT_IN or OPT_OUT for each listed single feature of Meta’s SDK 26.0.2 in degrees_of_freedom_spec.creative_features_spec, at v26.0 only, never chosen by AMCP), with the choices in the review and compared on read-back (bundles, feature customizations and catalog features stay unqualified); product sets of catalogs of the account business (create, change, delete) with the documented filter grammar, a check with Meta that the filter selects at least one product, the account ad sets and creatives that use a set (a set in use is not deleted, and one live ad sets use is not emptied) and read-back (shop publishing and collection metadata stay unqualified); catalog products one at a time with the documented fields, an existing retailer_id replaced only with an explicit allow_upsert and shown before and after, and the price read back through the numeric price filter (shops, checkout, app links, variants and item batches stay unqualified); scheduled product feeds (create, change, delete) of catalogs of the account business with an explicit deletion choice, HTTPS schedules without credentials, the documented effect of deleting a feed on its ads, and read-back (supplementary and localized feeds, feed rules, file uploads and moving items stay unqualified); commerce catalogs of the account business (create, change name, display settings and images, delete with the live product set block of Meta kept) with account, catalog, set and feed reads and read-back (partner integrations, segments and other verticals stay unqualified); automated rules (create, full or status-only update and delete through the documented rule routes AMCP maps) with the rule and named-object reads: rules that raise budgets, bids or delivery name their objects of the account, carry a limit, need a spending policy whose caps bound the worst case of each object, and spending confirmation, with read-back (webhook pings stay unqualified); customer lists under the approved personal-data policy: empty CUSTOM lists created, and people added and removed up to 10,000 per request, hashed in memory with only counts and a digest kept, on accounts the owner turned on, uploads executed by the owner, with the terms and list read first and verification by Meta counts (value-based lists and whole-list replacement stay unqualified); offline conversions through the Conversions API under the same policy: up to 1,000 standard events per request from email, phone, chat, store, system or messaging sources, the people hashed in memory and the events shown in aggregate, to a pixel of the account read first, within 7 days (62 for store events), stated as not recallable, executed by the owner and verified by the count Meta received (website and app events stay unqualified)',
    'meta-provision',
    'https://developers.facebook.com/docs/marketing-apis/',
  ],
  [
    'tiktok',
    'tiktok',
    'v1.3',
    'tiktok-snapchat',
    'tiktok-snapchat',
    "campaigns, ad groups, ads; custom (CUSTOMIZED_USER) identity creation with a square library avatar (TikTok-account identities stay unqualified; deleting unused custom identities is listed below); lookalike audience creation from an owned, available seed (customer files, refresh and sharing stay unqualified); manual ad group lifetime and next-day scheduled budget updates under the owner spending policy (campaign-budget-optimized ad groups stay unqualified; Upgraded Smart+ ad group budgets are listed below); custom conversion creation on an owned pixel with documented rules and read-back (app sources and custom event mapping stay unqualified; renaming and deletion are listed below); saved audience creation with documented targeting fields and owned, available referenced audiences (deleting unused saved audiences is listed below); pausing and enabling Upgraded Smart+ campaigns, ad groups and ads with complete per-ID receipts (deletion and SKAN postback windows stay unqualified); immediate Upgraded Smart+ ad group budget updates under the owner spending policy (scheduled budgets are allowlist-only and stay unqualified); paused Upgraded Smart+ website-conversion and lead-generation campaign creation (app, catalog, search, promotional, iOS dedicated and RTA campaigns stay unqualified); paused Upgraded Smart+ website-conversion and Instant Form lead generation ad group creation with per-mode targeting allowlists, pixel, custom conversion and owned-audience checks (other ad group types stay unqualified); Upgraded Smart+ campaign name, budget and PO number edits with the budget under the owner spending policy (Goal-based budget increase stays unqualified); dynamic call-to-action portfolio creation from recommended CTA groups, and manual ads that name a CTA portfolio must reference an existing one without call_to_action beside it (card, sticker, showcase, gesture and superlike portfolios stay unqualified); paused Upgraded Smart+ website (conversion, click and landing page view goals, with no catalog) and Instant Form lead generation Spark Ads from existing TikTok posts with available TikTok account identities, a published advertiser Instant Form or landing page, a CTA portfolio, explicit automatic creative switches and product information left off (the value goal, catalog ad groups, uploads, authorization-code posts, custom identities and product information modes other than UNSET stay unqualified), with every violation of the request's own shape answered at once; Search Ads negative keywords of manual campaigns and ad groups with Automatic Search Placement (add, replace, update, delete) with complete keyword list reads; account Pangle app block list and Brand Safety Hub defaults; edits of the name, posts, landing page and configuration of those ads, with removed posts listed and their removal from an enabled ad acknowledged, and product information never set to UNSET over a mode that is on; Upgraded Smart+ ad group name, end time, dayparting, comment, share and custom bid edits, with the campaign ad groups whose bids change alongside shown (targeting edits stay unqualified); pausing and enabling explicitly selected creatives inside Upgraded Smart+ ads with complete receipts (automatically added creatives stay unqualified); new manual non-Spark ads with custom identities are refused in ad groups that deliver on TikTok, and a manual ad create in an ad group of an Upgraded Smart+ campaign is refused with the Smart+ create named; ad comment blocked words (create, replace, delete, export tasks) with complete list reads and read-back; hiding and unhiding ad comments against the comment list of a caller-given scope of one ad, ad group or campaign and at most 31 days, keeping no comment text or author, with per-comment receipts and read-back (replies and deletion stay unqualified); renaming and deleting pixel custom conversions with pixel, conversion and ad group reads and read-back; deleting unused saved audiences and custom identities with ad group and ad reads and read-back; ad, Upgraded Smart+ and creative previews and Smart Text suggestions as reads that change nothing (a preview link expires after 30 days and may need a platform sign-in); renaming custom audiences, converting unused ones to Reach & Frequency, deleting unused unshared ones and including, excluding or disconnecting one in ad groups, with audience and ad group reads and read-back; renaming library images and videos and deleting ones no ad or Upgraded Smart+ ad uses, with asset and ad reads and read-back; audiences by rule (website traffic on owned pixels, ad engagement on owned ad groups, lead generation) with source reads and read-back (app, shop, business account, offline and organic audiences stay unqualified); pixel creation and renaming of owned pixels with complete pixel list reads and read-back (partner integrations and advanced matching stay unqualified); editing library images into new sized copies with source image reads and read-back of the new image; change log download tasks with advertiser and filtered object reads, checked until they succeed",
    'write-platforms',
    'https://business-api.tiktok.com/portal/docs',
  ],
  [
    'snapchat',
    'snapchat',
    'v1',
    'tiktok-snapchat',
    'tiktok-snapchat',
    'campaigns, ad squads, creatives, ads; lead generation form creation with owned banner/form dependency reads (lead reports and webhooks stay unqualified); creative updates that change top-snap media or the lead form must reference owned resources; customer-list and lookalike segment creation with owned seeds, and segment name/description/retention updates (user uploads and pixel/mobile/engagement rule audiences stay unqualified; audience segment deletion is listed below); reviewed creative collection PUT and existing JSON Patch; exact nested ad/ad-squad PATCH and complete collection PUT with parent ownership, native budget policy and read-back; the targeting of ad squads with 500 criteria or fewer replaced as one replace /targeting JSON Patch with account, campaign, ad squad and segment list reads (added segments of the account, included ones READY), a per-dimension diff, spending confirmation, widening of an active ad squad counted as activation, and read-back in any order and case; reserved/Smart Budgets and identity edits need separate contracts; planning reads (audience insights and reach and frequency forecasts) that estimate and create nothing; media copy from other ad accounts of the same organization with source account and media reads, receipt ownership and read-back; offer disclaimers created and deleted with account disclaimer reads, name checks and read-back; audience segment deletion with segment and ad squad targeting reads and read-back; custom conversions of pixels of the account (create, delete) with pixel and conversion reads and read-back; product sets of the catalogs of the organization of the account (create, update, delete) with organization, catalog, set, ad squad and creative reads and read-back; COMMERCE catalogs of the organization of the account (create, whole-object update with pixels of the account as event sources, deletion of empty catalogs only) with organization, catalog, pixel, feed and set reads and read-back (catalog roles and Snap App event sources stay unqualified); the product feed of a catalog (create, whole update, delete) with HTTPS schedules checked against the interval table and no credentials, and read-back (supplemental feeds and feed uploads stay unqualified); dynamic templates (create, update) with template, media and creative reads and read-back; event details for Reminder creatives (create, delete) with event and creative reads and read-back; pixel renames at account and organization level with account and pixel reads and read-back; claiming an organic Snap into the ad account media library by its Snap ID, with account read and media read-back (claims by ad code stay unqualified); the GEO targeting spec of ad squads with more than 500 criteria (up to 4,000) replaced with ad squad, campaign and spec reads, spending confirmation and read-back in any order and case',
    'snapchat-writes',
    'https://developers.snap.com/marketing-api/Ads-API/introduction',
  ],
  [
    'linkedin',
    'linkedin',
    '202609',
    'linkedin-x',
    'linkedin-x',
    'campaign groups, campaigns, creatives; organization-authored non-feed single-media DSC posts with exact organization/media bindings; scoped single and batch campaign conversion association writes with complete membership verification; Insight Tag conversion-rule creation and partial updates with exact account impact and native read-back; account-owned saved-audience creation, partial edits and single/batch deletion with complete membership, private-segment dependencies and exact native receipt/read-back; DRAFT lead gen form creation for the selected ad account with account-scoped form reads and exact read-back (publishing, edits, archiving, organization forms and lead responses stay unqualified); dynamic UTM tracking parameters of campaigns (create, replace with the current idempotency token, delete; account level from LinkedIn-Version 202608) with account, campaign and parameter reads and exact read-back; DoubleClick third-party tracking tags of creatives (create, delete) with account, creative and current tag reads and read-back; Message Ads InMail content and Conversation Ads conversations and message trees (create, update, delete) with account, conversation, message, content and lead form reads, whole-tree checks and read-back; Insight Tag creation (one per account) and the first-party tracking switch with account, tag and permission reads and read-back; A/B tests (create, update by execution state, delete while pending) with campaign group checks, spending confirmation to run them and read-back; blocking and allowing Insight Tag domains (single and batch) with tag, FULL access and domain reads and read-back; Audience Network publisher lists (registering an uploaded list, replacing the account allow and block lists) with list and preference reads and read-back; publishing draft and archiving published lead gen forms with form reads, spending confirmation and read-back (form content edits stay unqualified); batch deletion of DRAFT campaign groups without campaigns and of creatives that are DRAFT or in DRAFT campaigns, with entity, campaign and campaign search reads and read-back; edits (commentary, landing page, call to action) and deletion of DSC posts AMCP created, with post and sponsoring creative reads, spending confirmation for edits and read-back; ad account name and notification switches with account reads and read-back (status, reference and immutable fields stay unqualified); brand lift tests (create as DRAFT, update by execution state, delete before scheduling, and survey question deletion) with account, campaign group, test, survey and resumable-test reads, spending confirmation to run them and read-back (creating survey questions stays unqualified); engagement retargeting audiences (DMP segments of an ad engagement source created, renamed and deleted, and their engagement rules on the account campaigns added and removed) with account, segment, rule and campaign reads, a live-campaign usage check before deletion and read-back (list uploads, streaming, company, page, event and website audiences stay unqualified)',
    'linkedin-posts',
    'https://learn.microsoft.com/en-us/linkedin/marketing/',
  ],
  [
    'x',
    'x_ads',
    '12',
    'linkedin-x',
    'linkedin-x',
    'campaigns, line items, targeting; atomic reviewed create/delete audience batches on paused line items with complete membership and current private-reference verification; single website cards, nullcast Tweets, library registration and explicit active promotions; unpublished draft create/update/hard-delete and explicitly reviewed preview notifications; reviewed asynchronous analytics jobs with original-login status and bounded server-side gzip retrieval; line item tracking tags (create, URL update, delete) with tag, line item and current tag reads and read-back; promoted accounts, media creatives and scheduled promoted Tweets of line items (create with activation confirmation, delete) with line item, campaign, promotable user, account media or scheduled Tweet reads and read-back; curated categories of pre-roll line items (create and replace with confirmation, delete) with line item, category and association reads and read-back; call-to-action buttons of pre-roll line items (create, change, delete) with line item, campaign and button reads and read-back; media library edits and deletions and account media deletions with media, poster, card and media creative usage reads and read-back; promoted-only scheduled Tweets (create, edit before publication, delete) with author, card, media and promotion reads and read-back; custom audience placeholders, renames and deletions with name, ownership and targeting reads and read-back; new poll, image conversation and video conversation cards with media library and feature reads and read-back; conversation card edits and poll and conversation card deletions with the website card usage scan; campaign and line item batches (paused creates, updates or deletions, one operation type per batch) with funding instrument, campaign and entity reads, per-entity budget policy and read-back; product catalogs of FULL promotable users (create one per user, rename, delete when empty), product sets (filtered and manual create, manual update, delete with a warning that ad use cannot be checked), one scheduled feed per catalog (HTTPS, no credentials) and single products (create or replace, delete by key, found within the first 1,000) with promotable user, catalog, set, feed and product reads and read-back',
    'x-creative-writes',
    'https://docs.x.com/x-ads-api/introduction',
  ],
  [
    'microsoft',
    'microsoft_ads',
    'v13',
    'microsoft-ads',
    null,
    'Search campaigns, ad groups, responsive search ads, keywords; existing extension associations at account/campaign/ad-group levels',
    'microsoft',
    'https://learn.microsoft.com/en-us/advertising/guides/',
  ],
  [
    'apple',
    'apple_ads',
    'v1',
    'dv360-and-measurement',
    null,
    'campaigns, ad groups, ads, creatives, keywords, negative keywords and shared budgets; every affected account requires a grant and policy checks',
    'measurement-apple',
    'https://github.com/apple/apple-ads-platform-api-node',
  ],
  [
    'reddit',
    'reddit',
    'v3',
    'reddit',
    null,
    'classic campaigns, ad groups, existing-post ads, saved audiences; the conversion pixel of ad groups and CBO campaigns checked against the pixel list of the ad account, with its last event shown and a warning when it never fired or is stale; scoped legacy and asynchronous structured posts, community promotion and comment updates; onsite lead-form creation ended with Reddit’s 2026-09-21 withdrawal and is refused (Reddit pauses ads using those forms on 2026-09-30)',
    'reddit-writes',
    'https://ads-api.reddit.com/docs/v3/',
  ],
  [
    'dv360',
    'dv360',
    'v4',
    'dv360-and-measurement',
    'dv360',
    'campaigns, insertion orders, line items, creatives; advertiser-owned channel, location and negative-keyword lists with complete membership review; line item targeting (bulk edit, create, delete) with complete assigned-targeting reads, inherited-targeting and limit checks and advertiser-owned list references, and audience groups with every audience read under advertiser access and advertiserId-scoped audience reads (inventory-source assignment stays unqualified; YouTube & Partners line items are refused, and Demand Gen line items take their documented types); advertiser brand-safety targeting (edit, create, delete) of channel and keyword exclusions, digital content labels, sensitive categories and OMID; Demand Gen ad groups (create, patch with an update mask, delete) under Demand Gen line items with inventory, bid value, optimized targeting and product feed checks and read-back; Demand Gen ad group targeting (bulk edit, create, delete) of the documented ad group types, with location and language placed by the line item setting; YouTube video ad assets (create and bulk create) checked against the existing assets of each video in the advertiser; Demand Gen ads (create, patch with an update mask, delete) of the four ad types with their ad group, line item and YouTube video assets read and every creative field read back; line item bulk updates of status or the EU political advertising declaration (1-100 line items) with line item and insertion order reads, activation confirmation and read-back; line item duplication into a draft copy with source and insertion order reads and read-back; advertiser-owned inventory source groups (create, rename, delete) and their inventory sources (assign, remove, bulk edit) with complete assignment reads, the usable sources of the advertiser read page by page, spending confirmation for membership and read-back; advertiser settings (name, status, domain, default business name and logo, integration code, TV viewability exemption, EU political declaration) with activation confirmation and read-back; advertiser-owned custom bidding algorithms (create, rename, archive) with owner reads and read-back; SDF download tasks of the advertiser with operation read-back and access to their files; registering uploaded custom bidding scripts and rules for advertiser-owned algorithms with algorithm and file reads and read-back; renaming and re-describing advertiser-owned customer match audiences with audience reads and read-back (membership duration and members stay unqualified)',
    'write-platforms',
    'https://developers.google.com/display-video/api/reference/rest/v4',
  ],
  [
    'ga4',
    'ga4',
    'v1beta/v1alpha',
    'dv360-and-measurement',
    null,
    'audience exports and report tasks',
    'ga4-campaign-report',
    'https://developers.google.com/analytics/devguides/reporting/data/v1',
  ],
  [
    'gtm',
    'gtm',
    'v2',
    'dv360-and-measurement',
    null,
    'container entities and explicit publishing; scoped reverts, built-in variables, folders, pinned gallery imports, latest/undelete; complete workspace bulk edits, sync, conflict resolution and temporary preview; administrator account/permission and environment rotation workflows',
    'measurement-apple',
    'https://developers.google.com/tag-platform/tag-manager/api/v2',
  ],
  [
    'gsc',
    'google_search_console',
    'v3/v1',
    'dv360-and-measurement',
    null,
    'sitemaps; organic reporting only',
    'measurement-apple',
    'https://developers.google.com/webmaster-tools/v1/api_reference_index',
  ],
  [
    'drive',
    'google_drive',
    'v3',
    'media',
    null,
    null,
    'private-media',
    'https://developers.google.com/workspace/drive/api/reference/rest/v3',
  ],
  [
    'sheets',
    'google_sheets',
    'v4/v3',
    'reporting-overview',
    null,
    'AMCP-owned report destinations only',
    'report-delivery-discovery',
    'https://developers.google.com/workspace/sheets/api/reference/rest',
  ],
  [
    'amazon',
    'amazon',
    'catalog-dependent',
    null,
    null,
    null,
    'delegated-native',
    'https://advertising.amazon.com/API/docs/en-us',
  ],
  [
    'criteo',
    'criteo',
    sentAt('criteo'),
    'criteo',
    null,
    'standard Criteo-budget auction campaign creation and complete manual finite-limit PUT with fresh account/balance/line membership, native-unit owner policies and verified receipts; auction line item creation (in draft) and complete PUT with fresh account, campaign and line item membership, unique names, native-unit owner policies and read-back of every field and the status; their promoted products (append with bid overrides, delete, pause and unpause) against the complete product list of the line item, with read-back of every product in the request; their keywords (added and removed by match type, and bids of positive keywords) and complete bid multiplier PUTs, with read-back of each phrase or page type; existing preferred-line-item targeting: audience, store and add-to-basket scope, append and removal; fresh account/campaign/retailer checks; reviewed 2026.07 performance report jobs scoped by account, campaigns or line items, with durable scoped polling, checked JSON/compact outputs and no advertising mutation; campaign and line item budget overrides (complete PUT with membership and current override reads, confirmation and read-back); audience segments (bulk create of Events and empty contact list segments, update of names and event rules with confirmation, deletion) with retailer and segment searches and read-back; preferred (onsite display) line items (create in a preferred campaign, complete PUT) with membership, campaign, retailer and creative reads, spending confirmation and read-back; catalog requests and brand and seller catalog exports with account and status reads; creatives (create, and whole update keeping retailer and template) checked against the retailer template read, with retailer, template and creative reads and read-back of every value (keyword reviews and supply-side reports stay unqualified: they serve retailers)',
    'criteo-targeting-writes',
    'https://developers.criteo.com/retail-media/docs/overview',
  ],
  [
    'adjust',
    'adjust',
    'Reports Service (unversioned)',
    'adjust',
    null,
    null,
    'adjust-reporting',
    'https://dev.adjust.com/en/api/rs-api/',
  ],
  [
    'google_business',
    'google_business',
    'v1',
    'dv360-and-measurement',
    null,
    'location-scoped public place-action link creation, exact field-mask edits and deletion; complete link membership, native type eligibility and displaced preference verification; administrator-only account notification topic/event changes, explicit clearing and retired-event migration; exact account rename and account/location administrator invitations, role changes and removals with complete membership verification; location hours, special hours, phones, website, labels and the Ads phone for a location grant with location reads and read-back (title, address, categories, open status and store code stay unqualified); location attributes set and cleared by mask, checked against the attribute metadata of the location, with read-back; lodging facts set and cleared by field mask, checked against the pinned lodging schema, with location and lodging reads and read-back',
    'google-place-action-links',
    'https://developers.google.com/my-business/reference/rest',
  ],
].map(([id, gateway, version, guide, media, writes, test, docs]) => ({
  id,
  gateway: gateway + '_native_action',
  // The contract's record (ACC-05): its version and review date come from src/provider-contract-manifest.json, which
  // `npm run contracts:generate -- --reviewed-at=YYYY-MM-DD` moves whenever contract_digest changes, with the date of
  // the review that accepted the change, so they follow the content they describe.
  contract_version: contractRecord(String(id)).contract_version,
  api_version: version,
  owner_role: 'AMCP integration maintainer',
  reviewed_at: contractRecord(String(id)).reviewed_at,
  documentation: docs,
  guide: guide ? 'amcp://guides/' + guide : null,
  // Business Profile connects on the website since CON-06 (once the owner declares the project's API approval).
  website_connection: !!guide && !['criteo', 'adjust'].includes(String(id)),
  // Every level is unsupported, or built and tested locally but not proven against a live account (F-87):
  // `…_unverified`. A workspace's own verified writes are its live evidence (capabilities.ts `live_verified`).
  discovery: ['criteo', 'adjust', 'google_business'].includes(String(id))
    ? 'partial_unverified'
    : guide
      ? 'implemented_unverified'
      : 'unsupported',
  native_reads:
    guide && !['criteo', 'adjust', 'google_business'].includes(String(id))
      ? 'implemented_unverified'
      : 'partial_unverified',
  overview_reporting: [
    'google',
    'meta',
    'tiktok',
    'snapchat',
    'linkedin',
    'x',
    'microsoft',
    'apple',
    'reddit',
    'ga4',
    'gsc',
  ].includes(String(id))
    ? 'implemented_unverified'
    : 'unsupported',
  reviewed_writes: writes ? 'partial_unverified' : 'unsupported',
  write_scope: writes,
  media_import: media ? 'implemented_unverified' : 'unsupported',
  media_platform: media ? (({google: 'google_ads', x: 'x_ads'} as Record<string, string>)[String(id)] ?? id) : null,
  tests: [
    ...new Set([
      'tests/' + test + '.test.ts',
      ...(id === 'criteo'
        ? [
            'tests/criteo-report-jobs.test.ts',
            'tests/criteo-campaign-writes.test.ts',
            'tests/criteo-auction-line-items.test.mjs',
            'tests/criteo-promoted-products.test.mjs',
            'tests/criteo-creatives.test.mjs',
            'tests/criteo-line-item-bidding.test.mjs',
            'tests/criteo-budget-overrides.test.mjs',
            'tests/criteo-audience-segments.test.mjs',
            'tests/criteo-preferred-line-items.test.mjs',
            'tests/criteo-catalog-requests.test.mjs',
          ]
        : []),
      ...(id === 'google_business'
        ? [
            'tests/google-business-notifications.test.ts',
            'tests/google-business-access.test.ts',
            'tests/google-business-sync.test.ts',
            'tests/google-business-location-edits.test.mjs',
            'tests/google-business-location-attributes.test.mjs',
            'tests/google-business-lodging.test.mjs',
          ]
        : []),
      ...(id === 'snapchat'
        ? [
            'tests/snapchat-nested-updates.test.ts',
            'tests/snapchat-planning-reads.test.mjs',
            'tests/snapchat-chunked-media.test.mjs',
            'tests/snapchat-media-copy.test.mjs',
            'tests/snapchat-claim-media.test.mjs',
            'tests/snapchat-targeting-specs.test.mjs',
            'tests/snapchat-offer-disclaimers.test.mjs',
            'tests/snapchat-segment-deletions.test.mjs',
            'tests/snapchat-custom-conversions.test.mjs',
            'tests/snapchat-product-sets.test.mjs',
            'tests/snapchat-catalogs.test.mjs',
            'tests/snapchat-product-feeds.test.mjs',
            'tests/snapchat-dynamic-templates.test.mjs',
            'tests/snapchat-event-details.test.mjs',
            'tests/snapchat-pixel-names.test.mjs',
          ]
        : id === 'linkedin'
          ? [
              'tests/creative-chain-audit.test.ts',
              'tests/linkedin-conversion-links.test.ts',
              'tests/linkedin-conversion-rules.test.ts',
              'tests/linkedin-audience-templates.test.mjs',
              'tests/linkedin-planning-reads.test.mjs',
              'tests/linkedin-tracking-parameters.test.mjs',
              'tests/linkedin-third-party-tracking.test.mjs',
              'tests/linkedin-message-ads.test.mjs',
              'tests/linkedin-insight-tags.test.mjs',
              'tests/linkedin-ab-tests.test.mjs',
              'tests/linkedin-insight-domains.test.mjs',
              'tests/linkedin-publisher-restrictions.test.mjs',
              'tests/linkedin-lead-form-states.test.mjs',
              'tests/linkedin-entity-deletes.test.mjs',
              'tests/linkedin-dsc-edits.test.mjs',
              'tests/linkedin-account-settings.test.mjs',
              'tests/linkedin-lift-tests.test.mjs',
              'tests/linkedin-engagement-audiences.test.mjs',
            ]
          : id === 'tiktok'
            ? [
                'tests/creative-chain-audit.test.ts',
                'tests/tiktok-negative-keywords.test.mjs',
                'tests/tiktok-brand-safety.test.mjs',
                'tests/tiktok-blocked-words.test.mjs',
                'tests/tiktok-conversion-edits.test.mjs',
                'tests/tiktok-deletions.test.mjs',
                'tests/tiktok-preview-reads.test.mjs',
                'tests/tiktok-audience-edits.test.mjs',
                'tests/tiktok-library-assets.test.mjs',
                'tests/tiktok-rule-audiences.test.mjs',
                'tests/tiktok-pixels.test.mjs',
                'tests/tiktok-image-edits.test.mjs',
                'tests/tiktok-change-logs.test.mjs',
              ]
            : id === 'x'
              ? [
                  'tests/x-targeting-writes.test.ts',
                  'tests/x-targeting-batch.test.mjs',
                  'tests/x-draft-writes.test.ts',
                  'tests/x-report-jobs.test.ts',
                  'tests/x-audience-estimate.test.mjs',
                  'tests/x-tracking-tags.test.mjs',
                  'tests/x-line-item-associations.test.mjs',
                  'tests/x-curated-categories.test.mjs',
                  'tests/x-preroll-ctas.test.mjs',
                  'tests/x-media-library.test.mjs',
                  'tests/x-scheduled-tweets.test.mjs',
                  'tests/x-custom-audiences.test.mjs',
                  'tests/x-conversation-cards.test.mjs',
                  'tests/x-legacy-card-edits.test.mjs',
                  'tests/x-entity-batches.test.mjs',
                  'tests/x-product-catalogs.test.mjs',
                  'tests/x-product-sets.test.mjs',
                  'tests/x-scheduled-feeds.test.mjs',
                  'tests/x-catalog-products.test.mjs',
                ]
              : id === 'google'
                ? [
                    'tests/google-contracts.test.ts',
                    'tests/google-asset-links.test.ts',
                    'tests/google-configuration-writes.test.ts',
                    'tests/google-custom-segments.test.ts',
                    'tests/google-bidding-events.test.ts',
                    'tests/google-portfolio-strategies.test.ts',
                    'tests/google-state-queries.test.ts',
                    'tests/google-conversion-goals.test.ts',
                    'tests/google-conversion-actions.test.ts',
                    'tests/provider-unavailable-actions.test.mjs',
                    'tests/google-campaign-bid-modifiers.test.ts',
                    'tests/google-recommendation-dismissal.test.ts',
                    'tests/google-listing-groups.test.ts',
                    'tests/google-pmax-brand-guidelines.test.mjs',
                    'tests/google-user-list-customer-types.test.mjs',
                    'tests/google-campaign-drafts.test.mjs',
                    'tests/google-experiments.test.mjs',
                    'tests/google-experiment-lifecycle.test.mjs',
                    'tests/google-customer-settings.test.mjs',
                    'tests/google-auto-assets.test.mjs',
                    'tests/google-youtube-uploads.test.mjs',
                    'tests/google-recommendation-subscriptions.test.mjs',
                    'tests/google-smart-campaign-settings.test.mjs',
                    'tests/google-recommendation-apply.test.mjs',
                    'tests/google-customer-labels.test.mjs',
                    'tests/google-data-manager.test.mjs',
                  ]
                : id === 'apple'
                  ? ['tests/measurement-writes.test.ts', 'tests/apple-entity-writes.test.ts']
                  : id === 'reddit'
                    ? ['tests/reddit-creative-writes.test.ts', 'tests/reddit-post-creation.test.ts']
                    : id === 'dv360'
                      ? [
                          'tests/dv360-list-writes.test.ts',
                          'tests/dv360-targeting-search.test.ts',
                          'tests/dv360-line-item-targeting.test.ts',
                          'tests/dv360-advertiser-targeting.test.ts',
                          'tests/dv360-demand-gen-ad-groups.test.mjs',
                          'tests/dv360-ad-group-targeting.test.mjs',
                          'tests/dv360-ad-assets.test.mjs',
                          'tests/dv360-demand-gen-ads.test.mjs',
                          'tests/dv360-image-ad-assets.test.mjs',
                          'tests/dv360-audience-targeting.test.mjs',
                          'tests/dv360-line-item-bulk-update.test.mjs',
                          'tests/dv360-line-item-duplicate.test.mjs',
                          'tests/dv360-inventory-source-groups.test.mjs',
                          'tests/dv360-advertiser-settings.test.mjs',
                          'tests/dv360-custom-bidding.test.mjs',
                          'tests/dv360-sdf-downloads.test.mjs',
                          'tests/dv360-custom-bidding-files.test.mjs',
                          'tests/dv360-audience-edits.test.mjs',
                        ]
                      : id === 'gtm'
                        ? [
                            'tests/measurement-writes.test.ts',
                            'tests/gtm-workflow-writes.test.ts',
                            'tests/gtm-workspace-writes.test.ts',
                            'tests/gtm-diagnostics.test.ts',
                            'tests/retired-provider-actions.test.ts',
                          ]
                        : id === 'microsoft'
                          ? ['tests/wsdl-model.test.mjs', 'tests/microsoft-associations.test.ts']
                          : id === 'meta'
                            ? [
                                'tests/meta-contracts.test.ts',
                                'tests/meta-label-writes.test.ts',
                                'tests/meta-ad-library.test.ts',
                                'tests/meta-insights-jobs.test.ts',
                                'tests/meta-existing-posts.test.ts',
                                'tests/meta-value-rules.test.mjs',
                                'tests/meta-brand-safety.test.mjs',
                                'tests/meta-object-edits.test.mjs',
                                'tests/meta-ad-images.test.mjs',
                                'tests/meta-ad-videos.test.mjs',
                                'tests/meta-budget-schedules.test.mjs',
                                'tests/meta-product-sets.test.mjs',
                                'tests/meta-catalog-products.test.mjs',
                                'tests/meta-product-feeds.test.mjs',
                                'tests/meta-product-catalogs.test.mjs',
                                'tests/meta-ad-rules.test.mjs',
                                'tests/meta-customer-lists.test.mjs',
                                'tests/meta-offline-conversions.test.mjs',
                                'tests/meta-shop-opt-out.test.mjs',
                                'tests/meta-v26-rules.test.mjs',
                                'tests/meta-custom-conversions.test.mjs',
                                'tests/meta-pixels.test.mjs',
                                'tests/meta-account-settings.test.mjs',
                                'tests/meta-split-tests.test.mjs',
                              ]
                            : ['ga4', 'gtm', 'gsc', 'apple'].includes(String(id))
                              ? ['tests/measurement-writes.test.ts']
                              : []),
    ]),
  ],
  fixture_evidence: 'Local fixtures validate the stated family only; inspect release test evidence.',
  live_qualification: 'unverified',
  ...(id === 'x'
    ? {
        audience_estimation:
          'Native JSON v12 potential-audience range read; bounded criteria and private-reference checks; current selected-login authority. Estimates are non-additive and do not promise delivery. APP_LIST/TAP exclusions and comparison operators remain unqualified.',
      }
    : {}),
  ...(id === 'adjust'
    ? {
        native_reporting:
          'Existing encrypted API-token connection; local configured app bindings, administrator app/filter discovery, scoped events and bounded native JSON/app-indexed pivot reads. Exact numeric strings, explicit nulls/warnings/incomplete totals, current authority on retries and shared source-IP budget. No advertising writes, website OAuth, normalized dashboard or scheduled exports. Other catalog operations remain unmapped.',
      }
    : {}),
  ...(id === 'meta'
    ? {
        creative_identity_tests: ['tests/meta-creative-ownership.test.ts'],
        creative_top_level_fields: metaCreativeFields,
        creative_identity_boundary:
          'Bounded advertiser Page/Instagram membership, exact existing content owner, private Page-token reads and in-flight write-grant/credential checks. Existing posts need their read scopes; partner/creator content and advertising eligibility are not qualified.',
      }
    : {}),
  external_requirements: [
    'provider account permission',
    'configured app/identity',
    'provider approval and quota as applicable',
  ],
  recovery:
    'Read-only retries and durable local jobs; uncertain provider mutations require reconciliation with the original review.',
  ...(id === 'dv360'
    ? {
        targeting_search:
          'Advertiser-scoped native GEO_REGION, POI and BUSINESS_CHAIN discovery; exact connection control, bounded complete pages and no assignment side effects',
      }
    : {}),
  ...(id === 'meta'
    ? {
        existing_posts:
          'Selected-account Page and linked professional Instagram content with ephemeral server-only Page tokens, native creative references, bounded URL lookup and encrypted exact-request continuations. Requires separately approved read scopes; no content publication or ad creation.',
        public_research:
          'Bounded Ad Library search via amcp_native_action/search_ads_library; media format, coverage, truncation and cache freshness explicit; app eligibility unverified',
      }
    : {}),
  ...(['ga4', 'gsc', 'google_business'].includes(String(id))
    ? {
        connection_diagnostics:
          'Local connection status only: tenant-scoped metadata, explicit/default identity selection, bounded account lists, no credential access or provider requests. Authorization, refresh, discovery and grant changes remain separate.',
        diagnostic_tests: ['tests/connection-diagnostics.test.ts'],
        diagnostic_guide: 'amcp://guides/dv360-and-measurement',
      }
    : {}),
  ...(['ga4', 'gsc', 'google_business'].includes(String(id))
    ? {
        local_disconnect:
          'Administrator-only explicit connection UUID; preview by default, dry_run:false removes local credentials, discovery metadata and resource bindings atomically. Retains reviews, jobs, reports, claims and audit history. No provider calls or OAuth grant revocation.',
        disconnect_tests: ['tests/connection-disconnect.test.ts'],
        disconnect_guide: 'amcp://guides/dv360-and-measurement',
      }
    : {}),
  ...(id === 'google_business'
    ? {
        connection_sync:
          'Administrator-only MCP sync_assets reads complete bounded native account/location groups on an existing business.manage login (website Connections or operator-provisioned). Shared locations retain native parent memberships; exact numeric account and locations/{id} selections and write grants remain unchanged. Preview by default, current authority and login checked on every attempt; failed sync retains stale metadata. Website Connections runs the same collector.',
        connection_sync_tests: ['tests/google-business-sync.test.ts'],
        place_action_discovery:
          'Native global/region type metadata or exact location eligibility, bounded complete link lists and exact link reads. Location grants and current business.manage scope remain required; a partial collection carries scoped continuation.',
        place_action_discovery_tests: ['tests/google-place-action-discovery.test.ts'],
      }
    : {}),
  ...(id === 'google_business'
    ? {
        write_guide: 'amcp://guides/dv360-and-measurement',
        place_actions:
          'Requires a business.manage connection (website Connections or operator-provisioned) and explicit locations/{id} read/write grants. These public links have no paused state; owner activation and deletion controls apply.',
        qanda:
          'Local retirement-status diagnostic only. The provider discontinued Q&A on 2025-11-03 with no replacement API.',
      }
    : {}),
}));
/**
 * A provider contract at the version AMCP sends. A provider whose version travels in a request header (LinkedIn's
 * LinkedIn-Version, its adapter's versions.header) states the version a plan sent there, `sent`, or else the version
 * it sends now. Its contract_digest identifies this content at this version (ACC-05): another version is another
 * contract.
 */
export function effectiveProviderContract(id: string, sent?: string): JsonObject | undefined {
  const c = providerContracts.find(c => c.id === id);
  if (!c) return undefined;
  const versions = providerVersions(id),
    effective = {...c, api_version: versions?.header ? (sent ?? versions.current()) : c.api_version};
  return {...effective, contract_digest: contractDigest(effective)};
}
