'use strict';
// WEB-07: the Live portfolio page (/portfolio): read-only inventory drill-down, inventory comparison, serving
// diagnostics and Google Ads change history. Loaded with web/account-workflows.js; nothing else is needed.
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
// The page body this module provides (web/routes.js).
AMCP.routes.register('/portfolio', {render: renderPortfolio});
