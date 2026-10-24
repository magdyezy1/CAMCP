// DOC-03 (owner instruction of 2026-10-24: "DOCS AND HELP ARE MEMBERS ONLY"): the owner guide is shown on the website at
// /help to signed-in members only. Before it, the website had no help page and no link to documentation. These checks
// run the real website: a member's /help carries the guide in both languages; a visitor who is not signed in and a test
// account get the workspace shell without it (the shell sends them to sign-in or Home); the answer is never cached and
// is keyed by the session cookie; the strict security headers are those of every page; and the guide is in no public
// asset, robots entry or public page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {createPublicAssets, robotsTxt} from '../dist/server/public-assets.js';
import {helpPath} from '../dist/server/help-routes.js';
import {UserAccounts} from '../dist/server/user-accounts.js';
import {WebStore} from '../dist/server/web-store.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

const varyCookie = /(?:^|,)\s*cookie\s*(?:,|$)/i,
  guide = JSON.parse(fs.readFileSync('generated/help-guide.json', 'utf8')).languages;
// One sentence of each language that only the guide holds.
const english = 'Nothing changes without a review.',
  arabic = 'لا يتغير شيء دون مراجعة.';

async function site() {
  const master = Buffer.alloc(32, 63).toString('base64'),
    store = new Store(':memory:', master),
    options = {origin: 'https://amcp.invalid', masterKey: master, authEnv: {}};
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('No provider request is allowed');
    }),
  );
  const web = new WebStore(store, options),
    accounts = new UserAccounts(web),
    member = accounts.newUser('Help reader', 'help@example.test', null, true),
    reviewer = accounts.newUser('Reviewer', 'reviewer@example.test', null, true, true),
    cookie = session => web.cookie(session.id).split(';')[0];
  const listener = await listenForFetch(
    createHttpApp(service, store, {publicOrigin: options.origin, website: options}),
  );
  const base = 'http://127.0.0.1:' + listener.address().port;
  return {
    member: cookie(accounts.session(member)),
    reviewer: cookie(accounts.session(reviewer)),
    get: (route, headers = {}) => fetch(base + route, {headers, redirect: 'manual'}),
    async close() {
      const closed = new Promise(resolve => listener.close(resolve));
      listener.closeAllConnections();
      await closed;
      store.close();
    },
  };
}

test('a signed-in member’s /help carries the owner guide in English and Arabic, never cached', async () => {
  const s = await site();
  try {
    assert.equal(helpPath, '/help');
    const response = await s.get('/help', {cookie: s.member}),
      page = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('vary') ?? '', varyCookie);
    // The workspace shell, with the guide hidden beside the page content until the Help page script shows it.
    const shell = createPublicAssets('web').html('index.html'),
      embedded = '<div id="help-guide" class="help-guide" hidden>' + guide.en.html + guide.ar.html + '</div>';
    assert.equal(
      page,
      shell.replace('</main>', () => embedded + '</main>'),
    );
    assert.ok(page.includes(english) && page.includes(arabic));
    assert.match(page, /<div class="help-guide-language" lang="ar" dir="rtl" data-help-language="ar">/);
    // The same strict security headers as every page: the guide needs no script or style of its own.
    const home = await s.get('/dashboard', {cookie: s.member});
    for (const header of ['content-security-policy', 'referrer-policy', 'x-frame-options', 'permissions-policy'])
      assert.equal(response.headers.get(header), home.headers.get(header), header);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'; style-src 'self'/);
  } finally {
    await s.close();
  }
});

test('a visitor who is not signed in, or a test account, gets the shell without the guide (members only)', async () => {
  const s = await site();
  try {
    for (const [who, headers] of [
      ['signed out', {}],
      ['an unknown session', {cookie: 'amcp_session=' + 'x'.repeat(43)}],
      ['a test account', {cookie: s.reviewer}],
    ]) {
      const response = await s.get('/help', headers),
        page = await response.text();
      assert.equal(response.status, 200, who);
      assert.equal(response.headers.get('cache-control'), 'no-store', who);
      assert.match(response.headers.get('vary') ?? '', varyCookie, who);
      assert.ok(page.includes('<div id="help-guide" class="help-guide" data-help-unavailable hidden></div>'), who);
      assert.ok(!page.includes(english) && !page.includes(arabic), who + ' receives no part of the guide');
      assert.ok(!page.includes('help-guide-language'), who);
    }
  } finally {
    await s.close();
  }
});

test('the guide is in no public file, robots entry or public page', async () => {
  const s = await site();
  try {
    // The public asset snapshot (web/) holds no part of the guide, so no /assets address can serve it.
    for (const file of fs.readdirSync('web', {recursive: true}).map(String))
      if (fs.statSync('web/' + file).isFile() && !file.endsWith('.ttf'))
        assert.ok(!fs.readFileSync('web/' + file, 'utf8').includes(english), 'web/' + file);
    for (const address of [
      '/assets/help-guide.json',
      '/assets/generated/help-guide.json',
      '/generated/help-guide.json',
    ]) {
      const response = await s.get(address, {cookie: s.member});
      await response.arrayBuffer();
      assert.notEqual(response.status, 200, address);
    }
    // No crawler is pointed at it, and the public pages and sign-in pages do not carry it.
    assert.doesNotMatch(robotsTxt, /help/i);
    for (const route of ['/', '/login', '/about', '/privacy', '/dashboard']) {
      const page = await (await s.get(route, {cookie: s.member})).text();
      assert.ok(!page.includes(english) && !page.includes('help-guide-language'), route);
    }
  } finally {
    await s.close();
  }
});
