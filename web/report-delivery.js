'use strict';

function rememberDeliveryDraft() {
  const form = $('#report-schedule');
  if (form) overviewState.deliveryDraft = Object.fromEntries(new FormData(form));
}
function deliveryWindowControls() {
  const form = $('#report-schedule');
  if (!form) return;
  const kind = form.elements.schedule_kind.value,
    days = form.elements.preset.value === 'last_complete_days';
  for (const input of ['hour', 'weekday', 'day']) {
    const visible = input === 'hour' ? kind !== 'hourly' : input === 'weekday' ? kind === 'weekly' : kind === 'monthly';
    form.elements[input].closest('label').hidden = !visible;
    form.elements[input].disabled = !visible;
  }
  for (const input of ['days', 'offset_days']) {
    form.elements[input].closest('label').hidden = !days;
    form.elements[input].disabled = !days;
  }
}
async function renderReportDelivery(mode = 'delivery') {
  const sheetsNow = mode === 'sheets_now';
  const generation = navigationGeneration,
    identity = identityGeneration,
    sequence = (overviewState.deliverySequence = (overviewState.deliverySequence ?? 0) + 1);
  const present = () => generation === navigationGeneration && identity === identityGeneration;
  const current = () => present() && sequence === overviewState.deliverySequence;
  const b = await overviewCall({action: 'bootstrap'}),
    r = overviewState.report,
    config = structuredClone((sheetsNow ? r?.config : overviewState.config) ?? overviewDefault()),
    dialog = $('#report-delivery-dialog');
  if (!current()) return;
  const reader = session.workspaceRole === 'viewer',
    admin = !['operator', 'viewer'].includes(session.workspaceRole),
    selection = overviewState.selection;
  const view = selection?.kind === 'view' ? b.views.find(v => v.id === selection.id) : null,
    existing = b.schedules.find(s => s.id === view?.schedule_id);
  overviewState.bootstrap = b;
  updateSavedReportChoices(b);
  const draft = overviewState.deliveryDraft ?? {},
    sc = existing?.schedule_config ?? {},
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const formValues = {
    report_name: config.name,
    partial_delivery: config.partial_delivery ?? 'allow_marked',
    schedule_kind: existing?.schedule_kind ?? 'daily',
    hour: sc.hour ?? 8,
    minute: sc.minute ?? 0,
    weekday: sc.weekday ?? 1,
    day: sc.day ?? 1,
    timezone: existing?.timezone ?? config.date_range.timezone ?? zone,
    preset: config.date_range.preset ?? 'last_complete_days',
    days: config.date_range.days ?? 7,
    offset_days: config.date_range.offset_days ?? 0,
    window_timezone: config.date_range.timezone ?? zone,
    ...draft,
  };
  const options = b.sheets_connections
      .filter(c => c.enabled)
      .map(c => `<option value="${esc(c.id)}">${esc(c.label)}</option>`)
      .join(''),
    accounts = deliveryAccountSummary(config, b),
    tabDefault = ('AMCP ' + overviewLabel(config)).replace(/[:\\/?*\[\]]/g, ' ').slice(0, 80);
  const destinations = sheetsNow ? b.destinations : [...(b.file_destinations ?? []), ...b.destinations];
  if (sheetsNow && !b.destinations.some(d => d.id === overviewState.destinationId)) overviewState.destinationId = '';
  $('#report-delivery-content').innerHTML = `
  <div class="dialog-heading"><div><p class="eyebrow">${esc(uiText('REPORT DELIVERY'))}</p><h2 id="report-delivery-title">${sheetsNow ? uiText('Export now to Google Sheets') : existing ? uiText('Edit schedule') : uiText('Report destinations & schedules')}</h2></div><button class="icon-button" id="report-delivery-close" aria-label="${esc(uiText('Close report delivery'))}">×</button></div>
  <div class="delivery-report-context"><strong>${esc(overviewLabel(config))}</strong><p>${accounts.length ? accounts.map(esc).join(`<br>`) : uiText('Choose platform accounts in Reporting overview first.')}<br>${esc(uiText('Data grouping:'))} ${esc(reportLabel(config.grain ?? 'total'))}</p></div>
  <div id="delivery-status" role="status" aria-live="polite"></div>
  <section class="delivery-section"><h3>${esc(sheetsNow ? uiText('Choose your Google Sheets destination') : uiText('1. Choose a report destination'))}</h3><p>${esc(sheetsNow ? uiText('Export the collected snapshot below, including its entity IDs, dates and source evidence. Only this report’s owned tab is replaced; other spreadsheet tabs are kept. No schedule is created.') : uiText("Store client PDF/Excel files in this workspace or replace this report's owned Google Sheets tab."))}</p>
   ${sheetsNow && r ? `<p class="notice">${esc(uiText('Snapshot “{name}” · {count} rows · {state}', {name: r.config.name, count: r.row_count, state: reportDisplayState(r)}))}${r.state === 'partial' ? '<br>' + esc(uiText('This snapshot is partial. Failed sources and missing metrics remain marked in the export.')) : ''}</p>` : ''}
   <label>${esc(uiText('Report destination'))}<select id="report-destination"><option value="">${esc(uiText('Choose or add a destination'))}</option>${destinations.map(d => `<option value="${esc(d.id)}" ${d.id === overviewState.destinationId ? 'selected' : ''}>${esc(d.name)} · ${esc(d.kind === 'report_files' ? d.formats.map(f => f.toUpperCase()).join(' + ') : d.tab_name)} ${esc(uiText(d.kind === 'report_files' ? '· Stored files' : '· Google Sheets'))}</option>`).join('')}</select></label>
   ${sheetsNow ? '' : reportFileDestinationForm(config, reader)}
   ${
     !options
       ? `<p class="notice">${esc(uiText('To deliver to a spreadsheet,'))} <a href="/connections">${esc(uiText('connect Google Sheets'))}</a>${sheetsNow ? '.' : esc(uiText('. Stored PDF/Excel files need no Sheets login.'))}</p>`
       : `
   <details class="delivery-alternatives" ${overviewState.destinationId ? '' : 'open'}><summary>${esc(uiText('Paste a spreadsheet URL to add a separate report tab'))}</summary>
    <form id="report-bind-url" class="workspace-form"><label>${esc(uiText('Google Sheets login'))}<select name="connection_id">${options}</select></label><label class="delivery-wide">${esc(uiText('Google Sheet URL'))}<input type="url" name="spreadsheet_url" placeholder="https://docs.google.com/spreadsheets/d/…/edit" maxlength="2048" required></label><label>${esc(uiText('Report tab name'))}<input name="tab_name" value="${esc(tabDefault)}" maxlength="80" required></label><button class="button primary" ${reader ? 'disabled' : ''}>${esc(uiText('Use this Sheet & add a report tab'))}</button></form>
    <p class="form-note">${esc(uiText('The tab is created on the first export; a suffix keeps report tabs distinct.'))} ${admin ? uiText('The URL also selects that spreadsheet for AMCP.') : uiText('A workspace administrator must select new spreadsheets first.')}</p>
   </details>
   <details class="delivery-alternatives"><summary>${esc(uiText('Create a spreadsheet or use one already selected'))}</summary><form id="report-create-sheet" class="workspace-form"><label>${esc(uiText('Google login'))}<select name="connection_id">${options}</select></label><label>${esc(uiText('New spreadsheet name'))}<input name="name" value="${esc(overviewLabel(config))}" maxlength="100" required></label><button class="button" ${admin ? '' : 'disabled'}>${esc(uiText('Create spreadsheet & use it'))}</button></form><form id="report-bind-sheet" class="workspace-form"><label>${esc(uiText('Selected spreadsheet'))}<select name="binding">${b.sheets_connections
     .filter(c => c.enabled)
     .flatMap(c =>
       c.accounts.map(id => `<option value="${esc(JSON.stringify([c.id, id]))}">${esc(c.label)} · ${esc(id)}</option>`),
     )
     .join(
       '',
     )}</select></label><button class="button" ${reader ? 'disabled' : ''}>${esc(uiText('Add a separate report tab'))}</button></form></details>
   `
   }
   ${sheetsNow ? `<label class="form-note"><input type="checkbox" id="report-export-confirm"> ${esc(uiText('I authorize exporting this snapshot to the selected report tab.'))}</label>` : ''}
   <div class="report-actions">${sheetsNow ? '' : `<button class="button" id="report-save-destination" ${reader || !accounts.length ? 'disabled' : ''}>${esc(uiText('Save destination with report'))}</button>`}${r ? `<button class="button primary" id="report-export-now" ${!reader && ['complete', 'partial'].includes(r.state) && r.row_count > 0 ? '' : 'disabled'}>${esc(sheetsNow ? uiText('Export this snapshot now') : uiText('Deliver snapshot “{name}”', {name: r.config.name}))}</button>` : ''}</div>
  </section>
  ${
    sheetsNow
      ? ''
      : `<section class="delivery-section"><h3>${esc(existing ? uiText('2. Edit independent delivery') : uiText('2. Schedule independent delivery'))}</h3><p>${existing ? uiText('Saving updates this report and replaces pending runs from its previous settings. A provider request already sent may finish.') : uiText('Save this report’s accounts, metrics, date window, destination and delivery frequency together.')} ${existing && !existing.is_active ? uiText('This schedule is paused; saving keeps it paused.') : ''}</p>
   <form id="report-schedule" class="workspace-form">
    <label class="delivery-wide">${esc(uiText('Saved report name'))}<input name="report_name" maxlength="100" required></label>
    <label>${esc(uiText('Delivery frequency'))}<select name="schedule_kind"><option value="daily">${esc(uiText('Daily'))}</option><option value="weekly">${esc(uiText('Weekly'))}</option><option value="monthly">${esc(uiText('Monthly'))}</option><option value="hourly">${esc(uiText('Hourly'))}</option></select></label>
    <label>${esc(uiText('Partial report delivery'))}<select name="partial_delivery"><option value="allow_marked">${esc(uiText('Deliver marked partial results'))}</option><option value="complete_only">${esc(uiText('Wait until all sources succeed'))}</option></select></label>
    <label>${esc(uiText('At hour (0–23)'))}<input name="hour" type="number" min="0" max="23" required></label><label>${esc(uiText('Minute'))}<input name="minute" type="number" min="0" max="59" required></label>
    <label>${esc(uiText('Weekday'))}<select name="weekday">${[uiText('Sunday'), uiText('Monday'), uiText('Tuesday'), uiText('Wednesday'), uiText('Thursday'), uiText('Friday'), uiText('Saturday')].map((s, i) => `<option value="${i}">${s}</option>`).join('')}</select></label>
    <label>${esc(uiText('Day of month'))}<input name="day" type="number" min="1" max="31" required><small>${esc(uiText('Days 29–31 use the last day in shorter months.'))}</small></label>
    <label>${esc(uiText('Delivery timezone'))}<input name="timezone" list="report-timezones" required></label>
    <label>${esc(uiText('Collect data for'))}<select name="preset">${reportWindowOptions({preset: formValues.preset}, false)}</select></label>
    <label>${esc(uiText('Last complete days'))}<input name="days" type="number" min="1" max="366" required></label><label>${esc(uiText('Skip recent days'))}<input name="offset_days" type="number" min="0" max="90" required></label>
    <label>${esc(uiText('Window timezone'))}<input name="window_timezone" list="report-timezones" required></label>
    <button class="button primary" ${reader || !accounts.length ? 'disabled' : ''}>${existing ? uiText('Save schedule changes') : uiText('Save report & enable schedule')}</button>
   </form>
   <p class="form-note">${esc(uiText('The delivery timezone sets the clock; the window timezone determines which calendar dates are complete. Native data uses each platform’s reporting timezone. Missed runs are coalesced into one due run; nonexistent daylight-saving times are skipped.'))}</p>
  </section>
  <section class="delivery-section"><h3>${esc(uiText('All scheduled reports'))}</h3>${
    b.schedules
      .map(s => {
        const d = [...b.destinations, ...(b.file_destinations ?? [])].find(d => d.id === s.destination_id);
        return `<article class="schedule-row"><div><strong>${esc(overviewLabel(s.config))}</strong><small>${deliveryAccountSummary(s.config, b).map(esc).join(`<br>`)}<br>${esc(reportLabel(s.schedule_kind))} · ${esc(s.timezone)} · ${esc(reportWindowLabel(s.config.date_range))}<br>${esc(d?.name ?? uiText('Destination unavailable'))} · ${esc(d?.kind === 'report_files' ? d.formats.map(f => f.toUpperCase()).join(' + ') : (d?.tab_name ?? ''))}<br>${s.is_active ? uiText('Next: {date}', {date: date(s.next_run_at)}) : uiText('Paused')}${s.error ? `<br>` + esc(s.error.message) : ''}</small><div class="report-actions"><button class="button small" data-open-schedule="${esc(s.id)}">${esc(uiText('Edit report & schedule'))}</button>${s.last_report_id ? `<button class="button small" data-schedule-report="${esc(s.last_report_id)}">${esc(uiText('Latest snapshot'))}</button>` : ''}${d && d.kind !== 'report_files' ? `<a class="button small" href="https://docs.google.com/spreadsheets/d/${encodeURIComponent(d.spreadsheet_id)}/edit#gid=${encodeURIComponent(d.sheet_id)}" target="_blank" rel="noopener">${esc(uiText('Open Sheet ↗'))}</a>` : ''}</div></div><div class="report-actions"><button class="button small" data-toggle-schedule="${esc(s.id)}" ${reader ? 'disabled' : ''}>${s.is_active ? uiText('Pause') : uiText('Resume')}</button><button class="button small danger" data-remove-schedule="${esc(s.id)}" ${reader ? 'disabled' : ''}>${esc(uiText('Delete schedule'))}</button></div></article>`;
      })
      .join('') || `<p class="muted">${esc(uiText('No scheduled exports yet.'))}</p>`
  }</section>`
  }`;
  const form = $('#report-schedule');
  if (form) {
    for (const [k, v] of Object.entries(formValues)) if (form.elements[k]) form.elements[k].value = v;
    form.addEventListener('change', deliveryWindowControls);
    deliveryWindowControls();
  }
  const close = () => {
    clearTimeout(deliveryTimer);
    rememberDeliveryDraft();
    dialog.close();
  };
  $('#report-delivery-close').addEventListener('click', close);
  dialog.oncancel = () => {
    clearTimeout(deliveryTimer);
    rememberDeliveryDraft();
  };
  if (!dialog.open) dialog.showModal();
  const status = text => {
    if (present() && dialog.open) $('#delivery-status').textContent = text;
  };
  $('#report-destination')?.addEventListener('change', e => {
    overviewState.destinationId = e.target.value;
    overviewState.dirty = true;
  });
  const useDestination = async (destination, message) => {
    if (!current() || !dialog.open) return;
    rememberDeliveryDraft();
    overviewState.destinationId = destination.id;
    overviewState.dirty = true;
    await renderReportDelivery(mode);
    status(message);
  };
  const adoptSaved = async (viewId, message) => {
    if (!current() || !dialog.open) return;
    dialog.close();
    const latest = await overviewCall({action: 'bootstrap'}),
      saved = latest.views.find(v => v.id === viewId);
    if (!current()) return;
    selectOverviewDefinition(saved);
    await renderReportingOverview();
    await renderReportDelivery();
    status(message);
  };
  deliveryBind('#report-bind-files', async f => {
    const values = new FormData(f),
      file_destination = {
        name: values.get('name'),
        formats: values.getAll('formats'),
        presentation: {
          brand_name: values.get('brand_name'),
          accent_color: values.get('accent_color'),
          footer: values.get('footer'),
          template: values.get('template'),
          ...(values.get('artifact_language') ? {artifact_language: values.get('artifact_language')} : {}),
        },
      };
    if (!file_destination.formats.length) throw Error(uiText('Choose PDF, Excel, or both.'));
    if (!values.get('confirmed')) throw Error(uiText('Confirm storing the selected report files.'));
    const destination = await overviewCall({
      action: 'bind_file_destination',
      file_destination,
      idempotency_key: deliveryKey(f, file_destination),
      confirmed: true,
    });
    await useDestination(
      destination,
      uiText('File destination selected. Save it with this report or schedule recurring files.'),
    );
  });
  deliveryBind('#report-bind-url', async f => {
    rememberDeliveryDraft();
    const values = Object.fromEntries(new FormData(f));
    const destination = await overviewCall({
      action: 'bind_destination',
      ...values,
      idempotency_key: deliveryKey(f, values),
      confirmed: true,
    });
    await useDestination(
      destination,
      uiText('Destination ready. Save it with this report, export a snapshot or schedule delivery.'),
    );
  });
  deliveryBind('#report-create-sheet', async f => {
    rememberDeliveryDraft();
    const values = Object.fromEntries(new FormData(f)),
      key = f.dataset.creationKey ?? crypto.randomUUID();
    f.dataset.creationKey = key;
    const result = await overviewCall({action: 'create_spreadsheet', ...values, idempotency_key: key, confirmed: true}),
      destination = await overviewCall({
        action: 'bind_destination',
        connection_id: result.connection_id,
        spreadsheet_id: result.spreadsheet_id,
        tab_name: tabDefault,
        idempotency_key: key,
        confirmed: true,
      });
    await useDestination(destination, uiText('Spreadsheet created and report destination selected.'));
  });
  deliveryBind('#report-bind-sheet', async f => {
    rememberDeliveryDraft();
    const value = new FormData(f).get('binding');
    if (!value) throw Error(uiText('Choose a spreadsheet or paste its URL.'));
    const [connection_id, spreadsheet_id] = JSON.parse(value),
      values = {connection_id, spreadsheet_id, tab_name: tabDefault};
    await useDestination(
      await overviewCall({
        action: 'bind_destination',
        ...values,
        idempotency_key: deliveryKey(f, values),
        confirmed: true,
      }),
      uiText('A separate report tab has been selected.'),
    );
  });
  deliveryBind('#report-save-destination', async () => {
    const destination_id = $('#report-destination').value;
    if (!destination_id) throw Error(uiText('Choose a report destination first.'));
    const saved = await overviewCall({
      action: 'save',
      config,
      destination_id,
      ...(selection ? {id: selection.id, expected_revision: selection.revision} : {}),
      confirmed: true,
    });
    await adoptSaved(saved.id, uiText('Report destination saved.'));
  });
  deliveryBind('#report-export-now', async () => {
    rememberDeliveryDraft();
    if (!$('#report-destination').value) throw Error(uiText('Choose a report destination first.'));
    if (sheetsNow && !b.destinations.some(d => d.id === $('#report-destination').value))
      throw Error(uiText('Choose your Google Sheets destination'));
    if (sheetsNow && !$('#report-export-confirm').checked)
      throw Error(uiText('Confirm exporting this snapshot to Google Sheets first.'));
    const result = await overviewCall({
      action: 'export',
      report_id: r.id,
      destination_id: $('#report-destination').value,
      confirmed: true,
    });
    await pollDelivery(result.id);
  });
  deliveryBind('#report-schedule', async f => {
    if (!$('#report-destination').value) throw Error(uiText('Choose a report destination first.'));
    const v = Object.fromEntries(new FormData(f));
    const saved = {
      ...config,
      name: v.report_name,
      partial_delivery: v.partial_delivery,
      date_range: {
        preset: v.preset,
        timezone: v.window_timezone,
        ...(v.preset === 'last_complete_days' ? {days: Number(v.days), offset_days: Number(v.offset_days)} : {}),
      },
    };
    const schedule_config = {
      minute: Number(v.minute),
      ...(v.schedule_kind !== 'hourly' ? {hour: Number(v.hour)} : {}),
      ...(v.schedule_kind === 'weekly' ? {weekday: Number(v.weekday)} : {}),
      ...(v.schedule_kind === 'monthly' ? {day: Number(v.day)} : {}),
    };
    const values = {
      config: saved,
      schedule: {
        schedule_kind: v.schedule_kind,
        timezone: v.timezone,
        destination_id: $('#report-destination').value,
        schedule_config,
      },
    };
    const identity = existing
      ? {
          action: 'update_schedule',
          id: existing.id,
          expected_revision: existing.revision,
          expected_view_revision: selection.revision,
        }
      : {action: 'schedule', ...(selection ? {view_id: selection.id, expected_revision: selection.revision} : {})};
    const result = await overviewCall({
      ...identity,
      ...values,
      ...(!existing ? {idempotency_key: deliveryKey(f, values)} : {}),
      confirmed: true,
    });
    await adoptSaved(
      result.view_id,
      result.is_active
        ? uiText('Schedule saved. Next run: {date}', {date: date(result.next_run_at)})
        : uiText('Schedule saved and remains paused.'),
    );
  });
  deliveryBind('[data-toggle-schedule]', async el => {
    rememberDeliveryDraft();
    const s = b.schedules.find(s => s.id === el.dataset.toggleSchedule);
    await overviewCall({
      action: s.is_active ? 'pause_schedule' : 'resume_schedule',
      id: s.id,
      expected_revision: s.revision,
      confirmed: true,
    });
    await renderReportDelivery();
    status(
      s.is_active
        ? uiText('Schedule paused. Pending deliveries stopped.')
        : uiText('Schedule resumed with your current access.'),
    );
  });
  deliveryBind('[data-remove-schedule]', async el => {
    const s = b.schedules.find(s => s.id === el.dataset.removeSchedule);
    if (
      !(await confirmAction({
        title: uiText('Delete the schedule for “{name}”?', {name: overviewLabel(s.config)}),
        consequence: uiText('Pending deliveries stop; the saved report, snapshots and external spreadsheet are kept.'),
        confirmLabel: uiText('Delete schedule'),
      }))
    )
      return;
    rememberDeliveryDraft();
    await overviewCall({action: 'remove_schedule', id: s.id, expected_revision: s.revision, confirmed: true});
    if (selection?.id === s.view_id) {
      const latest = await overviewCall({action: 'bootstrap'}),
        v = latest.views.find(v => v.id === s.view_id);
      overviewState.selection.revision = v.revision;
    }
    await renderReportDelivery();
    status(uiText('Schedule deleted.'));
  });
  deliveryBind('[data-open-schedule]', async el => {
    if (!overviewMayLeave()) return;
    const s = b.schedules.find(s => s.id === el.dataset.openSchedule),
      v = b.views.find(v => v.id === s.view_id);
    close();
    selectOverviewDefinition(v);
    await renderReportingOverview();
    await renderReportDelivery();
  });
  deliveryBind('[data-schedule-report]', async el => {
    if (!overviewMayLeave()) return;
    close();
    overviewState.dirty = false;
    await openOverviewHistory(el.dataset.scheduleReport);
  });
}

