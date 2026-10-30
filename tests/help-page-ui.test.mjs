// DOC-03 (owner instruction of 2026-10-24: "DOCS AND HELP ARE MEMBERS ONLY"): the shell's Help page and its footer link.
// The server puts the owner guide in a member's /help page (tests/help-route.test.mjs); web/help.js shows the part in
// the interface language, hides the guide on every other page, takes it out of the page once the session may no longer
// read it (a sign-out, a test account, two-step setup owed), sends a visitor who is not signed in to sign-in, and loads
// /help from the server once when the page was opened from another one. The footer link is offered only to a signed-in
// person whose workspace includes the page. These run the shipped scripts against a minimal document.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));

function shell({session = {authenticated: true}, locale = 'en', guide = 'member'} = {}) {
  const parts = ['en', 'ar'].map(language => ({dataset: {helpLanguage: language}, hidden: false})),
    attributes = new Set(guide === 'unavailable' ? ['data-help-unavailable'] : []),
    // The #help-guide element the server put in the page: its language parts are its children, which setting its
    // textContent removes, as it does in a browser.
    element =
      guide === 'absent'
        ? null
        : {
            hidden: true,
            children: guide === 'unavailable' ? [] : [...parts],
            set textContent(value) {
              this.children = [];
              if (value !== '') throw Error('the guide is only ever emptied, never written by a script');
            },
            hasAttribute: name => attributes.has(name),
            setAttribute: name => void attributes.add(name),
            querySelector(selector) {
              return (
                this.children.find(part => selector === '[data-help-language="' + part.dataset.helpLanguage + '"]') ??
                null
              );
            },
            querySelectorAll(selector) {
              return selector === '[data-help-language]' ? this.children : [];
            },
          },
    storage = new Map(),
    calls = {login: 0, reload: 0};
  const context = createContext({
    Intl,
    Map,
    Set,
    Date,
    catalog,
    session,
    content: {innerHTML: ''},
    location: {pathname: '/help', search: '', hash: '', reload: () => calls.reload++},
    sessionStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)},
    showLogin: () => calls.login++,
    document: {
      addEventListener() {},
      getElementById: id => (id === 'help-guide' ? element : null),
      // The guide's language parts are the only elements of the page that hold it.
      querySelectorAll: selector => (selector === '[data-help-language]' && element ? element.children : []),
    },
  });
  context.sessionStorage.removeItem = key => storage.delete(key);
  const run = source => new Script(source).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  run(fs.readFileSync('web/routes.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(fs.readFileSync('web/help.js', 'utf8'));
  return {run, context, element, parts, calls, storage, render: () => run("AMCP.routes.renderer('/help')()")};
}

test('a member sees the guide in the interface language, with the page heading, and it hides on other pages', async () => {
  for (const locale of ['en', 'ar']) {
    const f = shell({locale});
    await f.render();
    assert.equal(f.element.hidden, false, locale);
    assert.deepEqual(
      f.parts.map(part => [part.dataset.helpLanguage, part.hidden]),
      [
        ['en', locale !== 'en'],
        ['ar', locale !== 'ar'],
      ],
    );
    const heading = f.context.content.innerHTML;
    assert.match(heading, /^<div class="page-heading"><div><h1>/);
    assert.ok(heading.includes(locale === 'ar' ? catalog['Help'] : '<h1>Help</h1>'), locale);
    assert.equal(f.calls.reload + f.calls.login, 0);
    // Every render starts by hiding the guide; only the Help page shows it again.
    f.run('AMCP.hooks.runBefore()');
    assert.equal(f.element.hidden, true);
  }
  // An interface language the guide has no part for shows the English guide.
  const other = shell({locale: 'fr'});
  await other.render();
  assert.deepEqual(
    other.parts.map(part => part.hidden),
    [false, true],
  );
});

// The review of wave 4c: web/app.js signs out without reloading the page (it asks the server for the signed-out session
// and renders Home), so the guide the server put in a member's /help page stayed in the document, hidden, for whoever
// used the tab next. The render after the session changes now takes it out; a member's next visit loads /help again.
test('after a sign-out, or as a test account or before two-step setup, no part of the guide stays in the document', async () => {
  for (const next of [
    {authenticated: false, csrf: null},
    {authenticated: true, testAccount: true},
    {authenticated: true, mfaEnrollmentRequired: true},
  ]) {
    const f = shell(),
      label = JSON.stringify(next);
    await f.render();
    assert.equal(f.element.hidden, false, label);
    assert.equal(f.context.document.querySelectorAll('[data-help-language]').length, 2, label);
    // A member who leaves Help keeps the guide in the page, hidden, for the next visit.
    f.run('AMCP.hooks.runBefore()');
    assert.equal(f.element.hidden, true, label);
    assert.equal(f.context.document.querySelectorAll('[data-help-language]').length, 2, label);
    // The session changes (a sign-out, or another identity in this tab) and the next page renders.
    f.context.session = next;
    f.run('AMCP.hooks.runBefore()');
    assert.equal(f.element.hidden, true, label);
    assert.equal(f.context.document.querySelectorAll('[data-help-language]').length, 0, label);
    assert.equal(f.element.hasAttribute('data-help-unavailable'), true, label);
    // A member who signs in again and opens Help gets the guide from the server, not from this page.
    f.context.session = {authenticated: true};
    await f.render();
    assert.equal(f.calls.reload, 1, label);
    assert.equal(f.element.hidden, true, label);
    assert.match(f.context.content.innerHTML, /role="status" aria-busy="true"/, label);
  }
  // The sign-out replaces the session before it renders the next page, so the render sees the signed-out session.
  const app = fs.readFileSync('web/app.js', 'utf8'),
    logout = app.slice(
      app.indexOf("if (el.id === 'logout-button') {"),
      app.indexOf("if (el.dataset.action === 'refresh')"),
    );
  assert.match(
    logout,
    /await api\('\/api\/session', \{method: 'DELETE'\}\);\s+session = await api\('\/api\/session'\);/,
  );
  assert.ok(logout.indexOf('session = await api') < logout.indexOf("navigate('/')"), 'the session is read first');
});

test('a visitor who is not signed in goes to sign-in, and nothing of the guide is shown', async () => {
  const f = shell({session: {authenticated: false}, guide: 'unavailable'});
  await f.render();
  assert.equal(f.calls.login, 1);
  assert.equal(f.element.hidden, true);
  assert.equal(f.calls.reload, 0);
});

test('a page opened from another page loads /help from the server once, and says so instead of looping', async () => {
  for (const guide of ['absent', 'unavailable']) {
    const f = shell({guide});
    await f.render();
    assert.equal(f.calls.reload, 1, guide);
    assert.match(f.context.content.innerHTML, /role="status" aria-busy="true"/);
    // Within ten seconds of that load the guide is still missing: no second reload, a message instead.
    await f.render();
    assert.equal(f.calls.reload, 1, guide);
    assert.match(f.context.content.innerHTML, /<p class="notice" role="alert">The guide could not be opened\./);
  }
  // Once the guide is shown, the next missing guide may load the page again.
  const f = shell();
  f.storage.set('amcp.help.reload', String(Date.now()));
  await f.render();
  assert.equal(f.storage.has('amcp.help.reload'), false);
});

test('the footer offers Help to signed-in members only; a test account’s scope has no Help page', () => {
  const app = fs.readFileSync('web/app.js', 'utf8'),
    source = app.slice(app.indexOf('function shellLinks() {'), app.indexOf('function closeWorkspaceMenu() {'));
  for (const [session, hidden] of [
    [{authenticated: false}, true],
    [{authenticated: true, workspaceRole: 'viewer'}, false],
    [{authenticated: true, workspaceRole: 'owner'}, false],
    [{authenticated: true, testAccount: true}, true],
  ]) {
    const link = {hidden: true},
      context = createContext({
        session,
        document: {querySelector: () => null, getElementById: id => (id === 'footer-help' ? link : null)},
      });
    new Script(fs.readFileSync('web/routes.js', 'utf8') + '\n' + source + '\nshellLinks();').runInContext(context);
    assert.equal(link.hidden, hidden, JSON.stringify(session));
  }
  // The link is in the shipped footer, hidden until the session says otherwise, beside About us.
  const index = fs.readFileSync('web/index.html', 'utf8');
  assert.match(
    index,
    /<footer class="page-footer"><span class="footer-links"><a href="\/about" data-ui-text="About us">About us<\/a><a href="\/help" id="footer-help" data-ui-text="Help" hidden>Help<\/a><\/span>/,
  );
});
