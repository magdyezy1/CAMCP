'use strict';
// Account access review. Rendered only when the server confirms this session is the instance
// owner: a workspace owner elsewhere on the instance gets 403 and sees nothing at all.
const baseApprovalSettings = renderSettings;
const approvalState = {
  pending: ['attention', 'Waiting for you'],
  approved: ['online', 'Has access'],
  revoked: ['offline', 'Access removed'],
};
const approvalWhen = value => {
  const d = new Date(Number(value));
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—';
};
const approvalText = value =>
  String(value ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
renderSettings = async function () {
  await baseApprovalSettings();
  if (!session.authenticated) return;
  let data;
  try {
    data = await api('/api/owner/accounts');
  } catch {
    return;
  }
  if (location.pathname !== '/settings') return;
  const area = document.createElement('section');
  area.className = 'owner-operations';
  content.prepend(area);
  const vars = list => (list ?? []).map(v => `<code>${approvalText(v)}</code>`).join(' ');
  // "Temporarily unavailable" tells the operator nothing. Name the variables that are missing.
  const notice = () => {
    const setup = data.setup ?? {},
      providers = data.providers ?? [],
      off = providers.filter(p => !p.configured);
    const lines = [];
    lines.push(
      setup.email?.length
        ? `<p class="muted">Verification and recovery email is off, so signups cannot complete and you are not notified. Set ${vars(setup.email)} to enable it.</p>`
        : setup.ownerNotice?.length
          ? `<p class="muted">Email works. Set ${vars(setup.ownerNotice)} to be emailed when someone requests access, or migrate to an owner account.</p>`
          : `<p class="muted">Access requests are emailed to <strong>${approvalText(data.ownerEmail)}</strong>.</p>`,
    );
    if (setup.reviewer) lines.push(`<p class="muted">Reviewer sign-in: ${approvalText(setup.reviewer)}</p>`);
    if (setup.signup?.length)
      lines.push(
        `<p class="muted">Registration is closed. Set ${vars(setup.signup)} to let people request access.</p>`,
      );
    lines.push(
      providers.some(p => p.configured)
        ? `<p class="muted">Social sign-in: ${providers
            .filter(p => p.configured)
            .map(p => approvalText(p.name))
            .join(
              ', ',
            )} enabled${off.length ? `. Not configured: ${off.map(p => `${approvalText(p.name)} (${vars(['AMCP_SIGNIN_' + p.id.toUpperCase() + '_CLIENT_ID', 'AMCP_SIGNIN_' + p.id.toUpperCase() + '_CLIENT_SECRET'])})`).join(', ')}` : '.'}</p>`
        : `<p class="muted">No social sign-in is configured. For each provider set <code>AMCP_SIGNIN_&lt;PROVIDER&gt;_CLIENT_ID</code> and <code>AMCP_SIGNIN_&lt;PROVIDER&gt;_CLIENT_SECRET</code>: ${off.map(p => approvalText(p.name)).join(', ')}.</p>`,
    );
    return lines.join('');
  };
  const render = () => {
    const rows = data.accounts ?? [],
      waiting = data.pending ?? 0;
    area.innerHTML = `<div class="report-heading"><div><span class="eyebrow">ACCOUNT ACCESS</span><h2>Who can use AMCP</h2><p>Anyone can register. Nobody can sign in until you grant access here.</p></div><button class="button" id="approvals-refresh">Refresh</button></div>
  ${waiting ? `<p><span class="status attention">${waiting} waiting for review</span></p>` : ''}
  <p id="approvals-error" class="error" role="alert"></p>
  ${notice()}
  ${data.emailEnabled ? `<form id="test-invite" class="auth-form"><label>Invite a test account<input name="name" placeholder="Their name" maxlength="80" required></label><label><input name="email" type="email" placeholder="their@email" maxlength="254" required></label><button class="button small" type="submit">Send setup link</button><small class="muted">They choose their own password and land with test access: Overview, Reporting overview, Client profiles, Connections, Activity and Settings. They can connect their own platform logins and choose accounts in their separate workspace. None of your connections are shared.</small></form>` : ''}
  ${
    rows.length
      ? `<table class="asset-table"><thead><tr><th>Account</th><th>Sign-in</th><th>Requested</th><th>Status</th><th></th></tr></thead><tbody>${rows
          .map(a => {
            const [tone, label] = approvalState[a.state] ?? ['offline', a.state];
            return `<tr><td><strong>${approvalText(a.name) || '—'}</strong><br><small>${approvalText(a.email) || 'No email address'}</small></td>
   <td><small>${approvalText((a.methods ?? []).join(', ')) || '—'}</small></td>
   <td><small>${approvalWhen(a.created_at)}</small></td>
   <td><span class="status ${tone}">${label}</span>${a.test ? ' <span class="status attention">Test</span>' : ''}</td>
   <td>${
     a.state === 'approved'
       ? `<button class="button small" data-grant="true" data-test="${a.test ? 'false' : 'true'}" data-user="${approvalText(a.id)}">${a.test ? 'Give full access' : 'Limit to test access'}</button>
      <button class="button small danger" data-grant="false" data-user="${approvalText(a.id)}">Remove access</button>`
       : `<button class="button small primary" data-grant="true" data-user="${approvalText(a.id)}">Grant access</button>
      <button class="button small" data-grant="true" data-test="true" data-user="${approvalText(a.id)}">Grant test access</button>`
   }</td></tr>`;
          })
          .join('')}</tbody></table>`
      : '<p class="muted">No accounts yet.</p>'
  }`;
  };
  const reload = async () => {
    data = await api('/api/owner/accounts');
    render();
  };
  render();
  area.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    const error = area.querySelector('#approvals-error');
    if (error) error.textContent = '';
    if (button.id === 'approvals-refresh') {
      try {
        await reload();
      } catch (e) {
        if (error) error.textContent = e.message;
      }
      return;
    }
    if (!button.dataset.user) return;
    const grant = button.dataset.grant === 'true';
    // Removing access ends live sessions and connector credentials, so say so before doing it.
    if (
      !grant &&
      !(await confirmAction({
        title: 'Remove access for this account?',
        consequence: 'Their sessions and connector credentials end immediately.',
        confirmLabel: 'Remove access',
      }))
    )
      return;
    button.disabled = true;
    const body = {
      user_id: button.dataset.user,
      grant,
      ...(button.dataset.test ? {test: button.dataset.test === 'true'} : {}),
    };
    try {
      await api('/api/owner/accounts/access', {method: 'POST', body: JSON.stringify(body)});
      await reload();
    } catch (e) {
      if (error) error.textContent = e.message;
      button.disabled = false;
    }
  });
  area.addEventListener('submit', async event => {
    if (event.target.id !== 'test-invite') return;
    event.preventDefault();
    const form = event.target,
      error = area.querySelector('#approvals-error');
    if (error) error.textContent = '';
    const values = Object.fromEntries(new FormData(form));
    // A sent invitation is a success, not an error: announce it and keep the error line for failures.
    try {
      const r = await api('/api/owner/accounts/test-invite', {method: 'POST', body: JSON.stringify(values)});
      toast(r.message);
      form.reset();
    } catch (e) {
      if (error) error.textContent = e.message;
    }
  });
};
