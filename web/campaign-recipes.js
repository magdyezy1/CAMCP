/* Business-input forms share the server recipes. Drafts are kept for this tab and signed-in identity (CMP-06): in
 * memory and in sessionStorage, so in-app navigation and a reload restore them; signing out or switching workspace
 * forgets them. Provider labels and profile text are rendered as data, never HTML or instructions. */
const recipeDrafts = new Map();
// WEB-03: a refusal shows its reason, what to do and its request reference (the shell's errorMessage), not the message
// alone; without the shell (an isolated page script), the message.
const recipeErrorText = e => (typeof errorMessage === 'function' ? errorMessage(e) : String(e?.message ?? ''));
const recipeLabels = {
  name: 'Campaign name',
  daily_budget: 'Daily budget in account currency',
  cpc_bid: 'Maximum cost per click',
  cpc_bid_ceiling: 'Campaign CPC ceiling in account currency',
  target_cpa: 'Target cost per conversion in account currency',
  conversion_goal_policy: 'Conversion goals for this campaign',
  conversion_value_policy: 'Conversion values for this campaign',
  target_roas: 'Target return on ad spend (ratio)',
  country_codes: 'Country codes — one per line',
  country_criterion_ids: 'Google location criterion IDs — one per line',
  language_criterion_ids: 'Google language criterion IDs — one per line',
  page_id: 'Facebook Page ID',
  pixel_id: 'Website pixel ID assigned to this account',
  click_attribution_days: 'Click attribution window',
  view_attribution_days: 'View attribution window',
  destination_url: 'Landing page URL',
  message: 'Ad message',
  headline: 'Image ad headline',
  drive_url: 'Google Drive image link',
  creative_id: 'Existing Snapchat website creative ID',
  optimization_goal: 'Lead-form optimization goal',
  regulated_content: 'Regulated advertising declaration',
  keywords: 'Exact-match keywords — one per line',
  // The TikTok Search pack's keywords carry a match type each (R2.5 M4, package r25-m4-search): one line is MATCH_TYPE: keyword.
  tiktok_search_keywords:
    'TikTok Search keywords — one per line, as MATCH_TYPE: keyword (PRECISE_WORD, PHRASE_WORD or BROAD_WORD)',
  headlines: 'Search ad headlines — one per line (3–15, 30 characters each)',
  descriptions: 'Search ad descriptions — one per line (2–4, 90 characters each)',
  language: 'Ad language',
  start_date: 'Start date in account timezone',
  end_date: 'End date in account timezone',
  start_time: 'Start time in the account timezone',
  end_time: 'End time in the account timezone',
  age_min: 'Minimum age',
  age_max: 'Maximum age',
  tiktok_item_id: 'Existing TikTok post ID',
  identity_type: 'TikTok account identity type',
  identity_id: 'TikTok account identity ID',
  identity_authorized_bc_id: 'Business Center ID of the identity',
  call_to_action: 'Call to action',
  call_to_action_id: 'TikTok dynamic call-to-action portfolio ID',
  optimization_event: 'Purchase event to optimize',
  business_name: 'Business name (25 characters)',
  long_headlines: 'Long headlines — one per line (1–5, 90 characters each)',
  marketing_image_asset_ids: 'Landscape image asset IDs already in the account — one per line',
  square_image_asset_ids: 'Square image asset IDs already in the account — one per line',
  logo_asset_ids: 'Logo asset IDs already in the account — one per line (1–5)',
  location_urns: 'LinkedIn location URNs — one per line',
  locale: 'Campaign locale (language_COUNTRY)',
  post_urn: 'Existing post URN to sponsor',
  lead_form_id: 'Existing lead form ID of this ad account',
  political_intent: 'Political advertising declaration',
};
// location_ids is one field of two providers' packs, each with its own location IDs. One label in recipeLabels named
// TikTok on the Microsoft Search form too (CMP-03 and CMP-07 each added the key, and the later one won). `other` labels
// a playbook's shared default, which applies to every workflow that takes the field.
const recipeLocationLabels = {
  microsoft: 'Microsoft location IDs — one per line',
  tiktok: 'TikTok location IDs — one per line',
  other: 'Location IDs of the workflow’s platform — one per line',
};
// The Performance Max pack (CMP-07) takes its own text counts.
const recipePmaxLabels = {
  headlines: 'Performance Max headlines — one per line (3–15, 30 characters each)',
  descriptions: 'Performance Max descriptions — one per line (2–5, 90 characters each)',
};
const recipeArrays = new Set([
  'location_ids',
  'country_codes',
  'country_criterion_ids',
  'language_criterion_ids',
  'location_ids',
  'keywords',
  'headlines',
  'descriptions',
  'long_headlines',
  'marketing_image_asset_ids',
  'square_image_asset_ids',
  'logo_asset_ids',
  'location_urns',
]);
// The TikTok packs' native call-to-action values and purchase events (src/tiktok-launch-recipes.ts).
const recipeTiktokCtas = [
  'LEARN_MORE',
  'SHOP_NOW',
  'SIGN_UP',
  'CONTACT_US',
  'APPLY_NOW',
  'BOOK_NOW',
  'ORDER_NOW',
  'GET_QUOTE',
  'SUBSCRIBE',
];
// The LinkedIn lead pack's lead form calls to action (src/linkedin-lead-recipe.ts).
const recipeLinkedinCtas = [
  'APPLY',
  'DOWNLOAD',
  'LEARN_MORE',
  'SIGN_UP',
  'SUBSCRIBE',
  'REGISTER',
  'REQUEST_DEMO',
  'VIEW_QUOTE',
  'JOIN',
  'ATTEND',
];
const recipeTiktokEvents = [
  ['SHOPPING', 'Complete payment'],
  ['ON_WEB_ORDER', 'Place an order'],
  ['INITIATE_ORDER', 'Initiate checkout'],
  ['ON_WEB_CART', 'Add to cart'],
];
/** The English label of a brief field for one workflow, or, without one, for every workflow that takes it. */
function recipeFieldLabel(name, recipeId) {
  if (name === 'creative_id' && recipeId === 'snapchat_lead_generation') return 'Existing Snapchat lead creative ID';
  if (recipeId === 'google_performance_max' && recipePmaxLabels[name]) return recipePmaxLabels[name];
  if (name === 'keywords' && recipeId === 'tiktok_search_traffic') return recipeLabels.tiktok_search_keywords;
  if (name === 'location_ids') {
    const platform = String(recipeId ?? '').split('_')[0];
    return platform !== 'other' && Object.hasOwn(recipeLocationLabels, platform)
      ? recipeLocationLabels[platform]
      : recipeLocationLabels.other;
  }
  return recipeLabels[name];
}
/** One item of a list field: a TikTok Search keyword record (a brief saved through MCP) as its line, MATCH_TYPE: keyword; any other item as it is. */
const recipeLine = item =>
  item && typeof item.keyword === 'string' && typeof item.match_type === 'string'
    ? item.match_type + ': ' + item.keyword
    : item;
