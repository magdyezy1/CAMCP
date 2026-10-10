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
  SIGNUP_DISABLED: 'Registration is currently closed. Existing members can still sign in.',
  SIGNIN_SETUP_REQUIRED: 'This sign-in provider needs configuration. Choose another available method.',
  SIGNIN_FAILED: 'Sign-in could not be completed. Please try again.',
};
function safeReturn(path) {
  return typeof path === 'string' &&
    path.length < 10000 &&
    /^\/(dashboard|connections|campaigns|media|reports|reporting-overview|report-library|report-pack|monitors|portfolio|measurement|commerce|operations|schedules|capabilities|profiles|connectors|account|settings|activity|oauth\/consent)(\?|#|$)/.test(
      path,
    )
    ? path
    : '/dashboard';
}
function afterSignIn() {
  const path = safeReturn(sessionStorage.getItem('amcp.return'));
  sessionStorage.removeItem('amcp.return');
  navigate(path);
}
function socialButtons() {
  return `<div class="social-buttons">${authOptions.providers.map(p => `<button class="social-button" data-social="${p.id}" ${p.configured ? '' : 'disabled'}><span class="social-icon ${p.id}">${p.id === 'google' ? 'G' : p.id === 'apple' ? `<svg width="20" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17 12c0-2 1.5-3.3 2-3.6-1.1-1.7-2.8-1.9-3.4-1.9-1.5-.2-2.9.9-3.6.9-.7 0-1.8-.9-3-.9-1.6 0-3.1 1-4 2.5-1.8 3.1-.5 7.7 1.2 10.2.8 1.1 1.7 2.4 3 2.3 1.2 0 1.7-.8 3.3-.8s2 .8 3.4.8 2.2-1.2 3-2.3c.9-1.3 1.3-2.5 1.3-2.6-.1 0-3.2-1.2-3.2-4.6ZM14.6 4.8c.7-.9 1.2-2.1 1.1-3.3-1.1 0-2.4.7-3.2 1.6-.7.8-1.3 2-1.1 3.2 1.2.1 2.4-.6 3.2-1.5Z"/></svg>` : 'f'}</span>${esc(uiText('Continue with'))} ${esc(p.name)}${p.configured ? '' : `<small>${esc(uiText('Not configured'))}</small>`}</button>`).join('')}</div>`;
}
function formField(label, name, type = 'text', extra = '') {
  return `<label>${esc(uiText(label))}<input name="${name}" type="${type}" ${extra} required></label>`;
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
async function renderAuthPage() {
  authOptions = await api('/api/account/options');
  const mode = location.pathname.slice(1),
    signup = mode === 'signup',
    forgot = mode === 'forgot-password',
    verify = ['verify-email', 'reset-password'].includes(mode);
  if (verify && location.hash) {
    const hash = new URLSearchParams(location.hash.slice(1));
    verificationLink = {
      token: hash.get('token'),
      kind: hash.get('kind') ?? (mode === 'reset-password' ? 'reset' : 'register'),
    };
    history.replaceState({}, '', location.pathname);
  }
  const heading = signup
    ? `${esc(uiText('Make yourself'))}<br>${esc(uiText('at home.'))}`
    : forgot
      ? uiText('A fresh start.')
      : verify
        ? uiText('You’re almost in.')
        : `${esc(uiText('Good to have'))}<br>${esc(uiText('you back.'))}`;
  const subtitle = signup
    ? uiText('A workspace for your accounts, your ideas, and whatever comes next.')
    : forgot
      ? uiText('Enter your account email. We’ll send a secure link to reset your password.')
      : verify
        ? uiText('Finish the steps below to secure your account.')
        : uiText('Sign in to pick up where you left off.');
  const authError = authErrors[new URLSearchParams(location.search).get('error')] ?? '',
    registration = registrationOpen(authOptions),
    // A sign-up no method can complete says so plainly and offers sign-in, instead of a disabled form (WEB-02).
    closed = signup && !registration;
  content.innerHTML = `<div class="auth-page"><div class="auth-brand">${brandLink()}${languageControl()}<a href="/" class="text-link">${esc(uiText('Back to home ↗'))}</a></div><section class="auth-story"><span class="eyebrow">${esc(uiText('YOUR SPACE TO MAKE MOVES'))}</span><div class="auth-tagline">${esc(uiText('A little more'))}<br>${esc(uiText('connected.'))}<br><em>${esc(uiText('A lot more you.'))}</em></div><div class="auth-art" aria-hidden="true"><div class="auth-arch"></div><div class="auth-disc"></div><span>✳</span><div class="auth-art-label">${esc(uiText('IDEAS IN MOTION'))}<br><b>${esc(uiText('AMCP / YOUR WORKSPACE'))}</b></div></div><p>${esc(uiText('One place for the accounts, creative, and decisions that move your work forward.'))}</p><div class="auth-story-footer">${esc(uiText('THOUGHTFUL BY DESIGN'))} <span>01 — ∞</span></div></section><section class="auth-form-side"><div class="auth-form-card"><span class="eyebrow">${signup ? uiText('LET’S START SOMETHING') : verify ? uiText('ACCOUNT SECURITY') : uiText('WELCOME TO AMCP')}</span><h1>${heading}</h1><p class="auth-subtitle">${subtitle}</p>${!forgot && !verify && !closed ? socialButtons() + `<div class="auth-divider"><span>${esc(uiText('or continue with email'))}</span></div>` : ''}<p id="auth-error" class="error" role="alert">${esc(uiText(authError))}</p><div id="auth-result" role="status"></div>${verify ? `<form id="email-finish" class="auth-form">${verificationLink?.kind === 'email' ? `<p>${esc(uiText('Confirm this email for your AMCP account. Existing sessions and MCP access will be revoked.'))}</p>` : formField(uiText('Choose a password'), 'password', 'password', 'minlength="15" maxlength="128" autocomplete="new-password"') + `<p class="form-note">${esc(uiText('At least 15 characters. A memorable phrase works well.'))}</p>`}<button class="button primary full" ${verificationLink?.token ? '' : 'disabled'}>${esc(uiText('Complete verification ↗'))}</button>${verificationLink?.token ? '' : `<p class="error">${esc(uiText('Open the complete link from your email to continue.'))}</p>`}</form>` : forgot ? `<form id="forgot-form" class="auth-form">${formField(uiText('Email address'), 'email', 'email', 'autocomplete="email" maxlength="254"')}<button class="button primary full" ${authOptions.emailEnabled ? '' : 'disabled'}>${esc(uiText('Send reset link ↗'))}</button></form>` : closed ? `<div class="auth-form auth-closed"><p class="notice">${esc(uiText(authErrors.SIGNUP_DISABLED))} ${esc(uiText('Ask your workspace owner for access.'))}</p><a class="button primary full" href="/login">${esc(uiText('Sign in to your workspace'))} ${glyph('arrow')}</a></div>` : `<form id="member-form" class="auth-form">${signup ? formField(uiText('Your name'), 'name', 'text', 'autocomplete="name" maxlength="80"') : ''}${formField(uiText('Email address'), 'email', 'email', 'autocomplete="username" maxlength="254"')}${signup ? `<p class="form-note">${esc(uiText('We’ll email a verification link. You’ll choose your password after confirming your address.'))}</p>` : formField(uiText('Password'), 'password', 'password', 'autocomplete="current-password" maxlength="128"') + `<a class="forgot-link" href="/forgot-password">${esc(uiText('Forgot password?'))}</a>`}<button class="button primary full" ${signup && (!authOptions.signupEnabled || !authOptions.emailEnabled) ? 'disabled' : ''}>${signup ? uiText('Create your account') : uiText('Sign in to your workspace')} ${glyph('arrow')}</button></form>`}${!authOptions.emailEnabled && ((signup && !closed) || forgot) ? `<p class="form-note setup-note">${esc(uiText('Email delivery hasn’t been configured yet. Use an available social sign-in method.'))}</p>` : ''}<p class="auth-switch">${verify || forgot ? `<a href="/login">${esc(uiText('← Back to sign in'))}</a>` : signup ? `${esc(uiText('Already part of AMCP?'))} <a href="/login">${esc(uiText('Sign in'))}</a>` : registration ? `${esc(uiText('New here?'))} <a href="/signup">${esc(uiText('Create an account'))}</a>` : `${esc(uiText('New here?'))} ${esc(uiText('Ask your workspace owner for access.'))}`}</p>${!signup && !verify && !forgot && authOptions.administratorEnabled ? `<button class="admin-link" data-open-admin>${esc(uiText('Deployment administrator access'))}</button>` : ''}${authLegalNotice()}<p class="auth-legal"><a href="/about">${esc(uiText('About us'))}</a></p></div></section></div>`;
  authBind('[data-social]', async button => {
    sessionStorage.setItem('amcp.return', safeReturn(sessionStorage.getItem('amcp.return')));
    const r = await api('/api/signin/' + button.dataset.social + '/start', {method: 'POST', body: '{}'});
    location.assign(r.url);
  });
  const done = (message, resend) => {
    $('#auth-result').innerHTML =
      `<div class="auth-success">${glyph('check')}<div><strong>${esc(uiText('Check your inbox'))}</strong><p>${esc(uiText(message))}</p>${resend ? `<p class="form-note">${esc(uiText('Nothing after a minute? Check spam, then'))} <button type="button" class="button small quiet" id="auth-resend">${esc(uiText('send it again'))}</button></p><p class="form-note" id="auth-resend-note" role="status" hidden></p>` : ''}</div></div>`;
    document.querySelectorAll('.auth-form').forEach(f => (f.hidden = true));
    const button = $('#auth-resend'),
      note = $('#auth-resend-note');
    if (!button) return;
    button.addEventListener('click', async () => {
      button.disabled = true;
      note.hidden = false;
      note.textContent = 'Sending…';
      try {
        note.textContent = (
          await api('/api/account/resend-verification', {method: 'POST', body: JSON.stringify(resend)})
        ).message;
      } catch (e) {
        note.textContent = uiText(e.message);
      }
      // The server rate-limits resends per address, so pause rather than invite a burst.
      setTimeout(() => {
        button.disabled = false;
      }, 30000);
    });
  };
  authBind('#member-form', async form => {
    const values = Object.fromEntries(new FormData(form));
    const r = await api('/api/account/' + (signup ? 'register' : 'login'), {
      method: 'POST',
      body: JSON.stringify(values),
    });
    if (signup) done(r.message, {name: values.name, email: values.email});
    else {
      session = await api('/api/session');
      platforms = (await api('/api/platforms')).platforms;
      afterSignIn();
    }
  });
  authBind('#forgot-form', async form => {
    const r = await api('/api/account/forgot-password', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    done(r.message);
  });
  authBind('#email-finish', async form => {
    const r = await api('/api/account/verify-email', {
      method: 'POST',
      body: JSON.stringify({...verificationLink, ...Object.fromEntries(new FormData(form))}),
    });
    verificationLink = null;
    form.hidden = true;
    $('#auth-result').innerHTML =
      `<div class="auth-success">${glyph('check')}<div><strong>${esc(uiText('You’re all set.'))}</strong><p>${esc(uiText(r.message))}</p><a class="button primary" href="/login">${esc(uiText('Continue to sign in ↗'))}</a></div></div>`;
  });
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
        ? `<section class="panel"><h2>${esc(uiText('Your original workspace'))}</h2><p>${esc(uiText('This account uses the deployment administrator password, which has no two-step verification. Use the owner setup below to move this workspace to an email account that can have it; everything in the workspace stays.'))}</p><a class="button" href="/settings">${esc(uiText('Deployment settings ↗'))}</a></section>`
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
const commandPages = [
  ['Report library', '/report-library', 'Saved client definitions, templates and retained snapshots'],
  ['Reporting overview', '/reporting-overview', 'Campaign metrics, recommendations and scheduled Sheets exports'],
  ['Home', '/dashboard', 'Work needing attention and account readiness'],
  ['Campaigns', '/campaigns', 'Plans, dependencies, reviews'],
  ['Media library', '/media', 'Drive imports, formats, and reuse'],
  ['Reports', '/reports', 'Evidence, totals, and recommendations'],
  ['Client profiles', '/profiles', 'Templates, naming, and defaults'],
  ['Connections', '/connections', 'Platforms, accounts, and permissions'],
  ['MCP connectors', '/connectors', 'Codex, Claude, Cursor, and tokens'],
  ['Live account portfolio', '/portfolio', 'Browse Google and Meta campaigns, ad groups, ad sets and ads'],
  ['Measurement diagnostics', '/measurement', 'Tag Manager audits and measurement evidence'],
  ['Commerce', '/commerce', 'Product imports with per-item reviews and receipts'],
  ['Monitoring inbox', '/monitors', 'Read-only rules and evidence-linked incidents'],
  ['Operations', '/operations', 'Campaign, media and delivery recovery'],
  ['Capabilities', '/capabilities', 'Workflow eligibility and native action contracts'],
  ['Schedules', '/schedules', 'Delivery times, windows and recovery'],
  ['Activity', '/activity', 'Your workspace audit history'],
  ['Your account', '/account', 'Profile, social sign-in, and security'],
  ['Settings', '/settings', 'Platform and deployment setup'],
];
function commandResults() {
  const q = $('#command-query').value.toLowerCase();
  $('#command-results').innerHTML =
    commandPages
      .filter(p => [...p, uiText(p[0]), uiText(p[2])].join(' ').toLowerCase().includes(q))
      .map(
        ([name, path, desc]) =>
          `<button data-command-go="${path}"><span><strong>${esc(uiText(name))}</strong><small>${esc(uiText(desc))}</small></span><span>↗</span></button>`,
      )
      .join('') || `<p class="empty">${esc(uiText('No pages match. Try “media” or “connections”.'))}</p>`;
}
function openCommand() {
  if (document.body.classList.contains('menu-open')) {
    closeNavigation();
    $('#menu-toggle').focus();
  }
  commandResults();
  $('#command-dialog').showModal();
  $('#command-query').focus();
}
$('#command-query').addEventListener('input', commandResults);
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
