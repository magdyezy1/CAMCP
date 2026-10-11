import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parsers} from 'prettier/plugins/babel';
import {
  inspectMeasurementFailures,
  inspectMeasurementRemedies,
  inspectProviderCaptureRemedies,
  inspectGoogleCaptureRemedies,
  localeProblems,
} from '../tools/check-locales.mjs';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {assertWebsiteRemedy} from './fixtures/website-remedy.mjs';
const files = ['src/measurement-events.ts', 'src/measurement-event-identity.ts', 'src/gtm-consent-evidence.ts'],
  catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
function ownedCodes() {
  const values = [];
  for (const file of files) {
    const walk = n => {
      if (!n || typeof n !== 'object') return;
      if (file.endsWith('gtm-consent-evidence.ts')) {
        if (n.type === 'NewExpression' && n.callee?.name === 'MirrorError' && n.arguments[1]?.type === 'StringLiteral')
          values.push({message: n.arguments[1].value, code: n.arguments[0].value});
      } else if (
        n.type === 'CallExpression' &&
        ['bad', 'invalid'].includes(n.callee?.name) &&
        n.arguments[0]?.type === 'StringLiteral'
      )
        values.push({
          message: n.arguments[0].value,
          code:
            n.callee.name === 'invalid'
              ? file.endsWith('measurement-events.ts')
                ? 'MEASUREMENT_EVIDENCE_INVALID'
                : 'MEASUREMENT_IDENTITY_INVALID'
              : n.arguments[1]?.type === 'StringLiteral'
                ? n.arguments[1].value
                : 'INVALID_ARGUMENT',
        });
      for (const [key, value] of Object.entries(n))
        if (!['loc', 'extra', 'comments', 'tokens'].includes(key))
          for (const child of Array.isArray(value) ? value : [value]) walk(child);
    };
    walk(parsers['babel-ts'].parse(readFileSync(file, 'utf8')));
  }
  return values;
}
test('measurement refusal ownership is exact by source, helper and literal argument position', () => {
  const sample =
    "bad('Owned argument.','NATIVE_CODE'); invalid('Owned response.'); new MirrorError('OWNED_CODE','Owned metadata.'); bad(native.message??'Fallback.'); invalid('Account '+nativeId); invalid(ready?'Conditional.':native.message); native.invalid('Native method.'); new Native.MirrorError('CODE','Native constructor.'); new MirrorError('CODE',native.message??'Native fallback.');";
  for (const file of files) {
    const expected = file.endsWith('gtm-consent-evidence.ts')
      ? ['Owned metadata.']
      : ['Owned argument.', 'Owned response.'];
    assert.deepEqual([...inspectMeasurementFailures(sample, file)], expected);
    assert.deepEqual([...inspectMeasurementFailures(sample, file.replaceAll('/', '\\'))], expected);
  }
  for (const file of ['src/measurement.ts', 'tests/measurement-events.ts', 'src/other-measurement-event-identity.ts'])
    assert.equal(inspectMeasurementFailures(sample, file).size, 0);
});
test('all 34 selected measurement refusal sentences and the two persistent feedback labels have authored Arabic', () => {
  const messages = new Set(files.flatMap(file => [...inspectMeasurementFailures(readFileSync(file, 'utf8'), file)]));
  assert.equal(messages.size, 34);
  for (const label of ['Read needs attention', 'Review the message and your settings before reading again.'])
    messages.add(label);
  assert.deepEqual(localeProblems(catalog, messages), []);
  for (const message of messages) {
    assert.match(catalog[message], /[\u0600-\u06ff]/);
    assert.notEqual(catalog[message], message);
  }
});
test('measurement remedy selector adds only the four reachable owned hints and preserves earlier collector selectors', () => {
  const source = readFileSync('src/errors.ts', 'utf8'),
    google = inspectGoogleCaptureRemedies(source, 'src/errors.ts'),
    providers = inspectProviderCaptureRemedies(source, 'src/errors.ts'),
    measurement = inspectMeasurementRemedies(source, 'src/errors.ts');
  assert.equal(google.size, 5);
  assert.equal(providers.size, 8);
  assert.equal(measurement.size, 12);
  assert.deepEqual(
    new Set([...measurement].filter(value => !providers.has(value))),
    new Set([
      'Correct the value the message names and send the call again (a write is prepared again).',
      ...Object.keys({
        'Correct what the message names and send the call again (a write is prepared again). A write whose outcome is uncertain is never resubmitted.':
          'صحّح ما تسمّيه الرسالة وأرسل الطلب مجددًا؛ إذا كان طلب كتابة، فتُحضّر الكتابة من جديد. لا تُعِد إرسال كتابة لا تُعرف نتيجتها.',
        'The current state is larger than one review can compare. Narrow the request to fewer objects or explicit IDs.':
          'تتجاوز الحالة الحالية ما يمكن مقارنته في مراجعة واحدة. حدّد الطلب بعدد أقل من العناصر أو بمعرّفات صريحة.',
        'The provider returned a different object, parent or account than the request names. Check that every ID belongs to the selected account and connection, then send the corrected call.':
          'أرجعت المنصة عنصرًا أو عنصرًا أصليًا أو حسابًا يختلف عمّا يحدّده الطلب. تحقّق من أن كل معرّف يتبع الحساب والاتصال المحدّدين، ثم أرسل الطلب المصحّح.',
      }),
    ]),
  );
  assert.deepEqual(localeProblems(catalog, measurement), []);
  const sample =
    "function familyRemedy(code){if(/_INVALID$/.test(code))return r('request','Owned value hint.');if(code==='NATIVE_INVALID')return r('native','Native exact hint.');} function other(){if(/_INVALID$/.test(code))return r('request','Other hint.');}";
  assert.deepEqual([...inspectMeasurementRemedies(sample, 'src/errors.ts')], ['Owned value hint.']);
  assert.equal(inspectProviderCaptureRemedies(sample, 'src/errors.ts').size, 0);
  assert.equal(inspectMeasurementRemedies(sample, 'src/native-errors.ts').size, 0);
  const metadata =
    "function errorRemedy(e){const stateRead={STATE_TOO_LARGE:'Owned bound.',STATE_TARGET_MISMATCH:'Owned identity.',STATE_NOT_FOUND:'Unselected state.',NATIVE_CODE:'Native hint.'};const other={STATE_TOO_LARGE:'Unrelated lookup.'};return {action:e.code==='INTERNAL_ERROR'?'Unselected internal.':'Owned final fallback.'};}";
  assert.deepEqual(
    [...inspectMeasurementRemedies(metadata, 'src/errors.ts')],
    ['Owned bound.', 'Owned identity.', 'Owned final fallback.'],
  );
  const dynamic =
    "function errorRemedy(e){const stateRead={STATE_TOO_LARGE:upstream.message};return {action:e.code==='INTERNAL_ERROR'?'Internal.':upstream.message??'Native fallback.'};}";
  assert.equal(inspectMeasurementRemedies(dynamic, 'src/errors.ts').size, 0);
});
test('all 36 source occurrences format bilingual authored reasons and reachable hints without changing native envelopes', () => {
  const values = ownedCodes(),
    hints = inspectMeasurementRemedies(readFileSync('src/errors.ts', 'utf8'), 'src/errors.ts'),
    reached = new Set();
  assert.equal(values.length, 36);
  assert.equal(new Set(values.map(value => value.message)).size, 34);
  for (const locale of ['en', 'ar']) {
    const f = accountWorkflowFixture(locale);
    for (const {message, code} of values) {
      const response = errorResult(
          new MirrorError(code, message, {
            property_id: '00123',
            stream_id: '00900',
            event_count: '9007199254740993',
            native_dimension: 'UNKNOWN',
          }),
          'synthetic-measurement-reference',
          0,
        ),
        before = JSON.stringify(response);
      assert.equal(response.error.remedy.mutation_retry_safe, false);
      reached.add(response.error.next_action);
      assert.ok(hints.has(response.error.next_action));
      f.context.response = response;
      const error = f.run('requestError(response)');
      assert.equal(error.message, message);
      assert.equal(error.code, code);
      assert.equal(error.details, response.error.details);
      f.context.error = error;
      const display = f.run('errorMessage(error)');
      assert.ok(display.includes(locale === 'ar' ? catalog[message] : message));
      // WEB-03: a hint written for an MCP client gives way to the website's own wording.
      assertWebsiteRemedy(
        f,
        display,
        response.error.next_action,
        locale === 'ar' ? catalog[response.error.next_action] : response.error.next_action,
      );
      assert.ok(display.includes('synthetic-measurement-reference'));
      assert.equal(JSON.stringify(response), before);
    }
  }
  assert.ok(reached.has('Correct the value the message names and send the call again (a write is prepared again).'));
});
test('near matching and unknown native measurement diagnostics stay literal and superseded requests stay silent', () => {
  for (const locale of ['en', 'ar']) {
    const f = accountWorkflowFixture(locale);
    for (const message of [
      'Native <img> failure 00123',
      'GA4 returned duplicate event/minute/stream rows. Native says X',
    ]) {
      const response = {
          success: false,
          error: {
            code: 'NATIVE_CODE',
            message,
            next_action: 'Native hint 00123',
            details: {native_id: '9007199254740993'},
          },
          meta: {requestId: 'literal-reference'},
        },
        before = JSON.stringify(response);
      f.context.response = response;
      f.context.error = f.run('requestError(response)');
      assert.ok(f.run('errorMessage(error)').includes(message));
      assert.equal(f.context.error.details.native_id, '9007199254740993');
      assert.equal(JSON.stringify(response), before);
    }
    f.context.error = f.run('supersededRequest()');
    f.context.error.message = 'Obsolete native diagnostic';
    assert.equal(f.run('errorMessage(error)'), '');
  }
});
test('MSR-03 review fix: the measurement ledger response refusals are owned sentences with Arabic', () => {
  // Regression: only bad() was registered for the ledger, so its invalid() refusals (MEASUREMENT_LEDGER_INVALID) reached
  // the website in English.
  const messages = inspectMeasurementFailures(
    readFileSync('src/measurement-ledger.ts', 'utf8'),
    'src/measurement-ledger.ts',
  );
  for (const message of [
    'The measurement ledger layers are incomplete.',
    'Measurement pagination was malformed, repeated or incomplete.',
    'Google Ads returned the same conversion action twice.',
  ])
    assert.ok(messages.has(message), message);
  assert.deepEqual(localeProblems(catalog, messages), []);
  for (const message of messages) assert.match(catalog[message], /[؀-ۿ]/);
});