function reportFileDestinationForm(config, reader) {
  return `<details class="delivery-alternatives"><summary>${esc(uiText('Create a PDF / Excel destination'))}</summary>
    <form id="report-bind-files" class="workspace-form"><fieldset ${reader ? 'disabled' : ''}><legend>${esc(uiText('Files retained in this workspace'))}</legend>
    <label>${esc(uiText('Destination name'))}<input name="name" maxlength="100" required value="${esc((config.name + ' files').slice(0, 100))}"></label>
    <div class="work-filter"><label><input type="checkbox" name="formats" value="pdf"> ${esc(uiText('PDF summary'))}</label><label><input type="checkbox" name="formats" value="xlsx"> ${esc(uiText('Excel with all report rows'))}</label></div>
    <label>${esc(uiText('Client brand name'))}<input name="brand_name" maxlength="100" value="${esc(config.client_name ?? '')}"></label>
    <label>${esc(uiText('Accent color'))}<input name="accent_color" type="color" value="#354B67"></label>
    <label>${esc(uiText('PDF layout'))}<select name="template"><option value="standard">${esc(uiText('Standard spacing'))}</option><option value="compact">${esc(uiText('Compact spacing'))}</option></select></label>
    <label>${esc(uiText('PDF and Excel language'))}<select name="artifact_language"><option value="en">${esc(uiText('English'))}</option><option value="ar">${esc(uiText('Arabic'))}</option></select></label>
    <p class="form-note">${esc(uiText('PDF and Excel language is saved separately from the interface language. Previously stored files keep their original content.'))}</p>
    <label>${esc(uiText('Footer'))}<input name="footer" maxlength="200"></label>
    <p class="form-note">${esc(uiText('Files are encrypted and follow snapshot deletion and your report retention policy. Workspace file storage is limited to 256 MiB. Each download requires current access to every report account. No file is emailed or uploaded to an external folder.'))}</p>
    <label class="form-note"><input type="checkbox" name="confirmed" required> ${esc(uiText('Store the selected formats with this branding'))}</label>
    <button class="button primary" type="submit">${esc(uiText('Create file destination'))}</button></fieldset></form></details>`;
}
