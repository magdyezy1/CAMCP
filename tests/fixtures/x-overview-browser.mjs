import assert from 'node:assert/strict';
import fs from 'node:fs';

/** Real editor, authenticated local HTTP and worker; all X responses and OAuth credentials are synthetic. */
export async function exerciseXOverview({page, site, locale, result}) {
  const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
    text = key => (locale === 'ar' ? (catalog[key] ?? key) : key);
  await page.goto(site.origin + '/reporting-overview');
  const form = page.locator('#overview-config'),
    platform = page.locator('.report-platform').filter({has: page.locator('[data-report-level=x]')}),
    settings = platform.locator('[data-report-source]');
  await form.waitFor();
  if (!(await platform.evaluate(element => element.open))) await platform.locator(':scope > summary').click();
  await platform.locator('[data-report-account=x]').check();
  const select = settings.locator('[data-report-level=x]');
  assert.deepEqual(
    await select.locator('option').allTextContents(),
    ['Campaign', 'Line item', 'Promoted tweet'].map(text),
  );
  await select.selectOption(['adset', 'ad']);
  await settings.locator('[data-report-complete-window=x]').check();
  const filters = settings.locator('details.native-settings').first();
  if (!(await filters.evaluate(element => element.open))) await filters.locator(':scope > summary').click();
  await settings.locator('[data-report-scope=ad_ids]').fill('p1');
  await form.locator('[name=name]').fill('X selected native promotion');
  await form.locator('[name=rangeMode]').selectOption('custom');
  await form.locator('[name=since]').fill('2026-09-01');
  await form.locator('[name=until]').fill('2026-09-02');
  const response = page.waitForResponse(
    response =>
      response.url().endsWith('/api/workspace/overview') && response.request().postDataJSON()?.action === 'run',
  );
  await form.locator('button[type=submit]').click();
  const acknowledged = await response,
    envelope = await acknowledged.json();
  assert.equal(envelope.success, true, JSON.stringify(envelope));
  const sent = acknowledged.request().postDataJSON();
  assert.deepEqual(sent.config.sources[0].levels, ['adset', 'ad']);
  assert.deepEqual(sent.config.sources[0].ad_ids, ['p1']);
  await site.granular.workOnce();
  await page.waitForFunction(
    id =>
      document.querySelector('#overview-results a[download="AMCP-report.csv"]')?.getAttribute('href') ===
      '/api/reporting-overview/' + encodeURIComponent(id) + '.csv',
    envelope.data.id,
  );
  const snapshot = site.granular.store.document(site.granular.tenant, 'overview_report', envelope.data.id),
    promotion = snapshot.rows.find(row => row.entity_level === 'ad'),
    line = snapshot.rows.find(row => row.entity_level === 'adset');
  assert.equal(snapshot.state, 'complete', JSON.stringify(snapshot.sources));
  assert.equal(promotion.entity_id, 'p1');
  assert.equal(promotion.parent_ids.campaign_id, 'c1');
  assert.equal(promotion.parent_ids.adset_id, 'l1');
  assert.equal(promotion.metrics.spend, '48');
  assert.equal(promotion.result.value, '48');
  assert.equal(line.metrics.spend, '48');
  assert.equal(line.aggregation.kind, 'rolled_up');
  assert((await page.locator('#overview-results').innerText()).includes(text('Rolled up from selected ads')));
  assert.equal(site.counts().writes, 0);
  result.x_native_detail = {
    native_labels: true,
    exact_scope: true,
    promotion_id: promotion.entity_id,
    parent_campaign: promotion.parent_ids.campaign_id,
    parent_line: promotion.parent_ids.adset_id,
    spend: promotion.metrics.spend,
    rolled_up_selected_ad_spend: line.metrics.spend,
    provider_writes: 0,
  };
  await page.goto(site.origin + '/reporting-overview');
  await form.waitFor();
}
