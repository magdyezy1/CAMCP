'use strict';
const glyphPaths = {
  overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  campaign: 'M4 10v5h4l11 4V5L8 10H4 M8 15l2 6 M21 9v6',
  media: 'M4 3h16v18H4z M4 16l5-5 4 4 3-3 4 4 M15 7h.01',
  report: 'M4 3v18h17 M8 16v-5 M13 16V7 M18 16V4',
  profile: 'M4 4h16v16H4z M9 9a3 3 0 1 0 6 0a3 3 0 1 0-6 0 M7 19v-2a5 5 0 0 1 10 0v2',
  connection: 'M9 15l6-6 M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0 M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
  connector: 'm8 5-6 7 6 7 M16 5l6 7-6 7 M14 3l-4 18',
  activity: 'M2 12h4l3-8 6 16 3-8h4',
  settings:
    'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
  arrow: 'M4 12h16 M14 6l6 6-6 6',
  check: 'm5 12 4 4L19 6',
  lock: 'M6 10h12v11H6z M8 10V6a4 4 0 0 1 8 0v4',
  spark: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z',
};
function glyph(name, cls = '') {
  return `<svg class="glyph ${cls}" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${glyphPaths[name] ?? glyphPaths.spark}"/></svg>`;
}
document.querySelectorAll('[data-icon]').forEach(el => {
  el.querySelector('span').innerHTML = glyph(el.dataset.icon);
});
/** A public file's address in this page's asset snapshot, as the server binds the HTML (WEB-04). */
function publicAssetUrl(path) {
  return typeof AMCPAssets === 'object' ? AMCPAssets.url(path) : path;
}
const brandLink = () =>
  `<a class="brand" href="/"><img src="${publicAssetUrl('/assets/mark.svg')}" width="38" height="38" alt=""><span>${esc(uiText('AMCP'))}</span></a>`;
const publicNavigation = (registration = false) =>
  `<header class="public-nav">${brandLink()}${languageControl()}<nav aria-label="${esc(uiText('Website navigation'))}"><a href="/about">${esc(uiText('About us'))}</a><a href="/#possibilities">${esc(uiText('The workspace'))}</a><a href="/#how-it-works">${esc(uiText('How it works'))}</a><a href="/connectors">${esc(uiText('For your AI tools ↗'))}</a></nav><div class="public-nav-actions">${session.authenticated ? `<a class="button primary" href="/dashboard">${esc(uiText('Open workspace ↗'))}</a>` : registration ? `<a class="text-link" href="/login">${esc(uiText('Sign in'))}</a><a class="button primary" href="/signup">${esc(uiText('Get started ↗'))}</a>` : `<a class="button primary" href="/login">${esc(uiText('Sign in'))}</a>`}</div></header>`;
/**
 * Whether a new person can finish signing up on this deployment. Older servers lack registrationAvailable, so it is
 * derived the same way: registration open and at least one method (email or a configured social sign-in) works.
 */
