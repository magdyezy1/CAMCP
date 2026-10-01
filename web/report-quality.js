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
