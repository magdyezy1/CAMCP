import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {WebStore} from '../dist/server/web-store.js';
import {UserAccounts} from '../dist/server/user-accounts.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

/**
 * SEC-05 (review 2026-10-08): the public sign-in page advertised "Claim this deployment with its administrator
 * password" because the flag reported only that the password was configured, even after the workspace moved to its
 * owner account, when the door can only refuse. The door is now offered while it can open, listed publicly only until
 * anyone holds an account, reachable for the owner at /login?owner=1, and labelled "Owner sign-in".
 */
const origin = 'https://amcp.invalid',
  master = Buffer.alloc(32, 31).toString('base64'),
  password = 'synthetic-owner-door-password';

async function site() {
  const store = new Store(':memory:', master),
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        throw Error('Unexpected provider request');
      }),
    ),
    website = {origin, masterKey: master, adminPassword: password, authEnv: {}};
  const listener = await listenForFetch(createHttpApp(service, store, {publicOrigin: origin, website}));
  const base = 'http://127.0.0.1:' + listener.address().port;
  return {
    store,
    accounts: new UserAccounts(new WebStore(store, website)),
    options: async () => (await fetch(base + '/api/account/options')).json(),
    signIn: async () =>
      fetch(base + '/api/session', {
        method: 'POST',
        headers: {Origin: origin, 'Content-Type': 'application/json'},
        body: JSON.stringify({password}),
      }),
    close: async () => {
      await new Promise(resolve => listener.close(resolve));
      store.close();
    },
  };
}

test('SEC-05: account options report the administrator door only while it can open, and list it only until an account exists (regression: administratorEnabled ignored owner migration)', async () => {
  const s = await site();
  try {
    assert.deepEqual(
      {enabled: (await s.options()).administratorEnabled, listed: (await s.options()).administratorListed},
      {enabled: true, listed: true},
    );
    s.accounts.newUser('Member', 'member@example.test', null, true);
    const withAccount = await s.options();
    assert.equal(withAccount.administratorEnabled, true);
    assert.equal(withAccount.administratorListed, false);
    assert.equal((await s.signIn()).status, 200);
    s.store.putDocument('local', 'account_settings', 'owner_migration', {owner_user_id: 'synthetic-owner'});
    const migrated = await s.options();
    assert.equal(migrated.administratorEnabled, false);
    assert.equal(migrated.administratorListed, false);
    // The door itself still refuses, as before.
    const refused = await s.signIn();
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error.code, 'OWNER_LOGIN_REQUIRED');
  } finally {
    await s.close();
  }
});

test('SEC-05: a pending (unapproved) sign-up does not hide the door, and with no administrator password it is neither enabled nor listed', async () => {
  const s = await site();
  try {
    s.accounts.newUser('Pending', 'pending@example.test', null, false);
    assert.equal((await s.options()).administratorListed, true);
  } finally {
    await s.close();
  }
  const store = new Store(':memory:', master),
    listener = await listenForFetch(
      createHttpApp(new MirrorService(new Registry(), store, new NativeTransport()), store, {
        publicOrigin: origin,
        website: {origin, masterKey: master, authEnv: {}},
      }),
    );
  try {
    const options = await (await fetch('http://127.0.0.1:' + listener.address().port + '/api/account/options')).json();
    assert.equal(options.administratorEnabled, false);
    assert.equal(options.administratorListed, false);
  } finally {
    await new Promise(resolve => listener.close(resolve));
    store.close();
  }
});

/** The sign-in page as web/account-security.js renders it, in English or Arabic, for these account options. */
async function signInPage(options, search = '', locale = 'en') {
  const preferences = new Map([['amcp.locale', locale]]),
    requests = [],
    nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {innerHTML: '', textContent: '', addEventListener() {}, focus() {}});
    return nodes.get(selector);
  };
  const context = createContext({
    document: {
      documentElement: {lang: 'en', dir: 'ltr'},
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
    },
    localStorage: {getItem: k => preferences.get(k), setItem: (k, v) => preferences.set(k, v)},
    navigationGeneration: 1,
    identityGeneration: 1,
    fetch: (url, args) => new Promise((resolve, reject) => requests.push({url, args, resolve, reject})),
    render: async () => {},
    toast() {},
    Intl,
    Date,
    AbortController,
    TextDecoder,
    performance,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    location: {pathname: '/login', search, hash: ''},
    history: {replaceState() {}},
    renderAccountPage: async () => {},
    renderAuthPage: async () => {},
    formField() {},
    socialButtons() {},
    authOptions: null,
    authErrors: {},
    verificationLink: null,
    session: {authenticated: false},
    platforms: [],
    content: node('#content'),
    $: node,
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    glyph: () => '',
    brandLink: () => '<a>AMCP</a>',
    afterSignIn() {},
    authBind() {},
    api: async url => (url === '/api/account/options' ? options : {}),
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  const initializing = run('initializeUILocale()');
  // The sign-in page needs only the shell's catalog chunk (WEB-07).
  if (locale === 'ar') {
    assert.equal(requests[0].url, '/assets/locales/ar/shell.json');
    requests[0].resolve(new Response(readFileSync('web/locales/ar/shell.json', 'utf8')));
  }
  await initializing;
  // account-security.js registers its part of /account with the route registry's extension points (WEB-07).
  run(readFileSync('web/routes.js', 'utf8'));
  run(readFileSync('web/account-security.js', 'utf8'));
  await context.renderAuthPage();
  return node('#content').innerHTML;
}

test('SEC-05: the sign-in page has no owner section once the door cannot open, hides it from the public once accounts exist, and opens it at ?owner=1', async () => {
  const base = {providers: [], emailEnabled: true, signupEnabled: true, testEnabled: false};
  const migrated = await signInPage({...base, administratorEnabled: false, administratorListed: false}, '?owner=1');
  assert.doesNotMatch(migrated, /owner-entry|data-open-admin/);
  assert.match(migrated, /name="email"/);
  const inUse = await signInPage({...base, administratorEnabled: true, administratorListed: false});
  assert.doesNotMatch(inUse, /owner-entry|data-open-admin/);
  for (const search of ['?owner=1', '']) {
    const html = await signInPage(
      {...base, administratorEnabled: true, administratorListed: search === ''},
      search === '' ? '' : search,
    );
    assert.match(html, /<section class="owner-entry">.*Owner sign-in.*data-open-admin/);
    assert.doesNotMatch(html, /Claim this deployment|OWNER SETUP/);
  }
  const arabic = await signInPage({...base, administratorEnabled: true, administratorListed: false}, '?owner=1', 'ar');
  assert.match(arabic, /تسجيل دخول المالك/);
  assert.doesNotMatch(arabic, /Owner sign-in/);
});
