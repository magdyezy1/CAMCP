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
  ad_accounts: 'Ad accounts',
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
};
let session = {authenticated: false, csrf: null},
  platforms = [],
  filter = 'all',
  search = '',
  currentPlatform = null,
  currentConnection = null,
  assetKind = 'ad_accounts',
  selected = new Set(),
  writeSelected = new Set(),
  assetSearch = '',
  client = 'codex',
  tokens = [],
  oauthClients = [],
  pollTimer;
const content = $('#content'),
  date = v => (v ? new Date(v).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'}) : 'Not synced');
// A new message restarts the timer; before, an older timer could hide a newer message after a second.
// One styled confirmation for destructive actions: it names the consequence, and Cancel has focus. Escape cancels.
function confirmAction({title, consequence, confirmLabel = 'Confirm'}) {
  const d = $('#action-dialog');
  $('#action-title').textContent = title;
  $('#action-copy').textContent = consequence;
  $('#action-confirm').textContent = confirmLabel;
  return new Promise(resolve => {
    const closed = () => {
      d.removeEventListener('close', closed);
      resolve(d.returnValue === 'confirm');
    };
    d.addEventListener('close', closed);
    d.returnValue = '';
    d.showModal();
    $('#action-cancel').focus();
  });
}
let toastTimer;
function toast(message) {
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
  content.innerHTML =
    '<section class="panel page-error" role="alert"><h1 tabindex="-1">This page could not open</h1><p>' +
    esc(pageErrorCauses[e?.code] ?? e?.message ?? 'Something went wrong.') +
    '</p><div class="dialog-actions"><button class="button primary" type="button" data-retry-page>Try again</button><a class="button" href="/connections">Back to Connections</a></div></section>';
  content.querySelector('[data-retry-page]').addEventListener('click', () => render());
  content.querySelector('h1').focus();
}
async function api(url, options = {}) {
  const method = options.method ?? 'GET',
    headers = {
      'Accept': 'application/json',
      ...(method !== 'GET' ? {'Content-Type': 'application/json', 'X-AMCP-CSRF': session.csrf ?? ''} : {}),
      ...options.headers,
    };
  const response = await fetch(url, {...options, headers, credentials: 'same-origin'});
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error('AMCP could not read the server response.');
  }
  if (!response.ok) {
    const e = Error(data.error?.message ?? 'This request could not be completed.');
    e.code = data.error?.code;
    if (response.status === 401 && !url.startsWith('/api/account/') && !url.startsWith('/api/session')) {
      session.authenticated = false;
      showLogin();
    }
    throw e;
  }
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
function navigate(route) {
  history.pushState({}, '', route);
  render();
  window.scrollTo(0, 0);
  document.getElementById('main').focus({preventScroll: true});
}
function route() {
  if (location.pathname === '/account') return 'account';
  if (
    ['/dashboard', '/campaigns', '/media', '/reports', '/reporting-overview', '/profiles'].includes(location.pathname)
  )
    return location.pathname.slice(1);
  if (location.pathname === '/connectors') return 'connectors';
  if (location.pathname === '/activity') return 'activity';
  if (location.pathname === '/settings') return 'settings';
  // Only the connections page and a provider's connection flow belong to Connections; the legal and sign-in pages
  // belong to no section of the navigation (F-43).
  if (location.pathname === '/connections' || location.pathname.startsWith('/oauth/')) return 'connections';
  return '';
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
function renderConnections() {
  const connected = platforms.filter(p => connectionCount(p) > 0),
    accounts = new Set(platforms.flatMap(p => p.connections.flatMap(c => c.accounts.map(a => p.id + ':' + a)))),
    logins = platforms.reduce((n, p) => n + p.connections.length, 0);
  content.innerHTML =
    header(
      'Connections',
      'Connect your platforms. Choose what AMCP can access.',
      `<button class="button" data-action="refresh">↻ <span>Refresh</span></button>`,
    ) +
    `${!session.authenticated ? `<div class="notice"><span>◈</span><p><strong>Your workspace, securely connected.</strong><br>Sign in to manage platform logins and choose your advertising assets.</p><button class="button dark" data-action="login">Sign in →</button></div>` : ''}` +
    `<div class="stat-grid"><div class="stat"><div><div class="stat-label">Connected platforms</div><div class="stat-value">${connected.length}<span class="muted stat-denominator"> / ${platforms.length}</span></div></div><span class="stat-icon" aria-hidden="true">◈</span></div><div class="stat"><div><div class="stat-label">Selected accounts & properties</div><div class="stat-value">${accounts.size}</div></div><span class="stat-icon" aria-hidden="true">▦</span></div><div class="stat"><div><div class="stat-label">Secure logins</div><div class="stat-value">${logins}</div></div><span class="stat-icon" aria-hidden="true">↗</span></div></div>` +
    `<div class="section-tools"><div class="filter-tabs" role="group" aria-label="Filter platforms"><button class="filter-tab ${filter === 'all' ? 'active' : ''}" data-filter="all">All platforms <span class="muted">${platforms.length}</span></button><button class="filter-tab ${filter === 'connected' ? 'active' : ''}" data-filter="connected">Connected <span class="muted">${connected.length}</span></button></div><label class="search"><span aria-hidden="true">⌕</span><input id="platform-search" type="search" value="${esc(search)}" placeholder="Search platforms…" aria-label="Search platforms"></label></div><div class="platform-grid" id="platform-grid"></div>`;
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
          attention = p.connections.some(c => c.error),
          status = attention ? 'Needs attention' : n ? 'Connected' : 'Not connected',
          metrics = p.assetKinds.slice(0, 3);
        while (metrics.length < 3) metrics.push(metrics.length === 1 ? 'logins' : 'selected');
        return `<article class="platform-card"><div class="platform-main"><div class="platform-top"><div class="platform-identity">${logo(p)}<div><div class="platform-name">${esc(p.name)}</div><div class="platform-kind">${esc(p.kind)}</div></div></div><span class="status ${attention ? 'attention' : n ? 'online' : 'offline'}"><i></i>${status}</span></div><p class="platform-description">${esc(p.description)}</p><div class="platform-bottom"><span class="platform-login">${n ? `${n} connected ${n === 1 ? 'login' : 'logins'}` : p.configured ? 'Ready to connect' : 'Administrator setup required'}</span><div class="platform-actions"><button class="button small" data-manage="${p.id}">Manage</button><button class="button small ${n ? '' : 'primary'}" data-connect="${p.id}">${n ? '+ Add login' : p.configured ? '+ Connect' : 'Set up →'}</button></div></div></div><div class="platform-metrics">${metrics.map(k => `<div><small>${esc((labels[k] ?? k).toUpperCase())}</small><b>${k === 'logins' ? n : k === 'selected' ? p.connections.reduce((v, c) => v + c.accounts.length, 0) : assetsFor(p, k)}</b></div>`).join('')}</div></article>`;
      })
      .join('') || '<div class="empty">No platforms match your search.</div>';
}
function renderConnectionSyncStatus(c) {
  if (!c?.lastSync) return '';
  const reason = c.groups?.flatMap(g => g.diagnostics ?? []).find(d => d.provider?.code)?.provider?.code;
  return (
    '<div class="notice connection-sync-status" role="status"><div><strong>' +
    esc(c.error ? 'Sync needs attention' + (reason ? ' — ' + reason : '') : 'Sync completed') +
    '</strong><p class="small-text">' +
    esc(date(c.lastSync)) +
    (c.error
      ? ' · Review the provider details below. Your saved login and selections are retained.'
      : ' · The requested assets were refreshed.') +
    '</p></div></div>'
  );
}
function renderGoogleAuthorization(c) {
  const a = c?.authorization;
  if (!a) return '';
  return (
    '<div class="notice"><div><strong>Google authorization</strong><p>Sync reloads accounts using this saved login. Reauthorize asks Google for fresh consent and keeps this connection after account access is verified.</p><p class="small-text">' +
    (a.matchesCurrentClient === true
      ? 'Saved OAuth client matches the current configuration.'
      : a.matchesCurrentClient === false
        ? 'Saved OAuth client differs from the current configuration. Use Reauthorize to connect with the current client.'
        : 'The saved OAuth client could not be compared. Reauthorize to establish a fresh connection.') +
    '</p>' +
    (a.clientId
      ? '<p class="small-text">Saved client: <span class="oauth-client-id">' + esc(a.clientId) + '</span></p>'
      : '') +
    (!a.adsScopeRecorded
      ? '<p>Google Ads permission is not recorded on this login. Reauthorize and approve Google Ads access.</p>'
      : '') +
    '</div></div>'
  );
}
async function syncConnection(id, kinds) {
  const result = await api('/api/connections/' + id + '/sync', {method: 'POST', body: JSON.stringify({kinds})});
  currentConnection = id;
  await refresh();
  if (result.error) {
    const reason = result.groups?.flatMap(g => g.diagnostics ?? []).find(d => d.provider?.code)?.provider?.code;
    toast(
      'Sync needs attention' +
        (reason ? ' — ' + reason : '') +
        '. Open the error details below. For Google authorization errors, use Reauthorize.',
    );
  } else toast('Accounts synced successfully.');
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
    `<div class="manage-header"><div class="platform-identity">${logo(p)}<div><h3>${esc(p.name)} assets</h3><div class="platform-kind">Manage logins and access inside AMCP</div></div></div><button class="icon-button" data-close="manage-dialog" aria-label="Close asset manager">×</button></div><div class="manage-body"><div class="panel-header"><div><h3>Connected logins</h3><p class="muted login-caption">Each login keeps its own encrypted credentials and permissions.</p></div><button class="button dark small" data-connect="${p.id}">+ Connect another</button></div><div class="login-list">${p.connections.map(login => `<div class="oauth-login"><span class="avatar">${esc(login.name.slice(0, 1).toUpperCase())}</span><div><button class="button quiet small" data-select-login="${esc(login.id)}"><strong>${esc(login.name)}</strong></button>${login.isDefault ? '<span class="default-badge">Default</span>' : ''}<small>${login.expiresAt ? 'Token expires ' + date(login.expiresAt) : 'Expiry not provided'} · ${login.enabled ? 'Enabled in AMCP' : 'Choose assets'}</small></div><div class="actions"><button class="button small" data-sync="${esc(login.id)}">↻ Sync</button>${p.id === 'google' ? `<button class="button small" data-reauthorize="${esc(login.id)}">Reauthorize</button>` : ''}${!login.isDefault ? `<button class="button small" data-default="${esc(login.id)}">Make default</button>` : ''}<button class="button small danger" data-disconnect="${esc(login.id)}" aria-label="Disconnect ${esc(login.name)}">↗</button></div></div>`).join('') || '<div class="empty"><strong>No logins connected</strong>Connect your account to discover its advertising assets.</div>'}</div>${c ? `${renderConnectionSyncStatus(c)}${renderGoogleAuthorization(c)}<div class="notice asset-notice"><span>✓</span><p>Select ${esc(labels[p.selectionKind].toLowerCase())} to grant MCP access to their data. Other tabs show related asset inventory. Saving this selection changes AMCP access only.</p></div>${session.writesEnabled && p.reviewedWrites !== false ? `<label class="form-note"><input type="checkbox" id="selection-write-access" ${c.defaultWriteAccess ? 'checked' : ''}> Enable read + reviewed write access for all selected resources</label>` : ''}${p.reviewedWrites === false ? '' : writeAccessPanel(c)}<div class="asset-tabs" role="group" aria-label="Asset types">${p.assetKinds.map(k => `<button data-asset-kind="${k}" class="${assetKind === k ? 'active' : ''}">${labels[k]} <span class="asset-count">${c.groups.find(g => g.kind === k)?.assets.length ?? '—'}</span></button>`).join('')}</div><div class="asset-toolbar"><label class="search"><span>⌕</span><input id="asset-search" type="search" value="${esc(assetSearch)}" placeholder="Search ${labels[assetKind].toLowerCase()}…" aria-label="Search assets"></label><button class="button small" data-sync-kind="${assetKind}">↻ Sync this tab</button></div>${renderAssetSyncDiagnostics(group)}<div id="asset-rows">${assetRows(assets, group)}</div>` : ''}</div><div class="manage-footer"><span class="muted small-text">${c ? 'Last sync: ' + date(c.lastSync) : 'Your provider opens in a secure authorization flow.'}</span>${c && assetKind === (platforms.find(p => p.id === currentPlatform)?.selectionKind ?? 'ad_accounts') ? `<div class="platform-actions"><button class="button small" data-select-all="true">Select visible</button><button class="button primary" data-save-assets="true">Save selection</button></div>` : ''}</div>`;
}
function writeAccessPanel(c) {
  const assets = c.groups.find(g => g.kind === 'ad_accounts')?.assets ?? [];
  return `<section class="panel consent-panel"><h3>Resource write access</h3><p>${session.writesEnabled ? 'Operator connectors may change only the selected accounts you explicitly enable below. Each change still requires a reviewed request through amcp_write.' : 'Write support is disabled in this deployment. You can revoke existing account grants below.'}</p>${c.accounts.length ? c.accounts.map(id => `<label class="token-row"><span>${esc(assets.find(a => a.id === id)?.name ?? id)}<small>${esc(id)}</small></span><input type="checkbox" data-write-account="${esc(id)}" aria-label="Allow writes to ${esc(id)}" ${writeSelected.has(id) ? 'checked' : ''} ${!session.writesEnabled ? 'disabled' : ''}></label>`).join('') : '<p class="muted">Save a resource selection before granting write access.</p>'}${session.writesEnabled && c.accounts.length ? '<label class="form-note"><input type="checkbox" id="confirm-write-access"> I authorize operator connectors to change the checked resources.</label>' : ''}<div class="dialog-actions">${c.writeAccounts?.length ? '<button class="button danger" data-revoke-write-access="true">Revoke all write access</button>' : ''}${session.writesEnabled && c.accounts.length ? '<button class="button" data-save-write-access="true">Save write access</button>' : ''}</div></section>`;
}
function assetRows(assets, group) {
  if (!assets.length)
    return `<div class="empty"><strong>${group?.complete ? 'No assets found' : group ? 'No assets available' : 'This tab has not been synced'}</strong>${group?.complete ? 'The provider returned an empty list for this login.' : 'Sync this tab to load the assets your login can access.'}</div>`;
  return `<table class="asset-table"><thead><tr><th scope="col" aria-label="Select"></th><th scope="col">${labels[assetKind]}</th><th scope="col">Access</th></tr></thead><tbody>${assets.map(a => `<tr><td>${assetKind === (platforms.find(p => p.id === currentPlatform)?.selectionKind ?? 'ad_accounts') ? `<input type="checkbox" data-asset-key="${esc(a.kind + ':' + a.id)}" aria-label="Select ${esc(a.name)}" ${selected.has(a.kind + ':' + a.id) ? 'checked' : ''}>` : ''}</td><td>${esc(a.name)}<small>${esc(a.id)}${a.currency ? ' · ' + esc(a.currency) : ''}${currentPlatform === 'google' ? googleAssetLabel(a) : ''}${a.source === 'configured_binding' ? ' · locally configured' : ''}</small></td><td><span class="status ${selected.has(a.kind + ':' + a.id) ? 'online' : 'offline'}">${assetKind === (platforms.find(p => p.id === currentPlatform)?.selectionKind ?? 'ad_accounts') ? (selected.has(a.kind + ':' + a.id) ? 'Selected' : 'Available') : 'Inventory'}</span></td></tr>`).join('')}</tbody></table>`;
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
async function startConnection(id) {
  if (!requireLogin()) return;
  const p = platforms.find(p => p.id === id);
  if (!p.configured) {
    if ($('#manage-dialog').open) $('#manage-dialog').close();
    navigate('/settings#' + id);
    toast(
      session.administrator
        ? 'Add the ' + p.name + ' app credentials to your server environment to enable Connect.'
        : 'This platform needs setup by the site administrator. Your existing connections remain available.',
    );
    return;
  }
  const result = await api('/api/auth/' + id + '/start', {method: 'POST', body: '{}'});
  location.assign(result.url);
}
async function refresh() {
  const data = await api('/api/platforms');
  platforms = data.platforms;
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
      oauthClients = (await api('/api/mcp/authorizations')).clients;
    } catch (e) {
      toast(e.message);
    }
  } else {
    tokens = [];
    oauthClients = [];
  }
  content.innerHTML =
    header('MCP connectors', 'Give your AI tools access to the accounts you select.') +
    `<section class="connector-hero"><div><span class="status online"><i></i>${session.writesEnabled ? 'Write support enabled' : 'Read-only deployment'}</span><h2 class="connector-title">Your workspace.<br>In the tools you already use.</h2><p>${session.writesEnabled ? 'Connect your AI tools for reporting and reviewed advertising changes. New connections default to read and reviewed write access.' : 'Connect Codex or another MCP client to read advertising data and prepare dry-run requests.'}</p></div><div class="endpoint-box"><small>AMCP MCP ENDPOINT</small><div class="copy-row"><code>${esc(session.origin + '/mcp')}</code><button class="button small" data-copy-endpoint="true">Copy</button></div></div></section><section class="panel consent-panel"><h2>Connect with browser authorization</h2><p>In an MCP client that supports OAuth, add the endpoint above and choose Sign in. AMCP requests read and reviewed write access when enabled. ${session.writesEnabled ? 'New clients default to <code>mcp:read mcp:write</code>; the consent screen identifies operator access. Clients can explicitly request <code>mcp:read</code> for read-only access. Existing reader authorizations stay read-only until reauthorized.' : 'Advertising writes are disabled in this deployment.'}</p><pre class="code-block">codex mcp add amcp --url ${esc(session.origin + '/mcp')}
codex mcp login amcp</pre><p class="muted">For clients using a bearer token, follow the setup below.</p></section><section class="panel"><div class="panel-header"><h2>Connect with a token</h2><span class="status">Streamable HTTP</span></div><div class="client-tabs"><button class="client-tab ${client === 'codex' ? 'active' : ''}" data-client="codex">Codex</button><button class="client-tab ${client === 'cursor' ? 'active' : ''}" data-client="cursor">Cursor</button><button class="client-tab ${client === 'other' ? 'active' : ''}" data-client="other">Other MCP client</button></div><div class="steps"><div class="step"><div><strong>Create a connector token</strong><p class="muted">Create a separate token for each tool. Tokens expire after 30 days and can be revoked below.</p></div></div><div class="step"><div><strong>Add your token to the tool’s environment</strong><p class="muted">Use the environment variable <code>AMCP_MCP_TOKEN</code>. Keep the value private.</p></div></div><div class="step"><div class="step-content"><div class="copy-row"><strong>${client === 'codex' ? 'Add this to your Codex config.toml' : client === 'cursor' ? 'Add this to your Cursor MCP configuration' : 'Configure your MCP client'}</strong><button class="button small" data-copy-config="true">Copy config</button></div><pre class="code-block">${esc(connectorCode())}</pre><p class="muted">${client === 'codex' ? 'Reload your MCP connections, then ask Codex to list the tools available from AMCP.' : 'Use a client that supports Streamable HTTP and bearer authentication.'}</p></div></div></div></section><section class="panel"><div class="panel-header"><div><h2>Connector tokens</h2><span class="muted token-caption">Access follows your current AMCP asset selections.</span></div><button class="button" data-create-token="true">Create read-only token</button></div>${session.writesEnabled ? '<div class="consent-panel"><p><strong>Read + write (default)</strong> Create an operator token for your selected resources, then use <code>amcp_write</code> to prepare and review a change before executing it.</p><label class="form-note"><input type="checkbox" id="operator-token-consent"> I authorize this connector to execute reviewed changes on accounts with write access.</label><p><button class="button primary" data-create-operator-token="true">+ Create read + write token</button></p></div>' : ''}<div id="new-token"></div>${tokens.map(t => `<div class="token-row"><div><strong>${esc(t.name)}</strong><small>${t.role === 'operator' ? 'Operator · reviewed writes' : 'Reader'} · Created ${date(t.createdAt)} · Expires ${date(t.expiresAt)}</small></div>${t.revoked ? '<span class="status offline">Revoked</span>' : `<button class="button small danger" data-revoke-token="${esc(t.id)}">Revoke</button>`}</div>`).join('') || `<div class="empty">${session.authenticated ? 'No connector tokens yet.' : 'Sign in to create and manage connector tokens.'}</div>`}</section><section class="panel"><div class="panel-header"><h2>Authorized MCP clients</h2></div>${oauthClients.map(c => `<div class="token-row"><div><strong>${esc(c.name)}</strong><small>${c.role === 'operator' ? 'Operator · reviewed writes' : 'Reader'} · Authorization expires ${date(c.expiresAt)}</small></div><button class="button small danger" data-revoke-client="${esc(c.id)}">Revoke access</button></div>`).join('') || '<div class="empty">No clients authorized through browser sign-in.</div>'}</section><p class="muted small-text">Codex configuration follows <a href="https://learn.chatgpt.com/docs/extend/mcp?surface=cli" target="_blank" rel="noreferrer">official OpenAI documentation ↗</a>.</p>`;
}
function renderSettings() {
  if (session.authenticated && !session.administrator) {
    content.innerHTML =
      header('Workspace settings', 'A few thoughtful details make this space yours.') +
      '<section class="panel"><h2>Your account & security</h2><p>Edit your profile, personalize your workspace name, link social accounts, and manage browser sessions.</p><a class="button primary" href="/account">Manage your account ↗</a></section><section class="panel"><h2>Connected platforms</h2><p>Choose the accounts your workspace can access, refresh assets, and manage permissions.</p><a class="button" href="/connections">Manage connections ↗</a></section>';
    return;
  }
  content.innerHTML =
    header('Settings', 'Register AMCP with your advertising and measurement platforms.') +
    '<div class="notice"><span>◈</span><p><strong>Keep provider secrets on the server.</strong><br>Add API credentials to your server environment. Register each browser OAuth callback exactly as shown below.</p></div><div class="settings-grid">' +
    platforms
      .map(p => {
        const apple = p.authType === 'client_credentials',
          googleMeasurement = ['ga4', 'gtm', 'gsc'].includes(p.id);
        const variables = apple
          ? 'AMCP_APPLE_CLIENT_ID<br>AMCP_APPLE_TEAM_ID<br>AMCP_APPLE_KEY_ID<br>AMCP_APPLE_PRIVATE_KEY'
          : 'AMCP_' + p.env + '_CLIENT_ID<br>AMCP_' + p.env + '_CLIENT_SECRET';
        return (
          '<section class="panel" id="' +
          esc(p.id) +
          '"><div class="panel-header"><div class="platform-identity">' +
          logo(p) +
          '<h2>' +
          esc(p.name) +
          '</h2></div><span class="status ' +
          (p.configured ? 'online' : 'attention') +
          '">' +
          (p.configured ? 'Configured' : 'Setup needed') +
          '</span></div><div class="setting-field"><label>APP NAME</label><strong>AMCP</strong></div><div class="setting-field"><label>' +
          (apple ? 'CONNECTION METHOD' : 'REDIRECT / CALLBACK URI') +
          '</label>' +
          (apple
            ? '<p>Server-side Apple Ads API credentials. No browser callback is required.</p>'
            : '<div class="copy-row"><code>' +
              esc(p.callback) +
              '</code><button class="button small" data-copy-callback="' +
              esc(p.id) +
              '">Copy</button></div>') +
          '</div><div class="setting-field"><label>SERVER VARIABLES</label><code>' +
          variables +
          '</code></div><div class="setting-field"><label>REQUESTED PERMISSIONS</label><code>' +
          esc(p.scopes.join(', ') || 'Configure permissions in the provider app') +
          '</code></div>' +
          (googleMeasurement
            ? '<p class="form-note">You may reuse AMCP_GOOGLE_CLIENT_ID and AMCP_GOOGLE_CLIENT_SECRET when both dedicated variables are unset. Enable this product’s API in Google Cloud and register its separate callback. Each connection has its own tokens and selected resources.</p>'
            : '') +
          (apple
            ? '<p class="form-note">Upload the matching P-256 public key in Apple Ads API settings, then store the private PEM key only in Railway. AMCP signs short-lived client secrets and renews access tokens automatically. A pre-generated AMCP_APPLE_CLIENT_SECRET is also supported, but you must replace it before it expires.</p>'
            : '') +
          (p.reviewedWrites === false
            ? '<p class="form-note">This connection enables provider reads and asset discovery. Reviewed live mutations are not enabled for this provider.</p>'
            : '') +
          (p.id === 'tiktok'
            ? '<p class="form-note">Use the callback parameter from your developer portal. AMCP_TIKTOK_REDIRECT_PARAMETER accepts redirect_uri or redirect_url. Marketing API long-term tokens require reauthorization if revoked; consumer TikTok token endpoints are not used.</p>'
            : '') +
          (p.id === 'meta'
            ? '<p class="form-note">AMCP exchanges the initial user token for a long-lived token and records Meta’s actual expiry. Use your own approved Meta app. Configure AMCP_META_LONG_LIVED_TOKEN=false only for a separately documented token type that does not support this exchange.</p>'
            : '') +
          '</section>'
        );
      })
      .join('') +
    '</div>';
}
async function renderActivity() {
  content.innerHTML = header('Activity', 'Connection and access changes in your AMCP workspace.');
  if (!session.authenticated) {
    content.innerHTML += '<div class="empty">Sign in to view workspace activity.</div>';
    return;
  }
  const result = await api('/api/activity');
  content.innerHTML += `<section class="panel">${result.events.map(e => `<div class="token-row"><div><strong>${esc(String(e.event.event ?? e.event.operation ?? 'Workspace request').replaceAll('_', ' '))}</strong><small>${esc(e.event.connection_id ?? e.event.platform ?? e.event.gateway ?? 'AMCP workspace')}</small></div><span class="muted">${date(e.at)}</span></div>${e.event.error ? `<details class="activity-failure" open><summary>${esc(e.event.error.code ?? 'Request failed')}</summary>${(e.diagnostics ?? []).length ? e.diagnostics.map(d => renderSourceDiagnostic(d)).join('') : `<p>${esc(e.event.error.message ?? 'The request failed.')}</p>`}</details>` : ''}`).join('') || '<div class="empty">No activity recorded yet.</div>'}</section>`;
}
async function renderCallback() {
  const id = new URLSearchParams(location.search).get('attempt');
  let result;
  try {
    result = id ? await api('/api/oauth/progress/' + encodeURIComponent(id)) : null;
  } catch (e) {
    content.innerHTML =
      header('Connection needs attention', esc(e.message)) +
      `<a href="/connections" class="button primary">Back to connections</a>`;
    return;
  }
  if (!result) {
    content.innerHTML =
      header('Connection not found', 'Start a connection from your AMCP workspace.') +
      '<a href="/connections" class="button primary">Back to connections</a>';
    return;
  }
  const p = platforms.find(p => p.id === result.platform),
    done = result.state === 'complete',
    failed = result.state === 'failed' || result.state === 'sync_attention';
  content.innerHTML = `<div class="callback-layout"><div class="callback-card"><div class="callback-top"><div class="brand"><img src="/assets/mark.svg" width="34" height="34" alt=""><span>AMCP</span></div><h1>${done ? 'You’re connected.' : failed ? 'A little attention needed.' : 'Connecting ' + esc(p?.name ?? 'your platform') + '.'}</h1><p>${esc(result.message ?? (done ? 'Your login is secured. Choose the assets to make available in AMCP.' : 'Securing your connection and discovering workspace assets.'))}</p></div><div class="callback-steps">${[
    [
      'authorization',
      p?.authType === 'client_credentials' ? 'API credentials verified' : 'Approve on ' + (p?.name ?? 'the provider'),
      'Provider authorization',
    ],
    ['exchange', 'Secure connection', 'Encrypted credential storage'],
    ['sync', 'Sync workspace assets', 'Available advertising assets'],
  ]
    .map(
      ([key, title, sub], i) =>
        `<div class="callback-step ${result[key] ? 'done' : failed ? 'failed' : ''}"><span class="step-number">${result[key] ? '✓' : i + 1}</span><div>${esc(title)}<small>${esc(sub)}</small></div></div>`,
    )
    .join(
      '',
    )}</div>${(result.diagnostics ?? []).length ? `<div class="reauthorization-errors">${result.diagnostics.map(d => renderSourceDiagnostic(d)).join('')}</div>` : ''}<div class="callback-bottom"><a href="/" class="muted">Back to workspace</a>${result.connectionId ? `<button class="button primary" data-callback-manage="${esc(result.platform)}" data-connection-id="${esc(result.connectionId)}">Choose assets →</button>` : '<a href="/" class="button">Try again</a>'}</div></div></div>`;
  if (!done && !failed) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(renderCallback, 1500);
  }
}
function renderLegal() {
  if (location.pathname === '/privacy') {
    location.replace('/privacy');
    return;
  }
  const kind = location.pathname;
  const copy =
    kind === '/terms'
      ? [
          'Terms of use',
          'Use AMCP only with accounts and data you are authorized to access. You control which provider logins and assets are connected to your workspace.',
          session.writesEnabled
            ? 'This deployment supports advertising changes through operator connectors on accounts explicitly enabled for writes. Each change requires preparation, review and confirmation. Reader credentials remain read-only.'
            : 'This deployment permits reads and local request previews. Advertising writes are disabled. A connector token grants access to the assets currently enabled in your AMCP workspace.',
          'Third-party platforms govern their own approvals, availability and account access. Keep credentials private and revoke any connector token you no longer use.',
          'Contact your workspace administrator for service support and data requests.',
        ]
      : [
          'Data deletion',
          'To remove a platform login, open Connections, select Manage, then Disconnect. AMCP removes that login’s stored credentials and asset selections locally.',
          'To remove AI-tool access, open MCP connectors and revoke its connector token. You can also remove AMCP authorization in the provider’s own account settings.',
          'Audit records and saved reports may remain until the workspace administrator applies the deployment’s retention policy. Contact the administrator to request deletion of these records or the complete workspace.',
        ];
  content.innerHTML = `<article class="document">${header(copy[0], 'AMCP · amcp.shop')}${copy
    .slice(1)
    .map(p => '<p>' + esc(p) + '</p>')
    .join('')}<p><a class="button" href="/">Back to workspace</a></p></article>`;
}
async function renderConsent() {
  if (!session.authenticated) {
    content.innerHTML =
      header('Authorize an MCP client', 'Sign in to review this access request.') +
      '<button class="button primary" data-action="login">Sign in</button>';
    return;
  }
  const request = new URLSearchParams(location.search).get('request');
  const info = await api('/api/mcp/consent?request=' + encodeURIComponent(request ?? ''));
  content.innerHTML =
    header('Authorize ' + esc(info.name), 'Review the tool requesting access to your workspace.') +
    '<section class="panel consent-panel"><h2>' +
    (info.role === 'operator'
      ? 'Read and change enabled advertising accounts'
      : 'Read your selected advertising accounts') +
    '</h2><p>' +
    (info.role === 'operator'
      ? 'This tool receives operator access. It can read your selected accounts and execute reviewed changes through amcp_write on accounts you explicitly enable for writes. Changes may affect campaign delivery or spend.'
      : 'This tool can read data available through your current AMCP account selections and prepare local dry runs. It cannot change your advertising accounts.') +
    '</p><p>Return address: <code>' +
    esc(info.redirectUri) +
    '</code></p><p>Permission: <code>' +
    esc(info.scope) +
    '</code></p><div class="dialog-actions"><button class="button" data-consent="deny">Cancel</button><button class="button primary" data-consent="approve">Authorize access</button></div></section>';
}
async function render() {
  clearTimeout(pollTimer);
  document.body.classList.toggle(
    'public-view',
    ['/', '/login', '/signup', '/forgot-password', '/reset-password', '/verify-email'].includes(location.pathname),
  );
  document.title =
    {
      '/': 'AMCP · Make room for your next move',
      '/login': 'Sign in · AMCP',
      '/signup': 'Create your account · AMCP',
      '/oauth/consent': 'Authorize access · AMCP',
      '/oauth/result': 'Connection result · AMCP',
    }[location.pathname] ??
    (location.pathname
      .slice(1)
      .replaceAll('-', ' ')
      .replace(/^./, c => c.toUpperCase()) || 'Workspace') + ' · AMCP';
  document.getElementById('workspace-name').textContent = session.workspaceName ?? 'AMCP workspace';
  document.getElementById('user-avatar').textContent = (session.name ?? 'A').slice(0, 1).toUpperCase();
  $('.readonly-indicator').innerHTML =
    '<i></i>' + (session.writesEnabled ? 'Read + reviewed writes' : 'Read-only workspace');
  $('.page-footer').lastElementChild.textContent =
    'Encrypted connections · ' + (session.writesEnabled ? 'Reviewed write access' : 'Read-only access');
  document.querySelectorAll('[data-route]').forEach(a => {
    const current = a.dataset.route === route();
    a.classList.toggle('active', current);
    if (current) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $('#breadcrumb').textContent = location.pathname.startsWith('/oauth')
    ? 'Connection'
    : ({
        dashboard: 'Overview',
        campaigns: 'Campaigns',
        media: 'Media library',
        reports: 'Reports',
        'reporting-overview': 'Reporting overview',
        profiles: 'Client profiles',
        connections: 'Connections',
        connectors: 'MCP connectors',
        activity: 'Activity',
        settings: 'Settings',
        account: 'Your account',
        terms: 'Terms',
        'data-deletion': 'Data deletion',
      }[route() || location.pathname.slice(1)] ?? '');
  $('#login-button').hidden = session.authenticated;
  $('#logout-button').hidden = !session.authenticated;
  try {
    if (location.pathname === '/') return renderLanding();
    if (['/login', '/signup', '/forgot-password', '/reset-password', '/verify-email'].includes(location.pathname))
      return await renderAuthPage();
    if (location.pathname === '/auth/complete') {
      afterSignIn();
      return;
    }
    if (location.pathname === '/account') return await renderAccountPage();
    if (location.pathname === '/reporting-overview') return await renderReportingOverview();
    if (['/dashboard', '/campaigns', '/media', '/reports', '/profiles'].includes(location.pathname))
      return await renderWorkspacePage();
    if (['/privacy', '/terms', '/data-deletion'].includes(location.pathname)) return renderLegal();
    if (location.pathname === '/oauth/consent') return await renderConsent();
    if (location.pathname === '/oauth/result') return await renderCallback();
    if (location.pathname === '/connectors') return await renderConnectors();
    if (location.pathname === '/activity') return await renderActivity();
    if (location.pathname === '/settings') return await renderSettings();
    renderConnections();
    if (location.pathname === '/login') showLogin();
  } catch (e) {
    showPageError(e);
  }
}
document.addEventListener('click', async event => {
  const el = event.target.closest('button,a');
  if (!el) return;
  if (clientNavigation(event, el)) {
    event.preventDefault();
    navigate(el.getAttribute('href'));
    return;
  }
  if (el.dataset.close) {
    $('#' + el.dataset.close).close();
    return;
  }
  try {
    if (el.dataset.consent) {
      el.disabled = true;
      const result = await api('/api/mcp/consent', {
        method: 'POST',
        body: JSON.stringify({
          request: new URLSearchParams(location.search).get('request'),
          approved: el.dataset.consent === 'approve',
        }),
      });
      location.assign(result.url);
      return;
    }
    if (el.id === 'login-button' || el.dataset.action === 'login') return showLogin();
    if (el.id === 'logout-button') {
      await api('/api/session', {method: 'DELETE'});
      session = await api('/api/session');
      platforms = (await api('/api/platforms')).platforms;
      navigate('/');
      return;
    }
    if (el.dataset.action === 'refresh') {
      el.disabled = true;
      await refresh();
      toast('Workspace refreshed. Use Sync to refresh provider assets.');
      return;
    }
    if (el.dataset.filter) {
      filter = el.dataset.filter;
      return renderConnections();
    }
    if (el.dataset.manage) return openManage(el.dataset.manage);
    if (el.dataset.selectLogin) return openManage(currentPlatform, el.dataset.selectLogin);
    if (el.dataset.connect) {
      el.disabled = true;
      return await startConnection(el.dataset.connect);
    }
    if (el.dataset.reauthorize) {
      el.disabled = true;
      const result = await api('/api/connections/' + el.dataset.reauthorize + '/reauthorize', {method: 'POST'});
      location.assign(result.url);
      return;
    }
    if (el.dataset.assetKind) {
      assetKind = el.dataset.assetKind;
      assetSearch = '';
      return renderManage();
    }
    if (el.dataset.sync || el.dataset.syncKind) {
      el.disabled = true;
      el.textContent = 'Syncing…';
      const id = el.dataset.sync ?? currentConnection;
      await syncConnection(id, [
        el.dataset.syncKind ?? platforms.find(p => p.id === currentPlatform)?.selectionKind ?? 'ad_accounts',
      ]);
      return;
    }
    if (el.dataset.default) {
      await api('/api/connections/' + el.dataset.default + '/default', {method: 'POST', body: '{}'});
      await refresh();
      toast('Default login updated.');
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
      el.disabled = true;
      await api('/api/connections/' + currentConnection + '/assets', {
        method: 'PATCH',
        body: JSON.stringify({
          selected: [...selected],
          ...($('#selection-write-access') &&
          $('#selection-write-access').checked !==
            (platforms.find(p => p.id === currentPlatform)?.connections.find(c => c.id === currentConnection)
              ?.defaultWriteAccess ===
              true)
            ? {write_access: $('#selection-write-access').checked}
            : {}),
        }),
      });
      await refresh();
      toast('Selection saved. Platform data was not changed.');
      return;
    }
    if (el.dataset.saveWriteAccess || el.dataset.revokeWriteAccess) {
      if (
        el.dataset.revokeWriteAccess &&
        !(await confirmAction({
          title: 'Revoke write access for this login?',
          consequence:
            'Operators can no longer prepare or execute changes on any account of this login. Reads and existing reviews are unaffected; executes will be refused.',
          confirmLabel: 'Revoke write access',
        }))
      )
        return;
      const accounts = el.dataset.revokeWriteAccess ? [] : [...writeSelected];
      if (accounts.length && !$('#confirm-write-access')?.checked) {
        toast('Confirm account write access before saving.');
        return;
      }
      el.disabled = true;
      await api('/api/connections/' + currentConnection + '/write-access', {
        method: 'PATCH',
        body: JSON.stringify({accounts, confirmed: accounts.length > 0}),
      });
      await refresh();
      toast(
        accounts.length
          ? 'Write access saved for the selected accounts. No advertising changes were executed.'
          : 'Resource write access revoked for this login.',
      );
      return;
    }
    if (el.dataset.client) {
      client = el.dataset.client;
      return await renderConnectors();
    }
    if (el.dataset.copyEndpoint) {
      await navigator.clipboard.writeText(session.origin + '/mcp');
      toast('Endpoint copied.');
      return;
    }
    if (el.dataset.copyConfig) {
      await navigator.clipboard.writeText(connectorCode());
      toast('Configuration copied.');
      return;
    }
    if (el.dataset.copyCallback) {
      await navigator.clipboard.writeText(platforms.find(p => p.id === el.dataset.copyCallback).callback);
      toast('Callback URI copied.');
      return;
    }
    if (el.dataset.createToken || el.dataset.createOperatorToken) {
      if (!requireLogin()) return;
      const operator = !!el.dataset.createOperatorToken;
      if (operator && !$('#operator-token-consent')?.checked) {
        toast('Confirm operator access before creating this token.');
        return;
      }
      el.disabled = true;
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
        '<div class="notice"><div><strong>Save this token now. It is shown only once.</strong><pre class="code-block token-secret" id="token-value"></pre><button class="button small" id="copy-new-token">Copy token</button></div></div>';
      $('#token-value').textContent = result.token;
      $('#copy-new-token').onclick = async () => {
        await navigator.clipboard.writeText(result.token);
        toast('Token copied. Keep it private.');
      };
      return;
    }
    if (el.dataset.revokeClient) {
      if (
        !(await confirmAction({
          title: 'Revoke this MCP client?',
          consequence:
            'Its access and refresh tokens stop working now. The client has to be authorized again to reconnect.',
          confirmLabel: 'Revoke client',
        }))
      )
        return;
      await api('/api/mcp/authorizations/' + el.dataset.revokeClient, {method: 'DELETE'});
      await renderConnectors();
      toast('MCP client access revoked.');
      return;
    }
    if (el.dataset.revokeToken) {
      if (
        !(await confirmAction({
          title: 'Revoke this connector token?',
          consequence: 'Every MCP client configured with this token loses access now. Create a new token to reconnect.',
          confirmLabel: 'Revoke token',
        }))
      )
        return;
      await api('/api/connector-tokens/' + el.dataset.revokeToken, {method: 'DELETE'});
      await renderConnectors();
      toast('Connector token revoked.');
      return;
    }
    if (el.dataset.callbackManage) {
      navigate('/connections');
      return openManage(el.dataset.callbackManage, el.dataset.connectionId);
    }
  } catch (e) {
    toast(e.message);
  } finally {
    if (el.isConnected) el.disabled = false;
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
    badge.textContent = event.target.checked ? 'Selected' : 'Available';
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
    platforms = (await api('/api/platforms')).platforms;
    afterSignIn();
  } catch (e) {
    $('#login-error').textContent = e.message;
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
    toast('Login disconnected from AMCP.');
  } catch (e) {
    toast(e.message);
  }
});
window.addEventListener('popstate', () => render());
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
  const path = href.split(/[?#]/)[0];
  return [
    '/',
    '/dashboard',
    '/campaigns',
    '/media',
    '/reports',
    '/reporting-overview',
    '/profiles',
    '/connections',
    '/connectors',
    '/activity',
    '/settings',
    '/account',
    '/login',
    '/signup',
    '/forgot-password',
    '/reset-password',
    '/verify-email',
    '/terms',
    '/data-deletion',
    '/oauth/consent',
    '/oauth/result',
    '/auth/complete',
  ].includes(path);
}
(async () => {
  try {
    session = await api('/api/session');
    await refresh();
  } catch (e) {
    content.innerHTML =
      header('AMCP', 'Your advertising workspace') + `<div class="notice warning">${esc(e.message)}</div>`;
  }
})();

function googleAssetLabel(a) {
  return (
    (a.status
      ? ' · ' +
        esc({CANCELED: 'Cancelled', ENABLED: 'Active', SUSPENDED: 'Suspended', CLOSED: 'Closed'}[a.status] ?? a.status)
      : '') +
    (a.manager ? ' · Manager' : '') +
    (a.hidden ? ' · Hidden' : '') +
    (a.testAccount ? ' · Test account' : '') +
    (a.parentId ? ' · Via manager ' + esc(a.parentId) : '')
  );
}

function renderAssetSyncDiagnostics(group) {
  const diagnostics = group?.diagnostics ?? [];
  if (!diagnostics.length) return group?.error ? `<p class="error" role="alert">${esc(group.error)}</p>` : '';
  return `<div role="status"><p class="error">Some assets could not be synced. Your login is saved; review the provider details below.</p>${diagnostics.map(d => `<details class="activity-failure" open><summary>${esc(d.account_id ?? 'Connection')} · ${esc(d.provider?.code ?? d.code)}</summary>${renderSourceDiagnostic(d)}</details>`).join('')}</div>`;
}
