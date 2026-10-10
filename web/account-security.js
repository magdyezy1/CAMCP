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
    content.insertAdjacentHTML(
      'beforeend',
      `<section class="panel account-security-panel"><div class="panel-header"><div><span class="eyebrow">${esc(uiText('ANOTHER LAYER OF SECURITY'))}</span><h2>${esc(uiText('Two-step authentication'))}</h2></div><span class="status ${account.mfaEnabled ? 'online' : ''}">${account.mfaEnabled ? uiText('Enabled') : uiText('Available')}</span></div><p>${esc(uiText('Use an authenticator app and keep recovery codes somewhere safe. Enabling or disabling this protection revokes existing sessions and MCP access.'))}</p><div id="mfa-setup">${account.mfaEnabled ? `<form id="mfa-disable" class="auth-form">${formField(uiText('Authenticator or recovery code'), 'code', 'text', 'maxlength="32" autocomplete="one-time-code"')}<button class="button">${esc(uiText('Disable two-step authentication'))}</button></form>` : `<button id="mfa-start" class="button primary">${esc(uiText('Set up authenticator'))}</button>`}</div></section>`,
    );
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
        const codes = result.recoveryCodes.join('\n');
        $('#mfa-setup').innerHTML =
          `<div class="notice" role="alert"><strong>${esc(uiText('Save these recovery codes now.'))}</strong> ${esc(uiText('Each code works once, if you lose your authenticator. They will not be shown again.'))}</div><pre class="recovery-key">${result.recoveryCodes.map(esc).join('\n')}</pre><div class="report-actions"><button type="button" class="button" id="mfa-copy-codes">${esc(uiText('Copy codes'))}</button><button type="button" class="button" id="mfa-download-codes">${esc(uiText('Download as a text file'))}</button><a class="button primary" href="/account">${esc(uiText('I’ve saved my codes'))}</a></div>`;
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
  if (['owner', 'admin'].includes(account.workspaceRole)) {
    const team = await api('/api/workspaces/members');
    content.insertAdjacentHTML(
      'beforeend',
      `<section class="panel"><span class="eyebrow">${esc(uiText('PEOPLE & ACCESS'))}</span><h2>${esc(uiText('Workspace members'))}</h2><div class="team-list">${team.members.map(m => `<div class="identity-row"><div><strong dir="auto" data-native>${esc(m.name)}</strong><small>${esc(m.email ?? uiText('Social account'))}</small></div>${account.workspaceRole === 'owner' && m.role !== 'owner' ? `<select aria-label="${esc(uiText('Role for {name}', {name: m.name}))}" data-member-role="${esc(m.id)}"><option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>${esc(uiText('Viewer'))}</option><option value="operator" ${m.role === 'operator' ? 'selected' : ''}>${esc(uiText('Operator'))}</option><option value="admin" ${m.role === 'admin' ? 'selected' : ''}>${esc(uiText('Admin'))}</option></select><button class="button small" data-member-save="${esc(m.id)}">${esc(uiText('Save role'))}</button><button class="button small danger" data-member-remove="${esc(m.id)}" data-member-name="${esc(m.name)}">${esc(uiText('Remove'))}</button>` : `<span class="status">${esc(uiRole(m.role))}</span>`}</div>`).join('')}</div><form id="invite-member" class="workspace-form">${formField(uiText('Email address'), 'email', 'email', 'maxlength="254"')}<label>${esc(uiText('Role'))}<select name="role"><option value="viewer">${esc(uiText('Viewer · reports and reads'))}</option><option value="operator">${esc(uiText('Operator · reviewed campaign changes'))}</option>${account.workspaceRole === 'owner' ? `<option value="admin">${esc(uiText('Admin · connections and invitations'))}</option>` : ''}</select></label><button class="button primary" ${options.emailEnabled ? '' : 'disabled'}>${esc(uiText('Send invitation'))}</button></form><p class="form-note">${esc(uiText('Invitations expire in 30 minutes. Send another invitation if a link expires.'))}</p></section>`,
    );
    authBind('#invite-member', async f => {
      const r = await api('/api/workspaces/invite', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(f))),
      });
      toast(uiText(r.message));
      f.reset();
    });
    authBind('[data-member-save]', async b => {
      const role = document.querySelector('[data-member-role="' + CSS.escape(b.dataset.memberSave) + '"]').value;
      await api('/api/workspaces/member', {method: 'POST', body: JSON.stringify({userId: b.dataset.memberSave, role})});
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
};
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
