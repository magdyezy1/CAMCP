// V2-RPT-05 (wave 5 round 1, Task 2): a failed source card acts by its error's category. A provider-data failure
// offers Retry and Copy, never "HTTP 400" or Manage connections; previews show the provider's own refusal details.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script, createContext} from 'node:vm';
import {providerDataAction} from '../dist/src/errors.js';

const esc = value =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
// The way tests/report-source-errors.test.ts loads the report builder and the shell's diagnostic helper.
function page() {
  const context = createContext({esc, document: {addEventListener() {}}});
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/report-quality.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/report-workflows.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/reporting-overview.js', 'utf8')).runInContext(context);
  const workspace = readFileSync('web/workspace.js', 'utf8');
  new Script(
    workspace.slice(
      workspace.indexOf('const overviewCall = async input => {'),
      workspace.indexOf('const capabilityFeatureLabels'),
    ),
  ).runInContext(context);
  return context;
}
const source = {platform: 'tiktok', connection_id: 'c', account_id: '7'};
function render(error) {
  const context = page();
  context.input = {source, complete: false, error};
  return new Script('renderReportSourceHealth(input,[{id:"tiktok",name:"TikTok"}],0)').runInContext(context);
}

test('a provider-data source card offers Retry and Copy, never HTTP 400 or Manage connections', () => {
  const html = render({
    code: 'REPORT_INCOMPLETE',
    category: 'provider_data',
    message: 'TikTok returned missing or inconsistent native report page counts.',
    next_action: providerDataAction,
    page_facts: {
      page: 2,
      page_size: 1000,
      total_number: 1500,
      total_page: 2,
      list_length: 1200,
      rule: 'page_longer_than_size',
    },
  });
  assert.match(html, /data-report-retry/);
  assert.match(html, /data-report-diagnostic/);
  assert.match(html, />Retry</);
  assert.doesNotMatch(html, /HTTP 400/);
  assert.doesNotMatch(html, /HTTP /);
  assert.doesNotMatch(html, /href="\/connections"/);
  assert.match(html, /The platform returned report data AMCP cannot accept as complete/);
});

test('a provider card offers Retry and Copy and keeps its HTTP status', () => {
  const html = render({code: 'UPSTREAM_ERROR', category: 'provider', message: 'm', http_status: 500});
  assert.match(html, /data-report-retry/);
  assert.match(html, /data-report-diagnostic/);
  assert.match(html, /HTTP 500/);
  assert.doesNotMatch(html, /href="\/connections"/);
});

test('a connection or permission card keeps Manage connections; rate-limit, request and internal cards offer Copy only', () => {
  for (const [category, status] of [
    ['connection', 401],
    ['permission', 403],
  ]) {
    const html = render({code: 'X', category, message: 'm', http_status: status});
    assert.match(html, /href="\/connections"/, category);
    assert.match(html, /data-report-diagnostic/, category);
    assert.doesNotMatch(html, /data-report-retry/, category);
  }
  for (const category of ['rate_limit', 'request', 'internal']) {
    const html = render({code: 'X', category, message: 'm', http_status: 400});
    assert.doesNotMatch(html, /href="\/connections"/, category);
    assert.doesNotMatch(html, /data-report-retry/, category);
    assert.match(html, /data-report-diagnostic/, category);
  }
});

test('a stored diagnostic without a category renders as before', () => {
  // Old snapshots render as recorded: Manage connections and Copy, with the stored HTTP status.
  const html = render({code: 'INSUFFICIENT_SCOPE', message: 'Forbidden', http_status: 403});
  assert.match(html, /href="\/connections"/);
  assert.match(html, /data-report-diagnostic/);
  assert.doesNotMatch(html, /data-report-retry/);
  assert.match(html, /HTTP 403/);
});

test('the Retry button resubmits the run form', () => {
  const builder = readFileSync('web/reporting-overview.js', 'utf8');
  assert.match(builder, /\[data-report-retry\]/);
  assert.match(builder, /#overview-config'\)\??\.requestSubmit\(\)/);
});

test('a preview error shows the provider message and request ID through the shared diagnostic renderer', () => {
  const context = page();
  new Script(readFileSync('web/ad-previews.js', 'utf8')).runInContext(context);
  context.result = {
    platform: 'linkedin',
    account_id: '7',
    meaning: 'Preview links open for anyone who has them and expire.',
    previews: [
      {
        ad_id: 'urn:li:sponsoredCreative:1',
        name: 'C',
        links: [],
        error: {
          code: 'UPSTREAM_ERROR',
          message: 'LinkedIn refused the preview.',
          category: 'provider',
          http_status: 400,
          provider: {message: 'Invalid <account>', request_id: 'abc'},
        },
      },
    ],
  };
  const html = new Script('previewResults(result)').runInContext(context);
  assert.match(html, /source-diagnostic/);
  assert.match(html, /Invalid &lt;account&gt;/);
  assert.match(html, /<code>abc<\/code>/);
  assert.doesNotMatch(html, /<account>/);
});
