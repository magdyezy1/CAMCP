import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebsite} from '../dist/server/website.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {snapchatAssetUsageFixture, snapUsageIds as ids} from './fixtures/snapchat-asset-usage-data.mjs';

async function website(t) {
  const f = snapchatAssetUsageFixture(t),
    origin = 'https://synthetic.amcp.invalid',
    options = {
      origin,
      masterKey: Buffer.alloc(32, 147).toString('base64'),
      tenantId: f.actor.tenantId,
      authEnv: {},
      fetcher: async () => {
        throw Error('Unexpected website egress');
      },
    },
    {web, accounts} = createWebsite(f.store, options, false, f.service),
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
      body: JSON.stringify({...f.input, reference_view: 'snapchat_top_snap'}),
    });
    return {response, body: await response.json()};
  };
  return {...f, web, session, request};
}
test('website viewer explicitly reads original Snapchat top-snap references with CSRF/no-store and exact receipt boundaries', async t => {
  const f = await website(t);
  assert.equal((await f.request('invalid')).response.status, 403);
  assert.equal(f.requests.length, 0);
  const r = await f.request();
  assert.equal(r.response.status, 200);
  assert.equal(r.response.headers.get('cache-control'), 'no-store');
  assert.equal(r.body.success, true, JSON.stringify(r.body));
  assert.equal(r.body.data.rows[0].creative_id, ids.creative);
  assert.equal(r.body.data.rows[0].media_id, ids.media);
  assert.equal(r.body.data.rows[0].ad_id, undefined);
  assert.equal(r.body.data.reference_view, 'snapchat_top_snap');
  assert.equal(f.requests.length, 6);
  assert.doesNotMatch(JSON.stringify(r.body), /PRIVATE-|source_url|access_token|download_link/);
});
test('website session withdrawal during a Snapchat reference response stops further reads and withholds evidence', async t => {
  const f = await website(t);
  f.setHook(({kind, body}) => {
    if (kind === 'creatives') f.web.signOut(f.session.id);
    return body;
  });
  const r = await f.request();
  assert.equal(r.response.status, 401);
  assert.equal(f.requests.length, 3);
  assert.doesNotMatch(JSON.stringify(r.body), /rows|source_references|Native <img/);
});
