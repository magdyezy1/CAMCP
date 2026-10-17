import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ledgerSnapPixel, ledgerTiktokAccount, ledgerTiktokPixels} from './measurement-ledger-data.mjs';

/**
 * MSR-03 measurement evidence ledger in a real browser. TikTok first: two pixels and none chosen keep activity unknown
 * with nothing read for it; the chosen pixel's statistics come back as literal fields whose meaning stays unconfirmed
 * (unknown, never observed); a statistics answer that names another pixel is refused and the layer stays unknown with
 * the error code. Then Snapchat, whose pixel activity and signal readiness are observed. Choosing reads nothing; each
 * read is one submit; nothing is written or saved.
 */
export async function exerciseMeasurementLedger({page, site, locale, result, before, beforeEvidence, checks}) {
  const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
    text = key => (locale === 'ar' ? (catalog[key] ?? key) : key),
    form = page.locator('#measurement-ledger'),
    region = page.locator('#measurement-ledger-result'),
    heading = page.locator('#measurement-ledger-heading'),
    target = form.locator('select[name=target]'),
    reads = () => site.counts().nativeReads - before.nativeReads;
  const option = async platform =>
    (await target.locator('option').evaluateAll(nodes => nodes.map(n => ({value: n.value, text: n.textContent})))).find(
      o => o.text.startsWith(platform + ' · '),
    )?.value;
  const layers = () =>
    page.locator('#measurement-ledger-result table.measurement-ledger tbody tr').evaluateAll(rows =>
      rows.map(row => ({
        layer: row.querySelector('th').textContent.trim(),
        state: row.querySelector('.measurement-ledger-state').className.replace('measurement-ledger-state ', ''),
        meaning: row.querySelectorAll('td')[1].textContent.trim(),
        evidence: row.querySelectorAll('td')[2].textContent,
      })),
    );
  const read = async () => {
    const answered = page.waitForResponse(
      r => r.url().endsWith('/api/workspace/workspace') && r.request().postDataJSON()?.action === 'measurement_ledger',
    );
    await form.locator('button[type=submit]').click();
    const envelope = await (await answered).json();
    assert.equal(envelope.success, true, JSON.stringify(envelope));
    await page.waitForFunction(() => document.activeElement?.id === 'measurement-ledger-heading');
    return envelope.data;
  };
  // Choosing the advertiser reads nothing.
  await form.scrollIntoViewIfNeeded();
  await target.selectOption(await option('TikTok'));
  assert.equal(reads(), 0, 'Choosing an account reads nothing');
  // 1. Two pixels, none chosen: the pixel list only; activity stays unknown with the reason.
  let data = await read();
  assert.equal(reads(), 1, 'The pixel list only: no statistics without a chosen pixel');
  let rows = await layers();
  assert.equal(rows.length, 6);
  assert.deepEqual(
    rows.map(r => r.state),
    [
      'measurement-ledger-observed',
      'measurement-ledger-unknown',
      'measurement-ledger-unavailable',
      'measurement-ledger-unavailable',
      'measurement-ledger-unavailable',
      'measurement-ledger-not_applicable',
    ],
  );
  assert.equal(
    rows[1].meaning,
    text('The account lists several pixels. Enter one pixel ID and read the ledger again.'),
  );
  assert.equal(data.scope.pixel_id, null);
  await checks.intermediate('ledger-several-pixels');
  // 2. The chosen pixel: its statistics are shown as returned and stay unknown.
  await form.locator('input[name=pixel_id]').fill(ledgerTiktokPixels[0]);
  data = await read();
  assert.equal(reads(), 3, 'The pixel list again and the chosen pixel’s statistics');
  rows = await layers();
  assert.equal(rows[1].state, 'measurement-ledger-unknown', 'Unconfirmed fields never read as observed activity');
  assert.ok(
    rows[1].meaning.startsWith(
      text(
        'TikTok returned these pixel event statistics. Their field meanings are not confirmed yet, so AMCP shows them as returned and does not interpret them.',
      ),
    ),
  );
  for (const literal of [
    'stats[0].events[0].name',
    'CompletePayment',
    'stats[0].events[1].count',
    '41',
    ledgerTiktokPixels[0],
  ])
    assert.ok(rows[1].evidence.includes(literal), literal + ' in ' + rows[1].evidence);
  const fields = page.locator('#measurement-ledger-result tbody tr').nth(1).locator('li code[dir=ltr]');
  assert.ok((await fields.count()) >= 10, 'Each path and value is a left-to-right literal');
  assert.equal(data.layers[1].evidence.field_meanings, 'unconfirmed');
  assert.equal(data.summary.observed, 1);
  assert.equal(data.scope.pixel_id, ledgerTiktokPixels[0]);
  assert.match(await heading.innerText(), new RegExp(ledgerTiktokAccount));
  await checks.intermediate('ledger-unconfirmed-fields');
  await checks.tables(page, result);
  // 3. A statistics answer naming another pixel is refused: unknown with the error code, no field shown.
  await form.locator('input[name=pixel_id]').fill(ledgerTiktokPixels[1]);
  data = await read();
  assert.equal(reads(), 5);
  rows = await layers();
  assert.equal(rows[1].state, 'measurement-ledger-unknown');
  assert.equal(rows[1].meaning, text('This read failed or was incomplete, so the layer stays unknown.'));
  assert.ok(rows[1].evidence.includes('MEASUREMENT_LEDGER_INVALID'), rows[1].evidence);
  assert.ok(!rows[1].evidence.includes('total'), 'A refused answer keeps no field');
  await checks.intermediate('ledger-foreign-statistics');
  // 4. Snapchat: the pixel's domains and signal readiness are observed; the codes stay literal.
  await form.locator('input[name=pixel_id]').fill('');
  await target.selectOption(await option('Snapchat'));
  data = await read();
  assert.equal(reads(), 8, 'The pixel list, the domain statistics and the signal readiness');
  rows = await layers();
  assert.deepEqual(
    rows.map(r => r.state),
    [
      'measurement-ledger-observed',
      'measurement-ledger-observed',
      'measurement-ledger-observed',
      'measurement-ledger-unavailable',
      'measurement-ledger-unavailable',
      'measurement-ledger-not_applicable',
    ],
  );
  assert.equal(
    rows[1].meaning,
    text('Snapchat reported the domains that fired the pixel in the last 7 days.'),
    'The website explains the reason itself',
  );
  assert.ok(rows[1].evidence.includes('shop.example.test'));
  assert.ok(rows[2].evidence.includes('PII_COVERAGE_CAPI') && rows[2].evidence.includes('P0'));
  assert.equal(data.scope.pixel_id, ledgerSnapPixel);
  await checks.intermediate('ledger-observed');
  // Read-only throughout: nothing saved, nothing written.
  assert.deepEqual(site.evidenceCounts(), beforeEvidence, 'The ledger saves no report, plan or review');
  assert.equal(site.counts().writes, 0);
  result.measurement_ledger = {
    reads: reads(),
    tiktok_activity: 'unknown',
    tiktok_unconfirmed_fields: true,
    foreign_statistics_refused: true,
    snapchat_activity: 'observed',
  };
  assert.ok(await region.isVisible());
}
