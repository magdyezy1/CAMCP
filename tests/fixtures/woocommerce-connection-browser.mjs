import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** Owner setup and local removal against an owned fixture. Every native response and credential is synthetic. */
export async function exerciseWooConnection({page, site, workflow, locale, output, id, result, before}) {
  const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
    input = site.wooConnection.input,
    label = locale === 'ar' ? 'متجر <أصلي>' : 'Synthetic <store>',
    initial = site.evidenceCounts(),
    form = page.locator('#woo-connect'),
    feedback = page.locator('#woo-connect-workspace-feedback');
  assert.deepEqual(site.wooConnection.connectionCounts(), {connections: 0, proofs: 0});
  assert.equal(await form.locator('[name=consumer_key]').getAttribute('type'), 'password');
  assert.equal(await form.locator('[name=consumer_secret]').getAttribute('type'), 'password');
  assert.equal(await form.locator('[name=consumer_secret]').getAttribute('autocomplete'), 'off');
  const fill = async () => {
    for (const [name, value] of Object.entries({
      label,
      store_origin: input.store_origin,
      consumer_key: input.consumer_key,
      consumer_secret: input.consumer_secret,
    }))
      await form.locator('[name=' + name + ']').fill(value);
    await form.locator('[name=confirmed]').check();
  };
  const responseFor = () =>
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/commerce/stores' && r.request().method() === 'POST');
  await fill();
  if (workflow.endsWith('-error')) {
    site.wooConnection.setFault(true);
    const pending = responseFor();
    await form.locator('button[type=submit]').click();
    const response = await pending,
      body = await response.json();
    assert.equal(response.status(), 502);
    assert.equal(body.error.code, 'WOOCOMMERCE_CONNECTION_UNAVAILABLE');
    assert.ok(body.meta.requestId);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE-SETUP|setupSynthetic|consumer_secret|Authorization/);
    await feedback.waitFor({state: 'visible'});
    assert.equal(await feedback.getAttribute('role'), 'alert');
    const message = await feedback.innerText();
    assert.ok(message.includes(locale === 'ar' ? catalog[body.error.message] : body.error.message));
    assert.ok(message.includes(body.meta.requestId));
    assert.equal(await form.locator('[name=consumer_key]').inputValue(), '');
    assert.equal(await form.locator('[name=consumer_secret]').inputValue(), '');
    assert.deepEqual(site.wooConnection.connectionCounts(), {connections: 0, proofs: 0});
    assert.equal(site.counts().nativeReads - before.nativeReads, 1);
    await page.waitForTimeout(6600);
    assert.equal(await feedback.isVisible(), true);
    assert.equal(await feedback.innerText(), message);
    await feedback.screenshot({path: path.join(output, id + '-diagnostic.png')});
    assert.deepEqual(result.expected_refusals, [{path: '/api/commerce/stores', status: 502}]);
    result.woo_setup_failure = {
      safe_localized_diagnostic: true,
      reference_retained: true,
      credentials_cleared: true,
      saved_connections: 0,
      automatic_retries: 0,
    };
    site.wooConnection.setFault(false);
    await fill();
  }
  if (workflow.endsWith('-stale')) {
    let release, reached, rejectReady, timer;
    const tasks = [],
      routeErrors = [];
    const held = new Promise(r => {
        release = r;
      }),
      ready = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error('Setup response not ready')), 15000);
        reached = resolve;
        rejectReady = reject;
      }),
      pattern = site.origin + '/api/commerce/stores';
    // The assertion below observes ready. Attach a rejection handler now so early cleanup cannot leave an unhandled timeout.
    ready.catch(() => {});
    const handler = intercepted => {
      const task = (async () => {
        try {
          const response = await intercepted.fetch();
          reached(await response.json());
          await held;
          await intercepted.fulfill({response});
        } catch (error) {
          routeErrors.push(error.message);
          rejectReady(error);
        }
      })();
      tasks.push(task);
      return task;
    };
    await page.route(pattern, handler);
    try {
      await form.locator('button[type=submit]').click();
      const body = await ready;
      clearTimeout(timer);
      assert.equal(body.read_access_verified, true);
      assert.equal(await form.locator('[name=consumer_secret]').inputValue(), '');
      await page.evaluate(() => navigate('/dashboard'));
      release();
      await page.waitForTimeout(100);
      assert.equal(await page.locator('#woo-connect-heading').count(), 0);
      assert.equal(await page.locator('#toast').isVisible(), false);
      assert.equal(site.counts().nativeReads - before.nativeReads, 3);
      await page.evaluate(() => navigate('/commerce'));
      await page.locator('#woo-stores-refresh').click();
      await page.locator('#action-dialog[open]').waitFor();
      await page.locator('#action-confirm').click();
      await page.locator('#woo-remove').waitFor({state: 'attached'});
      result.woo_setup_stale = {
        original_local_connection_preserved: true,
        credentials_cleared: true,
        obsolete_result_silent: true,
        explicit_metadata_refresh: true,
        automatic_retries: 0,
      };
    } finally {
      clearTimeout(timer);
      release();
      await Promise.all(tasks);
      await page.unroute(pattern, handler);
      assert.equal(tasks.length, 1);
      assert.deepEqual(routeErrors, []);
    }
  } else {
    const pending = responseFor();
    await form.locator('button[type=submit]').click();
    const response = await pending,
      body = await response.json();
    assert.equal(response.status(), 201);
    assert.equal(body.read_access_verified, true);
    assert.equal(body.key_permission_evidence, 'operator_recorded');
    assert.equal(body.writes_enabled, false);
    assert.equal(body.full_inventory, false);
    assert.equal(body.network_requests, 3);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE-SETUP|setupSynthetic|consumer_secret|Authorization/);
    await page.locator('#woo-connect-heading').waitFor();
    const displayed = await page.locator('#woo-connect-result').innerText();
    assert.ok(displayed.includes(label));
    assert.ok(displayed.includes(input.store_origin));
    assert.ok(displayed.includes('SAR'));
    assert.equal(await form.locator('[name=consumer_key]').inputValue(), '');
    assert.equal(await form.locator('[name=consumer_secret]').inputValue(), '');
    assert.equal(await form.locator('button[type=submit]').isDisabled(), true);
    assert.equal(
      await page.locator('#woo-source select[name=target] option').count(),
      1,
      'Setup does not silently refresh or select a source',
    );
    await page.locator('#woo-connections').screenshot({path: path.join(output, id + '-setup.png')});
    await page.locator('#woo-connect-refresh').click();
    await page.locator('#action-dialog[open]').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'action-cancel');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#woo-connect-heading').count(), 1);
    await page.locator('#woo-connect-refresh').click();
    await page.locator('#action-dialog[open]').waitFor();
    await page.locator('#action-confirm').click();
    await page.locator('#woo-remove').waitFor({state: 'attached'});
    result.woo_setup = {
      owner_form: true,
      read_verification_requests: 3,
      key_permission_operator_recorded: true,
      credentials_cleared: true,
      source_only: true,
      explicit_metadata_refresh: true,
    };
  }
  assert.deepEqual(site.wooConnection.connectionCounts(), {connections: 1, proofs: 1});
  const storeReads = site.counts().nativeReads;
  assert.equal(await page.locator('#woo-source select[name=target]').inputValue(), '');
  assert.equal(await page.locator('#woo-inventory select[name=target]').inputValue(), '');
  assert.equal(await page.locator('#woo-source select[name=target] option').count(), 2);
  const removal = page.locator('#woo-remove');
  await removal.locator('xpath=..').locator('summary').click();
  await removal.locator('[name=target]').selectOption('0');
  await removal.locator('[name=confirmed]').check();
  await removal.locator('button[type=submit]').click();
  await page.locator('#action-dialog[open]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'action-cancel');
  await page.keyboard.press('Escape');
  assert.deepEqual(site.wooConnection.connectionCounts(), {connections: 1, proofs: 1});
  await removal.locator('button[type=submit]').click();
  await page.locator('#action-dialog[open]').waitFor();
  await page.locator('#action-confirm').click();
  await page.locator('#woo-remove-heading').waitFor();
  assert.deepEqual(site.wooConnection.connectionCounts(), {connections: 0, proofs: 0});
  assert.equal(site.counts().nativeReads, storeReads);
  await page.locator('#woo-connections').screenshot({path: path.join(output, id + '-removal.png')});
  await page.locator('#woo-remove-refresh').click();
  await page.locator('#action-dialog[open]').waitFor();
  await page.locator('#action-confirm').click();
  await page.waitForFunction(() => document.querySelector('#woo-source select[name=target]')?.options.length === 1);
  assert.equal(await page.locator('#woo-remove').count(), 0);
  assert.equal(site.counts().nativeReads, storeReads);
  assert.deepEqual(site.evidenceCounts(), initial);
  assert.equal(site.counts().writes, 0);
  assert.equal(site.counts().nativeReads - before.nativeReads, workflow.endsWith('-error') ? 4 : 3);
  result.woo_local_removal = {
    confirmation_and_cancel: true,
    encrypted_connection_and_proof_removed: true,
    native_requests: 0,
    provider_changes: 0,
    explicit_metadata_refresh: true,
  };
}
