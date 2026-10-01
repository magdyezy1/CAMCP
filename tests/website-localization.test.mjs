import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {localeProblems, inspectLocaleSource, checkWebLocales} from '../tools/check-locales.mjs';

function fixture(saved = 'en') {
  const preferences = new Map([['amcp.locale', saved]]),
    confirmations = [],
    requests = [],
    notices = [];
  const root = {lang: 'en', dir: 'ltr'},
    controls = [],
    labels = [];
  let renders = 0;
  const context = createContext({
    document: {
      documentElement: root,
      querySelectorAll: selector =>
        selector === '[data-ui-text]' ? labels : selector === '[data-language-select]' ? controls : [],
      querySelector: () => null,
      addEventListener() {},
    },
    localStorage: {getItem: k => preferences.get(k), setItem: (k, v) => preferences.set(k, v)},
    navigationGeneration: 1,
    identityGeneration: 1,
    fetch: (url, args) => new Promise((resolve, reject) => requests.push({url, args, resolve, reject})),
    render: async () => {
      renders++;
    },
    toast: message => notices.push(message),
    confirmAction: args => new Promise(resolve => confirmations.push({args, resolve})),
    Intl,
    Date,
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  const run = code => new Script(code).runInContext(context);
  const respond = (index = 0, data = {'Home': 'الرئيسية', 'Hello, {name}': 'مرحبًا، {name}'}) =>
    requests[index].resolve({ok: true, text: async () => JSON.stringify(data)});
  return {
    context,
    run,
    preferences,
    confirmations,
    requests,
    notices,
    root,
    controls,
    labels,
    respond,
    renders: () => renders,
  };
}

test('Arabic preference uses a fixed local catalog, applies language/direction and keeps dynamic values intact', async () => {
  const f = fixture('ar'),
    initializing = f.run('initializeUILocale()');
  assert.equal(f.requests[0].url, '/assets/locales/ar.json');
  f.respond();
  await initializing;
  assert.equal(f.root.lang, 'ar');
  assert.equal(f.root.dir, 'rtl');
  assert.equal(f.run("uiText('Home')"), 'الرئيسية');
  assert.equal(
    f.run("uiText('Hello, {name}', {name:'<img onerror=bad> & Account 001'})"),
    'مرحبًا، <img onerror=bad> & Account 001',
  );
  assert.equal(f.run("uiText('provider_CANARY_001')"), 'provider_CANARY_001');
  assert.equal(f.run("uiNumber('100000000000000000.01')"), '100000000000000000.01');
  assert.equal(f.run('uiNumber(1234)'), new Intl.NumberFormat('ar').format(1234));
  assert.equal(
    f.run("uiDate(0, {timeZone:'UTC',year:'numeric',month:'long',day:'numeric'})"),
    new Intl.DateTimeFormat('ar', {timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric'}).format(0),
  );
});

test('unknown preferences and invalid catalogs fail safely without changing input controls or accepting placeholder drift', async () => {
  const unknown = fixture('https://untrusted.test/locale');
  await unknown.run('initializeUILocale()');
  assert.equal(unknown.requests.length, 0);
  assert.equal(unknown.root.dir, 'ltr');
  const f = fixture('ar'),
    initializing = f.run('initializeUILocale()');
  f.respond(0, {'Hello, {name}': 'مرحبًا، {password}'});
  await initializing;
  assert.equal(f.root.lang, 'en');
  assert.equal(f.run("uiText('Hello, {name}', {name:'Member'})"), 'Hello, Member');
});

test('language changes confirm unsaved edits and cannot apply a late confirmation across identity changes', async () => {
  const f = fixture();
  f.context.document.querySelectorAll = selector =>
    selector === 'input,select,textarea'
      ? [{type: 'text', value: 'edited', defaultValue: 'original', matches: () => false}]
      : [];
  let changing = f.run("changeUILocale('ar')");
  assert.equal(f.confirmations.length, 1);
  assert.match(f.confirmations[0].args.consequence, /Unsaved edits/);
  f.confirmations[0].resolve(false);
  assert.equal(await changing, false);
  assert.equal(f.requests.length, 0);
  assert.equal(f.renders(), 0);
  changing = f.run("changeUILocale('ar')");
  f.context.identityGeneration++;
  f.confirmations[1].resolve(true);
  assert.equal(await changing, false);
  assert.equal(f.requests.length, 0);
  assert.equal(f.preferences.get('amcp.locale'), 'en');
});

test('explicit language selection rerenders once, survives unavailable storage and leaves verification tickets intact', async () => {
  const f = fixture();
  f.context.localStorage.setItem = () => {
    throw Error('Storage denied');
  };
  f.context.loginMfaTicket = 'private-MFA';
  f.context.verificationLink = {token: 'private-verification'};
  const changing = f.run("changeUILocale('ar')");
  f.respond();
  assert.equal(await changing, true);
  assert.equal(f.renders(), 1);
  assert.equal(f.context.loginMfaTicket, 'private-MFA');
  assert.equal(f.context.verificationLink.token, 'private-verification');
  assert.equal(f.root.dir, 'rtl');
  assert.equal(await f.run("changeUILocale('de')"), false);
});

test('returning to English cancels an older catalog read, including initialization; untouched default selects need no confirmation', async () => {
  for (const initialize of [false, true]) {
    const f = fixture(initialize ? 'ar' : 'en');
    f.context.document.querySelectorAll = selector =>
      selector === 'input,select,textarea'
        ? [
            {
              tagName: 'SELECT',
              matches: () => false,
              options: [
                {selected: true, defaultSelected: false},
                {selected: false, defaultSelected: false},
              ],
            },
          ]
        : [];
    const changing = f.run(initialize ? 'initializeUILocale()' : "changeUILocale('ar')");
    assert.equal(f.confirmations.length, 0);
    assert.equal(await f.run("changeUILocale('en')"), false);
    f.respond();
    await changing;
    assert.equal(f.root.lang, 'en');
    assert.equal(f.renders(), 0);
  }
});

test('catalog checks reject missing or altered placeholders and translated protocol/keyboard values', () => {
  assert.equal(localeProblems({'Hello {name}': 'مرحبًا {name}'}, new Set(['Hello {name}'])).length, 0);
  assert.equal(localeProblems({'Hello {name}': 'مرحبًا {role}'}, new Set(['Home', 'Hello {name}'])).length, 2);
  for (const source of [
    "if(event.key===uiText('Enter')) run();",
    "api({role:uiText('viewer')});",
    "api({method:uiText('GET')});",
  ])
    assert.equal(inspectLocaleSource(source).problems.length, 1);
  assert.deepEqual(checkWebLocales().problems, []);
});

test('English and Arabic sign-in/MFA screens submit identical endpoints and original field values', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale),
      initializing = f.run('initializeUILocale()');
    if (locale === 'ar') f.respond(0, JSON.parse(readFileSync('web/locales/ar.json', 'utf8')));
    await initializing;
    const nodes = new Map(),
      bindings = new Map(),
      calls = [];
    const node = selector => {
      if (!nodes.has(selector))
        nodes.set(selector, {innerHTML: '', textContent: '', addEventListener() {}, focus() {}});
      return nodes.get(selector);
    };
    Object.assign(f.context, {
      URLSearchParams,
      location: {pathname: '/login', search: '', hash: ''},
      history: {replaceState() {}},
      FormData: class {
        constructor(form) {
          return new Map(Object.entries(form.values));
        }
      },
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
      authBind: (selector, handler) => bindings.set(selector, handler),
      api: async (url, args) => {
        if (args) calls.push({url, method: args.method, body: JSON.parse(args.body)});
        if (url === '/api/account/options') return {providers: [], emailEnabled: true, signupEnabled: true};
        if (url === '/api/account/login') return {mfaRequired: true, ticket: 'original-MFA-ticket'};
        if (url === '/api/platforms') return {platforms: []};
        return {};
      },
    });
    f.run(readFileSync('web/account-security.js', 'utf8'));
    await f.context.renderAuthPage();
    assert.match(node('#content').innerHTML, /name="email"/);
    assert.match(node('#content').innerHTML, /name="password"/);
    if (locale === 'ar') assert.match(node('#content').innerHTML, /يسعدنا رجوعك/);
    await bindings.get('#member-form')({
      values: {email: 'native+001@example.test', password: 'Synthetic private phrase 123'},
    });
    assert.match(node('#content').innerHTML, /name="code"/);
    if (locale === 'ar') assert.match(node('#content').innerHTML, /التحقق بخطوتين/);
    await bindings.get('#mfa-login')({values: {code: '001234'}});
    transcripts.push(calls);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
  assert.deepEqual(transcripts[0], [
    {
      url: '/api/account/login',
      method: 'POST',
      body: {email: 'native+001@example.test', password: 'Synthetic private phrase 123'},
    },
    {url: '/api/account/mfa/login', method: 'POST', body: {ticket: 'original-MFA-ticket', code: '001234'}},
  ]);
});

test('Arabic Home translates task labels while preserving and escaping campaign names and IDs', async () => {
  const f = fixture('ar'),
    initializing = f.run('initializeUILocale()');
  f.respond(0, JSON.parse(readFileSync('web/locales/ar.json', 'utf8')));
  await initializing;
  Object.assign(f.context, {
    session: {name: 'Home'},
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    header: (title, description, action) => `<h1>${title}</h1><p>${description}</p>${action}`,
    glyph: () => '',
    date: () => '',
    badge: value => value,
  });
  f.run(readFileSync('web/work-center.js', 'utf8'));
  f.context.data = {
    campaigns: [
      {id: 'native/001', name: 'Home', state: 'draft', updated_at: 1},
      {id: 'native/002', name: '<img onerror=bad>', state: 'draft', updated_at: 2},
    ],
    writes_paused: null,
  };
  const html = f.run('workHome(data,[{}])');
  assert.match(html, /<h1>الرئيسية<\/h1>/);
  assert.match(html, /<strong>Home<\/strong>/);
  assert.match(html, /campaigns\?id=native%2F001/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});
