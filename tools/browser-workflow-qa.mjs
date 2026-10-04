import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {browserWorkflowSite} from '../tests/fixtures/browser-workflow-sites.mjs';

const root = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url))),
  args = process.argv.slice(2),
  configuredModule = process.env.AMCP_QA_PLAYWRIGHT_MODULE,
  executablePath = process.env.AMCP_QA_BROWSER_PATH;
if (args.length !== 2 || args[0] !== '--output-dir')
  throw Error(
    'Use --output-dir .runtime/<fresh-directory>; configure AMCP_QA_PLAYWRIGHT_MODULE and AMCP_QA_BROWSER_PATH.',
  );
if (!configuredModule || !path.isAbsolute(configuredModule) || !executablePath || !path.isAbsolute(executablePath))
  throw Error('Browser QA requires explicit installed local Playwright module and test browser executable paths.');
if (!fs.statSync(executablePath).isFile()) throw Error('The configured test browser executable is not a file.');
const gitRoot = fs.realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], {cwd: root}).toString().trim());
if (root !== gitRoot || fs.realpathSync(process.cwd()) !== root)
  throw Error(
    'Run rendered browser qualification from the Git checkout root, alongside its exact source verification.',
  );
const output = path.resolve(root, args[1]),
  runtime = path.resolve(root, '.runtime');
if (!output.startsWith(runtime + path.sep) || fs.existsSync(output))
  throw Error('Browser QA output must be a fresh child of this checkout’s ignored .runtime directory.');
fs.mkdirSync(path.dirname(output), {recursive: true});
const realOutputParent = fs.realpathSync(path.dirname(output));
if (realOutputParent !== runtime && !realOutputParent.startsWith(runtime + path.sep))
  throw Error('Browser QA output escaped the ignored runtime.');
fs.mkdirSync(output);
const require = createRequire(import.meta.url),
  {chromium} = require(configuredModule),
  browser = await chromium.launch({executablePath, headless: true, args: ['--no-proxy-server']}),
  sha = bytes => createHash('sha256').update(bytes).digest('hex'),
  files = execFileSync('git', ['ls-files', '-z', 'web'], {cwd: root}).toString().split('\0').filter(Boolean),
  evidence = {
    record_kind: 'local_synthetic_rendered_workflow_qualification',
    started_at: new Date().toISOString(),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root}).toString().trim(),
    working_tree_clean: !execFileSync('git', ['status', '--porcelain'], {cwd: root}).toString().trim(),
    browser: browser.version(),
    browser_executable_sha256: sha(fs.readFileSync(executablePath)),
    playwright_version: require(path.join(configuredModule, 'package.json')).version,
    runner_source_sha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))),
    fixture_source_sha256: sha(fs.readFileSync(path.join(root, 'tests/fixtures/browser-workflow-sites.mjs'))),
    website_source_sha256: sha(
      Buffer.from(files.map(file => file + '\0' + sha(fs.readFileSync(path.join(root, file)))).join('\n')),
    ),
    provider_mutations: 0,
    external_provider_requests: 0,
    cases: [],
  };
const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(evidence, null, 2) + '\n');

async function keyboardNavigation(page, width) {
  const skip = page.locator('.skip,.skip-link'),
    target = (await skip.getAttribute('href')).slice(1);
  await skip.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), target, 'Keyboard skip link must reach main');
  if (width <= 850 && (await page.locator('#menu-toggle').isVisible())) {
    await page.locator('#menu-toggle').click();
    assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.querySelector('.main-shell').inert), true);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('sidebar-close')), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('#workspace-sidebar')), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('sidebar-close')), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'menu-toggle');
    assert.equal(await page.evaluate(() => document.querySelector('.main-shell').inert), false);
    await page.locator('#menu-toggle').click();
    await page.keyboard.press('Control+k');
    assert.equal(await page.locator('#command-dialog').evaluate(el => el.open), true);
    assert.equal(await page.evaluate(() => document.body.classList.contains('menu-open')), false);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'menu-toggle');
  }
}

