'use strict';
// WEB-07: what the account workflow pages share (Live portfolio, Measurement and Commerce, each now its own module:
// web/portfolio.js, web/measurement.js and web/commerce.js): the explanations AMCP authored for account reads, the
// account picker built from the working client's accounts, and the guard that ties a preview to its form and identity.
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
function uiAccountExplanation(value) {
  return accountExplanationMessages.has(value) ? uiText(value) : String(value ?? '');
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
