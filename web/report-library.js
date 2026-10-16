'use strict';

function overviewLabel(config) {
  return [config.client_name, config.name].filter(Boolean).join(' · ');
}
/**
 * Whether the working client covers a saved report or template (SEC-08): every account it reads is one of the client's,
 * so a report that mixes clients is not offered while one client is chosen. One without accounts suits any client.
 */
function overviewInWorkingClient(record, b) {
  return (
    typeof inWorkingClient !== 'function' ||
    (record.config?.sources ?? []).every(s =>
      inWorkingClient(b.platforms.find(p => p.id === s.platform)?.gateway, s.account_id, s.connection_id),
    )
  );
}
function overviewLibraryOptions(b) {
  const selected = overviewState.selection;
  return (
    `<option value="">${esc(uiText('Open a saved report or template'))}</option>` +
    [
      ['view', uiText('Saved reports'), b.views],
      ['template', uiText('Templates'), b.templates ?? []],
    ]
      .map(
        ([kind, label, records]) =>
          `<optgroup label="${label}">${records
            // The open report stays listed whatever the working client.
            .filter(r => (selected?.kind === kind && selected.id === r.id) || overviewInWorkingClient(r, b))
            .sort((a, b) => overviewLabel(a.config).localeCompare(overviewLabel(b.config)))
            .map(
              r =>
                `<option value="${kind}:${esc(r.id)}" ${selected?.kind === kind && selected.id === r.id ? 'selected' : ''}>${esc(overviewLabel(r.config))}</option>`,
            )
            .join('')}</optgroup>`,
      )
      .join('')
  );
}
function renderOverviewLibrary(b, reader) {
  const s = overviewState.selection,
    template = s?.kind === 'template';
  return `<section class="panel report-library" aria-label="${esc(uiText('Report library'))}"><div class="report-actions"><label>${esc(uiText('Report library'))}<select id="overview-saved">${overviewLibraryOptions(b)}</select></label><button id="overview-new" class="button primary" ${reader ? 'disabled' : ''}>${esc(uiText('+ New report'))}</button><button id="overview-duplicate" class="button" ${reader ? 'disabled' : ''}>${esc(uiText('Duplicate setup'))}</button><button id="overview-template" class="button" ${reader ? 'disabled' : ''}>${esc(uiText('Save as new template'))}</button>${template ? `<button id="overview-use-template" class="button primary">${esc(uiText('Create report from template'))}</button>` : ''}${s ? `<button id="overview-delete" class="button danger" ${reader ? 'disabled' : ''}>${esc(template ? uiText('Delete template') : uiText('Delete report'))}</button>` : ''}<a class="button" href="/connections">${esc(uiText('+ Connect accounts'))}</a></div><p class="form-note" id="overview-definition-status" role="status">${template ? uiText('Editing a reusable template. Account selections, client names, destinations and schedules are excluded. Create a report from it to select a client and accounts.') : s ? uiText('Editing a saved report. Save changes to update its settings and any linked schedule. Completed snapshots retain their original data.') : uiText('New report setup. Give it a client and name, choose accounts, then save or pull a report.')}</p></section>`;
}
function renderUnavailableReportSources(config, bootstrap) {
  const missing = (config.sources ?? []).filter(
    s =>
      !bootstrap.platforms
        .find(p => p.id === s.platform)
        ?.accounts.some(a => a.connection_id === s.connection_id && a.account_id === s.account_id),
  );
  return missing.length
    ? `<div class="notice"><strong>${esc(uiText('Some saved accounts are unavailable'))}</strong><p>${esc(uiText('Reconnect the saved login, or explicitly uncheck an account to remove it from this report.'))}</p>` +
        missing
          .map(
            s =>
              `<label class="report-account"><input type="checkbox" data-report-account="${esc(s.platform)}" value="${esc(JSON.stringify([s.platform, s.connection_id, s.account_id]))}" checked><span>${esc(pretty(s.platform))} · ${esc(s.account_id)}<small>${esc(uiText('Login:'))} ${esc(s.connection_id)}</small></span></label>`,
          )
          .join('') +
        `<a href="/connections">${esc(uiText('Manage connections'))}</a></div>`
    : '';
}
function reportWindowLabel(range) {
  if (range?.preset === 'last_complete_week') return uiText('Previous complete week (Monday–Sunday)');
  if (range?.preset === 'last_complete_month') return uiText('Previous complete calendar month');
  if (range?.preset)
    return (
      uiText('Last {days} complete days', {days: range.days ?? 7}) +
      (range.offset_days ? ' · ' + uiText('skip {days} recent days', {days: range.offset_days}) : '')
    );
  return reportRangeLabel(range);
}
function reportWindowOptions(range, custom = true) {
  const value = range?.preset ?? 'custom';
  return [
    ['last_complete_days', uiText('Last complete days')],
    ['last_complete_week', uiText('Previous complete week')],
    ['last_complete_month', uiText('Previous calendar month')],
    ['custom', uiText('Custom dates')],
  ]
    .filter(([v]) => custom || v !== 'custom')
    .map(([v, label]) => `<option value="${v}" ${value === v ? 'selected' : ''}>${label}</option>`)
    .join('');
}
function renderReportSetupFields(c) {
  const range = c.date_range,
    zone = range.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `<div class="report-control-top"><label class="report-name">${esc(uiText('Client name'))}<input name="client_name" value="${esc(c.client_name ?? '')}" maxlength="100" placeholder="${esc(uiText('e.g. Client A'))}"></label><label class="report-name">${esc(uiText('Report name'))}<input name="name" value="${esc(c.name)}" maxlength="100" required></label><label>${esc(uiText('Group data by'))}<select name="grain">${[
    ['total', uiText('Whole period')],
    ['daily', uiText('Day')],
    ['weekly', uiText('Week (Monday–Sunday)')],
    ['monthly', uiText('Calendar month')],
  ]
    .map(([v, label]) => `<option value="${v}" ${(c.grain ?? 'total') === v ? 'selected' : ''}>${label}</option>`)
    .join(
      '',
    )}</select></label><label>${esc(uiText('Date window'))}<select name="rangeMode" id="report-range-mode">${reportWindowOptions(range)}</select></label><div id="report-rolling" class="report-date-fields"><label data-rolling-days>${esc(uiText('Days'))}<input type="number" name="days" min="1" max="366" value="${range.days ?? 7}"></label><label data-rolling-days>${esc(uiText('Skip recent days'))}<input name="offset_days" type="number" min="0" max="90" value="${range.offset_days ?? 0}" title="${esc(uiText('Exclude recent days to allow conversions to mature'))}"></label><label>${esc(uiText('Window timezone'))}<input name="timezone" value="${esc(zone)}" list="report-timezones"></label></div><div id="report-dates" class="report-date-fields"><label>${esc(uiText('Set a full month'))}<input type="month" id="report-calendar-month" aria-label="${esc(uiText('Reporting month and year'))}"></label><label>${esc(uiText('From'))}<input type="date" name="since" value="${esc(range.since ?? new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))}"></label><label>${esc(uiText('Through'))}<input type="date" name="until" value="${esc(range.until ?? new Date(Date.now() - 86400000).toISOString().slice(0, 10))}"></label></div><p id="report-range-summary" class="report-date-summary" aria-live="polite"></p><p class="form-note">${esc(uiText('Grouping controls the rows in your report. Delivery frequency is set separately in Sheets & schedules. Each period is collected directly from the provider; longer ranges and more accounts take more requests.'))}</p></div>`;
}

