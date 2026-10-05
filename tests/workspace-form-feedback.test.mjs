import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {workspaceFormUIFixture, deferred} from './fixtures/workspace-form-ui.mjs';
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
for (const locale of ['en', 'ar'])
  test(
    locale + ' shared form failure keeps original reason, authored hint, reference and settings in a described alert',
    async () => {
      const f = workspaceFormUIFixture(locale),
        error = f.error('Native <img src="owned-test"> refusal');
      f.form.setAttribute('aria-describedby', 'form-instructions');
      f.button.setAttribute('aria-describedby', 'button-instructions');
      let calls = 0;
      f.bind(async () => {
        calls++;
        throw error;
      });
      await f.submit();
      const region = f.region(),
        text = f.message().textContent,
        hint = error.next_action;
      assert.equal(calls, 1);
      assert.equal(region.hidden, false);
      assert.equal(region.getAttribute('aria-atomic'), 'true');
      assert.ok(text.includes(error.message));
      assert.ok(text.includes(locale === 'ar' ? catalog[hint] : hint));
      assert.ok(text.includes(error.requestId));
      assert.ok(text.includes(locale === 'ar' ? 'المرجع:' : 'Reference:'));
      assert.equal(f.message().innerHTML, '');
      assert.equal(error.code, 'PROVIDER_ACCESS_DENIED');
      assert.equal(error.retryable, false);
      assert.equal(f.form.getAttribute('aria-describedby'), 'form-instructions ' + region.id);
      assert.equal(f.button.getAttribute('aria-describedby'), 'button-instructions ' + region.id);
      assert.equal(f.target.value, '0');
      assert.equal(f.nativeId.value, '9007199254740993');
      assert.deepEqual(f.toasts, []);
      assert.deepEqual(f.focus, ['settings-submit']);
      assert.equal(f.button.disabled, false);
      assert.ok(
        f.insertions[0].html.includes(
          locale === 'ar' ? catalog['This step needs attention.'] : 'This step needs attention.',
        ),
      );
    },
  );
for (const event of ['input', 'change'])
  test(event + ' clears only the shared description, preserves edited values and makes no new request', async () => {
    const f = workspaceFormUIFixture();
    let calls = 0;
    f.bind(async () => {
      calls++;
      throw f.error();
    });
    await f.submit();
    f.form.setAttribute('aria-describedby', 'current-instructions ' + f.region().id);
    f.button.setAttribute('aria-describedby', 'current-button ' + f.region().id);
    f.nativeId.value = '000099';
    await f.edit(event);
    assert.equal(f.region().hidden, true);
    assert.equal(f.message().textContent, '');
    assert.equal(f.form.getAttribute('aria-describedby'), 'current-instructions');
    assert.equal(f.button.getAttribute('aria-describedby'), 'current-button');
    assert.equal(f.nativeId.value, '000099');
    assert.equal(calls, 1);
    assert.deepEqual(f.toasts, []);
  });
for (const obsolete of ['input', 'change', 'navigation', 'identity', 'form-detached', 'region-detached'])
  test('an outstanding ' + obsolete + ' shared form refusal is silent and cannot move focus', async () => {
    const f = workspaceFormUIFixture(),
      pending = deferred();
    let calls = 0;
    f.bind(async () => {
      calls++;
      await pending.promise;
    });
    const completion = f.submit();
    assert.equal(f.button.disabled, true);
    if (obsolete === 'input' || obsolete === 'change') {
      f.nativeId.value = 'edited-native-id';
      await f.edit(obsolete);
    }
    if (obsolete === 'navigation') f.run('navigationGeneration++');
    if (obsolete === 'identity') f.run('identityGeneration++');
    if (obsolete === 'form-detached') f.form.isConnected = false;
    if (obsolete === 'region-detached') f.region().isConnected = false;
    pending.reject(f.error());
    await completion;
    assert.equal(calls, 1);
    assert.equal(f.region().hidden, true);
    assert.deepEqual(f.toasts, []);
    assert.deepEqual(f.focus, []);
    if (obsolete === 'input' || obsolete === 'change') {
      assert.equal(f.nativeId.value, 'edited-native-id');
      assert.equal(f.button.disabled, false);
    }
  });
