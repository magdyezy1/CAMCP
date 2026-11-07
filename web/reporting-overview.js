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
const overviewDefault = () => ({
  contract_version: 'overview-config-v4',
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
  superseded: 'Superseded',
  retrying: 'Retrying',
  pending: 'Sending',
  uncertain: 'Unconfirmed',
  rejected: 'Not applied',
  abandoned: 'Tab released',
  awareness: 'Awareness',
  traffic: 'Traffic',
  engagement: 'Engagement',
  video_views: 'Video Views',
  leads: 'Leads',
  sales: 'Sales',
  app_installs: 'App Installs',
  unknown: 'Unknown',
  mixed: 'Mixed',
  rolled_up_ads: 'Rolled up from selected ads',
  rolled_up_children: 'Rolled up from selected child entities',
  provider: 'From the platform',
  provider_mapped: 'Mapped from campaign settings',
  provider_inferred: 'Inferred from the platform’s value',
  user_override: 'Your choice',
  'user confirmed': 'Your choice',
  user_fallback: 'Your fallback',
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
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
  all: 'All',
};
function reportLabel(value) {
  return Object.hasOwn(reportLabels, value) ? uiText(reportLabels[value]) : pretty(value);
}
function reportObjectiveValue(config = {}) {
  return (
    config.objective_fallback ?? (config.objective && config.objective !== 'unknown' ? config.objective : 'provider')
  );
}
function reportObjectiveFields(platform, previous) {
  const value = $('[data-objective-for="' + CSS.escape(platform) + '"]').value,
    initial =
      overviewState.config?.sources.find(source => source.platform === platform) ??
      overviewState.config?.source_defaults?.[platform];
  // An unchanged platform control keeps each account’s saved choices.
  if (previous && value === reportObjectiveValue(initial))
    return Object.fromEntries(
      reportObjectiveValue(previous) === 'provider' ? [] : [['objective_fallback', reportObjectiveValue(previous)]],
    );
  return value === 'provider' ? {} : {objective_fallback: value};
}
function reportObjectiveSelect(platform, config = {}, groups) {
  const value = reportObjectiveValue(config);
  return html`<label>${uiText('Objective when the platform gives none')}<select data-objective-for="${platform}"><option value="provider">${uiText('No fallback (show unknown)')}</option>${groups.map(group => html`<option value="${group}" ${value === group ? 'selected' : ''}>${reportLabel(group)}</option>`)}</select></label>`;
}
/**
 * A row's objective: its group, where the group came from and, when it is unknown, why. A v4 snapshot nests them under
 * `objective` ({native, group, source, reason}); a snapshot recorded before that keeps them flat on the row beside a
 * native objective string. One reader serves every renderer, so each snapshot is shown as it was recorded.
 */
function reportRowObjective(row) {
  const nested = row.objective !== null && typeof row.objective === 'object' ? row.objective : {};
  return {
    group: nested.group ?? row.objective_group,
    source: nested.source ?? row.objective_source,
    reason: nested.reason ?? row.objective_reason,
  };
}
function reportObjectiveSource(row) {
  const objective = reportRowObjective(row);
  if (row.results_by_objective?.length && objective.source === 'provider')
    return uiText('This campaign group’s campaigns have different objectives: {list}.', {
      list: row.results_by_objective.map(reportResultObjective).join(', '),
    });
  if (objective.source === 'user_fallback' && objective.reason) return uiText(objective.reason);
  if (objective.source !== 'unknown') return objective.source ? reportLabel(objective.source) : '';
  const reason = String(objective.reason ?? ''),
    known = /^(.+?)’s (.+) has no matching AMCP objective; choose one in the report\.$/s.exec(reason),
    unknown = /^(.+?) returned the objective (.+), which AMCP does not group yet; choose one in the report\.$/s.exec(
      reason,
    );
  return known
    ? uiText('{platform}’s {native} has no matching AMCP objective; choose one in the report.', {
        platform: known[1],
        native: known[2],
      })
    : unknown
      ? uiText('{platform} returned the objective {native}, which AMCP does not group yet; choose one in the report.', {
          platform: unknown[1],
          native: unknown[2],
        })
      : uiText(reason);
}

/** Defaults mirror report-metrics.ts campaignRecommendation. */
const reportDefaultKpi = {
  awareness: 'cpm',
  traffic: 'cpc',
  engagement: 'cost_per_engagement',
  video_views: 'cpv',
  leads: 'cpl',
  sales: 'cpa',
  app_installs: 'cpi',
};
/** Target direction comes from its explicit value or the KPI definition. */
function reportTargetDirection(kpi, explicit) {
  const better =
    explicit ?? overviewState.bootstrap?.metrics?.[kpi]?.better ?? (kpi === 'cost_per_engagement' ? 'lower' : null);
  return better === 'higher'
    ? uiText('Higher is better')
    : better === 'lower'
      ? uiText('Lower is better')
      : uiText('Set a direction for this KPI');
}
/** The objective of an "objective:CURRENCY" target key (DEC-01), or null for objective and campaign keys. */
function reportCurrencyTargetObjective(key) {
  const match = /^([a-z_]+):([A-Z]{3})$/.exec(key);
  return match && Object.hasOwn(reportDefaultKpi, match[1]) ? match[1] : null;
}
/** Target fields without a website control (set through MCP) survive a website save; direction only for its KPI. */
function reportTargetExtras(previous, objective, kpi) {
  if (!previous) return {};
  const {direction, minimum_spend, maximum_change_percent, result_metric} = previous;
  return {
    ...(direction !== undefined && (previous.kpi ?? reportDefaultKpi[objective]) === kpi ? {direction} : {}),
    ...(minimum_spend !== undefined ? {minimum_spend} : {}),
    ...(maximum_change_percent !== undefined ? {maximum_change_percent} : {}),
    ...(result_metric !== undefined ? {result_metric} : {}),
  };
}
let reportCurrencyTargetSequence = 0;
/** One target for accounts in another currency. It reuses its card's KPI, sample and lag settings. */
function reportCurrencyTargetRow(objective, target = {}) {
  const row = objective + ':' + reportCurrencyTargetSequence++;
  return `<div class="target-currency-row" data-currency-target-row="${row}"><label>${esc(uiText('Currency'))}<input data-currency-target-currency="${row}" value="${esc(target.currency ?? '')}" maxlength="3" pattern="[A-Z]{3}" aria-label="${esc(uiText('{objective} target currency', {objective: reportLabel(objective)}))}"></label><label>${esc(uiText('Target'))}<input type="number" step="any" min="0.000001" data-currency-target-value="${row}" value="${target.target ?? ''}" placeholder="${esc(uiText('Set target'))}"></label><button type="button" class="button small" data-currency-target-remove="${row}">${esc(uiText('Remove'))}</button></div>`;
}
function reportCurrencyTargets(objective, targets) {
  const rows = Object.entries(targets ?? {}).filter(([key]) => reportCurrencyTargetObjective(key) === objective);
  return `<div class="target-currencies"><p class="form-note">${esc(uiText('Accounts in another currency need their own target. It uses this card’s KPI, sample and lag.'))}</p><div data-currency-targets="${objective}">${rows.map(([, t]) => reportCurrencyTargetRow(objective, t)).join('')}</div><button type="button" class="button small" data-currency-target-add="${objective}">${esc(uiText('+ Target for another currency'))}</button></div>`;
}
/** Grouped rows share their entity's whole-window recommendation (DEC-01); say so next to each period. */
function reportRecommendationBasis(recommendation) {
  const e = recommendation?.evidence ?? {};
  return recommendation?.basis === 'entity_window' && e.date_from
    ? `<small class="recommendation-as-of">${esc(uiText('Based on the whole window: {from} – {to}', {from: reportDay(e.date_from), to: reportDay(e.date_to)}))}</small>`
    : '';
}
/** Omitted values keep their zero qualifier. */
const reportOmittedNote = '* The platform omitted this value; it counts as 0.';
function reportOmittedMarker(row, key) {
  return row.omitted_as_zero?.includes(key)
    ? `<abbr class="metric-qualifier" title="${esc(uiText(reportOmittedNote))}">*</abbr>`
    : '';
}
/**
 * RPT-05: one precision-preserving format. Currency values use the currency's own minor units (KWD 3, JPY 0), exact
 * decimal strings keep every digit, and ROAS reads as a multiple (×).
 */
const metricFormat = (key, n, currency) => {
  if (n == null) return '—';
  if (typeof n !== 'number' && typeof n !== 'string') return String(n);
  const m =
    overviewState.bootstrap.metrics[key] ??
    (overviewState.report?.config.custom_metrics ?? overviewState.custom).find(m => m.id === key) ??
    {};
  if (m.format === 'currency' && currency) return uiDecimal(n, {currency});
  const text = uiDecimal(n, {maximumFractionDigits: m.format === 'number' ? 0 : 2});
  return text + (m.format === 'percent' ? '%' : key === 'roas' ? '×' : '');
};
/** A row's metric: its exact native decimal total when one was retained (detailed rows), otherwise its value. */
const metricValue = (row, key) => (row.entity_level ? row.native?.exact_totals?.[key] : undefined) ?? row.metrics[key];
/**
 * A metric cell: the formatted value, with the exact retained value on hover when formatting shortened it. `label`
 * names the column on phones, where each row reads as a card (RPT-05).
 */
function metricCell(row, key, label) {
  const value = metricValue(row, key),
    text = metricFormat(key, value, row.currency);
  return `<td${label === undefined ? '' : ` role="cell" data-label="${esc(label)}"`}${value != null && String(value) !== text ? ` title="${esc(String(value))}"` : ''}>${esc(text)}${reportOmittedMarker(row, key)}</td>`;
}
/** RPT-05: a row header names its entity in at most this many characters, so screen readers repeat a short name. */
const reportRowHeaderLimit = 40;
function reportShortName(name) {
  const chars = Array.from(String(name ?? ''));
  return chars.length > reportRowHeaderLimit ? chars.slice(0, reportRowHeaderLimit - 1).join('') + '…' : chars.join('');
}
/** A metric's column label: AMCP's label, the custom metric's own label, or its identifier. */
function reportMetricLabel(r, b, key) {
  return b.metrics[key]
    ? uiText(b.metrics[key].label)
    : (r.config.custom_metrics.find(m => m.id === key)?.label ?? pretty(key));
}
/**
 * RPT-05: the results table. The sticky row header holds only the entity name (at most 40 characters); the full name,
 * IDs, parents, account, time zone and source details sit in the context cell next to it. Daily grain has one Date
 * column. Below 600 px each row reads as a card; explicit table roles keep the semantics when CSS changes the display.
 */
function renderReportTable(r, keys, b) {
  const grain = r.config.grain ?? 'total',
    period = grain === 'daily' ? uiText('Date') : grain !== 'total' ? uiText('Period') : null,
    context = uiText('Platform · objective'),
    next = uiText('Recommended next move'),
    labels = Object.fromEntries(keys.map(k => [k, reportMetricLabel(r, b, k)]));
  const row = row => {
    const name = String(row.entity_name ?? row.campaign_name ?? row.entity_id ?? row.campaign_id ?? ''),
      short = reportShortName(name),
      day = grain === 'daily' && row.date_from === row.date_to;
    return `<tr role="row"><th scope="row" role="rowheader"><strong dir="auto" data-native${short === name ? '' : ` title="${esc(name)}"`}>${esc(short)}</strong></th><td role="cell" class="report-row-context" data-label="${esc(context)}"><span>${esc(b.platforms.find(p => p.id === row.platform)?.name ?? row.platform)}</span><small>${esc(reportLabel(reportRowObjective(row).group))}</small>${reportRowObjective(row).source ? html`<small>${reportObjectiveSource(row)}</small>` : ''}<small>${short === name ? '' : `<span dir="auto" data-native>${esc(name)}</span><br>`}${esc(row.entity_id ?? row.campaign_id)}<br>${row.entity_level ? esc(uiText('Reporting level: {level}', {level: reportLevelLabel(b, row)})) + '<br>' : ''}${row.parent_ids?.campaign_id ? esc(uiText('Campaign: {id}', {id: row.parent_ids.campaign_id})) + reportParentName(row.parent_ids.campaign_name) + '<br>' : ''}${row.parent_ids?.adset_id ? esc(uiText('Ad set / ad group: {id}', {id: row.parent_ids.adset_id})) + reportParentName(row.parent_ids.adset_name) + '<br>' : ''}${esc(row.account_id)} · ${esc(row.currency ?? '—')}${row.timezone ? ' · ' + esc(row.timezone) : ''}</small><details><summary>${esc(uiText('Source details'))}</summary><p>${esc(row.platform === 'linkedin' ? uiText(row.result_definition) : row.result_definition)}<br>${esc(row.attribution)}<br>${esc(row.timezone)}</p>${html`${reportObjectiveResults(row)}`}${reportQualityDetails(row)}<pre>${esc(JSON.stringify(row.native, null, 2))}</pre></details></td>${period ? `<td role="cell" data-label="${esc(period)}">${esc(reportDay(row.date_from))}${day ? '' : '<br>' + esc(reportDay(row.date_to))}</td>` : ''}${keys.map(k => metricCell(row, k, labels[k])).join('')}<td role="cell" class="recommendation" data-label="${esc(next)}"><span class="recommendation-pill decision-${row.recommendation.decision}">${esc(reportLabel(row.recommendation.decision))}</span><p>${esc(uiRecommendationReason(row.recommendation))}</p>${reportRecommendationAsOf(row)}${reportRecommendationBasis(row.recommendation)}${row.recommendation.evidence?.target ? `<small>${esc(uiText('{kpi} target {target} · actual {actual}', {kpi: row.recommendation.evidence.kpi, target: row.recommendation.evidence.target, actual: Number(row.recommendation.evidence.actual).toFixed(2)}))}</small>` : ''}</td></tr>`;
  };
  return `<table class="report-table report-rows-table" role="table"><caption>${uiBidi(overviewLabel(r.config))} · ${esc(reportWindowLabel(r.config.date_range))} · ${esc(uiText('{grain} grouping', {grain: reportLabel(grain)}))}</caption><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">${esc(uiText('Campaign / ad set / ad / resource'))}</th><th scope="col" role="columnheader">${esc(context)}</th>${period ? `<th scope="col" role="columnheader">${esc(period)}</th>` : ''}${keys.map(k => `<th scope="col" role="columnheader">${esc(labels[k])}</th>`).join('')}<th scope="col" role="columnheader">${esc(next)}</th></tr></thead><tbody role="rowgroup">${r.rows.map(row).join('')}</tbody></table>`;
}
/**
 * A delivery failure in the interface language (EXP-04 A). AMCP's own message goes through errorMessage, so a
 * catalogued message is translated and keeps its next step and request reference; a provider's message stays literal.
 */
const deliveryErrorText = e => {
  const owned = uiOwnedError(e);
  if ((e?.provider && typeof e.provider === 'object') || typeof errorMessage !== 'function')
    return [owned.message, owned.nextAction, e?.requestId ? uiText('Reference: {id}', {id: e.requestId}) : '']
      .filter(Boolean)
      .join(' ');
  return errorMessage(e);
};
/**
 * The report builder's Pull and Save (WEB-03): a refusal is shown next to the run bar, not at the top of a long page,
 * and takes focus so it is in view and read out. Its message, what to do and the reference each start a new line.
 */
function reportRunBind(selector, fn) {
  authBind(selector, async (el, event) => {
    const generation = navigationGeneration,
      identity = identityGeneration,
      alert = $('#report-run-error');
    if (alert) {
      alert.hidden = true;
      alert.textContent = '';
    }
    try {
      await fn(el, event);
    } catch (error) {
      const text = alert?.isConnected ? errorLines(error) : '';
      // An obsolete view or a superseded request stays silent; without the slot the shared handler shows it.
      if (generation !== navigationGeneration || identity !== identityGeneration) return;
      if (!text) throw error;
      alert.textContent = text;
      alert.hidden = false;
      alert.focus();
      alert.scrollIntoView?.({block: 'nearest'});
    }
  });
}
/** What stops a Pull before anything is sent (WEB-03): no account chosen, or a custom range that ends before it starts. */
function reportRunPreflight() {
  if (!document.querySelectorAll('[data-report-account]:checked').length)
    return uiText('Choose at least one account above, then pull the report.');
  const mode = $('#report-range-mode')?.value,
    since = $('[name="since"]')?.value,
    until = $('[name="until"]')?.value;
  if (mode === 'custom' && since && until && since > until)
    return uiText('The start date is after the end date. Correct the dates, then pull the report.');
  return '';
}
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
        deliveryStatusShow(deliveryErrorText(e), 'error');
    }
  });
}
let deliveryTimer;
async function openReportDelivery(mode = 'delivery') {
  const generation = navigationGeneration,
    identity = identityGeneration,
    load = overviewState.loadSequence,
    report = overviewState.report,
    selection = overviewState.selection;
  await Promise.all([loadPageAsset('report-delivery.js'), uiNeedChunks(['report-delivery'])]);
  // A language change during the script download may need the newly selected language's chunk.
  await uiNeedChunks(['report-delivery']);
  if (
    generation === navigationGeneration &&
    identity === identityGeneration &&
    load === overviewState.loadSequence &&
    report === overviewState.report &&
    selection === overviewState.selection
  )
    return renderReportDelivery(mode);
}
async function pollDelivery(id, previous = '') {
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
    const outcome = r.outcome ?? r.state,
      tone =
        outcome === 'complete'
          ? 'success'
          : ['failed', 'cancelled'].includes(outcome)
            ? 'error'
            : ['superseded', 'skipped'].includes(outcome)
              ? 'warning'
              : 'info';
    // EXP-03 A: a finished job that wrote nothing is never shown as Complete. EXP-04 A: a finished Sheets export
    // states its receipt; a failure reads in the interface language with its next step.
    deliveryStatusShow(
      outcome === 'superseded'
        ? `${esc(exportOutcomeMessage(r))} <button class="button small" id="delivery-new-tab">${esc(uiText('Export to a new tab'))}</button>`
        : r.url && outcome === 'complete'
          ? `${esc(deliveryReceipt(r))} <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(uiText('Open Google Sheets ↗'))}</a>`
          : `${esc(reportLabel(outcome))} · ${esc((r.job.error && deliveryErrorText(r.job.error)) || (outcome === 'skipped' && r.message ? uiText(r.message) : uiText('The export is tracked in this report’s delivery history.')))}`,
      tone,
      true,
      outcome !== previous,
    );
    if (r.destination_kind === 'report_files' && r.files?.length) $('#delivery-status').innerHTML += reportFileLinks(r);
    deliveryBind('#delivery-new-tab', async () => {
      const alternatives = $('#report-delivery-dialog .delivery-alternatives');
      if (!alternatives) return;
      alternatives.open = true;
      alternatives.querySelector('input:not([type=hidden]), select')?.focus();
    });
    if (['queued', 'running'].includes(r.state)) deliveryTimer = setTimeout(() => void pollDelivery(id, outcome), 3000);
    else if (['failed', 'cancelled'].includes(r.state) && (r.retry_available ?? r.job.retry_available) !== false) {
      $('#delivery-status').innerHTML +=
        `<button class="button small" id="delivery-retry">${esc(uiText('Retry export'))}</button>`;
      deliveryBind('#delivery-retry', async () => {
        await overviewCall({action: 'retry', id: r.job.id, confirmed: true});
        await pollDelivery(id);
      });
    }
  } catch (e) {
    if (current()) deliveryStatusShow(deliveryErrorText(e), 'error');
  }
}
function overviewConfig() {
  const form = $('#overview-config'),
    data = new FormData(form),
    b = overviewState.bootstrap,
    sources = [...document.querySelectorAll('[data-report-account]:checked')].map(el => {
      const [platform, connection_id, account_id] = JSON.parse(el.value),
        previous = overviewState.config?.sources.find(
          source =>
            source.platform === platform && source.connection_id === connection_id && source.account_id === account_id,
        ),
        selectedNative = $('[data-native-for="' + CSS.escape(platform) + '"]')
          .value.split(/[ ,\n]+/)
          .filter(Boolean),
        initialNative =
          overviewState.config?.sources.find(source => source.platform === platform)?.native_metrics ??
          overviewState.config?.source_defaults?.[platform]?.native_metrics ??
          [],
        native_metrics =
          previous && JSON.stringify(selectedNative) === JSON.stringify(initialNative)
            ? (previous.native_metrics ?? [])
            : selectedNative;
      const detail = overviewGranularityConfig(platform, el.value, previous);
      return {
        platform,
        connection_id,
        account_id,
        ...reportObjectiveFields(platform, previous),
        ...(previous?.objective_overrides !== undefined ? {objective_overrides: previous.objective_overrides} : {}),
        native_metrics,
        ...detail,
      };
    }),
    metrics = [...document.querySelectorAll('[data-report-metric]:checked')].map(el => el.value),
    targets = {},
    previous = overviewState.config?.targets ?? {};
  // DEC-01: campaign targets set through MCP have no card here; a website save keeps them unchanged.
  for (const [key, target] of Object.entries(previous))
    if (!Object.hasOwn(reportDefaultKpi, key) && !reportCurrencyTargetObjective(key)) targets[key] = target;
  const rules = (objective, key) => {
    const kpi = $('[data-target-kpi="' + objective + '"]').value;
    return {
      ...reportTargetExtras(previous[key], objective, kpi),
      context: readTargetContext(objective),
      kpi,
      minimum_results: Number($('[data-target-sample="' + objective + '"]').value),
      conversion_lag_days: Number($('[data-target-lag="' + objective + '"]').value),
    };
  };
  for (const el of document.querySelectorAll('[data-objective-target]')) {
    if (!el.value) continue;
    const objective = el.dataset.objectiveTarget;
    targets[objective] = {
      ...rules(objective, objective),
      target: Number(el.value),
      currency: $('[data-target-currency="' + objective + '"]').value.toUpperCase(),
    };
  }
  // DEC-01: each other-currency row becomes an "objective:CURRENCY" target with its card's rules.
  for (const el of document.querySelectorAll('[data-currency-target-value]')) {
    if (!el.value) continue;
    const row = el.dataset.currencyTargetValue,
      objective = row.slice(0, row.lastIndexOf(':')),
      currency = $('[data-currency-target-currency="' + row + '"]')
        .value.trim()
        .toUpperCase(),
      key = objective + ':' + currency;
    if (Object.hasOwn(targets, key)) throw new Error(uiText('Use each currency once per objective.'));
    targets[key] = {...rules(objective, key), target: Number(el.value), currency};
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
        if (
          !sources.some(source => source.platform === p.id) &&
          !Object.hasOwn(overviewState.config?.source_defaults ?? {}, p.id) &&
          overviewState.selection?.kind !== 'template'
        )
          return [p.id, {}];
        const native_metrics = $('[data-native-for="' + CSS.escape(p.id) + '"]')
          .value.split(/[ ,\n]+/)
          .filter(Boolean);
        return [
          p.id,
          {
            ...reportObjectiveFields(
              p.id,
              overviewState.config?.sources.find(source => source.platform === p.id) ??
                overviewState.config?.source_defaults?.[p.id],
            ),
            ...(native_metrics.length ? {native_metrics} : {}),
            ...Object.fromEntries(
              Object.entries(
                sources.find(source => source.platform === p.id) ?? overviewGranularityConfig(p.id),
              ).filter(([key]) => ['level', 'levels', 'report_options', 'statuses', 'delivered_only'].includes(key)),
            ),
          },
        ];
      })
      .filter(([, v]) => Object.keys(v).length),
  );
  return {
    contract_version: 'overview-config-v4',
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
// Labels for base metrics.
const metricAggregations = {
  sum: 'Summed',
  non_additive: 'Not summed',
  'native field': 'Native field',
  result_definition: 'By result definition',
  result_ratio: 'Native cost or paired ratio',
};
async function renderReportingOverview() {
  if (!session.authenticated) {
    showLogin();
    return;
  }
  if (typeof overviewGranularityFields !== 'function') {
    const generation = navigationGeneration,
      identity = identityGeneration;
    await Promise.all([loadPageAsset('report-source-settings.js'), uiNeedChunks(['report-source-settings'])]);
    if (generation !== navigationGeneration || identity !== identityGeneration) return;
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
  content.innerHTML = `<div class="report-heading"><div><span class="eyebrow">${esc(uiText('THE BIG PICTURE, WITH THE DETAILS'))}</span><h1>${esc(uiText('Report builder'))}<span class="report-spark" aria-hidden="true">✳</span></h1><p>${esc(uiText('Campaigns, ad sets and ads in one report. Every number keeps its source and measurement context.'))}</p></div><div class="report-actions"><button id="overview-delivery" class="button">${glyph('connection')} ${esc(uiText('Sheets & schedules'))}</button></div></div><p id="auth-error" class="error" role="alert"></p>${renderOverviewLibrary(b, viewer)}<form id="overview-config"><section class="report-control-panel">${renderReportSetupFields(c)}<datalist id="report-timezones">${['Africa/Cairo', 'Asia/Riyadh', 'Asia/Dubai', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'UTC'].map(v => `<option value="${v}">`).join('')}</datalist><h2 class="report-section-label"><span>01</span><strong>${esc(uiText('Platforms & accounts'))}</strong><small>${esc(uiText('Choose any combination. Each account keeps its own currency and reporting timezone.'))}</small></h2>${renderUnavailableReportSources(c, b)}<div class="report-platforms">${b.platforms
    .map(p => {
      const config = c.sources.find(s => s.platform === p.id) ?? c.source_defaults?.[p.id],
        // The working client narrows the accounts offered (SEC-08); an account the report already uses stays shown,
        // so editing a saved report never drops a source silently.
        accounts = p.accounts.filter(
          a =>
            selected.has(JSON.stringify([p.id, a.connection_id, a.account_id])) ||
            typeof inWorkingClient !== 'function' ||
            inWorkingClient(p.gateway, a.account_id, a.connection_id),
        );
      return `<details class="report-platform" ${config ? 'open' : ''}><summary><span class="report-platform-dot platform-${p.id}">${esc(p.name.slice(0, 1))}</span><strong>${esc(p.name)}</strong><small>${esc(uiText(accounts.length === 1 ? '{count} account' : '{count} accounts', {count: accounts.length}))}</small></summary><div class="report-platform-body">${
        accounts.length
          ? `<label class="check"><input type="checkbox" data-report-all="${p.id}"> ${esc(uiText('Select all {platform} accounts', {platform: p.name}))}</label>${accounts
              .map(a => {
                const key = JSON.stringify([p.id, a.connection_id, a.account_id]),
                  source =
                    c.sources.find(
                      s => s.platform === p.id && s.connection_id === a.connection_id && s.account_id === a.account_id,
                    ) ??
                    c.source_defaults?.[p.id] ??
                    {};
                // The account and login names are the provider's and the person's own; they keep their direction.
                return `<label class="report-account"><input type="checkbox" data-report-account="${p.id}" value="${esc(key)}" ${selected.has(key) ? 'checked' : ''}><span><bdi dir="auto" data-native>${esc(a.label)}</bdi><small>${esc(a.account_id)}</small><small>${esc(uiText('Login:'))} <bdi dir="auto" data-native>${esc(a.connection_label ?? a.label)}</bdi></small></span></label>${overviewState.selection?.kind === 'template' ? '' : html`${overviewAccountFields(p, source, key, selected.has(key), a)}`}`;
              })
              .join('')}`
          : p.accounts.length
            ? `<p class="muted">${esc(uiText('The working client has no {platform} account.', {platform: p.name}))}</p>`
            : `<p class="muted">${esc(uiText('Connect and select an account to include {platform}.', {platform: p.name}))}</p><a href="/connections" class="text-link">${esc(uiText('Manage connections'))}</a>`
      }${overviewState.selection?.kind === 'template' ? html`<fieldset data-report-defaults="${p.id}"><legend>${uiText('Template report settings')}</legend>${overviewGranularityFields(p, config)}</fieldset>` : ''}${reportObjectiveSelect(p.id, config, b.objective_fallback_groups ?? objectives)}<details class="native-settings"><summary>${esc(uiText('Additional native metrics'))}</summary><p>${esc(uiText('Request provider metric names. Availability and compatible combinations vary by account.'))}</p><textarea data-native-for="${p.id}" rows="2" aria-label="${esc(uiText('{platform} native metric names', {platform: p.name}))}" placeholder="${esc(p.native_metrics.slice(0, 3).join(', '))}">${esc(config?.native_metrics?.join(', ') ?? '')}</textarea><small>${esc(uiText('Examples:'))} ${esc(p.native_metrics.join(', ') || uiText('The endpoint returns its native columns automatically.'))}</small>${html`${overviewNativeNote(p.id)}`}</details></div></details>`;
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
        // A formula is written in metric identifiers (spend / clicks), read left to right in either language.
        `<label><input type="checkbox" data-report-metric value="${id}" ${c.metrics.includes(id) ? 'checked' : ''}><span>${esc(b.metrics[id] ? uiText(m.label) : m.label)}<small class="metric-formula"${m.formula ? ' dir="ltr"' : ''}>${esc(m.formula ?? uiText(metricAggregations[m.aggregation] ?? m.aggregation))}</small></span></label>`,
    )
    .join(
      '',
    )}</div></div></div><div class="custom-metric-heading"><div><h3>${esc(uiText('Your metrics'))}</h3><p>${esc(uiText('Calculate with metric names, numbers, parentheses and + − × /. Missing data and division by zero stay blank.'))}</p></div><button type="button" class="button" id="custom-metric-add">${esc(uiText('+ Create metric'))}</button></div><datalist id="native-field-list">${[...Object.keys(b.metrics), ...(overviewState.report?.native_metrics ?? [])].map(id => `<option value="${esc(id)}">`).join('')}</datalist><div id="custom-metric-list"></div><div id="custom-metric-editor" hidden><div class="custom-metric-fields"><label>${esc(uiText('Label'))}<input id="custom-label" placeholder="${esc(uiText('Cost per engaged session'))}" maxlength="80"></label><label>${esc(uiText('Identifier'))}<input id="custom-id" placeholder="cost_per_engaged_session" pattern="[a-z][a-z0-9_]*"></label><label>${esc(uiText('Formula'))}<input id="custom-formula" placeholder="spend / sessions" maxlength="500" list="native-field-list"></label><label>${esc(uiText('Format'))}<select id="custom-format"><option value="decimal">${esc(uiText('Decimal'))}</option><option value="currency">${esc(uiText('Currency'))}</option><option value="percent">${esc(uiText('Percent'))}</option><option value="number">${esc(uiText('Number'))}</option></select></label><button type="button" class="button primary" id="custom-metric-save">${esc(uiText('Add metric'))}</button></div></div></details><details class="report-options"><summary><h2 class="report-section-label"><span>03</span><strong>${esc(uiText('Performance targets & recommendation rules'))}</strong><small>${esc(uiText('Targets unlock objective-aware guidance.'))}</small></h2></summary><p class="muted">${esc(uiText('A recommendation compares results with your target after checking completeness, currency, attribution and sample size. AMCP never changes campaign budgets from this report.'))}</p><div class="target-grid">${objectives
    .map(o => {
      const t = c.targets[o] ?? {},
        kpi = reportDefaultKpi[o];
      return `<div class="target-card"><h3>${esc(reportLabel(o))}</h3><div class="target-fields"><label>KPI<select data-target-kpi="${o}">${[...new Set([kpi, 'roas', 'cpa', 'cpc', 'cpm', 'cpl', 'cpi', 'cpv'])].map(k => `<option value="${k}" ${(t.kpi ?? kpi) === k ? 'selected' : ''}>${k.toUpperCase()}</option>`).join('')}</select><small class="form-note" data-target-direction="${o}">${esc(reportTargetDirection(t.kpi ?? kpi, t.direction))}</small></label><label>${esc(uiText('Target'))}<input type="number" step="any" min="0.000001" data-objective-target="${o}" value="${t.target ?? ''}" placeholder="${esc(uiText('Set target'))}"></label><label>${esc(uiText('Currency'))}<input data-target-currency="${o}" value="${esc(t.currency ?? '')}" maxlength="3" pattern="[A-Z]{3}" aria-label="${esc(uiText('{objective} target currency', {objective: reportLabel(o)}))}"></label><label>${esc(uiText('Min. results'))}<input data-target-sample="${o}" type="number" min="1" value="${t.minimum_results ?? (o === 'awareness' ? 1000 : ['sales', 'leads', 'app_installs'].includes(o) ? 10 : 30)}"></label><label>${esc(uiText('Conversion lag, days'))}<input data-target-lag="${o}" type="number" min="0" max="90" value="${t.conversion_lag_days ?? 3}"></label></div>${reportCurrencyTargets(o, c.targets)}${reportTargetContext(o, t.context)}</div>`;
    })
    .join(
      '',
    )}</div></details><label class="report-delivery-policy">${esc(uiText('Sheets delivery policy'))}<select name="partial_delivery"><option value="allow_marked" ${c.partial_delivery !== 'complete_only' ? 'selected' : ''}>${esc(uiText('Allow clearly marked partial reports'))}</option><option value="complete_only" ${c.partial_delivery === 'complete_only' ? 'selected' : ''}>${esc(uiText('Deliver complete reports only'))}</option></select></label><p id="report-run-error" class="error report-run-error" role="alert" tabindex="-1" hidden></p><div class="report-runbar"><span id="report-selected-count" class="muted">${esc(uiText('Choose your accounts above.'))}</span><label class="check"><input type="checkbox" id="overview-compare-previous"> ${esc(uiText('Also collect the previous equal window to compare'))}</label><div><button type="button" id="overview-save" class="button" ${viewer ? 'disabled' : ''}>${overviewState.selection?.kind === 'template' ? uiText('Save template') : overviewState.selection ? uiText('Save changes') : uiText('Save report')}</button><button type="submit" class="button primary" ${viewer ? 'disabled' : ''}>${glyph('report')} ${esc(uiText('Pull report'))}</button></div></div></section></form><section id="overview-results"></section><section class="panel report-history">${renderOverviewHistory(history.reports, viewer)}</section><dialog id="report-delivery-dialog" class="report-delivery-dialog" aria-label="${esc(uiText('Report delivery'))}"><div id="report-delivery-content"></div></dialog>`;
  bindReportDates();
  // DEC-01: the target card shows the direction derived for the selected KPI.
  document.querySelectorAll('[data-target-kpi]').forEach(el =>
    el.addEventListener('change', () => {
      const note = $('[data-target-direction="' + el.dataset.targetKpi + '"]');
      if (note) note.textContent = reportTargetDirection(el.value);
    }),
  );
  // DEC-01: add or remove a target for accounts in another currency; the form's change event saves the draft.
  document.querySelectorAll('[data-currency-target-add]').forEach(button =>
    button.addEventListener('click', () => {
      const objective = button.dataset.currencyTargetAdd;
      $('[data-currency-targets="' + objective + '"]').insertAdjacentHTML(
        'beforeend',
        reportCurrencyTargetRow(objective),
      );
      $('[data-currency-targets="' + objective + '"] .target-currency-row:last-child input')?.focus();
    }),
  );
  $('.target-grid')?.addEventListener('click', event => {
    const button = event.target.closest?.('[data-currency-target-remove]');
    if (!button) return;
    button.closest('.target-currency-row')?.remove();
    $('#overview-config').dispatchEvent(new Event('change'));
  });
  document.querySelectorAll('[data-report-all]').forEach(el =>
    el.addEventListener('change', () => {
      document
        .querySelectorAll('[data-report-account="' + el.dataset.reportAll + '"]')
        .forEach(c => (c.checked = el.checked));
      count();
      updateOverviewGranularity();
    }),
  );
  const count = () => {
    $('#report-selected-count').textContent = (n =>
      uiText(n === 1 ? '{count} account selected' : '{count} accounts selected', {count: n}))(
      document.querySelectorAll('[data-report-account]:checked').length,
    );
  };
  document.querySelectorAll('[data-report-account]').forEach(el => el.addEventListener('change', count));
  for (const control of document.querySelectorAll(
    '[data-report-level], [data-report-account], [data-report-campaign-profile]',
  ))
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
  reportRunBind('#overview-config', async () => {
    if (overviewState.selection?.kind === 'template')
      throw new Error(uiText('Create a report from this template and choose its client accounts first.'));
    const blocked = reportRunPreflight();
    if (blocked) throw new Error(blocked);
    const selection = overviewState.selection,
      saved = selection?.kind === 'view' && !overviewState.dirty;
    overviewState.config = overviewConfig();
    // RPT-07: the previous equal window is a second, linked snapshot with its own collection limits.
    const run = await overviewCall({
      action: 'run',
      ...(saved ? {id: selection.id} : {config: overviewState.config}),
      confirmed: true,
      ...($('#overview-compare-previous')?.checked ? {compare: 'previous_period'} : {}),
    });
    if (saved && overviewState.selection === selection && run.view_revision !== undefined)
      selection.revision = run.view_revision;
    overviewState.page = 0;
    await loadOverviewReport(run.id);
  });
  reportRunBind('#overview-save', async () => saveOverviewDefinition());
  // Editing the setup clears a refusal shown at the run bar (WEB-03).
  for (const type of ['input', 'change'])
    $('#overview-config').addEventListener(type, () => {
      const alert = $('#report-run-error');
      if (alert && !alert.hidden) {
        alert.hidden = true;
        alert.textContent = '';
      }
    });
  bindOverviewLibrary();
  authBind('#overview-delivery', async () => {
    if (overviewState.selection?.kind === 'template')
      throw new Error(uiText('Create a report from this template before choosing its destination and schedule.'));
    overviewState.config = overviewConfig();
    await openReportDelivery();
  });
  const snapshotId = link.get('report_id');
  if (snapshotId && overviewState.report?.id !== snapshotId) {
    await loadOverviewReport(snapshotId, 0);
    const result = $('#overview-results');
    result?.setAttribute('tabindex', '-1');
    result?.scrollIntoView({block: 'start'});
    result?.focus({preventScroll: true});
  } else if (overviewState.report) await loadOverviewReport(overviewState.report.id);
  if (link.get('delivery') === '1') await openReportDelivery();
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
  const r = await overviewCall({
    action: 'get',
    id,
    offset: page * 100,
    limit: 100,
    include: {native: true, lineage: true},
  });
  if (location.pathname !== '/reporting-overview' || sequence !== overviewState.loadSequence) return;
  overviewState.report = r;
  overviewState.page = page;
  if (overviewState.watch?.id !== id) overviewState.watch = {id, since: Date.now()};
  refreshRecentReports(r);
  reportUrlState(r.id);
  const active = ['queued', 'running'].includes(r.job.state),
    waiting = active || (r.exports ?? []).some(e => ['queued', 'running'].includes(e.state)),
    pollDelay = waiting ? reportPollDelay(Date.now() - overviewState.watch.since) : null,
    exportable = ['complete', 'partial'].includes(r.state) && r.row_count > 0,
    keys = [...new Set([...r.config.metrics, ...r.config.custom_metrics.map(m => m.id)])],
    b = overviewState.bootstrap,
    root = $('#overview-results');
  root.innerHTML = `<div class="report-results-heading"><div><span class="eyebrow">${esc(reportRangeLabel(r.config.date_range))}</span><h2 dir="auto" data-native>${esc(r.config.name)}</h2><p class="muted">${active ? reportLabel(r.job.state) : reportDisplayState(r)} · ${esc(uiPlural(r.row_count, '{count} entity/resource row', '{count} entity/resource rows'))} · ${date(r.completed_at ?? r.created_at)}</p></div><div class="report-actions">${active ? `<button class="button" id="report-cancel">${esc(uiText('Cancel run'))}</button>` : exportable ? `${typeof session === 'undefined' || session?.downloadsAllowed !== false ? `<a class="button" href="/api/reporting-overview/${encodeURIComponent(r.id)}.csv" download="AMCP-report.csv">${esc(uiText('Download CSV'))}</a><a class="button" href="/api/reporting-overview/${encodeURIComponent(r.id)}.metadata.json" download="AMCP-report-evidence.json">${esc(uiText('Download source evidence'))}</a>` : ''}<button class="button primary" id="report-export" ${r.rows.length ? '' : 'disabled'}>${esc(uiText('Export now to Google Sheets ↗'))}</button>` : ''}${['failed', 'cancelled'].includes(r.job.state) && r.job.retry_available !== false ? `<button class="button" id="report-retry">${esc(uiText('Retry failed run'))}</button>` : ''}</div></div>${renderReportStatusStrip(r, b.platforms)}${active ? `<div class="report-progress" role="status"><span class="live-dot"></span><div><strong>${r.job.attempts > 1 ? uiText('Retrying the interrupted source') : uiText('Collecting native entity reports')}</strong><p>${esc(uiText('Completed sources are retained. You can leave this page and return to this report.'))}</p></div><span>${esc(uiText('Attempt'))} ${r.job.attempts || 1}</span></div>${renderReportWait(r)}` : ''}${waiting && pollDelay === null ? `<div class="notice report-refresh"><p>${esc(uiText('Automatic refresh stopped after 30 minutes. Completed sources are retained.'))}</p><button type="button" class="button small" id="report-refresh">${esc(uiText('Refresh'))}</button></div>` : ''}${r.job.error ? `<div class="notice"><strong>${esc(r.job.error.code)}</strong><p>${esc(uiOwnedError(r.job.error).message)}${active ? ' ' + esc(uiText('Next attempt: {date}', {date: date(r.job.available_at)})) : ''}</p></div>` : ''}${html`${reportNotices(r)}`}${renderReportSummary(r)}${html`${renderReportLevelCheck(r)}`}${renderMetricSources(r, keys, b)}<div class="report-source-health">${(r.sources ?? []).map((s, i) => renderReportSourceHealth(s, b.platforms, i, r.config.date_range, r)).join('')}</div>${!active && r.rows.length ? `<div class="report-table-wrap" role="region" tabindex="0" aria-label="${esc(uiText('Report rows (scrolls sideways)'))}">${renderReportTable(r, keys, b)}</div><div class="report-pagination"><span>${esc(uiText('Rows {start}–{end} of {total}. A dash means unavailable.', {start: r.offset + 1, end: r.offset + r.rows.length, total: r.row_count}))}${r.rows.some(row => row.omitted_as_zero?.length) ? ' ' + esc(uiText(reportOmittedNote)) : ''}</span><div><button id="report-prev" class="button small" ${r.offset ? '' : 'disabled'}>${esc(uiText('← Previous'))}</button><button id="report-next" class="button small" ${r.has_more ? '' : 'disabled'}>${esc(uiText('Next →'))}</button></div></div><details class="panel"><summary>${esc(uiText('Native fields available for custom metrics'))}</summary><p>${esc(uiText('Use these exact identifiers in a formula. Fields from other platforms are blank for this row.'))}</p><div class="native-field-tags">${(r.native_metrics ?? []).map(n => `<code>${esc(n)}</code>`).join('')}</div></details>` : !active ? renderReportEmpty(r) : ''}${renderSheetsDeliveryRecovery(r)}${renderExportHistory(r)}${['skipped', 'failed'].includes(r.export?.state) ? `<p class="notice">${esc(uiOwnedError(r.export).message)}</p>` : ''}${r.export?.url ? `<p class="notice">${esc(uiText('Scheduled export complete.'))} <a href="${esc(r.export.url)}" target="_blank" rel="noopener">${esc(uiText('Open Google Sheets ↗'))}</a></p>` : ''}`;
  bindSnapshotAnalysis(r, root);
  bindSheetsDeliveryRecovery(id);
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
  authBind('[data-report-retry]', retryReportRun);
  authBind('#report-cancel', async () => {
    await overviewCall({action: 'cancel', id: r.job_id, confirmed: true});
    overviewState.watch = null;
    await loadOverviewReport(id);
  });
  authBind('#report-retry', async () => {
    await overviewCall({action: 'retry', id: r.job_id, confirmed: true});
    overviewState.watch = null;
    await loadOverviewReport(id);
  });
  authBind('#report-refresh', async () => {
    overviewState.watch = null;
    await loadOverviewReport(id);
  });
  authBind('#report-export', async () => {
    await openReportDelivery('sheets_now');
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
  if (pollDelay !== null)
    pollTimer = setTimeout(() => {
      void loadOverviewReport(id).catch(e => toast(errorMessage(e)));
    }, pollDelay);
}
/**
 * RPT-05: an open snapshot is URL-addressable (`?report_id=`, with the saved report's `view_id`). The ID is opaque;
 * reopening it runs the same tenant and actor authorization as any other load.
 */
function reportUrlState(id) {
  if (typeof history === 'undefined' || location.pathname !== '/reporting-overview') return;
  if (new URLSearchParams(location.search ?? '').get('report_id') === id) return;
  const query = new URLSearchParams();
  if (overviewState.selection?.kind === 'view') query.set('view_id', overviewState.selection.id);
  query.set('report_id', id);
  history.replaceState(history.state ?? {}, '', '/reporting-overview?' + query);
}
/** RPT-05: poll every 3 s for the first minute, every 15 s up to 5 minutes, then every 60 s; stop after 30 minutes. */
function reportPollDelay(elapsed) {
  return elapsed < 60000 ? 3000 : elapsed < 300000 ? 15000 : elapsed < 1800000 ? 60000 : null;
}
/** Waiting time in the interface language: minutes below an hour, then hours and minutes. */
function reportElapsed(ms) {
  const minutes = Math.floor(Math.max(0, Number(ms) || 0) / 60000),
    hours = Math.floor(minutes / 60),
    rest = minutes % 60;
  if (minutes < 1) return uiText('less than a minute');
  if (!hours) return uiPlural(minutes, '{count} minute', '{count} minutes');
  return uiText('{hours} h {minutes} min', {hours: uiNumber(hours), minutes: uiNumber(rest)});
}
/** A queued run waits this long before AMCP says it has not started. */
const reportStallMs = 10 * 60000;
/**
 * RPT-05 stall signal: how long an active run has been queued, and a notice when no worker has started it after the
 * threshold or no worker has reported recently. Owners get a link to worker health.
 */
function renderReportWait(r) {
  const j = r.job ?? {};
  if (typeof j.queued_ms !== 'number') return '';
  const waitingForStart = j.state === 'queued' && !j.started_at,
    stalled = j.worker_recent === false || (waitingForStart && j.queued_ms >= reportStallMs);
  const health =
    typeof session !== 'undefined' && session?.workspaceRole === 'owner'
      ? `<a class="button small" href="/settings#owner-worker-health">${esc(uiText('Check worker health'))}</a>`
      : '';
  return (
    (waitingForStart
      ? `<p class="report-queued">${esc(uiText('Queued for {duration}', {duration: reportElapsed(j.queued_ms)}))}</p>`
      : '') +
    (stalled
      ? `<div class="notice report-stall" role="status"><strong>${esc(waitingForStart ? uiText('AMCP has not started this run yet') : uiText('No background worker has reported recently'))}</strong><p>${esc(j.worker_recent === false ? uiText('No background worker has reported in the last few minutes, so collection cannot continue. Completed sources are retained, and the run continues when a worker is available.') : uiText('This run has waited longer than usual for a background worker. It starts when a worker is available; there is no need to pull the report again.'))}</p>${health}</div>`
      : '')
  );
}
/** RPT-05: a partial snapshot says which sources are missing or limited, with links to their source cards. */
function renderReportStatusStrip(r, platforms) {
  const sources = (r.sources ?? []).map((s, i) => [s, i]);
  if (r.state !== 'partial' || !sources.length) return '';
  const failed = sources.filter(([s]) => s.error),
    limited = sources.filter(([s]) => !s.error && !s.complete),
    total = uiNumber(sources.length),
    link = ([s, i], code) =>
      `<a href="#report-source-${i}">${uiBidi((platforms.find(p => p.id === s.source.platform)?.name ?? s.source.platform) + ' · ' + s.source.account_id)}</a>${code ? ` <code>${esc(code)}</code>` : ''}`;
  const lines = [
    failed.length
      ? uiMarkup('{failed} of {total} sources failed: {sources}. Totals exclude them.', {
          failed: uiNumber(failed.length),
          total,
          sources: failed.map(f => link(f, f[0].error.provider?.code ?? f[0].error.code)).join(', '),
        })
      : '',
    limited.length
      ? uiMarkup('{count} of {total} sources have limited coverage: {sources}. Their totals may be incomplete.', {
          count: uiNumber(limited.length),
          total,
          sources: limited.map(l => link(l)).join(', '),
        })
      : '',
  ].filter(Boolean);
  return `<section class="report-status-strip" aria-label="${esc(uiText('Snapshot status'))}"><strong>${esc(reportLabel('partial'))}</strong>${lines.map(line => `<p>${line}</p>`).join('')}</section>`;
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

/** A summary's decision counts, for example "2 Scale · 1 Observe". */
function reportSummaryDecisions(g) {
  return Object.entries(g.decisions ?? {})
    .map(([k, n]) => esc(uiNumber(n) + ' ' + reportLabel(k)))
    .join(' · ');
}
/** RPT-04: how many summed rows count a provider-omitted value as 0, per metric. */
function reportSummaryOmitted(g) {
  return g.omitted_as_zero
    ? `<p class="form-note">${esc(
        uiText('Counted as 0 where the platform omitted the value: {metrics}', {
          metrics: Object.entries(g.omitted_as_zero)
            .map(
              ([k, n]) =>
                (overviewState.bootstrap?.metrics?.[k] ? uiText(overviewState.bootstrap.metrics[k].label) : k) +
                ' (' +
                n +
                ')',
            )
            .join(', '),
        }),
      )}</p>`
    : '';
}
/**
 * RPT-05: a small spend line over the window's periods, oldest first. It is an image with a text summary (lowest and
 * highest period); unknown periods leave a gap rather than reading as zero.
 */
function reportSparkline(g) {
  const series = g.series ?? [],
    known = series.map((p, i) => [p, i]).filter(([p]) => typeof p.spend === 'number' && Number.isFinite(p.spend));
  if (series.length < 2 || known.length < 2) return '';
  const values = known.map(([p]) => p.spend),
    low = known.reduce((a, b) => (b[0].spend < a[0].spend ? b : a))[0],
    high = known.reduce((a, b) => (b[0].spend > a[0].spend ? b : a))[0],
    min = Math.min(...values),
    span = Math.max(...values) - min,
    x = i => ((i / (series.length - 1)) * 200).toFixed(1),
    y = v => (span ? 34 - ((v - min) / span) * 32 : 18).toFixed(1);
  const segments = [];
  let segment = [];
  series.forEach((p, i) => {
    if (typeof p.spend === 'number' && Number.isFinite(p.spend)) segment.push(x(i) + ',' + y(p.spend));
    else if (segment.length) segments.push(segment.splice(0));
  });
  if (segment.length) segments.push(segment);
  const label = uiText('Spend per period from {from} to {to}: lowest {low} ({lowDate}), highest {high} ({highDate}).', {
    from: reportDay(series[0].date_from),
    to: reportDay(series.at(-1).date_from),
    low: metricFormat('spend', low.spend, g.currency),
    lowDate: reportDay(low.date_from),
    high: metricFormat('spend', high.spend, g.currency),
    highDate: reportDay(high.date_from),
  });
  return `<svg class="report-sparkline" viewBox="0 0 200 36" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">${segments
    .map(points =>
      points.length > 1
        ? `<polyline points="${points.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`
        : `<circle cx="${points[0].split(',')[0]}" cy="${points[0].split(',')[1]}" r="1.5" fill="currentColor"/>`,
    )
    .join('')}</svg>`;
}
/** Whole-window cards use report-summary.ts totals and sparklines; periods remain in rows and exports. */
function renderReportWindowSummary(r) {
  const tiles = r.window_summary,
    platforms = overviewState.bootstrap?.platforms ?? [],
    figures = [
      ['spend', uiText('Spend')],
      ['clicks', uiText('Clicks')],
      ['cpc', 'CPC'],
      ['conversions', uiText('Conversions')],
      ['cpa', 'CPA'],
      ['roas', 'ROAS'],
    ],
    tile = g =>
      `<article class="report-summary-card report-window-tile"><small>${esc(platforms.find(p => p.id === g.platform)?.name ?? pretty(g.platform))} · ${esc(g.account_id)} · ${esc(g.currency ?? uiText('Currency unavailable'))}</small><p>${esc(reportDay(g.date_from))} — ${esc(reportDay(g.date_to))} · ${esc(uiPlural(g.period_count, '{count} period', '{count} periods'))}${esc(reportCardLevel(r, g))}</p><h3>${esc(reportLabel(g.objective_group))} <span>${esc(
        g.entity_level
          ? uiPlural(g.entity_count, '{count} entity/resource', '{count} entities/resources')
          : uiPlural(g.entity_count, '{count} campaign', '{count} campaigns'),
      )}</span></h3><div>${html`${figures.map(([key, label]) => reportSummaryFigure(g, key, label))}`}</div>${reportSparkline(g)}<p>${reportSummaryDecisions(g)}</p>${reportSummaryOmitted(g)}${html`${reportSummaryCoverageNotes(g, figures)}`}${reportSummaryCoverage(r, g)}</article>`;
  return (
    `<div class="report-summary-grid">` +
    tiles.slice(0, 12).map(tile).join('') +
    `</div>` +
    reportSummaryExcludes(r) +
    (tiles.length > 12
      ? `<p class="form-note">${esc(uiText('Showing the first 12 account summaries. Every period is in the paginated table, CSV and Sheets export.'))}</p>`
      : '')
  );
}
function renderReportSummary(r) {
  if (Array.isArray(r.window_summary)) return renderReportWindowSummary(r);
  const figures = [
    ['spend', uiText('Spend')],
    ['clicks', uiText('Clicks')],
    ['cpc', 'CPC'],
  ];
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
          esc(reportCardLevel(r, g)) +
          `</p><h3>` +
          esc(reportLabel(g.objective_group)) +
          ` <span>` +
          esc(
            g.entity_level
              ? uiPlural(g.entity_count, '{count} entity/resource row', '{count} entity/resource rows')
              : uiPlural(g.campaign_count, '{count} campaign', '{count} campaigns'),
          ) +
          `</span></h3><div>` +
          html`${figures.map(([key, label]) => reportSummaryFigure(g, key, label))}` +
          `</div><p>` +
          reportSummaryDecisions(g) +
          `</p>` +
          reportSummaryOmitted(g) +
          html`${reportSummaryCoverageNotes(g, figures)}` +
          reportSummaryCoverage(r, g) +
          `</article>`,
      )
      .join('') +
    `</div>` +
    reportSummaryExcludes(r) +
    ((r.summary ?? []).length > 12
      ? `<p class="form-note">${esc(uiText('Showing the first 12 account/period summaries. All rows are available in the paginated table, CSV and Sheets export.'))}</p>`
      : '')
  );
}
/** RPT-05, F-L5-01: a source or a figure with limited coverage. */
function reportSummaryCoverage(r, g) {
  const limited = (r.sources ?? []).some(
    s => !s.error && !s.complete && s.source?.platform === g.platform && s.source?.account_id === g.account_id,
  );
  return limited || g.coverage_notes?.length
    ? `<p class="report-card-footer">${esc(uiText('Limited coverage: these totals may be incomplete.'))}</p>`
    : '';
}
/** RPT-05: summary totals never include a failed source; the footer names each one. */
function reportSummaryExcludes(r) {
  const failed = (r.sources ?? []).filter(s => s.error);
  if (!failed.length || !(r.summary ?? []).length) return '';
  const platforms = overviewState.bootstrap?.platforms ?? [];
  return `<p class="report-summary-excludes">${esc(
    uiText('Excludes: {sources} (source failed).', {
      sources: uiList(
        failed.map(
          s =>
            (platforms.find(p => p.id === s.source.platform)?.name ?? s.source.platform) + ' · ' + s.source.account_id,
        ),
      ),
    }),
  )}</p>`;
}
/** How each platform in the report measures each selected metric, so columns are compared knowingly across platforms. */
function renderMetricSources(r, keys, b) {
  if ((r.config.sources ?? []).some(s => s.level && s.level !== 'campaign') || r.sources?.some(s => s.metric_mapping))
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
        mapping = captured?.metric_mapping ?? b.metric_sources?.[source.platform];
      if (detailed && !captured?.metric_mapping) return unavailable();
      const field = mapping?.[key];
      if (!field) return `<span class="muted">${esc(uiText('Not reported'))}</span>`;
      const native =
        typeof field === 'string' ? field : (field.path ?? field.from ?? JSON.stringify(field.by_objective));
      if (typeof native !== 'string') return unavailable();
      return (
        `<code>${esc(native + (detailed && field.action_type !== undefined ? '[action_type=' + field.action_type + ']' : ''))}</code>` +
        (field.divisor ? ' ÷ ' + esc(number(field.divisor)) : '') +
        (!detailed && field.note ? `<small>${esc(field.note)}</small>` : '')
      );
    };
  if (!selected.length || !shared.length) return '';
  return (
    `<details class="panel metric-sources"><summary>${esc(uiText('How this snapshot counts its metrics'))}</summary><div class="report-table-wrap" role="region" tabindex="0" aria-label="${esc(uiText('Native metric mappings by account and entity level (scrolls sideways)'))}"><table class="report-table"><caption>${esc(uiText('Saved native fields by account and level. Additive totals share a period; reach and frequency are never summed.'))}</caption><thead><tr><th scope="col">${esc(uiText('Metric'))}</th>` +
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
/** An unconfirmed Sheets delivery blocks newer reports to its tab until it is confirmed, resent or released. */
function renderSheetsDeliveryRecovery(r) {
  const pending = (r.sheets_deliveries ?? []).filter(d => ['pending', 'uncertain'].includes(d.state));
  if (!pending.length) return '';
  const reader = session.workspaceRole === 'viewer';
  return (
    `<section class="panel" role="status"><h3>${esc(uiText('Unconfirmed Google Sheets delivery'))}</h3>` +
    pending
      .map(d => {
        const destination = (overviewState.bootstrap?.destinations ?? []).find(x => x.id === d.destination_id),
          attributes = `data-delivery-id="${esc(d.id)}" data-destination-id="${esc(d.destination_id)}"`,
          wait = !d.recovery_available;
        return (
          `<div class="schedule-row"><span><strong>${esc(uiText('Unconfirmed since {date}', {date: date(d.unconfirmed_since)}))}</strong><small>` +
          esc(
            uiText(
              'Google did not confirm this delivery, so AMCP does not send a newer report to this tab until it is resolved.',
            ),
          ) +
          (destination ? '<br>' + esc(destination.name) + ' · ' + esc(destination.tab_name) : '') +
          (wait
            ? '<br>' +
              esc(
                uiText('Google may still apply it. Resend and release are available after {date}.', {
                  date: date(d.settle_until),
                }),
              )
            : '') +
          `</small></span><div class="report-actions"><button class="button small" data-delivery-resolve="check" ${attributes} ${reader ? 'disabled' : ''}>${esc(uiText('Check again'))}</button>` +
          `<button class="button small" data-delivery-resolve="resend" ${attributes} ${reader || wait ? 'disabled' : ''}>${esc(uiText('Resend same report'))}</button>` +
          `<button class="button small danger" data-delivery-resolve="abandon" ${attributes} ${reader || wait ? 'disabled' : ''}>${esc(uiText('Release tab'))}</button></div></div>`
        );
      })
      .join('') +
    `</section>`
  );
}
function bindSheetsDeliveryRecovery(reportId) {
  authBind('[data-delivery-resolve]', async b => {
    const resolution = b.dataset.deliveryResolve;
    if (
      resolution === 'resend' &&
      !(await confirmAction({
        title: uiText('Resend the same report to this tab?'),
        consequence: uiText(
          'AMCP sends the identical report once more. The tab keeps one delivery marker, so a late copy of the first attempt cannot duplicate it.',
        ),
        confirmLabel: uiText('Resend same report'),
      }))
    )
      return;
    if (
      resolution === 'abandon' &&
      !(await confirmAction({
        title: uiText('Release this report tab?'),
        consequence: uiText(
          'AMCP stops waiting for this unconfirmed delivery and lets newer reports use the tab. If Google applies it later, the next export detects that and replaces it. The release is recorded in Activity.',
        ),
        confirmLabel: uiText('Release tab'),
      }))
    )
      return;
    const result = await overviewCall({
      action: 'resolve_delivery',
      destination_id: b.dataset.destinationId,
      ...(b.dataset.deliveryId ? {delivery_id: b.dataset.deliveryId} : {}),
      resolution,
      confirmed: true,
    });
    toast(
      resolution === 'check'
        ? result.reconciled
          ? uiText('Delivery confirmed in the tab.')
          : uiText('The tab does not show this delivery yet.')
        : resolution === 'resend'
          ? uiText('The same report is queued to resend.')
          : uiText('Report tab released.'),
    );
    await loadOverviewReport(reportId);
  });
}
/** EXP-03 A: the receipt of an export that wrote nothing because the tab already holds a newer snapshot. */
function exportOutcomeMessage(e) {
  return e.newer_captured_at
    ? uiText('Not written — this tab already holds a newer snapshot (captured {date}).', {
        date: date(e.newer_captured_at),
      })
    : uiText('Not written — this tab already holds a newer snapshot.');
}
/** EXP-03 E: the last delivery of a schedule, with a Retry for a failed delivery that can succeed on retry. */
function scheduleDeliveryHealth(s, reader) {
  const d = s.last_delivery;
  if (!d) return '';
  const failed = ['failed', 'retrying'].includes(d.state);
  return (
    `<span class="${failed ? 'error' : 'muted'}">` +
    esc(uiText('Last delivery: {state} · {date}', {state: reportLabel(d.state), date: date(d.at)})) +
    (d.error_code ? ' · ' + esc(d.error_code) : '') +
    (failed && s.consecutive_delivery_failures
      ? ' · ' + esc(uiText('{count} failed in a row', {count: s.consecutive_delivery_failures}))
      : '') +
    `</span>` +
    (d.state === 'failed' && d.retry_available && d.job_id
      ? ` <button class="button small" data-schedule-delivery-retry="${esc(d.job_id)}" ${reader ? 'disabled' : ''}>${esc(uiText('Retry delivery'))}</button>`
      : '')
  );
}
/**
 * The next deliveries of a schedule as a table (EXP-04 B, owner policy P6): the delivery time in its own zone first,
 * then the viewer's time, then the dates collected in the window's zone. A time moved out of a daylight-saving gap
 * says so (EXP-02). It reads a preview_schedule result; the preview makes no provider request.
 */
function scheduleOccurrencesTable(out, caption = uiText('Next 3 deliveries')) {
  const occurrences = Array.isArray(out?.occurrences) ? out.occurrences : [];
  if (!occurrences.length) return `<p class="empty">${esc(uiText('No upcoming delivery could be calculated.'))}</p>`;
  const viewer = uiViewerTimeZone(),
    first = occurrences[0],
    open = occurrences.some(o => (o.sources ?? []).some(s => s.open_at_delivery === true));
  return (
    `<div class="report-table-wrap" role="region" tabindex="0" aria-label="${esc(caption)}"><table class="report-table schedule-preview-table"><caption>${esc(caption)}</caption><thead><tr><th scope="col">${esc(uiText('Delivery time ({zone})', {zone: first.delivery_timezone}))}</th><th scope="col">${esc(uiText('Your time ({zone})', {zone: viewer}))}</th><th scope="col">${esc(uiText('Collected dates ({zone})', {zone: first.window_timezone}))}</th></tr></thead><tbody>` +
    occurrences
      .map(
        o =>
          `<tr><th scope="row">${esc(uiZonedTime(o.delivery_at, o.delivery_timezone))}${o.dst_shifted ? `<small>${esc(uiText('Moved forward by the daylight-saving change'))}</small>` : ''}</th><td>${esc(uiZonedTime(o.delivery_at, viewer))}</td><td>${esc(reportDay(o.date_range?.since))} – ${esc(reportDay(o.date_range?.until))}</td></tr>`,
      )
      .join('') +
    `</tbody></table></div>` +
    (open
      ? `<p class="form-note">${esc(uiText('At some of these times a source’s last day has not ended in its own time zone; that snapshot is partial and its recommendations wait.'))}</p>`
      : '')
  );
}
function renderExportHistory(r) {
  return (r.exports ?? []).length
    ? `<section class="panel"><h3>${esc(uiText('Delivery history'))}</h3>` +
        html`${reportNotices(r)}` +
        r.exports
          .map(
            e =>
              `<div class="schedule-row"><span><strong>` +
              esc(reportLabel(e.outcome ?? e.state)) +
              `</strong><small>` +
              esc(
                (e.error && uiOwnedError(e.error).message) ||
                  ((e.outcome ?? e.state) === 'superseded'
                    ? exportOutcomeMessage(e)
                    : e.destination_kind === 'report_files'
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
              // EXP-03 C: no Retry for a failure that repeats identically on every retry.
              (['failed', 'cancelled'].includes(e.state) && e.retry_available !== false
                ? `<button class="button small" data-export-retry="` +
                  esc(e.job_id) +
                  `">${esc(uiText('Retry export'))}</button>`
                : '') +
              // A tab whose delivery marker conflicts with AMCP's last confirmed delivery needs an audited release.
              (e.error?.details?.release_available === true && e.destination_id
                ? `<button class="button small danger" data-delivery-resolve="abandon" data-destination-id="${esc(e.destination_id)}" ${session.workspaceRole === 'viewer' ? 'disabled' : ''}>${esc(uiText('Release tab'))}</button>`
                : '') +
              `</div>`,
          )
          .join('') +
        `</section>`
    : '';
}

function reportFileLinks(e) {
  // Report files are for operators unless the owner allows viewer downloads (SEC-05); the server refuses them too.
  if (typeof session !== 'undefined' && session?.downloadsAllowed === false) return '';
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
  const state =
    ['queued', 'running'].includes(r.state) && ['failed', 'cancelled'].includes(r.job?.state) ? r.job.state : r.state;
  return state === 'complete' && r.row_count === 0
    ? ['objective_filter', 'scope_filter'].includes(r.empty_reason) || reportSourceRowCount(r) > 0
      ? uiText('Filtered out')
      : uiText('No data')
    : reportLabel(state);
}
function renderReportEmpty(r) {
  if (r.state === 'failed' || r.job?.state === 'failed')
    return `<div class="empty panel">${esc(uiText('The report could not be collected. Resolve the source errors above, then retry.'))}</div>`;
  if (r.state === 'cancelled' || r.job?.state === 'cancelled')
    return `<div class="empty panel">${esc(uiText('This report was cancelled. Pull a new report to collect its data.'))}</div>`;
  const modern = r.config.contract_version === 'overview-config-v4';
  if (modern && r.empty_reason === 'scope_filter') {
    const unknown = (r.sources ?? []).some(source =>
      (source.level_results ?? [source]).some(level => level.scope?.excluded_unknown_rows > 0),
    );
    return html`<div class="empty panel report-empty"><h3>${unknown ? uiText('Some rows could not be checked against your source filters') : uiText('No rows matched your source filters')}</h3><p>${reportRangeLabel(r.config.date_range)}</p><p>${unknown ? uiText('Some source evidence is unknown. Review the source details before changing the filters.') : uiText('Review the selected IDs, statuses and activity filter.')}</p><p>${uiText('There is nothing to export. CSV downloads and Google Sheets updates are disabled for this report.')}</p><a class="button" href="#overview-config">${uiText('Review dates, account and filters')}</a></div>`;
  }
  const count = modern && r.scoped_row_count !== undefined ? r.scoped_row_count : reportSourceRowCount(r),
    filtered = r.empty_reason === 'objective_filter' || r.filtered_row_count > 0 || count > 0;
  return `<div class="empty panel report-empty"><h3>${filtered ? uiText('Your objective filters excluded the returned rows') : modern ? uiText('No source rows returned') : uiText('No campaign rows returned')}</h3><p>${esc(reportRangeLabel(r.config.date_range))}</p><p>${filtered ? esc(modern ? uiPlural(count, '{count} row matched the source filters. Review the objective selections above.', '{count} rows matched the source filters. Review the objective selections above.') : uiPlural(count, '{count} row was returned before filtering. Review the objective selections above.', '{count} rows were returned before filtering. Review the objective selections above.')) : modern ? uiText('Check the selected account, dates and reporting levels. No performance values have been assumed.') : uiText('Check that the selected account and reporting year match Ads Manager. No performance values have been assumed.')}</p><p>${esc(uiText('There is nothing to export. CSV downloads and Google Sheets updates are disabled for this report.'))}</p><a class="button" href="#overview-config">${esc(uiText('Review dates, account and filters'))}</a></div>`;
}
function reportSourceHealthLabel(source) {
  if (source.error) return uiText('Source failed');
  if (source.scoped_row_count !== undefined) {
    if (!source.complete) return uiText('Limited coverage');
    if (source.scoped_row_count === 0 && source.row_count > 0) return uiText('Filtered out');
    if (source.scoped_row_count > 0) return uiText('Complete');
  }
  return source.row_count === 0
    ? uiText('No rows returned')
    : source.complete
      ? uiText('Complete')
      : uiText('Limited coverage');
}
const reportUnmatchedSentence = /^\d+ selected IDs? matched /; // the card lists them itself
function reportSourceCaptureMessage(source, range) {
  const warnings = (source.warnings ?? [])
    .filter(warning => !(source.unmatched_ids && reportUnmatchedSentence.test(warning)))
    .map(uiSourceWarning)
    .join(' ');
  if (source.row_count === 0 && !(source.scoped_row_count > 0))
    return (
      (source.scoped_row_count === undefined
        ? uiText('The provider returned no campaign rows for {range}. Check the account and year.', {
            range: reportRangeLabel(source.date_range ?? range),
          })
        : uiText('No source rows were captured for {range}.', {range: reportRangeLabel(source.date_range ?? range)})) +
      ' ' +
      warnings
    );
  return warnings || uiText('All returned pages captured.');
}
function reportSourceCounts(source) {
  const supporting = (source.level_results ?? [])
    .filter(level => level.purpose === 'scope_rollup')
    .reduce((count, level) => count + level.row_count, 0);
  return html`<p>${uiText('Native rows at requested levels: {count}', {count: source.row_count})}${source.scope_input_row_count !== undefined && source.scope_input_row_count !== source.row_count ? html` · ${uiText('Rows considered for source filters: {count}', {count: source.scope_input_row_count})}` : ''} · ${uiText('Rows after source filters: {count}', {count: source.scoped_row_count})} · ${uiText('{count} shown after objective filters', {count: source.visible_row_count ?? source.scoped_row_count})}${source.derived_row_count ? html` · ${uiText('Rolled-up rows: {count}', {count: source.derived_row_count})}` : ''}${supporting ? html` · ${uiText('Rows read at supporting levels: {count}', {count: supporting})}` : ''}</p>`;
}
function reportLevelLabel(b, row) {
  const label = (b.platforms.find(p => p.id === row.platform)?.entity_levels ?? []).find(
    level => level.id === row.entity_level,
  )?.label;
  return (
    (label ? uiText(label) : String(row.native_entity_type ?? '')) +
    (row.aggregation?.kind === 'rolled_up'
      ? ' · ' + reportLabel(row.aggregation.scope_field === 'ad_ids' ? 'rolled_up_ads' : 'rolled_up_children')
      : '')
  );
}
function reportParentChoices(account) {
  const choices = account.parent_campaigns?.campaigns ?? [],
    completed = account.parent_campaigns?.completed_at;
  if (!choices.length || !Number.isFinite(completed)) return '';
  return html`<details class="native-settings"><summary>${uiText('Campaign IDs from the report of {date}', {date: reportDay(new Date(completed).toISOString().slice(0, 10))})}</summary><ul>${choices.map(c => html`<li><code dir="ltr">${c.id}</code> <bdi dir="auto" data-native>${c.name ?? c.id}</bdi></li>`)}</ul></details>`;
}
/** RPT-07: a native parent's name beside its ID, kept literal (current provider metadata, never translated). */
function reportParentName(name) {
  return typeof name === 'string' && name ? ` · <span dir="auto" data-native>${esc(name)}</span>` : '';
}
function renderReportSourceHealth(s, platforms, index, range, report) {
  return `<details id="report-source-${index}" class="source-health ${s.complete ? 'complete' : 'attention'}" ${s.error ? 'open' : ''}><summary><span>${esc(platforms.find(p => p.id === s.source.platform)?.name ?? s.source.platform)}</span><strong>${esc(reportSourceHealthLabel(s))}</strong></summary>${s.account_name ? `<p><strong>${esc(s.account_name)}</strong></p>` : ''}<p>${esc(s.source.account_id)} · ${esc(s.currency ?? uiText('Currency unavailable'))} · ${esc(s.timezone ?? uiText('Timezone unavailable'))}</p>${s.error ? renderSourceDiagnostic(s.error) : `<p>${esc(reportSourceCaptureMessage(s, range))}</p>`}${reportFailedLevels(s)}${reportUnmatchedIds(s)}${s.scoped_row_count !== undefined ? html`${reportSourceCounts(s)}` : s.row_count > 0 ? `<p>${esc(uiPlural(s.row_count, '{count} source row', '{count} source rows'))}${s.visible_row_count === undefined ? '' : ' · ' + esc(uiText('{count} shown after objective filters', {count: s.visible_row_count}))}</p>` : ''}<small>${esc(s.attribution ?? '')}</small>${reportQualityDetails(s, report)}${renderPeriodFailures(s.period_errors ?? s.error?.period_errors ?? [])}${s.error ? html`${reportSourceActions(s.error, index)}` : ''}</details>`;
}
/**
 * V2-RPT-05: Retry on a source card runs the report again from the setup form. The form is submitted through its own
 * submit button, so the submit event has a submitter (a bare requestSubmit() has none), and a run that is already
 * starting is not started twice by a second click.
 */
async function retryReportRun() {
  const form = $('#overview-config'),
    submit = form?.querySelector('button[type="submit"]');
  if (submit && submit.getAttribute('aria-busy') !== 'true') form.requestSubmit(submit);
}
/**
 * V2-RPT-05: a failed source card's actions follow its error's category. The platform's data or a provider failure:
 * Retry (the run form again) and Copy. The connection or its permissions: Manage connections and Copy. A rate limit, a
 * request AMCP refused or an internal failure: Copy only. A stored diagnostic without a category keeps its old actions.
 * A credential failure the server marks (its layer) also offers Manage connections, and a login that changed during
 * the report offers the Retry its own next step names.
 */
function reportSourceActions(error, index) {
  const category = error.category,
    retry = ['provider_data', 'provider'].includes(category) || error.code === 'CONNECTION_AUTHORITY_CHANGED',
    connections =
      category === undefined || ['connection', 'permission'].includes(category) || error.layer === 'credential';
  return html`<div class="report-actions">${retry ? html`<button type="button" class="button small" data-report-retry="${index}">${uiText('Retry')}</button>` : ''}${connections ? html`<a class="button small" href="/connections">${uiText('Manage connections')}</a>` : ''}<button type="button" class="button small" data-report-diagnostic="${index}">${uiText('Copy error details')}</button></div>`;
}
/** F-L5-10: the levels that could not be collected, each with its error (a failed source shows its own). */
function reportFailedLevels(source) {
  const failed = source.error ? [] : (source.failed_levels ?? []),
    name = level => reportLevelName(source.source?.platform, level.level);
  return failed.length
    ? `<p>${esc(uiText('These levels could not be collected: {levels}.', {levels: uiList(failed.map(name))}))}</p>` +
        failed
          .map(level => `<p><strong>${esc(name(level))}</strong></p>` + renderSourceDiagnostic(level.error))
          .join('')
    : '';
}
/** F-L5-27: selected IDs that matched no returned row, so a mistyped or stale ID cannot narrow a total unnoticed. */
function reportUnmatchedIds(source) {
  const ids = Object.values(source.unmatched_ids ?? {}).flat();
  return ids.length
    ? `<p>${esc(uiText('Selected IDs that matched no returned row ({count}):', {count: uiNumber(ids.length)}))} ` +
        ids
          .slice(0, 10)
          .map(id => `<code dir="ltr">${esc(id)}</code>`)
          .join(', ') +
        (ids.length > 10 ? ' …' : '') +
        `</p>`
    : '';
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
