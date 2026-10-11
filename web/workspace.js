'use strict';
// Page headings use the route registry's canonical names (web/routes.js, WEB-06).
// First-party labels for the state values AMCP itself assigns (WEB-05). tests/status-labels.test.mjs reads the value
// lists from src and fails when one lacks a label here or an Arabic entry. Provider values never pass through here.
const statusLabels = {
  complete: 'Complete',
  incomplete: 'Incomplete',
  verified: 'Verified',
  verified_with_acceptance: 'Verified with acceptance',
  available: 'Available',
  resolved: 'Resolved',
  passed: 'Passed',
  ready: 'Ready',
  partial: 'Partial',
  uncertain: 'Uncertain',
  mismatch: 'Mismatch',
  failed: 'Failed',
  inconclusive: 'Inconclusive',
  open: 'Unresolved',
  attention: 'Needs attention',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
  expired: 'Expired',
  missing: 'Missing',
  unknown: 'Unknown',
  running: 'Running',
  queued: 'Queued',
  processing: 'Processing',
  verifying: 'Verifying',
  executing: 'Executing',
  pending: 'Pending',
  prepared: 'Prepared',
  review_ready: 'Ready for review',
  awaiting_review: 'Awaiting review',
  in_progress: 'In progress',
  draft: 'Draft',
  snoozed: 'Snoozed',
  acknowledged: 'Acknowledged',
  paused: 'Paused',
  active: 'Active',
  superseded: 'Superseded',
  skipped: 'Skipped',
  // A plan step whose target already held every value it would send (COM-01).
  skipped_unchanged: 'Unchanged, not sent',
  implemented_unverified: 'Implemented, not live-verified',
  recent_complete: 'Recent and complete',
  stale_or_incomplete: 'Stale or incomplete',
  // Account readiness (CON-03) and a media upload refused before any claim (MED-02).
  stale: 'Stale',
  not_applicable: 'Not applicable',
  not_submitted: 'Not submitted',
  // A retained reviewed change (WRT-08).
  unsubmitted: 'Awaiting approval',
  not_sent: 'Not sent',
  reconciled: 'Accepted as applied',
  // Refused by the provider without being applied (CMP-04).
  rejected: 'Refused, not applied',
  // Operations attention (OPS-06): a failed monitor notice past its 24 hours, and a login's credential health.
  undelivered: 'Undelivered',
  reauthorization_required: 'Reauthorization required',
  refresh_failed: 'Renewal failing',
  disabled: 'Turned off',
  // Media kinds share the badge.
  image: 'Image',
  video: 'Video',
  media: 'Media',
};
/** A state value's label; a value without one keeps its earlier spaced form. */
const statusLabel = value =>
  uiText(Object.hasOwn(statusLabels, value) ? statusLabels[value] : String(value ?? '').replaceAll('_', ' '));
// AMCP's own capability vocabulary from src/capabilities.ts, listed so its Arabic is required. The server's text is what
// is shown; tests/status-labels.test.mjs fails when the two drift apart.
const capabilityFeatureLabels = {
  campaign_builder: [
    'Durable campaign plans',
    'Dependency references, frozen reviews, restart recovery and verification',
  ],
  readiness: ['Account readiness', 'Current grants, recorded scopes, exact account read and requested asset checks'],
  media_library: [
    'Media library',
    'Selected private Drive files, receipt reuse, explicit format variants and seven upload adapters',
  ],
  write_verification: [
    'Write verification',
    'Background configuration read-back; unsupported and uncertain outcomes remain explicit',
  ],
  reporting: [
    'Source-linked reports',
    'Native source hashes, declared attribution, exact decimal totals and reconciliation',
  ],
  optimization: [
    'Evidence-based suggestions',
    'Pacing, sample thresholds, conversion lag warnings and comparable baselines',
  ],
  profiles: ['Approved client profiles', 'Revisioned naming, UTMs, account bindings and reusable native templates'],
  capabilities: [
    'Capability evidence',
    'Separate local implementation, provider reads, validation and verified writes',
  ],
  meaning: [
    'Implemented and fixture-tested are not live qualification. Evidence is timestamped and applies only to the listed account, action and fields.',
  ],
};
async function workspaceCall(tool, args) {
  const r = await api('/api/workspace/' + tool, {method: 'POST', body: JSON.stringify(args)});
  if (!r.success) throw requestError(r, uiText('Operation failed.'));
  return r.data;
}
const recordDetails = (v, title = uiText('Details')) =>
  `<details class="workspace-details"><summary>${esc(uiText(title))}</summary><pre class="code-block" tabindex="0" role="region" aria-label="${esc(uiText(title))}">${esc(JSON.stringify(v, null, 2))}</pre></details>`;
const badge = (v, label = statusLabel(v)) =>
  `<span class="status ${['verified', 'verified_with_acceptance', 'skipped_unchanged', 'complete', 'passed', 'ready', 'resolved'].includes(v) ? 'online' : ['failed', 'mismatch', 'uncertain', 'blocked', 'attention', 'open', 'partial', 'expired', 'reauthorization_required', 'refresh_failed', 'rejected'].includes(v) ? 'attention' : 'offline'}">${esc(label)}</span>`;
const blank = text => `<div class="empty">${esc(text)}</div>`;
const controls = (label, type = 'text', value = '', name = label) =>
  `<label>${esc(uiText(label))}<input name="${esc(name)}" type="${type}" ${type === 'number' ? 'step="any"' : ''} value="${esc(value)}"></label>`;
