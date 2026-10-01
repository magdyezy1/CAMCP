'use strict';

// Each loader owns its DOM node and request sequence. A late page cannot replace a newer filter, route or session.
function workPageLoader(selector, title, fetchPage, renderRows, bindRows = () => {}) {
  const root = $(selector),
    generation = navigationGeneration;
  let sequence = 0,
    page = 0,
    cursors = [undefined],
    next = null;
  const go = async (index = 0, reset = false) => {
    const request = ++sequence,
      cursor = reset ? undefined : cursors[index];
    root.setAttribute('aria-busy', 'true');
    const status = root.querySelector('[data-page-status]');
    if (status) status.textContent = 'Loading…';
    try {
      const result = await fetchPage(cursor);
      if (request !== sequence || generation !== navigationGeneration || !root.isConnected) return;
      page = index;
      if (reset) cursors = [undefined];
      next = result.next_cursor ?? result.next_offset ?? null;
      root.innerHTML = `<div class="panel-header"><h2>${esc(title)}</h2><span class="form-note">Page ${page + 1}${Number.isInteger(result.total) ? ' · ' + result.total + ' matching' : ''}</span></div>${renderRows(result)}<p data-page-status role="status">${next !== null ? 'More results are available.' : 'End of available results.'}</p><nav class="dialog-actions work-actions" aria-label="${esc(title)} pages"><button class="button small" data-page-prev ${page ? '' : 'disabled'}>Previous</button><button class="button small" data-page-next ${next !== null ? '' : 'disabled'}>Next</button></nav>`;
      workspaceBind(selector + ' [data-page-prev]', () => go(page - 1));
      workspaceBind(selector + ' [data-page-next]', () => {
        cursors[page + 1] = next;
        return go(page + 1);
      });
      bindRows(result);
    } catch (e) {
      if (request !== sequence || generation !== navigationGeneration || !root.isConnected) return;
      const current = root.querySelector('[data-page-status]');
      const message = 'Could not load this page. ' + errorMessage(e);
      if (current) current.textContent = message;
      else
        root.innerHTML = `<h2>${esc(title)}</h2><p class="error" role="alert">${esc(message)}</p><p>Apply the filters or refresh to try again.</p>`;
    } finally {
      if (request === sequence && generation === navigationGeneration && root.isConnected)
        root.setAttribute('aria-busy', 'false');
    }
  };
  return {load: () => go(0, true)};
}
function operationCard(op) {
  return `<article class="operation-card"><div class="operation-heading"><div><small>${esc(pretty(op.kind))} · ${op.updated_at ? date(op.updated_at) : 'Time unavailable'}</small><h3>${esc(op.name)}</h3></div>${badge(op.state)}</div><p class="form-note">Accounts ${op.accounts.map(esc).join(' · ')}</p><p>${esc(op.next_safe_action)}</p>${op.error_code ? `<p class="error">${esc(op.error_code)}</p>` : ''}${op.snoozed_until ? `<p>Attention resumes ${date(op.snoozed_until)}</p>` : ''}${op.next_run_at ? `<p>Next delivery ${date(op.next_run_at)}</p>` : ''}<div class="dialog-actions work-actions"><a class="button small" href="${esc(op.website_path)}">${op.kind === 'incident' ? 'Inspect incident' : 'Open original work'}</a></div>${recordDetails(op.next_call, 'Continue in MCP')}</article>`;
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
      root.innerHTML = `<div class="operation-heading"><div><small>Workbook reporting · Local output</small><h2 id="workbook-run-heading" tabindex="-1">${esc(run.name)}</h2></div>${badge(run.state)}</div><p><strong>Account ${esc(run.account_id)}</strong> · ${esc(run.gateway.replace('_native_action', '').replaceAll('_', ' '))}</p><p>${esc(run.next_safe_action)}</p>${run.error_code ? `<p class="error">${esc(run.error_code)}</p>` : ''}<p class="form-note">Query revision ${esc(run.query_revision ?? 'unknown')} · ${esc(run.attempts)} worker attempts · Updated ${date(run.updated_at)}</p><details class="workspace-details"><summary>Original run references</summary><p>Run <code>${esc(run.id)}</code></p><p>Query <code>${esc(run.query_id ?? 'Unavailable')}</code></p><p>Connection <code>${esc(run.connection_id)}</code></p>${run.schedule_id ? `<p>Schedule <code>${esc(run.schedule_id)}</code></p>` : ''}<p>Created ${date(run.created_at)}</p>${run.name_source === 'current_query' ? '<p>This older run uses the current query name for display. Its retained account scope and query revision determine access and execution.</p>' : ''}</details><p class="notice">This run stores its output in AMCP. It does not write a spreadsheet or change advertising settings. Resuming keeps the original query configuration; rolling dates are resolved when the worker executes.</p><div class="dialog-actions work-actions"><button id="workbook-run-refresh" class="button">Refresh run</button>${run.can_resume ? '<button id="workbook-run-resume" class="button primary">Resume report</button>' : ''}<a class="button" href="/connections">Review account access</a></div>${recordDetails(run.next_call, run.result_available ? 'Retrieve retained results in MCP' : 'Check this run in MCP')}<p data-run-status role="status"></p>`;
      workspaceBind('#workbook-run-refresh', load);
      workspaceBind('#workbook-run-resume', async () => {
        if (!active() || resuming || !run.can_resume) return;
        resuming = true;
        try {
          const confirmed = await confirmAction({
            title: 'Resume this report?',
            consequence:
              'Queue the original report for account ' +
              run.account_id +
              ' using your current access. The worker collects read-only data and retains the same run ID. Rolling dates resolve at execution.',
            confirmLabel: 'Resume report',
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
              errorMessage(e) + ' Refresh this run before trying again.';
        } finally {
          resuming = false;
        }
      });
      $('#workbook-run-heading').focus();
    } catch (e) {
      if (active()) {
        root.innerHTML = `<h2>Workbook report run</h2><p class="error" role="alert">${esc(errorMessage(e))}</p><button id="workbook-run-refresh" class="button">Refresh run</button>`;
        workspaceBind('#workbook-run-refresh', load);
      }
    } finally {
      if (active()) root.setAttribute('aria-busy', 'false');
    }
  };
  return {load};
}
async function renderOperationsCenter() {
  const params = new URLSearchParams(location.search);
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
  ];
  const stateOptions = ['all', 'attention', 'active', 'complete', 'deferred'];
  const option = (values, selected) =>
    values.map(v => `<option value="${v}" ${v === selected ? 'selected' : ''}>${esc(pretty(v))}</option>`).join('');
  content.innerHTML = header(
    'Operations',
    'Follow work across campaigns, uploads, reports and monitoring. Open the original record to inspect its evidence and continue.',
  );
  content.innerHTML += `<div class="dialog-actions work-actions"><a class="button" href="/monitors">Monitoring inbox</a><a class="button" href="/schedules">Schedules & deliveries</a><a class="button" href="/activity">Audit activity</a><button id="operations-refresh" class="button">Refresh</button></div>${params.has('run_id') ? '<section class="panel" id="workbook-run-detail" aria-label="Workbook report run"><p role="status">Loading original run…</p></section>' : ''}${params.has('workbook_schedule_id') ? '<section class="panel" id="workbook-schedule-detail" aria-label="Workbook schedule"><p role="status">Loading schedule…</p></section>' : ''}<section class="panel workspace-form"><form id="operations-filter" class="work-filter"><label>Work type<select name="kind">${option(kindOptions, params.get('kind') ?? (params.has('run_id') ? 'workbook_report' : params.has('workbook_schedule_id') ? 'workbook_schedule' : 'all'))}</select></label><label>Attention<select name="state">${option(stateOptions, params.get('state') ?? 'all')}</select></label><label>Search name or ID<input type="search" name="search" maxlength="200" value="${esc(params.get('search'))}"></label><label>Account ID<input name="account_id" maxlength="200" value="${esc(params.get('account_id'))}"></label><button class="button primary" type="submit">Apply filters</button></form></section><section class="panel" id="operations-results" aria-label="Operations results"><p data-page-status role="status">Loading operations…</p></section><p class="form-note">Includes retained campaign plans, upload reviews, reporting snapshots, export jobs, overview schedules, incidents, workbook report runs and workbook schedules with identifiable account scope within your current access. Updates can move records between pages; refresh for the latest state.</p>${session.administrator || session.workspaceRole === 'owner' ? '<section class="panel"><h2>Owner diagnostics</h2><p>Inspect a sanitized support bundle before downloading it.</p><button id="support-bundle" class="button">Prepare support bundle</button><div id="support-bundle-result"></div><a href="/settings">Policies, retention and deployment controls</a></section>' : ''}`;
  const form = $('#operations-filter');
  let filters = Object.fromEntries(new FormData(form));
  const pager = workPageLoader(
    '#operations-results',
    'Work and attention',
    cursor => workspaceCall('workspace', {action: 'operations', ...filters, limit: 20, ...(cursor ? {cursor} : {})}),
    result =>
      result.operations.map(operationCard).join('') ||
      blank(
        result.has_more
          ? 'No matching work on this page. Continue to the next page.'
          : 'No matching operations within your current access.',
      ),
  );
  workspaceBind('#operations-filter', () => {
    filters = Object.fromEntries(new FormData(form));
    const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v && v !== 'all'));
    if (params.has('run_id')) query.set('run_id', params.get('run_id'));
    if (params.has('workbook_schedule_id')) query.set('workbook_schedule_id', params.get('workbook_schedule_id'));
    history.replaceState(null, '', '/operations' + (query.size ? '?' + query : ''));
    return pager.load();
  });
  const run = params.has('run_id')
    ? workbookRunController($('#workbook-run-detail'), params.get('run_id'), () => pager.load())
    : null;
  const schedule = params.has('workbook_schedule_id')
    ? workbookScheduleController($('#workbook-schedule-detail'), params.get('workbook_schedule_id'), () => pager.load())
    : null;
  workspaceBind('#operations-refresh', () =>
    Promise.all([pager.load(), ...(run ? [run.load()] : []), ...(schedule ? [schedule.load()] : [])]),
  );
  workspaceBind('#support-bundle', async () => {
    const bundle = await workspaceCall('workspace', {action: 'support_bundle'});
    $('#support-bundle-result').innerHTML =
      recordDetails(bundle, 'Inspect support bundle') +
      '<button id="download-support" class="button">Download this bundle</button>';
    workspaceBind('#download-support', () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], {type: 'application/json'})),
        link = document.createElement('a');
      link.href = url;
      link.download = 'AMCP-support-bundle.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  });
  await Promise.all([pager.load(), ...(run ? [run.load()] : []), ...(schedule ? [schedule.load()] : [])]);
}
function incidentCard(i, detail = false) {
  return `<article class="operation-card"><div class="operation-heading"><div><h3>${esc(i.monitor_name)}</h3><small>${esc(i.platform)} · ${esc(i.account_id)} · ${esc(i.date_from)} — ${esc(i.date_to)}</small></div>${badge(i.attention_state)}</div><p>${esc(pretty(i.metric))}: <strong>${esc(i.value)}</strong> · Trigger ${esc(i.comparison)} ${esc(i.threshold)}${['spend', 'cpa'].includes(i.metric) ? ' ' + esc(i.currency) : ''}</p><p class="form-note">${esc(i.result_definition)} · ${esc(i.attribution)} · ${esc(i.timezone)}</p>${i.attention_state === 'snoozed' ? `<p>Attention resumes ${date(i.snoozed_until)}</p>` : ''}<div class="dialog-actions work-actions">${detail ? '' : `<a class="button small" href="/monitors?incident_id=${encodeURIComponent(i.id)}">Inspect incident</a>`}<a href="/reporting-overview?report_id=${encodeURIComponent(i.last_report_id)}">Supporting snapshot</a></div></article>`;
}
async function renderIncidentDetail(id) {
  const root = $('#incident-detail'),
    generation = navigationGeneration;
  try {
    const i = await workspaceCall('workspace', {action: 'incident', id});
    if (generation !== navigationGeneration || !root.isConnected) return;
    const disabled = session.workspaceRole === 'viewer' || ['resolved', 'superseded'].includes(i.attention_state);
    root.innerHTML = `<h2>Incident evidence</h2>${incidentCard(i, true)}${i.superseded_by_version ? `<p class="notice">Superseded by rule version ${i.superseded_by_version}. This incident retains its original evidence and has not been resolved by a newer snapshot.</p>` : ''}<p>Evidence observed ${date(i.observed_at)}. ${i.acknowledged_at ? 'Acknowledged ' + date(i.acknowledged_at) + '.' : ''}</p><p class="notice">Snooze defers attention. Evaluation continues, and only fresh, complete, comparable evidence can resolve the incident. Expiry restores its prior open or acknowledged state.</p><div class="dialog-actions work-actions">${i.state === 'open' ? `<button id="incident-ack" class="button" ${disabled ? 'disabled' : ''}>Acknowledge</button>` : ''}${i.attention_state === 'snoozed' ? `<button id="incident-resume" class="button" ${disabled ? 'disabled' : ''}>Resume attention now</button>` : ''}</div><form id="incident-snooze" class="work-filter"><label>Defer attention<select name="snooze_hours" ${disabled ? 'disabled' : ''}><option value="1">1 hour</option><option value="4">4 hours</option><option value="24">24 hours</option><option value="168">7 days</option></select></label><button type="submit" class="button" ${disabled ? 'disabled' : ''}>Snooze incident</button></form><h3>Recent evidence</h3><div class="evidence-trail">${(i.evidence ?? []).map(e => `<div><strong>${esc(pretty(i.metric))} ${esc(e.value)}</strong><small>${date(e.captured_at)}</small><a href="/reporting-overview?report_id=${encodeURIComponent(e.report_id)}">Inspect snapshot</a><code>${esc(e.source_hash)}</code></div>`).join('') || '<p>No retained evidence entries.</p>'}</div><a class="button small" href="/monitors?monitor_id=${encodeURIComponent(i.monitor_id)}">Inspect monitor rule</a>`;
    const change = async (action, extra = {}) => {
      await workspaceCall('workspace', {action, id: i.id, revision: i.revision, ...extra});
      await renderWorkspacePage();
      toast(
        action === 'snooze_incident'
          ? 'Attention deferred. Evidence evaluation continues.'
          : action === 'resume_incident'
            ? 'Incident attention resumed.'
            : 'Incident acknowledged.',
      );
    };
    workspaceBind('#incident-ack', () => change('acknowledge_incident'));
    workspaceBind('#incident-resume', () => change('resume_incident'));
    workspaceBind('#incident-snooze', form =>
      change('snooze_incident', {snooze_hours: Number(form.elements.snooze_hours.value)}),
    );
  } catch (e) {
    if (generation === navigationGeneration && root.isConnected)
      root.innerHTML = `<h2>Incident unavailable</h2><p class="error" role="alert">${esc(errorMessage(e))}</p><a href="/monitors">Return to the inbox</a>`;
  }
}
function monitorFields(m = {}) {
  return `${controls('Rule name', 'text', m.name ?? '', 'name')}<label>Metric<select name="metric">${['spend', 'clicks', 'conversions', 'cpa'].map(k => `<option value="${k}" ${m.metric === k ? 'selected' : ''}>${esc(k === 'cpa' ? 'Cost per conversion' : pretty(k))}</option>`).join('')}</select></label><label>Trigger when<select name="comparison"><option value="above" ${m.comparison === 'above' ? 'selected' : ''}>Above threshold</option><option value="below" ${m.comparison === 'below' ? 'selected' : ''}>Below threshold</option></select></label>${controls('Threshold in native metric units', 'text', m.threshold ?? '', 'threshold')}${controls('Maximum evidence age in hours', 'number', m.max_age_hours ?? 24, 'max_age_hours')}`;
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
        root.innerHTML = `<h3>Email notices need attention</h3><p class="error" role="alert">${esc(errorMessage(e))}</p><button id="monitor-email-refresh" class="button">Refresh notification status</button>`;
      if (current(token)) workspaceBind('#monitor-email-refresh', load);
    }
  }
  async function load() {
    const token = ++sequence;
    try {
      const s = await workspaceCall('workspace', {action: 'monitor_notifications', id});
      if (!current(token)) return;
      root.innerHTML = `<h3>Your email notices</h3><p>Email sends a brief notice and a sign-in link to your own verified address for future openings, reopenings and resolutions. Detailed account and performance evidence stays in the inbox. Updating a rule requires a new opt-in.</p><p class="form-note">Delivery requires the deployment's configured email worker. Pending means awaiting that worker. Sent means the provider accepted the message; inbox delivery is not verified. Snooze defers pending attention, acknowledgement cancels it, and pausing the rule stops unsent notices.</p>${s.reason ? `<p role="status">${esc(pretty(s.reason))}</p>` : ''}<button id="monitor-email-toggle" class="button" ${s.eligible ? '' : 'disabled'}>${s.enabled ? 'Turn off my email notices' : 'Enable email notices for me'}</button><p class="form-note">Five automatic attempts, then one confirmed retry of the original notice permits up to ten attempts total. Every attempt must fit within the original 24-hour lifetime.</p><h4>Recent delivery activity</h4>${s.deliveries.length ? s.deliveries.map(n => `<article class="operation-card"><strong>${esc(pretty(n.event))} · ${esc(pretty(n.state))}</strong><p>${esc(n.attempts)} attempts · ${date(n.created_at)}${n.next_attempt_at ? ' · Next attempt ' + date(n.next_attempt_at) : ''}</p>${n.reason ? `<p>${esc(pretty(n.reason))}</p>` : ''}<div class="dialog-actions work-actions"><a href="/monitors?incident_id=${encodeURIComponent(n.incident_id)}">Inspect incident</a>${n.retry_available ? `<button class="button small" data-retry-monitor-notice="${esc(n.id)}">Retry original notice</button>` : ''}</div></article>`).join('') : '<p>No delivery activity for this subscription yet. Existing incidents are not backfilled.</p>'}`;
      workspaceBind('#monitor-email-toggle', async () => {
        if (!current(token) || !s.eligible) return;
        const enabled = !s.enabled;
        if (
          !(await confirmAction(
            enabled ? 'Enable your email notices?' : 'Turn off your email notices?',
            enabled
              ? 'Future incident openings, reopenings and resolutions for this rule may send a brief email to your verified account address. No report contents are included. Existing incidents are not backfilled.'
              : 'Cancel unsent notices for this subscription. A message already sent to the provider cannot be recalled.',
            enabled ? 'Enable email notices' : 'Turn off notices',
          )) ||
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
          !(await confirmAction(
            'Retry this original notice?',
            'Retry the same recipient, payload and provider identity within its original expiry. Current access, rule and incident are checked again.',
            'Retry original notice',
          )) ||
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
        root.innerHTML = `<h3>Email notices unavailable</h3><p class="error" role="alert">${esc(errorMessage(e))}</p>`;
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
    root.innerHTML = `<h2>Edit monitor rule</h2><p>${esc(m.platform)} · ${esc(m.account_id)} · ${esc(m.currency)} · ${esc(m.timezone)}<br>${esc(m.result_definition)} · ${esc(m.attribution)} · Rule version ${m.rule_version}</p><p>Saving creates a new rule version. Older unresolved incidents become superseded, keeping their original rule and evidence. They are not marked resolved. ${m.active ? 'The rule remains active.' : 'The rule remains paused.'}</p><form id="edit-monitor"><fieldset ${session.workspaceRole === 'viewer' ? 'disabled' : ''}>${monitorFields(m)}<label class="form-note"><input type="checkbox" name="confirmed" required> Save this revised rule for this account and measurement context.</label><button class="button primary" type="submit">Save rule revision</button></fieldset></form>`;
    root.innerHTML +=
      '<section id="monitor-email-settings" class="panel" aria-label="Your monitor email notices"><p role="status">Loading your notification settings…</p></section>';
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
      toast('New rule version saved. Existing incidents retain their evidence.');
    });
  } catch (e) {
    if (generation === navigationGeneration && root.isConnected)
      root.innerHTML = `<h2>Rule unavailable</h2><p class="error" role="alert">${esc(errorMessage(e))}</p>`;
  }
}
async function renderMonitors() {
  const params = new URLSearchParams(location.search),
    reader = session.workspaceRole === 'viewer';
  content.innerHTML = header(
    'Monitoring inbox',
    'Follow evidence, triage incidents and adjust account-specific rules.',
  );
  content.innerHTML += `<div class="dialog-actions work-actions"><a href="/operations" class="button">All operations</a><a href="/reporting-overview" class="button">Reporting snapshots</a><button id="monitors-refresh" class="button">Refresh inbox</button></div><p class="notice">Rules evaluate retained reporting snapshots and deliver incidents here. They never launch advertising changes. Email notices require your separate opt-in on each monitor rule. Missing or stale evidence cannot resolve an incident.</p>${params.has('incident_id') ? '<section id="incident-detail" class="panel workspace-form"><p role="status">Loading incident…</p></section>' : ''}${params.has('monitor_id') ? '<section id="monitor-detail" class="panel workspace-form"><p role="status">Loading rule…</p></section>' : ''}<section class="panel workspace-form"><form id="incident-filter" class="work-filter"><label>Incident state<select name="state">${['all', 'open', 'acknowledged', 'snoozed', 'resolved', 'superseded'].map(k => `<option value="${k}">${pretty(k)}</option>`).join('')}</select></label><label>Rule or account search<input type="search" name="search" maxlength="200"></label><label>Account ID<input name="account_id" maxlength="200"></label><button type="submit" class="button">Filter incidents</button></form></section><section id="incident-list" class="panel"><p data-page-status role="status">Loading incidents…</p></section><section class="panel workspace-form"><form id="monitor-filter" class="work-filter"><label>Rule state<select name="state"><option value="all">All rules</option><option value="active">Active</option><option value="paused">Paused</option></select></label><label>Rule or account search<input type="search" name="search" maxlength="200"></label><button type="submit" class="button">Filter rules</button></form></section><section id="monitor-list" class="panel"><p data-page-status role="status">Loading rules…</p></section><section class="panel workspace-form"><h2>Create a rule from retained evidence</h2><p>Open a retained snapshot and choose Create a monitor, or enter its ID below. Account, currency, timezone, result definition and attribution come from that snapshot. <a href="/report-library">Browse snapshots</a>.</p><form id="monitor-source-form"><label>Snapshot ID<input name="report_id" maxlength="160" required value="${esc(params.get('report_id'))}"></label><button type="submit" class="button" ${reader ? 'disabled' : ''}>Choose measurement context</button></form><div id="monitor-rule"></div></section>`;
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
    'Incidents',
    offset => workspaceCall('workspace', {action: 'incidents', ...incidentFilters, offset: offset ?? 0, limit: 20}),
    r =>
      r.incidents.map(i => incidentCard(i)).join('') ||
      blank('No incidents match these filters within your current access.'),
  );
  const rules = workPageLoader(
    '#monitor-list',
    'Monitor rules',
    offset => workspaceCall('workspace', {action: 'monitors', ...monitorFilters, offset: offset ?? 0, limit: 20}),
    r =>
      r.monitors
        .map(
          m =>
            `<article class="operation-card"><div class="operation-heading"><div><h3>${esc(m.name)}</h3><small>${esc(m.account_id)} · ${esc(m.result_definition)} · ${esc(m.metric)} ${esc(m.comparison)} ${esc(m.threshold)}</small></div>${badge(m.active ? 'active' : 'paused')}</div><p>Latest evaluation: ${esc(pretty(m.last_evaluation?.status ?? 'Awaiting a completed snapshot'))}${m.last_evaluation ? ' · ' + date(m.last_evaluation.evaluated_at) : ''}</p><div class="dialog-actions work-actions"><a class="button small" href="/monitors?monitor_id=${encodeURIComponent(m.id)}">Inspect or edit rule</a><button class="button small" data-toggle-monitor="${esc(m.id)}" ${reader ? 'disabled' : ''}>${m.active ? 'Pause' : 'Resume'}</button></div></article>`,
        )
        .join('') || blank('No rules match these filters.'),
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
        toast(m.active ? 'Monitor paused.' : 'Monitor resumed with current access.');
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
      throw Error('This snapshot has no complete, unambiguous measurement context. Open its source evidence first.');
    $('#monitor-rule').innerHTML =
      `<form id="save-monitor"><label>Account and measurement context<select name="context" required>${contexts.map((s, i) => `<option value="${i}">${esc(s.platform)} · ${esc(s.account_id)} · ${esc(s.currency)} · ${esc(s.timezone)} · ${esc(s.result_definition)} · ${esc(s.attribution)}</option>`).join('')}</select></label><p>Each matching objective group is evaluated separately for this measurement context.</p>${monitorFields()}<label class="form-note"><input name="confirmed" type="checkbox" required> Save this rule and deliver incidents to this inbox.</label><button class="button primary" type="submit">Save and evaluate snapshot</button></form>`;
    workspaceBind('#save-monitor', async form => {
      await workspaceCall('workspace', {
        action: 'save_monitor',
        confirmed: form.elements.confirmed.checked,
        monitor: monitorValues(form, contexts[Number(form.elements.context.value)]),
      });
      await workspaceCall('workspace', {action: 'evaluate_monitors', report_id: report.id});
      await renderWorkspacePage();
      toast('Rule saved and snapshot evaluated.');
    });
  });
  await Promise.all([
    incidents.load(),
    rules.load(),
    ...(params.has('incident_id') ? [renderIncidentDetail(params.get('incident_id'))] : []),
    ...(params.has('monitor_id') ? [renderMonitorEditor(params.get('monitor_id'))] : []),
  ]);
}
