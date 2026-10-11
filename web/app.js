'use strict';
const $ = s => document.querySelector(s),
  esc = v =>
    String(v ?? '').replace(
      /[&<>"']/g,
      c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c],
    );
const labels = {
  spreadsheets: 'Spreadsheets',
  files: 'Drive files',
  folders: 'Drive folders',
  ad_accounts: 'Ad accounts',
  advertisers: 'Advertisers',
  pages: 'Pages',
  instagram: 'Instagram',
  catalogs: 'Catalogs',
  pixels: 'Pixels',
  mobile_apps: 'Mobile apps',
  custom_conversions: 'Custom conversions',
  profiles: 'Profiles',
  identities: 'Identities',
  properties: 'GA4 properties',
  data_streams: 'Data streams',
  tag_accounts: 'Tag Manager accounts',
  containers: 'Containers & Google tags',
  sites: 'Search Console sites',
  sitemaps: 'Sitemaps',
  locations: 'Business locations',
  business_accounts: 'Business accounts',
};
let session = {authenticated: false, csrf: null},
  platforms = [],
  commerceSources = [],
  filter = 'all',
  search = '',
  currentPlatform = null,
  currentConnection = null,
  assetKind = 'ad_accounts',
  selected = new Set(),
  writeSelected = new Set(),
  // The last Save and check access result of each login, shown inline in the asset manager (CON-05).
  accessChecks = new Map(),
  assetSearch = '',
  client = 'codex',
  tokens = [],
  oauthClients = [],
  oauthEnded = [],
  pollTimer;
let navigationGeneration = 0,
  identityGeneration = 0,
  // The path and query the current view was rendered for; a history step that changes only the fragment keeps it.
  renderedLocation = null,
  // A page holding unsaved edits answers true here, so an in-app link asks before leaving (CMP-06). Every render of a
  // different address and every identity reset clears it, so it never blocks signing out or switching workspace.
  pageLeaveGuard = null;
const identityKey = value =>
  JSON.stringify([!!value.authenticated, value.id ?? value.userId, value.workspaceId, value.workspaceRole, value.csrf]);
/** Clears what the previous identity saw. */
function resetPrivateState() {
  identityGeneration++;
  navigationGeneration++;
  pageLeaveGuard = null;
  clearTimeout(pollTimer);
  clearTimeout(toastTimer);
  platforms = [];
  commerceSources = [];
  tokens = [];
  oauthClients = [];
  oauthEnded = [];
  currentPlatform = currentConnection = null;
  selected.clear();
  writeSelected.clear();
  accessChecks.clear();
  search = assetSearch = '';
  filter = 'all';
  if (typeof overviewState !== 'undefined')
    overviewState = {
      bootstrap: null,
      config: null,
      report: null,
      page: 0,
      custom: [],
      history: [],
      selection: null,
      destinationId: null,
      loadSequence: (overviewState.loadSequence ?? 0) + 1,
      dirty: false,
    };
  if (typeof recipeDrafts !== 'undefined') recipeDrafts.clear();
  if (typeof loginMfaTicket !== 'undefined') loginMfaTicket = null;
  if (typeof deliveryTimer !== 'undefined') clearTimeout(deliveryTimer);
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  content.innerHTML = '';
  $('#toast').textContent = '';
  $('#toast').hidden = true;
}
/** Signing out or switching workspace also forgets the drafts this tab kept for the identity (CMP-06). */
function resetTabState() {
  resetPrivateState();
  if (typeof recipeDraftsForget === 'function') recipeDraftsForget();
}
function requestError(result, fallback = uiText('This request could not be completed.')) {
  const error = Error(result.error?.message ?? fallback);
  Object.assign(error, result.error ?? {});
  error.requestId = result.meta?.requestId ?? result.meta?.request_id ?? result.request_id;
  const parts = result.meta?.message_parts;
  if (
    parts &&
    typeof parts.base === 'string' &&
    typeof parts.suffix === 'string' &&
    error.message === parts.base.replace(/\.?$/, '') + ': ' + parts.suffix
  )
    error.messageParts = {base: parts.base, suffix: parts.suffix};
  return error;
}
const supersededRequest = () => Object.assign(Error(''), {code: 'REQUEST_SUPERSEDED'});
function errorMessage(error) {
  if (error?.code === 'REQUEST_SUPERSEDED') return '';
  const parts = error?.messageParts,
    split =
      parts &&
      typeof parts.base === 'string' &&
      typeof parts.suffix === 'string' &&
      error.message === parts.base.replace(/\.?$/, '') + ': ' + parts.suffix;
  const remedy =
    error?.next_action ??
    error?.remedy?.action ??
    error?.remedy?.message ??
    error?.remedy?.next_action ??
    error?.details?.next_action;
  return [
    split ? uiText(parts.base).replace(/\.?$/, '') + ': ' + parts.suffix : uiText(error?.message),
    typeof remedy === 'string' ? uiText(remedy) : '',
    error?.requestId ? uiText('Reference: {id}', {id: error.requestId}) : '',
  ]
    .filter(Boolean)
    .join(' ');
}
const content = $('#content'),
  date = v => (v ? uiDate(v) : uiText('Not synced'));
// A new message restarts the timer; before, an older timer could hide a newer message after a second.
// One styled confirmation for destructive actions: it names the consequence, and Cancel has focus. Escape cancels.
function confirmAction({title, consequence, confirmLabel = 'Confirm', items = []}) {
  const d = $('#action-dialog');
  $('#action-title').textContent = uiText(title);
  $('#action-copy').textContent = uiText(consequence);
  // What the action changes, one item each, when the caller names it (a spending policy's weakenings).
  d.querySelector?.('#action-items')?.remove();
  if (items.length) {
    const list = document.createElement('ul');
    list.id = 'action-items';
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = item;
      list.append(li);
    }
    $('#action-copy').after(list);
  }
  d.setAttribute?.('aria-describedby', items.length ? 'action-copy action-items' : 'action-copy');
  $('#action-confirm').textContent = uiText(confirmLabel);
  return new Promise(resolve => {
    const cancel = $('#action-cancel'),
      confirm = $('#action-confirm');
    const keydown = event => {
      if (event.key !== 'Tab') return;
      if (!event.shiftKey && document.activeElement === confirm) {
        event.preventDefault();
        cancel.focus();
      } else if (event.shiftKey && document.activeElement === cancel) {
        event.preventDefault();
        confirm.focus();
      }
    };
    const closed = () => {
      d.removeEventListener('close', closed);
      d.removeEventListener('keydown', keydown);
      resolve(d.returnValue === 'confirm');
    };
    d.addEventListener('close', closed);
    d.addEventListener('keydown', keydown);
    d.returnValue = '';
    d.showModal();
    cancel.focus();
  });
}
let toastTimer;
function toast(message) {
  if (!message) return;
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 6000);
}
// A page that fails to open says why and offers a way on, instead of a six-second toast over a page stuck loading.
const pageErrorCauses = {
  NOT_FOUND: 'This link has expired or belongs to another workspace.',
  CSRF_INVALID: 'Your session changed in another tab. Refresh the page and try again.',
  FORBIDDEN: 'Your role in this workspace does not include this page.',
  FORBIDDEN_ORIGIN: 'Open AMCP from its own address and try again.',
};
function showPageError(e) {
  const reload = e?.code === 'PAGE_ASSET_RELOAD_REQUIRED';
  content.innerHTML =
    `<section class="panel page-error" role="alert"><h1 tabindex="-1">${esc(e?.updated ? uiText('AMCP was updated') : uiText('This page could not open'))}</h1><p>` +
    esc(errorMessage({...e, message: pageErrorCauses[e?.code] ?? e?.message ?? 'Something went wrong.'})) +
    `</p><div class="dialog-actions"><button class="button primary" type="button" data-retry-page>${esc(uiText(reload ? 'Reload page' : 'Try again'))}</button><a class="button" href="/connections">${esc(uiText('Back to Connections'))}</a></div></section>`;
  content.querySelector('[data-retry-page]').addEventListener('click', () => (reload ? reloadPage() : render()));
  content.querySelector('h1').focus();
}
/** Reloads the document, asking first while it still holds unsaved edits: a reload never discards them silently. */
async function reloadPage() {
  if (
    uiHasUnsavedEdits() &&
    !(await confirmAction({
      title: uiText('Reload AMCP?'),
      consequence: uiText(
        'Unsaved edits on this page will be cleared. Save any recovery codes or one-time tokens first. Saved work is kept.',
      ),
      confirmLabel: uiText('Reload page'),
    }))
  )
    return false;
  location.reload();
  return true;
}
// AMCP was updated while this page was open: its files belong to a snapshot the server no longer has, so only a reload
// can continue (WEB-04). The person chooses when, after saving what they need; `prepare` runs only when they confirm.
async function reloadForUpdate(prepare) {
  const confirmed = await confirmAction({
    title: uiText('AMCP was updated'),
    consequence: uiHasUnsavedEdits()
      ? uiText(
          'Reload to continue. Unsaved edits on this page will be cleared, so save them first. Saved work is kept.',
        )
      : uiText('Reload to continue. Saved work is kept.'),
    confirmLabel: uiText('Reload page'),
  });
  if (!confirmed) return false;
  prepare?.();
  location.reload();
  return true;
}
/**
 * "Confirm it's you" (SEC-06): a sensitive change made long after sign-in is refused with REAUTH_REQUIRED before it has
 * any effect. This dialog proves the person again in place, with a password, a two-step code or a linked social
 * sign-in, so the page and its form keep their state. Resolves true once the server accepted the proof, false when
 * the person cancels. A social confirmation leaves the page and returns to it afterwards.
 */
function confirmIdentity() {
  const d = $('#reauth-dialog'),
    form = $('#reauth-form'),
    password = $('#reauth-password'),
    code = $('#reauth-code'),
    error = $('#reauth-error');
  if (!d || !form) return Promise.resolve(false);
  const usesPassword = session.hasPassword !== false,
    usesCode = session.mfaEnabled === true,
    providers = session.administrator || session.testAccount ? [] : (session.identities ?? []).map(i => i.provider);
  $('#reauth-password-field').hidden = !usesPassword;
  $('#reauth-code-field').hidden = !usesCode;
  $('#reauth-social').innerHTML = providers
    .map(
      p =>
        `<button type="button" class="button" data-reauth-social="${esc(p)}">${esc(uiText('Confirm with {provider}', {provider: p === 'google' ? 'Google' : p === 'apple' ? 'Apple' : p === 'facebook' ? 'Facebook' : p}))}</button>`,
    )
    .join('');
  password.value = code.value = error.textContent = '';
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      form.removeEventListener('submit', submit);
      $('#reauth-cancel').removeEventListener('click', cancel);
      $('#reauth-social').removeEventListener('click', social);
      d.removeEventListener('close', cancel);
      password.value = code.value = '';
      if (d.open) d.close();
      resolve(value);
    };
    const cancel = () => finish(false);
    const submit = async event => {
      event.preventDefault();
      const button = $('#reauth-confirm');
      button.disabled = true;
      error.textContent = '';
      try {
        await api('/api/account/reauthenticate', {
          method: 'POST',
          body: JSON.stringify(code.value.trim() ? {code: code.value.trim()} : {password: password.value}),
        });
        finish(true);
      } catch (e) {
        error.textContent = errorMessage(e);
      } finally {
        button.disabled = false;
      }
    };
    const social = async event => {
      const provider = event.target.closest?.('[data-reauth-social]')?.dataset.reauthSocial;
      if (!provider) return;
      try {
        sessionStorage.setItem('amcp.return', location.pathname + location.search);
        const r = await api('/api/signin/' + provider + '/start', {
          method: 'POST',
          body: JSON.stringify({reauth: true}),
        });
        location.assign(r.url);
      } catch (e) {
        error.textContent = errorMessage(e);
      }
    };
    form.addEventListener('submit', submit);
    $('#reauth-cancel').addEventListener('click', cancel);
    $('#reauth-social').addEventListener('click', social);
    d.addEventListener('close', cancel);
    d.showModal();
    (usesPassword ? password : usesCode ? code : d.querySelector('[data-reauth-social]'))?.focus();
  });
}
async function api(url, options = {}) {
  const generation = navigationGeneration,
    identity = identityGeneration;
  // `reauthRetried` marks the one repeat after "Confirm it's you"; it is not a fetch option.
  const {reauthRetried, ...init} = options;
  const method = init.method ?? 'GET',
    headers = {
      'Accept': 'application/json',
      ...(method !== 'GET' ? {'Content-Type': 'application/json', 'X-AMCP-CSRF': session.csrf ?? ''} : {}),
      ...init.headers,
    };
  let response, data;
  try {
    response = await fetch(url, {...init, headers, credentials: 'same-origin'});
    data = await response.json();
  } catch {
    if (generation !== navigationGeneration || identity !== identityGeneration) throw supersededRequest();
    throw Error(uiText('AMCP could not read the server response.'));
  }
  if (generation !== navigationGeneration || identity !== identityGeneration) throw supersededRequest();
  if (!response.ok) {
    const e = requestError(data);
    // The server refused before any effect; after the person confirms, the same request is sent exactly once more.
    if (e.code === 'REAUTH_REQUIRED' && !reauthRetried && url !== '/api/account/reauthenticate') {
      const confirmed = await confirmIdentity();
      if (generation !== navigationGeneration || identity !== identityGeneration) throw supersededRequest();
      if (confirmed) return api(url, {...init, reauthRetried: true});
    }
    if (response.status === 401 && !url.startsWith('/api/account/') && !url.startsWith('/api/session')) {
      resetPrivateState();
      session = {authenticated: false, csrf: null};
      showLogin();
    }
    throw e;
  }
  if (url === '/api/session' && method === 'GET' && identityKey(session) !== identityKey(data)) resetPrivateState();
  if (url === '/api/session' && method === 'DELETE') resetTabState();
  if (url === '/api/workspaces/switch') resetTabState();
  return data;
}
function showLogin() {
  if (location.pathname === '/login') return;
  if (!['/signup', '/forgot-password', '/verify-email', '/reset-password'].includes(location.pathname))
    sessionStorage.setItem('amcp.return', location.pathname + location.search);
  navigate('/login');
}
function requireLogin() {
  if (session.authenticated) return true;
  showLogin();
  return false;
}
function logo(p) {
  return `<span class="platform-logo ${esc(p.id)}" aria-hidden="true">${esc(p.logo)}</span>`;
}
/** The element a same-page fragment names, or null. Fragments only ever select an existing element by its ID. */
function fragmentTarget(hash) {
  if (!hash || hash.length < 2 || !hash.startsWith('#')) return null;
  try {
    return document.getElementById(decodeURIComponent(hash.slice(1)));
  } catch {
    return null;
  }
}
/** Moves keyboard focus to a section of the current page, opening it when it is a disclosure. */
function focusFragmentTarget(target) {
  if (target.tagName === 'DETAILS') target.open = true;
  if (!target.matches?.('a[href],button,input,select,textarea,summary,[tabindex]'))
    target.setAttribute('tabindex', '-1');
  target.scrollIntoView({block: 'start'});
  target.focus({preventScroll: true});
}
async function navigate(route) {
  history.pushState({}, '', route);
  await render();
  if (location.pathname + location.search + location.hash !== route) return;
  let target = fragmentTarget(location.hash);
  if (!target && location.pathname === '/reporting-overview' && new URLSearchParams(location.search).has('report_id'))
    target = document.getElementById('overview-results');
  if (target) focusFragmentTarget(target);
  else {
    window.scrollTo(0, 0);
    focusPageHeading();
  }
}
/**
 * Records a page's own state (a selection, a drill-down) in the address without re-rendering it, so Back returns to
 * the previous state and a reload restores it (WEB-06). The view stays rendered for the new address.
 */
