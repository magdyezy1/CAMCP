import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebsite} from '../dist/server/website.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {metaAssetUsageFixture} from './fixtures/meta-asset-usage-data.mjs';

async function website(t) {
  const f = metaAssetUsageFixture(t),
    origin = 'https://synthetic.amcp.invalid';
  const options = {
    origin,
    masterKey: Buffer.alloc(32, 131).toString('base64'),
    tenantId: f.actor.tenantId,
    authEnv: {},
    fetcher: async () => {
      throw Error('Unexpected website egress');
    },
  };
  const {web, accounts} = createWebsite(f.store, options, false, f.service);
  const user = accounts.newUser('Synthetic viewer', null, null, true);
  f.store.db
    .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,'viewer',?)")
    .run(f.actor.tenantId, user.id, Date.now());
  const session = accounts.session(user, f.actor.tenantId);
  assert.equal(session.actor.role, 'reader');
  const app = createHttpApp(f.service, f.store, {website: options});
  const listener = await listenForFetch(app);
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
    const body = await response.json();
    return {response, body};
  };
  return {...f, web, session, request};
}
test('authenticated website viewer reads native asset references without an upload write grant and retains CSRF protection', async t => {
  const f = await website(t),
    denied = await f.request('invalid');
  assert.equal(denied.response.status, 403);
  assert.equal(f.requests.length, 0);
  const out = await f.request();
  assert.equal(out.response.status, 200);
  assert.equal(out.response.headers.get('cache-control'), 'no-store');
  assert.equal(out.body.success, true, JSON.stringify(out.body));
  assert.deepEqual(
    out.body.data.rows.map(r => r.ad_id),
    ['501'],
  );
  assert.doesNotMatch(JSON.stringify(out.body), /PRIVATE-|access_token|source_url/);
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests.every(r => r.method === 'GET'));
});
test('website session revocation during native observation stops follow-up reads and withholds the result', async t => {
  const f = await website(t);
  f.setHook((body, _url, n) => {
    if (n === 2) f.web.signOut(f.session.id);
    return body;
  });
  const out = await f.request();
  assert.equal(out.response.status, 401);
  assert.equal(f.requests.length, 2);
  assert.doesNotMatch(JSON.stringify(out.body), /PRIVATE-|Native <ad>|rows|source_references/);
});
