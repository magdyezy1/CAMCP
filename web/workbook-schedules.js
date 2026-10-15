'use strict';
/** Why a workbook schedule cannot move to Reporting overview yet (EXP-04 D phase 2), worded by its server code. */
function workbookMoveReason(b) {
  const text =
    {
      native_request: uiText(
        'This saved query is a native provider request. Reporting overview collects campaign reports; recreate it there.',
      ),
      unsupported_fields: uiText('Reporting overview has no equivalent for these query settings.'),
      entity_level: uiText(
        'Only campaign-level queries move automatically. Recreate ad set or ad detail in Reporting overview with its detail options.',
      ),
      granularity: uiText('Reporting overview groups by total, day, week or month; this query uses another grouping.'),
      fixed_dates: uiText(
        'Scheduled Overview reports need a rolling window. This query uses fixed dates, so every run repeats the same days.',
      ),
      metrics: uiText('Use at most 30 native metric names, without query expressions.'),
      report_settings: uiText('Reporting overview refused the converted report settings.'),
      destination_required: uiText(
        'Choose a Google Sheets report tab bound to this workbook’s spreadsheet. Bind one in Reporting overview first.',
      ),
      destination_in_use: uiText('This report tab has another active schedule. Choose a separate report tab.'),
      already_migrated: uiText('This schedule already moved to Reporting overview.'),
    }[b.code] ?? b.code;
  // Native field names and error codes stay literal.
  const detail = b.fields?.length ? b.fields.join(', ') : (b.error_code ?? '');
  return `<li>${esc(text)}${detail ? ` <code dir="ltr" data-native>${esc(detail)}</code>` : ''}</li>`;
}
/** The move to Reporting overview: its state, or the explicit check that starts it. */
function workbookMoveSection(s) {
  const m = s.overview_migration,
    when = at => new Intl.DateTimeFormat(uiLocale, {dateStyle: 'medium', timeStyle: 'short'}).format(at);
  if (m?.state === 'migrated')
    return `<section class="workspace-details" aria-labelledby="workbook-move-heading"><h3 id="workbook-move-heading">${esc(uiText('Moved to Reporting overview'))}</h3><p>${esc(uiText('Moved on {date}. This schedule stays paused here while the Reporting overview schedule delivers to its Google Sheets report tab.', {date: when(m.migrated_at)}))}</p><div class="dialog-actions work-actions"><a class="button" href="/reporting-overview">${esc(uiText('Open Reporting overview'))}</a>${s.can_edit ? `<button class="button" type="button" id="workbook-move-undo">${esc(uiText('Undo the move'))}</button>` : ''}</div><p data-move-status role="status"></p></section>`;
  return `<section class="workspace-details" aria-labelledby="workbook-move-heading"><h3 id="workbook-move-heading">${esc(uiText('Move to Reporting overview'))}</h3><p>${esc(uiText('Moving creates one Reporting overview report and schedule with this clock, delivering to a Google Sheets report tab of this workbook’s spreadsheet, and pauses this schedule. The saved query stays unchanged, and the move can be undone.'))}</p>${m?.state === 'reverted' ? `<p class="form-note">${esc(uiText('An earlier move was undone on {date}; its Reporting overview schedule stays paused there.', {date: when(m.reverted_at)}))}</p>` : ''}${s.can_edit ? `<button class="button" type="button" id="workbook-move-check">${esc(uiText('Check whether it can move'))}</button>` : ''}<div data-move-result></div><p data-move-status role="status"></p></section>`;
}
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
      root.innerHTML = `<div class="operation-heading"><div><small>${esc(uiText('Local report schedule · Results stay in AMCP'))}</small><h2 id="workbook-schedule-heading" tabindex="-1">${esc(s.name)}</h2></div>${badge(s.state)}</div><p><strong>${esc(uiText('Account'))} ${esc(s.account_id)}</strong> ${esc(uiText('· Query revision'))} ${esc(s.query_revision)}</p>${s.error_code ? `<p class="error">${esc(s.error_code)}</p>` : ''}<p>${esc(s.meaning)}</p><p class="notice">${esc(uiText('This schedule keeps its results in AMCP and never writes to the saved spreadsheet. To deliver a report to Google Sheets on a schedule, use Reporting overview.'))} <a href="/reporting-overview">${esc(uiText('Schedule a Google Sheets delivery'))}</a></p>${workbookMoveSection(s)}<details class="workspace-details"><summary>${esc(uiText('Current saved clock ·'))} ${esc(s.timezone)}</summary>${s.preview_error ? `<p class="error">${esc(s.preview_error)}${esc(uiText('. Correct the clock settings below.'))}</p>` : `<ol>${s.occurrences.map((at, i) => `<li>${esc(localTime(at))}${s.dst_shifted?.[i] ? ' · ' + esc(uiText('Moved forward by the daylight-saving change')) : ''}</li>`).join('')}</ol>`}<p>${esc(uiText('Preview of future clock times, including while paused. Already queued runs keep their state.'))}</p></details><form id="workbook-schedule-form" class="workspace-form"><fieldset ${s.can_edit ? '' : 'disabled'}><legend>${esc(uiText('Future reporting runs'))}</legend><div class="work-filter"><label>${esc(uiText('Schedule name'))}<input name="name" maxlength="100" required value="${esc(s.name)}"></label><label>${esc(uiText('Clock timezone'))}<input name="timezone" maxlength="80" required value="${esc(s.timezone)}" placeholder="Africa/Cairo"></label><label>${esc(uiText('Frequency'))}<select name="schedule_kind">${options(
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
      // EXP-04 D phase 2: an explicit, reviewed move to Reporting overview, and its undo.
      const moveStatus = () => root.querySelector('[data-move-status]');
      workspaceBind('#workbook-move-check', async () => {
        if (!active() || saving || !s.can_edit) return;
        saving = true;
        try {
          moveStatus().textContent = uiText('Checking whether this schedule can move…');
          const preview = await workspaceCall('overview', {action: 'preview_workbook_move', id: s.id});
          if (!active()) return;
          moveStatus().textContent = '';
          const result = root.querySelector('[data-move-result]'),
            blockers = preview.blockers.filter(b => b.code !== 'destination_required');
          if (blockers.length) {
            result.innerHTML = `<p>${esc(uiText('This schedule cannot move yet:'))}</p><ul>${blockers.map(workbookMoveReason).join('')}</ul>`;
            return;
          }
          if (!preview.destinations.length) {
            result.innerHTML = `<p>${esc(uiText('Bind a Google Sheets report tab of this workbook’s spreadsheet in Reporting overview first.'))} <a href="/reporting-overview">${esc(uiText('Open Reporting overview'))}</a></p>`;
            return;
          }
          result.innerHTML = `<form id="workbook-move-form" class="workspace-form"><label>${esc(uiText('Google Sheets report tab'))}<select name="destination_id">${preview.destinations.map(d => `<option value="${esc(d.id)}" ${d.in_use ? 'disabled' : ''}>${esc(d.tab_name ?? d.id)}${d.in_use ? ' · ' + esc(uiText('has another active schedule')) : ''}</option>`).join('')}</select></label><div class="dialog-actions work-actions"><button class="button primary" type="submit">${esc(uiText('Review the move'))}</button></div></form>`;
          workspaceBind('#workbook-move-form', async form => {
            if (!active() || saving) return;
            saving = true;
            try {
              const reviewed = await workspaceCall('overview', {
                action: 'preview_workbook_move',
                id: s.id,
                destination_id: form.elements.destination_id.value,
              });
              if (!active()) return;
              if (!reviewed.migratable) {
                result.innerHTML = `<p>${esc(uiText('This schedule cannot move yet:'))}</p><ul>${reviewed.blockers.map(workbookMoveReason).join('')}</ul>`;
                return;
              }
              const tab = preview.destinations.find(d => d.id === reviewed.destination_id),
                grain = {total: 'Total', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly'}[
                  reviewed.overview_report.grain
                ];
              const confirmed = await confirmAction({
                title: uiText('Move this schedule to Reporting overview?'),
                consequence: uiText(
                  '{name} · Account {account} · Query revision {revision}. Creates a Reporting overview report ({grain} rows) and a schedule with the same clock ({timezone}), delivering to the report tab {tab}, and pauses this local schedule. {effect} The saved query is unchanged, and Undo the move restores this schedule.',
                  {
                    name: reviewed.overview_report.name,
                    account: s.account_id,
                    revision: reviewed.query_revision,
                    grain: uiText(grain ?? reviewed.overview_report.grain),
                    timezone: reviewed.overview_schedule.timezone,
                    tab: tab?.tab_name ?? reviewed.destination_id,
                    effect: reviewed.active
                      ? uiText('Its next delivery uses your current access.')
                      : uiText('The new schedule starts paused, as this one is.'),
                  },
                ),
                confirmLabel: uiText('Move to Reporting overview'),
              });
              if (!confirmed || !active()) return;
              await workspaceCall('overview', {
                action: 'move_workbook_schedule',
                id: s.id,
                destination_id: reviewed.destination_id,
                move_version: reviewed.move_version,
                confirmed: true,
              });
              if (!active()) return;
              await load();
              if (present()) await onChange();
            } catch (e) {
              if (active())
                moveStatus().textContent = errorMessage(e) + ' ' + uiText('Refresh the schedule before trying again.');
            } finally {
              saving = false;
            }
          });
        } catch (e) {
          if (active()) moveStatus().textContent = errorMessage(e);
        } finally {
          saving = false;
        }
      });
      workspaceBind('#workbook-move-undo', async () => {
        if (!active() || saving || !s.can_edit) return;
        saving = true;
        try {
          const confirmed = await confirmAction({
            title: uiText('Undo the move to Reporting overview?'),
            consequence: uiText(
              'Pauses the Reporting overview schedule (its report and snapshots stay) and restores this schedule as it was before the move. If its saved query changed since the move, this schedule stays paused for review.',
            ),
            confirmLabel: uiText('Undo the move'),
          });
          if (!confirmed || !active()) return;
          await workspaceCall('overview', {action: 'undo_workbook_move', id: s.id, confirmed: true});
          if (!active()) return;
          await load();
          if (present()) await onChange();
        } catch (e) {
          if (active())
            moveStatus().textContent = errorMessage(e) + ' ' + uiText('Refresh the schedule before trying again.');
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
