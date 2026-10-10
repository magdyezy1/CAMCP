// WEB-05: shell identifiers were not isolated, so an English account name or a numeric ID reordered inside Arabic
// text (accountText joined name + ' (' + id + ')'; Activity joined gateway, account and connection IDs), messages were
// glued from space-padded fragments, the default workspace name stayed an English template, digits followed the
// runtime's Arabic default, and audit, session and token times named no time zone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {inspectLocaleSource, shellScripts} from '../tools/check-locales.mjs';

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
  app = fs.readFileSync('web/app.js', 'utf8');
function shell(locale = 'ar', extra = {}) {
  const context = createContext({Intl, Map, Set, document: {addEventListener() {}}, catalog, ...extra});
  const run = source => new Script(source).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  return {run, context};
}

test('uiBidi isolates escaped values and uiMarkup fills a translated message with markup slots', () => {
  const page = shell('ar');
  assert.equal(page.run("uiBidi('Acme <b>')"), '<bdi>Acme &lt;b&gt;</bdi>');
  assert.equal(page.run("uiBidi('act_100', 'ltr')"), '<bdi dir="ltr">act_100</bdi>');
  assert.equal(page.run('uiBidi(undefined)'), '<bdi></bdi>');
  assert.equal(
    page.run("uiMarkup('Via manager {id}', {id: uiBidi('123-456-7890', 'ltr')})"),
    'عبر المدير <bdi dir="ltr">123-456-7890</bdi>',
  );
  assert.equal(
    page.run("uiMarkup('Your current verified address is {email}.', {email: uiBidi('a<b@example.com', 'ltr')})"),
    'عنوان بريدك الموثّق الحالي هو <bdi dir="ltr">a&lt;b@example.com</bdi>.',
  );
  // An unknown slot stays visible rather than disappearing.
  assert.equal(shell('en').run("uiMarkup('A <b> {missing}')"), 'A &lt;b&gt; {missing}');
});

test('account labels in markup isolate the name, the ID and the login; plain labels are unchanged', () => {
  const platforms = [
    {
      id: 'meta',
      name: 'Meta',
      gateway: 'meta_native_action',
      connections: [
        {
          id: 'login-1',
          name: 'Agency <login>',
          enabled: true,
          accounts: ['act_100'],
          groups: [{assets: [{id: 'act_100', name: 'Acme Store'}]}],
        },
        {id: 'login-2', name: 'Second', enabled: true, accounts: ['200'], groups: []},
      ],
    },
  ];
  const page = shell('ar', {platforms});
  page.run(app.slice(app.indexOf("/** An account's own name"), app.indexOf('function renderConnections()')));
  page.context.p = platforms[0];
  page.context.c = platforms[0].connections[0];
  assert.equal(page.run("accountText(p, c, 'act_100')"), 'Acme Store (act_100) · Agency <login>');
  assert.equal(
    page.run("accountHtml(p, c, 'act_100')"),
    '<bdi><bdi>Acme Store</bdi> (<bdi dir="ltr">act_100</bdi>) · <bdi>Agency &lt;login&gt;</bdi></bdi>',
  );
  assert.equal(
    page.run("accountLabelHtml(p, c, 'act_100')"),
    '<bdi><bdi>Meta</bdi> · <bdi><bdi>Acme Store</bdi> (<bdi dir="ltr">act_100</bdi>) · <bdi>Agency &lt;login&gt;</bdi></bdi></bdi>',
  );
  assert.equal(
    page.run("recordAccountLabelHtml('meta', 'login-1', 'act_100')"),
    page.run("accountLabelHtml(p, c, 'act_100')"),
  );
  assert.equal(
    page.run("recordAccountLabel('meta', 'login-1', 'act_100')"),
    'Meta · Acme Store (act_100) · Agency <login>',
  );
  // A record whose login is gone still isolates what it names.
  assert.equal(
    page.run("recordAccountLabelHtml('tiktok', 'gone', '<7>')"),
    '<bdi><bdi>tiktok</bdi> · <bdi dir="ltr">&lt;7&gt;</bdi></bdi>',
  );
});

