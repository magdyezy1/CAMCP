'use strict';
let overviewState = {
  bootstrap: null,
  config: null,
  report: null,
  page: 0,
  custom: [],
  history: [],
  selection: null,
  destinationId: null,
  loadSequence: 0,
  dirty: false,
};
const overviewCall = async input => {
  const r = await api('/api/workspace/overview', {method: 'POST', body: JSON.stringify(input)});
  if (!r.success) throw requestError(r, uiText('The report request failed.'));
  return r.data;
};
const overviewDefault = () => ({
  name: 'Campaign performance',
  client_name: '',
  grain: 'total',
  source_defaults: {},
  sources: [],
  date_range: {preset: 'last_complete_days', days: 7, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone},
  metrics: ['spend', 'impressions', 'clicks', 'conversions', 'cpa', 'roas'],
  custom_metrics: [],
  targets: {},
  objectives: [],
});
const pretty = value =>
  String(value ?? '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, x => x.toUpperCase());
// First-party display enums only. Never apply this to client names, native fields or saved values.
const reportLabels = {
  total: 'Total',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  hourly: 'Hourly',
  queued: 'Queued',
  running: 'Running',
  complete: 'Complete',
  partial: 'Partial',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  awareness: 'Awareness',
  traffic: 'Traffic',
  engagement: 'Engagement',
  video_views: 'Video Views',
  leads: 'Leads',
  sales: 'Sales',
  app_installs: 'App Installs',
  unknown: 'Unknown',
  observe: 'Observe',
  needs_review: 'Needs Review',
  needs_target: 'Needs Target',
  wait: 'Wait',
  reconsider_pause: 'Reconsider Pause',
  insufficient_data: 'Insufficient Data',
  maintain: 'Maintain',
  scale: 'Scale',
  pull_back: 'Pull Back',
  decimal: 'decimal',
  currency: 'currency',
  percent: 'percent',
  number: 'number',
};
function reportLabel(value) {
  return Object.hasOwn(reportLabels, value) ? uiText(reportLabels[value]) : pretty(value);
}
const metricFormat = (key, n, currency) => {
  if (n == null) return '—';
  if (typeof n !== 'number') return String(n);
  const m =
    overviewState.bootstrap.metrics[key] ??
    (overviewState.report?.config.custom_metrics ?? overviewState.custom).find(m => m.id === key) ??
    {};
  try {
    return (
      new Intl.NumberFormat(uiLocale, {
        maximumFractionDigits: m.format === 'number' ? 0 : 2,
        ...(m.format === 'currency' && currency ? {style: 'currency', currency} : {}),
      }).format(n) + (m.format === 'percent' ? '%' : '')
    );
  } catch {
    return String(n);
  }
};
function deliveryBind(selector, fn) {
  const generation = navigationGeneration,
    identity = identityGeneration;
  authBind(selector, async el => {
    if (generation !== navigationGeneration || identity !== identityGeneration || !$('#report-delivery-dialog')?.open)
      return;
    try {
      await fn(el);
    } catch (e) {
      if (generation === navigationGeneration && identity === identityGeneration && $('#report-delivery-dialog')?.open)
        $('#delivery-status').textContent = errorMessage(e);
    }
  });
}
let deliveryTimer;
async function pollDelivery(id) {
  const generation = navigationGeneration,
    identity = identityGeneration,
    sequence = overviewState.deliverySequence;
  const current = () =>
    generation === navigationGeneration &&
    identity === identityGeneration &&
    sequence === overviewState.deliverySequence &&
    $('#report-delivery-dialog')?.open;
  clearTimeout(deliveryTimer);
  if (location.pathname !== '/reporting-overview' || !$('#report-delivery-dialog')?.open) return;
  try {
    const r = await overviewCall({action: 'export_status', id});
    if (!current()) return;
    $('#delivery-status').innerHTML =
      r.url && r.state === 'complete'
        ? `${esc(uiText('Export complete.'))} <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(uiText('Open Google Sheets ↗'))}</a>`
        : `${reportLabel(r.state)} · ${esc((r.job.error && uiOwnedError(r.job.error).message) || uiText('The export is tracked in this report’s delivery history.'))}`;
    if (r.destination_kind === 'report_files' && r.files?.length) $('#delivery-status').innerHTML += reportFileLinks(r);
    if (['queued', 'running'].includes(r.state)) deliveryTimer = setTimeout(() => void pollDelivery(id), 3000);
    else if (['failed', 'cancelled'].includes(r.state)) {
      $('#delivery-status').innerHTML +=
        `<button class="button small" id="delivery-retry">${esc(uiText('Retry export'))}</button>`;
      deliveryBind('#delivery-retry', async () => {
        await overviewCall({action: 'retry', id: r.job.id, confirmed: true});
        await pollDelivery(id);
      });
    }
  } catch (e) {
    if (current()) $('#delivery-status').textContent = errorMessage(e);
  }
}
function overviewConfig() {
  const form = $('#overview-config'),
    data = new FormData(form),
    b = overviewState.bootstrap,
    sources = [...document.querySelectorAll('[data-report-account]:checked')].map(el => {
      const [platform, connection_id, account_id] = JSON.parse(el.value),
        objective = $('[data-objective-for="' + CSS.escape(platform) + '"]').value,
        native_metrics = $('[data-native-for="' + CSS.escape(platform) + '"]')
          .value.split(/[ ,\n]+/)
          .filter(Boolean);
      const detail = overviewGranularityConfig(platform),
        parent =
          platform === 'snapchat' && detail.level === 'adset'
            ? $('[data-report-parent="' + CSS.escape(el.value) + '"]')?.value
            : undefined;
      return {
        platform,
        connection_id,
        account_id,
        ...(objective !== 'provider' ? {objective} : {}),
        native_metrics,
        ...detail,
        ...(parent ? {campaign_id: parent} : {}),
      };
    }),
    metrics = [...document.querySelectorAll('[data-report-metric]:checked')].map(el => el.value),
    targets = {};
  for (const el of document.querySelectorAll('[data-objective-target]')) {
    if (!el.value) continue;
    const objective = el.dataset.objectiveTarget;
    targets[objective] = {
      context: readTargetContext(objective),
      target: Number(el.value),
      currency: $('[data-target-currency="' + objective + '"]').value.toUpperCase(),
      kpi: $('[data-target-kpi="' + objective + '"]').value,
      minimum_results: Number($('[data-target-sample="' + objective + '"]').value),
      conversion_lag_days: Number($('[data-target-lag="' + objective + '"]').value),
    };
  }
  const mode = data.get('rangeMode'),
    date_range =
      mode !== 'custom'
        ? {
            preset: mode === 'rolling' ? 'last_complete_days' : mode,
            ...(mode === 'last_complete_days' || mode === 'rolling'
              ? {days: Number(data.get('days')), offset_days: Number(data.get('offset_days'))}
              : {}),
            timezone: data.get('timezone'),
          }
        : {since: data.get('since'), until: data.get('until')};
  const source_defaults = Object.fromEntries(
    b.platforms
      .map(p => {
        const objective = $('[data-objective-for="' + CSS.escape(p.id) + '"]').value,
          native_metrics = $('[data-native-for="' + CSS.escape(p.id) + '"]')
            .value.split(/[ ,\n]+/)
            .filter(Boolean);
        return [
          p.id,
          {
            ...(objective !== 'provider' ? {objective} : {}),
            ...(native_metrics.length ? {native_metrics} : {}),
            ...overviewGranularityConfig(p.id),
          },
        ];
      })
      .filter(([, v]) => Object.keys(v).length),
  );
  return {
    partial_delivery: data.get('partial_delivery') ?? 'allow_marked',
    name: String(data.get('name')),
    client_name: String(data.get('client_name') ?? ''),
    grain: data.get('grain') ?? 'total',
    source_defaults,
    sources,
    date_range,
    metrics,
    custom_metrics: overviewState.custom,
    targets,
    objectives: [...document.querySelectorAll('[data-report-objective]:checked')].map(el => el.value),
  };
}
async function renderReportingOverview() {
  if (!session.authenticated) {
    showLogin();
    return;
  }
  const [b, history] = await Promise.all([overviewCall({action: 'bootstrap'}), overviewCall({action: 'list'})]);
  overviewState.bootstrap = b;
  overviewState.history = history.reports;
  const link = new URLSearchParams(location.search),
    viewId = link.get('view_id');
  if (viewId && overviewState.selection?.id !== viewId) {
    const definition = b.views.find(v => v.id === viewId);
    if (!definition) throw Error(uiText('This saved report is unavailable in the current workspace.'));
    selectOverviewDefinition(definition);
  }
  overviewState.config ??= overviewInitialConfig(location.search);
  const c = overviewState.config;
  overviewState.custom = c.custom_metrics ?? [];
  const viewer = session.workspaceRole === 'viewer',
    selected = new Set(c.sources.map(s => JSON.stringify([s.platform, s.connection_id, s.account_id]))),
    objectives = b.objectives.filter(o => o !== 'unknown');
  content.innerHTML = `<div class="report-heading"><div><span class="eyebrow">${esc(uiText('THE BIG PICTURE, WITH THE DETAILS'))}</span><h1>${esc(uiText('Reporting overview'))}<span class="report-spark" aria-hidden="true">✳</span></h1><p>${esc(uiText('Campaigns, ad sets and ads in one report. Every number keeps its source and measurement context.'))}</p></div><div class="report-actions"><button id="overview-delivery" class="button">${glyph('connection')} ${esc(uiText('Sheets & schedules'))}</button></div></div><p id="auth-error" class="error" role="alert"></p>${renderOverviewLibrary(b, viewer)}<form id="overview-config"><section class="report-control-panel">${renderReportSetupFields(c)}<datalist id="report-timezones">${['Africa/Cairo', 'Asia/Riyadh', 'Asia/Dubai', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'UTC'].map(v => `<option value="${v}">`).join('')}</datalist><h2 class="report-section-label"><span>01</span><strong>${esc(uiText('Platforms & accounts'))}</strong><small>${esc(uiText('Choose any combination. Each account keeps its own currency and reporting timezone.'))}</small></h2>${renderUnavailableReportSources(c, b)}<div class="report-platforms">${b.platforms
    .map(p => {
      const config = c.sources.find(s => s.platform === p.id) ?? c.source_defaults?.[p.id];
      return `<details class="report-platform" ${config ? 'open' : ''}><summary><span class="report-platform-dot platform-${p.id}">${esc(p.name.slice(0, 1))}</span><strong>${esc(p.name)}</strong><small>${esc(uiText(p.accounts.length === 1 ? '{count} account' : '{count} accounts', {count: p.accounts.length}))}</small></summary><div class="report-platform-body">${
        p.accounts.length
          ? `<label class="check"><input type="checkbox" data-report-all="${p.id}"> ${esc(uiText('Select all {platform} accounts', {platform: p.name}))}</label>${p.accounts
              .map(a => {
                const key = JSON.stringify([p.id, a.connection_id, a.account_id]),
                  parent =
                    c.sources.find(
                      s => s.platform === p.id && s.connection_id === a.connection_id && s.account_id === a.account_id,
                    )?.campaign_id ?? '';
                return `<label class="report-account"><input type="checkbox" data-report-account="${p.id}" value="${esc(key)}" ${selected.has(key) ? 'checked' : ''}><span>${esc(a.label)}<small>${esc(a.account_id)}</small><small>${esc(uiText('Login:'))} ${esc(a.connection_label ?? a.label)}</small></span></label>${p.id === 'snapchat' ? `<label data-report-parent-field hidden>${esc(uiText('Parent campaign UUID for ad squads'))}<input data-report-parent="${esc(key)}" value="${esc(parent)}" maxlength="36" disabled></label>` : ''}`;
              })
              .join('')}`
          : `<p class="muted">${esc(uiText('Connect and select an account to include {platform}.', {platform: p.name}))}</p><a href="/connections" class="text-link">${esc(uiText('Manage connections ↗'))}</a>`
      }${overviewGranularityFields(p, config)}<label>${esc(uiText('Objective when the API doesn’t supply it'))}<select data-objective-for="${p.id}"><option value="provider">${esc(uiText('Use provider objective'))}</option>${objectives.map(o => `<option value="${o}" ${config?.objective === o ? 'selected' : ''}>${esc(reportLabel(o))}</option>`).join('')}</select></label><details class="native-settings"><summary>${esc(uiText('Additional native metrics'))}</summary><p>${esc(uiText('Request provider metric names. Availability and compatible combinations vary by account.'))}</p><textarea data-native-for="${p.id}" rows="2" aria-label="${esc(uiText('{platform} native metric names', {platform: p.name}))}" placeholder="${esc(p.native_metrics.slice(0, 3).join(', '))}">${esc(config?.native_metrics?.join(', ') ?? '')}</textarea><small>${esc(uiText('Examples:'))} ${esc(p.native_metrics.join(', ') || uiText('The endpoint returns its native columns automatically.'))}</small></details></div></details>`;
    })
    .join(
      '',
    )}</div><details class="report-options"><summary><h2 class="report-section-label"><span>02</span><strong>${esc(uiText('Objectives, metrics & custom formulas'))}</strong></h2></summary><div class="report-options-grid"><div><h3>${esc(uiText('Filter by objective'))}</h3><p class="muted">${esc(uiText('Leave empty to show all objectives.'))}</p><div class="metric-pills">${b.objectives.map(o => `<label><input type="checkbox" data-report-objective value="${o}" ${c.objectives.includes(o) ? 'checked' : ''}><span>${esc(reportLabel(o))}</span></label>`).join('')}</div></div><div><h3>${esc(uiText('Displayed metrics'))}</h3><div class="metric-pills">${Object.entries(
    {
      ...b.metrics,
      ...Object.fromEntries(
        [
          ...new Set([
            ...(overviewState.report?.native_metrics ?? []),
            ...c.metrics.filter(k => k.startsWith('native_')),
          ]),
        ].map(id => [id, {label: id, aggregation: 'native field'}]),
      ),
    },
  )
    .map(
      ([id, m]) =>
        `<label><input type="checkbox" data-report-metric value="${id}" ${c.metrics.includes(id) ? 'checked' : ''}><span>${esc(b.metrics[id] ? uiText(m.label) : m.label)}<small class="metric-formula">${esc(m.formula ?? m.aggregation)}</small></span></label>`,
    )
    .join(
      '',
    )}</div></div></div><div class="custom-metric-heading"><div><h3>${esc(uiText('Your metrics'))}</h3><p>${esc(uiText('Calculate with metric names, numbers, parentheses and + − × /. Missing data and division by zero stay blank.'))}</p></div><button type="button" class="button" id="custom-metric-add">${esc(uiText('+ Create metric'))}</button></div><datalist id="native-field-list">${[...Object.keys(b.metrics), ...(overviewState.report?.native_metrics ?? [])].map(id => `<option value="${esc(id)}">`).join('')}</datalist><div id="custom-metric-list"></div><div id="custom-metric-editor" hidden><div class="custom-metric-fields"><label>${esc(uiText('Label'))}<input id="custom-label" placeholder="${esc(uiText('Cost per engaged session'))}" maxlength="80"></label><label>${esc(uiText('Identifier'))}<input id="custom-id" placeholder="cost_per_engaged_session" pattern="[a-z][a-z0-9_]*"></label><label>${esc(uiText('Formula'))}<input id="custom-formula" placeholder="spend / sessions" maxlength="500" list="native-field-list"></label><label>${esc(uiText('Format'))}<select id="custom-format"><option value="decimal">${esc(uiText('Decimal'))}</option><option value="currency">${esc(uiText('Currency'))}</option><option value="percent">${esc(uiText('Percent'))}</option><option value="number">${esc(uiText('Number'))}</option></select></label><button type="button" class="button primary" id="custom-metric-save">${esc(uiText('Add metric'))}</button></div></div></details><details class="report-options"><summary><h2 class="report-section-label"><span>03</span><strong>${esc(uiText('Performance targets & recommendation rules'))}</strong><small>${esc(uiText('Targets unlock objective-aware guidance.'))}</small></h2></summary><p class="muted">${esc(uiText('A recommendation compares results with your target after checking completeness, currency, attribution and sample size. AMCP never changes campaign budgets from this report.'))}</p><div class="target-grid">${objectives
    .map(o => {
      const t = c.targets[o] ?? {},
        kpi = {
          awareness: 'cpm',
          traffic: 'cpc',
          engagement: 'cost_per_engagement',
          video_views: 'cpv',
          leads: 'cpl',
          sales: 'cpa',
          app_installs: 'cpi',
        }[o];
      return `<div class="target-card"><h3>${esc(reportLabel(o))}</h3><div class="target-fields"><label>KPI<select data-target-kpi="${o}">${[...new Set([kpi, 'roas', 'cpa', 'cpc', 'cpm', 'cpl', 'cpi', 'cpv'])].map(k => `<option value="${k}" ${(t.kpi ?? kpi) === k ? 'selected' : ''}>${k.toUpperCase()}</option>`).join('')}</select></label><label>${esc(uiText('Target'))}<input type="number" step="any" min="0.000001" data-objective-target="${o}" value="${t.target ?? ''}" placeholder="${esc(uiText('Set target'))}"></label><label>${esc(uiText('Currency'))}<input data-target-currency="${o}" value="${esc(t.currency ?? '')}" maxlength="3" pattern="[A-Z]{3}" aria-label="${esc(uiText('{objective} target currency', {objective: reportLabel(o)}))}"></label><label>${esc(uiText('Min. results'))}<input data-target-sample="${o}" type="number" min="1" value="${t.minimum_results ?? (o === 'awareness' ? 1000 : ['sales', 'leads', 'app_installs'].includes(o) ? 10 : 30)}"></label><label>${esc(uiText('Conversion lag, days'))}<input data-target-lag="${o}" type="number" min="0" max="90" value="${t.conversion_lag_days ?? 3}"></label></div>${reportTargetContext(o, t.context)}</div>`;
    })
    .join(
      '',
    )}</div></details><label class="report-delivery-policy">${esc(uiText('Sheets delivery policy'))}<select name="partial_delivery"><option value="allow_marked" ${c.partial_delivery !== 'complete_only' ? 'selected' : ''}>${esc(uiText('Allow clearly marked partial reports'))}</option><option value="complete_only" ${c.partial_delivery === 'complete_only' ? 'selected' : ''}>${esc(uiText('Deliver complete reports only'))}</option></select></label><div class="report-runbar"><span id="report-selected-count" class="muted">${esc(uiText('Choose your accounts above.'))}</span><div><button type="button" id="overview-save" class="button" ${viewer ? 'disabled' : ''}>${overviewState.selection?.kind === 'template' ? uiText('Save template') : overviewState.selection ? uiText('Save changes') : uiText('Save report')}</button><button type="submit" class="button primary" ${viewer ? 'disabled' : ''}>${glyph('report')} ${esc(uiText('Pull report'))}</button></div></div></section></form><section id="overview-results"></section><section class="panel report-history">${renderOverviewHistory(history.reports, viewer)}</section><dialog id="report-delivery-dialog" class="report-delivery-dialog" aria-label="${esc(uiText('Report delivery'))}"><div id="report-delivery-content"></div></dialog>`;
  bindReportDates();
  document.querySelectorAll('[data-report-all]').forEach(el =>
    el.addEventListener('change', () => {
      document
        .querySelectorAll('[data-report-account="' + el.dataset.reportAll + '"]')
        .forEach(c => (c.checked = el.checked));
      count();
    }),
  );
  const count = () => {
    $('#report-selected-count').textContent = (n =>
      uiText(n === 1 ? '{count} account selected' : '{count} accounts selected', {count: n}))(
      document.querySelectorAll('[data-report-account]:checked').length,
    );
  };
  document.querySelectorAll('[data-report-account]').forEach(el => el.addEventListener('change', count));
  for (const control of document.querySelectorAll('[data-report-level], [data-report-account]'))
    control.addEventListener('change', updateOverviewGranularity);
  updateOverviewGranularity();
  count();
  renderCustomMetrics();
  $('#custom-metric-add').addEventListener('click', () => {
    $('#custom-metric-editor').hidden = false;
    $('#custom-label').focus();
  });
  $('#custom-metric-save').addEventListener('click', () => {
    const m = {
      label: $('#custom-label').value.trim(),
      id: $('#custom-id').value.trim(),
      formula: $('#custom-formula').value.trim(),
      format: $('#custom-format').value,
    };
    if (
      !m.label ||
      !m.formula ||
      !/^[a-z][a-z0-9_]{0,47}$/.test(m.id) ||
      overviewState.custom.some(x => x.id === m.id)
    ) {
      toast(uiText('Use a label, unique identifier and formula.'));
      return;
    }
    overviewState.custom.push(m);
    renderCustomMetrics();
    $('#custom-metric-editor').hidden = true;
  });
  authBind('#overview-config', async () => {
    if (overviewState.selection?.kind === 'template')
      throw new Error(uiText('Create a report from this template and choose its client accounts first.'));
    overviewState.config = overviewConfig();
    const run = await overviewCall({action: 'run', config: overviewState.config, confirmed: true});
    overviewState.page = 0;
    await loadOverviewReport(run.id);
  });
  authBind('#overview-save', async () => saveOverviewDefinition());
  bindOverviewLibrary();
  authBind('#overview-delivery', async () => {
    if (overviewState.selection?.kind === 'template')
      throw new Error(uiText('Create a report from this template before choosing its destination and schedule.'));
    overviewState.config = overviewConfig();
    await renderReportDelivery();
  });
  const snapshotId = link.get('report_id');
  if (snapshotId) {
    await loadOverviewReport(snapshotId, 0);
    const result = $('#overview-results');
    result?.setAttribute('tabindex', '-1');
    result?.scrollIntoView({block: 'start'});
    result?.focus({preventScroll: true});
  } else if (overviewState.report) await loadOverviewReport(overviewState.report.id);
  if (link.get('delivery') === '1') await renderReportDelivery();
}
function renderCustomMetrics() {
  const root = $('#custom-metric-list');
  root.innerHTML =
    overviewState.custom
      .map(
        (m, i) =>
          `<div class="custom-metric-row"><div><strong>${esc(m.label)}</strong><code>${esc(m.id)} = ${esc(m.formula)}</code></div><span>${esc(reportLabel(m.format))}</span><button type="button" class="button small" data-remove-metric="${i}" aria-label="${esc(uiText('Remove {name}', {name: m.label}))}">${esc(uiText('Remove'))}</button></div>`,
      )
      .join('') ||
    `<p class="muted">${esc(uiText('Example:'))} <code>cost_per_thousand_sessions = spend / sessions * 1000</code></p>`;
  root.querySelectorAll('[data-remove-metric]').forEach(b =>
    b.addEventListener('click', () => {
      overviewState.custom.splice(Number(b.dataset.removeMetric), 1);
      renderCustomMetrics();
    }),
  );
}
async function loadOverviewReport(id, page = overviewState.page) {
  if (location.pathname !== '/reporting-overview') return;
  clearTimeout(pollTimer);
  const sequence = ++overviewState.loadSequence;
  const r = await overviewCall({action: 'get', id, offset: page * 100, limit: 100});
  if (location.pathname !== '/reporting-overview' || sequence !== overviewState.loadSequence) return;
  overviewState.report = r;
  overviewState.page = page;
  refreshRecentReports(r);
  const active = ['queued', 'running'].includes(r.job.state),
    exportable = ['complete', 'partial'].includes(r.state) && r.row_count > 0,
    keys = [...new Set([...r.config.metrics, ...r.config.custom_metrics.map(m => m.id)])],
    b = overviewState.bootstrap,
    root = $('#overview-results');
  root.innerHTML = `<div class="report-results-heading"><div><span class="eyebrow">${esc(reportRangeLabel(r.config.date_range))}</span><h2>${esc(r.config.name)}</h2><p class="muted">${active ? reportLabel(r.job.state) : reportDisplayState(r)} · ${esc(uiText('{count} entity/resource rows', {count: r.row_count}))} · ${date(r.completed_at ?? r.created_at)}</p></div><div class="report-actions">${active ? `<button class="button" id="report-cancel">${esc(uiText('Cancel run'))}</button>` : exportable ? `<a class="button" href="/api/reporting-overview/${encodeURIComponent(r.id)}.csv" download="AMCP-report.csv">${esc(uiText('Download CSV'))}</a><a class="button" href="/api/reporting-overview/${encodeURIComponent(r.id)}.metadata.json" download="AMCP-report-evidence.json">${esc(uiText('Download source evidence'))}</a><button class="button primary" id="report-export" ${r.rows.length ? '' : 'disabled'}>${esc(uiText('Export now to Google Sheets ↗'))}</button>` : ''}${['failed', 'cancelled'].includes(r.job.state) ? `<button class="button" id="report-retry">${esc(uiText('Retry failed run'))}</button>` : ''}</div></div>${active ? `<div class="report-progress" role="status"><span class="live-dot"></span><div><strong>${r.job.attempts > 1 ? uiText('Retrying the interrupted source') : uiText('Collecting native entity reports')}</strong><p>${esc(uiText('Completed sources are retained. You can leave this page and return to this report.'))}</p></div><span>${esc(uiText('Attempt'))} ${r.job.attempts || 1}</span></div>` : ''}${r.job.error ? `<div class="notice"><strong>${esc(r.job.error.code)}</strong><p>${esc(uiOwnedError(r.job.error).message)}${active ? ' ' + esc(uiText('Next attempt: {date}', {date: date(r.job.available_at)})) : ''}</p></div>` : ''}${renderReportSummary(r)}${renderMetricSources(r, keys, b)}<div class="report-source-health">${(r.sources ?? []).map((s, i) => renderReportSourceHealth(s, b.platforms, i, r.config.date_range)).join('')}</div>${!active && r.rows.length ? `<div class="report-table-wrap" role="region" tabindex="0" aria-label="${esc(uiText('Report rows (scrolls sideways)'))}"><table class="report-table"><caption>${esc(overviewLabel(r.config))} · ${esc(reportWindowLabel(r.config.date_range))} · ${esc(uiText('{grain} grouping', {grain: reportLabel(r.config.grain ?? 'total')}))}</caption><thead><tr><th scope="col">${esc(uiText('Campaign / ad set / ad / resource'))}</th><th scope="col">${esc(uiText('Platform · objective'))}</th>${r.config.grain && r.config.grain !== 'total' ? `<th scope="col">${esc(uiText('Period'))}</th>` : ''}${keys.map(k => `<th scope="col">${esc(b.metrics[k] ? uiText(b.metrics[k].label) : (r.config.custom_metrics.find(m => m.id === k)?.label ?? pretty(k)))}</th>`).join('')}<th scope="col">${esc(uiText('Recommended next move'))}</th></tr></thead><tbody>${r.rows.map(row => `<tr><th scope="row"><strong>${esc(row.entity_name ?? row.campaign_name)}</strong><small>${esc(row.entity_id ?? row.campaign_id)}<br>${row.entity_level ? esc(uiText('Reporting level: {level}', {level: reportLevelLabel(b, row)})) + '<br>' : ''}${row.parent_ids?.campaign_id ? esc(uiText('Campaign: {id}', {id: row.parent_ids.campaign_id})) + '<br>' : ''}${row.parent_ids?.adset_id ? esc(uiText('Ad set / ad group: {id}', {id: row.parent_ids.adset_id})) + '<br>' : ''}${esc(row.account_id)} · ${esc(row.currency ?? '—')}${row.timezone ? ' · ' + esc(row.timezone) : ''}</small><details><summary>${esc(uiText('Source details'))}</summary><p>${esc(row.result_definition)}<br>${esc(row.attribution)}<br>${esc(row.timezone)}</p>${reportQualityDetails(row)}<pre>${esc(JSON.stringify(row.native, null, 2))}</pre></details></th><td><span>${esc(b.platforms.find(p => p.id === row.platform)?.name ?? row.platform)}</span><small>${esc(reportLabel(row.objective_group))}</small></td>${r.config.grain && r.config.grain !== 'total' ? `<td>${esc(reportDay(row.date_from))}<br>${esc(reportDay(row.date_to))}</td>` : ''}${keys.map(k => `<td>${esc(metricFormat(k, row.metrics[k], row.currency))}</td>`).join('')}<td class="recommendation"><span class="recommendation-pill decision-${row.recommendation.decision}">${esc(reportLabel(row.recommendation.decision))}</span><p>${esc(uiRecommendationReason(row.recommendation))}</p>${row.recommendation.evidence?.target ? `<small>${esc(uiText('{kpi} target {target} · actual {actual}', {kpi: row.recommendation.evidence.kpi, target: row.recommendation.evidence.target, actual: Number(row.recommendation.evidence.actual).toFixed(2)}))}</small>` : ''}</td></tr>`).join('')}</tbody></table></div><div class="report-pagination"><span>${esc(uiText('Rows {start}–{end} of {total}. A dash means unavailable.', {start: r.offset + 1, end: r.offset + r.rows.length, total: r.row_count}))}</span><div><button id="report-prev" class="button small" ${r.offset ? '' : 'disabled'}>${esc(uiText('← Previous'))}</button><button id="report-next" class="button small" ${r.has_more ? '' : 'disabled'}>${esc(uiText('Next →'))}</button></div></div><details class="panel"><summary>${esc(uiText('Native fields available for custom metrics'))}</summary><p>${esc(uiText('Use these exact identifiers in a formula. Fields from other platforms are blank for this row.'))}</p><div class="native-field-tags">${(r.native_metrics ?? []).map(n => `<code>${esc(n)}</code>`).join('')}</div></details>` : !active ? renderReportEmpty(r) : ''}${renderExportHistory(r)}${r.export?.state === 'skipped' ? `<p class="notice">${esc(uiOwnedError(r.export).message)}</p>` : ''}${r.export?.url ? `<p class="notice">${esc(uiText('Scheduled export complete.'))} <a href="${esc(r.export.url)}" target="_blank" rel="noopener">${esc(uiText('Open Google Sheets ↗'))}</a></p>` : ''}`;
  bindSnapshotAnalysis(r, root);
  authBind('[data-report-diagnostic]', async button => {
    const s = r.sources[Number(button.dataset.reportDiagnostic)];
    await navigator.clipboard.writeText(
      JSON.stringify(
        {report_id: r.id, platform: s.source.platform, account_id: s.source.account_id, error: s.error},
        null,
        2,
      ),
    );
    toast(uiText('Error details copied.'));
  });
  authBind('#report-cancel', async () => {
    await overviewCall({action: 'cancel', id: r.job_id, confirmed: true});
    await loadOverviewReport(id);
  });
  authBind('#report-retry', async () => {
    await overviewCall({action: 'retry', id: r.job_id, confirmed: true});
    await loadOverviewReport(id);
  });
  authBind('#report-export', async () => {
    await renderReportDelivery('sheets_now');
  });
  let paging = false;
  const changePage = async delta => {
    if (paging) return;
    paging = true;
    try {
      await loadOverviewReport(id, overviewState.page + delta);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      paging = false;
    }
  };
  $('#report-prev')?.addEventListener('click', () => changePage(-1));
  $('#report-next')?.addEventListener('click', () => changePage(1));
  authBind('[data-export-retry]', async b => {
    await overviewCall({action: 'retry', id: b.dataset.exportRetry, confirmed: true});
    await loadOverviewReport(id);
  });
  if (active || (r.exports ?? []).some(e => ['queued', 'running'].includes(e.state)))
    pollTimer = setTimeout(() => {
      void loadOverviewReport(id).catch(e => toast(e.message));
    }, 3000);
}
function deliveryKey(form, values) {
  const signature = JSON.stringify(values);
  if (form.dataset.requestValues !== signature) {
    form.dataset.requestValues = signature;
    form.dataset.requestKey = crypto.randomUUID();
  }
  return form.dataset.requestKey;
}
function deliveryAccountSummary(config, b) {
  return (config.sources ?? []).map(s => {
    const p = b.platforms.find(p => p.id === s.platform),
      a = p?.accounts.find(a => a.account_id === s.account_id && a.connection_id === s.connection_id);
    return (p?.name ?? pretty(s.platform)) + ' · ' + (a?.label ?? s.account_id) + ' (' + s.account_id + ')';
  });
}
function updateSavedReportChoices(b) {
  const select = $('#overview-saved');
  if (select) select.innerHTML = overviewLibraryOptions(b);
}

function renderReportSummary(r) {
  return (
    `<div class="report-summary-grid">` +
    (r.summary ?? [])
      .slice(0, 12)
      .map(
        g =>
          `<article class="report-summary-card"><small>` +
          esc(pretty(g.platform)) +
          ' · ' +
          esc(g.account_id) +
          ' · ' +
          esc(g.currency ?? uiText('Currency unavailable')) +
          `</small><p>` +
          esc(reportDay(g.date_from)) +
          ' — ' +
          esc(reportDay(g.date_to)) +
          `</p><h3>` +
          esc(reportLabel(g.objective_group)) +
          ` <span>` +
          esc(
            g.entity_level
              ? uiText('{count} entity/resource rows', {count: g.entity_count})
              : uiText('{count} campaigns', {count: g.campaign_count}),
          ) +
          `</span></h3><div><span>${esc(uiText('Spend'))}<strong>` +
          esc(metricFormat('spend', g.metrics.spend, g.currency)) +
          `</strong></span><span>${esc(uiText('Clicks'))}<strong>` +
          esc(metricFormat('clicks', g.metrics.clicks)) +
          `</strong></span><span>CPC<strong>` +
          esc(metricFormat('cpc', g.metrics.cpc, g.currency)) +
          `</strong></span></div><p>` +
          Object.entries(g.decisions)
            .map(([k, n]) => esc(n + ' ' + reportLabel(k)))
            .join(' · ') +
          `</p></article>`,
      )
      .join('') +
    `</div>` +
    ((r.summary ?? []).length > 12
      ? `<p class="form-note">${esc(uiText('Showing the first 12 account/period summaries. All rows are available in the paginated table, CSV and Sheets export.'))}</p>`
      : '')
  );
}
/** How each platform in the report measures each selected metric, so columns are compared knowingly across platforms. */
function renderMetricSources(r, keys, b) {
  if ((r.config.sources ?? []).some(s => s.level && s.level !== 'campaign'))
    return renderDetailedMetricSources(r, keys, b);
  const sources = b.metric_sources ?? {},
    platforms = [...new Set((r.config.sources ?? []).map(s => s.platform))].filter(p => sources[p]),
    shared = keys.filter(k => b.metrics[k] && !b.metrics[k].formula);
  if (!platforms.length || !shared.length) return '';
  const number = n => new Intl.NumberFormat(reportLocale()).format(n),
    cell = s =>
      s
        ? `<code>` +
          esc(s.from) +
          `</code>` +
          (s.divisor ? ' ÷ ' + esc(number(s.divisor)) : '') +
          (s.note ? `<small>` + esc(s.note) + `</small>` : '')
        : `<span class="muted">${esc(uiText('Not reported'))}</span>`;
  return (
    `<details class="panel metric-sources"><summary>${esc(uiText('How each platform counts these metrics'))}</summary><div class="report-table-wrap" role="region" tabindex="0" aria-label="${esc(uiText('Metric sources by platform (scrolls sideways)'))}"><table class="report-table"><caption>${esc(uiText('The native field or rule behind each metric. Calculated metrics such as CPA and ROAS use these values.'))}</caption><thead><tr><th scope="col">${esc(uiText('Metric'))}</th>` +
    platforms.map(p => `<th scope="col">` + esc(b.platforms.find(x => x.id === p)?.name ?? p) + `</th>`).join('') +
    `</tr></thead><tbody>` +
    shared
      .map(
        k =>
          `<tr><th scope="row">` +
          esc(uiText(b.metrics[k].label)) +
          `</th>` +
          platforms.map(p => `<td>` + cell(sources[p][k]) + `</td>`).join('') +
          `</tr>`,
      )
      .join('') +
    `</tbody></table></div></details>`
  );
}
/** A detailed snapshot can select different native result fields for each account and entity level. */
function renderDetailedMetricSources(r, keys, b) {
  const selected = r.config.sources ?? [],
    shared = keys.filter(k => b.metrics[k] && !b.metrics[k].formula),
    number = n => new Intl.NumberFormat(reportLocale()).format(n),
    unavailable = () => `<span class="muted">${esc(uiText('Native mapping unavailable'))}</span>`,
    cell = (source, key) => {
      const detailed = source.level && source.level !== 'campaign',
        captured = (r.sources ?? []).find(s =>
          ['platform', 'connection_id', 'account_id'].every(k => s.source?.[k] === source[k]),
        ),
        mapping = detailed ? captured?.metric_mapping : b.metric_sources?.[source.platform];
      if (detailed && !mapping) return unavailable();
      const field = mapping?.[key];
      if (!field) return `<span class="muted">${esc(uiText('Not reported'))}</span>`;
      const native = detailed ? (typeof field === 'string' ? field : field.path) : field.from;
      if (typeof native !== 'string') return unavailable();
      return (
        `<code>${esc(native + (detailed && field.action_type !== undefined ? '[action_type=' + field.action_type + ']' : ''))}</code>` +
        (field.divisor ? ' ÷ ' + esc(number(field.divisor)) : '') +
        (!detailed && field.note ? `<small>${esc(field.note)}</small>` : '')
      );
    };
  if (!selected.length || !shared.length) return '';
  return (
    `<details class="panel metric-sources"><summary>${esc(uiText('How this snapshot counts its metrics'))}</summary><div class="report-table-wrap" role="region" tabindex="0" aria-label="${esc(uiText('Native metric mappings by account and entity level (scrolls sideways)'))}"><table class="report-table"><caption>${esc(uiText('The saved native fields used for each account and entity level. Additive daily values are summed for each report period; reach and frequency are available only for single-day entity rows.'))}</caption><thead><tr><th scope="col">${esc(uiText('Metric'))}</th>` +
    selected
      .map(s => {
        const platform = b.platforms.find(p => p.id === s.platform),
          level = (platform?.entity_levels ?? []).find(l => l.id === (s.level ?? 'campaign'));
        return `<th scope="col">${esc(platform?.name ?? s.platform)}<br><bdi>${esc(s.account_id)}</bdi><br>${esc(uiText('Reporting level: {level}', {level: uiText(level?.label ?? (s.level ? pretty(s.level) : 'Campaigns'))}))}</th>`;
      })
      .join('') +
    `</tr></thead><tbody>` +
    shared
      .map(
        k =>
          `<tr><th scope="row">${esc(uiText(b.metrics[k].label))}</th>${selected.map(s => `<td>${cell(s, k)}</td>`).join('')}</tr>`,
      )
      .join('') +
    `</tbody></table></div></details>`
  );
}
function renderExportHistory(r) {
  return (r.exports ?? []).length
    ? `<section class="panel"><h3>${esc(uiText('Delivery history'))}</h3>` +
        r.exports
          .map(
            e =>
              `<div class="schedule-row"><span><strong>` +
              esc(reportLabel(e.state)) +
              `</strong><small>` +
              esc(
                (e.error && uiOwnedError(e.error).message) ||
                  (e.destination_kind === 'report_files'
                    ? uiText('{name} · Stored report files', {name: e.destination_name})
                    : uiText('Google Sheets export')),
              ) +
              `</small></span>` +
              (e.destination_kind === 'report_files' ? reportFileLinks(e) : '') +
              (e.url
                ? `<a class="button small" href="` +
                  esc(e.url) +
                  `" target="_blank" rel="noopener">${esc(uiText('Open sheet ↗'))}</a>`
                : '') +
              (['failed', 'cancelled'].includes(e.state)
                ? `<button class="button small" data-export-retry="` +
                  esc(e.job_id) +
                  `">${esc(uiText('Retry export'))}</button>`
                : '') +
              `</div>`,
          )
          .join('') +
        `</section>`
    : '';
}

function reportFileLinks(e) {
  return (e.files ?? [])
    .filter(f => ['pdf', 'xlsx'].includes(f.format))
    .map(
      f =>
        `<a class="button small" href="/api/reporting-files/` +
        encodeURIComponent(e.id) +
        '.' +
        f.format +
        '" download>' +
        esc(uiText('Download {format}', {format: f.format.toUpperCase()})) +
        ' · ' +
        esc(Math.ceil(f.size_bytes / 1024)) +
        ` KB</a>`,
    )
    .join('');
}

/** Dates read in the viewer's language; outside a browser (and when it is unavailable) the long British form stays. */
function reportLocale() {
  if (uiLocale === 'ar') return 'ar';
  try {
    return navigator.languages?.[0] ?? navigator.language ?? 'en-GB';
  } catch {
    return 'en-GB';
  }
}
/** A report day (YYYY-MM-DD) in the viewer's locale; anything else is shown as it is. */
function reportDay(value) {
  const d = new Date(String(value ?? '') + 'T00:00:00Z');
  return value && Number.isFinite(d.getTime())
    ? new Intl.DateTimeFormat(reportLocale(), {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(d)
    : String(value ?? '');
}
function reportRangeLabel(range) {
  const format = value => {
    const d = new Date(value + 'T00:00:00Z');
    return Number.isFinite(d.getTime())
      ? new Intl.DateTimeFormat(reportLocale(), {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        }).format(d)
      : uiText('Choose a date');
  };
  return range?.since && range?.until
    ? format(range.since) + ' — ' + format(range.until)
    : uiText('the selected period');
}
function reportMonthRange(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(uiText('Choose a valid reporting month and year.'));
  const end = new Date(month + '-01T00:00:00Z');
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  if (!Number.isFinite(end.getTime()) || end.toISOString().slice(0, 10).length !== 10)
    throw new Error(uiText('Choose a valid reporting month and year.'));
  return {since: month + '-01', until: end.toISOString().slice(0, 10)};
}
function overviewInitialConfig(search) {
  const c = overviewDefault(),
    q = new URLSearchParams(search);
  if (q.has('since') || q.has('until')) {
    const since = q.get('since'),
      until = q.get('until'),
      valid = v =>
        typeof v === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(v) &&
        Number.isFinite(Date.parse(v)) &&
        new Date(v).toISOString().slice(0, 10) === v;
    if (!valid(since) || !valid(until) || since > until || Date.parse(until) - Date.parse(since) > 365 * 86400000)
      throw new Error(uiText('The report link needs valid dates covering at most 366 days.'));
    c.date_range = {since, until};
  }
  return c;
}
function bindReportDates() {
  const mode = $('#report-range-mode'),
    since = $('[name="since"]'),
    until = $('[name="until"]'),
    summary = $('#report-range-summary');
  const update = () => {
    const rolling = mode.value !== 'custom',
      days = mode.value === 'last_complete_days' || mode.value === 'rolling';
    $('#report-rolling').hidden = !rolling;
    $('#report-dates').hidden = rolling;
    document.querySelectorAll('[data-rolling-days]').forEach(el => {
      el.hidden = !days;
      el.querySelector('input').disabled = !days;
    });
    since.required = until.required = !rolling;
    since.disabled = until.disabled = rolling;
    $('[name=timezone]').required = rolling;
    $('[name=timezone]').disabled = !rolling;
    summary.textContent = rolling
      ? uiText(
          'The complete calendar window is fixed when collection starts. Grouping uses each provider’s reporting calendar.',
        )
      : uiText('{range} · Dates use each platform’s reporting timezone.', {
          range: reportRangeLabel({since: since.value, until: until.value}),
        });
  };
  const manual = () => {
    $('#report-calendar-month').value = '';
    update();
  };
  mode.addEventListener('change', update);
  since.addEventListener('input', manual);
  until.addEventListener('input', manual);
  $('#report-calendar-month').addEventListener('change', e => {
    if (!e.target.value) return;
    const range = reportMonthRange(e.target.value);
    since.value = range.since;
    until.value = range.until;
    update();
  });
  update();
}
function reportSourceRowCount(r) {
  return r.source_row_count ?? (r.sources ?? []).reduce((n, s) => n + (s.row_count ?? 0), 0);
}
function reportDisplayState(r) {
  return r.state === 'complete' && r.row_count === 0
    ? r.empty_reason === 'objective_filter' || reportSourceRowCount(r) > 0
      ? uiText('Filtered out')
      : uiText('No data')
    : reportLabel(r.state);
}
function renderReportEmpty(r) {
  if (r.state === 'failed' || r.job?.state === 'failed')
    return `<div class="empty panel">${esc(uiText('The report could not be collected. Resolve the source errors above, then retry.'))}</div>`;
  if (r.state === 'cancelled')
    return `<div class="empty panel">${esc(uiText('This report was cancelled. Pull a new report to collect its data.'))}</div>`;
  const count = reportSourceRowCount(r),
    filtered = r.empty_reason === 'objective_filter' || r.filtered_row_count > 0 || count > 0;
  return `<div class="empty panel report-empty"><h3>${filtered ? uiText('Your objective filters excluded the returned rows') : uiText('No campaign rows returned')}</h3><p>${esc(reportRangeLabel(r.config.date_range))}</p><p>${filtered ? esc(uiText('{count} rows were returned before filtering. Review the objective selections above.', {count})) : uiText('Check that the selected account and reporting year match Ads Manager. No performance values have been assumed.')}</p><p>${esc(uiText('There is nothing to export. CSV downloads and Google Sheets updates are disabled for this report.'))}</p><a class="button" href="#overview-config">${esc(uiText('Review dates, account and filters'))}</a></div>`;
}
/** A row's reporting level: AMCP's level label in the interface language, otherwise the provider's native type. */
function reportLevelLabel(b, row) {
  const label = (b.platforms.find(p => p.id === row.platform)?.entity_levels ?? []).find(
    level => level.id === row.entity_level,
  )?.label;
  return label ? uiText(label) : String(row.native_entity_type ?? '');
}
function renderSourceDiagnostic(error) {
  const p = error.provider ?? {},
    owned = uiOwnedError(error),
    phase =
      {
        account_list: uiText('Accessible accounts'),
        account_lookup: uiText('Account lookup'),
        manager_hierarchy: uiText('Manager account hierarchy'),
        campaign_report: uiText('Campaign report'),
        campaign_lookup: uiText('Campaign lookup'),
      }[error.request?.stage] ?? uiText('Provider request');
  return `<div class="source-diagnostic"><strong><code>${esc(p.code ?? error.code)}</code>${error.http_status ? ` · HTTP ${esc(error.http_status)}` : ''}</strong><p>${esc(owned.message)}</p>${owned.nextAction ? `<p class="source-next-action">${esc(owned.nextAction)}</p>` : ''}${error.request ? `<small>${esc(phase)} · <code>${esc(error.request.method)} ${esc(error.request.path)}</code></small>` : ''}${Object.hasOwn(error, 'login_customer_id') ? `<small>${esc(uiText('Google login customer ID:'))} ${esc(error.login_customer_id ?? uiText('not sent'))}</small>` : ''}${p.request_id ? `<small>${esc(uiText('Provider request ID:'))} <code>${esc(p.request_id)}</code></small>` : ''}${p.errors?.length > 1 ? `<ul>${p.errors.map(e => `<li><code>${esc(e.code ?? '')}</code> ${esc(e.message ?? '')}${e.field ? ` · ${esc(e.field)}` : ''}</li>`).join('')}</ul>` : ''}</div>`;
}
function renderReportSourceHealth(s, platforms, index, range) {
  return `<details class="source-health ${s.complete ? 'complete' : 'attention'}" ${s.error ? 'open' : ''}><summary><span>${esc(platforms.find(p => p.id === s.source.platform)?.name ?? s.source.platform)}</span><strong>${s.error ? uiText('Source failed') : s.row_count === 0 ? uiText('No rows returned') : s.complete ? uiText('Complete') : uiText('Limited coverage')}</strong></summary>${s.account_name ? `<p><strong>${esc(s.account_name)}</strong></p>` : ''}<p>${esc(s.source.account_id)} · ${esc(s.currency ?? uiText('Currency unavailable'))} · ${esc(s.timezone ?? uiText('Timezone unavailable'))}</p>${s.error ? renderSourceDiagnostic(s.error) : `<p>${esc(s.row_count === 0 ? uiText('The provider returned no campaign rows for {range}. Check the account and year.', {range: reportRangeLabel(s.date_range ?? range)}) + ' ' + (s.warnings?.join(' ') ?? '') : s.warnings?.join(' ') || uiText('All returned pages captured.'))}</p>`}${s.row_count > 0 ? `<p>${esc(uiText('{count} source rows', {count: s.row_count}))}${s.visible_row_count === undefined ? '' : ' · ' + esc(uiText('{count} shown after objective filters', {count: s.visible_row_count}))}</p>` : ''}<small>${esc(s.attribution ?? '')}</small>${reportQualityDetails(s)}${renderPeriodFailures(s.period_errors ?? s.error?.period_errors ?? [])}${s.error ? `<div class="report-actions"><a class="button small" href="/connections">${esc(uiText('Manage connections'))}</a><button type="button" class="button small" data-report-diagnostic="${index}">${esc(uiText('Copy error details'))}</button></div>` : ''}</details>`;
}
function renderPeriodFailures(periods) {
  return periods.length
    ? `<details><summary>` +
        esc(uiText('{count} failed calendar period(s)', {count: periods.length})) +
        `</summary>` +
        periods
          .map(
            p =>
              `<p><strong>` +
              esc(reportRangeLabel(p.date_range)) +
              `</strong></p>` +
              renderSourceDiagnostic(p.error ?? {}),
          )
          .join('') +
        `</details>`
    : '';
}
