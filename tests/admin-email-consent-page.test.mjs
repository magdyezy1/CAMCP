// r25-admin-email, review S2-1 (the lead's decision of 2026-11-21): on the consent screen Owner access is offered but never
// preselected, and choosing it needs its own confirmation that names the app and its return host; the connector-token form
// keeps its checkbox and does not call Owner the default. The page runs in a fake DOM, as tests/connection-localization.test.mjs
// runs it; what the server does without the confirmation is pinned in tests/admin-email-ai-owner.test.ts. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
function fixture(locale) {
  const nodes = new Map(),
    listeners = new Map(),
    calls = [],
    toasts = [];
  const node = selector => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        innerHTML: '',
        textContent: '',
        value: '',
        checked: false,
        dataset: {},
        isConnected: true,
        classList: {add() {}, remove() {}, toggle() {}},
        getAttribute() {
          return null;
        },
        setAttribute() {},
        events: new Map(),
        addEventListener(event, fn) {
          this.events.set(event, fn);
        },
        querySelector: node,
        querySelectorAll: () => [],
        append() {},
        after() {},
        focus() {},
        insertAdjacentHTML(_position, html) {
          this.innerHTML += html;
        },
        close() {
          this.open = false;
        },
        showModal() {
          this.open = true;
        },
      });
    return nodes.get(selector);
  };
  const context = createContext({
    catalog,
    Intl,
    Date,
    URL,
    URLSearchParams,
    location: {pathname: '/oauth/consent', search: '?request=001-original', hash: '', assign() {}},
    history: {replaceState() {}, pushState() {}},
    window: {addEventListener() {}, scrollTo() {}},
    document: {
      querySelector: node,
      getElementById: id => node('#' + id),
      querySelectorAll: () => [],
      createElement: () => node('section'),
      body: {classList: {toggle() {}}},
      addEventListener: (event, fn) => {
        const list = listeners.get(event) ?? [];
        list.push(fn);
        listeners.set(event, list);
      },
    },
    setTimeout: () => 1,
    clearTimeout() {},
    FormData: class {
      constructor(form) {
        return new Map(Object.entries(form.values));
      }
    },
    authBind() {},
    pretty: value => String(value).replaceAll('_', ' '),
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(readFileSync('web/routes.js', 'utf8'));
  const app = readFileSync('web/app.js', 'utf8'),
    start = app.indexOf('(async () => {'),
    end = app.indexOf('})();', start) + 5;
  run(app.slice(0, start) + app.slice(end));
  run(
    `uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});session={authenticated:true,administrator:true,workspaceRole:'owner',writesEnabled:true,ownerCredentials:true,origin:'https://amcp.invalid'};`,
  );
  context.refresh = async () => {};
  context.confirmAction = async () => true;
  context.toast = (message, kind) => toasts.push({message, kind});
  const click = async dataset => {
    const el = {dataset, isConnected: true, tagName: 'BUTTON', getAttribute: () => null};
    for (const fn of listeners.get('click') ?? []) await fn({target: {closest: () => el}, preventDefault() {}});
  };
  return {run, context, node, calls, toasts, click};
}

/** What the server's consent screen answers for an owner of the deployment whose client asked to read and change. */
const ownerInfo = {
  name: 'Synthetic client',
  role: 'operator',
  scope: 'mcp:read mcp:write',
  requestedScope: 'mcp:read mcp:write',
  redirectUri: 'https://client.example/callback',
  redirectHost: 'client.example',
  choices: ['mcp:read', 'mcp:read mcp:write', 'owner'],
  ownerAccess: true,
};
async function consent(locale, info) {
  const f = fixture(locale);
  f.context.api = async (url, args) => {
    if (args) {
      f.calls.push({url, body: JSON.parse(args.body)});
      return {url: 'https://client.example/done'};
    }
    return info;
  };
  await f.run('renderConsent()');
  return f;
}
const radios = html =>
  [...html.matchAll(/<input type="radio" name="consent-scope" value="([^"]*)"\s*(checked)?\s*>/g)].map(m => ({
    value: m[1],
    checked: m[2] === 'checked',
  }));

test('Owner access is offered last and is never preselected: the operator choice stays checked', async () => {
  for (const locale of ['en', 'ar']) {
    const f = await consent(locale, ownerInfo),
      shown = radios(f.node('#content').innerHTML);
    assert.deepEqual(
      shown,
      [
        {value: 'mcp:read mcp:write', checked: true},
        {value: 'mcp:read', checked: false},
        {value: 'owner', checked: false},
      ],
      locale,
    );
  }
});

