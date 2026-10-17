// WEB-05: a saved Arabic choice was lost on the way to the static policy pages (unlocalized links), did not follow
// another tab, and a pristine /reports page claimed unsaved edits (a read-only derived field) whenever the language
// changed. These tests guard each of those paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';

// The page asks for catalog chunks (WEB-07: /assets/locales/ar/<chunk>.json); this serves the shipped ones.
const chunkResponse = url =>
  new Response(fs.readFileSync('web/' + String(url).replace(/^\/assets\//, ''), 'utf8'), {
    status: 200,
    headers: {'content-type': 'application/json'},
  });

/** Anchors of a real page, with just the attribute API applyUILocale uses. */
function anchors(file) {
  return [...fs.readFileSync(file, 'utf8').matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map(m => {
    const attributes = {href: m[1]};
    return {
      getAttribute: name => attributes[name] ?? null,
      setAttribute: (name, value) => (attributes[name] = String(value)),
    };
  });
}
/** Matches the comma-separated a[href="..."] selectors applyUILocale builds; nothing else is queried here. */
function documentWith(links, fields = []) {
  return {
    documentElement: {},
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === 'input,select,textarea') return fields;
      const wanted = [...selector.matchAll(/a\[href="([^"]*)"\]/g)].map(m => m[1]);
      return wanted.length ? links.filter(link => wanted.includes(link.getAttribute('href'))) : [];
    },
    addEventListener() {},
  };
}
function localized({links = [], fields = [], stored = {}, confirm = true, extra = {}} = {}) {
  const storage = new Map(Object.entries(stored)),
    listeners = new Map(),
    prompts = [];
  let renders = 0;
  const context = createContext({
    URL,
    Map,
    Set,
    Promise,
    Error,
    Intl,
    TextDecoder,
    AbortController,
    performance,
    setTimeout,
    clearTimeout,
    document: documentWith(links, fields),
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value))},
    addEventListener: (type, listener) => listeners.set(type, listener),
    fetch: async url => chunkResponse(url),
    confirmAction: async options => {
      prompts.push(options);
      return confirm;
    },
    toast() {},
    render: async () => {
      renders++;
    },
    ...extra,
  });
  const run = source => new Script(source).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  return {run, context, storage, listeners, prompts, renders: () => renders};
}
const legal = href => /^\/(?:privacy|terms|data-deletion)(?:\?|$)/.test(href);

test('with saved Arabic, every workspace and About link to the policy pages names Arabic after the page renders', async () => {
  for (const file of ['web/index.html', 'web/about.html']) {
    const links = anchors(file),
      page = localized({links, stored: {'amcp.locale': 'ar'}});
    assert.ok(links.filter(link => legal(link.getAttribute('href'))).length >= 2, file);
    await page.run('initializeUILocale()');
    assert.equal(page.run('uiLocale'), 'ar');
    for (const link of links.filter(link => legal(link.getAttribute('href'))))
      assert.match(link.getAttribute('href'), /\?lang=ar$/, file + ' ' + link.getAttribute('href'));
    // Switching back rewrites the same links instead of appending a second parameter.
    page.run("uiLocale = 'en'; applyUILocale()");
    for (const link of links.filter(link => legal(link.getAttribute('href'))))
      assert.match(link.getAttribute('href'), /^\/[a-z-]+\?lang=en$/, file);
  }
});

test('the landing page built after the last locale pass links the policies in the saved language', async () => {
  const content = {innerHTML: ''},
    page = localized({
      stored: {'amcp.locale': 'ar'},
      extra: {
        content,
        session: {authenticated: false},
        api: async () => ({registrationAvailable: false}),
        esc: value =>
          String(value ?? '').replace(
            /[&<>"']/g,
            c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c],
          ),
        location: {hash: ''},
        matchMedia: () => ({matches: false, addEventListener() {}}),
        requestAnimationFrame() {},
      },
    });
  await page.run('initializeUILocale()');
  // The landing renderer and its helpers; the account page and navigation that follow need a full document (the
  // sign-in pages are account-security.js's alone since WEB-07 removed identity.js's replaced copy).
  const identity = fs.readFileSync('web/identity.js', 'utf8');
  page.run(identity.slice(0, identity.indexOf('async function renderAccountPage()')));
  await page.run('renderLanding()');
  const hrefs = [...content.innerHTML.matchAll(/href="([^"]+)"/g)].map(m => m[1]).filter(legal);
  assert.deepEqual(hrefs.sort(), ['/data-deletion?lang=ar', '/privacy?lang=ar', '/terms?lang=ar']);
});

