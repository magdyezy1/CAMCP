import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import ExcelJS from 'exceljs';
import {browserWorkflowSite} from '../tests/fixtures/browser-workflow-sites.mjs';
import {evidenceId, retainedEvidence} from '../tests/fixtures/retained-evidence-data.mjs';
import {googleKeywordInput, googleKeywordRows} from '../tests/fixtures/google-keyword-evidence-data.mjs';
import {googleDeviceInput, googleDeviceRows} from '../tests/fixtures/google-device-evidence-data.mjs';

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
  files = [
    ...new Set(
      execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'web'], {cwd: root})
        .toString()
        .split('\0')
        .filter(Boolean),
    ),
  ].sort(),
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

async function checkProductLabels(page, selector, result) {
  const labels = await page
    .locator(selector + ' tbody th[scope=row]')
    .evaluateAll(cells => cells.map(cell => ({text: cell.textContent, width: cell.getBoundingClientRect().width})));
  assert.ok(labels.length, 'The selected product table must retain its native row labels');
  assert.ok(
    labels.every(label => label.width >= 120),
    'Product names and IDs need a readable column, not per-character wrapping',
  );
  result.product_labels ??= [];
  result.product_labels.push({selector, labels});
}

async function checkEvidenceControls(page, result) {
  const fields = ['evidence-row-query', 'evidence-rows-page-size', 'evidence-rows-page', 'evidence-download-language'],
    buttons = [
      'evidence-row-apply',
      'evidence-row-clear',
      'evidence-rows-previous',
      'evidence-rows-next',
      'evidence-download-xlsx',
    ],
    controls = await page.locator([...fields, ...buttons].map(id => '#' + id).join(',')).evaluateAll(nodes =>
      nodes.map(el => ({
        id: el.id,
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height,
        font_size: Number.parseFloat(getComputedStyle(el).fontSize),
        labels: [...(el.labels ?? [])].map(label => label.textContent.trim()),
      })),
    );
  assert.equal(controls.length, 9, 'Saved-report controls must remain available with their original identities');
  assert.ok(
    controls.every(control => control.width >= 44 && control.height >= 44),
    'Saved-report fields and action targets need usable dimensions',
  );
  assert.ok(
    controls
      .filter(control => fields.includes(control.id))
      .every(control => control.font_size >= 16 && control.labels.length === 1 && control.labels[0]),
    'Native report fields need readable type and their original accessible labels',
  );
  await page.locator('#evidence-row-query').focus();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'evidence-row-query');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'evidence-rows-page-size');
  const focus = await page.locator('#evidence-rows-page-size').evaluate(el => ({
    style: getComputedStyle(el).outlineStyle,
    width: Number.parseFloat(getComputedStyle(el).outlineWidth),
  }));
  assert.equal(focus.style, 'solid');
  assert.ok(focus.width >= 3);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'evidence-row-query');
  result.evidence_controls = controls;
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
    before = site.counts(),
    beforeEvidence =
      ['google-keyword-error', 'google-keyword-stale'].includes(workflow) ||
      workflow?.startsWith('provider-refusal-') ||
      workflow?.startsWith('measurement-')
        ? site.evidenceCounts()
        : undefined;
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
      workflow === 'snapchat'
        ? '?asset_id=asset-147&reference_view=snapchat_top_snap&reference_limit=50'
        : workflow === 'retained-evidence'
          ? '?id=' + evidenceId
          : '';
    const routeQuery = route === '/privacy' ? '?lang=' + locale : query;
    await page.goto(site.origin + route + routeQuery, {waitUntil: 'networkidle'});
    await page.waitForFunction(locale => document.documentElement.lang === locale, locale);
    await page.evaluate(() => document.fonts.ready);
    await page.locator('h1').first().waitFor({state: 'visible'});
    assert.equal(await page.locator('h1').count(), 1, 'Page needs one primary heading');
    assert.equal(await page.locator('h1').isVisible(), true, 'Primary heading must be visible');
    assert.equal(site.counts().nativeReads, before.nativeReads, 'Navigation must not silently read provider data');
    await keyboardNavigation(page, width);
    if (route === '/privacy') {
      assert.equal(
        await page.locator('link[rel=canonical]').getAttribute('href'),
        locale === 'ar' ? 'https://amcp.shop/privacy?lang=ar' : 'https://amcp.shop/privacy',
      );
      assert.equal(
        await page.locator('script').count(),
        0,
        'The complete privacy policy must not depend on JavaScript',
      );
      assert.equal(await page.locator('time').getAttribute('datetime'), '2026-09-30');
      assert.equal(await page.locator('article section').count(), 8);
      const other = locale === 'ar' ? 'en' : 'ar';
      await page.locator('.policy-languages a[hreflang=' + other + ']').click();
      assert.equal(await page.locator('html').getAttribute('lang'), other);
      await keyboardNavigation(page, width);
      await page.locator('.policy-languages a[hreflang=' + locale + ']').click();
      assert.equal(await page.locator('html').getAttribute('lang'), locale);
    }
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
      await checkProductLabels(page, '#woo-source-result table', result);
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
      assert.equal(
        await page.locator('#catalog-csv-mapping').isVisible(),
        false,
        'WooCommerce selection hides unrelated CSV layout controls',
      );
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
    } else if (workflow === 'woocommerce-variations') {
      await page.locator('#woo-source select[name=target]').selectOption('0');
      await page.locator('#woo-source select[name=source_kind]').selectOption('variations');
      await page.locator('#woo-source input[name=parent_product_id]').fill('101');
      await page.locator('#woo-source textarea[name=product_ids]').fill('102');
      await page.locator('#woo-source select[name=price_field]').selectOption('price');
      assert.equal(
        site.counts().nativeReads,
        before.nativeReads,
        'Choosing a hierarchy must not start a provider read',
      );
      await page.locator('#woo-source button[type=submit]').click();
      await page.locator('#woo-source-result table').waitFor();
      assert.equal(site.counts().nativeReads - before.nativeReads, 6);
      await checkProductLabels(page, '#woo-source-result table', result);
      assert.equal(await page.locator('#woo-source-result input:checked').count(), 0);
      const native = await page.locator('#woo-source-result').innerText();
      for (const value of ['GROUP-001', 'VAR-001', 'Original <shoe>', 'Color: Red', '0012.34 SAR'])
        assert.ok(native.includes(value), value);
      assert.equal(await page.locator('#woo-source-result img').count(), 0);
      await page.locator('#woo-title-102').fill('My reviewed <shoe> — red, small');
      assert.equal(
        await page.locator('#woo-product-102').isChecked(),
        false,
        'A title edit must not select a variation',
      );
      await page.locator('#woo-product-102').check();
      await page.locator('#use-woo-products').click();
      assert.equal(await page.locator('#catalog-csv-mapping').isVisible(), false);
      await page.locator('#catalog-import select[name=target]').selectOption('0');
      await page.locator('#catalog-import input[name=catalog_id]').fill('555');
      await page.locator('#catalog-import button[type=submit]').click();
      await page.locator('#catalog-preview table').waitFor();
      const preview = await page.locator('#catalog-preview table').innerText();
      for (const value of ['My reviewed <shoe> — red, small', 'VAR-001', 'GROUP-001', '0012.34 SAR', '1234'])
        assert.ok(preview.includes(value), value);
      assert.equal(
        site.counts().nativeReads - before.nativeReads,
        6,
        'Exact local destination preview must not read or write providers',
      );
      await checkProductLabels(page, '#catalog-preview table', result);
      await page.screenshot({path: path.join(output, id + '-reviewed.png'), fullPage: true});
      await page.locator('#woo-title-102').fill('A different reviewed title');
      assert.equal(await page.locator('#woo-product-102').isChecked(), false);
      assert.equal(
        await page.locator('#catalog-preview table').count(),
        0,
        'Title edits invalidate the previous destination preview',
      );
      assert.equal((await page.locator('#catalog-woo-selection').innerText()).trim(), '');
      await page.locator('#woo-source input[name=parent_product_id]').fill('103');
      assert.equal(
        await page.locator('#woo-source-result table').count(),
        0,
        'Parent edits invalidate the native hierarchy',
      );
      await page.locator('#woo-source input[name=parent_product_id]').fill('101');
      await page.locator('#woo-source button[type=submit]').click();
      await page.locator('#woo-source-result table').waitFor();
      assert.equal(site.counts().nativeReads - before.nativeReads, 12);
      assert.equal(await page.locator('#woo-source-result input:checked').count(), 0);
    } else if (workflow === 'google-device') {
      const capture = page.locator('#report-capture');
      await capture.waitFor();
      if (!(await capture.evaluate(el => el.open))) await capture.locator('summary').click();
      const form = page.locator('#capture-preset');
      await form.locator('[name=preset]').selectOption('google_campaign_device');
      await form.locator('[name=target]').selectOption('0');
      assert.equal(await page.locator('#capture-google-device-measurement').isVisible(), true);
      assert.equal(await page.locator('#capture-google-keyword-measurement').isVisible(), false);
      assert.equal(await form.locator('[name=conversion_definition]').inputValue(), 'metrics.conversions');
      assert.equal(await form.locator('[name=conversion_definition]').getAttribute('readonly'), '');
      for (const key of ['source_name', 'date_from', 'date_to', 'currency', 'timezone', 'attribution'])
        await form.locator(`[name=${key}]`).fill(googleDeviceInput.semantics[key]);
      await form.locator('[name=complete]').check();
      await form.locator('[name=attribution]').fill('Synthetic declared device attribution');
      assert.equal(await form.locator('[name=complete]').isChecked(), false);
      await form.locator('[name=complete]').check();
      assert.equal(site.counts().nativeReads, before.nativeReads, 'Device form choices make no native read');
      await form.locator('button[type=submit]').click();
      await page.waitForFunction(() => document.querySelectorAll('#report-native-rows tbody tr').length === 8);
      assert.equal(site.counts().nativeReads - before.nativeReads, 4);
      const rows = page.locator('#report-native-rows tbody tr'),
        original = googleDeviceRows();
      for (let i = 0; i < original.length; i++) {
        assert.equal((await rows.nth(i).locator('th[scope=row]').innerText()).trim(), original[i].campaign.name);
        assert.equal((await rows.nth(i).locator('td').nth(0).innerText()).trim(), original[i].segments.device);
        assert.equal((await rows.nth(i).locator('td').nth(1).innerText()).trim(), original[i].segments.date);
        assert.equal((await rows.nth(i).locator('td').nth(2).innerText()).trim(), original[i].campaign.resourceName);
        assert.equal(await rows.nth(i).locator('td').nth(0).getAttribute('dir'), 'ltr');
        assert.equal(await rows.nth(i).locator('td').nth(2).getAttribute('dir'), 'ltr');
      }
      assert.equal(await rows.locator('img').count(), 0, 'Campaign text stays escaped');
      assert.equal(await page.locator('#search-exclusion-candidates').count(), 0);
      await checkEvidenceControls(page, result);
      await checkProductLabels(page, '#report-native-rows table', result);
      await checkTables(page, result);
      await page.locator('#report-native-rows').screenshot({path: path.join(output, id + '-complete.png')});
      const metrics = await page.locator('.workspace-metrics').innerText();
      assert.ok(metrics.includes('9007199257.740993'));
      await page.locator('#evidence-row-query').fill('CONNECTED_TV');
      await page.locator('#evidence-row-apply').click();
      await page.waitForFunction(() => document.querySelectorAll('#report-native-rows tbody tr').length === 1);
      assert.equal((await rows.first().locator('td').nth(0).innerText()).trim(), 'CONNECTED_TV');
      assert.equal(await page.locator('.workspace-metrics').innerText(), metrics);
      await page.locator('#evidence-download-language').selectOption(locale);
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#evidence-download-xlsx').click(),
      ]);
      const workbookPath = path.join(output, id + '.xlsx');
      await download.saveAs(workbookPath);
      const bytes = fs.readFileSync(workbookPath),
        book = new ExcelJS.Workbook();
      await book.xlsx.load(bytes);
      const sheet = book.worksheets[1];
      assert.equal(sheet.rowCount, 9, 'Device filtering still downloads every original row');
      assert.equal(sheet.columnCount, 12);
      assert.equal(sheet.getCell('L1').value, 'native_device');
      assert.equal(Boolean(sheet.views[0].rightToLeft), locale === 'ar');
      for (let i = 0; i < original.length; i++) {
        assert.equal(sheet.getCell(i + 2, 1).value, original[i].campaign.resourceName);
        assert.equal(sheet.getCell(i + 2, 2).value, original[i].campaign.name);
        assert.equal(sheet.getCell(i + 2, 12).value, original[i].segments.device);
      }
      assert.equal(sheet.getCell('E2').value, '9007199254.740993');
      assert.equal(sheet.getCell('H3').value, '0');
      assert.equal(sheet.getCell('H4').value, null);
      assert.ok(book.worksheets[2].getColumn(2).values.includes('9007199257.740993'));
      result.device_report = {
        original_rows: 8,
        filtered_rows: 1,
        workbook_rows: 8,
        workbook_bytes: bytes.length,
        workbook_language: locale,
        native_devices: [...new Set(original.map(row => row.segments.device))],
      };
      await checkTables(page, result);
      await page.locator('#report-native-rows').screenshot({path: path.join(output, id + '-filtered.png')});
      assert.equal(
        site.counts().nativeReads - before.nativeReads,
        4,
        'Retained device search/export adds no native read',
      );
    } else if (workflow?.startsWith('provider-refusal-')) {
      const {provider, input, message} = site.captureRefusal;
      const catalog = JSON.parse(fs.readFileSync(path.join(root, 'web/locales/ar.json'), 'utf8'));
      const capture = page.locator('#report-capture');
      await capture.waitFor();
      if (!(await capture.evaluate(el => el.open))) await capture.locator('summary').click();
      const form = page.locator('#capture-preset');
      await form.locator('[name=preset]').selectOption(input.preset);
      await form.locator('[name=target]').selectOption('0');
      for (const key of ['source_name', 'date_from', 'date_to', 'currency', 'timezone']) {
        const field = form.locator('[name=' + key + ']');
        if (await field.isEditable()) await field.fill(input.semantics[key]);
        else assert.equal(await field.inputValue(), input.semantics[key]);
      }
      if (['linkedin', 'tiktok'].includes(provider))
        await form.locator('[name=attribution]').fill(input.semantics.attribution);
      if (provider === 'meta') {
        await form.locator('[name=result_action_type]').fill(input.result_action_type);
        await form.locator('[name=attribution_windows]').selectOption(input.attribution_windows.join(','));
      }
      if (provider === 'snapchat') {
        await form.locator('[name=swipe_up_attribution_window]').selectOption(input.swipe_up_attribution_window);
        await form.locator('[name=view_attribution_window]').selectOption(input.view_attribution_window);
      }
      await form.locator('[name=complete]').check();
      const snapshot = () =>
        form.evaluate(el =>
          Object.fromEntries(
            [...el.elements].filter(f => f.name).map(f => [f.name, f.type === 'checkbox' ? f.checked : f.value]),
          ),
        );
      const original = await snapshot();
      assert.equal(site.counts().nativeReads, before.nativeReads, 'Capture choices perform no provider read');
      const failedCapture = page.waitForResponse(
        response =>
          new URL(response.url()).pathname === '/api/workspace/reporting' &&
          response.request().postDataJSON()?.action === 'capture_preset',
      );
      await form.locator('button[type=submit]').click();
      const response = await failedCapture,
        body = await response.json(),
        wire = response.request().postDataJSON();
      assert.equal(body.success, false);
      assert.equal(body.error.code, 'REPORT_ACCOUNT_MISMATCH');
      assert.equal(body.error.message, message, 'The original native envelope stays in English');
      assert.equal(body.error.remedy.mutation_retry_safe, false);
      assert.equal(wire.connection_id, input.connection_id);
      assert.equal(wire.account_id, input.account_id);
      assert.equal(wire.preset, input.preset);
      for (const key of ['currency', 'timezone', 'date_from', 'date_to'])
        assert.equal(wire.semantics[key], input.semantics[key]);
      if (provider === 'meta') assert.deepEqual(wire.attribution_windows, input.attribution_windows);
      if (provider === 'snapchat') {
        assert.equal(wire.swipe_up_attribution_window, input.swipe_up_attribution_window);
        assert.equal(wire.view_attribution_window, input.view_attribution_window);
      }
      await page.waitForFunction(() => !document.querySelector('#capture-preset button[type=submit]').disabled);
      const feedback = page.locator('#capture-feedback');
      assert.equal(await feedback.isVisible(), true);
      assert.equal(await feedback.getAttribute('role'), 'alert');
      assert.equal(await feedback.getAttribute('aria-atomic'), 'true');
      assert.equal(
        await feedback.locator('strong').innerText(),
        locale === 'ar' ? catalog['Capture needs attention'] : 'Capture needs attention',
      );
      const display = await page.locator('#capture-feedback-message').innerText();
      assert.ok(display.includes(locale === 'ar' ? catalog[message] : message));
      assert.ok(display.includes(locale === 'ar' ? catalog[body.error.next_action] : body.error.next_action));
      assert.ok(display.includes(body.meta.requestId));
      assert.equal(await page.evaluate(() => document.activeElement.id), 'capture-preset-submit');
      for (const node of [form, form.locator('button[type=submit]')])
        assert.ok((await node.getAttribute('aria-describedby')).split(/\s+/).includes('capture-feedback'));
      assert.equal(await page.locator('#toast').isVisible(), false);
      assert.deepEqual(await snapshot(), original);
      await page.waitForTimeout(6600);
      assert.equal(await feedback.isVisible(), true);
      assert.equal(await page.locator('#capture-feedback-message').innerText(), display);
      assert.equal(site.counts().nativeReads - before.nativeReads, 1);
      assert.deepEqual(site.evidenceCounts(), beforeEvidence);
      await feedback.screenshot({path: path.join(output, id + '-diagnostic.png')});
      await form.locator('[name=source_name]').fill(input.semantics.source_name + ' corrected');
      assert.equal(await feedback.isVisible(), false);
      assert.equal(await form.locator('[name=complete]').isChecked(), false);
      for (const node of [form, form.locator('button[type=submit]')])
        assert.equal(
          ((await node.getAttribute('aria-describedby')) ?? '').split(/\s+/).includes('capture-feedback'),
          false,
        );
      assert.equal(site.counts().nativeReads - before.nativeReads, 1, 'Editing feedback never retries automatically');
      assert.deepEqual(site.evidenceCounts(), beforeEvidence);
      result.provider_refusal = {
        provider,
        code: body.error.code,
        original_message: body.error.message,
        display_language: locale,
        request_reference_preserved: true,
        authored_refusal_and_hint: true,
        persistent_after_ms: 6600,
        form_and_submit_described: true,
        original_submit_focus: true,
        original_settings_preserved: true,
        cleared_on_edit: true,
        failed_native_reads: 1,
        saved_reports: 0,
        automatic_retries: 0,
        duplicate_toasts: 0,
      };
    } else if (['google-keyword', 'google-keyword-error', 'google-keyword-stale'].includes(workflow)) {
      const recovery = workflow === 'google-keyword-error',
        stale = workflow === 'google-keyword-stale';
      const capture = page.locator('#report-capture');
      await capture.waitFor();
      if (!(await capture.evaluate(el => el.open))) await capture.locator('summary').click();
      const form = page.locator('#capture-preset');
      await form.locator('[name=preset]').selectOption('google_keyword');
      await form.locator('[name=target]').selectOption('0');
      assert.equal(await page.locator('#capture-google-keyword-measurement').isVisible(), true);
      assert.equal(await form.locator('[name=conversion_definition]').inputValue(), 'metrics.conversions');
      assert.equal(await form.locator('[name=conversion_definition]').getAttribute('readonly'), '');
      for (const key of ['source_name', 'date_from', 'date_to', 'currency', 'timezone', 'attribution'])
        await form.locator(`[name=${key}]`).fill(googleKeywordInput.semantics[key]);
      await form.locator('[name=complete]').check();
      await form.locator('[name=attribution]').fill('Synthetic declared keyword attribution');
      assert.equal(
        await form.locator('[name=complete]').isChecked(),
        false,
        'Editing measurement revokes the completeness declaration',
      );
      await form.locator('[name=complete]').check();
      assert.equal(site.counts().nativeReads, before.nativeReads, 'Keyword form choices must not read the provider');
      if (stale) {
        const pattern = site.origin + '/api/workspace/reporting';
        let releaseResponse, signalReady, readyTimer;
        const held = new Promise(resolve => {
            releaseResponse = resolve;
          }),
          ready = new Promise((resolve, reject) => {
            readyTimer = setTimeout(() => reject(Error('The owned capture response was not ready')), 15000);
            signalReady = result => {
              clearTimeout(readyTimer);
              resolve(result);
            };
          });
        await page.route(pattern, async intercepted => {
          if (intercepted.request().postDataJSON()?.action !== 'capture_preset') return intercepted.continue();
          const response = await intercepted.fetch();
          signalReady(await response.json());
          await held;
          await intercepted.fulfill({response});
        });
        try {
          await form.locator('button[type=submit]').click();
          const failed = await ready;
          assert.equal(failed.success, false);
          assert.equal(failed.error.code, 'REPORT_SHAPE_CHANGED');
          assert.equal(site.counts().nativeReads - before.nativeReads, 3);
          await form.locator('[name=attribution]').fill('Changed while the previous capture was pending');
          assert.equal(await form.locator('[name=complete]').isChecked(), false);
          releaseResponse();
          await page.waitForFunction(() => !document.querySelector('#capture-preset button[type=submit]').disabled);
          assert.equal(await page.locator('#capture-feedback').isVisible(), false);
          assert.equal(await page.locator('#capture-feedback-message').textContent(), '');
          assert.equal(await page.locator('#toast').isVisible(), false);
          assert.equal(await page.locator('#report-native-rows tbody tr').count(), 0);
          assert.equal(site.evidenceCounts().reports, beforeEvidence.reports);
          assert.equal(site.evidenceCounts().plans, beforeEvidence.plans);
          assert.equal(site.evidenceCounts().reviews, beforeEvidence.reviews);
          assert.equal(site.counts().nativeReads - before.nativeReads, 3);
          result.capture_stale = {
            delayed_original_failure: true,
            changed_measurement_preserved: true,
            obsolete_error_silent: true,
            failed_native_reads: 3,
            saved_reports: 0,
            automatic_retries: 0,
          };
          await form.locator('[name=complete]').check();
        } finally {
          clearTimeout(readyTimer);
          releaseResponse();
          await page.unroute(pattern);
        }
      }
      if (recovery) {
        const failedCapture = page.waitForResponse(
          response =>
            new URL(response.url()).pathname === '/api/workspace/reporting' &&
            response.request().postDataJSON()?.action === 'capture_preset',
        );
        await form.locator('button[type=submit]').click();
        const failed = await (await failedCapture).json(),
          ownedMessage = 'Google did not return a bounded positive Search keyword with its native match type.',
          reference = failed.meta?.requestId ?? failed.meta?.request_id ?? failed.request_id,
          displayed =
            locale === 'ar'
              ? JSON.parse(fs.readFileSync(path.join(root, 'web/locales/ar.json'), 'utf8'))[ownedMessage]
              : ownedMessage;
        assert.equal(failed.success, false);
        assert.equal(failed.error.code, 'REPORT_SHAPE_CHANGED');
        assert.equal(failed.error.message, ownedMessage, 'The original API diagnostic stays exact');
        assert.ok(reference, 'A failed capture must retain its request reference');
        const hint =
          locale === 'ar'
            ? JSON.parse(fs.readFileSync(path.join(root, 'web/locales/ar.json'), 'utf8'))[failed.error.next_action]
            : failed.error.next_action;
        assert.ok(hint, 'The selected recovery hint must have authored display copy');
        await page.waitForFunction(
          message =>
            !document.querySelector('#capture-feedback').hidden &&
            document.querySelector('#capture-feedback-message').textContent.includes(message),
          displayed,
        );
        const feedback = page.locator('#capture-feedback');
        assert.equal(await feedback.getAttribute('role'), 'alert');
        assert.equal(await feedback.getAttribute('aria-atomic'), 'true');
        assert.ok((await feedback.innerText()).includes(reference));
        assert.ok((await feedback.innerText()).includes(hint));
        assert.ok((await form.getAttribute('aria-describedby')).split(/\s+/).includes('capture-feedback'));
        assert.ok(
          (await form.locator('button[type=submit]').getAttribute('aria-describedby'))
            .split(/\s+/)
            .includes('capture-feedback'),
        );
        assert.equal(await page.locator('#toast').isVisible(), false, 'The same capture failure is not toasted twice');
        if (locale === 'ar') assert.equal((await feedback.innerText()).includes(failed.error.next_action), false);
        await page.waitForFunction(() => !document.querySelector('#capture-preset button[type=submit]').disabled);
        assert.equal(
          await form.locator('button[type=submit]').evaluate(button => document.activeElement === button),
          true,
          'A stable submit identity returns focus through the existing workspace binding',
        );
        const originalFeedback = await feedback.innerText();
        await page.waitForTimeout(6600);
        assert.equal(await feedback.isVisible(), true, 'Current failure remains after the original six-second toast');
        assert.equal(await feedback.innerText(), originalFeedback);
        assert.equal(
          site.counts().nativeReads - before.nativeReads,
          3,
          'Failed capture stops before final account read',
        );
        assert.equal(site.evidenceCounts().reports, beforeEvidence.reports, 'Failed native evidence must not be saved');
        assert.equal(site.evidenceCounts().plans, beforeEvidence.plans);
        assert.equal(site.evidenceCounts().reviews, beforeEvidence.reviews);
        assert.equal(await page.locator('#report-native-rows tbody tr').count(), 0);
        assert.equal(await form.locator('[name=preset]').inputValue(), 'google_keyword');
        assert.equal(await form.locator('[name=target]').inputValue(), '0');
        assert.equal(await form.locator('[name=complete]').isChecked(), true);
        for (const key of ['source_name', 'date_from', 'date_to', 'currency', 'timezone'])
          assert.equal(await form.locator(`[name=${key}]`).inputValue(), googleKeywordInput.semantics[key]);
        assert.equal(await form.locator('[name=attribution]').inputValue(), 'Synthetic declared keyword attribution');
        await feedback.screenshot({path: path.join(output, id + '-diagnostic.png')});
        assert.equal(site.counts().nativeReads - before.nativeReads, 3, 'No automatic retry follows the failure');
        result.capture_failure = {
          code: failed.error.code,
          original_message: failed.error.message,
          display_language: locale,
          request_reference_preserved: true,
          authored_recovery_hint: true,
          failed_native_reads: 3,
          saved_reports: 0,
          retained_form_scope: true,
          automatic_retries: 0,
          persistent_after_ms: 6600,
          form_and_submit_described: true,
          duplicate_toasts: 0,
        };
        await form.locator('[name=attribution]').fill('Explicitly corrected keyword attribution');
        assert.equal(await feedback.isVisible(), false);
        assert.equal(await page.locator('#capture-feedback-message').textContent(), '');
        assert.equal(await form.locator('[name=complete]').isChecked(), false);
        assert.equal((await form.getAttribute('aria-describedby')) ?? '', '');
        await form.locator('[name=complete]').check();
      }
      await form.locator('button[type=submit]').click();
      await page.waitForFunction(() => document.querySelectorAll('#report-native-rows tbody tr').length === 4);
      assert.equal(
        site.counts().nativeReads - before.nativeReads,
        recovery || stale ? 7 : 4,
        'An explicit successful capture uses two account reads and two native pages',
      );
      if (recovery || stale) {
        assert.equal(
          site.evidenceCounts().reports,
          beforeEvidence.reports + 1,
          'Only the successful explicit retry is retained',
        );
        assert.equal(site.evidenceCounts().plans, beforeEvidence.plans);
        assert.equal(site.evidenceCounts().reviews, beforeEvidence.reviews);
      }
      const rows = page.locator('#report-native-rows tbody tr'),
        original = googleKeywordRows();
      for (let i = 0; i < original.length; i++) {
        assert.equal(
          (await rows.nth(i).locator('th[scope=row]').innerText()).trim(),
          original[i].adGroupCriterion.keyword.text,
        );
        assert.equal(
          (await rows.nth(i).locator('td').nth(0).innerText()).trim(),
          original[i].adGroupCriterion.keyword.matchType,
        );
        assert.equal((await rows.nth(i).locator('td').nth(2).innerText()).trim(), original[i].keywordView.resourceName);
        assert.equal(await rows.nth(i).locator('td').nth(0).getAttribute('dir'), 'ltr');
        assert.equal(await rows.nth(i).locator('td').nth(2).getAttribute('dir'), 'ltr');
      }
      assert.equal(await rows.locator('img').count(), 0, 'Keyword text must remain literal escaped content');
      assert.equal(await page.locator('#search-exclusion-candidates').count(), 0);
      await checkEvidenceControls(page, result);
      await checkProductLabels(page, '#report-native-rows table', result);
      await checkTables(page, result);
      await page.locator('#report-native-rows').screenshot({path: path.join(output, id + '-complete.png')});
      const metrics = await page.locator('.workspace-metrics').innerText();
      assert.ok(metrics.includes('9007199257.740993'));
      await page.locator('#evidence-row-query').fill('PHRASE');
      await page.locator('#evidence-row-apply').click();
      await page.waitForFunction(() => document.querySelectorAll('#report-native-rows tbody tr').length === 1);
      assert.equal(
        (await rows.first().locator('th[scope=row]').innerText()).trim(),
        original[1].adGroupCriterion.keyword.text,
      );
      assert.equal(await page.locator('.workspace-metrics').innerText(), metrics);
      await page.locator('#evidence-download-language').selectOption(locale);
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#evidence-download-xlsx').click(),
      ]);
      const workbookPath = path.join(output, id + '.xlsx');
      await download.saveAs(workbookPath);
      const bytes = fs.readFileSync(workbookPath),
        book = new ExcelJS.Workbook();
      await book.xlsx.load(bytes);
      const sheet = book.worksheets[1];
      assert.equal(sheet.rowCount, 5, 'Filtering native match type must still download every keyword/day row');
      assert.equal(sheet.columnCount, 12);
      assert.equal(sheet.getCell('L1').value, 'keyword_match_type');
      assert.equal(Boolean(sheet.views[0].rightToLeft), locale === 'ar');
      for (let i = 0; i < original.length; i++) {
        assert.equal(sheet.getCell(i + 2, 1).value, original[i].keywordView.resourceName);
        assert.equal(sheet.getCell(i + 2, 2).value, original[i].adGroupCriterion.keyword.text);
        assert.equal(sheet.getCell(i + 2, 12).value, original[i].adGroupCriterion.keyword.matchType);
      }
      assert.equal(sheet.getCell('E2').value, '9007199254.740993');
      assert.equal(sheet.getCell('H3').value, '0');
      assert.equal(sheet.getCell('H4').value, null);
      assert.ok(book.worksheets[2].getColumn(2).values.includes('9007199257.740993'));
      result.keyword_report = {
        original_rows: 4,
        filtered_rows: 1,
        workbook_rows: 4,
        workbook_bytes: bytes.length,
        workbook_language: locale,
        native_match_types: ['EXACT', 'PHRASE', 'BROAD'],
      };
      await checkTables(page, result);
      await page.locator('#report-native-rows').screenshot({path: path.join(output, id + '-filtered.png')});
      assert.equal(
        site.counts().nativeReads - before.nativeReads,
        recovery || stale ? 7 : 4,
        'Retained filtering and downloads add no provider read',
      );
    } else if (workflow === 'retained-evidence') {
      const rows = page.locator('#report-native-rows tbody tr'),
        original = retainedEvidence();
      await rows.first().waitFor();
      assert.equal(await rows.count(), 50);
      const nativeLines = await page.locator('#report-native-rows tbody [dir=ltr]').evaluateAll(cells =>
        cells.map(cell => {
          const range = document.createRange();
          range.selectNodeContents(cell);
          return {value: cell.textContent, lines: range.getClientRects().length};
        }),
      );
      assert.ok(
        nativeLines.every(cell => cell.lines === 1),
        'Exact native IDs, dates and numeric text must remain on one line',
      );
      result.native_values_checked = nativeLines.length;
      assert.equal(await page.locator('#evidence-rows-page-size').inputValue(), '50');
      assert.equal((await rows.first().locator('th[scope=row]').innerText()).trim(), original.rows[0].entity_id);
      assert.equal(await rows.locator('img').count(), 0, 'Source names remain literal escaped text');
      await checkEvidenceControls(page, result);
      await page.locator('#evidence-rows-page-size').selectOption('25');
      await page.waitForFunction(() => document.querySelectorAll('#report-native-rows tbody tr').length === 25);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'evidence-rows-status');
      await page.locator('#evidence-rows-next').click();
      await page.waitForFunction(
        id => document.querySelector('#report-native-rows tbody th')?.textContent.trim() === id,
        original.rows[25].entity_id,
      );
      await page.locator('#evidence-rows-page').selectOption('7');
      await page.waitForFunction(
        id => document.querySelector('#report-native-rows tbody th')?.textContent.trim() === id,
        original.rows[150].entity_id,
      );
      assert.equal(await rows.count(), 1);
      assert.equal(await page.locator('#evidence-rows-next').isDisabled(), true);
      const search = async query => {
        await page.locator('#evidence-row-query').fill(query);
        await page.locator('#evidence-row-apply').click();
        await page.waitForFunction(
          () => document.querySelector('#report-native-rows')?.getAttribute('aria-busy') === 'false',
        );
      };
      await search('Home <img> 100');
      assert.equal(await rows.count(), 1);
      assert.equal((await rows.first().locator('th[scope=row]').innerText()).trim(), original.rows[100].entity_id);
      assert.ok((await page.locator('#report-native-rows').innerText()).includes(original.rows[100].spend));
      const metrics = await page.locator('.workspace-metrics').innerText();
      assert.ok(metrics.includes(original.totals.spend));
      const language = page.locator('#evidence-download-language');
      await language.selectOption(locale);
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#evidence-download-xlsx').click(),
      ]);
      const workbookPath = path.join(output, id + '.xlsx');
      await download.saveAs(workbookPath);
      const bytes = fs.readFileSync(workbookPath),
        book = new ExcelJS.Workbook();
      await book.xlsx.load(bytes);
      const sheet = book.worksheets[1];
      assert.equal(sheet.rowCount, 152, 'Filtered browsing must still download every retained row');
      assert.equal(Boolean(sheet.views[0].rightToLeft), locale === 'ar');
      assert.equal(sheet.getCell('A1').value, 'entity_id');
      original.rows.forEach((row, i) => {
        assert.equal(sheet.getCell(i + 2, 1).value, row.entity_id);
        assert.equal(sheet.getCell(i + 2, 2).value, row.entity_name);
        assert.equal(sheet.getCell(i + 2, 5).value, row.spend);
        assert.equal(sheet.getCell(i + 2, 5).type, ExcelJS.ValueType.String);
        assert.equal(sheet.getCell(i + 2, 7).value, '0');
        assert.equal(sheet.getCell(i + 2, 8).value, null);
      });
      assert.ok(book.worksheets[2].getColumn(2).values.includes(original.totals.spend));
      result.retained_report = {
        original_rows: 151,
        filtered_rows: 1,
        workbook_rows: 151,
        workbook_bytes: bytes.length,
        workbook_language: locale,
      };
      await page.locator('#evidence-columns summary').click();
      await page.locator('#evidence-column-entity_id').uncheck();
      assert.equal((await rows.first().locator('th[scope=row]').innerText()).trim(), original.rows[100].entity_name);
      await page.locator('#evidence-column-entity_name').uncheck();
      assert.equal(await rows.locator('th[scope=row]').count(), 0, 'A numeric metric is not a row identity');
      await page.locator('#evidence-columns-reset').click();
      await checkProductLabels(page, '#report-native-rows table', result);
      await checkTables(page, result);
      await page.locator('#report-native-rows').screenshot({path: path.join(output, id + '-filtered.png')});
      await search('NO-MATCH-SYNTHETIC-ROW');
      assert.equal(await rows.count(), 0);
      assert.equal(await page.locator('#evidence-rows-next').isDisabled(), true);
      await page.locator('#evidence-row-clear').click();
      await page.waitForFunction(() => document.querySelectorAll('#report-native-rows tbody tr').length === 25);
      assert.equal(await page.locator('#evidence-rows-page-size').inputValue(), '25');
      assert.equal(await page.locator('.workspace-metrics').innerText(), metrics);
      assert.equal(site.counts().nativeReads, before.nativeReads, 'Retained views/downloads make no provider read');
    } else if (workflow?.startsWith('measurement-') && workflow !== 'measurement-events') {
      const {kind: measurementKind, input, message, code} = site.measurementReadRefusal,
        stale = workflow.endsWith('-stale'),
        permission = workflow.endsWith('-permission'),
        formId = measurementKind === 'events' ? 'measurement-events' : 'measurement-event-identity',
        resultId = formId + '-result',
        feedbackId = formId + '-feedback',
        form = page.locator('#' + formId),
        submit = form.locator('button[type=submit]'),
        feedback = page.locator('#' + feedbackId),
        catalog = JSON.parse(fs.readFileSync(path.join(root, 'web/locales/ar.json'), 'utf8'));
      await form.locator('[name=target]').selectOption('0');
      for (const [key, value] of Object.entries(input.requirements))
        await form.locator('[name=' + key + ']').fill(Array.isArray(value) ? value.join(', ') : String(value));
      const snapshot = () =>
          form.evaluate(el => Object.fromEntries([...el.elements].filter(f => f.name).map(f => [f.name, f.value]))),
        original = await snapshot(),
        editName = measurementKind === 'events' ? 'minutes' : 'expected_count',
        changedValue = measurementKind === 'events' ? '4' : '2',
        pattern = site.origin + '/api/workspace/workspace';
      assert.equal(
        site.counts().nativeReads,
        before.nativeReads,
        'Selecting the measurement scope does not read the provider',
      );
      const assertRefusal = body => {
        assert.equal(body.success, false);
        assert.equal(body.error.code, code);
        assert.equal(body.error.message, message, 'The original native envelope remains in English');
        assert.equal(body.error.remedy.mutation_retry_safe, false);
        assert.ok(body.meta.requestId);
      };
      if (stale) {
        let releaseResponse, signalReady, readyTimer;
        const held = new Promise(resolve => (releaseResponse = resolve)),
          ready = new Promise((resolve, reject) => {
            readyTimer = setTimeout(() => reject(Error('The owned measurement response was not ready')), 15000);
            signalReady = body => {
              clearTimeout(readyTimer);
              resolve(body);
            };
          });
        await page.route(pattern, async intercepted => {
          if (intercepted.request().postDataJSON()?.action !== input.action) return intercepted.continue();
          assert.deepEqual(intercepted.request().postDataJSON(), input);
          const response = await intercepted.fetch();
          signalReady(await response.json());
          await held;
          await intercepted.fulfill({response});
        });
        try {
          await submit.click();
          const failed = await ready;
          assertRefusal(failed);
          assert.equal(site.counts().nativeReads - before.nativeReads, 1);
          await form.locator('[name=' + editName + ']').fill(changedValue);
          releaseResponse();
          await page.waitForFunction(id => !document.querySelector('#' + id + ' button[type=submit]').disabled, formId);
          assert.equal(await feedback.isVisible(), false);
          assert.equal(await page.locator('#' + feedbackId + '-message').innerText(), '');
          assert.equal(await page.locator('#' + resultId + ' table').count(), 0);
          assert.equal(await page.locator('#toast').isVisible(), false);
          assert.equal(await form.locator('[name=' + editName + ']').inputValue(), changedValue);
          assert.equal(site.counts().nativeReads - before.nativeReads, 1);
          assert.deepEqual(site.evidenceCounts(), beforeEvidence);
          result.measurement_stale = {
            kind: measurementKind,
            delayed_original_failure: true,
            changed_scope_preserved: true,
            obsolete_error_silent: true,
            failed_native_reads: 1,
            saved_reports: 0,
            automatic_retries: 0,
          };
        } finally {
          clearTimeout(readyTimer);
          releaseResponse();
          await page.unroute(pattern);
        }
      } else {
        const failedRead = page.waitForResponse(
          response =>
            new URL(response.url()).pathname === '/api/workspace/workspace' &&
            response.request().postDataJSON()?.action === input.action,
        );
        await submit.click();
        const failedResponse = await failedRead,
          failed = await failedResponse.json();
        assert.deepEqual(failedResponse.request().postDataJSON(), input);
        assertRefusal(failed);
        await page.waitForFunction(id => !document.querySelector('#' + id + ' button[type=submit]').disabled, formId);
        assert.equal(await feedback.isVisible(), true);
        assert.equal(await feedback.getAttribute('role'), 'alert');
        assert.equal(await feedback.getAttribute('aria-atomic'), 'true');
        assert.equal(
          await feedback.locator('strong').innerText(),
          locale === 'ar' ? catalog['Read needs attention'] : 'Read needs attention',
        );
        const display = await page.locator('#' + feedbackId + '-message').innerText();
        assert.ok(display.includes(locale === 'ar' && !permission ? catalog[message] : message));
        assert.ok(display.includes(locale === 'ar' ? catalog[failed.error.next_action] : failed.error.next_action));
        assert.ok(display.includes(failed.meta.requestId));
        assert.equal(await page.evaluate(() => document.activeElement.id), formId + '-submit');
        for (const control of [form, submit])
          assert.ok((await control.getAttribute('aria-describedby')).split(/\s+/).includes(feedbackId));
        assert.equal(await page.locator('#toast').isVisible(), false);
        assert.deepEqual(await snapshot(), original);
        await page.waitForTimeout(6600);
        assert.equal(await feedback.isVisible(), true);
        assert.equal(await page.locator('#' + feedbackId + '-message').innerText(), display);
        assert.equal(site.counts().nativeReads - before.nativeReads, 1);
        assert.deepEqual(site.evidenceCounts(), beforeEvidence);
        await feedback.screenshot({path: path.join(output, id + '-diagnostic.png')});
        await form.locator('[name=' + editName + ']').fill(changedValue);
        assert.equal(await feedback.isVisible(), false);
        for (const control of [form, submit])
          assert.equal(
            ((await control.getAttribute('aria-describedby')) ?? '').split(/\s+/).includes(feedbackId),
            false,
          );
        assert.equal(site.counts().nativeReads - before.nativeReads, 1, 'Editing never retries automatically');
        await form.locator('[name=' + editName + ']').fill(original[editName]);
        assert.deepEqual(await snapshot(), original);
        const recoveredRead = page.waitForResponse(
          response =>
            new URL(response.url()).pathname === '/api/workspace/workspace' &&
            response.request().postDataJSON()?.action === input.action,
        );
        await submit.click();
        const recoveredResponse = await recoveredRead,
          recovered = await recoveredResponse.json();
        assert.deepEqual(recoveredResponse.request().postDataJSON(), input);
        assert.equal(recovered.success, true, JSON.stringify(recovered));
        const out = recovered.data;
        assert.equal(out.scope.property_id, '123');
        assert.equal(out.scope.stream_id, '900');
        assert.equal(out.provider_mutations, 0);
        assert.equal(out.retained_snapshot, false);
        for (const check of ['deduplication', 'consent', 'attribution']) assert.equal(out.checks[check], 'unverified');
        await page
          .locator('#' + resultId + ' table')
          .first()
          .waitFor();
        const html = await page.locator('#' + resultId).innerText();
        if (measurementKind === 'events') {
          assert.equal(out.events[0].reported_count, '9007199254740995');
          assert.equal(out.events[1].reported_count, null);
          assert.ok(html.includes('9007199254740995'));
          assert.ok(html.includes(locale === 'ar' ? catalog['No count returned'] : 'No count returned'));
          assert.deepEqual(
            out.rows.map(row => row.minutes_ago),
            [0, 1],
          );
          assert.equal(out.checks.test_event_identity, 'unverified');
          await page
            .locator('#' + resultId + ' details')
            .first()
            .locator('summary')
            .click();
        } else {
          assert.equal(out.observation.reported_count, '9007199254740993');
          assert.equal(out.observation.declared_expected_count, '1');
          assert.equal(out.observation.comparison, 'above_declared');
          assert.equal(out.period.timezone, 'Asia/Riyadh');
          assert.equal(out.scope.test_id, input.requirements.test_id);
          assert.equal(out.period.date_from, input.requirements.date_from);
          assert.equal(out.period.date_to, input.requirements.date_to);
          assert.equal(out.source_references.length, 3);
          assert.ok(html.includes('9007199254740993'));
          assert.ok(html.includes('Asia/Riyadh'));
          assert.ok(html.includes(input.requirements.test_id));
        }
        assert.doesNotMatch(html, /PRIVATE-NATIVE|UNUSED-PRIVATE/);
        assert.equal(await feedback.isVisible(), false);
        assert.equal(await page.locator('#' + feedbackId + '-message').innerText(), '');
        assert.equal(site.counts().nativeReads - before.nativeReads, measurementKind === 'identity' ? 4 : 2);
        assert.deepEqual(site.evidenceCounts(), beforeEvidence);
        await checkProductLabels(page, '#' + resultId + ' table', result);
        result.measurement_refusal = {
          kind: measurementKind,
          code: failed.error.code,
          original_message: failed.error.message,
          display_language: locale,
          request_reference_preserved: true,
          authored_refusal_and_hint: !permission,
          authored_recovery_hint: true,
          native_message_preserved: permission,
          persistent_after_ms: 6600,
          form_and_submit_described: true,
          original_submit_focus: true,
          original_settings_preserved: true,
          cleared_on_edit: true,
          failed_native_reads: 1,
          explicit_recovery_reads: measurementKind === 'identity' ? 3 : 1,
          saved_reports: 0,
          automatic_retries: 0,
          duplicate_toasts: 0,
          original_values_preserved: true,
        };
      }
    } else if (workflow === 'measurement-events') {
      await page.locator('#measurement-events select[name=target]').selectOption('0');
      await page.locator('#measurement-events textarea[name=event_names]').fill('purchase, generate_lead');
      await page.locator('#measurement-events input[name=minutes]').fill('5');
      await page.locator('#measurement-events input[name=stream_id]').fill('900');
      assert.equal(site.counts().nativeReads, before.nativeReads, 'Event controls must not start a report');
      await page.locator('#measurement-events button[type=submit]').click();
      await page.locator('#measurement-events-result table').first().waitFor();
      assert.equal(
        site.counts().nativeReads - before.nativeReads,
        1,
        'One explicit native aggregate report is expected',
      );
      const summary = await page.locator('#measurement-events-result table').first().innerText();
      for (const value of ['purchase', 'generate_lead', '9007199254740995']) assert.ok(summary.includes(value), value);
      assert.ok(!summary.includes('9007199254740996'), 'The native exact integer must not be rounded');
      assert.ok(!summary.includes('UNUSED-PRIVATE-EVENT'));
      assert.equal(
        (
          await page
            .locator('#measurement-events-result table')
            .first()
            .locator('tbody tr')
            .nth(1)
            .locator('td')
            .first()
            .innerText()
        ).trim(),
        locale === 'ar' ? 'لم يُرجع عدد' : 'No count returned',
        'An unreturned event must stay unknown rather than becoming zero',
      );
      await page
        .locator('#measurement-events-result details')
        .filter({has: page.locator('table')})
        .locator('summary')
        .click();
      assert.equal(await page.locator('#measurement-events-result table').count(), 2);
      await checkProductLabels(page, '#measurement-events-result table', result);
      await checkTables(page, result);
      await page.screenshot({path: path.join(output, id + '-counts.png'), fullPage: true});
      await page.locator('#measurement-events input[name=minutes]').fill('4');
      assert.equal(
        await page.locator('#measurement-events-result table').count(),
        0,
        'Changing the report window clears old count evidence',
      );
      assert.equal(site.counts().nativeReads - before.nativeReads, 1);
      await page.locator('#measurement-events input[name=minutes]').fill('5');
      await page.locator('#measurement-events button[type=submit]').click();
      await page.locator('#measurement-events-result table').first().waitFor();
      assert.equal(site.counts().nativeReads - before.nativeReads, 2);
      assert.ok(
        (await page.locator('#measurement-events-result table').first().innerText()).includes('9007199254740995'),
      );
      await page
        .locator('#measurement-events-result details')
        .filter({has: page.locator('table')})
        .locator('summary')
        .click();
    } else if (workflow === 'catalog-groups') {
      await page.locator('#catalog-import select[name=target]').selectOption('0');
      await page.locator('#catalog-import input[name=catalog_id]').fill('555');
      await page.locator('#catalog-import select[name=allow_upsert]').selectOption('true');
      await page
        .locator('#catalog-import input[name=file]')
        .setInputFiles({name: 'original-meta-products.csv', mimeType: 'text/csv', buffer: site.csv});
      await page.locator('#catalog-import button[type=submit]').click();
      await page.locator('#catalog-preview table').waitFor();
      for (const value of ['GROUP-001', '0012.34 SAR', '1234'])
        assert.ok((await page.locator('#catalog-preview table').innerText()).includes(value), value);
      assert.equal(site.counts().nativeReads, before.nativeReads, 'Canonical group preview must remain local');
      await checkProductLabels(page, '#catalog-preview table', result);
      await page.locator('#compare-catalog-products').click();
      await page.locator('#catalog-comparison table').waitFor();
      assert.ok((await page.locator('#catalog-comparison table').innerText()).includes('OLD-GROUP'));
      assert.equal(await page.locator('#catalog-comparison input:checked').count(), 0);
      const compared = site.counts().nativeReads;
      await page.locator('#catalog-import select[name=column_mode]').selectOption('mapped');
      assert.equal(await page.locator('#catalog-preview table').count(), 0, 'Changing CSV layout clears old preview');
      await page
        .locator('#catalog-import input[name=file]')
        .setInputFiles({name: 'original-supplier-products.csv', mimeType: 'text/csv', buffer: site.supplierCSV});
      await page.locator('#catalog-load-columns').click();
      await page.locator('#catalog-map-retailer_product_group_id').waitFor();
      assert.equal(
        await page.locator('#catalog-map-retailer_product_group_id').inputValue(),
        '',
        'A parent-looking supplier column must not infer a group',
      );
      for (const [field, value] of Object.entries({
        retailer_id: 'SKU',
        name: 'Title',
        price: 'Source price',
        currency: 'Currency',
        image_url: 'Image',
        retailer_product_group_id: 'Parent group',
      }))
        await page.locator('#catalog-map-' + field).selectOption(value);
      assert.equal(site.counts().nativeReads, compared, 'Source column choices must not read providers');
      await page.locator('#catalog-import button[type=submit]').click();
      await page.locator('#catalog-preview table').waitFor();
      const preview = await page.locator('#catalog-preview').innerText();
      for (const value of ['GROUP-001', '0012.34 SAR', '1234']) assert.ok(preview.includes(value), value);
      assert.ok(!preview.includes('UNSELECTED-PRIVATE-SUPPLIER'));
      assert.equal(site.counts().nativeReads, compared, 'Supplier group preview must remain local');
      await checkProductLabels(page, '#catalog-preview table', result);
      await page.locator('#compare-catalog-products').click();
      await page.locator('#catalog-comparison table').waitFor();
      assert.ok((await page.locator('#catalog-comparison table').innerText()).includes('OLD-GROUP'));
      assert.equal(await page.locator('#catalog-comparison input:checked').count(), 0);
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
      await checkProductLabels(page, '#catalog-preview table', result);
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
  for (const kind of [
    'empty',
    'snapchat',
    'woocommerce',
    'woocommerce-variations',
    'catalog',
    'catalog-groups',
    'measurement-events',
    'measurement-events-error',
    'measurement-events-stale',
    'measurement-identity-error',
    'measurement-identity-stale',
    'measurement-events-permission',
    'measurement-identity-permission',
    'retained-evidence',
    'google-keyword',
    'google-keyword-error',
    'google-keyword-stale',
    'google-device',
    'provider-refusal-meta',
    'provider-refusal-linkedin',
    'provider-refusal-tiktok',
    'provider-refusal-snapchat',
  ]) {
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
          for (const locale of ['en', 'ar'])
            for (const width of ['/', '/privacy'].includes(route) ? [320, 375, 768, 1280] : [320, 1280])
              await renderedCase(site, kind, route, locale, width, false);
        for (const route of workspaceRoutes)
          for (const locale of ['en', 'ar'])
            for (const width of [320, 1280]) await renderedCase(site, kind, route, locale, width, true);
      } else {
        const route =
          kind === 'snapchat'
            ? '/media'
            : kind.startsWith('measurement-')
              ? '/measurement'
              : [
                    'retained-evidence',
                    'google-keyword',
                    'google-keyword-error',
                    'google-keyword-stale',
                    'google-device',
                    'provider-refusal-meta',
                    'provider-refusal-linkedin',
                    'provider-refusal-tiktok',
                    'provider-refusal-snapchat',
                  ].includes(kind)
                ? '/reports'
                : '/commerce';
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
