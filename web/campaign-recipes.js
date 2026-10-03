/* Business-input forms share the server recipes and retain drafts only in this tab.
 * Provider labels and profile text are rendered as data, never HTML or instructions. */
const recipeDrafts = new Map();
const recipeLabels = {
  name: 'Campaign name',
  daily_budget: 'Daily budget in account currency',
  cpc_bid: 'Maximum cost per click',
  cpc_bid_ceiling: 'Campaign CPC ceiling in account currency',
  target_cpa: 'Target cost per conversion in account currency',
  conversion_goal_policy: 'Conversion goals for this campaign',
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
  keywords: 'Exact-match keywords — one per line',
  headlines: 'Search ad headlines — one per line (3–15, 30 characters each)',
  descriptions: 'Search ad descriptions — one per line (2–4, 90 characters each)',
  language: 'Ad language',
  start_date: 'Start date in account timezone',
  end_date: 'End date in account timezone',
  start_time: 'Start timestamp with UTC offset',
  end_time: 'End timestamp with UTC offset',
};
const recipeArrays = new Set([
  'country_codes',
  'country_criterion_ids',
  'language_criterion_ids',
  'keywords',
  'headlines',
  'descriptions',
]);
function recipeField(name, value, required) {
  const label = uiText(recipeLabels[name] ?? pretty(name)),
    attr = `name="${name}" ${required ? 'required' : ''}`;
  if (name === 'conversion_goal_policy')
    return `<label>${esc(label)}<select ${attr}><option value="">${esc(uiText('Choose explicitly'))}</option><option value="ACCOUNT_DEFAULT" ${value === 'ACCOUNT_DEFAULT' ? 'selected' : ''}>${esc(uiText('Use the account-default conversion goals'))}</option></select></label>`;
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
  const text = Array.isArray(value) ? value.join('\n') : (value ?? '');
  if (recipeArrays.has(name) || name === 'message')
    return `<label>${esc(label)}<textarea ${attr} rows="3" maxlength="6000">${esc(text)}</textarea></label>`;
  return `<label>${esc(label)}<input ${attr} type="${name.endsWith('_url') ? 'url' : name.endsWith('_date') ? 'date' : 'text'}" value="${esc(text)}" ${['daily_budget', 'cpc_bid', 'cpc_bid_ceiling', 'target_cpa'].includes(name) ? 'inputmode="decimal"' : ''} maxlength="2048"></label>`;
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
  location_criteria: 'Google location targeting',
  language_criteria: 'Google language targeting',
  campaign_cpc_ceiling: 'Campaign CPC ceiling',
  account_default_conversion_goals: 'Current account-default conversion goals',
  primary_conversion_actions: 'Enabled primary conversion actions',
  campaign_target_cpa: 'Campaign target cost per conversion',
  location_targeting_before_activation: 'Location targeting before activation',
  provider_objective_acceptance: 'Provider objective acceptance',
};
const recipeEligibilityLabels = {
  ready: 'Confirmed for this check',
  blocked: 'Blocked',
  unknown: 'Needs further verification',
  needs_user_input: 'Complete the brief',
};
function conversionRecipePreview(out) {
  const recipe = out.recipe,
    plan = out.plan,
    details = () => recordDetails(out, uiText('Compiled plan and input provenance'));
  if (
    out.ready !== true ||
    out.provider_mutations !== 0 ||
    !['google_search_conversions', 'google_search_target_cpa'].includes(recipe?.id) ||
    recipe.conversion_goal_policy !== 'ACCOUNT_DEFAULT' ||
    recipe.bidding_strategy !== 'MAXIMIZE_CONVERSIONS' ||
    !/^[A-Z]{3}$/.test(recipe.currency) ||
    !Array.isArray(plan?.steps) ||
    !plan.steps.length
  )
    return details();
  const campaignStep = plan.steps.find(s => s.id === 'campaign'),
    budgetStep = plan.steps.find(s => s.id === 'budget'),
    campaign = campaignStep?.arguments?.payload?.operations?.[0]?.create,
    budget = budgetStep?.arguments?.payload?.operations?.[0]?.create;
  const amount = value =>
    typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
  const target = campaign?.maximize_conversions?.target_cpa_micros,
    wantsTarget = recipe.id === 'google_search_target_cpa';
  if (
    campaign?.status !== 'PAUSED' ||
    campaign.advertising_channel_type !== 'SEARCH' ||
    !campaign.maximize_conversions ||
    typeof campaign.maximize_conversions !== 'object' ||
    Array.isArray(campaign.maximize_conversions) ||
    Object.keys(campaign.maximize_conversions).some(key => key !== 'target_cpa_micros') ||
    !amount(budget?.amount_micros) ||
    budget.explicitly_shared !== false ||
    (wantsTarget
      ? !amount(target) || target !== recipe.target_cpa_micros
      : target !== undefined || recipe.target_cpa_micros !== undefined) ||
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
  return `<section aria-label="${esc(uiText('Paused conversion campaign preview'))}" class="conversion-recipe-preview"><h3>${esc(uiText('Paused conversion campaign preview'))}</h3><p>${esc(uiText('Local preview only. No plan is saved and no advertising changes are sent.'))}</p><dl><div><dt>${esc(uiText('Campaign name'))}</dt><dd><bdi dir="auto">${esc(plan.name)}</bdi></dd></div><div><dt>${esc(uiText('Advertising login and account'))}</dt><dd><code dir="ltr">${esc(campaignStep.connection_id)}</code> · <code dir="ltr">${esc(campaignStep.account_id)}</code></dd></div><div><dt>${esc(uiText('Daily budget in account currency'))}</dt><dd><bdi dir="ltr">${esc(decimal(budget.amount_micros))}</bdi> · ${esc(uiText('Native micros'))}: <code dir="ltr">${esc(budget.amount_micros)}</code></dd></div><div><dt>${esc(uiText('Bidding strategy'))}</dt><dd>${esc(uiText('Maximize Conversions'))}</dd></div><div><dt>${esc(uiText('Target cost per conversion in account currency'))}</dt><dd>${wantsTarget ? `<bdi dir="ltr">${esc(decimal(target))}</bdi> · ${esc(uiText('Native micros'))}: <code dir="ltr">${esc(target)}</code>` : esc(uiText('No target CPA'))}</dd></div><div><dt>${esc(uiText('Conversion goals for this campaign'))}</dt><dd>${esc(uiText('Use the account-default conversion goals'))}</dd></div></dl><p class="notice">${esc(uiText('Goal settings, primary conversion actions, event delivery and provider eligibility still need verification before activation.'))}</p><p>${esc(uiText('A target CPA is an average optimization target, not a per-conversion spending cap or guarantee.'))}</p>${details()}</section>`;
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
function recipeBlockerMeaning(row) {
  if (row.message) return uiText(row.message);
  if (Object.hasOwn(recipePrerequisiteLabels, row.code)) return uiText(recipePrerequisiteLabels[row.code]);
  return uiText(row.source ?? 'Current workspace prerequisite');
}
function recipeEligibilityView(out) {
  const status = value => esc(uiText(recipeEligibilityLabels[value] ?? 'Needs further verification'));
  return `<section aria-label="${esc(uiText('Account prerequisite evidence'))}"><h3>${esc(uiText('Account prerequisite evidence'))}</h3><p>${status(out.status)}</p><p>${esc(uiText('This check saves no campaign plan and makes no advertising changes. Each later change still needs its own review.'))}</p>${out.scope ? `<p>${esc(uiText('Advertising login and account'))}: <code>${esc(out.scope.connection_id)}</code> · <code>${esc(out.scope.account_id)}</code></p>` : ''}${out.expires_at ? `<p>${esc(uiText('Evidence expires'))}: ${esc(date(out.expires_at))}</p>` : ''}${out.missing_fields?.length ? `<p>${esc(uiText('Missing business inputs'))}: ${out.missing_fields.map(key => esc(uiText(recipeLabels[key] ?? pretty(key)))).join(', ')}</p>` : ''}${conversionGoalInspectionView(out)}<dl>${(out.dependencies ?? []).map(row => `<dt>${esc(uiText(recipeDependencyLabels[row.id] ?? pretty(row.id)))} — ${status(row.status)}</dt><dd><code>${esc(row.id)}</code><p>${esc(uiText(row.meaning))}</p></dd>`).join('')}</dl>${out.blockers?.length ? `<h4>${esc(uiText('Resolve before review'))}</h4><ul>${out.blockers.map(row => `<li>${esc(row.step_id ?? '')} ${esc(row.code)}: ${esc(recipeBlockerMeaning(row))}</li>`).join('')}</ul>` : ''}${out.deferred?.length ? `<h4>${esc(uiText('Checks after predecessor verification'))}</h4><ul>${out.deferred.map(row => `<li>${esc(row.step ?? '')}: ${esc(uiText(row.reason))}</li>`).join('')}</ul>` : ''}${out.warnings?.length ? `<h4>${esc(uiText('Account policy notices'))}</h4><ul>${out.warnings.map(row => `<li>${esc(uiText(row.message))}</li>`).join('')}</ul>` : ''}${recordDetails(out, uiText('Native evidence and input provenance'))}</section>`;
}
async function mountRecipeBuilder(profiles, openCampaign) {
  const {recipes} = await workspaceCall('campaign', {action: 'recipes'}),
    viewer = session.workspaceRole === 'viewer';
  const section = document.createElement('section');
  section.className = 'panel workspace-form recipe-builder';
  section.innerHTML = `<h2>${esc(uiText('Build from business inputs'))}</h2><p>${esc(uiText('Choose a workflow, complete the brief, then inspect a paused campaign plan. Each provider change receives its own review.'))}</p><div class="recipe-choice"><label>${esc(uiText('Workflow'))}<select id="recipe-choice">${recipes.map(r => `<option value="${esc(r.id)}">${esc(uiText(r.name))}</option>`).join('')}</select></label><label>${esc(uiText('Approved client profile'))}<select id="recipe-profile"><option value="">${esc(uiText('No profile'))}</option>${profiles.map(p => `<option value="${esc(p.id)}">${esc(p.name)} ${esc(uiText('· revision'))} ${p.revision}</option>`).join('')}</select></label></div><div id="recipe-fields" aria-live="polite"></div><p id="recipe-error" class="error" role="alert"></p><div id="recipe-preview" tabindex="-1"></div>`;
  $('#campaign-create > summary').after(section);
  let currentKey = '',
    context = null,
    loading = 0,
    actionSequence = 0;
  const route = navigationGeneration,
    identity = identityGeneration;
  const mounted = () => section.isConnected && route === navigationGeneration && identity === identityGeneration;
  const draft = () => {
    const f = $('#recipe-form');
    if (f && currentKey) recipeDrafts.set(currentKey, {values: Object.fromEntries(new FormData(f)), context});
  };
  const renderFields = async () => {
    ++actionSequence;
    const sequence = ++loading,
      recipe = $('#recipe-choice').value,
      profile = $('#recipe-profile').value;
    currentKey = JSON.stringify([recipe, profile]);
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
        optional = recipe.startsWith('meta') ? ['start_time', 'end_time'] : ['start_date', 'end_date'];
      const selected =
        values.target ??
        (values.connection_id && values.account_id
          ? JSON.stringify({connection_id: values.connection_id, account_id: values.account_id})
          : '');
      $('#recipe-fields').innerHTML =
        `${context.limitations.map(l => `<p class="notice">${esc(uiText(l))}</p>`).join('')}<form id="recipe-form"><div class="recipe-fields"><label>${esc(uiText('Advertising login and account'))}<select name="target" required><option value="">${esc(uiText('Choose the exact login and account'))}</option>${context.targets
          .map(t => {
            const id = JSON.stringify({connection_id: t.connection_id, account_id: t.account_id});
            return `<option value="${esc(id)}" ${selected === id ? 'selected' : ''}>${esc(t.label)}${t.write_granted ? '' : uiText(' — read access only')}</option>`;
          })
          .join(
            '',
          )}</select></label><label>${esc(uiText('Account currency'))}<input name="currency" value="${esc(values.currency ?? '')}" pattern="[A-Z]{3}" maxlength="3" required></label>${required.map(k => recipeField(k, values[k], true)).join('')}${recipe.startsWith('meta') ? `<label>${esc(uiText('Private Drive access'))}<select name="drive_connection_id"><option value="">${esc(uiText('Public link or resolve a selected login'))}</option>${context.drive_connections.map(c => `<option value="${esc(c.id)}" ${values.drive_connection_id === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>` : ''}</div>${context.recipe.platform === 'google' ? `<details><summary>${esc(uiText('Find Google targeting IDs'))}</summary><label>${esc(uiText('Type'))}<select id="recipe-lookup-kind"><option value="country">${esc(uiText('Country'))}</option><option value="language">${esc(uiText('Language'))}</option></select></label><label>${esc(uiText('Country name/code or language'))}<input id="recipe-lookup-query" maxlength="60"></label><button type="button" class="button" id="recipe-lookup">${esc(uiText('Find targeting'))}</button><div id="recipe-lookup-results" aria-live="polite"></div></details>` : ''}<details><summary>${esc(uiText('Optional schedule'))}</summary><div class="recipe-fields">${optional.map(k => recipeField(k, values[k], false)).join('')}</div></details><p class="form-note">${context.profile ? esc(uiText('Defaults from {name}, revision {revision}. Edited fields override those defaults.', {name: context.profile.name, revision: context.profile.revision})) : uiText('Supply the business decisions for this campaign.')} ${esc(uiText('Drafts stay in this tab; select Create plan to save server-side. Account currency is verified in preflight.'))}</p>${!context.targets.length ? `<p class="notice">${esc(uiText('Connect and select an account first.'))} <a href="/connections">${esc(uiText('Manage connections'))}</a></p>` : ''}<div class="dialog-actions"><button type="button" id="recipe-inspect" class="button">${esc(uiText('Inspect plan'))}</button><button type="button" id="recipe-eligibility" class="button">${esc(uiText('Check account prerequisites'))}</button><button type="submit" class="button primary" ${viewer ? 'disabled' : ''}>${esc(uiText('Create paused campaign plan'))}</button></div></form>`;
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
      f.elements.target.addEventListener('change', () => {
        const t = context.targets.find(
          t => JSON.stringify({connection_id: t.connection_id, account_id: t.account_id}) === f.elements.target.value,
        );
        if (t?.currency) f.elements.currency.value = t.currency;
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
            if (current()) $('#recipe-error').textContent = e.message;
          } finally {
            if (formCurrent()) b.disabled = false;
          }
        });
      const business = () => {
        const all = readRecipeBusiness(f);
        for (const [k, v] of Object.entries(context.defaults ?? {}))
          if (JSON.stringify(all[k]) === JSON.stringify(v)) delete all[k];
        return all;
      };
      const act = async action => {
        if (!formCurrent() || !f.reportValidity()) return;
        const request = ++actionSequence,
          snapshot = valuesHash();
        const current = () => formCurrent() && request === actionSequence && snapshot === valuesHash();
        $('#recipe-error').textContent = '';
        draft();
        try {
          const out = await workspaceCall('campaign', {
            action,
            recipe,
            ...(profile ? {profile_id: profile} : {}),
            business: business(),
            ...(action === 'recipe_eligibility' ? {live: true} : {}),
          });
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
              action === 'recipe_eligibility' ? recipeEligibilityView(out) : conversionRecipePreview(out);
            $('#recipe-preview').focus();
          }
        } catch (e) {
          if (current()) $('#recipe-error').textContent = e.message;
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
      for (const [id, action] of [
        ['#recipe-inspect', 'preview_recipe'],
        ['#recipe-eligibility', 'recipe_eligibility'],
      ]) {
        const button = $(id);
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await act(action);
          } finally {
            if (formCurrent()) button.disabled = false;
          }
        });
      }
    } catch (e) {
      if (sequence === loading && mounted()) {
        $('#recipe-fields').textContent = '';
        $('#recipe-error').textContent = e.message;
      }
    }
  };
  for (const el of [$('#recipe-choice'), $('#recipe-profile')])
    el.addEventListener('change', () => {
      draft();
      void renderFields();
    });
  await renderFields();
}