for (const oldResult of ['refusal', 'success'])
  test('an older ' + oldResult + ' cannot replace newer form feedback or re-enable its running control', async () => {
    const f = workspaceFormUIFixture(),
      first = deferred(),
      second = deferred();
    let calls = 0;
    f.bind(async () => {
      calls++;
      await (calls === 1 ? first.promise : second.promise);
    });
    const a = f.submit(),
      b = f.submit();
    assert.equal(calls, 2);
    if (oldResult === 'refusal') first.reject(f.error('Old native refusal'));
    else first.resolve();
    await a;
    assert.equal(f.region().hidden, true);
    assert.equal(f.button.disabled, true);
    assert.deepEqual(f.focus, []);
    second.reject(f.error('Current native refusal'));
    await b;
    assert.ok(f.message().textContent.includes('Current native refusal'));
    assert.ok(!f.message().textContent.includes('Old native refusal'));
    assert.equal(f.button.disabled, false);
    assert.deepEqual(f.focus, ['settings-submit']);
    assert.deepEqual(f.toasts, []);
  });
test('an explicit next attempt clears a prior failure before awaiting its response', async () => {
  const f = workspaceFormUIFixture(),
    pending = deferred();
  let calls = 0;
  f.bind(async () => {
    if (++calls === 1) throw f.error();
    await pending.promise;
  });
  await f.submit();
  assert.equal(f.region().hidden, false);
  const completion = f.submit();
  assert.equal(f.region().hidden, true);
  assert.equal(f.message().textContent, '');
  assert.equal(f.form.getAttribute('aria-describedby'), null);
  assert.equal(f.button.disabled, true);
  pending.resolve();
  await completion;
  assert.equal(calls, 2);
  assert.equal(f.button.disabled, false);
  assert.deepEqual(f.toasts, []);
});
test('a successful form re-render retains the original focus restoration behavior', async () => {
  const f = workspaceFormUIFixture();
  f.bind(async () => {
    f.form.isConnected = false;
    f.button.isConnected = false;
    f.region().isConnected = false;
  });
  await f.submit();
  assert.deepEqual(f.focus, ['heading']);
  assert.deepEqual(f.toasts, []);
});
test('a current form refusal keeps focus on another connected control', async () => {
  const f = workspaceFormUIFixture();
  f.document.activeElement = f.other;
  f.bind(async () => {
    throw f.error();
  });
  await f.submit();
  assert.equal(f.region().hidden, false);
  assert.deepEqual(f.focus, []);
  assert.equal(f.document.activeElement, f.other);
});
test('shared feedback reuses its region and listeners and preserves existing control IDs', async () => {
  const f = workspaceFormUIFixture('en', {buttonId: 'existing-submit'});
  f.bind(async () => {
    throw f.error();
  });
  const a = f.run('workspaceFormFeedback(form)'),
    b = f.run('workspaceFormFeedback(form)');
  assert.equal(a, b);
  assert.equal(f.insertions.length, 1);
  assert.equal(f.form.listeners.get('input').length, 1);
  assert.equal(f.form.listeners.get('change').length, 1);
  await f.submit();
  assert.equal(f.button.id, 'existing-submit');
  assert.deepEqual(f.focus, ['existing-submit']);
});
test('a form without an ID or submit button still retains its current failure', async () => {
  const f = workspaceFormUIFixture('en', {formId: '', noButton: true});
  f.bind(async () => {
    throw f.error();
  });
  await f.submit();
  assert.match(f.form.id, /^workspace-form-/);
  assert.equal(f.region().hidden, false);
  assert.ok(f.form.getAttribute('aria-describedby').includes(f.region().id));
  assert.deepEqual(f.toasts, []);
});
test('a real superseded request keeps shared feedback hidden', async () => {
  const f = workspaceFormUIFixture();
  f.bind(async () => {
    throw f.superseded();
  });
  await f.submit();
  assert.equal(f.region().hidden, true);
  assert.equal(f.message().textContent, '');
  assert.deepEqual(f.toasts, []);
});
for (const context of ['current', 'navigation', 'identity', 'detached'])
  test(
    'a ' + context + ' non-form control retains its original toast policy with current identity guards',
    async () => {
      const f = workspaceFormUIFixture('en', {binding: 'button', buttonId: 'original-action'}),
        pending = deferred();
      f.bind(async () => await pending.promise);
      const completion = f.submit();
      if (context === 'navigation') f.run('navigationGeneration++');
      if (context === 'identity') f.run('identityGeneration++');
      if (context === 'detached') f.button.isConnected = false;
      pending.reject(f.error());
      await completion;
      assert.equal(f.insertions.length, 0);
      assert.equal(f.toasts.length, context === 'current' ? 1 : 0);
      assert.deepEqual(f.focus, context === 'current' ? ['original-action'] : []);
    },
  );
test('a callback with its own handled diagnostic does not produce a duplicate shared alert', async () => {
  const f = workspaceFormUIFixture();
  let ownDiagnostics = 0;
  f.bind(async () => {
    ownDiagnostics++;
  });
  await f.submit();
  assert.equal(ownDiagnostics, 1);
  assert.equal(f.region().hidden, true);
  assert.deepEqual(f.toasts, []);
});
