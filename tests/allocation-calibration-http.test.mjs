import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebsite} from '../dist/server/website.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {allocationCalibrationFixture, calibrationNow} from './fixtures/allocation-calibration-data.mjs';

test('authenticated website viewer diagnoses historical allocation under CSRF and current session without native reads or writes', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const f = allocationCalibrationFixture(t),
    origin = 'https://synthetic.amcp.invalid',
    options = {
      origin,
      masterKey: Buffer.alloc(32, 132).toString('base64'),
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
  const listener = await listenForFetch(createHttpApp(f.service, f.store, {website: options}));
  t.after(() => new Promise((resolve, reject) => listener.close(error => (error ? reject(error) : resolve()))));
  const request = async (csrf = session.csrf) => {
    const response = await fetch('http://127.0.0.1:' + listener.address().port + '/api/workspace/reporting', {
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
  assert.equal((await request('invalid')).response.status, 403);
  const observed = await request();
  assert.equal(observed.response.status, 200);
  assert.equal(observed.body.success, true, JSON.stringify(observed.body));
  assert.equal(observed.response.headers.get('cache-control'), 'no-store');
  assert.equal(observed.body.data.record_kind, 'allocation_calibration');
  assert.equal(observed.body.data.factor_envelope.efficiency_low, '1');
  assert.doesNotMatch(JSON.stringify(observed.body), /PRIVATE-CALIBRATION|"source_request"|accessToken/);
  web.signOut(session.id);
  const revoked = await request();
  assert.equal(revoked.response.status, 401);
  assert.doesNotMatch(JSON.stringify(revoked.body), /allocation_calibration|expected_conversions/);
  assert.equal(f.nativeCalls(), 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_plan').length, 0);
});
