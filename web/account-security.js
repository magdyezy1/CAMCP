'use strict';
let loginMfaTicket = null;
const baseAccountPage = renderAccountPage;
formField = function (label, name, type = 'text', extra = '') {
  return `<label>${esc(label)}<span class="password-field"><input name="${esc(name)}" type="${type}" ${extra} required>${type === 'password' ? `<button type="button" class="password-toggle" aria-label="${esc(uiText('Show password'))}">${esc(uiText('Show'))}</button>` : ''}</span></label>`;
};
document.addEventListener('click', e => {
  const button = e.target.closest('.password-toggle');
  if (!button) return;
  const input = button.parentElement.querySelector('input');
  input.type = input.type === 'password' ? 'text' : 'password';
  button.textContent = input.type === 'password' ? uiText('Show') : uiText('Hide');
  button.setAttribute('aria-label', uiText(input.type === 'password' ? 'Show password' : 'Hide password'));
});
socialButtons = function () {
  const providers = (authOptions?.providers ?? []).filter(p => p.configured);
  return providers.length
    ? `<div class="social-buttons">${providers.map(p => `<button class="social-button" data-social="${esc(p.id)}"><span class="social-icon ${esc(p.id)}">${p.id === 'google' ? 'G' : p.id === 'apple' ? '●' : 'f'}</span>${esc(uiText('Continue with'))} ${esc(p.name)}</button>`).join('')}</div><div class="auth-divider"><span>${esc(uiText('or continue with email'))}</span></div>`
    : '';
};
const signInComplete = async () => {
  loginMfaTicket = null;
  session = await api('/api/session');
  platforms = (await api('/api/platforms')).platforms;
  afterSignIn();
};
renderAuthPage = async function () {
  authOptions = await api('/api/account/options');
  const mode = location.pathname.slice(1),
    signup = mode === 'signup',
    forgot = mode === 'forgot-password',
    verify = ['verify-email', 'reset-password'].includes(mode),
    hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('mfa')) {
    loginMfaTicket = hash.get('mfa');
    history.replaceState({}, '', location.pathname);
  }
  if (verify && hash.get('token')) {
    verificationLink = {
      token: hash.get('token'),
      kind: hash.get('kind') ?? (mode === 'reset-password' ? 'reset' : 'register'),
    };
    history.replaceState({}, '', location.pathname);
  }
  const mfa = !!loginMfaTicket,
    heading = mfa
      ? uiText('One more step.')
      : signup
        ? uiText('Make yourself at home.')
        : forgot
          ? uiText('A fresh start.')
          : verify
            ? uiText('You’re almost in.')
            : uiText('Good to have you back.'),
    kind = verificationLink?.kind;
  const password =
    formField(
      uiText('Choose a password'),
      'password',
      'password',
      'minlength="15" maxlength="128" autocomplete="new-password"',
    ) + `<p class="form-note">${esc(uiText('At least 15 characters. A memorable phrase works well.'))}</p>`;
  let form = mfa
    ? `<form id="mfa-login" class="auth-form">${formField(uiText('Authenticator or recovery code'), 'code', 'text', 'autocomplete="one-time-code" maxlength="32"')}<button class="button primary full">${esc(uiText('Verify and sign in ↗'))}</button></form>`
    : verify
      ? `<form id="email-finish" class="auth-form">${kind === 'owner' ? `<p>${esc(uiText('Set the email password for your existing workspace. Your connected accounts and campaign history stay here.'))}</p>` : ''}${kind === 'invite' && session.authenticated ? `<p>${esc(uiText('Accept this invitation with your signed-in account.'))}</p>` : kind === 'email' ? `<p>${esc(uiText('Confirm your new recovery email.'))}</p>` : (kind === 'invite' ? formField(uiText('Your name'), 'name', 'text', 'maxlength="80" autocomplete="name"') : '') + password}<button class="button primary full" ${verificationLink?.token ? '' : 'disabled'}>${esc(uiText('Complete verification ↗'))}</button></form><p class="form-note">${kind === 'invite' ? esc(uiText('Already have an account? Sign in in another tab, then reopen this email link.')) + ' ' : ''}${esc(uiText('If this link has expired, request a new one from'))} <a href="${kind === 'reset' ? '/forgot-password' : kind === 'owner' ? '/account' : '/signup'}">${kind === 'reset' ? uiText('password recovery') : kind === 'owner' ? uiText('Account settings') : uiText('registration')}</a>.</p>`
      : forgot
        ? `<form id="forgot-form" class="auth-form">${formField(uiText('Email address'), 'email', 'email', 'autocomplete="email" maxlength="254"')}<button class="button primary full" ${authOptions.emailEnabled ? '' : 'disabled'}>${esc(uiText('Send reset link ↗'))}</button></form>`
        : `<form id="member-form" class="auth-form">${signup ? formField(uiText('Your name'), 'name', 'text', 'autocomplete="name" maxlength="80"') : ''}${formField(uiText('Email address'), 'email', 'email', 'autocomplete="username" maxlength="254"')}${signup ? `<p class="form-note">${esc(uiText('First verify your email. Then choose your password.'))}</p>` : formField(uiText('Password'), 'password', 'password', 'autocomplete="current-password" maxlength="128"') + `<a class="forgot-link" href="/forgot-password">${esc(uiText('Forgot password?'))}</a>`}<button class="button primary full" ${signup && (!authOptions.signupEnabled || !authOptions.emailEnabled) ? 'disabled' : ''}>${signup ? uiText('Send verification email') : uiText('Sign in to your workspace')} ↗</button></form>`;
  // The owner door (SEC-05) appears only while it can open, and on the public page only until anyone holds an
  // account; afterwards the deployment owner opens it at /login?owner=1.
  content.innerHTML = `<div class="auth-page"><div class="auth-brand">${brandLink()}${languageControl()}<a href="/" class="text-link">${esc(uiText('Back to home ↗'))}</a></div><section class="auth-story"><span class="eyebrow">${esc(uiText('YOUR SPACE TO MAKE MOVES'))}</span><div class="auth-tagline">${esc(uiText('Connected accounts.'))}<br>${esc(uiText('Considered decisions.'))}<br><em>${esc(uiText('All yours.'))}</em></div><div class="auth-art" aria-hidden="true"><div class="auth-arch"></div><div class="auth-disc"></div><span>✳</span></div><p>${esc(uiText('Campaigns, creative and reporting. One workspace, with access you control.'))}</p></section><section class="auth-form-side"><div class="auth-form-card"><span class="eyebrow">${mfa ? uiText('TWO-STEP VERIFICATION') : uiText('WELCOME TO AMCP')}</span><h1>${heading}</h1><p class="auth-subtitle">${mfa ? uiText('Enter a code from your authenticator, or use a recovery code.') : signup ? uiText('A workspace for your accounts, ideas and next moves.') : forgot ? uiText('We’ll send a secure link to your verified email.') : verify ? uiText('Confirm your email and secure your account.') : uiText('Pick up where you left off.')}</p>${!mfa && !verify && !forgot ? socialButtons() : ''}<p id="auth-error" class="error" role="alert">${esc(uiText(authErrors[new URLSearchParams(location.search).get('error')] ?? ''))}</p><div id="auth-result" role="status"></div>${form}${!authOptions.emailEnabled && (signup || forgot) ? `<p class="form-note">${esc(uiText('Email registration and recovery are temporarily unavailable. Contact the workspace owner or use an available sign-in method.'))}</p>` : ''}<p class="auth-switch">${signup ? `<a href="/login">${esc(uiText('Already have an account? Sign in'))}</a>` : verify || forgot || mfa ? `<a href="/login" id="back-to-login">${esc(uiText('Back to sign in'))}</a>` : `${esc(uiText('New here?'))} <a href="/signup">${esc(uiText('Create an account'))}</a>`}</p>${authOptions.administratorEnabled && !mfa && (authOptions.administratorListed || new URLSearchParams(location.search).get('owner') === '1') ? `<section class="owner-entry"><span class="eyebrow">${esc(uiText('DEPLOYMENT OWNER'))}</span><h2>${esc(uiText('Owner sign-in'))}</h2><p>${esc(uiText('Sign in with the administrator password set on the server. Everyone else signs in with their own account above.'))}</p><button class="button primary large full" data-open-admin>${esc(uiText('Open owner sign-in ↗'))}</button></section>` : ''}${authOptions.testEnabled && !mfa ? `<section class="owner-entry test-entry"><span class="eyebrow">${esc(uiText('TEST ACCESS'))}</span><h2>${esc(uiText('Reviewer sign-in'))}</h2><p>${esc(uiText('Connect your own platforms in the test workspace. Everyone using the shared test password can access its selected accounts; use a personal account for private connections. The deployment owner’s connections stay separate.'))}</p><button class="button primary large full" data-open-test>${esc(uiText('Open test workspace ↗'))}</button></section>` : ''}${authLegalNotice()}</div></section></div>`;
  authBind('[data-social]', async b => {
    const r = await api('/api/signin/' + b.dataset.social + '/start', {method: 'POST', body: '{}'});
    location.assign(r.url);
  });
  authBind('#member-form', async f => {
    const data = Object.fromEntries(new FormData(f)),
      r = await api('/api/account/' + (signup ? 'register' : 'login'), {method: 'POST', body: JSON.stringify(data)});
    if (signup) {
      f.hidden = true;
      $('#auth-result').innerHTML =
        `<div class="auth-success"><div><strong>${esc(uiText('Check your inbox'))}</strong><p>${esc(uiText(r.message))}</p><p>${esc(uiText('Check spam too. The link expires in 30 minutes.'))}</p><button id="resend-email" class="button">${esc(uiText('Resend verification email'))}</button><span id="resend-status" role="status"></span></div></div>`;
      authBind('#resend-email', async () => {
        const response = await api('/api/account/resend-verification', {method: 'POST', body: JSON.stringify(data)});
        $('#resend-status').textContent = uiText(response.message);
      });
    } else if (r.mfaRequired) {
      loginMfaTicket = r.ticket;
      await renderAuthPage();
    } else await signInComplete();
  });
  authBind('#forgot-form', async f => {
    const r = await api('/api/account/forgot-password', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(new FormData(f))),
    });
    $('#auth-result').textContent = uiText(r.message);
  });
  authBind('#email-finish', async f => {
    const r = await api('/api/account/verify-email', {
      method: 'POST',
      body: JSON.stringify({...verificationLink, ...Object.fromEntries(new FormData(f))}),
    });
    verificationLink = null;
    f.hidden = true;
    $('#auth-result').innerHTML =
      `<div class="auth-success"><div><strong>${esc(uiText('You’re all set.'))}</strong><p>${esc(uiText(r.message))}</p><a class="button primary" href="${session.authenticated && kind === 'invite' ? '/account' : '/login'}">${esc(uiText('Continue ↗'))}</a></div></div>`;
  });
  authBind('#mfa-login', async f => {
    await api('/api/account/mfa/login', {
      method: 'POST',
      body: JSON.stringify({ticket: loginMfaTicket, code: new FormData(f).get('code')}),
    });
    await signInComplete();
  });
  $('#back-to-login')?.addEventListener('click', () => {
    loginMfaTicket = null;
  });
};
renderAccountPage = async function () {
  await baseAccountPage();
  if (!session.authenticated) return;
  const account = await api('/api/account'),
    options = await api('/api/account/options');
  if (account.administrator) {
    content.insertAdjacentHTML(
      'beforeend',
      `<section class="panel account-security-panel"><span class="eyebrow">${esc(uiText('KEEP YOUR EXISTING WORKSPACE'))}</span><h2>${esc(uiText('Set up your owner account'))}</h2><p>${esc(uiText('Verify your email and set a password for this workspace. Your platform connections, reports, campaigns and permissions remain in place.'))}</p><form id="owner-setup" class="auth-form">${formField(uiText('Your name'), 'name', 'text', 'maxlength="80" autocomplete="name"')}${formField(uiText('Email address'), 'email', 'email', 'maxlength="254" autocomplete="email"')}${formField(uiText('Current administrator password'), 'administratorPassword', 'password', 'autocomplete="current-password"')}<button class="button primary" ${options.emailEnabled ? '' : 'disabled'}>${esc(uiText('Send owner verification email ↗'))}</button></form>${options.emailEnabled ? '' : `<p class="notice">${esc(uiText('Configure a verified email sender in Settings before owner setup.'))}</p>`}</section>`,
    );
    authBind('#owner-setup', async f => {
      const r = await api('/api/account/owner-setup', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(f))),
      });
      toast(uiText(r.message));
      f.reset();
    });
  } else {
    // A workspace two-step requirement (SEC-06) says when it applies, and that nothing else opens once it does.
    const mfaNotice =
      account.mfaRequired && !account.mfaEnabled
        ? `<p class="notice" role="alert" id="mfa-required-notice">${esc(account.mfaEnrollmentRequired ? uiText('This workspace requires two-step verification. Set it up now to continue using AMCP.') : uiText('This workspace requires two-step verification from {date}. Set it up before then to keep working without interruption.', {date: date(account.mfaRequiredBy)}))}</p>`
        : '';
    content.insertAdjacentHTML(
      'beforeend',
      `<section class="panel account-security-panel"><div class="panel-header"><div><span class="eyebrow">${esc(uiText('ANOTHER LAYER OF SECURITY'))}</span><h2>${esc(uiText('Two-step authentication'))}</h2></div><span class="status ${account.mfaEnabled ? 'online' : ''}">${account.mfaEnabled ? uiText('Enabled') : uiText('Available')}</span></div>${mfaNotice}<p>${esc(uiText('Use an authenticator app and keep recovery codes somewhere safe. Enabling or disabling this protection revokes existing sessions and MCP access.'))}</p><div id="mfa-setup">${account.mfaEnabled ? `<form id="mfa-recovery" class="auth-form">${formField(uiText('Authenticator or recovery code'), 'code', 'text', 'maxlength="32" autocomplete="one-time-code"')}<button class="button">${esc(uiText('Create new recovery codes'))}</button><p class="form-note">${esc(uiText('Your previous recovery codes stop working. Your sessions stay signed in.'))}</p></form><form id="mfa-disable" class="auth-form">${formField(uiText('Authenticator or recovery code'), 'code', 'text', 'maxlength="32" autocomplete="one-time-code"')}<button class="button">${esc(uiText('Disable two-step authentication'))}</button></form>` : `<button id="mfa-start" class="button primary">${esc(uiText('Set up authenticator'))}</button>`}</div></section>`,
    );
    const showRecoveryCodes = recoveryCodes => {
      const codes = recoveryCodes.join('\n');
      $('#mfa-setup').innerHTML =
        `<div class="notice" role="alert"><strong>${esc(uiText('Save these recovery codes now.'))}</strong> ${esc(uiText('Each code works once, if you lose your authenticator. They will not be shown again.'))}</div><pre class="recovery-key">${recoveryCodes.map(esc).join('\n')}</pre><div class="report-actions"><button type="button" class="button" id="mfa-copy-codes">${esc(uiText('Copy codes'))}</button><button type="button" class="button" id="mfa-download-codes">${esc(uiText('Download as a text file'))}</button><a class="button primary" href="/account">${esc(uiText('I’ve saved my codes'))}</a></div>`;
      $('#mfa-copy-codes').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(codes);
          toast(uiText('Recovery codes copied.'));
        } catch {
          toast(uiText('Select the codes and copy them.'));
        }
      });
      $('#mfa-download-codes').addEventListener('click', () => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(
          new Blob(['AMCP recovery codes. Each works once.\n\n' + codes + '\n'], {type: 'text/plain'}),
        );
        link.download = 'AMCP-recovery-codes.txt';
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      });
    };
    authBind('#mfa-recovery', async f => {
      const result = await api('/api/account/mfa/recovery-codes', {
        method: 'POST',
        body: JSON.stringify({code: new FormData(f).get('code')}),
      });
      showRecoveryCodes(result.recoveryCodes);
    });
    authBind('#mfa-start', async () => {
      const r = await api('/api/account/mfa/start', {method: 'POST', body: '{}'});
      $('#mfa-setup').innerHTML =
        `<ol class="mfa-steps"><li><strong>${esc(uiText('Add AMCP to your authenticator app.'))}</strong> ${esc(uiText('Scan this code with it:'))}${mfaQr(r.uri)}${esc(uiText('On this phone or tablet:'))} <a class="button small" href="${esc(r.uri)}">${esc(uiText('Open in authenticator app'))}</a>${esc(uiText('. Or enter this setup key (time-based, 6 digits):'))}<code class="recovery-key" id="mfa-key">${esc(r.secret.match(/.{1,4}/g).join(' '))}</code><button type="button" class="button small" id="mfa-copy-key">${esc(uiText('Copy setup key'))}</button></li><li><strong>${esc(uiText('Enter the code the app shows'))}</strong> ${esc(uiText('to confirm it works.'))}<form id="mfa-enable" class="auth-form">${formField(uiText('6-digit authenticator code'), 'code', 'text', 'inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code"')}<button class="button primary">${esc(uiText('Verify and enable'))}</button></form></li></ol>`;
      $('#mfa-copy-key').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(r.secret);
          toast(uiText('Setup key copied.'));
        } catch {
          toast(uiText('Select the key and copy it.'));
        }
      });
      authBind('#mfa-enable', async f => {
        const result = await api('/api/account/mfa/enable', {
          method: 'POST',
          body: JSON.stringify({ticket: r.ticket, code: new FormData(f).get('code')}),
        });
        session = await api('/api/session');
        showRecoveryCodes(result.recoveryCodes);
      });
    });
    authBind('#mfa-disable', async f => {
      await api('/api/account/mfa/disable', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(f))),
      });
      session = await api('/api/session');
      await renderAccountPage();
    });
    const w = await api('/api/workspaces');
    content.insertAdjacentHTML(
      'beforeend',
      `<section class="panel"><h2>${esc(uiText('Your workspaces'))}</h2><p>${esc(uiText('One sign-in can belong to several workspaces. Each workspace controls its own accounts and permissions.'))}</p>${w.workspaces.map(x => `<div class="identity-row"><div><strong dir="auto" data-native>${esc(x.name)}</strong><small>${esc(uiRole(x.role))}</small></div><button class="button small" data-switch-workspace="${esc(x.id)}" ${x.id === account.workspaceId ? 'disabled' : ''}>${x.id === account.workspaceId ? uiText('Current workspace') : uiText('Switch workspace')}</button></div>`).join('')}</section>`,
    );
    authBind('[data-switch-workspace]', async b => {
      await api('/api/workspaces/switch', {
        method: 'POST',
        body: JSON.stringify({workspaceId: b.dataset.switchWorkspace}),
      });
      session = await api('/api/session');
      platforms = (await api('/api/platforms')).platforms;
      await render();
    });
  }
  // Until a required two-step setup is done the server refuses the team APIs (SEC-06), so the page shows setup only.
  if (['owner', 'admin'].includes(account.workspaceRole) && !account.mfaEnrollmentRequired) {
    const team = await api('/api/workspaces/members'),
      // Client access sets (SEC-08): what a member, token or AI client may be limited to.
      sets = (await api('/api/access-sets').catch(() => ({sets: []}))).sets ?? [],
      setName = id => sets.find(s => s.id === id)?.name ?? uiText('a removed client'),
      setOptions = (selectedId, none) =>
        `<option value="">${esc(none)}</option>` +
        sets
          .map(s => `<option value="${esc(s.id)}" ${s.id === selectedId ? 'selected' : ''}>${esc(s.name)}</option>`)
          .join(''),
      security = team.security ?? {require_mfa: 'off', invitation_hours: 72},
      baseline = team.baseline ?? {require_mfa: 'off'},
      owner = account.workspaceRole === 'owner',
      // SEC-06: the AMCP owner resets a member's lost two-step verification; workspace owners set the policy.
      resetButton = m =>
        account.instanceOwner && m.mfa && m.id !== account.id
          ? `<button class="button small" data-member-mfa-reset="${esc(m.id)}" data-member-name="${esc(m.name)}">${esc(uiText('Reset two-step'))}</button>`
          : '',
      invitations = (team.invitations ?? [])
        .map(
          i =>
            `<div class="identity-row"><div><strong>${esc(uiRole(i.role))}</strong><small>${esc(uiText('Invited {sent} · expires {expires}', {sent: date(i.created_at), expires: date(i.expires_at)}))}${i.access_set_id ? ' · ' + esc(uiText('Limited to {client}', {client: setName(i.access_set_id)})) : ''}</small></div><button class="button small" data-invite-revoke="${esc(i.id)}">${esc(uiText('Withdraw'))}</button></div>`,
        )
        .join(''),
      baselineNote =
        baseline.require_mfa === 'off'
          ? ''
          : `<p class="form-note">${esc(baseline.require_mfa === 'everyone' ? uiText('This deployment requires two-step verification of every member, {days} days after they join or the requirement starts.', {days: baseline.grace_days}) : uiText('This deployment requires two-step verification of owners and administrators, {days} days after they join or the requirement starts.', {days: baseline.grace_days}))}</p>`,
      policyForm = owner
        ? `<form id="workspace-security" class="workspace-form"><h3>${esc(uiText('Workspace security'))}</h3><label>${esc(uiText('Require two-step verification'))}<select name="require_mfa"><option value="off" ${security.require_mfa === 'off' ? 'selected' : ''}>${esc(uiText('Not required by this workspace'))}</option><option value="admins" ${security.require_mfa === 'admins' ? 'selected' : ''}>${esc(uiText('Owners and administrators'))}</option><option value="everyone" ${security.require_mfa === 'everyone' ? 'selected' : ''}>${esc(uiText('Everyone'))}</option></select></label><label>${esc(uiText('Grace period before it applies (days)'))}<input name="grace_days" type="number" min="0" max="30" value="7" required></label><label>${esc(uiText('Invitation lifetime (hours)'))}<input name="invitation_hours" type="number" min="1" max="168" value="${esc(security.invitation_hours)}" required></label><button class="button">${esc(uiText('Save security settings'))}</button></form>${security.require_mfa !== 'off' && security.grace_until ? `<p class="form-note">${esc(uiText('Members it covers can use AMCP only after setting up two-step verification from {date}.', {date: date(security.grace_until)}))}</p>` : ''}${baselineNote}`
        : baselineNote;
    content.insertAdjacentHTML(
      'beforeend',
      `<section class="panel"><span class="eyebrow">${esc(uiText('PEOPLE & ACCESS'))}</span><h2>${esc(uiText('Workspace members'))}</h2><div class="team-list">${team.members.map(m => `<div class="identity-row"><div><strong dir="auto" data-native>${esc(m.name)}</strong><small>${esc(m.email ?? uiText('Social account'))}${m.mfa ? ' · ' + esc(uiText('Two-step on')) : ''}${m.access_set_id ? ' · ' + esc(uiText('Limited to {client}', {client: setName(m.access_set_id)})) : ''}</small></div>${owner && m.role !== 'owner' ? `<select aria-label="${esc(uiText('Role for {name}', {name: m.name}))}" data-member-role="${esc(m.id)}"><option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>${esc(uiText('Viewer'))}</option><option value="operator" ${m.role === 'operator' ? 'selected' : ''}>${esc(uiText('Operator'))}</option><option value="admin" ${m.role === 'admin' ? 'selected' : ''}>${esc(uiText('Admin'))}</option></select>${sets.length ? `<select aria-label="${esc(uiText('Client limit for {name}', {name: m.name}))}" data-member-set="${esc(m.id)}">${setOptions(m.access_set_id, uiText('No client limit'))}</select>` : ''}<button class="button small" data-member-save="${esc(m.id)}">${esc(uiText('Save role'))}</button>${resetButton(m)}<button class="button small danger" data-member-remove="${esc(m.id)}" data-member-name="${esc(m.name)}">${esc(uiText('Remove'))}</button>` : `<span class="status">${esc(uiRole(m.role))}</span>${resetButton(m)}`}</div>`).join('')}</div>${invitations ? `<h3>${esc(uiText('Pending invitations'))}</h3><div class="team-list" id="pending-invitations">${invitations}</div>` : ''}<form id="invite-member" class="workspace-form">${formField(uiText('Email address'), 'email', 'email', 'maxlength="254"')}<label>${esc(uiText('Role'))}<select name="role"><option value="viewer">${esc(uiText('Viewer · reports and reads'))}</option><option value="operator">${esc(uiText('Operator · reviewed campaign changes'))}</option>${owner ? `<option value="admin">${esc(uiText('Admin · connections and invitations'))}</option>` : ''}</select></label>${sets.length ? `<label>${esc(uiText('Limit to client'))}<select name="access_set_id">${setOptions(null, uiText('No client limit'))}</select></label>` : ''}<button class="button primary" ${options.emailEnabled ? '' : 'disabled'}>${esc(uiText('Send invitation'))}</button></form><p class="form-note">${esc(uiText('Invitations expire after {hours} hours. Withdraw one to cancel its link; send a new invitation if a link expires.', {hours: security.invitation_hours}))}</p>${policyForm}</section>`,
    );
    content.insertAdjacentHTML('beforeend', accessSetSection(sets));
    bindAccessSets(sets);
    authBind('#invite-member', async f => {
      const {access_set_id: limit, ...invitation} = Object.fromEntries(new FormData(f));
      const r = await api('/api/workspaces/invite', {
        method: 'POST',
        body: JSON.stringify({...invitation, ...(limit ? {access_set_id: limit} : {})}),
      });
      toast(
        r.expires_at
          ? uiText('A private invitation link is on its way. It expires {date}.', {date: date(r.expires_at)})
          : uiText(r.message),
      );
      f.reset();
      await renderAccountPage();
    });
    authBind('[data-invite-revoke]', async b => {
      await api('/api/workspaces/invitations/' + encodeURIComponent(b.dataset.inviteRevoke) + '/revoke', {
        method: 'POST',
        body: '{}',
      });
      toast(uiText('Invitation withdrawn. Its link no longer works.'));
      await renderAccountPage();
    });
    authBind('#workspace-security', async f => {
      const values = Object.fromEntries(new FormData(f));
      await api('/api/workspaces/security-policy', {
        method: 'POST',
        body: JSON.stringify({
          require_mfa: values.require_mfa,
          grace_days: Number(values.grace_days),
          invitation_hours: Number(values.invitation_hours),
        }),
      });
      toast(uiText('Security settings saved.'));
      await renderAccountPage();
    });
    authBind('[data-member-mfa-reset]', async b => {
      if (
        !(await confirmAction({
          title: uiText('Reset two-step verification for {name}?', {name: b.dataset.memberName}),
          consequence: uiText(
            'Use this only when they lost their authenticator and recovery codes. Their sessions, connector tokens and AI-client connections end, they are emailed, and they set up two-step verification again at their next sign-in.',
          ),
          confirmLabel: uiText('Reset two-step'),
        }))
      )
        return;
      await api('/api/owner/accounts/mfa-reset', {
        method: 'POST',
        body: JSON.stringify({user_id: b.dataset.memberMfaReset}),
      });
      toast(uiText('Two-step verification was reset.'));
      await renderAccountPage();
    });
    authBind('[data-member-save]', async b => {
      const role = document.querySelector('[data-member-role="' + CSS.escape(b.dataset.memberSave) + '"]').value,
        // The member's client limit (SEC-08): one set, or none for the whole workspace. Administrators have none.
        limit = document.querySelector('[data-member-set="' + CSS.escape(b.dataset.memberSave) + '"]');
      await api('/api/workspaces/member', {
        method: 'POST',
        body: JSON.stringify({
          userId: b.dataset.memberSave,
          role,
          ...(limit ? {access_set_id: role === 'admin' ? null : limit.value || null} : {}),
        }),
      });
      toast(uiText('Role saved.'));
      await renderAccountPage();
    });
    // Removal is its own action, confirmed, rather than a role in the list.
    authBind('[data-member-remove]', async b => {
      if (
        !(await confirmAction({
          title: uiText('Remove {name} from this workspace?', {name: b.dataset.memberName}),
          consequence: uiText(
            'Their browser sessions and connector access to this workspace end immediately. Their sign-in and other workspaces are not affected.',
          ),
          confirmLabel: uiText('Remove from workspace'),
        }))
      )
        return;
      await api('/api/workspaces/member', {
        method: 'POST',
        body: JSON.stringify({userId: b.dataset.memberRemove, role: 'remove'}),
      });
      toast(uiText('Member removed.'));
      await renderAccountPage();
    });
  }
  // Self-service deletion (SEC-07, owner decision P3): a personal account only, never a door or reviewer sign-in, and
  // not before a required two-step setup (the server refuses everything else until then).
  if (!account.administrator && !account.testAccount && !account.mfaEnrollmentRequired) accountDeletionPanel();
};
/** The platform name of a saved login's gateway, from the platforms the shell loaded. */
const deletionPlatformName = gateway => (platforms ?? []).find(p => p.gateway === gateway)?.name ?? gateway;
/**
 * "Delete your account" (SEC-07, owner decision P3): a preview of what goes, a typed confirmation, the consequence
 * dialog and "Confirm it's you" (the server asks for it), then the erasure receipt in place of the page.
 */
