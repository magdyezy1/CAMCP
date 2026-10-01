import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
function fixture(locale) {
  const nodes = new Map(),
    listeners = new Map(),
    calls = [],
    bindings = new Map(),
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
    FormData: class {
      constructor(form) {
        return new Map(Object.entries(form.values));
      }
    },
    authBind: (selector, fn) => bindings.set(selector, fn),
    pretty: value => String(value).replaceAll('_', ' '),
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  const app = readFileSync('web/app.js', 'utf8'),
    start = app.indexOf('(async () => {'),
    end = app.indexOf('})();', start) + 5;
  run(app.slice(0, start) + app.slice(end));
  run(
    `uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});session={authenticated:true,administrator:true,workspaceRole:'owner',writesEnabled:true,origin:'https://amcp.invalid'};`,
  );
  context.api = async (url, args) => {
    if (args) calls.push({url, method: args.method, body: args.body ? JSON.parse(args.body) : undefined});
    if (url === '/api/connector-tokens') return {tokens: [], token: 'synthetic-token-001'};
    if (url === '/api/mcp/authorizations') return {clients: []};
    return {};
  };
  context.refresh = async () => {};
  context.confirmAction = async value => {
    confirmations.push(value);
    return true;
  };
  const click = async dataset => {
    const el = {dataset, isConnected: true, tagName: 'BUTTON', getAttribute: () => null};
    for (const fn of listeners.get('click') ?? []) await fn({target: {closest: () => el}, preventDefault() {}});
  };
  return {run, context, node, calls, bindings, confirmations, click};
}
const platform = {
  id: 'google',
  name: 'Google',
  kind: 'Advertising',
  description: 'Provider description',
  configured: true,
  selectionKind: 'ad_accounts',
  selectableKinds: ['ad_accounts'],
  assetKinds: ['ad_accounts'],
  gateway: 'google_ads_native_action',
  callback: 'https://amcp.invalid/oauth/google/callback',
  scopes: ['https://www.googleapis.com/auth/adwords'],
  env: 'GOOGLE',
  connections: [
    {
      id: 'login-001',
      name: 'Home',
      gateway: 'google_ads_native_action',
      enabled: true,
      isDefault: true,
      accounts: ['001234'],
      writeAccounts: [],
      defaultWriteAccess: false,
      selected: ['ad_accounts:001234'],
      groups: [
        {
          kind: 'ad_accounts',
          complete: true,
          assets: [{id: '001234', kind: 'ad_accounts', name: '<img onerror=bad> Home', currency: 'SAR'}],
        },
      ],
    },
  ],
};

test('DV360 advertiser selection and unknown inventory labels render without losing exact asset kinds', () => {
  for (const locale of ['en', 'ar'])
    for (const kind of ['advertisers', 'unknown_fixture_kind']) {
      const f = fixture(locale),
        p = structuredClone(platform);
      Object.assign(p, {id: 'dv360', selectionKind: kind, selectableKinds: [kind], assetKinds: [kind]});
      p.connections[0].groups[0].kind = kind;
      p.connections[0].groups[0].assets[0].kind = kind;
      f.context.platform = p;
      f.run(
        "platforms=[platform];currentPlatform='dv360';currentConnection='login-001';assetKind=platform.selectionKind;renderManage()",
      );
      assert.match(f.node('#manage-content').innerHTML, new RegExp('data-asset-key="' + kind + ':001234"'));
      if (locale === 'ar' && kind === 'advertisers') assert.match(f.node('#manage-content').innerHTML, /المعلنون/);
    }
});