async function checkTables(page, result) {
  result.tables = [];
  for (const region of await page.locator('.report-table-wrap[role=region],.data-scroll[role=region]').all()) {
    if (!(await region.isVisible()) || !(await region.locator('table').count())) continue;
    const before = await region.evaluate(el => ({
      width: el.clientWidth,
      scrollWidth: el.scrollWidth,
      scrollLeft: el.scrollLeft,
      direction: getComputedStyle(el).direction,
      caption: el.querySelector('caption')?.textContent.trim(),
      label: el.getAttribute('aria-label'),
      tabIndex: el.tabIndex,
    }));
    assert.ok(before.caption && before.label, 'Native table needs a caption and named region');
    assert.equal(before.tabIndex, 0, 'Native table scroll region needs keyboard access');
    if (before.scrollWidth > before.width + 1) {
      await region.focus();
      await page.keyboard.press(before.direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight');
      await page.waitForFunction(({selector, before}) => document.querySelector(selector)?.scrollLeft !== before, {
        selector: await region.evaluate(el => {
          el.dataset.browserQaScroll = 'selected';
          return '[data-browser-qa-scroll=selected]';
        }),
        before: before.scrollLeft,
      });
      await region.evaluate(el => delete el.dataset.browserQaScroll);
    }
    result.tables.push(before);
  }
}

async function renderedCase(site, kind, route, locale, width, authenticated, workflow) {
  const id = `${kind}-${route.slice(1) || 'home'}-${locale}-${width}`.replaceAll('/', '-'),
    context = await browser.newContext({
      viewport: {width, height: 900},
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    }),
    page = await context.newPage(),
    result = {id, kind, route, locale, width, errors: [], failed_responses: [], blocked_external_requests: []},
    before = site.counts();
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(20000);
  await context.route('**/*', intercepted => {
    const url = new URL(intercepted.request().url());
    if (url.origin === site.origin) return intercepted.continue();
    result.blocked_external_requests.push(url.origin + url.pathname);
    return intercepted.abort('blockedbyclient');
  });
  if (authenticated) await context.addCookies([site.cookie]);
  await context.addInitScript(locale => localStorage.setItem('amcp.locale', locale), locale);
  page.on('pageerror', error => result.errors.push(error.message));
  page.on('response', response => {
    if (response.status() >= 400)
      result.failed_responses.push({path: new URL(response.url()).pathname, status: response.status()});
  });
  try {
    const query =
      workflow === 'snapchat' ? '?asset_id=asset-147&reference_view=snapchat_top_snap&reference_limit=50' : '';
    await page.goto(site.origin + route + query, {waitUntil: 'networkidle'});
    await page.waitForFunction(locale => document.documentElement.lang === locale, locale);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('h1').count(), 1, 'Page needs one primary heading');
    assert.equal(await page.locator('h1').isVisible(), true, 'Primary heading must be visible');
    assert.equal(site.counts().nativeReads, before.nativeReads, 'Navigation must not silently read provider data');
    await keyboardNavigation(page, width);
    if (workflow === 'snapchat') {
      await page.locator('#creative-read-native-references').click();
      await page.locator('#creative-native-reference-pages table').waitFor();
      assert.equal(site.counts().nativeReads - before.nativeReads, 6);
      assert.equal(await page.locator('#creative-native-reference-pages img').count(), 0);
      assert.ok(
        (await page.locator('#creative-native-reference-pages').innerText()).includes('Native <img onerror=bad>'),
      );
      assert.ok(
        (await page.locator('#creative-native-reference-pages').innerText()).includes(
          '14700000-0000-4000-8000-000000000002',
        ),
      );
      await page.locator('#creative-snapchat-reference-limit').fill('49');
      assert.equal(
        await page.locator('#creative-native-reference-pages table').count(),
        0,
        'Changed limit clears old proof',
      );
      await page.locator('#creative-snapchat-reference-limit').fill('50');
      await page.locator('#creative-read-native-references').click();
      await page.locator('#creative-native-reference-pages table').waitFor();
      assert.equal(site.counts().nativeReads - before.nativeReads, 12);
    } else if (workflow === 'woocommerce') {
      await page.locator('#woo-source select[name=target]').selectOption('0');
      await page.locator('#woo-source textarea[name=product_ids]').fill('101');
      await page.locator('#woo-source select[name=price_field]').selectOption('price');
      await page.locator('#woo-source button[type=submit]').click();
      await page.locator('#woo-source-result table').waitFor();
      assert.equal(site.counts().nativeReads - before.nativeReads, 4);
      assert.equal(
        await page.locator('#woo-source-result input:checked').count(),
        0,
        'Source products must be unchecked',
      );
      assert.ok((await page.locator('#woo-source-result').innerText()).includes('SKU-001'));
      assert.ok((await page.locator('#woo-source-result').innerText()).includes('Original <shoe>'));
      assert.equal(await page.locator('#woo-source-result img').count(), 0);
      await page.locator('#woo-product-101').check();
      await page.locator('#use-woo-products').click();
      assert.equal(await page.locator('#catalog-import select[name=source_mode]').inputValue(), 'woocommerce');
      await page.locator('#woo-source select[name=price_field]').selectOption('regular_price');
      assert.equal(
        (await page.locator('#catalog-woo-selection').innerText()).trim(),
        '',
        'Source changes clear product handoff',
      );
      await page.locator('#woo-source button[type=submit]').click();
      await page.locator('#woo-source-result table').waitFor();
      assert.equal(site.counts().nativeReads - before.nativeReads, 8);
      assert.equal(await page.locator('#woo-source-result input:checked').count(), 0);
    } else if (workflow === 'catalog') {
      await page.locator('#catalog-import select[name=target]').selectOption('0');
      await page.locator('#catalog-import input[name=catalog_id]').fill('555');
      await page.locator('#catalog-import select[name=allow_upsert]').selectOption('true');
      await page
        .locator('#catalog-import input[name=file]')
        .setInputFiles({name: 'synthetic-products.csv', mimeType: 'text/csv', buffer: site.csv});
      await page.locator('#catalog-import button[type=submit]').click();
      await page.locator('#compare-catalog-products').waitFor();
      assert.equal(
        site.counts().nativeReads,
        before.nativeReads,
        'CSV preview must not read or mutate provider products',
      );
      await page.locator('#compare-catalog-products').click();
      await page.locator('#catalog-comparison table').waitFor();
      assert.ok(site.counts().nativeReads > before.nativeReads);
      assert.equal(
        await page.locator('#catalog-comparison input:checked').count(),
        0,
        'Comparison selections must be unchecked',
      );
      assert.ok((await page.locator('#catalog-comparison').innerText()).includes('9007199254740993'));
    }
    await checkTables(page, result);
    const layout = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      direction: getComputedStyle(document.documentElement).direction,
    }));
    result.layout = layout;
    assert.equal(layout.direction, locale === 'ar' ? 'rtl' : 'ltr');
    assert.ok(
      layout.scrollWidth <= layout.width + 1,
      `Page requires horizontal scroll: ${layout.scrollWidth}/${layout.width}`,
    );
    assert.deepEqual(result.errors, [], 'Browser script failed');
    assert.deepEqual(result.failed_responses, [], 'Owned website returned an error response');
    assert.deepEqual(result.blocked_external_requests, [], 'Website attempted external egress');
    assert.equal(site.counts().refused, 0, 'Website attempted unqualified provider egress');
    assert.equal(site.counts().writes, 0, 'Website attempted a provider mutation');
    result.native_reads = site.counts().nativeReads - before.nativeReads;
    if (workflow || route === '/about') await page.screenshot({path: path.join(output, id + '.png'), fullPage: true});
    result.passed = true;
  } catch (error) {
    result.passed = false;
    result.failure = error.message;
    result.diagnostics = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll('body *')]
        .filter(el => {
          if (el.closest('[inert],dialog:not([open]),[hidden],.report-table-wrap,.data-scroll,.about-art'))
            return false;
          const box = el.getBoundingClientRect();
          return box.width && box.height && (box.left < -1 || box.right > document.documentElement.clientWidth + 1);
        })
        .slice(0, 15)
        .map(el => ({
          tag: el.tagName,
          id: el.id,
          class: String(el.className),
          text: el.textContent.trim().slice(0, 100),
        })),
      tables: [...document.querySelectorAll('[role=region] table')].map(el => ({
        caption: el.caption?.textContent.trim(),
        region: el.parentElement.getAttribute('aria-label'),
        id: el.parentElement.id,
      })),
    }));
    await page.screenshot({path: path.join(output, id + '-failure.png'), fullPage: true}).catch(() => {});
  } finally {
    evidence.cases.push(result);
    save();
    console.log(JSON.stringify({id, passed: result.passed, failure: result.failure}));
    await context.close();
  }
}