test('Activity isolates gateway, account and connection IDs and shows times with their zone', async () => {
  const nodes = new Map(),
    node = key => {
      if (!nodes.has(key))
        nodes.set(key, {
          innerHTML: '',
          isConnected: true,
          elements: {search: {value: ''}, account_id: {value: ''}},
          setAttribute() {},
          focus() {},
          addEventListener() {},
        });
      return nodes.get(key);
    };
  const page = shell('ar', {
    session: {authenticated: true},
    content: node('content'),
    navigationGeneration: 1,
    identityGeneration: 1,
    URLSearchParams,
    header: (a, b) => a + b,
    $: node,
    esc: value =>
      String(value ?? '').replace(
        /[&<>"']/g,
        c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c],
      ),
    workspaceBind() {},
    renderSourceDiagnostic: () => '',
    api: async () => ({
      events: [
        {
          id: 1,
          at: Date.UTC(2026, 9, 10, 9, 5),
          event: {event: 'native_read', gateway: 'meta_native_action', account_id: '100', connection_id: 'login-1'},
        },
      ],
    }),
  });
  page.run(app.slice(app.indexOf('async function renderActivity()'), app.indexOf('async function renderCallback()')));
  await page.run('renderActivity()');
  const html = node('content').innerHTML + node('#activity-results').innerHTML;
  assert.match(
    html,
    /<small><bdi dir="ltr">meta_native_action<\/bdi> · <bdi dir="ltr">100<\/bdi> · <bdi dir="ltr">login-1<\/bdi><\/small>/,
  );
  const time = /<span class="muted">([^<]+)<\/span>/.exec(html)?.[1];
  assert.ok(time, 'The event time is shown');
  assert.match(time, /2026/, 'Latin digits');
  assert.match(time, /غرينتش|UTC|GMT|[+-]\d/, 'The time names its zone: ' + time);
});

test('Latin digits are pinned and audit times name their zone in both languages', () => {
  // A runtime whose Arabic default is Arabic-Indic (ICU ar-EG) still shows Latin digits (owner decision D27).
  const page = shell('ar');
  page.run("uiLocale = 'ar-EG'");
  assert.match(page.run('uiNumber(1234.5)'), /^1\D?234\D5$/u);
  assert.doesNotMatch(page.run('uiNumber(1234.5)'), /[٠-٩]/);
  assert.doesNotMatch(page.run("uiDate('2026-10-10T09:05:00Z')"), /[٠-٩]/);
  for (const locale of ['en', 'ar']) {
    const zoned = shell(locale).run("uiDateZoned('2026-10-10T09:05:00Z')");
    assert.match(zoned, /2026/);
    assert.doesNotMatch(zoned, /[٠-٩]/);
    assert.match(zoned, locale === 'en' ? /(?:UTC|GMT)/ : /(?:غرينتش|UTC|GMT|[+-]\d)/, zoned);
  }
  assert.equal(shell('ar').run("uiDateZoned('not a date')"), catalog['Date unavailable']);
});

test('the default workspace name reads in the interface language; a chosen name is kept as written', () => {
  const ar = shell('ar');
  assert.equal(ar.run("uiWorkspaceName('Lina’s workspace', 'Lina')"), 'مساحة عمل Lina');
  assert.equal(ar.run("uiWorkspaceName('Growth team', 'Lina')"), 'Growth team');
  assert.equal(ar.run('uiWorkspaceName(undefined, "Lina")'), catalog['AMCP workspace']);
  assert.equal(shell('en').run("uiWorkspaceName('Lina’s workspace', 'Lina')"), 'Lina’s workspace');
  // The server's default template is what the shell recognizes.
  assert.match(fs.readFileSync('server/user-accounts.ts', 'utf8'), /’s workspace/);
});

test('shell scripts build sentences from slotted messages, not space-padded fragments', () => {
  const padded = "uiText(' · Manager'); uiText('Last sync: ') + date(x); uiText(ok ? 'Fine' : 'Token expires ')";
  assert.equal(inspectLocaleSource(padded, 'app.js').problems.length, 3);
  assert.equal(inspectLocaleSource(padded, 'operations-center.js').problems.length, 0, 'Feature modules are tracked');
  assert.equal(inspectLocaleSource("uiText('Last sync: {date}', {date})", 'app.js').problems.length, 0);
  for (const file of shellScripts) {
    if (!fs.existsSync('web/' + file)) continue;
    assert.deepEqual(inspectLocaleSource(fs.readFileSync('web/' + file, 'utf8'), file).problems, [], file);
  }
  // The retired fragments are gone from the catalog, and their slotted replacements are translated.
  for (const key of [' · Manager', 'Last sync: ', 'Token expires ', 'Connecting ', 'Approve on '])
    assert.equal(Object.hasOwn(catalog, key), false, key);
  for (const key of ['Last sync: {date}', 'Token expires {date}', 'Connecting {platform}.', 'Approve on {platform}'])
    assert.match(catalog[key], /[؀-ۿ]/, key);
});
