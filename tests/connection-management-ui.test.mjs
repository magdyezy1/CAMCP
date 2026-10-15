// CON-05, website side: the provider callback refusal page, write-grant confirmation on selection saves, login rename,
// the default-login prompt, Save and check access and the optional revocation at Google on disconnect. Runs web/app.js
// in a small fake DOM, in English and Arabic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
function fixture(locale, {authenticated = true} = {}) {
  const nodes = new Map(),
    listeners = new Map(),
    calls = [],
    workspaceCalls = [],
    confirmations = [];
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
        listeners: {},
        addEventListener(event, fn) {
          this.listeners[event] = fn;
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
    location: {pathname: '/connections', search: '', hash: '', assign() {}},
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
    authBind() {},
    pretty: value => String(value).replaceAll('_', ' '),
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  const app = readFileSync('web/app.js', 'utf8'),
    start = app.indexOf('(async () => {'),
    end = app.indexOf('})();', start) + 5;
  run(app.slice(0, start) + app.slice(end));
  run(
    `uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});session={authenticated:${authenticated},administrator:${authenticated},workspaceRole:'owner',writesEnabled:true,origin:'https://amcp.invalid'};`,
  );
  context.api = async (url, args) => {
    if (args) calls.push({url, method: args.method, body: args.body ? JSON.parse(args.body) : undefined});
    return {};
  };
  context.refresh = async () => {};
  context.confirmAction = async value => {
    confirmations.push(value);
    return context.confirmAnswer ?? true;
  };
  // workspace.js helpers the asset manager uses for Save and check access.
  context.workspaceCall = async (tool, args) => {
    workspaceCalls.push({tool, args});
    return {
      record_kind: 'readiness_batch',
      results: args.account_ids.map(id => ({
        account_id: id,
        ready: id !== '005678',
        checks: id === '005678' ? [{key: 'provider_read', status: 'blocked', message: 'Connection disabled.'}] : [],
      })),
    };
  };
  context.readinessBadge = r => (r.ready ? '[ready]' : '[blocked]');
  context.publicAssetUrl = path => path;
  const click = async dataset => {
    const el = {dataset, isConnected: true, tagName: 'BUTTON', getAttribute: () => null};
    for (const fn of listeners.get('click') ?? []) await fn({target: {closest: () => el}, preventDefault() {}});
  };
  return {run, context, node, calls, workspaceCalls, confirmations, click};
}
const platform = () => ({
  id: 'meta',
  name: 'Meta',
  kind: 'Advertising',
  configured: true,
  accountRead: true,
  selectionKind: 'ad_accounts',
  selectableKinds: ['ad_accounts'],
  assetKinds: ['ad_accounts'],
  gateway: 'meta_native_action',
  connections: [
    {
      id: 'login-001',
      name: 'Meta · Person',
      identity: {name: 'Person'},
      gateway: 'meta_native_action',
      enabled: true,
      isDefault: true,
      accounts: ['001234'],
      writeAccounts: ['001234'],
      defaultWriteAccess: true,
      selected: ['ad_accounts:001234'],
      groups: [
        {
          kind: 'ad_accounts',
          complete: true,
          assets: [
            {id: '001234', kind: 'ad_accounts', name: 'First client'},
            {id: '005678', kind: 'ad_accounts', name: 'Second client'},
          ],
        },
      ],
    },
  ],
});
const manage = (f, p = platform()) => {
  f.context.platform = p;
  f.run(
    "platforms=[platform];currentPlatform=platform.id;currentConnection='login-001';assetKind='ad_accounts';selected=new Set(platform.connections[0].selected);renderManage()",
  );
  return f.node('#manage-content').innerHTML;
};

test('a callback refusal renders a fixed localized message, links to Connections or sign-in and echoes nothing', async () => {
  const messages = {
    SIGN_IN_REQUIRED: [/Your AMCP session ended before the provider returned/, /انتهت جلستك في AMCP/],
    FORBIDDEN: [/Only a workspace administrator can complete/, /لا يمكن إكمال اتصال المنصة إلا لمسؤول/],
    OAUTH_STATE_INVALID: [/This authorization expired or was already used/, /انتهت صلاحية هذا التفويض/],
    OAUTH_CALLBACK_INVALID: [/The provider returned an unexpected response/, /أعادت المنصة استجابة غير متوقعة/],
    '<script>PRIVATE</script>': [/The provider returned an unexpected response/, /أعادت المنصة استجابة غير متوقعة/],
  };
  for (const [locale, index] of [
    ['en', 0],
    ['ar', 1],
  ])
    for (const [code, expected] of Object.entries(messages))
      for (const authenticated of [true, false]) {
        const f = fixture(locale, {authenticated});
        f.context.platform = platform();
        f.context.location.pathname = '/oauth/result';
        f.context.location.search = '?' + new URLSearchParams({error: code, platform: 'meta', state: 'PRIVATE-STATE'});
        await f.run('platforms=[platform];renderCallback()');
        const html = f.node('#content').innerHTML;
        assert.match(html, expected[index], code);
        assert.match(html, locale === 'ar' ? /لم يتم ربط Meta/ : /Meta was not connected/);
        assert.doesNotMatch(html, /PRIVATE|<script>/);
        assert.match(html, authenticated ? /href="\/connections"/ : /href="\/login"/);
        assert.doesNotMatch(html, /href="\/"/, 'never the public landing page');
      }
  // An unknown platform ID is not shown.
  const f = fixture('en');
  f.context.location.pathname = '/oauth/result';
  f.context.location.search = '?error=OAUTH_STATE_INVALID&platform=PRIVATE-PLATFORM';
  await f.run('platforms=[];renderCallback()');
  assert.match(f.node('#content').innerHTML, /The platform was not connected/);
  assert.doesNotMatch(f.node('#content').innerHTML, /PRIVATE/);
});

test('a selection that adds write access names the resources and sends confirmed only after consent', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    manage(f);
    f.run("selected=new Set(['ad_accounts:001234','ad_accounts:005678'])");
    f.node('#selection-write-access').checked = true;
    f.context.confirmAnswer = false;
    await f.click({saveAssets: 'true'});
    assert.equal(f.calls.length, 0, 'declining the confirmation saves nothing');
    assert.deepEqual([...f.confirmations[0].items], ['Second client · 005678']);
    assert.match(f.confirmations[0].title, locale === 'ar' ? /صلاحية التعديل/ : /Enable write access/);
    f.context.confirmAnswer = true;
    await f.click({saveAssets: 'true'});
    assert.deepEqual(f.calls, [
      {
        url: '/api/connections/login-001/assets',
        method: 'PATCH',
        body: {selected: ['ad_accounts:001234', 'ad_accounts:005678'], confirmed: true},
      },
    ]);
  }
  // A read-only save and one that adds no account need no confirmation.
  const f = fixture('en');
  manage(f);
  f.run("selected=new Set(['ad_accounts:001234','ad_accounts:005678'])");
  f.node('#selection-write-access').checked = false;
  await f.click({saveAssets: 'true'});
  f.run("selected=new Set(['ad_accounts:001234'])");
  f.node('#selection-write-access').checked = true;
  await f.click({saveAssets: 'true'});
  assert.equal(f.confirmations.length, 0);
  assert.deepEqual(
    f.calls.map(c => c.body),
    [{selected: ['ad_accounts:001234', 'ad_accounts:005678'], write_access: false}, {selected: ['ad_accounts:001234']}],
  );
});