// R2.5 M4 (package r25-m4-search, the lead's review S3-4): the TikTok Search pack takes 1,000 keywords, one line each. A textarea cuts a longer
// paste at its maxlength without a word, possibly in the middle of a keyword, and 6,000 characters hold about 220 such lines, so this pack's
// keywords box has no length limit: the note under it counts the lines as readRecipeBusiness reads them, and refuses a longer list in words.
const recipeKeywordLimit = 1000;
function recipeKeywordNote(text) {
  const count = String(text ?? '')
    .split(/\r?\n/)
    .filter(line => line.trim()).length;
  const note = uiText('{count} of {limit} keywords', {count: uiNumber(count), limit: uiNumber(recipeKeywordLimit)});
  return count > recipeKeywordLimit
    ? note + ' ' + uiText('Use 1 to 1,000 keywords, each with a keyword and a match type.')
    : note;
}
function recipeField(name, value, required, recipeId) {
  const label = uiText(recipeFieldLabel(name, recipeId) ?? pretty(name)),
    attr = `name="${name}" ${required ? 'required' : ''}`;
  if (name === 'optimization_goal')
    return `<label>${esc(label)}<select ${attr}><option value="">${esc(uiText('Choose explicitly'))}</option><option value="SWIPES" ${value === 'SWIPES' ? 'selected' : ''}>${esc(uiText('Optimize swipes to the lead form'))}</option><option value="LEAD_FORM_SUBMISSIONS" ${value === 'LEAD_FORM_SUBMISSIONS' ? 'selected' : ''}>${esc(uiText('Optimize submitted lead forms'))}</option></select></label>`;
  // TikTok launch packs (CMP-07): native values stay literal; only the explanation is translated.
  if (name === 'identity_type')
    return `<label>${esc(label)}<select ${attr}><option value="">${esc(uiText('Choose explicitly'))}</option><option value="TT_USER" ${value === 'TT_USER' ? 'selected' : ''}>TT_USER — ${esc(uiText('TikTok account linked to this advertiser'))}</option><option value="BC_AUTH_TT" ${value === 'BC_AUTH_TT' ? 'selected' : ''}>BC_AUTH_TT — ${esc(uiText('TikTok account authorized through a Business Center'))}</option></select></label>`;
  if (name === 'call_to_action')
    return `<label>${esc(label)}<select ${attr}><option value="">${esc(uiText('Choose explicitly'))}</option>${(recipeId === 'linkedin_lead_generation' ? recipeLinkedinCtas : recipeTiktokCtas).map(v => `<option value="${v}" ${value === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>`;
  if (name === 'optimization_event')
    return `<label>${esc(label)}<select ${attr}><option value="">${esc(uiText('Choose explicitly'))}</option>${recipeTiktokEvents.map(([v, text]) => `<option value="${v}" ${value === v ? 'selected' : ''}>${v} — ${esc(uiText(text))}</option>`).join('')}</select></label>`;
  // LinkedIn lead generation (CMP-07): the explicit political-advertising declaration; NOT_POLITICAL is the only choice.
  if (name === 'political_intent')
    return `<label>${esc(label)}<select ${attr}><option value="">${esc(uiText('Choose explicitly'))}</option><option value="NOT_POLITICAL" ${value === 'NOT_POLITICAL' ? 'selected' : ''}>NOT_POLITICAL — ${esc(uiText('Not political advertising'))}</option></select><small>${esc(uiText('Political advertising needs a tailored native plan.'))}</small></label>`;
  if (name === 'conversion_goal_policy')
    return `<label>${esc(label)}<select ${attr}><option value="">${esc(uiText('Choose explicitly'))}</option><option value="ACCOUNT_DEFAULT" ${value === 'ACCOUNT_DEFAULT' ? 'selected' : ''}>${esc(uiText('Use the account-default conversion goals'))}</option></select></label>`;
  if (name === 'conversion_value_policy')
    return `<label>${esc(label)}<select ${attr}><option value="">${esc(uiText('Choose explicitly'))}</option><option value="ACCOUNT_RECORDED_VALUES" ${value === 'ACCOUNT_RECORDED_VALUES' ? 'selected' : ''}>${esc(uiText('Use the values recorded by the account'))}</option></select></label>`;
  if (name === 'target_roas')
    return `<label>${esc(label)}<input ${attr} type="text" inputmode="decimal" maxlength="15" value="${esc(value ?? '')}"><small>${esc(uiText('Enter a ratio from 0.01 to 1000; 3.5 means 350%.'))}</small></label>`;
  if (name === 'regulated_content')
    return `<label>${esc(label)}<select ${attr}><option value="">${esc(uiText('Choose explicitly'))}</option><option value="false" ${String(value) === 'false' ? 'selected' : ''}>${esc(uiText('No regulated content'))}</option><option value="true" ${String(value) === 'true' ? 'selected' : ''}>${esc(uiText('Regulated content applies — use a tailored plan'))}</option></select></label>`;
  if (name === 'click_attribution_days' || name === 'view_attribution_days') {
    const options =
      name === 'click_attribution_days'
        ? [
            ['1', uiText('1 day after a click')],
            ['7', uiText('7 days after a click')],
          ]
        : [
            ['0', uiText('Exclude view-through attribution')],
            ['1', uiText('1 day after a view')],
          ];
    return `<label>${esc(label)}<select ${attr}><option value="">${esc(uiText('Choose explicitly'))}</option>${options.map(([v, label]) => `<option value="${v}" ${String(value) === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`;
  }
  if (name === 'special_ad_categories')
    return `<label>${esc(uiText('Special ad category'))}<select ${attr}><option value="">${esc(uiText('Choose explicitly'))}</option><option value="none" ${value === 'none' || (Array.isArray(value) && !value.length) ? 'selected' : ''}>${esc(uiText('None apply'))}</option><option value="regulated" ${value?.length ? 'selected' : ''}>${esc(uiText('A regulated category applies — use a tailored plan'))}</option></select></label>`;
  if (name === 'contains_eu_political_advertising')
    return `<label>${esc(uiText('EU political advertising declaration'))}<select ${attr}><option value="">${esc(uiText('Choose explicitly'))}</option>${['DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', 'CONTAINS_EU_POLITICAL_ADVERTISING'].map(v => `<option value="${v}" ${value === v ? 'selected' : ''}>${v.startsWith('DOES_NOT') ? uiText('Does not contain EU political advertising') : uiText('Contains EU political advertising')}</option>`).join('')}</select></label>`;
  // A schedule time is picked as a wall-clock time in the account timezone and sent with its offset (CMP-06).
  if (name === 'start_time' || name === 'end_time')
    return `<label>${esc(label)}<input name="${name}_local" ${required ? 'required' : ''} type="datetime-local" step="60" value="${esc(recipeLocalTime(value))}"></label>`;
  if (name === 'age_min' || name === 'age_max')
    return `<label>${esc(label)}<input ${attr} type="number" min="13" max="65" step="1" inputmode="numeric" placeholder="${name === 'age_min' ? '18' : '65'}" value="${esc(value ?? '')}"></label>`;
  const text = Array.isArray(value) ? value.map(recipeLine).join('\n') : (value ?? '');
  if (name === 'keywords' && recipeId === 'tiktok_search_traffic')
    return `<label>${esc(label)}<textarea name="keywords" ${required ? 'required' : ''} rows="8" aria-describedby="recipe-keyword-count">${esc(text)}</textarea><small id="recipe-keyword-count" role="status" aria-live="polite">${esc(recipeKeywordNote(text))}</small></label>`;
  if (recipeArrays.has(name) || name === 'message')
    return `<label>${esc(label)}<textarea ${attr} rows="3" maxlength="6000">${esc(text)}</textarea></label>`;
  return `<label>${esc(label)}<input ${attr} type="${name.endsWith('_url') ? 'url' : name.endsWith('_date') ? 'date' : 'text'}" value="${esc(text)}" ${['daily_budget', 'cpc_bid', 'cpc_bid_ceiling', 'target_cpa'].includes(name) ? 'inputmode="decimal"' : ''} maxlength="2048"></label>`;
}
// CMP-03: the Microsoft location lookup of the Search pack's brief, from Microsoft's geographical locations file. It is
// offered only when recipe_context says this deployment can send its request (the GetGeoLocationsFileUrl page is
// pinned). Names, types and statuses stay literal; only AMCP's own explanations are translated.
function recipeMicrosoftLocationLookup() {
  return html`<details id="recipe-ms-locations"><summary>${uiText('Find Microsoft location IDs')}</summary><label>${uiText('Location name')}<input id="recipe-ms-location-query" maxlength="80" autocomplete="off" enterkeyhint="search"></label><div class="dialog-actions"><button type="button" class="button" id="recipe-ms-location-search">${uiText('Find locations')}</button><button type="button" class="button" id="recipe-ms-location-check">${uiText('Check the entered IDs')}</button></div><p class="form-note">${uiText('Microsoft names its locations in English. Several IDs can share a name, so check the type.')}</p><div id="recipe-ms-location-results" aria-live="polite"></div></details>`;
}
// Why a location is not offered, from its status in the file (src/microsoft-locations.ts).
const recipeMicrosoftLocationReasons = {
  pending_deprecation:
    'Microsoft marks this location as pending deprecation, and its pages disagree on whether it still targets. Choose an Active location.',
  deprecated: 'Microsoft marks this location as deprecated, so it cannot be added.',
  status_unknown: 'Microsoft’s file gives this location a status AMCP does not know, so it is not offered.',
  status_not_in_file:
    'Microsoft’s file has no status column, so AMCP cannot tell whether this location is deprecated. Check it in Microsoft Advertising.',
};
/** A lookup answer of the mode asked for, with exact numeric IDs, at most its bound, and no change made. */
function recipeMicrosoftLocationsValid(out, mode, ids = []) {
  const id = v => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v);
  return (
    out?.kind === 'microsoft_location' &&
    out.mode === mode &&
    out.provider_mutations === 0 &&
    Array.isArray(out.results) &&
    out.results.length <= (mode === 'search' ? 20 : 100) &&
    out.results.every(
      r =>
        id(r?.location_id) &&
        typeof r.display_name === 'string' &&
        typeof r.selectable === 'boolean' &&
        (r.reason === undefined || Object.hasOwn(recipeMicrosoftLocationReasons, r.reason)),
    ) &&
    (mode === 'search'
      ? Number.isSafeInteger(out.match_count) && out.match_count >= out.results.length
      : // A check answers for exactly the IDs entered: each one found or missing, once.
        Array.isArray(out.missing_ids) &&
        out.missing_ids.every(id) &&
        JSON.stringify([...out.results.map(r => r.location_id), ...out.missing_ids].sort()) ===
          JSON.stringify([...ids].sort()))
  );
}
// Microsoft's names, types, statuses and IDs arrive as text: escape-by-default markup (WEB-07).
function recipeMicrosoftLocationsView(out) {
  const native = v => (v === null || v === undefined ? uiText('Unknown') : html`<bdi dir="auto">${v}</bdi>`),
    // A search offers Add for a location that may be added; a check names the entered IDs to replace.
    rows = out.results.map(
      r =>
        html`<li><span><bdi dir="auto">${r.display_name}</bdi> · <code dir="ltr">${r.location_id}</code> · ${native(r.location_type)} · ${native(r.status)}</span>${out.mode === 'search' && r.selectable ? html`<button type="button" class="button small" data-ms-location="${r.location_id}" aria-label="${uiText('Add {name} ({id})', {name: r.display_name, id: r.location_id})}">${uiText('Add')}</button>` : ''}${r.reason ? html`<small>${uiText(recipeMicrosoftLocationReasons[r.reason])}</small>` : ''}</li>`,
    ),
    summary =
      out.mode === 'search'
        ? out.results.length
          ? uiText('{shown} of {total} shown.', {shown: uiNumber(out.results.length), total: uiNumber(out.match_count)})
          : uiText('No Microsoft location has this name. Try another spelling, in English.')
        : uiText('{found} of {total} location IDs are in Microsoft’s file.', {
            found: uiNumber(out.results.length),
            total: uiNumber(out.results.length + out.missing_ids.length),
          });
  return html`<p class="form-note">${summary}</p>${rows.length ? html`<ul class="recipe-location-results">${rows}</ul>` : ''}${out.missing_ids?.length ? html`<p class="notice">${uiText('Not in Microsoft’s geographical locations file:')} ${out.missing_ids.map((v, index) => html`${index ? ', ' : ''}<code dir="ltr">${v}</code>`)}</p>` : ''}`;
}
function readRecipeBusiness(form) {
  const v = Object.fromEntries(new FormData(form)),
    target = v.target ? JSON.parse(v.target) : {};
  delete v.target;
  for (const [k, value] of Object.entries(v))
    if (value === '') delete v[k];
    else if (recipeArrays.has(k))
      v[k] = value
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);
  if (v.special_ad_categories === 'none') v.special_ad_categories = [];
  else if (v.special_ad_categories === 'regulated')
    throw Error(
      uiText(
        'Use a tailored native plan for regulated categories; this website recipe does not set compliant targeting.',
      ),
    );
  if (v.regulated_content === 'false' || v.regulated_content === 'true')
    v.regulated_content = v.regulated_content === 'true';
  // The image comes from the one source chosen; the playbook-rule choice travels beside the brief (CMP-06).
  if (recipeImageSources.some(([key]) => key === v.image_source) && typeof v.image_value === 'string')
    v[v.image_source] = v.image_value.trim();
  for (const key of ['image_source', 'image_value', 'apply_playbook_rules', 'playbook_rules_seen']) delete v[key];
  const zone = v.schedule_timezone || 'UTC';
  delete v.schedule_timezone;
  for (const k of ['start_time', 'end_time'])
    if (v[k + '_local'] !== undefined) {
      v[k] = recipeOffsetTime(v[k + '_local'], zone);
      delete v[k + '_local'];
    }
  return {...v, ...target};
}
const recipeDependencyLabels = {
  page_identity: 'Facebook Page access',
  media_receipt: 'Uploaded media receipt',
  landing_page: 'Landing page acceptance',
  account_currency: 'Account currency',
  account_owned_pixel: 'Account-owned pixel',
  conversion_event_delivery: 'Conversion event delivery',
  attribution_window: 'Attribution window',
  location_criteria: 'Location targeting',
  language_criteria: 'Google language targeting',
  campaign_cpc_ceiling: 'Campaign CPC ceiling',
  account_default_conversion_goals: 'Current account-default conversion goals',
  primary_conversion_actions: 'Enabled primary conversion actions',
  campaign_target_cpa: 'Campaign target cost per conversion',
  conversion_value_policy: 'Chosen conversion value policy',
  conversion_value_configuration: 'Current primary-action value settings',
  reported_conversion_activity: 'Last reported conversion activity',
  conversion_value_delivery: 'Delivered conversion values',
  conversion_history_eligibility: 'Conversion history for value bidding',
  campaign_target_roas: 'Campaign target return on ad spend',
  provider_objective_acceptance: 'Provider objective acceptance',
  existing_website_creative: 'Existing account-owned website creative',
  country_targeting: 'Country targeting',
  automatic_swipe_bidding: 'Automatic bidding for swipes',
  existing_lead_creative: 'Existing account-owned lead creative',
  existing_lead_form: 'Original account-owned lead form',
  lead_form_policy_acceptance: 'Lead-form privacy and consent acceptance',
  lead_optimization_goal: 'Lead-form optimization goal',
  tiktok_spark_identity: 'TikTok account identity for Spark Ads',
  existing_tiktok_post: 'Existing TikTok post of the identity',
  dynamic_cta_portfolio: 'TikTok dynamic call-to-action portfolio',
  location_targeting: 'Location targeting',
  automatic_click_bidding: 'Automatic bidding for clicks',
  automatic_traffic_bidding: 'Automatic bidding for the chosen traffic goal',
  automatic_conversion_bidding: 'Automatic bidding for purchases',
  search_keywords: 'Search keywords and match types',
  search_ads_allowlist: 'TikTok Search Ads allowlist for this objective',
  smart_plus_search_allowlist: 'TikTok Smart+ Search allowlist for this objective',
  automatic_search_bidding: 'Automatic bidding for the chosen Search goal',
  existing_image_assets: 'Existing image and logo assets of the account',
  pmax_asset_minimums: 'Performance Max asset minimums',
  existing_linkedin_post: 'Existing post to sponsor',
  linkedin_lead_form: 'Account-owned LinkedIn lead form',
  automatic_lead_bidding: 'Maximum delivery for leads',
};
const recipeEligibilityLabels = {
  ready: 'Confirmed for this check',
  blocked: 'Blocked',
  unknown: 'Needs further verification',
  needs_user_input: 'Complete the brief',
};
function conversionRecipePreview(out) {
  if (['snapchat_website_traffic', 'snapchat_lead_generation'].includes(out.recipe?.id))
    return snapchatTrafficPreview(out);
  if (['tiktok_website_traffic', 'tiktok_website_conversions'].includes(out.recipe?.id))
    return tiktokLaunchPreview(out);
  if (out.recipe?.id === 'linkedin_lead_generation') return linkedinLeadPreview(out);
  if (out.recipe?.id === 'google_performance_max') return pmaxLaunchPreview(out);
  const recipe = out.recipe,
    plan = out.plan,
    valueBidding = ['google_search_conversion_value', 'google_search_target_roas'].includes(recipe?.id),
    details = () => recordDetails(out, uiText('Compiled plan and input provenance'));
  if (
    out.ready !== true ||
    out.provider_mutations !== 0 ||
    ![
      'google_search_conversions',
      'google_search_target_cpa',
      'google_search_conversion_value',
      'google_search_target_roas',
    ].includes(recipe?.id) ||
    recipe.conversion_goal_policy !== 'ACCOUNT_DEFAULT' ||
    recipe.bidding_strategy !== (valueBidding ? 'MAXIMIZE_CONVERSION_VALUE' : 'MAXIMIZE_CONVERSIONS') ||
    (valueBidding && recipe.conversion_value_policy !== 'ACCOUNT_RECORDED_VALUES') ||
    !/^[A-Z]{3}$/.test(recipe.currency) ||
    !Array.isArray(plan?.steps) ||
    !plan.steps.length
  )
    return details();
  // A Google recipe is one all-or-nothing build by default (CMP-04), or one step per resource with atomic: false.
  const build =
      plan.steps.length === 1 && plan.steps[0].id === 'build'
        ? plan.steps[0].arguments?.payload?.mutate_operations
        : undefined,
    buildCreate = key => (Array.isArray(build) ? build.find(o => o?.[key])?.[key]?.create : undefined),
    campaignStep = build ? plan.steps[0] : plan.steps.find(s => s.id === 'campaign'),
    budgetStep = plan.steps.find(s => s.id === 'budget'),
    campaign = build ? buildCreate('campaign_operation') : campaignStep?.arguments?.payload?.operations?.[0]?.create,
    budget = build ? buildCreate('campaign_budget_operation') : budgetStep?.arguments?.payload?.operations?.[0]?.create;
  const amount = value =>
    typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
  const strategy = valueBidding ? campaign?.maximize_conversion_value : campaign?.maximize_conversions,
    target = valueBidding ? strategy?.target_roas : strategy?.target_cpa_micros,
    wantsTarget = valueBidding ? recipe.id === 'google_search_target_roas' : recipe.id === 'google_search_target_cpa',
    ratio = value =>
      typeof value === 'string' &&
      /^(?:0|[1-9]\d{0,3})(?:\.\d{1,6})?$/.test(value) &&
      Number(value) >= 0.01 &&
      Number(value) <= 1000;
  if (
    campaign?.status !== 'PAUSED' ||
    campaign.advertising_channel_type !== 'SEARCH' ||
    !strategy ||
    typeof strategy !== 'object' ||
    Array.isArray(strategy) ||
    Object.keys(strategy).some(key => key !== (valueBidding ? 'target_roas' : 'target_cpa_micros')) ||
    (valueBidding &&
      (campaign.maximize_conversions !== undefined ||
        campaign.target_roas !== undefined ||
        campaign.target_cpa !== undefined ||
        campaign.manual_cpc !== undefined ||
        campaign.target_spend !== undefined ||
        campaign.bidding_strategy !== undefined)) ||
    !amount(budget?.amount_micros) ||
    budget.explicitly_shared !== false ||
    (wantsTarget
      ? valueBidding
        ? typeof target !== 'number' || !ratio(recipe.target_roas) || target !== Number(recipe.target_roas)
        : !amount(target) || target !== recipe.target_cpa_micros
      : Object.keys(strategy).length !== 0 ||
        (valueBidding ? recipe.target_roas !== undefined : recipe.target_cpa_micros !== undefined)) ||
    // A build names its account in every temporary resource name; any other customer is not this preview's.
    (build &&
      !(JSON.stringify(build).match(/customers\/[^/"]*\//g) ?? []).every(
        m => m === 'customers/' + String(campaignStep.account_id).replace(/-/g, '') + '/',
      )) ||
    !plan.steps.every(
      s =>
        s.kind === 'write' &&
        s.gateway === 'google_ads_native_action' &&
        s.account_id === campaignStep.account_id &&
        s.connection_id === campaignStep.connection_id &&
        s.expected_currency === recipe.currency,
    )
  )
    return details();
  const decimal = value => {
    const n = BigInt(value),
      fraction = (n % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
    return (n / 1000000n).toString() + (fraction ? '.' + fraction : '') + ' ' + recipe.currency;
  };
  const heading = uiText(
      valueBidding ? 'Paused conversion-value campaign preview' : 'Paused conversion campaign preview',
    ),
    percentage = text => {
      const [whole, fraction = ''] = text.split('.'),
        units = (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))) * 100n,
        tail = (units % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
      return (units / 1000000n).toString() + (tail ? '.' + tail : '') + '%';
    },
    targetRow = valueBidding
      ? `<div><dt>${esc(uiText('Target return on ad spend (ratio)'))}</dt><dd>${wantsTarget ? `<bdi dir="ltr">${esc(recipe.target_roas)}× · ${esc(percentage(recipe.target_roas))}</bdi>` : esc(uiText('No target ROAS'))}</dd></div><div><dt>${esc(uiText('Conversion values for this campaign'))}</dt><dd>${esc(uiText('Use the values recorded by the account'))}</dd></div>`
      : `<div><dt>${esc(uiText('Target cost per conversion in account currency'))}</dt><dd>${wantsTarget ? `<bdi dir="ltr">${esc(decimal(target))}</bdi> · ${esc(uiText('Native micros'))}: <code dir="ltr">${esc(target)}</code>` : esc(uiText('No target CPA'))}</dd></div>`;
  return `<section aria-label="${esc(heading)}" class="conversion-recipe-preview"><h3>${esc(heading)}</h3><p>${esc(uiText('Local preview only. No plan is saved and no advertising changes are sent.'))}</p><dl><div><dt>${esc(uiText('Campaign name'))}</dt><dd><bdi dir="auto">${esc(plan.name)}</bdi></dd></div><div><dt>${esc(uiText('Advertising login and account'))}</dt><dd><code dir="ltr">${esc(campaignStep.connection_id)}</code> · <code dir="ltr">${esc(campaignStep.account_id)}</code></dd></div><div><dt>${esc(uiText('Daily budget in account currency'))}</dt><dd><bdi dir="ltr">${esc(decimal(budget.amount_micros))}</bdi> · ${esc(uiText('Native micros'))}: <code dir="ltr">${esc(budget.amount_micros)}</code></dd></div><div><dt>${esc(uiText('Bidding strategy'))}</dt><dd>${esc(uiText(valueBidding ? 'Maximize Conversion Value' : 'Maximize Conversions'))}</dd></div>${targetRow}<div><dt>${esc(uiText('Conversion goals for this campaign'))}</dt><dd>${esc(uiText('Use the account-default conversion goals'))}</dd></div></dl><p class="notice">${esc(uiText(valueBidding ? 'Recorded values, conversion history and provider eligibility need verification before activation.' : 'Goal settings, primary conversion actions, event delivery and provider eligibility still need verification before activation.'))}</p><p>${esc(uiText(valueBidding ? 'A target ROAS is an average value-to-spend ratio, not a minimum guaranteed return or spending cap.' : 'A target CPA is an average optimization target, not a per-conversion spending cap or guarantee.'))}</p>${details()}</section>`;
}
function snapchatTrafficPreview(out) {
  const r = out.recipe,
    leads = r?.id === 'snapchat_lead_generation',
    plan = out.plan,
    steps = plan?.steps,
    details = () => recordDetails(out, uiText('Compiled plan and input provenance'));
  if (
    out.ready !== true ||
    out.provider_mutations !== 0 ||
    !/^[A-Z]{3}$/.test(r?.currency) ||
    !Array.isArray(steps) ||
    steps.length !== 3
  )
    return details();
  const campaign = steps[0]?.arguments?.payload?.campaigns?.[0],
    squad = steps[1]?.arguments?.payload?.adsquads?.[0],
    ad = steps[2]?.arguments?.payload?.ads?.[0],
    budget = r.daily_budget_micro;
  if (
    steps.map(s => s.id).join(',') !== 'campaign,squad,ad' ||
    steps.map(s => s.arguments?.action).join(',') !==
      'snapchat_campaign_create,snapchat_adsquad_create,snapchat_ad_create' ||
    !steps.every(
      s =>
        s.kind === 'write' &&
        s.gateway === 'snapchat_native_action' &&
        s.account_id === steps[0].account_id &&
        s.connection_id === steps[0].connection_id &&
        s.expected_currency === r.currency,
    ) ||
    ![campaign, squad, ad].every(v => v?.status === 'PAUSED') ||
    campaign.objective_v2_properties?.objective_v2_type !== (leads ? 'LEADS' : 'TRAFFIC') ||
    squad.child_ad_type !== (leads ? 'LEAD_GENERATION' : 'REMOTE_WEBPAGE') ||
    r.bidding_strategy !== 'AUTO_BID' ||
    squad.bid_strategy !== 'AUTO_BID' ||
    squad.optimization_goal !== r.optimization_goal ||
    !(leads ? ['SWIPES', 'LEAD_FORM_SUBMISSIONS'] : ['SWIPES']).includes(squad.optimization_goal) ||
    squad.daily_budget_micro !== budget ||
    typeof budget !== 'string' ||
    !/^[1-9]\d{0,15}$/.test(budget) ||
    BigInt(budget) < 5000000n ||
    BigInt(budget) > BigInt(Number.MAX_SAFE_INTEGER) ||
    ad.type !== (leads ? 'LEAD_GENERATION' : 'REMOTE_WEBPAGE') ||
    ad.creative_id !== r.creative_id ||
    typeof ad.creative_id !== 'string' ||
    !Array.isArray(squad.targeting?.geos) ||
    !squad.targeting.geos.length ||
    squad.targeting.geos.length > 20
  )
    return details();
  const n = BigInt(budget),
    fraction = (n % 1000000n).toString().padStart(6, '0').replace(/0+$/, ''),
    amount = (n / 1000000n).toString() + (fraction ? '.' + fraction : '') + ' ' + r.currency,
    row = (label, value, direction = 'auto') =>
      `<div><dt>${esc(uiText(label))}</dt><dd><bdi dir="${direction}">${esc(value)}</bdi></dd></div>`;
  return `<section aria-label="${esc(uiText(leads ? 'Paused Snapchat lead-form preview' : 'Paused Snapchat traffic preview'))}" class="conversion-recipe-preview"><h3>${esc(uiText(leads ? 'Paused Snapchat lead-form preview' : 'Paused Snapchat traffic preview'))}</h3><p>${esc(uiText('Local preview only. No plan is saved and no advertising changes are sent.'))}</p><dl>${row('Campaign name', plan.name)}${row('Advertising login and account', steps[0].connection_id + ' · ' + steps[0].account_id, 'ltr')}${row('Daily budget in account currency', amount, 'ltr')}${row('Native micros', budget, 'ltr')}${row(leads ? 'Existing Snapchat lead creative ID' : 'Existing Snapchat website creative ID', ad.creative_id, 'ltr')}${row('Country targeting', squad.targeting.geos.map(g => String(g.country_code).toUpperCase()).join(', '), 'ltr')}${row('Start timestamp with UTC offset', campaign.start_time, 'ltr')}${campaign.end_time ? row('End timestamp with UTC offset', campaign.end_time, 'ltr') : ''}${row('Bidding strategy', uiText(leads ? 'Automatic bidding' : 'Automatic bidding for swipes'))}${leads ? row('Lead-form optimization goal', uiText(r.optimization_goal === 'SWIPES' ? 'Optimize swipes to the lead form' : 'Optimize submitted lead forms')) : ''}</dl><p class="notice">${esc(uiText(leads ? 'Creates three paused entities using an existing lead creative and its original form. Preflight reads both account-owned dependencies without submitted leads. Provider approval, privacy and consent acceptance and objective eligibility remain unverified.' : 'Creates three paused entities. Existing creative media and destination remain unchanged. Preflight checks current creative ownership, type and destination syntax; provider approval, destination availability and objective acceptance remain unverified.'))}</p><p>${esc(uiText(leads ? 'Automatic bidding uses the daily budget for your chosen optimization goal. It does not guarantee a cost per lead or result. Activation requires a separate review.' : 'Automatic bidding uses the daily budget to optimize swipes. It does not guarantee a cost per result. Activation requires a separate review.'))}</p><p>${esc(uiText('Snapchat does not return automatic placement settings on GET. Native review retains this verification limitation.'))}</p>${details()}</section>`;
}
/** The paused TikTok launch preview (CMP-07): shown only when the compiled plan is exactly the pack's three creates. */
function tiktokLaunchPreview(out) {
  const r = out.recipe,
    purchases = r?.id === 'tiktok_website_conversions',
    plan = out.plan,
    steps = plan?.steps,
    details = () => recordDetails(out, uiText('Compiled plan and input provenance'));
  if (
    out.ready !== true ||
    out.provider_mutations !== 0 ||
    !/^[A-Z]{3}$/.test(r?.currency) ||
    !Array.isArray(steps) ||
    steps.length !== 3
  )
    return details();
  const campaign = steps[0]?.arguments?.payload,
    group = steps[1]?.arguments?.payload,
    ad = steps[2]?.arguments?.payload?.creatives?.[0];
  if (
    steps.map(s => s.id).join(',') !== 'campaign,adgroup,ad' ||
    steps.map(s => s.arguments?.action).join(',') !== 'tiktok_campaign_create,tiktok_adgroup_create,tiktok_ad_create' ||
    !steps.every(
      s =>
        s.kind === 'write' &&
        s.gateway === 'tiktok_native_action' &&
        s.account_id === steps[0].account_id &&
        s.connection_id === steps[0].connection_id &&
        s.expected_currency === r.currency,
    ) ||
    campaign?.operation_status !== 'DISABLE' ||
    campaign.objective_type !== (purchases ? 'WEB_CONVERSIONS' : 'TRAFFIC') ||
    group?.operation_status !== 'ENABLE' ||
    ad?.operation_status !== 'ENABLE' ||
    steps[2].arguments.payload.creatives.length !== 1 ||
    group.budget_mode !== 'BUDGET_MODE_DAY' ||
    typeof r.daily_budget !== 'string' ||
    !/^\d{1,9}(?:\.\d{1,2})?$/.test(r.daily_budget) ||
    group.budget !== Number(r.daily_budget) ||
    group.bid_type !== 'BID_TYPE_NO_BID' ||
    group.optimization_goal !== (purchases ? 'CONVERT' : 'CLICK') ||
    (purchases && (group.pixel_id !== r.pixel_id || group.optimization_event !== r.optimization_event)) ||
    !Array.isArray(group.location_ids) ||
    !group.location_ids.length ||
    group.location_ids.length > 20 ||
    ad.tiktok_item_id !== r.creative?.tiktok_item_id ||
    ad.identity_id !== r.creative?.identity_id
  )
    return details();
  const row = (label, value, direction = 'auto') =>
    `<div><dt>${esc(uiText(label))}</dt><dd><bdi dir="${direction}">${esc(value)}</bdi></dd></div>`;
  const title = purchases ? 'Paused TikTok website purchases preview' : 'Paused TikTok website traffic preview';
  return `<section aria-label="${esc(uiText(title))}" class="conversion-recipe-preview"><h3>${esc(uiText(title))}</h3><p>${esc(uiText('Local preview only. No plan is saved and no advertising changes are sent.'))}</p><dl>${row('Campaign name', plan.name)}${row('Advertising login and account', steps[0].connection_id + ' · ' + steps[0].account_id, 'ltr')}${row('Daily budget in account currency', r.daily_budget + ' ' + r.currency, 'ltr')}${row('Existing TikTok post ID', ad.tiktok_item_id, 'ltr')}${row('TikTok account identity', ad.identity_type + ' · ' + ad.identity_id, 'ltr')}${row('TikTok location IDs', group.location_ids.join(', '), 'ltr')}${row('Start time sent to TikTok (UTC)', group.schedule_start_time, 'ltr')}${group.schedule_end_time ? row('End time sent to TikTok (UTC)', group.schedule_end_time, 'ltr') : ''}${row('Call to action', ad.call_to_action, 'ltr')}${purchases ? row('Purchase event to optimize', group.pixel_id + ' · ' + group.optimization_event, 'ltr') : ''}</dl><p class="notice">${esc(uiText(purchases ? 'Creates a disabled campaign with an ad group and Spark Ad under it. Preflight reads the identity, post and pixel of this advertiser; event delivery, ad review and objective acceptance remain unverified.' : 'Creates a disabled campaign with an ad group and Spark Ad under it. Preflight reads the identity and post of this advertiser; ad review and objective acceptance remain unverified.'))}</p><p>${esc(uiText(purchases ? 'Maximum delivery uses the daily budget to seek the chosen purchase event. It does not guarantee a cost per purchase or result. Activation requires a separate review.' : 'Maximum delivery uses the daily budget to seek clicks. It does not guarantee a cost per result. Activation requires a separate review.'))}</p>${details()}</section>`;
}
/** The paused LinkedIn lead generation preview (CMP-07): shown only when the compiled plan is exactly the pack. */
function linkedinLeadPreview(out) {
  const r = out.recipe,
    plan = out.plan,
    steps = plan?.steps,
    details = () => recordDetails(out, uiText('Compiled plan and input provenance'));
  if (
    out.ready !== true ||
    out.provider_mutations !== 0 ||
    !/^[A-Z]{3}$/.test(r?.currency) ||
    !Array.isArray(steps) ||
    steps.length !== 3
  )
    return details();
  const [group, campaign, creative] = steps.map(s => s?.arguments?.payload),
    locations = campaign?.targetingCriteria?.include?.and?.[0]?.or?.['urn:li:adTargetingFacet:locations'],
    schedule = campaign?.runSchedule ?? {};
  if (
    steps.map(s => s.id).join(',') !== 'group,campaign,creative' ||
    steps.map(s => s.arguments?.action).join(',') !==
      'linkedin_rest_ad_accounts_ad_account_id_ad_campaign_groups_post,linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post,linkedin_rest_ad_accounts_ad_account_id_creatives_post' ||
    !steps.every(
      s =>
        s.kind === 'write' &&
        s.gateway === 'linkedin_native_action' &&
        s.account_id === steps[0].account_id &&
        s.connection_id === steps[0].connection_id &&
        s.expected_currency === r.currency,
    ) ||
    group?.status !== 'PAUSED' ||
    campaign?.status !== 'PAUSED' ||
    creative?.intendedStatus !== 'PAUSED' ||
    creative.status !== undefined ||
    campaign.objectiveType !== 'LEAD_GENERATION' ||
    campaign.optimizationTargetType !== 'MAX_LEAD' ||
    campaign.politicalIntent !== 'NOT_POLITICAL' ||
    campaign.totalBudget !== undefined ||
    group.totalBudget !== undefined ||
    typeof r.daily_budget !== 'string' ||
    campaign.dailyBudget?.amount !== r.daily_budget ||
    campaign.dailyBudget?.currencyCode !== r.currency ||
    !Array.isArray(locations) ||
    !locations.length ||
    locations.length > 50 ||
    !Number.isSafeInteger(schedule.start) ||
    (schedule.end !== undefined && !Number.isSafeInteger(schedule.end)) ||
    creative.content?.reference !== r.post_urn ||
    creative.leadgenCallToAction?.destination !== 'urn:li:adForm:' + r.lead_form_id ||
    creative.leadgenCallToAction?.label !== r.call_to_action
  )
    return details();
  const row = (label, value, direction = 'auto') =>
      `<div><dt>${esc(uiText(label))}</dt><dd><bdi dir="${direction}">${esc(value)}</bdi></dd></div>`,
    utc = ms => new Date(ms).toISOString().replace(/\.000Z$/, 'Z'),
    title = 'Paused LinkedIn lead generation preview';
  return `<section aria-label="${esc(uiText(title))}" class="conversion-recipe-preview"><h3>${esc(uiText(title))}</h3><p>${esc(uiText('Local preview only. No plan is saved and no advertising changes are sent.'))}</p><dl>${row('Campaign name', plan.name)}${row('Advertising login and account', steps[0].connection_id + ' · ' + steps[0].account_id, 'ltr')}${row('Daily budget in account currency', r.daily_budget + ' ' + r.currency, 'ltr')}${row('Existing post URN', creative.content.reference, 'ltr')}${row('Existing lead form ID', r.lead_form_id, 'ltr')}${row('Call to action', creative.leadgenCallToAction.label, 'ltr')}${row('LinkedIn location URNs', locations.join(', '), 'ltr')}${row('Campaign locale', String(campaign.locale?.language) + '_' + String(campaign.locale?.country), 'ltr')}${row('Start time sent to LinkedIn (UTC)', utc(schedule.start), 'ltr')}${schedule.end !== undefined ? row('End time sent to LinkedIn (UTC)', utc(schedule.end), 'ltr') : ''}</dl><p class="notice">${esc(uiText('Creates a paused campaign group, campaign and creative. Preflight reads the account’s lead forms; post eligibility, ad review and objective acceptance remain unverified. The creative serves only once its form is published.'))}</p><p>${esc(uiText('Maximum delivery uses the daily budget to seek lead form submissions. It does not guarantee a cost per lead or result; LinkedIn may spend up to 150% of a daily budget on a day. Activation requires a separate review.'))}</p>${details()}</section>`;
}
/** The paused Performance Max preview (CMP-07): shown only when the compiled plan is exactly the pack's one build. */
function pmaxLaunchPreview(out) {
  const r = out.recipe,
    plan = out.plan,
    step = Array.isArray(plan?.steps) && plan.steps.length === 1 ? plan.steps[0] : undefined,
    details = () => recordDetails(out, uiText('Compiled plan and input provenance'));
  const ops = step?.arguments?.payload?.mutate_operations;
  if (
    out.ready !== true ||
    out.provider_mutations !== 0 ||
    !/^[A-Z]{3}$/.test(r?.currency) ||
    !step ||
    !Array.isArray(ops)
  )
    return details();
  const creates = key => ops.filter(o => o?.[key]).map(o => o[key].create),
    [campaign] = creates('campaign_operation'),
    [budget] = creates('campaign_budget_operation'),
    groups = creates('asset_group_operation'),
    links = creates('asset_group_asset_operation'),
    criteria = creates('campaign_criterion_operation'),
    account = String(step.account_id ?? '').replace(/-/g, ''),
    counts = r.asset_counts && typeof r.asset_counts === 'object' ? Object.entries(r.asset_counts) : [];
  if (
    step.id !== 'build' ||
    step.kind !== 'write' ||
    step.gateway !== 'google_ads_native_action' ||
    step.expected_currency !== r.currency ||
    step.arguments.action !== 'google_ads_v23_google_ads_mutate' ||
    step.arguments.payload.partial_failure !== false ||
    campaign?.status !== 'PAUSED' ||
    campaign.advertising_channel_type !== 'PERFORMANCE_MAX' ||
    JSON.stringify(campaign.maximize_conversions) !== '{}' ||
    ['maximize_conversion_value', 'target_cpa', 'target_roas', 'manual_cpc', 'target_spend', 'bidding_strategy'].some(
      key => campaign[key] !== undefined,
    ) ||
    r.conversion_goal_policy !== 'ACCOUNT_DEFAULT' ||
    typeof budget?.amount_micros !== 'string' ||
    !/^[1-9]\d{0,15}$/.test(budget.amount_micros) ||
    budget.amount_micros !== r.daily_budget_micros ||
    budget.explicitly_shared !== false ||
    groups.length !== 1 ||
    groups[0]?.status !== 'ENABLED' ||
    groups[0].campaign !== campaign.resource_name ||
    !Array.isArray(groups[0].final_urls) ||
    groups[0].final_urls.length !== 1 ||
    !counts.length ||
    counts.some(([type, n]) => links.filter(l => l?.field_type === type).length !== n) ||
    links.length !== counts.reduce((sum, [, n]) => sum + n, 0) ||
    // A build names its account in every resource; any other customer is not this preview's.
    !(JSON.stringify(ops).match(/customers\/[^/"]*\//g) ?? []).every(m => m === 'customers/' + account + '/')
  )
    return details();
  const n = BigInt(budget.amount_micros),
    fraction = (n % 1000000n).toString().padStart(6, '0').replace(/0+$/, ''),
    amount = (n / 1000000n).toString() + (fraction ? '.' + fraction : '') + ' ' + r.currency,
    row = (label, value, direction = 'auto') =>
      `<div><dt>${esc(uiText(label))}</dt><dd><bdi dir="${direction}">${esc(value)}</bdi></dd></div>`,
    title = 'Paused Performance Max preview';
  return `<section aria-label="${esc(uiText(title))}" class="conversion-recipe-preview"><h3>${esc(uiText(title))}</h3><p>${esc(uiText('Local preview only. No plan is saved and no advertising changes are sent.'))}</p><dl>${row('Campaign name', plan.name)}${row('Advertising login and account', step.connection_id + ' · ' + step.account_id, 'ltr')}${row('Daily budget in account currency', amount, 'ltr')}${row('Native micros', budget.amount_micros, 'ltr')}${row('Bidding strategy', uiText('Maximize Conversions'))}${row('Conversion goals for this campaign', uiText('Use the account-default conversion goals'))}${row('Landing page URL', groups[0].final_urls[0], 'ltr')}${row('Asset group assets', counts.map(([type, count]) => type + ' ' + count).join(' · '), 'ltr')}${row('Location and language criteria', String(criteria.length), 'ltr')}${row('EU political advertising declaration', campaign.contains_eu_political_advertising, 'ltr')}</dl><p class="notice">${esc(uiText('One all-or-nothing build: Google creates the paused campaign, its asset group and every asset link together or not at all. Images and logos are existing account assets read for their type; asset approval, ad strength and event delivery remain unverified.'))}</p><p>${esc(uiText('Maximize Conversions uses the daily budget to seek conversions across Google’s channels. It does not guarantee a cost per conversion or result. Activation requires a separate review.'))}</p>${details()}</section>`;
}
function snapchatCreativeInspectionView(out) {
  if (out.recipe_id === 'snapchat_lead_generation') return snapchatLeadInspectionView(out);
  const evidence = out.dependencies?.find(
    row => row.id === 'existing_website_creative' && row.status === 'ready',
  )?.evidence;
  if (
    out.provider_mutations !== 0 ||
    out.scope?.gateway !== 'snapchat_native_action' ||
    evidence?.asset_type !== 'Snapchat creative' ||
    evidence.account_id !== out.scope.account_id ||
    evidence.connection_id !== out.scope.connection_id ||
    evidence.creative_type !== 'WEB_VIEW' ||
    evidence.destination_status !== 'syntax_checked'
  )
    return '';
  return `<section class="conversion-goal-inspection"><h4>${esc(uiText('Current existing creative'))}</h4><p><code dir="ltr">${esc(evidence.asset_id)}</code> · <code dir="ltr">WEB_VIEW</code></p><p>${esc(uiText('Original creative destination'))}: <bdi dir="ltr">${esc(evidence.original_destination)}</bdi></p><p>${esc(uiText('Native creative review status'))}: <bdi dir="auto">${esc(evidence.review_status ?? uiText('Not returned'))}</bdi></p><p class="notice">${esc(uiText('These current creative reads confirm ownership and fields. They do not establish advertising approval or destination availability; the native change review reads the creative again.'))}</p></section>`;
}
function snapchatLeadInspectionView(out) {
  const evidence = out.dependencies?.find(
      row => row.id === 'existing_lead_creative' && row.status === 'ready',
    )?.evidence,
    form = out.dependencies?.find(row => row.id === 'existing_lead_form' && row.status === 'ready')?.evidence;
  if (
    out.provider_mutations !== 0 ||
    out.scope?.gateway !== 'snapchat_native_action' ||
    evidence?.asset_type !== 'Snapchat creative' ||
    evidence.creative_type !== 'LEAD_GENERATION' ||
    form?.asset_type !== 'Snapchat lead form' ||
    form.asset_id !== evidence.lead_generation_form_id ||
    ![evidence, form].every(
      value => value.account_id === out.scope.account_id && value.connection_id === out.scope.connection_id,
    )
  )
    return '';
  return `<section class="conversion-goal-inspection"><h4>${esc(uiText('Current lead creative and original form'))}</h4><p>${esc(uiText('Existing Snapchat lead creative ID'))}: <code dir="ltr">${esc(evidence.asset_id)}</code></p><p>${esc(uiText('Original lead form ID'))}: <code dir="ltr">${esc(form.asset_id)}</code></p><p>${esc(uiText('Original form title'))}: <bdi dir="auto">${esc(form.original_title ?? uiText('Not returned'))}</bdi></p><p>${esc(uiText('Question fields'))}: ${esc(uiNumber(form.question_fields_count))}</p><p>${esc(uiText('Original privacy policy URL'))}: <bdi dir="ltr">${esc(form.original_privacy_policy_url ?? uiText('Not returned'))}</bdi></p><p>${esc(uiText('Native creative review status'))}: <bdi dir="auto">${esc(evidence.review_status ?? uiText('Not returned'))}</bdi></p><p class="notice">${esc(uiText('Current reads confirm the selected account and original form definition. Privacy-policy availability, consent acceptance, advertising approval and objective eligibility remain unverified. No submitted leads were read. Native review reads both dependencies again.'))}</p></section>`;
}
function conversionValueInspectionView(out) {
  const p = out.conversion_goal_inspection,
    s = p?.summary;
  const count = v => Number.isSafeInteger(v) && v >= 0 && v <= 4000;
  if (
    out.provider_mutations !== 0 ||
    p?.provider_mutations !== 0 ||
    p?.record_kind !== 'google_conversion_goal_inspection' ||
    p.complete !== true ||
    p.value_settings_selected !== true ||
    !['google_search_conversion_value', 'google_search_target_roas'].includes(out.recipe_id) ||
    p.scope?.gateway !== 'google_ads_native_action' ||
    p.scope.account_id !== out.scope?.account_id ||
    p.scope.connection_id !== out.scope?.connection_id ||
    typeof p.scope.account_id !== 'string' ||
    !/^[0-9]{1,20}$/.test(p.scope.account_id) ||
    !s ||
    !count(s.matching_primary_actions) ||
    !count(s.primary_value_settings_known) ||
    !count(s.primary_value_settings_unknown) ||
    s.primary_value_settings_known + s.primary_value_settings_unknown !== s.matching_primary_actions ||
    !Array.isArray(p.primary_actions) ||
    !p.primary_actions.length ||
    p.primary_actions.length > 20 ||
    p.primary_actions.length > s.matching_primary_actions
  )
    return '';
  const valid = v =>
    v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v).sort().join(',') === 'always_use_default_value,default_currency_code,default_value' &&
    (v.default_value === null ||
      (typeof v.default_value === 'number' &&
        Number.isFinite(v.default_value) &&
        v.default_value >= 0 &&
        v.default_value <= 1e12)) &&
    (v.default_currency_code === null ||
      (typeof v.default_currency_code === 'string' && /^[A-Z]{3}$/.test(v.default_currency_code))) &&
    (v.always_use_default_value === null || typeof v.always_use_default_value === 'boolean');
  if (
    !p.primary_actions.every(
      a =>
        a &&
        typeof a === 'object' &&
        !Array.isArray(a) &&
        typeof a.name === 'string' &&
        typeof a.resource_name === 'string' &&
        new RegExp('^customers/' + p.scope.account_id + '/conversionActions/[1-9][0-9]*$').test(a.resource_name) &&
        a.status === 'ENABLED' &&
        a.primary_for_goal === true &&
        valid(a.value_settings),
    )
  )
    return '';
  const literal = v => (v === null ? esc(uiText('Not returned')) : `<bdi dir="ltr">${esc(String(v))}</bdi>`);
  const rows = p.primary_actions
    .map(a => {
      const v = a.value_settings,
        behavior =
          v.always_use_default_value === null
            ? 'Not returned'
            : v.always_use_default_value
              ? 'Always use configured defaults'
              : 'Use event values when valid; otherwise use defaults';
      return `<tr><td><bdi dir="auto">${esc(a.name)}</bdi><br><code dir="ltr" class="goal-resource">${esc(a.resource_name)}</code></td><td>${literal(v.default_value)}</td><td>${literal(v.default_currency_code)}</td><td>${esc(uiText(behavior))}</td></tr>`;
    })
    .join('');
  return `<details class="conversion-goal-inspection"><summary>${esc(uiText('Current conversion value settings'))}</summary><p>${esc(uiText('Known value settings: {known} · Unknown: {unknown}. Counts cover the complete matching primary collection.', {known: s.primary_value_settings_known, unknown: s.primary_value_settings_unknown}))}</p><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Current conversion value settings'))}"><table class="review-table"><caption>${esc(uiText('Current conversion value settings'))}</caption><thead><tr>${['Primary conversion action', 'Default value in conversion currency', 'Default conversion currency', 'Event-value behavior'].map(label => `<th scope="col">${esc(uiText(label))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div><p>${esc(uiText('Default values keep their original conversion currency and configured amount.'))}</p><p class="notice">${esc(uiText('These are current configuration settings. They do not prove received event values, conversion history, account eligibility or actual return.'))}</p></details>`;
}
function conversionActivityInspectionView(out) {
  const p = out.conversion_goal_inspection,
    s = p?.summary;
  const count = v => Number.isSafeInteger(v) && v >= 0 && v <= 4000;
  if (
    out.provider_mutations !== 0 ||
    p?.provider_mutations !== 0 ||
    p?.record_kind !== 'google_conversion_goal_inspection' ||
    p.complete !== true ||
    p.activity_selected !== true ||
    !['google_search_conversion_value', 'google_search_target_roas'].includes(out.recipe_id) ||
    p.scope?.gateway !== 'google_ads_native_action' ||
    p.scope.account_id !== out.scope?.account_id ||
    p.scope.connection_id !== out.scope?.connection_id ||
    typeof p.scope.account_id !== 'string' ||
    !/^[0-9]{1,20}$/.test(p.scope.account_id) ||
    p.customer?.id !== p.scope.account_id ||
    typeof p.customer.timezone !== 'string' ||
    !s ||
    !count(s.matching_primary_actions) ||
    !count(s.primary_last_conversion_known) ||
    !count(s.primary_last_tag_known) ||
    s.primary_last_conversion_known > s.matching_primary_actions ||
    s.primary_last_tag_known > s.matching_primary_actions ||
    !Array.isArray(p.primary_actions) ||
    !p.primary_actions.length ||
    p.primary_actions.length > 20 ||
    p.primary_actions.length > s.matching_primary_actions
  )
    return '';
  try {
    new Intl.DateTimeFormat('en', {timeZone: p.customer.timezone}).format(0);
  } catch {
    return '';
  }
  const date = v =>
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    v >= '0001-01-01' &&
    Number.isFinite(new Date(v + 'T00:00:00.000Z').getTime()) &&
    new Date(v + 'T00:00:00.000Z').toISOString().slice(0, 10) === v;
  const valid = a =>
    a &&
    typeof a === 'object' &&
    !Array.isArray(a) &&
    Object.keys(a).sort().join(',') === 'last_conversion_date,last_tag_received_time' &&
    (a.last_conversion_date === null || date(a.last_conversion_date)) &&
    (a.last_tag_received_time === null ||
      (typeof a.last_tag_received_time === 'string' &&
        /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?$/.test(a.last_tag_received_time) &&
        date(a.last_tag_received_time.slice(0, 10))));
  if (
    !p.primary_actions.every(
      a =>
        a &&
        typeof a === 'object' &&
        !Array.isArray(a) &&
        typeof a.name === 'string' &&
        typeof a.resource_name === 'string' &&
        new RegExp('^customers/' + p.scope.account_id + '/conversionActions/[1-9][0-9]*$').test(a.resource_name) &&
        a.status === 'ENABLED' &&
        a.primary_for_goal === true &&
        valid(a.activity),
    )
  )
    return '';
  const knownConversions = p.primary_actions.filter(a => a.activity.last_conversion_date !== null).length,
    knownTags = p.primary_actions.filter(a => a.activity.last_tag_received_time !== null).length;
  if (
    new Set(p.primary_actions.map(a => a.resource_name)).size !== p.primary_actions.length ||
    knownConversions > s.primary_last_conversion_known ||
    knownTags > s.primary_last_tag_known ||
    (p.primary_actions.length === s.matching_primary_actions &&
      (knownConversions !== s.primary_last_conversion_known || knownTags !== s.primary_last_tag_known))
  )
    return '';
  const literal = v => (v === null ? esc(uiText('Not returned')) : `<bdi dir="ltr">${esc(v)}</bdi>`);
  const rows = p.primary_actions
    .map(
      a =>
        `<tr><td><bdi dir="auto">${esc(a.name)}</bdi><br><code dir="ltr" class="goal-resource">${esc(a.resource_name)}</code></td><td>${literal(a.activity.last_conversion_date)}</td><td>${literal(a.activity.last_tag_received_time)}</td></tr>`,
    )
    .join('');
  return `<details class="conversion-goal-inspection"><summary>${esc(uiText('Last reported conversion activity'))}</summary><p>${esc(uiText('Times use the advertising account timezone: {timezone}.', {timezone: p.customer.timezone}))}</p><p>${esc(uiText('Known conversion dates: {conversions} · Known tag detection times: {tags}. Counts cover the complete matching primary collection.', {conversions: uiNumber(s.primary_last_conversion_known), tags: uiNumber(s.primary_last_tag_known)}))}</p><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Last reported conversion activity'))}"><table class="review-table"><caption>${esc(uiText('Last reported conversion activity'))}</caption><thead><tr>${['Primary conversion action', 'Last reported conversion date', 'Last tag detected by Google Ads'].map(label => `<th scope="col">${esc(uiText(label))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div><p class="notice">${esc(uiText('A detected tag can have no attributable conversion. These dates do not prove delivered values, recent conversion volume, consent, deduplication, bidding eligibility or actual return.'))}</p></details>`;
}
function conversionGoalInspectionView(out) {
  const p = out.conversion_goal_inspection;
  if (
    out.provider_mutations !== 0 ||
    p?.record_kind !== 'google_conversion_goal_inspection' ||
    p.provider_mutations !== 0 ||
    p.scope?.gateway !== 'google_ads_native_action' ||
    p.scope.account_id !== out.scope?.account_id ||
    p.scope.connection_id !== out.scope?.connection_id ||
    typeof p.complete !== 'boolean'
  )
    return '';
  const heading = `<h4>${esc(uiText('Current conversion configuration'))}</h4>`,
    limits = `<p class="notice">${esc(uiText('These are current settings from repeated reads. They can change before activation; event delivery, campaign eligibility and performance still need verification.'))}</p>`;
  if (!p.complete) {
    const reasons = {
      manager_account: 'Select a client account; this inspection does not qualify manager conversion tracking.',
      shared_conversion_customer:
        'This account uses shared conversion tracking. A separately scoped inspection is needed; no other customer was read.',
      conversion_customer_unknown:
        'The conversion customer was not explicitly returned, so account-default goals remain unverified.',
    };
    return `<section class="conversion-goal-inspection">${heading}<p>${esc(uiText('No complete current goal and primary-action evidence is available.'))}</p><p>${esc(uiText(reasons[p.reason] ?? 'The current conversion configuration could not be completely inspected. Inspect it again before activation.'))}</p>${p.error?.code ? `<p><code dir="ltr">${esc(p.error.code)}</code></p>` : ''}</section>`;
  }
  const s = p.summary,
    count = n => Number.isSafeInteger(n) && n >= 0 && n <= 1000;
  if (
    !s ||
    !['goals', 'biddable_goals', 'actions', 'matching_primary_actions', 'unknown_primary_flags'].every(k =>
      count(s[k]),
    ) ||
    s.biddable_goals > s.goals ||
    s.matching_primary_actions > s.actions ||
    s.unknown_primary_flags > s.actions ||
    !Array.isArray(p.goals) ||
    p.goals.length > 20 ||
    !Array.isArray(p.primary_actions) ||
    p.primary_actions.length > 20 ||
    !p.goals.every(
      g =>
        typeof g.category === 'string' &&
        typeof g.origin === 'string' &&
        typeof g.biddable === 'boolean' &&
        g.resource_name === `customers/${p.scope.account_id}/customerConversionGoals/${g.category}~${g.origin}` &&
        count(g.matching_primary_actions),
    ) ||
    !p.primary_actions.every(
      a =>
        typeof a.name === 'string' &&
        typeof a.resource_name === 'string' &&
        a.resource_name.startsWith(`customers/${p.scope.account_id}/conversionActions/`) &&
        a.status === 'ENABLED' &&
        a.primary_for_goal === true,
    )
  )
    return '';
  const rows = p.goals
      .map(
        g =>
          `<tr><td><code dir="ltr">${esc(g.category)}</code></td><td><code dir="ltr">${esc(g.origin)}</code></td><td>${esc(uiText(g.biddable ? 'Yes' : 'No'))}</td><td>${esc(g.matching_primary_actions)}</td><td><details><summary aria-label="${esc(uiText('View resource for {category} from {origin}', {category: g.category, origin: g.origin}))}">${esc(uiText('View resource'))}</summary><code dir="ltr" class="goal-resource">${esc(g.resource_name)}</code></details></td></tr>`,
      )
      .join(''),
    omitted = p.display_omissions ?? {};
  return `<section class="conversion-goal-inspection">${heading}<p>${esc(uiText('Read {date} · Goals: {goals} · Biddable: {biddable} · Matching primary actions: {primary} · Unknown primary flags: {unknown}.', {date: date(p.captured_at), goals: s.goals, biddable: s.biddable_goals, primary: s.matching_primary_actions, unknown: s.unknown_primary_flags}))}</p>${limits}${rows ? `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Current account-default goal settings'))}"><table class="review-table"><caption>${esc(uiText('Current account-default goal settings'))}</caption><thead><tr>${['Category', 'Origin', 'Biddable now', 'Matching enabled primary actions', 'Native goal resource'].map(label => `<th scope="col">${esc(uiText(label))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : `<p>${esc(uiText('No account-default goals were returned by the complete inspection.'))}</p>`}<details><summary>${esc(uiText('Matching primary actions'))}</summary>${p.primary_actions.length ? `<ul>${p.primary_actions.map(a => `<li><bdi dir="auto">${esc(a.name)}</bdi> · <code dir="ltr" class="goal-resource">${esc(a.resource_name)}</code></li>`).join('')}</ul>` : `<p>${esc(uiText('No enabled explicit primary action matched a biddable default goal.'))}</p>`}</details>${omitted.goals || omitted.primary_actions ? `<p>${esc(uiText('Display omits {goals} goal rows and {primary} primary-action rows; counts and state hash cover the complete inspected collections.', {goals: omitted.goals ?? 0, primary: omitted.primary_actions ?? 0}))}</p>` : ''}</section>`;
}
const recipePrerequisiteLabels = {
  connection_disabled: 'Connection is disabled',
  deployment_writes_disabled: 'Reviewed writes are disabled in this deployment',
  workspace_writes_paused: 'The owner paused provider writes',
  operator_required: 'An operator role is required',
  account_write_grant_required: 'This account needs a write grant',
};
function recipePolicyNotice(row) {
  if (
    row.code === 'SPEND_POLICY_MISSING' &&
    Array.isArray(row.accounts) &&
    row.accounts.length > 0 &&
    row.accounts.length <= 50
  )
    return uiText(
      row.accounts.length === 1
        ? 'No owner spending policy covers this account. Each native review still asks for spending approval; this notice does not block the plan.'
        : 'No owner spending policy covers these selected accounts. Each native review still asks for spending approval; this notice does not block the plan.',
    );
  return uiText(row.message);
}
function recipeBlockerMeaning(row) {
  if (row.message) return uiText(row.message);
  if (Object.hasOwn(recipePrerequisiteLabels, row.code)) return uiText(recipePrerequisiteLabels[row.code]);
  return uiText(row.source ?? 'Current workspace prerequisite');
}
/** The recipe check's evidence; `recipeId` (the brief's recipe) names its missing fields when `out` does not. */
function recipeEligibilityView(out, recipeId) {
  const status = value => esc(uiText(recipeEligibilityLabels[value] ?? 'Needs further verification'));
  return `<section aria-label="${esc(uiText('Account prerequisite evidence'))}"><h3>${esc(uiText('Account prerequisite evidence'))}</h3><p>${status(out.status)}</p><p>${esc(uiText('This check saves no campaign plan and makes no advertising changes. Each later change still needs its own review.'))}</p>${out.scope ? `<p>${esc(uiText('Advertising login and account'))}: <code>${esc(out.scope.connection_id)}</code> · <code>${esc(out.scope.account_id)}</code></p>` : ''}${out.expires_at ? `<p>${esc(uiText('Evidence expires'))}: ${esc(date(out.expires_at))}</p>` : ''}${out.missing_fields?.length ? `<p>${esc(uiText('Missing business inputs'))}: ${out.missing_fields.map(key => esc(uiText(recipeFieldLabel(key, typeof out.recipe === 'string' ? out.recipe : (out.recipe?.id ?? recipeId)) ?? pretty(key)))).join(', ')}</p>` : ''}${conversionGoalInspectionView(out)}${conversionValueInspectionView(out)}${conversionActivityInspectionView(out)}${snapchatCreativeInspectionView(out)}<dl>${(out.dependencies ?? []).map(row => `<dt>${esc(uiText(recipeDependencyLabels[row.id] ?? pretty(row.id)))} — ${status(row.status)}</dt><dd><code>${esc(row.id)}</code><p>${esc(uiText(row.meaning))}</p></dd>`).join('')}</dl>${out.blockers?.length ? `<h4>${esc(uiText('Resolve before review'))}</h4><ul>${out.blockers.map(row => `<li>${esc(row.step_id ?? '')} ${esc(row.code)}: ${esc(recipeBlockerMeaning(row))}</li>`).join('')}</ul>` : ''}${out.deferred?.length ? `<h4>${esc(uiText('Checks after predecessor verification'))}</h4><ul>${out.deferred.map(row => `<li>${esc(row.step ?? '')}: ${esc(uiText(row.reason))}</li>`).join('')}</ul>` : ''}${out.warnings?.length ? `<h4>${esc(uiText('Account policy notices'))}</h4><ul>${out.warnings.map(row => `<li>${esc(recipePolicyNotice(row))}</li>`).join('')}</ul>` : ''}${recordDetails(out, uiText('Native evidence and input provenance'))}</section>`;
}
/**
 * Why no account can be chosen (CMP-06): nothing is connected for this platform, or the selected playbook's bound
 * accounts leave out the connected ones, which is fixed in the playbook rather than in Connections.
 */
function recipeNoTargetNotice(context) {
  return context.profile && context.excluded_by_playbook > 0
    ? `<p class="notice" id="recipe-no-target">${esc(uiText('This playbook’s bound accounts do not include an account for this workflow. Choose another workflow or playbook, or edit the playbook’s bound accounts.'))} <a href="/profiles?profile_id=${encodeURIComponent(context.profile.id)}">${esc(uiText('Open the playbook'))}</a></p>`
    : `<p class="notice" id="recipe-no-target">${esc(uiText('Connect and select an account first.'))} <a href="/connections">${esc(uiText('Manage connections'))}</a></p>`;
}
/** The wall-clock part of an offset timestamp, for a datetime-local field. */
function recipeLocalTime(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? value.slice(0, 16) : '';
}
/**
 * A datetime-local value read as a wall-clock time in an IANA timezone, as the offset timestamp recipes take
 * (CMP-06): 2026-11-01T09:00 in Asia/Riyadh is 2026-11-01T09:00:00+03:00. An unknown timezone is read as UTC.
 */
function recipeOffsetTime(local, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local ?? '');
  if (!m) return local;
  const options = {
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  };
  let format;
  try {
    format = new Intl.DateTimeFormat('en-US', {...options, timeZone: timeZone || 'UTC'});
  } catch {
    format = new Intl.DateTimeFormat('en-US', {...options, timeZone: 'UTC'});
  }
  const offsetAt = t => {
    const parts = Object.fromEntries(format.formatToParts(new Date(t)).map(p => [p.type, p.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - t;
  };
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)),
    minutes = Math.round(offsetAt(wall - offsetAt(wall)) / 60000),
    abs = Math.abs(minutes);
  return (
    `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}` +
    (minutes < 0 ? '-' : '+') +
    String(Math.floor(abs / 60)).padStart(2, '0') +
    ':' +
    String(abs % 60).padStart(2, '0')
  );
}
// Meta packs take exactly one image source (CMP-06).
const recipeImageSources = [
  ['drive_url', 'Google Drive image link'],
  ['source_id', 'Uploaded file ID from Creative'],
  ['source_url', 'Public HTTPS image link'],
  ['image_hash', 'Image already in this ad account (image hash)'],
];
function recipeImageField(values) {
  const source = recipeImageSources.some(([key]) => key === values.image_source)
      ? values.image_source
      : (recipeImageSources.find(([key]) => values[key])?.[0] ?? 'drive_url'),
    value = values.image_value ?? values[source] ?? '';
  return `<label>${esc(uiText('Image source'))}<select name="image_source">${recipeImageSources.map(([key, label]) => `<option value="${key}" ${key === source ? 'selected' : ''}>${esc(uiText(label))}</option>`).join('')}</select></label><label>${esc(uiText('Image'))}<input name="image_value" required maxlength="2048" dir="ltr" value="${esc(value)}"></label>`;
}
/** "Your input → Playbook result" for the playbook rules a preview applied (CMP-06). */
function recipeConventionView(provenance) {
  const c = provenance?.conventions;
  if (!c) return '';
  if (!c.applied)
    return `<p class="notice">${esc(uiText('Playbook naming and tracking rules are off for this plan; the name and landing page are used as typed.'))}</p>`;
  const rows = [
    c.name ? [uiText('Campaign name'), c.name.input, c.name.result] : null,
    c.destination_url ? [uiText('Landing page URL'), c.destination_url.input, c.destination_url.result] : null,
  ].filter(Boolean);
  return rows.length
    ? `<section class="recipe-conventions"><h3>${esc(uiText('Playbook rules applied'))}</h3><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Playbook rules applied'))}"><table class="review-table"><caption>${esc(uiText('Playbook rules applied'))}</caption><thead><tr><th scope="col">${esc(uiText('Field'))}</th><th scope="col">${esc(uiText('Your input'))}</th><th scope="col">${esc(uiText('Playbook result'))}</th></tr></thead><tbody>${rows.map(([label, input, result]) => `<tr><th scope="row">${esc(label)}</th><td><bdi dir="auto">${esc(input)}</bdi></td><td><bdi dir="auto">${esc(result)}</bdi></td></tr>`).join('')}</tbody></table></div></section>`
    : '';
}
// The objective-first chooser (CMP-06): an objective, then the workflows for it on platforms with a connected account.
const recipeObjectives = [
  ['traffic', 'Website visits'],
  ['sales', 'Website purchases'],
  ['leads', 'Leads'],
  ['search', 'Search ads'],
];
/** A recipe's business objective, as the server groups saved briefs (recipeObjective in src/recipe-context.ts). */
function recipeObjectiveOf(id) {
  // A Search pack is search acquisition, though its ID may end in _traffic (R2.5 M4, package r25-m4-search); the order is the server's (recipeObjective).
  return String(id).includes('search')
    ? 'search'
    : String(id).includes('lead')
      ? 'leads'
      : [
            'meta_website_sales',
            'tiktok_website_conversions',
            'tiktok_smart_plus_website_conversions',
            'google_performance_max',
          ].includes(id)
        ? 'sales'
        : String(id).endsWith('_traffic')
          ? 'traffic'
          : 'search';
}
/** The recipes offered: those of platforms with a connected account (all while none is), plus a chosen one. */
function recipePool(recipes, selected) {
  const connected = recipes.filter(recipeHasAccount),
    pool = connected.length ? connected : [...recipes],
    chosen = recipes.find(r => r.id === selected);
  if (chosen && !pool.includes(chosen)) pool.push(chosen);
  return pool;
}
function recipeObjectiveRecipes(recipes, objective, selected) {
  return recipePool(recipes, selected).filter(r => recipeObjectiveOf(r.id) === objective);
}
/** Workflow options for an objective; Google Search bidding strategies are one sub-choice group. */
function recipeOptions(recipes, objective, selected) {
  const list = recipeObjectiveRecipes(recipes, objective, selected),
    // A recipe the deployment offers as a draft only (CMP-03) says so beside its name.
    option = r =>
      `<option value="${esc(r.id)}" ${r.id === selected ? 'selected' : ''}>${esc(uiText(r.name))}${r.availability_label ? ' — ' + esc(uiText(r.availability_label)) : ''}</option>`,
    // Only the Google Search packs share the bidding sub-choice; Performance Max is its own workflow (CMP-07).
    google = list.filter(r => r.platform === 'google' && String(r.id).startsWith('google_search'));
  return (
    list
      .filter(r => !google.includes(r))
      .map(option)
      .join('') +
    (google.length
      ? `<optgroup label="${esc(uiText('Google Search — choose the bidding'))}">${google.map(option).join('')}</optgroup>`
      : '')
  );
}
// Drafts for this tab and identity (CMP-06); storage may be unavailable, and then drafts stay in this view only.
const recipeDraftKey = 'amcp.recipe-drafts';
function recipeDraftIdentity() {
  return typeof identityKey === 'function' && typeof session === 'object' && session ? identityKey(session) : '';
}
function recipeStoredDrafts() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(recipeDraftKey) ?? 'null');
    return saved && saved.identity === recipeDraftIdentity() && saved.drafts && typeof saved.drafts === 'object'
      ? saved
      : null;
  } catch {
    return null;
  }
}
function recipeStoreDraft(key, values, last) {
  try {
    const saved = recipeStoredDrafts() ?? {identity: recipeDraftIdentity(), drafts: {}};
    delete saved.drafts[key];
    saved.drafts[key] = values;
    const keys = Object.keys(saved.drafts);
    for (const old of keys.slice(0, Math.max(0, keys.length - 20))) delete saved.drafts[old];
    saved.last = last;
    sessionStorage.setItem(recipeDraftKey, JSON.stringify(saved));
  } catch {
    /* Private modes may deny storage. */
  }
}
/** Forgets this tab's composer drafts: signing out or switching workspace (web/app.js resetPrivateState). */
function recipeDraftsForget() {
  try {
    sessionStorage.removeItem(recipeDraftKey);
  } catch {
    /* Nothing was stored. */
  }
}
/** A saved brief's business inputs as the composer's form values. */
function recipeBriefValues(business) {
  const values = {};
  for (const [key, value] of Object.entries(business ?? {}))
    values[key] =
      key === 'special_ad_categories' && Array.isArray(value) && !value.length
        ? 'none'
        : Array.isArray(value)
          ? value.join('\n')
          : typeof value === 'boolean' || typeof value === 'number'
            ? String(value)
            : value;
  if (business?.connection_id && business?.account_id)
    values.target = JSON.stringify({connection_id: business.connection_id, account_id: business.account_id});
  return values;
}
const recipeGateways = {
  google: 'google_ads_native_action',
  meta: 'meta_native_action',
  microsoft: 'microsoft_ads_native_action',
  snapchat: 'snapchat_native_action',
  tiktok: 'tiktok_native_action',
  linkedin: 'linkedin_native_action',
};
/** Whether a recipe's platform has an enabled login with a selected account (no provider request). */
function recipeHasAccount(recipe) {
  const gateway = recipeGateways[recipe.platform];
  return (typeof platforms === 'object' && Array.isArray(platforms) ? platforms : []).some(
    p => p.gateway === gateway && p.connections?.some(c => c.enabled && c.accounts?.length),
  );
}
/** The composer's address parameters, or none where the page has no address. */
function recipeLinkParams() {
  return typeof URLSearchParams === 'function' && typeof location === 'object' && location
    ? new URLSearchParams(location.search ?? '')
    : new Map();
}
/**
 * The composer's starting choice (WEB-06 deep links). /campaigns?recipe=&profile_id=&connection_id=&account_id=
 * preselects; it never inspects, checks or saves anything until the person acts. A linked value this workspace does
 * not have is named instead of being silently replaced. Without a link the composer reopens this tab's last workflow
 * and playbook (CMP-06), or starts on the first workflow with an eligible account.
 */
function recipeStart(recipes, profiles, params = recipeLinkParams()) {
  const linked = {
      recipe: params.get('recipe'),
      profile: params.get('profile_id'),
      connection_id: params.get('connection_id'),
      account_id: params.get('account_id'),
    },
    notices = [];
  let recipe = recipes.find(r => r.id === linked.recipe)?.id;
  if (linked.recipe && !recipe) notices.push(uiText('The linked workflow is not available. Choose a workflow.'));
  const last = linked.recipe || linked.profile ? null : recipeStoredDrafts()?.last;
  recipe ??= recipes.find(r => r.id === last?.recipe)?.id;
  recipe ??= (recipes.find(recipeHasAccount) ?? recipes[0])?.id;
  // The working client's playbook comes before the tab's last one (SEC-08): its bindings narrow the accounts offered,
  // and its accounts' logins the Page suggestions.
  const working = typeof workingClient === 'function' ? workingClient()?.profile_id : undefined;
  let profile = profiles.find(p => p.id === (linked.profile ?? working ?? last?.profile))?.id ?? '';
  if (linked.profile && !profile)
    notices.push(uiText('The linked client playbook is not available in this workspace. Choose a playbook.'));
  const target =
    linked.connection_id && linked.account_id
      ? {connection_id: linked.connection_id, account_id: linked.account_id}
      : null;
  return {recipe, profile, target, notices};
}
async function mountRecipeBuilder(profiles, openCampaign) {
  // A recipe a dated provider deprecation retires is marked by the server from its date (R2.5 M4a merge): it is left out before the start is
  // chosen, so a link or a stored draft that names it falls back as for any unknown workflow.
  const {recipes: listed} = await workspaceCall('campaign', {action: 'recipes'}),
    recipes = listed.filter(r => !r.retired),
    viewer = session.workspaceRole === 'viewer',
    start = recipeStart(recipes, profiles);
  // Drafts this tab kept for this identity come back after a reload (CMP-06).
  for (const [key, values] of Object.entries(recipeStoredDrafts()?.drafts ?? {}))
    if (!recipeDrafts.has(key) && values && typeof values === 'object') recipeDrafts.set(key, {values});
  const startObjective = recipeObjectiveOf(start.recipe ?? ''),
    objectives = recipeObjectives.filter(
      ([id]) => id === startObjective || recipeObjectiveRecipes(recipes, id, start.recipe).length,
    ),
    filtered = recipes.some(recipeHasAccount) && recipes.some(r => !recipeHasAccount(r));
  const section = document.createElement('section');
  section.className = 'panel workspace-form recipe-builder';
  section.innerHTML = `<h2>${esc(uiText('Build from business inputs'))}</h2><p>${esc(uiText('Choose a workflow, complete the brief, then inspect a paused campaign plan. Each provider change receives its own review.'))}</p>${start.notices.map(text => `<p class="notice" role="status">${esc(text)}</p>`).join('')}<div class="recipe-choice"><label>${esc(uiText('Objective'))}<select id="recipe-objective">${objectives.map(([id, label]) => `<option value="${id}" ${id === startObjective ? 'selected' : ''}>${esc(uiText(label))}</option>`).join('')}</select></label><label>${esc(uiText('Workflow'))}<select id="recipe-choice">${recipeOptions(recipes, startObjective, start.recipe)}</select></label><label>${esc(uiText('Approved client profile'))}<select id="recipe-profile"><option value="">${esc(uiText('No profile'))}</option>${profiles.map(p => `<option value="${esc(p.id)}" ${p.id === start.profile ? 'selected' : ''}>${esc(p.name)} ${esc(uiText('· revision'))} ${p.revision}</option>`).join('')}</select></label></div>${filtered ? `<p class="form-note">${esc(uiText('Only workflows for platforms with a connected account are listed.'))} <a href="/connections">${esc(uiText('Manage connections'))}</a></p>` : ''}<details id="recipe-briefs" class="workspace-details"><summary>${esc(uiText('Saved client briefs'))}</summary><div id="recipe-brief-list" aria-live="polite"></div></details><div id="recipe-fields" aria-live="polite"></div><p id="recipe-error" class="error" role="alert"></p><div id="recipe-preview" tabindex="-1"></div>`;
  $('#campaign-create > summary').after(section);
  $('#recipe-objective').value = startObjective;
  $('#recipe-choice').value = start.recipe ?? '';
  $('#recipe-profile').value = start.profile;
  // A link to the composer opens it.
  if (start.notices.length || ['recipe', 'profile_id', 'connection_id'].some(k => recipeLinkParams().has(k)))
    $('#campaign-create').open = true;
  let linkedTarget = start.target;
  let currentKey = '',
    context = null,
    loading = 0,
    actionSequence = 0,
    // The saved brief this form came from, and the live eligibility check of these exact values (CMP-06).
    activeBrief = null,
    eligibility = null,
    briefsLoaded = false;
  const route = navigationGeneration,
    identity = identityGeneration;
  const mounted = () => section.isConnected && route === navigationGeneration && identity === identityGeneration;
  const draft = () => {
    const f = $('#recipe-form');
    if (f && currentKey) {
      const values = Object.fromEntries(new FormData(f));
      recipeDrafts.set(currentKey, {values, context});
      recipeStoreDraft(currentKey, values, {recipe: $('#recipe-choice').value, profile: $('#recipe-profile').value});
    }
  };
  const renderFields = async () => {
    ++actionSequence;
    const sequence = ++loading,
      recipe = $('#recipe-choice').value,
      profile = $('#recipe-profile').value;
    currentKey = JSON.stringify([recipe, profile]);
    eligibility = null;
    $('#recipe-error').textContent = '';
    $('#recipe-preview').innerHTML = '';
    $('#recipe-fields').textContent = uiText('Loading selected accounts and approved defaults…');
    try {
      const nextContext = await workspaceCall('campaign', {
        action: 'recipe_context',
        recipe,
        ...(profile ? {profile_id: profile} : {}),
      });
      if (sequence !== loading || !mounted()) return;
      context = nextContext;
      const saved = recipeDrafts.get(currentKey),
        defaults = context.defaults ?? {},
        values = {...defaults, ...(saved?.values ?? {})};
      const required = context.recipe.required.filter(k => !['account_id', 'connection_id', 'currency'].includes(k)),
        optional = ['snapchat', 'tiktok', 'linkedin'].includes(context.recipe.platform)
          ? ['end_time']
          : recipe.startsWith('meta')
            ? ['start_time', 'end_time']
            : ['start_date', 'end_date'];
      // A linked account is a hint checked against the current choices; one this person cannot use is named, not
      // replaced by another account (WEB-06).
      const linked = linkedTarget;
      linkedTarget = null;
      const linkedId = linked
          ? JSON.stringify({connection_id: linked.connection_id, account_id: linked.account_id})
          : null,
        linkedMissing =
          linked &&
          !context.targets.some(
            t => JSON.stringify({connection_id: t.connection_id, account_id: t.account_id}) === linkedId,
          );
      const targetId = t => JSON.stringify({connection_id: t.connection_id, account_id: t.account_id}),
        eligible = context.targets.filter(t => t.write_granted),
        // A sole eligible account is chosen for the person, with its currency (CMP-06).
        sole = eligible.length === 1 ? eligible[0] : context.targets.length === 1 ? context.targets[0] : null;
      const selected =
        (linked && !linkedMissing ? linkedId : null) ??
        values.target ??
        (values.connection_id && values.account_id
          ? JSON.stringify({connection_id: values.connection_id, account_id: values.account_id})
          : !linkedMissing && sole
            ? targetId(sole)
            : '');
      if (selected && !values.currency) {
        const t = context.targets.find(t => targetId(t) === selected);
        if (t?.currency) values.currency = t.currency;
      }
      const timed = ['meta', 'snapchat', 'tiktok', 'linkedin'].includes(context.recipe.platform),
        zoneOf = id => context.targets.find(t => targetId(t) === id)?.timezone || '',
        zoneNote = id =>
          zoneOf(id)
            ? uiText('Times are in the account timezone: {timezone}.', {timezone: zoneOf(id)})
            : uiText(
                'The account timezone is not known yet, so times are read as UTC. Check the account timezone before scheduling.',
              ),
        fieldValue = k => (['start_time', 'end_time'].includes(k) ? (values[k + '_local'] ?? values[k]) : values[k]),
        rulesOn = values.playbook_rules_seen ? values.apply_playbook_rules === 'true' : true;
      $('#recipe-fields').innerHTML =
        `${context.limitations.map(l => `<p class="notice">${esc(uiText(l))}</p>`).join('')}${linkedMissing ? `<p class="notice" role="status" id="recipe-linked-account">${esc(uiText('The linked account is not available to you for this workflow. Choose an account you can use.'))}</p>` : ''}<form id="recipe-form"><div class="recipe-fields"><label>${esc(uiText('Advertising login and account'))}<select name="target" required>${linkedMissing ? `<option value="" selected>${esc(uiText('Previously selected account — check access'))}</option>` : ''}<option value="">${esc(uiText('Choose the exact login and account'))}</option>${context.targets
          .map(t => {
            const id = JSON.stringify({connection_id: t.connection_id, account_id: t.account_id});
            return `<option value="${esc(id)}" ${selected === id ? 'selected' : ''}>${esc(t.label)}${t.write_granted ? '' : uiText(' — read access only')}</option>`;
          })
          .join(
            '',
          )}</select></label><label>${esc(uiText('Account currency'))}<input name="currency" value="${esc(values.currency ?? '')}" pattern="[A-Z]{3}" maxlength="3" required></label>${required.map(k => (k === 'drive_url' && context.recipe.platform === 'meta' ? recipeImageField(values) : recipeField(k, fieldValue(k), true, recipe))).join('')}${recipe.startsWith('meta') ? `<label>${esc(uiText('Private Drive access'))}<select name="drive_connection_id"><option value="">${esc(uiText('Public link or resolve a selected login'))}</option>${context.drive_connections.map(c => `<option value="${esc(c.id)}" ${values.drive_connection_id === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>` : ''}</div>${context.recipe.platform === 'google' ? `<details><summary>${esc(uiText('Find Google targeting IDs'))}</summary><label>${esc(uiText('Type'))}<select id="recipe-lookup-kind"><option value="country">${esc(uiText('Country'))}</option><option value="language">${esc(uiText('Language'))}</option></select></label><label>${esc(uiText('Country name/code or language'))}<input id="recipe-lookup-query" maxlength="60"></label><button type="button" class="button" id="recipe-lookup">${esc(uiText('Find targeting'))}</button><div id="recipe-lookup-results" aria-live="polite"></div></details>` : ''}${context.recipe.platform === 'microsoft' ? html`<p class="form-note" id="recipe-location-note">${uiText('Microsoft location IDs come from the Location Id column of its geographical locations file; use locations it lists as Active. Each becomes a positive location criterion of the paused campaign, read back by ID; activation preflight lists each location with the name Microsoft gives it, for you to confirm before approving.')}</p>${context.location_lookup?.available === true ? recipeMicrosoftLocationLookup() : ''}` : ''}<details><summary>${esc(uiText('Optional schedule'))}</summary><div class="recipe-fields">${optional.map(k => recipeField(k, fieldValue(k), false)).join('')}</div></details>${timed ? `<input type="hidden" name="schedule_timezone" value="${esc(zoneOf(selected))}"><p class="form-note" id="recipe-timezone-note">${esc(zoneNote(selected))}</p>` : ''}${context.recipe.platform === 'meta' ? `<details><summary>${esc(uiText('Audience age'))}</summary><p class="form-note">${esc(uiText('Meta targets ages 18–65 unless you set a range from 13 to 65.'))}</p><div class="recipe-fields">${['age_min', 'age_max'].map(k => recipeField(k, values[k], false)).join('')}</div></details>` : ''}${context.recipe.platform === 'tiktok' ? `<details><summary>${esc(uiText('Business Center identity'))}</summary><p class="form-note">${esc(uiText('Needed only for a BC_AUTH_TT identity: the Business Center that authorized the TikTok account.'))}</p><div class="recipe-fields">${recipeField('identity_authorized_bc_id', values.identity_authorized_bc_id, false)}</div></details>` : ''}${
          context.conventions
            ? `<fieldset class="recipe-conventions"><legend>${esc(uiText('Client playbook rules'))}</legend><input type="hidden" name="playbook_rules_seen" value="1"><label class="form-note"><input type="checkbox" name="apply_playbook_rules" value="true" ${rulesOn ? 'checked' : ''}> ${esc(uiText('Apply this playbook’s naming and tracking rules to this plan'))}</label>${context.conventions.naming ? `<p class="form-note">${esc(uiText('Naming rule'))}: <code dir="ltr">${esc(context.conventions.naming)}</code></p>` : ''}${
                Object.keys(context.conventions.utm ?? {}).length
                  ? `<p class="form-note">${esc(uiText('Tracking parameters'))}: <code dir="ltr">${esc(
                      Object.entries(context.conventions.utm)
                        .map(([k, v]) => k + '=' + v)
                        .join('&'),
                    )}</code></p>`
                  : ''
              }<p class="form-note">${esc(uiText('Inspect plan shows your input beside the playbook result before anything is saved.'))}</p></fieldset>`
            : ''
        }<p class="form-note">${context.profile ? esc(uiText('Defaults from {name}, revision {revision}. Edited fields override those defaults.', {name: context.profile.name, revision: context.profile.revision})) : uiText('Supply the business decisions for this campaign.')} ${esc(uiText('Drafts stay in this tab; select Create plan to save server-side. Account currency is verified in preflight.'))}</p>${!context.targets.length ? recipeNoTargetNotice(context) : ''}<div class="dialog-actions"><button type="button" id="recipe-inspect" class="button">${esc(uiText('Inspect plan'))}</button><button type="button" id="recipe-brief-check" class="button">${esc(uiText('Check this brief'))}</button><button type="button" id="recipe-eligibility" class="button">${esc(uiText('Check account prerequisites'))}</button><button type="button" id="recipe-save-brief" class="button" ${viewer ? 'disabled' : ''}>${esc(uiText('Save as client brief'))}</button><button type="submit" class="button primary" ${viewer ? 'disabled' : ''}>${esc(uiText('Create paused campaign plan'))}</button></div></form>`;
      const f = $('#recipe-form');
      const formCurrent = () => mounted() && sequence === loading && f.isConnected && $('#recipe-form') === f;
      const valuesHash = () => JSON.stringify(Object.fromEntries(new FormData(f)));
      const changed = () => {
        ++actionSequence;
        draft();
        if (formCurrent()) {
          $('#recipe-preview').innerHTML = '';
          if (context.recipe.platform === 'google') $('#recipe-lookup-results').innerHTML = '';
          $('#recipe-error').textContent = '';
        }
      };
      if (f.elements.page_id) {
        const list = document.createElement('datalist');
        list.id = 'recipe-pages';
        for (const page of context.pages) {
          const option = document.createElement('option');
          option.value = page.id;
          option.label = page.name + ' · ' + page.connection_id;
          list.append(option);
        }
        f.append(list);
        f.elements.page_id.setAttribute('list', 'recipe-pages');
      }
      f.addEventListener('input', changed);
      f.addEventListener('change', changed);
      // The note under the TikTok Search pack's keywords box follows what is typed or pasted (the box has no length limit). It is a live
      // region, which announces a rewrite, so it is written only when its words change.
      if (recipe === 'tiktok_search_traffic')
        f.elements.keywords?.addEventListener('input', event => {
          const note = $('#recipe-keyword-count'),
            next = recipeKeywordNote(event.target.value);
          if (note && note.textContent !== next) note.textContent = next;
        });
      f.elements.target.addEventListener('change', () => {
        const t = context.targets.find(
          t => JSON.stringify({connection_id: t.connection_id, account_id: t.account_id}) === f.elements.target.value,
        );
        if (t?.currency) f.elements.currency.value = t.currency;
        if (timed) {
          f.elements.schedule_timezone.value = t?.timezone || '';
          $('#recipe-timezone-note').textContent = zoneNote(f.elements.target.value);
        }
        changed();
      });
      if (context.recipe.platform === 'google')
        $('#recipe-lookup').addEventListener('click', async () => {
          const b = $('#recipe-lookup');
          const snapshot = valuesHash(),
            kind = $('#recipe-lookup-kind').value,
            query = $('#recipe-lookup-query').value;
          const current = () =>
            formCurrent() &&
            snapshot === valuesHash() &&
            kind === $('#recipe-lookup-kind').value &&
            query === $('#recipe-lookup-query').value;
          b.disabled = true;
          try {
            if (!f.elements.target.value) throw Error(uiText('Choose an account first.'));
            const target = JSON.parse(f.elements.target.value),
              out = await workspaceCall('campaign', {
                action: 'recipe_lookup',
                ...target,
                query,
                lookup_kind: kind,
              });
            if (!current()) return;
            $('#recipe-lookup-results').innerHTML =
              out.results
                .map(
                  r =>
                    `<button type="button" class="button small" data-recipe-criterion="` +
                    esc(r.id) +
                    '">' +
                    esc(r.name) +
                    ' · ' +
                    esc(r.id) +
                    `</button>`,
                )
                .join('') || `<p>${esc(uiText('No matching targeting constants. Try a different name.'))}</p>`;
            $('#recipe-lookup-results')
              .querySelectorAll('[data-recipe-criterion]')
              .forEach(el =>
                el.addEventListener('click', () => {
                  if (!current()) return;
                  const field = f.elements[kind === 'country' ? 'country_criterion_ids' : 'language_criterion_ids'];
                  field.value = [
                    ...new Set([...field.value.split(/\r?\n/).filter(Boolean), el.dataset.recipeCriterion]),
                  ].join('\n');
                  changed();
                  field.focus();
                }),
              );
          } catch (e) {
            if (current()) $('#recipe-error').textContent = recipeErrorText(e);
          } finally {
            if (formCurrent()) b.disabled = false;
          }
        });
      // CMP-03: Microsoft location IDs by name, or a check of the IDs entered. An answer is shown only while the account
      // and the query (or the entered IDs) are still the ones it was read for; Add puts its ID in the brief, for the
      // account it was read for, and keeps the other results for the next one.
      if (context.recipe.platform === 'microsoft' && context.location_lookup?.available === true) {
        const results = $('#recipe-ms-location-results'),
          entered = () => [
            ...new Set(
              String(f.elements.location_ids?.value ?? '')
                .split(/[\r\n,]+/)
                .map(s => s.trim())
                .filter(Boolean),
            ),
          ];
        const lookup = async (button, mode) => {
          const target = f.elements.target.value,
            typed = $('#recipe-ms-location-query').value.trim(),
            // The server reads digits as location IDs (locationQuery), so a number typed as a name is checked as an ID
            // and its answer is a check (before, that answer was refused as incomplete).
            numeric = mode === 'search' && /^[0-9][0-9,\s]*$/.test(typed),
            answer = numeric ? 'resolve' : mode,
            ids = numeric ? [...new Set(typed.split(/[\s,]+/).filter(Boolean))] : entered(),
            query = answer === 'search' ? typed : ids.join(','),
            sameAccount = () => formCurrent() && f.elements.target.value === target,
            current = () =>
              sameAccount() &&
              (mode === 'search'
                ? $('#recipe-ms-location-query').value.trim() === typed
                : entered().join(',') === query);
          button.disabled = true;
          $('#recipe-error').textContent = '';
          try {
            if (!target) throw Error(uiText('Choose an account first.'));
            if (!query)
              throw Error(
                uiText(
                  mode === 'search' ? 'Enter a location name to search for.' : 'Enter the location IDs to check first.',
                ),
              );
            if (answer === 'resolve' && (ids.length > 100 || !ids.every(id => /^[1-9][0-9]{0,18}$/.test(id))))
              throw Error(uiText('Microsoft location IDs are numbers, one per line.'));
            const out = await workspaceCall('campaign', {
              action: 'recipe_lookup',
              lookup_kind: 'microsoft_location',
              ...JSON.parse(target),
              query,
            });
            if (!current()) return;
            if (!recipeMicrosoftLocationsValid(out, answer, ids))
              throw Error(uiText('The location lookup answer is incomplete. Search again.'));
            setHtml(results, recipeMicrosoftLocationsView(out));
            results.querySelectorAll('[data-ms-location]').forEach(el =>
              el.addEventListener('click', () => {
                if (!sameAccount()) return;
                const field = f.elements.location_ids,
                  listed = String(field.value ?? '')
                    .split(/\r?\n/)
                    .map(s => s.trim())
                    .filter(Boolean);
                field.value = [...new Set([...listed, el.dataset.msLocation])].join('\n');
                changed();
                field.focus();
              }),
            );
          } catch (e) {
            if (current()) $('#recipe-error').textContent = recipeErrorText(e);
          } finally {
            if (formCurrent()) button.disabled = false;
          }
        };
        $('#recipe-ms-location-search').addEventListener('click', () =>
          lookup($('#recipe-ms-location-search'), 'search'),
        );
        $('#recipe-ms-location-check').addEventListener('click', () =>
          lookup($('#recipe-ms-location-check'), 'resolve'),
        );
        // Enter in the name field searches; it never submits the brief.
        $('#recipe-ms-location-query').addEventListener('keydown', event => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (!$('#recipe-ms-location-search').disabled) lookup($('#recipe-ms-location-search'), 'search');
        });
        f.elements.target.addEventListener('change', () => (results.innerHTML = ''));
      }
      const business = () => {
        const all = readRecipeBusiness(f);
        for (const [k, v] of Object.entries(context.defaults ?? {}))
          if (JSON.stringify(all[k]) === JSON.stringify(v)) delete all[k];
        return all;
      };
      // One creation key per exact brief: a double submit or a retry after a lost response returns the plan already
      // saved instead of a second draft; a changed brief, or the next plan after a save, gets a new key (CMP-02 b).
      let creation = {snapshot: undefined, key: ''};
      const creationKey = snapshot => {
        if (creation.snapshot !== snapshot) creation = {snapshot, key: crypto.randomUUID()};
        return creation.key;
      };
      // live is the account prerequisite check; Check this brief inspects the brief alone, without a provider request.
      const act = async (action, live = action === 'recipe_eligibility') => {
        if (!formCurrent() || !f.reportValidity()) return;
        const request = ++actionSequence,
          snapshot = valuesHash();
        const current = () => formCurrent() && request === actionSequence && snapshot === valuesHash();
        const key = action === 'create_from_recipe' ? creationKey(snapshot) : undefined;
        $('#recipe-error').textContent = '';
        draft();
        try {
          const out = await workspaceCall('campaign', {
            action,
            recipe,
            ...(profile ? {profile_id: profile} : {}),
            business: business(),
            ...(action === 'recipe_eligibility' ? {live} : {}),
            ...(key ? {idempotency_key: key} : {}),
            ...(context.conventions ? {apply_playbook_rules: !!f.elements.apply_playbook_rules?.checked} : {}),
            ...(action === 'create_from_recipe' && activeBrief ? {brief_id: activeBrief.id} : {}),
            // A live check of these exact values lets the plan skip a second preflight read (CMP-06).
            ...(action === 'create_from_recipe' && eligibility?.snapshot === snapshot
              ? {eligibility_ref: eligibility.ref}
              : {}),
          });
          if (action === 'recipe_eligibility' && live && typeof out.eligibility_ref === 'string')
            eligibility = {ref: out.eligibility_ref, snapshot};
          // Only this saved brief's key retires: a newer brief's key stays for its own retry.
          if (key && creation.key === key) creation = {snapshot: undefined, key: ''};
          if (!current()) return;
          if (action === 'create_from_recipe') {
            await openCampaign(out.id);
            if (!mounted() || request !== actionSequence) return;
            $('#recipe-preview').innerHTML = '';
            $('#campaign-detail').setAttribute('tabindex', '-1');
            $('#campaign-detail').focus();
            toast(uiText('Campaign plan saved. Run preflight and review each step.'));
          } else {
            $('#recipe-preview').innerHTML =
              action === 'recipe_eligibility'
                ? recipeEligibilityView(out, recipe)
                : recipeConventionView(out.provenance) + conversionRecipePreview(out);
            $('#recipe-preview').focus();
          }
        } catch (e) {
          if (current()) $('#recipe-error').textContent = recipeErrorText(e);
        }
      };
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const button = f.querySelector('[type="submit"]');
        button.disabled = true;
        try {
          await act('create_from_recipe');
        } finally {
          if (formCurrent()) button.disabled = viewer;
        }
      });
      // A client brief: the recipe, playbook and these inputs, saved for the next plan (CMP-06).
      $('#recipe-save-brief').addEventListener('click', async () => {
        if (!formCurrent() || !f.reportValidity()) return;
        const button = $('#recipe-save-brief'),
          request = ++actionSequence;
        button.disabled = true;
        $('#recipe-error').textContent = '';
        try {
          const all = readRecipeBusiness(f),
            saved = await workspaceCall('workspace', {
              action: 'save_brief',
              ...(activeBrief?.recipe === recipe ? {id: activeBrief.id, revision: activeBrief.revision} : {}),
              brief: {
                name:
                  String(all.name ?? '')
                    .trim()
                    .slice(0, 100) || uiText('Untitled brief'),
                recipe,
                ...(profile ? {profile_id: profile} : {}),
                business: all,
              },
            });
          if (!formCurrent() || request !== actionSequence) return;
          activeBrief = {id: saved.id, revision: saved.revision, recipe};
          briefsLoaded = false;
          toast(uiText('Client brief saved. Plans created from it record its revision.'));
        } catch (e) {
          if (formCurrent()) $('#recipe-error').textContent = recipeErrorText(e);
        } finally {
          if (formCurrent()) button.disabled = viewer;
        }
      });
      for (const [id, action, live] of [
        ['#recipe-inspect', 'preview_recipe'],
        ['#recipe-brief-check', 'recipe_eligibility', false],
        ['#recipe-eligibility', 'recipe_eligibility', true],
      ]) {
        const button = $(id);
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await act(action, live);
          } finally {
            if (formCurrent()) button.disabled = false;
          }
        });
      }
    } catch (e) {
      if (sequence === loading && mounted()) {
        $('#recipe-fields').textContent = '';
        $('#recipe-error').textContent = recipeErrorText(e);
      }
    }
  };
  for (const el of [$('#recipe-choice'), $('#recipe-profile')])
    el.addEventListener('change', () => {
      draft();
      if (el === $('#recipe-choice')) activeBrief = null;
      void renderFields();
    });
  // Choosing an objective lists its workflows and opens the first (CMP-06).
  $('#recipe-objective').addEventListener('change', () => {
    draft();
    const objective = $('#recipe-objective').value,
      first = recipeObjectiveRecipes(recipes, objective)[0]?.id ?? '';
    $('#recipe-choice').innerHTML = recipeOptions(recipes, objective, first);
    $('#recipe-choice').value = first;
    activeBrief = null;
    void renderFields();
  });
  const useBrief = async summary => {
    const brief = await workspaceCall('workspace', {action: 'brief', id: summary.id});
    if (!mounted()) return;
    if (!recipes.some(r => r.id === brief.recipe))
      throw Error(uiText('The linked workflow is not available. Choose a workflow.'));
    const objective = recipeObjectiveOf(brief.recipe);
    recipeDrafts.set(JSON.stringify([brief.recipe, brief.profile_id ?? '']), {
      values: recipeBriefValues(brief.business),
    });
    $('#recipe-objective').value = objective;
    $('#recipe-choice').innerHTML = recipeOptions(recipes, objective, brief.recipe);
    $('#recipe-choice').value = brief.recipe;
    $('#recipe-profile').value = profiles.some(p => p.id === brief.profile_id) ? brief.profile_id : '';
    await renderFields();
    if (mounted()) activeBrief = {id: brief.id, revision: brief.revision, recipe: brief.recipe};
  };
  $('#recipe-briefs').addEventListener('toggle', async () => {
    if (!$('#recipe-briefs').open || briefsLoaded) return;
    briefsLoaded = true;
    const list = $('#recipe-brief-list');
    try {
      const {briefs = []} = await workspaceCall('workspace', {action: 'briefs'});
      if (!mounted()) return;
      list.innerHTML = briefs.length
        ? briefs
            .map(
              (b, i) =>
                `<div class="token-row"><div><strong>${esc(b.name)}</strong><small>${esc(uiText(recipes.find(r => r.id === b.recipe)?.name ?? b.recipe))} · ${esc(uiText('Revision {revision}', {revision: b.revision}))}</small></div><button type="button" class="button small" data-recipe-brief="${i}">${esc(uiText('Use this brief'))}</button></div>`,
            )
            .join('')
        : `<p class="form-note">${esc(uiText('No saved briefs yet. Complete a brief and choose Save as client brief.'))}</p>`;
      list.querySelectorAll('[data-recipe-brief]').forEach(el =>
        el.addEventListener('click', () =>
          useBrief(briefs[Number(el.dataset.recipeBrief)]).catch(e => {
            if (mounted()) $('#recipe-error').textContent = recipeErrorText(e);
          }),
        ),
      );
    } catch (e) {
      briefsLoaded = false;
      if (mounted()) list.textContent = recipeErrorText(e);
    }
  });
  await renderFields();
}