function registrationOpen(options) {
  return (
    options?.registrationAvailable ??
    !!(options?.signupEnabled && (options.emailEnabled || options.providers?.some(p => p.configured)))
  );
}
/** The public calls to action follow the server: when sign-up cannot complete they offer sign-in instead (WEB-02). */
async function publicRegistrationOpen() {
  if (session.authenticated) return false;
  try {
    return registrationOpen(await api('/api/account/options'));
  } catch (e) {
    if (e?.code === 'REQUEST_SUPERSEDED') throw e;
    return false;
  }
}
async function renderLanding() {
  const registration = await publicRegistrationOpen(),
    start = session.authenticated ? '/dashboard' : registration ? '/signup' : '/login';
  content.innerHTML = `<div class="landing">${publicNavigation(registration)}<section class="landing-hero"><div class="hero-copy"><span class="eyebrow"><span class="live-dot"></span> ${esc(uiText('THE ADVERTISING WORKSPACE, RECONSIDERED'))}</span><h1>${esc(uiText('Big ideas.'))}<br>${esc(uiText('Less busywork.'))}<br><span>${esc(uiText('Your next move.'))}</span></h1><p>${esc(uiText('Bring your accounts, creative, and AI tools into one considered space. From the first brief to the final review, make every move with clarity.'))}</p><div class="hero-actions"><a class="button primary large" href="${start}">${esc(session.authenticated ? uiText('Open your workspace') : registration ? uiText('Make yourself at home') : uiText('Sign in to your workspace'))} ${glyph('arrow')}</a><a class="text-link" href="/#how-it-works">${esc(uiText('Take a closer look'))} <span>↓</span></a></div>${session.authenticated || registration ? '' : `<p class="hero-access">${esc(uiText('New to AMCP? Ask your workspace owner for access.'))}</p>`}<div class="hero-note">${glyph('lock')} ${esc(uiText('Your accounts. Your approvals. Your control.'))}</div></div><div class="hero-stage" role="img" aria-label="${esc(uiText('Illustration of the AMCP campaign workflow: bring the brief, connect the accounts and creative, then review every change before it runs.'))}"><div class="stage-caption"><span class="orbit-dot"></span> ${esc(uiText('ONE WORKSPACE. A LITTLE MORE POSSIBLE.'))}</div><div class="stage-orbits" aria-hidden="true"><div class="stage-orbit orbit-one"></div><div class="stage-orbit orbit-two"></div></div><div class="floating-chip chip-one"><span class="chip-icon peach">${glyph('media')}</span><div>${esc(uiText('Creative, connected'))}<small>${esc(uiText('Drive → your ad platforms'))}</small></div></div><div class="stage-window"><div class="stage-window-top"><div class="window-dots"><i></i><i></i><i></i></div><span>${esc(uiText('YOUR NEXT CAMPAIGN'))}</span><span>↗</span></div><div class="stage-window-body"><div class="stage-label">${esc(uiText('FROM IDEA TO ACTION'))}</div><h2>${esc(uiText('A clearer path'))}<br>${esc(uiText('from here to live.'))}</h2><div class="stage-flow"><div><span>01</span><p>${esc(uiText('Bring the brief'))}<small>${esc(uiText('Goals, audience, and creative'))}</small></p>${glyph('campaign')}</div><div><span>02</span><p>${esc(uiText('Connect the pieces'))}<small>${esc(uiText('The right accounts and assets'))}</small></p>${glyph('connection')}</div><div class="flow-emphasis"><span>03</span><p>${esc(uiText('Make it intentional'))}<small>${esc(uiText('Review every change before it runs'))}</small></p>${glyph('check')}</div></div><div class="stage-window-bottom"><span>${esc(uiText('WORKFLOW PREVIEW'))}</span><span class="pill-dot">${esc(uiText('Human approved'))}</span></div></div></div><div class="floating-chip chip-two"><img src="${publicAssetUrl('/assets/mark.svg')}" width="34" height="34" alt=""><div>${esc(uiText('One context. More possibility.'))}<small>${esc(uiText('Connected to your favorite AI tools'))}</small></div><span>✳</span></div><div class="stage-spark" aria-hidden="true">✳</div></div></section><section class="platform-ribbon" aria-label="${esc(uiText('Supported connections'))}"><span>${esc(uiText('MAKE SPACE FOR YOUR'))}<br>${esc(uiText('EXISTING STACK'))}</span><div>${esc(uiText('Google Ads'))}</div><div>${esc(uiText('Meta'))}</div><div>${esc(uiText('TikTok'))}</div><div>${esc(uiText('Snapchat'))}</div><div>${esc(uiText('LinkedIn'))}</div><div>${esc(uiText('Microsoft Ads'))}</div><div>${esc(uiText('+ more'))}</div></section><section class="possibilities" id="possibilities"><div class="section-heading"><div><span class="eyebrow">${esc(uiText('LESS SWITCHING. MORE DOING.'))}</span><h2>${esc(uiText('A place for everything'))}<br>${esc(uiText('that moves you forward.'))}</h2></div><p>${esc(uiText('The details stay connected, so you can stay focused on what comes next.'))}</p></div><div class="feature-bento"><article class="feature-card feature-wide"><div class="feature-icon">${glyph('campaign')}</div><span class="feature-index">${esc(uiText('01 / CAMPAIGNS'))}</span><h3>${esc(uiText('Give your next idea'))}<br>${esc(uiText('a thoughtful start.'))}</h3><p>${esc(uiText('Build a plan, connect its dependencies, and review the next step. Pick up where you left off.'))}</p><div class="mini-plan" role="img" aria-label="${esc(uiText('An example campaign plan: brief and objectives first, then accounts and creative, then review and execute.'))}"><span class="mini-plan-label">${esc(uiText('YOUR CAMPAIGN PLAN'))}</span><div><i></i><span>${esc(uiText('Brief & objectives'))}</span><b>${esc(uiText('Start here'))}</b></div><div><i></i><span>${esc(uiText('Accounts & creative'))}</span><span>02</span></div><div><i></i><span>${esc(uiText('Review & execute'))}</span><span>03</span></div></div><a href="/campaigns" class="text-link">${esc(uiText('Explore campaign planning ↗'))}</a></article><article class="feature-card feature-creative"><div class="feature-icon">${glyph('media')}</div><span class="feature-index">${esc(uiText('02 / CREATIVE'))}</span><h3>${esc(uiText('Your creative.'))}<br>${esc(uiText('In its best format.'))}</h3><p>${esc(uiText('Import from Drive, preview a crop, and transfer it to a selected account. Your AI tool never needs to download the file.'))}</p><div class="creative-frames" aria-hidden="true"><div class="frame-square"><span>1:1</span><i></i></div><div class="frame-story"><span>9:16</span><i></i></div><span class="frame-spark">✳</span></div></article><article class="feature-card feature-ai"><div class="feature-icon">${glyph('connector')}</div><span class="feature-index">${esc(uiText('03 / AI TOOLS'))}</span><h3>${esc(uiText('Your workspace,'))}<br>${esc(uiText('where you think.'))}</h3><p>${esc(uiText('Bring selected account context into Codex, Claude, Cursor, and compatible MCP clients.'))}</p><div class="client-cloud"><span>${esc(uiText('Codex'))}</span><span>${esc(uiText('Claude'))}</span><span>${esc(uiText('Cursor'))}</span><b aria-hidden="true">↗</b></div><a href="/connectors" class="text-link">${esc(uiText('Connect your tools ↗'))}</a></article><article class="feature-card feature-reports"><div class="feature-icon">${glyph('report')}</div><span class="feature-index">${esc(uiText('04 / CLARITY'))}</span><h3>${esc(uiText('Know what’s behind'))}<br>${esc(uiText('every number.'))}</h3><p>${esc(uiText('Trace reports to their source, reconcile totals, and review recommendations with their supporting evidence.'))}</p><div class="evidence-tags"><span>${esc(uiText('Source linked'))}</span><span>${esc(uiText('Freshness checked'))}</span><span>${esc(uiText('Reviewable'))}</span></div></article></div></section><section class="how-section" id="how-it-works"><div><span class="eyebrow">${esc(uiText('FROM HELLO TO YOUR NEXT MOVE'))}</span><h2>${esc(uiText('Settle in.'))}<br>${esc(uiText('Then get moving.'))}</h2><a href="${start}" class="button dark large">${esc(session.authenticated || registration ? uiText("Let's get you started") : uiText('Sign in to your workspace'))} ${glyph('arrow')}</a></div><ol class="how-steps"><li><span>01</span><div><h3>${esc(uiText('A space of your own'))}</h3><p>${esc(uiText('Create your account and personalize your workspace.'))}</p></div></li><li><span>02</span><div><h3>${esc(uiText('Connect what matters'))}</h3><p>${esc(uiText('Choose your platform logins and the accounts AMCP can access.'))}</p></div></li><li><span>03</span><div><h3>${esc(uiText('Make your next move'))}</h3><p>${esc(uiText('Bring in your AI tool, build a plan, and review changes before execution.'))}</p></div></li></ol></section><section class="closing-note"><span>✳</span><h2>${esc(uiText('More possibility.'))}<br>${esc(uiText('A little less friction.'))}</h2><a class="button primary large" href="${start}">${esc(session.authenticated ? uiText('Back to your workspace') : registration ? uiText('Create your AMCP account') : uiText('Sign in to your workspace'))} ↗</a></section><footer class="public-footer">${brandLink()}<span>${esc(uiText('Made for your next move.'))}</span><div><a href="/about">${esc(uiText('About us'))}</a><a href="/privacy?lang=${uiLocale}">${esc(uiText('Privacy'))}</a><a href="/terms?lang=${uiLocale}">${esc(uiText('Terms'))}</a><a href="/data-deletion?lang=${uiLocale}">${esc(uiText('Your data'))}</a></div></footer></div>`;
  // An explicit smooth scroll animates regardless of the CSS reduced-motion reset, so honour the preference here.
  if (location.hash)
    requestAnimationFrame(() =>
      document.getElementById(location.hash.slice(1))?.scrollIntoView({behavior: landingScrollBehavior()}),
    );
}
function landingScrollBehavior() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
let authOptions, verificationLink;
const authErrors = {
  ACCOUNT_EXISTS:
    'An AMCP account already uses this email. Sign in using its existing method, then link your social account from Account settings.',
  SIGNIN_CANCELLED: 'You cancelled sign-in. Choose a sign-in method whenever you’re ready.',
  SIGNIN_STATE_INVALID: 'Please finish sign-in in the browser where you started it, or begin again below.',
  IDENTITY_ALREADY_LINKED: 'That social account is already connected to another AMCP account.',
  SIGNIN_IDENTITY_MISMATCH: 'That is not the sign-in linked to your AMCP account. Try again with the linked account.',
  SIGNUP_DISABLED: 'Registration is currently closed. Existing members can still sign in.',
  SIGNIN_SETUP_REQUIRED: 'This sign-in provider needs configuration. Choose another available method.',
  SIGNIN_FAILED: 'Sign-in could not be completed. Please try again.',
};
/** Sign-in returns only to a workspace page in the route registry (WEB-06); anything else opens Home. */
function safeReturn(path) {
  return routeReturnable(path) ? path : '/dashboard';
}
function afterSignIn() {
  const path = safeReturn(sessionStorage.getItem('amcp.return'));
  sessionStorage.removeItem('amcp.return');
  navigate(path);
}
/** A selector that finds the same control after a re-render: its id, or its tag and data attributes. */
function focusKey(el) {
  if (!el || el === document.body) return null;
  if (el.id) return '#' + CSS.escape(el.id);
  const data = [...el.attributes]
    .filter(a => a.name.startsWith('data-'))
    .map(a => '[' + a.name + '="' + CSS.escape(a.value) + '"]')
    .join('');
  return data ? el.tagName.toLowerCase() + data : null;
}
/** Selectors of the control's enclosing elements that have an id, innermost first. */
function focusScopes(el) {
  const out = [];
  for (let e = el?.parentElement; e && e !== document.body; e = e.parentElement)
    if (e.id) out.push('#' + CSS.escape(e.id));
  return out;
}
/**
 * After an action, keeps keyboard focus on its control; when the control is gone, on the first control of its
 * nearest surviving section; otherwise on the page heading. Never on the body.
 */
