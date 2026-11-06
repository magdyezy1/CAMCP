import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {granularConfig, granularSource} from './overview-granularity-data.mjs';

/** Actual editor → HTTP → worker checks; the site's providers and Sheets tab are synthetic. */
export async function exerciseOverviewV4({page, site, locale, result}) {
  const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
    text = key => (locale === 'ar' ? (catalog[key] ?? key) : key),
    form = page.locator('#overview-config'),
    meta = page.locator('.report-platform').filter({has: page.locator('[data-report-level=meta]')});
  const waitSnapshot = id =>
    page.waitForFunction(
      id =>
        document.querySelector('#overview-results a[download="AMCP-report.csv"]')?.getAttribute('href') ===
        '/api/reporting-overview/' + encodeURIComponent(id) + '.csv',
      id,
    );
  const next = action =>
    page.waitForResponse(
      response =>
        response.url().endsWith('/api/workspace/overview') && response.request().postDataJSON()?.action === action,
    );
  await form.locator('[name=name]').fill('Selected ad totals');
  await meta.locator('[data-report-level=meta]').selectOption(['campaign', 'ad']);
  const source = meta.locator('[data-report-source]'),
    filters = source.locator('details.native-settings');
  if (!(await filters.evaluate(element => element.open))) await filters.locator(':scope > summary').click();
  await source.locator('[data-report-scope=ad_ids]').fill('9007199254740993');
  await source.locator('[data-report-delivered=meta]').uncheck();
  await source.locator('[data-report-statuses=meta]').selectOption('all');
  let response = next('run');
  await form.locator('button[type=submit]').click();
  let acknowledged = await response,
    envelope = await acknowledged.json();
  assert.equal(envelope.success, true, JSON.stringify(envelope));
  const sent = acknowledged.request().postDataJSON();
  assert.equal(sent.config.contract_version, 'overview-config-v4');
  assert.deepEqual(sent.config.sources[0].levels, ['campaign', 'ad']);
  assert.deepEqual(sent.config.sources[0].ad_ids, ['9007199254740993']);
  assert.equal(sent.config.sources[0].delivered_only, false);
  await site.granular.workOnce();
  await waitSnapshot(envelope.data.id);
  const snapshot = site.granular.store.document(site.granular.tenant, 'overview_report', envelope.data.id),
    parent = snapshot.rows.find(row => row.entity_level === 'campaign'),
    ad = snapshot.rows.find(row => row.entity_level === 'ad');
  assert.equal(snapshot.state, 'complete', JSON.stringify(snapshot.sources));
  assert.equal(parent.aggregation.kind, 'rolled_up');
  assert.equal(parent.aggregation.scope_field, 'ad_ids');
  assert.equal(parent.metrics.spend, ad.metrics.spend);
  assert.ok((await page.locator('#overview-results').innerText()).includes(text('Rolled up from selected ads')));
  response = next('save_template');
  await page.locator('#overview-template').click();
  envelope = await (await response).json();
  assert.equal(envelope.success, true, JSON.stringify(envelope));
  assert.deepEqual(envelope.data.config.sources, []);
  assert.deepEqual(envelope.data.config.source_defaults.meta.levels, ['campaign', 'ad']);
  for (const key of ['account_id', 'connection_id', 'campaign_ids', 'adset_ids', 'ad_ids'])
    assert.equal(envelope.data.config.source_defaults.meta[key], undefined);
  await page.locator('#overview-use-template').waitFor();
  await page.locator('#overview-use-template').click();
  await meta.locator('[data-report-account=meta]').check();
  assert.deepEqual(
    await meta
      .locator('[data-report-level=meta]')
      .evaluate(select => [...select.selectedOptions].map(option => option.value)),
    ['campaign', 'ad'],
  );
  assert.equal(await meta.locator('[data-report-scope=ad_ids]').inputValue(), '');
  assert.equal(await meta.locator('[data-report-delivered=meta]').isChecked(), false);
  result.v4_selected_rollup = {
    exact_id: ad.entity_id,
    selected_spend: ad.metrics.spend,
    ancestor_spend: parent.metrics.spend,
    labelled: true,
    account_free_template: true,
  };

  const legacyId = 'legacy-browser-' + randomUUID(),
    config = {
      ...granularConfig({...granularSource('meta', 'campaign'), objective: 'leads', report_options: undefined}),
      name: 'Legacy browser report',
      grain: 'daily',
      date_range: {since: '2026-09-01', until: '2026-09-02'},
      version: 3,
    },
    original = JSON.stringify(config);
  site.granular.store.putDocument(site.granular.tenant, 'overview_view', legacyId, {config, created_at: 1});
  await page.goto(site.origin + '/reporting-overview?view_id=' + legacyId);
  await page.locator('#overview-config').waitFor();
  const legacySource = page.locator('[data-report-source]').filter({has: page.locator('[data-report-level=meta]')});
  assert.equal(await legacySource.locator('[data-report-delivered=meta]').isChecked(), false);
  assert.equal(await legacySource.locator('[data-report-campaign-profile=meta]').isChecked(), false);
  response = next('run');
  await form.locator('button[type=submit]').click();
  acknowledged = await response;
  const input = acknowledged.request().postDataJSON();
  assert.equal(input.id, legacyId);
  assert.equal(input.config, undefined);
  envelope = await acknowledged.json();
  assert.equal(envelope.success, true, JSON.stringify(envelope));
  // Upgrading the stored definition for a run is not an edit (F-L6-09): its revision stays where the editor read it.
  assert.equal(envelope.data.view_revision, 1);
  await site.granular.workOnce();
  const first = site.granular.store.document(site.granular.tenant, 'overview_report', envelope.data.id),
    definition = site.granular.store.document(site.granular.tenant, 'overview_view', legacyId),
    notice = "Saved report objectives now fill gaps in the platform's objective. Numbers may change.";
  assert.equal(first.state, 'complete', JSON.stringify(first.sources));
  await waitSnapshot(envelope.data.id);
  assert.equal(JSON.stringify(definition.config), original);
  assert.equal(first.notices.filter(item => item.id === 'objective-fallback-v4').length, 1);
  assert.ok((await page.locator('#overview-results').innerText()).includes(text(notice)));
  await form.locator('[name=name]').fill('Edited after capture');
  response = next('save');
  await page.locator('#overview-save').click();
  acknowledged = await response;
  assert.equal(acknowledged.request().postDataJSON().expected_revision, 1);
  envelope = await acknowledged.json();
  assert.equal(envelope.success, true, JSON.stringify(envelope));
  await page.waitForFunction(() => !document.getElementById('overview-save')?.disabled);
  response = next('run');
  await form.locator('button[type=submit]').click();
  envelope = await (await response).json();
  assert.equal(envelope.success, true, JSON.stringify(envelope));
  await site.granular.workOnce();
  await waitSnapshot(envelope.data.id);
  const second = site.granular.store.document(site.granular.tenant, 'overview_report', envelope.data.id);
  assert.equal((second.notices ?? []).filter(item => item.id === 'objective-fallback-v4').length, 0);
  assert.ok(!(await page.locator('#overview-results').innerText()).includes(text(notice)));
  result.v4_saved_migration = {
    original_config_preserved: true,
    notice_once: true,
    own_revision_edit: true,
    configured_profile_preserved: true,
  };
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert(overflow <= 1, 'Source controls must fit the viewport: ' + overflow);
}
