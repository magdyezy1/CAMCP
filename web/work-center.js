'use strict';
// DOC-03: Home names each capability (src/capabilities.ts) by what it does for the owner and says what verified means;
// the capability's name, coverage, MCP tool and evidence state stay under Technical details (web/workspace.js). A
// capability without an outcome here shows its name.
const homeCapabilityCopy = {
  note: 'Each is tested against simulated platforms. It counts as verified on one of your accounts only after AMCP reads the result back there.',
  outcomes: {
    campaign_builder: 'Prepare campaigns that start paused',
    readiness: 'Check that accounts are ready before a launch',
    media_library: 'Keep your creative in one library',
    write_verification: 'Check that each approved change took effect',
    reporting: 'Report results from the platforms’ own numbers',
    optimization: 'Get suggestions only when the data supports them',
    profiles: 'Reuse each client’s naming, links and templates',
    capabilities: 'See what is verified on each account',
  },
};
// The operation kinds Home names, with the Operations labels (OPS-06). Home does not load the Operations page script.
function homeOperationKind(kind) {
  switch (kind) {
    case 'campaign':
      return uiText('Campaign plan');
    case 'upload':
      return uiText('Media upload');
    case 'report':
      return uiText('Report snapshot');
    case 'export':
      return uiText('Export job');
    case 'schedule':
      return uiText('Report schedule');
    case 'incident':
      return uiText('Incident');
    case 'workbook_report':
      return uiText('Workbook report');
    case 'workbook_schedule':
      return uiText('Workbook schedule');
    case 'write':
      return uiText('Reviewed change');
    case 'notice':
      return uiText('Monitor email notice');
    case 'connection':
      return uiText('Connection login');
    default:
      return uiText('Work');
  }
}
/**
 * The body of Home's "Needs attention" panel (V2-WEB-03): the feed's records, or what to say instead. `attention` is the
 * Operations page, `{error}` when it could not be read, or `{pending: true}` while it is still on its way: Home does not
 * wait for it, so the panel draws a skeleton and fills with this when the answer arrives (fillSection in web/workspace.js).
 */
function homeAttention(attention) {
  if (attention?.pending)
    return html`<div class="work-links">${typeof AmcpUI === 'object' ? AmcpUI.skeleton({shape: 'text', lines: 3}) : html`<p class="muted" role="status">${uiText('Loading…')}</p>`}</div>`;
  // The feed's original-record path is internal; anything else opens Operations instead.
  const work = op =>
      html`<a href="${/^\/(?![/\\])/.test(op.website_path ?? '') ? op.website_path : '/operations?state=attention'}"><strong dir="auto" data-native>${op.name}</strong><small>${homeOperationKind(op.kind)} · ${raw(badge(op.state))}${op.updated_at ? ' · ' + date(op.updated_at) : ''}</small></a>`,
    empty = html`<p>${uiText('Nothing needs attention: no campaign plans, uploads, reports, exports, schedules, incidents, workbook runs, reviewed changes, email notices or connection logins.')}</p>`,
    items = Array.isArray(attention?.operations) ? attention.operations : null,
    body = items
      ? items.length
        ? items.map(work)
        : attention.has_more
          ? html`<p>${uiText('None of the most recent records needs attention. Open Operations to check older ones.')}</p>`
          : empty
      : attention?.error
        ? html`<p class="error" role="alert">${uiText('Could not load the work that needs attention. Open Operations to see it.')}</p>`
        : empty;
  return html`<div class="work-links">${body}</div>${items?.length ? html`<p class="form-note">${uiText('The most recent work that needs attention. Operations reads a bounded number of records per page and lists the rest.')}</p>` : ''}`;
}
/**
 * Home (OPS-06): what needs a person comes from the Operations feed's own classifier (an `operations` page with state
 * `attention`), so a plan in `attention`, an uncertain upload or write, a failed export, an open incident, a failed
 * notice or a login to reauthorize all appear here; the campaign list stays for continuing recent work. Before, Home
 * kept its own list of plan states and missed every plan the runner put in `attention`.
 */
