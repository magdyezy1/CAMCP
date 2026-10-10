import assert from 'node:assert/strict';
import {forecast} from './conditional-program-data.mjs';

/** Real website interaction on the isolated server; private-product and stale-view cases create nothing. */
export async function exerciseConditionalPrograms({page, site, workflow, locale, result, before, checks}) {
  const filter = page.locator('#capability-filter');
  await filter.locator('[name=workflow_id]').selectOption('program:linkedin_forecast');
  await filter.locator('button[type=submit]').click();
  const card = page
    .locator('.capability-card')
    .filter({has: page.locator('[data-workflow-id="program:linkedin_forecast"]')});
  await card.waitFor();
  await card.locator(':scope > summary').click();
  const form = card.locator('[data-program-check]'),
    output = page.locator('#' + (await form.getAttribute('id')) + '-result');
  assert.equal(await form.getAttribute('data-account-id'), '123');
  assert.equal(await form.getAttribute('data-connection-id'), site.conditionalProgram.input.connection_id);
  const requirements = forecast().request,
    toDate = d => [d.year, String(d.month).padStart(2, '0'), String(d.day).padStart(2, '0')].join('-');
  await form.locator('[name=budget]').fill('300.000000');
  await form.locator('[name=date_from]').fill(toDate(requirements.startDateOn));
  await form.locator('[name=date_to]').fill(toDate(requirements.endDateOn));
  await form.locator('[name=locations]').fill('urn:li:geo:105080838');
  assert.equal(site.counts().nativeReads, before.nativeReads, 'Selecting the workflow and editing inputs stays local');
  if (locale === 'ar') assert.match(await card.innerText(), /النتائج المتوقعة تقديرات إرشادية/);
  else assert.match(await card.innerText(), /directional estimates/);
  const snapshot = site.evidenceCounts();
  const response = page.waitForResponse(
    r => r.url().endsWith('/api/workspace/workspace') && r.request().postDataJSON()?.action === 'program_check',
  );
  const held = workflow.endsWith('-stale') ? site.conditionalProgram.hold() : null;
  await form.locator('button[type=submit]').click();
  if (held) {
    await held;
    await form.locator('[name=budget]').fill('400');
    site.conditionalProgram.release();
  }
  const envelope = await (await response).json();
  assert.equal(envelope.success, true, JSON.stringify(envelope));
  assert.equal(envelope.data.state, workflow.endsWith('-denied') ? 'blocked' : 'observed');
  assert.equal(envelope.data.advertising_writes, 0);
  assert.equal(envelope.data.entitlement, 'unverified');
  await page.waitForFunction(
    id => !document.getElementById(id).querySelector('button[type=submit]').disabled,
    await form.getAttribute('id'),
  );
  if (held) {
    assert.equal((await output.innerText()).trim(), '');
  } else {
    await output.locator('h5').waitFor();
    assert.equal(await output.evaluate(el => el === document.activeElement), true);
    await output.locator('summary').click();
    assert.equal(await output.locator('pre').count(), 1);
    assert.match(await output.innerText(), workflow.endsWith('-denied') ? /PROVIDER_ACCESS_DENIED/ : /300000000/);
    if (workflow.endsWith('-denied')) {
      // CON-04/D21: the summary shows the provider status, code and reference, the owner action replaces a live
      // retry, and the card's readiness chip shows the refusal instead of "Ready for native inspection".
      const text = await output.innerText();
      for (const literal of ['403', 'ACCESS_DENIED', 'li-uuid-browser-1']) assert.ok(text.includes(literal), literal);
      assert.equal(envelope.data.next_call, null);
      assert.equal(envelope.data.owner_action.kind, 'request_provisioning');
      assert.match(
        await card.locator('[data-program-status]').first().innerText(),
        locale === 'ar' ? /رفضت المنصة/ : /Provider refused/,
      );
    }
    assert.doesNotMatch(await output.innerText(), /accessToken|synthetic-/);
  }
  let expectedReads = 1;
  if (!held) {
    await checks.tables(page, result);
    for (const program of ['linkedin_audience_insights', 'dv360_advertiser']) {
      await filter.locator('[name=workflow_id]').selectOption('program:' + program);
      await filter.locator('button[type=submit]').click();
      const selected = page
        .locator('.capability-card')
        .filter({has: page.locator('[data-workflow-id="program:' + program + '"]')});
      await selected.waitFor();
      await selected.locator(':scope > summary').click();
      const nextForm = selected.locator('[data-program-check]'),
        nextOutput = page.locator('#' + (await nextForm.getAttribute('id')) + '-result');
      if (program === 'linkedin_audience_insights') {
        assert.equal(await nextForm.locator('[name=input_kind]').inputValue(), 'guided');
        await nextForm.locator('[name=locations]').fill('urn:li:geo:105080838');
        await nextForm.locator('[name=audience_values]').fill('urn:li:skill:236');
        assert.equal(await nextForm.locator('[name=request]').isDisabled(), true);
        await nextForm.locator('[name=input_kind]').selectOption('native');
        assert.equal(await nextForm.locator('[name=locations]').isDisabled(), true);
        assert.equal(await nextForm.locator('[name=request]').isDisabled(), false);
        await nextForm.locator('[name=input_kind]').selectOption('guided');
        assert.equal(await nextForm.locator('[name=audience_values]').inputValue(), 'urn:li:skill:236');
      }
      assert.equal(
        site.counts().nativeReads - before.nativeReads,
        expectedReads,
        'Program selection and input changes do not read the provider',
      );
      const received = page.waitForResponse(
        r => r.url().endsWith('/api/workspace/workspace') && r.request().postDataJSON()?.action === 'program_check',
      );
      await nextForm.locator('button[type=submit]').click();
      const observed = await (await received).json();
      assert.equal(observed.success, true, JSON.stringify(observed));
      assert.equal(observed.data.state, workflow.endsWith('-denied') ? 'blocked' : 'observed');
      assert.equal(observed.data.scope.account_id, '123');
      assert.equal(observed.data.entitlement, 'unverified');
      assert.equal(observed.data.advertising_writes, 0);
      await nextOutput.locator('h5').waitFor();
      if (!workflow.endsWith('-denied'))
        assert.match(
          await nextOutput.innerText(),
          program.startsWith('linkedin') ? /420[,.\s]?000|٤٢٠[٬,.\s]?٠٠٠/ : /ENTITY_STATUS_PAUSED/,
        );
      assert.doesNotMatch(await nextOutput.innerText(), /accessToken|synthetic-|private display name|billingConfig/);
      await checks.tables(page, result);
      expectedReads++;
    }
  }
  assert.equal(site.counts().nativeReads - before.nativeReads, expectedReads);
  assert.deepEqual(site.evidenceCounts(), snapshot);
  await checks.tables(page, result);
  result.program = {
    workflow,
    state: envelope.data.state,
    requests: envelope.data.provider_requests,
    scope: envelope.data.scope,
    stale_result_discarded: !!held,
    advertising_writes: 0,
    native_reads: expectedReads,
  };
}