function restoreFocus(key, scopes = []) {
  const active = document.activeElement,
    dialog = active?.closest?.('dialog');
  if (active && active !== document.body && active.isConnected && (!dialog || dialog.open)) return;
  const next = key && document.querySelector(key);
  if (next && !next.disabled) {
    next.focus({preventScroll: true});
    return;
  }
  for (const scope of scopes) {
    const area = document.querySelector(scope);
    if (!area) continue;
    const control = area.querySelector(
      'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled])',
    );
    if (control) {
      control.focus({preventScroll: true});
      return;
    }
  }
  const heading = document.querySelector('#content h1') ?? document.querySelector('#content h2');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({preventScroll: true});
  }
}
function authBind(selector, fn) {
  document.querySelectorAll(selector).forEach(el =>
    el.addEventListener(el.tagName === 'FORM' ? 'submit' : 'click', async e => {
      e.preventDefault();
      const button = el.tagName === 'FORM' ? e.submitter : el;
      const generation = navigationGeneration;
      const key = focusKey(button) ?? (el.tagName === 'FORM' && el.id ? '#' + CSS.escape(el.id) + ' button' : null),
        scopes = focusScopes(button);
      const error = $('#auth-error');
      if (error) error.textContent = '';
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      try {
        await fn(el, e);
      } catch (err) {
        if (generation === navigationGeneration) {
          if (error) error.textContent = errorMessage(err);
          else toast(errorMessage(err));
        }
      } finally {
        if (button.isConnected) {
          button.disabled = false;
          button.removeAttribute('aria-busy');
        }
        if (generation === navigationGeneration) restoreFocus(key, scopes);
      }
    }),
  );
}
async function renderAccountPage() {
  if (!session.authenticated) {
    showLogin();
    return;
  }
  const [account, options, list] = await Promise.all([
    api('/api/account'),
    api('/api/account/options'),
    api('/api/account/sessions'),
  ]);
  authOptions = options;
  content.innerHTML =
    header(uiText('Make it yours.'), uiText('Your profile, your sign-in methods, and the sessions you control.')) +
    `<div class="account-hero"><div class="account-monogram" aria-hidden="true">${esc(account.name[0].toUpperCase())}</div><div><span class="eyebrow">${esc(uiText('YOUR AMCP ACCOUNT'))}</span><h2 dir="auto" data-native>${esc(account.name)}</h2><p>${esc(account.email ?? (account.administrator ? uiText('Deployment administrator') : uiText('No verified recovery email yet')))}</p></div><span class="status online">${esc(uiText('Private workspace'))}</span></div><div id="auth-error" class="error" role="alert"></div>${
      account.administrator
        ? `<section class="panel"><h2>${esc(uiText('Your original workspace'))}</h2><p>${esc(uiText('This account uses the deployment administrator password, which has no two-step verification. Use the owner setup below to move this workspace to an email account that can have it; everything in the workspace stays.'))}</p><a class="button" href="/settings">${esc(uiText('Deployment settings'))}</a></section>`
        : `<div class="account-columns"><section class="panel"><div class="panel-header"><h2>${esc(uiText('The essentials'))}</h2>${glyph('profile')}</div><form id="profile-form" class="auth-form">${formField(uiText('Your name'), 'name', 'text', `value="${esc(account.name)}" maxlength="80" autocomplete="name"`)}${formField(uiText('Workspace name'), 'workspaceName', 'text', `value="${esc(account.workspaceName)}" maxlength="80"`)}<button class="button primary">${esc(uiText('Save changes'))}</button></form></section><section class="panel"><div class="panel-header"><h2>${esc(uiText('Your sign-in methods'))}</h2>${glyph('lock')}</div><p class="muted">${esc(uiText('Link accounts while signed in. AMCP never merges accounts just because their emails match.'))}</p>${options.providers
            .filter(p => p.configured || account.identities.some(i => i.provider === p.id))
            .map(p => {
              const linked = account.identities.some(i => i.provider === p.id);
              return `<div class="identity-row"><span class="social-icon ${p.id}">${p.id === 'google' ? 'G' : p.id === 'apple' ? '●' : 'f'}</span><div><strong>${p.name}</strong><small>${linked ? uiText('Connected to your account') : p.configured ? uiText('Available to connect') : uiText('Not configured on this site')}</small></div><button class="button small ${linked ? '' : 'primary'}" data-${linked ? 'unlink' : 'link'}-social="${p.id}" ${!linked && !p.configured ? 'disabled' : ''}>${linked ? uiText('Remove') : uiText('Connect')}</button></div>`;
            })
            .join(
              '',
            )}</section><section class="panel"><h2>${esc(uiText('Recovery email'))}</h2><p class="muted">${account.email ? uiMarkup('Your current verified address is {email}.', {email: uiBidi(account.email, 'ltr')}) : esc(uiText('Add and verify an email to enable password sign-in and account recovery.'))}</p><form id="account-email" class="auth-form">${formField(uiText('Email address'), 'email', 'email', 'autocomplete="email" maxlength="254"')}<button class="button" ${options.emailEnabled ? '' : 'disabled'}>${esc(uiText('Send verification link'))}</button></form></section><section class="panel"><h2>${account.hasPassword ? uiText('Update your password') : uiText('Add a password')}</h2><p class="muted">${esc(uiText('Changing your password revokes existing sessions and MCP access. You’ll stay signed in here.'))}</p><form id="account-password" class="auth-form">${account.hasPassword ? formField(uiText('Current password'), 'currentPassword', 'password', 'autocomplete="current-password"') : ''}${formField(uiText('New password'), 'password', 'password', 'minlength="15" maxlength="128" autocomplete="new-password"')}<button class="button" ${account.email ? '' : 'disabled'}>${account.hasPassword ? uiText('Update password') : uiText('Set password')}</button></form></section></div>`
    }<section class="panel"><div class="panel-header"><div><h2>${esc(uiText('Where you’re signed in'))}</h2><p class="muted">${esc(uiText('End a session to remove its browser access immediately.'))}</p></div>${glyph('overview')}</div>${list.sessions.map(s => `<div class="identity-row"><span class="session-icon">${glyph('overview')}</span><div><strong>${s.current ? uiText('This browser') : uiText('Browser session')}</strong><small>${esc(uiText('Signed in'))} ${esc(uiDateZoned(s.signedInAt))} ${esc(uiText('· Expires'))} ${esc(uiDateZoned(s.expiresAt))}</small></div><button class="button small" data-end-session="${s.id}" data-current="${s.current}">${s.current ? uiText('Sign out') : uiText('End session')}</button></div>`).join('')}</section>`;
  authBind('#profile-form', async f => {
    await api('/api/account/profile', {method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(f)))});
    session = await api('/api/session');
    await render();
    toast(uiText('Your workspace feels a little more you. Changes saved.'));
  });
  authBind('[data-link-social]', async b => {
    const r = await api('/api/signin/' + b.dataset.linkSocial + '/start', {
      method: 'POST',
      body: JSON.stringify({link: true}),
    });
    location.assign(r.url);
  });
  authBind('[data-unlink-social]', async b => {
    if (
      !(await confirmAction({
        title: uiText('Remove this sign-in method?'),
        consequence: uiText(
          'You will no longer be able to sign in with it. Your other sign-in methods and your workspace stay as they are.',
        ),
        confirmLabel: uiText('Remove'),
      }))
    )
      return;
    await api('/api/account/identities/' + b.dataset.unlinkSocial, {method: 'DELETE'});
    await renderAccountPage();
    toast(uiText('Sign-in method removed.'));
  });
  authBind('#account-email', async f => {
    const r = await api('/api/account/email', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(new FormData(f))),
    });
    toast(uiText(r.message));
    f.reset();
  });
  authBind('#account-password', async f => {
    await api('/api/account/password', {method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(f)))});
    session = await api('/api/session');
    await renderAccountPage();
    toast(uiText('Password updated. Other sessions and MCP access were revoked.'));
  });
  authBind('[data-end-session]', async b => {
    await api('/api/account/sessions/' + b.dataset.endSession, {method: 'DELETE'});
    if (b.dataset.current === 'true') {
      session = await api('/api/session');
      navigate('/login');
    } else await renderAccountPage();
  });
  // Parts registered for the account page (WEB-07), given its account.
  await AMCP.routes.renderParts('/account', account);
}
const menuMatch = matchMedia('(max-width:850px)');
function closeNavigation() {
  document.querySelector('.main-shell').inert = false;
  document.body.classList.remove('menu-open');
  $('#menu-toggle').setAttribute('aria-expanded', 'false');
  $('#workspace-sidebar').inert = menuMatch.matches;
}
menuMatch.addEventListener('change', closeNavigation);
closeNavigation();
// The palette lists the route registry's pages (WEB-06): each is found by its navigation name, its former names and
// their translations, best match first, and a test account sees only the pages its workspace includes.
// WEB-08: beside the pages, the workspace owner reaches the emergency stop in one step. The entry only opens the
// control (pausing still asks first) and is listed only for the owner role, whose Settings page renders that control.
const ownerCommands = [
  {
    path: '/settings#owner-write-pause',
    label: 'Pause all writes',
    description: 'Opens the owner emergency stop; pausing asks first',
  },
];
function commandResults() {
  const query = $('#command-query').value,
    q = String(query ?? '')
      .trim()
      .toLowerCase(),
    commands =
      session.workspaceRole === 'owner'
        ? ownerCommands.filter(command =>
            [command.label, command.description, uiText(command.label), uiText(command.description)]
              .join(' ')
              .toLowerCase()
              .includes(q),
          )
        : [];
  const searchable = commandSearchable(String(query ?? '').trim()),
    pages = [...routeMatches(query, text => uiText(text)), ...commands]
      .map(
        page =>
          `<button data-command-go="${esc(page.path)}"><span><strong>${esc(uiText(page.label))}</strong><small>${esc(uiText(page.description))}</small></span><span aria-hidden="true">→</span></button>`,
      )
      .join('');
  $('#command-results').innerHTML =
    (pages ||
      (searchable ? '' : `<p class="empty">${esc(uiText('No pages match. Try “media” or “connections”.'))}</p>`)) +
    // WEB-09: the workspace's own entities follow the pages; commandEntitySearch fills them in.
    (searchable
      ? `<section class="command-entities" aria-labelledby="command-entities-heading"><h3 id="command-entities-heading" class="form-note">${esc(uiText('In this workspace'))}</h3><div id="command-entities" role="status" aria-live="polite"></div></section>`
      : '');
}
// WEB-09 (owner opt-in): beside the pages, the palette finds this workspace's campaign plans, saved reports, report
// snapshots, uploaded media and accounts by name or ID (POST /api/workspace-search: local reads as the signed-in
// person, at most five of each, never a provider request). A result only opens its page; nothing runs from here.
// Results belong to the identity, the working client and the query that asked for them, and last while the palette
// stays open: opening it again, or resetPrivateState, clears the cache.
const commandSearchCache = new Map();
let commandSearchTimer,
  commandSearchSequence = 0;
