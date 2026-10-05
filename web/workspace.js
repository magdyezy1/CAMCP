'use strict';
const workspaceTitles = {
  dashboard: 'Overview',
  campaigns: 'Campaigns',
  media: 'Media library',
  reports: 'Reports',
  profiles: 'Client profiles',
  operations: 'Operations',
  capabilities: 'Capabilities',
  schedules: 'Schedules & deliveries',
  'report-library': 'Report library',
  'report-pack': 'Report pack',
  monitors: 'Monitoring inbox',
  portfolio: 'Live account portfolio',
  measurement: 'Measurement diagnostics',
  commerce: 'Commerce',
};
async function workspaceCall(tool, args) {
  const r = await api('/api/workspace/' + tool, {method: 'POST', body: JSON.stringify(args)});
  if (!r.success) throw requestError(r, uiText('Operation failed.'));
  return r.data;
}
const recordDetails = (v, title = uiText('Details')) =>
  `<details class="workspace-details"><summary>${esc(uiText(title))}</summary><pre class="code-block">${esc(JSON.stringify(v, null, 2))}</pre></details>`;
const badge = v =>
  `<span class="status ${['verified', 'verified_with_acceptance', 'complete', 'passed', 'ready', 'resolved'].includes(v) ? 'online' : ['failed', 'mismatch', 'uncertain', 'blocked', 'attention', 'open', 'partial', 'expired'].includes(v) ? 'attention' : 'offline'}">${esc(uiText(String(v).replaceAll('_', ' ')))}</span>`;
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
    uiText(workspaceTitles[page]),
    uiText('Plan, review and verify work across your selected accounts.'),
  );
  if (!session.authenticated) {
    content.innerHTML += `<div class="empty"><strong>${esc(uiText('A workspace of your own.'))}</strong><p>${esc(uiText('Sign in to connect your accounts and get started.'))}</p><button class="button primary" data-action="login">${esc(uiText('Sign in to AMCP ↗'))}</button></div>`;
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
async function renderOverview() {
  const d = await workspaceCall('workspace', {action: 'dashboard'}),
    accounts = d.connections.flatMap(c => c.accounts_status.map(a => ({...a, connection: c}))),
    receipts = accounts.flatMap(a => a.verified_writes);
  content.innerHTML = workHome(d, accounts);
  content.innerHTML += `<div class="workspace-metrics"><article><strong>${accounts.length}</strong><span>${esc(uiText('Selected resources'))}</span></article><article><strong>${d.campaigns.length}</strong><span>${esc(uiText('Campaign plans'))}</span></article><article><strong>${receipts.filter(r => r.status === 'verified').length}</strong><span>${esc(uiText('Verified write receipts'))}</span></article></div><section class="panel"><div class="panel-header"><h2>${esc(uiText('Account readiness'))}</h2><a class="button small" href="/connections">${esc(uiText('Manage connections'))}</a></div>${accounts.map((a, i) => `<div class="token-row"><div><strong>${esc(a.connection.label)} · ${esc(a.account_id)}</strong><small>${esc(a.connection.gateway)} · ${a.connection.write_accounts.includes(a.account_id) ? uiText('Reviewed writes enabled') : uiText('Read access')} · ${a.check ? date(a.check.checked_at) : uiText('No readiness check')}</small>${a.check ? recordDetails(a.check.checks, uiText('Prerequisites')) : ''}</div><div>${badge(a.check?.ready ? 'ready' : a.check?.blocked ? 'blocked' : 'unknown')}<button class="button small" data-check-account="${i}">${esc(uiText('Check account'))}</button></div></div>`).join('') || blank(uiText('Connect a platform and select resources to check readiness.'))}</section><section class="panel"><div class="panel-header"><h2>${esc(uiText('Capabilities and evidence'))}</h2></div><p class="workspace-copy">${esc(d.capabilities.meaning)}</p>${d.capabilities.features.map(f => `<div class="token-row"><div><strong>${esc(f.name)}</strong><small>${esc(f.coverage)}</small><code>${esc(f.tool)}</code></div>${badge(f.implementation)}</div>`).join('')}${recordDetails(d.capabilities.evidence, uiText('Provider evidence by account and action'))}</section>`;
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
/** Every saved plan, a page at a time. */
async function campaignPlans() {
  const plans = [];
  for (let offset = 0; offset !== undefined;) {
    const page = await workspaceCall('campaign', {action: 'list', offset, limit: 100});
    plans.push(...page.campaigns);
    offset = page.next_offset;
  }
  return plans;
}
async function renderCampaigns() {
  const [campaigns, {profiles}] = await Promise.all([
    campaignPlans(),
    workspaceCall('workspace', {action: 'profiles'}),
  ]);
  content.innerHTML += `<div class="dialog-actions"><a class="button primary" href="/campaigns#campaign-create">${esc(uiText('New campaign plan'))}</a></div><section class="panel" id="campaign-history"><div class="panel-header"><h2>${esc(uiText('Campaign plans'))}</h2></div>${campaigns.map(c => `<div class="token-row"><div><strong>${esc(c.name)}</strong><small>${esc(uiText('{count} steps', {count: uiNumber(c.step_count)}))} · ${date(c.updated_at)}</small></div>${badge(c.state)}<button class="button small" data-run="${esc(c.id)}">${esc(uiText('Open'))}</button></div>`).join('') || blank(uiText('Start with a saved template or ask your MCP client to turn a brief into a reviewed campaign plan.'))}</section><section id="campaign-detail" class="panel workspace-form"></section><div id="campaign-review"></div><details class="panel" id="campaign-create"><summary>${esc(uiText('New campaign plan'))}</summary><details id="campaign-clone" class="workspace-form"></details><details class="workspace-form"><summary>${esc(uiText('Advanced: native plan or saved template'))}</summary><form id="campaign-form">${controls(uiText('Campaign name'), 'text', '', 'name')}<label>${esc(uiText('Brief'))}<textarea name="brief" rows="3" required></textarea></label><label>${esc(uiText('Client profile'))}<select name="profile_id"><option value="">${esc(uiText('No profile'))}</option>${profiles.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>${controls(uiText('Saved template name'), 'text', '', 'template')}<label>${esc(uiText('Template variables'))}<textarea name="variables" rows="3">{}</textarea></label><details><summary>${esc(uiText('Native steps supplied by your MCP client'))}</summary><p class="form-note">${esc(uiText('The server resolves explicit steps and verified resource references. It does not invent campaign settings from a brief.'))}</p><textarea name="steps" rows="6" aria-label="${esc(uiText('Native campaign steps'))}"></textarea></details><button class="button primary" type="submit">${esc(uiText('Create plan'))}</button></form></details></details>`;
  let openSequence = 0;
  const open = async id => {
    const sequence = ++openSequence;
    // The website is where a person approves each step, so it shows the whole stored plan and review.
    const run = await workspaceCall('campaign', {action: 'get', id, detail: 'full'});
    if (sequence !== openSequence) return;
    const current = () => sequence === openSequence;
    history.replaceState({}, '', '/campaigns?id=' + encodeURIComponent(id));
    $('#campaign-review').innerHTML = '';
    const planHistory = $('#campaign-history'),
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
      `<div class="dialog-actions">${run.steps.some(s => s.review_id && ['executing', 'uncertain', 'failed', 'verifying', 'mismatch', 'processing'].includes(s.status)) ? `<button id="reconcile-campaign" class="button">${esc(uiText('Read back submitted step'))}</button>` : ''}<button id="preflight-campaign" class="button">${esc(uiText('Check prerequisites'))}</button><button id="next-campaign" class="button">${esc(uiText('Review next step'))}</button><button id="approve-campaign" class="button">${esc(uiText('Review whole plan'))}</button>${run.approval?.plan_hash === run.plan_hash ? `<button id="run-campaign" class="button primary">${esc(uiText('Run approved plan / continue'))}</button>` : ''}${run.steps.some(s => s.status === 'failed') || run.preflight?.blocked ? `<button id="amend-campaign" class="button">${esc(uiText('Correct blocked step'))}</button>` : ''}${run.steps
        .filter(s => ['mismatch', 'verifying'].includes(s.status) && s.verification?.actual_hash)
        .map(
          s =>
            `<button class="button" data-accept-observed="${esc(s.id)}">${esc(uiText('Compare observed values:'))} ${esc(s.id)}</button>`,
        )
        .join(
          '',
        )}<button id="cancel-campaign" class="button danger">${esc(uiText('Cancel remaining work'))}</button></div>`;
    bindCampaignWorkflow(run, open, current);
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
      if (current()) {
        await open(id);
        $('#campaign-review').innerHTML = campaignOutcome(out);
      }
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
    workspaceBind('#next-campaign', async () => {
      const r = await workspaceCall('campaign', {action: 'prepare_next', id, detail: 'full'});
      if (!current()) return;
      if (r.review) {
        $('#campaign-review').innerHTML = reviewView(r.review, uiText('Execute reviewed campaign step'));
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
      } else {
        await open(id);
        $('#campaign-review').innerHTML = campaignOutcome(r);
      }
    });
    return sequence === openSequence;
  };
  workspaceBind('[data-run]', b => open(b.dataset.run));
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
async function renderMediaLibrary() {
  const page = Math.max(0, Number(new URLSearchParams(location.search).get('page')) || 0);
  const d = await workspaceCall('media', {action: 'list', offset: page * 50, limit: 50}),
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
    ) +
    adPreviewsPanel() +
    `<details class="panel workspace-form"><summary>${esc(uiText('Google Drive imports and media formats'))}</summary><p class="form-note">${esc(uiText('Use a public share link or a private file selected in a separate Drive connection. Files stay on the server. New variants expire after five minutes.'))}</p><form id="media-source">${controls(uiText('Google Drive file URL'), 'url', '', 'drive_url')}<label>${esc(uiText('Drive access'))}<select name="drive_connection_id"><option value="">${esc(uiText('Public share link'))}</option>${drive.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label><label>${esc(uiText('Format'))}<select name="preset"><option value="">${esc(uiText('Original'))}</option>${Object.keys(
      d.presets,
    )
      .map(p => `<option value="${p}">${p} · ${d.presets[p].join(' × ')}</option>`)
      .join(
        '',
      )}</select></label><label>${esc(uiText('Fit'))}<select name="fit"><option value="contain">${esc(uiText('Full frame with padding'))}</option><option value="crop">${esc(uiText('Center crop — review content loss'))}</option></select></label><button class="button" type="submit">${esc(uiText('Preview variant'))}</button></form><div id="variant-preview"></div><form id="media-import"><label>${esc(uiText('Advertising account'))}<select name="target" required>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>${controls(uiText('Media name'), 'text', 'AMCP media', 'name')}<label class="form-note"><input name="reuse" type="checkbox" checked> ${esc(uiText('Reuse a matching available upload receipt when one exists.'))}</label><button class="button primary" type="submit">${esc(uiText('Prepare upload'))}</button></form></details><section class="panel workspace-form"><h2>${esc(uiText('Unfinished uploads and recovery'))}</h2>${(d.recovery_reviews ?? []).map(r => `<div class="token-row"><div><strong>${esc(r.request.name)}</strong><small>${esc(recordAccountLabel(r.request.platform, r.request.connection_id, r.request.account_id))} ${esc(uiText('· Review expires'))} ${date(r.expires_at)}</small></div>${badge(r.state)}<button class="button small" data-media-recovery="${esc(r.review_id)}">${esc(uiText('Inspect recovery'))}</button></div>`).join('') || blank(uiText('No unfinished uploads in your currently authorized accounts.'))}<p class="form-note">${esc(uiText('Showing'))} ${(d.recovery_reviews ?? []).length} ${esc(uiText('of'))} ${d.recovery_total ?? 0}${esc(uiText('. Submitted uploads retain their original request and key.'))}</p></section><div id="media-review"></div>`;
  bindCreativePush(targets, pushDrives());
  bindAdPreviews();
  $('#media-review').insertAdjacentHTML(
    'beforebegin',
    `<div class="dialog-actions"><button id="media-prev" class="button" ${page ? '' : 'disabled'}>${esc(uiText('Previous recovery page'))}</button><span>${esc(uiText('Page'))} ${page + 1}</span><button id="media-next" class="button" ${d.has_more || d.recovery_has_more ? '' : 'disabled'}>${esc(uiText('Next recovery page'))}</button></div>`,
  );
  workspaceBind('#media-prev', () => navigate('/media?page=' + Math.max(0, page - 1)));
  workspaceBind('#media-next', () => navigate('/media?page=' + (page + 1)));
  const showJob = async id => {
    clearTimeout(pollTimer);
    const job = await workspaceCall('media', {action: 'job_status', review_id: id});
    $('#media-review').innerHTML =
      `<section class="panel"><h2>${esc(uiText('Upload progress'))}</h2>${badge(job.state)}<p>${esc(uiText('The original review and upload key are retained. You can leave and return to this job.'))}</p>${reviewTable(job.progress, uiText('Transfer progress'))}${job.error ? `<p class="error">${esc(job.error.message)}</p>` : ''}${recordDetails(job, uiText('Job, original receipt and journal'))}<a href="/media?review_id=${encodeURIComponent(id)}">${esc(uiText('Link to this upload'))}</a><button class="button" id="inspect-media-job">${esc(uiText('Inspect recovery'))}</button></section>`;
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
  const showReview = (review, tool = 'write') => {
    if (review.reused) {
      $('#media-review').innerHTML = recordDetails(review, uiText('Reused upload receipt — no upload performed'));
      return;
    }
    $('#media-review').innerHTML = reviewView(review);
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
    if (r.job_id && !inspect) return showJob(id);
    $('#media-review').innerHTML =
      recordDetails(r, uiText('Original request and recovery journal')) +
      `<p class="form-note">` +
      esc(
        r.journal.next_safe_action ??
          uiText('Inspect the retained request and receipt. Unknown submissions must not be repeated.'),
      ) +
      `</p>`;
    if (r.can_execute) {
      showReview(r, 'media');
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
    showReview(
      await workspaceCall('media', {
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
      }),
      'media',
    );
  });
  const showMediaStatus = async id => {
    const r = await workspaceCall('media', {action: 'status', review_id: id});
    $('#media-review').innerHTML = recordDetails(r, uiText('Provider processing result'));
    if (r.next_call?.arguments?.action === 'prepare_library') {
      $('#media-review').innerHTML +=
        `<button id="prepare-library" class="button">${esc(uiText('Review adding video to the account library'))}</button>`;
      workspaceBind('#prepare-library', async () =>
        showReview(await workspaceCall('media', r.next_call.arguments), 'media'),
      );
    } else if (r.next_call?.tool === 'amcp_write' && r.next_call.arguments.action === 'prepare') {
      $('#media-review').innerHTML +=
        `<button id="prepare-video-asset" class="button">${esc(uiText('Review creating the video asset'))}</button>`;
      workspaceBind('#prepare-video-asset', async () =>
        showReview(await workspaceCall('write', r.next_call.arguments)),
      );
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
      `<section class="panel"><div class="panel-header"><h2>${esc(r.semantics.source_name)}</h2>${badge(r.semantics.complete ? 'complete' : 'incomplete')}</div><div class="workspace-metrics">${['spend', 'impressions', 'clicks', 'conversions'].map(k => `<article><strong>${esc(r.totals[k] ?? uiText('Unknown'))}</strong><span>${esc(uiText(reportMetricLabels[k]))}${k === 'spend' ? ' · ' + esc(r.semantics.currency) : ''}</span></article>`).join('')}</div>${recordDetails({source_request: r.source_request, source_hash: r.source_hash, mapping: r.mapping, semantics: r.semantics, semantics_source: r.semantics_source, coverage: r.coverage, native_account_evidence: r.native_account_evidence, source_pages: r.source_pages, source_collection: r.source_collection, source_lineage: r.source_lineage}, uiText('Source and measurement definitions'))}<div id="report-evidence-download"></div><div id="report-native-rows"></div><div id="search-exclusion-workflow"></div></section><div class="workspace-columns"><section class="panel workspace-form"><h2>${esc(uiText('Pacing and recommendations'))}</h2><form id="analyze-report">${controls(uiText('Planned budget'), 'number', '', 'planned_budget')}${controls(uiText('Total days'), 'number', '', 'total_days')}${controls(uiText('Elapsed days'), 'number', '', 'elapsed_days')}${controls(uiText('Target CPA (optional)'), 'number', '', 'target_cpa')}<label>${esc(uiText('Earlier comparison report'))}<select name="baseline_id"><option value="">${esc(uiText('No baseline'))}</option>${reports
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