function setViewLocation(url, push = false) {
  if (url === location.pathname + location.search + location.hash) return;
  history[push ? 'pushState' : 'replaceState']({}, '', url);
  renderedLocation = location.pathname + location.search;
}
/** After a page opens, keyboard and screen-reader focus starts on its heading (WEB-06), or on the main region. */
function focusPageHeading() {
  const heading = content.querySelector('h1');
  if (heading) {
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus({preventScroll: true});
  } else document.getElementById('main').focus({preventScroll: true});
}
// The page key comes from the route registry (web/routes.js, WEB-06). Only the connections page and a provider's
// connection flow belong to Connections; the legal and sign-in pages belong to no section of the navigation (F-43).
function route() {
  return routeSection(location.pathname);
}
function header(title, description, action = '') {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div>${action}</div>`;
}
function connectionCount(p) {
  return p.connections.length;
}
function assetsFor(p, kind) {
  return new Set(p.connections.flatMap(c => (c.groups.find(g => g.kind === kind)?.assets ?? []).map(a => a.id))).size;
}
/** Whether the open platform's logins may select assets of this kind (Drive: files and folders). */
function selectableKind(kind) {
  const p = platforms.find(p => p.id === currentPlatform);
  return (p?.selectableKinds ?? [p?.selectionKind ?? 'ad_accounts']).includes(kind);
}
/** An account's own name as the last sync of this login read it, or null when no sync named it. */
function accountDisplayName(c, id) {
  const bare = v => String(v).replace(/^act_/, '');
  for (const g of c.groups ?? [])
    for (const a of g.assets ?? [])
      if (bare(a.id) === bare(id) && a.source !== 'configured_binding' && a.name && bare(a.name) !== bare(id))
        return a.name;
  return null;
}
/** An account as the website names it within its platform: its name and ID, and its login when there are several. */
function accountText(p, c, id) {
  const name = accountDisplayName(c, id),
    logins = p.connections.filter(x => x.enabled).length;
  return (name ? name + ' (' + id + ')' : id) + (logins > 1 ? ' · ' + (c.name ?? c.label ?? '') : '');
}
/**
 * accountText as escaped markup for running text (WEB-05): the label is isolated from the text around it, the name and
 * login keep their own direction, and the ID reads left to right inside Arabic. Option labels keep accountText.
 */
function accountHtml(p, c, id) {
  const name = accountDisplayName(c, id),
    logins = p.connections.filter(x => x.enabled).length;
  return (
    '<bdi>' +
    (name ? uiBidi(name) + ' (' + uiBidi(id, 'ltr') + ')' : uiBidi(id, 'ltr')) +
    (logins > 1 ? ' · ' + uiBidi(c.name ?? c.label ?? '') : '') +
    '</bdi>'
  );
}
/** The same with its platform first, for lists that mix platforms. */
function accountLabel(p, c, id) {
  return p.name + ' · ' + accountText(p, c, id);
}
function accountLabelHtml(p, c, id) {
  return '<bdi>' + uiBidi(p.name) + ' · ' + accountHtml(p, c, id) + '</bdi>';
}
/** The platform and login a stored record (a receipt, a review) names through its platform, login and account. */
function recordAccountSource(platform, connectionId, id) {
  const p = platforms.find(
      x => x.id === platform || x.gateway === platform + '_native_action' || x.gateway === platform,
    ),
    c = p?.connections.find(x => x.id === connectionId) ?? p?.connections.find(x => x.accounts?.includes(String(id)));
  return {p, c};
}
/** The same name for a stored record. */
function recordAccountLabel(platform, connectionId, id) {
  const {p, c} = recordAccountSource(platform, connectionId, id);
  return p && c ? accountLabel(p, c, id) : (p?.name ?? platform) + ' · ' + id;
}
function recordAccountLabelHtml(platform, connectionId, id) {
  const {p, c} = recordAccountSource(platform, connectionId, id);
  return p && c
    ? accountLabelHtml(p, c, id)
    : '<bdi>' + uiBidi(p?.name ?? platform) + ' · ' + uiBidi(id, 'ltr') + '</bdi>';
}
function renderConnections() {
  const connected = platforms.filter(p => connectionCount(p) > 0),
    accounts = new Set(platforms.flatMap(p => p.connections.flatMap(c => c.accounts.map(a => p.id + ':' + a)))),
    logins = platforms.reduce((n, p) => n + p.connections.length, 0);
  content.innerHTML =
    header(
      uiText('Connections'),
      uiText('Connect your platforms. Choose what AMCP can access.'),
      `<button class="button" data-action="refresh">↻ <span>${esc(uiText('Refresh'))}</span></button>`,
    ) +
    `${!session.authenticated ? `<div class="notice"><span>◈</span><p><strong>${esc(uiText('Your workspace, securely connected.'))}</strong><br>${esc(uiText('Sign in to manage platform logins and choose your advertising assets.'))}</p><button class="button dark" data-action="login">${esc(uiText('Sign in →'))}</button></div>` : ''}` +
    `<div class="stat-grid"><div class="stat"><div><div class="stat-label">${esc(uiText('Connected platforms'))}</div><div class="stat-value">${connected.length}<span class="muted stat-denominator"> / ${platforms.length}</span></div></div><span class="stat-icon" aria-hidden="true">◈</span></div><div class="stat"><div><div class="stat-label">${esc(uiText('Selected accounts & properties'))}</div><div class="stat-value">${accounts.size}</div></div><span class="stat-icon" aria-hidden="true">▦</span></div><div class="stat"><div><div class="stat-label">${esc(uiText('Secure logins'))}</div><div class="stat-value">${logins}</div></div><span class="stat-icon" aria-hidden="true">↗</span></div></div>` +
    `<div class="section-tools"><div class="filter-tabs" role="group" aria-label="${esc(uiText('Filter platforms'))}"><button class="filter-tab ${filter === 'all' ? 'active' : ''}" data-filter="all">${esc(uiText('All platforms'))} <span class="muted">${platforms.length}</span></button><button class="filter-tab ${filter === 'connected' ? 'active' : ''}" data-filter="connected">${esc(uiText('Connected'))} <span class="muted">${connected.length}</span></button></div><label class="search"><span aria-hidden="true">⌕</span><input id="platform-search" type="search" value="${esc(search)}" placeholder="${esc(uiText('Search platforms…'))}" aria-label="${esc(uiText('Search platforms'))}"></label></div><div class="platform-grid" id="platform-grid"></div>`;
  renderPlatformCards();
}
function renderPlatformCards() {
  const visible = platforms.filter(
    p => (filter === 'all' || p.connections.length) && p.name.toLowerCase().includes(search.toLowerCase()),
  );
  $('#platform-grid').innerHTML =
    visible
      .map(p => {
        const n = p.connections.length,
          // A login the provider no longer accepts is never shown as Connected (CON-02).
          dead = p.connections.some(c => c.status === 'reauthorization_required'),
          attention = dead || p.connections.some(c => c.error || c.status === 'expiring_soon'),
          status = dead
            ? uiText('Reauthorization required')
            : attention
              ? uiText('Needs attention')
              : n
                ? uiText('Connected')
                : uiText('Not connected'),
          metrics = p.assetKinds.slice(0, 3);
        while (metrics.length < 3) metrics.push(metrics.length === 1 ? 'logins' : 'selected');
        return `<article class="platform-card"><div class="platform-main"><div class="platform-top"><div class="platform-identity">${logo(p)}<div><div class="platform-name">${esc(p.name)}</div><div class="platform-kind">${esc(uiText(p.kind))}</div></div></div><span class="status ${attention ? 'attention' : n ? 'online' : 'offline'}"><i></i>${status}</span></div><p class="platform-description">${esc(uiText(p.description))}</p><div class="platform-bottom"><span class="platform-login">${n ? uiText('Connected logins: {count}', {count: uiNumber(n)}) : p.configured ? uiText('Ready to connect') : uiText('Administrator setup required')}</span><div class="platform-actions"><button class="button small" data-manage="${p.id}">${esc(uiText('Manage'))}</button><button class="button small ${n ? '' : 'primary'}" data-connect="${p.id}">${n ? uiText('+ Add login') : p.configured ? uiText('+ Connect') : uiText('Set up →')}</button></div></div></div><div class="platform-metrics">${metrics.map(k => `<div><small>${esc(uiText(labels[k] ?? k).toUpperCase())}</small><b>${k === 'logins' ? n : k === 'selected' ? p.connections.reduce((v, c) => v + c.accounts.length, 0) : assetsFor(p, k)}</b></div>`).join('')}</div></article>`;
      })
      .join('') || `<div class="empty">${esc(uiText('No platforms match your search.'))}</div>`;
}
function renderConnectionSyncStatus(c) {
  if (!c?.lastSync) return '';
  const reason = c.groups?.flatMap(g => g.diagnostics ?? []).find(d => d.provider?.code)?.provider?.code;
  return (
    `<div class="notice connection-sync-status" role="status"><div><strong>` +
    esc(c.error ? uiText('Sync needs attention') + (reason ? ' — ' + reason : '') : uiText('Sync completed')) +
    `</strong><p class="small-text">` +
    esc(date(c.lastSync)) +
    (c.error
      ? ' · ' + uiText('Review the provider details below. Your saved login and selections are retained.')
      : ' · ' + uiText('The requested assets were refreshed.')) +
    `</p></div></div>`
  );
}
/** One line of recorded login health (CON-02); never a token or its first-hour expiry. */
function loginHealthLine(login) {
  const h = login.credentialHealth ?? {},
    expiry = h.login_expires_at ? uiText('Login expires {date}', {date: date(h.login_expires_at)}) : '';
  if (h.state === 'reauthorization_required') return uiText('Reauthorization required');
  if (h.state === 'credentials_unreadable') return uiText('Saved login cannot be read by this server');
  if (h.state === 'refresh_failed') return uiText('Renewal failed; AMCP retries automatically');
  if (h.state === 'client_changed') return uiText('Saved OAuth client differs; reauthorize');
  if (h.state === 'expiring') return uiText('Expiring soon') + (expiry ? ' · ' + expiry : '');
  if (h.renews_automatically) return uiText('Access renews automatically') + (expiry ? ' · ' + expiry : '');
  return expiry || uiText('Expiry not provided');
}
/** A reviewer workspace login's age and automatic removal (SEC-06); empty for every other login. */
function reviewerLoginLine(login) {
  if (!login.reviewerRemovesAt) return '';
  return (
    ' · ' +
    esc(
      login.connectedAt
        ? uiText('Connected {connected} · removed automatically {date}', {
            connected: date(login.connectedAt),
            date: date(login.reviewerRemovesAt),
          })
        : uiText('Removed automatically {date}', {date: date(login.reviewerRemovesAt)}),
    )
  );
}
function renderCredentialHealth(c) {
  const h = c?.credentialHealth;
  if (
    !h ||
    !['reauthorization_required', 'refresh_failed', 'expiring', 'client_changed', 'credentials_unreadable'].includes(
      h.state,
    )
  )
    return '';
  const failure = h.last_failure
    ? `<p class="small-text">${esc(uiText('Last renewal attempt: {date}', {date: date(h.last_failure.at)}))}${h.last_failure.http_status ? ' · HTTP ' + esc(String(h.last_failure.http_status)) : ''}${h.last_failure.code ? ' · ' + esc(h.last_failure.code) : ''}</p>`
    : '';
  const text =
    h.state === 'reauthorization_required'
      ? uiText(
          'This login no longer works. Reauthorize it to keep this connection, its selections, saved reports and schedules.',
        )
      : h.state === 'refresh_failed'
        ? uiText('AMCP could not renew access. It retries after a short pause; Retry renewal asks again now.')
        : h.state === 'client_changed'
          ? uiText('This login was authorized with a different OAuth client. Reauthorize it with the current client.')
          : h.state === 'credentials_unreadable'
            ? uiText(
                'AMCP cannot open this saved login, usually because the server encryption key is missing or changed. The deployment administrator should restore the key; reauthorizing replaces the saved login.',
              )
            : uiText('This login expires soon and cannot renew itself. Reauthorize it before it expires.');
  const actions = [
    c.reauthorizeAvailable
      ? `<button class="button small ${h.state === 'reauthorization_required' ? 'primary' : ''}" data-reauthorize="${esc(c.id)}">${esc(uiText('Reauthorize'))}</button>`
      : '',
    h.last_failure
      ? `<button class="button small" data-credential-retry="${esc(c.id)}">${esc(uiText('Retry renewal'))}</button>`
      : '',
  ].filter(Boolean);
  return `<div class="notice credential-health" role="status"><div><strong>${esc(loginHealthLine(c))}</strong><p>${esc(text)}</p>${failure}${actions.length ? `<p>${actions.join(' ')}</p>` : ''}</div></div>`;
}
/** What the provider confirmed this login was granted (CON-03): declined permissions, or that it is not confirmed. */
function renderGrantedPermissions(c) {
  const g = c?.grants;
  if (!g) return '';
  const reauthorize = c.reauthorizeAvailable
    ? ` <button class="button small" data-reauthorize="${esc(c.id)}">${esc(uiText('Reauthorize'))}</button>`
    : '';
  if (g.requested_access_type === 'read')
    return `<div class="notice" role="status"><p>${esc(uiText('This login was authorized for read access only.'))}${reauthorize}</p></div>`;
  if (g.source !== 'permissions_endpoint') return '';
  if (!g.known)
    return `<div class="notice" role="status"><p>${esc(uiText('AMCP could not confirm which permissions this login granted. Sync to check again; until then readiness reports them as unknown.'))}</p></div>`;
  const declined = [...(g.declined ?? []), ...(g.expired ?? [])];
  if (!declined.length) return '';
  return `<div class="notice" role="status"><div><strong>${esc(uiText('Declined permissions'))}</strong><p><code dir="ltr">${esc(declined.join(', '))}</code></p><p>${esc(uiText('Features that need these permissions stay unavailable. Reauthorize and allow them to use those features.'))}${reauthorize}</p><p class="small-text">${esc(uiText('Checked {date}', {date: date(g.checked_at)}))}</p></div></div>`;
}
/**
 * Save and check access (CON-05): after a selection is saved, one bounded live account read for each newly selected
 * account (at most 20, read four at a time by the server), on this explicit click only.
 */
async function checkSelectedAccess(platformId, connectionId, before) {
  const c = platforms.find(p => p.id === platformId)?.connections.find(x => x.id === connectionId);
  if (!c) return;
  const added = c.accounts.filter(id => !before.has(id)),
    ids = added.slice(0, 20);
  if (!ids.length) {
    toast(uiText('No newly selected accounts to check.'));
    return;
  }
  const result = await workspaceCall('workspace', {action: 'check', connection_id: c.id, account_ids: ids, live: true});
  accessChecks.set(c.id, {...result, skipped: added.length - ids.length});
  if ($('#manage-dialog').open && currentConnection === c.id) renderManage();
}
/** Two or more enabled logins without a default: AI tools must name a login on every request (CON-05). */
function renderDefaultPrompt(p) {
  const enabled = p.connections.filter(c => c.enabled);
  if (enabled.length < 2 || enabled.some(c => c.isDefault)) return '';
  return `<div class="notice" role="status"><p><strong>${esc(uiText('Choose a default login'))}</strong> ${esc(uiText('Several {platform} logins are enabled and none is the default, so AI tools must name a login for every request. Use Make default on one of them.', {platform: p.name}))}</p></div>`;
}
/** The login's own name in AMCP and the provider identity it was authorized with (CON-05). */
function renderLoginIdentity(c) {
  const identity = c.identity?.name
    ? `<p class="small-text">${esc(uiText('Provider identity: {name}', {name: c.identity.name}))}</p>`
    : '';
  if (!session.administrator) return identity ? `<div class="notice">${identity}</div>` : '';
  return `<div class="notice login-identity"><div><label for="login-label">${esc(uiText('Login name'))}</label><div class="copy-row"><input id="login-label" type="text" maxlength="80" value="${esc(c.name)}" autocomplete="off"><button class="button small" data-rename-login="${esc(c.id)}">${esc(uiText('Rename'))}</button></div>${identity}</div></div>`;
}
function renderAccessChecks(p, c) {
  const result = c ? accessChecks.get(c.id) : undefined;
  if (!result?.results) return '';
  const name = id => c.groups.flatMap(g => g.assets).find(a => a.id === id)?.name ?? id,
    reason = r => r.checks?.find(x => x.status !== 'passed');
  return `<section class="notice access-checks" role="status" aria-live="polite"><div><strong>${esc(uiText('Access check'))}</strong><ul>${result.results
    .map(
      r =>
        `<li><bdi>${uiBidi(name(r.account_id))}</bdi> <small>${uiBidi(r.account_id, 'ltr')}</small> ${readinessBadge(r)}${reason(r) ? ` <small>${esc(uiText(reason(r).message))}</small>` : ''}</li>`,
    )
    .join(
      '',
    )}</ul>${result.skipped > 0 ? `<p class="small-text">${esc(uiText('{count} more accounts were not checked; check them from Home.', {count: uiNumber(result.skipped)}))}</p>` : ''}<p class="small-text">${esc(uiText('Each check read one selected account from {platform}. Nothing was changed.', {platform: p.name}))}</p></div></section>`;
}
function renderGoogleAuthorization(c) {
  const a = c?.authorization;
  if (!a) return '';
  return (
    `<div class="notice"><div><strong>${esc(uiText('Google authorization'))}</strong><p>${esc(uiText('Sync reloads accounts using this saved login. Reauthorize asks Google for fresh consent and keeps this connection after account access is verified.'))}</p><p class="small-text">` +
    (a.matchesCurrentClient === true
      ? uiText('Saved OAuth client matches the current configuration.')
      : a.matchesCurrentClient === false
        ? uiText(
            'Saved OAuth client differs from the current configuration. Use Reauthorize to connect with the current client.',
          )
        : uiText('The saved OAuth client could not be compared. Reauthorize to establish a fresh connection.')) +
    `</p>` +
    (a.clientId
      ? `<p class="small-text">${esc(uiText('Saved client:'))} <span class="oauth-client-id">` +
        esc(a.clientId) +
        `</span></p>`
      : '') +
    (!a.adsScopeRecorded
      ? `<p>${esc(uiText('Google Ads permission is not recorded on this login. Reauthorize and approve Google Ads access.'))}</p>`
      : '') +
    `</div></div>`
  );
}
async function syncConnection(id, kinds) {
  const result = await api('/api/connections/' + id + '/sync', {method: 'POST', body: JSON.stringify({kinds})});
  currentConnection = id;
  await refresh();
  if (result.error) {
    const reason = result.groups?.flatMap(g => g.diagnostics ?? []).find(d => d.provider?.code)?.provider?.code;
    toast(
      uiText('Sync needs attention') +
        (reason ? ' — ' + reason : '') +
        uiText('. Open the error details below. For authorization errors, use Reauthorize.'),
    );
  } else toast(uiText('Accounts synced successfully.'));
}
function renderManage() {
  const p = platforms.find(p => p.id === currentPlatform);
  if (!p) return;
  const c = p.connections.find(c => c.id === currentConnection);
  if (!c && p.connections.length) {
    currentConnection = (p.connections.find(c => c.isDefault) ?? p.connections[0]).id;
    return openManage(p.id, currentConnection);
  }
  const group = c?.groups.find(g => g.kind === assetKind),
    assets = (group?.assets ?? []).filter(a => (a.name + ' ' + a.id).toLowerCase().includes(assetSearch.toLowerCase()));
  $('#manage-content').innerHTML =
    `<div class="manage-header"><div class="platform-identity">${logo(p)}<div><h3>${esc(p.name)} ${esc(uiText('assets'))}</h3><div class="platform-kind">${esc(uiText('Manage logins and access inside AMCP'))}</div></div></div><button class="icon-button" data-close="manage-dialog" aria-label="${esc(uiText('Close asset manager'))}">×</button></div><div class="manage-body"><div class="panel-header"><div><h3>${esc(uiText('Connected logins'))}</h3><p class="muted login-caption">${esc(uiText('Each login keeps its own encrypted credentials and permissions.'))}</p></div><button class="button dark small" data-connect="${p.id}">${esc(uiText('+ Connect another'))}</button></div><div class="login-list">${p.connections.map(login => `<div class="oauth-login"><span class="avatar">${esc(login.name.slice(0, 1).toUpperCase())}</span><div><button class="button quiet small" data-select-login="${esc(login.id)}"><strong>${esc(login.name)}</strong></button>${login.isDefault ? `<span class="default-badge">${esc(uiText('Default'))}</span>` : ''}<small>${esc(loginHealthLine(login))}${reviewerLoginLine(login)} · ${login.enabled ? uiText('Enabled in AMCP') : uiText('Choose assets')}${login.duplicateOf ? ' · ' + esc(uiText('Same identity as another login')) : ''}</small></div><div class="actions"><button class="button small" data-sync="${esc(login.id)}">${esc(uiText('↻ Sync'))}</button>${login.reauthorizeAvailable ? `<button class="button small ${login.status === 'reauthorization_required' ? 'primary' : ''}" data-reauthorize="${esc(login.id)}">${esc(uiText('Reauthorize'))}</button>` : ''}${!login.isDefault && login.enabled ? `<button class="button small" data-default="${esc(login.id)}">${esc(uiText('Make default'))}</button>` : ''}<button class="button small danger" data-disconnect="${esc(login.id)}" aria-label="${esc(uiText('Disconnect {name}', {name: login.name}))}">↗</button></div></div>`).join('') || `<div class="empty"><strong>${esc(uiText('No logins connected'))}</strong>${esc(uiText('Connect your account to discover its advertising assets.'))}</div>`}</div>${renderDefaultPrompt(p)}${c ? `${renderLoginIdentity(c)}${renderCredentialHealth(c)}${renderGrantedPermissions(c)}${renderConnectionSyncStatus(c)}${renderAccessChecks(p, c)}${renderGoogleAuthorization(c)}<div class="notice asset-notice"><span>✓</span><p>${esc(uiText('Select'))} ${esc(uiText(labels[p.selectionKind] ?? p.selectionKind ?? 'Resources').toLowerCase())} ${esc(uiText('to grant MCP access to their data. Other tabs show related asset inventory. Saving this selection changes AMCP access only.'))}</p></div>${session.writesEnabled && p.reviewedWrites !== false ? `<label class="form-note"><input type="checkbox" id="selection-write-access" ${c.defaultWriteAccess ? 'checked' : ''}> ${esc(uiText('Enable read + reviewed write access for all selected resources'))}</label>` : ''}${p.reviewedWrites === false ? '' : writeAccessPanel(c)}<div class="asset-tabs" role="group" aria-label="${esc(uiText('Asset types'))}">${p.assetKinds.map(k => `<button data-asset-kind="${k}" class="${assetKind === k ? 'active' : ''}">${esc(uiText(labels[k] ?? k))} <span class="asset-count">${c.groups.find(g => g.kind === k)?.assets.length ?? '—'}</span></button>`).join('')}</div><div class="asset-toolbar"><label class="search"><span>⌕</span><input id="asset-search" type="search" value="${esc(assetSearch)}" placeholder="${esc(uiText('Search {kind}…', {kind: uiText(labels[assetKind] ?? assetKind)}))}" aria-label="${esc(uiText('Search assets'))}"></label><button class="button small" data-sync-kind="${assetKind}">${esc(uiText('↻ Sync this tab'))}</button></div>${renderAssetSyncDiagnostics(group)}<div id="asset-rows">${assetRows(assets, group)}</div>` : ''}</div><div class="manage-footer"><span class="muted small-text">${esc(c ? uiText('Last sync: {date}', {date: date(c.lastSync)}) : uiText('Your provider opens in a secure authorization flow.'))}</span>${c && selectableKind(assetKind) ? `<div class="platform-actions"><button class="button small" data-select-all="true">${esc(uiText('Select visible'))}</button><button class="button primary" data-save-assets="true">${esc(uiText('Save selection'))}</button>${p.accountRead ? `<button class="button" data-save-assets="check">${esc(uiText('Save and check access'))}</button>` : ''}</div>` : ''}</div>`;
}
/**
 * The resources a selection save would newly enable for writes, as display names, mirroring the server rule: with the
 * read + reviewed write option every selected resource has write access, otherwise only existing grants stay.
 */
function selectionWriteAdditions(p, c, writeOption) {
  if (!p || !c || !session.writesEnabled || p.reviewedWrites === false) return [];
  const kinds = p.selectableKinds ?? [p.selectionKind ?? 'ad_accounts'],
    accounts = [...selected]
      .map(key => {
        const kind = kinds.find(k => key.startsWith(k + ':'));
        return kind ? key.slice(kind.length + 1) : undefined;
      })
      .filter(Boolean),
    previous = (c.writeAccounts ?? []).filter(id => c.accounts.includes(id)),
    writes = (writeOption ?? c.defaultWriteAccess === true) ? accounts : writeOption === false ? [] : previous;
  return writes
    .filter(id => !previous.includes(id))
    .map(id => {
      const asset = c.groups.flatMap(g => g.assets).find(a => a.id === id);
      return asset && asset.name !== id ? asset.name + ' · ' + id : id;
    });
}
function writeAccessPanel(c) {
  // Every selectable kind names its resources (Business Profile locations and accounts, CON-06), ad accounts first.
  const assets = [...(c.groups.find(g => g.kind === 'ad_accounts')?.assets ?? []), ...c.groups.flatMap(g => g.assets)];
  return `<section class="panel consent-panel"><h3>${esc(uiText('Resource write access'))}</h3><p>${session.writesEnabled ? uiText('Operator connectors may change only the selected accounts you explicitly enable below. Each change still requires a reviewed request through amcp_write.') : uiText('Write support is disabled in this deployment. You can revoke existing account grants below.')}</p>${c.accounts.length ? c.accounts.map(id => `<label class="token-row"><span>${esc(assets.find(a => a.id === id)?.name ?? id)}<small>${esc(id)}</small></span><input type="checkbox" data-write-account="${esc(id)}" aria-label="${esc(uiText('Allow writes to {id}', {id}))}" ${writeSelected.has(id) ? 'checked' : ''} ${!session.writesEnabled ? 'disabled' : ''}></label>`).join('') : `<p class="muted">${esc(uiText('Save a resource selection before granting write access.'))}</p>`}${session.writesEnabled && c.accounts.length ? `<label class="form-note"><input type="checkbox" id="confirm-write-access"> ${esc(uiText('I authorize operator connectors to change the checked resources.'))}</label>` : ''}<div class="dialog-actions">${c.writeAccounts?.length ? `<button class="button danger" data-revoke-write-access="true">${esc(uiText('Revoke all write access'))}</button>` : ''}${session.writesEnabled && c.accounts.length ? `<button class="button" data-save-write-access="true">${esc(uiText('Save write access'))}</button>` : ''}</div></section>`;
}
function assetRows(assets, group) {
  // DV360 discovers advertisers through partners: an empty list names the user profile to set up (CON-04).
  if (!assets.length && group?.complete && currentPlatform === 'dv360')
    return `<div class="empty"><strong>${esc(uiText('No Display & Video 360 advertisers found'))}</strong>${esc(uiText('AMCP lists advertisers through the partners this Google identity can access. Ask a Display & Video 360 administrator to give it a user profile with Admin, Standard or Read only access to the partner or advertiser, keep the Display & Video 360 permission granted at sign-in, then sync again.'))}</div>`;
  if (!assets.length)
    return `<div class="empty"><strong>${group?.complete ? uiText('No assets found') : group ? uiText('No assets available') : uiText('This tab has not been synced')}</strong>${group?.complete ? uiText('The provider returned an empty list for this login.') : uiText('Sync this tab to load the assets your login can access.')}</div>`;
  return `<table class="asset-table"><thead><tr><th scope="col" aria-label="${esc(uiText('Select'))}"></th><th scope="col">${esc(uiText(labels[assetKind] ?? assetKind))}</th><th scope="col">${esc(uiText('Access'))}</th></tr></thead><tbody>${assets.map(a => `<tr><td>${selectableKind(assetKind) ? `<input type="checkbox" data-asset-key="${esc(a.kind + ':' + a.id)}" aria-label="${esc(uiText('Select {name}', {name: a.name}))}" ${selected.has(a.kind + ':' + a.id) ? 'checked' : ''}>` : ''}</td><td>${uiBidi(a.name)}<small>${uiBidi(a.id, 'ltr')}${a.currency ? ' · ' + uiBidi(a.currency, 'ltr') : ''}${currentPlatform === 'google' ? googleAssetLabel(a) : ''}${a.source === 'configured_binding' ? ' · ' + esc(uiText('locally configured')) : ''}</small></td><td><span class="status ${selected.has(a.kind + ':' + a.id) ? 'online' : 'offline'}">${selectableKind(assetKind) ? (selected.has(a.kind + ':' + a.id) ? uiText('Selected') : uiText('Available')) : uiText('Inventory')}</span></td></tr>`).join('')}</tbody></table>`;
}
function openManage(id, connectionId) {
  if (!requireLogin()) return;
  currentPlatform = id;
  const p = platforms.find(p => p.id === id);
  assetKind = p.selectionKind ?? 'ad_accounts';
  currentConnection = connectionId ?? p.connections.find(c => c.isDefault)?.id ?? p.connections[0]?.id ?? null;
  selected = new Set(p.connections.find(c => c.id === currentConnection)?.selected ?? []);
  writeSelected = new Set(p.connections.find(c => c.id === currentConnection)?.writeAccounts ?? []);
  assetSearch = '';
  renderManage();
  if (!$('#manage-dialog').open) $('#manage-dialog').showModal();
}
/**
 * An Operations item for a login that needs reauthorization or is turned off links to `/connections?connection_id=`
 * (OPS-06): open that login's Manage view, where it is reauthorized in place or turned on. Only a login this workspace
 * lists opens; the link is then cleared so a refresh does not reopen it.
 */
function openLinkedConnection() {
  const id = new URLSearchParams(location.search).get('connection_id');
  if (!id || !session.authenticated) return;
  const p = platforms.find(p => p.connections.some(c => c.id === id));
  history.replaceState(null, '', '/connections');
  if (p) openManage(p.id, id);
  else toast(uiText('That connection is no longer in this workspace.'));
}
async function startConnection(id) {
  if (!requireLogin()) return;
  const p = platforms.find(p => p.id === id);
  if (!p.configured) {
    if ($('#manage-dialog').open) $('#manage-dialog').close();
    navigate('/settings#' + id);
    toast(
      session.administrator
        ? uiText('Add the {platform} app credentials to your server environment to enable Connect.', {platform: p.name})
        : uiText('This platform needs setup by the site administrator. Your existing connections remain available.'),
    );
    return;
  }
  const result = await api('/api/auth/' + id + '/start', {method: 'POST', body: '{}'});
  location.assign(result.url);
}
async function refresh() {
  const data = await api('/api/platforms');
  platforms = data.platforms;
  commerceSources = data.commerce_sources ?? [];
  const c = platforms.find(p => p.id === currentPlatform)?.connections.find(c => c.id === currentConnection);
  if (c) {
    selected = new Set(c.selected ?? []);
    writeSelected = new Set(c.writeAccounts ?? []);
  }
  await render();
  if ($('#manage-dialog').open) renderManage();
}
function connectorCode() {
  const url = session.origin + '/mcp';
  if (client === 'codex') return `[mcp_servers.amcp]\nurl = "${url}"\nbearer_token_env_var = "AMCP_MCP_TOKEN"`;
  if (client === 'cursor')
    return JSON.stringify(
      {mcpServers: {amcp: {url, headers: {Authorization: 'Bearer ${env:AMCP_MCP_TOKEN}'}}}},
      null,
      2,
    );
  return JSON.stringify(
    {url, transport: 'streamable-http', headers: {Authorization: 'Bearer <your AMCP connector token>'}},
    null,
    2,
  );
}
async function renderConnectors() {
  if (session.authenticated) {
    try {
      tokens = (await api('/api/connector-tokens')).tokens;
      const authorizations = await api('/api/mcp/authorizations');
      oauthClients = authorizations.clients;
      oauthEnded = authorizations.ended ?? [];
    } catch (e) {
      toast(e.message);
    }
  } else {
    tokens = [];
    oauthClients = [];
    oauthEnded = [];
  }
  // MCP-08: every member may connect their own AI tools, capped by role. Owners and administrators manage every
  // token and client of the workspace; a member revokes their own.
  const viewer = session.workspaceRole === 'viewer',
    manages = item =>
      session.administrator === true || ['owner', 'admin'].includes(session.workspaceRole) || item.yours,
    endedReason = reason =>
      ({
        refresh_replay: uiText('Ended: a refresh token was reused'),
        code_replay: uiText('Ended: an authorization code was reused'),
        client_revoke: uiText('Ended: the app revoked its access'),
        workspace_revoke: uiText('Ended: revoked in AMCP'),
        membership_change: uiText('Ended: workspace membership changed'),
        password_change: uiText('Ended: the account password changed'),
        email_change: uiText('Ended: the account email changed'),
        mfa_change: uiText('Ended: two-step verification changed'),
        account_access_revoked: uiText('Ended: account access was removed'),
        owner_migration: uiText('Ended: the workspace moved to its owner account'),
        door_password_change: uiText('Ended: the administrator password changed'),
        restore_quarantine: uiText('Ended: AMCP was restored from a backup'),
      })[reason] ?? uiText('Ended');
  content.innerHTML =
    header(uiText('AI connectors'), uiText('Give your AI tools access to the accounts you select.')) +
    `<section class="connector-hero"><div><span class="status online"><i></i>${session.writesEnabled ? uiText('Write support enabled') : uiText('Read-only deployment')}</span><h2 class="connector-title">${esc(uiText('Your workspace.'))}<br>${esc(uiText('In the tools you already use.'))}</h2><p>${session.writesEnabled ? uiText('Connect your AI tools for reporting and reviewed advertising changes. New connections default to read and reviewed write access.') : uiText('Connect Codex or another MCP client to read advertising data and prepare dry-run requests.')}</p></div><div class="endpoint-box"><small>${esc(uiText('AMCP MCP ENDPOINT'))}</small><div class="copy-row"><code>${esc(session.origin + '/mcp')}</code><button class="button small" data-copy-endpoint="true">${esc(uiText('Copy'))}</button></div></div></section><section class="panel consent-panel"><h2>${esc(uiText('Connect with browser authorization'))}</h2><p>${esc(uiText('In an MCP client that supports OAuth, add the endpoint above and choose Sign in. AMCP requests read and reviewed write access when enabled.'))} ${session.writesEnabled ? `${esc(uiText('New clients default to'))} <code>mcp:read mcp:write</code>${esc(uiText('; the consent screen identifies operator access. Clients can explicitly request'))} <code>mcp:read</code> ${esc(uiText('for read-only access. Existing reader authorizations stay read-only until reauthorized.'))} ${esc(uiText('On the consent screen you can also choose read-only access. Viewers can approve read-only access only.'))}` : uiText('Advertising writes are disabled in this deployment.')}</p><pre class="code-block">codex mcp add amcp --url ${esc(session.origin + '/mcp')}
codex mcp login amcp</pre><p class="muted">${esc(uiText('For clients using a bearer token, follow the setup below.'))}</p></section><section class="panel"><div class="panel-header"><h2>${esc(uiText('Connect with a token'))}</h2><span class="status">${esc(uiText('Streamable HTTP'))}</span></div><div class="client-tabs"><button class="client-tab ${client === 'codex' ? 'active' : ''}" data-client="codex">${esc(uiText('Codex'))}</button><button class="client-tab ${client === 'cursor' ? 'active' : ''}" data-client="cursor">${esc(uiText('Cursor'))}</button><button class="client-tab ${client === 'other' ? 'active' : ''}" data-client="other">${esc(uiText('Other MCP client'))}</button></div><div class="steps"><div class="step"><div><strong>${esc(uiText('Create a connector token'))}</strong><p class="muted">${esc(uiText('Create a separate token for each tool. Tokens expire after 30 days and can be revoked below.'))}</p></div></div><div class="step"><div><strong>${esc(uiText('Add your token to the tool’s environment'))}</strong><p class="muted">${esc(uiText('Use the environment variable'))} <code>AMCP_MCP_TOKEN</code>${esc(uiText('. Keep the value private.'))}</p></div></div><div class="step"><div class="step-content"><div class="copy-row"><strong>${client === 'codex' ? uiText('Add this to your Codex config.toml') : client === 'cursor' ? uiText('Add this to your Cursor MCP configuration') : uiText('Configure your MCP client')}</strong><button class="button small" data-copy-config="true">${esc(uiText('Copy config'))}</button></div><pre class="code-block">${esc(connectorCode())}</pre><p class="muted">${client === 'codex' ? uiText('Reload your MCP connections, then ask Codex to list the tools available from AMCP.') : uiText('Use a client that supports Streamable HTTP and bearer authentication.')}</p></div></div></div></section><section class="panel"><div class="panel-header"><div><h2>${esc(uiText('Connector tokens'))}</h2><span class="muted token-caption">${esc(uiText('Access follows your current AMCP asset selections.'))}</span></div>${session.authenticated ? `<button class="button" data-create-token="true">${esc(uiText('Create read-only token'))}</button>` : `<a class="button" href="/login">${esc(uiText('Sign in to create a token'))}</a>`}</div>${session.writesEnabled && session.authenticated && !viewer ? `<div class="consent-panel"><p><strong>${esc(uiText('Read + write (default)'))}</strong> ${esc(uiText('Create an operator token for your selected resources, then use'))} <code>amcp_write</code> ${esc(uiText('to prepare and review a change before executing it.'))}</p><label class="form-note"><input type="checkbox" id="operator-token-consent"> ${esc(uiText('I authorize this connector to execute reviewed changes on accounts with write access.'))}</label><p><button class="button primary" data-create-operator-token="true">${esc(uiText('+ Create read + write token'))}</button></p></div>` : ''}<div id="new-token"></div>${tokens.map(t => `<div class="token-row"><div><strong>${uiBidi(t.name)}</strong><small>${t.role === 'operator' ? uiText('Operator · reviewed writes') : uiText('Reader')} ${esc(uiText('· Created'))} ${esc(uiDateZoned(t.createdAt))} ${esc(uiText('· Expires'))} ${esc(uiDateZoned(t.expiresAt))}</small></div>${t.revoked ? `<span class="status offline">${esc(uiText('Revoked'))}</span>` : manages(t) ? `<button class="button small danger" data-revoke-token="${esc(t.id)}">${esc(uiText('Revoke'))}</button>` : ''}</div>`).join('') || `<div class="empty">${session.authenticated ? uiText('No connector tokens yet.') : uiText('Sign in to create and manage connector tokens.')}</div>`}</section><section class="panel"><div class="panel-header"><h2>${esc(uiText('Authorized MCP clients'))}</h2></div>${oauthClients.map(c => `<div class="token-row"><div><strong>${uiBidi(c.name)}</strong><small>${c.role === 'operator' ? uiText('Operator · reviewed writes') : uiText('Reader')} ${esc(uiText('· Authorization expires'))} ${esc(uiDateZoned(c.expiresAt))}${c.ownerName ? ` ${esc(uiText('· Approved by'))} ${uiBidi(c.ownerName)}` : ''}</small></div>${manages(c) ? `<button class="button small danger" data-revoke-client="${esc(c.id)}"${'owner' in c ? ` data-revoke-owner="${esc(c.owner ?? '')}"` : ''}>${esc(uiText('Revoke access'))}</button>` : ''}</div>`).join('') || `<div class="empty">${esc(uiText('No clients authorized through browser sign-in.'))}</div>`}${oauthEnded.length ? `<h3>${esc(uiText('Recently ended connections'))}</h3>${oauthEnded.map(c => `<div class="token-row"><div><strong>${uiBidi(c.name)}</strong><small>${esc(endedReason(c.reason))} · ${esc(uiDateZoned(c.endedAt))}${c.ownerName ? ` ${esc(uiText('· Approved by'))} ${uiBidi(c.ownerName)}` : ''}</small></div></div>`).join('')}` : ''}</section><p class="muted small-text">${esc(uiText('Codex configuration follows'))} <a href="https://learn.chatgpt.com/docs/extend/mcp?surface=cli" target="_blank" rel="noreferrer">${esc(uiText('official OpenAI documentation ↗'))}</a>.</p>`;
}
function renderSettings() {
  if (session.authenticated && !session.administrator) {
    content.innerHTML =
      header(uiText('Workspace settings'), uiText('A few thoughtful details make this space yours.')) +
      `<section class="panel"><h2>${esc(uiText('Your account & security'))}</h2><p>${esc(uiText('Edit your profile, personalize your workspace name, link social accounts, and manage browser sessions.'))}</p><a class="button primary" href="/account">${esc(uiText('Manage your account →'))}</a></section><section class="panel"><h2>${esc(uiText('Connected platforms'))}</h2><p>${esc(uiText('Choose the accounts your workspace can access, refresh assets, and manage permissions.'))}</p><a class="button" href="/connections">${esc(uiText('Manage connections'))}</a></section>`;
    return;
  }
  content.innerHTML =
    header(uiText('Workspace settings'), uiText('Register AMCP with your advertising and measurement platforms.')) +
    `<div class="notice"><span>◈</span><p><strong>${esc(uiText('Keep provider secrets on the server.'))}</strong><br>${esc(uiText('Add API credentials to your server environment. Register each browser OAuth callback exactly as shown below.'))}</p></div><div class="settings-grid">` +
    platforms
      .map(p => {
        const apple = p.authType === 'client_credentials',
          googleMeasurement = ['ga4', 'gtm', 'gsc'].includes(p.id);
        const variables = apple
          ? `AMCP_APPLE_CLIENT_ID<br>AMCP_APPLE_TEAM_ID<br>AMCP_APPLE_KEY_ID<br>AMCP_APPLE_PRIVATE_KEY`
          : 'AMCP_' +
            p.env +
            `_CLIENT_ID<br>AMCP_` +
            p.env +
            '_CLIENT_SECRET' +
            (p.id === 'google_business' ? '<br>AMCP_GBP_API_APPROVED' : '');
        return (
          `<section class="panel" id="` +
          esc(p.id) +
          `"><div class="panel-header"><div class="platform-identity">` +
          logo(p) +
          `<h2>` +
          esc(p.name) +
          `</h2></div><span class="status ` +
          (p.configured ? 'online' : 'attention') +
          '">' +
          (p.configured ? uiText('Configured') : uiText('Setup needed')) +
          `</span></div><div class="setting-field"><label>${esc(uiText('APP NAME'))}</label><strong>AMCP</strong></div><div class="setting-field"><label>` +
          (apple ? uiText('CONNECTION METHOD') : uiText('REDIRECT / CALLBACK URI')) +
          `</label>` +
          (apple
            ? `<p>${esc(uiText('Server-side Apple Ads API credentials. No browser callback is required.'))}</p>`
            : `<div class="copy-row"><code>` +
              esc(p.callback) +
              `</code><button class="button small" data-copy-callback="` +
              esc(p.id) +
              `">${esc(uiText('Copy'))}</button></div>`) +
          `</div><div class="setting-field"><label>${esc(uiText('SERVER VARIABLES'))}</label><code>` +
          variables +
          `</code></div><div class="setting-field"><label>${esc(uiText('REQUESTED PERMISSIONS'))}</label><code>` +
          esc(p.scopes.join(', ') || uiText('Configure permissions in the provider app')) +
          `</code></div>` +
          (googleMeasurement
            ? `<p class="form-note">${esc(uiText('You may reuse AMCP_GOOGLE_CLIENT_ID and AMCP_GOOGLE_CLIENT_SECRET when both dedicated variables are unset. Enable this product’s API in Google Cloud and register its separate callback. Each connection has its own tokens and selected resources.'))}</p>`
            : '') +
          (p.id === 'google_business'
            ? `<p class="form-note">${esc(uiText('Google approves each Cloud project for the Business Profile APIs separately; a quota of 0 requests per minute means it has not approved yours yet. After approval, set AMCP_GBP_API_APPROVED=true to connect with AMCP_GOOGLE_CLIENT_ID and AMCP_GOOGLE_CLIENT_SECRET, or set the dedicated variables. Enable the Business Profile APIs and register this callback in that project.'))}</p>`
            : '') +
          (apple
            ? `<p class="form-note">${esc(uiText('Upload the matching P-256 public key in Apple Ads API settings, then store the private PEM key only in Railway. AMCP signs short-lived client secrets and renews access tokens automatically. A pre-generated AMCP_APPLE_CLIENT_SECRET is also supported, but you must replace it before it expires.'))}</p>`
            : '') +
          (p.reviewedWrites === false
            ? `<p class="form-note">${esc(uiText('This connection enables provider reads and asset discovery. Reviewed live mutations are not enabled for this provider.'))}</p>`
            : '') +
          (p.id === 'tiktok'
            ? `<p class="form-note">${esc(uiText('Use the callback parameter from your developer portal. AMCP_TIKTOK_REDIRECT_PARAMETER accepts redirect_uri or redirect_url. Marketing API long-term tokens require reauthorization if revoked; consumer TikTok token endpoints are not used.'))}</p>`
            : '') +
          (p.id === 'meta'
            ? `<p class="form-note">${esc(uiText('AMCP exchanges the initial user token for a long-lived token and records Meta’s actual expiry. Use your own approved Meta app. Configure AMCP_META_LONG_LIVED_TOKEN=false only for a separately documented token type that does not support this exchange.'))}</p>`
            : '') +
          `</section>`
        );
      })
      .join('') +
    `</div>`;
}
async function renderActivity() {
  content.innerHTML = header(
    uiText('Audit activity'),
    uiText('Account activity and your workspace events, within current access.'),
  );
  if (!session.authenticated) {
    content.innerHTML += `<div class="empty">${esc(uiText('Sign in to view workspace activity.'))}</div>`;
    return;
  }
  const generation = navigationGeneration,
    identity = identityGeneration;
  const initial = await api('/api/activity');
  if (generation !== navigationGeneration || identity !== identityGeneration) return;
  const rows = result =>
    `${
      result.events
        .map(
          e =>
            `<article class="activity-entry"><div class="token-row"><div><strong>${esc(String(e.event.event ?? uiText('Workspace request')).replaceAll('_', ' '))}</strong><small>${
              [e.event.gateway ?? e.event.platform, e.event.account_id, e.event.connection_id]
                .filter(Boolean)
                .map(value => uiBidi(value, 'ltr'))
                .join(' · ') || esc(uiText('AMCP workspace'))
            }</small></div><span class="muted">${esc(uiDateZoned(e.at))}</span></div>${e.event.action ? `<p>${esc(e.event.action)}</p>` : ''}${e.event.request_id ? `<p class="form-note">${esc(uiText('Request reference'))}: <code>${esc(e.event.request_id)}</code></p>` : ''}${e.event.error ? `<details class="activity-failure" open><summary>${esc(e.event.error.code ?? uiText('Request failed'))}</summary>${(e.diagnostics ?? []).length ? e.diagnostics.map(d => renderSourceDiagnostic(d)).join('') : `<p>${esc(uiText('Inspect the original work for more details.'))}</p>`}</details>` : ''}</article>`,
        )
        .join('') ||
      `<div class="empty">${esc(uiText('No accessible events on this page. Continue if another page is available.'))}</div>`
    }`;
  let page = 0,
    next = initial.next_cursor ?? null,
    cursors = [undefined],
    filters = {},
    sequence = 0;
  const markup = result =>
    rows(result) +
    `<p id="activity-status" role="status">${esc(next ? uiText('More results are available.') : uiText('End of available results.'))}</p><nav class="dialog-actions" aria-label="${esc(uiText('Activity pages'))}"><button id="activity-prev" class="button small" ${page ? '' : 'disabled'}>${esc(uiText('Previous'))}</button><span>${esc(uiText('Page'))} ${page + 1}</span><button id="activity-next" class="button small" ${next ? '' : 'disabled'}>${esc(uiText('Next'))}</button></nav>`;
  content.innerHTML += `<p class="notice">${esc(uiText('This history shows retained AMCP event metadata. Request bodies and receipts are omitted. Refresh to include newer events.'))}</p><form id="activity-filter" class="panel work-filter"><label>${esc(uiText('Search event, action or request reference'))}<input type="search" name="search" maxlength="200"></label><label>${esc(uiText('Account ID'))}<input name="account_id" maxlength="200"></label><button type="submit" class="button primary">${esc(uiText('Apply filters'))}</button><button type="button" id="activity-refresh" class="button">${esc(uiText('Refresh'))}</button></form><section class="panel" id="activity-results" aria-label="${esc(uiText('Activity results'))}">${markup(initial)}</section>`;
  const root = $('#activity-results'),
    form = $('#activity-filter');
  const current = () =>
    generation === navigationGeneration && identity === identityGeneration && root.isConnected && form.isConnected;
  const bind = () => {
    workspaceBind('#activity-prev', () => (page > 0 ? load(page - 1) : undefined));
    workspaceBind('#activity-next', () => (next ? load(page + 1) : undefined));
  };
  const load = async (index = 0, reset = false) => {
    if (!current()) return;
    const attempt = ++sequence,
      cursor = reset ? undefined : index === page + 1 ? next : cursors[index];
    const query = new URLSearchParams({...filters, ...(cursor ? {cursor} : {})});
    const active = () => attempt === sequence && current();
    root.setAttribute('aria-busy', 'true');
    try {
      const result = await api('/api/activity' + (query.size ? '?' + query : ''));
      if (!active()) return;
      if (reset) cursors = [undefined];
      else cursors[index] = cursor;
      page = index;
      next = result.next_cursor ?? null;
      root.innerHTML = markup(result);
      bind();
    } catch (e) {
      if (active()) $('#activity-status').textContent = uiText('Could not load this page.') + ' ' + errorMessage(e);
    } finally {
      if (active()) root.setAttribute('aria-busy', 'false');
    }
  };
  bind();
  workspaceBind('#activity-refresh', () => load(0, true));
  workspaceBind('#activity-filter', async () => {
    if (!current()) return;
    filters = Object.fromEntries(
      ['search', 'account_id'].map(k => [k, form.elements[k].value.trim()]).filter(([, v]) => v),
    );
    await load(0, true);
  });
  form.addEventListener('input', () => {
    if (current()) {
      sequence++;
      root.setAttribute('aria-busy', 'false');
    }
  });
}
/**
 * The provider callback could not be accepted before any login was saved (CON-05). Only these fixed codes are shown;
 * nothing from the address other than a known platform ID is displayed.
 */