const commandEntityKinds = {
  plan: 'Campaign plan',
  report: 'Saved report',
  snapshot: 'Report snapshot',
  media: 'Uploaded media',
  account: 'Account',
};
/** Whether this session searches the workspace: anyone signed in, a reviewer within its own test workspace. */
const commandSearchable = q => session.authenticated === true && q.length >= 2;
function commandEntityView(found) {
  if (found === 'loading') return `<p class="form-note">${esc(uiText('Searching this workspace…'))}</p>`;
  if (found === 'unavailable')
    return `<p class="form-note">${esc(uiText('Workspace search is unavailable right now. Pages are still listed above.'))}</p>`;
  const hits = (found.results ?? []).filter(hit => Object.hasOwn(commandEntityKinds, hit.kind));
  if (!hits.length) return `<p class="form-note">${esc(uiText('Nothing in this workspace matches.'))}</p>`;
  return hits
    .map(hit => {
      const detail =
        ['plan', 'snapshot'].includes(hit.kind) && hit.detail && typeof statusLabel === 'function'
          ? statusLabel(hit.detail)
          : hit.detail;
      return `<button data-command-go="${esc(hit.href)}"><span><strong><bdi dir="auto">${esc(hit.label)}</bdi></strong><small>${esc(uiText(commandEntityKinds[hit.kind]))}${detail ? ` · <bdi dir="auto">${esc(detail)}</bdi>` : ''}${hit.label !== hit.id ? ` · <bdi dir="ltr">${esc(hit.id)}</bdi>` : ''}</small></span><span aria-hidden="true">→</span></button>`;
    })
    .join('');
}
/**
 * Searches the workspace for the palette's current query after a short pause. A newer query, a shorter one or another
 * identity wins: an older pause sends nothing, and an older answer is not shown.
 */
