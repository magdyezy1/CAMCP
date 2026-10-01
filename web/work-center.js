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
async function renderScheduleCenter() {
  const b = await overviewCall({action: 'bootstrap'}),
    reader = session.workspaceRole === 'viewer',
    selected = new URLSearchParams(location.search).get('schedule_id'),
    visible = selected ? b.schedules.filter(s => s.id === selected) : b.schedules;
  content.innerHTML += `<div class="dialog-actions"><a href="/reporting-overview" class="button primary">Create a report and schedule</a><a href="/operations" class="button">Delivery recovery</a><a href="/operations?kind=workbook_schedule" class="button">Workbook schedules</a></div><p class="notice">Delivery timezone controls the clock. Window timezone controls the calendar dates collected. Missed occurrences are coalesced; nonexistent daylight-saving times are skipped.</p><section class="panel">${
    visible
      .map(s => {
        const d = [...b.destinations, ...(b.file_destinations ?? [])].find(d => d.id === s.destination_id);
        return `<article class="schedule-row"><div><h2>${esc(overviewLabel(s.config))}</h2>${badge(s.is_active ? 'active' : 'paused')}<p>${esc(s.schedule_kind)} · ${esc(s.timezone)}<br>${esc(reportWindowLabel(s.config.date_range))}<br>${esc(d?.name ?? 'Destination unavailable')} · ${esc(d?.kind === 'report_files' ? d.formats.map(f => f.toUpperCase()).join(' + ') : (d?.tab_name ?? ''))}<br>${s.is_active ? 'Next delivery: ' + date(s.next_run_at) : 'Paused'}</p>${s.error ? `<p class="error">${esc(s.error.message)}</p>` : ''}<div class="dialog-actions"><a class="button small" href="/reporting-overview?view_id=${encodeURIComponent(s.view_id)}&delivery=1">Edit report and schedule</a><button class="button small" data-schedule-preview="${esc(s.id)}">Preview next 3 windows</button>${s.last_report_id ? `<a class="button small" href="/reporting-overview?report_id=${encodeURIComponent(s.last_report_id)}">Last snapshot and delivery</a>` : ''}<button class="button small" data-schedule-toggle="${esc(s.id)}" ${reader ? 'disabled' : ''}>${s.is_active ? 'Pause' : 'Resume'}</button><button class="button small danger" data-schedule-delete="${esc(s.id)}" ${reader ? 'disabled' : ''}>Delete schedule</button></div><div id="schedule-preview-${esc(s.id)}"></div></div></article>`;
      })
      .join('') ||
    blank(
      selected
        ? 'This schedule is no longer available.'
        : 'No scheduled deliveries. Save a report and choose its destination to create one.',
    )
  }</section>${selected ? '<a href="/schedules" class="button">All schedules</a>' : ''}`;
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
