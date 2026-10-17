'use strict';
const accountExplanationMessages = new Set([
  'WooCommerce store discovery exceeds its bounded metadata limit.',
  'All published parent products and every reported variable-parent variation were collected twice within the stated bounds. Native IDs, selected price strings, statuses and reported memberships are preserved. The supported observations and store currency agreed across the sequential scans. This is not a point-in-time snapshot, unpublished-parent inventory, verified grouped-product membership, destination eligibility or write approval. Missing source products are retained; no product, draft or snapshot was changed or saved.',
  'WooCommerce inventory is incomplete, malformed or outside its collection bounds. No complete inventory is returned.',
  'The WooCommerce inventory read did not return a bounded authenticated JSON response. Inspect the store REST API access.',
  'Choose the WooCommerce inventory mode and one exact native price field.',
  'Choose the exact WooCommerce inventory scope and price field; absent source products must be retained.',
  'WooCommerce inventory has no qualified sandbox route.',
  'WooCommerce inventory requires one bound store, wc/v3 and an existing Read REST API key.',
  'WooCommerce inventory requires an existing encrypted, unexpired Consumer Key and Consumer Secret.',
  'The WooCommerce inventory login, store or permissions changed. Read the inventory again.',
  'WooCommerce inventory or currency changed between complete scans. Read it again; no changes are proposed.',
  'Only the selected published WooCommerce variations were read twice under the same repeated variable parent membership and store currency with current authorization. Native variations have no product name: destination titles require explicit operator review. This is sequential source evidence, not a point-in-time or full inventory, tax calculation, sale activation, independently qualified child image, destination eligibility or write approval. No products are changed or deleted.',
  'The native parent needs a nonempty SKU without surrounding whitespace before explicit Meta group mapping. No group ID is invented.',
  'The selected variation SKU equals its parent SKU. Use distinct native product and group identities before Meta mapping.',
  'The native parent name is unavailable or has surrounding whitespace. Correct it before reviewing a destination title.',
  'The provider-reported variation image must be an HTTPS URL without embedded credentials. No parent image is substituted.',
  'WooCommerce product sources have no qualified sandbox route.',
  'Selected products have duplicate SKUs. Choose stable unique retailer IDs before importing.',
  'Only the selected published WooCommerce products and price field were read twice with unchanged store currency and current authorization. This is sequential source evidence, not a point-in-time or full inventory, variant, tax calculation, sale activation, destination eligibility or write approval. No products are changed or deleted.',
  'WooCommerce did not return complete unchanged evidence for the exact selected products and currency.',
  'The selected store, login or read permission changed. Read its products again with current authorization.',
  'The selected WooCommerce store did not return a bounded authenticated JSON response. Inspect its HTTPS and REST API access.',
  'Configure an exact public HTTPS store origin on port 443 for WooCommerce.',
  'Only standalone simple products are mapped. Grouped products and variants require separate reconciliation.',
  'Digital or unknown delivery configuration requires separate destination qualification.',
  'A stable nonempty SKU of at most 100 characters is required; no retailer ID is invented.',
  'The native SKU has surrounding whitespace. Correct it in the store before Meta mapping; AMCP preserves it unchanged.',
  'A plain product name of at most 500 characters is required.',
  'The native product name has surrounding whitespace. Correct it in the store before Meta mapping; AMCP preserves it unchanged.',
  'The selected source price must be an exact nonnegative decimal with at most two places for the Meta import. No price is rounded or inferred.',
  'The source price exceeds the Meta import integer bound.',
  'The first native image must be an HTTPS URL without embedded credentials.',
  'Choose the exact WooCommerce store account and connection.',
  'Choose 1–50 exact published WooCommerce product IDs and price, regular_price or sale_price.',
  'The WooCommerce connection must bind one store account, wc/v3 and recorded Read or Read/Write REST API key permission.',
  'An existing encrypted WooCommerce Consumer Key and Consumer Secret are required for HTTPS Basic authentication.',
  'Only explicitly selected observed individual products are proposed for permanent removal. Saving retains an unapproved draft and deletes no products. Every unsent step rechecks selected supported evidence before native review and execution; each accepted deletion keeps its original receipt and independent read-back. Scheduled feeds may restore products they still contain. This does not reconcile products absent from your supplied source or establish X early-access entitlement.',
  'Choose the exact X account, login and catalog.',
  'Choose 1–50 distinct retailer IDs from the validated supplied products.',
  'Selected catalog evidence could not be read.',
  'The selected login or read access changed. Read a new removal preview.',
  'Removal needs an observed individual product for every selected retailer ID. Missing, grouped or unknown products require another workflow.',
  "Choose this session's original removal preview and hash.",
  'Save the original removal preview. Changed scope, products or selection require a new preview.',
  'Choose fewer or smaller source products for a removal preview.',
  'Read access changed. Read a new removal preview.',
  'At most 100 current removal previews may be retained.',
  'Save the current exact removal preview through its guarded workflow.',
  'The draft differs from its exact selected removal preview.',
  'Confirm the displayed selected removals before saving their unapproved draft.',
  'This removal draft is already being saved. Inspect or retry its original preview.',
  'The original plan does not match this removal preview.',
  'The original saved removal plan is unavailable.',
  'The removal preview expired. Read a new preview.',
  'Selected catalog evidence changed since preview. Read a new removal preview; no products were deleted.',
  'Removal draft could not be saved.',
  'This step no longer matches its original selected removal proposal.',
  'The original selected source product is unavailable.',
  'The selected product evidence changed after this draft. Read a new removal preview; no products were deleted.',
  'The typed product count applies to create_catalog_removal only.',
  'Inspect the other listed X products first, then select from that listing.',
  'The listed X products changed since you inspected them. Inspect them again; no products were deleted.',
  'Type the number of selected products to confirm their removal.',
  'Current evidence of explicitly selected listed X products only. Nothing is selected because it is absent from a source; products that are not listed, grouped or of unknown group status cannot be removed here. This is sequential evidence, not a point-in-time inventory snapshot.',
  'Native product keys select listed products only with selection_source listed_inventory.',
  'Choose supplied_products or listed_inventory as the selection.',
  'Selection of listed products is qualified for X catalogs only.',
  'A listed selection takes native product keys, not supplied products or retailer IDs.',
  'Choose 1–50 distinct listed native product keys.',
  'Preview of explicit additional-consent settings in the selected workspace. Existing required types are preserved. This does not establish built-in checks, runtime consent, event delivery or compliance. Saving creates an unapproved draft; publishing remains separate.',
  'Choose the exact Tag Manager account and login.',
  'Choose the exact container and workspace.',
  'Choose 1–10 distinct exact tag IDs.',
  'Choose 1–20 distinct literal additional-consent types. Variables and duplicate types are refused.',
  'custom_types_acknowledged is an explicit boolean.',
  'Some consent types are not documented Google consent types. Check their spelling, or acknowledge that your consent platform grants them.',
  'This login requires Tag Manager read permission.',
  'The selected login or read access changed. Read a new consent preview.',
  'Retain the exact complete native workspace and tag resources.',
  'Tag Manager returned conflicting resource identities.',
  'Retain a current native fingerprint for every selected workspace and tag.',
  'Retain the exact original tag ID, name and type.',
  'A selected tag changed during observation. Read a new preview.',
  'The workspace changed during observation. Read a new preview.',
  'Consent evidence reached its read, row, byte or time limit. Choose fewer tags and read a new preview.',
  'Save the original preview ID and hash. Changed scope or requirements need a new preview.',
  "Choose this session's exact consent preview.",
  'A selected tag has unqualified consent settings. Inspect its original native configuration separately.',
  'Keep at most 20 literal required types per tag in this guided draft.',
  'Retain a bounded literal consent parameter key.',
  'The selected tags already require these additional-consent types. No draft is needed.',
  'Choose fewer or smaller tags for this draft.',
  'Read access changed. Read a new consent preview.',
  'At most 100 current consent previews may be retained.',
  'Use this current confirmed consent preview.',
  'The draft differs from the exact consent preview.',
  'Confirm the exact preview before saving its unapproved draft.',
  'The consent preview expired. Read a new preview.',
  'This consent draft is already being saved. Inspect or retry its original preview.',
  'Selected tag or workspace configuration changed since preview. Read a new preview.',
  'Draft creation lost its current preview.',
  'The draft is missing its original consent binding.',
  'This step no longer matches its original consent proposal. Read a new preview.',
  'The original tag changed after this draft. Read a new preview; no update was submitted.',
  'The draft changed during the tag check. Refresh it before continuing.',
  'Current X campaign, line-item and promoted-post association inventory in provider order, excluding deleted and draft entities. Native micros stay exact and unconverted. Configured status, effective status, servability and approval are separate; none proves actual delivery. Post content, scheduled posts, promoted accounts and media creatives are outside this view. Provider changes can move or omit entities between pages; this is not a point-in-time snapshot. This read grants no write authority.',
  'Current non-removed Google inventory, ordered by exact immutable IDs. Native micros remain unconverted. Configured status does not prove serving. Provider changes across pages are possible; this is not a point-in-time snapshot. This read grants no write authority.',
  'Current native inventory in provider order and default status visibility, not a point-in-time snapshot. Provider changes between pages can move, repeat or remove entities. Configured and effective status stay separate. Native money remains exact and unconverted. This read grants no write authority.',
  'Current LinkedIn inventory in ascending native ID order, not a point-in-time snapshot. Campaign groups cover the seven documented status filters; test and non-test entities are included. Current parent reads verify account and hierarchy. Native decimal money and currency remain unconverted. Observed group controls and campaign pacing do not establish effective spend or budget-edit eligibility. Campaign daily settings are not a hard calendar-day spending cap. Creative intended status and observed serving state stay separate. No write authority is granted.',
  'Current Snapchat inventory in created-at descending order with provider default visibility, not a point-in-time or complete deleted-entity snapshot. Native money remains exact micros. Configured status, review status and delivery codes are independent and do not establish actual delivery. Only the opaque continuation token is reused on the fixed authorized native route. This read grants no write authority.',
  'Current TikTok standard campaign/ad-group/ad route inventory, excluding deleted entities. Native money keeps its JSON type and account-currency units, without conversion; budget_mode determines its meaning. Operation and secondary status remain separate and do not prove serving. Smart+, GMV Max and specialized route coverage is not implied. Page counts may change; this is not a point-in-time snapshot. This read grants no write authority.',
  'Configuration evidence only. This audit does not establish that real events fire, deduplicate, satisfy consent or attribute correctly.',
  'Current Google Ads conversion configuration from two matching bounded reads. Configuration is not proof that conversions are delivered, deduplicated, consented or attributed. Nothing was saved.',
  'The conversion configuration could not be completely inspected; no partial goal or primary-action evidence is reported as ready. Nothing was saved.',
  'Current GA4 property configuration from complete bounded Admin API reads. Configuration is not proof that events are sent, counted, deduplicated, consented or attributed. Nothing was saved.',
  'Measurement evidence for one asset in six fixed layers. A layer is observed only from complete evidence of the selected asset; everything else stays unknown, unavailable or not applicable. Configuration and reported activity do not prove that conversions are delivered, deduplicated, consented or attributed. Nothing was saved.',
  // PRV-07 A: the change history explanation and refusals (src/google-change-history.ts).
  'Google Ads change events of the selected customer in the requested account-local dates, newest first. Who made a change is personal data and was not requested; client_type names the tool used. Changed field paths name what changed, not its old or new value. limit_reached means older changes in the window may exist. Change history explains configuration changes; it does not prove their effect on performance. Nothing was saved or changed.',
  'Change history reads a selected Google Ads customer (gateway google_ads_native_action).',
  'Choose the exact numeric Google Ads customer ID.',
  'Choose explicit dates covering at most 30 days within the last 30 days. Google Ads keeps change history for 30 days.',
  'Choose a limit of 1–10,000 change events.',
  'Use 1–20 distinct native Google Ads change resource types, such as CAMPAIGN or AD_GROUP_AD.',
  'This Google Ads login changed. Read the change history again.',
  'Google Ads returned more change history pages than this bounded read takes.',
  'Google Ads did not return a complete change history response.',
  'Google Ads returned more change events than the requested limit.',
  'Google Ads returned a change for another customer or a malformed resource name.',
  'Google Ads returned an unrecognized change value.',
  'Google Ads returned a change history row mixed with another resource.',
  'Google Ads returned unselected change event fields.',
  'Google Ads returned a missing or repeated change event.',
  'Google Ads returned a change outside the requested window.',
  'Google Ads returned a change of a resource type outside the request.',
  'Google Ads returned malformed changed field paths.',
  'Preview is based on supplied product data. Current provider items are read by each native review before execution. Partial or uncertain writes retain per-item receipts in the campaign journal.',
  'Preview uses supplied product data and the existing X product contract. Each product keeps a separate native review, accepted receipt and independent read-back. Matching IDs are updated; missing source items are retained.',
  'X catalog endpoints require early-access entitlement; a local preview does not establish account eligibility.',
  'X updates matching product IDs. Ownership and existing values are checked during each native review.',
  'Product variants, live store synchronization and deletion of missing source items are outside this import.',
  'Preview validates supplied product data for a read-only Snapchat comparison. Exact decimal prices are kept as written. No review, draft or provider change is created.',
  'Snapchat changes catalog products only through product feeds. AMCP compares supplied products read-only and saves no draft; fix differences in the feed.',
  'Feed processing can take time, so a comparison shows current catalog evidence, not the next feed result.',
  'Each part is its own unapproved plan of at most 50 products in one lineage group; approve and run each part separately. Every product still needs its own native review and read-back, and products the source lacks are never deleted.',
  'Preview validates every product of this plan group from the source; nothing is saved. Saving creates one unapproved plan of at most 50 products per part, and every product still needs its own native review and read-back. Products the source lacks are never deleted.',
  'Choose an exact X product catalog ID and selected X ad account.',
  'X imports require explicit upsert approval: X updates matching product IDs. Create-only imports are not qualified.',
  'X imports require explicit retailer_id, name, price, currency, image_url, url, availability, condition, brand and plain text description.',
  'Product retailer IDs must be unique.',
  'Choose one explicit uppercase three-letter product currency.',
  'A sale start or end needs a sale price.',
  'Use a nonnegative decimal sale price, optionally followed by the product currency.',
  'The sale price must be in the product currency.',
  'The sale price must be lower than the price.',
  'A sale start or end is an ISO 8601 date and time with an explicit offset, such as 2026-11-01T00:00:00+03:00.',
  'The sale must end after it starts.',
  'X needs both the sale start and the sale end, or neither.',
  'Retire products as "out of stock" or "discontinued".',
  'Choose 1–50 distinct retailer IDs of the supplied products to retire.',
  'Retiring updates existing products: explicitly allow updates to existing retailer IDs.',
  'Current evidence for supplied X product IDs only, using repeated bounded native reads and exact supported decimal prices. Grouped or potentially hidden variants are blocked. Missing fields stay unknown. This is sequential evidence, not a point-in-time inventory snapshot. Every saved product still requires a fresh native review and independent read-back; products outside the supplied source are not returned or deleted.',
  'X comparison requires a complete catalog scan of at most 1,000 listed products. No product changes were submitted.',
  'X catalog ownership or supplied-product evidence changed during comparison. Read the source products again; no product changes were submitted.',
  'X listed catalog observations changed during collection. Read them again; no product changes were submitted.',
  'Products outside this supplied selection are retained. Their store absence is unverified. X listing can hide other variants, so this is not a complete variant inventory or a point-in-time snapshot.',
  'Choose true or false for inspecting other listed catalog products.',
  'Supplied products do not establish whole-store absence. The absent-source policy must be retain.',
  'Inspection of other listed products is qualified for X catalogs only.',
  'Catalog inventory inspection arguments apply only to catalog_compare.',
  'X catalog comparison reached its collection limit. Read a smaller eligible catalog again; no product changes were submitted.',
  'This job reads back an already submitted reviewed mutation. Polling never resubmits the mutation.',
  'Read-only configuration observations; no compiler, browser execution, consent or live tag-delivery qualification.',
  'References absent from the workspace inventory may include provider-managed system triggers; unknown is not passed.',
  'Resolve this conflict in a separately reviewed request before version creation.',
  'The parent folder is absent from the complete workspace inventory.',
  'A template parameter references a variable name absent from this workspace inventory.',
  'This unpaused tag has no explicit firing trigger; confirm whether tag sequencing invokes it.',
  'Latest version changed during the audit. Read a fresh snapshot before reviewing a mutation.',
  'The additional consent configuration could not be interpreted. Inspect the tag settings before drawing a runtime conclusion.',
]);
const gtmFindingLabels = {
  MERGE_CONFLICT: 'Merge conflict',
  DUPLICATE_NAME: 'Duplicate name',
  UNRESOLVED_FOLDER: 'Unresolved parent folder',
  UNRESOLVED_VARIABLE: 'Unresolved variable reference',
  UNRESOLVED_OR_SYSTEM_TRIGGER: 'Unresolved or system trigger',
  NO_FIRING_TRIGGER: 'No explicit firing trigger',
  NO_LIVE_VERSION: 'No live version',
  NO_LATEST_VERSION: 'No latest version',
  VERSION_CHANGED_DURING_AUDIT: 'Version changed during audit',
  CONSENT_CONFIGURATION_UNINTERPRETABLE: 'Unrecognized consent configuration',
};
const gtmEntityLabels = {
  tag: 'Tag',
  trigger: 'Trigger',
  variable: 'Variable',
  folder: 'Folder',
  customTemplate: 'Custom template',
  client: 'Client',
  transformation: 'Transformation',
  zone: 'Zone',
  gtagConfig: 'Google tag configuration',
  builtInVariable: 'Built-in variable',
};
function uiAccountExplanation(value) {
  return accountExplanationMessages.has(value) ? uiText(value) : String(value ?? '');
}
function uiGtmFindingLabel(code) {
  return Object.hasOwn(gtmFindingLabels, code) ? uiText(gtmFindingLabels[code]) : String(code ?? '');
}
function uiGtmFindingSeverity(value) {
  switch (value) {
    case 'error':
      return uiText('Error');
    case 'warning':
      return uiText('Warning');
    case 'unknown':
      return uiText('Unknown');
    default:
      return String(value ?? '');
  }
}
function uiGtmFindingMessage(finding) {
  const message = String(finding.message ?? ''),
    meta = finding.message_localization;
  if (uiLocale !== 'ar' || !meta || typeof meta !== 'object' || Array.isArray(meta))
    return uiAccountExplanation(message);
  if (
    meta.key === 'duplicate_name' &&
    finding.code === 'DUPLICATE_NAME' &&
    typeof meta.kind === 'string' &&
    Object.hasOwn(gtmEntityLabels, meta.kind) &&
    message === 'Another ' + meta.kind + ' has this same name; choose IDs explicitly.'
  )
    return uiText('Another {kind} has this same name; choose IDs explicitly.', {
      kind: uiText(gtmEntityLabels[meta.kind]),
    });
  if (
    meta.key === 'unresolved_trigger' &&
    finding.code === 'UNRESOLVED_OR_SYSTEM_TRIGGER' &&
    typeof meta.trigger_id === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(meta.trigger_id) &&
    message ===
      'Trigger ' +
        meta.trigger_id +
        ' is not in the workspace inventory; resolve whether it is provider-managed or missing before publishing.'
  )
    return uiText(
      'Trigger {id} is not in the workspace inventory; resolve whether it is provider-managed or missing before publishing.',
      {id: meta.trigger_id},
    );
  if (meta.key === 'missing_version') {
    if (
      meta.version === 'live' &&
      finding.code === 'NO_LIVE_VERSION' &&
      message === 'No live version was returned (scoped 404).'
    )
      return uiText('No live version was returned (scoped 404).');
    if (
      meta.version === 'latest' &&
      finding.code === 'NO_LATEST_VERSION' &&
      message === 'No latest version was returned (scoped 404).'
    )
      return uiText('No latest version was returned (scoped 404).');
  }
  return uiAccountExplanation(message);
}
function portfolioEntityLabel(value) {
  switch (value) {
    case 'campaign_group':
      return uiText('Campaign group');
    case 'line_item':
      return uiText('Line item');
    case 'promoted_tweet':
      return uiText('Promoted post');
    case 'creative':
      return uiText('Creative');
    case 'campaign':
      return uiText('Campaign');
    case 'adsquad':
      return uiText('Ad squad');
    case 'adset':
      return uiText('Ad set');
    case 'adgroup':
    case 'ad_group':
      return uiText('Ad Group');
    case 'ad':
      return uiText('Ad');
    default:
      return pretty(value);
  }
}
function accountChoices(ids) {
  const all = platforms
    .filter(p => ids.includes(p.id))
    .flatMap(p =>
      p.connections
        .filter(c => c.enabled)
        .flatMap(c =>
          c.accounts.map(account_id => ({
            gateway: p.gateway,
            connection_id: c.id,
            account_id,
            label: accountLabel(p, c, account_id),
          })),
        ),
    );
  // Every account picker of these workflows follows the working client (SEC-08); the pickers keep their explicit
  // placeholder and preselect only a sole account. hiddenByClient lets an empty picker name the filter instead of
  // asking to connect an account that is connected.
  if (typeof clientAccountOptions !== 'function') return all;
  const {options, hidden} = clientAccountOptions(all);
  return Object.assign(options, {hiddenByClient: hidden});
}
/**
 * An empty account picker's notice (markup): the working client hid every account, or none is connected yet. `notice`
 * and `linkText` are already in the interface language.
 */
function accountChoicesEmptyNotice(targets, notice, linkText = uiText('Connections')) {
  return targets.hiddenByClient && typeof workingClientEmptyNotice === 'function'
    ? esc(workingClientEmptyNotice())
    : `${esc(notice)} <a href="/connections">${esc(linkText)}</a>`;
}
function portfolioReconciliationView(out) {
  const changes = [
    ...out.changes.observed_added.map(row => ({
      id: row.id,
      label: uiText('Observed in the second read'),
      before: null,
      after: row,
    })),
    ...out.changes.not_observed_again.map(row => ({
      id: row.id,
      label: uiText('Not observed again'),
      before: row,
      after: null,
    })),
    ...out.changes.supported_fields_changed.map(row => ({...row, label: uiText('Supported fields changed')})),
  ];
  return `<h3 tabindex="-1" id="portfolio-comparison-heading">${esc(uiText('Inventory comparison'))}</h3><p>${esc(out.status === 'same_supported_fields' ? uiText('The supported fields matched in both complete reads.') : uiText('The two complete reads contain observed differences.'))}</p><p class="notice">${esc(uiText('Matching reads do not prove an atomic snapshot. A missing row does not establish deletion or authorize removal. Provider visibility rules still apply.'))}</p><p>${esc(uiText('First read: {before} entities. Second read: {after} entities. Unchanged: {same}.', {before: out.observations[0].row_count, after: out.observations[1].row_count, same: out.changes.unchanged_count}))}</p><p>${esc(uiText('Observation window: {start} to {end}.', {start: uiDate(out.observations[0].started_at), end: uiDate(out.observations[1].completed_at)}))}</p>${changes.length ? `<div class="data-scroll" tabindex="0" role="region" aria-label="${esc(uiText('Observed inventory differences'))}"><table class="review-table"><caption>${esc(uiText('Observed inventory differences'))}</caption><thead><tr><th scope="col">${esc(uiText('Native ID'))}</th><th scope="col">${esc(uiText('Observed change'))}</th><th scope="col">${esc(uiText('Before'))}</th><th scope="col">${esc(uiText('After'))}</th></tr></thead><tbody>${changes.map(row => `<tr><th scope="row" dir="ltr">${esc(row.id)}</th><td>${esc(row.label)}</td><td>${row.before ? recordDetails(row.before.native, uiText('Native fields')) : esc(uiText('Not observed'))}</td><td>${row.after ? recordDetails(row.after.native, uiText('Native fields')) : esc(uiText('Not observed'))}</td></tr>`).join('')}</tbody></table></div>` : ''}<details><summary>${esc(uiText('Inventory observation references'))}</summary>${out.observations.map((observation, index) => `<p>${esc(uiText('Read {number}: {pages} complete pages.', {number: index + 1, pages: observation.pages.length}))}</p><code dir="ltr">${esc(observation.content_sha256)}</code>`).join('')}</details>`;
}
// WEB-06: the account and drill-down live in the address, so Back returns to the parent level and a reload restores
// the selection. Restoring never reads the provider; the person chooses Read inventory.
/**
 * Google serving diagnostics (CMP-07): what each native symbol means, as an explanation beside the literal symbol. Every
 * symbol of the pinned v25 enums has one (tests/google-serving-diagnostics.test.mjs checks both languages); a symbol a
 * later version adds is shown as itself and marked as not named here.
 */
const servingLabels = {
  UNSPECIFIED: 'Not specified',
  UNKNOWN: 'Unknown in this API version',
  ELIGIBLE: 'Eligible to serve',
  PAUSED: 'Paused',
  REMOVED: 'Removed',
  ENDED: 'Ended',
  PENDING: 'Pending',
  MISCONFIGURED: 'Misconfigured',
  LIMITED: 'Limited',
  LEARNING: 'Learning',
  NOT_ELIGIBLE: 'Not eligible',
  CAMPAIGN_REMOVED: 'The campaign is removed.',
  CAMPAIGN_PAUSED: 'The campaign is paused.',
  CAMPAIGN_PENDING: 'The campaign has not started yet.',
  CAMPAIGN_ENDED: 'The campaign has ended.',
  CAMPAIGN_DRAFT: 'The campaign is a draft.',
  BIDDING_STRATEGY_MISCONFIGURED: 'The bid strategy is misconfigured.',
  BIDDING_STRATEGY_LIMITED: 'The bid strategy is limited.',
  BIDDING_STRATEGY_LEARNING: 'The bid strategy is learning.',
  BIDDING_STRATEGY_CONSTRAINED: 'The bid strategy is constrained.',
  BUDGET_CONSTRAINED: 'The budget limits delivery.',
  BUDGET_MISCONFIGURED: 'The budget is misconfigured.',
  SEARCH_VOLUME_LIMITED: 'Search volume is low.',
  AD_GROUPS_PAUSED: 'All ad groups are paused.',
  NO_AD_GROUPS: 'There are no ad groups.',
  KEYWORDS_PAUSED: 'All keywords are paused.',
  NO_KEYWORDS: 'There are no keywords.',
  AD_GROUP_ADS_PAUSED: 'All ads are paused.',
  NO_AD_GROUP_ADS: 'There are no ads.',
  HAS_ADS_LIMITED_BY_POLICY: 'Some ads are limited by policy.',
  HAS_ADS_DISAPPROVED: 'Some ads are disapproved.',
  MOST_ADS_UNDER_REVIEW: 'Most ads are under review.',
  MISSING_LEAD_FORM_EXTENSION: 'A required lead form asset is missing.',
  MISSING_CALL_EXTENSION: 'A required call asset is missing.',
  LEAD_FORM_EXTENSION_UNDER_REVIEW: 'The lead form asset is under review.',
  LEAD_FORM_EXTENSION_DISAPPROVED: 'The lead form asset is disapproved.',
  CALL_EXTENSION_UNDER_REVIEW: 'The call asset is under review.',
  CALL_EXTENSION_DISAPPROVED: 'The call asset is disapproved.',
  NO_MOBILE_APPLICATION_AD_GROUP_CRITERIA: 'No mobile app category targeting is set.',
  CAMPAIGN_GROUP_PAUSED: 'The campaign group is paused.',
  CAMPAIGN_GROUP_ALL_GROUP_BUDGETS_ENDED: 'All budgets of the campaign group have ended.',
  APP_NOT_RELEASED: 'The app is not released.',
  APP_PARTIALLY_RELEASED: 'The app is released in only some places.',
  HAS_ASSET_GROUPS_DISAPPROVED: 'Some asset groups are disapproved.',
  HAS_ASSET_GROUPS_LIMITED_BY_POLICY: 'Some asset groups are limited by policy.',
  MOST_ASSET_GROUPS_UNDER_REVIEW: 'Most asset groups are under review.',
  NO_ASSET_GROUPS: 'There are no asset groups.',
  ASSET_GROUPS_PAUSED: 'All asset groups are paused.',
  MISSING_LOCATION_TARGETING: 'Location targeting is missing.',
  CAMPAIGN_NOT_BOOKED: 'The reservation campaign is not booked.',
  BOOKING_HOLD_EXPIRING: 'The booking hold is about to expire.',
  BOOKING_HOLD_EXPIRED: 'The booking hold has expired.',
  BOOKING_CANCELLED: 'The booking was cancelled.',
  AD_GROUP_PAUSED: 'The ad group is paused.',
  AD_GROUP_REMOVED: 'The ad group is removed.',
  AD_GROUP_INCOMPLETE: 'The ad group is incomplete.',
  AD_GROUP_PAUSED_DUE_TO_LOW_ACTIVITY: 'Google paused the ad group for low activity.',
  AD_GROUP_AD_PAUSED: 'The ad is paused.',
  AD_GROUP_AD_REMOVED: 'The ad is removed.',
  AD_GROUP_AD_DISAPPROVED: 'The ad is disapproved.',
  AD_GROUP_AD_UNDER_REVIEW: 'The ad is under review.',
  AD_GROUP_AD_POOR_QUALITY: 'The ad is of poor quality.',
  AD_GROUP_AD_NO_ADS: 'Google could not generate ads.',
  AD_GROUP_AD_APPROVED_LABELED: 'The ad is approved with a policy label.',
  AD_GROUP_AD_AREA_OF_INTEREST_ONLY: 'The ad serves only to people interested in the targeted area.',
  AD_GROUP_AD_UNDER_APPEAL: 'The ad is under appeal.',
  ASSET_GROUP_PAUSED: 'The asset group is paused.',
  ASSET_GROUP_REMOVED: 'The asset group is removed.',
  ASSET_GROUP_LIMITED: 'The asset group is limited.',
  ASSET_GROUP_DISAPPROVED: 'The asset group is disapproved.',
  ASSET_GROUP_UNDER_REVIEW: 'The asset group is under review.',
  ASSET_LINK_PAUSED: 'The asset link is paused.',
  ASSET_LINK_REMOVED: 'The asset link is removed.',
  ASSET_DISAPPROVED: 'The asset is disapproved.',
  ASSET_UNDER_REVIEW: 'The asset is under review.',
  ASSET_APPROVED_LABELED: 'The asset is approved with a policy label.',
  DISAPPROVED: 'Disapproved',
  APPROVED_LIMITED: 'Approved with limits',
  APPROVED: 'Approved',
  AREA_OF_INTEREST_ONLY: 'Serves only to people interested in the area',
  REVIEW_IN_PROGRESS: 'Review in progress',
  REVIEWED: 'Reviewed',
  UNDER_APPEAL: 'Under appeal',
  ELIGIBLE_MAY_SERVE: 'Eligible; may serve before review',
  PROHIBITED: 'Prohibited',
  FULLY_LIMITED: 'Fully limited',
  DESCRIPTIVE: 'Descriptive',
  BROADENING: 'Broadening',
  NO_ADS: 'No ads',
  POOR: 'Poor',
  AVERAGE: 'Average',
  GOOD: 'Good',
  EXCELLENT: 'Excellent',
};
const servingLevelLabels = {
  campaign: 'Campaign',
  ad_group: 'Ad group',
  ad: 'Ad',
  asset_group: 'Asset group',
  asset_group_asset: 'Asset link',
};
function servingSymbol(value) {
  if (typeof value !== 'string' || !value) return esc(uiText('Not returned'));
  const label = Object.hasOwn(servingLabels, value)
    ? uiText(servingLabels[value])
    : uiText('Not named by this version of AMCP');
  return `<code dir="ltr">${esc(value)}</code> <span>${esc(label)}</span>`;
}
function servingDiagnosticsView(out) {
  const rows = Array.isArray(out?.rows) ? out.rows : [];
  const policy = p =>
    p
      ? `<div>${esc(uiText('Approval'))}: ${servingSymbol(p.approval_status)}</div><div>${esc(uiText('Review'))}: ${servingSymbol(p.review_status)}</div>${(p.topics ?? []).map(t => `<div>${esc(uiText('Policy topic'))}: <code dir="ltr">${esc(t.topic ?? '')}</code> · ${servingSymbol(t.type)}</div>`).join('')}`
      : '—';
  const unknown = [...new Set(rows.flatMap(r => r.unknown_symbols ?? []))];
  return `<h3 tabindex="-1" id="serving-diagnostics-heading">${esc(uiText('Google serving diagnostics'))}</h3><p class="notice">${esc(uiText('Google’s own status and reasons at read time. A status explains serving as Google reports it; it is not delivery or performance evidence, and nothing was changed.'))}</p>${unknown.length ? `<p role="status">${esc(uiText('Google returned symbols this version of AMCP does not name:'))} <code dir="ltr">${esc(unknown.join(', '))}</code></p>` : ''}${out?.has_more ? `<p>${esc(uiText('Some levels have more entities than this page shows. Open a campaign to narrow the read.'))}</p>` : ''}<div class="data-scroll" tabindex="0" role="region" aria-label="${esc(uiText('Google serving diagnostics'))}"><table class="review-table"><caption>${esc(uiText('Google serving diagnostics'))}</caption><thead><tr><th scope="col">${esc(uiText('Entity'))}</th><th scope="col">${esc(uiText('Primary status'))}</th><th scope="col">${esc(uiText('Reasons'))}</th><th scope="col">${esc(uiText('Policy'))}</th><th scope="col">${esc(uiText('Ad strength'))}</th></tr></thead><tbody>${
    rows
      .map(
        r =>
          `<tr><th scope="row">${esc(uiText(servingLevelLabels[r.level] ?? 'Entity'))}<small>${esc(r.name ?? '')}</small><small dir="ltr">${esc(r.id)}</small></th><td>${servingSymbol(r.primary_status)}</td><td>${(r.primary_status_reasons ?? []).map(s => `<div>${servingSymbol(s)}</div>`).join('') || '—'}</td><td>${policy(r.policy)}</td><td>${r.ad_strength === undefined ? '—' : servingSymbol(r.ad_strength)}${(r.action_items ?? []).length ? `<ul>${r.action_items.map(item => `<li><bdi dir="auto">${esc(item)}</bdi></li>`).join('')}</ul>` : ''}</td></tr>`,
      )
      .join('') || `<tr><td colspan="5">${esc(uiText('Google returned no current entities for this read.'))}</td></tr>`
  }</tbody></table></div>`;
}
const portfolioParentKeys = [
  'campaign_group_id',
  'campaign_id',
  'adset_id',
  'ad_group_id',
  'ad_squad_id',
  'adgroup_id',
  'line_item_id',
];
const portfolioEntities = [
  'campaign_group',
  'campaign',
  'adset',
  'ad_group',
  'adsquad',
  'adgroup',
  'line_item',
  'ad',
  'creative',
  'promoted_tweet',
];
function portfolioUrlState() {
  const params =
      typeof URLSearchParams === 'function' && typeof location === 'object' && location
        ? new URLSearchParams(location.search ?? '')
        : new Map(),
    config = {};
  if (portfolioEntities.includes(params.get('entity'))) config.entity = params.get('entity');
  for (const key of portfolioParentKeys)
    if (/^[A-Za-z0-9_.:-]{1,200}$/.test(params.get(key) ?? '')) config[key] = params.get(key);
  return {connection_id: params.get('connection_id'), account_id: params.get('account_id'), config};
}
function portfolioUrl(target, config) {
  return (
    '/portfolio?' +
    Object.entries({connection_id: target.connection_id, account_id: target.account_id, ...config})
      .map(([key, value]) => key + '=' + encodeURIComponent(value))
      .join('&')
  );
}
/** Exact account-currency amount of a native micros value, without rounding: 9007199254740993 → 9007199254.740993. */
function portfolioMicrosDecimal(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^-?\d{1,30}$/.test(text)) return null;
  const negative = text.startsWith('-'),
    n = BigInt(negative ? text.slice(1) : text),
    fraction = (n % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + (n / 1000000n).toString() + (fraction ? '.' + fraction : '');
}
async function renderPortfolio() {
  const targets = accountChoices(['google', 'meta', 'linkedin', 'snapchat', 'tiktok', 'x', 'microsoft']),
    generation = navigationGeneration,
    identity = identityGeneration,
    restored = portfolioUrlState(),
    restoredIndex = targets.findIndex(
      t => t.connection_id === restored.connection_id && t.account_id === restored.account_id,
    ),
    restoredMissing = !!(restored.connection_id || restored.account_id) && restoredIndex < 0,
    historyTargets = accountChoices(['google']);
  content.innerHTML += `<p class="notice">${esc(uiText('Browse current Google Ads, Meta, LinkedIn, Snapchat, TikTok, X and Microsoft Advertising inventory. Inventory is read-only; provider changes require a separate review.'))}</p><form id="portfolio-account" class="panel workspace-form"><label>${esc(uiText('Advertising account'))}<select name="target" required>${restoredMissing ? `<option value="" selected>${esc(uiText('Previously selected account — check access'))}</option>` : ''}<option value="">${esc(uiText('Choose a login and account'))}</option>${targets.map((t, i) => `<option value="${i}" ${i === restoredIndex ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label><button class="button primary" type="submit">${esc(uiText('Read inventory'))}</button></form><div id="portfolio-view" aria-live="polite"></div>`;
  // PRV-07 A: a Google Ads account's change history, read separately from the inventory above.
  content.innerHTML += changeHistoryMarkup(historyTargets);
  const view = $('#portfolio-view'),
    form = $('#portfolio-account');
  const attached = () =>
    generation === navigationGeneration && identity === identityGeneration && view.isConnected && form.isConnected;
  let target = null,
    current = {entity: 'campaign'},
    cursor = null,
    sequence = 0,
    comparisonSequence = 0;
  const load = async (config, next = null) => {
    if (!attached()) return;
    if (!target) throw Error(uiText('Choose an account and read its inventory first.'));
    comparisonSequence++;
    const seq = ++sequence,
      selected = {...target};
    const active = () => seq === sequence && attached();
    view.setAttribute('aria-busy', 'true');
    let out;
    try {
      out = await workspaceCall('workspace', {
        action: 'portfolio',
        ...selected,
        requirements: config,
        cursor: next ?? undefined,
        limit: 50,
      });
    } catch (e) {
      if (active()) throw e;
      return;
    } finally {
      if (active()) view.setAttribute('aria-busy', 'false');
    }
    if (!active()) return;
    // A new level gets its own history entry; a refresh or the next page of the same level does not.
    if (typeof setViewLocation === 'function') setViewLocation(portfolioUrl(selected, config), !next);
    current = config;
    cursor = out.next_cursor;
    const meta = selected.gateway === 'meta_native_action',
      linkedin = selected.gateway === 'linkedin_native_action',
      snap = selected.gateway === 'snapchat_native_action',
      tiktok = selected.gateway === 'tiktok_native_action',
      x = selected.gateway === 'x_ads_native_action',
      google = selected.gateway === 'google_ads_native_action',
      // RPT-07 (B27): Microsoft follows the Google hierarchy (campaign → ad_group → ad).
      microsoft = selected.gateway === 'microsoft_ads_native_action',
      root = linkedin ? 'campaign_group' : 'campaign',
      leaf = linkedin ? 'creative' : x ? 'promoted_tweet' : 'ad',
      child = linkedin
        ? config.entity === 'campaign_group'
          ? uiText('Campaigns')
          : uiText('Creatives')
        : config.entity === 'campaign'
          ? meta
            ? uiText('Ad sets')
            : snap
              ? uiText('Ad squads')
              : x
                ? uiText('Line items')
                : uiText('Ad groups')
          : x
            ? uiText('Promoted posts')
            : uiText('Ads');
    // WEB-06: Google, Snapchat and X document their unit as micros of the account currency (src/budget-units.ts), so
    // the exact decimal amount is shown beside the native value. Meta and TikTok stay unconverted.
    const exact = (value, currency) => {
      const decimal = portfolioMicrosDecimal(value);
      return decimal === null
        ? ''
        : ` · <bdi dir="ltr">${esc(decimal)}${/^[A-Z]{3}$/.test(currency ?? '') ? ' ' + esc(currency) : ''}</bdi>`;
    };
    const money = r => {
      if (r.native_money) {
        const entries = Object.entries(r.native_money).filter(([, v]) => v !== null);
        return entries.length
          ? portfolioBudgetContextView(r) +
              entries
                .map(
                  ([k, v]) =>
                    `<div>${esc(linkedin || snap || tiktok || x ? portfolioMoneyLabel(k) : k)}: <b>${esc(linkedin ? v.amount + ' ' + v.currencyCode : v)}</b>${(snap || x) && /_micros?$/.test(k) ? exact(v, r.currency) : ''}</div>`,
                )
                .join('') +
              `<small>${esc(linkedin ? uiText('LinkedIn native decimal amounts · unconverted') : snap ? uiText('Snapchat native micros · exact amount in account currency shown') : x ? uiText('X native micros · exact amount in account currency shown') : tiktok ? uiText('TikTok native account-currency amounts · unconverted') : microsoft ? uiText('Microsoft native decimal account-currency amounts · unconverted') : uiText('Meta native integers · unconverted'))}</small>`
          : portfolioBudgetContextView(r) + uiText('No amount returned');
      }
      return r.budget_micros != null
        ? esc(uiText('{amount} budget micros', {amount: r.budget_micros})) + exact(r.budget_micros, r.currency)
        : r.cpc_bid_micros != null
          ? esc(uiText('{amount} CPC bid micros', {amount: r.cpc_bid_micros})) + exact(r.cpc_bid_micros, r.currency)
          : '—';
    };
    // Row hand-offs (WEB-06): clone a root entity into a draft where cloning is supported and this account has write
    // access, and capture evidence for it. Both open a preselected form; nothing is read or saved until submitted.
    const login = platforms
        .find(p => p.gateway === selected.gateway)
        ?.connections.find(c => c.id === selected.connection_id),
      writable = !!(login?.writeAccounts ?? login?.write_accounts ?? []).includes(selected.account_id),
      clonable =
        writable &&
        [
          'google_ads_native_action',
          'snapchat_native_action',
          'tiktok_native_action',
          'linkedin_native_action',
        ].includes(selected.gateway),
      // Guided evidence capture has no X or Microsoft preset.
      capturable = !['x_ads_native_action', 'microsoft_ads_native_action'].includes(selected.gateway),
      scopeQuery =
        'connection_id=' +
        encodeURIComponent(selected.connection_id) +
        '&account_id=' +
        encodeURIComponent(selected.account_id);
    const handoffs = r =>
      (clonable && config.entity === root
        ? `<a class="button small" href="/campaigns?clone=1&${scopeQuery}&source_id=${encodeURIComponent(r.id)}#campaign-clone">${esc(uiText('Clone into a draft'))}</a>`
        : '') +
      (capturable && config.entity === 'campaign'
        ? `<a class="button small" href="/reports?${scopeQuery}&campaign_id=${encodeURIComponent(r.id)}#report-capture">${esc(uiText('Capture evidence for this campaign'))}</a>`
        : '');
    const serving = r =>
      x
        ? config.entity === 'campaign'
          ? `<small>${esc(uiText('Effective:'))} ${esc(r.effective_status ?? uiText('Unknown'))}</small><small>${esc(uiText('Servable: {state}', {state: r.servable === true ? uiText('Yes') : r.servable === false ? uiText('No') : uiText('Unknown')}))}</small>${r.reasons_not_servable?.length ? `<small>${esc(uiText('Not servable reasons: {reasons}', {reasons: r.reasons_not_servable.join(', ')}))}</small>` : ''}`
          : config.entity === 'promoted_tweet'
            ? `<small>${esc(uiText('Approval status: {status}', {status: r.approval_status ?? uiText('Unknown')}))}</small><small>${esc(uiText('Post ID: {id}', {id: r.tweet_id}))}</small>`
            : ''
        : tiktok
          ? `<small>${esc(uiText('Secondary status: {status}', {status: r.secondary_status ?? uiText('Unknown')}))}</small>${r.budget_mode ? `<small>${esc(uiText('Budget mode: {mode}', {mode: r.budget_mode}))}</small>` : ''}`
          : linkedin && config.entity === 'creative'
            ? `<small>${esc(uiText('Observed serving: {state}', {state: r.is_serving === true ? uiText('Yes') : r.is_serving === false ? uiText('No') : uiText('Unknown')}))}</small>${r.serving_hold_reasons?.length ? `<small>${esc(uiText('Serving hold reasons: {reasons}', {reasons: r.serving_hold_reasons.join(', ')}))}</small>` : ''}`
            : snap
              ? `${config.entity === 'ad' ? `<small>${esc(uiText('Review status: {status}', {status: r.review_status ?? uiText('Unknown')}))}</small>` : ''}<small>${esc(r.delivery_status?.length ? uiText('Delivery codes: {codes}', {codes: r.delivery_status.join(', ')}) : uiText('No delivery status codes returned'))}</small>`
              : '';
    const parent = linkedin
      ? config.campaign_group_id
        ? `<button id="portfolio-parent" class="button">${esc(uiText('Campaigns for group {id}', {id: config.campaign_group_id}))}</button>`
        : ''
      : config.campaign_id
        ? `<button id="portfolio-parent" class="button">${esc(uiText(meta ? 'Ad sets for {id}' : snap ? 'Ad squads for {id}' : x ? 'Line items for {id}' : 'Ad groups for {id}', {id: config.campaign_id}))}</button>`
        : '';
    view.innerHTML = `<section class="panel"><div class="dialog-actions"><button id="portfolio-root" class="button">${esc(linkedin ? uiText('Campaign groups') : uiText('Campaigns'))}</button>${parent}<a class="button" href="/campaigns#campaign-create">${esc(uiText('Create or clone a plan'))}</a>${capturable ? `<a class="button" href="/reports?${scopeQuery}#report-capture">${esc(uiText('Capture performance evidence'))}</a>` : ''}</div>
      <h2 id="portfolio-heading" tabindex="-1">${esc(uiText('{entity} inventory', {entity: portfolioEntityLabel(config.entity)}))}</h2>
      <p><strong>${esc(uiText('{platform} · Account {account}', {platform: linkedin ? 'LinkedIn' : meta ? 'Meta' : snap ? 'Snapchat' : tiktok ? 'TikTok' : x ? 'X' : microsoft ? 'Microsoft Advertising' : 'Google Ads', account: out.account_id}))}</strong>${config.campaign_group_id ? ' · ' + esc(uiText('Campaign group {id}', {id: config.campaign_group_id})) : ''}${config.campaign_id ? ' · ' + esc(uiText('Campaign {id}', {id: config.campaign_id})) : ''}${config.adset_id || config.ad_group_id || config.ad_squad_id || config.adgroup_id || config.line_item_id ? ' · ' + esc(uiText(meta ? 'Ad set {id}' : snap ? 'Ad squad {id}' : x ? 'Line item {id}' : 'Ad group {id}', {id: config.adset_id ?? config.ad_group_id ?? config.ad_squad_id ?? config.adgroup_id ?? config.line_item_id})) : ''}</p>
      <p>${esc(uiText('Read {date} · Current inventory', {date: date(out.captured_at)}))}</p><details class="workspace-details"><summary>${esc(uiText('Inventory scope and native units'))}</summary><p>${esc(uiAccountExplanation(out.meaning))}</p></details>
      <div class="data-scroll" role="region" aria-label="${esc(uiText('Portfolio entities'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('{entity} inventory', {entity: portfolioEntityLabel(config.entity)}))}</caption><thead><tr><th scope="col">${esc(uiText('Entity'))}</th><th scope="col">${esc(linkedin && config.entity === 'creative' ? uiText('Intended status') : uiText('Native status'))}</th><th scope="col">${esc(uiText('Native money fields'))}</th><th scope="col">${esc(uiText('Next view'))}</th></tr></thead><tbody>
      ${out.rows.map((r, i) => `<tr><th scope="row">${esc(r.name)}<small>${esc(r.id)}</small></th><td><strong>${esc(r.status ?? uiText('Unknown'))}</strong>${meta ? `<small>${esc(uiText('Effective:'))} ${esc(r.effective_status ?? uiText('Unknown'))}</small>` : ''}${serving(r)}${recordDetails(r.native, uiText('Native fields'))}</td><td>${money(r)}<small>${esc(r.currency ?? uiText('Currency unknown'))} · ${esc(r.timezone ?? uiText('Timezone unknown'))}</small></td><td>${config.entity !== leaf ? `<button class="button small" data-portfolio-child="${i}">${esc(child)}</button>` : esc(linkedin ? uiText('Read-only creative record') : x ? uiText('Read-only promoted-post association') : uiText('Read-only ad record'))}${handoffs(r)}</td></tr>`).join('') || `<tr><td colspan="4">${esc(uiText('No entities in this page. Follow Next page if the provider supplies a continuation.'))}</td></tr>`}
      </tbody></table></div><div class="dialog-actions"><button class="button" id="portfolio-refresh">${esc(uiText('Refresh first page'))}</button><button class="button" id="portfolio-next" ${out.has_more ? '' : 'hidden'}>${esc(uiText('Next page'))}</button><button class="button" id="portfolio-compare">${esc(uiText('Compare two complete reads'))}</button>${google ? `<button class="button" id="portfolio-serving">${esc(uiText('Why is it serving or not?'))}</button>` : ''}</div><p>${esc(uiText('Compare this hierarchy with two bounded reads of up to 500 entities and 20 pages each.'))}</p><section id="portfolio-comparison" aria-live="polite" aria-atomic="true"></section>${google ? '<section id="portfolio-serving-view" aria-live="polite" aria-atomic="true"></section>' : ''}</section>`;
    workspaceBind('#portfolio-root', () => load({entity: root}));
    workspaceBind('#portfolio-parent', () =>
      load(
        linkedin
          ? {entity: 'campaign', campaign_group_id: config.campaign_group_id}
          : {
              entity: meta ? 'adset' : snap ? 'adsquad' : tiktok ? 'adgroup' : x ? 'line_item' : 'ad_group',
              campaign_id: config.campaign_id,
            },
      ),
    );
    workspaceBind('[data-portfolio-child]', b => {
      if (!active()) return;
      const r = out.rows[Number(b.dataset.portfolioChild)];
      return load(
        linkedin
          ? config.entity === 'campaign_group'
            ? {entity: 'campaign', campaign_group_id: r.id}
            : {entity: 'creative', campaign_group_id: config.campaign_group_id, campaign_id: r.id}
          : config.entity === 'campaign'
            ? {
                entity: meta ? 'adset' : snap ? 'adsquad' : tiktok ? 'adgroup' : x ? 'line_item' : 'ad_group',
                campaign_id: r.id,
              }
            : {
                entity: x ? 'promoted_tweet' : 'ad',
                campaign_id: config.campaign_id,
                [meta ? 'adset_id' : snap ? 'ad_squad_id' : tiktok ? 'adgroup_id' : x ? 'line_item_id' : 'ad_group_id']:
                  r.id,
              },
      );
    });
    workspaceBind('#portfolio-next', () => load(current, cursor));
    workspaceBind('#portfolio-refresh', () => load(current));
    workspaceBind('#portfolio-compare', async () => {
      if (!active()) return;
      const comparison = ++comparisonSequence,
        section = $('#portfolio-comparison');
      const comparisonActive = () => active() && comparison === comparisonSequence && section.isConnected;
      section.setAttribute('aria-busy', 'true');
      section.innerHTML = esc(uiText('Comparing current inventory…'));
      try {
        const result = await workspaceCall('workspace', {
          action: 'portfolio_reconcile',
          ...selected,
          requirements: {...config},
          limit: 50,
          max_entities: 500,
          max_pages: 20,
        });
        if (!comparisonActive()) return;
        section.innerHTML = portfolioReconciliationView(result);
        $('#portfolio-comparison-heading').focus();
      } catch (error) {
        if (comparisonActive()) section.innerHTML = `<p role="alert">${esc(errorMessage(error))}</p>`;
      } finally {
        if (comparisonActive()) section.setAttribute('aria-busy', 'false');
      }
    });
    // CMP-07: Google's own serving diagnostics for this account, or the campaign in view (one bounded read).
    workspaceBind('#portfolio-serving', async () => {
      if (!active()) return;
      const section = $('#portfolio-serving-view'),
        servingActive = () => active() && section.isConnected;
      section.setAttribute('aria-busy', 'true');
      section.innerHTML = esc(uiText('Reading Google serving diagnostics…'));
      try {
        const result = await workspaceCall('reporting', {
          action: 'serving_diagnostics',
          connection_id: selected.connection_id,
          account_id: selected.account_id,
          ...(config.campaign_id ? {campaign_id: config.campaign_id} : {}),
        });
        if (!servingActive()) return;
        section.innerHTML = servingDiagnosticsView(result);
        $('#serving-diagnostics-heading').focus();
      } catch (error) {
        if (servingActive()) section.innerHTML = `<p role="alert">${esc(errorMessage(error))}</p>`;
      } finally {
        if (servingActive()) section.setAttribute('aria-busy', 'false');
      }
    });
    $('#portfolio-heading').focus();
  };
  // A restored address names the level to reopen; Read inventory reopens it there instead of at the top.
  let reopen = restoredIndex >= 0 && restored.config.entity ? restored.config : null;
  if (reopen)
    view.innerHTML = `<p class="notice" role="status" id="portfolio-restored">${esc(uiText('Read inventory to reopen {entity} inventory for this account.', {entity: portfolioEntityLabel(reopen.entity)}))}${['campaign_group_id', 'campaign_id'].map(key => (reopen[key] ? ' ' + esc(uiText(key === 'campaign_id' ? 'Campaign {id}' : 'Campaign group {id}', {id: reopen[key]})) : '')).join('')}</p>`;
  form.elements.target.addEventListener('change', () => {
    if (!attached()) return;
    sequence++;
    comparisonSequence++;
    target = null;
    cursor = null;
    reopen = null;
    view.setAttribute('aria-busy', 'false');
    view.innerHTML = blank(uiText('Read inventory to open the selected account.'));
  });
  workspaceBind('#portfolio-account', async form => {
    if (!attached()) return;
    const t = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !t) throw Error(uiText('Choose an account.'));
    const {label, ...binding} = t,
      rootEntity = binding.gateway === 'linkedin_native_action' ? 'campaign_group' : 'campaign',
      level = reopen && Number(form.elements.target.value) === restoredIndex ? reopen : {entity: rootEntity};
    target = binding;
    reopen = null;
    await load(level);
  });
  bindChangeHistory(historyTargets);
}
// PRV-07 A: one Google Ads customer's change history (src/google-change-history.ts), read only on submit and never
// saved. Who made a change is not requested. Resource types, operations, tools, field paths and resource names are
// native values and stay literal; the timeline is counted here from the validated rows.
const changeHistoryPageSize = 50,
  changeHistoryDayMs = 86400000;
function changeHistoryDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return null;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}
function changeHistoryShift(days) {
  const today = changeHistoryDay(new Date().toISOString().slice(0, 10));
  return new Date(today + days * changeHistoryDayMs).toISOString().slice(0, 10);
}
/** The same window the server accepts: at most 30 days, starting no earlier than 29 days before today (UTC). */
function changeHistoryWindow(from, to) {
  const first = changeHistoryDay(from),
    last = changeHistoryDay(to),
    today = changeHistoryDay(changeHistoryShift(0));
  return (
    first !== null &&
    last !== null &&
    last >= first &&
    last - first <= 29 * changeHistoryDayMs &&
    first >= today - 29 * changeHistoryDayMs &&
    last <= today + changeHistoryDayMs
  );
}
function changeHistoryMarkup(targets) {
  const earliest = changeHistoryShift(-29),
    latest = changeHistoryShift(1);
  return `<section class="panel workspace-form" aria-labelledby="change-history-title"><h2 id="change-history-title">${esc(uiText('Google Ads change history'))}</h2><p>${esc(uiText('See what changed in one Google Ads account, newest first, from the change history Google keeps for 30 days. Who made each change is not requested. Nothing is saved or changed.'))}</p><form id="change-history">${targets.length ? '' : `<p class="notice">${esc(uiText('Connect Google Ads and select a customer account in Connections to read its change history.'))} <a href="/connections">${esc(uiText('Connections'))}</a></p>`}<label>${esc(uiText('Google Ads account'))}<select name="target" required ${targets.length ? '' : 'disabled'}><option value="">${esc(uiText('Choose a selected account'))}</option>${targets.map((t, i) => `<option value="${i}" ${targets.length === 1 ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label><label>${esc(uiText('From date'))}<input name="date_from" type="date" required min="${earliest}" max="${latest}" value="${changeHistoryShift(-6)}"></label><label>${esc(uiText('To date'))}<input name="date_to" type="date" required min="${earliest}" max="${latest}" value="${changeHistoryShift(0)}"></label><p class="form-note">${esc(uiText('Dates are days in the account time zone. Choose at most 30 days within the last 30 days.'))}</p><button class="button primary" type="submit" ${targets.length ? '' : 'disabled'}>${esc(uiText('Read change history'))}</button></form><div id="change-history-result" aria-live="polite"></div></section>`;
}
const changeHistoryRowKeys = [
  'change_date_time',
  'resource_type',
  'operation',
  'client_type',
  'resource_name',
  'changed_fields',
  'campaign',
  'ad_group',
  'asset',
  'change_event',
].sort();
/** The response belongs to this account, login and window, and every row carries only the selected native fields. */
function changeHistoryValid(out, target, requested) {
  const code = v => typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v),
    prefix = 'customers/' + target.account_id + '/',
    resource = (v, kind = '') =>
      typeof v === 'string' && v.length <= 512 && v.startsWith(prefix + kind) && !/[\x00-\x20\x7f]/.test(v);
  if (
    !out ||
    out.record_kind !== 'change_history' ||
    out.provider_mutations !== 0 ||
    out.retained_snapshot !== false ||
    out.scope?.gateway !== 'google_ads_native_action' ||
    out.scope.account_id !== target.account_id ||
    out.scope.connection_id !== target.connection_id ||
    out.scope.date_from !== requested.date_from ||
    out.scope.date_to !== requested.date_to ||
    out.scope.limit !== requested.limit ||
    out.personal_data?.user_email !== 'not_requested' ||
    typeof out.meaning !== 'string' ||
    !Array.isArray(out.rows) ||
    out.rows.length !== out.row_count ||
    out.rows.length > requested.limit ||
    out.limit_reached !== (out.rows.length === requested.limit) ||
    out.complete !== !out.limit_reached
  )
    return false;
  const days = new Map();
  for (const r of out.rows) {
    if (
      !r ||
      typeof r !== 'object' ||
      Object.keys(r).sort().join() !== changeHistoryRowKeys.join() ||
      typeof r.change_date_time !== 'string' ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(r.change_date_time) ||
      r.change_date_time.slice(0, 10) < requested.date_from ||
      r.change_date_time.slice(0, 10) > requested.date_to ||
      !code(r.resource_type) ||
      !(r.operation === null || code(r.operation)) ||
      !(r.client_type === null || code(r.client_type)) ||
      !Array.isArray(r.changed_fields) ||
      r.changed_fields.length > 1000 ||
      !r.changed_fields.every(f => typeof f === 'string' && /^[A-Za-z0-9_.]{1,256}$/.test(f)) ||
      !(r.resource_name === null || resource(r.resource_name)) ||
      !(r.campaign === null || resource(r.campaign, 'campaigns/')) ||
      !(r.ad_group === null || resource(r.ad_group, 'adGroups/')) ||
      !(r.asset === null || resource(r.asset, 'assets/')) ||
      !resource(r.change_event, 'changeEvents/')
    )
      return false;
    const day = r.change_date_time.slice(0, 10);
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  const reported = out.timeline?.by_day;
  return (
    !!reported &&
    typeof reported === 'object' &&
    Object.keys(reported).length === days.size &&
    [...days].every(([day, count]) => reported[day] === count)
  );
}
function changeHistoryView(out, target, page) {
  const notReported = esc(uiText('Not reported')),
    native = v => (v === null || v === undefined ? notReported : `<code dir="ltr">${esc(v)}</code>`),
    pages = Math.max(1, Math.ceil(out.rows.length / changeHistoryPageSize)),
    start = page * changeHistoryPageSize,
    footer = `<p>${esc(uiText('Who made each change was not requested. Changed field paths name what changed, not the old or new values. Times are in the account time zone. Nothing was saved or changed.'))}</p>${recordDetails({scope: out.scope, source_references: out.source_references}, uiText('Change history scope and source references'))}`;
  let html = `<h3 id="change-history-heading" tabindex="-1">${esc(target.label)}</h3><p>${esc(uiText('Requested {requested} · Returned {captured}', {requested: date(out.requested_at), captured: date(out.captured_at)}))}</p>${badge(out.complete ? 'complete' : 'incomplete')}<p class="notice">${esc(uiAccountExplanation(out.meaning))}</p>`;
  if (out.limit_reached)
    html += `<p class="notice" role="status">${esc(uiText('Only the newest {count} changes in these dates were read. Older changes may exist; choose fewer days to read them.', {count: uiNumber(out.rows.length)}))}</p>`;
  if (!out.rows.length)
    return html + `<p>${esc(uiText('Google Ads reported no changes in these dates.'))}</p>` + footer;
  // Counts per value, most frequent first; equal counts keep the native value order.
  const tally = key => {
    const counts = new Map();
    for (const r of out.rows) counts.set(r[key], (counts.get(r[key]) ?? 0) + 1);
    return [...counts].sort(([a, x], [b, y]) => y - x || String(a).localeCompare(String(b)));
  };
  const table = (caption, header, rows) =>
    `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(caption)}"><table class="review-table"><caption>${esc(caption)}</caption><thead><tr><th scope="col">${esc(header)}</th><th scope="col">${esc(uiText('Changes'))}</th></tr></thead><tbody>${rows.map(([value, count]) => `<tr><th scope="row">${value}</th><td>${esc(uiNumber(count))}</td></tr>`).join('')}</tbody></table></div>`;
  const days = new Map();
  for (const r of out.rows)
    days.set(r.change_date_time.slice(0, 10), (days.get(r.change_date_time.slice(0, 10)) ?? 0) + 1);
  html += `<div class="workspace-metrics"><article><strong>${esc(uiNumber(out.rows.length))}</strong><span>${esc(uiText('Changes read'))}</span></article><article><strong>${esc(uiNumber(days.size))}</strong><span>${esc(uiText('Days with changes'))}</span></article></div>`;
  html += table(
    uiText('Changes per day'),
    uiText('Day'),
    [...days]
      .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
      .map(([day, count]) => [`<bdi dir="ltr">${esc(day)}</bdi>`, count]),
  );
  for (const [caption, header, key] of [
    [uiText('Changes by resource type'), uiText('Resource type'), 'resource_type'],
    [uiText('Changes by operation'), uiText('Operation'), 'operation'],
    [uiText('Changes by tool used'), uiText('Changed through'), 'client_type'],
  ])
    html += table(
      caption,
      header,
      tally(key).map(([value, count]) => [native(value), count]),
    );
  const context = r =>
    [
      [uiText('Campaign'), r.campaign],
      [uiText('Ad group'), r.ad_group],
      [uiText('Asset'), r.asset],
    ]
      .filter(([, value]) => value !== null && value !== (r.resource_name ?? r.asset))
      .map(([label, value]) => `<small>${esc(label)}: <code dir="ltr">${esc(value)}</code></small>`)
      .join('');
  html += `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Change events'))}"><table class="review-table"><caption>${esc(uiText('Change events'))}</caption><thead><tr><th scope="col">${esc(uiText('Changed at'))}</th><th scope="col">${esc(uiText('Resource type'))}</th><th scope="col">${esc(uiText('Operation'))}</th><th scope="col">${esc(uiText('Changed through'))}</th><th scope="col">${esc(uiText('Changed fields'))}</th><th scope="col">${esc(uiText('Changed resource'))}</th></tr></thead><tbody>${out.rows
    .slice(start, start + changeHistoryPageSize)
    .map(
      r =>
        `<tr><th scope="row"><bdi dir="ltr">${esc(r.change_date_time)}</bdi></th><td>${native(r.resource_type)}</td><td>${native(r.operation)}</td><td>${native(r.client_type)}</td><td>${r.changed_fields.length ? r.changed_fields.map(f => `<code dir="ltr">${esc(f)}</code>`).join(' ') : notReported}</td><td>${native(r.resource_name ?? r.asset)}${context(r)}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
  if (pages > 1)
    html += `<div class="dialog-actions"><button class="button" type="button" id="change-history-previous" ${page > 0 ? '' : 'disabled'}>${esc(uiText('Previous page'))}</button><span>${esc(uiText('Page {page} of {pages}', {page: uiNumber(page + 1), pages: uiNumber(pages)}))}</span><button class="button" type="button" id="change-history-next" ${page < pages - 1 ? '' : 'disabled'}>${esc(uiText('Next page'))}</button></div>`;
  return html + footer;
}
function bindChangeHistory(targets) {
  const form = $('#change-history'),
    result = $('#change-history-result');
  if (!form?.elements?.target || !result) return;
  const begin = accountWorkflowContext(form, result);
  workspaceBind('#change-history', async () => {
    const current = begin();
    if (!current()) return;
    const target = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !target) throw Error(uiText('Choose a Google Ads account.'));
    const requested = {date_from: form.elements.date_from.value, date_to: form.elements.date_to.value, limit: 1000};
    // A window Google cannot answer is refused here, before any request.
    if (!changeHistoryWindow(requested.date_from, requested.date_to))
      throw Error(
        uiText(
          'Choose explicit dates covering at most 30 days within the last 30 days. Google Ads keeps change history for 30 days.',
        ),
      );
    let out;
    try {
      out = await workspaceCall('workspace', {
        action: 'change_history',
        gateway: 'google_ads_native_action',
        connection_id: target.connection_id,
        account_id: target.account_id,
        requirements: requested,
      });
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    if (!changeHistoryValid(out, target, requested))
      throw Error(
        uiText('The change history response is incomplete or belongs to a different selection. Read it again.'),
      );
    const pages = Math.max(1, Math.ceil(out.rows.length / changeHistoryPageSize));
    // Paging shows rows already read; it never reads Google Ads again.
    const show = page => {
      if (!current()) return;
      const shown = Math.min(Math.max(page, 0), pages - 1);
      result.innerHTML = changeHistoryView(out, target, shown);
      workspaceBind('#change-history-previous', () => show(shown - 1));
      workspaceBind('#change-history-next', () => show(shown + 1));
    };
    show(0);
    $('#change-history-heading')?.focus();
  });
}
function portfolioMoneyLabel(value) {
  switch (value) {
    case 'budget':
      return uiText('Budget');
    case 'scheduled_budget':
      return uiText('Scheduled budget');
    case 'bid_price':
      return uiText('Bid price');
    case 'total_budget_amount_local_micro':
      return uiText('Total budget micros');
    case 'target_cpa_local_micro':
      return uiText('Target CPA micros');
    case 'bid_amount_local_micro':
      return uiText('Bid micros');
    case 'daily_budget_amount_local_micro':
    case 'daily_budget_micro':
      return uiText('Daily budget micros');
    case 'lifetime_budget_micro':
      return uiText('Lifetime budget micros');
    case 'lifetime_spend_cap_micro':
      return uiText('Lifetime spend cap micros');
    case 'bid_micro':
      return uiText('Bid micros');
    case 'totalBudget':
      return uiText('Total budget');
    case 'dailyBudget':
      return uiText('Daily budget');
    case 'unitCost':
      return uiText('Unit cost');
    default:
      return value;
  }
}

function portfolioBudgetContextView(row) {
  const c = row.budget_context;
  if (!c || typeof c !== 'object') return '';
  let label;
  switch (c.mode) {
    case 'group_dynamic':
      label = uiText('Shared campaign-group optimization');
      break;
    case 'group_total':
      label = uiText('Campaign-group total cap');
      break;
    case 'campaign_daily':
      label = uiText('Observed campaign daily setting');
      break;
    case 'campaign_total':
      label = uiText('Observed campaign total budget');
      break;
    case 'campaign_daily_and_total':
      label = uiText('Observed campaign daily and total budgets');
      break;
    default:
      label = uiText('Budget mode needs native review');
  }
  let html = `<small>${esc(label)}</small>`;
  if (c.mode === 'group_dynamic')
    html += `<small>${esc(uiText('Group optimization is active. Campaign daily settings are not a separate group spending cap.'))}</small>`;
  if (row.entity === 'campaign' && typeof c.group_id === 'string') {
    html += `<small>${esc(uiText('Observed campaign group: {id}', {id: c.group_id}))}</small>`;
    for (const key of ['group_daily_budget', 'group_total_budget']) {
      const value = c[key];
      if (value && typeof value.amount === 'string' && typeof value.currencyCode === 'string')
        html += `<small>${esc(uiText(key === 'group_daily_budget' ? 'Observed group daily budget' : 'Observed group total cap'))}: ${esc(value.amount)} ${esc(value.currencyCode)}</small>`;
    }
  }
  if (typeof c.campaign_pacing === 'string')
    html += `<small>${esc(uiText('Native campaign pacing: {value}', {value: c.campaign_pacing}))}</small>`;
  return html;
}
function measurementReadFeedback(form) {
  const generation = navigationGeneration,
    identity = identityGeneration,
    button = form.querySelector('button[type=submit]'),
    id = form.id + '-feedback';
  button.id = form.id + '-submit';
  button.insertAdjacentHTML(
    'beforebegin',
    '<div class="measurement-read-feedback" id="' +
      id +
      '" role="alert" aria-atomic="true" hidden><strong>' +
      esc(uiText('Read needs attention')) +
      '</strong><p id="' +
      id +
      '-message"></p><p>' +
      esc(uiText('Review the message and your settings before reading again.')) +
      '</p></div>',
  );
  const region = $('#' + id),
    message = $('#' + id + '-message'),
    connected = () =>
      generation === navigationGeneration && identity === identityGeneration && form.isConnected && region.isConnected;
  const describe = include => {
    for (const control of [form, button]) {
      const ids = (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean),
        remaining = ids.filter(value => value !== id);
      if (include) remaining.push(id);
      if (remaining.length) control.setAttribute('aria-describedby', remaining.join(' '));
      else control.removeAttribute('aria-describedby');
    }
  };
  const clear = () => {
    if (!connected()) return;
    region.hidden = true;
    message.textContent = '';
    describe(false);
  };
  form.addEventListener('input', clear);
  form.addEventListener('change', clear);
  return {
    clear,
    show(error) {
      if (!connected()) return;
      // WEB-03: the message, what to do, the provider's facts and the reference each on their own line.
      const text = errorLines(error);
      if (!text) return;
      message.textContent = text;
      describe(true);
      region.hidden = false;
    },
  };
}

// A reviewed preview belongs to the current form and identity, including while local files are read.
function accountWorkflowContext(form, result) {
  const generation = navigationGeneration,
    identity = identityGeneration;
  let sequence = 0;
  const current = () =>
    generation === navigationGeneration && identity === identityGeneration && form.isConnected && result.isConnected;
  const invalidate = () => {
    if (!current()) return;
    sequence++;
    result.innerHTML = '';
  };
  form.addEventListener('input', invalidate);
  form.addEventListener('change', invalidate);
  return () => {
    const attempt = ++sequence;
    if (current()) result.innerHTML = '';
    return () => attempt === sequence && current();
  };
}
function measurementSectionHeading(id, label) {
  return (
    '<div class="measurement-section-heading"><h2 id="' +
    esc(id) +
    '" tabindex="-1">' +
    esc(label) +
    '</h2><a class="measurement-task-return" id="' +
    esc(id) +
    '-return" href="#measurement-task-heading">' +
    esc(uiText('Back to measurement tasks')) +
    '</a></div>'
  );
}
function measurementTaskNavigationMarkup() {
  const tasks = [
    ['ledger', uiText('Measurement evidence ledger')],
    ['gtm', uiText('Google Tag Manager configuration audit')],
    ['events', uiText('Recent GA4 events')],
    ['identity', uiText('Inspect a specific GA4 test identifier')],
    ['ga4config', uiText('GA4 property configuration')],
    ['conversions', uiText('LinkedIn conversion settings')],
    ['goals', uiText('Google Ads conversion goals')],
    ['trace', uiText('Inspect a sanitized event trace')],
  ];
  return (
    '<nav id="measurement-task-navigation" class="measurement-task-navigation" aria-labelledby="measurement-task-heading" aria-describedby="measurement-task-help">' +
    '<h3 id="measurement-task-heading" tabindex="-1">' +
    esc(uiText('Choose a measurement task')) +
    '</h3><p class="form-note" id="measurement-task-help">' +
    esc(uiText('Jump between sections without changing your entries. Reads start only when you submit a form.')) +
    '</p><ul class="measurement-task-links">' +
    tasks
      .map(
        ([id, label]) =>
          '<li><a id="measurement-task-link-' +
          id +
          '" href="#measurement-section-' +
          id +
          '">' +
          esc(label) +
          '</a></li>',
      )
      .join('') +
    '</ul></nav>'
  );
}
function bindMeasurementTaskNavigation() {
  const navigation = $('#measurement-task-navigation'),
    generation = navigationGeneration,
    identity = identityGeneration,
    sections = ['ledger', 'gtm', 'events', 'identity', 'ga4config', 'conversions', 'goals', 'trace'],
    headingIds = ['measurement-task-heading', ...sections.map(id => 'measurement-section-' + id)];
  const attached = () =>
    generation === navigationGeneration && identity === identityGeneration && navigation.isConnected;
  const focusHeading = id => {
    if (!attached() || !headingIds.includes(id)) return false;
    const heading = $('#' + id);
    if (!heading || !heading.isConnected) return false;
    heading.setAttribute('tabindex', '-1');
    heading.focus({preventScroll: true});
    heading.scrollIntoView({block: 'start'});
    return true;
  };
  const links = sections.flatMap(id => [
    ['measurement-task-link-' + id, 'measurement-section-' + id],
    ['measurement-section-' + id + '-return', 'measurement-task-heading'],
  ]);
  for (const [linkId, headingId] of links) {
    const link = $('#' + linkId);
    link.addEventListener('click', event => {
      if (
        !attached() ||
        !link.isConnected ||
        event.currentTarget !== link ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey ||
        link.getAttribute('download') !== null ||
        link.getAttribute('target') ||
        link.getAttribute('href') !== '#' + headingId
      )
        return;
      if (focusHeading(headingId)) event.preventDefault();
    });
  }
  const fragment = typeof location === 'undefined' ? '' : location.hash;
  const headingId = headingIds.find(id => fragment === '#' + id);
  if (headingId) focusHeading(headingId);
}
async function renderMeasurement() {
  const targets = accountChoices(['gtm']),
    eventTargets = accountChoices(['ga4']),
    conversionTargets = accountChoices(['linkedin']),
    goalTargets = accountChoices(['google']),
    hubTargets = accountChoices(['meta', 'snapchat', 'tiktok', 'gsc', 'adjust']),
    // One ledger picker: Google Ads accounts first, then GA4 properties (the scope bar relies on this order), then the
    // providers owner direction P8 added (MSR-03).
    ledgerTargets = Object.assign(
      [
        ...goalTargets.map(t => ({...t, gateway: 'google_ads_native_action'})),
        ...eventTargets.map(t => ({...t, gateway: 'ga4_native_action'})),
        ...hubTargets,
      ],
      // What the working client hid of any of them (SEC-08), for the empty picker's notice.
      {
        hiddenByClient:
          (goalTargets.hiddenByClient ?? 0) + (eventTargets.hiddenByClient ?? 0) + (hubTargets.hiddenByClient ?? 0),
      },
    ),
    scopeSets = {gtm: targets, ga4: eventTargets, google: goalTargets, linkedin: conversionTargets};
  content.innerHTML += `<section class="panel"><h2>${esc(uiText('Measurement evidence'))}</h2><p>${esc(uiText('Review configured tags, trigger dependencies, workspace conflicts and published-version consistency. Configuration evidence is distinct from observed event delivery and attribution.'))}</p>${measurementTaskNavigationMarkup()}<details class="workspace-details"><summary>${esc(uiText('Related measurement workflows'))}</summary><div class="work-links"><a href="/reporting-overview"><strong>${esc(uiText('GA4 and Search Console context'))}</strong><small>${esc(uiText('Collect measurement reports with source definitions.'))}</small></a><a href="/profiles"><strong>${esc(uiText('Client conversion mappings'))}</strong><small>${esc(uiText('Inspect approved conversion definitions and account bindings.'))}</small></a><a href="/capabilities"><strong>${esc(uiText('Reviewed measurement changes'))}</strong><small>${esc(uiText('Discover exact conversion and tag contracts.'))}</small></a></div></details></section>${measurementScopeMarkup(scopeSets)}${measurementLedgerMarkup(ledgerTargets)}<section class="panel workspace-form">${measurementSectionHeading('measurement-section-gtm', uiText('Google Tag Manager configuration audit'))}<p>${esc(uiText('Read the configured tags, triggers, conflicts and published version of one account, container or workspace. Leave the container empty to list containers, or the workspace empty to list workspaces.'))}</p><form id="measurement-audit">${measurementTargetField(targets, uiText('Tag Manager account'), 'Connect Google Tag Manager and select an account in Connections to audit its configuration.')}${controls(uiText('Container ID (optional for account inventory)'), 'text', '', 'container_id')}${controls(uiText('Workspace ID (optional)'), 'text', '', 'workspace_id')}<button class="button primary" type="submit" ${targets.length ? '' : 'disabled'}>${esc(uiText('Read configuration evidence'))}</button></form><div id="measurement-result"></div></section>`;
  content.innerHTML += measurementEventsMarkup(eventTargets);
  content.innerHTML += measurementEventIdentityMarkup(eventTargets);
  content.innerHTML += measurementGa4ConfigMarkup(eventTargets);
  content.innerHTML += measurementConversionsMarkup(conversionTargets);
  content.innerHTML += measurementGoogleGoalsMarkup(goalTargets);
  content.innerHTML += measurementTraceMarkup(eventTargets);
  const form = $('#measurement-audit'),
    result = $('#measurement-result'),
    begin = accountWorkflowContext(form, result);
  // The shared scope fills each task first; an explicit handoff link for one task then takes precedence (MSR-02).
  bindMeasurementScope(scopeSets);
  prefillMeasurementAudit(form, result, targets);
  workspaceBind('#measurement-audit', async form => {
    const current = begin();
    if (!current()) return;
    const t = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !t) throw Error(uiText('Choose a Tag Manager account.'));
    const requirements = Object.fromEntries(
      ['container_id', 'workspace_id']
        .filter(k => form.elements[k].value.trim())
        .map(k => [k, form.elements[k].value.trim()]),
    );
    let out;
    try {
      out = await workspaceCall('workspace', {
        action: 'measurement_audit',
        connection_id: t.connection_id,
        account_id: t.account_id,
        requirements,
      });
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    const c = out.configuration,
      findings = Array.isArray(c.findings) ? c.findings.slice(0, 1000) : [],
      discovery = gtmDiscoveryRows(c, t, requirements);
    result.innerHTML = `<p class="notice">${esc(uiAccountExplanation(out.meaning))}</p>${badge(c.complete ? 'complete' : 'incomplete')}${gtmDiscoveryMarkup(discovery)}<h3>${esc(uiText('Configuration findings'))}</h3>${gtmFindingsMarkup(c, findings)}${c.limitations?.length ? `<section><h3>${esc(uiText('Observation limits'))}</h3><ul>${c.limitations.map(value => `<li>${esc(uiAccountExplanation(value))}</li>`).join('')}</ul></section>` : ''}<div id="gtm-consent-evidence"></div><div id="gtm-consent-diff"></div><div id="gtm-consent-draft"></div>${reviewTable(c.versions ?? {}, uiText('Published version evidence'))}${recordDetails(c, uiText('Audit scope, limits and native evidence'))}`;
    mountGtmDiscovery(discovery, form, current);
    mountGtmFindings(findings, current);
    mountGtmConsentEvidence(c.consent_evidence, current);
    mountGtmConsentDiff(c.consent_diff, c.live_consent_evidence, current);
    mountGtmConsentDraft(c.consent_evidence, out.scope, current);
  });
  bindMeasurementEvents(eventTargets);
  bindMeasurementEventIdentity(eventTargets);
  bindMeasurementGa4Config(eventTargets);
  bindMeasurementConversions(conversionTargets);
  bindMeasurementGoogleGoals(goalTargets);
  bindMeasurementLedger(ledgerTargets);
  bindMeasurementTrace(eventTargets);
  bindMeasurementTaskNavigation();
}
// An explicitly supplied, sanitized trace is browser-local evidence. It never upgrades a native read,
// configuration audit or aggregate count into runtime acceptance and never sends a measurement event.
// Version 2 (MSR-03) adds region-specific defaults for a declared visitor region, wait_for_update_ms and the merge of
// undeclared types; version 1 keeps its original model. The SHA-256 of an empty transaction ID is always flagged.
const measurementTraceEmptyKey = 'opaque-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  measurementTraceRegion = v => typeof v === 'string' && /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/.test(v);
function measurementTraceInspect(text, target, streams) {
  const fail = message => {
      throw Error(message);
    },
    object = v => v !== null && typeof v === 'object' && !Array.isArray(v),
    exact = (v, keys, required) =>
      object(v) && Object.keys(v).every(k => keys.includes(k)) && required.every(k => Object.hasOwn(v, k)),
    numeric = v => typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v),
    consentTypes = ['analytics_storage', 'ad_storage', 'ad_user_data', 'ad_personalization'];
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 131072)
    fail(uiText('Use a sanitized trace of at most 128 KiB.'));
  // Bound nesting before parsing and reject duplicate keys, including escaped spelling aliases.
  // JSON.parse alone would silently discard conflicting scope or consent declarations.
  const stack = [];
  for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^{}\[\],:\s]+/g)) {
    const token = match[0],
      top = stack.at(-1);
    if (token === '{' || token === '[') {
      stack.push({object: token === '{', keys: new Set(), key: token === '{'});
      if (stack.length > 6) fail(uiText('The sanitized trace is nested too deeply.'));
    } else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && top?.object) top.key = true;
    else if (token.startsWith('"') && top?.object && top.key) {
      let key;
      try {
        key = JSON.parse(token);
      } catch {
        fail(uiText('Use valid JSON for the sanitized trace.'));
      }
      if (top.keys.has(key)) fail(uiText('Duplicate trace fields cannot establish unambiguous evidence.'));
      top.keys.add(key);
      top.key = false;
    }
  }
  let trace;
  try {
    trace = JSON.parse(text);
  } catch {
    fail(uiText('Use valid JSON for the sanitized trace.'));
  }
  const scopeKeys =
    trace?.version === 2
      ? ['property_id', 'stream_id', 'test_id', 'visitor_region']
      : ['property_id', 'stream_id', 'test_id'];
  if (
    !exact(trace, ['version', 'scope', 'coverage', 'steps'], ['version', 'scope', 'coverage', 'steps']) ||
    ![1, 2].includes(trace.version) ||
    !exact(trace.scope, scopeKeys, scopeKeys) ||
    (trace.version === 2 &&
      trace.scope.visitor_region !== null &&
      !measurementTraceRegion(trace.scope.visitor_region)) ||
    !numeric(trace.scope.property_id) ||
    !numeric(trace.scope.stream_id) ||
    trace.scope.property_id !== target?.account_id ||
    typeof trace.scope.test_id !== 'string' ||
    !/^amcp-test-[A-Za-z0-9-]{8,64}$/.test(trace.scope.test_id) ||
    !['complete', 'partial'].includes(trace.coverage) ||
    !Array.isArray(trace.steps) ||
    trace.steps.length < 1 ||
    trace.steps.length > 1000
  )
    fail(
      trace?.version === 2
        ? uiText(
            'Use trace version 2 with the selected GA4 property, an exact stream, a synthetic test identifier, a visitor region code or null, and 1–1000 steps.',
          )
        : uiText(
            'Use trace version 1, the selected GA4 property, an exact stream, a synthetic test identifier and 1–1000 steps.',
          ),
    );
  const v2 = trace.version === 2,
    visitor = v2 ? trace.scope.visitor_region : null;
  let consent = Object.fromEntries(consentTypes.map(k => [k, 'unknown'])),
    previous = -1,
    defaults = 0;
  const transactions = new Map(),
    rows = [],
    findings = [];
  const finding = (code, step) => {
    if (!findings.some(f => f.code === code && f.step === step)) findings.push({code, step});
  };
  // Version 2 consent state: applicable defaults by specificity, the latest update per type, types whose default
  // arrived after an update (ordering not established) and types still waiting for an update.
  const applied = [],
    updated = new Map(),
    ambiguous = new Set(),
    waiting = new Map();
  const applies = regions => {
    if (!regions) return {applies: true, level: 0};
    const levels = regions.map(r => (r.includes('-') ? 2 : 1));
    if (visitor === null) return {applies: 'maybe', level: Math.max(...levels)};
    const matches = regions
      .map((r, i) => (r === visitor || visitor.startsWith(r + '-') ? levels[i] : 0))
      .filter(level => level > 0);
    return matches.length ? {applies: true, level: Math.max(...matches)} : {applies: false, level: 0};
  };
  const defaultValue = type => {
    const declaring = applied.filter(d => Object.hasOwn(d.consent, type));
    if (!declaring.length) return 'unknown';
    // An undeclared visitor region leaves a regional default's applicability open: only agreeing values survive.
    const level = visitor === null ? null : Math.max(...declaring.map(d => d.level)),
      values = new Set(declaring.filter(d => level === null || d.level === level).map(d => d.consent[type]));
    return values.size === 1 ? [...values][0] : 'unknown';
  };
  const v2State = () =>
    Object.fromEntries(
      consentTypes.map(k => [k, ambiguous.has(k) ? 'unknown' : updated.has(k) ? updated.get(k) : defaultValue(k)]),
    );
  for (const [index, step] of trace.steps.entries()) {
    if (
      !object(step) ||
      !Number.isSafeInteger(step.sequence) ||
      step.sequence !== index + 1 ||
      !Number.isSafeInteger(step.at_ms) ||
      step.at_ms < 0 ||
      step.at_ms < previous ||
      step.at_ms > 86400000 ||
      !['consent_default', 'consent_update', 'event'].includes(step.kind)
    )
      fail(uiText('Trace steps require consecutive sequence numbers and nondecreasing relative times within one day.'));
    previous = step.at_ms;
    let region = null,
      wait = null,
      rowConsent;
    if (step.kind !== 'event') {
      if (
        !exact(
          step,
          v2 && step.kind === 'consent_default'
            ? ['sequence', 'at_ms', 'kind', 'consent', 'region', 'wait_for_update_ms']
            : ['sequence', 'at_ms', 'kind', 'consent'],
          ['sequence', 'at_ms', 'kind', 'consent'],
        ) ||
        !object(step.consent) ||
        !Object.keys(step.consent).length ||
        Object.entries(step.consent).some(([k, v]) => !consentTypes.includes(k) || !['granted', 'denied'].includes(v))
      )
        fail(uiText('Consent steps accept only the four Google consent types with granted or denied values.'));
      if (
        (step.region !== undefined &&
          (!Array.isArray(step.region) ||
            step.region.length < 1 ||
            step.region.length > 50 ||
            !step.region.every(measurementTraceRegion) ||
            new Set(step.region).size !== step.region.length)) ||
        (step.wait_for_update_ms !== undefined &&
          (!Number.isSafeInteger(step.wait_for_update_ms) ||
            step.wait_for_update_ms < 0 ||
            step.wait_for_update_ms > 60000))
      )
        fail(
          uiText(
            'A version 2 consent default takes 1–50 distinct region codes such as US or US-CA, and wait_for_update_ms from 0 to 60000.',
          ),
        );
      region = step.region ? [...step.region] : null;
      wait = step.wait_for_update_ms ?? null;
      if (v2 && step.kind === 'consent_default') {
        const scope = applies(region);
        if (region && visitor === null) finding('default_region_unknown', step.sequence);
        if (scope.applies !== false) {
          const key = region ? [...region].sort().join(',') : '';
          if (applied.some(d => d.key === key && Object.keys(step.consent).some(k => Object.hasOwn(d.consent, k))))
            finding('repeated_default', step.sequence);
          if (rows.some(row => row.kind === 'event')) finding('late_default', step.sequence);
          // Whether a later default overrides an earlier update is not documented: the type becomes unknown.
          for (const type of Object.keys(step.consent))
            if (updated.has(type)) {
              ambiguous.add(type);
              finding('ordering_ambiguous', step.sequence);
            }
          applied.push({key, level: scope.level, consent: {...step.consent}});
          defaults++;
          if (wait)
            for (const type of Object.keys(step.consent))
              waiting.set(type, Math.max(waiting.get(type) ?? 0, step.at_ms + wait));
        }
        consent = v2State();
      } else if (v2) {
        if (!defaults) finding('update_without_default', step.sequence);
        for (const [type, value] of Object.entries(step.consent)) {
          updated.set(type, value);
          ambiguous.delete(type);
          waiting.delete(type);
        }
        consent = v2State();
      } else if (step.kind === 'consent_default') {
        if (defaults) finding('repeated_default', step.sequence);
        if (rows.some(row => row.kind === 'event')) finding('late_default', step.sequence);
        defaults++;
        consent = Object.fromEntries(consentTypes.map(k => [k, step.consent[k] ?? 'unknown']));
      } else {
        if (!defaults) finding('update_without_default', step.sequence);
        consent = {...consent, ...step.consent};
      }
    } else {
      if (
        !exact(
          step,
          [
            'sequence',
            'at_ms',
            'kind',
            'event_name',
            'test_id',
            'transaction_key',
            'analytics_storage_write',
            'ad_storage_write',
            ...(v2 ? ['transaction_id_empty'] : []),
          ],
          ['sequence', 'at_ms', 'kind', 'event_name', 'test_id'],
        ) ||
        typeof step.event_name !== 'string' ||
        !/^\p{L}[\p{L}\p{N}_]{0,39}$/u.test(step.event_name) ||
        step.test_id !== trace.scope.test_id ||
        ['analytics_storage_write', 'ad_storage_write'].some(
          k => step[k] !== undefined && typeof step[k] !== 'boolean',
        ) ||
        (step.transaction_key !== undefined &&
          (step.event_name !== 'purchase' ||
            typeof step.transaction_key !== 'string' ||
            !/^opaque-[a-f0-9]{64}$/.test(step.transaction_key))) ||
        (step.transaction_id_empty !== undefined &&
          (step.transaction_id_empty !== true || step.event_name !== 'purchase' || step.transaction_key !== undefined))
      )
        fail(
          uiText(
            'Event steps accept only an exact event name, the selected synthetic test identifier, optional hashed purchase key and storage-write observations.',
          ),
        );
      if (!defaults) finding('event_without_default', step.sequence);
      rowConsent = {...consent};
      // A tag waiting for an update fires with whichever state exists when the update or the timeout comes first.
      for (const [type, until] of waiting)
        if (step.at_ms < until) {
          rowConsent[type] = 'unknown';
          finding('event_during_consent_wait', step.sequence);
        }
      for (const [type, key] of [
        ['analytics_storage', 'analytics_storage_write'],
        ['ad_storage', 'ad_storage_write'],
      ])
        if (step[key] === true && rowConsent[type] === 'denied')
          finding(type === 'analytics_storage' ? 'analytics_storage_conflict' : 'ad_storage_conflict', step.sequence);
      if (step.event_name === 'purchase') {
        const key = step.transaction_id_empty ? measurementTraceEmptyKey : step.transaction_key;
        // GA4 deduplicates every purchase whose transaction ID is empty, so an empty ID is never a unique identity.
        if (key === measurementTraceEmptyKey) finding('empty_transaction_key', step.sequence);
        if (!key) finding('purchase_identity_unknown', step.sequence);
        else if (transactions.has(key)) finding('repeated_purchase_key', step.sequence);
        else transactions.set(key, step.sequence);
      }
    }
    rows.push({
      sequence: step.sequence,
      at_ms: step.at_ms,
      kind: step.kind,
      event_name: step.event_name ?? null,
      consent: rowConsent ?? {...consent},
      analytics_storage_write: step.analytics_storage_write ?? null,
      ad_storage_write: step.ad_storage_write ?? null,
      ...(v2 && step.kind === 'consent_default' ? {region, wait_for_update_ms: wait} : {}),
    });
  }
  // MSR-03: the trace's stream is compared with the synchronized data streams of the property (stored, no request).
  const listed = Array.isArray(streams) ? streams.find(s => s.id === trace.scope.stream_id) : undefined;
  return {
    version: trace.version,
    scope: {...trace.scope},
    coverage: trace.coverage,
    rows,
    findings,
    ...(v2 ? {consent_model: 'regional_defaults_merged'} : {}),
    stream_check: !Array.isArray(streams)
      ? {state: 'inventory_unavailable', stream_type: null}
      : listed
        ? {state: 'listed', stream_type: listed.type ?? null}
        : {state: 'not_listed', stream_type: null},
    qualification: 'supplied_sanitized_trace',
    provider_mutations: 0,
    network_requests: 0,
    runtime_acceptance: 'unverified',
    native_deduplication: 'unverified',
    attribution: 'unverified',
  };
}
function measurementTraceMarkup(targets) {
  return `<section class="panel workspace-form">${measurementSectionHeading('measurement-section-trace', uiText('Inspect a sanitized event trace'))}<p>${esc(uiText('Inspect an explicitly supplied test sequence in this browser. The trace is never sent to AMCP or a provider and is cleared when you leave. This does not certify live consent, deduplication or attribution.'))}</p><form id="measurement-trace">${measurementTargetField(targets, uiText('Selected GA4 property'), 'Connect a GA4 property in Connections to inspect a trace for it.')}<details class="measurement-trace-import"><summary>${esc(uiText('Convert a dataLayer export or HAR file in this browser'))}</summary><p class="form-note" id="measurement-trace-import-help">${esc(uiText('The file is read only in this browser and is never uploaded or stored. Only consent commands, event names, their order and keyed hashes of purchase transaction IDs are kept; URLs, cookies, user and client IDs, transaction IDs and every other field are left out.'))}</p><label>${esc(uiText('File type'))}<select name="import_format"><option value="datalayer">${esc(uiText('dataLayer export (JSON)'))}</option><option value="har">${esc(uiText('HAR file'))}</option></select></label><label>${esc(uiText('File to convert'))}<input type="file" name="import_file" accept=".json,.har,application/json" aria-describedby="measurement-trace-import-help"></label><label>${esc(uiText('Data stream ID'))}<input name="import_stream" inputmode="numeric" dir="ltr" autocomplete="off"></label><label>${esc(uiText('Synthetic test identifier'))}<input name="import_test_id" dir="ltr" autocomplete="off"></label><button class="button" type="button" id="measurement-trace-convert" ${targets.length ? '' : 'disabled'}>${esc(uiText('Convert locally'))}</button><p id="measurement-trace-import-status" class="form-note" role="status"></p></details><label>${esc(uiText('Sanitized trace JSON'))}<textarea name="trace" rows="12" maxlength="1048576" dir="ltr" required aria-describedby="measurement-trace-help"></textarea></label><p id="measurement-trace-help" class="form-note">${esc(uiText('Use version 1 with scope, coverage and steps. Include only synthetic test IDs, relative times, consent states and hashed purchase keys. Raw URLs, cookies, user IDs and original transaction IDs are refused.')).replace(/\b(scope|coverage|steps)\b/g, '<code dir="ltr">$1</code>')} ${esc(uiText('Version 2 also declares scope.visitor_region (a region code or null), optional region lists and wait_for_update_ms on consent defaults, and transaction_id_empty for a purchase whose transaction ID was empty.')).replace(/\b(scope\.visitor_region|wait_for_update_ms|transaction_id_empty)\b/g, '<code dir="ltr">$1</code>')}</p><div class="dialog-actions"><button class="button primary" type="submit" ${targets.length ? '' : 'disabled'}>${esc(uiText('Inspect trace locally'))}</button><button class="button" type="button" id="measurement-trace-example" ${targets.length ? '' : 'disabled'}>${esc(uiText('Load a synthetic example'))}</button><button class="button" type="button" id="measurement-trace-clear">${esc(uiText('Clear trace'))}</button></div></form><div id="measurement-trace-result" aria-live="polite"></div></section>`;
}
function measurementTraceResult(out, page = 0) {
  const labels = {
    event: uiText('Measurement event'),
    consent_default: uiText('Consent default'),
    consent_update: uiText('Consent update'),
    repeated_default: uiText('Repeated default declaration'),
    late_default: uiText('Consent default follows an event'),
    update_without_default: uiText('Consent update has no preceding default'),
    event_without_default: uiText('Event has no preceding consent default'),
    analytics_storage_conflict: uiText('Declared analytics storage write under denied analytics consent'),
    ad_storage_conflict: uiText('Declared advertising storage write under denied advertising consent'),
    purchase_identity_unknown: uiText('Purchase identity is unavailable'),
    repeated_purchase_key: uiText('Repeated hashed purchase key'),
    ordering_ambiguous: uiText(
      'A consent default follows an update of the same type; which one applies is not established, so the type is unknown',
    ),
    default_region_unknown: uiText(
      'A region-specific default applies only if the visitor is in that region, and the trace declares no visitor region',
    ),
    event_during_consent_wait: uiText(
      'Event observed while a consent default was still waiting for an update; its consent state is unknown',
    ),
    empty_transaction_key: uiText(
      'Purchase key comes from an empty transaction ID; GA4 deduplicates every purchase with an empty transaction ID',
    ),
    granted: uiText('Granted'),
    denied: uiText('Denied'),
    unknown: uiText('Unknown'),
  };
  const types = ['analytics_storage', 'ad_storage', 'ad_user_data', 'ad_personalization'],
    written = v => esc(v === true ? uiText('Yes') : v === false ? uiText('No') : uiText('Not declared')),
    detail = r =>
      r.region || r.wait_for_update_ms
        ? ` · ${r.region ? esc(uiText('Regions: {regions}', {regions: r.region.join(', ')})) : esc(uiText('All regions'))}${r.wait_for_update_ms ? ' · ' + esc(uiText('Waits {ms} ms for an update', {ms: r.wait_for_update_ms})) : ''}`
        : '',
    stream = out.stream_check?.state,
    v2 = out.version === 2;
  return `<h3 id="measurement-trace-heading" tabindex="-1">${esc(uiText('Supplied trace observations'))}</h3><p class="notice">${esc(uiText('Findings describe only the supplied sequence. A repeated purchase key does not prove that GA4 counted twice. Events under denied consent can be cookieless; an event alone is not a consent violation. Missing observations remain unknown.'))}</p>${v2 ? `<p class="form-note">${esc(uiText('Version 2 applies the most specific default that matches the declared visitor region and keeps types an earlier default set unless a later one declares them. A default after an update of the same type is reported as unknown, not as a conflict.'))}</p>` : ''}<p>${esc(uiText('Coverage'))}: ${esc(out.coverage === 'complete' ? uiText('Declared complete') : uiText('Declared partial'))} · ${out.rows.length} ${esc(uiText('steps'))} · ${out.findings.length} ${esc(uiText('findings'))}</p><p dir="ltr"><code>${esc(out.scope.property_id)} / ${esc(out.scope.stream_id)} / ${esc(out.scope.test_id)}${v2 ? ' / ' + esc(out.scope.visitor_region ?? '—') : ''}</code></p>${stream ? `<p class="form-note">${esc(stream === 'listed' ? uiText('The trace stream is one of the synchronized data streams of this property.') : stream === 'not_listed' ? uiText('The trace stream is not among the synchronized data streams of this property. Synchronize data streams in Connections or check the stream ID.') : uiText('Data streams of this property are not synchronized, so the trace stream was not compared.'))}${out.stream_check.stream_type ? ` <code dir="ltr">${esc(out.stream_check.stream_type)}</code>` : ''}${out.stream_check.stream_type && out.stream_check.stream_type !== 'WEB_DATA_STREAM' ? ' ' + esc(uiText('GA4 deduplicates purchases by transaction ID only for web streams.')) : ''}</p>` : ''}<ul>${out.findings.map(f => `<li>${esc(uiText('Step {step}: {finding}', {step: f.step, finding: labels[f.code]}))}</li>`).join('') || `<li>${esc(uiText('No selected issue was observed in the supplied trace. Live acceptance remains unverified.'))}</li>`}</ul><div class="report-table-wrap" role="region" tabindex="0" aria-label="${esc(uiText('Event and consent sequence'))}"><table class="report-table"><caption>${esc(uiText('Event and consent sequence'))}</caption><thead><tr><th scope="col">${esc(uiText('Step'))}</th><th scope="col">${esc(uiText('Relative time (ms)'))}</th><th scope="col">${esc(uiText('Observation'))}</th>${types.map(k => `<th scope="col"><code dir="ltr">${k}</code></th>`).join('')}<th scope="col">${esc(uiText('Declared analytics storage write'))}</th><th scope="col">${esc(uiText('Declared advertising storage write'))}</th></tr></thead><tbody>${out.rows
    .slice(page * 25, (page + 1) * 25)
    .map(
      r =>
        `<tr><th scope="row">${r.sequence}</th><td>${r.at_ms}</td><td>${esc(labels[r.kind])}${r.event_name ? ` · <code dir="ltr">${esc(r.event_name)}</code>` : ''}${detail(r)}</td>${types.map(k => `<td>${esc(labels[r.consent[k]])}</td>`).join('')}<td>${r.kind === 'event' ? written(r.analytics_storage_write) : ''}</td><td>${r.kind === 'event' ? written(r.ad_storage_write) : ''}</td></tr>`,
    )
    .join(
      '',
    )}</tbody></table></div><div class="dialog-actions"><button class="button" id="measurement-trace-previous" ${page ? '' : 'disabled'}>${esc(uiText('Previous page'))}</button><span>${esc(uiText('Page'))} ${page + 1}</span><button class="button" id="measurement-trace-next" ${(page + 1) * 25 < out.rows.length ? '' : 'disabled'}>${esc(uiText('Next page'))}</button></div>`;
}
function bindMeasurementTrace(targets) {
  const form = $('#measurement-trace'),
    result = $('#measurement-trace-result'),
    begin = accountWorkflowContext(form, result),
    importStatus = $('#measurement-trace-import-status');
  const clear = () => {
    form.elements.trace.value = '';
    result.innerHTML = '';
    if (form.elements.import_file) form.elements.import_file.value = '';
    if (importStatus) importStatus.textContent = '';
    form.dispatchEvent(new Event('input', {bubbles: true}));
  };
  workspaceBind('#measurement-trace-clear', clear);
  // MSR-03: a dataLayer export or HAR file is converted in this page only; nothing is uploaded, stored or sent.
  // The converter loads with this page (route-assets.js); without it the test identifier is typed. The generated
  // identifier is the field's starting value, not an unsaved edit (WEB-05: a fresh /measurement is pristine).
  if (
    form.elements.import_test_id &&
    !form.elements.import_test_id.value &&
    typeof measurementTraceImportTestId === 'function'
  )
    uiSetInitialValue(form.elements.import_test_id, measurementTraceImportTestId());
  workspaceBind('#measurement-trace-convert', async () => {
    const generation = navigationGeneration,
      identity = identityGeneration,
      attached = () => generation === navigationGeneration && identity === identityGeneration && form.isConnected;
    if (form.elements.target.value === '' && targets.length === 1) form.elements.target.value = '0';
    const t = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !t) throw Error(uiText('Choose a selected GA4 property first.'));
    const format = form.elements.import_format.value === 'har' ? 'har' : 'datalayer',
      file = form.elements.import_file.files?.[0];
    if (!file) throw Error(uiText('Choose a file to convert.'));
    // The size is checked before anything is read.
    if (
      !Number.isSafeInteger(file.size) ||
      file.size >
        (format === 'har' ? measurementTraceImportLimits.har_bytes : measurementTraceImportLimits.datalayer_bytes)
    )
      throw Error(
        uiText(
          format === 'har' ? 'Choose a HAR file of at most 16 MiB.' : 'Choose a dataLayer export of at most 2 MiB.',
        ),
      );
    const streams = measurementInventory('ga4', 'data_streams', t),
      streamId = form.elements.import_stream.value.trim() || (streams.length === 1 ? streams[0].id : ''),
      text = await file.text();
    if (!attached()) return;
    const out = await measurementTraceImport(text, {
      format,
      property_id: t.account_id,
      stream_id: streamId,
      test_id: form.elements.import_test_id.value.trim(),
      measurement_id: streams.find(s => s.id === streamId)?.measurement_id ?? null,
    });
    if (!attached()) return;
    form.elements.import_stream.value = streamId;
    form.elements.trace.value = out.json;
    form.dispatchEvent(new Event('input', {bubbles: true}));
    const s = out.summary;
    importStatus.textContent = [
      uiText(
        'Converted in this browser: {events} events and {consent} consent commands kept, {dropped} entries left out. Times follow the original order; real timing is unknown. Review the trace, then inspect it.',
        {events: uiNumber(s.events), consent: uiNumber(s.consent), dropped: uiNumber(s.dropped)},
      ),
      s.format === 'har'
        ? uiText('A HAR file establishes no consent state, because GA4 does not document its gcs and gcd parameters.')
        : '',
      s.format === 'har' && s.stream_filter === 'none'
        ? uiText('The measurement ID of this stream is not synchronized, so requests of every GA4 stream were kept.')
        : '',
      s.other_streams
        ? uiText('{count} requests of other streams were left out.', {count: uiNumber(s.other_streams)})
        : '',
      s.truncated ? uiText('Only the first {steps} steps were kept.', {steps: uiNumber(s.steps)}) : '',
    ]
      .filter(Boolean)
      .join(' ');
  });
  workspaceBind('#measurement-trace-example', () => {
    // MSR-02: the only property is preselected; otherwise the example explains inline which choice it needs.
    if (form.elements.target.value === '' && targets.length === 1) form.elements.target.value = '0';
    const t = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !t) {
      result.innerHTML = `<p class="notice" role="alert">${esc(uiText('Choose a selected GA4 property first.'))}</p>`;
      form.elements.target.focus?.();
      return;
    }
    form.elements.trace.value = JSON.stringify(
      {
        version: 1,
        scope: {
          property_id: t.account_id,
          stream_id: measurementInventory('ga4', 'data_streams', t)[0]?.id ?? '100',
          test_id: 'amcp-test-local-example',
        },
        coverage: 'partial',
        steps: [
          {
            sequence: 1,
            at_ms: 0,
            kind: 'consent_default',
            consent: {
              analytics_storage: 'denied',
              ad_storage: 'denied',
              ad_user_data: 'denied',
              ad_personalization: 'denied',
            },
          },
          {
            sequence: 2,
            at_ms: 100,
            kind: 'event',
            event_name: 'page_view',
            test_id: 'amcp-test-local-example',
            analytics_storage_write: false,
          },
          {sequence: 3, at_ms: 200, kind: 'consent_update', consent: {analytics_storage: 'granted'}},
          {
            sequence: 4,
            at_ms: 300,
            kind: 'event',
            event_name: 'purchase',
            test_id: 'amcp-test-local-example',
            transaction_key: 'opaque-' + 'a'.repeat(64),
            analytics_storage_write: true,
          },
        ],
      },
      null,
      2,
    );
    form.dispatchEvent(new Event('input', {bubbles: true}));
  });
  workspaceBind('#measurement-trace', () => {
    const current = begin(),
      t = targets[Number(form.elements.target.value)];
    if (!current()) return;
    if (form.elements.target.value === '' || !t) throw Error(uiText('Choose a selected GA4 property first.'));
    const out = measurementTraceInspect(form.elements.trace.value, t, measurementStreamInventory(t));
    let page = 0;
    const render = focus => {
      if (!current()) return;
      result.innerHTML = measurementTraceResult(out, page);
      workspaceBind('#measurement-trace-previous', () => {
        page = Math.max(0, page - 1);
        render(true);
      });
      workspaceBind('#measurement-trace-next', () => {
        page = Math.min(Math.ceil(out.rows.length / 25) - 1, page + 1);
        render(true);
      });
      if (focus) $('#measurement-trace-heading').focus();
    };
    render(true);
  });
}
function prefillMeasurementAudit(form, result, targets) {
  if (typeof location === 'undefined') return;
  const params = new URLSearchParams(location.search),
    keys = ['connection_id', 'account_id', 'container_id', 'workspace_id'];
  if (['conversion_rules', 'event_identity', 'google_goals', 'ga4_config', 'ledger'].some(key => params.has(key)))
    return;
  if (!keys.some(key => params.has(key))) return;
  for (const key of ['target', 'container_id', 'workspace_id']) form.elements[key].value = '';
  const account = params.get('account_id'),
    login = params.get('connection_id'),
    container = params.get('container_id') ?? '',
    workspace = params.get('workspace_id') ?? '',
    index = targets.findIndex(target => target.connection_id === login && target.account_id === account),
    valid =
      keys.every(key => params.getAll(key).length <= 1) &&
      index >= 0 &&
      (!container || /^[A-Za-z0-9_-]{1,128}$/.test(container)) &&
      (!workspace || (container && /^[A-Za-z0-9_-]{1,128}$/.test(workspace)));
  if (!valid) {
    result.innerHTML = `<p class="notice">${esc(uiText('The linked audit scope is unavailable. Choose a currently selected account.'))}</p>`;
    return;
  }
  form.elements.target.value = String(index);
  form.elements.container_id.value = container;
  form.elements.workspace_id.value = workspace;
  result.innerHTML = `<p class="form-note" role="status">${esc(uiText('Scope selected from an audit link. Read current configuration to refresh the evidence.'))}</p>`;
}
// MSR-02: every measurement form uses one target field. Without an eligible account it says how to connect one (and
// the caller disables submit); with exactly one it is preselected. Preselection never starts a read.
function measurementTargetField(targets, label, emptyNotice, choose = uiText('Choose a selected account')) {
  return `${targets.length ? '' : `<p class="notice measurement-empty">${accountChoicesEmptyNotice(targets, uiText(emptyNotice))}</p>`}<label>${esc(label)}<select name="target" required ${targets.length ? '' : 'disabled'}><option value="">${esc(choose)}</option>${targets.map((t, i) => `<option value="${i}" ${targets.length === 1 ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>`;
}
const measurementId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
// Synchronized inventory this login already holds (no request): GTM containers and GA4 data streams of one account.
function measurementInventory(platformId, kind, target) {
  if (!target) return [];
  const connection = platforms
      .find(p => p.id === platformId)
      ?.connections.find(c => c.enabled && c.id === target.connection_id),
    assets = connection?.groups?.find(g => g.kind === kind)?.assets ?? [],
    pattern =
      kind === 'containers'
        ? new RegExp('^accounts/' + target.account_id + '/containers/([0-9]{1,20})$')
        : new RegExp('^properties/' + target.account_id + '/dataStreams/([1-9][0-9]{0,19})$');
  const rows = [],
    seen = new Set();
  for (const asset of assets) {
    const id = typeof asset?.id === 'string' ? pattern.exec(asset.id)?.[1] : undefined;
    if (!id || seen.has(id) || rows.length >= 500) continue;
    seen.add(id);
    rows.push({
      id,
      name: typeof asset.name === 'string' && asset.name !== asset.id ? asset.name.slice(0, 200) : null,
      // MSR-03: synced GA4 streams retain their native type and measurement ID when discovery returned them.
      detail: [asset.measurementId, asset.streamType]
        .filter(v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v))
        .join(' · '),
      type: typeof asset.streamType === 'string' && /^[A-Z_]{1,64}$/.test(asset.streamType) ? asset.streamType : null,
      measurement_id:
        typeof asset.measurementId === 'string' && /^G-[A-Z0-9]{4,20}$/.test(asset.measurementId)
          ? asset.measurementId
          : null,
    });
  }
  return rows;
}
// The synchronized data streams of one property, or null when they were never completely synchronized (MSR-03).
function measurementStreamInventory(target) {
  if (!target) return null;
  const group = platforms
    .find(p => p.id === 'ga4')
    ?.connections.find(c => c.enabled && c.id === target.connection_id)
    ?.groups?.find(g => g.kind === 'data_streams');
  return group && group.complete !== false && Array.isArray(group.assets)
    ? measurementInventory('ga4', 'data_streams', target)
    : null;
}
// The audit's own discovery of containers and workspaces, kept in memory for the current identity only.
let measurementDiscovered = null;
function measurementDiscoveredRows(key) {
  if (!measurementDiscovered || measurementDiscovered.identity !== identityGeneration) return [];
  return measurementDiscovered.rows.get(key) ?? [];
}
const measurementScopeParams = {
  gtm: ['ms_gtm_login', 'ms_gtm_account'],
  ga4: ['ms_ga4_login', 'ms_ga4_property'],
  google: ['ms_google_login', 'ms_google_account'],
  linkedin: ['ms_linkedin_login', 'ms_linkedin_account'],
};
function measurementScopeMarkup(sets) {
  const select = (name, label, targets) =>
    `<label>${esc(label)}<select name="${name}" ${targets.length ? '' : 'disabled'}><option value="">${esc(uiText('Not chosen'))}</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>`;
  return `<section class="panel workspace-form measurement-scope" aria-labelledby="measurement-scope-heading"><h2 id="measurement-scope-heading">${esc(uiText('Measurement scope'))}</h2><p class="form-note" id="measurement-scope-help">${esc(uiText('Choose accounts once and every task below starts with them. Choosing makes no request; each read starts only when you submit its form.'))}</p><form id="measurement-scope" aria-describedby="measurement-scope-help"><fieldset><legend>${esc(uiText('Google Tag Manager'))}</legend>${select('gtm', uiText('Tag Manager account'), sets.gtm)}<label>${esc(uiText('Container'))}<select name="container" disabled><option value="">${esc(uiText('All containers'))}</option></select></label><label>${esc(uiText('Workspace'))}<select name="workspace" disabled><option value="">${esc(uiText('All workspaces'))}</option></select></label></fieldset><fieldset><legend>${esc(uiText('Google Analytics 4'))}</legend>${select('ga4', uiText('GA4 property'), sets.ga4)}<label>${esc(uiText('Data stream'))}<select name="stream" disabled><option value="">${esc(uiText('All streams'))}</option></select></label></fieldset><fieldset><legend>${esc(uiText('Advertising accounts'))}</legend>${select('google', uiText('Google Ads account'), sets.google)}${select('linkedin', uiText('LinkedIn advertising account'), sets.linkedin)}</fieldset><p class="form-note">${esc(uiText('Each task keeps its own fields, so you can still choose another account or type an ID there.'))}</p><button type="button" class="button small" id="measurement-scope-clear">${esc(uiText('Clear scope'))}</button><p id="measurement-scope-status" class="form-note" role="status"></p></form></section>`;
}
/**
 * One measurement scope shared by every task (MSR-02). It lives only in this page's URL (ms_* parameters), so leaving
 * the page clears it. Values that no longer match an account selected for the current identity are dropped and removed
 * from the URL, so an identity change clears a stale scope. Applying a scope only fills form fields and clears their earlier results; reads stay
 * submit-only.
 */
function bindMeasurementScope(sets) {
  const form = $('#measurement-scope'),
    status = $('#measurement-scope-status'),
    fields = form?.elements ?? {},
    generation = navigationGeneration,
    identity = identityGeneration,
    attached = () => generation === navigationGeneration && identity === identityGeneration && form.isConnected;
  if (!form || !fields.gtm) return;
  const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
  const indexOf = (kind, login, account) =>
    sets[kind].findIndex(t => t.connection_id === login && t.account_id === account);
  // Only accounts someone chose (here or in the link) are written to the URL; a preselected only account is not.
  const chosen = new Set();
  let scope = {gtm: null, container: '', workspace: '', ga4: null, stream: '', google: null, linkedin: null},
    stale = false;
  {
    for (const [kind, [loginKey, accountKey]] of Object.entries(measurementScopeParams)) {
      if (!params.has(loginKey) && !params.has(accountKey)) continue;
      const index =
        params.getAll(loginKey).length === 1 && params.getAll(accountKey).length === 1
          ? indexOf(kind, params.get(loginKey), params.get(accountKey))
          : -1;
      if (index < 0) stale = true;
      else {
        scope[kind] = index;
        chosen.add(kind);
      }
    }
    const extra = (key, valid) => {
      if (!params.has(key)) return '';
      const value = params.getAll(key).length === 1 ? params.get(key) : '';
      if (!valid(value)) stale = true;
      return valid(value) ? value : '';
    };
    scope.container = extra('ms_container', value => scope.gtm !== null && /^[0-9]{1,20}$/.test(value));
    scope.workspace = extra('ms_workspace', value => !!scope.container && measurementId(value));
    scope.stream = extra('ms_stream', value => scope.ga4 !== null && /^[1-9][0-9]{0,19}$/.test(value));
  }
  for (const kind of Object.keys(measurementScopeParams))
    if (scope[kind] === null && sets[kind].length === 1) scope[kind] = 0;
  let ledgerKind = ['google', 'ga4'].find(kind => chosen.has(kind)) ?? null;
  const options = (select, empty, rows, chosen) => {
    const list = rows.some(r => r.id === chosen) || !chosen ? rows : [...rows, {id: chosen, name: null, detail: ''}];
    select.innerHTML =
      `<option value="">${esc(empty)}</option>` +
      list
        .map(
          r =>
            `<option value="${esc(r.id)}">${esc(r.name ? r.name + ' (' + r.id + ')' : r.id)}${r.detail ? ' · ' + esc(r.detail) : ''}</option>`,
        )
        .join('');
    select.value = chosen;
    select.disabled = false;
  };
  const choices = () => {
    const gtm = scope.gtm === null ? null : sets.gtm[scope.gtm],
      ga4 = scope.ga4 === null ? null : sets.ga4[scope.ga4];
    if (gtm) {
      const discovered = measurementDiscoveredRows('containers|' + gtm.connection_id + '|' + gtm.account_id),
        inventory = measurementInventory('gtm', 'containers', gtm);
      options(
        fields.container,
        uiText('All containers'),
        [...inventory, ...discovered.filter(r => !inventory.some(i => i.id === r.id))],
        scope.container,
      );
    } else {
      fields.container.innerHTML = `<option value="">${esc(uiText('All containers'))}</option>`;
      fields.container.value = '';
      fields.container.disabled = true;
    }
    if (gtm && scope.container)
      options(
        fields.workspace,
        uiText('All workspaces'),
        measurementDiscoveredRows('workspaces|' + gtm.connection_id + '|' + gtm.account_id + '|' + scope.container),
        scope.workspace,
      );
    else {
      fields.workspace.innerHTML = `<option value="">${esc(uiText('All workspaces'))}</option>`;
      fields.workspace.value = '';
      fields.workspace.disabled = true;
    }
    if (ga4)
      options(fields.stream, uiText('All streams'), measurementInventory('ga4', 'data_streams', ga4), scope.stream);
    else {
      fields.stream.innerHTML = `<option value="">${esc(uiText('All streams'))}</option>`;
      fields.stream.value = '';
      fields.stream.disabled = true;
    }
    for (const kind of Object.keys(measurementScopeParams))
      fields[kind].value = scope[kind] === null ? '' : String(scope[kind]);
  };
  const remember = () => {
    if (typeof location === 'undefined' || typeof history === 'undefined' || typeof history.replaceState !== 'function')
      return;
    const next = new URLSearchParams(location.search);
    for (const key of [...Object.values(measurementScopeParams).flat(), 'ms_container', 'ms_workspace', 'ms_stream'])
      next.delete(key);
    for (const [kind, [loginKey, accountKey]] of Object.entries(measurementScopeParams)) {
      const t = scope[kind] === null ? null : sets[kind][scope[kind]];
      if (!t || !(chosen.has(kind) || (kind === 'gtm' && scope.container) || (kind === 'ga4' && scope.stream)))
        continue;
      next.set(loginKey, t.connection_id);
      next.set(accountKey, t.account_id);
    }
    if (scope.container) next.set('ms_container', scope.container);
    if (scope.workspace) next.set('ms_workspace', scope.workspace);
    if (scope.stream) next.set('ms_stream', scope.stream);
    const query = next.toString();
    history.replaceState(history.state, '', location.pathname + (query ? '?' + query : '') + (location.hash ?? ''));
  };
  // Writes the scope into each task form. Initially only chosen values are written; an explicit change also writes
  // cleared values and invalidates that form's earlier result.
  const apply = explicit => {
    const write = (formId, values) => {
      const target = $('#' + formId),
        elements = target?.elements;
      if (!elements) return;
      let changed = false;
      for (const [name, value] of Object.entries(values)) {
        if (!elements[name] || value === undefined || (!explicit && value === '')) continue;
        if (elements[name].value !== value) changed = true;
        elements[name].value = value;
      }
      if (explicit && changed) target.dispatchEvent(new Event('change', {bubbles: true}));
    };
    const index = kind => (scope[kind] === null ? '' : String(scope[kind])),
      // Without an account, an explicit change clears the dependent IDs; the initial fill leaves typed IDs alone.
      dependent = (kind, value) => (scope[kind] === null ? (explicit ? '' : undefined) : value);
    write('measurement-audit', {
      target: index('gtm'),
      container_id: dependent('gtm', scope.container),
      workspace_id: dependent('gtm', scope.workspace),
    });
    for (const id of ['measurement-events', 'measurement-event-identity'])
      write(id, {target: index('ga4'), stream_id: dependent('ga4', scope.stream)});
    write('measurement-trace', {target: index('ga4'), import_stream: dependent('ga4', scope.stream)});
    write('measurement-ga4-config', {target: index('ga4')});
    write('measurement-conversions', {target: index('linkedin')});
    write('measurement-google-goals', {target: index('google')});
    // The ledger lists Google Ads accounts, then GA4 properties, and follows the kind chosen last (MSR-03).
    const ledger = [ledgerKind, 'google', 'ga4'].find(kind => kind && scope[kind] !== null);
    write('measurement-ledger', {
      target: ledger ? String((ledger === 'ga4' ? sets.google.length : 0) + scope[ledger]) : '',
    });
  };
  measurementScopeController = {
    attached,
    // A container or workspace chosen from the audit's own discovery list (never a request).
    choose(kind, value, container) {
      if (!attached()) return;
      if (kind === 'container') {
        scope.container = value;
        scope.workspace = '';
      } else {
        scope.container = container;
        scope.workspace = value;
      }
      choices();
      remember();
      apply(true);
    },
    discovered() {
      if (attached()) choices();
    },
  };
  choices();
  apply(false);
  if (stale) {
    remember();
    status.textContent = uiText(
      'Part of the linked measurement scope no longer matches your selected accounts and was cleared.',
    );
  }
  form.addEventListener('change', event => {
    if (!attached()) return;
    const name = event?.target?.name;
    if (['gtm', 'ga4', 'google', 'linkedin'].includes(name)) {
      const value = fields[name].value,
        index = value === '' ? null : Number(value);
      if (index !== null && !sets[name][index]) return;
      scope[name] = index;
      if (index === null) chosen.delete(name);
      else chosen.add(name);
      if (name === 'google' || name === 'ga4')
        ledgerKind = index !== null ? name : ledgerKind === name ? null : ledgerKind;
      if (name === 'gtm') scope.container = scope.workspace = '';
      if (name === 'ga4') scope.stream = '';
    } else if (name === 'container') {
      scope.container = /^[0-9]{1,20}$/.test(fields.container.value) ? fields.container.value : '';
      scope.workspace = '';
    } else if (name === 'workspace')
      scope.workspace = measurementId(fields.workspace.value) ? fields.workspace.value : '';
    else if (name === 'stream')
      scope.stream = /^[1-9][0-9]{0,19}$/.test(fields.stream.value) ? fields.stream.value : '';
    else return;
    status.textContent = '';
    choices();
    remember();
    apply(true);
  });
  $('#measurement-scope-clear')?.addEventListener('click', () => {
    if (!attached()) return;
    scope = {gtm: null, container: '', workspace: '', ga4: null, stream: '', google: null, linkedin: null};
    chosen.clear();
    ledgerKind = null;
    status.textContent = uiText('The measurement scope was cleared.');
    choices();
    remember();
    apply(true);
  });
}
let measurementScopeController = null;
// The audit lists the containers of an account or the workspaces of a container. Each can be chosen without typing.
function gtmDiscoveryRows(c, target, requirements) {
  const kind = !requirements.container_id ? 'container' : !requirements.workspace_id ? 'workspace' : null,
    source = kind === 'container' ? c.containers : kind === 'workspace' ? c.workspaces : null;
  if (!kind || !target || !Array.isArray(source) || source.length > 1000) return null;
  const seen = new Set(),
    rows = [];
  for (const row of source) {
    const id = kind === 'container' ? row?.container_id : row?.workspace_id;
    if (
      !(kind === 'container' ? /^[0-9]{1,20}$/.test(id ?? '') : measurementId(id)) ||
      seen.has(id) ||
      (row.name !== null && row.name !== undefined && (typeof row.name !== 'string' || row.name.length > 256))
    )
      return null;
    seen.add(id);
    rows.push({id, name: row.name ?? null, detail: ''});
  }
  return {kind, target, container: requirements.container_id ?? '', rows};
}
function gtmDiscoveryMarkup(discovery) {
  if (!discovery) return '';
  const shown = discovery.rows.slice(0, 200),
    container = discovery.kind === 'container';
  return `<section class="measurement-discovery"><h3>${esc(uiText(container ? 'Containers in this account' : 'Workspaces in this container'))}</h3><p class="form-note">${esc(uiText('Choose one to fill the audit scope, then read its configuration. Choosing makes no request.'))}</p>${shown.length ? `<ul class="measurement-choice-list">${shown.map((r, i) => `<li><span dir="auto">${esc(r.name ?? uiText('Unnamed'))}</span> <code dir="ltr">${esc(r.id)}</code> <button type="button" class="button small" id="gtm-choice-${i}">${esc(uiText(container ? 'Use this container' : 'Use this workspace'))}</button></li>`).join('')}</ul>` : `<p>${esc(uiText(container ? 'No containers were returned for this account.' : 'No workspaces were returned for this container.'))}</p>`}${discovery.rows.length > shown.length ? `<p class="form-note">${esc(uiText('Only the first 200 are listed. Type another ID in the audit form.'))}</p>` : ''}</section>`;
}
function mountGtmDiscovery(discovery, form, selectionCurrent) {
  if (!discovery) return;
  const {kind, target, container} = discovery,
    key =
      kind === 'container'
        ? 'containers|' + target.connection_id + '|' + target.account_id
        : 'workspaces|' + target.connection_id + '|' + target.account_id + '|' + container;
  if (!measurementDiscovered || measurementDiscovered.identity !== identityGeneration)
    measurementDiscovered = {identity: identityGeneration, rows: new Map()};
  measurementDiscovered.rows.set(key, discovery.rows.slice(0, 1000));
  measurementScopeController?.discovered();
  discovery.rows.slice(0, 200).forEach((row, i) => {
    $('#gtm-choice-' + i)?.addEventListener('click', () => {
      if (!selectionCurrent() || !form.isConnected) return;
      const scopeForm = $('#measurement-scope'),
        index = scopeForm?.elements?.gtm?.value;
      // The scope bar follows the chosen row when it already names this account; the audit form is always filled.
      if (measurementScopeController?.attached() && index !== undefined && index === form.elements.target.value) {
        measurementScopeController.choose(kind, row.id, container);
      }
      if (kind === 'container') {
        form.elements.container_id.value = row.id;
        form.elements.workspace_id.value = '';
      } else form.elements.workspace_id.value = row.id;
      form.dispatchEvent(new Event('change', {bubbles: true}));
      $('#measurement-audit-submit')?.focus();
    });
  });
}
const measurementGoalStatuses = {
  account_default_conversion_goals: 'Biddable account-default goals',
  primary_conversion_actions: 'Primary conversion actions',
  conversion_value_configuration: 'Conversion value settings',
  reported_conversion_activity: 'Reported conversion activity',
};
const measurementGoalReasons = {
  manager_account: 'This is a manager account. Choose a client account that records its own conversions.',
  shared_conversion_customer:
    'This account uses another customer’s conversion tracking. AMCP did not read that customer, so goals stay unknown.',
  conversion_customer_unknown: 'Google Ads did not report the conversion tracking customer, so goals stay unknown.',
};
function measurementGoogleGoalsMarkup(targets) {
  return `<section class="panel workspace-form">${measurementSectionHeading('measurement-section-goals', uiText('Google Ads conversion goals'))}<p>${esc(uiText('Inspect account-default conversion goals, primary conversion actions, their value settings and last reported activity for one Google Ads account. This is configuration, not proof of delivery.'))}</p><form id="measurement-google-goals">${measurementTargetField(targets, uiText('Google Ads account'), 'Connect Google Ads and select a customer account in Connections to inspect conversion goals.')}<button class="button primary" type="submit" ${targets.length ? '' : 'disabled'}>${esc(uiText('Read conversion goals'))}</button></form><div id="measurement-google-goals-result" aria-live="polite"></div></section>`;
}
function measurementGoogleGoalsValid(out, target) {
  const text = (v, max = 256) => typeof v === 'string' && v.length <= max && !/[\x00-\x1f\x7f]/.test(v),
    code = v => typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v),
    nullableText = (v, max) => v === null || text(v, max),
    statuses = ['ready', 'blocked', 'unknown'];
  if (
    !out ||
    out.record_kind !== 'measurement_google_goals' ||
    out.provider_mutations !== 0 ||
    out.scope?.gateway !== 'google_ads_native_action' ||
    out.scope.account_id !== target.account_id ||
    out.scope.connection_id !== target.connection_id ||
    typeof out.complete !== 'boolean' ||
    !out.dependency_statuses ||
    Object.entries(out.dependency_statuses).some(
      ([k, v]) => !Object.hasOwn(measurementGoalStatuses, k) || !statuses.includes(v),
    )
  )
    return false;
  if (!out.complete) return true;
  return (
    Array.isArray(out.goals) &&
    out.goals.length <= 20 &&
    out.goals.every(
      g =>
        g &&
        text(g.resource_name, 300) &&
        code(g.category) &&
        code(g.origin) &&
        typeof g.biddable === 'boolean' &&
        Number.isSafeInteger(g.matching_primary_actions),
    ) &&
    Array.isArray(out.primary_actions) &&
    out.primary_actions.length <= 20 &&
    out.primary_actions.every(
      a =>
        a &&
        text(a.resource_name, 300) &&
        text(a.name) &&
        code(a.category) &&
        code(a.origin) &&
        code(a.status) &&
        (!a.value_settings ||
          ((a.value_settings.default_value === null || Number.isFinite(a.value_settings.default_value)) &&
            nullableText(a.value_settings.default_currency_code, 3) &&
            [true, false, null].includes(a.value_settings.always_use_default_value))) &&
        (!a.activity ||
          (nullableText(a.activity.last_conversion_date, 10) && nullableText(a.activity.last_tag_received_time, 26))),
    ) &&
    !!out.summary &&
    typeof out.summary === 'object' &&
    Object.values(out.summary).every(v => Number.isSafeInteger(v) && v >= 0)
  );
}
function measurementGoogleGoalsView(out, target) {
  const unknown = esc(uiText('Unknown')),
    native = v => (v === null || v === undefined ? unknown : `<code dir="ltr">${esc(v)}</code>`),
    status = v => esc(v === 'ready' ? uiText('Ready') : v === 'blocked' ? uiText('Blocked') : uiText('Unknown')),
    statusRows = Object.entries(out.dependency_statuses)
      .map(([k, v]) => `<li>${esc(uiText(measurementGoalStatuses[k]))}: ${status(v)}</li>`)
      .join('');
  let html = `<h3 id="measurement-google-goals-heading" tabindex="-1">${esc(target.label)}</h3><p>${esc(uiText('Requested {requested} · Returned {captured}', {requested: date(out.requested_at), captured: date(out.captured_at)}))}</p>${badge(out.complete ? 'complete' : 'incomplete')}<p class="notice">${esc(uiAccountExplanation(out.meaning))}</p><ul>${statusRows}</ul>`;
  if (!out.complete) {
    const reason = Object.hasOwn(measurementGoalReasons, out.reason)
      ? measurementGoalReasons[out.reason]
      : 'The current conversion configuration could not be completely inspected. Read it again.';
    return (
      html +
      `<p class="notice" role="status">${esc(uiText(reason))}</p>${recordDetails(out, uiText('Conversion goal scope, limits and source references'))}`
    );
  }
  const values = a =>
      !a.value_settings
        ? unknown
        : a.value_settings.default_value === null
          ? unknown
          : `<span dir="ltr">${esc(String(a.value_settings.default_value))} ${esc(a.value_settings.default_currency_code ?? '')}</span>`,
    always = a =>
      esc(
        a.value_settings?.always_use_default_value === true
          ? uiText('Yes')
          : a.value_settings?.always_use_default_value === false
            ? uiText('No')
            : uiText('Unknown'),
      );
  html += `<div class="workspace-metrics"><article><strong>${esc(uiNumber(out.summary.goals ?? 0))}</strong><span>${esc(uiText('Account-default goals'))}</span></article><article><strong>${esc(uiNumber(out.summary.biddable_goals ?? 0))}</strong><span>${esc(uiText('Biddable goals'))}</span></article><article><strong>${esc(uiNumber(out.summary.matching_primary_actions ?? 0))}</strong><span>${esc(uiText('Matching primary actions'))}</span></article></div>`;
  html += `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Account-default conversion goals'))}"><table class="review-table"><caption>${esc(uiText('Account-default conversion goals'))}</caption><thead><tr><th scope="col">${esc(uiText('Goal category'))}</th><th scope="col">${esc(uiText('Origin'))}</th><th scope="col">${esc(uiText('Biddable'))}</th><th scope="col">${esc(uiText('Matching primary actions'))}</th></tr></thead><tbody>${out.goals.map(g => `<tr><th scope="row">${native(g.category)}</th><td>${native(g.origin)}</td><td>${esc(g.biddable ? uiText('Yes') : uiText('No'))}</td><td>${esc(uiNumber(g.matching_primary_actions))}</td></tr>`).join('') || `<tr><td colspan="4">${esc(uiText('No account-default goals were returned.'))}</td></tr>`}</tbody></table></div>`;
  html += `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Primary conversion actions'))}"><table class="review-table"><caption>${esc(uiText('Primary conversion actions'))}</caption><thead><tr><th scope="col">${esc(uiText('Conversion action'))}</th><th scope="col">${esc(uiText('Goal category'))}</th><th scope="col">${esc(uiText('Status'))}</th><th scope="col">${esc(uiText('Default value'))}</th><th scope="col">${esc(uiText('Always use default value'))}</th><th scope="col">${esc(uiText('Last conversion date'))}</th><th scope="col">${esc(uiText('Last tag detected'))}</th></tr></thead><tbody>${out.primary_actions.map(a => `<tr><th scope="row"><bdi dir="auto">${esc(a.name)}</bdi><br><code dir="ltr">${esc(a.resource_name)}</code></th><td>${native(a.category)} · ${native(a.origin)}</td><td>${native(a.status)}</td><td>${values(a)}</td><td>${always(a)}</td><td>${native(a.activity?.last_conversion_date ?? null)}</td><td>${native(a.activity?.last_tag_received_time ?? null)}</td></tr>`).join('') || `<tr><td colspan="7">${esc(uiText('No enabled primary action matches a biddable goal.'))}</td></tr>`}</tbody></table></div>`;
  if (out.display_omissions?.goals > 0 || out.display_omissions?.primary_actions > 0)
    html += `<p class="form-note">${esc(uiText('Only the first 20 goals and 20 primary actions are listed; the counts above include every row read.'))}</p>`;
  return (
    html +
    `<p>${esc(uiText('Configured goals and actions are not proof that conversions are delivered, deduplicated, consented or attributed. Dates are reported by Google Ads in the account timezone. Nothing was changed and no snapshot was saved.'))}</p>${recordDetails(out, uiText('Conversion goal scope, limits and source references'))}`
  );
}
function bindMeasurementGoogleGoals(targets) {
  const form = $('#measurement-google-goals'),
    result = $('#measurement-google-goals-result');
  if (!form?.elements?.target) return;
  const begin = accountWorkflowContext(form, result);
  if (typeof location !== 'undefined') {
    const params = new URLSearchParams(location.search);
    if (params.has('google_goals')) {
      const index = targets.findIndex(
          t => t.account_id === params.get('account_id') && t.connection_id === params.get('connection_id'),
        ),
        valid =
          params.get('google_goals') === '1' &&
          ['google_goals', 'account_id', 'connection_id'].every(k => params.getAll(k).length === 1) &&
          index >= 0;
      form.elements.target.value = valid ? String(index) : '';
      result.innerHTML = `<p class="form-note" role="status">${esc(valid ? uiText('Account selected from a conversion goal link. Read current goals to refresh the evidence.') : uiText('The linked Google Ads account is unavailable. Choose a currently selected account.'))}</p>`;
    }
  }
  workspaceBind('#measurement-google-goals', async () => {
    const current = begin();
    if (!current()) return;
    const target = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !target) throw Error(uiText('Choose a Google Ads account.'));
    let out;
    try {
      out = await workspaceCall('workspace', {
        action: 'measurement_google_goals',
        gateway: 'google_ads_native_action',
        connection_id: target.connection_id,
        account_id: target.account_id,
      });
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    if (!measurementGoogleGoalsValid(out, target))
      throw Error(
        uiText('The conversion goal response is incomplete or belongs to a different selection. Read it again.'),
      );
    result.innerHTML = measurementGoogleGoalsView(out, target);
    $('#measurement-google-goals-heading')?.focus();
  });
}
// MSR-03 slice B: one GA4 property's Admin configuration. Google tags are related to its streams from the synchronized
// Tag Manager inventory, without a request; the read itself starts only on submit.
const measurementTestDimension = {
  registered: 'Registered with event scope',
  other_scope: 'Registered with another scope',
  not_registered: 'Not registered',
  not_read: 'Not read',
};
function measurementGa4ConfigMarkup(targets) {
  return `<section class="panel workspace-form">${measurementSectionHeading('measurement-section-ga4config', uiText('GA4 property configuration'))}<p>${esc(uiText('Read key events, custom dimensions and metrics, data streams, Google Ads links and data retention for one GA4 property. This reads configuration only; it does not show that events are sent or counted.'))}</p><form id="measurement-ga4-config">${measurementTargetField(targets, uiText('GA4 property'), 'Connect a GA4 property in Connections to read its configuration.', uiText('Choose a login and account'))}<button class="button primary" type="submit" ${targets.length ? '' : 'disabled'}>${esc(uiText('Read property configuration'))}</button></form><div id="measurement-ga4-config-result" aria-live="polite"></div></section>`;
}
function measurementGa4ConfigValid(out, target) {
  const text = (v, max = 300) => v === null || (typeof v === 'string' && v.length <= max),
    code = v => v === null || (typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v)),
    list = (v, check) =>
      v === undefined ||
      (Array.isArray(v) && v.length <= 1000 && v.every(r => !!r && typeof r === 'object' && check(r)));
  return (
    !!out &&
    out.record_kind === 'measurement_ga4_config' &&
    out.provider_mutations === 0 &&
    out.complete === true &&
    out.scope?.gateway === 'ga4_native_action' &&
    out.scope.property_id === target.account_id &&
    out.scope.connection_id === target.connection_id &&
    Object.hasOwn(measurementTestDimension, out.checks?.test_identifier_dimension) &&
    // MSR-04: absent from older responses.
    [undefined, 'registered', 'not_registered', 'not_read'].includes(out.checks.realtime_identity_dimension) &&
    list(out.key_events, r => text(r.event_name, 100) && !!r.event_name && code(r.counting_method)) &&
    list(out.custom_dimensions, r => text(r.parameter_name, 100) && text(r.display_name) && code(r.scope)) &&
    list(
      out.custom_metrics,
      r =>
        text(r.parameter_name, 100) &&
        text(r.display_name) &&
        code(r.measurement_unit) &&
        Array.isArray(r.restricted_metric_types) &&
        r.restricted_metric_types.every(code),
    ) &&
    list(
      out.data_streams,
      r =>
        /^[1-9][0-9]{0,19}$/.test(r.stream_id ?? '') &&
        code(r.type) &&
        text(r.display_name) &&
        (r.measurement_id === null || /^G-[A-Z0-9]{4,20}$/.test(r.measurement_id ?? '')),
    ) &&
    list(out.google_ads_links, r => /^[0-9]{1,32}$/.test(r.customer_id ?? '')) &&
    (out.data_retention === undefined ||
      (!!out.data_retention &&
        code(out.data_retention.event_data_retention) &&
        code(out.data_retention.user_data_retention)))
  );
}
// Synchronized Tag Manager containers whose Google tag IDs include a measurement ID (stored inventory, no request).
function measurementTagContainers(measurementId) {
  let synced = false;
  const found = new Map();
  for (const c of platforms.find(p => p.id === 'gtm')?.connections ?? [])
    for (const group of c.enabled ? (c.groups ?? []) : [])
      if (group.kind === 'containers' && Array.isArray(group.assets)) {
        synced = true;
        for (const asset of group.assets)
          if (typeof asset?.id === 'string' && Array.isArray(asset.tagIds) && asset.tagIds.includes(measurementId))
            found.set(asset.id, {
              name: typeof asset.name === 'string' ? asset.name.slice(0, 200) : asset.id,
              public_id: typeof asset.publicId === 'string' ? asset.publicId : null,
            });
      }
  return {synced, containers: [...found.values()].slice(0, 10)};
}
function measurementGa4ConfigView(out, target) {
  const unknown = esc(uiText('Unknown')),
    native = v => (v === null || v === undefined || v === '' ? unknown : `<code dir="ltr">${esc(v)}</code>`),
    flag = v => esc(v === true ? uiText('Yes') : v === false ? uiText('No') : uiText('Unknown')),
    shown = rows => (rows ?? []).slice(0, 100),
    table = (caption, headers, rows, cells) =>
      rows === undefined
        ? ''
        : `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(caption)}"><table class="review-table"><caption>${esc(caption)}</caption><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${shown(rows).map(cells).join('') || `<tr><td colspan="${headers.length}">${esc(uiText('None returned.'))}</td></tr>`}</tbody></table></div>`,
    lists = ['key_events', 'custom_dimensions', 'custom_metrics', 'data_streams', 'google_ads_links'];
  const tags = stream => {
    if (!stream.measurement_id) return unknown;
    const found = measurementTagContainers(stream.measurement_id);
    if (!found.synced) return esc(uiText('Tag Manager containers are not synchronized.'));
    return found.containers.length
      ? found.containers
          .map(
            c =>
              `<bdi dir="auto">${esc(c.name)}</bdi>${c.public_id ? ` <code dir="ltr">${esc(c.public_id)}</code>` : ''}`,
          )
          .join('<br>')
      : esc(uiText('No synchronized container refers to this measurement ID.'));
  };
  let html = `<h3 id="measurement-ga4-config-heading" tabindex="-1">${esc(target.label)}</h3><p>${esc(uiText('Requested {requested} · Returned {captured}', {requested: date(out.requested_at), captured: date(out.captured_at)}))}</p>${badge('complete')}<p class="notice">${esc(uiAccountExplanation(out.meaning))}</p><p>${esc(uiText('Test identifier dimension'))}: ${esc(uiText(measurementTestDimension[out.checks.test_identifier_dimension]))}${out.checks.test_identifier_dimension === 'registered' ? '' : ' · ' + esc(uiText('Inspecting a specific GA4 test identifier needs an event-scoped amcp_test_id custom dimension.'))}</p>${out.checks.realtime_identity_dimension === undefined ? '' : `<p>${esc(uiText('User-scoped amcp_test_id for realtime test reads'))}: ${esc(uiText(out.checks.realtime_identity_dimension === 'registered' ? 'Registered with user scope' : out.checks.realtime_identity_dimension === 'not_read' ? 'Not read' : 'Not registered'))}</p>`}`;
  html += table(
    uiText('Key events'),
    [uiText('Event name'), uiText('Counting method'), uiText('Default value')],
    out.key_events,
    k =>
      `<tr><th scope="row"><code dir="ltr">${esc(k.event_name)}</code></th><td>${native(k.counting_method)}</td><td>${k.default_value?.numeric_value === null || k.default_value?.numeric_value === undefined ? unknown : `<span dir="ltr">${esc(String(k.default_value.numeric_value))} ${esc(k.default_value.currency_code ?? '')}</span>`}</td></tr>`,
  );
  html += table(
    uiText('Data streams'),
    [uiText('Stream'), uiText('Type'), uiText('Measurement ID'), uiText('Google tags in synchronized containers')],
    out.data_streams,
    s =>
      `<tr><th scope="row"><bdi dir="auto">${esc(s.display_name ?? s.stream_id)}</bdi><br><code dir="ltr">${esc(s.stream_id)}</code></th><td>${native(s.type)}</td><td>${native(s.measurement_id)}</td><td>${tags(s)}</td></tr>`,
  );
  html += table(
    uiText('Custom dimensions'),
    [uiText('Parameter'), uiText('Display name'), uiText('Scope')],
    out.custom_dimensions,
    d =>
      `<tr><th scope="row"><code dir="ltr">${esc(d.parameter_name)}</code></th><td><bdi dir="auto">${esc(d.display_name ?? '')}</bdi></td><td>${native(d.scope)}</td></tr>`,
  );
  html += table(
    uiText('Custom metrics'),
    [uiText('Parameter'), uiText('Display name'), uiText('Measurement unit'), uiText('Restricted metric types')],
    out.custom_metrics,
    m =>
      `<tr><th scope="row"><code dir="ltr">${esc(m.parameter_name)}</code></th><td><bdi dir="auto">${esc(m.display_name ?? '')}</bdi></td><td>${native(m.measurement_unit)}</td><td>${m.restricted_metric_types.map(native).join(' ') || esc(uiText('None returned.'))}</td></tr>`,
  );
  html += table(
    uiText('Google Ads links'),
    [uiText('Google Ads customer ID'), uiText('Ads personalization'), uiText('Can manage clients')],
    out.google_ads_links,
    l =>
      `<tr><th scope="row"><code dir="ltr">${esc(l.customer_id)}</code></th><td>${flag(l.ads_personalization_enabled)}</td><td>${flag(l.can_manage_clients)}</td></tr>`,
  );
  if (out.data_retention)
    html += `<section><h4>${esc(uiText('Data retention'))}</h4><ul><li>${esc(uiText('Event data retention'))}: ${native(out.data_retention.event_data_retention)}</li><li>${esc(uiText('User data retention'))}: ${native(out.data_retention.user_data_retention)}</li><li>${esc(uiText('Reset user data on new activity'))}: ${flag(out.data_retention.reset_user_data_on_new_activity)}</li></ul></section>`;
  if (lists.some(key => (out[key]?.length ?? 0) > 100))
    html += `<p class="form-note">${esc(uiText('Only the first 100 rows of each list are shown; the counts include every row read.'))}</p>`;
  return (
    html +
    `<p>${esc(uiText('Configured GA4 settings are not proof that events are sent, counted, deduplicated, consented or attributed. Nothing was changed and no snapshot was saved.'))}</p>${recordDetails(out, uiText('GA4 configuration scope, limits and source references'))}`
  );
}
function bindMeasurementGa4Config(targets) {
  const form = $('#measurement-ga4-config'),
    result = $('#measurement-ga4-config-result');
  if (!form?.elements?.target) return;
  const begin = accountWorkflowContext(form, result);
  if (typeof location !== 'undefined') {
    const params = new URLSearchParams(location.search);
    if (params.has('ga4_config')) {
      const index = targets.findIndex(
          t => t.account_id === params.get('account_id') && t.connection_id === params.get('connection_id'),
        ),
        valid =
          params.get('ga4_config') === '1' &&
          ['ga4_config', 'account_id', 'connection_id'].every(k => params.getAll(k).length === 1) &&
          index >= 0;
      form.elements.target.value = valid ? String(index) : '';
      result.innerHTML = `<p class="form-note" role="status">${esc(valid ? uiText('Property selected from a configuration link. Read current configuration to refresh the evidence.') : uiText('The linked GA4 property is unavailable. Choose a currently selected property.'))}</p>`;
    }
  }
  workspaceBind('#measurement-ga4-config', async () => {
    const current = begin();
    if (!current()) return;
    const target = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !target) throw Error(uiText('Choose a selected GA4 property first.'));
    let out;
    try {
      out = await workspaceCall('workspace', {
        action: 'measurement_ga4_config',
        gateway: 'ga4_native_action',
        connection_id: target.connection_id,
        account_id: target.account_id,
      });
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    if (!measurementGa4ConfigValid(out, target))
      throw Error(
        uiText('The GA4 configuration response is incomplete or belongs to a different selection. Read it again.'),
      );
    result.innerHTML = measurementGa4ConfigView(out, target);
    $('#measurement-ga4-config-heading')?.focus();
  });
}
// MSR-03: the measurement evidence ledger of one asset. Slice C read a Google Ads account or a GA4 property; owner
// direction P8 (2026-10-11) adds Meta, Snapchat and TikTok ad accounts with their pixels, Search Console sites and Adjust
// apps (Adjust apps are bound administratively and appear only when the workspace lists them). Six fixed layers, each
// observed, unknown, unavailable or not applicable. The website explains each reason code itself; native values stay
// literal. Choosing an account never reads; the ledger is read only on submit.
const measurementLedgerLayers = {
  configuration: 'Configuration',
  provider_observed_activity: 'Provider-observed activity',
  provider_diagnostics: 'Provider diagnostics',
  supplied_runtime_trace: 'Supplied runtime trace',
  consent: 'Consent',
  attribution_settings: 'Attribution settings',
};
const measurementLedgerStates = {
  observed: 'Observed',
  unknown: 'Unknown',
  unavailable: 'Unavailable',
  not_applicable: 'Not applicable',
};
const measurementLedgerReasons = {
  complete_configuration: 'Read completely from the provider.',
  manager_account: 'This is a manager account. Choose a client account that records its own conversions.',
  shared_conversion_customer:
    'This account uses another customer’s conversion tracking. AMCP did not read that customer, so goals stay unknown.',
  conversion_customer_unknown: 'Google Ads did not report the conversion tracking customer, so goals stay unknown.',
  configuration_incomplete: 'The configuration could not be completely inspected.',
  configuration_unknown: 'Not read, because the configuration is unknown.',
  activity_reported: 'Google Ads reported a last conversion date and a last tag detection for every primary action.',
  activity_incomplete: 'Google Ads did not report activity for every primary action.',
  key_events_reported: 'GA4 reported key events in the last 30 minutes.',
  no_recent_key_events: 'No key event was reported in the last 30 minutes. Absence does not establish a broken tag.',
  key_events_unreadable: 'No key event name can be read as an exact realtime event name.',
  no_key_events: 'The property has no key event.',
  upload_summaries: 'Offline conversion upload summaries by upload client.',
  no_uploads: 'Google Ads reported no offline conversion upload for this account.',
  action_settings: 'Attribution model and lookback windows of enabled conversion actions.',
  no_enabled_actions: 'The account has no enabled conversion action.',
  read_failed: 'This read failed or was incomplete, so the layer stays unknown.',
  browser_only: 'Supplied traces are inspected only in this browser and never reach AMCP.',
  no_provider_source: 'The provider exposes no source for this layer to AMCP.',
  unpinned_api: 'This is available only in a provider API version AMCP has not pinned.',
  unpinned_contract: 'The provider publishes no response contract AMCP could pin, so this is not read.',
  unpinned_request:
    'AMCP sends this read only as a pinned copy of the provider’s specification documents it, and this deployment has not pinned it yet, so this is not read.',
  unconfirmed_fields:
    'TikTok returned these pixel event statistics. Their field meanings are not confirmed yet, so AMCP shows them as returned and does not interpret them.',
  pixels_listed: 'The pixels the account lists, read completely from the provider.',
  no_pixels: 'The account lists no pixel.',
  pixel_not_selected: 'The account lists several pixels. Enter one pixel ID and read the ledger again.',
  pixel_not_listed: 'The pixel ID you entered is not listed for this account, so it was not read.',
  pixel_events_reported: 'Meta reported pixel events by event name in the last 24 hours.',
  pixel_domains_reported: 'Snapchat reported the domains that fired the pixel in the last 7 days.',
  no_recent_events: 'No pixel event was reported in the read window. Absence does not establish a broken pixel.',
  dataset_quality:
    'Meta dataset quality of web events: match quality, Conversions API coverage, deduplication keys and freshness.',
  quality_permission_missing:
    'Dataset quality needs the ads_management or business_management permission besides ads_read, so it was not read.',
  signal_readiness: 'Snapchat signal readiness recommendations by event type, with their priority and score.',
  no_quality_data: 'The provider reported no quality data for this pixel.',
  not_pixel_setting: 'Attribution windows are chosen per ad set, ad group or report, not on the pixel.',
  site_permission: 'The site as Search Console lists it for this login, with the login’s permission level.',
  site_unverified: 'This login is an unverified user of the site and has no access to its data.',
  search_totals_reported: 'Final daily web search clicks and impressions over the last seven complete days.',
  no_search_activity:
    'Search Console reported no final search data for the last seven days. Data can lag by several days.',
  sitemaps_listed: 'Submitted sitemaps with their errors, warnings and last download.',
  no_sitemaps: 'No sitemap is submitted for this site.',
  no_consent_setting: 'This provider has no consent setting.',
  no_attribution: 'This provider attributes no conversions.',
  event_catalog: 'The events defined for the app in Adjust.',
  daily_activity_reported: 'Installs and events Adjust reported per day over the last seven complete UTC days.',
  report_incomplete: 'Adjust returned warnings or missing totals, so the report is incomplete.',
  no_recent_activity:
    'Adjust reported no activity for the app in the last seven days. Absence does not establish broken tracking.',
};
// The related task of a layer, on this page; following it makes no request.
const measurementLedgerTasks = {
  google_ads_native_action: {configuration: 'goals', provider_observed_activity: 'goals', consent: 'gtm'},
  ga4_native_action: {configuration: 'ga4config', provider_observed_activity: 'events', consent: 'gtm'},
  meta_native_action: {consent: 'gtm'},
  snapchat_native_action: {consent: 'gtm'},
  tiktok_native_action: {consent: 'gtm'},
  google_search_console_native_action: {},
  adjust_native_action: {},
};
// The gateways whose ledger reads one pixel or dataset of the selected account.
const measurementLedgerPixelGateways = ['meta_native_action', 'snapchat_native_action', 'tiktok_native_action'],
  measurementLedgerPixel = v => typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v);
function measurementLedgerMarkup(targets) {
  return `<section class="panel workspace-form">${measurementSectionHeading('measurement-section-ledger', uiText('Measurement evidence ledger'))}<p>${esc(uiText('Collect configuration, provider-observed activity, diagnostics, consent and attribution evidence for one advertising account, GA4 property, Search Console site or app in one view. Each layer says whether it was observed, is unknown, is unavailable or does not apply.'))}</p><form id="measurement-ledger">${measurementTargetField(targets, uiText('Account, property, site or app'), 'Connect an advertising, analytics or Search Console account in Connections to read its measurement evidence ledger.')}<label>${esc(uiText('Pixel or dataset ID (optional)'))}<input name="pixel_id" type="text" maxlength="64" autocomplete="off" spellcheck="false" dir="ltr" aria-describedby="measurement-ledger-pixel-help"></label><p class="form-note" id="measurement-ledger-pixel-help">${esc(uiText('Only for a Meta, Snapchat or TikTok account. The ledger lists the account’s pixels first and reads the only pixel, or the one you enter here.'))}</p><button class="button primary" type="submit" ${targets.length ? '' : 'disabled'}>${esc(uiText('Read the evidence ledger'))}</button></form><div id="measurement-ledger-result" aria-live="polite"></div></section>`;
}
function measurementLedgerValid(out, target, pixel) {
  const code = v => typeof v === 'string' && /^[a-z_]{1,64}$/.test(v),
    counts = out?.summary;
  return (
    !!out &&
    out.record_kind === 'measurement_ledger' &&
    out.provider_mutations === 0 &&
    out.scope?.gateway === target.gateway &&
    Object.hasOwn(measurementLedgerTasks, target.gateway) &&
    out.scope.account_id === target.account_id &&
    out.scope.connection_id === target.connection_id &&
    // A pixel ledger names the pixel it read, or none; when a pixel was entered, it is that one.
    (measurementLedgerPixelGateways.includes(target.gateway)
      ? out.scope.pixel_id === null ||
        (measurementLedgerPixel(out.scope.pixel_id) && (!pixel || out.scope.pixel_id === pixel))
      : out.scope.pixel_id === undefined) &&
    Array.isArray(out.layers) &&
    out.layers.map(l => l?.layer).join() === Object.keys(measurementLedgerLayers).join() &&
    out.layers.every(
      l =>
        Object.hasOwn(measurementLedgerStates, l.state) &&
        code(l.reason) &&
        (l.evidence === null || (typeof l.evidence === 'object' && !Array.isArray(l.evidence))),
    ) &&
    !!counts &&
    Object.keys(measurementLedgerStates).every(s => counts[s] === out.layers.filter(l => l.state === s).length) &&
    // A failed read carries only its error code and the provider's allow-listed facts, never partial rows.
    out.layers.every(
      l =>
        l.reason !== 'read_failed' ||
        (l.state === 'unknown' &&
          !!l.evidence &&
          Object.keys(l.evidence).every(key => ['error', 'http_status', 'provider_code', 'request_id'].includes(key)) &&
          /^[A-Z][A-Z0-9_]{0,63}$/.test(l.evidence.error ?? '')),
    )
  );
}
function measurementLedgerEvidence(l, gateway) {
  const e = l.evidence ?? {},
    unknown = esc(uiText('Unknown')),
    native = v => (v === null || v === undefined || v === '' ? unknown : `<code dir="ltr">${esc(String(v))}</code>`),
    list = rows => (rows.length ? `<ul class="measurement-ledger-list">${rows.join('')}</ul>` : ''),
    rows = v => (Array.isArray(v) ? v.slice(0, 5) : []),
    count = v => (Number.isSafeInteger(v) ? uiNumber(v) : '0'),
    percent = v =>
      typeof v === 'number' && Number.isFinite(v)
        ? `<span dir="ltr">${esc(uiNumber(v / 100, {style: 'percent', maximumFractionDigits: 1}))}</span>`
        : unknown,
    more = (v, total) =>
      Number.isSafeInteger(total) && total > Math.min(5, Array.isArray(v) ? v.length : 0)
        ? `<p class="form-note">${esc(uiText('{shown} of {total} shown.', {shown: Math.min(5, Array.isArray(v) ? v.length : 0), total: uiNumber(total)}))}</p>`
        : '';
  const pixel = measurementLedgerPixelGateways.includes(gateway);
  // A provider's refusal keeps its HTTP status, error code and request ID (allow-listed facts, never its message).
  const providerStatus =
      Number.isInteger(e.http_status) && e.http_status >= 400 && e.http_status <= 599 ? e.http_status : null,
    providerCode =
      Number.isSafeInteger(e.provider_code) ||
      (typeof e.provider_code === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(e.provider_code))
        ? String(e.provider_code)
        : null,
    providerRequest =
      typeof e.request_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:+=\/-]{0,127}$/.test(e.request_id)
        ? e.request_id
        : null;
  if (typeof e.error === 'string')
    return `${esc(uiText('Error code'))}: ${native(e.error)}${providerStatus !== null ? ` ${esc(uiText('Provider response: HTTP {status}.', {status: providerStatus}))}` : ''}${providerCode !== null ? ` ${esc(uiText('Provider code: {code}.', {code: providerCode}))}` : ''}${providerRequest !== null ? ` ${esc(uiText('Provider request ID: {id}.', {id: providerRequest}))}` : ''}`;
  if (l.state !== 'observed') {
    if (
      l.layer === 'provider_observed_activity' &&
      gateway === 'google_ads_native_action' &&
      l.reason === 'activity_incomplete'
    )
      return esc(
        uiText(
          '{conversions} of {actions} primary actions report a last conversion; {tags} report a last tag detection.',
          {
            conversions: uiNumber(e.primary_last_conversion_known ?? 0),
            actions: uiNumber(e.matching_primary_actions ?? 0),
            tags: uiNumber(e.primary_last_tag_known ?? 0),
          },
        ),
      );
    if (l.layer === 'provider_observed_activity' && gateway === 'ga4_native_action' && Array.isArray(e.events))
      return list(
        rows(e.events).map(
          v =>
            `<li><code dir="ltr">${esc(v.event_name)}</code>: ${v.reported_count === null ? esc(uiText('None reported')) : native(v.reported_count)}</li>`,
        ),
      );
    if (l.layer === 'provider_observed_activity' && gateway === 'meta_native_action' && 'last_fired_time' in e)
      return `${esc(uiText('Last fired'))} ${native(e.last_fired_time)}`;
    // MSR-03: TikTok's statistics as returned, each value literal, with no meaning claimed for any field.
    if (l.reason === 'unconfirmed_fields' && Array.isArray(e.fields)) {
      const shown = e.fields.slice(0, 20);
      return `${esc(uiText('{start} to {end} in UTC days; TikTok’s day basis is not confirmed.', {start: e.window?.start_date ?? '', end: e.window?.end_date ?? ''}))}${list(shown.map(f => `<li><code dir="ltr">${esc(String(f.path))}</code>: ${f.value === null ? '<code dir="ltr">null</code>' : native(f.value)}</li>`))}${Number.isSafeInteger(e.field_count) && e.field_count > shown.length ? `<p class="form-note">${esc(uiText('{shown} of {total} shown.', {shown: uiNumber(shown.length), total: uiNumber(e.field_count)}))}</p>` : ''}`;
    }
    if (l.reason === 'report_incomplete' && Number.isSafeInteger(e.warnings))
      return esc(uiText('{count} provider warnings', {count: uiNumber(e.warnings)}));
    return '';
  }
  if (l.layer === 'configuration' && gateway === 'google_ads_native_action')
    return esc(
      uiText('{goals} account-default goals · {actions} matching primary actions', {
        goals: uiNumber(e.summary?.goals ?? 0),
        actions: uiNumber(e.summary?.matching_primary_actions ?? 0),
      }),
    );
  if (l.layer === 'configuration' && gateway === 'ga4_native_action')
    return `${esc(uiText('{events} key events · {streams} data streams', {events: uiNumber(e.summary?.key_events ?? 0), streams: uiNumber(e.summary?.data_streams ?? 0)}))}${list(rows(e.data_streams).map(s => `<li><code dir="ltr">${esc(s.stream_id)}</code> ${native(s.type)} ${s.measurement_id ? native(s.measurement_id) : ''}</li>`))}`;
  if (l.layer === 'configuration' && pixel) {
    const detail = p =>
      gateway === 'meta_native_action'
        ? ` · ${esc(uiText('Last fired'))} ${native(p.last_fired_time)}${p.is_unavailable === true ? ' · ' + esc(uiText('Unavailable')) : ''}`
        : gateway === 'snapchat_native_action'
          ? ` · ${native(p.effective_status ?? p.status)}`
          : ` · ${esc(p.owned === true ? uiText('Owned') : p.owned === false ? uiText('Shared or unbound') : uiText('Ownership unknown'))}`;
    return `${esc(uiText('{count} pixels listed', {count: count(e.pixel_count)}))}${list(
      rows(e.pixels).map(p => {
        const id = p.id ?? p.pixel_id,
          name = p.name ?? p.pixel_name;
        return `<li><code dir="ltr">${esc(String(id))}</code>${name ? ` <bdi dir="auto">${esc(name)}</bdi>` : ''}${detail(p)}${id === e.selected_pixel ? ' · <strong>' + esc(uiText('Selected')) + '</strong>' : ''}</li>`;
      }),
    )}${more(e.pixels, e.pixel_count)}`;
  }
  if (l.layer === 'configuration' && gateway === 'google_search_console_native_action')
    return `${native(e.site_url)} · ${esc(uiText('Permission'))} ${native(e.permission_level)}`;
  if (l.layer === 'configuration' && gateway === 'adjust_native_action')
    return `${esc(uiText('{count} events defined', {count: count(e.event_count)}))}${list(rows(e.events).map(v => `<li><code dir="ltr">${esc(String(v.id))}</code>${v.name ? ` <bdi dir="auto">${esc(v.name)}</bdi>` : ''}</li>`))}${more(e.events, e.event_count)}`;
  if (l.layer === 'provider_observed_activity' && gateway === 'google_ads_native_action')
    return list(
      rows(e.primary_actions).map(
        a =>
          `<li><bdi dir="auto">${esc(a.name ?? a.resource_name)}</bdi>: ${esc(uiText('Last conversion date'))} ${native(a.last_conversion_date)} · ${esc(uiText('Last tag detected'))} ${native(a.last_tag_received_time)}</li>`,
      ),
    );
  if (l.layer === 'provider_observed_activity' && gateway === 'ga4_native_action')
    return list(
      rows(e.events).map(
        v =>
          `<li><code dir="ltr">${esc(v.event_name)}</code>: ${v.reported_count === null ? esc(uiText('None reported')) : native(v.reported_count)}</li>`,
      ),
    );
  if (l.layer === 'provider_observed_activity' && gateway === 'meta_native_action')
    return `${esc(uiText('Last {hours} hours', {hours: count(e.window_hours)}))} · ${esc(uiText('Last fired'))} ${native(e.last_fired_time)}${list(rows(e.events).map(v => `<li><code dir="ltr">${esc(v.event_name)}</code>: ${native(v.count)}</li>`))}${more(e.events, e.event_count)}`;
  if (l.layer === 'provider_observed_activity' && gateway === 'snapchat_native_action')
    return `${esc(uiText('{events} events from {domains} domains in the last 7 days', {events: count(e.total_events), domains: count(e.domain_count)}))}${list(rows(e.domains).map(d => `<li><code dir="ltr">${esc(d.domain_name)}</code>: ${native(d.total_events)}</li>`))}${more(e.domains, e.domain_count)}`;
  if (l.layer === 'provider_observed_activity' && gateway === 'google_search_console_native_action')
    return esc(
      uiText('{clicks} clicks · {impressions} impressions on {days} reported days ({start} to {end}, Pacific time)', {
        clicks: count(e.clicks),
        impressions: count(e.impressions),
        days: count(e.days_reported),
        start: e.start_date,
        end: e.end_date,
      }),
    );
  if (l.layer === 'provider_observed_activity' && gateway === 'adjust_native_action')
    return `${esc(uiText('Installs {installs} · Events {events} from {start} to {end} (UTC)', {installs: e.totals?.installs ?? uiText('Unknown'), events: e.totals?.events ?? uiText('Unknown'), start: e.start_date, end: e.end_date}))}${list(rows(e.days).map(d => `<li><code dir="ltr">${esc(d.day)}</code>: ${native(d.installs)} · ${native(d.events)}</li>`))}`;
  if (l.layer === 'provider_diagnostics' && gateway === 'meta_native_action')
    return (
      list(
        rows(e.events).map(
          v =>
            `<li><code dir="ltr">${esc(v.event_name)}</code>: ${v.composite_score === null ? `${esc(uiText('Match quality'))} ${unknown}` : esc(uiText('Match quality {score} of 10', {score: uiNumber(v.composite_score)}))} · ${esc(uiText('Conversions API coverage'))} ${percent(v.event_coverage_percentage)} · ${esc(uiText('Upload frequency'))} ${native(v.upload_frequency)}${rows(
              v.dedupe_keys,
            )
              .map(
                k => ` · ${esc(uiText('Deduplication key'))} ${native(k.dedupe_key)} ${percent(k.server_percentage)}`,
              )
              .join('')}</li>`,
        ),
      ) + more(e.events, e.event_count)
    );
  if (l.layer === 'provider_diagnostics' && gateway === 'snapchat_native_action')
    return (
      list(
        rows(e.scores).map(
          s =>
            `<li><code dir="ltr">${esc(s.event_type)}</code> ${native(s.action_source)} ${native(s.event_source)}${list(rows(s.recommendations).map(r => `<li>${native(r.recommendation_code)} · ${native(r.priority)} · ${native(r.score)}${r.title ? ` · <bdi dir="auto">${esc(r.title)}</bdi>` : ''}</li>`))}</li>`,
        ),
      ) + more(e.scores, e.score_count)
    );
  if (l.layer === 'provider_diagnostics' && gateway === 'google_search_console_native_action')
    return `${esc(uiText('{errors} with errors · {warnings} with warnings · {pending} pending', {errors: count(e.with_errors), warnings: count(e.with_warnings), pending: count(e.pending)}))}${list(rows(e.sitemaps).map(s => `<li><code dir="ltr">${esc(s.path)}</code>: ${esc(uiText('Errors'))} ${native(s.errors)} · ${esc(uiText('Warnings'))} ${native(s.warnings)} · ${esc(uiText('Last downloaded'))} ${native(s.last_downloaded)}</li>`))}${more(e.sitemaps, e.sitemap_count)}`;
  if (l.layer === 'provider_diagnostics')
    return (
      list(
        rows(e.upload_summaries).map(
          s =>
            `<li>${native(s.client)} · ${native(s.status)} · ${esc(uiText('Success rate'))} ${s.success_rate === null ? unknown : `<span dir="ltr">${esc(uiNumber(s.success_rate, {style: 'percent', maximumFractionDigits: 1}))}</span>`} · ${esc(uiText('Last upload'))} ${native(s.last_upload_date_time)}${Number.isSafeInteger(s.alert_count) && s.alert_count ? ` · ${esc(uiText('{count} alerts', {count: uiNumber(s.alert_count)}))}` : ''}</li>`,
        ),
      ) + more(e.upload_summaries, e.summary_count)
    );
  if (l.layer === 'attribution_settings')
    return (
      list(
        rows(e.actions).map(
          a =>
            `<li><bdi dir="auto">${esc(a.name)}</bdi>: ${native(a.attribution_model)} · ${esc(uiText('Click-through window'))} ${a.click_through_lookback_window_days === null ? unknown : esc(uiText('{days} days', {days: uiNumber(a.click_through_lookback_window_days)}))} · ${esc(uiText('View-through window'))} ${a.view_through_lookback_window_days === null ? unknown : esc(uiText('{days} days', {days: uiNumber(a.view_through_lookback_window_days)}))}</li>`,
        ),
      ) + more(e.actions, e.action_count)
    );
  return '';
}
function measurementLedgerView(out, target) {
  const tasks = measurementLedgerTasks[out.scope.gateway],
    link = l => {
      const task = l.layer === 'supplied_runtime_trace' ? 'trace' : tasks[l.layer];
      return task
        ? `<a href="#measurement-section-${task}">${esc(uiText(task === 'trace' ? 'Inspect a sanitized event trace' : task === 'gtm' ? 'Google Tag Manager configuration audit' : task === 'goals' ? 'Google Ads conversion goals' : task === 'ga4config' ? 'GA4 property configuration' : 'Recent GA4 events'))}</a>`
        : '';
    };
  const summary = Object.entries(measurementLedgerStates)
    .map(
      ([state, label]) =>
        `<article><strong>${esc(uiNumber(out.summary[state]))}</strong><span>${esc(uiText(label))}</span></article>`,
    )
    .join('');
  const body = out.layers
    .map(
      l =>
        `<tr><th scope="row">${esc(uiText(measurementLedgerLayers[l.layer]))}</th><td><span class="measurement-ledger-state measurement-ledger-${esc(l.state)}">${esc(uiText(measurementLedgerStates[l.state]))}</span></td><td>${esc(Object.hasOwn(measurementLedgerReasons, l.reason) ? uiText(measurementLedgerReasons[l.reason]) : l.reason)}${link(l) ? `<br>${link(l)}` : ''}</td><td>${measurementLedgerEvidence(l, out.scope.gateway)}</td></tr>`,
    )
    .join('');
  const pixel = out.scope.pixel_id
    ? `<p>${esc(uiText('Pixel or dataset ID'))}: <code dir="ltr">${esc(out.scope.pixel_id)}</code></p>`
    : '';
  return `<h3 id="measurement-ledger-heading" tabindex="-1">${esc(target.label)}</h3>${pixel}<p>${esc(uiText('Requested {requested} · Returned {captured}', {requested: date(out.requested_at), captured: date(out.captured_at)}))}</p><p class="notice">${esc(uiAccountExplanation(out.meaning))}</p><div class="workspace-metrics">${summary}</div><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Evidence layers'))}"><table class="review-table measurement-ledger"><caption>${esc(uiText('Evidence layers'))}</caption><thead><tr><th scope="col">${esc(uiText('Layer'))}</th><th scope="col">${esc(uiText('State'))}</th><th scope="col">${esc(uiText('What this means'))}</th><th scope="col">${esc(uiText('Evidence'))}</th></tr></thead><tbody>${body}</tbody></table></div><p>${esc(uiText('Configuration and reported activity do not prove that conversions are delivered, deduplicated, consented or attributed. Nothing was changed and no snapshot was saved.'))}</p>${recordDetails(out, uiText('Evidence ledger scope, limits and source references'))}`;
}
function bindMeasurementLedger(targets) {
  const form = $('#measurement-ledger'),
    result = $('#measurement-ledger-result');
  if (!form?.elements?.target) return;
  const begin = accountWorkflowContext(form, result);
  if (typeof location !== 'undefined') {
    const params = new URLSearchParams(location.search);
    if (params.has('ledger')) {
      const index = targets.findIndex(
          t =>
            t.gateway === params.get('gateway') &&
            t.account_id === params.get('account_id') &&
            t.connection_id === params.get('connection_id'),
        ),
        pixel = params.get('pixel_id'),
        valid =
          params.get('ledger') === '1' &&
          ['ledger', 'gateway', 'account_id', 'connection_id'].every(k => params.getAll(k).length === 1) &&
          index >= 0 &&
          (!params.has('pixel_id') ||
            (params.getAll('pixel_id').length === 1 &&
              measurementLedgerPixelGateways.includes(targets[index].gateway) &&
              measurementLedgerPixel(pixel)));
      form.elements.target.value = valid ? String(index) : '';
      if (form.elements.pixel_id) form.elements.pixel_id.value = valid && pixel ? pixel : '';
      result.innerHTML = `<p class="form-note" role="status">${esc(valid ? uiText('Account selected from an evidence ledger link. Read the ledger to refresh the evidence.') : uiText('The linked account is unavailable. Choose a currently selected account, property, site or app.'))}</p>`;
    }
  }
  workspaceBind('#measurement-ledger', async () => {
    const current = begin();
    if (!current()) return;
    const target = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !target) throw Error(uiText('Choose an account, property, site or app.'));
    const pixel = (form.elements.pixel_id?.value ?? '').trim();
    if (pixel && !measurementLedgerPixelGateways.includes(target.gateway))
      throw Error(uiText('A pixel ID applies only to a Meta, Snapchat or TikTok account.'));
    if (pixel && !measurementLedgerPixel(pixel))
      throw Error(uiText('Use the exact pixel or dataset ID the account lists.'));
    let out;
    try {
      out = await workspaceCall('workspace', {
        action: 'measurement_ledger',
        gateway: target.gateway,
        connection_id: target.connection_id,
        account_id: target.account_id,
        ...(pixel ? {requirements: {pixel_id: pixel}} : {}),
      });
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    if (!measurementLedgerValid(out, target, pixel))
      throw Error(
        uiText('The evidence ledger response is incomplete or belongs to a different selection. Read it again.'),
      );
    result.innerHTML = measurementLedgerView(out, target);
    $('#measurement-ledger-heading')?.focus();
  });
}
function measurementConversionsMarkup(targets) {
  return `<section class="panel workspace-form">${measurementSectionHeading('measurement-section-conversions', uiText('LinkedIn conversion settings'))}<p>${esc(uiText('Inspect current conversion rules, attribution windows and configured values for one selected account.'))}</p><form id="measurement-conversions">${measurementTargetField(targets, uiText('LinkedIn advertising account'), 'Connect LinkedIn and select an ad account to inspect conversion settings.')}<button class="button" type="submit" ${targets.length ? '' : 'disabled'}>${esc(uiText('Read conversion settings'))}</button></form><div id="measurement-conversions-result"></div></section>`;
}
function bindMeasurementConversions(targets) {
  const form = $('#measurement-conversions'),
    result = $('#measurement-conversions-result'),
    begin = accountWorkflowContext(form, result);
  if (typeof location !== 'undefined') {
    const params = new URLSearchParams(location.search);
    if (params.has('conversion_rules')) {
      const index = targets.findIndex(
          t => t.account_id === params.get('account_id') && t.connection_id === params.get('connection_id'),
        ),
        valid =
          params.get('conversion_rules') === '1' &&
          ['conversion_rules', 'account_id', 'connection_id'].every(k => params.getAll(k).length === 1) &&
          index >= 0;
      form.elements.target.value = valid ? String(index) : '';
      result.innerHTML = `<p class="form-note" role="status">${esc(valid ? uiText('Account selected from a conversion link. Read current settings to refresh the evidence.') : uiText('The linked conversion account is unavailable. Choose a currently selected account.'))}</p>`;
    }
  }
  workspaceBind('#measurement-conversions', async form => {
    const current = begin();
    if (!current()) return;
    const target = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !target) throw Error(uiText('Choose a LinkedIn advertising account.'));
    let out;
    try {
      out = await workspaceCall('workspace', {
        action: 'measurement_conversions',
        gateway: 'linkedin_native_action',
        connection_id: target.connection_id,
        account_id: target.account_id,
      });
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    const seen = new Set();
    if (
      !out ||
      out.record_kind !== 'conversion_rules' ||
      out.complete !== true ||
      !Number.isSafeInteger(out.captured_at) ||
      out.captured_at < 1 ||
      !Array.isArray(out.rules) ||
      out.rules.length > 1000 ||
      out.rule_count !== out.rules.length ||
      out.scope?.gateway !== 'linkedin_native_action' ||
      out.scope.account_id !== target.account_id ||
      out.scope.connection_id !== target.connection_id ||
      (out.collection_request !== undefined &&
        (!out.collection_request ||
          typeof out.collection_request !== 'object' ||
          Array.isArray(out.collection_request) ||
          Object.keys(out.collection_request).length !== 3 ||
          out.collection_request.finder !== 'account' ||
          out.collection_request.ownership_selection !== 'provider_default_owned' ||
          out.collection_request.shared_rules_requested !== false)) ||
      out.rules.some(r => {
        if (
          !r ||
          typeof r !== 'object' ||
          typeof r.id !== 'string' ||
          !/^[1-9][0-9]{0,19}$/.test(r.id) ||
          seen.has(r.id)
        )
          return true;
        seen.add(r.id);
        return (
          [r.name, r.type, r.attribution_type, r.value_type].some(
            v => v !== null && (typeof v !== 'string' || v.length > 256 || /[\x00-\x1f\x7f]/.test(v)),
          ) ||
          [r.conversion_method, r.ownership_type].some(
            v => v != null && (typeof v !== 'string' || !v.trim() || v.length > 100 || /[\x00-\x1f\x7f]/.test(v)),
          ) ||
          (r.enabled !== null && typeof r.enabled !== 'boolean') ||
          [r.post_click_days, r.post_view_days].some(
            v => v !== null && (!Number.isSafeInteger(v) || v < 0 || v > 365),
          ) ||
          // Observed activity (MSR-04): absent from older responses, null when LinkedIn reports none (unknown).
          [r.last_callback_at, r.latest_first_party_callback_at].some(
            v => v != null && (!Number.isSafeInteger(v) || v < 1),
          ) ||
          (r.value !== null &&
            (!r.value ||
              typeof r.value.amount !== 'string' ||
              !/^-?\d{1,30}(?:\.\d{1,18})?$/.test(r.value.amount) ||
              typeof r.value.currency !== 'string' ||
              !/^[A-Z]{3}$/.test(r.value.currency)))
        );
      })
    )
      throw Error(uiText('Conversion evidence changed or is incomplete. Read current settings again.'));
    result.innerHTML = `<h3 id="conversion-settings-heading" tabindex="-1">${esc(uiText('Current conversion configuration'))}</h3><p>${esc(target.label)} · ${esc(date(out.captured_at))}</p><p class="notice">${esc(uiText('These are current rule settings. Campaign links, event delivery, deduplication, consent and historical attribution remain unverified. Omitted fields stay unknown. No rule was changed and no snapshot was saved.'))}</p><p class="form-note" id="conversion-collection-scope">${esc(uiText("This view requests LinkedIn's default owned-rule selection. Shared rules are not requested. Missing method or ownership fields stay unknown."))}</p><label>${esc(uiText('Find a conversion rule'))}<input id="conversion-rule-search" type="search" maxlength="150" aria-describedby="conversion-rule-search-help"></label><p class="form-note" id="conversion-rule-search-help">${esc(uiText('Search name, ID, type, method or ownership.'))}</p><div id="conversion-rule-rows"></div>${recordDetails(out, uiText('Conversion configuration source references'))}`;
    mountConversionRuleRows(out.rules, current);
    $('#conversion-settings-heading').focus();
  });
}
function mountConversionRuleRows(rules, selectionCurrent) {
  const root = $('#conversion-rule-rows'),
    field = $('#conversion-rule-search'),
    current = () => root.isConnected && field.isConnected && selectionCurrent(),
    unknown = () => esc(uiText('Unknown')),
    nativeMetadata = value => (value == null ? unknown() : '<code dir="ltr">' + esc(value) + '</code>'),
    days = value => (value == null ? unknown() : esc(uiText('{count} days', {count: uiNumber(value)}))),
    // MSR-04: LinkedIn's last-fired times; a missing time stays Unknown, never "never fired".
    observed = r =>
      r.last_callback_at == null && r.latest_first_party_callback_at == null
        ? unknown()
        : [
            r.last_callback_at == null ? '' : esc(uiText('Last fired: {time}', {time: uiDate(r.last_callback_at)})),
            r.latest_first_party_callback_at == null
              ? ''
              : esc(uiText('Latest first-party callback: {time}', {time: uiDate(r.latest_first_party_callback_at)})),
          ]
            .filter(Boolean)
            .join('<br>'),
    attribution = value =>
      value === 'LAST_TOUCH_BY_CAMPAIGN'
        ? uiText('Last touch for each campaign')
        : value === 'LAST_TOUCH_BY_CONVERSION'
          ? uiText('Last touch across campaigns')
          : (value ?? uiText('Unknown'));
  let offset = 0,
    needle = '';
  const render = (focus = false) => {
    if (!current()) return;
    const rows = rules.filter(
        r =>
          !needle ||
          [r.id, r.name, r.type, r.conversion_method, r.ownership_type].some(
            v => typeof v === 'string' && v.toLowerCase().includes(needle),
          ),
      ),
      page = rows.slice(offset, offset + 50);
    root.innerHTML =
      (rows.length
        ? `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Conversion settings, scroll for all fields'))}"><table class="review-table"><caption>${esc(uiText('Native conversion rule settings'))}</caption><thead><tr><th scope="col">${esc(uiText('Conversion rule'))}</th><th scope="col">${esc(uiText('Native conversion type'))}</th><th scope="col">${esc(uiText('Registration method'))}</th><th scope="col">${esc(uiText('Reported ownership'))}</th><th scope="col">${esc(uiText('Enabled'))}</th><th scope="col">${esc(uiText('Post-click window'))}</th><th scope="col">${esc(uiText('Post-view window'))}</th><th scope="col">${esc(uiText('Attribution model'))}</th><th scope="col">${esc(uiText('Configured conversion value'))}</th><th scope="col">${esc(uiText('Observed activity'))}</th></tr></thead><tbody>${page.map(r => `<tr><th scope="row"><span dir="auto">${esc(r.name || uiText('Unnamed conversion'))}</span><br><code dir="ltr">${esc(r.id)}</code></th><td>${r.type == null ? unknown() : `<code dir="ltr">${esc(r.type)}</code>`}</td><td>${nativeMetadata(r.conversion_method)}</td><td>${nativeMetadata(r.ownership_type)}</td><td>${esc(r.enabled === true ? uiText('Enabled') : r.enabled === false ? uiText('Disabled') : uiText('Unknown'))}</td><td>${days(r.post_click_days)}</td><td>${days(r.post_view_days)}</td><td>${esc(attribution(r.attribution_type))}</td><td>${r.value == null ? unknown() : `<span dir="ltr">${esc(r.value.amount)} ${esc(r.value.currency)}</span>`}<br>${r.value_type == null ? unknown() : `<code dir="ltr">${esc(r.value_type)}</code>`}</td><td>${observed(r)}</td></tr>`).join('')}</tbody></table></div><p class="form-note" id="conversion-observed-activity-note">${esc(uiText('Observed activity is the last time LinkedIn reports a rule’s URL match fired. LinkedIn may take about 20 minutes to update it. Unknown means LinkedIn reported no time, not that the rule never fired; a time does not verify event delivery.'))}</p>`
        : `<p>${esc(needle ? uiText('No conversion rules match this search') : uiText('No conversion rules were returned for this account.'))}</p>`) +
      `<div class="report-pagination"><p id="conversion-rule-status" role="status" tabindex="-1">${esc(uiText('Showing {shown} of {matched} matching rules; {total} collected', {shown: uiNumber(page.length), matched: uiNumber(rows.length), total: uiNumber(rules.length)}))}</p><div><button class="button small" type="button" id="conversion-rule-previous">${esc(uiText('Previous page'))}</button><button class="button small" type="button" id="conversion-rule-next">${esc(uiText('Next page'))}</button></div></div>`;
    $('#conversion-rule-previous').disabled = offset === 0;
    $('#conversion-rule-next').disabled = offset + 50 >= rows.length;
    $('#conversion-rule-previous').addEventListener('click', () => {
      if (current() && offset >= 50) {
        offset -= 50;
        render(true);
      }
    });
    $('#conversion-rule-next').addEventListener('click', () => {
      if (current() && offset + 50 < rows.length) {
        offset += 50;
        render(true);
      }
    });
    if (focus) $('#conversion-rule-status').focus();
  };
  field.addEventListener('input', () => {
    if (!current()) return;
    needle = field.value.slice(0, 150).trim().toLowerCase();
    offset = 0;
    render();
  });
  render();
}
// MSR-01: the audit groups unresolved trigger references by trigger ID. A grouped row is shown only when its counts
// and bounded sample are well formed; otherwise the finding renders exactly as before.
function gtmFindingRow(f) {
  const grouped =
    f.code === 'UNRESOLVED_OR_SYSTEM_TRIGGER' &&
    f.grouping === 'trigger_id' &&
    Number.isSafeInteger(f.entity_count) &&
    f.entity_count > 0 &&
    Number.isSafeInteger(f.tag_count) &&
    f.tag_count >= 0 &&
    f.tag_count <= f.entity_count &&
    Array.isArray(f.sample_paths) &&
    f.sample_paths.length >= 1 &&
    f.sample_paths.length <= 20 &&
    f.sample_paths.every(value => typeof value === 'string' && value.length <= 512);
  return `<article><h4>${esc(uiGtmFindingLabel(f.code))} · ${esc(uiGtmFindingSeverity(f.severity))}</h4><p>${esc(uiGtmFindingMessage(f))}</p>${grouped ? `<p>${esc(uiText('Referenced by {count} entities, including {tags} tags.', {count: uiNumber(f.entity_count), tags: uiNumber(f.tag_count)}))}</p><details><summary>${esc(uiText('Referencing paths'))}</summary><ul>${f.sample_paths.map(value => `<li><code dir="ltr">${esc(value)}</code></li>`).join('')}</ul>${f.sample_paths_truncated === true ? `<p class="form-note">${esc(uiText('Only the first 20 referencing paths are listed.'))}</p>` : ''}</details>` : ''}<p><code dir="ltr">${esc(f.code)}</code></p><code dir="ltr">${esc(f.path)}</code></article>`;
}
const gtmFindingSeverities = ['all', 'error', 'warning', 'unknown'];
function gtmFindingsList(findings, severity = 'all', page = 0) {
  const rows = findings.filter(f => severity === 'all' || f?.severity === severity),
    last = Math.max(0, Math.ceil(rows.length / 25) - 1),
    current = Math.min(Math.max(0, page), last),
    shown = rows.slice(current * 25, current * 25 + 25);
  return (
    (shown.map(gtmFindingRow).join('') ||
      `<p>${esc(findings.length ? uiText('No findings match this severity.') : uiText('No configuration finding was returned for this scope.'))}</p>`) +
    (rows.length > 25
      ? `<div class="report-pagination"><p id="gtm-findings-status" role="status" tabindex="-1">${esc(uiText('Showing {shown} of {total} matching findings', {shown: uiNumber(shown.length), total: uiNumber(rows.length)}))}</p><div><button type="button" class="button small" id="gtm-findings-previous" ${current ? '' : 'disabled'}>${esc(uiText('Previous page'))}</button><button type="button" class="button small" id="gtm-findings-next" ${current < last ? '' : 'disabled'}>${esc(uiText('Next page'))}</button></div></div>`
      : '')
  );
}
function gtmFindingsMarkup(c, findings) {
  const total = Number.isSafeInteger(c.finding_count) && c.finding_count >= findings.length ? c.finding_count : null,
    truncated = c.finding_list === 'truncated' || c.findings_truncated === true;
  return `${truncated ? `<p class="notice">${esc(uiText(c.complete ? 'This list shows {shown} of {total} findings, errors and warnings first. Every configuration read completed; only the list is shortened.' : 'This list shows {shown} of {total} findings, errors and warnings first.', {shown: uiNumber(findings.length), total: total === null ? uiText('Unknown') : uiNumber(total)}))}</p>` : ''}${findings.length ? `<div class="work-filter"><label>${esc(uiText('Severity'))}<select id="gtm-findings-severity">${gtmFindingSeverities.map(value => `<option value="${value}">${esc(value === 'all' ? uiText('All severities') : uiGtmFindingSeverity(value))}</option>`).join('')}</select></label></div>` : ''}<div id="gtm-findings-list">${gtmFindingsList(findings)}</div>`;
}
function mountGtmFindings(findings, selectionCurrent) {
  if (!findings.length) return;
  const filter = $('#gtm-findings-severity'),
    list = $('#gtm-findings-list'),
    generation = navigationGeneration,
    identity = identityGeneration,
    current = () =>
      generation === navigationGeneration &&
      identity === identityGeneration &&
      list.isConnected &&
      filter.isConnected &&
      selectionCurrent();
  let page = 0;
  const bind = () => {
    for (const [id, step] of [
      ['#gtm-findings-previous', -1],
      ['#gtm-findings-next', 1],
    ]) {
      const button = $(id);
      if (!button) continue;
      button.addEventListener('click', () => {
        if (!current() || !gtmFindingSeverities.includes(filter.value)) return;
        page += step;
        render(true);
      });
    }
  };
  const render = focus => {
    list.innerHTML = gtmFindingsList(findings, filter.value, page);
    bind();
    if (focus) $('#gtm-findings-status')?.focus();
  };
  filter.value = 'all';
  bind();
  filter.addEventListener('change', () => {
    if (!current() || !gtmFindingSeverities.includes(filter.value)) return;
    page = 0;
    render(false);
  });
}
const gtmConsentDiffStates = ['all', 'differs', 'draft_only', 'live_only', 'unknown', 'same'];
function uiGtmConsentDiffState(value) {
  switch (value) {
    case 'differs':
      return uiText('Draft differs from published');
    case 'draft_only':
      return uiText('Only in the draft workspace');
    case 'live_only':
      return uiText('Only in the published version');
    case 'same':
      return uiText('Same as published');
    case 'all':
      return uiText('All tags');
    default:
      return uiText('Unknown');
  }
}
// MSR-01: the published (live) version and the draft workspace come from the same audit reads. The comparison is
// configuration only; it never shows which version a site serves or how consent behaves at runtime.
function mountGtmConsentDiff(diff, live, selectionCurrent) {
  const root = $('#gtm-consent-diff');
  if (!root || !selectionCurrent()) return;
  const settings = ['notSet', 'notNeeded', 'needed', 'unknown'],
    nativeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value),
    types = value =>
      value === null ||
      (Array.isArray(value) &&
        value.length <= 20 &&
        value.every(type => typeof type === 'string' && type.length <= 100)),
    side = value => value === null || (value && settings.includes(value.setting) && types(value.required_types));
  if (!live || live.scope !== 'published_version_configuration') return;
  if (!diff) {
    root.innerHTML =
      live.status === 'unavailable'
        ? `<p class="notice">${esc(uiText('Published-version consent settings could not be summarized within the audit bounds.'))}</p>`
        : live.counts && settings.every(state => Number.isSafeInteger(live.counts[state]))
          ? `<h3>${esc(uiText('Published version consent settings'))}</h3><p>${settings.map(state => `${esc(uiGtmConsentSetting(state))}: ${esc(uiNumber(live.counts[state]))}`).join(' · ')}</p><p class="form-note">${esc(uiText('Choose a workspace to compare its draft consent settings with the published version.'))}</p>`
          : '';
    return;
  }
  const seen = new Set();
  if (
    !Array.isArray(diff.rows) ||
    diff.rows.length > 2000 ||
    !nativeId(diff.live_version_id) ||
    diff.rows.some(row => {
      if (!row || !nativeId(row.tag_id) || seen.has(row.tag_id)) return true;
      seen.add(row.tag_id);
      return !gtmConsentDiffStates.slice(1).includes(row.state) || !side(row.draft) || !side(row.live);
    })
  ) {
    root.innerHTML = `<p class="notice error" role="alert">${esc(uiText('The published and draft consent comparison could not be displayed. Read the audit again.'))}</p>`;
    return;
  }
  const generation = navigationGeneration,
    identity = identityGeneration,
    current = () =>
      generation === navigationGeneration && identity === identityGeneration && root.isConnected && selectionCurrent(),
    cell = value =>
      value === null
        ? esc(uiText('Not present'))
        : `${esc(uiGtmConsentSetting(value.setting))}${value.required_types?.length ? `<br>${value.required_types.map(type => `<code dir="ltr">${esc(type)}</code>`).join(', ')}` : ''}`;
  root.innerHTML = `<h3>${esc(uiText('Published vs draft consent'))}</h3><p class="form-note">${esc(uiText('Compares additional consent settings in the selected workspace with the published version {id}. Both came from this audit; runtime consent and event delivery remain unverified.', {id: diff.live_version_id}))}</p><p>${gtmConsentDiffStates
    .slice(1)
    .map(
      state =>
        `${esc(uiGtmConsentDiffState(state))}: ${esc(uiNumber(diff.rows.filter(row => row.state === state).length))}`,
    )
    .join(
      ' · ',
    )}</p><div class="work-filter"><label>${esc(uiText('Comparison'))}<select id="gtm-consent-diff-filter">${gtmConsentDiffStates.map(state => `<option value="${state}">${esc(uiGtmConsentDiffState(state))}</option>`).join('')}</select></label></div><div id="gtm-consent-diff-rows"></div>`;
  const filter = $('#gtm-consent-diff-filter'),
    rowsNode = $('#gtm-consent-diff-rows');
  filter.value = 'all';
  let page = 0;
  const render = focus => {
    if (!current() || !gtmConsentDiffStates.includes(filter.value)) return;
    const rows = diff.rows.filter(row => filter.value === 'all' || row.state === filter.value),
      last = Math.max(0, Math.ceil(rows.length / 25) - 1);
    page = Math.min(Math.max(0, page), last);
    const shown = rows.slice(page * 25, page * 25 + 25);
    rowsNode.innerHTML =
      (shown.length
        ? `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Published vs draft consent'))}"><table class="review-table"><caption>${esc(uiText('Published vs draft consent'))}</caption><thead><tr><th scope="col">${esc(uiText('Tag'))}</th><th scope="col">${esc(uiText('Draft workspace'))}</th><th scope="col">${esc(uiText('Published version'))}</th><th scope="col">${esc(uiText('Comparison'))}</th></tr></thead><tbody>${shown.map(row => `<tr><th scope="row"><span dir="auto">${esc(row.name ?? uiText('Unknown'))}</span><br><code dir="ltr">${esc(row.tag_id)}</code></th><td>${cell(row.draft)}</td><td>${cell(row.live)}</td><td>${esc(uiGtmConsentDiffState(row.state))}</td></tr>`).join('')}</tbody></table></div>`
        : `<p>${esc(uiText('No tags match these filters.'))}</p>`) +
      `<div class="report-pagination"><p id="gtm-consent-diff-status" role="status" tabindex="-1">${esc(uiText('Showing {shown} of {total} matching tags', {shown: uiNumber(shown.length), total: uiNumber(rows.length)}))}</p><div><button type="button" class="button small" id="gtm-consent-diff-previous" ${page ? '' : 'disabled'}>${esc(uiText('Previous page'))}</button><button type="button" class="button small" id="gtm-consent-diff-next" ${page < last ? '' : 'disabled'}>${esc(uiText('Next page'))}</button></div></div>`;
    $('#gtm-consent-diff-previous').addEventListener('click', () => {
      if (!current() || page <= 0) return;
      page--;
      render(true);
    });
    $('#gtm-consent-diff-next').addEventListener('click', () => {
      if (!current() || page >= last) return;
      page++;
      render(true);
    });
    if (focus) $('#gtm-consent-diff-status').focus();
  };
  filter.addEventListener('change', () => {
    page = 0;
    render(false);
  });
  render(false);
}
function uiGtmConsentSetting(value) {
  switch (value) {
    case 'notSet':
      return uiText('Additional consent not set');
    case 'notNeeded':
      return uiText('No additional consent required');
    case 'needed':
      return uiText('Additional consent required');
    default:
      return uiText('Unknown');
  }
}
// The documented Google consent types (MSR-01); the server applies the same list. Native values are never translated.
const gtmDocumentedConsentTypes = [
  'ad_storage',
  'analytics_storage',
  'ad_user_data',
  'ad_personalization',
  'functionality_storage',
  'personalization_storage',
  'security_storage',
];
function gtmCheckedValues(field) {
  if (!field) return [];
  const nodes = typeof field.length === 'number' && typeof field.item === 'function' ? Array.from(field) : [field];
  return nodes.filter(node => node?.checked === true).map(node => String(node.value));
}
/** Names the non-standard types and, for a likely misspelling, the documented type one or two edits away. */
function gtmCustomTypeWarning(custom) {
  const distance = (a, b) => {
    const row = Array.from({length: b.length + 1}, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const saved = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
        previous = saved;
      }
    }
    return row[b.length];
  };
  const suggestions = custom
    .map(value => [value, gtmDocumentedConsentTypes.find(type => distance(value.toLowerCase(), type) <= 2)])
    .filter(([, type]) => type);
  return [
    uiText(
      'Some consent types are not documented Google consent types: {types}. Check their spelling, or confirm that your consent platform grants them.',
      {types: custom.join(', ')},
    ),
    ...suggestions.map(([value, type]) => uiText('Did you mean {type} instead of {value}?', {type, value})),
  ].join(' ');
}
function mountGtmConsentDraft(evidence, scope, selectionCurrent) {
  const root = $('#gtm-consent-draft');
  if (!root || !selectionCurrent()) return;
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value),
    seen = new Set(),
    validScope =
      scope && ['account_id', 'connection_id', 'container_id', 'workspace_id'].every(key => validId(scope[key])),
    path = validScope
      ? `accounts/${scope.account_id}/containers/${scope.container_id}/workspaces/${scope.workspace_id}`
      : null;
  if (
    !validScope ||
    evidence?.scope !== 'workspace_configuration' ||
    evidence.workspace_path !== path ||
    !Array.isArray(evidence.rows) ||
    evidence.rows.length > 1000 ||
    evidence.tag_count !== evidence.rows.length ||
    evidence.rows.some(row => {
      if (!row || !validId(row.tag_id) || row.path !== path + '/tags/' + row.tag_id || seen.has(row.tag_id))
        return true;
      seen.add(row.tag_id);
      return !['notSet', 'notNeeded', 'needed', 'unknown'].includes(row.setting);
    })
  ) {
    root.innerHTML = `<p class="form-note">${esc(uiText('Choose an exact container and workspace, then read its audit to draft consent changes.'))}</p>`;
    return;
  }
  if (!evidence.rows.length) return;
  root.innerHTML = `<section class="workspace-form"><h3>${esc(uiText('Draft additional consent requirements'))}</h3><p id="gtm-consent-draft-help">${esc(uiText('Choose the tags and literal types your policy requires. Existing required types, tag parameters, triggers and paused state are preserved. Preview and saving make no provider changes. Each update needs native review; publishing remains separate.'))}</p><form id="gtm-consent-form" aria-describedby="gtm-consent-draft-help"><label>${esc(uiText('Choose 1–10 tags'))}<select name="tag_ids" multiple size="6" required>${evidence.rows.map(row => `<option value="${esc(row.tag_id)}" ${row.setting === 'unknown' ? 'disabled' : ''}>${esc(row.name ?? row.tag_id)} · ${esc(row.tag_id)} · ${esc(uiGtmConsentSetting(row.setting))}</option>`).join('')}</select></label><fieldset><legend>${esc(uiText('Documented Google consent types'))}</legend>${gtmDocumentedConsentTypes.map(type => `<label class="checkbox-row"><input type="checkbox" name="standard_types" value="${type}"><code dir="ltr">${type}</code></label>`).join('')}</fieldset><label>${esc(uiText('Other consent types (comma-separated)'))}<input name="required_types" type="text" maxlength="2020" dir="ltr" autocomplete="off" spellcheck="false" aria-describedby="gtm-consent-types-help"></label><p class="form-note" id="gtm-consent-types-help">${esc(uiText('Use 1–20 distinct literal types. Variables and automatic policy selection are unavailable. Unknown native settings need separate inspection.'))} ${esc(uiText('Enter other types only when your consent platform grants them; a misspelled type is never granted and the tag stops firing after publishing.'))}</p><label class="checkbox-row"><input type="checkbox" name="custom_types_acknowledged" value="true">${esc(uiText('I confirm our consent platform grants the non-standard types entered above.'))}</label><p id="gtm-consent-custom-warning" class="notice" role="alert" hidden></p><button type="submit" class="button primary">${esc(uiText('Preview consent additions'))}</button></form><div id="gtm-consent-preview"></div></section>`;
  const form = $('#gtm-consent-form'),
    result = $('#gtm-consent-preview'),
    begin = accountWorkflowContext(form, result);
  workspaceBind('#gtm-consent-form', async () => {
    const attemptCurrent = begin(),
      current = () => selectionCurrent() && root.isConnected && attemptCurrent();
    if (!current()) return;
    const tagIds = Array.from(form.elements.tag_ids.selectedOptions, option => option.value),
      checked = gtmCheckedValues(form.elements.standard_types).filter(value =>
        gtmDocumentedConsentTypes.includes(value),
      ),
      typed = form.elements.required_types.value.trim()
        ? form.elements.required_types.value.split(/[,،]/).map(value => value.trim())
        : [],
      types = [...checked, ...typed.filter(value => !checked.includes(value))],
      custom = types.filter(value => !gtmDocumentedConsentTypes.includes(value)),
      acknowledged = gtmCheckedValues(form.elements.custom_types_acknowledged).includes('true'),
      warning = $('#gtm-consent-custom-warning');
    if (warning) {
      warning.hidden = true;
      warning.textContent = '';
    }
    if (
      !tagIds.length ||
      tagIds.length > 10 ||
      new Set(tagIds).size !== tagIds.length ||
      tagIds.some(id => !evidence.rows.some(row => row.tag_id === id && row.setting !== 'unknown'))
    )
      throw Error(uiText('Choose 1–10 distinct exact tag IDs.'));
    if (
      !types.length ||
      types.length > 20 ||
      new Set(typed).size !== typed.length ||
      types.some(value => !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(value))
    )
      throw Error(
        uiText('Choose 1–20 distinct literal additional-consent types. Variables and duplicate types are refused.'),
      );
    // MSR-01: a non-standard type is never granted unless a consent platform grants it by that exact name.
    if (custom.length && !acknowledged) {
      const message = gtmCustomTypeWarning(custom);
      if (warning) {
        warning.textContent = message;
        warning.hidden = false;
      }
      throw Error(message);
    }
    let p;
    try {
      p = await workspaceCall('workspace', {
        action: 'preview_consent_plan',
        gateway: 'gtm_native_action',
        account_id: scope.account_id,
        connection_id: scope.connection_id,
        requirements: {
          container_id: scope.container_id,
          workspace_id: scope.workspace_id,
          tag_ids: tagIds,
          required_types: types,
          ...(custom.length ? {custom_types_acknowledged: true} : {}),
        },
      });
    } catch (error) {
      if (current()) throw Error(uiAccountExplanation(error.message));
      return;
    }
    if (!current()) return;
    const valid =
      p?.record_kind === 'gtm_consent_preview' &&
      typeof p.preview_id === 'string' &&
      /^[a-f0-9]{64}$/.test(p.preview_hash) &&
      Number.isSafeInteger(p.expires_at) &&
      p.expires_at > Date.now() &&
      p.provider_mutations === 0 &&
      p.publishing === false &&
      p.scope?.gateway === 'gtm_native_action' &&
      p.scope?.workspace_path === path &&
      ['account_id', 'connection_id', 'container_id', 'workspace_id'].every(key => p.scope[key] === scope[key]) &&
      JSON.stringify(p.scope.tag_ids) === JSON.stringify(tagIds) &&
      JSON.stringify(p.scope.required_types) === JSON.stringify(types) &&
      JSON.stringify(p.scope.custom_types ?? []) === JSON.stringify(custom) &&
      Array.isArray(p.targets) &&
      p.targets.length === tagIds.length &&
      p.targets.some(t => t.state === 'change') &&
      p.targets.every(
        (t, i) =>
          t &&
          t.tag_id === tagIds[i] &&
          t.path === path + '/tags/' + tagIds[i] &&
          ['change', 'unchanged'].includes(t.state) &&
          ['notSet', 'notNeeded', 'needed'].includes(t.before_setting) &&
          Array.isArray(t.before_required_types) &&
          Array.isArray(t.proposed_required_types) &&
          t.proposed_required_types.length <= 20 &&
          t.proposed_required_types.every(v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(v)) &&
          t.before_required_types.every(v => t.proposed_required_types.includes(v)) &&
          JSON.stringify(t.proposed_required_types) ===
            JSON.stringify([...t.before_required_types, ...types.filter(v => !t.before_required_types.includes(v))]),
      );
    if (!valid) throw Error(uiText('The consent preview does not match this selection. Read a new preview.'));
    const table = `<h4 tabindex="-1" id="gtm-consent-preview-title">${esc(uiText('Review explicit consent additions'))}</h4><p class="notice">${esc(uiText('This is an unapproved workspace proposal. Built-in consent checks, consent defaults and updates, runtime order and event delivery remain unverified.'))}</p>${custom.length ? `<p class="notice warning"><strong>${esc(uiText('Non-standard consent type'))}</strong>: ${custom.map(value => `<code dir="ltr">${esc(value)}</code>`).join(', ')}. ${esc(uiText('A tag that requires a type your consent platform never grants will not fire after publishing.'))}</p>` : ''}<p>${esc(uiText('Preview expires: {date}', {date: uiDate(p.expires_at)}))}</p><div class="data-scroll" role="region" aria-label="${esc(uiText('Consent additions'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('Consent additions'))}</caption><thead><tr><th scope="col">${esc(uiText('Tag'))}</th><th scope="col">${esc(uiText('Original consent setting'))}</th><th scope="col">${esc(uiText('Original required types'))}</th><th scope="col">${esc(uiText('Proposed required types'))}</th><th scope="col">${esc(uiText('Draft change'))}</th></tr></thead><tbody>${p.targets.map(t => `<tr><th scope="row"><bdi dir="auto">${esc(t.name ?? t.tag_id)}</bdi><br><code dir="ltr">${esc(t.tag_id)}</code></th><td>${esc(uiGtmConsentSetting(t.before_setting))}</td><td><code dir="ltr">${esc(t.before_required_types.join(', ') || '—')}</code></td><td><code dir="ltr">${esc(t.proposed_required_types.join(', '))}</code></td><td>${esc(uiText(t.state === 'change' ? 'Add required types' : 'Already required; no step'))}</td></tr>`).join('')}</tbody></table></div>${recordDetails({workspace_path: path, source_hash: p.source_hash, source_references: p.source_references, network_requests: p.network_requests}, uiText('Consent source references'))}`;
    result.innerHTML =
      table +
      `<button id="gtm-consent-save" class="button primary" type="button">${esc(uiText('Save unapproved consent draft'))}</button>`;
    $('#gtm-consent-preview-title').focus();
    const button = $('#gtm-consent-save');
    workspaceBind(
      '#gtm-consent-save',
      async () => {
        if (!current()) return;
        if (p.expires_at <= Date.now()) throw Error(uiText('The consent preview expired. Read a new preview.'));
        let saved;
        try {
          saved = await workspaceCall('workspace', {
            action: 'create_consent_plan',
            preview_id: p.preview_id,
            preview_hash: p.preview_hash,
            confirmed: true,
          });
        } catch (error) {
          if (current()) throw Error(uiAccountExplanation(error.message));
          return;
        }
        if (!current()) return;
        if (
          saved?.record_kind !== 'gtm_consent_plan' ||
          typeof saved.id !== 'string' ||
          !validId(saved.id) ||
          saved.provider_mutations !== 0 ||
          saved.publishing !== false ||
          saved.approval_required !== true
        )
          throw Error(
            uiText('The saved consent draft could not be verified. Inspect the original preview before retrying.'),
          );
        result.innerHTML =
          table +
          `<p role="status" class="notice">${esc(uiText('Unapproved consent draft saved. Review each native update before execution. Publishing remains separate.'))} <a href="/campaigns?id=${encodeURIComponent(saved.id)}">${esc(uiText('Open consent draft'))}</a></p>`;
      },
      {disabled: () => !current() || !button.isConnected || p.expires_at <= Date.now()},
    );
  });
}
function mountGtmConsentEvidence(evidence, selectionCurrent) {
  if (!evidence) return;
  const root = $('#gtm-consent-evidence'),
    generation = navigationGeneration,
    identity = identityGeneration,
    current = () =>
      generation === navigationGeneration && identity === identityGeneration && root.isConnected && selectionCurrent(),
    states = ['notSet', 'notNeeded', 'needed', 'unknown'];
  if (!current()) return;
  if (
    evidence.scope !== 'workspace_configuration' ||
    !Array.isArray(evidence.rows) ||
    evidence.rows.length > 1000 ||
    evidence.tag_count !== evidence.rows.length ||
    evidence.rows.some(
      row =>
        !row ||
        typeof row.tag_id !== 'string' ||
        typeof row.path !== 'string' ||
        !states.includes(row.setting) ||
        (row.required_types !== null &&
          (!Array.isArray(row.required_types) ||
            row.required_types.length > 20 ||
            row.required_types.some(v => typeof v !== 'string' || v.length > 100))),
    )
  ) {
    root.innerHTML = `<p class="notice error" role="alert">${esc(uiText('Consent evidence could not be displayed. Read the audit again.'))}</p>`;
    return;
  }
  root.innerHTML = `<h3>${esc(uiText('Workspace consent settings'))}</h3><p class="form-note">${esc(uiText('These are additional consent settings in the selected workspace. Built-in checks, default and updated consent states, runtime timing and event delivery remain unverified.'))}</p><p><code dir="ltr">${esc(evidence.workspace_path)}</code></p><p>${states.map(state => `${esc(uiGtmConsentSetting(state))}: ${esc(uiNumber(evidence.rows.filter(row => row.setting === state).length))}`).join(' · ')}</p><div class="work-filter"><label>${esc(uiText('Additional consent'))}<select id="gtm-consent-filter"><option value="all">${esc(uiText('All tags'))}</option>${states.map(state => `<option value="${state}">${esc(uiGtmConsentSetting(state))}</option>`).join('')}</select></label><label>${esc(uiText('Search tag name, ID or consent type'))}<input type="search" id="gtm-consent-search" maxlength="150"></label></div><div id="gtm-consent-rows"></div>`;
  const filter = $('#gtm-consent-filter'),
    search = $('#gtm-consent-search'),
    rowsNode = $('#gtm-consent-rows');
  filter.value = 'all';
  search.value = '';
  let offset = 0;
  const render = (focus = false) => {
    if (!current()) return;
    const query = search.value.slice(0, 150).toLocaleLowerCase(),
      rows = evidence.rows.filter(
        row =>
          (filter.value === 'all' || row.setting === filter.value) &&
          [row.tag_id, row.name, row.type, ...(row.required_types ?? [])].some(value =>
            String(value ?? '')
              .toLocaleLowerCase()
              .includes(query),
          ),
      ),
      page = rows.slice(offset, offset + 50);
    rowsNode.innerHTML = rows.length
      ? `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Tag consent configuration table'))}"><table class="review-table"><caption>${esc(uiText('Additional consent by tag'))}</caption><thead><tr>${['Tag', 'Type', 'Additional consent', 'Required consent types', 'Configured status'].map(label => `<th scope="col">${esc(uiText(label))}</th>`).join('')}</tr></thead><tbody>${page.map(row => `<tr><th scope="row"><span dir="auto">${esc(row.name ?? uiText('Unknown'))}</span><br><code dir="ltr">${esc(row.tag_id)}</code></th><td dir="ltr">${esc(row.type ?? uiText('Unknown'))}</td><td>${esc(uiGtmConsentSetting(row.setting))}${row.reason ? `<p class="form-note">${esc(uiText('The additional consent types could not be interpreted. Inspect the native tag settings.'))}</p>` : ''}</td><td>${row.required_types === null ? esc(uiText('Unknown')) : row.required_types.length ? row.required_types.map(value => `<code dir="ltr">${esc(value)}</code>`).join(', ') : esc(uiText('No additional types listed'))}</td><td>${esc(row.paused === true ? uiText('Paused') : row.paused === false ? uiText('Unpaused') : uiText('Unknown'))}</td></tr>`).join('')}</tbody></table></div>`
      : `<p>${esc(evidence.rows.length ? uiText('No tags match these filters.') : uiText('No tags in this workspace inventory.'))}</p>`;
    rowsNode.innerHTML += `<div class="report-pagination"><p id="gtm-consent-status" role="status" tabindex="-1">${esc(uiText('Showing {shown} of {total} matching tags', {shown: uiNumber(page.length), total: uiNumber(rows.length)}))}</p><div><button type="button" class="button small" id="gtm-consent-previous">${esc(uiText('Previous page'))}</button><button type="button" class="button small" id="gtm-consent-next">${esc(uiText('Next page'))}</button></div></div>`;
    $('#gtm-consent-previous').disabled = offset === 0;
    $('#gtm-consent-next').disabled = offset + 50 >= rows.length;
    $('#gtm-consent-previous').addEventListener('click', () => {
      if (current() && offset > 0) {
        offset -= 50;
        render(true);
      }
    });
    $('#gtm-consent-next').addEventListener('click', () => {
      if (current() && offset + 50 < rows.length) {
        offset += 50;
        render(true);
      }
    });
    if (focus) $('#gtm-consent-status').focus();
  };
  const refresh = () => {
    if (current() && ['all', ...states].includes(filter.value)) {
      offset = 0;
      render();
    }
  };
  filter.addEventListener('change', refresh);
  search.addEventListener('input', refresh);
  render();
}
const measurementIdentityLabels = {
  matches_declared: 'Reported count matches your expectation',
  above_declared: 'Reported count is above your expectation',
  below_declared: 'Reported count is below your expectation',
  not_observed: 'No matching count returned',
};
function measurementIdentityPeriod(from, to) {
  const day = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return null;
    const time = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
  };
  const first = day(from),
    last = day(to);
  return first !== null && last !== null && last >= first && last - first <= 6 * 86400000;
}
function measurementIdentityRows(out, requirements) {
  if (!Array.isArray(out.rows) || out.rows.length > 1000 || !out.observation) return false;
  const seen = new Set();
  let total = 0n;
  for (const row of out.rows) {
    if (
      !row ||
      row.event_name !== requirements.event_name ||
      row.test_id !== requirements.test_id ||
      !/^[1-9][0-9]{0,19}$/.test(row.stream_id ?? '') ||
      typeof row.stream_id !== 'string' ||
      (requirements.stream_id && row.stream_id !== requirements.stream_id) ||
      seen.has(row.stream_id) ||
      typeof row.event_count !== 'string' ||
      !/^(?:0|[1-9][0-9]{0,29})$/.test(row.event_count)
    )
      return false;
    seen.add(row.stream_id);
    total += BigInt(row.event_count);
  }
  const count = out.rows.length ? String(total) : null,
    expected = BigInt(requirements.expected_count);
  const comparison =
    count === null
      ? 'not_observed'
      : total === expected
        ? 'matches_declared'
        : total > expected
          ? 'above_declared'
          : 'below_declared';
  return out.observation.reported_count === count && out.observation.comparison === comparison;
}
function measurementEventIdentityMarkup(targets) {
  return `<section class="panel workspace-form">${measurementSectionHeading('measurement-section-identity', uiText('Inspect a specific GA4 test identifier'))}<p>${esc(uiText('Use an existing event-scoped amcp_test_id custom dimension and a synthetic identifier already sent by your own test instrumentation. AMCP does not register the dimension or send an event.'))}</p><form id="measurement-event-identity">${measurementTargetField(targets, uiText('GA4 property'), 'Connect a GA4 property in Connections to inspect a test identifier.', uiText('Choose a login and account'))}<label>${esc(uiText('Exact event name'))}<input name="event_name" type="text" maxlength="40" required></label><label>${esc(uiText('Synthetic test identifier'))}<input name="test_id" type="text" maxlength="74" required aria-describedby="measurement-identity-help" dir="ltr"></label><p class="form-note" id="measurement-identity-help">${esc(uiText('Use amcp-test- followed by 8–64 letters, digits or hyphens. Generate a new identifier only before your separate test; enter the original identifier to inspect an existing test.'))}</p><button id="measurement-identity-generate" type="button" class="button small">${esc(uiText('Generate a synthetic test identifier'))}</button><label>${esc(uiText('Report source'))}<select name="mode" aria-describedby="measurement-identity-mode-help"><option value="core_report">${esc(uiText('Core reports: property calendar dates'))}</option><option value="realtime_user_scope">${esc(uiText('Realtime: user scope, test properties only'))}</option></select></label><p class="form-note" id="measurement-identity-mode-help">${esc(uiText('Realtime reads a user-scoped amcp_test_id on a GA4 property the workspace owner marked as a test property. Counts arrive within minutes but cover every event of the test user, so they are not event-level proof.'))}</p><div id="measurement-identity-dates"><label>${esc(uiText('From date'))}<input name="date_from" type="date" required></label><label>${esc(uiText('To date'))}<input name="date_to" type="date" required></label><p class="form-note">${esc(uiText('Choose at most seven calendar days in the GA4 property timezone. Core reporting may lag; this is not a realtime event trace.'))}</p></div><div id="measurement-identity-minutes" hidden><label>${esc(uiText('Recent window (minutes)'))}<input name="minutes" type="number" min="1" max="30" step="1" value="30"></label></div><label>${esc(uiText('Stream ID (optional)'))}<input name="stream_id" type="text" maxlength="20" inputmode="numeric" dir="ltr"></label><label>${esc(uiText('Your expected count'))}<input name="expected_count" type="number" min="1" max="1000" step="1" value="1" required></label><button type="submit" class="button primary" ${targets.length ? '' : 'disabled'}>${esc(uiText('Read matching test counts'))}</button></form><div id="measurement-event-identity-result" aria-live="polite"></div></section>`;
}
function bindMeasurementEventIdentity(targets) {
  const form = $('#measurement-event-identity'),
    result = $('#measurement-event-identity-result'),
    feedback = measurementReadFeedback(form),
    begin = accountWorkflowContext(form, result);
  // MSR-04: the realtime mode reads a recent minute window instead of property calendar dates.
  const realtimeMode = () => form.elements.mode?.value === 'realtime_user_scope',
    modeSwitch = () => {
      const realtime = realtimeMode();
      $('#measurement-identity-dates').hidden = realtime;
      $('#measurement-identity-minutes').hidden = !realtime;
      form.elements.date_from.required = form.elements.date_to.required = !realtime;
      if (form.elements.minutes) form.elements.minutes.required = realtime;
    };
  form.elements.mode?.addEventListener('change', modeSwitch);
  if (typeof location !== 'undefined') {
    const p = new URLSearchParams(location.search);
    if (p.has('event_identity')) {
      const realtime = p.get('mode') === 'realtime_user_scope',
        keys = [
          'event_identity',
          'account_id',
          'connection_id',
          'event_name',
          'test_id',
          ...(realtime ? ['mode', 'minutes'] : ['date_from', 'date_to']),
          'expected_count',
        ],
        index = targets.findIndex(
          t => t.account_id === p.get('account_id') && t.connection_id === p.get('connection_id'),
        ),
        valid =
          p.get('event_identity') === '1' &&
          keys.every(k => p.getAll(k).length === 1) &&
          p.getAll('stream_id').length <= 1 &&
          index >= 0 &&
          /^amcp-test-[A-Za-z0-9-]{8,64}$/.test(p.get('test_id') ?? '') &&
          /^\p{L}[\p{L}\p{N}_]{0,39}$/u.test(p.get('event_name') ?? '') &&
          (realtime
            ? /^[1-9][0-9]?$/.test(p.get('minutes') ?? '') &&
              Number(p.get('minutes')) <= 30 &&
              !p.has('date_from') &&
              !p.has('date_to')
            : !p.has('mode') && !p.has('minutes') && measurementIdentityPeriod(p.get('date_from'), p.get('date_to'))) &&
          /^[1-9][0-9]{0,3}$/.test(p.get('expected_count') ?? '') &&
          Number(p.get('expected_count')) <= 1000 &&
          (!p.has('stream_id') || /^[1-9][0-9]{0,19}$/.test(p.get('stream_id') ?? ''));
      form.elements.target.value = valid ? String(index) : '';
      if (form.elements.mode) form.elements.mode.value = valid && realtime ? 'realtime_user_scope' : 'core_report';
      if (form.elements.minutes) form.elements.minutes.value = valid && realtime ? p.get('minutes') : '30';
      modeSwitch();
      for (const k of ['event_name', 'test_id', 'date_from', 'date_to', 'stream_id', 'expected_count'])
        form.elements[k].value = valid ? (p.get(k) ?? '') : k === 'expected_count' ? '1' : '';
      result.innerHTML = `<p class="form-note" role="status">${esc(uiText(valid ? 'Test scope selected from the original inspection. Read current evidence to refresh it.' : 'The linked test scope is unavailable. Choose a currently selected property and original test identifier.'))}</p>`;
    }
  }
  workspaceBind('#measurement-identity-generate', async () => {
    const current = begin();
    if (!current()) return;
    form.elements.test_id.value = 'amcp-test-' + crypto.randomUUID();
    form.elements.test_id.focus();
  });
  workspaceBind('#measurement-event-identity', async () => {
    const current = begin();
    if (!current()) return;
    feedback.clear();
    try {
      const target = targets[Number(form.elements.target.value)];
      if (form.elements.target.value === '' || !target) throw Error(uiText('Choose a GA4 property.'));
      const realtime = realtimeMode(),
        requirements = realtime
          ? {
              mode: 'realtime_user_scope',
              event_name: form.elements.event_name.value.trim(),
              test_id: form.elements.test_id.value.trim(),
              minutes: Number(form.elements.minutes.value),
              expected_count: Number(form.elements.expected_count.value),
            }
          : {
              event_name: form.elements.event_name.value.trim(),
              test_id: form.elements.test_id.value.trim(),
              date_from: form.elements.date_from.value,
              date_to: form.elements.date_to.value,
              expected_count: Number(form.elements.expected_count.value),
            },
        stream = form.elements.stream_id.value.trim();
      if (stream) requirements.stream_id = stream;
      const {label, ...scope} = target;
      let out;
      out = await workspaceCall('workspace', {action: 'measurement_event_identity', ...scope, requirements});
      if (!current()) return;
      if (
        out?.record_kind !== 'measurement_event_identity' ||
        out.scope?.property_id !== scope.account_id ||
        out.scope.connection_id !== scope.connection_id ||
        out.scope.event_name !== requirements.event_name ||
        out.scope.test_id !== requirements.test_id ||
        out.scope.stream_id !== (stream || null) ||
        (realtime
          ? out.mode !== 'realtime_user_scope' ||
            out.scope.mode !== 'realtime_user_scope' ||
            out.scope.identity_dimension !== 'customUser:amcp_test_id' ||
            out.scope.minutes !== requirements.minutes ||
            out.relative_window?.start_minutes_ago !== requirements.minutes - 1 ||
            out.relative_window.end_minutes_ago !== 0 ||
            out.checks?.event_level_proof !== 'not_established'
          : out.mode === 'realtime_user_scope' ||
            out.scope.date_from !== requirements.date_from ||
            out.scope.date_to !== requirements.date_to ||
            out.period?.date_from !== requirements.date_from ||
            out.period.date_to !== requirements.date_to ||
            typeof out.period.timezone !== 'string' ||
            !out.period.timezone) ||
        !out.observation ||
        !Object.hasOwn(measurementIdentityLabels, out.observation.comparison) ||
        (out.observation.reported_count !== null &&
          (typeof out.observation.reported_count !== 'string' || !/^\d+$/.test(out.observation.reported_count))) ||
        out.observation.declared_expected_count !== String(requirements.expected_count) ||
        !measurementIdentityRows(out, requirements)
      )
        throw Error(
          uiText('The test inspection response is incomplete or belongs to a different selection. Read it again.'),
        );
      result.innerHTML = `<h3 id="measurement-identity-heading" tabindex="-1">${esc(uiText('GA4 property {id}', {id: out.scope.property_id}))}</h3><p><bdi dir="auto">${esc(out.scope.event_name)}</bdi> · <bdi dir="ltr">${esc(out.scope.test_id)}</bdi></p>${realtime ? `<p>${esc(uiText('Realtime window: the last {minutes} minutes, relative to GA4 processing time', {minutes: uiNumber(out.scope.minutes)}))}</p><p class="notice">${esc(uiText('User-scoped realtime counts: every event of the synthetic test user carries this identifier, so a match is not event-level proof. Realtime processing can lag by a few minutes.'))}</p>` : `<p>${esc(uiText('Property calendar dates'))}: <bdi dir="ltr">${esc(out.period.date_from)} — ${esc(out.period.date_to)}</bdi> · ${esc(uiText('Timezone'))}: <bdi dir="ltr">${esc(out.period.timezone)}</bdi></p>`}<div class="workspace-metrics"><article><strong class="${out.observation.reported_count === null ? 'measurement-count-missing' : ''}"><bdi dir="ltr">${esc(out.observation.reported_count ?? uiText('No count returned'))}</bdi></strong><span>${esc(uiText('Reported matching count'))}</span></article><article><strong><bdi dir="ltr">${esc(out.observation.declared_expected_count)}</bdi></strong><span>${esc(uiText('Your declared expectation'))}</span></article></div><p class="notice">${esc(uiText(measurementIdentityLabels[out.observation.comparison]))}</p><p>${esc(uiText('Matching this test identifier does not establish deduplication, consent, attribution or overall tracking health. Multiple counts are a reason to investigate, not proof of duplicate delivery. Missing or zero counts can reflect processing delays or filters.'))}</p><p class="form-note">${esc(uiText('No event was sent and no snapshot was saved. The existing custom dimension was checked before and after this bounded report.'))}</p>${realtime ? `<p class="form-note">${esc(uiText('The user-scoped amcp_test_id value stays on the synthetic test user in GA4. Use a fresh identifier and a dedicated test browser or device for each test.'))}</p>` : ''}<div class="data-scroll" role="region" aria-label="${esc(uiText('Matching test counts by stream'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('Matching test counts by stream'))}</caption><thead><tr><th scope="col">${esc(uiText('Stream ID'))}</th><th scope="col">${esc(uiText('Reported count'))}</th></tr></thead><tbody>${out.rows.map(r => `<tr><th scope="row"><bdi dir="ltr">${esc(r.stream_id)}</bdi></th><td><bdi dir="ltr">${esc(r.event_count)}</bdi></td></tr>`).join('') || `<tr><td colspan="2">${esc(uiText('No matching test rows were returned.'))}</td></tr>`}</tbody></table></div>${recordDetails(out, uiText('Test scope, source references and unverified checks'))}`;
      $('#measurement-identity-heading').focus();
    } catch (error) {
      if (current()) feedback.show(error);
    }
  });
}
function measurementEventsMarkup(targets) {
  return `<section class="panel workspace-form">${measurementSectionHeading('measurement-section-events', uiText('Recent GA4 events'))}<p>${esc(uiText('Read aggregate counts for exact event names in one selected property and a recent window. This does not send a test event.'))}</p>
  <form id="measurement-events">${measurementTargetField(targets, uiText('GA4 property'), 'Connect a GA4 property in Connections to read recent events.', uiText('Choose a login and account'))}
  <label>${esc(uiText('Exact event names'))}<textarea name="event_names" rows="2" maxlength="900" required aria-describedby="measurement-event-names-help"></textarea></label><p class="form-note" id="measurement-event-names-help">${esc(uiText('Separate names with commas or new lines. Names are case-sensitive; select at most 20.'))}</p>
  <label>${esc(uiText('Recent window (minutes)'))}<input name="minutes" type="number" min="1" max="30" step="1" value="5" required></label><label>${esc(uiText('Stream ID (optional)'))}<input name="stream_id" type="text" inputmode="numeric" maxlength="20"></label>
  <button class="button primary" type="submit" ${targets.length ? '' : 'disabled'}>${esc(uiText('Read recent event counts'))}</button></form><div id="measurement-events-result" aria-live="polite"></div></section>`;
}
function bindMeasurementEvents(targets) {
  const form = $('#measurement-events'),
    result = $('#measurement-events-result'),
    feedback = measurementReadFeedback(form),
    begin = accountWorkflowContext(form, result);
  workspaceBind('#measurement-events', async form => {
    const current = begin();
    if (!current()) return;
    feedback.clear();
    try {
      const t = targets[Number(form.elements.target.value)];
      if (form.elements.target.value === '' || !t) throw Error(uiText('Choose a GA4 property.'));
      const event_names = form.elements.event_names.value
          .split(/[,\r\n]+/)
          .map(s => s.trim())
          .filter(Boolean),
        minutes = Number(form.elements.minutes.value),
        stream = form.elements.stream_id.value.trim();
      if (!event_names.length || event_names.length > 20) throw Error(uiText('Enter 1–20 exact event names.'));
      const {label, ...scope} = t;
      let out;
      out = await workspaceCall('workspace', {
        action: 'measurement_events',
        ...scope,
        requirements: {event_names, minutes, ...(stream ? {stream_id: stream} : {})},
      });
      if (!current()) return;
      const status = e => (e.state === 'observed' ? uiText('Activity observed') : uiText('No positive count observed'));
      result.innerHTML = `<h3 id="measurement-events-heading" tabindex="-1">${esc(uiText('GA4 property {id}', {id: out.scope.property_id}))}</h3>
      <p>${esc(uiText('Window: {minutes} minutes · Stream: {stream}', {minutes: out.scope.minutes, stream: out.scope.stream_id ?? uiText('All returned streams')}))}</p><p>${esc(uiText('Requested {requested} · Returned {captured}', {requested: date(out.requested_at), captured: date(out.captured_at)}))}</p>
      <div class="data-scroll" role="region" aria-label="${esc(uiText('Recent event counts'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('Recent event counts'))}</caption><thead><tr><th scope="col">${esc(uiText('Event'))}</th><th scope="col">${esc(uiText('Reported count'))}</th><th scope="col">${esc(uiText('Observation'))}</th></tr></thead><tbody>${out.events.map(e => `<tr><th scope="row"><bdi dir="ltr">${esc(e.event_name)}</bdi></th><td><bdi dir="ltr">${esc(e.reported_count ?? uiText('No count returned'))}</bdi></td><td>${esc(status(e))}</td></tr>`).join('')}</tbody></table></div>
      <p class="notice">${esc(uiText('Missing or zero counts do not establish a broken tag; realtime processing can lag.'))}</p><p>${esc(uiText('These aggregate counts cannot identify your test event or verify deduplication, consent or attribution. They do not establish conversion configuration or overall tracking health. No test events were sent and no snapshot was saved.'))}</p>
      <details class="workspace-details"><summary>${esc(uiText('Minute and stream evidence'))}</summary><p>${esc(uiText('Minutes ago are relative to GA4 request processing time, not exact event timestamps.'))}</p><div class="data-scroll" role="region" aria-label="${esc(uiText('Minute and stream evidence'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('Minute and stream evidence'))}</caption><thead><tr><th scope="col">${esc(uiText('Event'))}</th><th scope="col">${esc(uiText('Minutes ago'))}</th><th scope="col">${esc(uiText('Stream ID'))}</th><th scope="col">${esc(uiText('Reported count'))}</th></tr></thead><tbody>${out.rows.map(r => `<tr><th scope="row"><bdi dir="ltr">${esc(r.event_name)}</bdi></th><td><bdi dir="ltr">${esc(r.minutes_ago)}</bdi></td><td><bdi dir="ltr">${esc(r.stream_id)}</bdi></td><td><bdi dir="ltr">${esc(r.event_count)}</bdi></td></tr>`).join('') || `<tr><td colspan="4">${esc(uiText('No minute rows were returned.'))}</td></tr>`}</tbody></table></div></details>${recordDetails(out, uiText('Observation scope and evidence limits'))}`;
      $('#measurement-events-heading').focus();
    } catch (error) {
      if (current()) feedback.show(error);
    }
  });
}
function parseProductCSV(text, gateway = 'meta_native_action') {
  const table = parseProductCSVTable(text);
  if (table.headers.some(header => !catalogSourceFields(gateway).includes(header)))
    throw Error(
      uiText('AMCP column mode accepts only product fields. Choose supplier mapping to select other source columns.'),
    );
  return table.rows;
}
// A product CSV holds at most 500 products in 192 KiB, the bounds of AMCP's CSV source (src/catalog-sources.ts): more
// than 50 are saved as one plan group (COM-03), and AMCP checks the exact byte size again.
const catalogCsvMaxRows = 500,
  catalogCsvMaxBytes = 196608;
function parseProductCSVTable(text) {
  if (text.length > catalogCsvMaxBytes) throw Error(uiText('Use a CSV source of at most 192 KiB and 500 products.'));
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [],
    field = '',
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
      continue;
    }
    if (c === '"') {
      if (field || closed) throw Error(uiText('Invalid CSV quoting.'));
      quoted = true;
      continue;
    }
    if (closed && !['\r', '\n', ','].includes(c)) throw Error(uiText('Unexpected text after a quoted CSV value.'));
    if (c === ',') {
      row.push(field);
      field = '';
      closed = false;
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
      field = '';
      closed = false;
      continue;
    }
    field += c;
  }
  if (quoted) throw Error(uiText('A quoted CSV value is not closed.'));
  row.push(field);
  if (row.some(v => v !== '')) rows.push(row);
  const headers = rows.shift()?.map(h => h.replace(/^\uFEFF/, '').trim());
  if (
    !headers?.length ||
    headers.length > 100 ||
    headers.some(h => !h || h.length > 200 || /[\x00-\x1f\x7f]/.test(h)) ||
    new Set(headers).size !== headers.length
  )
    throw Error(uiText('Use 1–100 unique named CSV columns, each up to 200 characters.'));
  if (rows.length > catalogCsvMaxRows) throw Error(uiText('Use a CSV source of at most 192 KiB and 500 products.'));
  return {
    headers,
    rows: rows.map(r => {
      if (r.length !== headers.length) throw Error(uiText('Every CSV row must match the header columns.'));
      return Object.fromEntries(headers.map((h, i) => [h, r[i]]).filter(([, v]) => v !== ''));
    }),
  };
}
const catalogMapFields = [
  'retailer_id',
  'name',
  'price',
  'currency',
  'image_url',
  'url',
  'availability',
  'condition',
  'brand',
  'description',
];
// An optional sale for every destination (COM-02 A): a decimal sale price and its literal start and end.
const catalogSaleFields = ['sale_price', 'sale_price_start_date', 'sale_price_end_date'];
function catalogSourceFields(gateway = 'meta_native_action') {
  if (!['meta_native_action', 'x_ads_native_action', 'snapchat_native_action'].includes(gateway))
    throw Error(uiText('Choose the exact account.'));
  // COM-02 D: a Snapchat comparison compares a sale price only; the read format of Snapchat sale dates is unqualified.
  return gateway === 'meta_native_action'
    ? [...catalogMapFields, 'retailer_product_group_id', ...catalogSaleFields]
    : gateway === 'snapchat_native_action'
      ? [...catalogMapFields, 'sale_price']
      : [...catalogMapFields, ...catalogSaleFields];
}
function catalogFieldLabel(field) {
  switch (field) {
    case 'retailer_id':
      return uiText('Retailer ID');
    case 'retailer_product_group_id':
      return uiText('Meta product group ID');
    case 'name':
      return uiText('Product name');
    case 'price':
      return uiText('Decimal price');
    case 'currency':
      return uiText('Currency');
    case 'image_url':
      return uiText('Product image URL');
    case 'url':
      return uiText('Product page URL');
    case 'availability':
      return uiText('Availability');
    case 'condition':
      return uiText('Condition');
    case 'brand':
      return uiText('Brand');
    case 'description':
      return uiText('Description');
    case 'sale_price':
      return uiText('Sale price');
    case 'sale_price_start_date':
      return uiText('Sale start (ISO 8601 with offset)');
    case 'sale_price_end_date':
      return uiText('Sale end (ISO 8601 with offset)');
    case 'sale_price_effective_date':
      return uiText('Sale period');
    default:
      return field;
  }
}
/**
 * A supplier export reduced to the columns a mapping selects (COM-03): AMCP projects it on the server with the saved
 * mapping profile, so only selected columns leave the browser (and, for an image list read by its first URL, only that
 * URL). Incomplete selections and rows without a required value are refused here, before anything is sent.
 */
function selectedCatalogSource(table, settings) {
  const {columns, fixed_currency, image_mode} = settings,
    fields = catalogSourceFields(settings.gateway);
  if (
    !columns ||
    Object.keys(columns).some(k => !fields.includes(k)) ||
    Object.values(columns).some(v => typeof v !== 'string' || (v && !table.headers.includes(v)))
  )
    throw Error(uiText('Choose only columns from the loaded CSV.'));
  if (!['single', 'first_list'].includes(image_mode)) throw Error(uiText('Choose how to read the image column.'));
  if (
    typeof fixed_currency !== 'string' ||
    (columns.currency ? fixed_currency !== '' : !/^[A-Z]{3}$/.test(fixed_currency))
  )
    throw Error(
      uiText('Choose either a currency column or one explicit three-letter uppercase currency for every row.'),
    );
  const required =
    settings.gateway === 'x_ads_native_action'
      ? catalogMapFields.filter(key => key !== 'currency')
      : ['retailer_id', 'name', 'price', 'image_url'];
  for (const key of required)
    if (!columns[key]) throw Error(uiText('Select a source column for {field}.', {field: catalogFieldLabel(key)}));
  if (!table.rows.length) throw Error(uiText('The CSV has no product rows.'));
  const chosen = Object.fromEntries(Object.entries(columns).filter(([, header]) => header)),
    headers = [...new Set(Object.values(chosen))],
    // Only the image column read by its first URL is shortened, and only when no other field reads that column.
    image =
      image_mode === 'first_list' && Object.values(chosen).filter(header => header === chosen.image_url).length === 1
        ? chosen.image_url
        : undefined,
    encode = value => (/[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value);
  table.rows.forEach((row, index) => {
    for (const key of [...required, ...(columns.currency ? ['currency'] : [])])
      if (!row[chosen[key]]?.trim())
        throw Error(uiText('CSV row {row} has no value for {field}.', {row: index + 1, field: catalogFieldLabel(key)}));
  });
  const lines = [
    headers.map(encode).join(','),
    ...table.rows.map(row =>
      headers
        .map(header => {
          const value = row[header] ?? '';
          return encode(header === image && value ? value.split(',')[0].trim() : value);
        })
        .join(','),
    ),
  ];
  return {columns: chosen, text: lines.join('\n')};
}
function catalogMappingMarkup() {
  return `<fieldset id="catalog-csv-mapping"><legend>${esc(uiText('CSV column mapping'))}</legend><label>${esc(uiText('CSV layout'))}<select name="column_mode"><option value="canonical">${esc(uiText('AMCP product columns'))}</option><option value="mapped">${esc(uiText('Map supplier or WooCommerce export columns'))}</option></select></label><div id="catalog-mapping-controls" hidden><button type="button" class="button" id="catalog-load-columns">${esc(uiText('Load columns from the selected file'))}</button><p class="form-note">${esc(uiText('Choose the exact price column and stable retailer ID. Sale dates, tax, stock and product variants are not inferred. Every source row is included.'))}</p><p class="form-note">${esc(uiText('A sale price and its start and end are optional columns; select them only when your source supplies them.'))}</p><div id="catalog-mapping"></div><label>${esc(uiText('Fixed currency when no currency column is selected'))}<input type="text" name="fixed_currency" maxlength="3" placeholder="SAR"></label><label>${esc(uiText('Image column handling'))}<select name="image_mode"><option value="single">${esc(uiText('One literal image URL per row'))}</option><option value="first_list">${esc(uiText('Use the first URL in a comma-separated image list'))}</option></select></label><p class="form-note">${esc(uiText('Only the selected columns are sent. AMCP maps them with this catalog’s saved, versioned column mapping, and blank optional values stay out of the products.'))}</p></div></fieldset>`;
}
function catalogComparisonState(state) {
  switch (state) {
    case 'new':
      return uiText('New product');
    case 'changed':
      return uiText('Changes found');
    case 'matching':
      return uiText('Submitted fields match');
    case 'unknown':
      return uiText('Some fields are unknown');
    default:
      return uiText('Unknown');
  }
}
function catalogImportPreviewMarkup(out, request) {
  const x = request.gateway === 'x_ads_native_action',
    // COM-02 D: a Snapchat preview keeps the exact decimal "amount CUR" of each product, like X.
    snapchat = request.gateway === 'snapchat_native_action',
    exact = x || snapchat,
    grouped = !exact && request.products.some(product => product.retailer_product_group_id !== undefined),
    // COM-02 A: the supplied sale, its native form and its literal period, only when a product has one.
    sale = request.products.some(product => product.sale_price !== undefined),
    saleCell = (product, index) => {
      if (product.sale_price === undefined) return `<td>${esc(uiText('Not supplied'))}</td>`;
      const item = out.items?.[index],
        native = exact
          ? (item?.native_sale_price ?? uiText('Unknown'))
          : Number.isSafeInteger(item?.sale_price_minor_units)
            ? item.sale_price_minor_units
            : uiText('Unknown'),
        period = ['sale_price_start_date', 'sale_price_end_date']
          .filter(k => product[k] !== undefined)
          .map(k => `<br>${esc(catalogFieldLabel(k))}: <bdi dir="ltr">${esc(product[k])}</bdi>`)
          .join('');
      return `<td><bdi>${esc(catalogSaleText(product))}</bdi><br><bdi>${esc(native)}</bdi>${period}</td>`;
    };
  const titles = [
      uiText('Product'),
      uiText('Source price'),
      uiText(x ? 'Native X price' : snapchat ? 'Native Snapchat price' : 'Native hundredths'),
      ...(sale ? [uiText('Sale price')] : []),
      ...(grouped ? [uiText('Meta product group ID')] : []),
      uiText('Existing retailer IDs'),
    ],
    policy = uiText(
      snapchat
        ? 'Compared read-only; fix differences in the product feed'
        : request.allow_upsert
          ? 'Explicitly update existing IDs after native review'
          : 'Create only — refuse existing IDs',
    );
  return `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Products and exact native price units'))}"><table class="review-table"><caption>${esc(uiText('Products and exact native price units'))}</caption><thead><tr>${titles.map(title => `<th scope="col">${esc(title)}</th>`).join('')}</tr></thead><tbody>${request.products.map((product, index) => `<tr><th scope="row"><strong>${esc(product.name)}</strong><br><code>${esc(product.retailer_id)}</code></th><td><bdi>${esc(product.price + ' ' + product.currency)}</bdi></td><td><bdi>${esc(exact ? (out.items?.[index]?.native_price ?? uiText('Unknown')) : Number.isSafeInteger(out.items?.[index]?.price_minor_units) ? out.items[index].price_minor_units : uiText('Unknown'))}</bdi></td>${sale ? saleCell(product, index) : ''}${grouped ? `<td><code dir="ltr">${esc(product.retailer_product_group_id ?? uiText('Not supplied'))}</code></td>` : ''}<td>${esc(policy)}</td></tr>`).join('')}</tbody></table></div>`;
}
/**
 * A plan group of 51–500 source products (COM-03): AMCP's part-by-part validation of the CSV the website sent, checked
 * against that source (its row count, column mode and mapping version) before it can be saved. Nothing is saved yet;
 * the products of each part are listed by the plan it becomes.
 */
function catalogPlanGroupMarkup(out, expected) {
  const plans = Array.isArray(out?.plans) ? out.plans : [],
    text = value => typeof value === 'string' && value.length > 0 && value.length <= 100;
  if (
    out?.record_kind !== 'catalog_plan_group_preview' ||
    out.item_count !== expected.rows ||
    out.parts !== Math.ceil(expected.rows / 50) ||
    plans.length !== out.parts ||
    plans.some(
      (plan, i) =>
        plan?.part !== i + 1 ||
        !Number.isSafeInteger(plan.item_count) ||
        plan.item_count < 1 ||
        plan.item_count > 50 ||
        !text(plan.first_retailer_id) ||
        !text(plan.last_retailer_id),
    ) ||
    plans.reduce((sum, plan) => sum + plan.item_count, 0) !== out.item_count ||
    out.source?.source_kind !== 'csv' ||
    out.source.columns !== expected.columns ||
    (expected.version !== undefined && out.source.mapping_profile?.version !== expected.version) ||
    typeof out.lineage_group_id !== 'string' ||
    out.provider_mutations !== 0 ||
    out.destructive_deletions !== 0
  )
    throw Error(uiText('The plan group could not be confirmed. Validate the source again.'));
  const counts = {count: uiNumber(out.item_count), parts: uiNumber(out.parts)};
  return `<h3 id="catalog-plan-group-heading" tabindex="-1">${esc(uiText('{count} products in {parts} plans of at most 50', counts))}</h3><p>${esc(uiAccountExplanation(out.meaning))}</p><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Plan group parts'))}"><table class="review-table"><caption>${esc(uiText('Plan group parts'))}</caption><thead><tr><th scope="col">${esc(uiText('Part'))}</th><th scope="col">${esc(uiText('Products'))}</th><th scope="col">${esc(uiText('First retailer ID'))}</th><th scope="col">${esc(uiText('Last retailer ID'))}</th></tr></thead><tbody>${plans.map(plan => `<tr><th scope="row">${esc(uiNumber(plan.part))}</th><td>${esc(uiNumber(plan.item_count))}</td><td><code dir="ltr">${esc(plan.first_retailer_id)}</code></td><td><code dir="ltr">${esc(plan.last_retailer_id)}</code></td></tr>`).join('')}</tbody></table></div>${Array.isArray(out.destination_limitations) && out.destination_limitations.length ? `<ul>${out.destination_limitations.map(value => `<li>${esc(uiAccountExplanation(value))}</li>`).join('')}</ul>` : ''}<p class="form-note" id="create-catalog-plan-group-note">${esc(uiText('A plan group is saved from its whole source. Compare at most 50 products at a time; each part is its own unapproved plan that you approve and run separately.'))}</p>${recordDetails({lineage_group_id: out.lineage_group_id, group_source_hash: out.group_source_hash, source: out.source, plans}, uiText('Plan group source and hashes'))}<button type="button" class="button primary" id="create-catalog-plan-group" aria-describedby="create-catalog-plan-group-note">${esc(uiText('Save {count} products as {parts} plans', counts))}</button>`;
}
/** The saved plan group: one link per part's unapproved plan, which must be exactly the previewed parts. */
function catalogPlanGroupSavedMarkup(saved, preview) {
  const plans = Array.isArray(saved?.plans) ? saved.plans : [];
  if (
    saved?.record_kind !== 'catalog_plan_group' ||
    saved.lineage_group_id !== preview.lineage_group_id ||
    saved.parts !== preview.parts ||
    saved.item_count !== preview.item_count ||
    plans.length !== preview.parts ||
    plans.some(
      (plan, i) =>
        plan?.part !== i + 1 ||
        typeof plan.id !== 'string' ||
        !plan.id ||
        plan.item_count !== preview.plans[i].item_count,
    )
  )
    throw Error(uiText('The saved plan group could not be confirmed. Open Campaigns to review the saved plans.'));
  return `<h3 id="catalog-plan-group-saved-heading" tabindex="-1">${esc(uiText('{parts} unapproved plans saved', {parts: uiNumber(saved.parts)}))}</h3><p>${esc(uiAccountExplanation(saved.meaning))}</p><ol>${plans.map(plan => `<li><a href="/campaigns?id=${encodeURIComponent(plan.id)}">${esc(uiText('Part {part} of {parts}: {count} products', {part: uiNumber(plan.part), parts: uiNumber(saved.parts), count: uiNumber(plan.item_count)}))}</a></li>`).join('')}</ol>`;
}
// The Meta product attributes a comparison may name as held but not sent (src/meta-catalog-products.ts, COM-01).
const metaCatalogUnsentFieldNames = [
  'retailer_id',
  'name',
  'description',
  'short_description',
  'brand',
  'category',
  'fb_product_category',
  'product_type',
  'color',
  'size',
  'material',
  'pattern',
  'gtin',
  'manufacturer_part_number',
  'retailer_product_group_id',
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
  'custom_label_4',
  'availability',
  'condition',
  'age_group',
  'gender',
  'visibility',
  'url',
  'image_url',
  'mobile_link',
  'sale_price_start_date',
  'sale_price_end_date',
  'additional_image_urls',
  'inventory',
  'currency',
  'sale_price',
];
// The X optional attributes a comparison may name as held but not sent (src/x-catalogs.ts, COM-01).
const xCatalogUnsentFieldNames = [
  'gtin',
  'mpn',
  'mobile_link',
  'additional_image_link',
  'google_product_category',
  'product_type',
  'inventory',
  'sale_price',
  'sale_price_effective_date',
  'gender',
  'color',
  'size',
  'age_group',
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
  'custom_label_4',
];
// The Snapchat optional attributes a comparison may name as held but not sent (src/snapchat-catalog-comparison.ts).
const snapCatalogUnsentFieldNames = [
  'sale_price',
  'item_group_id',
  'google_product_category',
  'product_type',
  'additional_image_link',
  'mobile_link',
  'color',
  'size',
  'gender',
  'age_group',
  'material',
  'pattern',
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
  'custom_label_4',
];
// Serving notes of the shared comparison item v2 (src/catalog-destinations.ts, COM-03).
const catalogServingNoteCodes = ['availability_limits_serving', 'staging_visibility'];
/**
 * The commerce destinations this page compares (COM-03): one description each, read by the single comparison validator
 * and table below. Meta proves price equality with its own native filter, so its prices are checked for consistency;
 * X and Snapchat return exact decimal prices, which are compared again here. Snapchat changes products only through
 * product feeds (feedOnly): its comparison names what to fix there and nothing is saved.
 */
function catalogWebDestination(gateway) {
  const fields = ['name', 'image_url', 'url', 'availability', 'condition', 'brand', 'description'];
  if (gateway === 'x_ads_native_action')
    return {
      gateway,
      fields,
      exactPrice: true,
      upsertRequired: true,
      unsent: xCatalogUnsentFieldNames,
      blocked: ['hidden_variant', 'grouped_product', 'group_status_unknown', 'retire_absent'],
      productId: /^[1-9][0-9]{0,24}$/,
      destinationOnly: 'note',
      removal: true,
      retire: true,
      feedOnly: false,
    };
  if (gateway === 'meta_native_action')
    return {
      gateway,
      fields: null,
      exactPrice: false,
      upsertRequired: false,
      unsent: metaCatalogUnsentFieldNames,
      blocked: ['existing_product_create_only', 'retire_absent'],
      productId: /^[1-9][0-9]{0,31}$/,
      // Owner decision P9: a populated attribute the source does not send makes an otherwise matching product unknown,
      // so it enters the review set (src/catalog-destinations.ts); before P9 it was only a note.
      destinationOnly: 'review',
      removal: false,
      retire: true,
      feedOnly: false,
    };
  if (gateway === 'snapchat_native_action')
    return {
      gateway,
      fields,
      exactPrice: true,
      upsertRequired: false,
      unsent: snapCatalogUnsentFieldNames,
      blocked: [],
      productId: /^[^\u0000-\u001f\u007f]{1,100}$/,
      destinationOnly: 'note',
      removal: false,
      retire: false,
      feedOnly: true,
    };
  throw Error(uiText('Catalog comparison scope or evidence changed. Validate and read the import again.'));
}
/** A supplied sale price as the destination receives it (COM-02 A): the decimal amount and the product currency. */
function catalogSaleText(product) {
  return String(product.sale_price).split(' ')[0] + ' ' + product.currency;
}
/** An exact X price in one canonical text: no leading zeros in the whole part, no trailing zeros in the fraction. */
function catalogExactMoney(value) {
  const m = typeof value === 'string' ? /^(\d{1,12})(?:\.(\d{1,6}))? ([A-Z]{3})$/.exec(value) : null;
  return m ? m[1].replace(/^0+(?=\d)/, '') + '.' + (m[2] ?? '').replace(/0+$/, '') + ' ' + m[3] : null;
}
const catalogIdentityBlocks = ['hidden_variant', 'grouped_product', 'group_status_unknown'];
/**
 * Checks a comparison against the request and preview it answers, for every destination (COM-03): its scope and
 * source, each item's identity, state, blocker, changes and unknown fields recomputed from its own evidence, and the
 * summary and review set. Any difference refuses the whole comparison.
 */
function validCatalogComparison(out, request, preview) {
  const d = catalogWebDestination(request.gateway),
    invalid = () => {
      throw Error(uiText('Catalog comparison scope or evidence changed. Validate and read the import again.'));
    };
  if (
    !out ||
    out.record_kind !== 'catalog_comparison' ||
    out.complete !== true ||
    out.source_hash !== preview.source_hash ||
    !out.scope ||
    ['gateway', 'account_id', 'connection_id', 'catalog_id'].some(k => out.scope[k] !== request[k]) ||
    (d.upsertRequired && request.allow_upsert !== true) ||
    // A feed-only destination says so, and names the feed as the remedy (COM-02 D).
    (d.feedOnly && (out.writes !== 'feed_only' || out.remedy !== 'fix_in_feed')) ||
    (!d.feedOnly && (out.writes !== undefined || out.remedy !== undefined)) ||
    !Number.isSafeInteger(out.captured_at) ||
    out.captured_at <= 0 ||
    !Array.isArray(out.items) ||
    out.items.length !== request.products.length ||
    out.item_count !== out.items.length ||
    !Array.isArray(out.review_retailer_ids)
  )
    invalid();
  // COM-02 E: the grouped records that keep a supplied SKU's absence unestablished (X only), named for the person. A
  // possible hidden variant always comes with them, and a fully read set of groups leaves none.
  const groups = out.variant_groups;
  if (
    (groups !== undefined &&
      (d.gateway !== 'x_ads_native_action' ||
        !groups ||
        typeof groups !== 'object' ||
        !['not_qualified', 'complete', 'incomplete'].includes(groups.expansion) ||
        !Number.isSafeInteger(groups.grouped_record_count) ||
        !Array.isArray(groups.grouped_records) ||
        groups.grouped_records.length > 10 ||
        groups.grouped_record_count < Math.max(1, groups.grouped_records.length) ||
        groups.grouped_records.some(
          r => !r || typeof r.retailer_id !== 'string' || !/^[1-9][0-9]{0,24}$/.test(r.product_id ?? ''),
        ) ||
        groups.remedy !== (groups.expansion === 'complete' ? null : 'scheduled_feed'))) ||
    (out.items.some(item => item?.blocked_reason === 'hidden_variant') &&
      groups !== undefined &&
      groups.remedy !== 'scheduled_feed')
  )
    invalid();
  const counts = {new: 0, changed: 0, matching: 0, unknown: 0, blocked: 0, needs_review: 0},
    review = [],
    // COM-02 B: a retirement sends the supplied row with the retirement availability.
    retiring = new Set(request.requirements?.retire_retailer_ids ?? []);
  let withUnsent = 0;
  out.items.forEach((item, index) => {
    const retire = retiring.has(request.products[index].retailer_id),
      s = retire
        ? {...request.products[index], availability: request.requirements.retire_availability}
        : request.products[index],
      // COM-01: attributes the destination holds that the source does not send. An older Meta server sends none.
      unsent = d.gateway === 'meta_native_action' ? (item?.unsent_fields ?? []) : item?.unsent_fields;
    if (
      !item ||
      item.retailer_id !== s.retailer_id ||
      !['new', 'changed', 'matching', 'unknown'].includes(item.state) ||
      typeof item.blocked !== 'boolean' ||
      ![true, false, null].includes(item.price_matches) ||
      !Array.isArray(item.changes) ||
      !Array.isArray(item.unknown_fields) ||
      !Array.isArray(unsent) ||
      unsent.some(k => !d.unsent.includes(k) || Object.hasOwn(s, k)) ||
      new Set(unsent).size !== unsent.length ||
      (item.serving_notes !== undefined &&
        (!Array.isArray(item.serving_notes) || item.serving_notes.some(k => !catalogServingNoteCodes.includes(k)))) ||
      // The shared blocker (item v2): named exactly when the product is blocked. An older Meta server names none.
      (item.blocked_reason !== undefined &&
        (item.blocked_reason === null ? item.blocked : !item.blocked || !d.blocked.includes(item.blocked_reason))) ||
      (item.blocked_reason === undefined && d.gateway !== 'meta_native_action') ||
      !item.before ||
      typeof item.before !== 'object' ||
      (d.exactPrice
        ? item.before.price !== null && !catalogExactMoney(item.before.price)
        : item.before.price !== undefined && item.before.price !== null && typeof item.before.price !== 'string')
    )
      invalid();
    const present = item.before.present;
    if (present === true) {
      if (
        typeof item.product_id !== 'string' ||
        !d.productId.test(item.product_id) ||
        item.before.id !== item.product_id ||
        (d.exactPrice && item.before.retailer_id !== s.retailer_id) ||
        (d.fields && d.fields.some(k => item.before[k] !== null && typeof item.before[k] !== 'string'))
      )
        invalid();
    } else if (
      item.product_id !== null ||
      ![false, null].includes(present) ||
      (present === null && item.blocked_reason !== 'hidden_variant') ||
      (d.exactPrice && item.before.price !== null)
    )
      invalid();
    if (item.blocked && catalogIdentityBlocks.includes(item.blocked_reason)) {
      // The product's identity is unknown (a grouped or possibly hidden variant): nothing else is compared.
      if (
        item.state !== 'unknown' ||
        item.price_matches !== null ||
        item.changes.length ||
        item.unknown_fields.length !== 1 ||
        item.unknown_fields[0] !== 'retailer_id' ||
        (present === null ? item.blocked_reason !== 'hidden_variant' : item.blocked_reason === 'hidden_variant')
      )
        invalid();
    } else {
      // Meta blocks an existing product under a create-only import, and a retirement blocks a missing product (it
      // would be created); X otherwise blocks only unknown identities.
      const createOnly = d.gateway === 'meta_native_action' && present === true && !request.allow_upsert,
        absent = retire && present !== true;
      if (
        item.blocked !== (createOnly || absent) ||
        (item.blocked_reason !== undefined &&
          item.blocked_reason !== (absent ? 'retire_absent' : createOnly ? 'existing_product_create_only' : null))
      )
        invalid();
      if (present !== true) {
        if (
          item.state !== 'new' ||
          item.price_matches !== null ||
          item.changes.length ||
          item.unknown_fields.length ||
          unsent.length
        )
          invalid();
      } else {
        let changes, unknown;
        if (d.exactPrice) {
          // X and Snapchat return every compared value and an exact price: changes and unknown fields are recomputed
          // here over the fields the source supplied (X requires them all; Snapchat's are partly optional).
          const supplied = d.fields.filter(k => s[k] !== undefined);
          unknown = supplied.filter(k => item.before[k] === null);
          changes = supplied.filter(k => item.before[k] !== null && item.before[k] !== s[k]);
          const price =
            item.before.price === null
              ? null
              : catalogExactMoney(item.before.price) === catalogExactMoney(s.price + ' ' + s.currency);
          if (price === null) unknown.push('price', 'currency');
          else if (!price) changes.push('price');
          // A supplied sale (COM-02 A): the amount compares exactly, the effective period literally; a product without
          // a current sale shows it as a change.
          let sale;
          const native = {
            sale_price: s.sale_price === undefined ? undefined : catalogSaleText(s),
            sale_price_effective_date:
              s.sale_price_start_date === undefined ? undefined : s.sale_price_start_date + '/' + s.sale_price_end_date,
          };
          if (native.sale_price !== undefined) {
            if (item.before.sale_price !== null && !catalogExactMoney(item.before.sale_price)) {
              sale = null;
              unknown.push('sale_price');
            } else {
              sale =
                item.before.sale_price !== null &&
                catalogExactMoney(item.before.sale_price) === catalogExactMoney(native.sale_price);
              if (!sale) changes.push('sale_price');
            }
          }
          if (
            native.sale_price_effective_date !== undefined &&
            item.before.sale_price_effective_date !== native.sale_price_effective_date
          )
            changes.push('sale_price_effective_date');
          if (
            item.price_matches !== price ||
            item.sale_price_matches !== sale ||
            item.unknown_fields.length !== unknown.length ||
            item.unknown_fields.some((k, i) => k !== unknown[i]) ||
            item.changes.length !== changes.length ||
            item.changes.some(
              (c, i) =>
                !c ||
                c.field !== changes[i] ||
                c.before !== item.before[c.field] ||
                (c.field === 'price'
                  ? c.after_native_price !== s.price + ' ' + s.currency
                  : c.field === 'sale_price'
                    ? c.after_native_price !== native.sale_price
                    : c.field === 'sale_price_effective_date'
                      ? c.after !== native.sale_price_effective_date
                      : c.after !== s[c.field]),
            )
          )
            invalid();
        } else {
          // Meta proves price equality with its own filter: every change and unknown field names a supplied field, and a
          // price change carries the preview's exact hundredths.
          changes = item.changes.map(c => c?.field);
          unknown = item.unknown_fields;
          if (
            typeof item.price_matches !== 'boolean' ||
            unknown.some(k => typeof k !== 'string' || !Object.hasOwn(s, k)) ||
            new Set(unknown).size !== unknown.length ||
            item.changes.some(
              c =>
                !c ||
                typeof c.field !== 'string' ||
                !Object.hasOwn(s, c.field) ||
                (c.before !== null && typeof c.before !== 'string') ||
                (['price', 'sale_price'].includes(c.field)
                  ? !Number.isSafeInteger(c.after_minor_units) ||
                    c.after_minor_units !==
                      preview.items[index]?.[c.field === 'price' ? 'price_minor_units' : 'sale_price_minor_units'] ||
                    c.currency !== s.currency
                  : c.after !== s[c.field]),
            ) ||
            new Set(changes).size !== changes.length ||
            changes.includes('price') === item.price_matches ||
            // A supplied sale price is compared with Meta's own sale_price_amount filter (COM-02 A).
            (s.sale_price === undefined
              ? item.sale_price_matches !== undefined || changes.includes('sale_price')
              : typeof item.sale_price_matches !== 'boolean' ||
                changes.includes('sale_price') === item.sale_price_matches)
          )
            invalid();
        }
        if (
          item.state !==
          (changes.length
            ? 'changed'
            : unknown.length || (d.destinationOnly === 'review' && unsent.length)
              ? 'unknown'
              : 'matching')
        )
          invalid();
      }
    }
    // A feed-only destination names the feed as the fix for every product that differs (COM-02 D).
    if (d.feedOnly ? item.fix_in !== (item.state === 'matching' ? null : 'feed') : item.fix_in !== undefined) invalid();
    counts[item.state]++;
    if (unsent.length) withUnsent++;
    if (item.blocked) counts.blocked++;
    else if (item.state !== 'matching') review.push(item.retailer_id);
  });
  counts.needs_review = review.length;
  if (
    !out.summary ||
    Object.keys(counts).some(k => out.summary[k] !== counts[k]) ||
    (out.summary.with_destination_only_values !== undefined &&
      out.summary.with_destination_only_values !== withUnsent) ||
    review.length !== out.review_retailer_ids.length ||
    review.some((id, i) => out.review_retailer_ids[i] !== id)
  )
    invalid();
  return {destination: d, counts, review};
}
function catalogServingNote(code) {
  return code === 'staging_visibility'
    ? uiText('The current product is in staging, so ads do not show it; the source does not change its visibility.')
    : uiText('Ads may not show this product with this availability.');
}
function catalogComparisonMarkup(out, request, preview) {
  const {destination: d, counts, review} = validCatalogComparison(out, request, preview),
    x = d.gateway === 'x_ads_native_action',
    // COM-02 D: Snapchat shows exact native values like X, but changes products only through feeds.
    exact = d.exactPrice,
    inventoryHtml = x ? catalogListedInventoryMarkup(out, request) : '',
    // COM-02 E: why a supplied product may be a hidden variant, naming the grouped records that can hide it.
    groups = out.variant_groups,
    variantHtml =
      x && groups?.remedy === 'scheduled_feed' && out.items.some(item => item.blocked_reason === 'hidden_variant')
        ? `<p class="notice">${esc(
            uiText(
              'X lists only the first product of each group, so grouped records can hide the supplied products marked as possible hidden variants ({count} in this catalog: {records}). Add or change product variants through the catalog’s scheduled feed.',
              {
                count: groups.grouped_record_count,
                records:
                  groups.grouped_records.map(r => r.retailer_id).join(', ') +
                  (groups.grouped_record_count > groups.grouped_records.length ? ', …' : ''),
              },
            ),
          )}</p>`
        : '',
    // COM-02 B: an existing product can be retired (kept, with an availability that keeps it out of ads) instead of
    // deleted; offered after an upsert comparison that is not already a retirement.
    retirable = d.retire && request.allow_upsert === true && request.requirements?.retire_retailer_ids === undefined,
    eligible = item => !item.blocked && item.before.present === true;
  const reason = key =>
    key === 'grouped_product'
      ? uiText('Grouped product; native variant updates are outside this import')
      : key === 'hidden_variant'
        ? uiText('Product may be a hidden variant; absence is not established')
        : key === 'group_status_unknown'
          ? uiText('Product-group status is unknown; a native update is withheld')
          : key === 'retire_absent'
            ? uiText('Not in the catalog; retiring would create it')
            : uiText('Existing product; updates are disabled');
  const rows = out.items
    .map((item, index) => {
      const s = request.products[index],
        unsent = item.unsent_fields ?? [],
        details =
          item.changes
            .map(c =>
              exact
                ? `<li>${esc(catalogFieldLabel(c.field))}: <bdi>${esc(c.before ?? uiText('Not set'))}</bdi> → <bdi>${esc(c.after_native_price ?? c.after)}</bdi></li>`
                : `<li>${esc(catalogFieldLabel(c.field))}: ${esc(c.before ?? uiText('Unknown'))} → ${esc(c.field === 'price' ? s.price + ' ' + s.currency : c.field === 'sale_price' ? catalogSaleText(s) : c.after)}</li>`,
            )
            .join('') +
          item.unknown_fields
            .map(k => `<li>${esc(catalogFieldLabel(k))}: ${esc(uiText('Current value is unknown'))}</li>`)
            .join(''),
        current = exact
          ? `<bdi>${esc(item.before.price ?? uiText('Unknown'))}</bdi>`
          : esc(item.before.price ?? uiText('Unknown')),
        notes =
          (unsent.length
            ? `<p class="form-note">${esc(d.feedOnly ? uiText('Other native attributes have values: {fields}. Your feed keeps or changes them; this comparison does not.', {fields: unsent.join(', ')}) : x ? uiText('Other native attributes have values: {fields}. X does not establish whether an update preserves omitted attributes.', {fields: unsent.join(', ')}) : uiText('Other native attributes have values: {fields}. Meta does not establish whether an update preserves omitted attributes.', {fields: unsent.join(', ')}))}</p>`
            : '') +
          (item.serving_notes ?? []).map(code => `<p class="form-note">${esc(catalogServingNote(code))}</p>`).join('') +
          (item.fix_in === 'feed'
            ? `<p class="form-note">${esc(uiText('Fix this product in the product feed.'))}</p>`
            : ''),
        removal = x
          ? `<td>${!item.blocked && item.before.present === true ? `<label><input type="checkbox" id="catalog-remove-${index}"> ${esc(uiText('Select {retailer_id} for removal', {retailer_id: item.retailer_id}))}</label>` : esc(uiText('Unavailable'))}</td>`
          : '',
        retire = retirable
          ? `<td>${eligible(item) ? `<label><input type="checkbox" id="catalog-retire-${index}"> ${esc(uiText('Retire {retailer_id}', {retailer_id: item.retailer_id}))}</label>` : esc(uiText('Unavailable'))}</td>`
          : '';
      // Owner decision P9: a product unknown only because the catalog holds values the source does not send says why.
      const destinationOnlyReview =
        d.destinationOnly === 'review' && item.state === 'unknown' && unsent.length > 0 && !details;
      return `<tr><th scope="row"><strong>${esc(s.name)}</strong><br><code>${esc(item.retailer_id)}</code>${item.product_id ? `<br>${esc(uiText('Product ID'))}: <code class="catalog-product-id" dir="ltr">${esc(item.product_id)}</code>` : ''}</th><td>${esc(catalogComparisonState(item.state))}${item.blocked ? `<p class="form-note">${esc(reason(item.blocked_reason))}</p>` : ''}</td><td>${esc(uiText('Current'))}: ${current}<br>${esc(uiText('Proposed'))}: <bdi>${esc(s.price + ' ' + s.currency)}</bdi></td><td>${details ? `<ul>${details}</ul>` : esc(item.state === 'new' ? uiText('No current product was returned') : destinationOnlyReview ? uiText('Every supplied field matches; it needs review because the catalog holds values this import does not send.') : uiText('All supplied fields have matching evidence'))}${notes}</td>${removal}${retire}</tr>`;
    })
    .join('');
  const headers = [
    uiText('Product'),
    uiText('Comparison'),
    uiText('Price'),
    uiText('Field differences'),
    ...(x ? [uiText('Select for removal')] : []),
    ...(retirable ? [uiText('Retire')] : []),
  ];
  const removable = x && out.items.some(eligible),
    retirement =
      retirable && out.items.some(eligible)
        ? `<p>${esc(uiText('Retiring keeps a product and its history but sets its availability so ads stop showing it; nothing is deleted. Each product still gets its own native review.'))}</p><label for="catalog-retire-availability">${esc(uiText('Retire as'))}<select id="catalog-retire-availability"><option value="discontinued">discontinued</option><option value="out of stock">out of stock</option></select></label><button type="button" class="button" id="save-catalog-retirement">${esc(uiText('Save retirement draft for selected products'))}</button>`
        : '';
  // A feed-only destination saves nothing: it names how many products to fix in the feed (COM-02 D).
  const next = d.feedOnly
    ? `<p class="notice">${esc(review.length ? uiText('Snapchat changes products only through product feeds. Fix the {count} products that differ in your feed; AMCP saves no draft for Snapchat.', {count: review.length}) : uiText('Every supplied product matches its Snapchat product. Nothing needs a fix in the feed.'))}</p>`
    : `<p>${esc(uiText('{count} products need a fresh native review before execution. Saving a plan does not submit product changes.', {count: review.length}))}</p>${review.length ? `<button type="button" class="button primary" id="save-catalog-changes">${esc(uiText('Save only products needing review'))}</button>` : `<p>${esc(uiText('No eligible product changes need a draft.'))}</p>`}`;
  return `<h3 id="catalog-comparison-heading" tabindex="-1">${esc(uiText('Compare current catalog products'))}</h3><p>${esc(uiText('Read {date} · {new} new · {changed} changed · {matching} matching · {unknown} unknown · {blocked} blocked', {date: date(out.captured_at), ...counts}))}</p><p class="notice">${esc(x ? uiText('Only supplied X product IDs are returned. Supported decimal prices compare exactly. Grouped or hidden variants are blocked; missing fields remain unknown. Repeated reads are sequential evidence, not a point-in-time inventory snapshot. A saved draft still needs fresh native review. Missing source products are not deleted.') : d.feedOnly ? uiText('Only supplied Snapchat product IDs are read, twice. Supported decimal prices compare exactly; missing fields remain unknown. Feed processing can take time, so this is current evidence, not a point-in-time inventory snapshot. Missing source products are not read or deleted.') : uiText('Only supplied retailer IDs are compared. Formatted native prices are display text; equality uses the native price filter. Unknown fields need review. This is current sequential evidence, not a point-in-time inventory snapshot. Missing source products are not deleted.'))}</p>${variantHtml}${inventoryHtml}<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Catalog comparison, scroll for all fields'))}"><table class="review-table"><caption>${esc(x ? uiText('Supplied X product comparison') : d.feedOnly ? uiText('Supplied Snapchat product comparison') : uiText('Compare current catalog products'))}</caption><thead><tr>${headers.map(k => `<th scope="col">${esc(k)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>${next}${removable ? `<p>${esc(uiText('Select only the observed products you intend to remove. Products outside this selection are retained.'))}</p><button type="button" class="button" id="preview-catalog-removal">${esc(uiText('Preview selected removals'))}</button><div id="catalog-removal-preview" aria-live="polite"></div>` : ''}${retirement}`;
}
function catalogListedInventoryMarkup(out, request) {
  const invalid = () => {
    throw Error(uiText('Listed catalog evidence changed. Read the original source selection again.'));
  };
  if (request.inspect_other_listed_products !== true) {
    if (out.listed_inventory !== undefined) invalid();
    return '';
  }
  const inventory = out.listed_inventory,
    object = v => v && typeof v === 'object' && !Array.isArray(v),
    count = v => Number.isSafeInteger(v) && v >= 0 && v <= 1000,
    text = (v, max) =>
      typeof v === 'string' &&
      v === v.trim() &&
      v.length > 0 &&
      Array.from(v).length <= max &&
      !/[\u0000-\u001f\u007f]/.test(v),
    hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v),
    source = new Set(request.products.map(p => p.retailer_id)),
    ids = new Set(),
    keys = new Set(),
    counts = {individual: 0, grouped: 0, unknown: 0},
    fields = [
      'retailer_id',
      'product_id',
      'name',
      'price',
      'currency',
      'group_status',
      'item_group_id',
      'item_group_key',
    ];
  if (
    request.gateway !== 'x_ads_native_action' ||
    request.absent_source_policy !== 'retain' ||
    !object(inventory) ||
    inventory.record_kind !== 'x_catalog_selection_inventory' ||
    inventory.coverage !== 'bounded_listed_products' ||
    inventory.listed_scan_complete !== true ||
    inventory.variant_inventory_complete !== false ||
    inventory.source_coverage !== 'supplied_products_only' ||
    inventory.source_absence_established !== false ||
    inventory.absent_source_policy !== 'retain' ||
    inventory.provider_mutations !== 0 ||
    inventory.destructive_deletions !== 0 ||
    !object(inventory.scope) ||
    Object.keys(inventory.scope).length !== 4 ||
    ['gateway', 'account_id', 'connection_id', 'catalog_id'].some(k => inventory.scope[k] !== request[k]) ||
    inventory.source_hash !== out.source_hash ||
    !hash(inventory.material_hash) ||
    !hash(inventory.observations_hash) ||
    inventory.requested_at !== out.requested_at ||
    inventory.captured_at !== out.captured_at ||
    !Number.isSafeInteger(inventory.requested_at) ||
    inventory.requested_at <= 0 ||
    inventory.requested_at > inventory.captured_at ||
    inventory.source_selection_count !== request.products.length ||
    !['listed_product_count', 'supplied_listed_count', 'outside_selection_count'].every(k => count(inventory[k])) ||
    !Array.isArray(inventory.items) ||
    inventory.items.length !== inventory.outside_selection_count ||
    inventory.supplied_listed_count !== out.items.filter(p => p.before.present === true).length ||
    inventory.listed_product_count !== inventory.supplied_listed_count + inventory.items.length ||
    !object(inventory.outside_selection_group_counts) ||
    Object.keys(inventory.outside_selection_group_counts).length !== 3
  )
    invalid();
  for (const item of inventory.items) {
    if (
      !object(item) ||
      Object.keys(item).length !== fields.length ||
      fields.some(k => !Object.hasOwn(item, k)) ||
      !text(item.retailer_id, 100) ||
      source.has(item.retailer_id) ||
      ids.has(item.retailer_id) ||
      typeof item.product_id !== 'string' ||
      !/^[1-9][0-9]{0,24}$/.test(item.product_id) ||
      keys.has(item.product_id) ||
      (item.name !== null && !text(item.name, 150)) ||
      !['individual', 'grouped', 'unknown'].includes(item.group_status) ||
      ['item_group_id', 'item_group_key'].some(k => item[k] !== null && !text(item[k], 100)) ||
      (item.group_status === 'individual' && (item.item_group_id !== null || item.item_group_key !== null)) ||
      (item.group_status === 'grouped' && item.item_group_id === null && item.item_group_key === null)
    )
      invalid();
    if (item.price === null) {
      if (item.currency !== null) invalid();
    } else {
      const price = typeof item.price === 'string' && /^(\d{1,12}(?:\.\d{1,6})?) ([A-Z]{3})$/.exec(item.price);
      if (!price || item.currency !== price[2]) invalid();
    }
    ids.add(item.retailer_id);
    keys.add(item.product_id);
    counts[item.group_status]++;
  }
  if (Object.keys(counts).some(k => inventory.outside_selection_group_counts[k] !== counts[k])) invalid();
  const evidence = Object.fromEntries(
    [
      'record_kind',
      'coverage',
      'listed_scan_complete',
      'variant_inventory_complete',
      'source_coverage',
      'source_absence_established',
      'absent_source_policy',
      'source_selection_count',
      'listed_product_count',
      'supplied_listed_count',
      'outside_selection_count',
      'outside_selection_group_counts',
      'material_hash',
      'items',
      'provider_mutations',
      'destructive_deletions',
      'scope',
      'source_hash',
      'requested_at',
      'captured_at',
      'observations_hash',
    ].map(k => [k, inventory[k]]),
  );
  return `<section aria-labelledby="catalog-inventory-heading"><h4 id="catalog-inventory-heading" tabindex="-1">${esc(uiText('Other listed X products'))}</h4><p>${esc(uiText('{listed} listed products · {selected} supplied products observed · {other} outside this source selection', {listed: inventory.listed_product_count, selected: inventory.supplied_listed_count, other: inventory.outside_selection_count}))}</p><p class="notice">${esc(uiText('Products outside this supplied selection are retained. Their store absence is unverified. X listing can hide other variants, so this is not a complete variant inventory or a point-in-time snapshot.'))}</p><div id="catalog-inventory-view" aria-live="polite">${catalogListedInventoryView(inventory)}</div><p>${esc(uiText('Select only listed products you intend to remove; none is selected for you. A product is never removed because your source lacks it.'))}</p><button type="button" class="button" id="preview-listed-removal">${esc(uiText('Preview removal of selected listed products'))}</button><div id="catalog-listed-removal-preview" aria-live="polite"></div>${recordDetails(evidence, uiText('Listed inventory evidence'))}</section>`;
}

function catalogListedInventoryView(inventory, query = '', page = 0, selected = null) {
  const groupLabel = status =>
      status === 'individual'
        ? uiText('Individual product')
        : status === 'grouped'
          ? uiText('Grouped product')
          : uiText('Product-group status is unknown'),
    term = query.trim().toLowerCase(),
    filtered = inventory.items.filter(p =>
      [
        p.retailer_id,
        p.product_id,
        p.name,
        p.price,
        p.currency,
        p.group_status,
        p.item_group_id,
        p.item_group_key,
        groupLabel(p.group_status),
      ]
        .filter(v => v !== null)
        .join(' ')
        .toLowerCase()
        .includes(term),
    ),
    size = 50,
    pages = Math.max(1, Math.ceil(filtered.length / size)),
    current = Math.max(0, Math.min(page, pages - 1)),
    from = current * size,
    rows = filtered
      .slice(from, from + size)
      .map(p => {
        const group = groupLabel(p.group_status),
          details = ['item_group_id', 'item_group_key']
            .filter(k => p[k] !== null)
            .map(
              k =>
                `<br>${esc(k === 'item_group_id' ? uiText('Native group ID') : uiText('Native group key'))}: <bdi>${esc(p[k])}</bdi>`,
            )
            .join(''),
          // COM-02 B: only an individual listed product can be selected, and none is selected for you.
          select = !selected
            ? ''
            : `<td>${p.group_status === 'individual' ? `<label><input type="checkbox" id="catalog-listed-remove-${esc(p.product_id)}"${selected.has(p.product_id) ? ' checked' : ''}> ${esc(uiText('Select {retailer_id} for removal', {retailer_id: p.retailer_id}))}</label>` : esc(uiText('Unavailable'))}</td>`;
        return `<tr><th scope="row"><strong><bdi>${esc(p.name ?? uiText('Unknown'))}</bdi></strong><br>${esc(uiText('Retailer ID'))}: <code dir="ltr">${esc(p.retailer_id)}</code><br>${esc(uiText('Product ID'))}: <code dir="ltr">${esc(p.product_id)}</code></th><td><bdi dir="ltr">${esc(p.price ?? uiText('Unknown'))}</bdi></td><td>${esc(group)}${details}</td>${select}</tr>`;
      })
      .join(''),
    headers = [
      uiText('Product'),
      uiText('Price'),
      uiText('Product grouping'),
      ...(selected ? [uiText('Select for removal')] : []),
    ];
  return `<div class="split"><label for="catalog-inventory-search">${esc(uiText('Find a listed product, native key, group or price'))}<input type="search" id="catalog-inventory-search" value="${esc(query)}"></label><div><button type="button" class="button" id="catalog-inventory-find">${esc(uiText('Search listed products'))}</button><button type="button" class="button" id="catalog-inventory-clear">${esc(uiText('Clear search'))}</button></div></div><p role="status">${esc(uiText('Showing {from}–{through} of {count} other listed products', {from: filtered.length ? from + 1 : 0, through: Math.min(from + size, filtered.length), count: filtered.length}))}</p>${filtered.length ? `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Other listed products, scroll for all fields'))}"><table class="review-table"><caption>${esc(uiText('Other listed X products'))}</caption><thead><tr>${headers.map(k => `<th scope="col">${esc(k)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : `<p>${esc(uiText('No other listed products match this view. This does not establish whole-store absence.'))}</p>`}<div class="pagination"><button type="button" class="button" id="catalog-inventory-previous" ${current === 0 ? 'disabled' : ''}>${esc(uiText('Previous'))}</button><span>${esc(uiText('Page {page} of {pages}', {page: current + 1, pages}))}</span><button type="button" class="button" id="catalog-inventory-next" ${current >= pages - 1 ? 'disabled' : ''}>${esc(uiText('Next'))}</button></div>`;
}

/**
 * The listed products of an inspection, searchable and paged, with an explicit removal selection by native key
 * (COM-02 B): nothing is preselected, a selection survives searching and paging, and changing it clears its preview.
 */
function bindCatalogListedInventory(inventory, active, request) {
  let query = '',
    page = 0,
    removalSequence = 0;
  const selected = new Set(),
    order = inventory.items.map(p => p.product_id),
    invalidate = () => {
      removalSequence++;
      const output = $('#catalog-listed-removal-preview');
      if (output) output.innerHTML = '';
    };
  const render = focus => {
    if (!active()) return;
    $('#catalog-inventory-view').innerHTML = catalogListedInventoryView(
      inventory,
      query,
      page,
      request ? selected : null,
    );
    const find = () => {
      if (!active()) return;
      query = $('#catalog-inventory-search').value;
      page = 0;
      render('#catalog-inventory-search');
    };
    workspaceBind('#catalog-inventory-find', find);
    workspaceBind('#catalog-inventory-clear', () => {
      if (!active()) return;
      query = '';
      page = 0;
      render('#catalog-inventory-search');
    });
    workspaceBind('#catalog-inventory-previous', () => {
      if (!active()) return;
      page = Math.max(0, page - 1);
      render('#catalog-inventory-heading');
    });
    workspaceBind('#catalog-inventory-next', () => {
      if (!active()) return;
      page++;
      render('#catalog-inventory-heading');
    });
    $('#catalog-inventory-search').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        find();
      }
    });
    if (request)
      for (const p of inventory.items)
        if (p.group_status === 'individual') {
          const box = $('#catalog-listed-remove-' + p.product_id);
          box?.addEventListener('change', () => {
            if (!active()) return;
            if (box.checked) selected.add(p.product_id);
            else selected.delete(p.product_id);
            invalidate();
          });
        }
    if (focus) $(focus).focus();
  };
  render();
  if (!request) return;
  workspaceBind('#preview-listed-removal', async () => {
    if (!active()) return;
    const product_keys = order.filter(key => selected.has(key));
    if (!product_keys.length) throw Error(uiText('Select at least one listed individual product to preview removal.'));
    const sequence = ++removalSequence,
      output = $('#catalog-listed-removal-preview'),
      removalActive = () =>
        active() &&
        sequence === removalSequence &&
        JSON.stringify(order.filter(key => selected.has(key))) === JSON.stringify(product_keys);
    output.innerHTML = `<p role="status">${esc(uiText('Reading selected products for a removal preview. No products are deleted.'))}</p>`;
    try {
      const proposed = await workspaceCall('workspace', {
        action: 'preview_catalog_removal',
        gateway: request.gateway,
        account_id: request.account_id,
        connection_id: request.connection_id,
        catalog_id: request.catalog_id,
        requirements: {
          selection_source: 'listed_inventory',
          product_keys,
          listed_inventory_hash: inventory.material_hash,
        },
      });
      if (!removalActive()) return;
      output.innerHTML = catalogListedRemovalMarkup(proposed, request, inventory, product_keys);
      $('#catalog-listed-removal-heading').focus();
      workspaceBind('#save-listed-removal', async () => {
        if (!removalActive()) return;
        const typed = $('#catalog-listed-removal-count').value.trim();
        if (!/^[1-9][0-9]?$/.test(typed) || Number(typed) !== proposed.targets.length)
          throw Error(uiText('Type the number of selected products to confirm their removal.'));
        try {
          const saved = await workspaceCall('workspace', {
            action: 'create_catalog_removal',
            preview_id: proposed.preview_id,
            preview_hash: proposed.preview_hash,
            confirmed: true,
            confirmed_count: Number(typed),
          });
          if (removalActive()) await navigate('/campaigns?id=' + encodeURIComponent(saved.id));
        } catch (error) {
          if (removalActive()) throw error;
        }
      });
    } catch (error) {
      if (removalActive()) {
        output.innerHTML = '';
        throw error;
      }
    }
  });
}

/** The removal preview of selected listed products, checked against the inspection the person selected from. */
function catalogListedRemovalMarkup(out, request, inventory, keys) {
  const listed = new Map(inventory.items.map(p => [p.product_id, p]));
  if (
    !out ||
    out.record_kind !== 'x_catalog_removal_preview' ||
    out.selection_source !== 'listed_inventory' ||
    out.confirmation !== 'confirmed_count' ||
    request.gateway !== 'x_ads_native_action' ||
    !out.scope ||
    ['gateway', 'account_id', 'connection_id', 'catalog_id'].some(k => out.scope[k] !== request[k]) ||
    out.listed_inventory_hash !== inventory.material_hash ||
    out.source_hash !== null ||
    !/^[a-f0-9]{64}$/.test(out.preview_hash ?? '') ||
    typeof out.preview_id !== 'string' ||
    !out.preview_id ||
    !Number.isSafeInteger(out.expires_at) ||
    out.expires_at <= Date.now() ||
    out.provider_mutations !== 0 ||
    out.destructive_deletions !== 0 ||
    !Array.isArray(out.targets) ||
    !keys.length ||
    out.targets.length !== keys.length ||
    out.item_count !== keys.length ||
    out.targets.some((target, i) => {
      const p = listed.get(keys[i]);
      return (
        !p ||
        p.group_status !== 'individual' ||
        !target?.before ||
        target.product_id !== keys[i] ||
        target.retailer_id !== p.retailer_id ||
        target.before.present !== true ||
        target.before.id !== keys[i] ||
        (target.before.name ?? null) !== p.name ||
        (target.before.price ?? null) !== p.price
      );
    })
  )
    throw Error(uiText('The selected removal preview changed. Inspect the listed products again.'));
  const rows = out.targets
    .map(
      target =>
        `<tr><th scope="row">${esc(target.before.name ?? target.retailer_id)}<br><code>${esc(target.retailer_id)}</code></th><td><code dir="ltr">${esc(target.product_id)}</code></td><td><bdi>${esc(target.before.price ?? uiText('Unknown'))}</bdi></td></tr>`,
    )
    .join('');
  return `<h4 id="catalog-listed-removal-heading" tabindex="-1">${esc(uiText('Selected listed product removals'))}</h4><p class="notice">${esc(uiText('These listed products are proposed for permanent deletion because you selected them, not because your source lacks them. Saving creates an unapproved draft and deletes no products. Each product requires native review, execution confirmation and read-back. A scheduled feed may restore products it still contains.'))}</p><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Selected listed product removals'))}"><table class="review-table"><caption>${esc(uiText('{count} explicitly selected products', {count: out.item_count}))}</caption><thead><tr>${[uiText('Product'), uiText('Product ID'), uiText('Current price')].map(k => `<th scope="col">${esc(k)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div><label for="catalog-listed-removal-count">${esc(uiText('Type the number of products to remove ({count})', {count: out.item_count}))}<input type="text" inputmode="numeric" id="catalog-listed-removal-count" autocomplete="off" maxlength="2"></label><button type="button" class="button" id="save-listed-removal">${esc(uiText('Save unapproved removal draft'))}</button>`;
}

function catalogRemovalMarkup(out, request, comparison, ids, preview) {
  const selected = comparison.items.filter(item => ids.includes(item.retailer_id));
  if (
    !out ||
    out.record_kind !== 'x_catalog_removal_preview' ||
    request.gateway !== 'x_ads_native_action' ||
    !out.scope ||
    ['gateway', 'account_id', 'connection_id', 'catalog_id'].some(k => out.scope[k] !== request[k]) ||
    out.source_hash !== preview.source_hash ||
    !/^[a-f0-9]{64}$/.test(out.preview_hash ?? '') ||
    typeof out.preview_id !== 'string' ||
    !out.preview_id ||
    !Number.isSafeInteger(out.expires_at) ||
    out.expires_at <= Date.now() ||
    out.provider_mutations !== 0 ||
    out.destructive_deletions !== 0 ||
    !Array.isArray(out.targets) ||
    selected.length !== ids.length ||
    !selected.length ||
    out.targets.length !== selected.length ||
    out.item_count !== selected.length ||
    out.targets.some(
      (target, i) =>
        target.retailer_id !== selected[i].retailer_id ||
        target.product_id !== selected[i].product_id ||
        selected[i].blocked ||
        selected[i].before.present !== true ||
        JSON.stringify(target.before) !== JSON.stringify(selected[i].before),
    )
  )
    throw Error(uiText('The selected removal preview changed. Compare the source products again.'));
  const rows = out.targets
    .map(
      target =>
        `<tr><th scope="row">${esc(target.before.name ?? target.retailer_id)}<br><code>${esc(target.retailer_id)}</code></th><td><code dir="ltr">${esc(target.product_id)}</code></td><td><bdi>${esc(target.before.price ?? uiText('Unknown'))}</bdi></td></tr>`,
    )
    .join('');
  return `<h3 id="catalog-removal-heading" tabindex="-1">${esc(uiText('Selected product removals'))}</h3><p class="notice">${esc(uiText('These selected products are proposed for permanent deletion. Saving creates an unapproved draft and deletes no products. Each product requires native review, execution confirmation and read-back. A scheduled feed may restore products it still contains.'))}</p><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Selected product removals'))}"><table class="review-table"><caption>${esc(uiText('{count} explicitly selected products', {count: out.item_count}))}</caption><thead><tr>${[uiText('Product'), uiText('Product ID'), uiText('Current price')].map(k => `<th scope="col">${esc(k)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div><button type="button" class="button" id="save-catalog-removal">${esc(uiText('Save unapproved removal draft'))}</button>`;
}
function wooCommerceVariationControlsMarkup() {
  return `<label>${esc(uiText('WooCommerce source selection'))}<select name="source_kind"><option value="products">${esc(uiText('Standalone products'))}</option><option value="variations">${esc(uiText('Selected variations of one parent'))}</option></select></label><label id="woo-parent-control" hidden>${esc(uiText('Exact published variable parent product ID'))}<input type="text" name="parent_product_id" inputmode="numeric" maxlength="20" pattern="[1-9][0-9]{0,19}" disabled></label><p class="form-note">${esc(uiText('Variation mode reads only the IDs you enter under the selected parent. Review the native parent group and a destination title for each selected child; no variation name is inferred as a native value.'))}</p>`;
}
function wooCommerceVariationRow(item, currency) {
  const review = item.blockers.length
    ? item.blockers.map(message => `<p>${esc(uiAccountExplanation(message))}</p>`).join('')
    : `<label>${esc(uiText('Review destination title'))}<input type="text" id="woo-title-${esc(item.product_id)}" maxlength="500" value="${esc(item.suggested_destination_name ?? '')}"></label><label><input type="checkbox" id="woo-product-${esc(item.product_id)}">${esc(uiText('Select this variation with the reviewed title and shown parent SKU as its Meta group'))}</label>`;
  return `<tr><th scope="row">${esc(item.parent_name ?? uiText('Unknown'))}<br><code dir="ltr">${esc(item.product_id)}</code><p>${esc(uiText('Native parent SKU'))}: <code dir="ltr">${esc(item.parent_sku ?? uiText('Unknown'))}</code></p>${item.attributes.map(attribute => `<p>${esc(attribute.name)}: ${esc(attribute.option)}</p>`).join('')}</th><td><code dir="ltr">${esc(item.sku ?? uiText('Unknown'))}</code></td><td><bdi dir="ltr">${esc(item.selected_price ?? uiText('Unknown'))} ${esc(currency)}</bdi></td><td><code dir="ltr">${esc(item.stock_status ?? uiText('Unknown'))}</code><br><code dir="ltr">${esc(item.tax_status ?? uiText('Unknown'))}</code></td><td>${item.first_image_url ? `<code dir="ltr">${esc(item.first_image_url)}</code>` : esc(uiText('Unknown'))}<p>${esc(uiText('Provider-reported variation image; custom-child image origin is unverified.'))}</p></td><td>${review}</td></tr>`;
}
function commerceAdministrator() {
  return (
    typeof session !== 'undefined' &&
    session.authenticated === true &&
    !session.testAccount &&
    (session.administrator === true || ['owner', 'admin'].includes(session.workspaceRole))
  );
}
/** WooCommerce store sources are parked (ARC-01, P9): offered only where the deployment's AMCP_PROVIDERS names them. */
function commerceStoresOffered() {
  return !(typeof providersNotOffered !== 'undefined' && providersNotOffered.includes('woocommerce'));
}
/**
 * While WooCommerce is parked, an administrator sees only the stored store connections, to remove one: no store is
 * connected or read, and nothing else of the store panels is shown.
 */
function wooCommerceParkedMarkup() {
  const sources = typeof commerceSources === 'undefined' ? [] : commerceSources;
  if (!commerceAdministrator() || !sources.length) return '';
  return `<section class="panel workspace-form" id="woo-connections"><div class="panel-header"><h2>${esc(uiText('WooCommerce store connections'))}</h2><button class="button" type="button" id="woo-stores-refresh">${esc(uiText('Refresh store list'))}</button></div><p class="notice" id="woo-parked">${esc(uiText('This deployment does not offer WooCommerce store sources: their work is parked. No store is connected or read. You can still remove a stored connection.'))}</p>${wooCommerceRemovalMarkup(sources, true)}</section>`;
}
function wooCommerceRemovalMarkup(sources, open) {
  return `<details${open ? ' open' : ''}><summary>${esc(uiText('Remove a local store connection'))}</summary><p id="woo-remove-help">${esc(uiText('Removal deletes this AMCP connection, its encrypted key, discovery metadata and related finished report data. Reviews, receipts and audit history remain. The WooCommerce key, products and provider access are unchanged.'))}</p><form id="woo-remove" aria-describedby="woo-remove-help"><label>${esc(uiText('Configured WooCommerce store'))}<select name="target" required><option value="">${esc(uiText('Choose a store'))}</option>${sources.map((item, i) => `<option value="${i}">${esc(item.label)} · ${esc(item.store_origin)}</option>`).join('')}</select></label><label class="form-note"><input type="checkbox" name="confirmed" required>${esc(uiText('I confirm removal of the selected local AMCP connection and its related stored report data.'))}</label><button class="button danger" type="submit">${esc(uiText('Remove local connection'))}</button></form><div id="woo-remove-result" aria-live="polite"></div></details>`;
}
function wooCommerceConnectionsMarkup() {
  if (!commerceAdministrator()) return '';
  const sources = typeof commerceSources === 'undefined' ? [] : commerceSources;
  return `<section class="panel workspace-form" id="woo-connections"><div class="panel-header"><h2>${esc(uiText('WooCommerce store connections'))}</h2><button class="button" type="button" id="woo-stores-refresh">${esc(uiText('Refresh store list'))}</button></div><p>${esc(uiText('Connect an existing Read REST API key to inspect products. This grants AMCP read access only.'))}</p><details ${sources.length ? '' : 'open'}><summary>${esc(uiText('Connect a WooCommerce source'))}</summary><p id="woo-connect-help">${esc(uiText('Use WooCommerce → Settings → Advanced → REST API to inspect an existing key and its user. Choose a key with Read permission. AMCP verifies product and currency reads, stores the key encrypted and never changes the store.'))} <a href="https://woocommerce.com/document/woocommerce-rest-api/" target="_blank" rel="noreferrer">${esc(uiText('Official WooCommerce key guide ↗'))}</a></p><p class="form-note">${esc(uiText('Use the exact HTTPS origin on port 443 without a path. Setup is limited to 3 requests, 256 KiB and 20 seconds. Read success cannot independently establish the key’s native write permission.'))}</p><form id="woo-connect" aria-describedby="woo-connect-help"><label>${esc(uiText('Store label'))}<input name="label" type="text" required maxlength="200" autocomplete="off"></label><label>${esc(uiText('HTTPS store origin'))}<input name="store_origin" type="url" required maxlength="2048" dir="ltr" autocomplete="off" spellcheck="false" placeholder="https://shop.example.com"></label><label>${esc(uiText('Consumer Key'))}<input name="consumer_key" type="password" required minlength="4" maxlength="203" autocomplete="off" spellcheck="false" dir="ltr" pattern="ck_[A-Za-z0-9]+"></label><label>${esc(uiText('Consumer Secret'))}<input name="consumer_secret" type="password" required minlength="4" maxlength="203" autocomplete="off" spellcheck="false" dir="ltr" pattern="cs_[A-Za-z0-9]+"></label><label class="form-note"><input type="checkbox" name="confirmed" required>${esc(uiText('I confirm this existing key has Read permission and authorize encrypted storage and read verification in this workspace.'))}</label><p class="form-note">${esc(uiText('Credential fields are cleared when submitted and are never included in the result. If a reply is interrupted, refresh the store list before adding another connection.'))}</p><button class="button primary" type="submit">${esc(uiText('Verify reads and connect'))}</button></form><div id="woo-connect-result" aria-live="polite"></div></details>${sources.length ? wooCommerceRemovalMarkup(sources, false) : ''}</section>`;
}
function wooConnectionResult(out, request) {
  const origin = new URL(request.store_origin).origin;
  if (
    out?.record_kind !== 'woocommerce_connection' ||
    out.connection_id !== request.connection_id ||
    out.store_origin !== origin ||
    out.label !== request.label ||
    !/^wc_[a-f0-9]{64}$/.test(out.account_id ?? '') ||
    out.account_id_kind !== 'amcp_origin_binding' ||
    out.key_permission !== 'read' ||
    out.key_permission_evidence !== 'operator_recorded' ||
    out.read_access_verified !== true ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(out.verified_at ?? '') ||
    !Number.isFinite(Date.parse(out.verified_at)) ||
    !/^[A-Z]{3}$/.test(out.native_currency ?? '') ||
    !Number.isSafeInteger(out.reported_published_products) ||
    out.reported_published_products < 0 ||
    out.full_inventory !== false ||
    out.writes_enabled !== false ||
    out.credentials_disclosed !== false ||
    out.provider_mutations !== 0 ||
    typeof out.replayed !== 'boolean' ||
    out.network_requests !== (out.replayed ? 0 : 3) ||
    !Number.isSafeInteger(out.collected_bytes) ||
    out.collected_bytes < (out.replayed ? 0 : 1) ||
    out.collected_bytes > 256 * 1024
  )
    throw Error(
      uiText('The WooCommerce setup result does not match this request. Refresh the store list before trying again.'),
    );
  return `<h3 tabindex="-1" id="woo-connect-heading">${esc(uiText(out.replayed ? 'Existing store connection recovered' : 'Store read access verified'))}</h3><p><strong>${esc(out.label)}</strong> · <bdi dir="ltr">${esc(out.store_origin)}</bdi></p><p>${esc(uiText('Verified {date} · Reported published products: {count}', {date: date(out.verified_at), count: uiNumber(out.reported_published_products)}))} · <bdi dir="ltr">${esc(out.native_currency)}</bdi></p><p>${esc(uiText('AMCP store binding'))}: <code dir="ltr">${esc(out.account_id)}</code></p><p class="form-note">${esc(uiText('This binding identifies the origin inside AMCP; it is not a native WooCommerce store ID.'))}</p><p class="notice">${esc(uiText('Product and currency access were verified during setup. Read permission is your recorded selection; full inventory, future access and destination eligibility still need inspection. Store writes remain disabled.'))}</p>${out.replayed ? `<p>${esc(uiText('This is the original setup result. No new store reads were made by this retry.'))}</p>` : ''}<button class="button" type="button" id="woo-connect-refresh">${esc(uiText('Refresh store list'))}</button>`;
}
function bindWooCommerceConnections(parked = false) {
  if (!commerceAdministrator()) return;
  const identity = session,
    identityValue = identityKey(session),
    navigation = navigationGeneration,
    identityVersion = identityGeneration,
    sources = [...commerceSources],
    authorized = () => commerceAdministrator() && session === identity && identityKey(session) === identityValue;
  const bindRefresh = (selector, current) =>
    workspaceBind(selector, async () => {
      if (!current() || !authorized()) return;
      if (
        !(await confirmAction({
          title: uiText('Refresh the Commerce page?'),
          consequence: uiText('The store list will refresh. Unsaved Commerce entries on this page will be cleared.'),
          confirmLabel: uiText('Refresh store list'),
        })) ||
        !current() ||
        !authorized()
      )
        return;
      const data = await api('/api/platforms');
      if (!current() || !authorized()) return;
      if (
        !Array.isArray(data.commerce_sources) ||
        data.commerce_sources.some(
          item =>
            !item ||
            typeof item !== 'object' ||
            !/^[A-Za-z0-9_-]{1,160}$/.test(item.connection_id ?? '') ||
            !/^[A-Za-z0-9_-]{1,160}$/.test(item.account_id ?? '') ||
            typeof item.label !== 'string' ||
            item.label.length > 200 ||
            typeof item.store_origin !== 'string' ||
            item.store_origin.length > 2048,
        )
      )
        throw Error(uiText('The store list could not be refreshed. Reload Commerce before starting another setup.'));
      commerceSources = data.commerce_sources.map(item => ({
        connection_id: item.connection_id,
        account_id: item.account_id,
        label: item.label,
        store_origin: item.store_origin,
      }));
      await navigate('/commerce');
    });
  bindRefresh(
    '#woo-stores-refresh',
    () =>
      authorized() &&
      navigation === navigationGeneration &&
      identityVersion === identityGeneration &&
      $('#woo-connections').isConnected,
  );
  // A parked WooCommerce (ARC-01, P9) shows no connect form: only stored connections can be removed.
  if (!parked) bindWooCommerceConnect(authorized, bindRefresh);
  if (!sources.length) return;
  const remove = $('#woo-remove'),
    removeResult = $('#woo-remove-result'),
    removeBegin = accountWorkflowContext(remove, removeResult);
  let removing = false,
    removed = false;
  workspaceBind(
    '#woo-remove',
    async () => {
      if (removing || removed || !authorized()) return;
      const attempt = removeBegin(),
        current = () => attempt() && authorized(),
        value = remove.elements.target.value,
        source = /^\d+$/.test(value) ? sources[Number(value)] : undefined;
      if (!current() || !source || remove.elements.confirmed.checked !== true)
        throw Error(uiText('Choose a store and explicitly confirm removal of its local AMCP connection.'));
      if (
        !(await confirmAction({
          title: uiText('Remove this local WooCommerce connection?'),
          consequence: uiText(
            'This deletes the selected AMCP connection, encrypted key and related stored report data. The WooCommerce store and native key remain unchanged.',
          ),
          confirmLabel: uiText('Remove local connection'),
        })) ||
        !current()
      )
        return;
      removing = true;
      try {
        const out = await api('/api/commerce/stores/' + encodeURIComponent(source.connection_id), {
          method: 'DELETE',
          body: JSON.stringify({confirmed: true}),
        });
        if (!current()) return;
        if (
          out.success !== true ||
          out.disconnected !== true ||
          out.connection_id !== source.connection_id ||
          out.gateway !== 'commerce_native_action' ||
          out.network_requests !== 0 ||
          out.provider_changes !== 0
        )
          throw Error(uiText('The WooCommerce removal result does not match this connection. Refresh the store list.'));
        removed = true;
        removeResult.innerHTML = `<h3 tabindex="-1" id="woo-remove-heading">${esc(uiText('Local store connection removed'))}</h3><p>${esc(uiText('The WooCommerce store and native key are unchanged. Refresh the store list before another source read.'))}</p><button class="button" type="button" id="woo-remove-refresh">${esc(uiText('Refresh store list'))}</button>`;
        $('#woo-remove-heading').focus({preventScroll: true});
        bindRefresh('#woo-remove-refresh', current);
      } catch (error) {
        if (current()) throw error;
      } finally {
        removing = false;
      }
    },
    {disabled: () => removed},
  );
}
function bindWooCommerceConnect(authorized, bindRefresh) {
  const form = $('#woo-connect'),
    result = $('#woo-connect-result'),
    begin = accountWorkflowContext(form, result),
    requestId = crypto.randomUUID();
  let submitting = false,
    completed = false;
  workspaceBind(
    '#woo-connect',
    async () => {
      if (submitting || completed || !authorized()) return;
      const attempt = begin(),
        current = () => attempt() && authorized(),
        request = {
          connection_id: requestId,
          store_origin: form.elements.store_origin.value,
          label: form.elements.label.value,
          consumer_key: form.elements.consumer_key.value,
          consumer_secret: form.elements.consumer_secret.value,
          key_permission: 'read',
          confirmed: form.elements.confirmed.checked === true,
        };
      if (!current()) return;
      submitting = true;
      form.elements.consumer_key.value = '';
      form.elements.consumer_secret.value = '';
      const fields = ['label', 'store_origin', 'consumer_key', 'consumer_secret', 'confirmed'];
      for (const field of fields) form.elements[field].disabled = true;
      try {
        const out = await api('/api/commerce/stores', {method: 'POST', body: JSON.stringify(request)});
        if (!current()) return;
        result.innerHTML = wooConnectionResult(out, request);
        completed = true;
        $('#woo-connect-heading').focus({preventScroll: true});
        bindRefresh('#woo-connect-refresh', current);
      } catch (error) {
        if (current()) throw error;
      } finally {
        // Retain no secret in a retry cache. The stable request ID lets an explicitly re-entered identical key recover the original result.
        request.consumer_key = request.consumer_secret = '';
        submitting = false;
        if (current()) for (const field of fields) form.elements[field].disabled = false;
      }
    },
    {disabled: () => completed},
  );
}
function wooCommerceSourcePanelMarkup() {
  const sources = typeof commerceSources === 'undefined' ? [] : commerceSources;
  return `<section class="panel workspace-form"><h2>${esc(uiText('WooCommerce product source'))}</h2><p>${esc(uiText('Read 1–50 explicitly selected published products from a configured store. Choose the intended price field. The first native image is shown; tax, sale activation and variants are not inferred.'))}</p>${sources.length ? '' : `<p class="notice">${esc(uiText('No qualified WooCommerce source is configured. Ask a workspace administrator to connect an existing Read key in the store connections section of Commerce.'))}</p>`}<form id="woo-source">${wooCommerceVariationControlsMarkup()}<label>${esc(uiText('Configured WooCommerce store'))}<select name="target" required><option value="">${esc(uiText('Choose a store'))}</option>${sources.map((item, i) => `<option value="${i}">${esc(item.label)} · ${esc(item.store_origin)}</option>`).join('')}</select></label><label>${esc(uiText('Exact WooCommerce product or variation IDs'))}<textarea name="product_ids" required maxlength="1050" placeholder="101, 102"></textarea></label><label>${esc(uiText('Native source price field'))}<select name="price_field" required><option value="">${esc(uiText('Choose a price field'))}</option><option value="price">${esc(uiText('Current native price'))}</option><option value="regular_price">${esc(uiText('Regular native price'))}</option><option value="sale_price">${esc(uiText('Native sale price field'))}</option></select></label><button class="button" type="submit">${esc(uiText('Read selected source products'))}</button></form><div id="woo-source-result" aria-live="polite"></div></section>`;
}
function wooCommerceSourceSelection(out, request) {
  const scope = out?.scope,
    variations = request.requirements.source_kind === 'variations',
    requestedIds = variations ? request.requirements.variation_ids : request.requirements.product_ids;
  if (
    out?.record_kind !== 'catalog_source' ||
    out.complete_selected_evidence !== true ||
    out.full_inventory !== false ||
    out.source_saved !== false ||
    out.provider_mutations !== 0 ||
    out.destructive_deletions !== 0 ||
    scope?.gateway !== request.gateway ||
    scope.account_id !== request.account_id ||
    scope.connection_id !== request.connection_id ||
    scope.price_field !== request.requirements.price_field ||
    scope.source_kind !== (variations ? 'variations' : undefined) ||
    (variations &&
      (scope.parent_product_id !== request.requirements.parent_product_id ||
        out.parent?.product_id !== scope.parent_product_id ||
        out.parent.product_type !== 'variable' ||
        out.parent.status !== 'publish')) ||
    !/^[A-Z]{3}$/.test(out.native_currency ?? '') ||
    !/^[a-f0-9]{64}$/.test(out.source_hash ?? '') ||
    !Array.isArray(out.items) ||
    out.items.length !== requestedIds.length ||
    out.selected_product_count !== out.items.length ||
    out.native_requests !== (variations ? 6 : 4) ||
    out.collected_rows !== out.items.length * 2 + (variations ? 2 : 0) ||
    !Array.isArray(out.product_ids) ||
    out.product_ids.length !== out.items.length ||
    new Set(out.product_ids).size !== out.items.length ||
    out.items.some(
      item =>
        !requestedIds.includes(item.product_id) ||
        !out.product_ids.includes(item.product_id) ||
        item.status !== 'publish' ||
        !Array.isArray(item.blockers) ||
        (variations &&
          (item.name !== null ||
            item.requires_title_review !== true ||
            item.parent_product_id !== scope.parent_product_id ||
            item.parent_name !== out.parent.name ||
            item.parent_sku !== out.parent.sku ||
            !Array.isArray(item.attributes) ||
            item.attributes.length > 25)),
    ) ||
    new Set(out.items.map(item => item.product_id)).size !== out.items.length
  )
    throw Error(uiText('The WooCommerce source selection or scope changed. Read its products again.'));
  return out.items;
}
function wooCommerceSourceMarkup(out, request) {
  const items = wooCommerceSourceSelection(out, request);
  const rows = items
    .map(item =>
      request.requirements.source_kind === 'variations'
        ? wooCommerceVariationRow(item, out.native_currency)
        : `<tr><th scope="row">${esc(item.name ?? uiText('Unknown'))}<br><code dir="ltr">${esc(item.product_id)}</code></th><td><code dir="ltr">${esc(item.sku ?? uiText('Unknown'))}</code></td><td><bdi dir="ltr">${esc(item.selected_price ?? uiText('Unknown'))} ${esc(out.native_currency)}</bdi></td><td><code dir="ltr">${esc(item.stock_status ?? uiText('Unknown'))}</code><br><code dir="ltr">${esc(item.tax_status ?? uiText('Unknown'))}</code></td><td>${item.first_image_url ? `<code dir="ltr">${esc(item.first_image_url)}</code>` : esc(uiText('Unknown'))}</td><td>${item.blockers.length ? item.blockers.map(message => `<p>${esc(uiAccountExplanation(message))}</p>`).join('') : `<label><input type="checkbox" id="woo-product-${esc(item.product_id)}">${esc(uiText('Select for Meta preview'))}</label>`}</td></tr>`,
    )
    .join('');
  return `<h3 id="woo-source-heading" tabindex="-1">${esc(uiText('Selected store products'))}</h3><p>${esc(uiText('Read {date} · {count} selected products · {currency}', {date: date(out.captured_at), count: out.selected_product_count, currency: out.native_currency}))}</p><p class="notice">${esc(uiAccountExplanation(out.meaning))}</p><p>${esc(uiText(request.requirements.source_kind === 'variations' ? 'Price field: {field}. Native child SKU, price, currency, image and parent SKU are preserved. Each destination title is an operator-reviewed suggestion, not a native child name. Backorders and unknown stock stay omitted.' : 'Price field: {field}. Mapping uses the shown SKU, name, exact price, currency and first image. Instock and outofstock map to their literal availability; backorders and unknown stock stay omitted.', {field: scopePriceLabel(request.requirements.price_field)}))}</p><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('WooCommerce source products, scroll for all fields'))}"><table class="review-table"><caption>${esc(uiText('Explicit WooCommerce product selection'))}</caption><thead><tr>${[uiText('Product'), uiText('Retailer ID'), uiText('Price'), uiText('Native stock and tax settings'), uiText('First native image URL'), uiText('Selection or blockers')].map(label => `<th scope="col">${esc(label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div><button type="button" class="button" id="use-woo-products">${esc(uiText('Use selected products for Meta preview'))}</button>`;
}
function scopePriceLabel(field) {
  return field === 'price'
    ? uiText('Current native price')
    : field === 'regular_price'
      ? uiText('Regular native price')
      : uiText('Native sale price field');
}
function bindWooCommerceSource(useProducts, clearProducts) {
  const sources = typeof commerceSources === 'undefined' ? [] : commerceSources,
    form = $('#woo-source'),
    result = $('#woo-source-result'),
    begin = accountWorkflowContext(form, result);
  const invalidate = () => {
    begin();
    clearProducts();
  };
  form.addEventListener('input', invalidate);
  form.addEventListener('change', invalidate);
  const adjustSourceKind = () => {
    const variations = form.elements.source_kind.value === 'variations';
    $('#woo-parent-control').hidden = !variations;
    form.elements.parent_product_id.disabled = !variations;
    form.elements.parent_product_id.required = variations;
  };
  form.elements.source_kind.addEventListener('change', () => {
    adjustSourceKind();
    invalidate();
  });
  adjustSourceKind();
  const handoff = new URLSearchParams(location.search),
    keys = ['woo_source', 'connection_id', 'account_id', 'product_ids', 'price_field'];
  if (handoff.get('woo_source') === '1' && keys.every(key => handoff.getAll(key).length === 1)) {
    const selected = sources.findIndex(
        item => item.connection_id === handoff.get('connection_id') && item.account_id === handoff.get('account_id'),
      ),
      ids = (handoff.get('product_ids') ?? '').split(','),
      field = handoff.get('price_field'),
      variations = handoff.get('source_kind') === 'variations',
      parentId = handoff.get('parent_product_id');
    if (
      selected >= 0 &&
      ids.length >= 1 &&
      ids.length <= 50 &&
      new Set(ids).size === ids.length &&
      ids.every(id => /^[1-9][0-9]{0,19}$/.test(id)) &&
      (!handoff.has('source_kind') ||
        (variations &&
          handoff.getAll('source_kind').length === 1 &&
          handoff.getAll('parent_product_id').length === 1 &&
          /^[1-9][0-9]{0,19}$/.test(parentId ?? ''))) &&
      (variations || !handoff.has('parent_product_id')) &&
      ['price', 'regular_price', 'sale_price'].includes(field)
    ) {
      form.elements.target.value = String(selected);
      form.elements.product_ids.value = ids.join(', ');
      form.elements.price_field.value = field;
      form.elements.source_kind.value = variations ? 'variations' : 'products';
      form.elements.parent_product_id.value = variations ? parentId : '';
      adjustSourceKind();
    }
  }
  workspaceBind('#woo-source', async () => {
    const current = begin();
    clearProducts();
    if (!current()) return;
    const source = form.elements.target.value === '' ? undefined : sources[Number(form.elements.target.value)],
      ids = form.elements.product_ids.value.trim().split(/[,\s]+/),
      price = form.elements.price_field.value,
      variations = form.elements.source_kind.value === 'variations',
      parentId = form.elements.parent_product_id.value.trim();
    if (
      !source ||
      !['products', 'variations'].includes(form.elements.source_kind.value) ||
      (variations && !/^[1-9][0-9]{0,19}$/.test(parentId)) ||
      ids.length < 1 ||
      ids.length > 50 ||
      new Set(ids).size !== ids.length ||
      ids.some(id => !/^[1-9][0-9]{0,19}$/.test(id)) ||
      !['price', 'regular_price', 'sale_price'].includes(price)
    )
      throw Error(uiText('Choose a store, 1–50 distinct published product IDs and an explicit price field.'));
    const request = {
      action: 'catalog_source',
      gateway: 'commerce_native_action',
      connection_id: source.connection_id,
      account_id: source.account_id,
      requirements: variations
        ? {source_kind: 'variations', parent_product_id: parentId, variation_ids: ids, price_field: price}
        : {product_ids: ids, price_field: price},
    };
    try {
      const out = await workspaceCall('workspace', request);
      if (!current()) return;
      result.innerHTML = wooCommerceSourceMarkup(out, request);
      $('#woo-source-heading').focus();
      for (const item of out.items.filter(item => !item.blockers.length)) {
        $('#woo-product-' + item.product_id).addEventListener('change', clearProducts);
        if (variations)
          $('#woo-title-' + item.product_id).addEventListener('input', () => {
            $('#woo-product-' + item.product_id).checked = false;
            clearProducts();
          });
      }
      workspaceBind('#use-woo-products', () => {
        if (!current()) return;
        const items = wooCommerceSourceSelection(out, request).filter(
          item => !item.blockers.length && $('#woo-product-' + item.product_id).checked,
        );
        if (!items.length) throw Error(uiText('Select at least one eligible source product for the Meta preview.'));
        const products = items.map(item => {
          const name = variations ? $('#woo-title-' + item.product_id).value : item.name;
          if (
            variations &&
            (typeof name !== 'string' ||
              !name ||
              name !== name.trim() ||
              name.length > 500 ||
              /[\x00-\x1f\x7f]/.test(name))
          )
            throw Error(
              uiText(
                'Review an exact plain destination title without surrounding whitespace for every selected variation.',
              ),
            );
          return {
            retailer_id: item.sku,
            name,
            ...(variations ? {retailer_product_group_id: item.parent_sku} : {}),
            price: item.selected_price,
            currency: out.native_currency,
            image_url: item.first_image_url,
            ...(item.product_url ? {url: item.product_url} : {}),
            ...(item.stock_status === 'instock'
              ? {availability: 'in stock'}
              : item.stock_status === 'outofstock'
                ? {availability: 'out of stock'}
                : {}),
          };
        });
        useProducts(products, out, current);
      });
    } catch (error) {
      if (current()) {
        result.innerHTML = '';
        throw error;
      }
    }
  });
}
async function renderCommerce() {
  // COM-01: the reviewed import comes first; it is the active journey. Store sources follow, collapsed into one
  // administrator disclosure until a source is configured, so the page no longer opens with forms that cannot run.
  // COM-02 D: Snapchat accounts are offered for a read-only comparison; their products change only through feeds.
  // ARC-01, P9: while WooCommerce is parked the store panels and the WooCommerce product source are not shown.
  const targets = accountChoices(['meta', 'x', 'snapchat']),
    storesOffered = commerceStoresOffered(),
    storeSources = typeof commerceSources === 'undefined' ? [] : commerceSources,
    storePanels = storesOffered
      ? wooCommerceConnectionsMarkup() + wooCommerceSourcePanelMarkup() + wooCommerceInventoryPanelMarkup()
      : '';
  content.innerHTML += `<section class="panel workspace-form"><h2>${esc(uiText('Reviewed catalog product import'))}</h2><p>${esc(uiText('Import up to 500 supplied products for the selected account and catalog; more than 50 are saved as one group of plans of at most 50 products each. Ownership is checked during native review. Every item keeps a separate review, receipt and read-back in its saved plan. Missing items are retained.'))}</p><p class="form-note">${esc(uiText('Product imports support Meta and X. Snapchat catalogs change only through feeds; AMCP compares their products read-only.'))}</p>${targets.length ? '' : `<p class="notice" id="catalog-no-destination">${accountChoicesEmptyNotice(targets, uiText('Connect a Meta or X ad account to import products.'), uiText('Manage connections'))}</p>`}<form id="catalog-import"><label>${esc(uiText('Meta, X or Snapchat ad account'))}<select name="target" required><option value="">${esc(uiText('Choose an account'))}</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>${controls(uiText('Native product catalog ID'), 'text', '', 'catalog_id')}${controls(uiText('Import plan name'), 'text', 'Product catalog import', 'name')}<label>${esc(uiText('Product source'))}<select name="source_mode"><option value="csv">${esc(uiText('Product CSV'))}</option>${storesOffered ? `<option value="woocommerce">${esc(uiText('Selected WooCommerce products'))}</option>` : ''}</select></label><div id="catalog-csv-controls"><label>${esc(uiText('Product CSV'))}<input type="file" name="file" accept=".csv,text/csv" required></label></div><div id="catalog-woo-selection" class="form-note" aria-live="polite"></div><div id="catalog-destination-help" class="form-note" aria-live="polite"></div>${catalogMappingMarkup()}<label>${esc(uiText('Existing retailer IDs'))}<select name="allow_upsert"><option value="false">${esc(uiText('Create only — refuse existing IDs'))}</option><option value="true">${esc(uiText('Explicitly update existing IDs after native review'))}</option></select></label><button class="button primary" type="submit">${esc(uiText('Validate and preview products'))}</button></form><div id="catalog-preview"></div></section><p class="notice">${esc(uiText('Mapped supplier and WooCommerce exports use the selected Meta or X reviewed product contract. Choose the intended price, currency, image and destination fields. Live store synchronization and additional destinations require separate qualification.'))}</p>`;
  if (storesOffered) {
    content.innerHTML += storeSources.length
      ? storePanels
      : `<details class="panel" id="commerce-store-sources"><summary>${esc(uiText('Connect a store source (administrators)'))}</summary>${storePanels}</details>`;
    bindWooCommerceInventory();
    bindWooCommerceConnections();
  } else {
    const parked = wooCommerceParkedMarkup();
    content.innerHTML += parked;
    if (parked) bindWooCommerceConnections(true);
  }
  const form = $('#catalog-import'),
    result = $('#catalog-preview'),
    begin = accountWorkflowContext(form, result);
  let selectedWoo = null;
  const updateSourceMode = () => {
    const woo = form.elements.source_mode.value === 'woocommerce';
    form.elements.file.required = !woo;
    $('#catalog-csv-controls').hidden = woo;
    $('#catalog-csv-mapping').hidden = woo;
    $('#catalog-mapping-controls').hidden = woo || form.elements.column_mode.value !== 'mapped';
  };
  form.elements.source_mode.addEventListener('change', () => {
    begin();
    updateSourceMode();
  });
  updateSourceMode();
  if (storesOffered)
    bindWooCommerceSource(
      (products, source, current) => {
        selectedWoo = {products: structuredClone(products), source, current};
        begin();
        form.elements.source_mode.value = 'woocommerce';
        updateSourceMode();
        $('#catalog-woo-selection').innerHTML =
          `<p>${esc(uiText('{count} original products selected from {store}. Validate the exact destination fields before saving a draft.', {count: products.length, store: source.scope.store_origin}))}</p>`;
        form.elements.target.focus();
      },
      () => {
        selectedWoo = null;
        begin();
        $('#catalog-woo-selection').innerHTML = '';
      },
    );
  const destinationHelp = () => {
    const target = form.elements.target.value === '' ? undefined : targets[Number(form.elements.target.value)];
    const snapchat = target?.gateway === 'snapchat_native_action';
    $('#catalog-destination-help').innerHTML =
      `<p>${esc(uiText(target?.gateway === 'x_ads_native_action' ? 'This X import requires every mapped product field, including product page, availability, condition, brand and plain text description. It accepts names up to 150 characters and source prices with up to six decimal places. Use exact native availability and condition values. Explicit upsert approval is required.' : target?.gateway === 'meta_native_action' ? 'Required columns: retailer_id, name, price, currency, image_url. Optional: url, availability, condition, brand, description, retailer_product_group_id. Select an exact Meta group column only when your source supplies it; no group is inferred. Price is a decimal amount in the product currency; Meta counts hundredths, so digits beyond two decimal places must be zeros (12.500 KWD is 12.50). Use HTTPS links.' : snapchat ? 'Snapchat changes catalog products only through product feeds, so AMCP compares them read-only and saves no draft. Required columns: retailer_id, name, price, currency, image_url. Optional: url, availability, condition, brand, description, sale_price. Prices are exact decimals.' : 'Choose an account to see the required destination fields.'))}</p>${target?.gateway === 'x_ads_native_action' ? `<p>${esc(uiText('X catalog access requires early-access entitlement. Previewing or saving a draft does not establish eligibility or publish a product.'))}</p>` : ''}${target && !snapchat ? `<p>${esc(uiText('Optional sale columns: sale_price (a decimal lower than the price, in the product currency), sale_price_start_date and sale_price_end_date (ISO 8601 with an explicit offset; X needs both or neither). Without them the destination keeps its current sale, which the comparison names.'))}</p>` : ''}`;
  };
  form.elements.target.addEventListener('change', () => {
    resetMapping();
    destinationHelp();
  });
  destinationHelp();
  const handoff = new URLSearchParams(location.search);
  if (handoff.has('catalog_comparison')) {
    // The comparison's gateway selects Meta or X (COM-01); an older link without one is a Meta comparison. A gateway
    // that does not match the account's own platform selects nothing.
    const keys = ['catalog_comparison', 'connection_id', 'account_id', 'catalog_id'],
      gateway = handoff.has('gateway') ? handoff.get('gateway') : 'meta_native_action',
      catalogPattern =
        gateway === 'x_ads_native_action'
          ? /^[1-9][0-9]{0,24}$/
          : gateway === 'meta_native_action'
            ? /^[1-9][0-9]{0,31}$/
            : gateway === 'snapchat_native_action'
              ? /^[A-Za-z0-9-]{1,64}$/
              : null,
      valid =
        keys.every(k => handoff.getAll(k).length === 1) &&
        handoff.getAll('gateway').length <= 1 &&
        handoff.get('catalog_comparison') === '1' &&
        catalogPattern !== null &&
        catalogPattern.test(handoff.get('catalog_id') ?? ''),
      selected = valid
        ? targets.findIndex(
            t =>
              t.gateway === gateway &&
              t.account_id === handoff.get('account_id') &&
              t.connection_id === handoff.get('connection_id'),
          )
        : -1;
    form.elements.target.value = selected < 0 ? '' : String(selected);
    if (selected >= 0) form.elements.catalog_id.value = handoff.get('catalog_id');
    destinationHelp();
    result.innerHTML = `<p class="notice">${esc(uiText(selected >= 0 ? 'The original account and catalog are selected. Choose the original CSV to validate and compare it again.' : 'The original catalog scope is no longer available. Choose a currently accessible account and catalog.'))}</p>`;
  }
  let loaded = null;
  const resetMapping = () => {
    const current = begin();
    if (!current()) return;
    loaded = null;
    $('#catalog-mapping').innerHTML = '';
    updateSourceMode();
  };
  form.elements.column_mode.addEventListener('change', resetMapping);
  form.elements.file.addEventListener('change', resetMapping);
  updateSourceMode();
  workspaceBind('#catalog-load-columns', async () => {
    const current = begin();
    if (!current()) return;
    loaded = null;
    $('#catalog-mapping').innerHTML = '';
    const file = form.elements.file.files[0];
    const target = form.elements.target.value === '' ? undefined : targets[Number(form.elements.target.value)];
    if (!target) throw Error(uiText('Choose the exact account.'));
    const fields = catalogSourceFields(target.gateway);
    if (!file || file.size > catalogCsvMaxBytes) throw Error(uiText('Choose a CSV of at most 192 KiB.'));
    let table;
    try {
      const text = await file.text();
      if (!current()) return;
      table = parseProductCSVTable(text);
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    if (!table.rows.length) throw Error(uiText('The CSV has no product rows.'));
    // COM-03: the catalog's saved mapping fills the columns it names; only the mapping is read, never the file's rows.
    const catalog = form.elements.catalog_id.value.trim();
    let saved = null;
    if (/^[A-Za-z0-9-]{1,64}$/.test(catalog)) {
      try {
        const read = await workspaceCall('workspace', {
          action: 'catalog_mapping',
          gateway: target.gateway,
          account_id: target.account_id,
          connection_id: target.connection_id,
          catalog_id: catalog,
        });
        if (!current()) return;
        saved =
          read?.record_kind === 'catalog_mapping' && read.profile === null
            ? {version: 0}
            : read?.record_kind === 'catalog_mapping' &&
                Number.isSafeInteger(read.profile?.version) &&
                read.profile.columns &&
                typeof read.profile.columns === 'object'
              ? read.profile
              : null;
      } catch (error) {
        if (current()) throw error;
        return;
      }
    }
    loaded = {
      file,
      table,
      target_key: JSON.stringify([target.gateway, target.account_id, target.connection_id]),
      mapping: saved
        ? {catalog_id: catalog, version: saved.version, identity: saved.columns?.retailer_id ?? null}
        : null,
    };
    const profile = saved?.version ? saved : null,
      identity = profile?.columns.retailer_id;
    $('#catalog-mapping').innerHTML =
      `<p>${esc(uiText('{rows} product rows loaded. Review each selected source column.', {rows: table.rows.length}))}</p>${profile ? `<p class="form-note">${esc(uiText('Saved mapping version {version} of this catalog filled the columns it names. Products are identified by the column {column}.', {version: profile.version, column: identity}))}</p>` : ''}<div class="work-filter">${fields.map(field => `<label>${esc(catalogFieldLabel(field))}<select id="catalog-map-${field}"><option value="">${esc(uiText('No column selected'))}</option>${table.headers.map(header => `<option value="${esc(header)}">${esc(header)}</option>`).join('')}</select></label>`).join('')}</div>${profile ? `<label><input type="checkbox" id="catalog-replace-identity"> ${esc(uiText('Identify products by another retailer ID column from now on'))}</label>` : ''}`;
    for (const key of fields)
      $('#catalog-map-' + key).value =
        profile && table.headers.includes(profile.columns[key])
          ? profile.columns[key]
          : !profile && table.headers.includes(key)
            ? key
            : '';
    if (profile) {
      form.elements.fixed_currency.value = profile.fixed_currency;
      form.elements.image_mode.value = profile.image_mode;
    }
  });
  workspaceBind('#catalog-import', async form => {
    const current = begin();
    if (!current()) return;
    const target = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !target) throw Error(uiText('Choose the exact account.'));
    const file = form.elements.file.files[0],
      useWoo = form.elements.source_mode.value === 'woocommerce';
    if (!useWoo && (!file || file.size > catalogCsvMaxBytes)) throw Error(uiText('Choose a CSV of at most 192 KiB.'));
    const {label, ...binding} = target;
    const settings = {
      ...binding,
      catalog_id: form.elements.catalog_id.value.trim(),
      name: form.elements.name.value.trim(),
      allow_upsert: form.elements.allow_upsert.value === 'true',
    };
    // COM-03: a CSV of 51–500 products is validated and saved as one plan group of plans of at most 50 (`group`: the
    // source the preview must confirm). A Snapchat comparison reads at most 50 products, and saves nothing.
    let request, out, source, group;
    const grouped = rows => {
      if (rows <= 50) return false;
      if (binding.gateway === 'snapchat_native_action')
        throw Error(uiText('Compare at most 50 Snapchat products at a time.'));
      return true;
    };
    try {
      let products;
      if (useWoo) {
        if (binding.gateway !== 'meta_native_action')
          throw Error(
            uiText('WooCommerce source selection maps to Meta. X still requires all ten explicit CSV fields.'),
          );
        if (!selectedWoo || !selectedWoo.current())
          throw Error(uiText('Read and select current WooCommerce source products before previewing them.'));
        products = structuredClone(selectedWoo.products);
      } else if (form.elements.column_mode.value === 'mapped') {
        if (
          !loaded ||
          loaded.file !== file ||
          loaded.target_key !== JSON.stringify([binding.gateway, binding.account_id, binding.connection_id])
        )
          throw Error(uiText('Load the selected CSV columns before previewing mapped products.'));
        const selected = selectedCatalogSource(loaded.table, {
          gateway: binding.gateway,
          columns: Object.fromEntries(catalogSourceFields(binding.gateway).map(k => [k, $('#catalog-map-' + k).value])),
          fixed_currency: form.elements.fixed_currency.value.trim(),
          image_mode: form.elements.image_mode.value,
        });
        const many = grouped(loaded.table.rows.length);
        // The catalog's products keep the retailer ID column its saved mapping names unless the person explicitly
        // chooses another one; AMCP refuses an implicit change too.
        if (
          loaded.mapping?.catalog_id === settings.catalog_id &&
          loaded.mapping.identity &&
          selected.columns.retailer_id !== loaded.mapping.identity &&
          !$('#catalog-replace-identity')?.checked
        )
          throw Error(
            uiText(
              'This catalog’s products are identified by the column {column}. Keep it, or choose to identify products by another retailer ID column from now on.',
              {column: loaded.mapping.identity},
            ),
          );
        // COM-03: the mapping is saved as the catalog's versioned profile and AMCP projects the selected columns with
        // it, so the preview, comparison and saved plan all name the same source and mapping version.
        const mapping = await workspaceCall('workspace', {
          action: 'save_catalog_mapping',
          gateway: binding.gateway,
          account_id: binding.account_id,
          connection_id: binding.connection_id,
          catalog_id: settings.catalog_id,
          ...(loaded.mapping?.catalog_id === settings.catalog_id ? {revision: loaded.mapping.version} : {}),
          requirements: {
            columns: selected.columns,
            fixed_currency: form.elements.fixed_currency.value.trim(),
            image_mode: form.elements.image_mode.value,
            ...($('#catalog-replace-identity')?.checked ? {replace_identity_column: true} : {}),
          },
        });
        if (!current()) return;
        if (mapping?.record_kind !== 'catalog_mapping' || !Number.isSafeInteger(mapping.profile?.version))
          throw Error(uiText('The column mapping could not be confirmed. Load the CSV columns again.'));
        loaded.mapping = {
          catalog_id: settings.catalog_id,
          version: mapping.profile.version,
          identity: mapping.profile.columns?.retailer_id ?? null,
        };
        source = {kind: 'csv', text: selected.text, columns: 'profile', profile_version: mapping.profile.version};
        if (many) group = {rows: loaded.table.rows.length, columns: 'profile', version: mapping.profile.version};
        out = await workspaceCall('workspace', {
          action: 'catalog_preview',
          ...settings,
          requirements: {source, ...(group ? {chunked: true} : {})},
        });
        if (!current()) return;
        products = out?.supplied_products;
        if (
          !group &&
          (!Array.isArray(products) ||
            !products.length ||
            products.some(p => !p || typeof p !== 'object' || typeof p.retailer_id !== 'string') ||
            out.source?.columns !== 'profile' ||
            out.source?.mapping_profile?.version !== mapping.profile.version)
        )
          throw Error(uiText('The column mapping could not be confirmed. Load the CSV columns again.'));
      } else {
        const text = await file.text();
        if (!current()) return;
        products = parseProductCSV(text, binding.gateway);
        // More than 50 products: the whole CSV (its columns are AMCP product fields) is the plan group's source.
        if (grouped(products.length)) {
          group = {rows: products.length, columns: 'canonical'};
          source = {kind: 'csv', text, columns: 'canonical'};
          out = await workspaceCall('workspace', {
            action: 'catalog_preview',
            ...settings,
            requirements: {source, chunked: true},
          });
          if (!current()) return;
        }
      }
      if (group) result.innerHTML = catalogPlanGroupMarkup(out, group);
      else {
        request = {...settings, products};
        if (!source) out = await workspaceCall('workspace', {action: 'catalog_preview', ...request});
      }
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    if (group) {
      // Each part becomes its own unapproved plan; the saved group must be the previewed one.
      $('#catalog-plan-group-heading').focus();
      workspaceBind('#create-catalog-plan-group', async () => {
        if (!current()) return;
        try {
          const saved = await workspaceCall('workspace', {
            action: 'catalog_plan',
            ...settings,
            requirements: {source, chunked: true},
          });
          if (!current()) return;
          result.innerHTML = catalogPlanGroupSavedMarkup(saved, out);
          $('#catalog-plan-group-saved-heading').focus();
        } catch (error) {
          if (current()) throw error;
        }
      });
      return;
    }
    // A mapped CSV reaches AMCP as its source; the server projects it again for every comparison and plan (COM-03).
    const sourced = (extra = {}, requirements = {}) =>
      source
        ? {
            ...Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'products')),
            ...extra,
            requirements: {source, ...requirements},
          }
        : {...request, ...extra, ...(Object.keys(requirements).length ? {requirements} : {})};
    // COM-02 D: Snapchat products change only through feeds, so a Snapchat preview leads to a comparison and nothing else.
    const feedOnly = request.gateway === 'snapchat_native_action';
    result.innerHTML =
      `<button type="button" class="button primary" id="compare-catalog-products">${esc(uiText('Compare current catalog products'))}</button>` +
      (request.gateway === 'x_ads_native_action'
        ? `<button type="button" class="button" id="inspect-catalog-inventory" aria-describedby="catalog-inspection-limits catalog-inspection-feedback">${esc(uiText('Inspect other listed X products'))}</button><p id="catalog-inspection-limits" class="form-note">${esc(uiText('Inspect listed products in this X catalog. Products outside your source selection stay retained; full store and variant absence are unverified.'))}</p><div id="catalog-inspection-feedback" class="workspace-form-feedback" role="alert" aria-atomic="true" hidden></div>`
        : '') +
      catalogImportPreviewMarkup(out, request) +
      recordDetails(request.products, uiText('Exact product fields sent for review')) +
      (request.gateway === 'x_ads_native_action'
        ? recordDetails(
            out.plan?.steps?.map(step => step.arguments.payload),
            uiText('Exact X product fields sent for native review'),
          )
        : '') +
      `<p>${esc(uiAccountExplanation(out.meaning))}</p>` +
      (out.destination_limitations?.length
        ? `<ul>${out.destination_limitations.map(value => `<li>${esc(uiAccountExplanation(value))}</li>`).join('')}</ul>`
        : '') +
      recordDetails({source_hash: out.source_hash}, uiText('Source hash')) +
      `<div id="catalog-comparison" aria-live="polite"></div>` +
      (feedOnly
        ? ''
        : `<button class="button" id="create-catalog-plan" aria-describedby="create-catalog-plan-note">${esc(uiText('Save all supplied products for native review'))}</button><p class="form-note" id="create-catalog-plan-note"></p>`);
    let comparisonSequence = 0,
      // The latest validated comparison of these products and when it was read: "Save all" names it in the plan's
      // lineage while AMCP still accepts its reference (15 minutes), and saves without it afterwards (COM-03).
      compared = null;
    const compareCatalogProducts = async (inspectOther = false) => {
      if (!current()) return;
      const comparisonRequest = inspectOther
          ? {...request, inspect_other_listed_products: true, absent_source_policy: 'retain'}
          : request,
        sequence = ++comparisonSequence,
        comparison = $('#catalog-comparison'),
        active = () => current() && sequence === comparisonSequence;
      compared = null;
      if (request.gateway === 'x_ads_native_action') {
        $('#catalog-inspection-feedback').hidden = true;
        $('#catalog-inspection-feedback').innerHTML = '';
      }
      comparison.innerHTML = `<p role="status">${esc(inspectOther ? uiText('Reading other listed X products. No product changes are submitted.') : uiText('Reading supplied retailer IDs. No product changes are submitted.'))}</p>`;
      try {
        const evidence = await workspaceCall(
          'workspace',
          sourced({
            action: 'catalog_compare',
            ...(inspectOther ? {inspect_other_listed_products: true, absent_source_policy: 'retain'} : {}),
          }),
        );
        if (!active()) return;
        // The comparison a plan saved from it names in its lineage (COM-03); a stale reference is refused by AMCP.
        const lineage =
          typeof evidence?.lineage_token === 'string' &&
          evidence.lineage_token.startsWith('v1.') &&
          evidence.lineage_token.length <= 32768
            ? {comparison_token: evidence.lineage_token}
            : {};
        const html = catalogComparisonMarkup(evidence, comparisonRequest, out);
        if (!active()) return;
        comparison.innerHTML = html;
        compared = lineage.comparison_token ? {lineage, at: Date.now()} : null;
        $('#catalog-comparison-heading').focus();
        // After a comparison, "Save all" says how many supplied products already match (COM-01). An X plan records
        // those as unchanged when it reaches them and sends nothing; a Meta plan reviews and sends them again.
        const unchanged = evidence.items.filter(item => item.state === 'matching').length;
        if (!feedOnly) {
          $('#create-catalog-plan').textContent = unchanged
            ? uiText('Save all {count} supplied products ({unchanged} already match)', {
                count: request.products.length,
                unchanged,
              })
            : uiText('Save all supplied products for native review');
          $('#create-catalog-plan-note').textContent = !unchanged
            ? ''
            : request.gateway === 'x_ads_native_action'
              ? uiText(
                  'Products that still match when the plan reaches them are recorded as unchanged; nothing is sent for them.',
                )
              : uiText(
                  'Meta products that already match are reviewed and sent again; save only products needing review to leave them out.',
                );
        }
        if (inspectOther) bindCatalogListedInventory(evidence.listed_inventory, active, comparisonRequest);
        if (request.gateway === 'x_ads_native_action') {
          let removalSequence = 0;
          const selection = () =>
            evidence.items
              .filter((item, i) => !item.blocked && item.before.present === true && $('#catalog-remove-' + i).checked)
              .map(item => item.retailer_id);
          const invalidate = () => {
            if (!active()) return;
            removalSequence++;
            $('#catalog-removal-preview').innerHTML = '';
          };
          evidence.items.forEach((item, i) => {
            if (!item.blocked && item.before.present === true)
              $('#catalog-remove-' + i).addEventListener('change', invalidate);
          });
          if (evidence.items.some(item => !item.blocked && item.before.present === true))
            workspaceBind('#preview-catalog-removal', async () => {
              if (!active()) return;
              const retailer_ids = selection();
              if (!retailer_ids.length)
                throw Error(uiText('Select at least one observed individual product to preview removal.'));
              const sequence = ++removalSequence,
                output = $('#catalog-removal-preview');
              const removalActive = () =>
                active() &&
                sequence === removalSequence &&
                JSON.stringify(selection()) === JSON.stringify(retailer_ids);
              output.innerHTML = `<p role="status">${esc(uiText('Reading selected products for a removal preview. No products are deleted.'))}</p>`;
              try {
                const proposed = await workspaceCall('workspace', {
                  action: 'preview_catalog_removal',
                  ...request,
                  retailer_ids,
                });
                if (!removalActive()) return;
                output.innerHTML = catalogRemovalMarkup(proposed, request, evidence, retailer_ids, out);
                $('#catalog-removal-heading').focus();
                workspaceBind('#save-catalog-removal', async () => {
                  if (!removalActive()) return;
                  try {
                    const saved = await workspaceCall('workspace', {
                      action: 'create_catalog_removal',
                      preview_id: proposed.preview_id,
                      preview_hash: proposed.preview_hash,
                      confirmed: true,
                    });
                    if (removalActive()) await navigate('/campaigns?id=' + encodeURIComponent(saved.id));
                  } catch (error) {
                    if (removalActive()) throw error;
                  }
                });
              } catch (error) {
                if (removalActive()) {
                  output.innerHTML = '';
                  throw error;
                }
              }
            });
        }
        // COM-02 B: retire the selected existing products through the reviewed upsert; nothing is deleted.
        const retirable = item => !item.blocked && item.before.present === true;
        if (!feedOnly && comparisonRequest.allow_upsert === true && evidence.items.some(retirable))
          workspaceBind('#save-catalog-retirement', async () => {
            if (!active()) return;
            const retire_retailer_ids = evidence.items
              .filter((item, i) => retirable(item) && $('#catalog-retire-' + i).checked)
              .map(item => item.retailer_id);
            if (!retire_retailer_ids.length) throw Error(uiText('Select at least one existing product to retire.'));
            const retire_availability = $('#catalog-retire-availability').value,
              products = request.products.filter(p => retire_retailer_ids.includes(p.retailer_id)),
              retirement = {retire_retailer_ids, retire_availability, ...lineage};
            try {
              const plan = await workspaceCall(
                'workspace',
                source
                  ? sourced(
                      {action: 'catalog_plan'},
                      {select_retailer_ids: products.map(p => p.retailer_id), ...retirement},
                    )
                  : {action: 'catalog_plan', ...request, products, requirements: retirement},
              );
              if (active()) await navigate('/campaigns?id=' + encodeURIComponent(plan.id));
            } catch (error) {
              if (active()) throw error;
            }
          });
        if (!feedOnly && evidence.review_retailer_ids.length)
          workspaceBind('#save-catalog-changes', async () => {
            if (!active()) return;
            const selected = new Set(evidence.review_retailer_ids),
              products = request.products.filter(p => selected.has(p.retailer_id));
            if (!products.length) return;
            try {
              const plan = await workspaceCall(
                'workspace',
                source
                  ? sourced(
                      {action: 'catalog_plan'},
                      {select_retailer_ids: products.map(p => p.retailer_id), ...lineage},
                    )
                  : {
                      action: 'catalog_plan',
                      ...request,
                      products,
                      ...(lineage.comparison_token ? {requirements: lineage} : {}),
                    },
              );
              if (active()) await navigate('/campaigns?id=' + encodeURIComponent(plan.id));
            } catch (error) {
              if (active()) throw error;
            }
          });
      } catch (error) {
        if (active()) {
          comparison.innerHTML = '';
          if (inspectOther) {
            const feedback = $('#catalog-inspection-feedback');
            feedback.innerHTML = `<p>${esc(errorMessage(error))}</p>`;
            feedback.hidden = false;
          } else throw error;
        }
      }
    };
    workspaceBind('#compare-catalog-products', () => compareCatalogProducts(false));
    if (request.gateway === 'x_ads_native_action')
      workspaceBind('#inspect-catalog-inventory', () => compareCatalogProducts(true));
    if (!feedOnly)
      workspaceBind('#create-catalog-plan', async () => {
        if (!current()) return;
        try {
          const plan = await workspaceCall(
            'workspace',
            sourced({action: 'catalog_plan'}, compared && Date.now() - compared.at < 840000 ? compared.lineage : {}),
          );
          if (current()) await navigate('/campaigns?id=' + encodeURIComponent(plan.id));
        } catch (error) {
          if (current()) throw error;
        }
      });
  });
}

function wooCommerceInventoryPanelMarkup() {
  const sources = typeof commerceSources === 'undefined' ? [] : commerceSources;
  return `<section class="panel workspace-form"><h2>${esc(uiText('Inspect published store inventory'))}</h2><p>${esc(uiText('Read the published product collection and every reported variable-parent variation. Native statuses and selected prices remain exact. This inspection creates no import, draft or deletion.'))}</p><p id="woo-inventory-limits" class="form-note">${esc(uiText('Two complete scans must agree within 1,000 products and variations per scan, 64 requests, 8 MiB and 60 seconds. Unpublished parents and independently verified grouped-product membership are outside this inspection.'))}</p><form id="woo-inventory" aria-describedby="woo-inventory-limits"><label>${esc(uiText('Configured WooCommerce store'))}<select name="target" required><option value="">${esc(uiText('Choose a store'))}</option>${sources.map((item, i) => `<option value="${i}">${esc(item.label)} · ${esc(item.store_origin)}</option>`).join('')}</select></label><label>${esc(uiText('Native source price field'))}<select name="price_field" required><option value="">${esc(uiText('Choose a price field'))}</option><option value="price">${esc(uiText('Current native price'))}</option><option value="regular_price">${esc(uiText('Regular native price'))}</option><option value="sale_price">${esc(uiText('Native sale price field'))}</option></select></label><button class="button" type="submit" ${sources.length ? '' : 'disabled'}>${esc(uiText('Inspect inventory without changes'))}</button></form><div id="woo-inventory-result" aria-live="polite"></div></section>`;
}
function wooCommerceInventorySelection(out, request, source) {
  const invalid = () => {
      throw Error(uiText('The WooCommerce inventory scope or completeness changed. Read it again.'));
    },
    scope = out?.scope,
    count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000,
    hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    id = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value),
    ids = new Set(),
    parents = new Map();
  if (
    out?.record_kind !== 'catalog_source_inventory' ||
    out.state !== 'complete' ||
    out.complete_collected_inventory !== true ||
    scope?.gateway !== request.gateway ||
    scope.account_id !== request.account_id ||
    scope.connection_id !== request.connection_id ||
    scope.store_origin !== source.store_origin ||
    scope.api_version !== 'wc/v3' ||
    scope.source_kind !== 'inventory' ||
    scope.absent_source_policy !== 'retain' ||
    scope.price_field !== request.requirements.price_field ||
    scope.product_status !== 'publish' ||
    scope.variation_status !== 'any' ||
    out.point_in_time !== false ||
    out.unpublished_parents_collected !== false ||
    out.grouped_membership !== 'not_independently_verified' ||
    out.destination_eligibility !== 'unverified' ||
    out.provider_mutations !== 0 ||
    out.destructive_deletions !== 0 ||
    out.saved_drafts !== 0 ||
    out.source_saved !== false ||
    !/^[A-Z]{3}$/.test(out.native_currency ?? '') ||
    !hash(out.source_hash) ||
    !count(out.item_count) ||
    !count(out.product_count) ||
    !count(out.variation_count) ||
    out.item_count !== out.product_count + out.variation_count ||
    !Array.isArray(out.items) ||
    out.items.length !== out.item_count ||
    !Number.isSafeInteger(out.captured_at) ||
    out.captured_at <= 0 ||
    !Number.isSafeInteger(out.native_requests) ||
    out.native_requests < 5 ||
    out.native_requests > 64 ||
    out.collected_rows !== out.item_count * 2 ||
    !Number.isSafeInteger(out.collected_bytes) ||
    out.collected_bytes < 1 ||
    out.collected_bytes > 8388608 ||
    !out.limits ||
    out.limits.items_per_scan !== 1000 ||
    out.limits.page_size !== 100 ||
    out.limits.requests !== 64 ||
    out.limits.bytes !== 8388608 ||
    out.limits.elapsed_ms !== 60000 ||
    !Array.isArray(out.scans) ||
    out.scans.length !== 2 ||
    !out.scans[0] ||
    !out.scans[1] ||
    out.scans[0].source_hash !== out.scans[1].source_hash ||
    out.scans.some(
      (scan, i) =>
        scan.scan !== i + 1 ||
        scan.item_count !== out.item_count ||
        !hash(scan.source_hash) ||
        !Array.isArray(scan.pages) ||
        !scan.pages.length,
    ) ||
    !Array.isArray(out.currency_evidence) ||
    out.currency_evidence.length !== 3 ||
    out.currency_evidence.some(
      value =>
        !value ||
        value.value !== out.native_currency ||
        !hash(value.source_hash) ||
        !Number.isSafeInteger(value.observed_at) ||
        value.observed_at <= 0,
    ) ||
    out.meaning !==
      'All published parent products and every reported variable-parent variation were collected twice within the stated bounds. Native IDs, selected price strings, statuses and reported memberships are preserved. The supported observations and store currency agreed across the sequential scans. This is not a point-in-time snapshot, unpublished-parent inventory, verified grouped-product membership, destination eligibility or write approval. Missing source products are retained; no product, draft or snapshot was changed or saved.'
  )
    invalid();
  const fields = [
    'product_id',
    'sku',
    'status',
    'selected_price',
    'stock_status',
    'tax_status',
    'virtual',
    'downloadable',
    'date_modified_gmt',
    'entity_kind',
    'product_type',
    'name',
    'parent_product_id',
  ];
  const items = out.items.map(item => {
    if (
      !item ||
      typeof item !== 'object' ||
      !id(item.product_id) ||
      ids.has(item.product_id) ||
      !['product', 'variation'].includes(item.entity_kind) ||
      ['sku', 'status', 'selected_price', 'stock_status', 'tax_status', 'date_modified_gmt', 'name'].some(
        key =>
          item[key] !== null &&
          (typeof item[key] !== 'string' || item[key].length > 500 || /[\x00-\x1f\x7f]/.test(item[key])),
      ) ||
      ['virtual', 'downloadable'].some(key => item[key] !== null && typeof item[key] !== 'boolean')
    )
      invalid();
    ids.add(item.product_id);
    if (item.entity_kind === 'product') {
      if (
        item.status !== 'publish' ||
        item.parent_product_id !== '0' ||
        !['simple', 'variable', 'grouped', 'external'].includes(item.product_type) ||
        !Array.isArray(item.variation_ids) ||
        !Array.isArray(item.reported_grouped_product_ids) ||
        [item.variation_ids, item.reported_grouped_product_ids].some(
          values =>
            values.length > 1000 ||
            new Set(values).size !== values.length ||
            values.some(value => !id(value) || value === item.product_id),
        ) ||
        (item.product_type !== 'variable' && item.variation_ids.length) ||
        (item.product_type !== 'grouped' && item.reported_grouped_product_ids.length)
      )
        invalid();
      parents.set(item.product_id, item);
      return {
        ...Object.fromEntries(fields.map(key => [key, item[key]])),
        variation_ids: [...item.variation_ids],
        reported_grouped_product_ids: [...item.reported_grouped_product_ids],
      };
    }
    if (
      item.product_type !== 'variation' ||
      !['publish', 'draft', 'pending', 'private', 'future'].includes(item.status) ||
      item.name !== null ||
      item.requires_title_review !== true ||
      !id(item.parent_product_id) ||
      !Array.isArray(item.attributes) ||
      item.attributes.length > 25 ||
      ['parent_name', 'parent_sku'].some(
        key =>
          item[key] !== null &&
          (typeof item[key] !== 'string' || item[key].length > 500 || /[\x00-\x1f\x7f]/.test(item[key])),
      ) ||
      item.attributes.some(
        a =>
          !a ||
          typeof a.id !== 'string' ||
          !/^(0|[1-9][0-9]{0,19})$/.test(a.id) ||
          ['name', 'option'].some(k => typeof a[k] !== 'string' || a[k].length > 200 || /[\x00-\x1f\x7f]/.test(a[k])),
      ) ||
      new Set(item.attributes.map(a => (a.id === '0' ? 'custom:' + a.name : a.id))).size !== item.attributes.length
    )
      invalid();
    return {
      ...Object.fromEntries(fields.map(key => [key, item[key]])),
      parent_name: item.parent_name,
      parent_sku: item.parent_sku,
      requires_title_review: true,
      attributes: item.attributes.map(a => ({id: a.id, name: a.name, option: a.option})),
    };
  });
  if (parents.size !== out.product_count) invalid();
  for (const parent of parents.values()) {
    const children = items.filter(
        item => item.entity_kind === 'variation' && item.parent_product_id === parent.product_id,
      ),
      memberIds = new Set(parent.variation_ids);
    if (
      children.length !== memberIds.size ||
      children.some(
        child =>
          !memberIds.has(child.product_id) || child.parent_name !== parent.name || child.parent_sku !== parent.sku,
      )
    )
      invalid();
  }
  if (
    items.some(
      item =>
        item.entity_kind === 'variation' &&
        (!parents.has(item.parent_product_id) || parents.get(item.parent_product_id).product_type !== 'variable'),
    )
  )
    invalid();
  const variables = [...parents.values()].filter(parent => parent.product_type === 'variable');
  const scans = out.scans.map(scan => {
    const collections = new Map(),
      pages = scan.pages.map(page => {
        if (
          !page ||
          !['product', 'variation'].includes(page.entity_kind) ||
          !Number.isSafeInteger(page.page) ||
          page.page < 1 ||
          page.page > 10 ||
          !Number.isSafeInteger(page.count) ||
          page.count < 0 ||
          page.count > 100 ||
          !count(page.total) ||
          !Number.isSafeInteger(page.total_pages) ||
          page.total_pages < 0 ||
          page.total_pages > 10 ||
          !hash(page.source_hash) ||
          !Number.isSafeInteger(page.observed_at) ||
          page.observed_at <= 0
        )
          invalid();
        const parent = page.entity_kind === 'variation' ? parents.get(page.parent_product_id) : null;
        if (
          page.entity_kind === 'product'
            ? page.parent_product_id !== null
            : !parent || parent.product_type !== 'variable'
        )
          invalid();
        const expected = parent ? parent.variation_ids.length : out.product_count,
          key = parent ? parent.product_id : 'products',
          previous = collections.get(key) ?? {pages: 0, rows: 0, total_pages: page.total_pages};
        if (
          page.total !== expected ||
          page.page !== previous.pages + 1 ||
          page.total_pages !== previous.total_pages ||
          (expected ? page.total_pages !== Math.ceil(expected / 100) : page.total_pages > 1) ||
          page.count !== Math.min(100, expected - previous.rows)
        )
          invalid();
        collections.set(key, {pages: page.page, rows: previous.rows + page.count, total_pages: page.total_pages});
        return Object.fromEntries(
          [
            'entity_kind',
            'parent_product_id',
            'page',
            'count',
            'total',
            'total_pages',
            'source_hash',
            'observed_at',
          ].map(key => [key, page[key]]),
        );
      });
    if (
      collections.size !== variables.length + 1 ||
      !collections.has('products') ||
      variables.some(parent => !collections.has(parent.product_id)) ||
      [...collections.values()].some(value => value.pages !== Math.max(1, value.total_pages)) ||
      pages.reduce((sum, page) => sum + page.count, 0) !== out.item_count
    )
      invalid();
    return {scan: scan.scan, item_count: scan.item_count, source_hash: scan.source_hash, pages};
  });
  if (out.native_requests !== 3 + scans.reduce((sum, scan) => sum + scan.pages.length, 0)) invalid();
  return {
    ...Object.fromEntries(
      [
        'record_kind',
        'state',
        'complete_collected_inventory',
        'native_currency',
        'item_count',
        'product_count',
        'variation_count',
        'source_hash',
        'captured_at',
        'native_requests',
        'collected_rows',
        'collected_bytes',
        'point_in_time',
        'unpublished_parents_collected',
        'grouped_membership',
        'destination_eligibility',
        'provider_mutations',
        'destructive_deletions',
        'saved_drafts',
        'source_saved',
        'meaning',
      ].map(key => [key, out[key]]),
    ),
    scope: Object.fromEntries(
      [
        'gateway',
        'account_id',
        'connection_id',
        'store_origin',
        'api_version',
        'source_kind',
        'price_field',
        'product_status',
        'variation_status',
        'absent_source_policy',
      ].map(key => [key, scope[key]]),
    ),
    limits: Object.fromEntries(
      ['items_per_scan', 'page_size', 'requests', 'bytes', 'elapsed_ms'].map(key => [key, out.limits[key]]),
    ),
    items,
    scans,
    currency_evidence: out.currency_evidence.map(value => ({
      value: value.value,
      source_hash: value.source_hash,
      observed_at: value.observed_at,
    })),
  };
}
function wooCommerceInventoryView(out, query = '', page = 0) {
  const kind = item => (item.entity_kind === 'variation' ? uiText('Native variation') : uiText('Published product')),
    term = query.trim().toLowerCase(),
    filtered = out.items.filter(item =>
      [
        item.product_id,
        item.parent_product_id,
        item.name,
        item.parent_name,
        item.sku,
        item.parent_sku,
        item.status,
        item.selected_price,
        item.product_type,
        kind(item),
        ...(item.attributes ?? []).flatMap(a => [a.name, a.option]),
      ]
        .filter(value => value !== null && value !== undefined)
        .join(' ')
        .toLowerCase()
        .includes(term),
    ),
    pages = Math.max(1, Math.ceil(filtered.length / 50)),
    current = Math.max(0, Math.min(page, pages - 1)),
    from = current * 50,
    native = value => (value === null ? uiText('Unknown') : value === '' ? uiText('Empty native value') : value),
    rows = filtered
      .slice(from, from + 50)
      .map(
        item =>
          `<tr><th scope="row"><strong><bdi>${esc(native(item.name ?? item.parent_name ?? null))}</bdi></strong><br><code dir="ltr">${esc(item.product_id)}</code><p>${esc(kind(item))}</p>${item.entity_kind === 'variation' ? `<p>${esc(uiText('Native parent ID'))}: <code dir="ltr">${esc(item.parent_product_id)}</code></p>${item.attributes.map(a => `<p><bdi>${esc(a.name)}: ${esc(a.option)}</bdi></p>`).join('')}` : ''}</th><td><code dir="ltr">${esc(native(item.sku))}</code>${item.entity_kind === 'variation' ? `<p>${esc(uiText('Native parent SKU'))}: <code dir="ltr">${esc(native(item.parent_sku))}</code></p>` : ''}</td><td><bdi dir="ltr">${esc(native(item.selected_price))} ${esc(out.native_currency)}</bdi></td><td><code dir="ltr">${esc(item.status)}</code><br><code dir="ltr">${esc(native(item.stock_status))}</code><br><code dir="ltr">${esc(native(item.tax_status))}</code></td><td><code dir="ltr">${esc(item.product_type)}</code>${item.entity_kind === 'product' ? `<p>${esc(uiText('{count} reported variation IDs', {count: item.variation_ids.length}))}</p>${item.product_type === 'grouped' ? `<p>${esc(uiText('{count} reported grouped-product IDs', {count: item.reported_grouped_product_ids.length}))}</p>` : ''}` : `<p>${esc(uiText('Destination title and eligibility need a separate selected-product review.'))}</p>`}</td></tr>`,
      )
      .join('');
  return `<div class="split"><label for="woo-inventory-search">${esc(uiText('Find a native product, variation, SKU, status or price'))}<input type="search" id="woo-inventory-search" value="${esc(query)}" maxlength="500"></label><div><button type="button" class="button" id="woo-inventory-find">${esc(uiText('Search inventory'))}</button><button type="button" class="button" id="woo-inventory-clear">${esc(uiText('Clear search'))}</button></div></div><p role="status">${esc(uiText('Showing {from}–{through} of {count} collected products and variations', {from: filtered.length ? from + 1 : 0, through: Math.min(from + 50, filtered.length), count: filtered.length}))}</p>${filtered.length ? `<div class="data-scroll native-inventory-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Store inventory, scroll for all native fields'))}"><table class="review-table"><caption>${esc(uiText('Published products and their reported variations'))}</caption><thead><tr>${[uiText('Product'), uiText('Native SKU'), uiText('Price'), uiText('Native status, stock and tax'), uiText('Native type and membership')].map(label => `<th scope="col">${esc(label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : `<p>${esc(uiText('No collected rows match this local view. Unpublished products and whole-store absence are not established.'))}</p>`}<div class="pagination"><button type="button" class="button" id="woo-inventory-previous" ${current === 0 ? 'disabled' : ''}>${esc(uiText('Previous'))}</button><span>${esc(uiText('Page {page} of {pages}', {page: current + 1, pages}))}</span><button type="button" class="button" id="woo-inventory-next" ${current >= pages - 1 ? 'disabled' : ''}>${esc(uiText('Next'))}</button></div>`;
}
function bindWooCommerceInventory() {
  const sources = typeof commerceSources === 'undefined' ? [] : commerceSources,
    form = $('#woo-inventory'),
    result = $('#woo-inventory-result'),
    begin = accountWorkflowContext(form, result);
  const handoff = new URLSearchParams(location.search),
    keys = ['woo_inventory', 'connection_id', 'account_id', 'price_field'];
  if (
    handoff.get('woo_inventory') === '1' &&
    keys.every(key => handoff.getAll(key).length === 1) &&
    !handoff.has('product_ids') &&
    !handoff.has('parent_product_id') &&
    !handoff.has('source_kind')
  ) {
    const index = sources.findIndex(
      source =>
        source.connection_id === handoff.get('connection_id') && source.account_id === handoff.get('account_id'),
    );
    if (index >= 0 && ['price', 'regular_price', 'sale_price'].includes(handoff.get('price_field'))) {
      form.elements.target.value = String(index);
      form.elements.price_field.value = handoff.get('price_field');
    }
  }
  workspaceBind(
    '#woo-inventory',
    async () => {
      const active = begin();
      if (!active()) return;
      const source = form.elements.target.value === '' ? undefined : sources[Number(form.elements.target.value)],
        price = form.elements.price_field.value;
      if (!source || !['price', 'regular_price', 'sale_price'].includes(price))
        throw Error(uiText('Choose a configured store and an exact native price field for inventory inspection.'));
      const request = {
        action: 'catalog_source',
        gateway: 'commerce_native_action',
        connection_id: source.connection_id,
        account_id: source.account_id,
        requirements: {source_kind: 'inventory', price_field: price, absent_source_policy: 'retain'},
      };
      try {
        const response = await workspaceCall('workspace', request);
        if (!active()) return;
        const out = wooCommerceInventorySelection(response, request, source);
        const evidence = Object.fromEntries(
          [
            'record_kind',
            'scope',
            'complete_collected_inventory',
            'native_currency',
            'item_count',
            'product_count',
            'variation_count',
            'items',
            'source_hash',
            'scans',
            'currency_evidence',
            'captured_at',
            'native_requests',
            'collected_rows',
            'collected_bytes',
            'limits',
            'point_in_time',
            'unpublished_parents_collected',
            'grouped_membership',
            'destination_eligibility',
            'provider_mutations',
            'destructive_deletions',
            'saved_drafts',
            'source_saved',
          ].map(key => [key, out[key]]),
        );
        result.innerHTML = `<h3 id="woo-inventory-heading" tabindex="-1">${esc(uiText('Observed store inventory'))}</h3><p>${esc(uiText('Read {date} · {products} published products · {variations} reported variations · {currency}', {date: date(out.captured_at), products: out.product_count, variations: out.variation_count, currency: out.native_currency}))}</p><p class="notice">${esc(uiAccountExplanation(out.meaning))}</p><div id="woo-inventory-view" aria-live="polite"></div>${recordDetails(evidence, uiText('Complete collected inventory evidence'))}`;
        let query = '',
          page = 0;
        const render = focus => {
          if (!active()) return;
          $('#woo-inventory-view').innerHTML = wooCommerceInventoryView(out, query, page);
          const find = () => {
            if (!active()) return;
            query = $('#woo-inventory-search').value;
            page = 0;
            render('#woo-inventory-search');
          };
          workspaceBind('#woo-inventory-find', find);
          workspaceBind('#woo-inventory-clear', () => {
            if (!active()) return;
            query = '';
            page = 0;
            render('#woo-inventory-search');
          });
          workspaceBind('#woo-inventory-previous', () => {
            if (!active()) return;
            page = Math.max(0, page - 1);
            render('#woo-inventory-heading');
          });
          workspaceBind('#woo-inventory-next', () => {
            if (!active()) return;
            page++;
            render('#woo-inventory-heading');
          });
          $('#woo-inventory-search').addEventListener('keydown', event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              find();
            }
          });
          if (focus) $(focus).focus();
        };
        render('#woo-inventory-heading');
      } catch (error) {
        if (active()) {
          result.innerHTML = '';
          throw error;
        }
      }
    },
    {disabled: () => sources.length === 0},
  );
}
