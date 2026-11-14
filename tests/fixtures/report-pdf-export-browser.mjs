import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {asRead, inCodePoints, providerNamesFor} from './report-pdf-export-data.mjs';
import {openPdf} from '../helpers/pdf-structure.mjs';
import {pdfActualText} from '../helpers/pdf-actual-text.mjs';

/**
 * P2B-02, the rendered kind `report-pdf-export`: a report whose provider names carry a combining mark directly after a space and
 * after a no-break space, in Latin and in Arabic, is run through the real editor and worker, and exported to PDF with the report pack
 * page's own button, in both PDF languages (a saved setting of the pack). Each download must be a PDF that opens (the structure a
 * reader needs: tests/helpers/pdf-structure.mjs) and must carry the names of the report's entities as they were sent. Before P2B-02
 * the route answered 500 for every one of them, with a generic error, and nothing was downloaded. The fake provider is the
 * granular fixture's own; nothing leaves the loopback origin.
 */
export async function exerciseReportPdfExport({page, site, locale, output, id, result}) {
  const names = providerNamesFor[locale],
    entities = [names.campaign, names.ad];
  site.granular.providerNames(names);
  // The steps of the granular-reporting case, with the two levels and the selected ad of its overview-v4 case.
  const form = page.locator('#overview-config'),
    meta = page.locator('.report-platform').filter({has: page.locator('[data-report-level=meta]')});
  await form.locator('[name=name]').fill('PDF export check');
  await form.locator('[name=rangeMode]').selectOption('custom');
  await form.locator('[name=since]').fill('2026-09-01');
  await form.locator('[name=until]').fill('2026-09-02');
  await meta.locator(':scope > summary').click();
  await meta.locator('[data-report-account=meta]').check();
  await meta.locator('[data-report-level=meta]').selectOption(['campaign', 'ad']);
  await meta.locator('[data-report-result=meta]').fill('purchase');
  await meta.locator('[data-report-complete-window=meta]').check();
  await meta.locator('[data-objective-for=meta]').selectOption('sales');
  const source = meta.locator('[data-report-source]'),
    filters = source.locator('details.native-settings');
  if (!(await filters.evaluate(element => element.open))) await filters.locator(':scope > summary').click();
  await source.locator('[data-report-scope=ad_ids]').fill('9007199254740993');
  await source.locator('[data-report-delivered=meta]').uncheck();
  await source.locator('[data-report-statuses=meta]').selectOption('all');
  const run = page.waitForResponse(
    response =>
      response.url().endsWith('/api/workspace/overview') && response.request().postDataJSON()?.action === 'run',
  );
  await form.locator('button[type=submit]').click();
  const envelope = await (await run).json();
  assert.equal(envelope.success, true, JSON.stringify(envelope));
  const reportId = envelope.data.id;
  assert.equal(await site.granular.workOnce(), true);
  await page.waitForFunction(
    reportId =>
      document.querySelector('#overview-results a[download="AMCP-report.csv"]')?.getAttribute('href') ===
      '/api/reporting-overview/' + encodeURIComponent(reportId) + '.csv',
    reportId,
  );
  const stored = site.granular.store.document(site.granular.tenant, 'overview_report', reportId);
  assert.equal(stored.state, 'complete', JSON.stringify(stored.sources).slice(0, 400));
  assert.deepEqual(
    stored.rows.map(row => row.entity_name).sort(),
    [...entities].sort(),
    'the provider names reached the report as they were sent',
  );

  // The report pack page: the PDF language is a saved presentation setting, English until it is saved.
  const pack = site.origin + '/report-pack?report_id=' + encodeURIComponent(reportId);
  let saved = 'en';
  result.report_pdf_export = [];
  for (const language of ['en', 'ar']) {
    await page.goto(pack, {waitUntil: 'networkidle'});
    await page.locator('#download-pack-pdf').waitFor({state: 'visible'});
    if (language !== saved) {
      await page
        .locator('#report-presentation')
        .evaluate(presentation => (presentation.closest('details').open = true));
      await page.locator('#report-presentation [name=artifact_language]').selectOption(language);
      await page.locator('#report-presentation [name=confirmed]').check();
      const presented = page.waitForResponse(
        response =>
          response.url().endsWith('/api/workspace/overview') &&
          response.request().postDataJSON()?.action === 'save_presentation',
      );
      await page.locator('#report-presentation button[type=submit]').click();
      assert.equal((await (await presented).json()).success, true, 'the ' + language + ' presentation was saved');
      saved = language;
      await page.locator('#download-pack-pdf').waitFor({state: 'visible'});
    }
    const answered = page.waitForResponse(
        response => new URL(response.url()).pathname === '/api/reporting-overview/' + reportId + '.pdf',
      ),
      downloading = page.waitForEvent('download');
    // A refused export never downloads: the pending wait must not reject unhandled when the case has already failed.
    downloading.catch(() => {});
    await page.locator('#download-pack-pdf').click();
    const label = `the ${language} PDF of a report with the provider names ${entities.map(inCodePoints).join(' and ')}`,
      response = await answered;
    assert.equal(response.status(), 200, `${label} answered ${response.status()}`);
    assert.match(response.headers()['content-type'] ?? '', /^application\/pdf/, label);
    const file = path.join(output, `${id}-${language}.pdf`);
    await (await downloading).saveAs(file);
    const bytes = fs.readFileSync(file),
      opened = openPdf(bytes),
      read = pdfActualText(bytes);
    assert.ok(opened.pages >= 1 && opened.streams > opened.pages, `${label} does not open: ${JSON.stringify(opened)}`);
    for (const name of entities)
      assert.ok(read.includes(asRead(name)), `${label} does not carry ${inCodePoints(name)}`);
    result.report_pdf_export.push({
      pdf_language: language,
      provider_names: entities,
      file: path.basename(file),
      bytes: bytes.length,
      pages: opened.pages,
      objects: opened.objects,
      streams: opened.streams,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  // The case ends on the page it began on, so that the checks every case runs at its end read the same page.
  await page.goto(site.origin + '/reporting-overview', {waitUntil: 'networkidle'});
}