function renderCallbackRefusal(code, platformId) {
  const p = platforms.find(x => x.id === platformId),
    signIn = !session.authenticated,
    text = uiText(
      code === 'SIGN_IN_REQUIRED'
        ? 'Your AMCP session ended before the provider returned. Nothing was saved. Sign in, then start the connection again from Connections.'
        : code === 'FORBIDDEN'
          ? 'Only a workspace administrator can complete a platform connection. Nothing was saved. Sign in as an administrator and start again.'
          : code === 'OAUTH_STATE_INVALID'
            ? 'This authorization expired or was already used. Authorizations last 10 minutes and finish only in the browser session that started them. Nothing was saved. Start again from Connections.'
            : 'The provider returned an unexpected response. Nothing was saved. Start again from Connections.',
    );
  content.innerHTML = `<div class="callback-layout"><div class="callback-card" role="alert"><div class="callback-top"><div class="brand"><img src="${publicAssetUrl('/assets/mark.svg')}" width="34" height="34" alt=""><span>AMCP</span></div><h1>${esc(p ? uiText('{platform} was not connected.', {platform: p.name}) : uiText('The platform was not connected.'))}</h1><p>${esc(text)}</p></div><div class="callback-bottom">${signIn ? `<a href="/login" class="button primary">${esc(uiText('Sign in'))}</a>` : `<a href="/connections" class="button primary">${esc(uiText('Start again'))}</a>`}</div></div></div>`;
}
/** A new login of an identity that is already connected (CON-05): renewing the existing login keeps its work. */
function renderDuplicateLogin(result) {
  const existing = result.duplicateOf
    ? platforms.find(p => p.id === result.platform)?.connections.find(c => c.id === result.duplicateOf)
    : undefined;
  if (!existing) return '';
  return `<div class="notice" role="status"><div><strong>${esc(uiText('This identity is already connected'))}</strong><p>${esc(uiText('The same provider identity is also saved as {name}. To renew that login and keep its selections, saved reports and schedules, reauthorize it instead, then disconnect this new login.', {name: existing.name}))}</p>${existing.reauthorizeAvailable ? `<p><button class="button small" data-reauthorize="${esc(existing.id)}">${esc(uiText('Reauthorize existing'))}</button></p>` : ''}</div></div>`;
}
async function renderCallback() {
  const params = new URLSearchParams(location.search),
    refusal = params.get('error');
  if (refusal && !params.get('attempt')) return renderCallbackRefusal(refusal, params.get('platform'));
  const id = params.get('attempt');
  let result;
  try {
    result = id ? await api('/api/oauth/progress/' + encodeURIComponent(id)) : null;
  } catch (e) {
    content.innerHTML =
      header(uiText('Connection needs attention'), esc(e.message)) +
      `<a href="/connections" class="button primary">${esc(uiText('Back to connections'))}</a>`;
    return;
  }
  if (!result) {
    content.innerHTML =
      header(uiText('Connection not found'), uiText('Start a connection from your AMCP workspace.')) +
      `<a href="/connections" class="button primary">${esc(uiText('Back to connections'))}</a>`;
    return;
  }
  const p = platforms.find(p => p.id === result.platform),
    done = result.state === 'complete',
    failed = result.state === 'failed' || result.state === 'sync_attention';
  content.innerHTML = `<div class="callback-layout"><div class="callback-card"><div class="callback-top"><div class="brand"><img src="${publicAssetUrl('/assets/mark.svg')}" width="34" height="34" alt=""><span>AMCP</span></div><h1>${done ? uiText('You’re connected.') : failed ? uiText('A little attention needed.') : esc(uiText('Connecting {platform}.', {platform: p?.name ?? uiText('your platform')}))}</h1><p>${esc(result.message ?? (done ? uiText('Your login is secured. Choose the assets to make available in AMCP.') : uiText('Securing your connection and discovering workspace assets.')))}</p></div><div class="callback-steps">${[
    [
      'authorization',
      p?.authType === 'client_credentials'
        ? uiText('API credentials verified')
        : uiText('Approve on {platform}', {platform: p?.name ?? uiText('the provider')}),
      uiText('Provider authorization'),
    ],
    ['exchange', uiText('Secure connection'), uiText('Encrypted credential storage')],
    ['sync', uiText('Sync workspace assets'), uiText('Available advertising assets')],
  ]
    .map(
      ([key, title, sub], i) =>
        `<div class="callback-step ${result[key] ? 'done' : failed ? 'failed' : ''}"><span class="step-number">${result[key] ? '✓' : i + 1}</span><div>${esc(title)}<small>${esc(sub)}</small></div></div>`,
    )
    .join(
      '',
    )}</div>${(result.diagnostics ?? []).length ? `<div class="reauthorization-errors">${result.diagnostics.map(d => renderSourceDiagnostic(d)).join('')}</div>` : ''}${renderDuplicateLogin(result)}<div class="callback-bottom"><a href="/connections" class="muted">${esc(uiText('Back to connections'))}</a>${result.connectionId ? `<button class="button primary" data-callback-manage="${esc(result.platform)}" data-connection-id="${esc(result.connectionId)}">${esc(uiText('Choose assets →'))}</button>` : `<a href="/connections" class="button">${esc(uiText('Try again'))}</a>`}</div></div></div>`;
  if (!done && !failed) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(renderCallback, 1500);
  }
}
// Privacy, Terms and Data deletion are complete static pages that need no session or JavaScript (WEB-02). A view that
// still reaches one of them in the workspace opens the static page in the interface language.
function renderLegal() {
  const target = location.pathname + '?lang=' + uiLocale;
  if (location.pathname + location.search !== target) return location.replace(target);
  // A stale shell already at the static address: no reload loop, and no empty view either. target="_self" opens the
  // static page itself instead of the client router (WEB-02 review).
  content.innerHTML = `<section class="panel"><p><a class="button primary" href="${esc(target)}" target="_self">${esc(uiText('Open this page'))}</a></p></section>`;
}
async function renderConsent() {
  if (!session.authenticated) {
    content.innerHTML =
      header(uiText('Authorize an MCP client'), uiText('Sign in to review this access request.')) +
      `<button class="button primary" data-action="login">${esc(uiText('Sign in'))}</button>`;
    return;
  }
  const request = new URLSearchParams(location.search).get('request');
  const info = await api('/api/mcp/consent?request=' + encodeURIComponent(request ?? ''));
  // MCP-08: the workspace is named above the decision, the return host is shown large, and the member chooses read only
  // or read and reviewed changes within what the app asked for and their role allows. Write stays the default choice.
  const choices = info.choices ?? [info.scope],
    write = choices.includes('mcp:read mcp:write'),
    option = (scope, title, text, checked) =>
      `<label class="consent-choice"><input type="radio" name="consent-scope" value="${esc(scope)}" ${checked ? 'checked' : ''}><span><strong>${esc(title)}</strong><small>${esc(text)}</small></span></label>`;
  content.innerHTML =
    header(
      esc(uiText('Authorize {name}', {name: info.name})),
      uiText('Review the tool requesting access to your workspace.'),
    ) +
    `<section class="panel consent-panel"><span class="eyebrow">${esc(uiText('WORKSPACE'))}</span><h2>${esc(info.workspace?.name ?? uiText('AMCP workspace'))}</h2><p>${esc(uiText('After you decide, AMCP returns you to:'))}</p><p class="consent-host"><strong>${esc(info.redirectHost ?? '')}</strong></p>${info.loopback ? `<p class="notice" role="note">${esc(uiText('This app receives the result on this computer (a loopback address). Approve only if you started this connection from an app on this device.'))}</p>` : ''}<p class="muted">${esc(uiText('The name “{name}” is provided by the app and is not verified by AMCP.', {name: info.name}))}${info.clientMetadataHost ? ' ' + esc(uiText('The app identifies itself with a metadata document that AMCP fetched from {host}.', {host: info.clientMetadataHost})) : ''}</p><fieldset class="consent-choices"><legend>${esc(uiText('Access to grant'))}</legend>` +
    (write
      ? option(
          'mcp:read mcp:write',
          uiText('Read and change enabled advertising accounts'),
          uiText(
            'This tool receives operator access. It can read your selected accounts and execute reviewed changes through amcp_write on accounts you explicitly enable for writes. Changes may affect campaign delivery or spend.',
          ),
          true,
        )
      : '') +
    option(
      'mcp:read',
      uiText('Read your selected advertising accounts'),
      uiText(
        'This tool can read data available through your current AMCP account selections and prepare local dry runs. It cannot change your advertising accounts.',
      ),
      !write,
    ) +
    `</fieldset>${info.capped ? `<p class="notice" role="note">${esc(uiText('The app asked for reviewed changes too. Your workspace role allows read-only access, so it receives read access only.'))}</p>` : ''}<details><summary>${esc(uiText('Return address:'))}</summary><code>${esc(info.redirectUri)}</code></details><p>${esc(uiText('Requested permission:'))} <code>${esc(info.requestedScope ?? info.scope)}</code></p><div class="dialog-actions"><button class="button" data-consent="deny">${esc(uiText('Cancel'))}</button><button class="button primary" data-consent="approve">${esc(uiText('Authorize access'))}</button></div></section>`;
}
/**
 * What this person can do here, from their role and the deployment together (WEB-06). Before, the line showed only the
 * deployment's write switch, so a viewer read "Read + reviewed writes". The server still decides every request.
 */
