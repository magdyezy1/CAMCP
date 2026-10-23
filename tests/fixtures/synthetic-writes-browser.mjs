// Rendered synthetic write journeys (QA-03): review → consent → execute with accepted, uncertain and refused outcomes;
// a spending-policy edit round trip; an export that completes and one that is superseded. Each runs against the
// fixture's own fake provider (tests/fixtures/synthetic-writes-data.mjs); intermediate dialog and alert states are
// inspected with the same accessibility, WCAG and Arabic leak checks as a page's initial and final states.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spendPolicyConnection, spendPolicySeed} from './synthetic-writes-data.mjs';

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
const translate = locale => key => (locale === 'ar' ? (catalog[key] ?? key) : key);
const pattern = text => new RegExp(text.replace(/[.?*+^$()[\]{}|\\]/g, '\\$&'));
/** EXP-04 A: a finished export states a receipt (rows, tab, spreadsheet, time) instead of "Export complete.". */
const receiptPattern = text =>
  new RegExp(
    [
      'Exported {rows} row to the tab “{tab}” in “{spreadsheet}” at {time}.',
      'Exported {rows} rows to the tab “{tab}” in “{spreadsheet}” at {time}.',
    ]
      .map(key =>
        text(key)
          .replace(/[.?*+^$()[\]|\\]/g, '\\$&')
          .replace('{rows}', '[0-9]+')
          .replace('{tab}', '[^”]+')
          .replace('{spreadsheet}', '[^”]+')
          .replace('{time}', '.+?'),
      )
      .join('|'),
  );
const workspaceResponse = (page, tool, action) =>
  page.waitForResponse(
    response =>
      response.url().endsWith('/api/workspace/' + tool) && response.request().postDataJSON()?.action === action,
  );

/** One plan per outcome; the person reviews, is refused without consent, consents and executes. */
export async function exerciseWriteJourney({page, site, locale, result, checks}) {
  const text = translate(locale),
    steps = page.locator('#campaign-detail .campaign-steps');
  result.write_journeys = [];
  for (const outcome of ['accepted', 'uncertain', 'refused']) {
    const id = await site.writeJourney.seed(outcome),
      before = site.counts();
    let actions = 0;
    await page.goto(site.origin + '/campaigns?id=' + encodeURIComponent(id), {waitUntil: 'networkidle'});
    await page.locator('#next-campaign').waitFor();
    assert.deepEqual(site.counts(), before, 'Opening a plan reads and writes nothing at the provider');
    const prepared = workspaceResponse(page, 'campaign', 'prepare_next');
    await page.locator('#next-campaign').click();
    actions++;
    assert.equal((await (await prepared).json()).success, true);
    const panel = page.locator('#campaign-review .review-panel');
    await panel.waitFor();
    assert.equal((await panel.locator('h2').innerText()).trim(), text('Review this change'));
    assert.equal(await page.locator('#review-consent').isChecked(), false, 'Consent starts unchecked');
    assert.equal(await page.locator('#spend-consent').count(), 0, 'A paused create asks for consent only');
    assert.equal(site.counts().syntheticWrites, before.syntheticWrites, 'Preparing a review sends no mutation');
    await checks.intermediate('review-open');
    // Execute without consent is refused in the page; the refusal is announced and nothing is sent. Design review
    // 2026-10: the refusal stands beside the box it names and moves focus to it; before, a six-second toast in the
    // corner repeated the box's label as if it were the error, and outlived the outcome of the execution.
    await page.locator('#execute-reviewed').click();
    actions++;
    const refusal = page.locator('#review-consent-error');
    await refusal.waitFor({state: 'visible'});
    assert.equal((await refusal.innerText()).trim(), text('Tick the authorization above to execute this request.'));
    assert.equal(await refusal.getAttribute('role'), 'alert');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'review-consent');
    assert.match(
      (await page.locator('#review-consent').getAttribute('aria-describedby')) ?? '',
      /review-consent-error/,
    );
    assert.equal(await page.locator('#review-consent').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#toast').isVisible(), false, 'The refusal is not a passing toast');
    await checks.intermediate('consent-required-alert');
    assert.equal(site.counts().syntheticWrites, before.syntheticWrites, 'Execute without consent sends nothing');
    if (outcome === 'refused') site.writeJourney.changeAccountState();
    await page.locator('#review-consent').check();
    actions++;
    // Ticking the box clears its refusal.
    assert.equal(await refusal.isVisible(), false);
    assert.equal(await page.locator('#review-consent').getAttribute('aria-invalid'), null);
    const executed = workspaceResponse(page, 'campaign', 'execute_next');
    await page.locator('#execute-reviewed').click();
    actions++;
    const envelope = await (await executed).json();
    assert.equal(envelope.success, true, JSON.stringify(envelope.error));
    await page.locator('#campaign-review [role=status]').waitFor();
    const step = envelope.data.steps.find(s => s.id === 'campaign'),
      expected = {accepted: 'verified', uncertain: 'uncertain', refused: 'failed'}[outcome];
    assert.equal(step.status, expected, outcome);
    await steps.locator('.status').first().waitFor();
    assert.equal((await steps.locator('.status').first().textContent()).trim(), text(statusText[expected]));
    if (outcome === 'uncertain') {
      assert.equal(step.error, 'WRITE_OUTCOME_UNCERTAIN');
      // The way out of an uncertain step is a read-back of the same review, never a second send.
      assert.equal(await page.locator('#reconcile-campaign').isVisible(), true);
    }
    if (outcome === 'refused') assert.equal(step.error, 'STATE_CHANGED');
    // Design review 2026-10: the outcome says what happened. Before, a step that failed or whose result was lost was
    // announced as "Saved." (role=status), the same word as a plan saved without any execution.
    const said = (await page.locator('#campaign-review .run-outcome').innerText()).trim();
    assert.notEqual(said, text('Saved.'));
    assert.ok(
      said.includes(
        text(
          {
            accepted: 'Every step of this plan is done.',
            uncertain:
              'The provider’s answer to this step was lost, so AMCP cannot confirm the change. It is never sent again: use Read back submitted step to check the account.',
            refused: 'This step did not complete. What happened and what to do are shown with the step.',
          }[outcome],
        ),
      ),
      outcome + ': ' + said,
    );
    // The way on is the emphasized action of the plan: a read-back for an uncertain step, a correction for a refused one.
    if (outcome === 'uncertain')
      assert.match(await page.locator('#reconcile-campaign').getAttribute('class'), /\bprimary\b/);
    if (outcome === 'refused') assert.match(await page.locator('#amend-campaign').getAttribute('class'), /\bprimary\b/);
    const after = site.counts();
    assert.equal(after.syntheticWrites - before.syntheticWrites, outcome === 'refused' ? 0 : 1, outcome);
    assert.equal(after.writes, 0, 'Synthetic journeys never write to a provider');
    await checks.intermediate('outcome-' + outcome);
    result.write_journeys.push({
      outcome,
      step_status: step.status,
      user_actions: actions,
      synthetic_writes: after.syntheticWrites - before.syntheticWrites,
      provider_reads: after.nativeReads - before.nativeReads,
    });
  }
}
const statusText = {verified: 'Verified', uncertain: 'Uncertain', failed: 'Failed'};

