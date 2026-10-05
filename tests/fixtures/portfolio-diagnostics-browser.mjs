import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
export async function exercisePortfolioDiagnostic(
  page,
  site,
  {output, id, locale, width, before, beforeEvidence, result, catalogPath = 'web/locales/ar.json'},
) {
  const {provider, input, message, code} = site.portfolioRefusal,
    catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')),
    form = page.locator('#portfolio-account'),
    select = form.locator('select[name="target"]'),
    submit = form.locator('button[type="submit"]'),
    feedback = page.locator('#portfolio-account-workspace-feedback'),
    endpoint = site.origin + '/api/workspace/workspace';
  await select.selectOption('0');
  assert.equal(site.counts().nativeReads, before.nativeReads, 'Selecting an account does not read inventory');
  assert.equal(await feedback.isVisible(), false);
  const requestWait = page.waitForRequest(r => r.url() === endpoint && r.method() === 'POST'),
    responseWait = page.waitForResponse(r => r.url() === endpoint && r.request().method() === 'POST');
  await submit.click();
  const request = await requestWait,
    response = await responseWait,
    body = await response.json();
  assert.deepEqual(request.postDataJSON(), input, 'Inventory submits the exact original selected account and root');
  assert.equal(body.success, false);
  assert.equal(body.error.code, code);
  assert.equal(body.error.message, message);
  assert.equal(body.data, undefined);
  assert.equal(typeof body.meta.requestId, 'string');
  assert.ok(body.meta.requestId.length > 0);
  await feedback.waitFor({state: 'visible'});
  const display = locale === 'ar' ? catalog[message] : message,
    reference = body.meta.requestId,
    hint = body.error.next_action,
    shown = await feedback.innerText();
  assert.ok(shown.includes(display), 'Actual persistent form displays the owned sentence in its current language');
  assert.ok(shown.includes(reference), 'Original request reference remains visible');
  if (typeof hint === 'string') assert.ok(shown.includes(locale === 'ar' ? (catalog[hint] ?? hint) : hint));
  assert.equal(await feedback.getAttribute('role'), 'alert');
  assert.equal(await feedback.getAttribute('aria-atomic'), 'true');
  for (const control of [form, submit])
    assert.ok(
      ((await control.getAttribute('aria-describedby')) ?? '')
        .split(/\s+/)
        .includes('portfolio-account-workspace-feedback'),
    );
  assert.equal(await select.inputValue(), '0');
  assert.equal(await submit.isEnabled(), true);
  assert.equal(await page.locator('#portfolio-view').getAttribute('aria-busy'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'portfolio-account-submit');
  assert.equal(site.counts().nativeReads - before.nativeReads, 1);
  assert.deepEqual(site.evidenceCounts(), beforeEvidence, 'Refused inventory saves no report, plan or review');
  const box = await feedback.boundingBox();
  assert.ok(box && box.x >= -1 && box.x + box.width <= width + 1, 'Persistent diagnostic stays within the viewport');
  const nativeBefore = site.counts().nativeReads;
  await page.waitForTimeout(6600);
  assert.equal(await feedback.isVisible(), true);
  assert.equal(await feedback.innerText(), shown);
  assert.equal(site.counts().nativeReads, nativeBefore, 'Elapsed time does not retry the refused inventory read');
  assert.equal(await page.locator('#toast').isVisible(), false);
  await feedback.screenshot({path: path.join(output, id + '-diagnostic.png')});
  await select.selectOption('');
  assert.equal(await feedback.isVisible(), false);
  for (const control of [form, submit])
    assert.ok(
      !((await control.getAttribute('aria-describedby')) ?? '')
        .split(/\s+/)
        .includes('portfolio-account-workspace-feedback'),
    );
  assert.equal(site.counts().nativeReads, nativeBefore, 'Editing scope clears feedback without a new read');
  assert.deepEqual(site.evidenceCounts(), beforeEvidence);
  result.portfolio_diagnostic = {
    provider,
    code,
    original_message: message,
    display_language: locale,
    persistent_after_ms: 6600,
    original_request_preserved: true,
    original_selection_preserved: true,
    request_reference_preserved: true,
    authored_reason_and_hint: true,
    form_and_submit_described: true,
    original_submit_focus: true,
    diagnostic_within_viewport: true,
    cleared_on_edit: true,
    native_reads: 1,
    automatic_reads: 0,
    provider_mutations: 0,
    saved_reports: 0,
  };
}