function accessLine(s) {
  if (!s?.authenticated) return uiText('Not signed in');
  if (s.testAccount) return uiText('Test workspace · read access');
  const role = s.administrator ? uiText('Deployment administrator') : s.workspaceRole ? uiRole(s.workspaceRole) : '';
  if (s.workspaceRole === 'viewer' || (!s.administrator && !['owner', 'admin', 'operator'].includes(s.workspaceRole)))
    return role ? uiText('{role} · read-only access', {role}) : uiText('Read-only access');
  return s.writesEnabled
    ? uiText('{role} · read + reviewed writes', {role})
    : uiText('{role} · read-only workspace', {role});
}
/** Shell links follow the session: the brand opens Home when signed in, and members get the workspace switcher. */
function shellLinks() {
  document.querySelector('.sidebar .brand')?.setAttribute('href', session.authenticated ? '/dashboard' : '/');
  const toggle = document.getElementById('workspace-switch-open');
  if (!toggle) return;
  toggle.hidden = !session.authenticated || !!session.testAccount;
  if (toggle.hidden || toggle.dataset.identity !== identityKey(session)) closeWorkspaceMenu();
}
function closeWorkspaceMenu() {
  const toggle = document.getElementById('workspace-switch-open'),
    menu = document.getElementById('workspace-switch-menu');
  if (toggle) {
    toggle.setAttribute('aria-expanded', 'false');
    delete toggle.dataset.identity;
  }
  if (menu) {
    menu.hidden = true;
    menu.innerHTML = '';
  }
}
/**
 * The sidebar's workspace card switches workspaces in place (WEB-06): it lists the workspaces this sign-in belongs to,
 * read when opened, and switches with the account page's endpoint. api() resets private state on a switch.
 */
