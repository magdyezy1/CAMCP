import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';
import {WebStore} from '../server/web-store.js';

const master = Buffer.alloc(32, 91).toString('base64');
const origin = 'https://amcp.shop';
const password = 'synthetic-owner-password-only';
const testPassword = 'synthetic-reviewer-password';
const blocked: typeof fetch = async () => {
  throw Error('Unexpected vendor egress');
};

async function site() {
  const store = new Store(':memory:', master),
    service = new MirrorService(new Registry(), store);
  const toolActors: {tool: string; role: string; testAccount: boolean}[] = [],
    invoke = service.call.bind(service);
  service.call = (...args) => {
    toolActors.push({tool: args[0], role: args[2].role, testAccount: args[2].testAccount === true});
    return invoke(...args);
  };
  const listener = await listenForFetch(
    createHttpApp(service, store, {
      website: {origin, masterKey: master, adminPassword: password, testPassword, fetcher: blocked},
    }),
  );

  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  const request = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {Origin: origin, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bytes = await response.arrayBuffer();
    return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
      status: response.status,
      headers: response.headers,
    });
  };
  const login = await request('/api/session/test', 'POST', {password: testPassword});
  assert.equal(login.status, 200, 'the reviewer door should accept the configured test password');
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!,
    csrf = (await login.json()).csrf;
  const headers = {Cookie: cookie, 'X-AMCP-CSRF': csrf};
  return {
    store,
    toolActors,
    request,
    headers,
    close: async () => {
      const closed = new Promise<void>(r => listener.close(() => r()));
      listener.closeAllConnections();
      await closed;
      store.close();
    },
  };
}

/**
 * Reviewers can manage connections in their own workspace. Other restricted areas and unknown
 * connection operations remain refused by default, even if navigation hides their entry points.
 */
const refused: [string, string][] = [
  ['POST', '/api/signin/google/start'],
  ['POST', '/api/account/password'],
  ['POST', '/api/owner/accounts/test-invite'],
  ['POST', '/api/access-sets'],
  ['DELETE', '/api/access-sets/test'],
  ['POST', '/api/workspaces/member'],
  ['POST', '/api/workspaces/security-policy'],
  ['POST', '/api/connections/synthetic/future-operation'],
  ['PATCH', '/api/connections/synthetic'],
];

test('a reviewer test account is refused every route outside its allow-list', async () => {
  const s = await site();
  try {
    for (const [method, url] of refused) {
      const response = await s.request(url, method, method === 'GET' ? undefined : {}, s.headers);
      assert.equal(response.status, 403, method + ' ' + url + ' should be refused');
      assert.equal((await response.json()).error?.code, 'TEST_ACCOUNT_SCOPE', method + ' ' + url);
    }
  } finally {
    await s.close();
  }
});

test('an unknown route added later is refused by default rather than reachable', async () => {
  const s = await site();
  try {
    // Stands in for any endpoint introduced after this gate was written. Under a deny-list this
    // passed; under the allow-list it must not, which is the property worth protecting.
    const response = await s.request('/api/some-future-endpoint', 'POST', {}, s.headers);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error?.code, 'TEST_ACCOUNT_SCOPE');
  } finally {
    await s.close();
  }
});

test('the reviewer areas an evaluator needs still work', async () => {
  const s = await site();
  try {
    for (const url of ['/api/session', '/api/platforms', '/api/activity']) {
      const response = await s.request(url, 'GET', undefined, s.headers);
      assert.notEqual(response.status, 403, url + ' is part of the reviewer scope');
    }
    // Client profiles and settings run through the allow-listed workspace tool.
    const profiles = await s.request('/api/workspace/workspace', 'POST', {action: 'profiles'}, s.headers);
    assert.notEqual(profiles.status, 403);
  } finally {
    await s.close();
  }
});

