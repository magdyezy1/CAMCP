// Optional local browser regression check. Uses the synthetic in-memory reporting fixture only.
// Install Playwright separately; AMCP_BROWSER_EXECUTABLE can name an existing Chromium executable.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const {chromium} = createRequire(import.meta.url)('playwright'),
  port = 43284,
  base = 'http://127.0.0.1:' + port,
  server = spawn(process.execPath, ['tests/fixtures/reporting-browser.mjs', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
let browser;
const failures = [],
  checks = [];
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Synthetic fixture did not start.')), 15000);
  server.stdout.on('data', b => {
    if (b.toString().includes('Synthetic reporting fixture:')) {
      clearTimeout(timer);
      resolve();
    }
  });
  server.stderr.on('data', b => process.stderr.write(b));
  server.on('exit', code => {
    clearTimeout(timer);
    reject(Error('Fixture exited: ' + code));
  });
});
function check(name, condition, details) {
  checks.push({name, passed: Boolean(condition), details});
  if (!condition) failures.push(name);
}
try {
  await ready;
  browser = await chromium.launch({
    executablePath: process.env.AMCP_BROWSER_EXECUTABLE,
    args: ['--no-zygote', '--single-process'],
    headless: true,
  });
  const page = await browser.newPage({locale: 'en-US', viewport: {width: 320, height: 900}}),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/login');
  await page.locator('[data-open-admin]').click();
  await page.locator('#password').fill('synthetic-browser-password');
  await page.locator('#login-form button[type=submit]').click();
  await page.waitForURL('**/dashboard');
  for (const route of ['/dashboard', '/account']) {
    await page.goto(base + route);
    await page.locator(route === '/account' ? '.account-security-panel' : '.overview-welcome').waitFor();
    const width = await page.evaluate(() => ({viewport: innerWidth, document: document.documentElement.scrollWidth}));
    check(route + ' fits at 320 px', width.document <= width.viewport + 1, width);
  }
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto(base + '/dashboard');
  await page.locator('[data-check-account]').first().focus();
  await page.locator('[data-check-account]').first().press('Enter');
  await page.waitForFunction(() => document.querySelector('main')?.innerText.includes('Prerequisites'));
  const focus = await page.evaluate(() => ({
    tag: document.activeElement.tagName,
    control: document.activeElement.getAttribute('data-check-account'),
  }));
  check('account readiness retains keyboard focus', focus.tag === 'BUTTON' && focus.control === '0', focus);

  let release;
  const waiting = new Promise(resolve => {
      release = resolve;
    }),
    requested = new Promise(resolve => {
      void page.route('**/api/activity', async route => {
        resolve();
        await waiting;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({events: [{at: 1, event: {event: 'old fixture activity'}}]}),
        });
      });
    });
  await page.evaluate(() => {
    window.activitySettled = false;
    const original = renderActivity;
    renderActivity = async () => {
      try {
        return await original();
      } finally {
        window.activitySettled = true;
      }
    };
  });
  await page.locator('[data-route="activity"]').click();
  await requested;
  await page.locator('[data-route="connections"]').click();
  const before = await page.locator('#content').innerText();
  release();
  await page.waitForFunction(() => window.activitySettled);
  check('delayed activity cannot overwrite Connections', (await page.locator('#content').innerText()) === before);
  await page.unroute('**/api/activity');
  await page.route('**/api/activity', route =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({error: {code: 'UNAUTHORIZED', message: 'Synthetic expired session'}}),
    }),
  );
  await page.locator('[data-route="activity"]').click();
  await page.waitForURL('**/login');
  await page.waitForFunction(() => window.activitySettled);
  await page.waitForFunction(() => !!document.querySelector('#member-form'));
  check('session expiry keeps sign-in visible', await page.locator('#member-form').isVisible());
  check('no uncaught browser errors', errors.length === 0, errors);
  console.log(JSON.stringify({version: await browser.version(), checks}, null, 2));
  assert.equal(failures.length, 0, failures.join('; '));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