async function openWorkspaceMenu() {
  const toggle = document.getElementById('workspace-switch-open'),
    menu = document.getElementById('workspace-switch-menu');
  if (toggle.getAttribute('aria-expanded') === 'true') return closeWorkspaceMenu();
  const identity = identityGeneration;
  toggle.setAttribute('aria-expanded', 'true');
  toggle.dataset.identity = identityKey(session);
  menu.hidden = false;
  menu.innerHTML = `<p role="status">${esc(uiText('Loading your workspaces…'))}</p>`;
  const {workspaces = []} = await api('/api/workspaces');
  if (identity !== identityGeneration || toggle.getAttribute('aria-expanded') !== 'true') return;
  menu.innerHTML =
    `<p class="workspace-menu-title">${esc(uiText('Your workspaces'))}</p>` +
    workspaces
      .map(
        w =>
          `<button type="button" data-shell-switch="${esc(w.id)}" ${w.id === session.workspaceId ? 'aria-current="true" disabled' : ''}><bdi>${esc(w.name)}</bdi><small>${esc(w.id === session.workspaceId ? uiText('Current workspace') : uiRole(w.role))}</small></button>`,
      )
      .join('') +
    `<a href="/account">${esc(uiText('Manage your workspaces'))}</a>`;
  menu.querySelector('button:not([disabled]),a')?.focus();
}
async function switchWorkspaceFromShell(id) {
  if (!id || id === session.workspaceId) return;
  await api('/api/workspaces/switch', {method: 'POST', body: JSON.stringify({workspaceId: id})});
  session = await api('/api/session');
  const platformData = await api('/api/platforms');
  platforms = platformData.platforms;
  commerceSources = platformData.commerce_sources ?? [];
  closeWorkspaceMenu();
  // Plan, report and account IDs in the address belonged to the previous workspace: keep only the page.
  navigate(routeEntry(location.pathname) && routeAvailable(location.pathname) ? location.pathname : '/dashboard');
}
// WEB-06: a failed shell action stays on screen until the next action or page, instead of a six-second toast.
function showShellAlert(message) {
  const alert = document.getElementById('shell-alert');
  if (!alert || !message) return toast(message);
  alert.textContent = message;
  alert.hidden = false;
}
function clearShellAlert() {
  const alert = document.getElementById('shell-alert');
  if (!alert || alert.hidden) return;
  alert.textContent = '';
  alert.hidden = true;
}
async function render() {
  const generation = ++navigationGeneration,
    identity = identityGeneration,
    pathname = location.pathname,
    routeChanged = renderedLocation !== location.pathname + location.search;
  renderedLocation = location.pathname + location.search;
  clearTimeout(pollTimer);
  if (routeChanged) clearShellAlert();
  pageLeaveGuard = null;
  const page = routeEntry(location.pathname),
    navigationKey = routeNavigationKey(location.pathname);
  document.body.classList.toggle('public-view', page?.public === true);
  // One name per page (WEB-06): the tab title, breadcrumb and heading use the registry's canonical label.
  const pageTitle =
    page?.label ??
    (location.pathname
      .slice(1)
      .replaceAll('-', ' ')
      .replace(/^./, c => c.toUpperCase()) ||
      uiText('Workspace'));
  document.title = uiText(pageTitle) + ' · AMCP';
  applyUILocale();
  document.getElementById('workspace-name').textContent = uiWorkspaceName(session.workspaceName, session.name);
  document.getElementById('user-avatar').textContent = (session.name ?? 'A').slice(0, 1).toUpperCase();
  $('.readonly-indicator').innerHTML = `<i></i>` + esc(accessLine(session));
  shellLinks();
  const footerAccess = session.writesEnabled
    ? 'Encrypted connections · Reviewed write access'
    : 'Encrypted connections · Read-only access';
  const footer = $('.page-footer').lastElementChild;
  footer.setAttribute('data-ui-text', footerAccess);
  footer.textContent = uiText(footerAccess);
  document.querySelectorAll('[data-route]').forEach(a => {
    const current = a.dataset.route === navigationKey;
    a.classList.toggle('active', current);
    if (current) {
      a.setAttribute('aria-current', 'page');
      const group = a.closest?.('details');
      if (group) group.open = true;
    } else a.removeAttribute('aria-current');
  });
  // A child page names its parent first: "Connections / Connection result".
  $('#breadcrumb').textContent = page
    ? (page.parent ? uiText(routeLabel(page.parent)) + ' / ' : '') + uiText(page.label)
    : uiText(
        {terms: 'Terms', 'data-deletion': 'Data deletion', privacy: 'Privacy'}[location.pathname.slice(1)] ??
          'Workspace',
      );
  $('#login-button').hidden = session.authenticated;
  $('#logout-button').hidden = !session.authenticated;
  try {
    // WEB-06: a new page replaces the previous one at once with its heading and a busy placeholder, so the previous
    // page's controls cannot be used while this one loads its files and data.
    const pending = pageAssetsPending(pathname);
    if (pending || (routeChanged && page && !page.public))
      content.innerHTML = `<div class="page-heading"><div><h1>${esc(uiText(pageTitle))}</h1></div></div><section class="panel" role="status" aria-busy="true" id="route-loading"><p>${esc(uiText('Loading this page…'))}</p></section>`;
    if (pending) await ensurePageAssets(pathname);
    if (generation !== navigationGeneration || identity !== identityGeneration || pathname !== location.pathname)
      return;
    if (location.pathname === '/') return await renderLanding();
    if (['/login', '/signup', '/forgot-password', '/reset-password', '/verify-email'].includes(location.pathname))
      return await renderAuthPage();
    if (location.pathname === '/auth/complete') {
      afterSignIn();
      return;
    }
    // A member whose workspace now requires two-step verification sets it up first (SEC-06); the server refuses the
    // other workspace APIs until then, so every other page shows Account instead.
    if (session.authenticated && session.mfaEnrollmentRequired && location.pathname !== '/account') {
      history.replaceState({}, '', '/account');
      return await renderAccountPage();
    }
    if (location.pathname === '/account') return await renderAccountPage();
    if (location.pathname === '/reporting-overview') return await renderReportingOverview();
    if (
      [
        '/dashboard',
        '/campaigns',
        '/media',
        '/reports',
        '/operations',
        '/capabilities',
        '/report-library',
        '/report-pack',
        '/monitors',
        '/portfolio',
        '/measurement',
        '/commerce',
        '/schedules',
        '/profiles',
      ].includes(location.pathname)
    )
      return await renderWorkspacePage();
    if (['/privacy', '/terms', '/data-deletion'].includes(location.pathname)) return renderLegal();
    if (location.pathname === '/oauth/consent') return await renderConsent();
    if (location.pathname === '/oauth/result') return await renderCallback();
    if (location.pathname === '/connectors') return await renderConnectors();
    if (location.pathname === '/activity') return await renderActivity();
    if (location.pathname === '/settings') return await renderSettings();
    renderConnections();
    if (location.pathname === '/login') showLogin();
    else if (location.pathname === '/connections') openLinkedConnection();
  } catch (e) {
    if (
      generation === navigationGeneration &&
      identity === identityGeneration &&
      pathname === location.pathname &&
      e.code !== 'REQUEST_SUPERSEDED'
    )
      showPageError(e);
  }
}
document.addEventListener('click', async event => {
  const el = event.target.closest('button,a');
  if (!el) return;
  // Skip links and in-page jumps (#main, #overview-config) move focus without a history entry or a re-render.
  const section = fragmentLink(event, el);
  if (section) {
    event.preventDefault();
    focusFragmentTarget(section);
    return;
  }
  if (clientNavigation(event, el)) {
    event.preventDefault();
    const href = el.getAttribute('href');
    if (
      typeof pageLeaveGuard === 'function' &&
      pageLeaveGuard() &&
      !(await confirmAction({
        title: uiText('Leave without saving?'),
        consequence: uiText('Unsaved edits on this page will be lost. Saved work is kept.'),
        confirmLabel: uiText('Leave page'),
      }))
    )
      return;
    navigate(href);
    return;
  }
  if (el.dataset.close) {
    $('#' + el.dataset.close).close();
    return;
  }
  // A shell action's error stays on screen until the person's next action (WEB-06).
  if (typeof clearShellAlert === 'function') clearShellAlert();
  let disabledHere = false;
  const disableControl = () => {
    disabledHere = true;
    el.disabled = true;
  };
  try {
    if (el.id === 'workspace-switch-open') return await openWorkspaceMenu();
    if (el.dataset.shellSwitch) {
      disableControl();
      return await switchWorkspaceFromShell(el.dataset.shellSwitch);
    }
    if (el.dataset.consent) {
      disableControl();
      const approved = el.dataset.consent === 'approve',
        scope = approved ? $('input[name="consent-scope"]:checked')?.value : undefined;
      const result = await api('/api/mcp/consent', {
        method: 'POST',
        body: JSON.stringify({
          request: new URLSearchParams(location.search).get('request'),
          approved,
          ...(scope ? {scope} : {}),
        }),
      });
      location.assign(result.url);
      return;
    }
    if (el.id === 'login-button' || el.dataset.action === 'login') return showLogin();
    if (el.id === 'logout-button') {
      await api('/api/session', {method: 'DELETE'});
      session = await api('/api/session');
      const platformData = await api('/api/platforms');
      platforms = platformData.platforms;
      commerceSources = platformData.commerce_sources ?? [];
      navigate('/');
      return;
    }
    if (el.dataset.action === 'refresh') {
      disableControl();
      await refresh();
      toast(uiText('Workspace refreshed. Use Sync to refresh provider assets.'));
      return;
    }
    if (el.dataset.filter) {
      filter = el.dataset.filter;
      return renderConnections();
    }
    if (el.dataset.manage) return openManage(el.dataset.manage);
    if (el.dataset.selectLogin) return openManage(currentPlatform, el.dataset.selectLogin);
    if (el.dataset.connect) {
      disableControl();
      return await startConnection(el.dataset.connect);
    }
    if (el.dataset.reauthorize) {
      disableControl();
      const result = await api('/api/connections/' + encodeURIComponent(el.dataset.reauthorize) + '/reauthorize', {
        method: 'POST',
      });
      location.assign(result.url);
      return;
    }
    if (el.dataset.credentialRetry) {
      disableControl();
      const result = await api(
        '/api/connections/' + encodeURIComponent(el.dataset.credentialRetry) + '/credential-retry',
        {
          method: 'POST',
          body: '{}',
        },
      );
      currentConnection = el.dataset.credentialRetry;
      await refresh();
      toast(
        result.retry
          ? uiText('AMCP will ask the provider to renew this login on its next request.')
          : uiText('No renewal failure is recorded for this login.'),
      );
      return;
    }
    if (el.dataset.assetKind) {
      assetKind = el.dataset.assetKind;
      assetSearch = '';
      return renderManage();
    }
    if (el.dataset.sync || el.dataset.syncKind) {
      disableControl();
      el.textContent = uiText('Syncing…');
      const id = el.dataset.sync ?? currentConnection;
      await syncConnection(id, [
        el.dataset.syncKind ?? platforms.find(p => p.id === currentPlatform)?.selectionKind ?? 'ad_accounts',
      ]);
      return;
    }
    if (el.dataset.default) {
      await api('/api/connections/' + el.dataset.default + '/default', {method: 'POST', body: '{}'});
      await refresh();
      toast(uiText('Default login updated.'));
      return;
    }
    if (el.dataset.renameLogin) {
      const label = $('#login-label')?.value.trim() ?? '';
      if (!label || label.length > 80) {
        toast(uiText('Use a login name of 1 to 80 characters.'));
        return;
      }
      disableControl();
      await api('/api/connections/' + encodeURIComponent(el.dataset.renameLogin) + '/label', {
        method: 'PATCH',
        body: JSON.stringify({label}),
      });
      await refresh();
      toast(uiText('Login renamed.'));
      return;
    }
    if (el.dataset.disconnect) {
      $('#confirm-form').dataset.connectionId = el.dataset.disconnect;
      $('#confirm-dialog').showModal();
      return;
    }
    if (el.dataset.selectAll) {
      document.querySelectorAll('[data-asset-key]').forEach(input => {
        input.checked = true;
        selected.add(input.dataset.assetKey);
      });
      renderManage();
      return;
    }
    if (el.dataset.saveAssets) {
      const p = platforms.find(p => p.id === currentPlatform),
        login = p?.connections.find(c => c.id === currentConnection),
        toggle = $('#selection-write-access'),
        writeAccess = toggle && toggle.checked !== (login?.defaultWriteAccess === true) ? toggle.checked : undefined,
        added = selectionWriteAdditions(p, login, toggle ? toggle.checked : undefined);
      // A selection that enables write access for more resources names them and asks first (D19, CON-05).
      if (
        added.length &&
        !(await confirmAction({
          title: uiText('Enable write access for these resources?'),
          consequence: uiText(
            'Write access will be enabled for the resources below. Operator connectors may then prepare and execute reviewed changes on them; each change still needs its own review.',
          ),
          confirmLabel: uiText('Enable write access'),
          items: added,
        }))
      )
        return;
      disableControl();
      const checkAfter = el.dataset.saveAssets === 'check',
        before = new Set(login?.accounts ?? []);
      await api('/api/connections/' + currentConnection + '/assets', {
        method: 'PATCH',
        body: JSON.stringify({
          selected: [...selected],
          ...(writeAccess === undefined ? {} : {write_access: writeAccess}),
          ...(added.length ? {confirmed: true} : {}),
        }),
      });
      await refresh();
      toast(uiText('Selection saved. Platform data was not changed.'));
      if (checkAfter) await checkSelectedAccess(currentPlatform, currentConnection, before);
      return;
    }
    if (el.dataset.saveWriteAccess || el.dataset.revokeWriteAccess) {
      if (
        el.dataset.revokeWriteAccess &&
        !(await confirmAction({
          title: uiText('Revoke write access for this login?'),
          consequence: uiText(
            'Operators can no longer prepare or execute changes on any account of this login. Reads and existing reviews are unaffected; executes will be refused.',
          ),
          confirmLabel: uiText('Revoke write access'),
        }))
      )
        return;
      const accounts = el.dataset.revokeWriteAccess ? [] : [...writeSelected];
      if (accounts.length && !$('#confirm-write-access')?.checked) {
        toast(uiText('Confirm account write access before saving.'));
        return;
      }
      disableControl();
      await api('/api/connections/' + currentConnection + '/write-access', {
        method: 'PATCH',
        body: JSON.stringify({accounts, confirmed: accounts.length > 0}),
      });
      await refresh();
      toast(
        accounts.length
          ? uiText('Write access saved for the selected accounts. No advertising changes were executed.')
          : uiText('Resource write access revoked for this login.'),
      );
      return;
    }
    if (el.dataset.client) {
      client = el.dataset.client;
      return await renderConnectors();
    }
    if (el.dataset.copyEndpoint) {
      await navigator.clipboard.writeText(session.origin + '/mcp');
      toast(uiText('Endpoint copied.'));
      return;
    }
    if (el.dataset.copyConfig) {
      await navigator.clipboard.writeText(connectorCode());
      toast(uiText('Configuration copied.'));
      return;
    }
    if (el.dataset.copyCallback) {
      await navigator.clipboard.writeText(platforms.find(p => p.id === el.dataset.copyCallback).callback);
      toast(uiText('Callback URI copied.'));
      return;
    }
    if (el.dataset.createToken || el.dataset.createOperatorToken) {
      if (!requireLogin()) return;
      const operator = !!el.dataset.createOperatorToken;
      if (operator && !$('#operator-token-consent')?.checked) {
        toast(uiText('Confirm operator access before creating this token.'));
        return;
      }
      disableControl();
      const result = await api('/api/connector-tokens', {
        method: 'POST',
        body: JSON.stringify({
          name: client === 'codex' ? 'Codex' : client === 'cursor' ? 'Cursor' : 'MCP client',
          role: operator ? 'operator' : 'reader',
          confirmed: operator,
        }),
      });
      await renderConnectors();
      $('#new-token').innerHTML =
        `<div class="notice"><div><strong>${esc(uiText('Save this token now. It is shown only once.'))}</strong><pre class="code-block token-secret" id="token-value"></pre><button class="button small" id="copy-new-token">${esc(uiText('Copy token'))}</button></div></div>`;
      $('#token-value').textContent = result.token;
      $('#copy-new-token').onclick = async () => {
        await navigator.clipboard.writeText(result.token);
        toast(uiText('Token copied. Keep it private.'));
      };
      return;
    }
    if (el.dataset.revokeClient) {
      if (
        !(await confirmAction({
          title: uiText('Revoke this MCP client?'),
          consequence: uiText(
            'Its access and refresh tokens stop working now. The client has to be authorized again to reconnect.',
          ),
          confirmLabel: uiText('Revoke client'),
        }))
      )
        return;
      // A client metadata document's client ID is a URL, and one app's ID is shared by everyone who uses it: encode the
      // ID, and end only the listed person's connection when the row names one (MCP-08 with CIMD).
      await api(
        '/api/mcp/authorizations/' +
          encodeURIComponent(el.dataset.revokeClient) +
          (el.dataset.revokeOwner !== undefined ? '?owner=' + encodeURIComponent(el.dataset.revokeOwner) : ''),
        {method: 'DELETE'},
      );
      await renderConnectors();
      toast(uiText('MCP client access revoked.'));
      return;
    }
    if (el.dataset.revokeToken) {
      if (
        !(await confirmAction({
          title: uiText('Revoke this connector token?'),
          consequence: uiText(
            'Every MCP client configured with this token loses access now. Create a new token to reconnect.',
          ),
          confirmLabel: uiText('Revoke token'),
        }))
      )
        return;
      await api('/api/connector-tokens/' + el.dataset.revokeToken, {method: 'DELETE'});
      await renderConnectors();
      toast(uiText('Connector token revoked.'));
      return;
    }
    if (el.dataset.callbackManage) {
      navigate('/connections');
      return openManage(el.dataset.callbackManage, el.dataset.connectionId);
    }
  } catch (e) {
    // On the page, the error persists above the content until the next action; inside a dialog it stays a toast.
    if (el.closest?.('dialog')) toast(e.message);
    else showShellAlert(errorMessage(e));
  } finally {
    if (disabledHere && el.isConnected) el.disabled = false;
  }
});
document.addEventListener('input', event => {
  if (event.target.id === 'platform-search') {
    search = event.target.value;
    renderPlatformCards();
  }
  if (event.target.id === 'asset-search') {
    assetSearch = event.target.value;
    const c = platforms.find(p => p.id === currentPlatform)?.connections.find(c => c.id === currentConnection),
      group = c?.groups.find(g => g.kind === assetKind);
    $('#asset-rows').innerHTML = assetRows(
      (group?.assets ?? []).filter(a => (a.name + ' ' + a.id).toLowerCase().includes(assetSearch.toLowerCase())),
      group,
    );
  }
});
document.addEventListener('change', event => {
  if (event.target.dataset.writeAccount) {
    if (event.target.checked) writeSelected.add(event.target.dataset.writeAccount);
    else writeSelected.delete(event.target.dataset.writeAccount);
    const confirm = $('#confirm-write-access');
    if (confirm) confirm.checked = false;
  }
  if (event.target.dataset.assetKey) {
    if (event.target.checked) selected.add(event.target.dataset.assetKey);
    else selected.delete(event.target.dataset.assetKey);
    const badge = event.target.closest('tr').querySelector('.status');
    badge.className = 'status ' + (event.target.checked ? 'online' : 'offline');
    badge.textContent = event.target.checked ? uiText('Selected') : uiText('Available');
  }
});
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $('#login-error').textContent = '';
  try {
    const result = await api('/api/session', {method: 'POST', body: JSON.stringify({password: $('#password').value})});
    session = await api('/api/session');
    $('#password').value = '';
    $('#login-dialog').close();
    const platformData = await api('/api/platforms');
    platforms = platformData.platforms;
    commerceSources = platformData.commerce_sources ?? [];
    afterSignIn();
  } catch (e) {
    $('#login-error').textContent = errorMessage(e);
  } finally {
    button.disabled = false;
  }
});
$('#confirm-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/connections/' + event.currentTarget.dataset.connectionId, {method: 'DELETE'});
    $('#confirm-dialog').close();
    currentConnection = null;
    await refresh();
    toast(uiText('Login disconnected from AMCP.'));
  } catch (e) {
    toast(e.message);
  }
});
// A history step that changes only the fragment (a skip link, an in-page jump, or Back over one) moves focus to its
// section. Re-rendering would clear what the person typed and repeat the page's requests (WEB-01).
window.addEventListener('popstate', async () => {
  if (renderedLocation === location.pathname + location.search) {
    const target = fragmentTarget(location.hash);
    if (target) focusFragmentTarget(target);
    return;
  }
  // Back and Forward land on the page heading like a link does, once that page has rendered and is still current.
  const shown = location.pathname + location.search + location.hash;
  await render();
  if (location.pathname + location.search + location.hash !== shown) return;
  const target = fragmentTarget(location.hash);
  if (target) focusFragmentTarget(target);
  else focusPageHeading();
});
/** A plain activation of a link to a section of the current page, or null. */
function fragmentLink(event, el) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey ||
    el.tagName !== 'A' ||
    el.hasAttribute('download') ||
    el.getAttribute('target')
  )
    return null;
  const href = el.getAttribute('href');
  return href?.startsWith('#') ? fragmentTarget(href) : null;
}
function clientNavigation(event, el) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey ||
    el.tagName !== 'A' ||
    el.hasAttribute('download') ||
    el.getAttribute('target')
  )
    return false;
  const href = el.getAttribute('href');
  if (!href?.startsWith('/') || href.startsWith('//')) return false;
  // Every page in the route registry is client-navigable; anything else is a document (WEB-06).
  return routeEntry(href.split(/[?#]/)[0]) !== undefined;
}
(async () => {
  // All deferred feature scripts must be initialized before a fast local session response can start rendering.
  if (document.readyState !== 'complete')
    await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, {once: true}));
  try {
    await initializeUILocale();
    session = await api('/api/session');
    await refresh();
    // A fresh load at a section of a workspace page opens there once the page has its data, as an in-app link does
    // (WEB-08: the palette's /settings#owner-write-pause). The browser found nothing there while the page was empty.
    if (globalThis.location?.hash && !document.body.classList.contains('public-view')) {
      const section = fragmentTarget(location.hash);
      if (section) focusFragmentTarget(section);
    }
  } catch (e) {
    content.innerHTML =
      header('AMCP', uiText('Your advertising workspace')) + `<div class="notice warning">${esc(e.message)}</div>`;
  }
})();

