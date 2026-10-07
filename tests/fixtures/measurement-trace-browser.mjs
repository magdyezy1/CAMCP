import assert from 'node:assert/strict';
import fs from 'node:fs';

export async function exerciseMeasurementTrace({page, site, locale, result, before, beforeEvidence, checks}) {
  const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
  const text = v => (locale === 'ar' ? catalog[v] : v);
  const form = page.locator('#measurement-trace'),
    region = page.locator('#measurement-trace-result');
  const requests = [];
  const onRequest = request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') && request.method() !== 'GET')
      requests.push({path: url.pathname, method: request.method()});
  };
  page.on('request', onRequest);
  try {
    await page.locator('#measurement-task-link-trace').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'measurement-section-trace');
    await form.locator('[name=target]').selectOption('0');
    await page.locator('#measurement-trace-example').click();
    const example = await form.locator('[name=trace]').inputValue();
    assert.equal(JSON.parse(example).scope.property_id, '123');
    await form.locator('button[type=submit]').click();
    await page.locator('#measurement-trace-heading').waitFor();
    assert.equal(await region.locator('tbody tr').count(), 4);
    assert.ok(
      (await region.innerText()).includes(
        text('No selected issue was observed in the supplied trace. Live acceptance remains unverified.'),
      ),
    );
    const row2 = await region.locator('tbody tr').nth(1).innerText();
    assert.ok(row2.includes(text('Denied')));
    const row4 = await region.locator('tbody tr').nth(3).innerText();
    assert.ok(row4.includes(text('Granted')));
    assert.ok(row4.includes(text('Denied')));
    const opposite = (await page.locator('html').getAttribute('data-theme')) === 'dark' ? 'light' : 'dark';
    await page.locator('[data-theme-select]:visible').first().selectOption(opposite);
    assert.equal(await form.locator('[name=trace]').inputValue(), example);
    assert.equal(await region.locator('tbody tr').count(), 4);
    await checks.tables(page, result);
    const long = {
      version: 1,
      scope: {property_id: '123', stream_id: '100', test_id: 'amcp-test-browser-example'},
      coverage: 'partial',
      steps: [
        {
          sequence: 1,
          at_ms: 0,
          kind: 'consent_default',
          consent: {
            analytics_storage: 'denied',
            ad_storage: 'denied',
            ad_user_data: 'denied',
            ad_personalization: 'denied',
          },
        },
        ...Array.from({length: 50}, (_, i) => ({
          sequence: i + 2,
          at_ms: i + 1,
          kind: 'event',
          event_name: i > 47 ? 'purchase' : 'page_view',
          test_id: 'amcp-test-browser-example',
          ...(i > 47 ? {transaction_key: 'opaque-' + 'b'.repeat(64)} : {}),
          analytics_storage_write: i === 0,
        })),
      ],
    };
    await form.locator('[name=trace]').fill(JSON.stringify(long));
    assert.equal(await region.locator('table').count(), 0);
    await form.locator('button[type=submit]').click();
    assert.equal(await region.locator('tbody tr').count(), 25);
    const observations = await region.innerText();
    assert.ok(observations.includes(text('Declared analytics storage write under denied analytics consent')));
    assert.ok(observations.includes(text('Repeated hashed purchase key')));
    assert.ok(!observations.includes('opaque-'));
    await page.locator('#measurement-trace-next').click();
    assert.equal((await region.locator('tbody th[scope=row]').first().innerText()).trim(), '26');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'measurement-trace-heading');
    await page.locator('#measurement-trace-next').click();
    assert.equal(await region.locator('tbody tr').count(), 1);
    assert.equal(await page.locator('#measurement-trace-next').isDisabled(), true);
    await checks.tables(page, result);
    const foreign = {...long, scope: {...long.scope, property_id: '999'}};
    await form.locator('[name=trace]').fill(JSON.stringify(foreign));
    await form.locator('button[type=submit]').click();
    const feedback = form.locator('.workspace-form-feedback');
    await feedback.waitFor({state: 'visible'});
    assert.equal(await region.locator('table').count(), 0);
    assert.ok(
      (await feedback.innerText()).includes(
        text(
          'Use trace version 1, the selected GA4 property, an exact stream, a synthetic test identifier and 1–1000 steps.',
        ),
      ),
    );
    await page.locator('#measurement-trace-clear').click();
    assert.equal(await form.locator('[name=trace]').inputValue(), '');
    assert.equal(await region.innerText(), '');
    // End with a populated, inspectable trace so the maintained semantic/WCAG/reflow checks cover its table.
    await page.locator('#measurement-trace-example').click();
    await form.locator('button[type=submit]').click();
    assert.equal(await region.locator('tbody tr').count(), 4);
    assert.deepEqual(site.counts(), before);
    assert.deepEqual(site.evidenceCounts(), beforeEvidence);
    assert.deepEqual(requests, []);
    result.measurement_trace = {
      steps: 51,
      table_page_size: 25,
      typed_refusals: true,
      scope_preserved: true,
      consent_state_preserved: true,
      purchase_collision_observed: true,
      native_deduplication: 'unverified',
      local_only: true,
      provider_mutations: 0,
      provider_requests: 0,
      submitted_http_requests: 0,
    };
  } finally {
    page.off('request', onRequest);
  }
}
