'use strict';
async function renderClientPlaybooks() {
  const generation = navigationGeneration,
    identity = identityGeneration;
  const [{profiles}, {recipes}] = await Promise.all([
    workspaceCall('workspace', {action: 'profiles'}),
    workspaceCall('campaign', {action: 'recipes'}),
  ]);
  if (generation !== navigationGeneration || identity !== identityGeneration) return;
  const targets = platforms.flatMap(p =>
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
  content.innerHTML += `<div class="workspace-columns"><section class="panel"><h2>${esc(uiText('Clients and approved playbooks'))}</h2>${profiles.map((p, i) => `<div class="token-row"><div><strong>${esc(p.name)}</strong><small>${esc(uiText('Revision {revision} · {date}', {revision: p.revision, date: date(p.approved_at)}))}</small><a href="/campaigns#campaign-create">${esc(uiText('Build a campaign'))}</a></div><button class="button small" data-edit-profile="${i}">${esc(uiText('Open'))}</button></div>`).join('') || blank(uiText('Save a client’s selected accounts, naming, tracking and campaign defaults.'))}<button class="button" id="new-client">${esc(uiText('New client'))}</button></section><section class="panel workspace-form"><h2 id="profile-heading">${esc(uiText('New client playbook'))}</h2><form id="profile-form">${controls(uiText('Client name'), 'text', '', 'name')}${controls(uiText('Naming convention'), 'text', '{{campaign_name}}', 'naming')}<p class="form-note">${esc(uiText('Use named variables such as {{campaign_name}} or {{market}}. Preview the resolved names and tracking URL before approval.'))}</p><fieldset><legend>${esc(uiText('Tracking defaults'))}</legend>${['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].map(k => controls(pretty(k), 'text', k === 'utm_campaign' ? '{{campaign_name}}' : '', k)).join('')}</fieldset><fieldset><legend>${esc(uiText('Reusable report branding'))}</legend><label class="form-note"><input type="checkbox" name="include_presentation"> ${esc(uiText('Include approved branding for client report packs'))}</label><div id="profile-branding-fields" hidden><div class="work-filter">${controls(uiText('Report brand name'), 'text', '', 'report_brand_name')}<label>${esc(uiText('Report accent color'))}<input type="color" name="report_accent_color" value="#354B67"></label><label>${esc(uiText('Report PDF layout'))}<select name="report_template"><option value="standard">${esc(uiText('Standard spacing'))}</option><option value="compact">${esc(uiText('Compact spacing'))}</option></select></label><label>${esc(uiText('PDF and Excel language'))}<select name="report_artifact_language"><option value="en">${esc(uiText('English'))}</option><option value="ar">${esc(uiText('Arabic'))}</option></select></label></div>${controls(uiText('Report footer'), 'text', '', 'report_footer')}<p class="form-note">${esc(uiText('PDF and Excel language is saved separately from the interface language. Previously stored files keep their original content.'))}</p><p class="form-note">${esc(uiText('Apply an approved profile revision from a report pack. Earlier snapshots keep the branding they received. Bound accounts also restrict where this branding can be applied.'))}</p></div></fieldset><fieldset id="profile-accounts"><legend>${esc(uiText('Bound accounts'))}</legend></fieldset><fieldset><legend>${esc(uiText('Campaign recipe defaults'))}</legend><label>${esc(uiText('Recipe'))}<select id="profile-recipe">${recipes.map(r => `<option value="${esc(r.id)}">${esc(uiText(r.name))}</option>`).join('')}</select></label><div id="profile-default-fields"></div><p class="form-note">${esc(uiText('Blank fields supply no default. Currency, identity, conversion and account choices still require preflight. Existing plans keep their saved revision.'))}</p></fieldset><details><summary>${esc(uiText('Advanced templates, variables and conversion mappings'))}</summary><label>${esc(uiText('Native campaign templates'))}<textarea name="templates" rows="5">{}</textarea></label><label>${esc(uiText('Additional defaults, named variables and conversion mappings'))}<textarea name="additional" rows="5">{}</textarea></label></details><fieldset><legend>${esc(uiText('Preview a campaign'))}</legend>${controls(uiText('Example campaign name'), 'text', 'Autumn launch', 'example_name')}${controls(uiText('Landing page for tracking preview'), 'url', 'https://example.com/', 'example_url')}<label>${esc(uiText('Saved native template'))}<select name="preview_template"><option value="">${esc(uiText('Naming and tracking only'))}</option></select></label><label>${esc(uiText('Example variable overrides (JSON)'))}<textarea name="example_variables" rows="2">{}</textarea></label><button type="button" class="button" id="preview-profile">${esc(uiText('Preview resolved settings'))}</button></fieldset><div id="profile-preview" aria-live="polite"></div><label class="form-note"><input type="checkbox" name="approve" required> ${esc(uiText('I approve these reusable settings and selected account bindings.'))}</label><div class="dialog-actions"><button class="button primary" type="submit">${esc(uiText('Save approved playbook'))}</button><button type="button" class="button danger" id="delete-profile" hidden>${esc(uiText('Delete playbook'))}</button></div></form></section></div>`;
  let editing = null,
    defaults = {},
    currentRecipe = recipes[0]?.id;
  const form = $('#profile-form'),
    preview = $('#profile-preview');
  let version = 0,
    previewSequence = 0;
  const current = () =>
    generation === navigationGeneration && identity === identityGeneration && form.isConnected && preview.isConnected;
  const selected = () => {
    const captured = version;
    return () => current() && captured === version;
  };
  const invalidate = event => {
    if (!current() || event?.target === form.elements.approve) return;
    version++;
    previewSequence++;
    form.elements.approve.checked = false;
    preview.innerHTML = '';
  };
  form.addEventListener('input', invalidate);
  form.addEventListener('change', invalidate);
  const brandingFields = ['brand_name', 'accent_color', 'footer', 'template', 'artifact_language'];
  const toggleBranding = () => {
    const included = form.elements.include_presentation.checked;
    $('#profile-branding-fields').hidden = !included;
    for (const key of brandingFields) form.elements['report_' + key].disabled = !included;
  };
  form.elements.include_presentation.addEventListener('change', toggleBranding);
  const saveDefaults = () => {
    if (!currentRecipe) return;
    const values = {...defaults.recipes?.[currentRecipe]};
    $('#profile-default-fields')
      .querySelectorAll('[data-default-field]')
      .forEach(el => {
        const key = el.dataset.defaultField,
          raw = el.value.trim();
        if (!raw) delete values[key];
        else
          values[key] = recipeArrays.has(key)
            ? raw
                .split(/\r?\n/)
                .map(s => s.trim())
                .filter(Boolean)
            : raw;
      });
    defaults.recipes = {...defaults.recipes, [currentRecipe]: values};
  };
  const drawDefaults = () => {
    const recipe = recipes.find(r => r.id === currentRecipe),
      values = defaults.recipes?.[currentRecipe] ?? {};
    // Reusable creative and targeting defaults are explicit; regulated declarations and resource IDs stay in the campaign brief.
    const keys = (recipe?.required ?? []).filter(k =>
      [
        'daily_budget',
        'cpc_bid',
        'country_codes',
        'country_criterion_ids',
        'language_criterion_ids',
        'destination_url',
        'keywords',
        'headlines',
        'descriptions',
        'language',
      ].includes(k),
    );
    $('#profile-default-fields').innerHTML = keys
      .map(
        k =>
          `<label>${esc(recipeLabels[k] ? uiText(recipeLabels[k]) : pretty(k))}${recipeArrays.has(k) ? `<textarea data-default-field="${k}" rows="2">${esc((values[k] ?? []).join?.('\n') ?? values[k] ?? '')}</textarea>` : `<input data-default-field="${k}" value="${esc(values[k] ?? '')}">`}</label>`,
      )
      .join('');
  };
  const drawAccounts = bindings => {
    const options = [...targets];
    for (const b of bindings)
      if (
        !options.some(
          t => t.gateway === b.gateway && t.connection_id === b.connection_id && t.account_id === b.account_id,
        )
      )
        options.push({
          ...b,
          label: uiText('Unavailable: {account} · {connection}', {account: b.account_id, connection: b.connection_id}),
        });
    $('#profile-accounts').innerHTML =
      `<legend>${esc(uiText('Bound accounts'))}</legend>` +
      options
        .map(t => {
          const {label, ...binding} = t;
          return `<label class="form-note"><input type="checkbox" data-profile-binding value="${esc(JSON.stringify(binding))}" ${bindings.some(b => b.gateway === t.gateway && b.connection_id === t.connection_id && b.account_id === t.account_id) ? 'checked' : ''}> ${esc(label)}</label>`;
        })
        .join('');
  };
  const draft = () => {
    saveDefaults();
    const extra = JSON.parse(form.elements.additional.value);
    if (!extra || typeof extra !== 'object' || Array.isArray(extra))
      throw Error(uiText('Additional settings must be a JSON object.'));
    if (Object.keys(extra).some(k => !['defaults', 'variables', 'conversion_mappings'].includes(k)))
      throw Error(uiText('Additional settings accept defaults, variables and conversion_mappings.'));
    if (extra.defaults?.recipes !== undefined)
      throw Error(
        uiText(
          'Edit recipe defaults in the Campaign recipe defaults fields above. Remove defaults.recipes from advanced settings.',
        ),
      );
    return {
      ...extra,
      name: form.elements.name.value,
      naming:
        editing?.naming &&
        typeof editing.naming === 'object' &&
        form.elements.naming.value === JSON.stringify(editing.naming)
          ? editing.naming
          : form.elements.naming.value,
      utm: {
        ...(editing?.utm ?? {}),
        ...Object.fromEntries(
          ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].map(k => [k, form.elements[k].value]),
        ),
      },
      defaults: {...(extra.defaults ?? {}), recipes: defaults.recipes ?? {}},
      templates: JSON.parse(form.elements.templates.value),
      ...(form.elements.include_presentation.checked
        ? {
            report_presentation: Object.fromEntries(
              brandingFields.map(key => [key, form.elements['report_' + key].value]),
            ),
          }
        : {}),
      bindings: [...form.querySelectorAll('[data-profile-binding]:checked')].map(el => JSON.parse(el.value)),
    };
  };
  const load = p => {
    if (!current()) return;
    invalidate();
    editing = p;
    defaults = structuredClone(p?.defaults ?? {});
    $('#profile-heading').textContent = p
      ? uiText('Edit {name} · revision {revision}', {name: p.name, revision: p.revision})
      : uiText('New client playbook');
    form.elements.name.value = p?.name ?? '';
    form.elements.include_presentation.checked = !!p?.report_presentation;
    const presentation = {
      brand_name: '',
      accent_color: '#354B67',
      footer: '',
      template: 'standard',
      artifact_language: 'en',
      ...p?.report_presentation,
    };
    for (const key of brandingFields) form.elements['report_' + key].value = presentation[key];
    toggleBranding();
    form.elements.naming.value =
      typeof p?.naming === 'string' ? p.naming : p?.naming ? JSON.stringify(p.naming) : '{{campaign_name}}';
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'])
      form.elements[k].value = p?.utm?.[k] ?? (k === 'utm_campaign' ? '{{campaign_name}}' : '');
    form.elements.templates.value = JSON.stringify(p?.templates ?? {}, null, 2);
    form.elements.additional.value = JSON.stringify(
      {
        defaults: Object.fromEntries(Object.entries(p?.defaults ?? {}).filter(([key]) => key !== 'recipes')),
        variables: p?.variables ?? {},
        conversion_mappings: p?.conversion_mappings ?? {},
      },
      null,
      2,
    );
    form.elements.preview_template.innerHTML =
      `<option value="">${esc(uiText('Naming and tracking only'))}</option>` +
      Object.keys(p?.templates ?? {})
        .map(k => `<option value="${esc(k)}">${esc(k)}</option>`)
        .join('');
    form.elements.approve.checked = false;
    $('#delete-profile').hidden = !p || session.workspaceRole === 'viewer';
    $('#profile-preview').innerHTML = '';
    drawAccounts(p?.bindings ?? []);
    drawDefaults();
  };
  $('#profile-recipe').addEventListener('change', e => {
    saveDefaults();
    currentRecipe = e.target.value;
    drawDefaults();
  });
  workspaceBind('[data-edit-profile]', b => load(profiles[Number(b.dataset.editProfile)]));
  workspaceBind('#new-client', () => load(null));
  workspaceBind('#preview-profile', async () => {
    if (!current()) return;
    const selection = selected(),
      attempt = ++previewSequence,
      active = () => selection() && attempt === previewSequence;
    preview.innerHTML = '';
    let result;
    try {
      result = await workspaceCall('workspace', {
        action: 'preview_profile',
        profile: draft(),
        preview: {
          variables: {
            campaign_name: form.elements.example_name.value,
            ...JSON.parse(form.elements.example_variables.value),
          },
          destination_url: form.elements.example_url.value,
          ...(form.elements.preview_template.value ? {template: form.elements.preview_template.value} : {}),
        },
      });
    } catch (error) {
      if (active()) throw error;
      return;
    }
    if (!active()) return;
    preview.innerHTML =
      reviewTable(
        {
          name: result.naming,
          tracking: result.utm,
          destination: result.destination_url,
          bindings: result.bindings,
          report_branding: result.report_presentation,
        },
        uiText('Resolved playbook preview'),
      ) +
      (result.steps ? reviewTable(result.steps, uiText('Resolved native template steps')) : '') +
      `<p>${esc(result.meaning)}</p>`;
  });
  workspaceBind('#profile-form', async () => {
    if (!current()) return;
    const active = selected();
    try {
      await workspaceCall('workspace', {
        action: 'save_profile',
        profile: draft(),
        confirmed: form.elements.approve.checked,
        ...(editing ? {id: editing.id, revision: editing.revision} : {}),
      });
    } catch (error) {
      if (active()) throw error;
      return;
    }
    if (!active()) return;
    await renderWorkspacePage();
    if (generation === navigationGeneration && identity === identityGeneration)
      toast(uiText('Approved playbook saved. Existing campaigns and report packs keep their original settings.'));
  });
  workspaceBind('#delete-profile', async () => {
    if (!current() || !editing) return;
    const profile = editing,
      active = selected();
    try {
      if (
        !(await confirmAction({
          title: uiText('Delete {name}?', {name: profile.name}),
          consequence: uiText('Existing plans keep their recorded settings. This removes the reusable playbook.'),
          confirmLabel: uiText('Delete playbook'),
        })) ||
        !active()
      )
        return;
      await workspaceCall('workspace', {
        action: 'delete_profile',
        id: profile.id,
        revision: profile.revision,
        confirmed: true,
      });
    } catch (error) {
      if (active()) throw error;
      return;
    }
    if (!active()) return;
    await renderWorkspacePage();
  });
  load(null);
  if (session.workspaceRole === 'viewer') {
    form.elements.approve.disabled = true;
    form.querySelector('button[type="submit"]').disabled = true;
  }
}