test('Arabic connection selection and write grants retain exact scopes and explicit acknowledgement', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.platform = structuredClone(platform);
    f.run(
      "platforms=[platform];currentPlatform='google';currentConnection='login-001';selected=new Set(['ad_accounts:001234']);writeSelected=new Set(['001234']);renderConnections();renderManage();",
    );
    assert.match(f.node('#manage-content').innerHTML, /data-asset-key="ad_accounts:001234"/);
    assert.match(f.node('#manage-content').innerHTML, /&lt;img onerror=bad&gt; Home/);
    if (locale === 'ar') {
      assert.match(f.node('#content').innerHTML, /المنصات المتصلة/);
      assert.match(f.node('#manage-content').innerHTML, /حفظ التحديد/);
    }
    await f.click({saveAssets: 'true'});
    await f.click({saveWriteAccess: 'true'});
    assert.equal(f.calls.length, 1, 'unchecked acknowledgement cannot grant writes');
    f.node('#confirm-write-access').checked = true;
    await f.click({saveWriteAccess: 'true'});
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
  assert.deepEqual(transcripts[0], [
    {url: '/api/connections/login-001/assets', method: 'PATCH', body: {selected: ['ad_accounts:001234']}},
    {url: '/api/connections/login-001/write-access', method: 'PATCH', body: {accounts: ['001234'], confirmed: true}},
  ]);
});

test('Arabic consent retains client identity, redirect URI, permission scopes and original approval request', async () => {
  const requests = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.location.pathname = '/oauth/consent';
    f.context.location.search = '?request=001-original';
    f.context.api = async (url, args) => {
      if (args) {
        requests.push({url, body: JSON.parse(args.body)});
        return {url: 'https://amcp.invalid/done'};
      }
      return {
        name: 'Home <img>',
        role: 'operator',
        scope: 'mcp:read mcp:write',
        redirectUri: 'https://client.invalid/callback?code=001',
      };
    };
    await f.run('renderConsent()');
    const html = f.node('#content').innerHTML;
    assert.match(html, /Home &lt;img&gt;/);
    assert.match(html, /mcp:read mcp:write/);
    assert.match(html, /https:\/\/client.invalid\/callback\?code=001/);
    if (locale === 'ar') assert.match(html, /تفويض Home/);
    await f.click({consent: 'approve'});
  }
  assert.deepEqual(requests, [
    {url: '/api/mcp/consent', body: {request: '001-original', approved: true}},
    {url: '/api/mcp/consent', body: {request: '001-original', approved: true}},
  ]);
});

test('Arabic setup keeps provider variables, callback URLs, sample config and English legal wording intact', () => {
  const legal = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.platform = structuredClone(platform);
    f.run('platforms=[platform];renderSettings()');
    const html = f.node('#content').innerHTML;
    assert.match(html, /AMCP_GOOGLE_CLIENT_ID<br>AMCP_GOOGLE_CLIENT_SECRET/);
    assert.match(html, /https:\/\/amcp.invalid\/oauth\/google\/callback/);
    assert.match(html, /https:\/\/www.googleapis.com\/auth\/adwords/);
    if (locale === 'ar') assert.match(html, /متغيرات الخادم/);
    f.context.location.pathname = '/terms';
    f.run('renderLegal()');
    legal.push(f.node('#content').innerHTML);
    assert.match(legal.at(-1), /lang="en" dir="ltr"/);
    assert.match(legal.at(-1), /Use AMCP only with accounts and data you are authorized to access/);
  }
  assert.equal(legal[1], legal[0]);
});

