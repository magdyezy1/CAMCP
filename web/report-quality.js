// Exact authored explanations only; provider diagnostics and user content retain their original text.
const reportExplanationMessages = new Set([
  'A recent change or seasonal event may explain this result. Review the supplied context before changing budgets.',
  'Account currencies, timezones, attribution and conversion definitions remain separate.',
  'Assumes unchanged prices, auction conditions, targeting, creative and measurement. Actual delivery can differ.',
  'Attribution, conversion lag and source mappings must be verified before acting.',
  'Budgets cover a comparable period with the same number of days as the evidence. They are not native daily or lifetime budgets.',
  'Check current campaign budgets and prepare a separate reviewed change. This proposal uses caller-declared budget values.',
  'Confirm attribution and the primary conversion definition before making budget recommendations.',
  'Confirm this campaign’s objective and primary result metric.',
  'Heuristic evidence, not a causal estimate or performance guarantee.',
  'Illustrative constrained sensitivity model, not a forecast or statistical confidence interval.',
  'Illustrative sensitivity model, not a forecast or a statistical confidence interval.',
  'Inspect creative, audience, placement and delivery changes before replacing this creative.',
  'Investigate budget, schedule and targeting changes.',
  'Linear response ignores saturation, auction changes, audience overlap, creative changes and causal incrementality. Caps are user assumptions, not verified provider limits.',
  'Measurement and organic reports provide context; they do not establish an advertising budget action.',
  'Measurement completeness and timezone retain the original report declarations; the minimum conversion threshold is a user assumption, not statistical significance.',
  'No live budget or approval is created. Any later change needs current native budget ownership, units, eligibility, preflight and a separate reviewed plan.',
  'Observational comparison; no causal lift or seasonal adjustment is inferred.',
  'Observational evidence does not establish causality or adjust for seasonality.',
  'Performance is below target. Consider a bounded budget reduction and diagnose the cause.',
  'Performance is close to the configured target. Maintain delivery and monitor.',
  'Performance is comfortably above target. Consider a bounded budget increase after checking capacity and recent changes.',
  'Performance is materially below target. Review tracking, targeting and creative before deciding whether to pause.',
  'Performance supports growth, but a confirmed capacity or budget constraint prevents increasing delivery.',
  'Preview only. Daily amounts round down to whole micros; residuals are shown. These are ongoing average daily budgets, not a scheduled period spending cap. Creating a draft does not approve or execute it.',
  'Reach and frequency are not summed. Calculated ratios come from compatible additive totals.',
  'Recommendations are advisory; a separate review is required for advertising changes.',
  'Refresh a complete reporting window before acting.',
  'Refresh complete data with verified currency and timezone before recommending a change.',
  'Review conversion lag and targeting before preparing a bid or budget change.',
  'Review delivery and budget pacing.',
  'Review relevance and conversion lag before preparing an exact negative keyword.',
  'Review whether delivery can meet the planned budget.',
  'Spend exceeded three target acquisition costs with no reported results. Check tracking and conversion lag, then consider pausing.',
  'The reporting window is still inside the configured conversion-lag period.',
  'The reporting window needs an unambiguous account timezone boundary.',
  'The secondary KPI is unavailable or below its target. Resolve the conflicting evidence before changing delivery.',
  'The supplied daily budget limit leaves no room for an increase.',
  'The target currency must match the campaign account currency.',
  'These scenarios never change budgets, activate campaigns or create an approval.',
  'Tracking is marked unverified. Resolve measurement before changing delivery.',
  'Wait for enough results to distinguish a signal from a small sample.',
]);
function uiReportExplanation(value) {
  return reportExplanationMessages.has(value) ? uiText(value) : String(value ?? '');
}
function uiRecommendationReason(recommendation) {
  const message = recommendation.reason_localization;
  if (
    recommendation.decision === 'needs_target' &&
    message?.key === 'target_required' &&
    typeof message.kpi === 'string' &&
    typeof message.currency === 'string'
  )
    return uiText('Set a {kpi} target in {currency} for this objective or campaign.', {
      kpi: message.kpi,
      currency: message.currency,
    });
  return uiReportExplanation(recommendation.reason);
}
const reportAnalysisLabels = {
  data_quality: 'Data quality',
  budget_pacing: 'Budget pacing',
  search_waste: 'Search waste',
  possible_creative_fatigue: 'Possible creative fatigue',
  cpa_above_target: 'CPA above target',
  spend_anomaly: 'Spend anomaly',
  bounded_budget_proposal: 'Bounded budget proposal',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};
