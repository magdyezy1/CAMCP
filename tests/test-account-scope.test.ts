import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';

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
  ['POST', '/api/mcp/consent'],
  ['POST', '/api/connections/synthetic/future-operation'],
  ['PATCH', '/api/connections/synthetic'],
  ['GET', '/api/connector-tokens'],
  ['POST', '/api/connector-tokens'],
  ['GET', '/api/mcp/authorizations'],
  ['GET', '/api/media/variants/abc/preview'],
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
test('a reviewer opens Clients & templates and saves a playbook in its own workspace; campaigns stay refused', async () => {
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
    for (const args of [{action: 'recipes'}, {action: 'list'}, {action: 'create', name: 'x', brief: 'x', steps: []}]) {
      const refused = await s.request('/api/workspace/campaign', 'POST', args, s.headers);
      assert.equal(refused.status, 403, args.action);
      assert.equal((await refused.json()).error?.code, 'TEST_ACCOUNT_SCOPE', args.action);
    }
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
      ['POST', '/API/workspace/write'],
      ['POST', '/Api/Workspace/write'],
      ['POST', '/api/workspace/WRITE'],
      ['POST', '/api/workspace/%77rite'],
      ['POST', '/api/workspace/write/'],
      ['POST', '/api//workspace/write'],
      ['GET', '/API/connector-tokens'],
      ['GET', '/api/CONNECTOR-TOKENS'],
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
