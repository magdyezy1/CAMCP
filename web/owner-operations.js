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
  if (!g) return uiText('Choose an account to see how its platform counts money.');
  const u = (h.budget_units ?? {})[g];
  return u
    ? uiText('{platform} counts {unit}; amounts in account currency are converted ({evidence}).', {
        platform: platformName(g),
        unit: u.unit,
        evidence: u.evidence,
      })
    : uiText(
        '{platform} has no documented unit in AMCP: choose “Native API units” and use the unit of the native request you review.',
        {platform: platformName(g)},
      );
};
const ownerCall = async input => {
  const r = await api('/api/workspace/workspace', {method: 'POST', body: JSON.stringify(input)});
  if (!r.success) throw new Error(r.error?.message ?? uiText('Workspace operation failed.'));
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
  area.innerHTML = `<div class="report-heading"><div><span class="eyebrow">${esc(uiText('WORKSPACE OWNER'))}</span><h2>${esc(uiText('Health & operating controls'))}</h2><p>${esc(uiText('Connection readiness, deliveries and the boundaries you set for your team.'))}</p></div><button class="button" id="owner-refresh">${esc(uiText('Refresh health'))}</button></div><p id="owner-error" class="error" role="alert"></p><div class="report-summary-grid"><article class="report-summary-card"><small>${esc(uiText('Sign-in email'))}</small><h3>${signin.emailEnabled ? uiText('Configured') : uiText('Setup needed')}</h3><p>${esc(uiText('Verified registration, invitations and password recovery use the durable email queue.'))}</p>${!signin.emailEnabled ? `<code>AMCP_EMAIL_API_KEY<br>AMCP_EMAIL_FROM</code><p>${esc(uiText('Verify your sender domain in Resend, then set both server variables.'))}</p>` : ''}</article><article class="report-summary-card"><small>${esc(uiText('Social sign-in'))}</small><h3>${esc(uiText('Your providers'))}</h3>${signin.providers.map(p => `<p><strong>${esc(p.name)}</strong> · ${p.configured ? uiText('Configured') : uiText('Needs app credentials')}${p.callback ? `<br><code>` + esc(p.callback) + `</code>` : ''}</p>`).join('')}<a href="/account">${esc(uiText('Account security & members ↗'))}</a></article><article class="report-summary-card"><small>${esc(uiText('Backup verification'))}</small><h3>${h.backup.status === 'verified' ? uiText('Restore checked') : uiText('Verification needed')}</h3><p>${esc(h.backup.message ?? uiText('Last verification: ') + date(h.backup.verified_at))}</p><code>npm run admin -- backup-encrypted &lt;new-file&gt;</code></article></div><section class="panel"><h3>${esc(uiText('Connection health'))}</h3>${h.connections.map(c => `<div class="schedule-row"><span><strong>${esc(c.name)}</strong><small>${esc(c.gateway.replace('_native_action', ''))} · ${c.account_count} ${esc(uiText('selected ·'))} ${c.write_account_count} ${esc(uiText('write grants'))}</small></span><span class="status ${c.needs_attention ? 'attention' : ''}">${c.expires_at ? uiText('Expires ') + date(c.expires_at) : uiText('Provider expiry unavailable')}</span></div>`).join('') || `<p class="empty">${esc(uiText('Connect a platform to start.'))}</p>`}</section><div class="report-options-grid"><section class="panel"><h3>${esc(uiText('Background work'))}</h3>${h.jobs.map(j => `<p><strong>${esc(pretty(j.kind))}</strong> · ${esc(j.state)} · ${j.count}</p>`).join('') || `<p>${esc(uiText('No background jobs.'))}</p>`}<h4>${esc(uiText('Email delivery'))}</h4>${h.email.map(e => `<p>${esc(pretty(e.state))}: ${e.count}</p>`).join('') || `<p>${esc(uiText('No queued deliveries for this workspace.'))}</p>`}</section><section class="panel"><h3>${esc(uiText('Storage & retention'))}</h3><p>${(h.storage.database_bytes / 1048576).toFixed(1)} ${esc(uiText('MiB deployment database ·'))} ${h.storage.report_rows} ${esc(uiText('workspace report rows.'))}</p><form id="owner-retention"><label>${esc(uiText('Keep completed report snapshots for (days)'))}<input name="days" type="number" min="7" max="365" value="${h.retention?.days ?? 90}" required></label><p class="form-note">${esc(uiText('Saving enables automatic cleanup after this period. Audit records and write receipts are retained.'))}</p><button class="button">${esc(uiText('Save retention policy'))}</button></form><details><summary>${esc(uiText('Workspace limits & API versions'))}</summary><pre>${esc(JSON.stringify({limits: h.limits, versions: h.api_versions}, null, 2))}</pre></details></section></div><section class="panel" id="owner-write-pause"><h3>${esc(uiText('Pause all writes'))}</h3>${h.write_pause ? `<p class="notice"><strong>${esc(uiText('Writes are paused'))}</strong> ${esc(uiText('since'))} ${esc(date(h.write_pause.paused_at))} ${esc(uiText('by'))} ${esc(h.write_pause.paused_by)}: ${esc(h.write_pause.reason)}</p><p>${esc(uiText('Every reviewed write and media upload of this workspace is refused until you resume. Reads, reviews and verification continue.'))}</p><button class="button primary" id="owner-resume-writes">${esc(uiText('Resume writes'))}</button>` : `<p>${esc(uiText('An emergency stop for this workspace: every reviewed write and media upload is refused until an owner resumes. Nothing already submitted is undone.'))}</p><form id="owner-pause-writes"><label>${esc(uiText('Reason (shown to everyone whose write is refused)'))}<input name="reason" maxlength="500" required></label><button class="button">${esc(uiText('Pause all writes'))}</button></form>`}</section><section class="panel"><h3>${esc(uiText('Account spending policy'))}</h3><p>${esc(uiText('Set caps for reviewed changes. These limits govern requested budgets; they do not measure or cap the provider’s billed spend.'))}</p><form id="owner-spend-policy" class="workspace-form"><label>${esc(uiText('Selected account'))}<select name="binding" required><option value="">${esc(uiText('Choose an account'))}</option>${platforms
    .filter(p => p.reviewedWrites !== false)
    .flatMap(p =>
      p.connections.flatMap(c =>
        (c.accounts ?? []).map(
          a =>
            `<option value="${esc(JSON.stringify([c.gateway ?? p.gateway, c.id, a]))}">${esc(accountLabel(p, c, a))}</option>`,
        ),
      ),
    )
    .join(
      '',
    )}</select></label><label>${esc(uiText('When a change goes beyond a cap'))}<select name="enforcement"><option value="confirm" selected>${esc(uiText('Ask for confirmation (recommended)'))}</option><option value="block">${esc(uiText('Refuse the change'))}</option></select></label><label>${esc(uiText('Amounts are in'))}<select name="unit"><option value="currency">${esc(uiText('Account currency (where the platform unit is documented)'))}</option><option value="native">${esc(uiText('Native API units'))}</option></select></label><p class="form-note" id="owner-policy-unit" aria-live="polite">${policyUnitNote(h, '')}</p><label>${esc(uiText('Maximum budget'))}<input name="max_budget" type="number" min="0" step="any"></label><label>${esc(uiText('Maximum increase per change, %'))}<input name="max_budget_increase_percent" type="number" min="0" max="10000" step="any" value="20"></label><label>${esc(uiText('Cumulative daily increases'))}<input name="max_daily_increase" type="number" min="0" step="any"></label><label>${esc(uiText('Maximum bid'))}<input name="max_bid" type="number" min="0" step="any"></label><label class="check"><input name="allow_activation" type="checkbox" checked> ${esc(uiText('Allow activation after review'))}</label><label class="check"><input name="allow_deletion" type="checkbox"> ${esc(uiText('Allow deletion after review'))}</label><p class="form-note">${esc(uiText('With “Ask for confirmation”, a change beyond a cap is still prepared; the reviewer sees which cap and by how much, and it runs only after they confirm. Activation and deletion rules always refuse.'))}</p><button class="button primary">${esc(uiText('Save account policy'))}</button></form><form id="owner-workspace-policy" class="workspace-form"><h4>${esc(uiText('Workspace default'))}</h4><p class="form-note">${esc(uiText('Covers every account without a policy of its own. Budget caps are per platform in account currency, because each platform counts money in its own unit.'))}</p><label>${esc(uiText('When a change goes beyond a cap'))}<select name="enforcement"><option value="confirm" selected>${esc(uiText('Ask for confirmation (recommended)'))}</option><option value="block">${esc(uiText('Refuse the change'))}</option></select></label><label>${esc(uiText('Maximum increase per change, %'))}<input name="max_budget_increase_percent" type="number" min="0" max="10000" step="any"></label>${Object.entries(
    h.budget_units ?? {},
  )
    .filter(([g]) => platforms.some(p => p.connections.some(c => (c.gateway ?? p.gateway) === g)))
    .map(
      ([g, u]) =>
        `<label>${esc(platformName(g))} ${esc(uiText('maximum budget, account currency'))}<input name="cap:${esc(g)}" type="number" min="0" step="any"><small>${esc(uiText('Stored as'))} ${esc(u.unit)}</small></label>`,
    )
    .join(
      '',
    )}<button class="button">${esc(uiText('Save workspace default'))}</button></form>${(h.policy_warnings ?? []).map(w => `<div class="notice" role="status"><strong>${esc(uiText('Workspace default'))}</strong><p>${esc(w.message)}</p></div>`).join('')}<div id="owner-policy-list">${h.policies.map(p => `<details><summary>${p.gateway ? esc(platformName(p.gateway)) + ' · ' + esc(p.account_id) : uiText('Workspace default')} · ${p.enforcement === 'block' ? uiText('refuses beyond caps') : uiText('asks beyond caps')}</summary><pre>${esc(JSON.stringify(p, null, 2))}</pre></details>`).join('')}</div></section>`;
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
        title: uiText('Delete report snapshots older than {days} days?', {days}),
        consequence: uiText(
          'Saving turns on automatic cleanup: completed report snapshots older than {days} days are deleted from now on. Audit records and write receipts are kept.',
          {days},
        ),
        confirmLabel: uiText('Save and enable cleanup'),
      }))
    )
      return;
    await ownerCall({action: 'save_retention', days, confirmed: true});
    toast(uiText('Report retention policy saved.'));
    await renderSettings();
  });
  bind('#owner-pause-writes', async f => {
    const reason = String(new FormData(f).get('reason') ?? '').trim();
    if (
      !(await confirmAction({
        title: uiText('Pause every reviewed write of this workspace?'),
        consequence: uiText(
          'Executions and media uploads are refused until an owner resumes writes. Reviews prepared now stay valid for five minutes.',
        ),
        confirmLabel: uiText('Pause all writes'),
      }))
    )
      return;
    await ownerCall({action: 'pause_writes', reason, confirmed: true});
    toast(uiText('Writes are paused.'));
    await renderSettings();
  });
  bind('#owner-resume-writes', async () => {
    if (
      !(await confirmAction({
        title: uiText('Resume reviewed writes?'),
        consequence: uiText('Executions and media uploads run again under every other control.'),
        confirmLabel: uiText('Resume writes'),
      }))
    )
      return;
    await ownerCall({action: 'resume_writes', confirmed: true});
    toast(uiText('Writes resumed.'));
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
    toast(uiText('Account policy saved.'));
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
        title: uiText('Save the workspace default spending policy?'),
        consequence: uiText('It applies to every account without a policy of its own, from the next reviewed change.'),
        confirmLabel: uiText('Save workspace default'),
      }))
    )
      return;
    await ownerCall({action: 'save_spend_policy', scope: 'workspace', policy, confirmed: true});
    toast(uiText('Workspace default saved.'));
    await renderSettings();
  });
};
