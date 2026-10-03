/* Business-input forms share the server recipes and retain drafts only in this tab.
 * Provider labels and profile text are rendered as data, never HTML or instructions. */
const recipeDrafts = new Map();
const recipeLabels = {
  name: 'Campaign name',
  daily_budget: 'Daily budget in account currency',
  cpc_bid: 'Maximum cost per click',
  cpc_bid_ceiling: 'Campaign CPC ceiling in account currency',
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
  return `<label>${esc(label)}<input ${attr} type="${name.endsWith('_url') ? 'url' : name.endsWith('_date') ? 'date' : 'text'}" value="${esc(text)}" ${['daily_budget', 'cpc_bid', 'cpc_bid_ceiling'].includes(name) ? 'inputmode="decimal"' : ''} maxlength="2048"></label>`;
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
  location_targeting_before_activation: 'Location targeting before activation',
  provider_objective_acceptance: 'Provider objective acceptance',
};
const recipeEligibilityLabels = {
  ready: 'Confirmed for this check',
  blocked: 'Blocked',
  unknown: 'Needs further verification',
  needs_user_input: 'Complete the brief',
};
function recipeEligibilityView(out) {
  const status = value => esc(uiText(recipeEligibilityLabels[value] ?? 'Needs further verification'));
  return `<section aria-label="${esc(uiText('Account prerequisite evidence'))}"><h3>${esc(uiText('Account prerequisite evidence'))}</h3><p>${status(out.status)}</p><p>${esc(uiText('This check saves no campaign plan and makes no advertising changes. Each later change still needs its own review.'))}</p>${out.scope ? `<p>${esc(uiText('Advertising login and account'))}: <code>${esc(out.scope.connection_id)}</code> · <code>${esc(out.scope.account_id)}</code></p>` : ''}${out.expires_at ? `<p>${esc(uiText('Evidence expires'))}: ${esc(date(out.expires_at))}</p>` : ''}${out.missing_fields?.length ? `<p>${esc(uiText('Missing business inputs'))}: ${out.missing_fields.map(key => esc(uiText(recipeLabels[key] ?? pretty(key)))).join(', ')}</p>` : ''}<dl>${(out.dependencies ?? []).map(row => `<dt>${esc(uiText(recipeDependencyLabels[row.id] ?? pretty(row.id)))} — ${status(row.status)}</dt><dd><code>${esc(row.id)}</code><p>${esc(uiText(row.meaning))}</p></dd>`).join('')}</dl>${out.blockers?.length ? `<h4>${esc(uiText('Resolve before review'))}</h4><ul>${out.blockers.map(row => `<li>${esc(row.step_id ?? '')} ${esc(row.code)}: ${esc(uiText(row.message ?? row.source ?? 'Current workspace prerequisite'))}</li>`).join('')}</ul>` : ''}${out.deferred?.length ? `<h4>${esc(uiText('Checks after predecessor verification'))}</h4><ul>${out.deferred.map(row => `<li>${esc(row.step ?? '')}: ${esc(uiText(row.reason))}</li>`).join('')}</ul>` : ''}${out.warnings?.length ? `<h4>${esc(uiText('Account policy notices'))}</h4><ul>${out.warnings.map(row => `<li>${esc(uiText(row.message))}</li>`).join('')}</ul>` : ''}${recordDetails(out, uiText('Native evidence and input provenance'))}</section>`;
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
        `${context.limitations.map(l => `<p class="notice">${esc(l)}</p>`).join('')}<form id="recipe-form"><div class="recipe-fields"><label>${esc(uiText('Advertising login and account'))}<select name="target" required><option value="">${esc(uiText('Choose the exact login and account'))}</option>${context.targets
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
            $('#campaign-detail').setAttribute('tabindex', '-1');
            $('#campaign-detail').focus();
            toast(uiText('Campaign plan saved. Run preflight and review each step.'));
          } else {
            $('#recipe-preview').innerHTML =
              action === 'recipe_eligibility'
                ? recipeEligibilityView(out)
                : recordDetails(out, uiText('Compiled plan and input provenance'));
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
