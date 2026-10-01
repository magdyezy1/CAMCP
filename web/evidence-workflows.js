'use strict';
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
  const gateways = {google: 'google_ads_native_action', meta: 'meta_native_action'};
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
  root.innerHTML = `<summary>${esc(uiText('Capture detailed native evidence'))}</summary><p>${esc(uiText('Choose Google campaign, ad group, ad or search-term evidence, or Meta campaign, ad-set or ad evidence. Reading may take up to two minutes.'))}</p><form id="capture-preset"><div class="recipe-fields"><label>${esc(uiText('Report detail'))}<select name="preset">${presets.map(p => `<option value="${esc(p.id)}">${esc(evidencePresetLabel(p))}</option>`).join('')}</select></label><label>${esc(uiText('Account'))}<select name="target" required></select></label>${controls(uiText('Evidence name'), 'text', '', 'source_name')}${controls(uiText('From'), 'date', '', 'date_from')}${controls(uiText('Through'), 'date', '', 'date_to')}${controls(uiText('Native currency'), 'text', '', 'currency')}${controls(uiText('Native IANA timezone'), 'text', '', 'timezone')}</div><div class="recipe-fields" id="capture-generic-measurement">${controls(uiText('Attribution definition'), 'text', '', 'attribution')}${controls(uiText('Conversion definition'), 'text', '', 'conversion_definition')}</div><div class="recipe-fields" id="capture-meta-measurement" hidden><label>${esc(uiText('Exact Meta conversion action type'))}<input name="result_action_type" maxlength="160" list="meta-action-examples" placeholder="offsite_conversion.fb_pixel_purchase"></label><datalist id="meta-action-examples"><option value="offsite_conversion.fb_pixel_purchase"></option><option value="offsite_conversion.fb_pixel_lead"></option></datalist><label>${esc(uiText('Meta attribution window'))}<select name="attribution_windows"><option value="">${esc(uiText('Choose explicitly'))}</option><option value="1d_click">${esc(uiText('1-day click'))}</option><option value="7d_click">${esc(uiText('7-day click'))}</option><option value="1d_click,1d_view">${esc(uiText('1-day click and 1-day view'))}</option><option value="7d_click,1d_view">${esc(uiText('7-day click and 1-day view'))}</option><option value="1d_view">${esc(uiText('1-day view only'))}</option></select></label><p class="form-note">${esc(uiText('Uses impression-time reporting and the exact selected action type. Overlapping purchase aliases are not combined; an absent action remains unknown.'))}</p></div><p class="form-note">${esc(uiText('Match the native account currency, timezone and report window. Search-term visibility can prevent equality with campaign totals. Missing metrics stay unknown.'))}</p><label class="form-note"><input name="complete" type="checkbox"> ${esc(uiText('The selected reporting window is complete under these declared measurement settings.'))}</label><button type="submit" class="button primary">${esc(uiText('Read and retain evidence'))}</button></form>`;
  const form = $('#capture-preset');
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