const workspaceFormFeedbacks = new WeakMap();
function workspaceFormFeedback(form) {
  if (workspaceFormFeedbacks.has(form)) return workspaceFormFeedbacks.get(form);
  const navigation = navigationGeneration,
    identity = identityGeneration,
    button = form.querySelector('button[type="submit"]');
  if (!form.id) form.id = 'workspace-form-' + crypto.randomUUID();
  if (button && !button.id) button.id = form.id + '-submit';
  const id = form.id + '-workspace-feedback';
  form.insertAdjacentHTML(
    'beforeend',
    '<div class="workspace-form-feedback" id="' +
      esc(id) +
      '" role="alert" aria-atomic="true" hidden><strong>' +
      esc(uiText('This step needs attention.')) +
      '</strong><p id="' +
      esc(id + '-message') +
      '"></p><p>' +
      esc(uiText('Review the message below before continuing.')) +
      '</p></div>',
  );
  const region = document.getElementById(id),
    message = document.getElementById(id + '-message'),
    viewCurrent = () => navigation === navigationGeneration && identity === identityGeneration,
    connected = () => viewCurrent() && form.isConnected && region.isConnected;
  let version = 0,
    latestAttempt = 0;
  const describe = include => {
    for (const control of [form, button].filter(Boolean)) {
      const ids = (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean),
        remaining = ids.filter(value => value !== id);
      if (include) remaining.push(id);
      if (remaining.length) control.setAttribute('aria-describedby', remaining.join(' '));
      else control.removeAttribute('aria-describedby');
    }
  };
  const clear = () => {
    version++;
    if (!connected()) return;
    region.hidden = true;
    message.textContent = '';
    describe(false);
  };
  form.addEventListener('input', clear);
  form.addEventListener('change', clear);
  const feedback = {
    begin() {
      clear();
      const attempt = ++latestAttempt,
        settings = version,
        latest = () => viewCurrent() && attempt === latestAttempt,
        currentScope = () => latest() && settings === version,
        current = () => currentScope() && connected();
      return {
        latest,
        currentScope,
        current,
        show(error) {
          if (!current()) return;
          const text = errorMessage(error);
          if (!text) return;
          message.textContent = text;
          describe(true);
          region.hidden = false;
        },
      };
    },
  };
  workspaceFormFeedbacks.set(form, feedback);
  return feedback;
}
function workspaceBind(selector, fn, options = {}) {
  document.querySelectorAll(selector).forEach(el => {
    const feedback = el.tagName === 'FORM' ? workspaceFormFeedback(el) : null;
    let latestClick = 0;
    el.addEventListener(el.tagName === 'FORM' ? 'submit' : 'click', async event => {
      event.preventDefault();
      const button = el.tagName === 'FORM' ? el.querySelector('button[type="submit"]') : el,
        request = feedback?.begin(),
        generation = navigationGeneration,
        identity = identityGeneration,
        click = ++latestClick,
        currentScope = () =>
          request
            ? request.currentScope()
            : generation === navigationGeneration && identity === identityGeneration && click === latestClick,
        latest = () =>
          request
            ? request.latest()
            : generation === navigationGeneration && identity === identityGeneration && click === latestClick,
        key = focusKey(button),
        scopes = focusScopes(button);
      let failed = false;
      try {
        if (button) button.disabled = true;
        await fn(el, event);
      } catch (error) {
        failed = true;
        if (request) request.show(error);
        else if (currentScope() && el.isConnected) toast(errorMessage(error));
      } finally {
        if (button && latest()) button.disabled = options.disabled?.(button) === true;
        // A successful re-render can restore its replacement control. Obsolete failures cannot move focus.
        if (currentScope() && (!failed || (request ? request.current() : el.isConnected))) restoreFocus(key, scopes);
      }
    });
  });
}

async function renderWorkspacePage() {
  const page = route();
  content.innerHTML = header(
    uiText(routeLabel('/' + page)),
    uiText('Plan, review and verify work across your selected accounts.'),
  );
  if (!session.authenticated) {
    content.innerHTML += `<div class="empty"><strong>${esc(uiText('A workspace of your own.'))}</strong><p>${esc(uiText('Sign in to connect your accounts and get started.'))}</p><button class="button primary" data-action="login">${esc(uiText('Sign in →'))}</button></div>`;
    return;
  }
  if (page === 'dashboard') return renderOverview();
  if (page === 'profiles') return renderProfiles();
  if (page === 'campaigns') return renderCampaigns();
  if (page === 'media') return renderMediaLibrary();
  if (page === 'operations') return renderOperationsCenter();
  if (page === 'capabilities') return renderCapabilityCenter();
  if (page === 'schedules') return renderScheduleCenter();
  if (page === 'report-library') return renderReportLibraryPage();
  if (page === 'report-pack') return renderReportPack();
  if (page === 'monitors') return renderMonitors();
  if (page === 'portfolio') return renderPortfolio();
  if (page === 'measurement') return renderMeasurement();
  if (page === 'commerce') return renderCommerce();
  return renderDecisionReports();
}
/** Readiness is evaluated for this viewer from shared account-read evidence, which ages out after 15 minutes. */
function readinessBadge(check) {
  if (check?.readiness === 'not_applicable') return badge('not_applicable', uiText('Not applicable'));
  if (check?.stale) return badge('stale', uiText('Stale'));
  return badge(check?.ready ? 'ready' : check?.blocked ? 'blocked' : 'unknown');
}
function readinessAge(check) {
  if (check?.readiness === 'not_applicable') return uiText('No account readiness read for this connection');
  if (!check?.checked_at) return uiText('No readiness check');
  return date(check.checked_at) + (check.stale ? ' · ' + uiText('Older than 15 minutes; check again') : '');
}
async function renderOverview() {
  // The attention items come from the Operations classifier (OPS-06); a failure there still shows the rest of Home.
  const [d, attention] = await Promise.all([
      workspaceCall('workspace', {action: 'dashboard', view: 'full'}),
      workspaceCall('workspace', {action: 'operations', state: 'attention', limit: 8}).catch(error => ({error})),
    ]),
    accounts = d.connections.flatMap(c => c.accounts_status.map(a => ({...a, connection: c}))),
    receipts = accounts.flatMap(a => a.verified_writes),
    // Counted as the badges show them: a stale check is to be checked again, and a login with no account read is left out.
    checked = accounts.filter(a => a.check?.readiness !== 'not_applicable'),
    ready = checked.filter(a => !a.check?.stale && a.check?.ready).length,
    blocked = checked.filter(a => !a.check?.stale && !a.check?.ready && a.check?.blocked).length,
    accountName = a =>
      typeof recordAccountLabelHtml === 'function'
        ? recordAccountLabelHtml(a.connection.gateway, a.connection.id, a.account_id)
        : esc(a.connection.label) + ' · ' + esc(a.account_id);
  content.innerHTML = workHome(d, accounts, attention);
  // Readiness is a summary with its accounts one click away, and capability evidence (tool names, evidence levels) is
  // technical detail, so Home stays short on a phone (OPS-06 increment 2).
  content.innerHTML += `<div class="workspace-metrics"><article><strong>${accounts.length}</strong><span>${esc(uiText('Selected resources'))}</span></article><article><strong>${d.campaign_counts?.total ?? d.campaigns.length}</strong><span>${esc(uiText('Campaign plans'))}</span></article><article><strong>${receipts.filter(r => r.status === 'verified').length}</strong><span>${esc(uiText('Verified write receipts'))}</span></article></div><section class="panel" id="home-readiness"><div class="panel-header"><h2>${esc(uiText('Account readiness'))}</h2><a class="button small" href="/connections">${esc(uiText('Manage connections'))}</a></div>${accounts.length ? `<p>${esc(uiText('Ready: {ready} · Blocked: {blocked} · To check: {other}', {ready, blocked, other: checked.length - ready - blocked}))}</p><details class="workspace-details"><summary>${esc(uiText('Accounts and their readiness'))}</summary>${accounts.map((a, i) => `<div class="token-row"><div><strong>${accountName(a)}</strong><small>${a.connection.write_accounts.includes(a.account_id) ? uiText('Reviewed writes enabled') : uiText('Read access')} · ${esc(readinessAge(a.check))}</small>${a.check?.checks ? recordDetails(a.check.checks, uiText('Prerequisites')) : ''}</div><div>${readinessBadge(a.check)}${a.check?.readiness === 'not_applicable' ? '' : `<button class="button small" data-check-account="${i}">${esc(uiText('Check account'))}</button>`}</div></div>`).join('')}</details>` : blank(uiText('Connect a platform and select resources to check readiness.'))}</section><section class="panel" id="home-capabilities"><div class="panel-header"><h2>${esc(uiText('Capabilities and evidence'))}</h2><a class="button small" href="/capabilities">${esc(uiText('Check capabilities'))}</a></div><p class="workspace-copy">${esc(uiText(d.capabilities.meaning))}</p><details class="workspace-details"><summary>${esc(uiText('Technical details'))}</summary>${d.capabilities.features.map(f => `<div class="token-row"><div><strong>${esc(uiText(f.name))}</strong><small>${esc(uiText(f.coverage))}</small><code>${esc(f.tool)}</code></div>${badge(f.implementation)}</div>`).join('')}${recordDetails(d.capabilities.evidence, uiText('Provider evidence by account and action'))}</details></section>`;
  workspaceBind('[data-check-account]', async b => {
    const a = accounts[Number(b.dataset.checkAccount)];
    await workspaceCall('workspace', {
      action: 'check',
      connection_id: a.connection.id,
      account_id: a.account_id,
      live: true,
      requirements: {write: a.connection.write_accounts.includes(a.account_id)},
    });
    await renderWorkspacePage();
  });
}
async function renderProfiles() {
  return renderClientPlaybooks();
}

