import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {parsers} from 'prettier/plugins/babel';
import {inspectReportingFailures, inspectProviderCaptureRemedies, localeProblems} from '../tools/check-locales.mjs';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {assertWebsiteRemedy} from './fixtures/website-remedy.mjs';
const collectors = {
  'src/meta-evidence.ts': 16,
  'src/linkedin-evidence.ts': 6,
  'src/tiktok-reporting.ts': 15,
  'src/snapchat-evidence.ts': 38,
};
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
function formatter(locale) {
  const context = createContext({catalog, document: {addEventListener() {}}, Intl, Date});
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(
    'uiLocale=' +
      JSON.stringify(locale) +
      ';uiMessages=new Map(' +
      (locale === 'ar' ? 'Object.entries(catalog)' : '[]') +
      ');',
  );
  const app = readFileSync('web/app.js', 'utf8'),
    start = app.indexOf('function requestError('),
    end = app.indexOf("const content = $('#content')", start);
  assert.ok(start >= 0 && end > start);
  run(app.slice(start, end));
  return {context, run};
}
function ownedCodes() {
  const values = [];
  for (const file of Object.keys(collectors)) {
    const names = file.endsWith('snapchat-evidence.ts') ? ['bad', 'incomplete', 'shape'] : ['bad', 'incomplete'];
    const walk = n => {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'CallExpression' && names.includes(n.callee?.name) && n.arguments[0]?.type === 'StringLiteral')
        values.push({
          message: n.arguments[0].value,
          code:
            n.callee.name === 'incomplete'
              ? 'REPORT_INCOMPLETE'
              : n.callee.name === 'shape'
                ? 'REPORT_SHAPE_CHANGED'
                : n.arguments[1]?.type === 'StringLiteral'
                  ? n.arguments[1].value
                  : 'INVALID_ARGUMENT',
        });
      for (const [k, v] of Object.entries(n))
        if (!['loc', 'extra', 'comments', 'tokens'].includes(k))
          for (const child of Array.isArray(v) ? v : [v]) walk(child);
    };
    walk(parsers['babel-ts'].parse(readFileSync(file, 'utf8')));
  }
  return values;
}

test('provider refusal ownership includes exact collector literals and only Snapchat shape, excluding native expressions and other files', () => {
  const sample =
    "bad('Owned refusal.','NATIVE_CODE'); incomplete('Owned completion.'); shape('Owned Snapchat shape.'); bad(upstream.message??'Fallback.'); incomplete('Account '+nativeId); shape(ready?'Conditional.':upstream.message); upstream.bad('Native object method.');";
  for (const file of Object.keys(collectors)) {
    const expected = [
      'Owned refusal.',
      'Owned completion.',
      ...(file.endsWith('snapchat-evidence.ts') ? ['Owned Snapchat shape.'] : []),
    ];
    assert.deepEqual([...inspectReportingFailures(sample, file)], expected);
    assert.deepEqual([...inspectReportingFailures(sample, file.replaceAll('/', '\\'))], expected);
  }
  for (const file of [
    'src/meta-reporting.ts',
    'src/other-meta-evidence.ts',
    'tests/tiktok-reporting.ts',
    'src/snapchat-reporting.ts',
  ])
    assert.equal(inspectReportingFailures(sample, file).size, 0);
});

test('all 75 selected provider refusal sentences have authored Arabic without codes or native fallbacks', () => {
  let count = 0;
  for (const [file, expected] of Object.entries(collectors)) {
    const messages = inspectReportingFailures(readFileSync(file, 'utf8'), file);
    assert.equal(messages.size, expected);
    assert.deepEqual(localeProblems(catalog, messages), []);
    for (const message of messages) {
      assert.match(catalog[message], /[\u0600-\u06ff]/);
      assert.notEqual(catalog[message], message);
      assert.ok(!message.startsWith('REPORT_'));
    }
    count += messages.size;
  }
  assert.equal(count, 75);
});