function uiAnalysisLabel(value) {
  return Object.hasOwn(reportAnalysisLabels, value)
    ? uiText(reportAnalysisLabels[value])
    : String(value ?? '').replaceAll('_', ' ');
}
function reportTargetContext(objective, context = {}) {
  const flag = (key, label) =>
    `<label>${label}<select data-target-context="${objective}:${key}">${[
      ['', uiText('Not supplied')],
      ['true', uiText('Yes')],
      ['false', uiText('No')],
    ]
      .map(
        ([value, text]) =>
          `<option value="${value}" ${String(context[key] ?? '') === value ? 'selected' : ''}>${text}</option>`,
      )
      .join('')}</select></label>`;
  return `<details><summary>${esc(uiText('Business context and constraints'))}</summary><div class="target-fields"><label>${esc(uiText('Context note'))}<textarea maxlength="1000" data-target-context="${objective}:note">${esc(context.note ?? '')}</textarea></label><label>${esc(uiText('Seasonal event or promotion'))}<input maxlength="1000" data-target-context="${objective}:seasonal_event" value="${esc(context.seasonal_event ?? '')}"></label>${flag('recent_change', uiText('Recent campaign or business change?'))}${flag('tracking_verified', uiText('Tracking verified?'))}${flag('capacity_available', uiText('Capacity available for growth?'))}${flag('budget_available', uiText('Budget available for growth?'))}<label>${esc(uiText('Current daily budget'))}<input type="number" min="0" step="any" data-target-context="${objective}:current_daily_budget" value="${context.current_daily_budget ?? ''}"></label><label>${esc(uiText('Maximum daily budget'))}<input type="number" min="0" step="any" data-target-context="${objective}:maximum_daily_budget" value="${context.maximum_daily_budget ?? ''}"></label><label>${esc(uiText('Secondary KPI'))}<select data-target-secondary="${objective}:kpi"><option value="">${esc(uiText('None supplied'))}</option>${['roas', 'cpa', 'ctr', 'conversion_rate', 'cpc'].map(k => `<option value="${k}" ${context.secondary_kpi?.kpi === k ? 'selected' : ''}>${k.toUpperCase()}</option>`).join('')}</select></label><label>${esc(uiText('Secondary target'))}<input type="number" min="0.000001" step="any" data-target-secondary="${objective}:target" value="${context.secondary_kpi?.target ?? ''}"></label><label>${esc(uiText('Secondary direction'))}<select data-target-secondary="${objective}:direction"><option value="higher" ${context.secondary_kpi?.direction === 'higher' ? 'selected' : ''}>${esc(uiText('Higher is better'))}</option><option value="lower" ${context.secondary_kpi?.direction === 'lower' ? 'selected' : ''}>${esc(uiText('Lower is better'))}</option></select></label></div><p class="form-note">${esc(uiText('Context is supplied by you. AMCP does not infer seasonal effects or causal impact.'))}</p></details>`;
}
function readTargetContext(objective) {
  const out = {};
  for (const el of document.querySelectorAll('[data-target-context]')) {
    const [id, key] = el.dataset.targetContext.split(':');
    if (id !== objective || el.value === '') continue;
    out[key] = ['current_daily_budget', 'maximum_daily_budget'].includes(key)
      ? Number(el.value)
      : ['recent_change', 'tracking_verified', 'capacity_available', 'budget_available'].includes(key)
        ? el.value === 'true'
        : el.value;
  }
  const s = {};
  for (const el of document.querySelectorAll('[data-target-secondary]')) {
    const [id, key] = el.dataset.targetSecondary.split(':');
    if (id === objective) s[key] = key === 'target' ? Number(el.value) : el.value;
  }
  if (s.kpi) out.secondary_kpi = s;
  return out;
}
function reportQualityDetails(source) {
  const q = source.quality;
  if (!q)
    return `<p class="form-note">${esc(uiText('Legacy snapshot: measurement-quality metadata was not recorded.'))}</p>`;
  const labels = [
    q.sampled ? uiText('Sampled') : '',
    q.thresholded ? uiText('Thresholded') : '',
    q.data_loss ? uiText('Aggregation loss') : '',
    q.truncated ? uiText('Truncated by GA4') : '',
    q.restricted_metrics?.length ? uiText('Restricted: {metrics}', {metrics: q.restricted_metrics.join(', ')}) : '',
  ].filter(Boolean);
  return `<p class="form-note">${esc(labels.join(' · ') || uiText('No additional source-quality flags recorded.'))}</p><details><summary>${esc(uiText('Quality and source evidence'))}</summary><pre>${esc(JSON.stringify({quality: q, lineage: source.lineage, query_fingerprint: source.query_fingerprint}, null, 2))}</pre></details>`;
}
function refreshRecentReports(report) {
  overviewState.history = [
    {...report, rows: undefined},
    ...overviewState.history.filter(r => r.id !== report.id),
  ].slice(0, 50);
  const section = document.querySelector('.report-history');
  if (!section) return;
  section.innerHTML = renderOverviewHistory(
    overviewState.history,
    typeof session !== 'undefined' && session.workspaceRole === 'viewer',
  );
  bindOverviewHistory();
}