function accountDeletionPanel() {
  content.insertAdjacentHTML(
    'beforeend',
    `<section class="panel account-deletion-panel" id="account-deletion" aria-labelledby="account-deletion-heading"><span class="eyebrow">${esc(uiText('DELETE ACCOUNT'))}</span><h2 id="account-deletion-heading">${esc(uiText('Delete your account'))}</h2><p>${esc(uiText('Deleting your account erases it, your own workspace and everything that workspace holds: platform logins, reports, plans, files and settings. Your memberships in other workspaces end. This cannot be undone.'))}</p><button type="button" class="button danger" id="account-deletion-review">${esc(uiText('Review what will be deleted'))}</button><p id="account-deletion-error" class="error" role="alert"></p><div id="account-deletion-plan"></div></section>`,
  );
  const error = $('#account-deletion-error');
  $('#account-deletion-review').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    error.textContent = '';
    try {
      showAccountDeletionPlan(await api('/api/account/deletion'));
    } catch (e) {
      error.textContent = errorMessage(e);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
}
/** What a deletion removes, one line each, from the server's counts (the preview's or the receipt's). */
function accountDeletionItems(w = {}) {
  const n = value => uiNumber(Number(value) || 0);
  return [
    uiText('Your own workspace and its settings'),
    uiText('{count} platform logins', {count: n(w.platform_logins)}),
    uiText('{count} saved records, such as reports and plans', {count: n(w.saved_records)}),
    uiText('{count} files', {count: n(w.files)}),
    uiText('{count} connector keys and AI-client connections', {count: n(w.connector_keys)}),
    uiText('{count} memberships in other workspaces', {count: n(w.other_workspaces)}),
  ];
}
function showAccountDeletionPlan(plan) {
  const area = $('#account-deletion-plan'),
    error = $('#account-deletion-error'),
    names = (plan.platforms ?? []).map(deletionPlatformName);
  if (!plan.available) {
    area.innerHTML = `<p class="notice" id="account-deletion-refusal">${esc(plan.refusal?.message ? uiText(plan.refusal.message) : uiText('Your account cannot be deleted right now.'))}</p>`;
    return;
  }
  const items = accountDeletionItems(plan.will_delete);
  area.innerHTML = `<h3>${esc(uiText('What will be deleted'))}</h3><ul id="account-deletion-items">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>${names.length ? `<p class="form-note">${esc(uiText('AMCP does not contact your platforms. Afterwards, remove AMCP’s access in each of them: {platforms}.', {platforms: names.join(', ')}))}</p>` : ''}<p class="form-note">${esc(uiText('Older backups keep a copy until they expire. If one is ever restored, the operator applies your deletion to it again.'))}</p><form id="account-deletion-form" class="auth-form">${formField(plan.confirm_with === 'name' ? uiText('Type your account name to confirm') : uiText('Type your email address to confirm'), 'confirm', 'text', 'autocomplete="off" maxlength="254" spellcheck="false"')}<button class="button danger">${esc(uiText('Delete my account permanently'))}</button></form>`;
  $('#account-deletion-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter,
      confirm = new FormData(event.currentTarget).get('confirm');
    error.textContent = '';
    if (
      !(await confirmAction({
        title: uiText('Delete your account permanently?'),
        consequence: uiText(
          'Your account, your workspace and everything it holds are erased now. You are signed out everywhere. This cannot be undone.',
        ),
        confirmLabel: uiText('Delete permanently'),
      }))
    )
      return;
    button.disabled = true;
    try {
      const result = await api('/api/account/delete', {method: 'POST', body: JSON.stringify({confirm})});
      showAccountDeletionReceipt(result, (result.platforms ?? []).map(deletionPlatformName));
    } catch (e) {
      error.textContent = errorMessage(e);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
}
/** After the erasure: this tab forgets the person, and the receipt replaces the page. */
function showAccountDeletionReceipt(result, names) {
  const receipt = result.receipt ?? {},
    platformsNote = names.length
      ? uiText('AMCP does not contact your platforms. Remove AMCP’s access in each of them: {platforms}.', {
          platforms: names.join(', '),
        })
      : '',
    // The downloadable copy: the erasure's random id and UTC time, what went, and where to remove AMCP's access.
    lines = [
      uiText('AMCP account deletion receipt'),
      uiText('Erasure receipt {id}, {time}.', {
        id: receipt.erasure_id,
        time: new Date(Number(receipt.erased_at)).toISOString(),
      }),
      uiText('What was deleted'),
      ...accountDeletionItems(receipt.deleted).map(item => '- ' + item),
      ...(platformsNote ? [platformsNote] : []),
    ];
  resetPrivateState();
  session = {authenticated: false, csrf: null};
  shellLinks();
  content.innerHTML = `<section class="panel account-deletion-receipt" id="account-deletion-receipt"><span class="eyebrow">${esc(uiText('DELETE ACCOUNT'))}</span><h1 tabindex="-1">${esc(uiText('Your account was deleted'))}</h1><p>${esc(uiText('Your account, your workspace and everything it held were erased from AMCP. Keep this receipt if you may need to show the deletion later.'))}</p><p>${esc(uiText('Erasure receipt {id}, {time}.', {id: receipt.erasure_id, time: date(receipt.erased_at)}))}</p>${platformsNote ? `<p>${esc(platformsNote)}</p>` : ''}<div class="dialog-actions"><button type="button" class="button" id="account-deletion-download">${esc(uiText('Download receipt'))}</button><a class="button primary" href="/">${esc(uiText('Back to home'))}</a></div></section>`;
  $('#account-deletion-download').addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], {type: 'text/plain'}));
    link.download = 'AMCP-deletion-receipt.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  content.querySelector('h1').focus();
}
/**
 * Client access sets (SEC-08 phase 2, owner direction P1): an administrator names the accounts of one client, then
 * limits a member (above), a connector token or an AI client (AI connectors page) to them. Unlike the working client in
 * the top bar, a set is access control: limited access reaches nothing else, and a removed set reaches nothing.
 */