function campaignRows(run) {
  return campaignJournal(run);
}
function reviewView(review, buttonLabel = uiText('Execute reviewed request')) {
  return readableReview(review, buttonLabel);
}
/** The Campaigns list (CMP-05): newest first, one page at a time, with its filters in the URL. */
async function renderCampaigns() {
  const filters = campaignListFilters();
  const [first, {profiles}] = await Promise.all([
    workspaceCall('campaign', {action: 'list', limit: 50, ...filters}),
    workspaceCall('workspace', {action: 'profiles'}),
  ]);
  content.innerHTML += `<div class="dialog-actions"><a class="button primary" href="/campaigns#campaign-create">${esc(uiText('New campaign plan'))}</a></div><section class="panel" id="campaign-history"><div class="panel-header"><h2>${esc(uiText('Campaign plans'))}</h2></div>${campaignFilterForm(filters, first.total)}<div id="campaign-rows">${first.campaigns.map(campaignPlanRow).join('') || blank(Object.keys(filters).length ? uiText('No plans match these filters.') : uiText('Start with a saved template or ask your MCP client to turn a brief into a reviewed campaign plan.'))}</div>${first.next_cursor ? `<button id="campaign-more" class="button" type="button">${esc(uiText('Load more'))}</button>` : ''}</section><section id="campaign-detail" class="panel workspace-form"></section><div id="campaign-review"></div><details class="panel" id="campaign-create"><summary>${esc(uiText('New campaign plan'))}</summary><details id="campaign-clone" class="workspace-form"></details><details class="workspace-form"><summary>${esc(uiText('Advanced: native plan or saved template'))}</summary><form id="campaign-form">${controls(uiText('Campaign name'), 'text', '', 'name')}<label>${esc(uiText('Brief'))}<textarea name="brief" rows="3" required></textarea></label><label>${esc(uiText('Client profile'))}<select name="profile_id"><option value="">${esc(uiText('No profile'))}</option>${profiles.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><label>${esc(uiText('Saved template'))}<select name="template"><option value="">${esc(uiText('No saved template'))}</option></select></label><p class="form-note" id="campaign-template-note">${esc(uiText('Choose a client profile to list its saved templates.'))}</p><label>${esc(uiText('Template variables'))}<textarea name="variables" rows="3">{}</textarea></label><details><summary>${esc(uiText('Native steps supplied by your MCP client'))}</summary><p class="form-note">${esc(uiText('The server resolves explicit steps and verified resource references. It does not invent campaign settings from a brief.'))}</p><textarea name="steps" rows="6" aria-label="${esc(uiText('Native campaign steps'))}"></textarea></details><button class="button primary" type="submit">${esc(uiText('Create plan'))}</button></form></details></details>`;
  let openSequence = 0;
  // `after`: the response that led here; one naming a step to correct opens the amendment form (CMP-02 a).
  const open = async (id, after) => {
    const sequence = ++openSequence;
    // The website is where a person approves each step, so it shows the whole stored plan and review.
    const run = await workspaceCall('campaign', {action: 'get', id, detail: 'full'});
    if (sequence !== openSequence) return;
    const current = () => sequence === openSequence;
    history.replaceState({}, '', '/campaigns?id=' + encodeURIComponent(id));
    $('#campaign-review').innerHTML = '';
    const planHistory = $('#campaign-rows'),
      old = [...planHistory.querySelectorAll('[data-run]')].find(b => b.dataset.run === id)?.closest('.token-row'),
      row = document.createElement('div');
    row.className = 'token-row';
    row.innerHTML =
      `<div><strong>` +
      esc(run.name) +
      `</strong><small>` +
      esc(uiText('{count} steps', {count: uiNumber(run.steps.length)})) +
      ' · ' +
      date(run.updated_at) +
      `</small></div>` +
      badge(run.state) +
      `<button class="button small" data-run="` +
      esc(id) +
      `">${esc(uiText('Open'))}</button>`;
    row.querySelector('button').addEventListener('click', () => open(id).catch(e => toast(errorMessage(e))));
    if (old) old.replaceWith(row);
    else {
      planHistory.querySelector('.empty')?.remove();
      planHistory.append(row);
    }
    $('#campaign-detail').innerHTML =
      campaignRows(run) +
      `<div class="dialog-actions">${run.steps.some(s => s.review_id && ['executing', 'uncertain', 'failed', 'verifying', 'mismatch', 'processing'].includes(s.status)) ? `<button id="reconcile-campaign" class="button">${esc(uiText('Read back submitted step'))}</button>` : ''}<button id="preflight-campaign" class="button">${esc(uiText('Check prerequisites'))}</button><button id="next-campaign" class="button">${esc(uiText('Review next step'))}</button><button id="approve-campaign" class="button">${esc(uiText('Review whole plan'))}</button>${run.approval?.plan_hash === run.plan_hash ? `<button id="run-campaign" class="button primary">${esc(uiText('Run approved plan / continue'))}</button>${run.steps.every(s => s.kind === 'media') && !['queued', 'running'].includes(run.background?.state) ? `<button id="run-background" class="button">${esc(uiText('Run on the AMCP server'))}</button>` : ''}` : ''}${campaignNeedsAmendment(run) ? `<button id="amend-campaign" class="button">${esc(uiText('Correct blocked step'))}</button>` : ''}${['attention', 'cancelled'].includes(run.state) && run.steps.some(s => !['verified', 'verified_with_acceptance', 'complete'].includes(s.status)) ? `<button id="continue-campaign" class="button">${esc(uiText('Continue in a new linked plan'))}</button>` : ''}${campaignCanActivate(run) ? `<button id="activate-campaign" class="button">${esc(uiText('Prepare activation'))}</button>` : ''}${run.steps
        .filter(s => ['mismatch', 'verifying'].includes(s.status) && s.verification?.actual_hash)
        .map(
          s =>
            `<button class="button" data-accept-observed="${esc(s.id)}">${esc(uiText('Compare observed values:'))} ${esc(s.id)}</button>`,
        )
        .join(
          '',
        )}${campaignTeamActions(run)}<button id="cancel-campaign" class="button danger">${esc(uiText('Cancel remaining work'))}</button></div>`;
    bindCampaignWorkflow(run, open, current, after);
    workspaceBind('#reconcile-campaign', async () => {
      const step = run.steps.find(
        s =>
          s.review_id && ['executing', 'uncertain', 'failed', 'verifying', 'mismatch', 'processing'].includes(s.status),
      );
      if (!step) throw Error(uiText('No submitted step needs reconciliation.'));
      await workspaceCall('campaign', {action: 'reconcile_step', id, step_id: step.id});
      if (current()) await open(id);
    });
    workspaceBind('#preflight-campaign', async () => {
      const out = await workspaceCall('campaign', {action: 'preflight', id, detail: 'full'});
      if (current()) await open(id, out);
    });
    workspaceBind('#cancel-campaign', async () => {
      if (
        !(await confirmAction({
          title: uiText('Cancel the remaining steps?'),
          consequence: uiText(
            'Steps that have not run yet will not run. Changes already made at the provider stay in place; nothing is deleted.',
          ),
          confirmLabel: uiText('Cancel remaining work'),
        }))
      )
        return;
      await workspaceCall('campaign', {action: 'cancel', id, confirmed: true});
      if (current()) await open(id);
    });
    const reviewNext = async () => {
      const r = await workspaceCall('campaign', {action: 'prepare_next', id, detail: 'full'});
      if (!current()) return;
      if (r.review) {
        $('#campaign-review').innerHTML = reviewView(r.review, uiText('Execute reviewed campaign step'));
        // An expired step review is prepared again by prepare_next, which reads the state again (WRT-05).
        bindReviewCountdown(r.review, reviewNext);
        workspaceBind('#execute-reviewed', async () => {
          const out = await workspaceCall('campaign', {
            action: 'execute_next',
            id,
            review_id: r.review.review_id,
            idempotency_key: r.review.idempotency_key,
            ...readReviewConsents(r.review),
          });
          if (current()) {
            await open(id);
            $('#campaign-review').innerHTML = campaignOutcome(out);
          }
        });
      } else await open(id, r);
    };
    workspaceBind('#next-campaign', reviewNext);
    return sequence === openSequence;
  };
  workspaceBind('[data-run]', b => open(b.dataset.run));
  bindCampaignList(first, filters, open);
  // The saved templates of the chosen profile, by name (CMP-06): a name no longer has to be remembered and typed.
  const templateForm = $('#campaign-form');
  templateForm.elements.profile_id.addEventListener('change', () => {
    const names = Object.keys(profiles.find(p => p.id === templateForm.elements.profile_id.value)?.templates ?? {});
    templateForm.elements.template.innerHTML =
      `<option value="">${esc(uiText('No saved template'))}</option>` +
      names.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
    $('#campaign-template-note').textContent = !templateForm.elements.profile_id.value
      ? uiText('Choose a client profile to list its saved templates.')
      : names.length
        ? ''
        : uiText('This profile has no saved templates.');
  });
  workspaceBind('#campaign-form', async f => {
    const v = Object.fromEntries(new FormData(f)),
      r = await workspaceCall('campaign', {
        action: 'create',
        name: v.name,
        brief: v.brief,
        ...(v.profile_id ? {profile_id: v.profile_id} : {}),
        ...(v.template ? {template: v.template} : {}),
        variables: JSON.parse(v.variables),
        ...(v.steps.trim() ? {steps: JSON.parse(v.steps)} : {}),
      });
    await open(r.id);
    toast(uiText('Plan saved. Each step requires its own review.'));
  });
  await mountRecipeBuilder(profiles, open);
  mountCampaignClone(open);
  const linked = new URLSearchParams(location.search).get('id');
  if (linked) await open(linked);
  if (location.hash === '#campaign-create') $('#campaign-create').open = true;
}
/**
 * A queued media upload's progress panel. A job that failed before any claim sent nothing to the platform (MED-02):
 * it shows "Not sent — try again" and its button queues the same review again, instead of the "no safe retry" advice.
 */
