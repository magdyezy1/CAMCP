import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function exercisePortfolioComparison({page, site, workflow, locale, output, id, result, before, checks}) {
  const artifacts = site.evidenceCounts();
  site.portfolioComparison.reset();
  const form = page.locator('#portfolio-account'),
    selector = form.locator('[name=target]');
  await selector.selectOption('0');
  await form.locator('button[type=submit]').click();
  await page.locator('#portfolio-heading').waitFor();
  assert.equal(site.counts().nativeReads - before.nativeReads, 1);
  const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
    reason = 'Google returned inconsistent account metadata or an unordered inventory continuation.';
  const responseFor = () =>
    page.waitForResponse(
      r =>
        new URL(r.url()).pathname === '/api/workspace/workspace' &&
        r.request().postDataJSON()?.action === 'portfolio_reconcile',
    );
  const stale = workflow.endsWith('-stale'),
    fault = workflow !== 'portfolio-comparison';
  if (stale) {
    let release, signal, finish, routeError;
    const held = new Promise(resolve => {
        release = resolve;
      }),
      ready = new Promise(resolve => {
        signal = resolve;
      }),
      completed = new Promise(resolve => {
        finish = resolve;
      }),
      pattern = site.origin + '/api/workspace/workspace';
    await page.route(pattern, async intercepted => {
      if (intercepted.request().postDataJSON()?.action !== 'portfolio_reconcile') return intercepted.continue();
      try {
        const response = await intercepted.fetch();
        signal(await response.json());
        await held;
        await intercepted.fulfill({response});
      } catch (error) {
        routeError = error;
        signal({success: false, error: {code: 'BROWSER_ROUTE_FAILED', message: error.message}});
      } finally {
        finish();
      }
    });
    try {
      await page.locator('#portfolio-compare').click();
      const failed = await ready;
      assert.equal(failed.error.code, 'PORTFOLIO_INVALID_RESPONSE');
      assert.equal(failed.error.message, reason);
      await selector.selectOption('');
      release();
      await page.waitForFunction(() => !document.querySelector('#portfolio-compare'));
      assert.equal(await page.locator('#portfolio-comparison').count(), 0);
      assert.equal(await page.locator('#toast').isVisible(), false);
      assert.equal(site.counts().nativeReads - before.nativeReads, 2);
      result.inventory_comparison_stale = {
        obsolete_response_silent: true,
        changed_account_preserved: true,
        automatic_retries: 0,
        provider_mutations: 0,
      };
    } finally {
      release();
      await completed;
      await page.unroute(pattern);
      if (routeError) throw routeError;
    }
    await selector.selectOption('0');
    await form.locator('button[type=submit]').click();
    await page.locator('#portfolio-heading').waitFor();
    site.portfolioComparison.recover();
  } else if (fault) {
    const pending = responseFor();
    await page.locator('#portfolio-compare').click();
    const response = await pending,
      body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'PORTFOLIO_INVALID_RESPONSE');
    assert.equal(body.error.message, reason);
    const alert = page.locator('#portfolio-comparison [role=alert]');
    await alert.waitFor();
    const shown = await alert.innerText();
    assert.ok(shown.includes(locale === 'ar' ? catalog[reason] : reason));
    assert.ok(shown.includes(body.meta.requestId));
    assert.equal(site.counts().nativeReads - before.nativeReads, 2);
    await page.waitForTimeout(6600);
    assert.equal(await alert.innerText(), shown);
    assert.equal(site.counts().nativeReads - before.nativeReads, 2);
    assert.equal(await page.locator('#toast').isVisible(), false);
    await alert.screenshot({path: path.join(output, id + '-diagnostic.png')});
    assert.equal(await page.locator('#portfolio-view table').count(), 1);
    result.inventory_comparison_failure = {
      original_reference_preserved: true,
      original_inventory_preserved: true,
      persistent_after_ms: 6600,
      automatic_retries: 0,
      provider_mutations: 0,
    };
    site.portfolioComparison.recover();
  }
  const pending = responseFor();
  await page.locator('#portfolio-compare').click();
  const response = await pending,
    body = await response.json();
  assert.equal(body.success, true, JSON.stringify(body));
  const input = response.request().postDataJSON(),
    out = body.data;
  assert.equal(input.gateway, 'google_ads_native_action');
  assert.equal(input.account_id, '123');
  assert.equal(input.connection_id, 'synthetic-reconciliation-login');
  assert.deepEqual(input.requirements, {entity: 'campaign'});
  assert.equal(out.status, 'changes_observed');
  assert.equal(out.coverage.atomic_snapshot, false);
  assert.equal(out.coverage.absence_authorizes_delete, false);
  assert.equal(out.collection_usage.requests, 2);
  assert.equal(out.changes.unchanged_count, 1);
  await page.locator('#portfolio-comparison-heading').waitFor();
  await page.waitForFunction(() => document.activeElement.id === 'portfolio-comparison-heading');
  const rows = page.locator('#portfolio-comparison tbody tr');
  assert.equal(await rows.count(), 3);
  for (const [index, value] of ['9007199254740999', '9007199254740995', '9007199254740993'].entries()) {
    assert.equal((await rows.nth(index).locator('th[scope=row]').innerText()).trim(), value);
    assert.equal(await rows.nth(index).locator('th[scope=row]').getAttribute('dir'), 'ltr');
  }
  assert.equal(await page.locator('#portfolio-comparison img').count(), 0);
  await checks.tables(page, result);
  await checks.productLabels(page, '#portfolio-comparison', result);
  await page.locator('#portfolio-comparison').screenshot({path: path.join(output, id + '-comparison.png')});
  await rows.nth(2).locator('td').nth(1).locator('summary').click();
  await rows.nth(2).locator('td').nth(2).locator('summary').click();
  assert.ok((await rows.nth(2).innerText()).includes('9007199254740993'));
  assert.ok((await rows.nth(2).innerText()).includes('9007199254740995'));
  const reads = stale ? 5 : fault ? 4 : 3;
  assert.equal(site.counts().nativeReads - before.nativeReads, reads);
  assert.deepEqual(site.evidenceCounts(), artifacts);
  result.inventory_comparison = {
    complete_observations: 2,
    observed_added: 1,
    not_observed_again: 1,
    supported_fields_changed: 1,
    unchanged: 1,
    exact_ids_and_micros_preserved: true,
    native_reads: reads,
    atomic_snapshot: false,
    absence_authorizes_delete: false,
    provider_mutations: 0,
    saved_artifacts: 0,
  };
}
