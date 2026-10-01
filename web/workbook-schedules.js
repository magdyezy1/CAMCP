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
              `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`,
          )
          .join('');
      const localTime = at =>
        new Intl.DateTimeFormat(undefined, {timeZone: s.timezone, dateStyle: 'medium', timeStyle: 'short'}).format(at);
      root.innerHTML = `<div class="operation-heading"><div><small>Workbook schedule · Local output</small><h2 id="workbook-schedule-heading" tabindex="-1">${esc(s.name)}</h2></div>${badge(s.state)}</div><p><strong>Account ${esc(s.account_id)}</strong> · Query revision ${esc(s.query_revision)}</p>${s.error_code ? `<p class="error">${esc(s.error_code)}</p>` : ''}<p>${esc(s.meaning)}</p><details class="workspace-details"><summary>Current saved clock · ${esc(s.timezone)}</summary>${s.preview_error ? `<p class="error">${esc(s.preview_error)}. Correct the clock settings below.</p>` : `<ol>${s.occurrences.map(at => `<li>${esc(localTime(at))}</li>`).join('')}</ol>`}<p>Preview of future clock times, including while paused. Already queued runs keep their state.</p></details><form id="workbook-schedule-form" class="workspace-form"><fieldset ${s.can_edit ? '' : 'disabled'}><legend>Future reporting runs</legend><div class="work-filter"><label>Schedule name<input name="name" maxlength="100" required value="${esc(s.name)}"></label><label>Clock timezone<input name="timezone" maxlength="80" required value="${esc(s.timezone)}" placeholder="Africa/Cairo"></label><label>Frequency<select name="schedule_kind">${options(
        [
          ['hourly', 'Hourly'],
          ['daily', 'Daily'],
          ['weekly', 'Weekly'],
          ['monthly', 'Monthly'],
        ],
        s.schedule_kind,
      )}</select></label><label id="workbook-schedule-hour">Hour (0–23)<input name="hour" type="number" min="0" max="23" step="1" required value="${esc(s.schedule.hour ?? 0)}"></label><label>Minute (0–59)<input name="minute" type="number" min="0" max="59" step="1" required value="${esc(s.schedule.minute ?? 0)}"></label><label id="workbook-schedule-weekday">Weekday<select name="weekday">${options(
        ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((v, i) => [i, v]),
        s.schedule.weekday ?? 1,
      )}</select></label><label id="workbook-schedule-day">Day of month<input name="day" type="number" min="1" max="31" step="1" required value="${esc(s.schedule.day ?? 1)}"></label></div><p class="form-note">Monthly dates beyond a month's length use its last day. Nonexistent daylight-saving times are skipped; repeated local times run once.</p><label class="form-note"><input name="active" type="checkbox" ${s.active ? 'checked' : ''}> Enable future runs</label><div class="dialog-actions work-actions"><button class="button primary" type="submit">Review schedule changes</button></div></fieldset></form>${!s.can_edit ? '<p class="notice">Viewer access can inspect this schedule. An operator must change it.</p>' : ''}<div class="dialog-actions work-actions"><button class="button" id="workbook-schedule-refresh">Refresh schedule</button>${s.last_run ? `<a class="button" href="${esc(s.last_run.website_path)}">Last run · ${esc(s.last_run.state)}</a>` : ''}${s.query_id ? `<a class="button" href="/operations?query_id=${encodeURIComponent(s.query_id)}">Review saved query</a>` : ''}<a class="button" href="/operations?kind=workbook_schedule">All workbook schedules</a></div><p data-schedule-status role="status"></p>`;
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
          root.querySelector('[data-schedule-status]').textContent = 'Checking the proposed clock…';
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
              ? 'unused'
              : field === 'active'
                ? v
                  ? 'enabled'
                  : 'paused'
                : field === 'weekday'
                  ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][v]
                  : String(v);
          const changes = preview.changes
            .map(c => `${labels[c.field]}: ${value(c.field, c.from)} → ${value(c.field, c.to)}`)
            .join('; ');
          const times = preview.occurrences
            .map(at =>
              new Intl.DateTimeFormat(undefined, {
                timeZone: preview.schedule.timezone,
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(at),
            )
            .join('; ');
          const confirmed = await confirmAction({
            title: enabled ? 'Enable these future report runs?' : 'Save and pause future report runs?',
            consequence: `${preview.schedule.name} · Account ${preview.account_id} · Query revision ${preview.query_revision}. ${changes || 'Clock settings are unchanged.'} Next three clock times (${preview.schedule.timezone}): ${times}. ${enabled ? 'The next future occurrence uses your current access.' : 'These are clock previews only; no new runs will be queued while paused.'} Existing runs and retained results are unchanged.`,
            confirmLabel: 'Save schedule',
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
              errorMessage(e) + ' Refresh the schedule before trying again.';
        } finally {
          saving = false;
        }
      });
      $('#workbook-schedule-heading').focus();
    } catch (e) {
      if (active()) {
        root.innerHTML = `<h2>Workbook schedule</h2><p class="error" role="alert">${esc(errorMessage(e))}</p><button id="workbook-schedule-refresh" class="button">Refresh schedule</button>`;
        workspaceBind('#workbook-schedule-refresh', load);
      }
    } finally {
      if (active()) root.setAttribute('aria-busy', 'false');
    }
  };
  return {load};
}