test('an administrator renames a login from the asset manager; names outside 1 to 80 characters are not sent', async () => {
  const f = fixture('ar'),
    html = manage(f);
  assert.match(html, /اسم اتصال الدخول/);
  assert.match(html, /الهوية لدى المنصة: Person/);
  f.node('#login-label').value = 'x'.repeat(81);
  await f.click({renameLogin: 'login-001'});
  f.node('#login-label').value = '  ';
  await f.click({renameLogin: 'login-001'});
  assert.equal(f.calls.length, 0);
  f.node('#login-label').value = ' Client A ';
  await f.click({renameLogin: 'login-001'});
  assert.deepEqual(f.calls, [{url: '/api/connections/login-001/label', method: 'PATCH', body: {label: 'Client A'}}]);
});

test('Connections asks for a default when several logins are enabled without one; a disabled login cannot be made default', () => {
  const p = platform(),
    second = {...structuredClone(p.connections[0]), id: 'login-002', name: 'Meta · Other', isDefault: false};
  p.connections[0].isDefault = false;
  p.connections.push(second, {...structuredClone(second), id: 'login-003', enabled: false, duplicateOf: 'login-002'});
  for (const locale of ['en', 'ar']) {
    const html = manage(fixture(locale), structuredClone(p));
    assert.match(html, locale === 'ar' ? /اختر اتصال الدخول الافتراضي/ : /Choose a default login/);
    assert.match(html, /data-default="login-001"/);
    assert.match(html, /data-default="login-002"/);
    assert.doesNotMatch(html, /data-default="login-003"/);
    assert.match(html, locale === 'ar' ? /الهوية نفسها لاتصال دخول آخر/ : /Same identity as another login/);
  }
  p.connections[1].isDefault = true;
  assert.doesNotMatch(manage(fixture('en'), p), /Choose a default login/);
});