function googleAssetLabel(a) {
  return (
    (a.status
      ? ' · ' +
        esc(
          uiText(
            {CANCELED: 'Cancelled', ENABLED: 'Active', SUSPENDED: 'Suspended', CLOSED: 'Closed'}[a.status] ?? a.status,
          ),
        )
      : '') +
    (a.manager ? ' · ' + esc(uiText('Manager')) : '') +
    (a.hidden ? ' · ' + esc(uiText('Hidden')) : '') +
    (a.testAccount ? ' · ' + esc(uiText('Test account')) : '') +
    (a.parentId ? ' · ' + uiMarkup('Via manager {id}', {id: uiBidi(a.parentId, 'ltr')}) : '')
  );
}

function renderAssetSyncDiagnostics(group) {
  const diagnostics = group?.diagnostics ?? [];
  if (!diagnostics.length) return group?.error ? `<p class="error" role="alert">${esc(group.error)}</p>` : '';
  return `<div role="status"><p class="error">${esc(uiText('Some assets could not be synced. Your login is saved; review the provider details below.'))}</p>${diagnostics.map(d => `<details class="activity-failure" open><summary>${esc(d.account_id ?? uiText('Connection'))} · ${esc(d.provider?.code ?? d.code)}</summary>${renderSourceDiagnostic(d)}</details>`).join('')}</div>`;
}
