'use strict';
async function renderReportLibraryPage() {
  const [b, page] = await Promise.all([overviewCall({action: 'bootstrap'}), overviewCall({action: 'list', limit: 30})]);
  content.innerHTML += `<div class="dialog-actions"><button id="library-new-report" class="button primary">${esc(uiText('New report'))}</button><a class="button" href="/schedules">${esc(uiText('Schedules and delivery'))}</a><a class="button" href="/reports">${esc(uiText('Evidence and analysis'))}</a></div><section class="panel"><h2>${esc(uiText('Saved report definitions'))}</h2><p>${esc(uiText('Definitions hold accounts, metrics and delivery settings. Each run creates a separate snapshot.'))}</p><label>${esc(uiText('Find a client or report'))}<input id="report-library-search" type="search"></label><div id="report-definition-list"></div></section><section class="panel"><h2>${esc(uiText('Reusable templates'))}</h2>${(b.templates ?? []).map(t => `<div class="token-row"><div><strong>${esc(t.config.name)}</strong><small>${esc(uiText('Account-free template · revision {revision}', {revision: t.revision}))}</small></div><button class="button small" data-library-template="${esc(t.id)}">${esc(uiText('Use template'))}</button></div>`).join('') || blank(uiText('Save a template from the report builder to reuse its metric and layout choices.'))}</section><section class="panel"><h2>${esc(uiText('Retained snapshots'))}</h2><div id="snapshot-library"></div><button id="snapshot-more" class="button">${esc(uiText('Load more snapshots'))}</button></section>`;
  const definitions = () => {
    const query = $('#report-library-search').value.toLocaleLowerCase();
    $('#report-definition-list').innerHTML =
      b.views
        .filter(v => overviewLabel(v.config).toLocaleLowerCase().includes(query))
        .map(
          v =>
            `<div class="token-row"><div><strong>${esc(overviewLabel(v.config))}</strong><small>${esc(uiText('{count} accounts · {grain} · revision {revision}', {count: v.config.sources.length, grain: reportLabel(v.config.grain ?? 'total'), revision: v.revision}))}</small></div><a class="button small" href="/reporting-overview?view_id=${encodeURIComponent(v.id)}">${esc(uiText('Open builder'))}</a></div>`,
        )
        .join('') || blank(uiText('No matching saved report.'));
  };
  $('#report-library-search').addEventListener('input', definitions);
  definitions();
  workspaceBind('#library-new-report', async () => {
    resetOverviewSelection();
    overviewState.config = overviewDefault();
    await navigate('/reporting-overview');
  });
  workspaceBind('[data-library-template]', async button => {
    selectOverviewDefinition(
      b.templates.find(t => t.id === button.dataset.libraryTemplate),
      'template',
    );
    await navigate('/reporting-overview');
  });
  let next = null;
  const append = data => {
    $('#snapshot-library').insertAdjacentHTML(
      'beforeend',
      data.reports
        .map(
          r =>
            `<div class="token-row"><div><strong>${esc(overviewLabel(r.config))}</strong><small>${date(r.captured_at ?? r.created_at)} · ${esc(uiText('{count} rows', {count: r.row_count ?? 0}))} · ${esc(reportWindowLabel(r.config.date_range))}</small></div>${badge(r.state)}<a class="button small" href="/reporting-overview?report_id=${encodeURIComponent(r.id)}">${esc(uiText('Open snapshot'))}</a></div>`,
        )
        .join('') ||
        (data.has_more
          ? `<p>${esc(uiText('No accessible snapshots in this page. Continue to older results.'))}</p>`
          : `<p>${esc(uiText('No further snapshots.'))}</p>`),
    );
    next = data.next_offset;
    $('#snapshot-more').hidden = !data.has_more;
  };
  append(page);
  workspaceBind('#snapshot-more', async () => {
    if (next !== null) append(await overviewCall({action: 'list', offset: next, limit: 30}));
  });
}
/** RPT-07: first-party labels for the comparison's reason codes; provider values stay literal. */
const comparisonRowReasons = {
  platform: 'Platform',
  account_id: 'Account',
  currency: 'Currency',
  timezone: 'Time zone',
  result_definition: 'Result definition',
  attribution: 'Attribution',
  entity_level: 'Reporting level',
  grain: 'Grouping',
  window: 'Window',
  definition_changed_within_window: 'Definition changed within the window',
  not_in_baseline: 'Not in the earlier window',
  not_in_current: 'Not in this window',
};
const comparisonMetricReasons = {
  non_additive_multi_day: 'Not additive across days; compared only for single-day windows',
  formula_changed: 'The formula changed between the windows',
  native_or_non_additive_dependency: 'Uses a provider field or a non-additive metric',
  depends_on_excluded_metric: 'Depends on an excluded metric',
  native_field_not_comparable: 'Provider field without a known aggregation',
};
const comparisonText = (labels, code) => (Object.hasOwn(labels, code) ? uiText(labels[code]) : code);
/** One compared metric: this window, the earlier window and the change, with nothing coloured as good or bad. */
function comparisonCell(key, value, currency) {
  if (!value || value.current === null || value.baseline === null)
    return `<td role="cell">${esc(uiText('Unavailable'))}</td>`;
  const format = n => (typeof metricFormat === 'function' ? metricFormat(key, n, currency) : String(n)),
    sign = value.delta.startsWith('-') ? '' : '+',
    percent =
      value.delta_percent === null
        ? `<span title="${esc(uiText('The earlier value is zero, so there is no percentage.'))}">—</span>`
        : esc(sign + uiDecimal(value.delta_percent, {maximumFractionDigits: 2}) + '%');
  return `<td role="cell"><strong>${esc(format(value.current))}</strong><small>${esc(uiText('Earlier: {value}', {value: format(value.baseline)}))}</small><small>${esc(uiText('Change:'))} ${esc(sign + format(value.delta))} (${percent})</small></td>`;
}
function renderSnapshotComparison(out) {
  const keys = out.metrics,
    label = key =>
      typeof overviewState !== 'undefined' && overviewState.bootstrap?.metrics?.[key]
        ? uiText(overviewState.bootstrap.metrics[key].label)
        : key,
    entity = row =>
      `<span dir="auto" data-native>${esc(row.entity_name ?? row.entity_id)}</span><small>${esc(row.entity_id)} · ${esc(row.account_id)}</small>`,
    list = (items, count, one, other) =>
      count
        ? `<details><summary>${esc(uiPlural(count, one, other))}</summary><ul>${items.map(x => `<li>${entity(x)} — ${esc((x.reasons ?? [x.reason]).map(code => comparisonText(comparisonRowReasons, code)).join(', '))}</li>`).join('')}</ul></details>`
        : '';
  return `<p class="form-note">${esc(uiText('{current} compared with {baseline} ({days} days each).', {current: reportRangeLabel(out.current.date_range), baseline: reportRangeLabel(out.baseline.date_range), days: out.current.window_days}))}</p>${out.excluded_metrics.length ? `<p class="form-note">${esc(uiText('Not compared:'))} ${out.excluded_metrics.map(x => `${esc(label(x.metric))} (${esc(comparisonText(comparisonMetricReasons, x.reason))})`).join('; ')}</p>` : ''}${
    out.rows.length
      ? `<div class="report-table-wrap" role="region" tabindex="0" aria-label="${esc(uiText('Period comparison (scrolls sideways)'))}"><table class="report-table report-compare-table" role="table"><caption>${esc(uiText('Entities in both windows: each metric in this window, in the earlier window, and the change.'))}</caption><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">${esc(uiText('Campaign / ad set / ad / resource'))}</th>${keys.map(k => `<th scope="col" role="columnheader">${esc(label(k))}</th>`).join('')}</tr></thead><tbody role="rowgroup">${out.rows.map(row => `<tr role="row"><th scope="row" role="rowheader">${entity(row)}</th>${keys.map(k => comparisonCell(k, row.values[k], row.currency)).join('')}</tr>`).join('')}</tbody></table></div><p class="muted">${esc(uiText('Rows {start}–{end} of {total} matching entities.', {start: out.offset + 1, end: out.offset + out.rows.length, total: out.row_count}))}</p>`
      : blank(uiText('No entity appears in both windows with the same measurement definitions.'))
  }${list(out.incompatible, out.incompatible_count, '{count} entity not compared: measurement definitions differ', '{count} entities not compared: measurement definitions differ')}${list(out.only_current, out.only_current_count, '{count} entity only in this window', '{count} entities only in this window')}${list(out.only_baseline, out.only_baseline_count, '{count} entity only in the earlier window', '{count} entities only in the earlier window')}<ul class="form-note">${out.limitations.map(x => `<li>${esc(uiText(x))}</li>`).join('')}</ul>`;
}
/**
 * RPT-07 "Compare to": an earlier retained snapshot of equal length (the previous-period pair is preselected). Options
 * that fail a rule stay listed, disabled, with the reason. Comparing reads retained snapshots only.
 */
function mountSnapshotComparison(report, root) {
  root.insertAdjacentHTML(
    'beforeend',
    `<section class="panel workspace-form" id="snapshot-compare"><h2>${esc(uiText('Compare periods'))}</h2><p>${esc(uiText('Compare this snapshot with an earlier window of the same length. Only entities with the same currency, time zone, attribution and result definition are compared, and nothing is read from the provider.'))}</p><button class="button" id="snapshot-compare-choices">${esc(uiText('Choose an earlier window'))}</button><div id="snapshot-compare-body"></div></section>`,
  );
  const show = async baselineId => {
    const out = await overviewCall({
      action: 'compare',
      id: report.id,
      ...(baselineId ? {baseline_id: baselineId} : {}),
    });
    $('#snapshot-compare-result').innerHTML = renderSnapshotComparison(out);
  };
  workspaceBind('#snapshot-compare-choices', async () => {
    const out = await overviewCall({action: 'compare_candidates', id: report.id});
    $('#snapshot-compare-body').innerHTML =
      `<form id="snapshot-compare-form"><label>${esc(uiText('Compare to'))}<select name="baseline_id" required><option value="">${esc(uiText('Choose explicitly'))}</option>${out.candidates
        .map(
          c =>
            `<option value="${esc(c.id)}" ${c.eligible ? '' : 'disabled'} ${c.paired && c.eligible ? 'selected' : ''}>${esc(reportRangeLabel(c.date_range))} · ${esc(c.name ?? '')}${c.paired ? ' · ' + esc(uiText('previous equal window')) : ''}${c.eligible ? '' : ' — ' + esc(c.reasons.map(r => uiText(r.message)).join(' '))}</option>`,
        )
        .join(
          '',
        )}</select></label><button type="submit" class="button primary">${esc(uiText('Compare'))}</button></form><div id="snapshot-compare-result"></div>`;
    workspaceBind('#snapshot-compare-form', async form => show(form.elements.baseline_id.value));
    if (out.candidates.some(c => c.paired && c.eligible)) await show(out.paired_baseline_id);
  });
}
function bindSnapshotAnalysis(report, root) {
  root.insertAdjacentHTML(
    'afterbegin',
    `<p class="notice">${esc(uiText('This is a retained snapshot. Changes in the report builder create a separate run.'))} <button class="button small" id="snapshot-use-setup">${esc(uiText('Use this snapshot’s setup'))}</button></p>`,
  );
  workspaceBind('#snapshot-use-setup', async () => {
    await openOverviewHistory(report.id);
    $('#overview-config')?.scrollIntoView({block: 'start'});
  });
  if (!['complete', 'partial'].includes(report.state) || !report.row_count) return;
  root.insertAdjacentHTML(
    'beforeend',
    `<section class="panel workspace-form"><h2>${esc(uiText('Analyze retained evidence'))}</h2><p>${esc(uiText('Choose one compatible account and measurement definition from this snapshot. Its original capture time and source lineage are retained.'))}</p><button class="button" id="snapshot-analysis-groups">${esc(uiText('Choose evidence group'))}</button><div id="snapshot-analysis"></div></section>`,
  );
  mountSnapshotComparison(report, root);
  root.insertAdjacentHTML(
    'beforeend',
    `<a class="button" href="/report-pack?report_id=` +
      encodeURIComponent(report.id) +
      `">${esc(uiText('Preview client report pack'))}</a> <a class="button" href="/monitors?report_id=` +
      encodeURIComponent(report.id) +
      `">${esc(uiText('Create a monitor from this snapshot'))}</a>`,
  );
  workspaceBind('#snapshot-analysis-groups', async () => {
    const out = await workspaceCall('reporting', {action: 'overview_sources', id: report.id});
    $('#snapshot-analysis').innerHTML =
      `<p>${esc(out.meaning)}</p><form id="capture-overview-evidence"><label>${esc(uiText('Account and measurement context'))}<select name="group" required><option value="">${esc(uiText('Choose explicitly'))}</option>${out.groups.map(g => `<option value="${esc(g.id)}" ${g.eligible ? '' : 'disabled'}>${esc(g.account_id)} · ${esc(g.semantics.currency ?? uiText('Currency unknown'))} · ${esc(g.semantics.timezone ?? uiText('Timezone unknown'))} · ${esc(g.semantics.conversion_definition)} · ${esc(uiText('{count} rows', {count: g.row_count}))}</option>`).join('')}</select></label><button type="submit" class="button primary">${esc(uiText('Capture evidence and open analysis'))}</button></form>`;
    workspaceBind('#capture-overview-evidence', async form => {
      const captured = await workspaceCall('reporting', {
        action: 'capture_overview',
        id: report.id,
        group_id: form.elements.group.value,
      });
      await navigate('/reports?id=' + encodeURIComponent(captured.id));
    });
  });
}