test('Save and check access saves, then checks only the newly selected accounts and shows each result inline', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale),
      html = manage(f);
    assert.match(html, /data-save-assets="check"/);
    f.run("selected=new Set(['ad_accounts:001234','ad_accounts:005678'])");
    f.node('#selection-write-access').checked = false;
    f.node('#manage-dialog').open = true;
    f.context.refresh = async () => f.run("platforms[0].connections[0].accounts=['001234','005678']");
    await f.click({saveAssets: 'check'});
    assert.equal(f.calls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.workspaceCalls)), [
      {
        tool: 'workspace',
        args: {action: 'check', connection_id: 'login-001', account_ids: ['005678'], live: true},
      },
    ]);
    const shown = f.node('#manage-content').innerHTML;
    assert.match(shown, /Second client/);
    assert.match(shown, /\[blocked\]/);
    assert.match(shown, locale === 'ar' ? /فحص الوصول/ : /Access check/);
  }
  // Without an exact account read contract the button is not offered.
  const p = platform();
  p.accountRead = false;
  assert.doesNotMatch(manage(fixture('en'), p), /data-save-assets="check"/);
});

// CON-05 sub-item 10 (owner decision D19 (4)): revocation at Google is a separate choice in the disconnect dialog,
// offered only where the deployment owner turned it on, never pre-checked, and sent only when checked.
test('the disconnect dialog offers revocation at Google only where it is on, unchecked, and sends it only when checked', async () => {
  const google = available => ({
    ...platform(),
    id: 'google',
    name: 'Google Ads',
    gateway: 'google_ads_native_action',
    provider_revocation: {
      available,
      reason: available ? null : 'deployment_off',
      provider: 'google',
      shared_client: true,
    },
    connections: [{...platform().connections[0], id: 'login-g1', name: 'Google Ads · Person'}],
  });
  const meta = {...platform(), provider_revocation: {available: false, reason: 'provider_not_supported'}};
  // The shipped dialog: the choice is hidden until offered, never checked, and its warning is read with it.
  const shipped = readFileSync('web/index.html', 'utf8').match(/<div id="confirm-revoke" hidden>.*?<\/div>/)?.[0] ?? '';
  assert.match(
    shipped,
    /<input type="checkbox" id="confirm-revoke-provider" aria-describedby="confirm-revoke-warning">/,
  );
  assert.doesNotMatch(shipped, /checked/);
  assert.match(shipped, /id="confirm-revoke-warning" class="notice warning"/);
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale),
      text = message => (locale === 'ar' ? catalog[message] : message),
      form = f.node('#confirm-form'),
      submit = () => form.listeners.submit({preventDefault() {}, currentTarget: form});
    let answer = {success: true};
    f.context.api = async (url, args) => {
      f.calls.push({url, method: args.method, body: args.body ? JSON.parse(args.body) : undefined});
      if (answer instanceof Error) throw answer;
      return answer;
    };
    f.context.list = [google(true), meta];
    f.run('platforms=list');
    // Offered and unchecked, even after an earlier opening left it checked: a plain disconnect stays local.
    f.node('#confirm-revoke-provider').checked = true;
    await f.click({disconnect: 'login-g1'});
    assert.equal(f.node('#confirm-dialog').open, true);
    assert.equal(f.node('#confirm-revoke').hidden, false);
    assert.equal(f.node('#confirm-revoke-provider').checked, false);
    await submit();
    assert.deepEqual(f.calls.at(-1), {url: '/api/connections/login-g1', method: 'DELETE', body: undefined});
    assert.equal(f.node('#toast').textContent, text('Login disconnected from AMCP.'));
    // Checked: the request asks for it, and the message says what Google answered.
    for (const [outcome, message] of [
      ['revoked', 'Login disconnected from AMCP and its access revoked at Google.'],
      [
        'token_already_invalid',
        'Login disconnected. Google reported that its token no longer worked, so AMCP’s access through it had already ended.',
      ],
    ]) {
      answer = {success: true, provider_revocation: {provider: 'google', outcome}};
      await f.click({disconnect: 'login-g1'});
      f.node('#confirm-revoke-provider').checked = true;
      await submit();
      assert.deepEqual(f.calls.at(-1), {
        url: '/api/connections/login-g1',
        method: 'DELETE',
        body: {revoke_at_provider: true},
      });
      assert.equal(f.node('#toast').textContent, text(message));
      assert.equal(f.node('#confirm-dialog').open, false);
    }
    // A refusal keeps the dialog open with the reason inside it (a toast would sit behind the modal dialog, outside
    // what assistive technology reads), so the administrator can retry or disconnect locally.
    const refusal =
      'The provider did not confirm the revocation, so AMCP kept this login. Try again, or disconnect it without provider revocation and remove AMCP in the provider’s own settings.';
    answer = Object.assign(Error(refusal), {code: 'PROVIDER_REVOCATION_FAILED', requestId: 'synthetic-reference'});
    f.node('#toast').textContent = '';
    await f.click({disconnect: 'login-g1'});
    f.node('#confirm-revoke-provider').checked = true;
    await submit();
    assert.equal(f.node('#confirm-dialog').open, true);
    assert.equal(
      f.node('#confirm-error').textContent,
      text(refusal) +
        ' ' +
        (locale === 'ar' ? catalog['Reference: {id}'] : 'Reference: {id}').replace('{id}', 'synthetic-reference'),
    );
    assert.equal(f.node('#toast').textContent, '', 'not behind the dialog');
    assert.equal(f.node('#confirm-submit').disabled, false, 'the administrator can retry');
    // Opening the dialog again starts without the earlier reason.
    await f.click({disconnect: 'login-g1'});
    assert.equal(f.node('#confirm-error').textContent, '');
    // One request at a time: a second Disconnect while Google answers sends nothing more.
    let settle;
    answer = new Promise(resolve => (settle = resolve));
    f.node('#confirm-revoke-provider').checked = true;
    const sent = f.calls.length,
      first = submit();
    assert.equal(f.node('#confirm-submit').disabled, true);
    await submit();
    assert.equal(f.calls.length, sent + 1);
    settle({success: true, provider_revocation: {provider: 'google', outcome: 'revoked'}});
    await first;
    assert.equal(f.node('#confirm-submit').disabled, false);
    assert.equal(f.node('#confirm-dialog').open, false);
    assert.equal(f.node('#toast').textContent, text('Login disconnected from AMCP and its access revoked at Google.'));
    // Not offered where the owner left it off, or for a provider without a documented endpoint; nothing is sent.
    answer = {success: true};
    for (const [platforms, id] of [
      [[google(false)], 'login-g1'],
      [[meta], 'login-001'],
    ]) {
      f.context.list = platforms;
      f.run('platforms=list');
      await f.click({disconnect: id});
      assert.equal(f.node('#confirm-revoke').hidden, true, id);
      f.node('#confirm-revoke-provider').checked = true;
      await submit();
      assert.deepEqual(f.calls.at(-1), {url: '/api/connections/' + id, method: 'DELETE', body: undefined});
    }
  }
});
