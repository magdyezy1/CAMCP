// Ruling 16 (7), P2B-02 end to end without a browser: a report whose provider names carry a combining mark directly after a space and
// after a no-break space (Latin and Arabic) is collected from the fixture's fake provider, assembled, charted and exported to PDF
// through the website's own route, in both PDF languages. Before P2B-02 the route answered 500 on every one. The rendered kind
// `report-pdf-export` (tools/browser-workflow-qa.mjs) does the same through the real page and download button.
import test from 'node:test';
import assert from 'node:assert/strict';
import {browserWorkflowSite} from './fixtures/browser-workflow-sites.mjs';
import {
  asRead,
  inCodePoints,
  presentationFor,
  providerNamesFor,
  reportPdfExportConfig,
} from './fixtures/report-pdf-export-data.mjs';
import {openPdf} from './helpers/pdf-structure.mjs';
import {pdfActualText} from './helpers/pdf-actual-text.mjs';

const credentials = site => ({
  origin: site.origin,
  'x-amcp-csrf': site.csrf,
  cookie: site.cookie.name + '=' + site.cookie.value,
});
const call = async (site, tool, body) => {
  const response = await fetch(site.origin + '/api/workspace/' + tool, {
    method: 'POST',
    headers: {'content-type': 'application/json', ...credentials(site)},
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, tool + ' ' + body.action);
  return response.json();
};

test('a report with provider names that carry a mark after a space is exported to PDF through the website, in both languages (P2B-02)', async t => {
  const site = await browserWorkflowSite('report-pdf-export');
  t.after(() => site.close());
  for (const page of ['en', 'ar']) {
    const names = providerNamesFor[page];
    site.granular.providerNames(names);
    const queued = await call(site, 'overview', {action: 'run', config: reportPdfExportConfig(), confirmed: true});
    assert.equal(queued.success, true, JSON.stringify(queued.error));
    const id = queued.data.id;
    assert.equal(await site.granular.workOnce(), true);
    const stored = site.granular.store.document(site.granular.tenant, 'overview_report', id);
    assert.equal(stored.state, 'complete', page + ': ' + JSON.stringify(stored.sources).slice(0, 400));
    // The provider's names reached the report as they were sent.
    assert.deepEqual(stored.rows.map(row => row.entity_name).sort(), [names.campaign, names.ad].sort(), page);
    for (const language of ['en', 'ar']) {
      const pack = await call(site, 'overview', {action: 'report_pack', id}),
        saved = await call(site, 'overview', {
          action: 'save_presentation',
          id,
          presentation: presentationFor(language),
          presentation_revision: pack.data.presentation_revision ?? 0,
          confirmed: true,
        });
      assert.equal(saved.success, true, JSON.stringify(saved.error));
      const label = `${page} names, ${language} PDF`,
        response = await fetch(site.origin + '/api/reporting-overview/' + id + '.pdf', {headers: credentials(site)});
      assert.equal(response.status, 200, label + ' answered ' + response.status);
      assert.match(response.headers.get('content-type'), /^application\/pdf/, label);
      const bytes = Buffer.from(await response.arrayBuffer()),
        opened = openPdf(bytes),
        read = pdfActualText(bytes);
      assert.ok(opened.pages >= 1 && opened.streams > opened.pages, label + ': ' + JSON.stringify(opened));
      for (const name of [names.campaign, names.ad])
        assert.ok(read.includes(asRead(name)), `${label}: the PDF carries ${inCodePoints(name)}`);
    }
  }
  assert.equal(site.counts().writes, 0);
  assert.equal(site.counts().refused, 0);
});