function commandEntitySearch() {
  const q = String($('#command-query').value ?? '').trim(),
    // The working client (SEC-08) narrows the search as it narrows every list; answers are kept per client and query.
    client = typeof workingClientQuery === 'function' ? workingClientQuery() : {},
    key = JSON.stringify([client.profile_id ?? null, q]),
    sequence = ++commandSearchSequence,
    identity = identityGeneration,
    current = () => sequence === commandSearchSequence && identity === identityGeneration,
    show = found => {
      const region = $('#command-entities');
      if (current() && region) region.innerHTML = commandEntityView(found);
    };
  if (!commandSearchable(q)) return;
  if (commandSearchCache.has(key)) return show(commandSearchCache.get(key));
  show('loading');
  commandSearchTimer = setTimeout(async () => {
    if (!current()) return;
    try {
      const found = await api('/api/workspace-search', {method: 'POST', body: JSON.stringify({q, ...client})});
      if (identity !== identityGeneration) return;
      // Bounded: the most recent queries of this identity only.
      if (commandSearchCache.size >= 20) commandSearchCache.delete(commandSearchCache.keys().next().value);
      commandSearchCache.set(key, found);
      show(found);
    } catch (error) {
      if (error?.code !== 'REQUEST_SUPERSEDED') show('unavailable');
    }
  }, 250);
}
/**
 * A newly opened palette asks the workspace again: answers are kept only while the dialog stays open, so a plan or
 * report created or renamed since the last search is found under the same query.
 */