function workHome(d, accounts, attention) {
  const recent = [...d.campaigns].sort((a, b) => b.updated_at - a.updated_at).slice(0, 8);
  // A plan's or record's name is the person's own text: it keeps its direction and stays literal (WEB-05, design review
  // 2026-10; the Arabic Home counted every English plan name as untranslated).
  const card = c =>
    `<a href="/campaigns?id=${encodeURIComponent(c.id)}"><strong dir="auto" data-native>${esc(c.name)}</strong><small>${badge(c.state)} · ${date(c.updated_at)}</small></a>`;
  const disabled = (d.connections ?? []).filter(c => c.enabled === false).length;
  return (
    header(
      uiText('Home'),
      esc(uiText(routeSubtitle('/dashboard'))),
      // One primary action (WEB-06, design review 2026-10): a plan needs a connected account, so until one is
      // connected the emphasized action is Set up connections below.
      `<a class="button${accounts.length ? ' primary' : ''}" href="/campaigns#campaign-create">${esc(uiText('New campaign plan'))}</a>`,
    ) +
    (d.writes_paused
      ? `<div class="notice warning" role="status"><strong>${esc(uiText('Provider writes are paused'))}</strong><p>${esc(d.writes_paused.reason)}</p><a href="/settings#owner-write-pause">${esc(uiText('View operating controls'))}</a></div>`
      : '') +
    (disabled
      ? `<div class="notice" role="status"><p>${esc(uiText('Connection logins turned off: {count}. Reads and reviewed changes through them stop until an administrator turns them on.', {count: disabled}))}</p><a href="/connections">${esc(uiText('Manage connections'))}</a></div>`
      : '') +
    (accounts.length
      ? ''
      : `<section class="panel"><h2>${esc(uiText('Connect your first account'))}</h2><p>${esc(uiText('Choose a platform login and the accounts your workspace can use. Readiness checks will explain the next step.'))}</p><a href="/connections" class="button primary">${esc(uiText('Set up connections'))}</a></section>`) +
    `<section class="panel"><div class="panel-header"><h2>${esc(uiText('Needs attention'))}</h2><a href="/operations?state=attention">${esc(uiText('All operations'))}</a></div><div id="home-attention"${attention?.pending ? ' aria-busy="true"' : ''}>${homeAttention(attention)}</div></section><section class="panel"><div class="panel-header"><h2>${esc(uiText('Continue recent work'))}</h2><a href="/campaigns">${esc(uiText('All plans'))}</a></div><div class="work-links">${
      recent.map(card).join('') ||
      emptyBlock({
        title: uiText('No saved campaign plans yet'),
        body: uiText('Your saved campaign plans will appear here.'),
        action: {label: uiText('New campaign plan'), href: '/campaigns#campaign-create', variant: 'secondary'},
      })
    }</div></section><div class="quick-actions"><a href="/media"><span>${glyph('media')}</span><div><strong>${esc(uiText('Prepare creative'))}</strong><small>${esc(uiText('Sources, variants and upload receipts'))}</small></div></a><a href="/reporting-overview"><span>${glyph('report')}</span><div><strong>${esc(uiText('Build a report'))}</strong><small>${esc(uiText('Source evidence and client deliveries'))}</small></div></a><a href="/capabilities"><span>${glyph('connection')}</span><div><strong>${esc(uiText('Check capabilities'))}</strong><small>${esc(uiText('Account prerequisites and action contracts'))}</small></div></a></div>`
  );
}
async function renderScheduleCenter() {
  const b = await overviewCall({action: 'bootstrap'}),
    reader = session.workspaceRole === 'viewer',
    selected = new URLSearchParams(location.search).get('schedule_id'),
    visible = selected ? b.schedules.filter(s => s.id === selected) : b.schedules;
  content.innerHTML += `<div class="dialog-actions"><a href="/reporting-overview" class="button primary">${esc(uiText('Create a report and schedule'))}</a><a href="/operations" class="button">${esc(uiText('Delivery recovery'))}</a><a href="/operations?kind=workbook_schedule" class="button">${esc(uiText('Local report schedules'))}</a></div><p class="notice">${esc(uiText('Delivery timezone controls the clock. Window timezone controls the calendar dates collected. Missed occurrences are coalesced. A nonexistent daylight-saving time runs at the first valid time after the change; a repeated time runs once.'))}</p><section class="panel">${
    visible
      .map(s => {
        const d = [...b.destinations, ...(b.file_destinations ?? [])].find(d => d.id === s.destination_id);
        return `<article class="schedule-row"><div><h2>${esc(overviewLabel(s.config))}</h2>${badge(!s.is_active ? 'paused' : ['failed', 'retrying'].includes(s.last_delivery?.state) || s.schedule_warning ? 'attention' : 'active')}<p>${esc(reportLabel(s.schedule_kind))} · ${esc(s.timezone)}<br>${esc(reportWindowLabel(s.config.date_range))}<br>${esc(d?.name ?? uiText('Destination unavailable'))} · ${esc(d?.kind === 'report_files' ? d.formats.map(f => f.toUpperCase()).join(' + ') : (d?.tab_name ?? ''))}<br>${s.is_active ? esc(uiText('Next delivery: ') + uiScheduleTime(s.next_run_at, s.timezone)) : uiText('Paused')}</p>${s.error ? `<p class="error">${esc(uiText(s.error.message))}</p>` : ''}${s.schedule_warning ? `<p class="notice">${esc(uiText(s.schedule_warning.message))}</p>` : ''}${s.last_delivery ? `<p>${scheduleDeliveryHealth(s, reader)}</p>` : ''}<div class="dialog-actions"><a class="button small" href="/reporting-overview?view_id=${encodeURIComponent(s.view_id)}&delivery=1">${esc(uiText('Edit report and schedule'))}</a><button class="button small" data-schedule-preview="${esc(s.id)}">${esc(uiText('Preview next 3 windows'))}</button>${s.last_report_id ? `<a class="button small" href="/reporting-overview?report_id=${encodeURIComponent(s.last_report_id)}">${esc(uiText('Last snapshot and delivery'))}</a>` : ''}<button class="button small" data-schedule-toggle="${esc(s.id)}" ${reader ? 'disabled' : ''}>${s.is_active ? uiText('Pause') : uiText('Resume')}</button><button class="button small danger" data-schedule-delete="${esc(s.id)}" ${reader ? 'disabled' : ''}>${esc(uiText('Delete schedule'))}</button></div><div id="schedule-preview-${esc(s.id)}"></div></div></article>`;
      })
      .join('') ||
    blank(
      selected
        ? uiText('This schedule is no longer available.')
        : uiText('No scheduled deliveries. Save a report and choose its destination to create one.'),
    )
  }</section>${selected ? `<a href="/schedules" class="button">${esc(uiText('All schedules'))}</a>` : ''}`;
  workspaceBind('[data-schedule-preview]', async button => {
    const out = await overviewCall({action: 'preview_schedule', id: button.dataset.schedulePreview});
    // EXP-04 B: a readable table in the delivery zone, the viewer's zone and the window's zone, not a raw dump; a
    // time moved out of a daylight-saving gap is labeled (EXP-02).
    $('#schedule-preview-' + button.dataset.schedulePreview).innerHTML = scheduleOccurrencesTable(
      out,
      uiText('Next delivery times and collected dates'),
    );
  });
  workspaceBind('[data-schedule-delivery-retry]', async button => {
    await overviewCall({action: 'retry', id: button.dataset.scheduleDeliveryRetry, confirmed: true});
    await renderWorkspacePage();
    toast(uiText('Delivery queued again.'));
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
    toast(s.is_active ? uiText('Schedule paused.') : uiText('Schedule resumed with current access.'));
  });
  workspaceBind('[data-schedule-delete]', async button => {
    const s = b.schedules.find(s => s.id === button.dataset.scheduleDelete);
    if (
      !(await confirmAction({
        title: uiText('Delete this schedule?'),
        consequence: uiText(
          'Pending deliveries stop. Saved reports, snapshots and the external spreadsheet remain available.',
        ),
        confirmLabel: uiText('Delete schedule'),
      }))
    )
      return;
    await overviewCall({action: 'remove_schedule', id: s.id, expected_revision: s.revision, confirmed: true});
    await renderWorkspacePage();
  });
}