function mediaJobPanel(job, id) {
  const notSent = job.state === 'failed' && job.not_submitted === true,
    // MED-02 review: the busy copy is only for media contention; another refusal shows its own remedy, and one that
    // would repeat offers no Try again.
    busy = notSent && ['MEDIA_MEMORY_BUSY', 'MEDIA_UPLOAD_BUSY', 'MEDIA_PROCESSOR_BUSY'].includes(job.error?.code),
    again = notSent && job.retry_available !== false;
  return `<section class="panel"><h2>${esc(uiText('Upload progress'))}</h2>${notSent ? badge('not_submitted', uiText(again ? 'Not sent — try again' : 'Not sent')) : badge(job.state)}<p>${esc(uiText('The original review and upload key are retained. You can leave and return to this job.'))}</p>${busy ? `<p role="status">${esc(uiText('Nothing reached the platform: AMCP was busy with other media work. Try again while the review is valid; the same reviewed file is queued again.'))}</p>` : notSent && !again ? `<p role="status">${esc(uiText('Nothing reached the platform, and queueing this review again would stop the same way. Prepare the upload again.'))}</p>` : ''}${reviewTable(job.progress, uiText('Transfer progress'))}${job.error ? `<p class="error">${esc(uiOwnedError(job.error).message)}</p>` : ''}${recordDetails(job, uiText('Job, original receipt and journal'))}<a href="/media?review_id=${encodeURIComponent(id)}">${esc(uiText('Link to this upload'))}</a><button class="button" id="inspect-media-job">${esc(uiText(again ? 'Try again' : 'Inspect recovery'))}</button></section>`;
}
/** The recovery note of a review whose background job failed before any claim; empty otherwise. */
const mediaNotSentNotice = r =>
  r.state !== 'not_submitted'
    ? ''
    : r.can_execute === false
      ? `<p role="status">${esc(uiText('Nothing reached the platform, and queueing this review again would stop the same way. Prepare the upload again.'))}</p>`
      : `<p role="status">${esc(uiText('Not sent — try again. Nothing reached the platform, so submitting this review again is safe while it is valid.'))}</p>`;
