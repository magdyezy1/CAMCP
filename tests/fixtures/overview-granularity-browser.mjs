import assert from 'node:assert/strict';
import fs from 'node:fs';

/** Real browser → authenticated HTTP → worker → synthetic native reports → owned synthetic Sheets tab. */
export async function exerciseGranularOverview({page, site, locale, result, checks}) {
  const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
    text = key => (locale === 'ar' ? (catalog[key] ?? key) : key),
    form = page.locator('#overview-config'),
    meta = page.locator('.report-platform').filter({has: page.locator('[data-report-level=meta]')});
  await form.locator('[name=name]').fill('Original snapshot name');
  await form.locator('[name=rangeMode]').selectOption('custom');
  await form.locator('[name=since]').fill('2026-09-01');
  await form.locator('[name=until]').fill('2026-09-02');
  await meta.locator(':scope > summary').click();
  await meta.locator('[data-report-account=meta]').check();
  await meta.locator('[data-report-level=meta]').selectOption('ad');
  await meta.locator('[data-report-result=meta]').fill('purchase');
  await meta.locator('[data-report-complete-window=meta]').check();
  await meta.locator('[data-objective-for=meta]').selectOption('sales');
  const initialTheme = await page.locator('html').getAttribute('data-theme');
  const beforeTheme = site.counts();
  await page
    .locator('[data-theme-select]:visible')
    .first()
    .selectOption(initialTheme === 'dark' ? 'light' : 'dark');
  assert.equal(await form.locator('[name=name]').inputValue(), 'Original snapshot name');
  assert.equal(await meta.locator('[data-report-level=meta]').inputValue(), 'ad');
  assert.equal(await meta.locator('[data-report-account=meta]').isChecked(), true);
  await page.locator('[data-theme-select]:visible').first().selectOption('system');
  assert.equal(await page.locator('html').getAttribute('data-theme'), initialTheme);
  assert.deepEqual(site.counts(), beforeTheme, 'Changing appearance cannot fetch provider data or reset report inputs');
  const requested = page.waitForResponse(
    r => r.url().endsWith('/api/workspace/overview') && r.request().postDataJSON()?.action === 'run',
  );
  await form.locator('button[type=submit]').click();
  const envelope = await (await requested).json();
  assert.equal(envelope.success, true, JSON.stringify(envelope));
  assert.equal(await site.granular.workOnce(), true);
  await page.locator('#report-export').waitFor();
  const table = page.locator('.report-table-wrap .report-table').last();
  await table.locator('tbody tr').waitFor();
  assert.match(await table.innerText(), /9007199254740993/);
  assert.match(await table.innerText(), /201/);
  assert.match(await table.innerText(), /=UNTRUSTED AD\(\)/);
  await page.locator('.metric-sources > summary').click();
  const mapping = page.locator('.metric-sources .report-table');
  assert.match(await mapping.innerText(), /\/actions\[action_type=purchase\]/);
  assert.doesNotMatch(await mapping.innerText(), /leads, installs or purchases/);
  await checks.tables(page, result);
  // Editing the setup after collection must not change the snapshot selected for immediate export.
  await form.locator('[name=name]').fill('Edited setup not exported');
  await page.locator('#report-export').click();
  const dialog = page.locator('#report-delivery-dialog');
  await dialog.locator('#report-export-now').waitFor();
  assert.equal(await dialog.locator('#report-schedule').count(), 0);
  assert.equal(await dialog.locator('#report-bind-files').count(), 0);
  assert.match(await dialog.innerText(), /Original snapshot name/);
  assert.doesNotMatch(await dialog.innerText(), /Edited setup not exported/);
  const bind = dialog.locator('#report-bind-url');
  await bind
    .locator('[name=spreadsheet_url]')
    .fill('https://docs.google.com/spreadsheets/d/syntheticGranularSheet/edit');
  const bound = page.waitForResponse(
    r => r.url().endsWith('/api/workspace/overview') && r.request().postDataJSON()?.action === 'bind_destination',
  );
  await bind.locator('button').click();
  assert.equal((await (await bound).json()).success, true);
  await dialog.locator('#report-export-now').waitFor();
  const beforeConfirmation = site.counts();
  await dialog.locator('#report-export-now').click();
  await page.waitForFunction(
    expected => document.getElementById('delivery-status').textContent === expected,
    text('Confirm exporting this snapshot to Google Sheets first.'),
  );
  assert.deepEqual(site.counts(), beforeConfirmation, 'Unchecked export consent issues no Sheets requests');
  await dialog.locator('#report-export-confirm').check();
  const exported = page.waitForResponse(
    r => r.url().endsWith('/api/workspace/overview') && r.request().postDataJSON()?.action === 'export',
  );
  await dialog.locator('#report-export-now').click();
  assert.equal((await (await exported).json()).success, true);
  assert.equal(await site.granular.workOnce(), true);
  await dialog.locator('#delivery-status a').waitFor();
  assert.match(
    await dialog.locator('#delivery-status').innerText(),
    new RegExp(text('Export complete.').replace('.', '\\.')),
  );
  const tab = [...site.granular.tabs.values()].find(tab => tab.properties.sheetId !== 7),
    headers = tab.values[0].map(cell => cell.stringValue);
  assert.deepEqual(tab.values[1][headers.indexOf('Entity ID')], {stringValue: '9007199254740993'});
  assert.deepEqual(site.granular.tabs.get(7).values, [['KEEP THIS ORIGINAL']]);
  assert.equal(site.granular.store.documents(site.granular.tenant, 'overview_schedule').length, 0);
  result.granular_export = {
    snapshot: 'Original snapshot name',
    native_entity_id: '9007199254740993',
    native_parent_adset_id: '201',
    synthetic_sheets_batches: site.granular.requests.filter(
      request => request.url.hostname === 'sheets.googleapis.com' && request.method === 'POST',
    ).length,
    original_tab_preserved: true,
    no_schedule: true,
    theme_preserves_form: true,
    native_metric_mapping: '/actions[action_type=purchase]',
  };
  await page.locator('#report-delivery-close').click();
  // The middle-level control is independent from the date grouping and survives a fresh native run.
  await meta.locator('[data-report-level=meta]').selectOption('adset');
  const nextRun = page.waitForResponse(
    r => r.url().endsWith('/api/workspace/overview') && r.request().postDataJSON()?.action === 'run',
  );
  await form.locator('button[type=submit]').click();
  assert.equal((await (await nextRun).json()).success, true);
  assert.equal(await site.granular.workOnce(), true);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.report-table-wrap .report-table')]
      .at(-1)
      ?.querySelector('tbody th')
      ?.textContent.includes('Original group'),
  );
  assert.doesNotMatch(await table.locator('tbody').innerText(), /9007199254740993/);
  await page.locator('.metric-sources > summary').click();
  assert.match(await mapping.innerText(), /\/actions\[action_type=purchase\]/);
  await checks.tables(page, result);
}
