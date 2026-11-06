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

// F-L8-01: the card's Retry resubmits the run form. It used to call requestSubmit() with no submitter, which crashed
// authBind before the run started (tests/auth-bind-submitter.test.mjs); the browser case in
// tests/fixtures/overview-v4-browser.mjs clicks the real button and counts the `run` requests.
function retryPage({busy = false, form = true} = {}) {
  const context = page(),
    submit = {getAttribute: name => (name === 'aria-busy' && busy ? 'true' : null)},
    submitted = [],
    node = {
      querySelector: selector => (selector === 'button[type="submit"]' ? submit : null),
      requestSubmit: (...args) => submitted.push(args),
    };
  context.$ = selector => (selector === '#overview-config' && form ? node : null);
  return {context, submit, submitted};
}
test('Retry submits the run form through its own submit button, so the submit event carries a submitter', async () => {
  const {context, submit, submitted} = retryPage();
  await new Script('retryReportRun()').runInContext(context);
  assert.equal(submitted.length, 1, 'the report is run once');
  assert.equal(submitted[0].length, 1, 'requestSubmit is given a submitter');
  assert.equal(submitted[0][0], submit, 'the form’s own submit button');
});
test('Retry does not start a second run while the first is still running, and tolerates a missing form', async () => {
  const running = retryPage({busy: true});
  await new Script('retryReportRun()').runInContext(running.context);
  assert.deepEqual(running.submitted, [], 'the submit button is busy: a second click starts nothing');
  const absent = retryPage({form: false});
  await new Script('retryReportRun()').runInContext(absent.context);
  assert.deepEqual(absent.submitted, []);
});

// F-L1-05, F-L1-08 and F-L1-11: the card's actions and HTTP badge follow what the server says about the failure.
test('a credential failure the server marks offers Manage connections beside Retry, and prints no HTTP 200', () => {
  // TikTok answered HTTP 200 with an in-body "access token invalid" code: a provider failure whose layer is credential.
  const html = render({
    code: 'PLATFORM_ERROR',
    category: 'provider',
    layer: 'credential',
    http_status: 200,
    message: 'The provider rejected the request.',
    provider: {code: '40105', message: 'Access token is invalid or expired'},
  });
  assert.match(html, /data-report-retry/);
  assert.match(html, /href="\/connections"/);
  assert.match(html, /data-report-diagnostic/);
  assert.doesNotMatch(html, /HTTP 200|HTTP /);
  // A provider failure that is not a credential one keeps Retry and Copy only.
  const other = render({code: 'PLATFORM_ERROR', category: 'provider', layer: 'unknown', message: 'm'});
  assert.match(other, /data-report-retry/);
  assert.doesNotMatch(other, /href="\/connections"/);
});
test('a login that changed during the report offers Retry, its own next step, beside Manage connections', () => {
  const html = render({
    code: 'CONNECTION_AUTHORITY_CHANGED',
    category: 'connection',
    message: 'The login changed.',
    next_action:
      'The login was replaced or its permissions changed during this report. Retry the report with the current login.',
  });
  assert.match(html, /data-report-retry/);
  assert.match(html, /href="\/connections"/);
  assert.match(html, /Retry the report with the current login/);
  // The other connection failures still ask for a reconnect, not a retry.
  assert.doesNotMatch(render({code: 'AUTH_EXPIRED', category: 'connection', message: 'm'}), /data-report-retry/);
});
test('the HTTP badge names only a status a provider answered with: a 4xx or 5xx integer', () => {
  const badge = status =>
    /HTTP (\d+)/.exec(render({code: 'UPSTREAM_ERROR', category: 'provider', message: 'm', http_status: status}))?.[1];
  for (const status of [400, 401, 404, 429, 500, 503, 599]) assert.equal(badge(status), String(status), String(status));
  for (const status of [200, 204, 302, 399, 600, 0, -1, 500.5, '500', null, undefined, NaN])
    assert.equal(badge(status), undefined, String(status));
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
