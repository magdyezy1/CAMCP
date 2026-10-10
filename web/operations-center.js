'use strict';
const operationLabels = {
  all: 'All',
  campaign: 'Campaign plan',
  upload: 'Media upload',
  report: 'Report snapshot',
  export: 'Export job',
  schedule: 'Report schedule',
  incident: 'Incident',
  workbook_report: 'Workbook report',
  workbook_schedule: 'Workbook schedule',
  write: 'Reviewed change',
  appears_applied: 'Appears applied',
  appears_not_applied: 'Appears not applied',
  indeterminate: 'Not settled',
  attention: 'Needs attention',
  active: 'Active',
  complete: 'Complete',
  deferred: 'Deferred',
  open: 'Unresolved',
  acknowledged: 'Acknowledged',
  snoozed: 'Snoozed',
  resolved: 'Resolved',
  superseded: 'Superseded',
  spend: 'Spend',
  clicks: 'Clicks',
  conversions: 'Conversions',
  cpa: 'Cost per conversion',
  above: 'Above threshold',
  below: 'Below threshold',
  opened: 'Incident opened',
  reopened: 'Incident reopened',
  sent: 'Accepted by email provider',
  pending: 'Awaiting delivery',
  failed: 'Failed',
  cancelled: 'Cancelled',
  paused: 'Paused',
  queued: 'Queued',
  running: 'Running',
  unavailable: 'Unavailable',
};
const operationLabel = value => uiText(operationLabels[value] ?? pretty(value));