function commandSearchOpened() {
  commandSearchCache.clear();
}
function openCommand() {
  if (document.body.classList.contains('menu-open')) {
    closeNavigation();
    $('#menu-toggle').focus();
  }
  commandSearchOpened();
  commandResults();
  commandEntitySearch();
  $('#command-dialog').showModal();
  $('#command-query').focus();
}
$('#command-query').addEventListener('input', () => {
  commandResults();
  commandEntitySearch();
});
document.addEventListener('click', e => {
  const b = e.target.closest('button,a');
  if (!b) return;
  if (b.hasAttribute('data-open-admin')) {
    $('#login-dialog').showModal();
    $('#password').focus();
  }
  if (b.id === 'menu-toggle') {
    const open = !document.body.classList.contains('menu-open');
    document.body.classList.toggle('menu-open', open);
    $('#menu-toggle').setAttribute('aria-expanded', String(open));
    $('#workspace-sidebar').inert = !open;
    document.querySelector('.main-shell').inert = open;
    if (open) document.querySelector('.sidebar-close').focus();
  }
  if (b.hasAttribute('data-command-open')) openCommand();
  if (b.dataset.commandGo) {
    $('#command-dialog').close();
    navigate(b.dataset.commandGo);
  }
  if (b.hasAttribute('data-menu-close')) {
    closeNavigation();
    $('#menu-toggle').focus();
  }
  if (b.matches('.sidebar a')) {
    closeNavigation();
    $('#main').focus({preventScroll: true});
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Tab' && document.body.classList.contains('menu-open')) {
    const sidebar = $('#workspace-sidebar'),
      controls = [...sidebar.querySelectorAll('a[href],button:not([disabled]),summary,[tabindex="0"]')].filter(
        el => el.tabIndex >= 0 && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden',
      ),
      first = controls[0],
      last = controls.at(-1),
      active = document.activeElement;
    if (first && (!sidebar.contains(active) || (e.shiftKey ? active === first : active === last))) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    openCommand();
  }
  if (e.key === 'Escape' && document.body.classList.contains('menu-open')) {
    closeNavigation();
    $('#menu-toggle').focus();
  }
  if ($('#command-dialog').open) {
    const buttons = [...document.querySelectorAll('[data-command-go]')],
      index = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
    if (e.key === 'Enter' && document.activeElement === $('#command-query')) {
      e.preventDefault();
      buttons[0]?.click();
    }
  }
});
