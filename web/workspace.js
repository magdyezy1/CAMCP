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
  if (!r.success) throw requestError(r, 'Operation failed.');
  return r.data;
}
const recordDetails = (v, title = 'Details') =>
  `<details class="workspace-details"><summary>${esc(title)}</summary><pre class="code-block">${esc(JSON.stringify(v, null, 2))}</pre></details>`;
const badge = v =>
  `<span class="status ${['verified', 'verified_with_acceptance', 'complete', 'passed', 'ready', 'resolved'].includes(v) ? 'online' : ['failed', 'mismatch', 'uncertain', 'blocked', 'attention', 'open', 'partial', 'expired'].includes(v) ? 'attention' : 'offline'}">${esc(String(v).replaceAll('_', ' '))}</span>`;
const blank = text => `<div class="empty">${esc(text)}</div>`;
const controls = (label, type = 'text', value = '', name = label) =>
  `<label>${esc(label)}<input name="${esc(name)}" type="${type}" ${type === 'number' ? 'step="any"' : ''} value="${esc(value)}"></label>`;
function workspaceBind(selector, fn) {
  document.querySelectorAll(selector).forEach(el =>
    el.addEventListener(el.tagName === 'FORM' ? 'submit' : 'click', async event => {
      event.preventDefault();
      const button = el.tagName === 'FORM' ? el.querySelector('button[type="submit"]') : el;
      const generation = navigationGeneration,
        key = focusKey(button),
        scopes = focusScopes(button);
      try {
        if (button) button.disabled = true;
        await fn(el, event);
      } catch (e) {
        if (generation === navigationGeneration) toast(errorMessage(e));
      } finally {
        if (button) button.disabled = false;
        if (generation === navigationGeneration) restoreFocus(key, scopes);
      }
    }),
  );
}
async function renderWorkspacePage() {
  const page = route();
  content.innerHTML = header(workspaceTitles[page], 'Plan, review and verify work across your selected accounts.');
  if (!session.authenticated) {
    content.innerHTML +=
      '<div class="empty"><strong>A workspace of your own.</strong><p>Sign in to connect your accounts and get started.</p><button class="button primary" data-action="login">Sign in to AMCP ↗</button></div>';
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
  content.innerHTML += `<div class="workspace-metrics"><article><strong>${accounts.length}</strong><span>Selected resources</span></article><article><strong>${d.campaigns.length}</strong><span>Campaign plans</span></article><article><strong>${receipts.filter(r => r.status === 'verified').length}</strong><span>Verified write receipts</span></article></div><section class="panel"><div class="panel-header"><h2>Account readiness</h2><a class="button small" href="/connections">Manage connections</a></div>${accounts.map((a, i) => `<div class="token-row"><div><strong>${esc(a.connection.label)} · ${esc(a.account_id)}</strong><small>${esc(a.connection.gateway)} · ${a.connection.write_accounts.includes(a.account_id) ? 'Reviewed writes enabled' : 'Read access'} · ${a.check ? date(a.check.checked_at) : 'No readiness check'}</small>${a.check ? recordDetails(a.check.checks, 'Prerequisites') : ''}</div><div>${badge(a.check?.ready ? 'ready' : a.check?.blocked ? 'blocked' : 'unknown')}<button class="button small" data-check-account="${i}">Check account</button></div></div>`).join('') || blank('Connect a platform and select resources to check readiness.')}</section><section class="panel"><div class="panel-header"><h2>Capabilities and evidence</h2></div><p class="workspace-copy">${esc(d.capabilities.meaning)}</p>${d.capabilities.features.map(f => `<div class="token-row"><div><strong>${esc(f.name)}</strong><small>${esc(f.coverage)}</small><code>${esc(f.tool)}</code></div>${badge(f.implementation)}</div>`).join('')}${recordDetails(d.capabilities.evidence, 'Provider evidence by account and action')}</section>`;
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
function reviewView(review, buttonLabel = 'Execute reviewed request') {
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
  content.innerHTML += `<div class="dialog-actions"><a class="button primary" href="/campaigns#campaign-create">New campaign plan</a></div><section class="panel" id="campaign-history"><div class="panel-header"><h2>Campaign plans</h2></div>${campaigns.map(c => `<div class="token-row"><div><strong>${esc(c.name)}</strong><small>${c.step_count} steps · ${date(c.updated_at)}</small></div>${badge(c.state)}<button class="button small" data-run="${esc(c.id)}">Open</button></div>`).join('') || blank('Start with a saved template or ask your MCP client to turn a brief into a reviewed campaign plan.')}</section><section id="campaign-detail" class="panel workspace-form"></section><div id="campaign-review"></div><details class="panel" id="campaign-create"><summary>New campaign plan</summary><details id="campaign-clone" class="workspace-form"></details><details class="workspace-form"><summary>Advanced: native plan or saved template</summary><form id="campaign-form">${controls('Campaign name', 'text', '', 'name')}<label>Brief<textarea name="brief" rows="3" required></textarea></label><label>Client profile<select name="profile_id"><option value="">No profile</option>${profiles.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>${controls('Saved template name', 'text', '', 'template')}<label>Template variables<textarea name="variables" rows="3">{}</textarea></label><details><summary>Native steps supplied by your MCP client</summary><p class="form-note">The server resolves explicit steps and verified resource references. It does not invent campaign settings from a brief.</p><textarea name="steps" rows="6" aria-label="Native campaign steps"></textarea></details><button class="button primary" type="submit">Create plan</button></form></details></details>`;
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
      '<div><strong>' +
      esc(run.name) +
      '</strong><small>' +
      run.steps.length +
      ' steps · ' +
      date(run.updated_at) +
      '</small></div>' +
      badge(run.state) +
      '<button class="button small" data-run="' +
      esc(id) +
      '">Open</button>';
    row.querySelector('button').addEventListener('click', () => open(id).catch(e => toast(errorMessage(e))));
    if (old) old.replaceWith(row);
    else {
      planHistory.querySelector('.empty')?.remove();
      planHistory.append(row);
    }
    $('#campaign-detail').innerHTML =
      campaignRows(run) +
      `<div class="dialog-actions">${run.steps.some(s => s.review_id && ['executing', 'uncertain', 'failed', 'verifying', 'mismatch', 'processing'].includes(s.status)) ? '<button id="reconcile-campaign" class="button">Read back submitted step</button>' : ''}<button id="preflight-campaign" class="button">Check prerequisites</button><button id="next-campaign" class="button">Review next step</button><button id="approve-campaign" class="button">Review whole plan</button>${run.approval?.plan_hash === run.plan_hash ? '<button id="run-campaign" class="button primary">Run approved plan / continue</button>' : ''}${run.steps.some(s => s.status === 'failed') || run.preflight?.blocked ? '<button id="amend-campaign" class="button">Correct blocked step</button>' : ''}${run.steps
        .filter(s => ['mismatch', 'verifying'].includes(s.status) && s.verification?.actual_hash)
        .map(
          s =>
            `<button class="button" data-accept-observed="${esc(s.id)}">Compare observed values: ${esc(s.id)}</button>`,
        )
        .join('')}<button id="cancel-campaign" class="button danger">Cancel remaining work</button></div>`;
    bindCampaignWorkflow(run, open, current);
    workspaceBind('#reconcile-campaign', async () => {
      const step = run.steps.find(
        s =>
          s.review_id && ['executing', 'uncertain', 'failed', 'verifying', 'mismatch', 'processing'].includes(s.status),
      );
      if (!step) throw Error('No submitted step needs reconciliation.');
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
          title: 'Cancel the remaining steps?',
          consequence:
            'Steps that have not run yet will not run. Changes already made at the provider stay in place; nothing is deleted.',
          confirmLabel: 'Cancel remaining work',
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
        $('#campaign-review').innerHTML = reviewView(r.review, 'Execute reviewed campaign step');
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
    toast('Plan saved. Each step requires its own review.');
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
    '<section class="panel workspace-form" id="creative-library"></section><div id="creative-detail"></div>' +
    creativePushPanel(
      targets,
      (d.sources ?? []).filter(s => s.state === 'complete'),
      pushDrives(),
    ) +
    adPreviewsPanel() +
    `<details class="panel workspace-form"><summary>Google Drive imports and media formats</summary><p class="form-note">Use a public share link or a private file selected in a separate Drive connection. Files stay on the server. New variants expire after five minutes.</p><form id="media-source">${controls('Google Drive file URL', 'url', '', 'drive_url')}<label>Drive access<select name="drive_connection_id"><option value="">Public share link</option>${drive.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label><label>Format<select name="preset"><option value="">Original</option>${Object.keys(
      d.presets,
    )
      .map(p => `<option value="${p}">${p} · ${d.presets[p].join(' × ')}</option>`)
      .join(
        '',
      )}</select></label><label>Fit<select name="fit"><option value="contain">Full frame with padding</option><option value="crop">Center crop — review content loss</option></select></label><button class="button" type="submit">Preview variant</button></form><div id="variant-preview"></div><form id="media-import"><label>Advertising account<select name="target" required>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>${controls('Media name', 'text', 'AMCP media', 'name')}<label class="form-note"><input name="reuse" type="checkbox" checked> Reuse a matching available upload receipt when one exists.</label><button class="button primary" type="submit">Prepare upload</button></form></details><section class="panel workspace-form"><h2>Unfinished uploads and recovery</h2>${(d.recovery_reviews ?? []).map(r => `<div class="token-row"><div><strong>${esc(r.request.name)}</strong><small>${esc(recordAccountLabel(r.request.platform, r.request.connection_id, r.request.account_id))} · Review expires ${date(r.expires_at)}</small></div>${badge(r.state)}<button class="button small" data-media-recovery="${esc(r.review_id)}">Inspect recovery</button></div>`).join('') || blank('No unfinished uploads in your currently authorized accounts.')}<p class="form-note">Showing ${(d.recovery_reviews ?? []).length} of ${d.recovery_total ?? 0}. Submitted uploads retain their original request and key.</p></section><div id="media-review"></div>`;
  bindCreativePush(targets, pushDrives());
  bindAdPreviews();
  $('#media-review').insertAdjacentHTML(
    'beforebegin',
    `<div class="dialog-actions"><button id="media-prev" class="button" ${page ? '' : 'disabled'}>Previous recovery page</button><span>Page ${page + 1}</span><button id="media-next" class="button" ${d.has_more || d.recovery_has_more ? '' : 'disabled'}>Next recovery page</button></div>`,
  );
  workspaceBind('#media-prev', () => navigate('/media?page=' + Math.max(0, page - 1)));
  workspaceBind('#media-next', () => navigate('/media?page=' + (page + 1)));
  const showJob = async id => {
    clearTimeout(pollTimer);
    const job = await workspaceCall('media', {action: 'job_status', review_id: id});
    $('#media-review').innerHTML =
      `<section class="panel"><h2>Upload progress</h2>${badge(job.state)}<p>The original review and upload key are retained. You can leave and return to this job.</p>${reviewTable(job.progress, 'Transfer progress')}${job.error ? `<p class="error">${esc(job.error.message)}</p>` : ''}${recordDetails(job, 'Job, original receipt and journal')}<a href="/media?review_id=${encodeURIComponent(id)}">Link to this upload</a><button class="button" id="inspect-media-job">Inspect recovery</button></section>`;
    workspaceBind('#inspect-media-job', () => showRecovery(id, true));
    if (['queued', 'running'].includes(job.state))
      pollTimer = setTimeout(() => showJob(id).catch(e => toast(errorMessage(e))), 4000);
  };
  let variant = null;
  $('#media-source').addEventListener('input', () => {
    variant = null;
    $('#variant-preview').innerHTML =
      '<p class="form-note">Source or format changed. Preview again before importing a variant.</p>';
  });
  const showReview = (review, tool = 'write') => {
    if (review.reused) {
      $('#media-review').innerHTML = recordDetails(review, 'Reused upload receipt — no upload performed');
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
            ? 'Upload queued. Progress is retained if you leave this page.'
            : 'Submission retained. Check processing status before using video.',
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
      recordDetails(r, 'Original request and recovery journal') +
      '<p class="form-note">' +
      esc(
        r.journal.next_safe_action ??
          'Inspect the retained request and receipt. Unknown submissions must not be repeated.',
      ) +
      '</p>';
    if (r.can_execute) {
      showReview(r, 'media');
    } else if (r.resume_available) {
      $('#media-review').innerHTML += reviewView(r, 'Resume original upload');
      workspaceBind('#execute-reviewed', async () => {
        if (!$('#review-consent').checked)
          throw Error('Review and authorize continuation of this original upload first.');
        try {
          await workspaceCall('media', {
            action: 'resume',
            review_id: r.review_id,
            idempotency_key: r.idempotency_key,
            confirmed: true,
          });
          await renderWorkspacePage();
          toast('Original upload completed. Reconcile its campaign step before preparing dependent work.');
        } catch (error) {
          await showRecovery(id);
          throw error;
        }
      });
    } else if (r.state === 'complete') {
      $('#media-review').innerHTML +=
        '<button id="recovery-status" class="button">Check completed media status</button>';
      workspaceBind('#recovery-status', async () => {
        $('#media-review').innerHTML = recordDetails(
          await workspaceCall('media', {action: 'status', review_id: id}),
          'Provider processing result',
        );
      });
    } else {
      $('#media-review').innerHTML +=
        '<p role="status">No safe upload retry is available. Inspect the retained identifiers and provider state. Do not create another upload to recover an uncertain result.</p>';
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
      $('#variant-preview').innerHTML = '<p>Original source selected. Prepare upload to freeze its exact bytes.</p>';
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
      `<p>${esc(variant.review_note)}</p>${variant.kind === 'video' ? `<video controls preload="metadata" src="${esc(variant.preview_url)}"></video>` : `<img src="${esc(variant.preview_url)}" alt="Media variant preview">`}<p class="form-note">${variant.width} × ${variant.height} · ${variant.size} bytes · Expires ${date(variant.expires_at)}</p>`;
  });
  workspaceBind('#media-import', async f => {
    const v = Object.fromEntries(new FormData(f)),
      source = Object.fromEntries(new FormData($('#media-source'))),
      target = targets[Number(v.target)];
    if (!target) throw Error('Connect and select an advertising account first.');
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
    $('#media-review').innerHTML = recordDetails(r, 'Provider processing result');
    if (r.next_call?.arguments?.action === 'prepare_library') {
      $('#media-review').innerHTML +=
        '<button id="prepare-library" class="button">Review adding video to the account library</button>';
      workspaceBind('#prepare-library', async () =>
        showReview(await workspaceCall('media', r.next_call.arguments), 'media'),
      );
    } else if (r.next_call?.tool === 'amcp_write' && r.next_call.arguments.action === 'prepare') {
      $('#media-review').innerHTML +=
        '<button id="prepare-video-asset" class="button">Review creating the video asset</button>';
      workspaceBind('#prepare-video-asset', async () =>
        showReview(await workspaceCall('write', r.next_call.arguments)),
      );
    }
  };
  await bindCreativeLibrary(targets, showMediaStatus);
}
async function renderDecisionReports() {
  const generation = navigationGeneration;
  const {reports} = await workspaceCall('reporting', {action: 'list'});
  if (generation !== navigationGeneration) return;
  content.innerHTML += `<section class="panel"><div class="panel-header"><h2>Source-linked reports</h2></div><p class="workspace-copy">Capture detailed native evidence below or analyze a retained snapshot from the report library. Review totals, definitions and source lineage here.</p><div id="decision-report-list"></div></section><details id="report-capture" class="panel workspace-form"></details><div id="report-detail"></div>`;
  const detail = $('#report-detail'),
    list = $('#decision-report-list');
  const renderList = () => {
    list.innerHTML =
      reports
        .map(
          r =>
            `<div class="token-row"><div><strong>${esc(r.semantics.source_name)}</strong><small>${esc(r.account_id)} · ${esc(r.semantics.date_from)} — ${esc(r.semantics.date_to)} · ${esc(r.semantics.currency)} · ${date(r.captured_at)}</small></div><button class="button small" data-report="${esc(r.id)}">Open report</button></div>`,
        )
        .join('') ||
      blank(
        'No evidence captured yet. Choose a detailed report below or analyze a saved snapshot from the report library.',
      );
    workspaceBind('[data-report]', b => openReport(b.dataset.report));
  };
  let selectionSequence = 0;
  const openReport = async id => {
    const sequence = ++selectionSequence;
    const r = await workspaceCall('reporting', {action: 'get', id});
    if (sequence !== selectionSequence || generation !== navigationGeneration || !detail.isConnected) return;
    if (!reports.some(report => report.id === r.id)) {
      const {rows, ...metadata} = r;
      reports.unshift(metadata);
      renderList();
    }
    history.replaceState({}, '', '/reports?id=' + encodeURIComponent(id));
    $('#report-detail').innerHTML =
      `<section class="panel"><div class="panel-header"><h2>${esc(r.semantics.source_name)}</h2>${badge(r.semantics.complete ? 'complete' : 'incomplete')}</div><div class="workspace-metrics">${['spend', 'impressions', 'clicks', 'conversions'].map(k => `<article><strong>${r.totals[k] === null ? 'Unknown' : esc(r.totals[k])}</strong><span>${k}${k === 'spend' ? ' · ' + esc(r.semantics.currency) : ''}</span></article>`).join('')}</div>${recordDetails({source_request: r.source_request, source_hash: r.source_hash, mapping: r.mapping, semantics: r.semantics, semantics_source: r.semantics_source, coverage: r.coverage}, 'Source and measurement definitions')}${recordDetails(r.rows, 'Native mapped rows (first page)')}</section><div class="workspace-columns"><section class="panel workspace-form"><h2>Pacing and recommendations</h2><form id="analyze-report">${controls('Planned budget', 'number', '', 'planned_budget')}${controls('Total days', 'number', '', 'total_days')}${controls('Elapsed days', 'number', '', 'elapsed_days')}${controls('Target CPA (optional)', 'number', '', 'target_cpa')}<label>Earlier comparison report<select name="baseline_id"><option value="">No baseline</option>${reports
        .filter(x => x.id !== r.id)
        .map(
          x => `<option value="${esc(x.id)}">${esc(x.semantics.source_name)} · ${esc(x.semantics.date_from)}</option>`,
        )
        .join(
          '',
        )}</select></label><button type="submit" class="button primary">Analyze evidence</button></form></section><section class="panel workspace-form"><h2>Reconcile with an export</h2><form id="reconcile-report">${controls('Reference name', 'text', '', 'label')}${controls('Reference spend', 'text', '', 'spend')}${controls('Reference clicks', 'text', '', 'clicks')}${controls('Reference conversions', 'text', '', 'conversions')}<p class="form-note">These are manually supplied reference totals. Use the same account, dates, currency and attribution as this report.</p><button type="submit" class="button">Compare totals</button></form></section></div><div id="report-result"></div>`;
    mountScenarioModel(r);
    detail.setAttribute('tabindex', '-1');
    detail.focus();
    workspaceBind('#analyze-report', async f => {
      const v = Object.fromEntries(new FormData(f)),
        options = {};
      for (const k of ['planned_budget', 'total_days', 'elapsed_days', 'target_cpa'])
        if (v[k] !== '') options[k] = k.endsWith('days') ? Number(v[k]) : v[k];
      const out = await workspaceCall('reporting', {
        action: 'analyze',
        id: r.id,
        options,
        ...(v.baseline_id ? {baseline_id: v.baseline_id} : {}),
      });
      if (sequence !== selectionSequence || generation !== navigationGeneration || !detail.isConnected) return;
      $('#report-result').innerHTML =
        `<section class="panel"><div class="panel-header"><h2>Recommendations</h2>${badge(out.eligible_for_action ? 'ready' : 'blocked')}</div>${out.recommendations.map(x => `<div class="token-row"><div><strong>${esc(x.type.replaceAll('_', ' '))}</strong><p>${esc(x.proposal)}</p><small>Confidence: ${esc(x.confidence)} · A new review is required before a change.</small>${recordDetails(x.evidence, 'Supporting evidence')}</div></div>`).join('') || blank('No recommendation met the configured thresholds.')}${recordDetails(out, 'Analysis provenance and limitations')}</section>`;
    });
    workspaceBind('#reconcile-report', async f => {
      const v = Object.fromEntries(new FormData(f)),
        out = await workspaceCall('reporting', {
          action: 'reconcile',
          id: r.id,
          reference: {
            label: v.label,
            captured_at: Date.now(),
            totals: Object.fromEntries(['spend', 'clicks', 'conversions'].filter(k => v[k] !== '').map(k => [k, v[k]])),
          },
        });
      if (sequence !== selectionSequence || generation !== navigationGeneration || !detail.isConnected) return;
      $('#report-result').innerHTML =
        '<section class="panel"><h2>Reconciliation</h2>' +
        badge(out.matched ? 'verified' : 'mismatch') +
        recordDetails(out, 'Metric differences') +
        '</section>';
    });
  };
  await mountCaptureWizard(openReport);
  if (generation !== navigationGeneration || !detail.isConnected) return;
  renderList();
  const linked = new URLSearchParams(location.search).get('id');
  if (linked) await openReport(linked);
}
