'use strict';
function workbookScheduleController(root, id, onChange = () => {}) {
  const generation = navigationGeneration,
    identity = identityGeneration;
  let sequence = 0,
    saving = false;
  const present = () => generation === navigationGeneration && identity === identityGeneration && root.isConnected;
  const load = async () => {
    const request = ++sequence,
      active = () => request === sequence && present();
    root.setAttribute('aria-busy', 'true');
    try {
      const s = await workspaceCall('workspace', {action: 'report_schedule', id});
      if (!active()) return;
      const options = (values, selected) =>
        values
          .map(
            ([v, label]) =>
              `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(uiText(label))}</option>`,
          )
          .join('');
      const localTime = at =>
        new Intl.DateTimeFormat(uiLocale, {timeZone: s.timezone, dateStyle: 'medium', timeStyle: 'short'}).format(at);
      root.innerHTML = `<div class="operation-heading"><div><small>${esc(uiText('Local report schedule · Results stay in AMCP'))}</small><h2 id="workbook-schedule-heading" tabindex="-1">${esc(s.name)}</h2></div>${badge(s.state)}</div><p><strong>${esc(uiText('Account'))} ${esc(s.account_id)}</strong> ${esc(uiText('· Query revision'))} ${esc(s.query_revision)}</p>${s.error_code ? `<p class="error">${esc(s.error_code)}</p>` : ''}<p>${esc(s.meaning)}</p><p class="notice">${esc(uiText('This schedule keeps its results in AMCP and never writes to the saved spreadsheet. To deliver a report to Google Sheets on a schedule, use Reporting overview.'))} <a href="/reporting-overview">${esc(uiText('Schedule a Google Sheets delivery'))}</a></p><details class="workspace-details"><summary>${esc(uiText('Current saved clock ·'))} ${esc(s.timezone)}</summary>${s.preview_error ? `<p class="error">${esc(s.preview_error)}${esc(uiText('. Correct the clock settings below.'))}</p>` : `<ol>${s.occurrences.map((at, i) => `<li>${esc(localTime(at))}${s.dst_shifted?.[i] ? ' · ' + esc(uiText('Moved forward by the daylight-saving change')) : ''}</li>`).join('')}</ol>`}<p>${esc(uiText('Preview of future clock times, including while paused. Already queued runs keep their state.'))}</p></details><form id="workbook-schedule-form" class="workspace-form"><fieldset ${s.can_edit ? '' : 'disabled'}><legend>${esc(uiText('Future reporting runs'))}</legend><div class="work-filter"><label>${esc(uiText('Schedule name'))}<input name="name" maxlength="100" required value="${esc(s.name)}"></label><label>${esc(uiText('Clock timezone'))}<input name="timezone" maxlength="80" required value="${esc(s.timezone)}" placeholder="Africa/Cairo"></label><label>${esc(uiText('Frequency'))}<select name="schedule_kind">${options(
        [
          ['hourly', uiText('Hourly')],
          ['daily', uiText('Daily')],
          ['weekly', uiText('Weekly')],
          ['monthly', uiText('Monthly')],
        ],
        s.schedule_kind,
      )}</select></label><label id="workbook-schedule-hour">${esc(uiText('Hour (0–23)'))}<input name="hour" type="number" min="0" max="23" step="1" required value="${esc(s.schedule.hour ?? 0)}"></label><label>${esc(uiText('Minute (0–59)'))}<input name="minute" type="number" min="0" max="59" step="1" required value="${esc(s.schedule.minute ?? 0)}"></label><label id="workbook-schedule-weekday">${esc(uiText('Weekday'))}<select name="weekday">${options(
        [
          uiText('Sunday'),
          uiText('Monday'),
          uiText('Tuesday'),
          uiText('Wednesday'),
          uiText('Thursday'),
          uiText('Friday'),
          uiText('Saturday'),
        ].map((v, i) => [i, v]),
        s.schedule.weekday ?? 1,
      )}</select></label><label id="workbook-schedule-day">${esc(uiText('Day of month'))}<input name="day" type="number" min="1" max="31" step="1" required value="${esc(s.schedule.day ?? 1)}"></label></div><p class="form-note">${esc(uiText("Monthly dates beyond a month's length use its last day. A nonexistent daylight-saving time runs at the first valid time after the change; repeated local times run once."))}</p><label class="form-note"><input name="active" type="checkbox" ${s.active ? 'checked' : ''}> ${esc(uiText('Enable future runs'))}</label><div class="dialog-actions work-actions"><button class="button primary" type="submit">${esc(uiText('Review schedule changes'))}</button></div></fieldset></form>${!s.can_edit ? `<p class="notice">${esc(uiText('Viewer access can inspect this schedule. An operator must change it.'))}</p>` : ''}<div class="dialog-actions work-actions"><button class="button" id="workbook-schedule-refresh">${esc(uiText('Refresh schedule'))}</button>${s.last_run ? `<a class="button" href="${esc(s.last_run.website_path)}">${esc(uiText('Last run ·'))} ${esc(s.last_run.state)}</a>` : ''}${s.query_id ? `<a class="button" href="/operations?query_id=${encodeURIComponent(s.query_id)}">${esc(uiText('Review saved query'))}</a>` : ''}<a class="button" href="/operations?kind=workbook_schedule">${esc(uiText('All local report schedules'))}</a></div><p data-schedule-status role="status"></p>`;
      const form = $('#workbook-schedule-form');
      const fields = () => {
        const kind = form.elements.schedule_kind.value;
        $('#workbook-schedule-weekday').hidden = kind !== 'weekly';
        $('#workbook-schedule-day').hidden = kind !== 'monthly';
        $('#workbook-schedule-hour').hidden = kind === 'hourly';
        form.elements.weekday.disabled = kind !== 'weekly';
        form.elements.day.disabled = kind !== 'monthly';
        form.elements.hour.disabled = kind === 'hourly';
      };
      form.elements.schedule_kind.addEventListener('change', fields);
      fields();
      workspaceBind('#workbook-schedule-refresh', load);
      workspaceBind('#workbook-schedule-form', async form => {
        if (!active() || saving || !s.can_edit) return;
        saving = true;
        try {
          const e = form.elements,
            kind = e.schedule_kind.value,
            schedule = {
              name: e.name.value,
              timezone: e.timezone.value,
              schedule_kind: kind,
              hour: kind === 'hourly' ? 0 : Number(e.hour.value),
              minute: Number(e.minute.value),
              ...(kind === 'weekly' ? {weekday: Number(e.weekday.value)} : {}),
              ...(kind === 'monthly' ? {day: Number(e.day.value)} : {}),
            },
            enabled = e.active.checked;
          root.querySelector('[data-schedule-status]').textContent = uiText('Checking the proposed clock…');
          const preview = await workspaceCall('workspace', {
            action: 'preview_report_schedule',
            id: s.id,
            schedule_version: s.schedule_version,
            active: enabled,
            schedule,
          });
          if (!active()) return;
          root.querySelector('[data-schedule-status]').textContent = '';
          const labels = {
            name: 'Name',
            timezone: 'Timezone',
            schedule_kind: 'Frequency',
            minute: 'Minute',
            hour: 'Hour',
            weekday: 'Weekday',
            day: 'Day of month',
            active: 'Future runs',
          };
          const value = (field, v) =>
            v === null
              ? uiText('unused')
              : field === 'active'
                ? v
                  ? uiText('enabled')
                  : uiText('paused')
                : field === 'weekday'
                  ? [
                      uiText('Sunday'),
                      uiText('Monday'),
                      uiText('Tuesday'),
                      uiText('Wednesday'),
                      uiText('Thursday'),
                      uiText('Friday'),
                      uiText('Saturday'),
                    ][v]
                  : field === 'schedule_kind'
                    ? uiText({hourly: 'Hourly', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly'}[v] ?? v)
                    : String(v);
          const changes = preview.changes
            .map(c => `${uiText(labels[c.field])}: ${value(c.field, c.from)} → ${value(c.field, c.to)}`)
            .join('; ');
          const times = preview.occurrences
            .map(
              (at, i) =>
                new Intl.DateTimeFormat(uiLocale, {
                  timeZone: preview.schedule.timezone,
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(at) +
                (preview.dst_shifted?.[i] ? ' (' + uiText('Moved forward by the daylight-saving change') + ')' : ''),
            )
            .join('; ');
          const confirmed = await confirmAction({
            title: enabled ? uiText('Enable these future report runs?') : uiText('Save and pause future report runs?'),
            consequence: uiText(
              '{name} · Account {account} · Query revision {revision}. {changes} Next three clock times ({timezone}): {times}. {effect} Existing runs and retained results are unchanged.',
              {
                name: preview.schedule.name,
                account: preview.account_id,
                revision: preview.query_revision,
                changes: changes || uiText('Clock settings are unchanged.'),
                timezone: preview.schedule.timezone,
                times,
                effect: enabled
                  ? uiText('The next future occurrence uses your current access.')
                  : uiText('These are clock previews only; no new runs will be queued while paused.'),
              },
            ),
            confirmLabel: uiText('Save schedule'),
          });
          if (!confirmed || !active()) return;
          await workspaceCall('workspace', {
            action: 'save_report_schedule',
            id: s.id,
            schedule_version: s.schedule_version,
            confirmed: true,
            active: preview.active,
            schedule: preview.schedule,
          });
          if (!active()) return;
          await load();
          if (present()) await onChange();
        } catch (e) {
          if (active())
            root.querySelector('[data-schedule-status]').textContent =
              errorMessage(e) + ' ' + uiText('Refresh the schedule before trying again.');
        } finally {
          saving = false;
        }
      });
      $('#workbook-schedule-heading').focus();
    } catch (e) {
      if (active()) {
        root.innerHTML = `<h2>${esc(uiText('Local report schedule'))}</h2><p class="error" role="alert">${esc(errorMessage(e))}</p><button id="workbook-schedule-refresh" class="button">${esc(uiText('Refresh schedule'))}</button>`;
        workspaceBind('#workbook-schedule-refresh', load);
      }
    } finally {
      if (active()) root.setAttribute('aria-busy', 'false');
    }
  };
  return {load};
}
