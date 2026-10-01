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