// WEB-06: Clients & templates is a test-account page, but it needed the campaign tool for its recipe list, which this
// gate refuses. The profiles response now carries the recipe fields; the campaign tool stays refused.
test('a reviewer opens Clients & templates and saves a playbook in its own workspace; campaign workflows are available', async () => {
  const s = await site();
  try {
    const profiles = await s.request('/api/workspace/workspace', 'POST', {action: 'profiles'}, s.headers);
    assert.equal(profiles.status, 200);
    const listed = (await profiles.json()).data;
    assert.deepEqual(listed.profiles, []);
    const clicks = listed.recipe_defaults.find((r: {id: string}) => r.id === 'google_search_clicks');
    assert.deepEqual(clicks.fields, [
      'daily_budget',
      'country_criterion_ids',
      'language_criterion_ids',
      'keywords',
      'headlines',
      'descriptions',
      'destination_url',
      'cpc_bid_ceiling',
    ]);
    assert.ok(
      listed.recipe_defaults.every((r: {fields: string[]}) =>
        r.fields.every(k => !['account_id', 'connection_id', 'currency', 'special_ad_categories'].includes(k)),
      ),
      'resource IDs, currency and declarations stay in each brief',
    );
    const saved = await s.request(
      '/api/workspace/workspace',
      'POST',
      {
        action: 'save_profile',
        confirmed: true,
        profile: {
          name: 'Reviewer client',
          naming: '{{campaign_name}}',
          defaults: {recipes: {google_search_clicks: {daily_budget: '25'}}},
        },
      },
      s.headers,
    );
    assert.equal(saved.status, 200);
    const record = (await saved.json()).data;
    assert.equal(record.name, 'Reviewer client');
    const again = (await (await s.request('/api/workspace/workspace', 'POST', {action: 'profiles'}, s.headers)).json())
      .data;
    assert.deepEqual(
      again.profiles.map((p: {id: string}) => p.id),
      [record.id],
    );
    // Saved client briefs are local workspace documents like playbooks (CMP-06): a reviewer may keep them, while using
    // one in a recipe needs the campaign tool, which stays refused below.
    const brief = await s.request(
      '/api/workspace/workspace',
      'POST',
      {
        action: 'save_brief',
        brief: {name: 'Reviewer brief', recipe: 'google_search_clicks', business: {daily_budget: '25'}},
      },
      s.headers,
    );
    assert.equal(brief.status, 200);
    const briefs = (await (await s.request('/api/workspace/workspace', 'POST', {action: 'briefs'}, s.headers)).json())
      .data;
    assert.deepEqual(
      briefs.briefs.map((b: {name: string}) => b.name),
      ['Reviewer brief'],
    );
    for (const action of ['recipes', 'list']) {
      const response = await s.request('/api/workspace/campaign', 'POST', {action}, s.headers);
      assert.equal(response.status, 200, action);
      assert.equal((await response.json()).success, true, action);
    }
    assert.ok(s.toolActors.some(actor => actor.tool === 'amcp_campaign'));
    assert.ok(s.toolActors.every(actor => actor.role === 'operator' && actor.testAccount));
    assert.equal((await s.request('/api/connector-tokens', 'GET', undefined, s.headers)).status, 200);
    const issued = await s.request('/api/connector-tokens', 'POST', {name: 'Reviewer LLM', role: 'reader'}, s.headers);
    assert.equal(issued.status, 200, await issued.clone().text());
    const token = await issued.json();
    const actor = s.store.authenticate(token.token);
    assert.equal(actor.role, 'reader');
    assert.equal(actor.testAccount, true);
    assert.equal(actor.ownerUserId, 'workspace-test');
    assert.equal(actor.tenantId, 'local-test');
    const escalated = await s.request('/api/connector-tokens', 'POST', {name: 'Invalid', role: 'admin'}, s.headers);
    assert.equal((await escalated.json()).error.code, 'INVALID_ROLE');
    assert.equal((await s.request('/api/connector-tokens/' + token.id, 'DELETE', undefined, s.headers)).status, 200);
    assert.throws(() => s.store.authenticate(token.token), {code: 'UNAUTHORIZED'});
    const second = await s.request('/api/connector-tokens', 'POST', {name: 'Next reviewer', role: 'reader'}, s.headers);
    const rotating = await second.json();
    assert.equal(s.store.authenticate(rotating.token).testAccount, true);
    new WebStore(s.store, {
      origin,
      masterKey: master,
      adminPassword: password,
      testPassword: testPassword + '-changed',
    });
    assert.throws(() => s.store.authenticate(rotating.token), {code: 'UNAUTHORIZED'});
    assert.equal((await s.request('/api/session', 'GET', undefined, s.headers)).status, 200);
    assert.equal((await s.request('/api/connector-tokens', 'GET', undefined, s.headers)).status, 401);
  } finally {
    await s.close();
  }
});

test('a reviewer test account cannot write owner policy through the workspace tool', async () => {
  const s = await site();
  try {
    const saved = await s.request(
      '/api/workspace/workspace',
      'POST',
      {
        action: 'save_spend_policy',
        gateway: 'meta_native_action',
        account_id: '123',
        confirmed: true,
        policy: {allow_activation: false},
      },
      s.headers,
    );
    assert.equal((await saved.json()).error?.code, 'OWNER_REQUIRED', 'the test actor must not pass the owner guard');
    const retention = await s.request(
      '/api/workspace/workspace',
      'POST',
      {action: 'save_retention', confirmed: true, days: 30},
      s.headers,
    );
    assert.equal((await retention.json()).error?.code, 'OWNER_REQUIRED');
  } finally {
    await s.close();
  }
});

/**
 * Express routes case-insensitively by default, so a case-sensitive prefix test in the gate let
 * `/API/...` skip it while still reaching the handler. The control and its first test shared the
 * same assumption about spelling, which is why the gap survived. Vary the spelling, not just the
 * route.
 */
test('the reviewer scope holds however the path is spelled', async () => {
  const s = await site();
  try {
    const spellings: [string, string][] = [
      ['POST', '/API/owner/accounts/access'],
      ['POST', '/Api/Owner/accounts/access'],
      ['POST', '/api/owner/ACCOUNTS/access'],
      ['POST', '/api/owner/accounts/%61ccess'],
      ['POST', '/api/owner/accounts/access/'],
      ['POST', '/api//owner/accounts/access'],
      ['POST', '/API/access-sets'],
      ['POST', '/api/ACCESS-SETS'],
    ];
    for (const [method, url] of spellings) {
      const response = await s.request(url, method, method === 'GET' ? undefined : {}, s.headers);
      assert.equal(response.status, 403, method + ' ' + url + ' must be refused, not routed');
      assert.equal((await response.json()).error?.code, 'TEST_ACCOUNT_SCOPE', method + ' ' + url);
    }
  } finally {
    await s.close();
  }
});
