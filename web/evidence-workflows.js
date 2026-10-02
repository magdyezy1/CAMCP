'use strict';
function mountEvidenceDownload(report, selectionCurrent) {
  const root = $('#report-evidence-download'),
    generation = navigationGeneration,
    identity = identityGeneration,
    current = () =>
      generation === navigationGeneration && identity === identityGeneration && root.isConnected && selectionCurrent();
  if (!current()) return;
  root.innerHTML = `<div class="report-pagination"><label>${esc(uiText('Excel language'))}<select id="evidence-download-language"><option value="en">${esc(uiText('English'))}</option><option value="ar">${esc(uiText('Arabic'))}</option></select></label><button type="button" class="button small" id="evidence-download-xlsx">${esc(uiText('Download all rows as Excel'))}</button></div><p class="form-note">${esc(uiText('Includes all retained rows, totals, field mappings and source references. Numeric values remain text to preserve precision.'))}</p><p id="evidence-download-status" role="status"></p>`;
  const language = $('#evidence-download-language'),
    button = $('#evidence-download-xlsx'),
    status = $('#evidence-download-status');
  language.value = 'en';
  let busy = false;
  button.addEventListener('click', async () => {
    if (!current() || busy) return;
    if (!['en', 'ar'].includes(language.value) || typeof report.id !== 'string' || !report.id) {
      status.textContent = uiText('Choose English or Arabic for the workbook.');
      return;
    }
    busy = true;
    button.disabled = true;
    language.disabled = true;
    root.setAttribute('aria-busy', 'true');
    status.textContent = uiText('Preparing all retained rows…');
    try {
      const response = await fetch(
        '/api/reporting-evidence/' + encodeURIComponent(report.id) + '.xlsx?language=' + language.value,
        {cache: 'no-store'},
      );
      if (!current()) return;
      if (
        !response.ok ||
        response.headers.get('content-type')?.split(';')[0].trim() !==
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
        throw Error('Invalid workbook response');
      const blob = await response.blob();
      if (!current()) return;
      if (!Number.isSafeInteger(blob.size) || blob.size <= 0 || blob.size > 20 * 1024 * 1024)
        throw Error('Invalid workbook size');
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      try {
        link.href = url;
        link.download = 'AMCP-detailed-evidence.xlsx';
        link.click();
        status.textContent = uiText('Detailed evidence prepared for download.');
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch {
      if (current())
        status.textContent = uiText('The evidence workbook could not be downloaded. Retry or reopen the report.');
    } finally {
      busy = false;
      if (current()) {
        button.disabled = false;
        language.disabled = false;
        root.setAttribute('aria-busy', 'false');
      }
    }
  });
}
function mountEvidenceRows(report, selectionCurrent) {
  const root = $('#report-native-rows'),
    generation = navigationGeneration,
    identity = identityGeneration,
    current = () =>
      generation === navigationGeneration && identity === identityGeneration && root.isConnected && selectionCurrent(),
    limit = 50,
    total = report.row_count;
  const labels = {
    entity_id: uiText('Entity ID'),
    entity_name: uiText('Entity name'),
    date: uiText('Date'),
    search_term: uiText('Search term'),
    spend: uiText('Spend'),
    impressions: uiText('Impressions'),
    clicks: uiText('Clicks'),
    conversions: uiText('Conversions'),
    conversion_value: uiText('Conversion value'),
    reach: uiText('Reach'),
    frequency: uiText('Frequency'),
  };
  const columns = Object.keys(labels).filter(
    key =>
      ['entity_id', 'entity_name'].includes(key) ||
      Object.hasOwn(report.mapping ?? {}, key) ||
      (key === 'date' && report.source === 'overview_snapshot'),
  );
  const visible = new Set(columns);
  let offset = 0,
    busy = false,
    columnsOpen = false,
    query = report.row_query ?? '',
    draft = query,
    matched = report.matched_row_count ?? total,
    lastPage = report;
  const pages = () => Math.max(1, Math.ceil(matched / limit));
  const matches = page => page.matched_row_count ?? (query ? undefined : total);
  const valid = (page, start, fresh) =>
    page &&
    typeof page === 'object' &&
    ['id', 'gateway', 'account_id', 'connection_id', 'source_hash'].every(key => page[key] === report[key]) &&
    /^[a-f0-9]{64}$/.test(report.source_hash ?? '') &&
    Number.isSafeInteger(total) &&
    total >= 0 &&
    total <= 10000 &&
    page.row_count === total &&
    (page.row_query ?? '') === query &&
    Number.isSafeInteger(matches(page)) &&
    matches(page) >= 0 &&
    matches(page) <= total &&
    (query !== '' || matches(page) === total) &&
    (fresh || matches(page) === matched) &&
    Array.isArray(page.rows) &&
    page.rows.length === Math.min(limit, Math.max(0, matches(page) - start)) &&
    page.has_more === start + limit < matches(page) &&
    page.rows.every(
      row =>
        row &&
        typeof row === 'object' &&
        !Array.isArray(row) &&
        columns.every(
          key =>
            row[key] == null ||
            typeof row[key] === 'string' ||
            (typeof row[key] === 'number' && Number.isFinite(row[key])),
        ),
    );
  const cell = (row, key) =>
    row[key] == null
      ? `<td>${esc(uiText('Unknown'))}</td>`
      : `<td dir="${['entity_name', 'search_term'].includes(key) ? 'auto' : 'ltr'}">${esc(String(row[key]))}</td>`;
  const heading = () => `<h3>${esc(uiText('Retained native rows'))}</h3>`;
  const controls = () =>
    `<form id="evidence-row-search" class="report-pagination"><label>${esc(uiText('Find an entity, date or search term'))}<input id="evidence-row-query" type="search" maxlength="150" value="${esc(draft)}"></label><div><button type="submit" class="button small" id="evidence-row-apply">${esc(uiText('Search retained rows'))}</button><button type="button" class="button small" id="evidence-row-clear">${esc(uiText('Clear search'))}</button></div></form><p class="form-note">${esc(uiText('Search changes displayed rows only. Totals, analysis and Excel retain the complete report.'))}</p><details id="evidence-columns"${columnsOpen ? ' open' : ''}><summary>${esc(uiText('Visible columns'))}</summary><div class="recipe-fields">${columns.map(key => `<label><input type="checkbox" id="evidence-column-${key}" ${visible.has(key) ? 'checked' : ''}> ${esc(labels[key])}</label>`).join('')}</div><button type="button" class="button small" id="evidence-columns-reset">${esc(uiText('Show all columns'))}</button></details>`;
  const bind = () => {
    const field = $('#evidence-row-query'),
      columnDetails = $('#evidence-columns');
    columnDetails.open = columnsOpen;
    columnDetails.addEventListener('toggle', () => {
      if (current() && columnDetails.isConnected) columnsOpen = columnDetails.open;
    });
    field.value = draft;
    field.addEventListener('input', () => {
      if (!current()) return;
      draft = field.value;
      $('#evidence-row-clear').disabled = busy || (!query && !draft);
    });
    $('#evidence-row-apply').disabled = false;
    $('#evidence-row-search').addEventListener('submit', event => {
      event.preventDefault();
      if (!current() || busy) return;
      if (draft.length > 150 || /[\x00-\x1f\x7f]/.test(draft)) return;
      query = draft.trim();
      return load(0, true);
    });
    $('#evidence-row-clear').disabled = !query && !draft;
    $('#evidence-row-clear').addEventListener('click', () => {
      if (!current() || busy) return;
      draft = '';
      if (!query && lastPage) {
        field.value = '';
        $('#evidence-row-clear').disabled = true;
        field.focus();
        return;
      }
      query = '';
      return load(0, true);
    });
    for (const key of columns) {
      const control = $('#evidence-column-' + key);
      control.checked = visible.has(key);
      control.disabled = !lastPage;
      control.addEventListener('change', () => {
        if (!current() || busy || !lastPage) return;
        columnsOpen = columnDetails.open;
        if (control.checked) visible.add(key);
        else if (visible.size > 1) visible.delete(key);
        else control.checked = true;
        if (lastPage) {
          render(lastPage);
          $('#evidence-column-' + key).focus();
        }
      });
    }
    $('#evidence-columns-reset').disabled = !lastPage;
    $('#evidence-columns-reset').addEventListener('click', () => {
      if (!current() || busy || !lastPage) return;
      columnsOpen = columnDetails.open;
      columns.forEach(key => visible.add(key));
      if (lastPage) {
        render(lastPage);
        $('#evidence-columns-reset').focus();
      }
    });
  };
  const failure = (start, changed = false, fresh = false) => {
    if (!current()) return;
    busy = false;
    lastPage = null;
    root.setAttribute('aria-busy', 'false');
    root.innerHTML =
      heading() +
      controls() +
      `<p class="notice error" role="alert">${esc(changed ? uiText('This evidence changed. Reopen the report before browsing more rows.') : uiText('The saved rows could not be read. Retry or reopen the report.'))}</p><button type="button" class="button small" id="evidence-rows-retry">${esc(uiText('Retry row read'))}</button>`;
    bind();
    $('#evidence-rows-retry').disabled = false;
    $('#evidence-rows-retry').addEventListener('click', () => load(start, fresh));
    $('#evidence-rows-retry').focus();
  };
  function render(page, focus = false) {
    if (!current()) return;
    root.setAttribute('aria-busy', 'false');
    lastPage = page;
    const shown = columns.filter(key => visible.has(key));
    const range = matched
      ? uiText('Rows {from}–{through} of {total}', {
          from: uiNumber(offset + 1),
          through: uiNumber(offset + page.rows.length),
          total: uiNumber(matched),
        })
      : query
        ? uiText('No rows match this search')
        : uiText('No mapped native rows');
    root.innerHTML =
      heading() +
      controls() +
      (query
        ? `<p>${esc(uiText('Matching {matched} of {total} retained rows', {matched: uiNumber(matched), total: uiNumber(total)}))}: <code dir="auto">${esc(query)}</code></p>`
        : '') +
      `<p class="form-note">${esc(uiText('Values retain native IDs and decimal strings. Missing metrics remain unknown.'))}</p>` +
      (matched
        ? `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Native evidence rows, scroll for all fields'))}"><table class="review-table"><caption>${esc(uiText('Mapped native evidence'))}</caption><thead><tr>${shown.map(key => `<th scope="col">${esc(labels[key])}${['spend', 'conversion_value'].includes(key) ? ' · <span dir="ltr">' + esc(report.semantics.currency) + '</span>' : ''}</th>`).join('')}</tr></thead><tbody>${page.rows.map(row => `<tr>${shown.map(key => cell(row, key)).join('')}</tr>`).join('')}</tbody></table></div>`
        : '') +
      `<div class="report-pagination"><p id="evidence-rows-status" role="status" tabindex="-1">${esc(range)}</p><div><button type="button" class="button small" id="evidence-rows-previous">${esc(uiText('Previous page'))}</button><label>${esc(uiText('Page'))}<select id="evidence-rows-page">${Array.from({length: pages()}, (_, i) => `<option value="${i + 1}">${esc(uiNumber(i + 1))}</option>`).join('')}</select></label><button type="button" class="button small" id="evidence-rows-next">${esc(uiText('Next page'))}</button></div></div>`;
    bind();
    $('#evidence-rows-previous').disabled = offset === 0;
    $('#evidence-rows-next').disabled = offset + limit >= matched;
    const select = $('#evidence-rows-page');
    select.value = String(offset / limit + 1);
    select.disabled = pages() === 1;
    $('#evidence-rows-previous').addEventListener('click', () => load(offset - limit));
    $('#evidence-rows-next').addEventListener('click', () => load(offset + limit));
    select.addEventListener('change', () => {
      if (!/^[1-9][0-9]*$/.test(select.value) || Number(select.value) > pages()) return;
      return load((Number(select.value) - 1) * limit);
    });
    if (focus) $('#evidence-rows-status').focus();
  }
  async function load(start, fresh = false) {
    if (
      !current() ||
      busy ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start % limit !== 0 ||
      (!fresh && start >= Math.max(1, matched))
    )
      return;
    busy = true;
    root.setAttribute('aria-busy', 'true');
    for (const id of [
      'evidence-rows-previous',
      'evidence-rows-next',
      'evidence-rows-page',
      'evidence-rows-retry',
      'evidence-row-apply',
      'evidence-row-clear',
      'evidence-columns-reset',
      ...columns.map(key => 'evidence-column-' + key),
    ]) {
      const control = $('#' + id);
      if (control) control.disabled = true;
    }
    let page;
    try {
      page = await workspaceCall('reporting', {
        action: 'get',
        id: report.id,
        offset: start,
        limit,
        ...(query ? {row_query: query} : {}),
      });
    } catch {
      if (current()) failure(start, false, fresh);
      return;
    }
    if (!current()) return;
    if (!valid(page, start, fresh)) {
      failure(start, true, fresh);
      return;
    }
    offset = start;
    matched = matches(page);
    busy = false;
    render(page, true);
  }
  if (!current()) return;
  if (typeof query !== 'string' || query.length > 150 || !valid(report, 0, false)) {
    failure(0, true);
    return;
  }
  render(report);
}

function evidencePresetLabel(preset) {
  switch (preset.id) {
    case 'google_campaign':
      return uiText('Google campaign performance');
    case 'google_adset':
      return uiText('Google ad group performance');
    case 'google_ad':
      return uiText('Google ad performance');
    case 'google_search_terms':
      return uiText('Google search term evidence');
    case 'meta_campaign':
      return uiText('Meta campaign performance');
    case 'meta_adset':
      return uiText('Meta ad set performance');
    case 'meta_ad':
      return uiText('Meta ad performance');
    case 'linkedin_campaign_group':
      return uiText('LinkedIn campaign group performance');
    case 'linkedin_campaign':
      return uiText('LinkedIn campaign performance');
    case 'linkedin_creative':
      return uiText('LinkedIn creative performance');
    case 'tiktok_campaign':
      return uiText('TikTok campaign performance');
    case 'tiktok_adgroup':
      return uiText('TikTok ad group performance');
    case 'tiktok_ad':
      return uiText('TikTok ad performance');
    default:
      return preset.name;
  }
}
function evidenceFormContext(form, current, onChange) {
  let sequence = 0;
  const invalidate = event => {
    if (!current()) return;
    sequence++;
    onChange?.(event);
  };
  form.addEventListener('input', invalidate);
  form.addEventListener('change', invalidate);
  return () => {
    const attempt = ++sequence;
    return () => current() && form.isConnected && attempt === sequence;
  };
}
async function mountCaptureWizard(openReport) {
  const generation = navigationGeneration,
    identity = identityGeneration,
    root = $('#report-capture'),
    current = () => generation === navigationGeneration && identity === identityGeneration && root.isConnected;
  let presets;
  try {
    ({presets} = await workspaceCall('reporting', {action: 'capture_presets'}));
  } catch (error) {
    if (current()) throw error;
    return;
  }
  if (!current()) return;
  const gateways = {
    google: 'google_ads_native_action',
    meta: 'meta_native_action',
    linkedin: 'linkedin_native_action',
    tiktok: 'tiktok_native_action',
  };
  const targets = platforms
    .filter(p => presets.some(s => s.gateway === gateways[p.id]))
    .flatMap(p =>
      p.connections
        .filter(c => c.enabled)
        .flatMap(c =>
          c.accounts.map(account_id => ({
            gateway: gateways[p.id],
            connection_id: c.id,
            account_id,
            label: accountLabel(p, c, account_id),
          })),
        ),
    );
  root.innerHTML = `<summary>${esc(uiText('Capture detailed native evidence'))}</summary><p>${esc(uiText('Choose detailed Google, Meta, LinkedIn or TikTok evidence. Each provider keeps its native reporting levels and measurement definitions. Reading may take up to two minutes.'))}</p><form id="capture-preset"><div class="recipe-fields"><label>${esc(uiText('Report detail'))}<select name="preset">${presets.map(p => `<option value="${esc(p.id)}">${esc(evidencePresetLabel(p))}</option>`).join('')}</select></label><label>${esc(uiText('Account'))}<select name="target" required></select></label>${controls(uiText('Evidence name'), 'text', '', 'source_name')}${controls(uiText('From'), 'date', '', 'date_from')}${controls(uiText('Through'), 'date', '', 'date_to')}${controls(uiText('Native currency'), 'text', '', 'currency')}${controls(uiText('Native IANA timezone'), 'text', '', 'timezone')}</div><div class="recipe-fields" id="capture-generic-measurement">${controls(uiText('Attribution definition'), 'text', '', 'attribution')}${controls(uiText('Conversion definition'), 'text', '', 'conversion_definition')}</div><div class="recipe-fields" id="capture-meta-measurement" hidden><label>${esc(uiText('Exact Meta conversion action type'))}<input name="result_action_type" maxlength="160" list="meta-action-examples" placeholder="offsite_conversion.fb_pixel_purchase"></label><datalist id="meta-action-examples"><option value="offsite_conversion.fb_pixel_purchase"></option><option value="offsite_conversion.fb_pixel_lead"></option></datalist><label>${esc(uiText('Meta attribution window'))}<select name="attribution_windows"><option value="">${esc(uiText('Choose explicitly'))}</option><option value="1d_click">${esc(uiText('1-day click'))}</option><option value="7d_click">${esc(uiText('7-day click'))}</option><option value="1d_click,1d_view">${esc(uiText('1-day click and 1-day view'))}</option><option value="7d_click,1d_view">${esc(uiText('7-day click and 1-day view'))}</option><option value="1d_view">${esc(uiText('1-day view only'))}</option></select></label><p class="form-note">${esc(uiText('Uses impression-time reporting and the exact selected action type. Overlapping purchase aliases are not combined; an absent action remains unknown.'))}</p></div><p class="form-note">${esc(uiText('Match the native account currency, timezone and report window. Search-term visibility can prevent equality with campaign totals. Missing metrics stay unknown.'))}</p><label class="form-note"><input name="complete" type="checkbox"> ${esc(uiText('The selected reporting window is complete under these declared measurement settings.'))}</label><button type="submit" class="button primary">${esc(uiText('Read and retain evidence'))}</button></form>`;
  const form = $('#capture-preset');
  $('#capture-meta-measurement').insertAdjacentHTML(
    'beforeend',
    `<p class="form-note">${esc(uiText('Meta verifies account currency and timezone before and after complete Insights pages, including empty reports. Each page keeps its source reference. Keep attribution choices explicit; complete paging does not verify conversion delivery.'))}</p>`,
  );
  form.insertAdjacentHTML(
    'beforeend',
    `<p id="capture-google-measurement" class="form-note" hidden>${esc(uiText('Google verifies customer currency and timezone before and after complete report pages. Ads and search terms keep their full resource identity. Conversions use metrics.conversions; declare attribution windows or enter unknown. Search-term evidence excludes Performance Max and may not equal campaign totals.'))}</p>`,
  );
  form.insertAdjacentHTML(
    'beforeend',
    `<p id="capture-linkedin-measurement" class="form-note" hidden>${esc(uiText('LinkedIn uses UTC daily dates and externalWebsiteConversions. Account identity and currency are verified before and after the complete analytics response. Each read keeps its source reference. Declare the conversion-rule attribution windows, or enter unknown. Empty results cannot prove zero activity. Use the current month or previous five calendar months; narrow large reports.'))}</p>`,
  );
  let declaredTimezone = form.elements.timezone.value,
    declaredConversion = form.elements.conversion_definition.value;
  form.insertAdjacentHTML(
    'beforeend',
    `<p id="capture-tiktok-measurement" class="form-note" hidden>${esc(uiText('TikTok uses advertiser-local daily dates for standard auction campaigns, ad groups and ads. Currency and timezone are verified before and after collection. Choose 1–31 closed days. Native conversion follows each entity optimization goal; goals may differ. Declare attribution windows or enter unknown. Smart+ and GMV Max reports are separate.'))}</p>`,
  );
  const begin = evidenceFormContext(form, current, event => {
    if (event.target !== form.elements.complete) form.elements.complete.checked = false;
  });
  const selectPreset = () => {
    const preset = presets.find(p => p.id === form.elements.preset.value),
      selected = form.elements.target.value;
    form.elements.target.innerHTML =
      `<option value="">${esc(uiText('Choose the exact login and account'))}</option>` +
      targets
        .map((t, i) => (t.gateway === preset.gateway ? `<option value="${i}">${esc(t.label)}</option>` : ''))
        .join('');
    if (selected !== '' && targets[Number(selected)]?.gateway === preset.gateway) form.elements.target.value = selected;
    const meta = preset.gateway === 'meta_native_action';
    const linkedin = preset.gateway === 'linkedin_native_action';
    const tiktok = preset.gateway === 'tiktok_native_action';
    const google = preset.gateway === 'google_ads_native_action';
    $('#capture-linkedin-measurement').hidden = !linkedin;
    $('#capture-tiktok-measurement').hidden = !tiktok;
    $('#capture-google-measurement').hidden = !google;
    for (const [key, fixed] of [
      ['timezone', linkedin ? 'UTC' : null],
      [
        'conversion_definition',
        linkedin
          ? 'externalWebsiteConversions'
          : tiktok
            ? 'conversion (optimization goal)'
            : google
              ? 'metrics.conversions'
              : null,
      ],
    ]) {
      const field = form.elements[key];
      if (fixed !== null) {
        if (!field.readOnly) {
          if (key === 'timezone') declaredTimezone = field.value;
          else declaredConversion = field.value;
        }
        field.value = fixed;
      } else if (field.readOnly) field.value = key === 'timezone' ? declaredTimezone : declaredConversion;
      field.readOnly = fixed !== null;
    }
    $('#capture-generic-measurement').hidden = meta;
    $('#capture-meta-measurement').hidden = !meta;
    for (const key of ['result_action_type', 'attribution_windows']) {
      form.elements[key].required = meta;
      form.elements[key].disabled = !meta;
    }
    for (const key of ['attribution', 'conversion_definition']) {
      form.elements[key].required = !meta;
      form.elements[key].disabled = meta;
    }
  };
  form.elements.preset.addEventListener('change', selectPreset);
  selectPreset();
  workspaceBind('#capture-preset', async form => {
    const active = begin();
    if (!active()) return;
    const t = targets[Number(form.elements.target.value)];
    const preset = presets.find(p => p.id === form.elements.preset.value);
    if (form.elements.target.value === '' || !t || t.gateway !== preset.gateway)
      throw Error(uiText('Choose the exact account for this provider.'));
    const semantics = Object.fromEntries(
      ['source_name', 'date_from', 'date_to', 'currency', 'timezone', 'attribution', 'conversion_definition'].map(k => [
        k,
        form.elements[k].value.trim(),
      ]),
    );
    let out;
    try {
      out = await workspaceCall('reporting', {
        action: 'capture_preset',
        preset: form.elements.preset.value,
        connection_id: t.connection_id,
        account_id: t.account_id,
        semantics: {...semantics, complete: form.elements.complete.checked},
        ...(preset.gateway === 'meta_native_action'
          ? {
              result_action_type: form.elements.result_action_type.value.trim(),
              attribution_windows: form.elements.attribution_windows.value.split(','),
            }
          : {}),
      });
    } catch (error) {
      if (active()) throw error;
      return;
    }
    if (!active()) return;
    await openReport(out.id);
    if (active()) toast(uiText('Evidence retained with its original source and mapping.'));
  });
}
function mountScenarioModel(report) {
  const generation = navigationGeneration,
    identity = identityGeneration;
  $('#report-detail').insertAdjacentHTML(
    'beforeend',
    `<details class="panel workspace-form"><summary>${esc(uiText('Explore budget scenarios'))}</summary><p>${esc(uiText('Model a range of outcomes from this report’s observed cost per conversion. This is a sensitivity model, not a forecast.'))}</p><form id="scenario-model"><label>${esc(uiText('Budgets in {currency} — one per line', {currency: report.semantics.currency}))}<textarea name="budgets" rows="3" required></textarea></label>${controls(uiText('Low efficiency factor'), 'number', '0.8', 'efficiency_low')}${controls(uiText('High efficiency factor'), 'number', '1.2', 'efficiency_high')}<p class="form-note">${esc(uiText('1.0 keeps the observed conversion efficiency; 0.8 assumes 20% fewer conversions per unit of budget.'))}</p><button type="submit" class="button">${esc(uiText('Model scenarios'))}</button></form><div id="scenario-result" aria-live="polite"></div></details>`,
  );
  const scenarioResult = $('#scenario-result'),
    form = $('#scenario-model'),
    current = () =>
      generation === navigationGeneration && identity === identityGeneration && scenarioResult.isConnected,
    begin = evidenceFormContext(form, current, () => {
      scenarioResult.innerHTML = '';
    });
  workspaceBind('#scenario-model', async form => {
    const active = begin();
    if (!active()) return;
    scenarioResult.innerHTML = '';
    let out;
    try {
      out = await workspaceCall('reporting', {
        action: 'scenarios',
        id: report.id,
        options: {
          budgets: form.elements.budgets.value
            .split(/\r?\n/)
            .map(s => s.trim())
            .filter(Boolean),
          efficiency_low: Number(form.elements.efficiency_low.value),
          efficiency_high: Number(form.elements.efficiency_high.value),
        },
      });
    } catch (error) {
      if (active()) throw error;
      return;
    }
    if (!active()) return;
    scenarioResult.innerHTML = `<p>${badge(out.evidence_status)} · ${esc(uiText('Observed CPA: {amount} {currency}', {amount: out.observed.cpa, currency: out.currency}))}</p><div class="data-scroll"><table class="review-table"><caption>${esc(uiText('Modeled outcomes under your assumptions'))}</caption><thead><tr><th scope="col">${esc(uiText('Budget'))}</th><th scope="col">${esc(uiText('Low conversions'))}</th><th scope="col">${esc(uiText('High conversions'))}</th></tr></thead><tbody>${out.scenarios.map(s => `<tr><td>${esc(s.budget)} ${esc(out.currency)}</td><td>${esc(uiNumber(s.modeled_conversions_low, {maximumFractionDigits: 1}))}</td><td>${esc(uiNumber(s.modeled_conversions_high, {maximumFractionDigits: 1}))}</td></tr>`).join('')}</tbody></table></div><ul>${out.limitations.map(x => `<li>${esc(uiReportExplanation(x))}</li>`).join('')}</ul>${recordDetails(out, uiText('Model assumptions and source lineage'))}`;
  });
  mountAllocationModel(report);
}
function reportPackBody(pack) {
  const value = x => (x === null || x === undefined ? uiText('Unknown') : esc(uiNumber(x, {maximumFractionDigits: 2})));
  const money = (x, currency) =>
    x === null || x === undefined ? uiText('Unknown') : `${value(x)} ${esc(currency ?? '')}`;
  const context = s =>
    `${esc(s.platform)} · ${esc(s.account_id)} · ${esc(s.objective_group ? uiText(pretty(s.objective_group)) : uiText('All objectives'))}`;
  const charts = pack.summary.filter(s => Number.isFinite(s.metrics.ctr)).slice(0, 30);
  const scale = Math.max(1, ...charts.map(s => s.metrics.ctr));
  return `<article class="report-pack">
    <header><svg viewBox="0 0 1000 5" aria-hidden="true"><rect width="1000" height="5" fill="${esc(pack.presentation?.accent_color || '#354B67')}"/></svg><p class="eyebrow">AMCP · ${esc(pack.presentation?.brand_name || pack.client_name || uiText('Performance report'))}</p>
      <h1>${esc(pack.title)}</h1><p>${esc(pack.date_range.since)} — ${esc(pack.date_range.until)} · ${esc(uiText('{grain} grouping', {grain: uiText(pretty(pack.grain))}))}</p>
      <p>${esc(uiText('{state} snapshot · {count} source rows · Collected {date}', {state: uiText(pretty(pack.state)), count: uiNumber(pack.row_count), date: date(pack.created_at)}))}</p></header>
    ${pack.state === 'partial' ? `<p class="notice">${esc(uiText('Partial evidence: some sources or periods are incomplete. See source coverage before interpreting results.'))}</p>` : ''}
    <h2>${esc(uiText('Account and measurement summaries'))}</h2><p>${esc(uiText('Each row retains its own currency, timezone, attribution, conversion definition and reporting window.'))}</p>
    <div class="data-scroll" role="region" aria-label="${esc(uiText('Account performance, scroll for all metrics'))}" tabindex="0"><table class="review-table">
      <caption>${esc(uiText('Performance by account, objective and period'))}</caption>
      <thead><tr><th scope="col">${esc(uiText('Account / context'))}</th><th scope="col">${esc(uiText('Period'))}</th><th scope="col">${esc(uiText('Spend'))}</th><th scope="col">${esc(uiText('Impressions'))}</th><th scope="col">${esc(uiText('Clicks'))}</th><th scope="col">${esc(uiText('Conversions'))}</th><th scope="col">CPA</th></tr></thead>
      <tbody>${pack.summary.map(s => `<tr><th scope="row">${context(s)}<small>${esc(s.timezone)}<br>${esc(s.result_definition)}<br>${esc(s.attribution)} · ${s.complete ? uiText('Complete') : uiText('Incomplete')}</small></th><td>${esc(s.date_from)}<br>${esc(s.date_to)}</td><td class="pack-value">${money(s.metrics.spend, s.currency)}</td><td class="pack-value">${value(s.metrics.impressions)}</td><td class="pack-value">${value(s.metrics.clicks)}</td><td class="pack-value">${value(s.metrics.conversions)}</td><td class="pack-value">${money(s.metrics.cpa, s.currency)}</td></tr>`).join('')}</tbody></table></div>
    <h2>${esc(uiText('Click-through rate by account and period'))}</h2><p>${esc(uiText('Each bar uses compatible native totals. The shared scale runs from 0% to {scale}%; accounts are not combined.', {scale: uiNumber(scale, {maximumFractionDigits: 2})}))}${pack.summary.length > 30 ? ' ' + esc(uiText('The first 30 available ratios are shown; the table includes all groups.')) : ''}</p>
    ${
      charts.length
        ? charts
            .map(s => {
              const rate = s.metrics.ctr,
                width = Math.max(0, Math.min(100, (rate / scale) * 100));
              return `<figure><figcaption>${context(s)} · ${esc(s.date_from)} — ${esc(s.date_to)}: ${value(rate)}%</figcaption><svg viewBox="0 0 500 18" role="img" aria-label="${esc(uiText('Click-through rate {rate} percent', {rate: uiNumber(rate, {maximumFractionDigits: 2})}))}"><rect width="500" height="18" fill="#ebe9f6"/><rect width="${width * 5}" height="18" fill="#5a43ad"/></svg></figure>`;
            })
            .join('')
        : `<p>${esc(uiText('Click-through rate is unavailable in this snapshot.'))}</p>`
    }
    <h2>${esc(uiText('Source coverage'))}</h2>
    ${pack.sources.map(s => `<section class="pack-evidence"><h3>${esc(pretty(s.platform ?? uiText('Source')))} · ${esc(s.account_id ?? uiText('Account'))}</h3><p>${s.complete ? uiText('Complete') : uiText('Incomplete')} · ${esc(uiText('{count} rows', {count: s.row_count == null ? uiText('Unknown') : uiNumber(s.row_count)}))}${s.error ? ' · ' + esc(s.error.code ?? uiText('Source error')) + ': ' + esc(s.error.message ?? uiText('Inspect source evidence for recovery details.')) : ''}</p><details><summary>${esc(uiText('Measurement definitions and source reference'))}</summary><dl><dt>${esc(uiText('Attribution'))}</dt><dd>${esc(s.attribution ?? uiText('Unknown'))}</dd><dt>${esc(uiText('Conversion definition'))}</dt><dd>${esc(s.result_definition ?? uiText('Unknown'))}</dd><dt>${esc(uiText('Query fingerprint'))}</dt><dd><code>${esc(s.query_fingerprint ?? uiText('Not supplied'))}</code></dd></dl></details></section>`).join('')}
    <h2>${esc(uiText('Reading this report'))}</h2><ul>${pack.limitations.map(x => `<li>${esc(uiReportExplanation(x))}</li>`).join('')}</ul>
    <details class="pack-evidence"><summary>${esc(uiText('Snapshot and audit reference'))}</summary><p>${esc(uiText('Snapshot:'))} <code>${esc(pack.snapshot_id)}</code><br>${esc(uiText('Source hash:'))} <code>${esc(pack.source_hash)}</code></p></details>
    ${pack.presentation?.footer ? `<p>${esc(pack.presentation.footer)}</p>` : ''}
    <p>${esc(uiText('Retain the raw CSV and source evidence JSON with this report pack. This pack presents the saved snapshot and does not refresh provider data.'))}</p></article>`;
}
async function renderReportPack(focus = false) {
  const generation = navigationGeneration,
    identity = identityGeneration,
    current = () => generation === navigationGeneration && identity === identityGeneration;
  const id = new URLSearchParams(location.search).get('report_id');
  if (!id) throw Error(uiText('Open a report pack from a retained snapshot.'));
  const pack = await overviewCall({action: 'report_pack', id});
  if (!current()) return false;
  content.innerHTML =
    `<div class="dialog-actions report-pack-actions"><a class="button" href="/reporting-overview?report_id=${encodeURIComponent(id)}">${esc(uiText('Back to snapshot'))}</a><button class="button primary" id="download-pack">${esc(uiText('Download HTML report pack'))}</button><button class="button" id="download-pack-pdf">${esc(uiText('Download PDF'))}</button><button class="button" id="download-pack-xlsx">${esc(uiText('Download Excel'))}</button><button class="button" id="print-pack">${esc(uiText('Print preview'))}</button><a class="button" href="${esc(pack.csv_path)}" download="AMCP-report-rows.csv">${esc(uiText('Raw CSV'))}</a><a class="button" href="${esc(pack.evidence_path)}" download="AMCP-report-evidence.json">${esc(uiText('Source evidence'))}</a></div><p class="notice report-pack-actions">${esc(uiText('Review client labels, selected accounts and source coverage before sharing. The downloaded HTML contains these displayed account details.'))}</p>` +
    reportPackBody(pack);
  await bindReportPresentation(pack, id);
  if (!current()) return false;
  workspaceBind('#print-pack', () => {
    if (current()) window.print();
  });
  workspaceBind('#download-pack', () => {
    if (!current()) return;
    const html =
      `<!doctype html><html lang="${uiLocale}" dir="${uiLocale === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>` +
      esc(pack.title) +
      `</title><style>body{font:15px/1.55 system-ui,sans-serif;color:#252336;max-width:1200px;margin:auto;padding:40px}h1{font-size:36px}h2{margin-top:36px}table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:start;padding:10px;border-bottom:1px solid #ddd;vertical-align:top}small{display:block;font-weight:normal;margin-top:6px}.data-scroll{overflow-x:auto}.review-table{min-width:760px}.review-table th:first-child{min-width:180px}.pack-value{white-space:nowrap}.pack-evidence{border-top:1px solid #ddd;padding:12px 0}.pack-evidence dl{display:grid;grid-template-columns:1fr 3fr;gap:8px}.pack-evidence dd{margin:0;overflow-wrap:anywhere}figure{max-width:650px}code{overflow-wrap:anywhere;direction:ltr;unicode-bidi:isolate}summary{cursor:pointer}pre{white-space:pre-wrap}thead{display:table-header-group}@media print{body{padding:0}.data-scroll{overflow:visible}.review-table{min-width:0;font-size:9pt}.review-table th:first-child{min-width:0;width:25%}td,th{padding:5pt}tr,figure{break-inside:avoid}}</style></head><body>` +
      reportPackBody(pack) +
      `</body></html>`;
    const url = URL.createObjectURL(new Blob([html], {type: 'text/html'})),
      link = document.createElement('a');
    link.href = url;
    link.download = 'AMCP-report-pack.html';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  if (focus) {
    const heading = content.querySelector('.report-pack h1');
    heading.setAttribute('tabindex', '-1');
    heading.focus();
  }
  return true;
}
