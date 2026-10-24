// DOC-03 (owner instruction of 2026-10-24: "DOCS AND HELP ARE MEMBERS ONLY"): the shell's Help page and its footer link.
// The server puts the owner guide in a member's /help page (tests/help-route.test.mjs); web/help.js shows the part in
// the interface language, hides the guide on every other page, sends a visitor who is not signed in to sign-in, and
// loads /help from the server once when the page was opened from another one. The footer link is offered only to a
// signed-in person whose workspace includes the page. These run the shipped scripts against a minimal document.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));

function shell({session = {authenticated: true}, locale = 'en', guide = 'member'} = {}) {
  const parts = ['en', 'ar'].map(language => ({dataset: {helpLanguage: language}, hidden: false})),
    element =
      guide === 'absent'
        ? null
        : {
            hidden: true,
            hasAttribute: name => name === 'data-help-unavailable' && guide === 'unavailable',
            querySelector: selector =>
              parts.find(part => selector === '[data-help-language="' + part.dataset.helpLanguage + '"]') ?? null,
            querySelectorAll: selector => (selector === '[data-help-language]' ? parts : []),
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
    document: {addEventListener() {}, getElementById: id => (id === 'help-guide' ? element : null)},
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
