import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {operationsWorkerHealth} from '../../dist/src/operations-worker-health.js';

export function workerHealthBrowserFixture(store, tenant) {
  const setScenario = scenario => {
    assert.ok(['active', 'stale', 'uncertain', 'unavailable', 'not_observed'].includes(scenario));
    const now = Date.now();
    store.transaction(() => {
      store.db.prepare("DELETE FROM documents WHERE tenant_id='__service_limits__' AND kind='worker_heartbeat'").run();
      if (scenario === 'active') {
        for (let n = 0; n < 1000; n++)
          store.putDocument('__service_limits__', 'worker_heartbeat', 'PRIVATE-SYNTHETIC-PROCESS-' + n, {
            at: now - n,
            state: n % 2 ? 'working' : 'idle',
            private: 'UNUSED-PRIVATE-HEARTBEAT',
          });
      }
      if (['stale', 'uncertain'].includes(scenario))
        store.putDocument('__service_limits__', 'worker_heartbeat', 'PRIVATE-SYNTHETIC-OLD', {
          at: now - 120000,
          state: 'working',
        });
      if (['active', 'uncertain', 'unavailable'].includes(scenario))
        store.putDocument('__service_limits__', 'worker_heartbeat', 'PRIVATE-SYNTHETIC-FUTURE', {
          at: now + 86400000,
          state: 'working',
        });
    });
  };
  setScenario('active');
  return {
    setScenario,
    observation: () => operationsWorkerHealth(store),
    settingsCounts: () =>
      Object.fromEntries(
        ['spend_policy', 'write_pause', 'retention_policy', 'campaign_plan', 'write_review'].map(kind => [
          kind,
          store.documents(tenant, kind).length,
        ]),
      ),
  };
}

export async function exerciseWorkerHealth({page, site, locale, output, id, result, before, checks}) {
  const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
    translated = text => (locale === 'ar' ? catalog[text] : text),
    labels = {
      active: 'Background processes recently observed',
      stale: 'Only older process observations',
      uncertain: 'Process observations uncertain',
      unavailable: 'Process observations unavailable',
      not_observed: 'No process heartbeat has been observed',
    },
    panel = page.locator('#owner-worker-health'),
    settings = site.workerHealth.settingsCounts(),
    observations = [];
  await panel.waitFor();
  assert.equal((await panel.locator('strong').innerText()).trim(), translated(labels.active));
  // WEB-08: a verdict leads (the newest report's age and the threshold); the raw observations start collapsed.
  assert.match(
    await panel.locator('.worker-health-verdict').innerText(),
    locale === 'ar' ? /أحدث تقرير قبل/ : /Newest report .+ ago; reports older than 90 seconds are not recent\./,
  );
  assert.equal(await panel.locator('details.worker-health-details').evaluate(node => node.open), false);
  assert.equal(await panel.locator('tbody tr').count(), 100);
  assert.equal(await panel.locator('input,button,select').count(), 0);
  assert.match(await panel.innerText(), locale === 'ar' ? /لا تؤكد/ : /do not confirm workspace jobs/);
  assert.doesNotMatch(await page.locator('body').innerText(), /PRIVATE-SYNTHETIC|UNUSED-PRIVATE-HEARTBEAT/);
  for (const scenario of ['stale', 'uncertain', 'unavailable', 'not_observed', 'active']) {
    site.workerHealth.setScenario(scenario);
    const awaited = page.waitForResponse(
      response =>
        response.url() === site.origin + '/api/workspace/workspace' &&
        response.request().postDataJSON()?.action === 'health',
    );
    await page.locator('#owner-refresh').click();
    const response = await awaited,
      body = await response.json();
    assert.equal(response.status(), 200);
    assert.equal(response.headers()['cache-control'], 'no-store');
    assert.equal(body.success, true);
    assert.equal(body.data.operations.worker.status, scenario);
    assert.doesNotMatch(
      JSON.stringify(body.data.operations.worker),
      /PRIVATE-SYNTHETIC|UNUSED-PRIVATE-HEARTBEAT|access_token/,
    );
    await page.waitForFunction(
      expected => document.querySelector('#owner-worker-health strong')?.textContent.trim() === expected,
      translated(labels[scenario]),
    );
    const observed = body.data.operations.worker;
    assert.equal(
      observed.observations.length,
      scenario === 'active' ? 100 : ['stale', 'uncertain'].includes(scenario) ? 1 : 0,
    );
    assert.equal(await panel.locator('tbody tr').count(), observed.observations.length);
    assert.deepEqual(site.workerHealth.settingsCounts(), settings);
    assert.deepEqual(site.counts(), before);
    observations.push({
      status: scenario,
      total: observed.total_heartbeat_records,
      valid: observed.observed_records,
      active: observed.active_records,
      unavailable: observed.unavailable_records,
      shown: observed.observations.length,
      has_more: observed.has_more,
    });
  }
  // Opening the collapsed observations shows the same keyboard-scrollable table.
  await panel.locator('details.worker-health-details > summary').click();
  await checks.tables(page, result);
  const region = panel.locator('.data-scroll');
  await region.focus();
  assert.equal(await region.evaluate(node => document.activeElement === node), true);
  assert.ok(
    await region.evaluate(node => node.scrollHeight > node.clientHeight),
    'The bounded observations stay in a keyboard-scrollable table',
  );
  if (output && id) await panel.screenshot({path: path.join(output, id + '-worker-health-panel.png')});
  result.worker_health = {
    qualified_states: observations,
    explicit_health_refreshes: observations.length,
    provider_reads: 0,
    provider_mutations: 0,
    owner_setting_changes: 0,
    shared_process_scope_explained: true,
    observations_bounded: true,
    heartbeat_payloads_withheld: true,
    original_settings_preserved: true,
  };
}
