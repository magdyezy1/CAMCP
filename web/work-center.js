'use strict';
function workHome(d, accounts) {
  const needsAttention = d.campaigns.filter(c =>
    ['blocked', 'failed', 'uncertain', 'awaiting_review', 'mismatch'].includes(c.state),
  );
  const recent = [...d.campaigns].sort((a, b) => b.updated_at - a.updated_at).slice(0, 8);
  const card = c =>
    `<a href="/campaigns?id=${encodeURIComponent(c.id)}"><strong>${esc(c.name)}</strong><small>${badge(c.state)} · ${date(c.updated_at)}</small></a>`;
  return (
    header(
      'Home',
      'Welcome back, ' + esc((session.name ?? 'there').split(' ')[0]) + '. Continue your work or start a new task.',
      '<a class="button primary" href="/campaigns#campaign-create">New campaign plan</a>',
    ) +
    (d.writes_paused
      ? `<div class="notice warning" role="status"><strong>Provider writes are paused</strong><p>${esc(d.writes_paused.reason)}</p><a href="/settings#owner-write-pause">View operating controls</a></div>`
      : '') +
    (accounts.length
      ? ''
      : '<section class="panel"><h2>Connect your first account</h2><p>Choose a platform login and the accounts your workspace can use. Readiness checks will explain the next step.</p><a href="/connections" class="button primary">Set up connections</a></section>') +
    `<section class="panel"><div class="panel-header"><h2>Needs attention</h2><a href="/operations">All operations</a></div><div class="work-links">${needsAttention.map(card).join('') || '<p>No saved campaign plans currently need attention.</p>'}</div></section><section class="panel"><div class="panel-header"><h2>Continue recent work</h2><a href="/campaigns">All plans</a></div><div class="work-links">${recent.map(card).join('') || '<p>Your saved campaign plans will appear here.</p>'}</div></section><div class="quick-actions"><a href="/media"><span>${glyph('media')}</span><div><strong>Prepare creative</strong><small>Sources, variants and upload receipts</small></div></a><a href="/reporting-overview"><span>${glyph('report')}</span><div><strong>Build a report</strong><small>Source evidence and client deliveries</small></div></a><a href="/capabilities"><span>${glyph('connection')}</span><div><strong>Check capabilities</strong><small>Account prerequisites and action contracts</small></div></a></div>`
  );
}
async function renderCapabilityCenter() {
  const graph = await workspaceCall('workspace', {action: 'capabilities'});
  content.innerHTML += `<p class="notice">${esc(graph.meaning)}</p><section class="panel"><h2>Workflow and account eligibility</h2>${graph.workflows.map(w => `<details><summary><strong>${esc(w.name)}</strong> · ${esc(w.kind.replaceAll('_', ' '))}</summary><p>${esc(w.description)}</p><p>Required inputs: ${esc(w.required_inputs.join(', '))}</p>${w.accounts.map(a => `<div class="token-row"><div><strong>${esc(a.label)} · ${esc(a.account_id)}</strong><small>${esc(a.blockers.join(', ') || 'Local prerequisites available. Native preflight still required.')}</small><small>Unverified: ${esc(a.unresolved.join(', '))}</small></div>${badge(a.local_state)}</div>`).join('') || '<p>Connect and select a matching account first.</p>'}<a class="button small" href="${esc(w.website_path)}">Open workflow</a>${recordDetails(w.next_call, 'Continue in MCP')}</details>`).join('')}</section><section class="panel workspace-form"><h2>Action contract reference</h2><form id="contract-filter"><label>Platform<select name="gateway"><option value="">All platforms</option>${graph.contracts.map(g => `<option value="${esc(g.gateway)}">${esc(g.gateway.replace('_native_action', ''))}</option>`).join('')}</select></label><label>Search action, route or classification<input name="search" type="search" maxlength="200"></label><button type="submit" class="button">Search contracts</button></form><div id="contract-results" aria-live="polite"></div></section>`;
  const filter = $('#contract-filter');
  const load = async offset => {
    const r = await workspaceCall('workspace', {
      action: 'contracts',
      ...(filter.elements.gateway.value ? {gateway: filter.elements.gateway.value} : {}),
      search: filter.elements.search.value,
      offset,
      limit: 30,
    });
    $('#contract-results').innerHTML =
      `<p>${r.total} matching contracts. ${esc(r.meaning)}</p>${r.actions.map(a => `<details><summary><strong>${esc(a.action)}</strong> · ${badge(a.status)}</summary><p>${esc(a.reason)}</p><code dir="ltr">${esc(a.method)} ${esc(a.path)}</code><p>Aliases: ${esc(a.aliases.join(', ') || 'None')}</p><p>Implementation: ${esc(a.implementation)} · Live qualification: ${esc(a.live_qualification)}</p><p>Evidence: ${esc(a.source)}</p><p>Tests: ${esc(a.tests.join(', '))}</p></details>`).join('')}<div class="dialog-actions"><button id="contracts-prev" class="button" ${offset ? '' : 'disabled'}>Previous</button><button id="contracts-next" class="button" ${r.has_more ? '' : 'disabled'}>Next</button></div>`;
    workspaceBind('#contracts-prev', () => load(Math.max(0, offset - 30)));
    workspaceBind('#contracts-next', () => load(offset + 30));
  };
  workspaceBind('#contract-filter', () => load(0));
  await load(0);
}
async function renderOperationsCenter() {
  const generation = navigationGeneration;
  const results = await Promise.allSettled([
    workspaceCall('campaign', {action: 'list', limit: 100}),
    workspaceCall('media', {action: 'list', limit: 100}),
    overviewCall({action: 'list'}),
  ]);
  if (generation !== navigationGeneration) return;
  const [campaigns, media, reports] = results.map(r => (r.status === 'fulfilled' ? r.value : {}));
  const errors = results.flatMap((r, i) =>
    r.status === 'rejected' ? [{area: ['Campaigns', 'Creative', 'Reports'][i], message: errorMessage(r.reason)}] : [],
  );
  content.innerHTML += `<div class="dialog-actions"><a class="button" href="/activity">Audit activity</a><a class="button" href="/capabilities">Capabilities</a><button id="operations-refresh" class="button">Refresh</button></div>${errors.map(e => `<p class="error" role="alert">${esc(e.area)}: ${esc(e.message)}</p>`).join('')}<section class="panel"><h2>Campaigns to resume or inspect</h2>${
    (campaigns.campaigns ?? [])
      .filter(c => !['complete', 'cancelled'].includes(c.state))
      .map(
        c =>
          `<div class="token-row"><div><strong>${esc(c.name)}</strong><small>${date(c.updated_at)}</small></div>${badge(c.state)}<a class="button small" href="/campaigns?id=${encodeURIComponent(c.id)}">Open original plan</a></div>`,
      )
      .join('') || '<p>No unfinished plans in this page of results.</p>'
  }<a href="/campaigns">All campaign plans</a></section><section class="panel"><h2>Upload recovery</h2>${(media.recovery_reviews ?? []).map(r => `<div class="token-row"><div><strong>${esc(r.request?.name)}</strong><small>Original review ${esc(r.review_id)}</small></div>${badge(r.state)}<a class="button small" href="/media?review_id=${encodeURIComponent(r.review_id)}">Inspect receipt and recovery</a></div>`).join('') || '<p>No unfinished uploads in this page of results.</p>'}<a href="/media">All creative and receipts</a></section><section class="panel"><h2>Report collection and delivery</h2>${(reports.reports ?? []).map(r => `<div class="token-row"><div><strong>${esc(r.config?.name ?? r.name ?? r.id)}</strong><small>${date(r.completed_at ?? r.created_at)}</small></div>${badge(r.state)}<a class="button small" href="/reporting-overview?report_id=${encodeURIComponent(r.id)}">Open snapshot</a></div>`).join('') || '<p>No report runs available.</p>'}<a href="/schedules">Schedules and delivery destinations</a></section>${session.administrator || session.workspaceRole === 'owner' ? '<section class="panel"><h2>Owner diagnostics</h2><p>Inspect a sanitized support bundle before downloading it.</p><button id="support-bundle" class="button">Prepare support bundle</button><div id="support-bundle-result"></div><a href="/settings">Policies, retention and deployment controls</a></section>' : ''}`;
  workspaceBind('#operations-refresh', () => renderWorkspacePage());
  workspaceBind('#support-bundle', async () => {
    const bundle = await workspaceCall('workspace', {action: 'support_bundle'});
    $('#support-bundle-result').innerHTML =
      recordDetails(bundle, 'Inspect support bundle') +
      '<button id="download-support" class="button">Download this bundle</button>';
    workspaceBind('#download-support', () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], {type: 'application/json'}));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'AMCP-support-bundle.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  });
}
async function renderScheduleCenter() {
  const b = await overviewCall({action: 'bootstrap'}),
    reader = session.workspaceRole === 'viewer';
  content.innerHTML += `<div class="dialog-actions"><a href="/reporting-overview" class="button primary">Create a report and schedule</a><a href="/operations" class="button">Delivery recovery</a></div><p class="notice">Delivery timezone controls the clock. Window timezone controls the calendar dates collected. Missed occurrences are coalesced; nonexistent daylight-saving times are skipped.</p><section class="panel">${
    b.schedules
      .map(s => {
        const d = b.destinations.find(d => d.id === s.destination_id);
        return `<article class="schedule-row"><div><h2>${esc(overviewLabel(s.config))}</h2>${badge(s.is_active ? 'active' : 'paused')}<p>${esc(s.schedule_kind)} · ${esc(s.timezone)}<br>${esc(reportWindowLabel(s.config.date_range))}<br>${esc(d?.name ?? 'Destination unavailable')} · ${esc(d?.tab_name ?? '')}<br>${s.is_active ? 'Next delivery: ' + date(s.next_run_at) : 'Paused'}</p>${s.error ? `<p class="error">${esc(s.error.message)}</p>` : ''}<div class="dialog-actions"><a class="button small" href="/reporting-overview?view_id=${encodeURIComponent(s.view_id)}&delivery=1">Edit report and schedule</a><button class="button small" data-schedule-preview="${esc(s.id)}">Preview next 3 windows</button>${s.last_report_id ? `<a class="button small" href="/reporting-overview?report_id=${encodeURIComponent(s.last_report_id)}">Last snapshot and delivery</a>` : ''}<button class="button small" data-schedule-toggle="${esc(s.id)}" ${reader ? 'disabled' : ''}>${s.is_active ? 'Pause' : 'Resume'}</button><button class="button small danger" data-schedule-delete="${esc(s.id)}" ${reader ? 'disabled' : ''}>Delete schedule</button></div><div id="schedule-preview-${esc(s.id)}"></div></div></article>`;
      })
      .join('') || blank('No scheduled deliveries. Save a report and choose its destination to create one.')
  }</section>`;
  workspaceBind('[data-schedule-preview]', async button => {
    const out = await overviewCall({action: 'preview_schedule', id: button.dataset.schedulePreview});
    $('#schedule-preview-' + button.dataset.schedulePreview).innerHTML = reviewTable(
      out.occurrences,
      'Next delivery times and collected dates',
    );
  });
  workspaceBind('[data-schedule-toggle]', async button => {
    const s = b.schedules.find(s => s.id === button.dataset.scheduleToggle);
    await overviewCall({
      action: s.is_active ? 'pause_schedule' : 'resume_schedule',
      id: s.id,
      expected_revision: s.revision,
      confirmed: true,
    });
    await renderWorkspacePage();
    toast(s.is_active ? 'Schedule paused.' : 'Schedule resumed with current access.');
  });
  workspaceBind('[data-schedule-delete]', async button => {
    const s = b.schedules.find(s => s.id === button.dataset.scheduleDelete);
    if (
      !(await confirmAction({
        title: 'Delete this schedule?',
        consequence: 'Pending deliveries stop. Saved reports, snapshots and the external spreadsheet remain available.',
        confirmLabel: 'Delete schedule',
      }))
    )
      return;
    await overviewCall({action: 'remove_schedule', id: s.id, expected_revision: s.revision, confirmed: true});
    await renderWorkspacePage();
  });
}
