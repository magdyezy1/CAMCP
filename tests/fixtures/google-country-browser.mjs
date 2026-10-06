import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {googleCountryInput, googleCountryRows} from './google-country-evidence-data.mjs';

/** Exercise only the owned semantic-read fixture; retained search/export cannot call providers. */
export async function exerciseGoogleCountry({page, site, workflow, locale, output, id, result, before, checks}) {
  const initialEvidence = site.evidenceCounts(),
    capture = page.locator('#report-capture');
  await capture.waitFor();
  if (!(await capture.evaluate(el => el.open))) await capture.locator('summary').click();
  const form = page.locator('#capture-preset'),
    submit = form.locator('button[type=submit]'),
    feedback = page.locator('#capture-feedback');
  await form.locator('[name=preset]').selectOption('google_campaign_country');
  await form.locator('[name=target]').selectOption('0');
  assert.equal(await page.locator('#capture-google-country-measurement').isVisible(), true);
  for (const part of ['device', 'keyword', 'hour'])
    assert.equal(await page.locator('#capture-google-' + part + '-measurement').isVisible(), false);
  assert.equal(await form.locator('[name=conversion_definition]').inputValue(), 'metrics.conversions');
  assert.equal(await form.locator('[name=conversion_definition]').getAttribute('readonly'), '');
  for (const key of ['source_name', 'date_from', 'date_to', 'currency', 'timezone', 'attribution'])
    await form.locator('[name=' + key + ']').fill(googleCountryInput.semantics[key]);
  await form.locator('[name=complete]').check();
  await form.locator('[name=attribution]').fill('Synthetic declared country attribution');
  assert.equal(await form.locator('[name=complete]').isChecked(), false);
  await form.locator('[name=complete]').check();
  assert.equal(site.counts().nativeReads, before.nativeReads, 'Country scope choices make no native read');
  const input = {
      ...googleCountryInput,
      semantics: {
        ...googleCountryInput.semantics,
        attribution: 'Synthetic declared country attribution',
        conversion_definition: 'metrics.conversions',
      },
    },
    snapshot = () =>
      form.evaluate(el =>
        Object.fromEntries(
          [...el.elements].filter(f => f.name).map(f => [f.name, f.type === 'checkbox' ? f.checked : f.value]),
        ),
      ),
    original = await snapshot(),
    responseFor = () =>
      page.waitForResponse(
        r =>
          new URL(r.url()).pathname === '/api/workspace/reporting' &&
          r.request().postDataJSON()?.action === 'capture_preset',
      ),
    reason = 'Google did not return the requested native country and location type.',
    catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
    fault = workflow !== 'google-country',
    stale = workflow.endsWith('-stale');
  const assertFailure = body => {
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'REPORT_SHAPE_CHANGED');
    assert.equal(body.error.message, reason);
    assert.ok(body.meta.requestId);
  };
  if (stale) {
    let releaseResponse, signalReady, readyTimer;
    const held = new Promise(resolve => (releaseResponse = resolve)),
      ready = new Promise((resolve, reject) => {
        readyTimer = setTimeout(() => reject(Error('The owned country capture response was not ready')), 15000);
        signalReady = body => {
          clearTimeout(readyTimer);
          resolve(body);
        };
      }),
      pattern = site.origin + '/api/workspace/reporting';
    await page.route(pattern, async intercepted => {
      if (intercepted.request().postDataJSON()?.action !== 'capture_preset') return intercepted.continue();
      assert.deepEqual(intercepted.request().postDataJSON(), input);
      const response = await intercepted.fetch();
      signalReady(await response.json());
      await held;
      await intercepted.fulfill({response});
    });
    try {
      await submit.click();
      const failed = await ready;
      assertFailure(failed);
      assert.equal(site.counts().nativeReads - before.nativeReads, 3);
      assert.deepEqual(site.evidenceCounts(), initialEvidence);
      await form.locator('[name=attribution]').fill('Changed country scope');
      releaseResponse();
      await page.waitForFunction(() => !document.querySelector('#capture-preset button[type=submit]').disabled);
      assert.equal(await feedback.isVisible(), false);
      assert.equal(await page.locator('#capture-feedback-message').innerText(), '');
      assert.equal(await page.locator('#toast').isVisible(), false);
      assert.equal(await form.locator('[name=attribution]').inputValue(), 'Changed country scope');
      assert.equal(await form.locator('[name=complete]').isChecked(), false);
      assert.equal(site.counts().nativeReads - before.nativeReads, 3);
      assert.deepEqual(site.evidenceCounts(), initialEvidence);
      await form.locator('[name=attribution]').fill(original.attribution);
      await form.locator('[name=complete]').check();
      assert.deepEqual(await snapshot(), original);
      result.country_capture_stale = {
        delayed_original_failure: true,
        changed_measurement_preserved: true,
        obsolete_error_silent: true,
        failed_native_reads: 3,
        saved_reports: 0,
        automatic_retries: 0,
      };
    } finally {
      clearTimeout(readyTimer);
      releaseResponse();
      await page.unroute(pattern);
    }
  } else if (fault) {
    const pending = responseFor();
    await submit.click();
    const response = await pending,
      failed = await response.json();
    assert.deepEqual(response.request().postDataJSON(), input);
    assertFailure(failed);
    await page.waitForFunction(() => !document.querySelector('#capture-preset button[type=submit]').disabled);
    assert.equal(await feedback.isVisible(), true);
    assert.equal(await feedback.getAttribute('role'), 'alert');
    assert.equal(await feedback.getAttribute('aria-atomic'), 'true');
    const message = await page.locator('#capture-feedback-message').innerText();
    assert.ok(message.includes(locale === 'ar' ? catalog[reason] : reason));
    assert.ok(message.includes(failed.meta.requestId));
    for (const control of [form, submit])
      assert.ok((await control.getAttribute('aria-describedby')).split(/\s+/).includes('capture-feedback'));
    assert.equal(await page.locator('#toast').isVisible(), false);
    assert.deepEqual(await snapshot(), original);
    assert.equal(site.counts().nativeReads - before.nativeReads, 3);
    assert.deepEqual(site.evidenceCounts(), initialEvidence);
    await page.waitForTimeout(6600);
    assert.equal(await feedback.isVisible(), true);
    assert.equal(await page.locator('#capture-feedback-message').innerText(), message);
    assert.equal(site.counts().nativeReads - before.nativeReads, 3);
    await feedback.screenshot({path: path.join(output, id + '-diagnostic.png')});
    await form.locator('[name=attribution]').fill('Edited country scope');
    assert.equal(await feedback.isVisible(), false);
    assert.equal(await form.locator('[name=complete]').isChecked(), false);
    assert.equal(site.counts().nativeReads - before.nativeReads, 3);
    await form.locator('[name=attribution]').fill(original.attribution);
    await form.locator('[name=complete]').check();
    assert.deepEqual(await snapshot(), original);
    result.country_capture_failure = {
      code: 'REPORT_SHAPE_CHANGED',
      display_language: locale,
      original_message: reason,
      persistent_after_ms: 6600,
      request_reference_preserved: true,
      original_settings_preserved: true,
      form_and_submit_described: true,
      failed_native_reads: 3,
      saved_reports: 0,
      automatic_retries: 0,
      duplicate_toasts: 0,
    };
  }
  const pending = responseFor();
  await submit.click();
  const response = await pending,
    body = await response.json();
  assert.deepEqual(response.request().postDataJSON(), input);
  assert.equal(body.success, true, JSON.stringify(body));
  const report = body.data;
  assert.equal(report.row_count, 8);
  assert.equal(report.grain, 'campaign × native country × native location type × day');
  assert.equal(report.totals.spend, '72057594037.927944');
  assert.equal(report.totals.conversions, '16');
  assert.equal(report.source_pages.length, 2);
  assert.equal(report.native_account_evidence.checks.length, 2);
  await page.waitForFunction(() => document.querySelectorAll('#report-native-rows tbody tr').length === 8);
  const expected = googleCountryRows(),
    rows = page.locator('#report-native-rows tbody tr');
  for (let i = 0; i < expected.length; i++) {
    assert.equal((await rows.nth(i).locator('th[scope=row]').innerText()).trim(), expected[i].campaign.name);
    for (const [index, value] of [
      expected[i].geographicView.countryCriterionId,
      expected[i].geographicView.locationType,
      expected[i].segments.date,
      expected[i].campaign.resourceName,
      expected[i].geographicView.resourceName,
    ].entries())
      assert.equal((await rows.nth(i).locator('td').nth(index).innerText()).trim(), String(value));
    for (const index of [0, 1, 3, 4])
      assert.equal(await rows.nth(i).locator('td').nth(index).getAttribute('dir'), 'ltr');
  }
  assert.equal(await rows.locator('img').count(), 0);
  assert.equal(await page.locator('#search-exclusion-candidates').count(), 0);
  await checks.evidenceControls(page, result);
  await checks.productLabels(page, '#report-native-rows table', result);
  await checks.tables(page, result);
  await page.locator('#report-native-rows').screenshot({path: path.join(output, id + '-complete.png')});
  const metrics = await page.locator('.workspace-metrics').innerText();
  await page.locator('#evidence-row-query').fill('AREA_OF_INTEREST');
  await page.locator('#evidence-row-apply').click();
  await page.waitForFunction(() => document.querySelectorAll('#report-native-rows tbody tr').length === 2);
  assert.equal((await rows.first().locator('td').nth(0).innerText()).trim(), '2222');
  assert.equal((await rows.first().locator('td').nth(1).innerText()).trim(), 'AREA_OF_INTEREST');
  assert.equal(await page.locator('.workspace-metrics').innerText(), metrics);
  await page.locator('#evidence-download-language').selectOption(locale);
  const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#evidence-download-xlsx').click(),
    ]),
    workbookPath = path.join(output, id + '.xlsx');
  await download.saveAs(workbookPath);
  const bytes = fs.readFileSync(workbookPath),
    book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  const sheet = book.worksheets[1];
  assert.equal(sheet.rowCount, 9, 'Retained country filtering downloads all original rows');
  assert.equal(sheet.columnCount, 14);
  assert.equal(sheet.getCell('L1').value, 'native_country_criterion_id');
  assert.equal(Boolean(sheet.views[0].rightToLeft), locale === 'ar');
  for (let i = 0; i < expected.length; i++) {
    assert.equal(sheet.getCell(i + 2, 1).value, expected[i].campaign.resourceName);
    assert.equal(sheet.getCell(i + 2, 2).value, expected[i].campaign.name);
    assert.equal(sheet.getCell(i + 2, 12).value, expected[i].geographicView.countryCriterionId);
    assert.equal(sheet.getCell(i + 2, 13).value, expected[i].geographicView.locationType);
    assert.equal(sheet.getCell(i + 2, 14).value, expected[i].geographicView.resourceName);
  }
  assert.equal(sheet.getCell('L2').value, '0');
  assert.equal(sheet.getCell('L9').value, '2222');
  assert.equal(sheet.getCell('M2').value, 'UNSPECIFIED');
  assert.equal(sheet.getCell('M4').value, 'AREA_OF_INTEREST');
  assert.equal(sheet.getCell('M5').value, 'LOCATION_OF_PRESENCE');
  assert.equal(sheet.getCell('E2').value, '9007199254.740993');
  assert.equal(sheet.getCell('H2').value, '2');
  assert.ok(book.worksheets[2].getColumn(2).values.includes('72057594037.927944'));
  assert.equal(
    site.counts().nativeReads - before.nativeReads,
    fault ? 7 : 4,
    'Retained country search/export makes no additional native read',
  );
  assert.equal(site.evidenceCounts().reports, initialEvidence.reports + 1);
  assert.equal(site.evidenceCounts().plans, initialEvidence.plans);
  assert.equal(site.evidenceCounts().reviews, initialEvidence.reviews);
  result.country_report = {
    original_rows: 8,
    filtered_rows: 2,
    workbook_rows: 8,
    workbook_bytes: bytes.length,
    workbook_language: locale,
    native_countries: [...new Set(expected.map(row => row.geographicView.countryCriterionId))],
    native_location_types: [...new Set(expected.map(row => row.geographicView.locationType))],
    presence_and_interest_preserved: true,
    native_reads: fault ? 7 : 4,
    provider_mutations: 0,
  };
  await checks.tables(page, result);
  await page.locator('#report-native-rows').screenshot({path: path.join(output, id + '-filtered.png')});
}
