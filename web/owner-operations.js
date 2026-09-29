'use strict';
const baseWorkspaceSettings = renderSettings;
const platformName = g =>
  ({
    google_ads_native_action: 'Google Ads',
    meta_native_action: 'Meta',
    tiktok_native_action: 'TikTok',
    snapchat_native_action: 'Snapchat',
    linkedin_native_action: 'LinkedIn',
    x_ads_native_action: 'X',
    microsoft_ads_native_action: 'Microsoft Advertising',
    reddit_native_action: 'Reddit',
    dv360_native_action: 'DV360',
    apple_ads_native_action: 'Apple Ads',
    criteo_native_action: 'Criteo',
  })[g] ?? String(g).replace('_native_action', '');
/** What the amounts of an account policy mean for the selected platform. */
const policyUnitNote = (h, g) => {
  if (!g) return 'Choose an account to see how its platform counts money.';
  const u = (h.budget_units ?? {})[g];
  return u
    ? platformName(g) + ' counts ' + u.unit + '; amounts in account currency are converted (' + u.evidence + ').'
    : platformName(g) +
        ' has no documented unit in AMCP: choose “Native API units” and use the unit of the native request you review.';
};
const ownerCall = async input => {
  const r = await api('/api/workspace/workspace', {method: 'POST', body: JSON.stringify(input)});
  if (!r.success) throw new Error(r.error?.message ?? 'Workspace operation failed.');
  return r.data;
};
renderSettings = async function () {
  baseWorkspaceSettings();
  if (!session.authenticated || (!session.administrator && session.workspaceRole !== 'owner')) return;
  const [h, signin] = await Promise.all([ownerCall({action: 'health'}), api('/api/account/options')]);
  if (location.pathname !== '/settings') return;
  const area = document.createElement('section');
  area.className = 'owner-operations';
  // Below the page's own heading, so the page title comes first (F-43).
  const pageHeading = content.querySelector(':scope > .page-heading');
  if (pageHeading) pageHeading.after(area);
  else content.append(area);
  area.innerHTML = `<div class="report-heading"><div><span class="eyebrow">WORKSPACE OWNER</span><h2>Health & operating controls</h2><p>Connection readiness, deliveries and the boundaries you set for your team.</p></div><button class="button" id="owner-refresh">Refresh health</button></div><p id="owner-error" class="error" role="alert"></p><div class="report-summary-grid"><article class="report-summary-card"><small>Sign-in email</small><h3>${signin.emailEnabled ? 'Configured' : 'Setup needed'}</h3><p>Verified registration, invitations and password recovery use the durable email queue.</p>${!signin.emailEnabled ? '<code>AMCP_EMAIL_API_KEY<br>AMCP_EMAIL_FROM</code><p>Verify your sender domain in Resend, then set both server variables.</p>' : ''}</article><article class="report-summary-card"><small>Social sign-in</small><h3>Your providers</h3>${signin.providers.map(p => `<p><strong>${esc(p.name)}</strong> · ${p.configured ? 'Configured' : 'Needs app credentials'}${p.callback ? '<br><code>' + esc(p.callback) + '</code>' : ''}</p>`).join('')}<a href="/account">Account security & members ↗</a></article><article class="report-summary-card"><small>Backup verification</small><h3>${h.backup.status === 'verified' ? 'Restore checked' : 'Verification needed'}</h3><p>${esc(h.backup.message ?? 'Last verification: ' + date(h.backup.verified_at))}</p><code>npm run admin -- backup-encrypted &lt;new-file&gt;</code></article></div><section class="panel"><h3>Connection health</h3>${h.connections.map(c => `<div class="schedule-row"><span><strong>${esc(c.name)}</strong><small>${esc(c.gateway.replace('_native_action', ''))} · ${c.account_count} selected · ${c.write_account_count} write grants</small></span><span class="status ${c.needs_attention ? 'attention' : ''}">${c.expires_at ? 'Expires ' + date(c.expires_at) : 'Provider expiry unavailable'}</span></div>`).join('') || '<p class="empty">Connect a platform to start.</p>'}</section><div class="report-options-grid"><section class="panel"><h3>Background work</h3>${h.jobs.map(j => `<p><strong>${esc(pretty(j.kind))}</strong> · ${esc(j.state)} · ${j.count}</p>`).join('') || '<p>No background jobs.</p>'}<h4>Email delivery</h4>${h.email.map(e => `<p>${esc(pretty(e.state))}: ${e.count}</p>`).join('') || '<p>No queued deliveries for this workspace.</p>'}</section><section class="panel"><h3>Storage & retention</h3><p>${(h.storage.database_bytes / 1048576).toFixed(1)} MiB deployment database · ${h.storage.report_rows} workspace report rows.</p><form id="owner-retention"><label>Keep completed report snapshots for (days)<input name="days" type="number" min="7" max="365" value="${h.retention?.days ?? 90}" required></label><p class="form-note">Saving enables automatic cleanup after this period. Audit records and write receipts are retained.</p><button class="button">Save retention policy</button></form><details><summary>Workspace limits & API versions</summary><pre>${esc(JSON.stringify({limits: h.limits, versions: h.api_versions}, null, 2))}</pre></details></section></div><section class="panel" id="owner-write-pause"><h3>Pause all writes</h3>${h.write_pause ? `<p class="notice"><strong>Writes are paused</strong> since ${esc(date(h.write_pause.paused_at))} by ${esc(h.write_pause.paused_by)}: ${esc(h.write_pause.reason)}</p><p>Every reviewed write and media upload of this workspace is refused until you resume. Reads, reviews and verification continue.</p><button class="button primary" id="owner-resume-writes">Resume writes</button>` : `<p>An emergency stop for this workspace: every reviewed write and media upload is refused until an owner resumes. Nothing already submitted is undone.</p><form id="owner-pause-writes"><label>Reason (shown to everyone whose write is refused)<input name="reason" maxlength="500" required></label><button class="button">Pause all writes</button></form>`}</section><section class="panel"><h3>Account spending policy</h3><p>Set caps for reviewed changes. These limits govern requested budgets; they do not measure or cap the provider’s billed spend.</p><form id="owner-spend-policy" class="workspace-form"><label>Selected account<select name="binding" required><option value="">Choose an account</option>${platforms
    .filter(p => p.reviewedWrites !== false)
    .flatMap(p =>
      p.connections.flatMap(c =>
        (c.accounts ?? []).map(
          a =>
            `<option value="${esc(JSON.stringify([c.gateway ?? p.gateway, c.id, a]))}">${esc(p.name)} · ${esc(c.label ?? c.name ?? '')} · ${esc(a)}</option>`,
        ),
      ),
    )
    .join(
      '',
    )}</select></label><label>When a change goes beyond a cap<select name="enforcement"><option value="confirm" selected>Ask for confirmation (recommended)</option><option value="block">Refuse the change</option></select></label><label>Amounts are in<select name="unit"><option value="currency">Account currency (where the platform unit is documented)</option><option value="native">Native API units</option></select></label><p class="form-note" id="owner-policy-unit" aria-live="polite">${policyUnitNote(h, '')}</p><label>Maximum budget<input name="max_budget" type="number" min="0" step="any"></label><label>Maximum increase per change, %<input name="max_budget_increase_percent" type="number" min="0" max="10000" step="any" value="20"></label><label>Cumulative daily increases<input name="max_daily_increase" type="number" min="0" step="any"></label><label>Maximum bid<input name="max_bid" type="number" min="0" step="any"></label><label class="check"><input name="allow_activation" type="checkbox" checked> Allow activation after review</label><label class="check"><input name="allow_deletion" type="checkbox"> Allow deletion after review</label><p class="form-note">With “Ask for confirmation”, a change beyond a cap is still prepared; the reviewer sees which cap and by how much, and it runs only after they confirm. Activation and deletion rules always refuse.</p><button class="button primary">Save account policy</button></form><form id="owner-workspace-policy" class="workspace-form"><h4>Workspace default</h4><p class="form-note">Covers every account without a policy of its own. Budget caps are per platform in account currency, because each platform counts money in its own unit.</p><label>When a change goes beyond a cap<select name="enforcement"><option value="confirm" selected>Ask for confirmation (recommended)</option><option value="block">Refuse the change</option></select></label><label>Maximum increase per change, %<input name="max_budget_increase_percent" type="number" min="0" max="10000" step="any"></label>${Object.entries(
    h.budget_units ?? {},
  )
    .filter(([g]) => platforms.some(p => p.connections.some(c => (c.gateway ?? p.gateway) === g)))
    .map(
      ([g, u]) =>
        `<label>${esc(platformName(g))} maximum budget, account currency<input name="cap:${esc(g)}" type="number" min="0" step="any"><small>Stored as ${esc(u.unit)}</small></label>`,
    )
    .join(
      '',
    )}<button class="button">Save workspace default</button></form>${(h.policy_warnings ?? []).map(w => `<div class="notice" role="status"><strong>Workspace default</strong><p>${esc(w.message)}</p></div>`).join('')}<div id="owner-policy-list">${h.policies.map(p => `<details><summary>${p.gateway ? esc(platformName(p.gateway)) + ' · ' + esc(p.account_id) : 'Workspace default'} · ${p.enforcement === 'block' ? 'refuses beyond caps' : 'asks beyond caps'}</summary><pre>${esc(JSON.stringify(p, null, 2))}</pre></details>`).join('')}</div></section>`;
  const bind = (selector, fn) =>
    authBind(selector, async el => {
      try {
        await fn(el);
      } catch (e) {
        $('#owner-error').textContent = e.message;
        $('#owner-error').scrollIntoView({block: 'center'});
      }
    });
  bind('#owner-refresh', async () => renderSettings());
  bind('#owner-retention', async f => {
    const days = Number(new FormData(f).get('days'));
    if (
      !(await confirmAction({
        title: 'Delete report snapshots older than ' + days + ' days?',
        consequence:
          'Saving turns on automatic cleanup: completed report snapshots older than ' +
          days +
          ' days are deleted from now on. Audit records and write receipts are kept.',
        confirmLabel: 'Save and enable cleanup',
      }))
    )
      return;
    await ownerCall({action: 'save_retention', days, confirmed: true});
    toast('Report retention policy saved.');
    await renderSettings();
  });
  bind('#owner-pause-writes', async f => {
    const reason = String(new FormData(f).get('reason') ?? '').trim();
    if (
      !(await confirmAction({
        title: 'Pause every reviewed write of this workspace?',
        consequence:
          'Executions and media uploads are refused until an owner resumes writes. Reviews prepared now stay valid for five minutes.',
        confirmLabel: 'Pause all writes',
      }))
    )
      return;
    await ownerCall({action: 'pause_writes', reason, confirmed: true});
    toast('Writes are paused.');
    await renderSettings();
  });
  bind('#owner-resume-writes', async () => {
    if (
      !(await confirmAction({
        title: 'Resume reviewed writes?',
        consequence: 'Executions and media uploads run again under every other control.',
        confirmLabel: 'Resume writes',
      }))
    )
      return;
    await ownerCall({action: 'resume_writes', confirmed: true});
    toast('Writes resumed.');
    await renderSettings();
  });
  $('#owner-spend-policy select[name=binding]')?.addEventListener('change', e => {
    const b = e.target.value ? JSON.parse(e.target.value) : [''];
    $('#owner-policy-unit').textContent = policyUnitNote(h, b[0]);
  });
  bind('#owner-spend-policy', async f => {
    const d = new FormData(f),
      [gateway, connection_id, account_id] = JSON.parse(d.get('binding')),
      suffix = d.get('unit') === 'native' ? '_native' : '_currency',
      policy = {
        allow_activation: d.has('allow_activation'),
        allow_deletion: d.has('allow_deletion'),
        enforcement: d.get('enforcement'),
      };
    if (d.get('max_budget_increase_percent') !== '')
      policy.max_budget_increase_percent = Number(d.get('max_budget_increase_percent'));
    for (const key of ['max_budget', 'max_daily_increase', 'max_bid'])
      if (d.get(key) !== '') policy[key + suffix] = Number(d.get(key));
    await ownerCall({action: 'save_spend_policy', gateway, connection_id, account_id, policy, confirmed: true});
    toast('Account policy saved.');
    await renderSettings();
  });
  bind('#owner-workspace-policy', async f => {
    const d = new FormData(f),
      policy = {enforcement: d.get('enforcement')},
      per = {};
    if (d.get('max_budget_increase_percent') !== '')
      policy.max_budget_increase_percent = Number(d.get('max_budget_increase_percent'));
    for (const [k, v] of d.entries())
      if (k.startsWith('cap:') && v !== '') per[k.slice(4)] = {max_budget_currency: Number(v)};
    if (Object.keys(per).length) policy.per_gateway = per;
    if (
      !(await confirmAction({
        title: 'Save the workspace default spending policy?',
        consequence: 'It applies to every account without a policy of its own, from the next reviewed change.',
        confirmLabel: 'Save workspace default',
      }))
    )
      return;
    await ownerCall({action: 'save_spend_policy', scope: 'workspace', policy, confirmed: true});
    toast('Workspace default saved.');
    await renderSettings();
  });
};