function accessSetAccounts() {
  return platforms.flatMap(p =>
    (p.connections ?? [])
      .filter(c => c.enabled)
      .flatMap(c =>
        c.accounts.map(account => ({
          gateway: p.gateway,
          connection_id: c.id,
          account_id: account,
          label: p.name + ' · ' + accountText(p, c, account),
        })),
      ),
  );
}
function accessSetSection(sets, editing = null) {
  const accounts = accessSetAccounts(),
    bound = new Set((editing?.bindings ?? []).map(b => JSON.stringify([b.gateway, b.connection_id, b.account_id])));
  return `<section class="panel" id="access-sets"><span class="eyebrow">${esc(uiText('CLIENT ACCESS'))}</span><h2>${esc(uiText('Client access sets'))}</h2><p>${esc(uiText('Name the accounts of one client, then limit a member, connector token or AI client to them. Limited access reaches no other account. The working client in the top bar is only a view filter.'))}</p><div class="team-list">${
    sets
      .map(
        s =>
          `<div class="identity-row"><div><strong dir="auto" data-native>${esc(s.name)}</strong><small>${esc(uiText('{count} accounts', {count: (s.bindings ?? []).length}))}${s.in_use ? ' · ' + esc(uiText('{members} members and {credentials} tokens or AI clients limited to it', {members: s.in_use.members, credentials: s.in_use.credentials})) : ''}</small></div><button class="button small" data-access-set-edit="${esc(s.id)}">${esc(uiText('Edit'))}</button><button class="button small danger" data-access-set-remove="${esc(s.id)}">${esc(uiText('Remove'))}</button></div>`,
      )
      .join('') || `<div class="empty">${esc(uiText('No client access sets yet.'))}</div>`
  }</div><form id="access-set-form" class="workspace-form"><h3>${esc(editing ? uiText('Edit {client}', {client: editing.name}) : uiText('New client access set'))}</h3>${editing ? `<input type="hidden" name="id" value="${esc(editing.id)}"><input type="hidden" name="revision" value="${esc(editing.revision)}">` : ''}<label>${esc(uiText('Client name'))}<input name="name" maxlength="80" required value="${esc(editing?.name ?? '')}"></label><fieldset class="access-set-accounts"><legend>${esc(uiText('Accounts of this client'))}</legend>${
    accounts
      .map((a, i) => {
        const key = JSON.stringify([a.gateway, a.connection_id, a.account_id]);
        return `<label class="check"><input type="checkbox" name="account" value="${i}" ${bound.has(key) ? 'checked' : ''}> <bdi dir="auto">${esc(a.label)}</bdi></label>`;
      })
      .join('') || `<p class="form-note">${esc(uiText('Connect and select accounts first.'))}</p>`
  }</fieldset><button class="button primary">${esc(editing ? uiText('Save client access set') : uiText('Create client access set'))}</button>${editing ? ` <button class="button" type="button" data-access-set-cancel>${esc(uiText('Cancel'))}</button>` : ''}</form></section>`;
}
function bindAccessSets(sets) {
  const redraw = editing => {
    $('#access-sets').outerHTML = accessSetSection(sets, editing);
    bindAccessSets(sets);
  };
  authBind('[data-access-set-edit]', b => redraw(sets.find(s => s.id === b.dataset.accessSetEdit) ?? null));
  authBind('[data-access-set-cancel]', () => redraw(null));
  authBind('#access-set-form', async f => {
    const accounts = accessSetAccounts(),
      values = new FormData(f),
      bindings = values.getAll('account').map(i => {
        const {gateway, connection_id, account_id} = accounts[Number(i)];
        return {gateway, connection_id, account_id};
      });
    if (!bindings.length) throw Error(uiText('Choose at least one account for this client.'));
    await api('/api/access-sets', {
      method: 'POST',
      body: JSON.stringify({
        name: String(values.get('name') ?? '').trim(),
        bindings,
        ...(values.get('id') ? {id: values.get('id'), revision: Number(values.get('revision'))} : {}),
      }),
    });
    toast(uiText('Client access set saved. Limited access follows it from the next request.'));
    await renderAccountPage();
  });
  authBind('[data-access-set-remove]', async b => {
    const set = sets.find(s => s.id === b.dataset.accessSetRemove);
    if (!set) return;
    if (
      !(await confirmAction({
        title: uiText('Remove the client access set {client}?', {client: set.name}),
        consequence: uiText(
          'Members, connector tokens and AI clients limited to it then reach no account until an administrator gives them access again.',
        ),
        confirmLabel: uiText('Remove client access set'),
      }))
    )
      return;
    await api('/api/access-sets/' + encodeURIComponent(set.id), {
      method: 'DELETE',
      body: JSON.stringify({confirmed: true, revision: set.revision}),
    });
    toast(uiText('Client access set removed.'));
    await renderAccountPage();
  });
}
// Reviewer sign-in. Same shape as the administrator door, a different destination.
document.addEventListener('click', event => {
  if (!event.target.closest('[data-open-test]')) return;
  $('#test-dialog').showModal();
  $('#test-password').focus();
});
$('#test-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $('#test-error').textContent = '';
  try {
    await api('/api/session/test', {method: 'POST', body: JSON.stringify({password: $('#test-password').value})});
    $('#test-password').value = '';
    $('#test-dialog').close();
    await signInComplete();
  } catch (e) {
    $('#test-error').textContent = errorMessage(e);
  } finally {
    button.disabled = false;
  }
});