// Each loader owns its DOM node and request sequence. A late page cannot replace a newer filter, route or session.
function workPageLoader(selector, title, fetchPage, renderRows, bindRows = () => {}, active = () => true) {
  const root = $(selector),
    generation = navigationGeneration,
    identity = identityGeneration;
  const current = () =>
    generation === navigationGeneration && identity === identityGeneration && root.isConnected && active();
  let sequence = 0,
    page = 0,
    cursors = [undefined],
    next = null;
  const go = async (index = 0, reset = false) => {
    if (!current()) return;
    const request = ++sequence,
      cursor = reset ? undefined : cursors[index];
    root.setAttribute('aria-busy', 'true');
    const status = root.querySelector('[data-page-status]');
    if (status) status.textContent = uiText('Loading…');
    try {
      const result = await fetchPage(cursor);
      if (request !== sequence || !current()) return;
      page = index;
      if (reset) cursors = [undefined];
      next = result.next_cursor ?? result.next_offset ?? null;
      root.innerHTML = `<div class="panel-header"><h2>${esc(uiText(title))}</h2><span class="form-note">${esc(uiText('Page'))} ${page + 1}${Number.isInteger(result.total) ? uiText(' · {count} matching', {count: result.total}) : ''}</span></div>${renderRows(result)}<p data-page-status role="status">${next !== null ? uiText('More results are available.') : uiText('End of available results.')}</p><nav class="dialog-actions work-actions" aria-label="${esc(uiText('{title} pages', {title: uiText(title)}))}"><button class="button small" data-page-prev ${page ? '' : 'disabled'}>${esc(uiText('Previous'))}</button><button class="button small" data-page-next ${next !== null ? '' : 'disabled'}>${esc(uiText('Next'))}</button></nav>`;
      workspaceBind(selector + ' [data-page-prev]', () => go(page - 1));
      workspaceBind(selector + ' [data-page-next]', () => {
        cursors[page + 1] = next;
        return go(page + 1);
      });
      bindRows(result);
    } catch (e) {
      if (request !== sequence || !current()) return;
      const errorStatus = root.querySelector('[data-page-status]');
      const message = uiText('Could not load this page. ') + errorMessage(e);
      if (errorStatus) errorStatus.textContent = message;
      else
        root.innerHTML = `<h2>${esc(uiText(title))}</h2><p class="error" role="alert">${esc(message)}</p><p>${esc(uiText('Apply the filters or refresh to try again.'))}</p>`;
    } finally {
      if (request === sequence && current()) root.setAttribute('aria-busy', 'false');
    }
  };
  return {load: () => go(0, true)};
}
// Only these authored AMCP instructions are localized; unfamiliar/provider guidance stays source text.
function operationGuidance(value) {
  switch (value) {
    case 'Inspect this original workbook run, retained query revision and current access before retrieving results or resuming collection.':
      return uiText(
        'Inspect this original workbook run, retained query revision and current access before retrieving results or resuming collection.',
      );
    case 'The retained query requests a write. Save a corrected read-only query and prepare a new run.':
      return uiText('The retained query requests a write. Save a corrected read-only query and prepare a new run.');
    case 'The original run is complete. Retrieve its retained result through MCP; prepare a new run for fresh data.':
      return uiText(
        'The original run is complete. Retrieve its retained result through MCP; prepare a new run for fresh data.',
      );
    case 'Refresh this original run to follow the worker. A queued run waits for an active worker; do not create duplicates.':
      return uiText(
        'Refresh this original run to follow the worker. A queued run waits for an active worker; do not create duplicates.',
      );
    case 'Inspect the original query revision and account. Confirm resuming this read-only report with your current access; its original run ID is retained.':
      return uiText(
        'Inspect the original query revision and account. Confirm resuming this read-only report with your current access; its original run ID is retained.',
      );
    case 'Inspect this original run and ask the workspace owner to diagnose its state before continuing.':
      return uiText('Inspect this original run and ask the workspace owner to diagnose its state before continuing.');
    case 'Inspect the original review and its claim. An uncertain write is reconciled with read-only lookups; it is never submitted again automatically.':
      return uiText(
        'Inspect the original review and its claim. An uncertain write is reconciled with read-only lookups; it is never submitted again automatically.',
      );
    default:
      return String(value ?? '');
  }
}
function operationGatewayLabel(gateway) {
  switch (gateway) {
    case 'gtm_native_action':
      return uiText('Google Tag Manager');
    case 'google_business_native_action':
      return uiText('Google Business Profile');
    case 'ga4_native_action':
      return uiText('Google Analytics 4');
    case 'google_search_console_native_action':
      return uiText('Google Search Console');
    default:
      return String(gateway ?? '')
        .replace('_native_action', '')
        .replaceAll('_', ' ');
  }
}
function operationCard(op) {
  return `<article class="operation-card"><div class="operation-heading"><div><small>${esc(operationLabel(op.kind))} · ${op.updated_at ? date(op.updated_at) : uiText('Time unavailable')}</small><h3>${esc(op.name)}</h3></div>${badge(op.state)}</div><p class="form-note">${esc(uiText('Accounts'))} ${op.accounts.map(esc).join(' · ')}</p><p>${esc(operationGuidance(op.next_safe_action))}</p>${op.error_code ? `<p class="error">${esc(op.error_code)}</p>` : ''}${op.snoozed_until ? `<p>${esc(uiText('Attention resumes'))} ${date(op.snoozed_until)}</p>` : ''}${op.next_run_at ? `<p>${esc(uiText('Next delivery'))} ${date(op.next_run_at)}</p>` : ''}<div class="dialog-actions work-actions"><a class="button small" href="${esc(op.website_path)}">${op.kind === 'incident' ? uiText('Inspect incident') : op.kind === 'write' ? uiText('Open original review') : uiText('Open original work')}</a></div>${recordDetails(op.next_call, uiText('Continue in MCP'))}</article>`;
}
// What a person does next with a retained reviewed change (WRT-08), by its state. AMCP's own copy, localized.
function writeGuidance(state) {
  switch (state) {
    case 'unsubmitted':
      return uiText(
        'Prepared and not executed. Approve and execute it where it was prepared, before it expires, or let it expire.',
      );
    case 'not_sent':
      return uiText('Nothing reached the provider. Execute the same review again before it expires.');
    case 'expired':
      return uiText('Nothing was submitted and the review expired. Prepare the same change again to review it.');
    case 'executing':
      return uiText('The change is being sent. Refresh in a moment; never execute it twice.');
    case 'uncertain':
      return uiText(
        'The change may have reached the provider, and its outcome was not recorded. AMCP never sends it again. Check the provider read-only before any new change.',
      );
    case 'failed':
      return uiText('The provider reported a failed or partial outcome. Inspect the receipt before any correction.');
    case 'reconciled':
      return uiText('Accepted as applied after a read-only check. It is never sent again.');
    case 'verified':
      return uiText('Applied and read back.');
    case 'mismatch':
    case 'inconclusive':
      return uiText(
        'Applied, but the read-back disagrees or could not settle. A correction is a new reviewed change.',
      );
    case 'superseded':
      return uiText('Found not applied and replaced by a new review. This review is never sent.');
    default:
      return uiText('Applied. Its read-back follows.');
  }
}
function reconciliationGuidance(classification) {
  if (classification === 'appears_applied')
    return uiText(
      'The provider appears to hold this change. If you agree, accept it as applied; nothing is sent.',
    );
  if (classification === 'appears_not_applied')
    return uiText(
      'The provider does not appear to hold this change. Prepare a replacement review from MCP (Continue in MCP); this one is never sent.',
    );
  return uiText('The provider reads did not settle the outcome. Check again later or inspect the provider directly.');
}
/** The original review behind a write record (WRT-08): its state, claim and read-only reconciliation. */
function writeRecordController(root, id, onChange = () => {}) {
  const generation = navigationGeneration,
    identity = identityGeneration;
  let sequence = 0,
    busy = false;
  const present = () => generation === navigationGeneration && identity === identityGeneration && root.isConnected;
  const load = async () => {
    const request = ++sequence,
      active = () => request === sequence && present();
    root.setAttribute('aria-busy', 'true');
    try {
      const w = await workspaceCall('write', {action: 'status', review_id: id});
      if (!active()) return;
      const r = w.reconciliation,
        fresh = r && Date.now() - Number(r.checked_at) < 15 * 60000,
        acceptable = w.state === 'uncertain' && fresh && r.classification === 'appears_applied';
      root.innerHTML = `<div class="operation-heading"><div><small>${esc(uiText('Reviewed change'))} · ${esc(operationGatewayLabel(w.gateway))}</small><h2 id="write-record-heading" tabindex="-1">${esc(w.action ?? w.review_id)}</h2></div>${badge(w.state)}</div><p><strong>${esc(uiText('Account'))} ${esc(w.account_id)}</strong></p>${w.summary?.text ? `<p>${esc(w.summary.text)}</p>` : ''}<p>${esc(writeGuidance(w.state))}</p><p class="form-note">${w.prepared_at ? esc(uiText('Prepared')) + ' ' + date(w.prepared_at) + ' · ' : ''}${esc(uiText('Expires'))} ${date(w.expires_at)}</p>${r ? `<section class="notice" aria-label="${esc(uiText('Read-only provider check'))}"><p><strong>${esc(operationLabel(r.classification))}</strong> · ${date(r.checked_at)}</p><p>${esc(reconciliationGuidance(r.classification))}</p></section>` : ''}<details class="workspace-details"><summary>${esc(uiText('Original review references'))}</summary><p>${esc(uiText('Review'))} <code>${esc(w.review_id)}</code></p><p>${esc(uiText('Connection'))} <code>${esc(w.connection_id)}</code></p>${w.fingerprint ? `<p>${esc(uiText('Fingerprint'))} <code>${esc(w.fingerprint)}</code></p>` : ''}${(w.suggested_reads ?? []).length ? `<p>${esc(uiText('Provider lookups this review read'))}</p><ul>${w.suggested_reads.map(s => `<li><code>${esc(s.method)} ${esc(s.path)}</code></li>`).join('')}</ul>` : ''}</details><div class="dialog-actions work-actions"><button id="write-record-refresh" class="button">${esc(uiText('Refresh'))}</button>${w.state === 'uncertain' && session.workspaceRole !== 'viewer' ? `<button id="write-record-reconcile" class="button">${esc(uiText('Check the provider (read-only)'))}</button>` : ''}${acceptable ? `<button id="write-record-accept" class="button primary">${esc(uiText('Accept as applied'))}</button>` : ''}</div>${recordDetails(w.next_call, uiText('Continue in MCP'))}<p data-write-status role="status"></p>`;
      const report = e => {
        if (active()) root.querySelector('[data-write-status]').textContent = errorMessage(e);
      };
      workspaceBind('#write-record-refresh', load);
      workspaceBind('#write-record-reconcile', async () => {
        if (!active() || busy) return;
        busy = true;
        try {
          await workspaceCall('write', {action: 'reconcile', review_id: id});
          if (active()) await load();
        } catch (e) {
          report(e);
        } finally {
          busy = false;
        }
      });
      workspaceBind('#write-record-accept', async () => {
        if (!active() || busy || !acceptable) return;
        busy = true;
        try {
          const confirmed = await confirmAction({
            title: uiText('Accept this change as applied?'),
            consequence: uiText(
              'Record what the provider showed at {time} as this review’s result. Nothing is sent; the review is never sent again, and its read-back follows.',
              {time: date(r.checked_at)},
            ),
            confirmLabel: uiText('Accept as applied'),
          });
          if (!confirmed || !active()) return;
          await workspaceCall('write', {
            action: 'reconcile',
            review_id: id,
            accept_applied: true,
            reconciliation_id: r.reconciliation_id,
          });
          if (!active()) return;
          await load();
          if (present()) await onChange();
        } catch (e) {
          report(e);
        } finally {
          busy = false;
        }
      });
      $('#write-record-heading').focus();
    } catch (e) {
      if (active()) {
        root.innerHTML = `<h2>${esc(uiText('Reviewed change'))}</h2><p class="error" role="alert">${esc(errorMessage(e))}</p><button id="write-record-refresh" class="button">${esc(uiText('Refresh'))}</button>`;
        workspaceBind('#write-record-refresh', load);
      }
    } finally {
      if (active()) root.setAttribute('aria-busy', 'false');
    }
  };
  return {load};
}
function workbookRunController(root, id, onChange = () => {}) {
  const generation = navigationGeneration,
    identity = identityGeneration;
  let sequence = 0,
    resuming = false;
  const present = () => generation === navigationGeneration && identity === identityGeneration && root.isConnected;
  const load = async () => {
    const request = ++sequence,
      active = () => request === sequence && present();
    root.setAttribute('aria-busy', 'true');
    try {
      const run = await workspaceCall('workspace', {action: 'report_run', id});
      if (!active()) return;
      root.innerHTML = `<div class="operation-heading"><div><small>${esc(uiText('Workbook reporting · Local output'))}</small><h2 id="workbook-run-heading" tabindex="-1">${esc(run.name)}</h2></div>${badge(run.state)}</div><p><strong>${esc(uiText('Account'))} ${esc(run.account_id)}</strong> · ${esc(operationGatewayLabel(run.gateway))}</p><p>${esc(operationGuidance(run.next_safe_action))}</p>${run.error_code ? `<p class="error">${esc(run.error_code)}</p>` : ''}<p class="form-note">${esc(uiText('Query revision'))} ${esc(run.query_revision ?? uiText('Unknown'))} · ${esc(uiText('Worker attempts: {count} · Updated {updated}', {count: uiNumber(run.attempts), updated: date(run.updated_at)}))}</p><details class="workspace-details"><summary>${esc(uiText('Original run references'))}</summary><p>${esc(uiText('Run'))} <code>${esc(run.id)}</code></p><p>${esc(uiText('Query'))} ${run.query_id ? `<a href="/operations?query_id=${encodeURIComponent(run.query_id)}">${esc(run.query_id)}</a>` : uiText('Unavailable')}</p><p>${esc(uiText('Connection'))} <code>${esc(run.connection_id)}</code></p>${run.schedule_id ? `<p>${esc(uiText('Schedule'))} <code>${esc(run.schedule_id)}</code></p>` : ''}<p>${esc(uiText('Created'))} ${date(run.created_at)}</p>${run.name_source === 'current_query' ? `<p>${esc(uiText('This older run uses the current query name for display. Its retained account scope and query revision determine access and execution.'))}</p>` : ''}</details><p class="notice">${esc(uiText('This run stores its output in AMCP. It does not write a spreadsheet or change advertising settings. Resuming keeps the original query configuration; rolling dates are resolved when the worker executes.'))}</p><div class="dialog-actions work-actions"><button id="workbook-run-refresh" class="button">${esc(uiText('Refresh run'))}</button>${run.can_resume ? `<button id="workbook-run-resume" class="button primary">${esc(uiText('Resume report'))}</button>` : ''}<a class="button" href="/connections">${esc(uiText('Review account access'))}</a></div>${recordDetails(run.next_call, run.result_available ? uiText('Retrieve retained results in MCP') : uiText('Check this run in MCP'))}<p data-run-status role="status"></p>`;
      workspaceBind('#workbook-run-refresh', load);
      workspaceBind('#workbook-run-resume', async () => {
        if (!active() || resuming || !run.can_resume) return;
        resuming = true;
        try {
          const confirmed = await confirmAction({
            title: uiText('Resume this report?'),
            consequence: uiText(
              'Queue the original report for account {account} using your current access. The worker collects read-only data and retains the same run ID. Rolling dates resolve at execution.',
              {account: run.account_id},
            ),
            confirmLabel: uiText('Resume report'),
          });
          if (!confirmed || !active()) return;
          await workspaceCall('workspace', {
            action: 'resume_report_run',
            id: run.id,
            run_version: run.run_version,
            confirmed: true,
          });
          if (!active()) return;
          await load();
          if (present()) await onChange();
        } catch (e) {
          if (active())
            root.querySelector('[data-run-status]').textContent =
              errorMessage(e) + ' ' + uiText('Refresh this run before trying again.');
        } finally {
          resuming = false;
        }
      });
      $('#workbook-run-heading').focus();
    } catch (e) {
      if (active()) {
        root.innerHTML = `<h2>${esc(uiText('Workbook report run'))}</h2><p class="error" role="alert">${esc(errorMessage(e))}</p><button id="workbook-run-refresh" class="button">${esc(uiText('Refresh run'))}</button>`;
        workspaceBind('#workbook-run-refresh', load);
      }
    } finally {
      if (active()) root.setAttribute('aria-busy', 'false');
    }
  };
  return {load};
}
function workbookQueryController(root, id) {
  const generation = navigationGeneration,
    identity = identityGeneration;
  let reviewSequence = 0,
    sequence = 0,
    preparedRun = null;
  const current = token =>
    token === sequence && generation === navigationGeneration && identity === identityGeneration && root.isConnected;
  const values = (form, q) => {
    const e = form.elements;
    let config = q.query_config;
    if (config.gateway || q.configuration_redacted) config = JSON.parse(e.configuration.value);
    else {
      const kind = e.window.value;
      config = {
        ...config,
        date_range:
          kind === 'fixed'
            ? {since: e.since.value, until: e.until.value}
            : {
                preset: kind,
                timezone: e.timezone.value,
                ...(kind === 'last_complete_days'
                  ? {days: Number(e.days.value), offset_days: Number(e.offset.value)}
                  : {}),
              },
      };
    }
    return {name: e.name.value, query_config: config};
  };
  const failure = (e, token) => {
    if (current(token)) root.querySelector('[data-query-status]').textContent = errorMessage(e);
  };
  async function load() {
    const token = ++sequence;
    root.setAttribute('aria-busy', 'true');
    try {
      const q = await workspaceCall('workspace', {action: 'report_query', id});
      if (!current(token)) return;
      const range = q.query_config.date_range ?? {},
        option = (value, label) =>
          `<option value="${value}" ${value === (range.preset ?? 'fixed') ? 'selected' : ''}>${label}</option>`;
      root.innerHTML = `<h2 id="workbook-query-heading" tabindex="-1">${esc(q.name)}</h2><p>${esc(uiText('Account'))} <strong>${esc(q.account_id)}</strong> · ${esc(q.gateway)} ${esc(uiText('· Connection'))} ${esc(q.connection_id)}</p><p class="notice">${esc(uiText('Review changes before saving. A changed definition pauses active schedules for separate review and creates one prepared report. Existing runs keep their original configuration. Changing accounts or providers requires a separate query.'))}</p>${q.configuration_redacted ? `<p class="error">${esc(uiText('Credentials were removed from this legacy configuration. Keep credentials in Connections and remove credential fields from the advanced query before reviewing.'))}</p>` : ''}<form id="workbook-query-form"><fieldset ${q.can_edit && !q.schedules_truncated ? '' : 'disabled'}><label>${esc(uiText('Query name'))}<input name="name" maxlength="120" required value="${esc(q.name)}"></label>${q.query_config.gateway || q.configuration_redacted ? `<details class="workspace-details" ${q.configuration_redacted ? 'open' : ''}><summary>${esc(uiText('Advanced query configuration'))}</summary><label>${esc(uiText('Complete query JSON'))}<textarea name="configuration" rows="12" maxlength="65536" required>${esc(JSON.stringify(q.query_config, null, 2))}</textarea></label><p>${esc(uiText('Use an independently supported read with explicit account and connection. Credentials and advertising writes are refused.'))}</p></details>` : `<div class="work-filter"><label>${esc(uiText('Report window'))}<select name="window">${option('fixed', uiText('Explicit dates'))}${option('last_complete_days', uiText('Last complete days'))}${option('last_complete_week', uiText('Last complete calendar week'))}${option('last_complete_month', uiText('Last complete calendar month'))}</select></label><label>${esc(uiText('Start date'))}<input type="date" name="since" value="${esc(range.since ?? '')}"></label><label>${esc(uiText('End date'))}<input type="date" name="until" value="${esc(range.until ?? '')}"></label><label>${esc(uiText('Complete days'))}<input type="number" name="days" min="1" max="366" value="${esc(range.days ?? 7)}"></label><label>${esc(uiText('Skip recent days'))}<input type="number" name="offset" min="0" max="90" value="${esc(range.offset_days ?? 0)}"></label><label>${esc(uiText('Report calendar timezone'))}<input name="timezone" maxlength="80" value="${esc(range.timezone ?? 'UTC')}"></label></div><p class="form-note">${esc(uiText('Explicit dates use start/end. Rolling days use the day count and recent-day offset. Rolling calendar weeks/months use the timezone and ignore the day count. This timezone is separate from the schedule clock.'))}</p>`}<button type="submit" class="button primary">${esc(uiText('Review query changes'))}</button></fieldset></form><div id="workbook-query-preview"></div><p data-query-status role="status"></p><p><a class="button" href="/operations?workbook_binding_id=${encodeURIComponent(q.workbook_binding_id)}">${esc(uiText('Inspect current workbook setup'))}</a>${q.can_edit ? `<a class="button" href="/operations?move_query_id=${encodeURIComponent(q.id)}">${esc(uiText('Move saved query'))}</a>` : ''}</p><h3>${esc(uiText('Linked schedules'))}</h3>${q.schedules.map(s => `<a class="button small" href="/operations?workbook_schedule_id=${encodeURIComponent(s.id)}">${s.active ? uiText('Active') : uiText('Paused')} ${esc(uiText('schedule'))} ${esc(s.id)}</a>`).join('') || `<p>${esc(uiText('No linked schedules.'))}</p>`}${q.schedules_truncated ? `<p>${esc(uiText('This editor supports up to 100 linked schedules.'))}</p>` : ''}${preparedRun ? `<p><a class="button" href="/operations?run_id=${encodeURIComponent(preparedRun)}">${esc(uiText('Inspect prepared report'))}</a></p>` : ''}`;
      workspaceBind('#workbook-query-form', async form => {
        if (!current(token) || !q.can_edit || q.schedules_truncated) return;
        const reviewToken = ++reviewSequence;
        try {
          const query = values(form, q),
            captured = JSON.stringify(query);
          const unchanged = () =>
            reviewToken === reviewSequence && current(token) && JSON.stringify(values(form, q)) === captured;
          const preview = await workspaceCall('workspace', {
            action: 'preview_report_query',
            id,
            query_version: q.query_version,
            query,
          });
          if (!unchanged()) return;
          $('#workbook-query-preview').innerHTML =
            `<h3>${esc(uiText('Review this query revision'))}</h3><p>${esc(uiText('Changed:'))} ${esc(preview.changes.join(', ') || uiText('No definition changes'))}.</p><p><strong>${esc(preview.schedules_to_pause)} ${esc(uiText('active schedules will pause.'))}</strong> ${esc(uiText('Existing reports stay intact; the new report remains prepared until separately resumed.'))}</p>${recordDetails(preview.query, uiText('Exact proposed query'))}<button id="workbook-query-save" class="button primary">${esc(uiText('Save reviewed query'))}</button>`;
          workspaceBind('#workbook-query-save', async () => {
            try {
              if (!unchanged()) {
                failure(Error(uiText('The form changed. Review it again before saving.')), token);
                return;
              }
              const accepted = await confirmAction({
                title: uiText('Save this query revision?'),
                consequence: uiText(
                  'Save the inspected definition for account {account}. Pause {count} active schedules and create one unsubmitted report. Existing runs remain unchanged.',
                  {account: q.account_id, count: preview.schedules_to_pause},
                ),
                confirmLabel: uiText('Save reviewed query'),
              });
              if (!accepted || !unchanged()) return;
              const result = await workspaceCall('workspace', {
                action: 'save_report_query',
                id,
                query_version: preview.query_version,
                query: preview.query,
                confirmed: true,
              });
              if (!current(token)) return;
              preparedRun = result.prepared_run_id;
              await load();
              if (current(sequence)) $('#workbook-query-heading')?.focus();
            } catch (e) {
              failure(e, token);
            }
          });
        } catch (e) {
          failure(e, token);
        }
      });
    } catch (e) {
      if (current(token))
        root.innerHTML = `<h2>${esc(uiText('Saved query unavailable'))}</h2><p class="error" role="alert">${esc(errorMessage(e))}</p>`;
    } finally {
      if (current(token)) root.setAttribute('aria-busy', 'false');
    }
  }
  return {load};
}
async function renderOperationsCenter() {
  const params = new URLSearchParams(location.search);
  if (params.has('move_query_id')) return renderWorkbookQueryMove(params);
  if (params.has('bindings') || params.has('workbook_binding_id')) return renderWorkbookBindings(params);
  const kindOptions = [
    'all',
    'campaign',
    'upload',
    'report',
    'export',
    'schedule',
    'incident',
    'workbook_report',
    'workbook_schedule',
    'write',
  ];
  const stateOptions = ['all', 'attention', 'active', 'complete', 'deferred'];
  const option = (values, selected) =>
    values
      .map(v => `<option value="${v}" ${v === selected ? 'selected' : ''}>${esc(operationLabel(v))}</option>`)
      .join('');
  content.innerHTML = header(
    uiText('Operations'),
    uiText(
      'Follow work across campaigns, uploads, reports and monitoring. Open the original record to inspect its evidence and continue.',
    ),
  );
  content.innerHTML += `<div class="dialog-actions work-actions"><a class="button" href="/operations?bindings=1">${esc(uiText('Workbook setup'))}</a><a class="button" href="/monitors">${esc(uiText('Monitoring inbox'))}</a><a class="button" href="/schedules">${esc(uiText('Schedules & deliveries'))}</a><a class="button" href="/activity">${esc(uiText('Audit activity'))}</a><button id="operations-refresh" class="button">${esc(uiText('Refresh'))}</button></div>${params.has('run_id') ? `<section class="panel" id="workbook-run-detail" aria-label="${esc(uiText('Workbook report run'))}"><p role="status">${esc(uiText('Loading original run…'))}</p></section>` : ''}${params.has('workbook_schedule_id') ? `<section class="panel" id="workbook-schedule-detail" aria-label="${esc(uiText('Workbook schedule'))}"><p role="status">${esc(uiText('Loading schedule…'))}</p></section>` : ''}${params.has('write_id') ? `<section class="panel" id="write-record-detail" aria-label="${esc(uiText('Reviewed change'))}"><p role="status">${esc(uiText('Loading original review…'))}</p></section>` : ''}<section class="panel workspace-form"><form id="operations-filter" class="work-filter"><label>${esc(uiText('Work type'))}<select name="kind">${option(kindOptions, params.get('kind') ?? (params.has('run_id') ? 'workbook_report' : params.has('workbook_schedule_id') ? 'workbook_schedule' : params.has('write_id') ? 'write' : 'all'))}</select></label><label>${esc(uiText('Attention'))}<select name="state">${option(stateOptions, params.get('state') ?? 'all')}</select></label><label>${esc(uiText('Search name or ID'))}<input type="search" name="search" maxlength="200" value="${esc(params.get('search'))}"></label><label>${esc(uiText('Account ID'))}<input name="account_id" maxlength="200" value="${esc(params.get('account_id'))}"></label><button class="button primary" type="submit">${esc(uiText('Apply filters'))}</button></form></section><section class="panel" id="operations-results" aria-label="${esc(uiText('Operations results'))}"><p data-page-status role="status">${esc(uiText('Loading operations…'))}</p></section><p class="form-note">${esc(uiText('Includes retained campaign plans, upload reviews, reporting snapshots, export jobs, overview schedules, incidents, workbook report runs, workbook schedules and reviewed changes with identifiable account scope within your current access. Updates can move records between pages; refresh for the latest state.'))}</p>${session.administrator || session.workspaceRole === 'owner' ? `<section class="panel"><h2>${esc(uiText('Owner diagnostics'))}</h2><p>${esc(uiText('Inspect a sanitized support bundle before downloading it.'))}</p><button id="support-bundle" class="button">${esc(uiText('Prepare support bundle'))}</button><div id="support-bundle-result"></div><a class="button owner-settings-link" href="/settings">${esc(uiText('Policies, retention and deployment controls'))}</a></section>` : ''}`;
  content.innerHTML += `${params.has('query_id') ? `<section id="workbook-query-detail" class="panel workspace-form" aria-label="${esc(uiText('Saved workbook query'))}"><p role="status">${esc(uiText('Loading saved query…'))}</p></section>` : ''}<details class="panel" ${params.has('queries') || params.has('query_id') ? 'open' : ''}><summary>${esc(uiText('Saved workbook queries'))}</summary><p>${esc(uiText('Inspect reusable queries, review their reporting window and follow their original schedules. Outputs stay in this workspace.'))}</p><form id="workbook-query-filter" class="work-filter"><label>${esc(uiText('Query search'))}<input type="search" name="search" maxlength="200"></label><button type="submit" class="button">${esc(uiText('Find queries'))}</button></form><section id="workbook-query-list"><p data-page-status role="status">${esc(uiText('Loading queries…'))}</p></section></details>`;
  let querySearch = '';
  const queryPager = workPageLoader(
    '#workbook-query-list',
    uiText('Saved queries'),
    offset =>
      workspaceCall('workspace', {action: 'report_queries', search: querySearch, offset: offset ?? 0, limit: 20}),
    r =>
      r.queries
        .map(
          q =>
            `<article class="operation-card"><h3>${esc(q.name)}</h3><p>${esc(uiText('Account'))} ${esc(q.account_id)} · ${esc(q.gateway)} ${esc(uiText('· Revision'))} ${esc(q.revision)}</p><a class="button small" href="/operations?query_id=${encodeURIComponent(q.id)}">${esc(uiText('Inspect saved query'))}</a></article>`,
        )
        .join('') || `<p>${esc(uiText('No accessible queries on this page.'))}</p>`,
  );
  workspaceBind('#workbook-query-filter', form => {
    querySearch = form.elements.search.value;
    return queryPager.load();
  });
  const savedQuery = params.has('query_id')
    ? workbookQueryController($('#workbook-query-detail'), params.get('query_id'))
    : null;
  const form = $('#operations-filter');
  let filters = Object.fromEntries(new FormData(form));
  const pager = workPageLoader(
    '#operations-results',
    uiText('Work and attention'),
    cursor => workspaceCall('workspace', {action: 'operations', ...filters, limit: 20, ...(cursor ? {cursor} : {})}),
    result =>
      result.operations.map(operationCard).join('') ||
      blank(
        result.has_more
          ? uiText('No matching work on this page. Continue to the next page.')
          : uiText('No matching operations within your current access.'),
      ),
  );
  workspaceBind('#operations-filter', () => {
    filters = Object.fromEntries(new FormData(form));
    const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v && v !== 'all'));
    if (params.has('run_id')) query.set('run_id', params.get('run_id'));
    if (params.has('workbook_schedule_id')) query.set('workbook_schedule_id', params.get('workbook_schedule_id'));
    if (params.has('query_id')) query.set('query_id', params.get('query_id'));
    if (params.has('write_id')) query.set('write_id', params.get('write_id'));
    history.replaceState(null, '', '/operations' + (query.size ? '?' + query : ''));
    return pager.load();
  });
  const run = params.has('run_id')
    ? workbookRunController($('#workbook-run-detail'), params.get('run_id'), () => pager.load())
    : null;
  const schedule = params.has('workbook_schedule_id')
    ? workbookScheduleController($('#workbook-schedule-detail'), params.get('workbook_schedule_id'), () => pager.load())
    : null;
  const write = params.has('write_id')
    ? writeRecordController($('#write-record-detail'), params.get('write_id'), () => pager.load())
    : null;
  workspaceBind('#operations-refresh', () =>
    Promise.all([
      pager.load(),
      queryPager.load(),
      ...(savedQuery ? [savedQuery.load()] : []),
      ...(run ? [run.load()] : []),
      ...(schedule ? [schedule.load()] : []),
      ...(write ? [write.load()] : []),
    ]),
  );
  workspaceBind('#support-bundle', async () => {
    const bundle = await workspaceCall('workspace', {action: 'support_bundle'});
    $('#support-bundle-result').innerHTML =
      recordDetails(bundle, uiText('Inspect support bundle')) +
      `<button id="download-support" class="button">${esc(uiText('Download this bundle'))}</button>`;
    workspaceBind('#download-support', () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], {type: 'application/json'})),
        link = document.createElement('a');
      link.href = url;
      link.download = 'AMCP-support-bundle.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  });
  await Promise.all([
    pager.load(),
    queryPager.load(),
    ...(savedQuery ? [savedQuery.load()] : []),
    ...(run ? [run.load()] : []),
    ...(schedule ? [schedule.load()] : []),
    ...(write ? [write.load()] : []),
  ]);
}
function incidentCard(i, detail = false) {
  return `<article class="operation-card"><div class="operation-heading"><div><h3>${esc(i.monitor_name)}</h3><small>${esc(i.platform)} · ${esc(i.account_id)} · ${esc(i.date_from)} — ${esc(i.date_to)}</small></div>${badge(i.attention_state)}</div><p>${esc(operationLabel(i.metric))}: <strong>${esc(i.value)}</strong> ${esc(uiText('· Trigger'))} ${esc(operationLabel(i.comparison))} ${esc(i.threshold)}${['spend', 'cpa'].includes(i.metric) ? ' ' + esc(i.currency) : ''}</p><p class="form-note">${esc(i.result_definition)} · ${esc(i.attribution)} · ${esc(i.timezone)}</p>${i.attention_state === 'snoozed' ? `<p>${esc(uiText('Attention resumes'))} ${date(i.snoozed_until)}</p>` : ''}<div class="dialog-actions work-actions">${detail ? '' : `<a class="button small" href="/monitors?incident_id=${encodeURIComponent(i.id)}">${esc(uiText('Inspect incident'))}</a>`}<a href="/reporting-overview?report_id=${encodeURIComponent(i.last_report_id)}">${esc(uiText('Supporting snapshot'))}</a></div></article>`;
}
async function renderIncidentDetail(id) {
  const root = $('#incident-detail'),
    generation = navigationGeneration;
  try {
    const i = await workspaceCall('workspace', {action: 'incident', id});
    if (generation !== navigationGeneration || !root.isConnected) return;
    const disabled = session.workspaceRole === 'viewer' || ['resolved', 'superseded'].includes(i.attention_state);
    root.innerHTML = `<h2>${esc(uiText('Incident evidence'))}</h2>${incidentCard(i, true)}${i.superseded_by_version ? `<p class="notice">${esc(uiText('Superseded by rule version'))} ${i.superseded_by_version}${esc(uiText('. This incident retains its original evidence and has not been resolved by a newer snapshot.'))}</p>` : ''}<p>${esc(uiText('Evidence observed'))} ${date(i.observed_at)}. ${i.acknowledged_at ? uiText('Acknowledged ') + date(i.acknowledged_at) + '.' : ''}</p><p class="notice">${esc(uiText('Snooze defers attention. Evaluation continues, and only fresh, complete, comparable evidence can resolve the incident. Expiry restores its prior open or acknowledged state.'))}</p><div class="dialog-actions work-actions">${i.state === 'open' ? `<button id="incident-ack" class="button" ${disabled ? 'disabled' : ''}>${esc(uiText('Acknowledge'))}</button>` : ''}${i.attention_state === 'snoozed' ? `<button id="incident-resume" class="button" ${disabled ? 'disabled' : ''}>${esc(uiText('Resume attention now'))}</button>` : ''}</div><form id="incident-snooze" class="work-filter"><label>${esc(uiText('Defer attention'))}<select name="snooze_hours" ${disabled ? 'disabled' : ''}><option value="1">${esc(uiText('1 hour'))}</option><option value="4">${esc(uiText('4 hours'))}</option><option value="24">${esc(uiText('24 hours'))}</option><option value="168">${esc(uiText('7 days'))}</option></select></label><button type="submit" class="button" ${disabled ? 'disabled' : ''}>${esc(uiText('Snooze incident'))}</button></form><h3>${esc(uiText('Recent evidence'))}</h3><div class="evidence-trail">${(i.evidence ?? []).map(e => `<div><strong>${esc(operationLabel(i.metric))} ${esc(e.value)}</strong><small>${date(e.captured_at)}</small><a href="/reporting-overview?report_id=${encodeURIComponent(e.report_id)}">${esc(uiText('Inspect snapshot'))}</a><code>${esc(e.source_hash)}</code></div>`).join('') || `<p>${esc(uiText('No retained evidence entries.'))}</p>`}</div><a class="button small" href="/monitors?monitor_id=${encodeURIComponent(i.monitor_id)}">${esc(uiText('Inspect monitor rule'))}</a>`;
    const change = async (action, extra = {}) => {
      await workspaceCall('workspace', {action, id: i.id, revision: i.revision, ...extra});
      await renderWorkspacePage();
      toast(
        action === 'snooze_incident'
          ? uiText('Attention deferred. Evidence evaluation continues.')
          : action === 'resume_incident'
            ? uiText('Incident attention resumed.')
            : uiText('Incident acknowledged.'),
      );
    };
    workspaceBind('#incident-ack', () => change('acknowledge_incident'));
    workspaceBind('#incident-resume', () => change('resume_incident'));
    workspaceBind('#incident-snooze', form =>
      change('snooze_incident', {snooze_hours: Number(form.elements.snooze_hours.value)}),
    );
  } catch (e) {
    if (generation === navigationGeneration && root.isConnected)
      root.innerHTML = `<h2>${esc(uiText('Incident unavailable'))}</h2><p class="error" role="alert">${esc(errorMessage(e))}</p><a href="/monitors">${esc(uiText('Return to the inbox'))}</a>`;
  }
}
function monitorFields(m = {}) {
  return `${controls(uiText('Rule name'), 'text', m.name ?? '', 'name')}<label>${esc(uiText('Metric'))}<select name="metric">${['spend', 'clicks', 'conversions', 'cpa'].map(k => `<option value="${k}" ${m.metric === k ? 'selected' : ''}>${esc(k === 'cpa' ? uiText('Cost per conversion') : operationLabel(k))}</option>`).join('')}</select></label><label>${esc(uiText('Trigger when'))}<select name="comparison"><option value="above" ${m.comparison === 'above' ? 'selected' : ''}>${esc(uiText('Above threshold'))}</option><option value="below" ${m.comparison === 'below' ? 'selected' : ''}>${esc(uiText('Below threshold'))}</option></select></label>${controls(uiText('Threshold in native metric units'), 'text', m.threshold ?? '', 'threshold')}${controls(uiText('Maximum evidence age in hours'), 'number', m.max_age_hours ?? 24, 'max_age_hours')}`;
}
function monitorValues(form, context) {
  return {
    ...Object.fromEntries(
      ['platform', 'connection_id', 'account_id', 'currency', 'timezone', 'result_definition', 'attribution'].map(k => [
        k,
        context[k],
      ]),
    ),
    name: form.elements.name.value,
    metric: form.elements.metric.value,
    comparison: form.elements.comparison.value,
    threshold: form.elements.threshold.value,
    max_age_hours: Number(form.elements.max_age_hours.value),
  };
}
function monitorNotificationController(root, id) {
  const generation = navigationGeneration,
    identity = identityGeneration;
  let sequence = 0;
  const current = token =>
    token === sequence && generation === navigationGeneration && identity === identityGeneration && root.isConnected;
  async function change(args, token) {
    try {
      await workspaceCall('workspace', args);
      if (current(token)) await load();
    } catch (e) {
      if (current(token))
        root.innerHTML = `<h3>${esc(uiText('Email notices need attention'))}</h3><p class="error" role="alert">${esc(errorMessage(e))}</p><button id="monitor-email-refresh" class="button">${esc(uiText('Refresh notification status'))}</button>`;
      if (current(token)) workspaceBind('#monitor-email-refresh', load);
    }
  }
  async function load() {
    const token = ++sequence;
    try {
      const s = await workspaceCall('workspace', {action: 'monitor_notifications', id});
      if (!current(token)) return;
      root.innerHTML = `<h3>${esc(uiText('Your email notices'))}</h3><p>${esc(uiText('Email sends a brief notice and a sign-in link to your own verified address for future openings, reopenings and resolutions. Detailed account and performance evidence stays in the inbox. Updating a rule requires a new opt-in.'))}</p><p class="form-note">${esc(uiText("Delivery requires the deployment's configured email worker. Pending means awaiting that worker. Sent means the provider accepted the message; inbox delivery is not verified. Snooze defers pending attention, acknowledgement cancels it, and pausing the rule stops unsent notices."))}</p>${s.reason ? `<p role="status">${esc(pretty(s.reason))}</p>` : ''}<button id="monitor-email-toggle" class="button" ${s.eligible ? '' : 'disabled'}>${s.enabled ? uiText('Turn off my email notices') : uiText('Enable email notices for me')}</button><p class="form-note">${esc(uiText('Five automatic attempts, then one confirmed retry of the original notice permits up to ten attempts total. Every attempt must fit within the original 24-hour lifetime.'))}</p><h4>${esc(uiText('Recent delivery activity'))}</h4>${s.deliveries.length ? s.deliveries.map(n => `<article class="operation-card"><strong>${esc(operationLabel(n.event))} · ${esc(operationLabel(n.state))}</strong><p>${esc(n.attempts)} ${esc(uiText('attempts ·'))} ${date(n.created_at)}${n.next_attempt_at ? uiText(' · Next attempt {date}', {date: date(n.next_attempt_at)}) : ''}</p>${n.reason ? `<p>${esc(pretty(n.reason))}</p>` : ''}<div class="dialog-actions work-actions"><a href="/monitors?incident_id=${encodeURIComponent(n.incident_id)}">${esc(uiText('Inspect incident'))}</a>${n.retry_available ? `<button class="button small" data-retry-monitor-notice="${esc(n.id)}">${esc(uiText('Retry original notice'))}</button>` : ''}</div></article>`).join('') : `<p>${esc(uiText('No delivery activity for this subscription yet. Existing incidents are not backfilled.'))}</p>`}`;
      workspaceBind('#monitor-email-toggle', async () => {
        if (!current(token) || !s.eligible) return;
        const enabled = !s.enabled;
        if (
          !(await confirmAction({
            title: enabled ? uiText('Enable your email notices?') : uiText('Turn off your email notices?'),
            consequence: enabled
              ? uiText(
                  'Future incident openings, reopenings and resolutions for this rule may send a brief email to your verified account address. No report contents are included. Existing incidents are not backfilled.',
                )
              : uiText(
                  'Cancel unsent notices for this subscription. A message already sent to the provider cannot be recalled.',
                ),
            confirmLabel: enabled ? uiText('Enable email notices') : uiText('Turn off notices'),
          })) ||
          !current(token)
        )
          return;
        await change(
          {
            action: 'set_monitor_notifications',
            id,
            enabled,
            subscription_version: s.subscription_version,
            confirmed: true,
          },
          token,
        );
      });
      workspaceBind('[data-retry-monitor-notice]', async button => {
        const n = s.deliveries.find(n => n.id === button.dataset.retryMonitorNotice);
        if (!current(token) || !n?.retry_available) return;
        if (
          !(await confirmAction({
            title: uiText('Retry this original notice?'),
            consequence: uiText(
              'Retry the same recipient, payload and provider identity within its original expiry. Current access, rule and incident are checked again.',
            ),
            confirmLabel: uiText('Retry original notice'),
          })) ||
          !current(token)
        )
          return;
        await change(
          {
            action: 'retry_monitor_notification',
            notification_id: n.id,
            notification_version: n.notification_version,
            confirmed: true,
          },
          token,
        );
      });
    } catch (e) {
      if (current(token))
        root.innerHTML = `<h3>${esc(uiText('Email notices unavailable'))}</h3><p class="error" role="alert">${esc(errorMessage(e))}</p>`;
    }
  }
  return {load};
}
async function renderMonitorEditor(id) {
  const root = $('#monitor-detail'),
    generation = navigationGeneration;
  try {
    const m = await workspaceCall('workspace', {action: 'monitor', id});
    if (generation !== navigationGeneration || !root.isConnected) return;
    root.innerHTML = `<h2>${esc(uiText('Edit monitor rule'))}</h2><p>${esc(m.platform)} · ${esc(m.account_id)} · ${esc(m.currency)} · ${esc(m.timezone)}<br>${esc(m.result_definition)} · ${esc(m.attribution)} ${esc(uiText('· Rule version'))} ${m.rule_version}</p><p>${esc(uiText('Saving creates a new rule version. Older unresolved incidents become superseded, keeping their original rule and evidence. They are not marked resolved.'))} ${m.active ? uiText('The rule remains active.') : uiText('The rule remains paused.')}</p><form id="edit-monitor"><fieldset ${session.workspaceRole === 'viewer' ? 'disabled' : ''}>${monitorFields(m)}<label class="form-note"><input type="checkbox" name="confirmed" required> ${esc(uiText('Save this revised rule for this account and measurement context.'))}</label><button class="button primary" type="submit">${esc(uiText('Save rule revision'))}</button></fieldset></form>`;
    root.innerHTML += `<section id="monitor-email-settings" class="panel" aria-label="${esc(uiText('Your monitor email notices'))}"><p role="status">${esc(uiText('Loading your notification settings…'))}</p></section>`;
    const emailSettings = monitorNotificationController($('#monitor-email-settings'), id);
    await emailSettings.load();
    if (generation !== navigationGeneration || !root.isConnected) return;
    workspaceBind('#edit-monitor', async form => {
      await workspaceCall('workspace', {
        action: 'save_monitor',
        id: m.id,
        revision: m.revision,
        confirmed: form.elements.confirmed.checked,
        monitor: monitorValues(form, m),
      });
      await renderWorkspacePage();
      toast(uiText('New rule version saved. Existing incidents retain their evidence.'));
    });
  } catch (e) {
    if (generation === navigationGeneration && root.isConnected)
      root.innerHTML = `<h2>${esc(uiText('Rule unavailable'))}</h2><p class="error" role="alert">${esc(errorMessage(e))}</p>`;
  }
}
async function renderMonitors() {
  const params = new URLSearchParams(location.search),
    reader = session.workspaceRole === 'viewer';
  content.innerHTML = header(
    uiText('Monitoring inbox'),
    uiText('Follow evidence, triage incidents and adjust account-specific rules.'),
  );
  content.innerHTML += `<div class="dialog-actions work-actions"><a href="/operations" class="button">${esc(uiText('All operations'))}</a><a href="/reporting-overview" class="button">${esc(uiText('Reporting snapshots'))}</a><button id="monitors-refresh" class="button">${esc(uiText('Refresh inbox'))}</button></div><p class="notice">${esc(uiText('Rules evaluate retained reporting snapshots and deliver incidents here. They never launch advertising changes. Email notices require your separate opt-in on each monitor rule. Missing or stale evidence cannot resolve an incident.'))}</p>${params.has('incident_id') ? `<section id="incident-detail" class="panel workspace-form"><p role="status">${esc(uiText('Loading incident…'))}</p></section>` : ''}${params.has('monitor_id') ? `<section id="monitor-detail" class="panel workspace-form"><p role="status">${esc(uiText('Loading rule…'))}</p></section>` : ''}<section class="panel workspace-form"><form id="incident-filter" class="work-filter"><label>${esc(uiText('Incident state'))}<select name="state">${['all', 'open', 'acknowledged', 'snoozed', 'resolved', 'superseded'].map(k => `<option value="${k}">${esc(operationLabel(k))}</option>`).join('')}</select></label><label>${esc(uiText('Rule or account search'))}<input type="search" name="search" maxlength="200"></label><label>${esc(uiText('Account ID'))}<input name="account_id" maxlength="200"></label><button type="submit" class="button">${esc(uiText('Filter incidents'))}</button></form></section><section id="incident-list" class="panel"><p data-page-status role="status">${esc(uiText('Loading incidents…'))}</p></section><section class="panel workspace-form"><form id="monitor-filter" class="work-filter"><label>${esc(uiText('Rule state'))}<select name="state"><option value="all">${esc(uiText('All rules'))}</option><option value="active">${esc(uiText('Active'))}</option><option value="paused">${esc(uiText('Paused'))}</option></select></label><label>${esc(uiText('Rule or account search'))}<input type="search" name="search" maxlength="200"></label><button type="submit" class="button">${esc(uiText('Filter rules'))}</button></form></section><section id="monitor-list" class="panel"><p data-page-status role="status">${esc(uiText('Loading rules…'))}</p></section><section class="panel workspace-form"><h2>${esc(uiText('Create a rule from retained evidence'))}</h2><p>${esc(uiText('Open a retained snapshot and choose Create a monitor, or enter its ID below. Account, currency, timezone, result definition and attribution come from that snapshot.'))} <a href="/report-library">${esc(uiText('Browse snapshots'))}</a>.</p><form id="monitor-source-form"><label>${esc(uiText('Snapshot ID'))}<input name="report_id" maxlength="160" required value="${esc(params.get('report_id'))}"></label><button type="submit" class="button" ${reader ? 'disabled' : ''}>${esc(uiText('Choose measurement context'))}</button></form><div id="monitor-rule"></div></section>`;
  const readFilters = (prefix, selector) => {
    const form = $(selector),
      result = {};
    for (const key of ['state', 'search', 'account_id']) {
      if (form.elements[key] && params.has(prefix + key)) form.elements[key].value = params.get(prefix + key);
      if (form.elements[key]) result[key] = form.elements[key].value;
    }
    return result;
  };
  const rememberFilters = (prefix, values) => {
    const query = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries(values)) {
      if (value && value !== 'all') query.set(prefix + key, value);
      else query.delete(prefix + key);
    }
    history.replaceState(null, '', '/monitors' + (query.size ? '?' + query : ''));
  };
  let incidentFilters = readFilters('incident_', '#incident-filter'),
    monitorFilters = readFilters('rule_', '#monitor-filter');
  const incidents = workPageLoader(
    '#incident-list',
    uiText('Incidents'),
    offset => workspaceCall('workspace', {action: 'incidents', ...incidentFilters, offset: offset ?? 0, limit: 20}),
    r =>
      r.incidents.map(i => incidentCard(i)).join('') ||
      blank(uiText('No incidents match these filters within your current access.')),
  );
  const rules = workPageLoader(
    '#monitor-list',
    uiText('Monitor rules'),
    offset => workspaceCall('workspace', {action: 'monitors', ...monitorFilters, offset: offset ?? 0, limit: 20}),
    r =>
      r.monitors
        .map(
          m =>
            `<article class="operation-card"><div class="operation-heading"><div><h3>${esc(m.name)}</h3><small>${esc(m.account_id)} · ${esc(m.result_definition)} · ${esc(m.metric)} ${esc(m.comparison)} ${esc(m.threshold)}</small></div>${badge(m.active ? 'active' : 'paused')}</div><p>${esc(uiText('Latest evaluation:'))} ${esc(pretty(m.last_evaluation?.status ?? uiText('Awaiting a completed snapshot')))}${m.last_evaluation ? ' · ' + date(m.last_evaluation.evaluated_at) : ''}</p><div class="dialog-actions work-actions"><a class="button small" href="/monitors?monitor_id=${encodeURIComponent(m.id)}">${esc(uiText('Inspect or edit rule'))}</a><button class="button small" data-toggle-monitor="${esc(m.id)}" ${reader ? 'disabled' : ''}>${m.active ? uiText('Pause') : uiText('Resume')}</button></div></article>`,
        )
        .join('') || blank(uiText('No rules match these filters.')),
    result => {
      workspaceBind('#monitor-list [data-toggle-monitor]', async b => {
        const m = result.monitors.find(m => m.id === b.dataset.toggleMonitor);
        await workspaceCall('workspace', {
          action: 'set_monitor_state',
          id: m.id,
          revision: m.revision,
          active: !m.active,
          confirmed: true,
        });
        await rules.load();
        toast(m.active ? uiText('Monitor paused.') : uiText('Monitor resumed with current access.'));
      });
    },
  );
  workspaceBind('#incident-filter', form => {
    incidentFilters = Object.fromEntries(new FormData(form));
    rememberFilters('incident_', incidentFilters);
    return incidents.load();
  });
  workspaceBind('#monitor-filter', form => {
    monitorFilters = Object.fromEntries(new FormData(form));
    rememberFilters('rule_', monitorFilters);
    return rules.load();
  });
  workspaceBind('#monitors-refresh', () => renderWorkspacePage());
  workspaceBind('#monitor-source-form', async form => {
    const report = await overviewCall({action: 'get', id: form.elements.report_id.value.trim(), limit: 1});
    const contexts = (report.summary ?? []).flatMap(s => {
      const sources = report.config.sources.filter(x => x.platform === s.platform && x.account_id === s.account_id);
      return sources.length === 1 && s.complete ? [{...sources[0], ...s}] : [];
    });
    if (!contexts.length)
      throw Error(
        uiText('This snapshot has no complete, unambiguous measurement context. Open its source evidence first.'),
      );
    $('#monitor-rule').innerHTML =
      `<form id="save-monitor"><label>${esc(uiText('Account and measurement context'))}<select name="context" required>${contexts.map((s, i) => `<option value="${i}">${esc(s.platform)} · ${esc(s.account_id)} · ${esc(s.currency)} · ${esc(s.timezone)} · ${esc(s.result_definition)} · ${esc(s.attribution)}</option>`).join('')}</select></label><p>${esc(uiText('Each matching objective group is evaluated separately for this measurement context.'))}</p>${monitorFields()}<label class="form-note"><input name="confirmed" type="checkbox" required> ${esc(uiText('Save this rule and deliver incidents to this inbox.'))}</label><button class="button primary" type="submit">${esc(uiText('Save and evaluate snapshot'))}</button></form>`;
    workspaceBind('#save-monitor', async form => {
      await workspaceCall('workspace', {
        action: 'save_monitor',
        confirmed: form.elements.confirmed.checked,
        monitor: monitorValues(form, contexts[Number(form.elements.context.value)]),
      });
      await workspaceCall('workspace', {action: 'evaluate_monitors', report_id: report.id});
      await renderWorkspacePage();
      toast(uiText('Rule saved and snapshot evaluated.'));
    });
  });
  await Promise.all([
    incidents.load(),
    rules.load(),
    ...(params.has('incident_id') ? [renderIncidentDetail(params.get('incident_id'))] : []),
    ...(params.has('monitor_id') ? [renderMonitorEditor(params.get('monitor_id'))] : []),
  ]);
}
