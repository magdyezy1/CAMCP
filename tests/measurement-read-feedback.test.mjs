import test from 'node:test';
import assert from 'node:assert/strict';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {measurementReadRefusalFixture} from './fixtures/measurement-read-refusal-data.mjs';
const forms = {events: 'measurement-events', identity: 'measurement-event-identity'};
async function setup(kind, locale = 'en', connectionId = 'ga4-login') {
  const f = accountWorkflowFixture(locale),
    id = forms[kind];
  f.context.platforms.find(platform => platform.id === 'ga4').connections[0].id = connectionId;
  await f.run('renderMeasurement()');
  return {
    ...f,
    id,
    form: f.node('#' + id),
    button: f.node(id + ':submit'),
    region: f.node('#' + id + '-feedback'),
    message: f.node('#' + id + '-feedback-message'),
    result: f.node('#' + (kind === 'events' ? 'measurement-events-result' : 'measurement-event-identity-result')),
    submit: () => f.bindings.get('#' + id)(f.node('#' + id)),
  };
}
const snapshot = f =>
  JSON.stringify(Object.fromEntries(Object.entries(f.form.elements).map(([key, node]) => [key, node.value])));
function failure(f, kind, message) {
  const defaults =
    kind === 'events'
      ? ['MEASUREMENT_EVIDENCE_INVALID', 'GA4 returned duplicate event/minute/stream rows.']
      : ['MEASUREMENT_IDENTITY_INVALID', 'GA4 test identity rows are incomplete or exceed the bounded inspection.'];
  f.context.response = errorResult(new MirrorError(defaults[0], message ?? defaults[1]), 'synthetic-read-reference', 0);
  return f.run('requestError(response)');
}
for (const kind of Object.keys(forms)) {
  for (const locale of ['en', 'ar'])
    test(
      kind + ' current ' + locale + ' refusal describes its form, preserves values, and clears on input and change',
      async () => {
        const f = await setup(kind, locale),
          original = snapshot(f),
          error = failure(f, kind);
        f.form.setAttribute('aria-describedby', 'original-form-help');
        f.button.setAttribute('aria-describedby', 'original-submit-help');
        const wire = JSON.stringify(f.context.response);
        f.respond(() => {
          throw error;
        });
        await f.submit();
        assert.equal(f.region.hidden, false);
        assert.equal(f.region.getAttribute('role'), 'alert');
        assert.equal(f.region.getAttribute('aria-atomic'), 'true');
        assert.ok(f.message.textContent.includes('synthetic-read-reference'));
        assert.ok(f.message.textContent.includes(locale === 'ar' ? f.context.catalog[error.message] : error.message));
        assert.equal(snapshot(f), original);
        assert.equal(JSON.stringify(f.context.response), wire);
        assert.equal(f.region.focused, undefined, 'An error does not move focus');
        assert.equal(f.button.id, f.id + '-submit');
        for (const [control, originalHelp] of [
          [f.form, 'original-form-help'],
          [f.button, 'original-submit-help'],
        ])
          assert.deepEqual(control.getAttribute('aria-describedby').split(/\s+/), [originalHelp, f.id + '-feedback']);
        await f.submit();
        assert.equal(f.calls.length, 2, 'Only explicit submissions read again');
        assert.equal(
          f.form
            .getAttribute('aria-describedby')
            .split(/\s+/)
            .filter(id => id === f.id + '-feedback').length,
          1,
        );
        for (const event of ['input', 'change']) {
          f.result.innerHTML = 'Previous evidence';
          f.form.events.get(event)();
          assert.equal(f.region.hidden, true);
          assert.equal(f.message.textContent, '');
          assert.equal(f.result.innerHTML, '');
          assert.equal(f.form.getAttribute('aria-describedby'), 'original-form-help');
          assert.equal(f.button.getAttribute('aria-describedby'), 'original-submit-help');
          await f.submit();
        }
        assert.equal(snapshot(f), original);
      },
    );
  test(kind + ' explicit recovery renders original qualified native values and clears the refusal', async t => {
    const native = measurementReadRefusalFixture(kind),
      f = await setup(kind, 'en', native.input.connection_id);
    t.after(native.close);
    f.respond(async args => {
      const out = await native.service.call('amcp_workspace', args, native.actor);
      if (!out.success) {
        f.context.response = out;
        throw f.run('requestError(response)');
      }
      return out.data;
    });
    await f.submit();
    assert.equal(f.region.hidden, false);
    assert.equal(native.requests.length, 1);
    await f.submit();
    assert.equal(f.region.hidden, true);
    assert.equal(f.message.textContent, '');
    assert.match(f.result.innerHTML, kind === 'events' ? /9007199254740995/ : /9007199254740993/);
    assert.equal(native.requests.length, kind === 'identity' ? 4 : 2);
    assert.doesNotMatch(f.result.innerHTML, /PRIVATE-NATIVE|UNUSED-PRIVATE/);
  });
  for (const departure of ['input', 'change', 'navigation', 'identity', 'form', 'result'])
    test(kind + ' obsolete refusal after ' + departure + ' cannot replace current feedback', async () => {
      const f = await setup(kind),
        error = failure(f, kind);
      let rejectOld;
      f.respond(() => new Promise((_resolve, reject) => (rejectOld = reject)));
      const pending = f.submit();
      if (departure === 'input' || departure === 'change') f.form.events.get(departure)();
      else if (departure === 'navigation') f.context.navigationGeneration++;
      else if (departure === 'identity') f.context.identityGeneration++;
      else f[departure].isConnected = false;
      rejectOld(error);
      await pending;
      assert.equal(f.region.hidden, true);
      assert.equal(f.message.textContent, '');
      assert.equal(f.result.innerHTML, '');
    });
  test(kind + ' newer refusal survives an older response and unknown native markup remains text', async () => {
    const f = await setup(kind),
      old = failure(f, kind);
    let rejectOld;
    f.respond(() => new Promise((_resolve, reject) => (rejectOld = reject)));
    const pending = f.submit(),
      newer = failure(f, kind, 'Native <img src=x onerror=alert(1)> 00100');
    f.respond(() => {
      throw newer;
    });
    await f.submit();
    const text = f.message.textContent;
    assert.ok(text.includes(newer.message));
    assert.equal(f.message.innerHTML, '');
    rejectOld(old);
    await pending;
    assert.equal(f.message.textContent, text);
    assert.equal(f.region.hidden, false);
  });
  test(kind + ' actual superseded error helper never becomes visible feedback', async () => {
    const f = await setup(kind),
      obsolete = f.run('supersededRequest()');
    obsolete.message = 'Obsolete native diagnostic';
    f.respond(() => {
      throw obsolete;
    });
    await f.submit();
    assert.equal(f.region.hidden, true);
    assert.equal(f.message.textContent, '');
  });
}