try {
  for (const kind of ['empty', 'snapchat', 'woocommerce', 'catalog']) {
    const site = await browserWorkflowSite(kind);
    try {
      if (kind === 'empty') {
        for (const locale of ['en', 'ar'])
          for (const width of [320, 375, 768, 1280]) await renderedCase(site, kind, '/about', locale, width, false);
        const publicRoutes = ['/', '/login', '/signup', '/privacy', '/terms', '/data-deletion'],
          workspaceRoutes = [
            '/dashboard',
            '/campaigns',
            '/reports',
            '/reporting-overview',
            '/operations',
            '/capabilities',
            '/report-library',
            '/report-pack',
            '/monitors',
            '/portfolio',
            '/measurement',
            '/schedules',
            '/profiles',
            '/connections',
            '/connectors',
            '/settings',
            '/account',
            '/activity',
          ];
        for (const route of publicRoutes)
          for (const locale of route === '/privacy' ? ['en'] : ['en', 'ar'])
            for (const width of ['/', '/privacy'].includes(route) ? [320, 375, 768, 1280] : [320, 1280])
              await renderedCase(site, kind, route, locale, width, false);
        for (const route of workspaceRoutes)
          for (const locale of ['en', 'ar'])
            for (const width of [320, 1280]) await renderedCase(site, kind, route, locale, width, true);
      } else {
        const route = kind === 'snapchat' ? '/media' : '/commerce';
        for (const locale of ['en', 'ar'])
          for (const width of [320, 375, 768, 1280]) await renderedCase(site, kind, route, locale, width, true, kind);
      }
    } finally {
      await site.close();
    }
  }
} finally {
  await browser.close();
  evidence.finished_at = new Date().toISOString();
  evidence.total = evidence.cases.length;
  evidence.passed = evidence.cases.filter(item => item.passed).length;
  evidence.failed = evidence.total - evidence.passed;
  save();
}
console.log(
  JSON.stringify({total: evidence.total, passed: evidence.passed, failed: evidence.failed, browser: evidence.browser}),
);
if (evidence.failed) process.exitCode = 1;