function overviewGranularityFields(platform, config = {}) {
  const levels = platform.entity_levels ?? [{id: 'campaign', label: 'Campaign / resource'}],
    level = config.level ?? 'campaign',
    options = config.report_options ?? {},
    // RPT-04: Meta and Snapchat campaign rows can use the detailed attribution windows (a campaign profile).
    campaignProfile = level === 'campaign' && config.report_options !== undefined;
  const windows =
    platform.id === 'meta'
      ? `<label>${esc(uiText('Click attribution window'))}<select data-report-click-window="${esc(platform.id)}"><option value="7d_click" ${options.attribution_windows?.includes('7d_click') || !options.attribution_windows ? 'selected' : ''}>7d_click</option><option value="1d_click" ${options.attribution_windows?.includes('1d_click') ? 'selected' : ''}>1d_click</option><option value="28d_click" ${options.attribution_windows?.includes('28d_click') ? 'selected' : ''}>28d_click</option><option value="" ${options.attribution_windows && !options.attribution_windows.some(w => /_click$/.test(w)) ? 'selected' : ''}>${esc(uiText('No click window'))}</option></select></label><label class="check"><input type="checkbox" data-report-view-window="${esc(platform.id)}" ${options.attribution_windows?.includes('1d_view') ? 'checked' : ''}> 1d_view</label><label class="check"><input type="checkbox" data-report-engaged-view-window="${esc(platform.id)}" ${options.attribution_windows?.includes('1d_ev') ? 'checked' : ''}> 1d_ev (${esc(uiText('engaged view'))})</label>`
      : platform.id === 'snapchat'
        ? `<label>${esc(uiText('Swipe attribution window'))}<select data-report-swipe="snapchat">${['1_DAY', '7_DAY', '28_DAY'].map(value => `<option value="${value}" ${(options.swipe_up_attribution_window ?? '28_DAY') === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>${esc(uiText('View attribution window'))}<select data-report-view="snapchat">${['none', '1_HOUR', '3_HOUR', '6_HOUR', '1_DAY', '7_DAY'].map(value => `<option value="${value}" ${(options.view_attribution_window ?? '1_DAY') === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>`
        : '';
  const measurement =
    platform.id === 'meta'
      ? `<label>${esc(uiText('Exact Meta result action'))}<input data-report-result="${esc(platform.id)}" value="${esc(options.result_action_type ?? 'purchase')}" pattern="[a-z][a-z0-9_.]{0,159}" maxlength="160" required></label><p class="form-note">${esc(uiText('Select one native action, such as purchase or lead. Overlapping conversion aliases are never added together.'))}</p>`
      : platform.id === 'snapchat'
        ? ''
        : `<label>${esc(uiText('Declared conversion attribution'))}<input data-report-attribution="${esc(platform.id)}" value="${esc(options.attribution ?? 'unknown')}" maxlength="200" required></label>`;
  const profile =
    windows && levels.length > 1
      ? `<label class="check" data-report-campaign-profile-field="${esc(platform.id)}" ${level === 'campaign' ? '' : 'hidden'}><input type="checkbox" data-report-campaign-profile="${esc(platform.id)}" ${campaignProfile ? 'checked' : ''}> ${esc(uiText('Use explicit attribution windows for campaign rows'))}</label><fieldset data-report-windows="${esc(platform.id)}" ${level === 'campaign' && !campaignProfile ? 'hidden disabled' : ''}><legend>${esc(uiText('Attribution windows'))}</legend>${windows}<p class="form-note">${esc(uiText('Detailed levels always use these windows. Campaign rows use them only when selected; otherwise they keep the provider default attribution.'))}</p></fieldset>`
      : '';
  return `<label>${esc(uiText('Reporting level'))}<select data-report-level="${esc(platform.id)}">${levels.map(item => `<option value="${esc(item.id)}" ${item.id === level ? 'selected' : ''}>${esc(uiText(item.label))}</option>`).join('')}</select></label>${profile}${levels.length > 1 ? `<fieldset data-report-detail="${esc(platform.id)}" ${level === 'campaign' ? 'hidden disabled' : ''}><legend>${esc(uiText('Detailed measurement settings'))}</legend>${measurement}<label class="check"><input type="checkbox" data-report-complete-window="${esc(platform.id)}" ${options.complete_window ? 'checked' : ''}> ${esc(uiText('I have checked the reporting window is complete'))}</label><p class="form-note">${esc(uiText('Detailed reports collect verified native daily rows and add only additive metrics. Missing values stay unknown; multi-day reach and frequency stay unavailable. Clear additional native metrics before using a detailed level.'))}</p>${platform.id === 'linkedin' ? `<p class="form-note">${esc(uiText('LinkedIn campaigns are the native middle level; its ad-level report uses sponsored creatives. No ad-set hierarchy is invented.'))}</p>` : ''}</fieldset>` : `<p class="form-note">${esc(uiText('This source currently supports campaign or measurement-context rows in this report builder.'))}</p>`}`;
}
/** RPT-04: the Meta or Snapchat attribution windows selected in the report form. */
function overviewAttributionProfile(platform) {
  return platform === 'meta'
    ? {
        attribution_windows: [
          $('[data-report-click-window="meta"]').value,
          ...($('[data-report-view-window="meta"]').checked ? ['1d_view'] : []),
          ...($('[data-report-engaged-view-window="meta"]')?.checked ? ['1d_ev'] : []),
        ].filter(Boolean),
      }
    : {
        swipe_up_attribution_window: $('[data-report-swipe="snapchat"]').value,
        view_attribution_window: $('[data-report-view="snapchat"]').value,
      };
}
function overviewGranularityConfig(platform) {
  const level = $('[data-report-level="' + CSS.escape(platform) + '"]')?.value ?? 'campaign';
  if (level === 'campaign')
    return $('[data-report-campaign-profile="' + CSS.escape(platform) + '"]')?.checked
      ? {report_options: overviewAttributionProfile(platform)}
      : {};
  const complete_window = $('[data-report-complete-window="' + CSS.escape(platform) + '"]').checked;
  const report_options =
    platform === 'meta'
      ? {
          complete_window,
          result_action_type: $('[data-report-result="meta"]').value,
          ...overviewAttributionProfile('meta'),
        }
      : platform === 'snapchat'
        ? {complete_window, ...overviewAttributionProfile('snapchat')}
        : {complete_window, attribution: $('[data-report-attribution="' + CSS.escape(platform) + '"]').value};
  return {level, report_options};
}
function updateOverviewGranularity() {
  document.querySelectorAll('[data-report-windows]').forEach(fieldset => {
    const id = fieldset.dataset.reportWindows,
      campaign = $('[data-report-level="' + CSS.escape(id) + '"]').value === 'campaign',
      profile = $('[data-report-campaign-profile="' + CSS.escape(id) + '"]');
    profile.closest('[data-report-campaign-profile-field]').hidden = !campaign;
    fieldset.hidden = campaign && !profile.checked;
    fieldset.disabled = fieldset.hidden;
  });
  document.querySelectorAll('[data-report-detail]').forEach(fieldset => {
    const detailed = $('[data-report-level="' + CSS.escape(fieldset.dataset.reportDetail) + '"]').value !== 'campaign';
    fieldset.hidden = !detailed;
    fieldset.disabled = !detailed;
  });
  document.querySelectorAll('[data-report-parent]').forEach(input => {
    const key = input.dataset.reportParent,
      selected = [...document.querySelectorAll('[data-report-account]:checked')].some(control => control.value === key),
      required = selected && $('[data-report-level="snapchat"]')?.value === 'adset';
    input.disabled = !required;
    input.required = required;
    input.closest('[data-report-parent-field]').hidden = !required;
  });
}
function resetOverviewSelection() {
  clearTimeout(pollTimer);
  clearTimeout(deliveryTimer);
  overviewState.loadSequence = (overviewState.loadSequence ?? 0) + 1;
  overviewState.deliveryDraft = null;
  overviewState.selection = null;
  overviewState.destinationId = null;
  overviewState.exportDestinationId = null;
  overviewState.report = null;
  overviewState.page = 0;
  overviewState.dirty = false;
}
function selectOverviewDefinition(record, kind = 'view') {
  resetOverviewSelection();
  overviewState.selection = {id: record.id, revision: record.revision, kind};
  overviewState.config = {...overviewDefault(), ...structuredClone(record.config)};
  overviewState.destinationId = record.destination_id ?? null;
}
/**
 * Leaving unsaved report edits asks first, in AMCP's own confirmation instead of the browser's (EXP-04 A). Choosing a
 * tab for a one-off export is not an edit, so it never asks.
 */
async function overviewMayLeave() {
  return (
    !overviewState.dirty ||
    (await confirmAction({
      title: uiText('Discard the unsaved changes to this report setup?'),
      consequence: uiText(
        'Your unsaved changes to this report’s setup are lost. Saved reports, snapshots and schedules are kept.',
      ),
      confirmLabel: uiText('Discard changes'),
    }))
  );
}
async function newOverviewReport(config = overviewDefault()) {
  resetOverviewSelection();
  overviewState.config = config;
  history.replaceState({}, '', '/reporting-overview');
  await renderReportingOverview();
  $('[name="name"]')?.focus();
}
async function saveOverviewDefinition(asTemplate = false) {
  if (!$('#overview-config').reportValidity()) return;
  const config = overviewConfig(),
    selection = asTemplate ? null : overviewState.selection,
    kind = asTemplate ? 'template' : (selection?.kind ?? 'view');
  const saved = await overviewCall({
    action: kind === 'template' ? 'save_template' : 'save',
    config,
    ...(selection ? {id: selection.id, expected_revision: selection.revision} : {}),
    ...(kind === 'view' && overviewState.destinationId ? {destination_id: overviewState.destinationId} : {}),
    confirmed: true,
  });
  selectOverviewDefinition(saved, kind);
  await renderReportingOverview();
  toast(
    kind === 'template' ? uiText('Template saved. Use it to create separate client reports.') : uiText('Report saved.'),
  );
}
function renderOverviewHistory(history, reader) {
  return (
    `<div class="panel-header"><h2>${esc(uiText('Recent snapshots'))}</h2><span class="muted">${esc(uiText('Collected results with their original settings and source evidence'))}</span></div>` +
    (history
      .map(
        r =>
          `<div class="report-history-item"><button class="report-history-row" data-report-open="${esc(r.id)}"><span><strong dir="auto" data-native>${esc(overviewLabel(r.config))}</strong><small>${esc(reportRangeLabel(r.config.date_range))} · ${esc(reportLabel(r.config.grain ?? 'total'))} · ${date(r.created_at)}</small></span><span class="status">${reportDisplayState(r)}</span><span>${esc(uiPlural(r.row_count ?? 0, '{count} row ↗', '{count} rows ↗'))}</span></button><button class="button small danger" data-report-delete="${esc(r.id)}" aria-label="${esc(uiText('Delete'))} · ${esc(overviewLabel(r.config))}" ${reader ? 'disabled' : ''}>${esc(uiText('Delete'))}</button></div>`,
      )
      .join('') || `<p class="empty">${esc(uiText('Choose accounts and pull your first report.'))}</p>`)
  );
}
async function openOverviewHistory(id) {
  if (!(await overviewMayLeave())) return;
  resetOverviewSelection();
  await loadOverviewReport(id);
  const r = overviewState.report;
  if (!r || r.id !== id) return;
  overviewState.config = {...overviewDefault(), ...structuredClone(r.config)};
  overviewState.destinationId = r.destination_id ?? null;
  await renderReportingOverview();
  $('#overview-results')?.scrollIntoView({block: 'start'});
}
function bindOverviewHistory() {
  authBind('.report-history [data-report-open]', async b => openOverviewHistory(b.dataset.reportOpen));
  authBind('.report-history [data-report-delete]', async b => {
    const r = overviewState.history.find(r => r.id === b.dataset.reportDelete);
    if (
      !r ||
      !(await confirmAction({
        title: uiText('Delete the collected snapshot “{name}”?', {name: overviewLabel(r.config)}),
        consequence: uiText(
          'Its active jobs will stop. Saved report setups, other snapshots and external spreadsheets are kept.',
        ),
        confirmLabel: uiText('Delete snapshot'),
      }))
    )
      return;
    try {
      await overviewCall({action: 'delete_report', id: r.id, confirmed: true});
    } catch (e) {
      // A snapshot whose Sheets delivery is unconfirmed is deleted only together with an audited tab release.
      if (e.code !== 'SHEETS_DELIVERY_UNRESOLVED') throw e;
      if (
        !(await confirmAction({
          title: uiText('Release the report tab and delete “{name}”?', {name: overviewLabel(r.config)}),
          consequence: uiText(
            'Google did not confirm this snapshot’s Sheets delivery. Deleting it releases that report tab for newer reports. The release is recorded in Activity.',
          ),
          confirmLabel: uiText('Release tab & delete'),
        }))
      )
        return;
      await overviewCall({action: 'delete_report', id: r.id, resolution: 'abandon', confirmed: true});
    }
    if (overviewState.report?.id === r.id) {
      clearTimeout(pollTimer);
      overviewState.loadSequence++;
      overviewState.report = null;
    }
    // RPT-05: a deleted snapshot's deep link is removed, so a reload does not reopen it.
    if (new URLSearchParams(location.search).get('report_id') === r.id)
      history.replaceState(
        {},
        '',
        '/reporting-overview' +
          (overviewState.selection?.kind === 'view'
            ? '?view_id=' + encodeURIComponent(overviewState.selection.id)
            : ''),
      );
    overviewState.config = overviewConfig();
    await renderReportingOverview();
    toast(uiText('Snapshot deleted.'));
  });
}
function bindOverviewLibrary() {
  $('#overview-config').addEventListener('input', () => {
    overviewState.dirty = true;
    overviewState.config = overviewConfig();
  });
  $('#overview-config').addEventListener('change', () => {
    overviewState.dirty = true;
    overviewState.config = overviewConfig();
  });
  authBind('#overview-new', async () => {
    if (await overviewMayLeave()) await newOverviewReport();
  });
  authBind('#overview-duplicate', async () => {
    const c = overviewConfig();
    await newOverviewReport({...c, name: (c.name + ' copy').slice(0, 100)});
    toast(uiText('New copy. Choose its client, destination and schedule.'));
  });
  authBind('#overview-template', async () => saveOverviewDefinition(true));
  authBind('#overview-use-template', async () => {
    const c = overviewConfig();
    await newOverviewReport({...c, client_name: '', sources: []});
    toast(uiText('Choose the client and accounts for this report.'));
  });
  authBind('#overview-delete', async () => {
    const s = overviewState.selection;
    if (!s) return;

    if (
      !(await confirmAction({
        title:
          s.kind === 'template'
            ? uiText('Delete the template “{name}”?', {name: overviewState.config.name})
            : uiText('Delete the saved report “{name}”?', {name: overviewState.config.name}),
        consequence:
          s.kind === 'view'
            ? uiText(
                'Its schedule and pending deliveries will stop. Collected snapshots and external spreadsheets are kept.',
              )
            : uiText('Reports already created from it are kept.'),
        confirmLabel: s.kind === 'template' ? uiText('Delete template') : uiText('Delete saved report'),
      }))
    )
      return;
    await overviewCall({
      action: s.kind === 'template' ? 'delete_template' : 'delete_view',
      id: s.id,
      expected_revision: s.revision,
      confirmed: true,
    });
    await newOverviewReport();
    toast(s.kind === 'template' ? uiText('Template deleted.') : uiText('Saved report deleted.'));
  });
  $('#overview-saved').addEventListener('change', async e => {
    const current = overviewState.selection,
      chosen = e.target.value;
    if (!(await overviewMayLeave())) {
      e.target.value = current ? current.kind + ':' + current.id : '';
      return;
    }
    e.target.value = chosen;
    const [kind, id] = e.target.value.split(':'),
      r = (kind === 'template' ? overviewState.bootstrap.templates : overviewState.bootstrap.views)?.find(
        r => r.id === id,
      );
    if (!r) return;
    try {
      selectOverviewDefinition(r, kind);
      history.replaceState(
        {},
        '',
        '/reporting-overview' + (kind === 'view' ? '?view_id=' + encodeURIComponent(r.id) : ''),
      );
      await renderReportingOverview();
    } catch (error) {
      $('#auth-error').textContent = error.message;
    }
  });
  bindOverviewHistory();
}
