'use strict';
async function mountCaptureWizard(openReport) {
  const {presets} = await workspaceCall('reporting', {action: 'capture_presets'});
  const targets = platforms
    .filter(p => p.id === 'google')
    .flatMap(p =>
      p.connections
        .filter(c => c.enabled)
        .flatMap(c =>
          c.accounts.map(account_id => ({connection_id: c.id, account_id, label: accountLabel(p, c, account_id)})),
        ),
    );
  $('#report-capture').innerHTML =
    `<summary>Capture detailed native evidence</summary><p>Use a tested field mapping for Google campaign, ad group, ad or search-term reports. Other supported account snapshots can be analyzed from the report library. Reading may take up to two minutes.</p><form id="capture-preset"><div class="recipe-fields"><label>Report detail<select name="preset">${presets.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label><label>Account<select name="target" required><option value="">Choose a Google Ads login and account</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>${controls('Evidence name', 'text', '', 'source_name')}${controls('From', 'date', '', 'date_from')}${controls('Through', 'date', '', 'date_to')}${controls('Native currency', 'text', '', 'currency')}${controls('Native IANA timezone', 'text', '', 'timezone')}${controls('Attribution definition', 'text', '', 'attribution')}${controls('Conversion definition', 'text', '', 'conversion_definition')}</div><p class="form-note">Match the native account settings and report window. Search-term visibility can prevent equality with campaign totals. Missing metrics stay unknown.</p><label class="form-note"><input name="complete" type="checkbox"> The selected reporting window is complete under these declared measurement settings.</label><button type="submit" class="button primary">Read and retain evidence</button></form>`;
  workspaceBind('#capture-preset', async form => {
    const t = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !t) throw Error('Choose the exact account.');
    const semantics = Object.fromEntries(
      ['source_name', 'date_from', 'date_to', 'currency', 'timezone', 'attribution', 'conversion_definition'].map(k => [
        k,
        form.elements[k].value.trim(),
      ]),
    );
    const out = await workspaceCall('reporting', {
      action: 'capture_preset',
      preset: form.elements.preset.value,
      connection_id: t.connection_id,
      account_id: t.account_id,
      semantics: {...semantics, complete: form.elements.complete.checked},
    });
    await openReport(out.id);
    toast('Evidence retained with its original source and mapping.');
  });
}
function mountScenarioModel(report) {
  $('#report-detail').insertAdjacentHTML(
    'beforeend',
    `<details class="panel workspace-form"><summary>Explore budget scenarios</summary><p>Model a range of outcomes from this report’s observed cost per conversion. This is a sensitivity model, not a forecast.</p><form id="scenario-model"><label>Budgets in ${esc(report.semantics.currency)} — one per line<textarea name="budgets" rows="3" required></textarea></label>${controls('Low efficiency factor', 'number', '0.8', 'efficiency_low')}${controls('High efficiency factor', 'number', '1.2', 'efficiency_high')}<p class="form-note">1.0 keeps the observed conversion efficiency; 0.8 assumes 20% fewer conversions per unit of budget.</p><button type="submit" class="button">Model scenarios</button></form><div id="scenario-result" aria-live="polite"></div></details>`,
  );
  workspaceBind('#scenario-model', async form => {
    const out = await workspaceCall('reporting', {
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
    $('#scenario-result').innerHTML =
      `<p>${badge(out.evidence_status)} · Observed CPA: ${esc(out.observed.cpa)} ${esc(out.currency)}</p><div class="data-scroll"><table class="review-table"><caption>Modeled outcomes under your assumptions</caption><thead><tr><th scope="col">Budget</th><th scope="col">Low conversions</th><th scope="col">High conversions</th></tr></thead><tbody>${out.scenarios.map(s => `<tr><td>${esc(s.budget)} ${esc(out.currency)}</td><td>${s.modeled_conversions_low.toLocaleString(undefined, {maximumFractionDigits: 1})}</td><td>${s.modeled_conversions_high.toLocaleString(undefined, {maximumFractionDigits: 1})}</td></tr>`).join('')}</tbody></table></div><ul>${out.limitations.map(x => `<li>${esc(x)}</li>`).join('')}</ul>${recordDetails(out, 'Model assumptions and source lineage')}`;
  });
}
function reportPackBody(pack) {
  const value = x =>
    x === null || x === undefined ? 'Unknown' : Number(x).toLocaleString(undefined, {maximumFractionDigits: 2});
  const money = (x, currency) => (x === null || x === undefined ? 'Unknown' : `${value(x)} ${esc(currency ?? '')}`);
  const context = s =>
    `${esc(s.platform)} · ${esc(s.account_id)} · ${esc(pretty(s.objective_group ?? 'All objectives'))}`;
  const charts = pack.summary.filter(s => Number.isFinite(s.metrics.ctr)).slice(0, 30);
  const scale = Math.max(1, ...charts.map(s => s.metrics.ctr));
  return `<article class="report-pack">
    <header><p class="eyebrow">AMCP · ${esc(pack.client_name || 'Performance report')}</p>
      <h1>${esc(pack.title)}</h1><p>${esc(pack.date_range.since)} — ${esc(pack.date_range.until)} · ${esc(pack.grain)} grouping</p>
      <p>${esc(pretty(pack.state))} snapshot · ${pack.row_count} source rows · Collected ${date(pack.created_at)}</p></header>
    ${pack.state === 'partial' ? '<p class="notice">Partial evidence: some sources or periods are incomplete. See source coverage before interpreting results.</p>' : ''}
    <h2>Account and measurement summaries</h2><p>Each row retains its own currency, timezone, attribution, conversion definition and reporting window.</p>
    <div class="data-scroll" role="region" aria-label="Account performance, scroll for all metrics" tabindex="0"><table class="review-table">
      <caption>Performance by account, objective and period</caption>
      <thead><tr><th scope="col">Account / context</th><th scope="col">Period</th><th scope="col">Spend</th><th scope="col">Impressions</th><th scope="col">Clicks</th><th scope="col">Conversions</th><th scope="col">CPA</th></tr></thead>
      <tbody>${pack.summary.map(s => `<tr><th scope="row">${context(s)}<small>${esc(s.timezone)}<br>${esc(s.result_definition)}<br>${esc(s.attribution)} · ${s.complete ? 'Complete' : 'Incomplete'}</small></th><td>${esc(s.date_from)}<br>${esc(s.date_to)}</td><td class="pack-value">${money(s.metrics.spend, s.currency)}</td><td class="pack-value">${value(s.metrics.impressions)}</td><td class="pack-value">${value(s.metrics.clicks)}</td><td class="pack-value">${value(s.metrics.conversions)}</td><td class="pack-value">${money(s.metrics.cpa, s.currency)}</td></tr>`).join('')}</tbody></table></div>
    <h2>Click-through rate by account and period</h2><p>Each bar uses compatible native totals. The shared scale runs from 0% to ${value(scale)}%; accounts are not combined.${pack.summary.length > 30 ? ' The first 30 available ratios are shown; the table includes all groups.' : ''}</p>
    ${
      charts.length
        ? charts
            .map(s => {
              const rate = s.metrics.ctr,
                width = Math.max(0, Math.min(100, (rate / scale) * 100));
              return `<figure><figcaption>${context(s)} · ${esc(s.date_from)} — ${esc(s.date_to)}: ${value(rate)}%</figcaption><svg viewBox="0 0 500 18" role="img" aria-label="Click-through rate ${esc(value(rate))} percent"><rect width="500" height="18" fill="#ebe9f6"/><rect width="${width * 5}" height="18" fill="#5a43ad"/></svg></figure>`;
            })
            .join('')
        : '<p>Click-through rate is unavailable in this snapshot.</p>'
    }
    <h2>Source coverage</h2>
    ${pack.sources.map(s => `<section class="pack-evidence"><h3>${esc(pretty(s.platform ?? 'Source'))} · ${esc(s.account_id ?? 'Account')}</h3><p>${s.complete ? 'Complete' : 'Incomplete'} · ${value(s.row_count)} rows${s.error ? ' · ' + esc(s.error.code ?? 'Source error') + ': ' + esc(s.error.message ?? 'Inspect source evidence for recovery details.') : ''}</p><details><summary>Measurement definitions and source reference</summary><dl><dt>Attribution</dt><dd>${esc(s.attribution ?? 'Unknown')}</dd><dt>Conversion definition</dt><dd>${esc(s.result_definition ?? 'Unknown')}</dd><dt>Query fingerprint</dt><dd><code>${esc(s.query_fingerprint ?? 'Not supplied')}</code></dd></dl></details></section>`).join('')}
    <h2>Reading this report</h2><ul>${pack.limitations.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    <details class="pack-evidence"><summary>Snapshot and audit reference</summary><p>Snapshot: <code>${esc(pack.snapshot_id)}</code><br>Source hash: <code>${esc(pack.source_hash)}</code></p></details>
    <p>Retain the raw CSV and source evidence JSON with this report pack. This pack presents the saved snapshot and does not refresh provider data.</p></article>`;
}
async function renderReportPack() {
  const id = new URLSearchParams(location.search).get('report_id');
  if (!id) throw Error('Open a report pack from a retained snapshot.');
  const pack = await overviewCall({action: 'report_pack', id});
  content.innerHTML =
    `<div class="dialog-actions report-pack-actions"><a class="button" href="/reporting-overview?report_id=${encodeURIComponent(id)}">Back to snapshot</a><button class="button primary" id="download-pack">Download HTML report pack</button><button class="button" id="print-pack">Print / save PDF</button><a class="button" href="${esc(pack.csv_path)}" download="AMCP-report-rows.csv">Raw CSV</a><a class="button" href="${esc(pack.evidence_path)}" download="AMCP-report-evidence.json">Source evidence</a></div><p class="notice report-pack-actions">Review client labels, selected accounts and source coverage before sharing. The downloaded HTML contains these displayed account details.</p>` +
    reportPackBody(pack);
  workspaceBind('#print-pack', () => window.print());
  workspaceBind('#download-pack', () => {
    const html =
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
      esc(pack.title) +
      '</title><style>body{font:15px/1.55 system-ui,sans-serif;color:#252336;max-width:1200px;margin:auto;padding:40px}h1{font-size:36px}h2{margin-top:36px}table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:start;padding:10px;border-bottom:1px solid #ddd;vertical-align:top}small{display:block;font-weight:normal;margin-top:6px}.data-scroll{overflow-x:auto}.review-table{min-width:760px}.review-table th:first-child{min-width:180px}.pack-value{white-space:nowrap}.pack-evidence{border-top:1px solid #ddd;padding:12px 0}.pack-evidence dl{display:grid;grid-template-columns:1fr 3fr;gap:8px}.pack-evidence dd{margin:0;overflow-wrap:anywhere}figure{max-width:650px}code{overflow-wrap:anywhere}summary{cursor:pointer}pre{white-space:pre-wrap}thead{display:table-header-group}@media print{body{padding:0}.data-scroll{overflow:visible}.review-table{min-width:0;font-size:9pt}.review-table th:first-child{min-width:0;width:25%}td,th{padding:5pt}tr,figure{break-inside:avoid}}</style></head><body>' +
      reportPackBody(pack) +
      '</body></html>';
    const url = URL.createObjectURL(new Blob([html], {type: 'text/html'})),
      link = document.createElement('a');
    link.href = url;
    link.download = 'AMCP-report-pack.html';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
async function renderMonitors() {
  const [policies, incidents, reports] = await Promise.all([
    workspaceCall('workspace', {action: 'monitors', limit: 100}),
    workspaceCall('workspace', {action: 'incidents', limit: 100}),
    overviewCall({action: 'list', limit: 30}),
  ]);
  content.innerHTML += `<p class="notice">Read-only rules evaluate completed reporting snapshots and deliver incidents to this workspace inbox. They never launch advertising changes or send external messages. Missing or stale evidence cannot resolve an incident.</p><section class="panel"><h2>Incidents</h2>${incidents.incidents.map(i => `<div class="token-row monitor-row"><div><strong>${esc(i.monitor_name)}</strong><small>${esc(i.account_id)} · ${esc(i.date_from)} — ${esc(i.date_to)} · ${esc(i.metric)} ${esc(i.value)} ${esc(i.comparison)} ${esc(i.threshold)}</small><a href="/reporting-overview?report_id=${encodeURIComponent(i.last_report_id)}">Open supporting snapshot</a></div>${badge(i.state)}${i.state === 'open' ? `<button class="button small" data-ack-incident="${esc(i.id)}">Acknowledge</button>` : ''}</div>`).join('') || blank('No incidents in the available evidence.')}<p>${incidents.has_more ? 'Showing the latest 100 incidents.' : 'All accessible incidents shown.'}</p></section><section class="panel"><h2>Rules</h2>${policies.monitors.map(m => `<div class="token-row monitor-row"><div><strong>${esc(m.name)}</strong><small>${esc(m.account_id)} · ${esc(m.result_definition)} · ${esc(m.metric)} ${esc(m.comparison)} ${esc(m.threshold)}</small><small>Latest evaluation: ${esc(pretty(m.last_evaluation?.status ?? 'Awaiting a completed snapshot'))}${m.last_evaluation ? ' · ' + date(m.last_evaluation.evaluated_at) : ''}</small></div>${badge(m.active ? 'active' : 'paused')}<button class="button small" data-toggle-monitor="${esc(m.id)}">${m.active ? 'Pause' : 'Resume'}</button></div>`).join('') || blank('Create a rule from an exact account and measurement context below.')}</section><section class="panel workspace-form"><h2>Create a rule from retained evidence</h2><label>Snapshot<select id="monitor-source"><option value="">Choose a finished report</option>${reports.reports
    .filter(r => ['complete', 'partial'].includes(r.state))
    .map(r => `<option value="${esc(r.id)}">${esc(r.config.name)} · ${date(r.completed_at)}</option>`)
    .join(
      '',
    )}</select></label><button id="load-monitor-source" class="button">Choose measurement context</button><div id="monitor-rule"></div></section>`;
  workspaceBind('[data-ack-incident]', async b => {
    const i = incidents.incidents.find(i => i.id === b.dataset.ackIncident);
    await workspaceCall('workspace', {action: 'acknowledge_incident', id: i.id, revision: i.revision});
    await renderWorkspacePage();
  });
  workspaceBind('[data-toggle-monitor]', async b => {
    const m = policies.monitors.find(m => m.id === b.dataset.toggleMonitor);
    await workspaceCall('workspace', {
      action: 'set_monitor_state',
      id: m.id,
      revision: m.revision,
      active: !m.active,
      confirmed: true,
    });
    await renderWorkspacePage();
  });
  workspaceBind('#load-monitor-source', async () => {
    const id = $('#monitor-source').value;
    if (!id) throw Error('Choose a finished snapshot.');
    const report = await overviewCall({action: 'get', id, limit: 1});
    $('#monitor-rule').innerHTML =
      `<form id="save-monitor">${controls('Rule name', 'text', '', 'name')}<label>Account and measurement definition<select name="context" required>${report.summary.map((s, i) => `<option value="${i}">${esc(s.platform)} · ${esc(s.account_id)} · ${esc(s.currency)} · ${esc(s.result_definition)} · ${esc(s.attribution)}</option>`).join('')}</select></label><label>Metric<select name="metric"><option value="spend">Spend</option><option value="clicks">Clicks</option><option value="conversions">Conversions</option><option value="cpa">Cost per conversion</option></select></label><label>Trigger when<select name="comparison"><option value="above">Above threshold</option><option value="below">Below threshold</option></select></label>${controls('Threshold in native metric units', 'text', '', 'threshold')}${controls('Maximum evidence age in hours', 'number', '24', 'max_age_hours')}<label class="form-note"><input name="confirmed" type="checkbox" required> Save this rule and display its incidents in this workspace inbox.</label><button class="button primary" type="submit">Save and evaluate this snapshot</button></form>`;
    workspaceBind('#save-monitor', async form => {
      const s = report.summary[Number(form.elements.context.value)];
      if (!s) throw Error('The snapshot has no compatible measurement context.');
      const source = report.config.sources.find(x => x.platform === s.platform && x.account_id === s.account_id);
      await workspaceCall('workspace', {
        action: 'save_monitor',
        confirmed: form.elements.confirmed.checked,
        monitor: {
          platform: source.platform,
          connection_id: source.connection_id,
          account_id: source.account_id,
          currency: s.currency,
          timezone: s.timezone,
          result_definition: s.result_definition,
          attribution: s.attribution,
          name: form.elements.name.value,
          metric: form.elements.metric.value,
          comparison: form.elements.comparison.value,
          threshold: form.elements.threshold.value,
          max_age_hours: Number(form.elements.max_age_hours.value),
        },
      });
      await workspaceCall('workspace', {action: 'evaluate_monitors', report_id: id});
      await renderWorkspacePage();
    });
  });
}