test('Arabic owner access review retains original user, test flag and explicit revocation confirmation', async () => {
  const output = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.location.pathname = '/settings';
    f.run('renderSettings=async()=>{}');
    f.context.api = async (url, args) => {
      if (args) {
        f.calls.push({url, body: JSON.parse(args.body)});
        return {};
      }
      return {
        pending: 0,
        accounts: [
          {
            id: 'user-001',
            name: 'Home <img>',
            email: 'native+001@example.test',
            state: 'approved',
            created_at: 0,
            methods: ['google'],
            test: true,
          },
        ],
        setup: {},
        providers: [],
      };
    };
    f.run(readFileSync('web/account-approvals.js', 'utf8'));
    await f.run('renderSettings()');
    const area = f.node('section');
    assert.match(area.innerHTML, /Home &lt;img&gt;/);
    assert.match(area.innerHTML, /data-user="user-001"/);
    if (locale === 'ar') assert.match(area.innerHTML, /لديه صلاحية الدخول/);
    const click = dataset => area.events.get('click')({target: {closest: () => ({dataset})}});
    await click({user: 'user-001', grant: 'true', test: 'false'});
    await click({user: 'user-001', grant: 'false'});
    assert.equal(f.confirmations.length, 1);
    if (locale === 'ar') assert.match(f.confirmations[0].consequence, /فورًا/);
    output.push(f.calls);
  }
  assert.deepEqual(output[1], output[0]);
  assert.deepEqual(output[0], [
    {url: '/api/owner/accounts/access', body: {user_id: 'user-001', grant: true, test: false}},
    {url: '/api/owner/accounts/access', body: {user_id: 'user-001', grant: false}},
  ]);
});

test('Arabic MCP setup preserves copied configuration and native token role/default name', async () => {
  const output = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.run("client='other'");
    const config = f.run('connectorCode()');
    await f.run('renderConnectors()');
    if (locale === 'ar') assert.match(f.node('#content').innerHTML, /إنشاء رمز اتصال/);
    await f.click({createOperatorToken: 'true'});
    assert.equal(f.calls.length, 0);
    f.node('#operator-token-consent').checked = true;
    await f.click({createOperatorToken: 'true'});
    assert.equal(f.node('#token-value').textContent, 'synthetic-token-001');
    output.push({config, calls: f.calls});
  }
  assert.deepEqual(output[1], output[0]);
  assert.deepEqual(output[0].calls, [
    {url: '/api/connector-tokens', method: 'POST', body: {name: 'MCP client', role: 'operator', confirmed: true}},
  ]);
});

test('Arabic owner controls preserve spending units, exact account binding and confirmed retention', async () => {
  const output = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.location.pathname = '/settings';
    f.context.platform = structuredClone(platform);
    f.run('platforms=[platform];renderSettings=()=>{}');
    f.context.api = async (url, args) => {
      if (url === '/api/account/options') return {emailEnabled: true, providers: []};
      const body = JSON.parse(args.body);
      if (body.action === 'health')
        return {
          success: true,
          data: {
            backup: {status: 'verified'},
            connections: [],
            jobs: [],
            email: [],
            storage: {database_bytes: 0, report_rows: 0},
            policies: [],
            budget_units: {google_ads_native_action: {unit: 'micros', evidence: 'native-unit-evidence'}},
          },
        };
      f.calls.push(body);
      return {success: true, data: {}};
    };
    f.run(readFileSync('web/owner-operations.js', 'utf8'));
    await f.run('renderSettings()');
    if (locale === 'ar') assert.match(f.node('section').innerHTML, /سياسة إنفاق الحساب/);
    await f.bindings.get('#owner-spend-policy')({
      values: {
        binding: '["google_ads_native_action","login-001","001234"]',
        unit: 'currency',
        enforcement: 'block',
        max_budget: '12.34',
        max_budget_increase_percent: '20',
        max_daily_increase: '',
        max_bid: '',
      },
    });
    await f.bindings.get('#owner-retention')({values: {days: '30'}});
    if (locale === 'ar') assert.match(f.confirmations[0].consequence, /30/);
    output.push(f.calls);
  }
  assert.deepEqual(output[1], output[0]);
  assert.deepEqual(output[0], [
    {
      action: 'save_spend_policy',
      gateway: 'google_ads_native_action',
      connection_id: 'login-001',
      account_id: '001234',
      policy: {
        allow_activation: false,
        allow_deletion: false,
        enforcement: 'block',
        max_budget_increase_percent: 20,
        max_budget_currency: 12.34,
      },
      confirmed: true,
    },
    {action: 'save_retention', days: 30, confirmed: true},
  ]);
});
