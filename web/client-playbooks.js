'use strict';
async function renderClientPlaybooks() {
  const generation = navigationGeneration,
    identity = identityGeneration;
  // WEB-06: the profiles response names the recipe fields a playbook can default, so this page needs only the workspace
  // tool, which a test account may use. An older server without them falls back to the campaign recipes; a refusal
  // there (a test account) hides only the recipe defaults.
  const profileData = await workspaceCall('workspace', {action: 'profiles'}),
    {profiles} = profileData;
  let recipes = Array.isArray(profileData.recipe_defaults)
    ? profileData.recipe_defaults.map(r => ({id: r.id, name: r.name, required: r.fields ?? []}))
    : null;
  if (!recipes)
    recipes = await workspaceCall('campaign', {action: 'recipes'}).then(
      r => r.recipes,
      e => {
        if (e?.code === 'TEST_ACCOUNT_SCOPE' || e?.code === 'FORBIDDEN') return [];
        throw e;
      },
    );
  if (generation !== navigationGeneration || identity !== identityGeneration) return;
  // "Build a campaign" opens the composer with this playbook chosen (WEB-06), where the workspace includes Campaigns.
  const campaignsOpen = typeof routeAvailable !== 'function' || routeAvailable('/campaigns');
  // Advertising accounts first (CMP-06): a playbook binds the accounts its campaigns use; Drive files, sheets and
  // properties are listed only when asked for or already bound.
  const advertising = p => ['ad_accounts', 'advertisers'].includes(p.selectionKind ?? 'ad_accounts');
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
  const platformName = gateway => platforms.find(p => p.gateway === gateway)?.name ?? gateway;
  // defaults.common (CMP-06): one value every workflow that takes the field starts from; a workflow's own wins.
  const sharedDefaults = '*common',
    sharedKeys = [...new Set(recipes.flatMap(r => r.required ?? []))];
  // The list names what each playbook binds, so a client is recognised without opening it (CMP-06).
  const bindingSummary = p => {
    const bound = Array.isArray(p.bindings) ? p.bindings : [];
    return bound.length
      ? uiText('{count} bound accounts · {platforms}', {
          count: uiNumber(bound.length),
          platforms: [...new Set(bound.map(b => platformName(b.gateway)))].join(', '),
        })
      : uiText('No bound accounts: any connected account can be chosen');
  };
  content.innerHTML += `<div class="workspace-columns client-playbook-columns"><section class="panel"><h2>${esc(uiText('Clients and approved playbooks'))}</h2>${profiles.length > 1 ? `<label class="work-filter">${esc(uiText('Find a client'))}<input type="search" id="profile-search" data-derived maxlength="100" autocomplete="off"></label><p class="form-note" id="profile-search-empty" role="status" hidden>${esc(uiText('No client matches this search.'))}</p>` : ''}<p class="notice" id="profile-link-missing" role="status" hidden>${esc(uiText('The linked client playbook is not available in this workspace. Choose a playbook.'))}</p><div id="profile-list">${profiles.map((p, i) => `<div class="token-row" data-profile-row="${i}"><div><strong>${esc(p.name)}</strong><small>${esc(uiText('Revision {revision} · {date}', {revision: p.revision, date: date(p.approved_at)}))}</small><small>${esc(bindingSummary(p))}</small>${campaignsOpen ? `<a href="/campaigns?profile_id=${encodeURIComponent(p.id)}#campaign-create">${esc(uiText('Build a campaign'))}</a>` : ''}</div><button class="button small" data-edit-profile="${i}">${esc(uiText('Open'))}</button></div>`).join('') || blank(uiText('Save a client’s selected accounts, naming, tracking and campaign defaults.'))}</div><button class="button" id="new-client">${esc(uiText('New client'))}</button></section><section class="panel workspace-form"><h2 id="profile-heading">${esc(uiText('New client playbook'))}</h2><form id="profile-form">${controls(uiText('Client name'), 'text', '', 'name')}${controls(uiText('Naming convention'), 'text', '{{campaign_name}}', 'naming')}<p class="form-note">${esc(uiText('Use named variables such as {{campaign_name}} or {{market}}. Preview the resolved names and tracking URL before approval.'))}</p><fieldset><legend>${esc(uiText('Tracking defaults'))}</legend>${[
    ['utm_source', uiText('UTM source')],
    ['utm_medium', uiText('UTM medium')],
    ['utm_campaign', uiText('UTM campaign')],
    ['utm_content', uiText('UTM content')],
    ['utm_term', uiText('UTM term')],
  ]
    .map(([k, label]) => controls(label, 'text', k === 'utm_campaign' ? '{{campaign_name}}' : '', k))
    .join(
      '',
    )}</fieldset><fieldset><legend>${esc(uiText('Reusable report branding'))}</legend><label class="form-note"><input type="checkbox" name="include_presentation"> ${esc(uiText('Include approved branding for client report packs'))}</label><div id="profile-branding-fields" hidden><div class="work-filter">${controls(uiText('Report brand name'), 'text', '', 'report_brand_name')}<label>${esc(uiText('Report accent color'))}<input type="color" name="report_accent_color" value="#354B67"></label><label>${esc(uiText('Report PDF layout'))}<select name="report_template"><option value="standard">${esc(uiText('Standard spacing'))}</option><option value="compact">${esc(uiText('Compact spacing'))}</option></select></label><label>${esc(uiText('PDF and Excel language'))}<select name="report_artifact_language"><option value="en">${esc(uiText('English'))}</option><option value="ar">${esc(uiText('Arabic'))}</option></select></label></div>${controls(uiText('Report footer'), 'text', '', 'report_footer')}<p class="form-note">${esc(uiText('PDF and Excel language is saved separately from the interface language. Previously stored files keep their original content.'))}</p><p class="form-note">${esc(uiText('Apply an approved profile revision from a report pack. Earlier snapshots keep the branding they received. Bound accounts also restrict where this branding can be applied.'))}</p></div></fieldset><fieldset id="profile-accounts"><legend>${esc(uiText('Bound accounts'))}</legend></fieldset><fieldset id="profile-recipe-defaults" ${recipes.length ? '' : 'hidden'}><legend>${esc(uiText('Campaign recipe defaults'))}</legend><label>${esc(uiText('Recipe'))}<select id="profile-recipe">${recipes.map(r => `<option value="${esc(r.id)}">${esc(uiText(r.name))}</option>`).join('')}<option value="${sharedDefaults}">${esc(uiText('Shared by every workflow'))}</option></select></label><div id="profile-default-fields"></div><p class="form-note">${esc(uiText('Blank fields supply no default. Currency, identity, conversion and account choices still require preflight. Existing plans keep their saved revision.'))}</p></fieldset><fieldset id="profile-conversions"><legend>${esc(uiText('Conversion references'))}</legend><p class="form-note">${esc(uiText('Name a conversion goal and enter its exact existing reference as text. These are reusable declarations; provider ownership and event delivery are not verified and campaign preflight is still required.'))}</p><div id="profile-conversion-fields"></div><button type="button" class="button small" id="profile-conversion-add">${esc(uiText('Add conversion reference'))}</button><p class="form-note">${esc(uiText('Edit up to 50 simple text references here. Structured, unusual or additional saved mappings remain in Advanced settings and are preserved.'))}</p></fieldset><details><summary>${esc(uiText('Advanced templates, variables and conversion mappings'))}</summary><label>${esc(uiText('Native campaign templates'))}<textarea name="templates" rows="5">{}</textarea></label><label>${esc(uiText('Additional defaults, named variables and conversion mappings'))}<textarea name="additional" rows="5">{}</textarea></label></details><fieldset><legend>${esc(uiText('Preview a campaign'))}</legend>${controls(uiText('Example campaign name'), 'text', 'Autumn launch', 'example_name')}${controls(uiText('Landing page for tracking preview'), 'url', 'https://example.com/', 'example_url')}<label>${esc(uiText('Saved native template'))}<select name="preview_template"><option value="">${esc(uiText('Naming and tracking only'))}</option></select></label><label>${esc(uiText('Example variable overrides (JSON)'))}<textarea name="example_variables" rows="2">{}</textarea></label><button type="button" class="button" id="preview-profile">${esc(uiText('Preview resolved settings'))}</button></fieldset><div id="profile-preview" aria-live="polite"></div><label class="form-note"><input type="checkbox" name="approve" required> ${esc(uiText('I approve these reusable settings and selected account bindings.'))}</label><div class="dialog-actions"><button class="button primary" type="submit">${esc(uiText('Save approved playbook'))}</button><button type="button" class="button" id="duplicate-profile" hidden>${esc(uiText('Duplicate playbook'))}</button><button type="button" class="button danger" id="delete-profile" hidden>${esc(uiText('Delete playbook'))}</button></div></form></section></div>`;
  // `editing` is the saved playbook a save revises (none for a new or duplicated one); `origin` is what the form was
  // filled from, whose structured naming and extra UTM keys a save keeps.
  let editing = null,
    origin = null,
    defaults = {},
    conversionReferences = [],
    conversionGeneration = 0,
    currentRecipe = recipes[0]?.id,
    showAllAccounts = false,
    // Unsaved edits since the playbook was opened (CMP-06): leaving asks first.
    edited = false;
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
  // Choosing which defaults or example to look at changes nothing that a save stores.
  const viewControls = new Set(['example_name', 'example_url', 'example_variables', 'preview_template']);
  const invalidate = event => {
    if (!current() || event?.target === form.elements.approve || event?.target?.id === 'profile-accounts-all') return;
    if (!event || (!viewControls.has(event.target?.name) && event.target?.id !== 'profile-recipe')) edited = true;
    version++;
    previewSequence++;
    form.elements.approve.checked = false;
    preview.innerHTML = '';
  };
  const dirty = () => current() && edited;
  if (typeof pageLeaveGuard !== 'undefined') pageLeaveGuard = dirty;
  /** Whether the person may replace the form: nothing unsaved, or they chose to discard it. */
  const discardEdits = async () =>
    !dirty() ||
    ((await confirmAction({
      title: uiText('Discard unsaved edits?'),
      consequence: uiText('Unsaved edits to this playbook will be lost. Saved playbooks are kept.'),
      confirmLabel: uiText('Discard edits'),
    })) &&
      current());
  // The open playbook is in the address (CMP-06), so a reload or a shared link reopens it.
  const showLocation = p => {
    if (typeof setViewLocation === 'function' && typeof location === 'object' && location?.pathname === '/profiles')
      setViewLocation('/profiles' + (p?.id ? '?profile_id=' + encodeURIComponent(p.id) : ''));
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
    const shared = currentRecipe === sharedDefaults,
      values = {...(shared ? defaults.common : defaults.recipes?.[currentRecipe])};
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
    if (shared) defaults.common = values;
    else defaults.recipes = {...defaults.recipes, [currentRecipe]: values};
  };
  const drawDefaults = () => {
    const shared = currentRecipe === sharedDefaults,
      recipe = recipes.find(r => r.id === currentRecipe),
      values = (shared ? defaults.common : defaults.recipes?.[currentRecipe]) ?? {};
    // Reusable creative and targeting defaults are explicit; regulated declarations and resource IDs stay in the campaign brief.
    const keys = (shared ? sharedKeys : (recipe?.required ?? [])).filter(k =>
      [
        'daily_budget',
        'cpc_bid',
        'cpc_bid_ceiling',
        'target_cpa',
        'target_roas',
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
    $('#profile-default-fields').innerHTML =
      (shared
        ? `<p class="form-note">${esc(uiText('Every workflow that takes one of these fields starts from it. A value set for one workflow wins.'))}</p>`
        : '') +
      keys
        .map(
          k =>
            `<label>${esc(recipeLabels[k] ? uiText(recipeLabels[k]) : pretty(k))}${recipeArrays.has(k) ? `<textarea data-default-field="${k}" rows="2">${esc((values[k] ?? []).join?.('\n') ?? values[k] ?? '')}</textarea>` : `<input data-default-field="${k}" value="${esc(values[k] ?? '')}">`}</label>`,
        )
        .join('');
  };
  const sameBinding = (a, b) =>
    a.gateway === b.gateway && a.connection_id === b.connection_id && a.account_id === b.account_id;
  // Bound accounts grouped by platform (CMP-06). Files, sheets and properties are listed only on request or when bound.
  const drawAccounts = bindings => {
    const options = [...targets];
    for (const b of bindings)
      if (!options.some(t => sameBinding(t, b)))
        options.push({
          ...b,
          label: uiText('Unavailable: {account} · {connection}', {account: b.account_id, connection: b.connection_id}),
        });
    const isAdvertising = gateway => {
        const p = platforms.find(p => p.gateway === gateway);
        return !p || advertising(p);
      },
      others = options.some(t => !isAdvertising(t.gateway)),
      groups = new Map();
    for (const t of options) {
      const checked = bindings.some(b => sameBinding(t, b));
      if (!showAllAccounts && !checked && !isAdvertising(t.gateway)) continue;
      if (!groups.has(t.gateway)) groups.set(t.gateway, []);
      groups.get(t.gateway).push({t, checked});
    }
    $('#profile-accounts').innerHTML =
      `<legend>${esc(uiText('Bound accounts'))}</legend>` +
      (others
        ? `<label class="form-note"><input type="checkbox" id="profile-accounts-all" data-derived ${showAllAccounts ? 'checked' : ''}> ${esc(uiText('Also list files, spreadsheets and properties'))}</label>`
        : '') +
      ([...groups]
        .map(
          ([gateway, rows]) =>
            `<fieldset class="profile-account-group"><legend>${esc(platformName(gateway))} · ${esc(uiNumber(rows.length))}</legend>${rows
              .map(({t, checked}) => {
                const {label, ...binding} = t;
                return `<label class="form-note"><input type="checkbox" data-profile-binding value="${esc(JSON.stringify(binding))}" ${checked ? 'checked' : ''}> ${esc(label)}</label>`;
              })
              .join('')}</fieldset>`,
        )
        .join('') || `<p class="form-note">${esc(uiText('No connected advertising account yet.'))}</p>`);
    $('#profile-accounts-all')?.addEventListener?.('change', event => {
      if (!current()) return;
      showAllAccounts = event.target.checked;
      drawAccounts([...form.querySelectorAll('[data-profile-binding]:checked')].map(el => JSON.parse(el.value)));
    });
  };
  const captureConversions = () => {
    conversionReferences = conversionReferences.map((_, i) => ({
      name: $('#profile-conversion-name-' + i).value,
      value: $('#profile-conversion-value-' + i).value,
    }));
  };
  const drawConversions = () => {
    const drawn = ++conversionGeneration;
    $('#profile-conversion-fields').innerHTML = conversionReferences.length
      ? conversionReferences
          .map(
            (_, i) =>
              `<div class="profile-conversion-row"><label for="profile-conversion-name-${i}">${esc(uiText('Goal name {number}', {number: i + 1}))}</label><input id="profile-conversion-name-${i}" maxlength="80" dir="auto"><label for="profile-conversion-value-${i}">${esc(uiText('Exact reference {number}', {number: i + 1}))}</label><input id="profile-conversion-value-${i}" maxlength="2048" dir="auto"><button id="profile-conversion-remove-${i}" class="button small" type="button">${esc(uiText('Remove reference {number}', {number: i + 1}))}</button></div>`,
          )
          .join('')
      : `<p class="form-note">${esc(uiText('No simple conversion references.'))}</p>`;
    conversionReferences.forEach((r, i) => {
      $('#profile-conversion-name-' + i).value = r.name;
      $('#profile-conversion-value-' + i).value = r.value;
      $('#profile-conversion-remove-' + i).addEventListener('click', () => {
        if (!current() || drawn !== conversionGeneration) return;
        captureConversions();
        conversionReferences.splice(i, 1);
        invalidate();
        drawConversions();
        (conversionReferences.length
          ? $('#profile-conversion-name-' + Math.min(i, conversionReferences.length - 1))
          : $('#profile-conversion-add')
        ).focus();
      });
    });
    $('#profile-conversion-add').disabled = conversionReferences.length >= 50;
  };
  $('#profile-conversion-add').addEventListener('click', () => {
    if (!current() || conversionReferences.length >= 50) return;
    captureConversions();
    conversionReferences.push({name: '', value: ''});
    invalidate();
    drawConversions();
    $('#profile-conversion-name-' + (conversionReferences.length - 1)).focus();
  });
  const conversionDraft = advanced => {
    if (advanced !== undefined && (!advanced || typeof advanced !== 'object' || Array.isArray(advanced)))
      throw Error(uiText('Advanced conversion mappings must be a named JSON object.'));
    captureConversions();
    const result = Object.entries(advanced ?? {}),
      seen = new Set(result.map(([name]) => name));
    for (const {name, value} of conversionReferences) {
      if (name === '' && value === '') continue;
      if (!simpleConversionReference(name, value))
        throw Error(
          uiText(
            'Use a goal name of 1–80 letters, numbers, spaces, underscores, periods or hyphens and a nonempty exact text reference up to 2,048 characters.',
          ),
        );
      if (seen.has(name))
        throw Error(uiText('Conversion reference names must be unique across guided and Advanced settings.'));
      seen.add(name);
      result.push([name, value]);
    }
    return Object.fromEntries(result);
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
    if (extra.defaults?.common !== undefined)
      throw Error(
        uiText(
          'Edit shared defaults with “Shared by every workflow” in the Campaign recipe defaults fields above. Remove defaults.common from advanced settings.',
        ),
      );
    return {
      ...extra,
      conversion_mappings: conversionDraft(extra.conversion_mappings),
      name: form.elements.name.value,
      naming:
        origin?.naming &&
        typeof origin.naming === 'object' &&
        form.elements.naming.value === JSON.stringify(origin.naming)
          ? origin.naming
          : form.elements.naming.value,
      utm: {
        ...(origin?.utm ?? {}),
        ...Object.fromEntries(
          ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].map(k => [k, form.elements[k].value]),
        ),
      },
      defaults: {
        ...(extra.defaults ?? {}),
        ...(defaults.common && Object.keys(defaults.common).length ? {common: defaults.common} : {}),
        recipes: defaults.recipes ?? {},
      },
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
  // `p` is the saved playbook to revise, or null for a new one; `source` fills the form (a duplicate's copy).
  const load = (saved, p = saved) => {
    if (!current()) return;
    invalidate();
    editing = saved;
    origin = p;
    defaults = structuredClone(p?.defaults ?? {});
    $('#profile-heading').textContent = saved
      ? uiText('Edit {name} · revision {revision}', {name: saved.name, revision: saved.revision})
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
    conversionReferences = [];
    const advancedMappings = Object.fromEntries(
      Object.entries(p?.conversion_mappings ?? {}).filter(([name, value]) => {
        if (conversionReferences.length >= 50 || !simpleConversionReference(name, value)) return true;
        conversionReferences.push({name, value});
        return false;
      }),
    );
    drawConversions();
    form.elements.additional.value = JSON.stringify(
      {
        defaults: Object.fromEntries(
          Object.entries(p?.defaults ?? {}).filter(([key]) => key !== 'recipes' && key !== 'common'),
        ),
        variables: p?.variables ?? {},
        conversion_mappings: advancedMappings,
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
    $('#delete-profile').hidden = !saved || session.workspaceRole === 'viewer';
    $('#duplicate-profile').hidden = !saved || session.workspaceRole === 'viewer';
    $('#profile-preview').innerHTML = '';
    drawAccounts(p?.bindings ?? []);
    drawDefaults();
    // The filled playbook is the form's starting state, so a language switch does not report edits (WEB-05).
    if (typeof uiMarkPristine === 'function') uiMarkPristine(form);
    // A duplicate is not saved yet, so leaving it asks first.
    edited = p !== saved;
    showLocation(saved);
  };
  $('#profile-recipe').addEventListener('change', e => {
    saveDefaults();
    currentRecipe = e.target.value;
    drawDefaults();
  });
  // Opening another playbook or a new one asks before discarding unsaved edits (CMP-06).
  workspaceBind('[data-edit-profile]', async b => {
    const p = profiles[Number(b.dataset.editProfile)];
    if (!dirty()) return load(p);
    if (await discardEdits()) load(p);
  });
  workspaceBind('#new-client', async () => {
    if (!dirty()) return load(null);
    if (await discardEdits()) load(null);
  });
  // A new client from an existing playbook (CMP-06): every setting is copied into an unsaved new playbook, which needs
  // its own approval. The copy keeps the account bindings, which still grant nothing.
  workspaceBind('#duplicate-profile', async () => {
    if (!current() || !editing || !(await discardEdits())) return;
    const {id, revision, approved_at, approved_by, created_at, updated_at, ...copy} = structuredClone(editing);
    copy.name = uiText('Copy of {name}', {name: editing.name}).slice(0, 100);
    load(null, copy);
    form.elements.name.focus?.();
  });
  // Search narrows the list by client name; it changes nothing saved (CMP-06).
  $('#profile-search')?.addEventListener?.('input', event => {
    if (!current()) return;
    const query = event.target.value.trim().toLocaleLowerCase();
    let shown = 0;
    $('#profile-list')
      .querySelectorAll('[data-profile-row]')
      .forEach(row => {
        const match =
          !query ||
          String(profiles[Number(row.dataset.profileRow)]?.name ?? '')
            .toLocaleLowerCase()
            .includes(query);
        row.hidden = !match;
        if (match) shown++;
      });
    $('#profile-search-empty').hidden = shown > 0;
  });
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
          campaign_defaults: result.defaults ?? {},
          report_branding: result.report_presentation,
        },
        uiText('Resolved playbook preview'),
      ) +
      profileConversionPreview(result.conversion_mappings ?? {}) +
      (result.steps ? reviewTable(result.steps, uiText('Resolved native template steps')) : '') +
      `<p>${esc(profilePreviewExplanation(result.meaning))}</p>`;
  });
  workspaceBind('#profile-form', async () => {
    if (!current()) return;
    const active = selected();
    let saved;
    try {
      saved = await workspaceCall('workspace', {
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
    // The page reopens on the playbook just saved.
    edited = false;
    if (typeof saved?.id === 'string') showLocation(saved);
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
    edited = false;
    showLocation(null);
    await renderWorkspacePage();
  });
  // /profiles?profile_id= reopens that playbook; one this workspace does not have is named, not silently replaced.
  const linked =
    typeof URLSearchParams === 'function' && typeof location === 'object' && location
      ? new URLSearchParams(location.search ?? '').get('profile_id')
      : null;
  const linkedProfile = linked ? profiles.find(p => p.id === linked) : null;
  if (linked && !linkedProfile) $('#profile-link-missing').hidden = false;
  load(linkedProfile ?? null);
  if (session.workspaceRole === 'viewer') {
    form.elements.approve.disabled = true;
    form.querySelector('button[type="submit"]').disabled = true;
  }
}

function simpleConversionReference(name, value) {
  return (
    typeof name === 'string' &&
    /^[\p{L}\p{N}_][\p{L}\p{M}\p{N} _.-]{0,79}$/u.test(name) &&
    name.trim() === name &&
    !['__proto__', 'constructor', 'prototype'].includes(name) &&
    typeof value === 'string' &&
    value.length <= 2048 &&
    value.trim() !== '' &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function profileConversionPreview(mappings) {
  const simple = [],
    advanced = [];
  for (const [name, value] of Object.entries(mappings)) {
    if (simple.length < 50 && simpleConversionReference(name, value)) simple.push([name, value]);
    else advanced.push([name, value]);
  }
  return `<section class="profile-conversion-preview"><h3>${esc(uiText('Declared conversion references'))}</h3><p class="form-note">${esc(uiText('Provider ownership and event delivery are not verified by this local preview. These references do not replace campaign preflight.'))}</p>${simple.length ? `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Declared conversion references'))}"><table class="review-table"><caption>${esc(uiText('Declared conversion references'))}</caption><thead><tr><th scope="col">${esc(uiText('Conversion goal'))}</th><th scope="col">${esc(uiText('Exact reference'))}</th></tr></thead><tbody>${simple.map(([name, value]) => `<tr><th scope="row"><bdi dir="auto">${esc(name)}</bdi></th><td><bdi dir="auto">${esc(value)}</bdi></td></tr>`).join('')}</tbody></table></div>` : `<p>${esc(uiText('No simple conversion references.'))}</p>`}${advanced.length ? `<details class="workspace-details"><summary>${esc(uiText('Other declared conversion mappings'))}</summary><pre class="code-block">${esc(JSON.stringify(Object.fromEntries(advanced), null, 2))}</pre></details>` : ''}</section>`;
}

function profilePreviewExplanation(meaning) {
  return meaning ===
    'Preview only. Defaults are copied into a new draft; existing plans and schedules keep their recorded profile revision. Account bindings do not grant access.'
    ? uiText(
        'Preview only. Defaults are copied into a new draft; existing plans and schedules keep their recorded profile revision. Account bindings do not grant access.',
      )
    : meaning;
}
