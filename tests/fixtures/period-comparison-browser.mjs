import assert from 'node:assert/strict';
import fs from 'node:fs';
import {comparisonBaselineWindow, comparisonWindow} from './period-comparison-data.mjs';

// Bidirectional controls the Arabic number and currency formats may add around signs and symbols.
const plain = value => String(value).replace(/[؜‎‏‪-‮⁦-⁩]/g, '');

/**
 * RPT-07 period comparison in a real browser: the run bar collects the previous equal window with the report, the
 * worker collects both snapshots from the synthetic provider, and "Compare periods" lists the retained snapshots with
 * the paired one chosen and the others disabled with their reasons, then shows this window, the earlier window and the
 * change for each entity found in both. Choosing and comparing read retained snapshots only.
 */
export async function exercisePeriodComparison({page, site, locale, result, checks}) {
  const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
    text = key => (locale === 'ar' ? (catalog[key] ?? key) : key),
    fixture = site.periodComparison;
  // Each case starts from the same retained snapshots (an overlapping and a shorter window), then opens the page anew.
  const seeded = await fixture.reset();
  await page.reload({waitUntil: 'networkidle'});
  await page.locator('h1').first().waitFor({state: 'visible'});
  const form = page.locator('#overview-config'),
    meta = page.locator('.report-platform').filter({has: page.locator('[data-report-level=meta]')});
  await form.locator('[name=name]').fill('Weekly comparison');
  await form.locator('[name=rangeMode]').selectOption('custom');
  await form.locator('[name=since]').fill(comparisonWindow.since);
  await form.locator('[name=until]').fill(comparisonWindow.until);
  if (!(await meta.evaluate(el => el.open))) await meta.locator(':scope > summary').click();
  await meta.locator('[data-report-account=meta]').check();
  await meta.locator('[data-objective-for=meta]').selectOption('sales');
  // Reach is chosen too: a seven-day reach is not a sum of days, so the comparison names it as not compared.
  const options = page.locator('details.report-options').filter({has: page.locator('[data-report-metric]')});
  if (!(await options.evaluate(el => el.open))) await options.locator(':scope > summary').click();
  const reach = page.locator('[data-report-metric][value=reach]');
  await reach.focus();
  await page.keyboard.press('Space');
  assert.equal(await reach.isChecked(), true);
  await page.locator('#overview-compare-previous').check();
  const beforeRun = site.counts(),
    requested = page.waitForResponse(
      r => r.url().endsWith('/api/workspace/overview') && r.request().postDataJSON()?.action === 'run',
    );
  await form.locator('button[type=submit]').click();
  const response = await requested,
    sent = response.request().postDataJSON(),
    envelope = await response.json();
  assert.equal(envelope.success, true, JSON.stringify(envelope));
  assert.equal(sent.compare, 'previous_period', 'The run bar asks for the previous equal window');
  assert.deepEqual(envelope.data.comparison.baseline_date_range, comparisonBaselineWindow);
  assert.equal(envelope.data.comparison.estimated_requests_total, 2 * envelope.data.estimated_requests);
  assert.deepEqual(site.counts(), beforeRun, 'Queueing a run reads nothing from the provider');
  // The worker collects the snapshot and its previous equal window; the page shows the snapshot once it is complete.
  assert.equal(await fixture.drain(), 2);
  const collected = site.counts().nativeReads - beforeRun.nativeReads;
  assert.ok(collected >= 2, 'Both windows were read from the synthetic provider');
  const choices = page.locator('#snapshot-compare-choices');
  await choices.waitFor({state: 'visible', timeout: 15000});
  assert.equal(
    (await page.locator('#snapshot-compare h2').innerText()).trim(),
    text('Compare periods'),
    'The comparison section is in the page language',
  );
  const beforeCompare = site.counts();
  await choices.click();
  const select = page.locator('#snapshot-compare-form select[name=baseline_id]'),
    table = page.locator('#snapshot-compare-result .report-compare-table');
  await table.waitFor();
  // The pair is chosen for the person; snapshots that fail a rule stay listed, disabled, with the reason.
  const listed = await select
    .locator('option')
    .evaluateAll(nodes =>
      nodes.map(option => ({
        value: option.value,
        disabled: option.disabled,
        selected: option.selected,
        text: option.textContent,
      })),
    );
  assert.equal(listed[0].value, '', 'Nothing is chosen without an explicit option');
  const paired = listed.find(option => option.value === envelope.data.comparison.baseline_id);
  assert.ok(paired && paired.selected && !paired.disabled, JSON.stringify(listed));
  assert.ok(paired.text.includes(text('previous equal window')));
  for (const [key, reason] of [
    ['overlap', 'The baseline must end before the current window starts.'],
    ['shorter', 'The windows have different lengths.'],
  ]) {
    const option = listed.find(o => o.value === seeded[key]);
    assert.ok(option?.disabled, key + ' is offered disabled: ' + JSON.stringify(listed));
    assert.ok(option.text.includes(text(reason)), key + ' names its reason: ' + option.text);
  }
  assert.equal(
    listed.filter(o => o.value && !o.disabled).length,
    1,
    'Only the compatible earlier window can be chosen',
  );
  // The delta columns: this window, the earlier window and the change, per metric.
  const headers = await table.locator('thead th').allInnerTexts();
  assert.equal(headers.length, 7, JSON.stringify(headers));
  const rowText = async name =>
    plain(await table.locator('tbody tr').filter({hasText: name}).innerText()).replace(/\s+/g, ' ');
  const first = await rowText('Spring <sale> العربية'),
    second = await rowText('Second campaign');
  for (const expected of [
    '170.30',
    text('Earlier: {value}').replace('{value}', ''),
    '100.10',
    text('Change:'),
    '70.20',
    '+70.13%',
    '-10',
    '-20%',
    '+20%',
  ])
    assert.ok(first.includes(plain(expected).trim()), 'First row shows ' + expected + ': ' + first);
  // A zero earlier value has no percentage, and a ratio with an unknown side is unavailable, never zero.
  assert.ok(second.includes('12.50') && second.includes('—'), second);
  assert.ok(second.includes(text('Unavailable')), second);
  const noPercent = table.locator('tbody tr').filter({hasText: 'Second campaign'}).locator('span[title]').first();
  assert.equal(await noPercent.getAttribute('title'), text('The earlier value is zero, so there is no percentage.'));
  // Native names stay literal and take their own direction.
  const name = table.locator('tbody th span[data-native]').first();
  assert.equal(await name.getAttribute('dir'), 'auto');
  assert.equal(await name.innerText(), 'Spring <sale> العربية');
  const view = page.locator('#snapshot-compare-result');
  assert.ok(
    plain(await view.innerText()).includes(text('Not compared:')),
    'Reach is named as not compared over seven days',
  );
  assert.ok(
    plain(await view.innerText()).includes(text('Not additive across days; compared only for single-day windows')),
  );
  const onlyEarlier = view.locator('details > summary').filter({
    hasText: text('{count} entity only in the earlier window').replace('{count}', '').trim(),
  });
  assert.equal(await onlyEarlier.count(), 1, 'The campaign of the earlier window only is listed, not counted as zero');
  await onlyEarlier.click();
  assert.ok((await view.locator('details[open] li').innerText()).includes('Paused before'));
  assert.deepEqual(site.counts(), beforeCompare, 'Listing and comparing read retained snapshots only');
  await checks.intermediate('period-comparison');
  await checks.tables(page, result);
  // Comparing again with the explicit choice reads nothing either.
  const again = page.waitForResponse(
    r => r.url().endsWith('/api/workspace/overview') && r.request().postDataJSON()?.action === 'compare',
  );
  await page.locator('#snapshot-compare-form button[type=submit]').click();
  const compared = await (await again).json();
  assert.equal(compared.success, true);
  assert.equal(compared.data.baseline.id, envelope.data.comparison.baseline_id);
  assert.equal(compared.data.network_requests, 0);
  await table.waitFor();
  assert.deepEqual(site.counts(), beforeCompare, 'An explicit comparison reads retained snapshots only');
  result.period_comparison = {
    current: comparisonWindow,
    baseline: comparisonBaselineWindow,
    paired_selected: true,
    disabled_with_reasons: ['window_order', 'window_length'],
    compared_rows: await table.locator('tbody tr').count(),
    provider_reads_collecting: collected,
    provider_reads_comparing: 0,
  };
}
