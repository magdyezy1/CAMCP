/* Business-input forms share the server recipes and retain drafts only in this tab.
 * Provider labels and profile text are rendered as data, never HTML or instructions. */
const recipeDrafts = new Map();
const recipeLabels = {
  name: 'Campaign name',
  daily_budget: 'Daily budget in account currency',
  cpc_bid: 'Maximum cost per click',
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
  const label = recipeLabels[name] ?? pretty(name),
    attr = `name="${name}" ${required ? 'required' : ''}`;
  if (name === 'click_attribution_days' || name === 'view_attribution_days') {
    const options =
      name === 'click_attribution_days'
        ? [
            ['1', '1 day after a click'],
            ['7', '7 days after a click'],
          ]
        : [
            ['0', 'Exclude view-through attribution'],
            ['1', '1 day after a view'],
          ];
    return `<label>${esc(label)}<select ${attr}><option value="">Choose explicitly</option>${options.map(([v, label]) => `<option value="${v}" ${String(value) === v ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
  }
  if (name === 'special_ad_categories')
    return `<label>Special ad category<select ${attr}><option value="">Choose explicitly</option><option value="none" ${value === 'none' || (Array.isArray(value) && !value.length) ? 'selected' : ''}>None apply</option><option value="regulated" ${value?.length ? 'selected' : ''}>A regulated category applies — use a tailored plan</option></select></label>`;
  if (name === 'contains_eu_political_advertising')
    return `<label>EU political advertising declaration<select ${attr}><option value="">Choose explicitly</option>${['DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', 'CONTAINS_EU_POLITICAL_ADVERTISING'].map(v => `<option value="${v}" ${value === v ? 'selected' : ''}>${v.startsWith('DOES_NOT') ? 'Does not contain EU political advertising' : 'Contains EU political advertising'}</option>`).join('')}</select></label>`;
  const text = Array.isArray(value) ? value.join('\n') : (value ?? '');
  if (recipeArrays.has(name) || name === 'message')
    return `<label>${esc(label)}<textarea ${attr} rows="3" maxlength="6000">${esc(text)}</textarea></label>`;
  return `<label>${esc(label)}<input ${attr} type="${name.endsWith('_url') ? 'url' : name.endsWith('_date') ? 'date' : 'text'}" value="${esc(text)}" ${['daily_budget', 'cpc_bid'].includes(name) ? 'inputmode="decimal"' : ''} maxlength="2048"></label>`;
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
      'Use a tailored native plan for regulated categories; this website recipe does not set compliant targeting.',
    );
  return {...v, ...target};
}
async function mountRecipeBuilder(profiles, openCampaign) {
  const {recipes} = await workspaceCall('campaign', {action: 'recipes'}),
    viewer = session.workspaceRole === 'viewer';
  const section = document.createElement('section');
  section.className = 'panel workspace-form recipe-builder';
  section.innerHTML = `<h2>Build from business inputs</h2><p>Choose a workflow, complete the brief, then inspect a paused campaign plan. Each provider change receives its own review.</p><div class="recipe-choice"><label>Workflow<select id="recipe-choice">${recipes.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select></label><label>Approved client profile<select id="recipe-profile"><option value="">No profile</option>${profiles.map(p => `<option value="${esc(p.id)}">${esc(p.name)} · revision ${p.revision}</option>`).join('')}</select></label></div><div id="recipe-fields" aria-live="polite"></div><p id="recipe-error" class="error" role="alert"></p><div id="recipe-preview" tabindex="-1"></div>`;
  $('#campaign-create > summary').after(section);
  let currentKey = '',
    context = null,
    loading = 0;
  const draft = () => {
    const f = $('#recipe-form');
    if (f && currentKey) recipeDrafts.set(currentKey, {values: Object.fromEntries(new FormData(f)), context});
  };
  const renderFields = async () => {
    const sequence = ++loading,
      recipe = $('#recipe-choice').value,
      profile = $('#recipe-profile').value;
    currentKey = JSON.stringify([recipe, profile]);
    $('#recipe-error').textContent = '';
    $('#recipe-preview').innerHTML = '';
    $('#recipe-fields').textContent = 'Loading selected accounts and approved defaults…';
    try {
      const nextContext = await workspaceCall('campaign', {
        action: 'recipe_context',
        recipe,
        ...(profile ? {profile_id: profile} : {}),
      });
      if (sequence !== loading || !section.isConnected) return;
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
        `${context.limitations.map(l => `<p class="notice">${esc(l)}</p>`).join('')}<form id="recipe-form"><div class="recipe-fields"><label>Advertising login and account<select name="target" required><option value="">Choose the exact login and account</option>${context.targets
          .map(t => {
            const id = JSON.stringify({connection_id: t.connection_id, account_id: t.account_id});
            return `<option value="${esc(id)}" ${selected === id ? 'selected' : ''}>${esc(t.label)}${t.write_granted ? '' : ' — read access only'}</option>`;
          })
          .join(
            '',
          )}</select></label><label>Account currency<input name="currency" value="${esc(values.currency ?? '')}" pattern="[A-Z]{3}" maxlength="3" required></label>${required.map(k => recipeField(k, values[k], true)).join('')}${recipe.startsWith('meta') ? `<label>Private Drive access<select name="drive_connection_id"><option value="">Public link or resolve a selected login</option>${context.drive_connections.map(c => `<option value="${esc(c.id)}" ${values.drive_connection_id === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>` : ''}</div>${recipe === 'google_search' ? '<details><summary>Find Google targeting IDs</summary><label>Type<select id="recipe-lookup-kind"><option value="country">Country</option><option value="language">Language</option></select></label><label>Country name/code or language<input id="recipe-lookup-query" maxlength="60"></label><button type="button" class="button" id="recipe-lookup">Find targeting</button><div id="recipe-lookup-results" aria-live="polite"></div></details>' : ''}<details><summary>Optional schedule</summary><div class="recipe-fields">${optional.map(k => recipeField(k, values[k], false)).join('')}</div></details><p class="form-note">${context.profile ? 'Defaults from ' + esc(context.profile.name) + ' revision ' + context.profile.revision + '. Edited fields override those defaults.' : 'Supply the business decisions for this campaign.'} Drafts stay in this tab; select Create plan to save server-side. Account currency is verified in preflight.</p>${!context.targets.length ? '<p class="notice">Connect and select an account first. <a href="/connections">Manage connections</a></p>' : ''}<div class="dialog-actions"><button type="button" id="recipe-inspect" class="button">Inspect plan</button><button type="submit" class="button primary" ${viewer ? 'disabled' : ''}>Create paused campaign plan</button></div></form>`;
      const f = $('#recipe-form');
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
      f.addEventListener('input', draft);
      f.elements.target.addEventListener('change', () => {
        const t = context.targets.find(
          t => JSON.stringify({connection_id: t.connection_id, account_id: t.account_id}) === f.elements.target.value,
        );
        if (t?.currency) f.elements.currency.value = t.currency;
        draft();
      });
      if (recipe === 'google_search')
        $('#recipe-lookup').addEventListener('click', async () => {
          const b = $('#recipe-lookup');
          b.disabled = true;
          try {
            if (!f.elements.target.value) throw Error('Choose an account first.');
            const target = JSON.parse(f.elements.target.value),
              kind = $('#recipe-lookup-kind').value,
              out = await workspaceCall('campaign', {
                action: 'recipe_lookup',
                ...target,
                query: $('#recipe-lookup-query').value,
                lookup_kind: kind,
              });
            $('#recipe-lookup-results').innerHTML =
              out.results
                .map(
                  r =>
                    '<button type="button" class="button small" data-recipe-criterion="' +
                    esc(r.id) +
                    '">' +
                    esc(r.name) +
                    ' · ' +
                    esc(r.id) +
                    '</button>',
                )
                .join('') || '<p>No matching targeting constants. Try a different name.</p>';
            $('#recipe-lookup-results')
              .querySelectorAll('[data-recipe-criterion]')
              .forEach(el =>
                el.addEventListener('click', () => {
                  const field = f.elements[kind === 'country' ? 'country_criterion_ids' : 'language_criterion_ids'];
                  field.value = [
                    ...new Set([...field.value.split(/\r?\n/).filter(Boolean), el.dataset.recipeCriterion]),
                  ].join('\n');
                  draft();
                  field.focus();
                }),
              );
          } catch (e) {
            $('#recipe-error').textContent = e.message;
          } finally {
            b.disabled = false;
          }
        });
      const business = () => {
        const all = readRecipeBusiness(f);
        for (const [k, v] of Object.entries(context.defaults ?? {}))
          if (JSON.stringify(all[k]) === JSON.stringify(v)) delete all[k];
        return all;
      };
      const act = async create => {
        if (!f.reportValidity()) return;
        $('#recipe-error').textContent = '';
        draft();
        try {
          const out = await workspaceCall('campaign', {
            action: create ? 'create_from_recipe' : 'preview_recipe',
            recipe,
            ...(profile ? {profile_id: profile} : {}),
            business: business(),
          });
          if (create) {
            await openCampaign(out.id);
            $('#campaign-detail').setAttribute('tabindex', '-1');
            $('#campaign-detail').focus();
            toast('Campaign plan saved. Run preflight and review each step.');
          } else {
            $('#recipe-preview').innerHTML = recordDetails(out, 'Compiled plan and input provenance');
            $('#recipe-preview').focus();
          }
        } catch (e) {
          $('#recipe-error').textContent = e.message;
        }
      };
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const button = f.querySelector('[type="submit"]');
        button.disabled = true;
        try {
          await act(true);
        } finally {
          button.disabled = viewer;
        }
      });
      $('#recipe-inspect').addEventListener('click', () => act(false));
    } catch (e) {
      if (sequence === loading) {
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