test('a client that asked only to read, or a person who is not offered Owner, sees no Owner choice and no confirmation', async () => {
  for (const info of [
    {...ownerInfo, scope: 'mcp:read', requestedScope: 'mcp:read', choices: ['mcp:read'], ownerAccess: false},
    {...ownerInfo, choices: ['mcp:read', 'mcp:read mcp:write'], ownerAccess: false},
  ]) {
    const html = (await consent('en', info)).node('#content').innerHTML;
    assert.ok(!radios(html).some(r => r.value === 'owner'));
    assert.ok(!html.includes('owner-consent-confirm'));
    assert.equal(radios(html).filter(r => r.checked).length, 1, 'exactly one choice is preselected');
  }
});

test('the confirmation names the app and its return host, in English and in Arabic', async () => {
  const sentence = 'I confirm that {name}, returning to {host}, gets owner access to this workspace.';
  assert.ok(catalog[sentence], 'the sentence has its Arabic');
  assert.ok(catalog[sentence].includes('{name}') && catalog[sentence].includes('{host}'));
  for (const locale of ['en', 'ar']) {
    const f = await consent(locale, {...ownerInfo, name: 'Home <img>'}),
      html = f.node('#content').innerHTML,
      expected = (locale === 'ar' ? catalog[sentence] : sentence)
        .replace('{name}', 'Home &lt;img&gt;')
        .replace('{host}', 'client.example');
    assert.ok(html.includes('id="owner-consent-confirm"'), locale);
    assert.ok(html.includes(expected), locale + ': ' + expected);
  }
});

test('Authorize with Owner chosen sends nothing until the confirmation is ticked, and then carries it', async () => {
  const f = await consent('en', ownerInfo);
  f.node('input[name="consent-scope"]:checked').value = 'owner';
  await f.click({consent: 'approve'});
  assert.equal(f.calls.length, 0, 'nothing is sent without the confirmation');
  assert.deepEqual(f.toasts, [{message: 'Confirm owner access for this app before authorizing.', kind: 'error'}]);
  f.node('#owner-consent-confirm').checked = true;
  await f.click({consent: 'approve'});
  assert.deepEqual(f.calls, [
    {url: '/api/mcp/consent', body: {request: '001-original', approved: true, scope: 'owner', owner_confirmed: true}},
  ]);
});

test('operator and read-only approvals, and a refusal, carry no owner confirmation, ticked or not', async () => {
  for (const [scope, approve] of [
    ['mcp:read mcp:write', 'approve'],
    ['mcp:read', 'approve'],
    ['owner', 'deny'],
  ]) {
    const f = await consent('en', ownerInfo);
    f.node('input[name="consent-scope"]:checked').value = scope;
    f.node('#owner-consent-confirm').checked = true;
    await f.click({consent: approve});
    assert.equal(f.calls.length, 1, scope + ' ' + approve);
    assert.ok(!('owner_confirmed' in f.calls[0].body), scope + ' ' + approve);
    assert.equal(f.calls[0].body.scope === 'owner', false);
  }
});

test('the token form offers Owner without calling it the default, and creates it only with its checkbox', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.run("client='other'");
    f.context.api = async (url, args) => {
      if (args) f.calls.push({url, method: args.method, body: JSON.parse(args.body)});
      if (url === '/api/connector-tokens') return {tokens: [], token: 'synthetic-token-001'};
      if (url === '/api/mcp/authorizations') return {clients: []};
      return {};
    };
    await f.run('renderConnectors()');
    const html = f.node('#content').innerHTML;
    assert.ok(html.includes('data-create-owner-token="true"'), locale);
    assert.ok(!html.includes('Owner (default)') && !html.includes(catalog['Owner (default)'] ?? '\u0000'), locale);
    assert.ok(html.includes(locale === 'ar' ? catalog['Read + write (default)'] : 'Read + write (default)'), locale);
    await f.click({createOwnerToken: 'true'});
    assert.equal(f.calls.length, 0, 'no token without the checkbox');
    f.node('#owner-token-consent').checked = true;
    await f.click({createOwnerToken: 'true'});
    assert.deepEqual(
      f.calls.map(c => c.body),
      [{name: 'MCP client', role: 'owner', confirmed: true}],
    );
  }
});

test('a person who may not carry owner access is offered no owner token', async () => {
  const f = fixture('en');
  f.run('session.ownerCredentials=false;client="other"');
  f.context.api = async url => (url === '/api/connector-tokens' ? {tokens: []} : {clients: []});
  await f.run('renderConnectors()');
  assert.ok(!f.node('#content').innerHTML.includes('data-create-owner-token'));
});
