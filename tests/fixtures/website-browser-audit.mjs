// Optional browser audit: synthetic owner/report journeys, reflow and axe accessibility checks.
// Requires Playwright, axe-core (or AMCP_AXE_SCRIPT) and a Chromium executable.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url),
  {chromium} = require('playwright'),
  axeScript = process.env.AMCP_AXE_SCRIPT ?? require.resolve('axe-core/axe.js');
mkdirSync('.runtime', {recursive: true});
const server = spawn(process.execPath, ['tests/fixtures/reporting-browser.mjs', '43285'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverText = '',
  browser,
  page;
server.stderr.on('data', b => process.stderr.write(b));
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Fixture failed to start')), 15000);
  server.stdout.on('data', b => {
    serverText += b.toString();
    if (serverText.includes('Synthetic reporting fixture:')) {
      clearTimeout(timer);
      resolve();
    }
  });
  server.on('exit', code => {
    clearTimeout(timer);
    reject(Error('Fixture exited ' + code));
  });
});
const base = 'http://127.0.0.1:43285';
const measurements = {version: null, journeys: [], pages: [], pageErrors: []};
(async () => {
  await ready;
  browser = await chromium.launch({
    executablePath: process.env.AMCP_BROWSER_EXECUTABLE,
    args: ['--no-zygote', '--single-process'],
    headless: true,
  });
  measurements.version = await browser.version();
  page = await browser.newPage({viewport: {width: 1280, height: 900}, locale: 'en-US', timezoneId: 'UTC'});
  page.on('pageerror', e => measurements.pageErrors.push(e.message));
  async function audit(route, width, authenticated) {
    await page.setViewportSize({width, height: 900});
    const started = Date.now();
    await page.goto(base + route);
    await page.waitForFunction(() => !document.querySelector('.initial-loading'));
    await page.evaluate(readFileSync(axeScript, 'utf8'));
    const result = await page.evaluate(async () => {
      const a = await axe.run(document, {
        runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']},
      });
      return {
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        title: document.title,
        h1: [...document.querySelectorAll('main h1')].map(e => e.textContent),
        violations: a.violations.map(v => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.map(n => ({target: n.target, summary: n.failureSummary})),
        })),
        navigation: performance.getEntriesByType('navigation').map(n => ({
          domContentLoaded: n.domContentLoadedEventEnd,
          responseEnd: n.responseEnd,
          transferSize: n.transferSize,
        })),
        resources: performance.getEntriesByType('resource').reduce(
          (r, e) => {
            r.transferBytes += e.transferSize;
            r.encodedBytes += e.encodedBodySize;
            r.requests++;
            return r;
          },
          {requests: 0, transferBytes: 0, encodedBytes: 0},
        ),
      };
    });
    if (authenticated && width === 320 && ['/dashboard', '/account'].includes(route))
      await page.screenshot({path: '.runtime/website-audit-' + route.slice(1) + '-320-final.png', fullPage: true});
    measurements.pages.push({route, width, authenticated, elapsed: Date.now() - started, ...result});
    console.log('Audited ' + route + ' ' + width);
  }
  for (const width of [320, 360, 430, 1280])
    for (const route of ['/', '/login', '/signup', '/privacy', '/terms', '/data-deletion'])
      await audit(route, width, false);
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto(base + '/login');
  await page.locator('[data-open-admin]').click();
  await page.locator('#password').fill('synthetic-browser-password');
  await page.locator('#login-form button[type=submit]').click();
  await page.waitForURL('**/dashboard');
  measurements.journeys.push({name: 'Administrator sign-in', passed: true});
  await page.locator('[data-route="reporting-overview"]').click();
  await page.locator('#overview-config').waitFor();
  await page.locator('#overview-config [name="client_name"]').fill('Synthetic client A');
  await page.locator('#overview-config [name="name"]').fill('Synthetic weekly review');
  await page
    .locator('details.report-platform')
    .filter({has: page.locator('[data-report-account="meta"]')})
    .locator('summary')
    .first()
    .click();
  await page.locator('[data-report-account="meta"]').first().check();
  await page.locator('#overview-save').click();
  await page.waitForFunction(
    () =>
      document.querySelector('#overview-saved')?.innerText.includes('Synthetic weekly review') ||
      document.querySelector('#toast')?.innerText.includes('saved'),
  );
  measurements.journeys.push({name: 'Save client-specific report', passed: true});
  await page.locator('#overview-config button[type=submit]').click();
  await page.waitForFunction(
    () => document.querySelector('#overview-results')?.innerText.includes('Download CSV'),
    {},
    {timeout: 15000},
  );
  const csvUrl = await page.locator('#overview-results a[download="AMCP-campaign-report.csv"]').getAttribute('href'),
    csv = await page.request.get(base + csvUrl),
    csvText = await csv.text();
  measurements.journeys.push({
    name: 'Collect report and download CSV',
    passed: csv.ok() && csvText.includes('42.5'),
    bytes: Buffer.byteLength(csvText),
    result: await page.locator('#overview-results').innerText(),
  });
  await page.locator('#overview-delivery').click();
  await page.locator('#report-bind-url').waitFor();
  await page
    .locator('#report-bind-url [name="spreadsheet_url"]')
    .fill('https://docs.google.com/spreadsheets/d/syntheticSheetA/edit');
  await page.locator('#report-bind-url [name="tab_name"]').fill('Synthetic weekly review');
  await page.locator('#report-bind-url button').click();
  await page.waitForFunction(() => !!document.querySelector('#report-destination')?.value, {}, {timeout: 15000});
  await page.locator('#report-export-now').click();
  await page.waitForFunction(
    () => /complete/i.test(document.querySelector('#delivery-status')?.textContent ?? ''),
    {},
    {timeout: 15000},
  );
  measurements.journeys.push({
    name: 'Bind selected Sheets file and export snapshot',
    passed: true,
    status: await page.locator('#delivery-status').innerText(),
  });
  await page.locator('#report-delivery-close').click();
  for (const width of [320, 360, 430, 1280])
    for (const route of [
      '/dashboard',
      '/connections',
      '/campaigns',
      '/media',
      '/profiles',
      '/reports',
      '/connectors',
      '/reporting-overview',
      '/settings',
      '/activity',
      '/account',
    ])
      await audit(route, width, true);
  assert.ok(
    measurements.journeys.every(j => j.passed),
    'A synthetic owner/report journey failed',
  );
  assert.equal(
    measurements.pages.filter(p => p.overflow || p.violations.length).length,
    0,
    'A page overflows or fails the accessibility audit',
  );
  assert.equal(measurements.pageErrors.length, 0, 'Uncaught browser errors');
  console.log(
    JSON.stringify(
      {
        journeys: measurements.journeys.map(j => ({name: j.name, passed: j.passed})),
        pages: measurements.pages.length,
        violations: measurements.pages
          .filter(p => p.violations.length)
          .map(p => ({route: p.route, width: p.width, ids: p.violations.map(v => v.id)})),
        overflow: measurements.pages.filter(p => p.overflow).map(p => ({route: p.route, width: p.width})),
        errors: measurements.pageErrors,
      },
      null,
      2,
    ),
  );
})()
  .catch(e => {
    console.error(e);
    measurements.error = e.message;
    process.exitCode = 1;
  })
  .finally(async () => {
    if (measurements.error && page) {
      measurements.errorPage = {
        url: page.url(),
        text: await page.locator('main').innerText(),
        toast: await page.locator('#toast').innerText(),
      };
      await page.screenshot({path: '.runtime/website-audit-browser-error.png', fullPage: true});
    }
    writeFileSync('.runtime/website-audit-browser-results.json', JSON.stringify(measurements, null, 2) + '\n');
    await browser?.close();
    server.kill('SIGTERM');
  });
