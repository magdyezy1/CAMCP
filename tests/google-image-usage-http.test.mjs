import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebsite} from '../dist/server/website.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {googleImageUsageFixture} from './fixtures/google-image-usage-data.mjs';

async function website(t) {
  const f = googleImageUsageFixture(t),
    origin = 'https://synthetic.amcp.invalid',
    options = {
      origin,
      masterKey: Buffer.alloc(32, 143).toString('base64'),
      tenantId: f.actor.tenantId,
      authEnv: {},
      fetcher: async () => {
        throw Error('Unexpected website egress');
      },
    };
  const {web, accounts} = createWebsite(f.store, options, false, f.service),
    user = accounts.newUser('Synthetic viewer', null, null, true);
  f.store.db
    .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,'viewer',?)")
    .run(f.actor.tenantId, user.id, Date.now());
  const session = accounts.session(user, f.actor.tenantId);
  assert.equal(session.actor.role, 'reader');
  const app = createHttpApp(f.service, f.store, {website: options}),
    listener = await listenForFetch(app);
  t.after(() => new Promise((resolve, reject) => listener.close(e => (e ? reject(e) : resolve()))));
  const request = async (csrf = session.csrf) => {
    const response = await fetch('http://127.0.0.1:' + listener.address().port + '/api/workspace/media', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: web.cookieName + '=' + session.id,
        'X-AMCP-CSRF': csrf,
      },
      body: JSON.stringify(f.input),
    });
    return {response, body: await response.json()};
  };
  return {...f, web, session, request};
}
test('website viewers read bounded Google image references without write grants and retain CSRF/no-store boundaries', async t => {
  const f = await website(t);
  assert.equal((await f.request('invalid')).response.status, 403);
  assert.equal(f.requests.length, 0);
  const out = await f.request();
  assert.equal(out.response.status, 200);
  assert.equal(out.response.headers.get('cache-control'), 'no-store');
  assert.equal(out.body.success, true, JSON.stringify(out.body));
  assert.equal(out.body.data.rows[0].ad_id, '9007199254740993');
  assert.doesNotMatch(JSON.stringify(out.body), /PRIVATE-|access_token|source_url/);
  assert.equal(f.requests.length, 6);
});
test('website session withdrawal around a Google image read stops further requests and withholds native evidence', async t => {
  const f = await website(t);
  f.setHook(({resource, body}) => {
    if (resource === 'ad_group_ad_asset_view') f.web.signOut(f.session.id);
    return body;
  });
  const out = await f.request();
  assert.equal(out.response.status, 401);
  assert.equal(f.requests.length, 3);
  assert.doesNotMatch(JSON.stringify(out.body), /rows|source_references|Native <img/);
});
