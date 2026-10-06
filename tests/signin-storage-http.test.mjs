import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {websiteDiagnosticFixture} from './fixtures/website-diagnostics-data.mjs';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
const password = 'Local synthetic storage diagnosis password only!';
const reviewerPassword = 'Separate local synthetic reviewer password only!';
const message =
  'AMCP storage is full. The deployment administrator must restore capacity before sign-in or saving can continue.';
for (const kind of ['administrator', 'reviewer'])
  test(`real SQLite-full ${kind} sign-in fails closed with a reference and recovers only after capacity is restored`, async () => {
    const site = await websiteDiagnosticFixture({adminPassword: password, testPassword: reviewerPassword});
    try {
      const path = kind === 'administrator' ? '/api/session' : '/api/session/test';
      site.store.db.exec('CREATE TABLE synthetic_storage_pressure(value BLOB)');
      const before = site.evidenceCounts(),
        pages = site.store.db.prepare('PRAGMA page_count').get().page_count;
      site.store.db.exec('PRAGMA max_page_count=' + pages);
      site.store.db.exec(
        'CREATE TRIGGER synthetic_login_storage_pressure BEFORE INSERT ON amcp_login_limits BEGIN INSERT INTO synthetic_storage_pressure VALUES(zeroblob(1048576)); END',
      );
      const initial = await fetch(site.origin + '/api/session');
      assert.equal(initial.status, 200);
      assert.equal((await initial.json()).authenticated, false);
      const request = () =>
        fetch(site.origin + path, {
          method: 'POST',
          headers: {Origin: site.origin, 'Content-Type': 'application/json'},
          body: JSON.stringify({password: kind === 'administrator' ? password : reviewerPassword}),
        });
      const refused = await request(),
        body = await refused.json();
      assert.equal(refused.status, 503);
      assert.equal(refused.headers.get('set-cookie'), null);
      assert.deepEqual(body.error, {code: 'STORAGE_FULL', message});
      assert.match(body.meta.requestId, /^[0-9a-f-]{36}$/);
      assert.equal(site.store.db.prepare('SELECT count(*) AS n FROM amcp_login_limits').get().n, 0);
      assert.deepEqual(site.evidenceCounts(), before);
      assert.equal(site.logs.length, 1);
      assert.equal(site.logs[0].code, 'STORAGE_FULL');
      assert.equal(site.logs[0].requestId, body.meta.requestId);
      assert.deepEqual(site.logs[0].database, {result_code: 13, primary_code: 13, name: 'SQLITE_FULL'});
      const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
      for (const locale of ['en', 'ar']) {
        const ui = accountWorkflowFixture(locale);
        ui.context.response = body;
        const text = ui.run('errorMessage(requestError(response))');
        assert.ok(text.includes(locale === 'ar' ? catalog[message] : message));
        assert.ok(text.includes(body.meta.requestId));
      }
      assert.doesNotMatch(
        JSON.stringify({body, logs: site.logs}),
        /Local synthetic|zeroblob|password|sqlite.*path|stack|errstr/i,
      );
      site.store.db.exec('PRAGMA max_page_count=' + (pages + 512));
      const recovered = await request();
      assert.equal(recovered.status, 200);
      assert.equal((await recovered.json()).authenticated, true);
      assert.ok(recovered.headers.get('set-cookie'));
      assert.deepEqual(site.counts(), {nativeReads: 0, externalRequests: 0});
    } finally {
      await site.close();
    }
  });