/**
 * The media page's link to another page of recovery reviews (MED-05): only `recovery_page` changes, so the creative
 * library's own search and filters in the address stay as they are.
 */
function mediaRecoveryHref(search, page) {
  const query = new URLSearchParams(search);
  query.delete('page');
  if (page > 0) query.set('recovery_page', String(page));
  else query.delete('recovery_page');
  const text = query.toString();
  return '/media' + (text ? '?' + text : '');
}
async function renderMediaLibrary() {
  const params = new URLSearchParams(location.search),
    // Recovery has its own page (?recovery_page; an older ?page link still opens that page).
    page = Math.max(0, Number(params.get('recovery_page') ?? params.get('page')) || 0);
  // Upload receipts are not shown here (the creative library pages them itself), so they are left out of this call.
  const d = await workspaceCall('media', {
      action: 'list',
      include_assets: false,
      recovery_offset: page * 50,
      limit: 50,
    }),
    targets = platforms
      .filter(p => ['meta', 'tiktok', 'snapchat', 'google', 'linkedin', 'x', 'dv360'].includes(p.id))
      .flatMap(p =>
        p.connections
          .filter(c => c.enabled)
          .flatMap(c =>
            c.accounts.map(a => ({
              platform: p.gateway.replace(/_native_action$/, ''),
              account_id: a,
              connection_id: c.id,
              label: accountLabel(p, c, a),
              platformName: p.name,
              account: accountText(p, c, a),
            })),
          ),
      ),
    drive = platforms.find(p => p.id === 'drive')?.connections.filter(c => c.enabled) ?? [];
  content.innerHTML +=
    `<section class="panel workspace-form" id="creative-library"></section><div id="creative-detail"></div>` +
    creativePushPanel(
      targets,
      (d.sources ?? []).filter(s => s.state === 'complete'),
      pushDrives(),
      (d.sources ?? []).filter(s => s.state === 'receiving'),
    ) +
    adPreviewsPanel() +
    `<details class="panel workspace-form"><summary>${esc(uiText('Google Drive imports and media formats'))}</summary><p class="form-note">${esc(uiText('Use a public share link or a private file selected in a separate Drive connection. Files stay on the server. New variants expire after five minutes.'))}</p><form id="media-source">${controls(uiText('Google Drive file URL'), 'url', '', 'drive_url')}<label>${esc(uiText('Drive access'))}<select name="drive_connection_id"><option value="">${esc(uiText('Public share link'))}</option>${drive.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label><label>${esc(uiText('Format'))}<select name="preset"><option value="">${esc(uiText('Original'))}</option>${Object.keys(
      d.presets,
    )
      .map(p => `<option value="${p}">${p} · ${d.presets[p].join(' × ')}</option>`)
      .join(
        '',
      )}</select></label><label>${esc(uiText('Fit'))}<select name="fit"><option value="contain">${esc(uiText('Full frame with padding'))}</option><option value="crop">${esc(uiText('Center crop — review content loss'))}</option></select></label><button class="button" type="submit">${esc(uiText('Preview variant'))}</button></form><div id="variant-preview"></div><form id="media-import"><label>${esc(uiText('Advertising account'))}<select name="target" required>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>${controls(uiText('Media name'), 'text', 'AMCP media', 'name')}<label class="form-note"><input name="reuse" type="checkbox" checked> ${esc(uiText('Reuse a matching available upload receipt when one exists.'))}</label><button class="button primary" type="submit">${esc(uiText('Prepare upload'))}</button></form></details><section class="panel workspace-form"><h2>${esc(uiText('Unfinished uploads and recovery'))}</h2>${(d.recovery_reviews ?? []).map(r => `<div class="token-row"><div><strong>${esc(r.request.name)}</strong><small>${recordAccountLabelHtml(r.request.platform, r.request.connection_id, r.request.account_id)} ${esc(uiText('· Review expires'))} ${date(r.expires_at)}</small></div>${badge(r.state)}<button class="button small" data-media-recovery="${esc(r.review_id)}">${esc(uiText('Inspect recovery'))}</button></div>`).join('') || blank(uiText('No unfinished uploads in your currently authorized accounts.'))}<p class="form-note">${esc(uiText('Showing'))} ${(d.recovery_reviews ?? []).length} ${esc(uiText('of'))} ${d.recovery_total ?? 0}${esc(uiText('. Submitted uploads retain their original request and key.'))}</p></section><div id="media-review"></div>`;
  bindCreativePush(
    targets,
    pushDrives(),
    (d.sources ?? []).filter(s => s.state === 'receiving'),
    undefined,
    {serverPush: d.server_push === true},
  );
  bindAdPreviews();
  $('#media-review').insertAdjacentHTML(
    'beforebegin',
    `<div class="dialog-actions"><button id="media-prev" class="button" ${page ? '' : 'disabled'}>${esc(uiText('Previous recovery page'))}</button><span>${esc(uiText('Page'))} ${page + 1}</span><button id="media-next" class="button" ${d.recovery_has_more ? '' : 'disabled'}>${esc(uiText('Next recovery page'))}</button></div>`,
  );
  workspaceBind('#media-prev', () => navigate(mediaRecoveryHref(location.search, Math.max(0, page - 1))));
  workspaceBind('#media-next', () => navigate(mediaRecoveryHref(location.search, page + 1)));
  const showJob = async id => {
    clearTimeout(pollTimer);
    const job = await workspaceCall('media', {action: 'job_status', review_id: id});
    $('#media-review').innerHTML = mediaJobPanel(job, id);
    workspaceBind('#inspect-media-job', () => showRecovery(id, true));
    if (['queued', 'running'].includes(job.state))
      pollTimer = setTimeout(() => showJob(id).catch(e => toast(errorMessage(e))), 4000);
  };
  let variant = null;
  $('#media-source').addEventListener('input', () => {
    variant = null;
    $('#variant-preview').innerHTML =
      `<p class="form-note">${esc(uiText('Source or format changed. Preview again before importing a variant.'))}</p>`;
  });
  // prepare, when given, prepares the same request again for a new review once this one expires (WRT-05).
  const showReview = (review, tool = 'write', prepare) => {
    if (review.reused) {
      $('#media-review').innerHTML = recordDetails(review, uiText('Reused upload receipt — no upload performed'));
      return;
    }
    $('#media-review').innerHTML = reviewView(review);
    const again = async () => {
      const next = await prepare();
      // The same request over unchanged state, by the server's fingerprint and state hash, says so as a plan step does.
      if (
        typeof review.fingerprint === 'string' &&
        typeof review.state_hash === 'string' &&
        next.review_id !== review.review_id &&
        next.fingerprint === review.fingerprint &&
        next.state_hash === review.state_hash
      )
        next.unchanged_since_review ??= review.review_id;
      showReview(next, tool, prepare);
    };
    bindReviewCountdown(review, prepare ? again : undefined);
    workspaceBind('#execute-reviewed', async () => {
      const consents = readReviewConsents(review);
      try {
        await workspaceCall(tool, {
          action: tool === 'media' ? 'execute_async' : 'execute',
          review_id: review.review_id,
          idempotency_key: review.idempotency_key,
          ...consents,
        });
        if (tool === 'media') await showJob(review.review_id);
        else await renderWorkspacePage();
        toast(
          tool === 'media'
            ? uiText('Upload queued. Progress is retained if you leave this page.')
            : uiText('Submission retained. Check processing status before using video.'),
        );
      } catch (error) {
        if (tool === 'media') await showRecovery(review.review_id);
        throw error;
      }
    });
  };
  const showRecovery = async (id, inspect = false) => {
    clearTimeout(pollTimer);
    const r = await workspaceCall('media', {action: 'recovery', review_id: id});
    if (r.job_id && !inspect && r.state !== 'not_submitted') return showJob(id);
    const notSent = mediaNotSentNotice(r);
    $('#media-review').innerHTML =
      recordDetails(r, uiText('Original request and recovery journal')) +
      (notSent ||
        `<p class="form-note">` +
          esc(
            r.journal.next_safe_action ??
              uiText('Inspect the retained request and receipt. Unknown submissions must not be repeated.'),
          ) +
          `</p>`);
    if (r.can_execute) {
      showReview(r, 'media');
      // The review replaces the panel; a review that was never sent keeps its "Not sent — try again" note above it.
      if (notSent) $('#media-review').insertAdjacentHTML('afterbegin', notSent);
    } else if (r.resume_available) {
      $('#media-review').innerHTML += reviewView(r, uiText('Resume original upload'));
      workspaceBind('#execute-reviewed', async () => {
        if (!$('#review-consent').checked)
          throw Error(uiText('Review and authorize continuation of this original upload first.'));
        try {
          await workspaceCall('media', {
            action: 'resume',
            review_id: r.review_id,
            idempotency_key: r.idempotency_key,
            confirmed: true,
          });
          await renderWorkspacePage();
          toast(uiText('Original upload completed. Reconcile its campaign step before preparing dependent work.'));
        } catch (error) {
          await showRecovery(id);
          throw error;
        }
      });
    } else if (r.state === 'complete') {
      $('#media-review').innerHTML +=
        `<button id="recovery-status" class="button">${esc(uiText('Check completed media status'))}</button>`;
      workspaceBind('#recovery-status', async () => {
        $('#media-review').innerHTML = recordDetails(
          await workspaceCall('media', {action: 'status', review_id: id}),
          uiText('Provider processing result'),
        );
      });
    } else {
      $('#media-review').innerHTML +=
        `<p role="status">${esc(uiText('No safe upload retry is available. Inspect the retained identifiers and provider state. Do not create another upload to recover an uncertain result.'))}</p>`;
    }
    $('#media-review').setAttribute('tabindex', '-1');
    $('#media-review').focus();
  };
  workspaceBind('[data-media-recovery]', b => showRecovery(b.dataset.mediaRecovery));
  const linkedReview = new URLSearchParams(location.search).get('review_id');
  if (linkedReview) await showRecovery(linkedReview);
  workspaceBind('#media-source', async f => {
    const v = Object.fromEntries(new FormData(f));
    if (!v.preset) {
      variant = null;
      $('#variant-preview').innerHTML =
        `<p>${esc(uiText('Original source selected. Prepare upload to freeze its exact bytes.'))}</p>`;
      return;
    }
    variant = await workspaceCall('media', {
      action: 'variant',
      drive_url: v.drive_url,
      ...(v.drive_connection_id ? {drive_connection_id: v.drive_connection_id} : {}),
      preset: v.preset,
      fit: v.fit,
    });
    $('#variant-preview').innerHTML =
      `<p>${esc(variant.review_note)}</p>${variant.kind === 'video' ? `<video controls preload="metadata" src="${esc(variant.preview_url)}"></video>` : `<img src="${esc(variant.preview_url)}" alt="Media variant preview">`}<p class="form-note">${variant.width} × ${variant.height} · ${variant.size} ${esc(uiText('bytes · Expires'))} ${date(variant.expires_at)}</p>`;
  });
  workspaceBind('#media-import', async f => {
    const v = Object.fromEntries(new FormData(f)),
      source = Object.fromEntries(new FormData($('#media-source'))),
      target = targets[Number(v.target)];
    if (!target) throw Error(uiText('Connect and select an advertising account first.'));
    const request = {
        action: 'prepare',
        platform: target.platform,
        connection_id: target.connection_id,
        account_id: target.account_id,
        name: v.name,
        reuse_existing: v.reuse === 'on',
        ...(variant
          ? {variant_id: variant.id}
          : {
              drive_url: source.drive_url,
              ...(source.drive_connection_id ? {drive_connection_id: source.drive_connection_id} : {}),
            }),
      },
      prepare = () => workspaceCall('media', request);
    showReview(await prepare(), 'media', prepare);
  });
  const showMediaStatus = async id => {
    const r = await workspaceCall('media', {action: 'status', review_id: id});
    $('#media-review').innerHTML = recordDetails(r, uiText('Provider processing result'));
    if (r.next_call?.arguments?.action === 'prepare_library') {
      $('#media-review').innerHTML +=
        `<button id="prepare-library" class="button">${esc(uiText('Review adding video to the account library'))}</button>`;
      const prepare = () => workspaceCall('media', r.next_call.arguments);
      workspaceBind('#prepare-library', async () => showReview(await prepare(), 'media', prepare));
    } else if (r.next_call?.tool === 'amcp_write' && r.next_call.arguments.action === 'prepare') {
      $('#media-review').innerHTML +=
        `<button id="prepare-video-asset" class="button">${esc(uiText('Review creating the video asset'))}</button>`;
      const prepare = () => workspaceCall('write', r.next_call.arguments);
      workspaceBind('#prepare-video-asset', async () => showReview(await prepare(), 'write', prepare));
    }
  };
  await bindCreativeLibrary(targets, showMediaStatus);
}
async function renderDecisionReports() {
  const reportMetricLabels = {spend: 'Spend', impressions: 'Impressions', clicks: 'Clicks', conversions: 'Conversions'};
  const generation = navigationGeneration,
    identity = identityGeneration;
  const viewCurrent = () => generation === navigationGeneration && identity === identityGeneration;
  let reports, page;
  try {
    page = await workspaceCall('reporting', {action: 'list', limit: 30});
    reports = page.reports;
  } catch (error) {
    if (viewCurrent()) throw error;
    return;
  }
  if (!viewCurrent()) return;
  content.innerHTML += `<section class="panel"><div class="panel-header"><h2>${esc(uiText('Source-linked reports'))}</h2></div><p class="workspace-copy">${esc(uiText('Capture detailed native evidence below or analyze a retained snapshot from the report library. Review totals, definitions and source lineage here.'))}</p><form id="evidence-index-search" class="work-filter"><label>${esc(uiText('Search saved evidence'))}<input id="evidence-index-query" name="search" type="search" maxlength="150"></label><button type="submit" class="button">${esc(uiText('Search evidence'))}</button><button id="evidence-index-reset" type="button" class="button secondary">${esc(uiText('Reset search'))}</button></form><p id="evidence-index-status" role="status"></p><div id="decision-report-list"></div><button id="evidence-index-next" type="button" class="button" hidden>${esc(uiText('More saved evidence'))}</button></section><details id="report-capture" class="panel workspace-form"></details><div id="report-detail"></div>`;
  const detail = $('#report-detail'),
    list = $('#decision-report-list');
  let nextCursor = page.next_cursor ?? null,
    search = '',
    indexSequence = 0,
    indexBusy = false,
    syncReferenceChoices = () => {};
  const matchesSearch = report =>
    !search ||
    [report.id, report.semantics.source_name, report.account_id, report.preset].some(
      value => typeof value === 'string' && value.toLowerCase().includes(search.toLowerCase()),
    );
  const renderList = () => {
    list.innerHTML =
      reports
        .map(
          r =>
            `<div class="token-row"><div><strong>${esc(r.semantics.source_name ?? uiText('Untitled evidence'))}</strong><small>${esc(r.account_id)} · ${esc(r.semantics.date_from ?? uiText('Unknown'))} — ${esc(r.semantics.date_to ?? uiText('Unknown'))} · ${esc(r.semantics.currency ?? uiText('Unknown'))} · ${r.captured_at == null ? esc(uiText('Unknown')) : date(r.captured_at)}</small></div><button class="button small" data-report="${esc(r.id)}" aria-label="${esc(uiText('Open report {name} for account {account}, {from} — {through}', {name: r.semantics.source_name ?? uiText('Untitled evidence'), account: r.account_id, from: r.semantics.date_from ?? uiText('Unknown'), through: r.semantics.date_to ?? uiText('Unknown')}))}">${esc(uiText('Open report'))}</button></div>`,
        )
        .join('') ||
      blank(
        uiText(
          search || nextCursor
            ? 'No matching accessible evidence on this page. Continue or change the search.'
            : 'No evidence captured yet. Choose a detailed report below or analyze a saved snapshot from the report library.',
        ),
      );
    $('#evidence-index-next').hidden = !nextCursor;
    $('#evidence-index-next').disabled = indexBusy;
    syncReferenceChoices();
    workspaceBind('[data-report]', b => openReport(b.dataset.report));
  };
  const loadIndex = async reset => {
    if (!viewCurrent() || (!reset && (indexBusy || !nextCursor))) return;
    const attempt = ++indexSequence,
      requestSearch = reset ? $('#evidence-index-query').value.trim() : search,
      requestCursor = reset ? null : nextCursor,
      current = () => viewCurrent() && list.isConnected && attempt === indexSequence;
    indexBusy = true;
    if (reset) {
      search = requestSearch;
      reports = [];
      nextCursor = null;
    }
    renderList();
    $('#evidence-index-status').textContent = uiText('Loading saved evidence…');
    try {
      const out = await workspaceCall('reporting', {
        action: 'list',
        limit: 30,
        ...(requestSearch ? {search: requestSearch} : {}),
        ...(requestCursor ? {cursor: requestCursor} : {}),
      });
      if (!current()) return;
      if (!Array.isArray(out.reports) || (out.has_more === true && !out.next_cursor))
        throw Error(uiText('The evidence page is incomplete. Reset the search and try again.'));
      for (const report of out.reports) {
        const found = reports.findIndex(r => r.id === report.id);
        if (found < 0) reports.push(report);
        else reports[found] = report;
      }
      nextCursor = out.next_cursor ?? null;
      $('#evidence-index-status').textContent = uiText('{count} accessible evidence reports loaded', {
        count: uiNumber(reports.length),
      });
    } catch (error) {
      if (!current()) return;
      $('#evidence-index-status').textContent = uiText('Could not load saved evidence. Try again or reset the search.');
    } finally {
      if (current()) {
        indexBusy = false;
        renderList();
      }
    }
  };
  workspaceBind('#evidence-index-next', () => loadIndex(false));
  workspaceBind('#evidence-index-search', () => loadIndex(true));
  workspaceBind('#evidence-index-reset', () => {
    $('#evidence-index-query').value = '';
    return loadIndex(true);
  });
  let selectionSequence = 0;
  const openReport = async id => {
    const sequence = ++selectionSequence;
    const requestCurrent = () =>
      sequence === selectionSequence &&
      generation === navigationGeneration &&
      identity === identityGeneration &&
      detail.isConnected;
    let r;
    try {
      r = await workspaceCall('reporting', {action: 'get', id});
    } catch (error) {
      if (requestCurrent()) throw error;
      return;
    }
    if (!requestCurrent()) return;
    if (!reports.some(report => report.id === r.id) && matchesSearch(r)) {
      const {rows, ...metadata} = r;
      reports.unshift(metadata);
      renderList();
    }
    history.replaceState({}, '', '/reports?id=' + encodeURIComponent(id));
    const references = reports.filter(x => x.id !== r.id && x.gateway === r.gateway && x.account_id === r.account_id);
    const currentSelection = () =>
      sequence === selectionSequence &&
      generation === navigationGeneration &&
      identity === identityGeneration &&
      detail.isConnected;
    $('#report-detail').innerHTML =
      `<section class="panel"><div class="panel-header"><h2>${esc(r.semantics.source_name)}</h2>${badge(r.semantics.complete ? 'complete' : 'incomplete')}</div><div class="workspace-metrics">${['spend', 'impressions', 'clicks', 'conversions'].map(k => `<article><strong>${r.totals[k] == null ? esc(uiText('Unknown')) : uiDecimalMarkup(r.totals[k], k === 'spend' ? {minorUnitsOf: r.semantics.currency} : {maximumFractionDigits: k === 'conversions' ? 2 : 0})}</strong><span>${esc(uiText(reportMetricLabels[k]))}${k === 'spend' ? ' · ' + esc(r.semantics.currency) : ''}</span></article>`).join('')}</div>${recordDetails({source_request: r.source_request, source_hash: r.source_hash, mapping: r.mapping, semantics: r.semantics, semantics_source: r.semantics_source, coverage: r.coverage, native_account_evidence: r.native_account_evidence, source_pages: r.source_pages, source_collection: r.source_collection, source_lineage: r.source_lineage}, uiText('Source and measurement definitions'))}<div id="report-evidence-download"></div><div id="report-native-rows"></div><div id="search-exclusion-workflow"></div></section><div class="workspace-columns"><section class="panel workspace-form"><h2>${esc(uiText('Pacing and recommendations'))}</h2><form id="analyze-report">${controls(uiText('Planned budget'), 'number', '', 'planned_budget')}${controls(uiText('Total days'), 'number', '', 'total_days')}${controls(uiText('Elapsed days'), 'number', '', 'elapsed_days')}${controls(uiText('Target CPA (optional)'), 'number', '', 'target_cpa')}<label>${esc(uiText('Earlier comparison report'))}<select name="baseline_id"><option value="">${esc(uiText('No baseline'))}</option>${reports
        .filter(x => x.id !== r.id)
        .map(
          x => `<option value="${esc(x.id)}">${esc(x.semantics.source_name)} · ${esc(x.semantics.date_from)}</option>`,
        )
        .join(
          '',
        )}</select></label><button type="submit" class="button primary">${esc(uiText('Analyze evidence'))}</button></form></section><section class="panel workspace-form"><h2>${esc(uiText('Reconcile report totals'))}</h2><form id="reconcile-retained"><label>${esc(uiText('Retained reference report'))}<select name="reference_id" required><option value="">${esc(uiText('Choose a retained report'))}</option>${references.map(x => `<option value="${esc(x.id)}">${esc(x.semantics.source_name)} · ${esc(x.semantics.date_from)} — ${esc(x.semantics.date_to)}</option>`).join('')}</select></label><p class="form-note">${esc(uiText('Both reports must cover the same account, dates, currency, timezone, attribution and native grain. Unknown or incomplete settings cannot establish comparability.'))}</p><button type="submit" class="button">${esc(uiText('Compare retained reports'))}</button></form><details><summary>${esc(uiText('Import a CSV reference'))}</summary><div id="reference-import"></div></details><details><summary>${esc(uiText('Enter reference totals manually'))}</summary><form id="reconcile-report">${controls(uiText('Reference name'), 'text', '', 'label')}${controls(uiText('Reference spend'), 'text', '', 'spend')}${controls(uiText('Reference clicks'), 'text', '', 'clicks')}${controls(uiText('Reference conversions'), 'text', '', 'conversions')}<p class="form-note">${esc(uiText('These are manually supplied reference totals. Use the same account, dates, currency and attribution as this report.'))}</p><button type="submit" class="button">${esc(uiText('Compare totals'))}</button></form></details></section></div><div id="report-result"></div>`;
    mountEvidenceRows(r, currentSelection);
    mountEvidenceDownload(r, currentSelection);
    let resultSequence = 0;
    const resultNode = $('#report-result');
    syncReferenceChoices = () => {
      if (!currentSelection()) return;
      for (const [name, candidates, placeholder] of [
        ['baseline_id', reports.filter(x => x.id !== r.id), 'No baseline'],
        [
          'reference_id',
          reports.filter(x => x.id !== r.id && x.gateway === r.gateway && x.account_id === r.account_id),
          'Choose a retained report',
        ],
      ]) {
        const select = detail.querySelector('select[name="' + name + '"]');
        if (!select) continue;
        const previous = select.value;
        select.innerHTML =
          '<option value="">' +
          esc(uiText(placeholder)) +
          '</option>' +
          candidates
            .map(
              x =>
                '<option value="' +
                esc(x.id) +
                '">' +
                esc(x.semantics.source_name ?? uiText('Untitled evidence')) +
                ' · ' +
                esc(x.semantics.date_from ?? uiText('Unknown')) +
                '</option>',
            )
            .join('');
        select.value = candidates.some(x => x.id === previous) ? previous : '';
        if (select.value !== previous) {
          resultSequence++;
          resultNode.innerHTML = '';
        }
      }
    };
    for (const selector of ['#analyze-report', '#reconcile-report', '#reconcile-retained']) {
      const invalidate = () => {
        if (currentSelection()) {
          resultSequence++;
          resultNode.innerHTML = '';
        }
      };
      $(selector).addEventListener('input', invalidate);
      $(selector).addEventListener('change', invalidate);
    }
    const reportAction = async (args, render) => {
      const attempt = ++resultSequence;
      const current = () => currentSelection() && resultNode.isConnected && attempt === resultSequence;
      if (!current()) return;
      let out;
      try {
        out = await workspaceCall('reporting', args);
      } catch (error) {
        if (current()) throw error;
        return;
      }
      if (current()) resultNode.innerHTML = render(out);
    };
    mountReferenceImport(
      r,
      reference => reportAction({action: 'reconcile', id: r.id, reference}, renderReportReconciliation),
      currentSelection,
      () => {
        if (currentSelection()) {
          resultSequence++;
          resultNode.innerHTML = '';
        }
      },
    );
    mountScenarioModel(r);
    detail.setAttribute('tabindex', '-1');
    detail.focus();
    workspaceBind('#analyze-report', async f => {
      const v = Object.fromEntries(new FormData(f)),
        options = {};
      for (const k of ['planned_budget', 'total_days', 'elapsed_days', 'target_cpa'])
        if (v[k] !== '') options[k] = k.endsWith('days') ? Number(v[k]) : v[k];
      await reportAction(
        {
          action: 'analyze',
          id: r.id,
          options,
          ...(v.baseline_id ? {baseline_id: v.baseline_id} : {}),
        },
        out =>
          `<section class="panel"><div class="panel-header"><h2>${esc(uiText('Recommendations'))}</h2>${badge(out.eligible_for_action ? 'ready' : 'blocked')}</div>${out.recommendations.map(x => `<div class="token-row"><div><strong>${esc(uiAnalysisLabel(x.type))}</strong><p>${esc(uiReportExplanation(x.proposal))}</p><small>${esc(uiText('Confidence:'))} ${esc(uiAnalysisLabel(x.confidence))} ${esc(uiText('· A new review is required before a change.'))}</small>${recordDetails(x.evidence, uiText('Supporting evidence'))}</div></div>`).join('') || blank(uiText('No recommendation met the configured thresholds.'))}${recordDetails(out, uiText('Analysis provenance and limitations'))}</section>`,
      );
    });
    workspaceBind('#reconcile-report', async f => {
      const v = Object.fromEntries(new FormData(f));
      await reportAction(
        {
          action: 'reconcile',
          id: r.id,
          reference: {
            label: v.label,
            captured_at: Date.now(),
            totals: Object.fromEntries(['spend', 'clicks', 'conversions'].filter(k => v[k] !== '').map(k => [k, v[k]])),
          },
        },
        renderReportReconciliation,
      );
    });
    workspaceBind('#reconcile-retained', async f => {
      const v = Object.fromEntries(new FormData(f));
      if (!v.reference_id) throw Error(uiText('Choose a retained report'));
      await reportAction(
        {action: 'reconcile_report', id: r.id, reference_id: v.reference_id},
        renderReportReconciliation,
      );
    });
  };
  await mountCaptureWizard(openReport);
  if (generation !== navigationGeneration || identity !== identityGeneration || !detail.isConnected) return;
  renderList();
  const linked = new URLSearchParams(location.search).get('id');
  if (linked) await openReport(linked);
}