/**
 * WRT-03 round trip: the form shows the stored policy, a save that changes one field keeps every other setting, and a
 * weakening asks first, names what weakens, and saves nothing when cancelled.
 */
export async function exerciseSpendPolicyEdit({page, site, locale, result, checks}) {
  const text = translate(locale),
    seeded = await site.spendPolicy.reset(),
    binding = JSON.stringify(['meta_native_action', spendPolicyConnection, '123']);
  await page.reload({waitUntil: 'networkidle'});
  const form = page.locator('#owner-spend-policy'),
    field = name => form.locator(`[name=${name}]`),
    select = async () => {
      await form.waitFor();
      if ((await field('binding').inputValue()) !== binding) await field('binding').selectOption(binding);
    },
    save = async () => {
      const saved = workspaceResponse(page, 'workspace', 'save_spend_policy');
      await form.locator('button.primary').click();
      return (await saved).json();
    };
  await select();
  const shown = {};
  for (const name of [
    'enforcement',
    'unit',
    'max_budget',
    'max_budget_increase_percent',
    'max_daily_increase',
    'max_bid',
    'max_total_budget',
  ])
    shown[name] = await field(name).inputValue();
  shown.allow_activation = await field('allow_activation').isChecked();
  shown.allow_deletion = await field('allow_deletion').isChecked();
  assert.deepEqual(
    shown,
    {
      enforcement: 'block',
      unit: 'native',
      max_budget: '10000',
      max_budget_increase_percent: '20',
      max_daily_increase: '5000',
      max_bid: '500',
      max_total_budget: '',
      allow_activation: false,
      allow_deletion: false,
    },
    'The form shows the stored policy of the selected account',
  );
  // A tightening of one field saves without a question and keeps every other setting.
  await field('max_budget_increase_percent').fill('10');
  const tightened = await save();
  assert.equal(tightened.success, true, JSON.stringify(tightened.error));
  assert.equal(await page.locator('#action-dialog').evaluate(dialog => dialog.open), false);
  const afterTighten = await site.spendPolicy.stored();
  assert.equal(afterTighten.revision, seeded.revision + 1);
  for (const [name, value] of Object.entries({...spendPolicySeed, max_budget_increase_percent: 10}))
    assert.equal(afterTighten[name], value, 'A one-field edit keeps ' + name);
  // A weakening names itself and saves nothing when cancelled.
  await select();
  await page.locator('#toast:not([hidden])').waitFor();
  await checks.intermediate('saved-alert');
  await field('max_budget').fill('20000');
  await form.locator('button.primary').click();
  const dialog = page.locator('#action-dialog');
  await page.waitForFunction(() => document.getElementById('action-dialog').open);
  assert.equal(
    (await dialog.locator('#action-title').innerText()).trim(),
    text('Weaken the spending policy of this account?'),
  );
  assert.equal(await dialog.locator('#action-items li').count(), 1);
  await checks.intermediate('weakening-dialog');
  await dialog.locator('#action-cancel').click();
  await page.waitForFunction(() => !document.getElementById('action-dialog').open);
  assert.equal((await site.spendPolicy.stored()).revision, afterTighten.revision, 'Cancel saves nothing');
  const confirmed = workspaceResponse(page, 'workspace', 'save_spend_policy');
  await form.locator('button.primary').click();
  await page.waitForFunction(() => document.getElementById('action-dialog').open);
  await dialog.locator('#action-confirm').click();
  assert.equal((await (await confirmed).json()).success, true);
  const afterWeaken = await site.spendPolicy.stored();
  assert.equal(afterWeaken.revision, afterTighten.revision + 1);
  for (const [name, value] of Object.entries({
    ...spendPolicySeed,
    max_budget_increase_percent: 10,
    max_budget_native: 20000,
  }))
    assert.equal(afterWeaken[name], value, 'A confirmed weakening changes only ' + name);
  assert.deepEqual(site.counts().writes, 0);
  result.spend_policy_round_trip = {
    revisions: [seeded.revision, afterTighten.revision, afterWeaken.revision],
    kept_settings: Object.keys(spendPolicySeed).length,
    weakening_confirmation: true,
  };
}