test('additional capture remedy ownership selects required, argument and scope hints without dynamic or unrelated families', () => {
  const source =
    "function familyRemedy(code){if(/_REQUIRED$/.test(code))return r('request','Owned required hint.');if(/_INVALID$/.test(code))return r('request','Unselected value hint.');if(/REPORT/.test(code))return r('report',upstream.message);} export function errorRemedy(e){if(/^(INVALID|MISSING|CONFLICTING|UNSUPPORTED|UNKNOWN)_/.test(e.code))return {action:'Owned argument hint.'};if(e.code==='OTHER')return {action:'Unrelated hint.'};} export function errorResult(e){const remediation={INSUFFICIENT_SCOPE:'Owned scope hint.',NATIVE_CODE:'Native hint.'};} function other(){if(/_REQUIRED$/.test(code))return r('request','Unrelated function hint.');}";
  assert.deepEqual(
    [...inspectProviderCaptureRemedies(source, 'src/errors.ts')],
    ['Owned required hint.', 'Owned argument hint.', 'Owned scope hint.'],
  );
  assert.equal(inspectProviderCaptureRemedies(source, 'src/provider-errors.ts').size, 0);
});

test('all actual selected refusal codes format in English and Arabic with authored hints and unchanged structured retry semantics', () => {
  const values = ownedCodes(),
    remedies = inspectProviderCaptureRemedies(readFileSync('src/errors.ts', 'utf8'), 'src/errors.ts');
  assert.equal(values.length, 76);
  assert.equal(new Set(values.map(value => value.message)).size, 75);
  assert.equal(remedies.size, 8);
  assert.deepEqual(localeProblems(catalog, remedies), []);
  const reached = new Set();
  for (const locale of ['en', 'ar']) {
    const f = formatter(locale);
    for (const {message, code} of values) {
      const response = errorResult(
          new MirrorError(code, message, {
            account_id: '00100',
            spend: '9007199254.740993',
            native_match_type: 'UNKNOWN',
          }),
          'synthetic-provider-reference',
          0,
        ),
        before = JSON.stringify(response);
      assert.equal(response.error.remedy.mutation_retry_safe, false);
      reached.add(response.error.next_action);
      assert.ok(Object.hasOwn(catalog, response.error.next_action));
      f.context.response = response;
      const error = f.run('requestError(response)');
      assert.equal(error.message, message);
      assert.equal(error.code, code);
      assert.equal(error.details, response.error.details);
      f.context.error = error;
      const display = f.run('errorMessage(error)');
      assert.ok(display.includes(locale === 'ar' ? catalog[message] : message));
      // WEB-03: a hint written for an MCP client ("send the call again") gives way to the website's own wording.
      assertWebsiteRemedy(
        f,
        display,
        response.error.next_action,
        locale === 'ar' ? catalog[response.error.next_action] : response.error.next_action,
      );
      assert.ok(display.includes('synthetic-provider-reference'));
      assert.equal(JSON.stringify(response), before);
    }
  }
  assert.deepEqual([...reached].sort(), [...remedies].sort());
});

test('unknown native diagnostics and changed source text remain literal while obsolete errors stay silent', () => {
  for (const locale of ['en', 'ar']) {
    const f = formatter(locale);
    for (const message of [
      'Native <img> failure 00100',
      'Meta did not return the exact selected advertising account. Provider says X',
    ]) {
      const response = {
          success: false,
          error: {
            code: 'NATIVE_CODE',
            message,
            next_action: 'Native hint 00100',
            details: {native_id: '9007199254740993'},
          },
          meta: {requestId: 'literal-reference'},
        },
        before = JSON.stringify(response);
      f.context.response = response;
      const error = f.run('requestError(response)');
      f.context.error = error;
      assert.ok(f.run('errorMessage(error)').includes(message));
      assert.equal(error.details.native_id, '9007199254740993');
      assert.equal(JSON.stringify(response), before);
    }
    f.context.error = f.run('supersededRequest()');
    f.context.error.message = 'Obsolete native diagnostic';
    assert.equal(f.run('errorMessage(error)'), '');
  }
});
