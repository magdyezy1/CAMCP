'use strict';
const accountExplanationMessages = new Set([
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
  'The draft changed during its product check. Refresh before continuing.',
  'Preview of explicit additional-consent settings in the selected workspace. Existing required types are preserved. This does not establish built-in checks, runtime consent, event delivery or compliance. Saving creates an unapproved draft; publishing remains separate.',
  'Choose the exact Tag Manager account and login.',
  'Choose the exact container and workspace.',
  'Choose 1–10 distinct exact tag IDs.',
  'Choose 1–20 distinct literal additional-consent types. Variables and duplicate types are refused.',
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
  'Preview is based on supplied product data. Current provider items are read by each native review before execution. Partial or uncertain writes retain per-item receipts in the campaign journal.',
  'Preview uses supplied product data and the existing X product contract. Each product keeps a separate native review, accepted receipt and independent read-back. Matching IDs are updated; missing source items are retained.',
  'X catalog endpoints require early-access entitlement; a local preview does not establish account eligibility.',
  'X updates matching product IDs. Ownership and existing values are checked during each native review.',
  'Product variants, live store synchronization and deletion of missing source items are outside this import.',
  'Choose an exact X product catalog ID and selected X ad account.',
  'X imports require explicit upsert approval: X updates matching product IDs. Create-only imports are not qualified.',
  'X imports require explicit retailer_id, name, price, currency, image_url, url, availability, condition, brand and plain text description.',
  'Product retailer IDs must be unique.',
  'Choose one explicit uppercase three-letter product currency.',
  'Current evidence for supplied X product IDs only, using repeated bounded native reads and exact supported decimal prices. Grouped or potentially hidden variants are blocked. Missing fields stay unknown. This is sequential evidence, not a point-in-time inventory snapshot. Every saved product still requires a fresh native review and independent read-back; products outside the supplied source are not returned or deleted.',
  'X comparison requires a complete catalog scan of at most 1,000 listed products. No product changes were submitted.',
  'X catalog ownership or supplied-product evidence changed during comparison. Read the source products again; no product changes were submitted.',
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
  return platforms
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
}
async function renderPortfolio() {
  const targets = accountChoices(['google', 'meta', 'linkedin', 'snapchat', 'tiktok', 'x']),
    generation = navigationGeneration,
    identity = identityGeneration;
  content.innerHTML += `<p class="notice">${esc(uiText('Browse current Google Ads, Meta, LinkedIn, Snapchat, TikTok and X inventory. Inventory is read-only; provider changes require a separate review.'))}</p><form id="portfolio-account" class="panel workspace-form"><label>${esc(uiText('Advertising account'))}<select name="target" required><option value="">${esc(uiText('Choose a login and account'))}</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label><button class="button primary" type="submit">${esc(uiText('Read inventory'))}</button></form><div id="portfolio-view" aria-live="polite"></div>`;
  const view = $('#portfolio-view'),
    form = $('#portfolio-account');
  const attached = () =>
    generation === navigationGeneration && identity === identityGeneration && view.isConnected && form.isConnected;
  let target = null,
    current = {entity: 'campaign'},
    cursor = null,
    sequence = 0;
  const load = async (config, next = null) => {
    if (!attached()) return;
    if (!target) throw Error(uiText('Choose an account and read its inventory first.'));
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
    current = config;
    cursor = out.next_cursor;
    const meta = selected.gateway === 'meta_native_action',
      linkedin = selected.gateway === 'linkedin_native_action',
      snap = selected.gateway === 'snapchat_native_action',
      tiktok = selected.gateway === 'tiktok_native_action',
      x = selected.gateway === 'x_ads_native_action',
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
    const money = r => {
      if (r.native_money) {
        const entries = Object.entries(r.native_money).filter(([, v]) => v !== null);
        return entries.length
          ? portfolioBudgetContextView(r) +
              entries
                .map(
                  ([k, v]) =>
                    `<div>${esc(linkedin || snap || tiktok || x ? portfolioMoneyLabel(k) : k)}: <b>${esc(linkedin ? v.amount + ' ' + v.currencyCode : v)}</b></div>`,
                )
                .join('') +
              `<small>${esc(linkedin ? uiText('LinkedIn native decimal amounts · unconverted') : snap ? uiText('Snapchat native micros · unconverted') : x ? uiText('X native micros · unconverted') : tiktok ? uiText('TikTok native account-currency amounts · unconverted') : uiText('Meta native integers · unconverted'))}</small>`
          : portfolioBudgetContextView(r) + uiText('No amount returned');
      }
      return r.budget_micros != null
        ? esc(uiText('{amount} budget micros', {amount: r.budget_micros}))
        : r.cpc_bid_micros != null
          ? esc(uiText('{amount} CPC bid micros', {amount: r.cpc_bid_micros}))
          : '—';
    };
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
    view.innerHTML = `<section class="panel"><div class="dialog-actions"><button id="portfolio-root" class="button">${esc(linkedin ? uiText('Campaign groups') : uiText('Campaigns'))}</button>${parent}<a class="button" href="/campaigns#campaign-create">${esc(uiText('Create or clone a plan'))}</a><a class="button" href="/reports#report-capture">${esc(uiText('Capture performance evidence'))}</a></div>
      <h2 id="portfolio-heading" tabindex="-1">${esc(uiText('{entity} inventory', {entity: portfolioEntityLabel(config.entity)}))}</h2>
      <p><strong>${esc(uiText('{platform} · Account {account}', {platform: linkedin ? 'LinkedIn' : meta ? 'Meta' : snap ? 'Snapchat' : tiktok ? 'TikTok' : x ? 'X' : 'Google Ads', account: out.account_id}))}</strong>${config.campaign_group_id ? ' · ' + esc(uiText('Campaign group {id}', {id: config.campaign_group_id})) : ''}${config.campaign_id ? ' · ' + esc(uiText('Campaign {id}', {id: config.campaign_id})) : ''}${config.adset_id || config.ad_group_id || config.ad_squad_id || config.adgroup_id || config.line_item_id ? ' · ' + esc(uiText(meta ? 'Ad set {id}' : snap ? 'Ad squad {id}' : x ? 'Line item {id}' : 'Ad group {id}', {id: config.adset_id ?? config.ad_group_id ?? config.ad_squad_id ?? config.adgroup_id ?? config.line_item_id})) : ''}</p>
      <p>${esc(uiText('Read {date} · Current inventory', {date: date(out.captured_at)}))}</p><details class="workspace-details"><summary>${esc(uiText('Inventory scope and native units'))}</summary><p>${esc(uiAccountExplanation(out.meaning))}</p></details>
      <div class="data-scroll" role="region" aria-label="${esc(uiText('Portfolio entities'))}" tabindex="0"><table class="review-table"><thead><tr><th scope="col">${esc(uiText('Entity'))}</th><th scope="col">${esc(linkedin && config.entity === 'creative' ? uiText('Intended status') : uiText('Native status'))}</th><th scope="col">${esc(uiText('Native money fields'))}</th><th scope="col">${esc(uiText('Next view'))}</th></tr></thead><tbody>
      ${out.rows.map((r, i) => `<tr><th scope="row">${esc(r.name)}<small>${esc(r.id)}</small></th><td><strong>${esc(r.status ?? uiText('Unknown'))}</strong>${meta ? `<small>${esc(uiText('Effective:'))} ${esc(r.effective_status ?? uiText('Unknown'))}</small>` : ''}${serving(r)}${recordDetails(r.native, uiText('Native fields'))}</td><td>${money(r)}<small>${esc(r.currency ?? uiText('Currency unknown'))} · ${esc(r.timezone ?? uiText('Timezone unknown'))}</small></td><td>${config.entity !== leaf ? `<button class="button small" data-portfolio-child="${i}">${esc(child)}</button>` : esc(linkedin ? uiText('Read-only creative record') : x ? uiText('Read-only promoted-post association') : uiText('Read-only ad record'))}</td></tr>`).join('') || `<tr><td colspan="4">${esc(uiText('No entities in this page. Follow Next page if the provider supplies a continuation.'))}</td></tr>`}
      </tbody></table></div><div class="dialog-actions"><button class="button" id="portfolio-refresh">${esc(uiText('Refresh first page'))}</button><button class="button" id="portfolio-next" ${out.has_more ? '' : 'hidden'}>${esc(uiText('Next page'))}</button></div></section>`;
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
    $('#portfolio-heading').focus();
  };
  form.elements.target.addEventListener('change', () => {
    if (!attached()) return;
    sequence++;
    target = null;
    cursor = null;
    view.setAttribute('aria-busy', 'false');
    view.innerHTML = blank(uiText('Read inventory to open the selected account.'));
  });
  workspaceBind('#portfolio-account', async form => {
    if (!attached()) return;
    const t = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !t) throw Error(uiText('Choose an account.'));
    const {label, ...binding} = t;
    target = binding;
    await load({entity: binding.gateway === 'linkedin_native_action' ? 'campaign_group' : 'campaign'});
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
      const text = errorMessage(error);
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
async function renderMeasurement() {
  const targets = accountChoices(['gtm']),
    eventTargets = accountChoices(['ga4']),
    conversionTargets = accountChoices(['linkedin']);
  content.innerHTML += `<section class="panel"><h2>${esc(uiText('Measurement evidence'))}</h2><p>${esc(uiText('Review configured tags, trigger dependencies, workspace conflicts and published-version consistency. Configuration evidence is distinct from observed event delivery and attribution.'))}</p><div class="work-links"><a href="/reporting-overview"><strong>${esc(uiText('GA4 and Search Console context'))}</strong><small>${esc(uiText('Collect measurement reports with source definitions.'))}</small></a><a href="/profiles"><strong>${esc(uiText('Client conversion mappings'))}</strong><small>${esc(uiText('Inspect approved conversion definitions and account bindings.'))}</small></a><a href="/capabilities"><strong>${esc(uiText('Reviewed measurement changes'))}</strong><small>${esc(uiText('Discover exact conversion and tag contracts.'))}</small></a></div></section><section class="panel workspace-form"><h2>${esc(uiText('Google Tag Manager configuration audit'))}</h2><form id="measurement-audit"><label>${esc(uiText('Tag Manager account'))}<select name="target" required><option value="">${esc(uiText('Choose a selected account'))}</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>${controls(uiText('Container ID (optional for account inventory)'), 'text', '', 'container_id')}${controls(uiText('Workspace ID (optional)'), 'text', '', 'workspace_id')}<button class="button primary" type="submit">${esc(uiText('Read configuration evidence'))}</button></form><div id="measurement-result"></div></section>`;
  content.innerHTML += measurementEventsMarkup(eventTargets);
  content.innerHTML += measurementEventIdentityMarkup(eventTargets);
  content.innerHTML += measurementConversionsMarkup(conversionTargets);
  const form = $('#measurement-audit'),
    result = $('#measurement-result'),
    begin = accountWorkflowContext(form, result);
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
    const c = out.configuration;
    result.innerHTML = `<p class="notice">${esc(uiAccountExplanation(out.meaning))}</p>${badge(c.complete ? 'complete' : 'incomplete')}<h3>${esc(uiText('Configuration findings'))}</h3>${(c.findings ?? []).map(f => `<article><h4>${esc(uiGtmFindingLabel(f.code))} · ${esc(uiGtmFindingSeverity(f.severity))}</h4><p>${esc(uiGtmFindingMessage(f))}</p><p><code dir="ltr">${esc(f.code)}</code></p><code dir="ltr">${esc(f.path)}</code></article>`).join('') || `<p>${esc(uiText('No configuration finding was returned for this scope.'))}</p>`}${c.limitations?.length ? `<section><h3>${esc(uiText('Observation limits'))}</h3><ul>${c.limitations.map(value => `<li>${esc(uiAccountExplanation(value))}</li>`).join('')}</ul></section>` : ''}<div id="gtm-consent-evidence"></div><div id="gtm-consent-draft"></div>${reviewTable(c.versions ?? {}, uiText('Published version evidence'))}${recordDetails(c, uiText('Audit scope, limits and native evidence'))}`;
    mountGtmConsentEvidence(c.consent_evidence, current);
    mountGtmConsentDraft(c.consent_evidence, out.scope, current);
  });
  bindMeasurementEvents(eventTargets);
  bindMeasurementEventIdentity(eventTargets);
  bindMeasurementConversions(conversionTargets);
}
function prefillMeasurementAudit(form, result, targets) {
  if (typeof location === 'undefined') return;
  const params = new URLSearchParams(location.search),
    keys = ['connection_id', 'account_id', 'container_id', 'workspace_id'];
  if (params.has('conversion_rules') || params.has('event_identity')) return;
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
function measurementConversionsMarkup(targets) {
  return `<section class="panel workspace-form"><h2>${esc(uiText('LinkedIn conversion settings'))}</h2><p>${esc(uiText('Inspect current conversion rules, attribution windows and configured values for one selected account.'))}</p>${targets.length ? '' : `<p class="notice">${esc(uiText('Connect LinkedIn and select an ad account to inspect conversion settings.'))}</p>`}<form id="measurement-conversions"><label>${esc(uiText('LinkedIn advertising account'))}<select name="target" required><option value="">${esc(uiText('Choose a selected account'))}</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label><button class="button" type="submit">${esc(uiText('Read conversion settings'))}</button></form><div id="measurement-conversions-result"></div></section>`;
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
          (r.enabled !== null && typeof r.enabled !== 'boolean') ||
          [r.post_click_days, r.post_view_days].some(
            v => v !== null && (!Number.isSafeInteger(v) || v < 0 || v > 365),
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
    result.innerHTML = `<h3 id="conversion-settings-heading" tabindex="-1">${esc(uiText('Current conversion configuration'))}</h3><p>${esc(target.label)} · ${esc(date(out.captured_at))}</p><p class="notice">${esc(uiText('These are current rule settings. Campaign links, event delivery, deduplication, consent and historical attribution remain unverified. Omitted fields stay unknown. No rule was changed and no snapshot was saved.'))}</p><label>${esc(uiText('Find a conversion rule'))}<input id="conversion-rule-search" type="search" maxlength="150"></label><div id="conversion-rule-rows"></div>${recordDetails(out, uiText('Conversion configuration source references'))}`;
    mountConversionRuleRows(out.rules, current);
    $('#conversion-settings-heading').focus();
  });
}
function mountConversionRuleRows(rules, selectionCurrent) {
  const root = $('#conversion-rule-rows'),
    field = $('#conversion-rule-search'),
    current = () => root.isConnected && field.isConnected && selectionCurrent(),
    unknown = () => esc(uiText('Unknown')),
    days = value => (value == null ? unknown() : esc(uiText('{count} days', {count: uiNumber(value)}))),
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
        r => !needle || [r.id, r.name, r.type].some(v => typeof v === 'string' && v.toLowerCase().includes(needle)),
      ),
      page = rows.slice(offset, offset + 50);
    root.innerHTML =
      (rows.length
        ? `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Conversion settings, scroll for all fields'))}"><table class="review-table"><caption>${esc(uiText('Native conversion rule settings'))}</caption><thead><tr><th scope="col">${esc(uiText('Conversion rule'))}</th><th scope="col">${esc(uiText('Native conversion type'))}</th><th scope="col">${esc(uiText('Enabled'))}</th><th scope="col">${esc(uiText('Post-click window'))}</th><th scope="col">${esc(uiText('Post-view window'))}</th><th scope="col">${esc(uiText('Attribution model'))}</th><th scope="col">${esc(uiText('Configured conversion value'))}</th></tr></thead><tbody>${page.map(r => `<tr><th scope="row"><span dir="auto">${esc(r.name || uiText('Unnamed conversion'))}</span><br><code dir="ltr">${esc(r.id)}</code></th><td>${r.type == null ? unknown() : `<code dir="ltr">${esc(r.type)}</code>`}</td><td>${esc(r.enabled === true ? uiText('Enabled') : r.enabled === false ? uiText('Disabled') : uiText('Unknown'))}</td><td>${days(r.post_click_days)}</td><td>${days(r.post_view_days)}</td><td>${esc(attribution(r.attribution_type))}</td><td>${r.value == null ? unknown() : `<span dir="ltr">${esc(r.value.amount)} ${esc(r.value.currency)}</span>`}<br>${r.value_type == null ? unknown() : `<code dir="ltr">${esc(r.value_type)}</code>`}</td></tr>`).join('')}</tbody></table></div>`
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
  root.innerHTML = `<section class="workspace-form"><h3>${esc(uiText('Draft additional consent requirements'))}</h3><p id="gtm-consent-draft-help">${esc(uiText('Choose the tags and literal types your policy requires. Existing required types, tag parameters, triggers and paused state are preserved. Preview and saving make no provider changes. Each update needs native review; publishing remains separate.'))}</p><form id="gtm-consent-form" aria-describedby="gtm-consent-draft-help"><label>${esc(uiText('Choose 1–10 tags'))}<select name="tag_ids" multiple size="6" required>${evidence.rows.map(row => `<option value="${esc(row.tag_id)}" ${row.setting === 'unknown' ? 'disabled' : ''}>${esc(row.name ?? row.tag_id)} · ${esc(row.tag_id)} · ${esc(uiGtmConsentSetting(row.setting))}</option>`).join('')}</select></label><label>${esc(uiText('Additional consent types (comma-separated)'))}<input name="required_types" type="text" required maxlength="2020" placeholder="ad_storage, analytics_storage" dir="ltr" autocomplete="off" spellcheck="false"></label><p class="form-note">${esc(uiText('Use 1–20 distinct literal types. Variables and automatic policy selection are unavailable. Unknown native settings need separate inspection.'))}</p><button type="submit" class="button primary">${esc(uiText('Preview consent additions'))}</button></form><div id="gtm-consent-preview"></div></section>`;
  const form = $('#gtm-consent-form'),
    result = $('#gtm-consent-preview'),
    begin = accountWorkflowContext(form, result);
  workspaceBind('#gtm-consent-form', async () => {
    const attemptCurrent = begin(),
      current = () => selectionCurrent() && root.isConnected && attemptCurrent();
    if (!current()) return;
    const tagIds = Array.from(form.elements.tag_ids.selectedOptions, option => option.value),
      types = form.elements.required_types.value.split(/[,،]/).map(value => value.trim());
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
      new Set(types).size !== types.length ||
      types.some(value => !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(value))
    )
      throw Error(
        uiText('Choose 1–20 distinct literal additional-consent types. Variables and duplicate types are refused.'),
      );
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
    const table = `<h4 tabindex="-1" id="gtm-consent-preview-title">${esc(uiText('Review explicit consent additions'))}</h4><p class="notice">${esc(uiText('This is an unapproved workspace proposal. Built-in consent checks, consent defaults and updates, runtime order and event delivery remain unverified.'))}</p><p>${esc(uiText('Preview expires: {date}', {date: uiDate(p.expires_at)}))}</p><div class="data-scroll" role="region" aria-label="${esc(uiText('Consent additions'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('Consent additions'))}</caption><thead><tr><th scope="col">${esc(uiText('Tag'))}</th><th scope="col">${esc(uiText('Original consent setting'))}</th><th scope="col">${esc(uiText('Original required types'))}</th><th scope="col">${esc(uiText('Proposed required types'))}</th><th scope="col">${esc(uiText('Draft change'))}</th></tr></thead><tbody>${p.targets.map(t => `<tr><th scope="row"><bdi dir="auto">${esc(t.name ?? t.tag_id)}</bdi><br><code dir="ltr">${esc(t.tag_id)}</code></th><td>${esc(uiGtmConsentSetting(t.before_setting))}</td><td><code dir="ltr">${esc(t.before_required_types.join(', ') || '—')}</code></td><td><code dir="ltr">${esc(t.proposed_required_types.join(', '))}</code></td><td>${esc(uiText(t.state === 'change' ? 'Add required types' : 'Already required; no step'))}</td></tr>`).join('')}</tbody></table></div>${recordDetails({workspace_path: path, source_hash: p.source_hash, source_references: p.source_references, network_requests: p.network_requests}, uiText('Consent source references'))}`;
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
  return `<section class="panel workspace-form"><h2>${esc(uiText('Inspect a specific GA4 test identifier'))}</h2><p>${esc(uiText('Use an existing event-scoped amcp_test_id custom dimension and a synthetic identifier already sent by your own test instrumentation. AMCP does not register the dimension or send an event.'))}</p><form id="measurement-event-identity"><label>${esc(uiText('GA4 property'))}<select name="target" required><option value="">${esc(uiText('Choose a login and account'))}</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label><label>${esc(uiText('Exact event name'))}<input name="event_name" type="text" maxlength="40" required></label><label>${esc(uiText('Synthetic test identifier'))}<input name="test_id" type="text" maxlength="74" required aria-describedby="measurement-identity-help" dir="ltr"></label><p class="form-note" id="measurement-identity-help">${esc(uiText('Use amcp-test- followed by 8–64 letters, digits or hyphens. Generate a new identifier only before your separate test; enter the original identifier to inspect an existing test.'))}</p><button id="measurement-identity-generate" type="button" class="button small">${esc(uiText('Generate a synthetic test identifier'))}</button><label>${esc(uiText('From date'))}<input name="date_from" type="date" required></label><label>${esc(uiText('To date'))}<input name="date_to" type="date" required></label><p class="form-note">${esc(uiText('Choose at most seven calendar days in the GA4 property timezone. Core reporting may lag; this is not a realtime event trace.'))}</p><label>${esc(uiText('Stream ID (optional)'))}<input name="stream_id" type="text" maxlength="20" inputmode="numeric" dir="ltr"></label><label>${esc(uiText('Your expected count'))}<input name="expected_count" type="number" min="1" max="1000" step="1" value="1" required></label><button type="submit" class="button primary" ${targets.length ? '' : 'disabled'}>${esc(uiText('Read matching test counts'))}</button></form><div id="measurement-event-identity-result" aria-live="polite"></div></section>`;
}
function bindMeasurementEventIdentity(targets) {
  const form = $('#measurement-event-identity'),
    result = $('#measurement-event-identity-result'),
    feedback = measurementReadFeedback(form),
    begin = accountWorkflowContext(form, result);
  if (typeof location !== 'undefined') {
    const p = new URLSearchParams(location.search);
    if (p.has('event_identity')) {
      const keys = [
          'event_identity',
          'account_id',
          'connection_id',
          'event_name',
          'test_id',
          'date_from',
          'date_to',
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
          measurementIdentityPeriod(p.get('date_from'), p.get('date_to')) &&
          /^[1-9][0-9]{0,3}$/.test(p.get('expected_count') ?? '') &&
          Number(p.get('expected_count')) <= 1000 &&
          (!p.has('stream_id') || /^[1-9][0-9]{0,19}$/.test(p.get('stream_id') ?? ''));
      form.elements.target.value = valid ? String(index) : '';
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
      const requirements = {
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
        out.scope.date_from !== requirements.date_from ||
        out.scope.date_to !== requirements.date_to ||
        out.period?.date_from !== requirements.date_from ||
        out.period.date_to !== requirements.date_to ||
        typeof out.period.timezone !== 'string' ||
        !out.period.timezone ||
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
      result.innerHTML = `<h3 id="measurement-identity-heading" tabindex="-1">${esc(uiText('GA4 property {id}', {id: out.scope.property_id}))}</h3><p><bdi dir="auto">${esc(out.scope.event_name)}</bdi> · <bdi dir="ltr">${esc(out.scope.test_id)}</bdi></p><p>${esc(uiText('Property calendar dates'))}: <bdi dir="ltr">${esc(out.period.date_from)} — ${esc(out.period.date_to)}</bdi> · ${esc(uiText('Timezone'))}: <bdi dir="ltr">${esc(out.period.timezone)}</bdi></p><div class="workspace-metrics"><article><strong class="${out.observation.reported_count === null ? 'measurement-count-missing' : ''}"><bdi dir="ltr">${esc(out.observation.reported_count ?? uiText('No count returned'))}</bdi></strong><span>${esc(uiText('Reported matching count'))}</span></article><article><strong><bdi dir="ltr">${esc(out.observation.declared_expected_count)}</bdi></strong><span>${esc(uiText('Your declared expectation'))}</span></article></div><p class="notice">${esc(uiText(measurementIdentityLabels[out.observation.comparison]))}</p><p>${esc(uiText('Matching this test identifier does not establish deduplication, consent, attribution or overall tracking health. Multiple counts are a reason to investigate, not proof of duplicate delivery. Missing or zero counts can reflect processing delays or filters.'))}</p><p class="form-note">${esc(uiText('No event was sent and no snapshot was saved. The existing custom dimension was checked before and after this bounded report.'))}</p><div class="data-scroll" role="region" aria-label="${esc(uiText('Matching test counts by stream'))}" tabindex="0"><table class="review-table"><caption>${esc(uiText('Matching test counts by stream'))}</caption><thead><tr><th scope="col">${esc(uiText('Stream ID'))}</th><th scope="col">${esc(uiText('Reported count'))}</th></tr></thead><tbody>${out.rows.map(r => `<tr><th scope="row"><bdi dir="ltr">${esc(r.stream_id)}</bdi></th><td><bdi dir="ltr">${esc(r.event_count)}</bdi></td></tr>`).join('') || `<tr><td colspan="2">${esc(uiText('No matching test rows were returned.'))}</td></tr>`}</tbody></table></div>${recordDetails(out, uiText('Test scope, source references and unverified checks'))}`;
      $('#measurement-identity-heading').focus();
    } catch (error) {
      if (current()) feedback.show(error);
    }
  });
}
function measurementEventsMarkup(targets) {
  return `<section class="panel workspace-form"><h2>${esc(uiText('Recent GA4 events'))}</h2><p>${esc(uiText('Read aggregate counts for exact event names in one selected property and a recent window. This does not send a test event.'))}</p>
  ${targets.length ? '' : `<p class="notice">${esc(uiText('Connect a GA4 property in Connections to read recent events.'))} <a href="/connections">${esc(uiText('Connections'))}</a></p>`}
  <form id="measurement-events"><label>${esc(uiText('GA4 property'))}<select name="target" required><option value="">${esc(uiText('Choose a login and account'))}</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>
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
function parseProductCSVTable(text) {
  if (text.length > 131072) throw Error(uiText('Use a CSV smaller than 128 KiB and at most 50 products.'));
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
  if (rows.length > 50) throw Error(uiText('Import at most 50 products in each reviewed plan.'));
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
function catalogSourceFields(gateway = 'meta_native_action') {
  if (!['meta_native_action', 'x_ads_native_action'].includes(gateway))
    throw Error(uiText('Choose the exact account.'));
  return gateway === 'meta_native_action' ? [...catalogMapFields, 'retailer_product_group_id'] : catalogMapFields;
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
    default:
      return field;
  }
}
function mapProductCSV(table, settings) {
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
  return table.rows.map((row, index) => {
    const product = Object.fromEntries(
      fields
        .filter(key => columns[key] && row[columns[key]] !== undefined && row[columns[key]] !== '')
        .map(key => [key, row[columns[key]]]),
    );
    if (!columns.currency) product.currency = fixed_currency;
    if (image_mode === 'first_list' && product.image_url) product.image_url = product.image_url.split(',')[0].trim();
    for (const key of [...required, 'currency'])
      if (!product[key]?.trim())
        throw Error(uiText('CSV row {row} has no value for {field}.', {row: index + 1, field: catalogFieldLabel(key)}));
    return product;
  });
}
function catalogMappingMarkup() {
  return `<fieldset id="catalog-csv-mapping"><legend>${esc(uiText('CSV column mapping'))}</legend><label>${esc(uiText('CSV layout'))}<select name="column_mode"><option value="canonical">${esc(uiText('AMCP product columns'))}</option><option value="mapped">${esc(uiText('Map supplier or WooCommerce export columns'))}</option></select></label><div id="catalog-mapping-controls" hidden><button type="button" class="button" id="catalog-load-columns">${esc(uiText('Load columns from the selected file'))}</button><p class="form-note">${esc(uiText('Choose the exact price column and stable retailer ID. Sale dates, tax, stock and product variants are not inferred. Every source row is included.'))}</p><div id="catalog-mapping"></div><label>${esc(uiText('Fixed currency when no currency column is selected'))}<input type="text" name="fixed_currency" maxlength="3" placeholder="SAR"></label><label>${esc(uiText('Image column handling'))}<select name="image_mode"><option value="single">${esc(uiText('One literal image URL per row'))}</option><option value="first_list">${esc(uiText('Use the first URL in a comma-separated image list'))}</option></select></label><p class="form-note">${esc(uiText('Only selected product columns are sent for preview. Blank optional fields are omitted from the request.'))}</p></div></fieldset>`;
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
    grouped = !x && request.products.some(product => product.retailer_product_group_id !== undefined);
  const titles = [
      uiText('Product'),
      uiText('Source price'),
      uiText(x ? 'Native X price' : 'Native hundredths'),
      ...(grouped ? [uiText('Meta product group ID')] : []),
      uiText('Existing retailer IDs'),
    ],
    policy = uiText(
      request.allow_upsert ? 'Explicitly update existing IDs after native review' : 'Create only — refuse existing IDs',
    );
  return `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Products and exact native price units'))}"><table class="review-table"><caption>${esc(uiText('Products and exact native price units'))}</caption><thead><tr>${titles.map(title => `<th scope="col">${esc(title)}</th>`).join('')}</tr></thead><tbody>${request.products.map((product, index) => `<tr><th scope="row"><strong>${esc(product.name)}</strong><br><code>${esc(product.retailer_id)}</code></th><td><bdi>${esc(product.price + ' ' + product.currency)}</bdi></td><td><bdi>${esc(x ? (out.items?.[index]?.native_price ?? uiText('Unknown')) : Number.isSafeInteger(out.items?.[index]?.price_minor_units) ? out.items[index].price_minor_units : uiText('Unknown'))}</bdi></td>${grouped ? `<td><code dir="ltr">${esc(product.retailer_product_group_id ?? uiText('Not supplied'))}</code></td>` : ''}<td>${esc(policy)}</td></tr>`).join('')}</tbody></table></div>`;
}
function catalogComparisonMarkup(out, request, preview) {
  if (request.gateway === 'x_ads_native_action') return xCatalogComparisonMarkup(out, request, preview);
  const invalid = () => {
    throw Error(uiText('Catalog comparison scope or evidence changed. Validate and read the import again.'));
  };
  if (
    !out ||
    out.record_kind !== 'catalog_comparison' ||
    out.complete !== true ||
    out.source_hash !== preview.source_hash ||
    !out.scope ||
    ['gateway', 'account_id', 'connection_id', 'catalog_id'].some(k => out.scope[k] !== request[k]) ||
    !Number.isSafeInteger(out.captured_at) ||
    out.captured_at <= 0 ||
    !Array.isArray(out.items) ||
    out.items.length !== request.products.length ||
    out.item_count !== out.items.length ||
    !Array.isArray(out.review_retailer_ids)
  )
    invalid();
  const counts = {new: 0, changed: 0, matching: 0, unknown: 0, blocked: 0, needs_review: 0},
    review = [];
  out.items.forEach((item, index) => {
    const supplied = request.products[index];
    if (
      !item ||
      item.retailer_id !== supplied.retailer_id ||
      !['new', 'changed', 'matching', 'unknown'].includes(item.state) ||
      typeof item.blocked !== 'boolean' ||
      ![true, false, null].includes(item.price_matches) ||
      !Array.isArray(item.changes) ||
      !Array.isArray(item.unknown_fields) ||
      !item.before ||
      (item.state === 'new'
        ? item.product_id !== null ||
          item.before.present !== false ||
          item.blocked ||
          item.price_matches !== null ||
          item.changes.length ||
          item.unknown_fields.length
        : typeof item.product_id !== 'string' ||
          !/^[1-9][0-9]{0,31}$/.test(item.product_id) ||
          item.before.present !== true ||
          item.before.id !== item.product_id ||
          typeof item.price_matches !== 'boolean') ||
      item.blocked !== (item.state !== 'new' && !request.allow_upsert) ||
      (item.before.price !== undefined && item.before.price !== null && typeof item.before.price !== 'string') ||
      item.unknown_fields.some(k => typeof k !== 'string' || !Object.hasOwn(supplied, k)) ||
      new Set(item.unknown_fields).size !== item.unknown_fields.length ||
      item.changes.some(
        c =>
          !c ||
          typeof c.field !== 'string' ||
          !Object.hasOwn(supplied, c.field) ||
          (c.before !== null && typeof c.before !== 'string') ||
          (c.field === 'price'
            ? !Number.isSafeInteger(c.after_minor_units) ||
              c.after_minor_units !== preview.items[index]?.price_minor_units ||
              c.currency !== supplied.currency
            : c.after !== supplied[c.field]),
      ) ||
      new Set(item.changes.map(c => c.field)).size !== item.changes.length ||
      (item.state === 'matching' &&
        (item.changes.length || item.unknown_fields.length || item.price_matches !== true)) ||
      (item.state === 'changed' && !item.changes.length) ||
      (item.state === 'unknown' && (!item.unknown_fields.length || item.changes.length))
    )
      invalid();
    counts[item.state]++;
    if (item.blocked) counts.blocked++;
    else if (item.state !== 'matching') review.push(item.retailer_id);
  });
  counts.needs_review = review.length;
  if (
    !out.summary ||
    Object.keys(counts).some(k => out.summary[k] !== counts[k]) ||
    review.length !== out.review_retailer_ids.length ||
    review.some((id, i) => out.review_retailer_ids[i] !== id)
  )
    invalid();
  const rows = out.items
    .map((item, index) => {
      const supplied = request.products[index],
        details =
          item.changes
            .map(
              c =>
                `<li>${esc(catalogFieldLabel(c.field))}: ${esc(c.before ?? uiText('Unknown'))} → ${esc(c.field === 'price' ? supplied.price + ' ' + supplied.currency : c.after)}</li>`,
            )
            .join('') +
          item.unknown_fields
            .map(k => `<li>${esc(catalogFieldLabel(k))}: ${esc(uiText('Current value is unknown'))}</li>`)
            .join('');
      return `<tr><th scope="row"><strong>${esc(supplied.name)}</strong><br><code>${esc(item.retailer_id)}</code>${item.product_id ? `<br>${esc(uiText('Product ID'))}: <code class="catalog-product-id" dir="ltr">${esc(item.product_id)}</code>` : ''}</th><td>${esc(catalogComparisonState(item.state))}${item.blocked ? `<p class="form-note">${esc(uiText('Existing product; updates are disabled'))}</p>` : ''}</td><td>${esc(uiText('Current'))}: ${esc(item.before.price ?? uiText('Unknown'))}<br>${esc(uiText('Proposed'))}: <bdi>${esc(supplied.price + ' ' + supplied.currency)}</bdi></td><td>${details ? `<ul>${details}</ul>` : esc(item.state === 'new' ? uiText('No current product was returned') : uiText('All supplied fields have matching evidence'))}</td></tr>`;
    })
    .join('');
  return `<h3 id="catalog-comparison-heading" tabindex="-1">${esc(uiText('Compare current catalog products'))}</h3><p>${esc(uiText('Read {date} · {new} new · {changed} changed · {matching} matching · {unknown} unknown · {blocked} blocked', {date: date(out.captured_at), ...counts}))}</p><p class="notice">${esc(uiText('Only supplied retailer IDs are compared. Formatted native prices are display text; equality uses the native price filter. Unknown fields need review. This is current sequential evidence, not a point-in-time inventory snapshot. Missing source products are not deleted.'))}</p><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Catalog comparison, scroll for all fields'))}"><table class="review-table"><caption>${esc(uiText('Compare current catalog products'))}</caption><thead><tr>${[uiText('Product'), uiText('Comparison'), uiText('Price'), uiText('Field differences')].map(k => `<th scope="col">${esc(k)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div><p>${esc(uiText('{count} products need a fresh native review before execution. Saving a plan does not submit product changes.', {count: review.length}))}</p>${review.length ? `<button type="button" class="button primary" id="save-catalog-changes">${esc(uiText('Save only products needing review'))}</button>` : `<p>${esc(uiText('No eligible product changes need a draft.'))}</p>`}`;
}
function xCatalogComparisonMarkup(out, request, preview) {
  const invalid = () => {
    throw Error(uiText('Catalog comparison scope or evidence changed. Validate and read the import again.'));
  };
  const money = value => {
    const m = typeof value === 'string' ? /^(\d{1,12})(?:\.(\d{1,6}))? ([A-Z]{3})$/.exec(value) : null;
    return m ? m[1].replace(/^0+(?=\d)/, '') + '.' + (m[2] ?? '').replace(/0+$/, '') + ' ' + m[3] : null;
  };
  if (
    !out ||
    out.record_kind !== 'catalog_comparison' ||
    out.complete !== true ||
    out.source_hash !== preview.source_hash ||
    !out.scope ||
    ['gateway', 'account_id', 'connection_id', 'catalog_id'].some(k => out.scope[k] !== request[k]) ||
    request.allow_upsert !== true ||
    !Number.isSafeInteger(out.captured_at) ||
    out.captured_at <= 0 ||
    !Array.isArray(out.items) ||
    out.items.length !== request.products.length ||
    out.item_count !== out.items.length ||
    !Array.isArray(out.review_retailer_ids)
  )
    invalid();
  const counts = {new: 0, changed: 0, matching: 0, unknown: 0, blocked: 0, needs_review: 0},
    review = [],
    fields = ['name', 'image_url', 'url', 'availability', 'condition', 'brand', 'description'];
  out.items.forEach((item, index) => {
    const source = request.products[index];
    if (
      !item ||
      item.retailer_id !== source.retailer_id ||
      !['new', 'changed', 'matching', 'unknown'].includes(item.state) ||
      typeof item.blocked !== 'boolean' ||
      ![true, false, null].includes(item.price_matches) ||
      !Array.isArray(item.changes) ||
      !Array.isArray(item.unknown_fields) ||
      !Array.isArray(item.unsent_fields) ||
      item.unsent_fields.some(
        k =>
          ![
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
          ].includes(k),
      ) ||
      new Set(item.unsent_fields).size !== item.unsent_fields.length ||
      !item.before ||
      (item.before.price !== null && !money(item.before.price))
    )
      invalid();
    const present = item.before.present;
    if (present === true) {
      if (
        typeof item.product_id !== 'string' ||
        !/^[1-9][0-9]{0,24}$/.test(item.product_id) ||
        item.before.id !== item.product_id ||
        item.before.retailer_id !== source.retailer_id ||
        fields.some(k => item.before[k] !== null && typeof item.before[k] !== 'string')
      )
        invalid();
    } else if (item.product_id !== null || item.before.price !== null || ![false, null].includes(present)) invalid();
    if (item.blocked) {
      if (
        item.state !== 'unknown' ||
        item.price_matches !== null ||
        item.changes.length ||
        item.unknown_fields.length !== 1 ||
        item.unknown_fields[0] !== 'retailer_id' ||
        (present === null
          ? item.blocked_reason !== 'hidden_variant'
          : present !== true || !['grouped_product', 'group_status_unknown'].includes(item.blocked_reason))
      )
        invalid();
      counts.blocked++;
    } else {
      if (item.blocked_reason !== null) invalid();
      if (present === false) {
        if (
          item.state !== 'new' ||
          item.price_matches !== null ||
          item.changes.length ||
          item.unknown_fields.length ||
          item.unsent_fields.length
        )
          invalid();
      } else {
        if (present !== true) invalid();
        const unknown = fields.filter(k => item.before[k] === null),
          changes = fields.filter(k => item.before[k] !== null && item.before[k] !== source[k]),
          price =
            item.before.price === null
              ? null
              : money(item.before.price) === money(source.price + ' ' + source.currency);
        if (price === null) unknown.push('price', 'currency');
        else if (!price) changes.push('price');
        if (
          item.price_matches !== price ||
          item.unknown_fields.length !== unknown.length ||
          item.unknown_fields.some((k, i) => k !== unknown[i]) ||
          item.changes.length !== changes.length ||
          item.changes.some(
            (c, i) =>
              !c ||
              c.field !== changes[i] ||
              c.before !== item.before[c.field] ||
              (c.field === 'price'
                ? c.after_native_price !== source.price + ' ' + source.currency
                : c.after !== source[c.field]),
          ) ||
          item.state !== (changes.length ? 'changed' : unknown.length ? 'unknown' : 'matching')
        )
          invalid();
      }
      if (item.state !== 'matching') review.push(item.retailer_id);
    }
    counts[item.state]++;
  });
  counts.needs_review = review.length;
  if (
    !out.summary ||
    Object.keys(counts).some(k => out.summary[k] !== counts[k]) ||
    review.length !== out.review_retailer_ids.length ||
    review.some((id, i) => out.review_retailer_ids[i] !== id)
  )
    invalid();
  const reason = key =>
    key === 'grouped_product'
      ? uiText('Grouped product; native variant updates are outside this import')
      : key === 'hidden_variant'
        ? uiText('Product may be a hidden variant; absence is not established')
        : uiText('Product-group status is unknown; a native update is withheld');
  const rows = out.items
    .map((item, index) => {
      const source = request.products[index],
        details =
          item.changes
            .map(
              c =>
                `<li>${esc(catalogFieldLabel(c.field))}: <bdi>${esc(c.before)}</bdi> → <bdi>${esc(c.field === 'price' ? c.after_native_price : c.after)}</bdi></li>`,
            )
            .join('') +
          item.unknown_fields
            .map(k => `<li>${esc(catalogFieldLabel(k))}: ${esc(uiText('Current value is unknown'))}</li>`)
            .join('');
      return `<tr><th scope="row"><strong>${esc(source.name)}</strong><br><code>${esc(item.retailer_id)}</code>${item.product_id ? `<br>${esc(uiText('Product ID'))}: <code class="catalog-product-id" dir="ltr">${esc(item.product_id)}</code>` : ''}</th><td>${esc(catalogComparisonState(item.state))}${item.blocked ? `<p class="form-note">${esc(reason(item.blocked_reason))}</p>` : ''}</td><td>${esc(uiText('Current'))}: <bdi>${esc(item.before.price ?? uiText('Unknown'))}</bdi><br>${esc(uiText('Proposed'))}: <bdi>${esc(source.price + ' ' + source.currency)}</bdi></td><td>${details ? `<ul>${details}</ul>` : esc(item.state === 'new' ? uiText('No current product was returned') : uiText('All supplied fields have matching evidence'))}${item.unsent_fields.length ? `<p class="form-note">${esc(uiText('Other native attributes have values: {fields}. X does not establish whether an update preserves omitted attributes.', {fields: item.unsent_fields.join(', ')}))}</p>` : ''}</td><td>${!item.blocked && item.before.present === true ? `<label><input type="checkbox" id="catalog-remove-${index}"> ${esc(uiText('Select {retailer_id} for removal', {retailer_id: item.retailer_id}))}</label>` : esc(uiText('Unavailable'))}</td></tr>`;
    })
    .join('');
  return `<h3 id="catalog-comparison-heading" tabindex="-1">${esc(uiText('Compare current catalog products'))}</h3><p>${esc(uiText('Read {date} · {new} new · {changed} changed · {matching} matching · {unknown} unknown · {blocked} blocked', {date: date(out.captured_at), ...counts}))}</p><p class="notice">${esc(uiText('Only supplied X product IDs are returned. Supported decimal prices compare exactly. Grouped or hidden variants are blocked; missing fields remain unknown. Repeated reads are sequential evidence, not a point-in-time inventory snapshot. A saved draft still needs fresh native review. Missing source products are not deleted.'))}</p><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Catalog comparison, scroll for all fields'))}"><table class="review-table"><caption>${esc(uiText('Supplied X product comparison'))}</caption><thead><tr>${[uiText('Product'), uiText('Comparison'), uiText('Price'), uiText('Field differences'), uiText('Select for removal')].map(k => `<th scope="col">${esc(k)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div><p>${esc(uiText('{count} products need a fresh native review before execution. Saving a plan does not submit product changes.', {count: review.length}))}</p>${review.length ? `<button type="button" class="button primary" id="save-catalog-changes">${esc(uiText('Save only products needing review'))}</button>` : `<p>${esc(uiText('No eligible product changes need a draft.'))}</p>`}${out.items.some(item => !item.blocked && item.before.present === true) ? `<p>${esc(uiText('Select only the observed products you intend to remove. Products outside this selection are retained.'))}</p><button type="button" class="button" id="preview-catalog-removal">${esc(uiText('Preview selected removals'))}</button><div id="catalog-removal-preview" aria-live="polite"></div>` : ''}`;
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
function wooCommerceSourcePanelMarkup() {
  const sources = typeof commerceSources === 'undefined' ? [] : commerceSources;
  return `<section class="panel workspace-form"><h2>${esc(uiText('WooCommerce product source'))}</h2><p>${esc(uiText('Read 1–50 explicitly selected published products from a configured store. Choose the intended price field. The first native image is shown; tax, sale activation and variants are not inferred.'))}</p><form id="woo-source">${wooCommerceVariationControlsMarkup()}<label>${esc(uiText('Configured WooCommerce store'))}<select name="target" required><option value="">${esc(uiText('Choose a store'))}</option>${sources.map((item, i) => `<option value="${i}">${esc(item.label)} · ${esc(item.store_origin)}</option>`).join('')}</select></label><label>${esc(uiText('Exact WooCommerce product or variation IDs'))}<textarea name="product_ids" required maxlength="1050" placeholder="101, 102"></textarea></label><label>${esc(uiText('Native source price field'))}<select name="price_field" required><option value="">${esc(uiText('Choose a price field'))}</option><option value="price">${esc(uiText('Current native price'))}</option><option value="regular_price">${esc(uiText('Regular native price'))}</option><option value="sale_price">${esc(uiText('Native sale price field'))}</option></select></label><button class="button" type="submit">${esc(uiText('Read selected source products'))}</button></form>${sources.length ? '' : `<p class="notice">${esc(uiText('No qualified WooCommerce source is configured. A deployment administrator can provision a Read REST API key through encrypted Connections; no key is entered on this page.'))}</p>`}<div id="woo-source-result" aria-live="polite"></div></section>`;
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
        throw Error(uiAccountExplanation(error.message));
      }
    }
  });
}
async function renderCommerce() {
  content.innerHTML += wooCommerceSourcePanelMarkup();
  const targets = accountChoices(['meta', 'x']);
  content.innerHTML += `<section class="panel workspace-form"><h2>${esc(uiText('Reviewed catalog product import'))}</h2><p>${esc(uiText('Import up to 50 supplied products for the selected account and catalog. Ownership is checked during native review. Every item keeps a separate review, receipt and read-back in its saved plan. Missing items are retained.'))}</p><form id="catalog-import"><label>${esc(uiText('Meta or X ad account'))}<select name="target" required><option value="">${esc(uiText('Choose an account'))}</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>${controls(uiText('Native product catalog ID'), 'text', '', 'catalog_id')}${controls(uiText('Import plan name'), 'text', 'Product catalog import', 'name')}<label>${esc(uiText('Product source'))}<select name="source_mode"><option value="csv">${esc(uiText('Product CSV'))}</option><option value="woocommerce">${esc(uiText('Selected WooCommerce products'))}</option></select></label><div id="catalog-csv-controls"><label>${esc(uiText('Product CSV'))}<input type="file" name="file" accept=".csv,text/csv" required></label></div><div id="catalog-woo-selection" class="form-note" aria-live="polite"></div><div id="catalog-destination-help" class="form-note" aria-live="polite"></div>${catalogMappingMarkup()}<label>${esc(uiText('Existing retailer IDs'))}<select name="allow_upsert"><option value="false">${esc(uiText('Create only — refuse existing IDs'))}</option><option value="true">${esc(uiText('Explicitly update existing IDs after native review'))}</option></select></label><button class="button primary" type="submit">${esc(uiText('Validate and preview products'))}</button></form><div id="catalog-preview"></div></section><p class="notice">${esc(uiText('Mapped supplier and WooCommerce exports use the selected Meta or X reviewed product contract. Choose the intended price, currency, image and destination fields. Live store synchronization and additional destinations require separate qualification.'))}</p>`;
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
    $('#catalog-destination-help').innerHTML =
      `<p>${esc(uiText(target?.gateway === 'x_ads_native_action' ? 'This X import requires every mapped product field, including product page, availability, condition, brand and plain text description. It accepts names up to 150 characters and source prices with up to six decimal places. Use exact native availability and condition values. Explicit upsert approval is required.' : target?.gateway === 'meta_native_action' ? 'Required columns: retailer_id, name, price, currency, image_url. Optional: url, availability, condition, brand, description, retailer_product_group_id. Select an exact Meta group column only when your source supplies it; no group is inferred. Price is a decimal amount in the product currency with at most two decimal places. Use HTTPS links.' : 'Choose an account to see the required destination fields.'))}</p>${target?.gateway === 'x_ads_native_action' ? `<p>${esc(uiText('X catalog access requires early-access entitlement. Previewing or saving a draft does not establish eligibility or publish a product.'))}</p>` : ''}`;
  };
  form.elements.target.addEventListener('change', () => {
    resetMapping();
    destinationHelp();
  });
  destinationHelp();
  const handoff = new URLSearchParams(location.search);
  if (handoff.has('catalog_comparison')) {
    const keys = ['catalog_comparison', 'connection_id', 'account_id', 'catalog_id'],
      valid =
        keys.every(k => handoff.getAll(k).length === 1) &&
        handoff.get('catalog_comparison') === '1' &&
        /^[1-9][0-9]{0,31}$/.test(handoff.get('catalog_id') ?? ''),
      selected = valid
        ? targets.findIndex(
            t =>
              t.gateway === 'meta_native_action' &&
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
    if (!file || file.size > 131072) throw Error(uiText('Choose a CSV smaller than 128 KiB.'));
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
    loaded = {file, table, target_key: JSON.stringify([target.gateway, target.account_id, target.connection_id])};
    $('#catalog-mapping').innerHTML =
      `<p>${esc(uiText('{rows} product rows loaded. Review each selected source column.', {rows: table.rows.length}))}</p><div class="work-filter">${fields.map(field => `<label>${esc(catalogFieldLabel(field))}<select id="catalog-map-${field}"><option value="">${esc(uiText('No column selected'))}</option>${table.headers.map(header => `<option value="${esc(header)}">${esc(header)}</option>`).join('')}</select></label>`).join('')}</div>`;
    for (const key of fields) $('#catalog-map-' + key).value = table.headers.includes(key) ? key : '';
  });
  workspaceBind('#catalog-import', async form => {
    const current = begin();
    if (!current()) return;
    const target = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !target) throw Error(uiText('Choose the exact account.'));
    const file = form.elements.file.files[0],
      useWoo = form.elements.source_mode.value === 'woocommerce';
    if (!useWoo && (!file || file.size > 131072)) throw Error(uiText('Choose a CSV smaller than 128 KiB.'));
    const {label, ...binding} = target;
    const settings = {
      ...binding,
      catalog_id: form.elements.catalog_id.value.trim(),
      name: form.elements.name.value.trim(),
      allow_upsert: form.elements.allow_upsert.value === 'true',
    };
    let request, out;
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
        products = mapProductCSV(loaded.table, {
          gateway: binding.gateway,
          columns: Object.fromEntries(catalogSourceFields(binding.gateway).map(k => [k, $('#catalog-map-' + k).value])),
          fixed_currency: form.elements.fixed_currency.value.trim(),
          image_mode: form.elements.image_mode.value,
        });
      } else {
        const text = await file.text();
        if (!current()) return;
        products = parseProductCSV(text, binding.gateway);
      }
      request = {...settings, products};
      out = await workspaceCall('workspace', {action: 'catalog_preview', ...request});
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    result.innerHTML =
      `<button type="button" class="button primary" id="compare-catalog-products">${esc(uiText('Compare current catalog products'))}</button>` +
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
      `<div id="catalog-comparison" aria-live="polite"></div><button class="button" id="create-catalog-plan">${esc(uiText('Save all supplied products for native review'))}</button>`;
    let comparisonSequence = 0;
    workspaceBind('#compare-catalog-products', async () => {
      if (!current()) return;
      const sequence = ++comparisonSequence,
        comparison = $('#catalog-comparison'),
        active = () => current() && sequence === comparisonSequence;
      comparison.innerHTML = `<p role="status">${esc(uiText('Reading supplied retailer IDs. No product changes are submitted.'))}</p>`;
      try {
        const evidence = await workspaceCall('workspace', {action: 'catalog_compare', ...request});
        if (!active()) return;
        const html = catalogComparisonMarkup(evidence, request, out);
        if (!active()) return;
        comparison.innerHTML = html;
        $('#catalog-comparison-heading').focus();
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
        if (evidence.review_retailer_ids.length)
          workspaceBind('#save-catalog-changes', async () => {
            if (!active()) return;
            const selected = new Set(evidence.review_retailer_ids),
              products = request.products.filter(p => selected.has(p.retailer_id));
            if (!products.length) return;
            try {
              const plan = await workspaceCall('workspace', {action: 'catalog_plan', ...request, products});
              if (active()) await navigate('/campaigns?id=' + encodeURIComponent(plan.id));
            } catch (error) {
              if (active()) throw error;
            }
          });
      } catch (error) {
        if (active()) {
          comparison.innerHTML = '';
          throw error;
        }
      }
    });
    workspaceBind('#create-catalog-plan', async () => {
      if (!current()) return;
      try {
        const plan = await workspaceCall('workspace', {action: 'catalog_plan', ...request});
        if (current()) await navigate('/campaigns?id=' + encodeURIComponent(plan.id));
      } catch (error) {
        if (current()) throw error;
      }
    });
  });
}