/** EXP-03: the newer snapshot's export completes; the older one's is superseded, says so, and writes nothing. */
export async function exerciseExportOutcomes({page, site, locale, result, checks}) {
  const text = translate(locale),
    {older, newer, destination} = site.exportOutcomes.seed(),
    status = page.locator('#delivery-status');
  result.export_outcomes = [];
  for (const [report, outcome] of [
    [newer, 'complete'],
    [older, 'superseded'],
  ]) {
    const before = site.counts();
    await page.goto(site.origin + '/reporting-overview?report_id=' + encodeURIComponent(report), {
      waitUntil: 'networkidle',
    });
    await page.locator('#report-export').click();
    const dialog = page.locator('#report-delivery-dialog');
    await dialog.locator('#report-export-now').waitFor();
    await dialog.locator('#report-destination').selectOption(destination);
    const note = dialog.locator('#report-destination-note');
    assert.equal(await note.isVisible(), outcome === 'superseded', 'Only the older snapshot is warned about');
    await checks.intermediate('delivery-dialog-' + outcome);
    await dialog.locator('#report-export-confirm').check();
    const exported = page.waitForResponse(
      r => r.url().endsWith('/api/workspace/overview') && r.request().postDataJSON()?.action === 'export',
    );
    await dialog.locator('#report-export-now').click();
    assert.equal((await (await exported).json()).success, true);
    assert.equal(await site.exportOutcomes.workOnce(), true);
    const expected = outcome === 'complete' ? receiptPattern(text).source : pattern(text('Export to a new tab')).source;
    await page.waitForFunction(
      expected => new RegExp(expected).test(document.getElementById('delivery-status')?.textContent ?? ''),
      expected,
      {timeout: 10000},
    );
    if (outcome === 'superseded') {
      assert.doesNotMatch(await status.innerText(), pattern(text('Export complete.')));
      assert.doesNotMatch(await status.innerText(), receiptPattern(text), 'A superseded export states no receipt');
      assert.equal(await status.locator('#delivery-new-tab').isVisible(), true);
    } else assert.equal(await status.locator('a[href*="docs.google.com"]').count(), 1);
    await checks.intermediate('export-' + outcome);
    // Design review 2026-10: the authorization box sits beside the first line of its text (the dialog's label grid had
    // put it alone on a line above it), and the status that follows an export covers neither the box nor the export
    // button (the sticky status bar hid both until the reader scrolled; WCAG 2.4.11).
    const consent = dialog.locator('#report-export-confirm'),
      lineup = await consent.evaluate(box => {
        const text = [...box.closest('label').childNodes].find(n => n.nodeType === 3 && n.textContent.trim()),
          range = document.createRange();
        range.selectNodeContents(text);
        const line = range.getClientRects()[0],
          b = box.getBoundingClientRect(),
          middle = (b.top + b.bottom) / 2;
        return {
          beside: b.right <= line.left + 1 || b.left >= line.right - 1,
          level: middle >= line.top - 4 && middle <= line.bottom + 4,
        };
      });
    assert.deepEqual(lineup, {beside: true, level: true}, 'The authorization box sits beside its text');
    for (const control of [consent, dialog.locator('#report-export-now')]) {
      await control.scrollIntoViewIfNeeded();
      const cover = await control.evaluate(element => {
        const r = element.getBoundingClientRect(),
          top = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        return top && !element.contains(top) && !top.contains(element) ? top.id || String(top.className) : null;
      });
      assert.equal(cover, null, 'The export status covers ' + outcome);
    }
    const written = site.counts().syntheticWrites - before.syntheticWrites;
    assert.equal(written > 0, outcome === 'complete', 'Only the complete export writes the tab');
    assert.equal(site.exportOutcomes.tab.report, newer, 'The tab keeps the newer snapshot');
    assert.equal(site.counts().writes, 0);
    await dialog.locator('#report-delivery-close').click();
    result.export_outcomes.push({outcome, synthetic_writes: written});
  }
}