test('a language chosen in another tab applies here, and still asks before clearing unsaved edits', async () => {
  const page = localized();
  const storage = page.listeners.get('storage');
  assert.equal(typeof storage, 'function', 'The page listens for language changes from other tabs');
  storage({key: 'amcp.theme', newValue: 'dark'});
  storage({key: 'amcp.locale', newValue: 'fr'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.run('uiLocale'), 'en', 'Unrelated keys and unsupported languages are ignored');
  storage({key: 'amcp.locale', newValue: 'ar'});
  for (let i = 0; i < 50 && page.run('uiLocale') !== 'ar'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.run('uiLocale'), 'ar');
  assert.equal(page.renders(), 1);
  assert.equal(page.prompts.length, 0);

  const edited = {
      tagName: 'INPUT',
      type: 'text',
      value: 'typed',
      defaultValue: '',
      readOnly: false,
      matches: () => false,
    },
    guarded = localized({fields: [edited], confirm: false});
  guarded.listeners.get('storage')({key: 'amcp.locale', newValue: 'ar'});
  for (let i = 0; i < 50 && !guarded.prompts.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(guarded.prompts.length, 1, 'Unsaved edits are confirmed first');
  assert.equal(guarded.run('uiLocale'), 'en', 'Declining keeps this tab and its edits');
});

test('a pristine page with read-only or derived fields has no unsaved edits, so a language switch asks nothing', async () => {
  const field = (props, selectors = []) => ({
    tagName: 'INPUT',
    type: 'text',
    defaultValue: '',
    readOnly: false,
    matches: selector => selectors.some(s => selector.includes(s)),
    ...props,
  });
  // The /reports capture form fills its fixed native conversion field (read-only) when the preset is chosen.
  const derived = [
    field({name: 'conversion_definition', value: 'metrics.conversions', readOnly: true}),
    field({name: 'timezone', value: 'UTC', readOnly: true}),
    field({name: 'computed', value: '42'}, ['[data-derived]']),
  ];
  const page = localized({fields: derived});
  assert.equal(page.run('uiHasUnsavedEdits()'), false);
  assert.equal(await page.run("changeUILocale('ar')"), true);
  assert.equal(page.prompts.length, 0, 'No dialog on a pristine page');

  const typed = localized({fields: [...derived, field({name: 'source_name', value: 'Typed name'})]});
  assert.equal(typed.run('uiHasUnsavedEdits()'), true, 'A typed value is still an unsaved edit');

  // A value the page fills in itself becomes the field's starting state.
  const input = field({value: ''}),
    options = [
      {value: 'a', selected: true, defaultSelected: true},
      {value: 'b', selected: false, defaultSelected: false},
    ],
    select = {
      tagName: 'SELECT',
      options,
      set value(v) {
        for (const option of options) option.selected = option.value === v;
      },
    };
  page.context.input = input;
  page.context.select = select;
  page.run("uiSetInitialValue(input, 'prefilled'); uiSetInitialValue(select, 'b')");
  assert.equal(page.run('uiHasUnsavedEdits()'), false);
  assert.equal(input.value, 'prefilled');
  assert.equal(input.defaultValue, 'prefilled');
  assert.deepEqual(
    options.map(o => [o.selected, o.defaultSelected]),
    [
      [false, false],
      [true, true],
    ],
  );
});

// The browser pristine-route probe found /profiles dirty on first render: the playbook form is filled from saved data
// (the advanced JSON field) and a colour field reports '#354b67' for markup '#354B67'.
test('a form filled from saved data, and a colour field written in capitals, are pristine', () => {
  const field = props => ({tagName: 'INPUT', type: 'text', readOnly: false, matches: () => false, ...props});
  const colour = field({type: 'color', value: '#354b67', defaultValue: '#354B67'}),
    additional = field({tagName: 'TEXTAREA', type: 'textarea', value: '{\n  "defaults": {}\n}', defaultValue: '{}'}),
    approve = field({type: 'checkbox', checked: true, defaultChecked: false}),
    options = [
      {value: '', selected: false, defaultSelected: true},
      {value: 'compact', selected: true, defaultSelected: false},
    ],
    template = {tagName: 'SELECT', type: 'select-one', readOnly: false, matches: () => false, options},
    upload = field({type: 'file', files: [], value: ''}),
    fields = [colour, additional, approve, template, upload],
    form = {querySelectorAll: selector => (selector === 'input,select,textarea' ? fields : [])},
    page = localized({fields: [colour]});
  assert.equal(page.run('uiHasUnsavedEdits()'), false, 'Colour case is not an edit');
  colour.value = '#ffffff';
  assert.equal(page.run('uiHasUnsavedEdits()'), true, 'A chosen colour is an edit');
  colour.value = '#354b67';

  const filled = localized({fields});
  assert.equal(filled.run('uiHasUnsavedEdits()'), true, 'Before: the filled values look like edits');
  filled.context.form = form;
  filled.run('uiMarkPristine(form)');
  assert.equal(filled.run('uiHasUnsavedEdits()'), false, 'After: the filled values are the starting state');
  assert.equal(additional.defaultValue, additional.value);
  assert.equal(approve.defaultChecked, true);
  assert.deepEqual(
    options.map(o => o.defaultSelected),
    [false, true],
  );
  additional.value = '{}';
  assert.equal(filled.run('uiHasUnsavedEdits()'), true, 'A later edit is still detected');
  // The playbook editor marks its form pristine after filling it.
  const source = fs.readFileSync('web/client-playbooks.js', 'utf8'),
    load = source.slice(source.indexOf('const load = p => {'), source.indexOf("$('#profile-recipe')"));
  assert.match(load, /drawDefaults\(\);[\s\S]*uiMarkPristine\(form\);\s*\};\s*$/);
});
