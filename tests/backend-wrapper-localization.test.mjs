import test from 'node:test';
import assert from 'node:assert/strict';
import {parsers} from 'prettier/plugins/babel';
import {backendContractSourceFiles, inspectBackendWrapperFailures, localeProblems} from '../tools/check-locales.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
  files = backendContractSourceFiles(),
  selected = files.map(file => ({file, messages: inspectBackendWrapperFailures(fs.readFileSync(file, 'utf8'), file)})),
  owned = new Set(selected.flatMap(row => [...row.messages]));
const file = 'src/wrapped.ts',
  imports = "import {MirrorError as Failure} from './errors.js';\n",
  wrapper = 'function fail(code:string,message:string){throw new Failure(code,message,{},400);}\n';
const inspect = (source, target = file) => [...inspectBackendWrapperFailures(source, target)].sort();
test('canonical runtime aliases qualify only a sole-throw helper static message argument', () => {
  assert.deepEqual(inspect(imports + wrapper + "fail('CODE','Authored explanation.');fail('CODE',native.message);"), [
    'Authored explanation.',
  ]);
});
test('multi-stage local forwarding preserves the actual parameter position and excludes transformed reasons', () => {
  const source =
    imports +
    wrapper +
    "function reject(message:string){return fail('CODE',message);}function forward(code:string,reason:string){reject(reason);}function altered(reason:string){reject(reason.trim());}forward('NATIVE','Forwarded authored explanation.');altered('Native transformation.');";
  assert.deepEqual(inspect(source), ['Forwarded authored explanation.']);
});
test('nested Windows paths resolve actual canonical source imports', () => {
  const source =
    imports.replace("'./errors.js'", "'../../errors.js'") + wrapper + "fail('CODE','Nested owned reason.');";
  assert.deepEqual(inspect(source, 'src\\nested\\deep\\wrapped.ts'), ['Nested owned reason.']);
  assert.deepEqual(inspect(source, 'server/nested/deep/wrapped.ts'), []);
});
test('type-only, default, namespace and unrelated constructors or imported helper calls remain unqualified', () => {
  for (const prefix of [
    "import type {MirrorError as Failure} from './errors.js';",
    "import Failure from './errors.js';",
    "import * as Failure from './errors.js';",
    "import {MirrorError as Failure} from './native.js';",
  ]) {
    assert.deepEqual(inspect(prefix + wrapper + "fail('CODE','Unowned reason.');"), []);
  }
  assert.deepEqual(inspect("import {fail} from './helper.js';fail('Native reason.');"), []);
});
test('constructor parameter shadows and callable parameter, block, catch, class and var shadows cannot author provider text', () => {
  const source =
    imports +
    wrapper +
    "function other(Failure:any,message:string){throw new Failure('CODE',message);}function parameter(fail:any){fail('X','Native parameter.');}function hoisted(){fail('X','Native var.');var fail=native;}try{}catch(fail){fail('X','Native catch.');}{let fail=native;fail('X','Native block.');}{class fail{};fail('X','Native class.');}const named=function fail(){fail('X','Native named expression.');};for(let fail of native){fail('X','Native loop.');}fail('X','Outside owned reason.');other(native,'Native constructor.');";
  assert.deepEqual(inspect(source), ['Outside owned reason.']);
});
test('global assignment, destructuring, update or loop reassignment invalidates helper ownership and its forwarders', () => {
  for (const assignment of ['fail=native;', '[fail]=native;', 'fail++;', 'for(fail of native){}'])
    assert.deepEqual(
      inspect(
        imports +
          wrapper +
          "function forward(message:string){fail('X',message);}" +
          assignment +
          "fail('X','Unowned mutable reason.');forward('Unowned forwarded reason.');",
      ),
      [],
    );
});
test('an assignment to a shadowed parameter does not disqualify the outer owned helper', () => {
  assert.deepEqual(
    inspect(
      imports +
        wrapper +
        "function nativeScope(fail:any){fail=native;fail('X','Native parameter.');}fail('X','Outer owned reason.');",
    ),
    ['Outer owned reason.'],
  );
});
test('a reassigned forwarder is excluded without disqualifying its canonical direct helper', () => {
  assert.deepEqual(
    inspect(
      imports +
        wrapper +
        "function forward(message:string){fail('X',message);}forward=native;forward('Native reassigned forwarder.');fail('X','Direct owned reason.');",
    ),
    ['Direct owned reason.'],
  );
});
test('wrapper parameter shadows prevent forwarder qualification', () => {
  assert.deepEqual(
    inspect(
      imports +
        wrapper +
        "function forward(fail:any,reason:string){return fail('X',reason);}forward(native,'Native shadowed forwarder.');",
    ),
    [],
  );
});
test('member calls, dynamic messages, aliases, arrow helpers and multiple-statement helpers stay outside this qualified scope', () => {
  const source =
    imports +
    wrapper +
    "const alias=fail;const arrow=(m:string)=>{throw new Failure('X',m);};function larger(m:string){before();throw new Failure('X',m);}object.fail('X','Native member.');alias('X','Alias reason.');arrow('Arrow reason.');larger('Larger reason.');fail('X',native.message);fail('X',`dynamic ${native.message}`);";
  assert.deepEqual(inspect(source), []);
});
test('an existing constructor sentence cannot collide with an ownership probe for an unrelated helper', () => {
  const prefix = imports + "function nativeFail(message:string){throw new NativeFailure('X',message);}";
  const fn = parsers['babel-ts'].parse(prefix).program.body[1];
  const collision = '__AMCP_LOCAL_WRAPPER_' + fn.start + '__';
  const source = prefix + "new Failure('X'," + JSON.stringify(collision) + ");nativeFail('Unowned collision reason.');";
  assert.deepEqual(inspect(source), []);
});
test('unsafe/private, absolute or absent source paths refuse before parsing arbitrary source text', () => {
  for (const target of [
    null,
    undefined,
    'C:/private.ts',
    '../src/file.ts',
    '.mirror/PRIVATE/file.ts',
    'tests/file.ts',
    'src/../server/file.ts',
    'src/file.js',
  ])
    assert.deepEqual([...inspectBackendWrapperFailures('not valid code', target)], []);
});
test('ownership inspection never executes authored calls, native functions or global mutations', () => {
  assert.equal(globalThis.__amcp_wrapper_probe, undefined);
  const source =
    imports + wrapper + "globalThis.__amcp_wrapper_probe=1;native.write();fail('X','Unexecuted authored reason.');";
  assert.deepEqual(inspect(source), ['Unexecuted authored reason.']);
  assert.equal(globalThis.__amcp_wrapper_probe, undefined);
});

test('spread calls cannot pretend a static argument occupies the canonical message position', () => {
  const source =
    imports +
    wrapper +
    "fail(...native,'Unqualified shifted reason.');fail('X','Unqualified trailing spread.',...native);fail('X','Exact owned reason.');";
  assert.deepEqual(inspect(source), ['Exact owned reason.']);
});
test('spread forwarding helpers cannot qualify their static callers through unknown argument positions', () => {
  const source =
    imports +
    wrapper +
    "function forward(message:string){return fail(...native,message);}function tail(message:string){return fail('X',message,...native);}forward('Unqualified forwarded spread.');tail('Unqualified trailing forwarded spread.');fail('X','Direct exact reason.');";
  assert.deepEqual(inspect(source), ['Direct exact reason.']);
});

test('all actual qualified wrapper reasons have Arabic while native fields, limits and examples remain exact', () => {
  assert.equal(files.length, 519);
  assert.equal(selected.filter(row => row.messages.size).length, 172);
  assert.equal(owned.size, 2679);
  assert.equal(Object.keys(catalog).length, 10062);
  assert.deepEqual(localeProblems(catalog, owned), []);
  const rephrased = 'requestMetaData names only the ad account: {sponsoredAccountUrn: "urn:li:sponsoredAccount:<id>"}.';
  for (const message of owned) {
    const translated = catalog[message];
    assert.match(translated, /[\u0600-\u06ff]/u);
    assert.notEqual(translated, message);
    for (const token of new Set(message.match(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g) ?? []))
      assert.ok(translated.includes(token), 'Original native field ' + token);
    for (const bound of new Set(message.match(/\b\d[\d,]*(?:\.\d+)?\b/g) ?? []))
      assert.ok(translated.includes(bound), 'Original quantity ' + bound);
    const stack = [];
    for (let i = 0; i < message.length; i++) {
      if (message[i] === '{') stack.push(i);
      if (message[i] === '}' && stack.length) {
        const example = message.slice(stack.pop(), i + 1);
        if (message === rephrased && example.includes('<id>')) {
          for (const token of ['requestMetaData', 'sponsoredAccountUrn', 'urn:li:sponsoredAccount:'])
            assert.ok(translated.includes(token));
          assert.doesNotMatch(translated, /[<>]/);
        } else assert.ok(translated.includes(example), 'Original native example ' + example);
      }
    }
  }
  assert.equal(owned.has(rephrased), true);
  for (const [message, tokens] of [
    ['Give exactly one of type (similarity or reach) and ratio.', ['type', 'similarity', 'reach', 'ratio']],
    ['Expected the reviewed CSV_STRING stream, not JSON, an error or a signed download URL.', ['CSV_STRING', 'JSON']],
  ]) {
    assert.equal(owned.has(message), true);
    for (const token of tokens) assert.ok(catalog[message].includes(token));
  }
  assert.equal(owned.has('Claim into the selected ad account.'), true);
  assert.match(catalog['Claim into the selected ad account.'], /claim/);
  assert.equal(owned.has('Store credentials through Connections, not workspace documents.'), true);
  assert.match(catalog['Store credentials through Connections, not workspace documents.'], /«الاتصالات»/);
});
test('future nested sole-throw helpers are discovered and their missing Arabic is refused without executing source', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-wrapper-locale-'));
  const records = {
    'src/errors.ts': 'export class MirrorError extends Error {}',
    'src/future.ts':
      "import {MirrorError} from './errors.js';function fail(reason:string){throw new MirrorError('CODE',reason);}fail('Future wrapper reason.');",
    'server/new/routes.ts':
      "import {MirrorError as Failure} from '../../src/errors.js';function deny(code:string,reason:string){throw new Failure(code,reason);}function forward(reason:string){return deny('CODE',reason);}forward('Future forwarded server reason.');",
  };
  try {
    for (const [file, source] of Object.entries(records)) {
      const target = path.join(temporary, file);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, source);
    }
    const discovered = backendContractSourceFiles(temporary);
    assert.deepEqual(discovered, ['server/new/routes.ts', 'src/errors.ts', 'src/future.ts']);
    const messages = new Set(
      discovered.flatMap(file => [
        ...inspectBackendWrapperFailures(fs.readFileSync(path.join(temporary, file), 'utf8'), file),
      ]),
    );
    assert.deepEqual(localeProblems(catalog, messages), [
      'Missing Arabic message: Future forwarded server reason.',
      'Missing Arabic message: Future wrapper reason.',
    ]);
  } finally {
    for (const file of Object.keys(records)) fs.unlinkSync(path.join(temporary, file));
    for (const directory of ['server/new', 'server', 'src']) fs.rmdirSync(path.join(temporary, directory));
    fs.rmdirSync(temporary);
  }
});
for (const locale of ['en', 'ar'])
  test(
    'actual ' + locale + ' wrapper formatter preserves every original machine value and reference without calls',
    () => {
      const fixture = accountWorkflowFixture(locale);
      for (const message of owned) {
        const result = errorResult(
            new MirrorError(
              'ORIGINAL_WRAPPER_CODE',
              message,
              {
                native_id: '9007199254740993',
                account_urn: 'urn:li:adAccount:9007199254740993',
                currency_code: 'SAR',
                daily_budget: '0012.3400',
                native_name: 'Original <img> campaign',
                original_false: false,
              },
              409,
              false,
            ),
            'original-wrapper-reference',
            0,
          ),
          before = JSON.stringify(result);
        fixture.context.response = result;
        fixture.context.error = fixture.run('requestError(response)');
        const displayed = fixture.run('errorMessage(error)');
        assert.ok(displayed.includes(locale === 'ar' ? catalog[message] : message));
        assert.ok(displayed.includes('original-wrapper-reference'));
        assert.equal(fixture.context.error.code, 'ORIGINAL_WRAPPER_CODE');
        assert.equal(fixture.context.error.message, message);
        assert.equal(fixture.context.error.details, result.error.details);
        assert.equal(result.error.retryable, false);
        assert.equal(result.error.remedy.mutation_retry_safe, false);
        assert.equal(JSON.stringify(result), before);
      }
      for (const message of [
        'Unrecognized native wrapper sentence 00123',
        '9007199254740993',
        'urn:li:adAccount:9007199254740993',
      ]) {
        assert.equal(Object.hasOwn(catalog, message), false);
        fixture.context.response = errorResult(
          new MirrorError('NATIVE_UNCHANGED', message),
          'original-native-reference',
          0,
        );
        const before = JSON.stringify(fixture.context.response);
        fixture.context.error = fixture.run('requestError(response)');
        assert.ok(fixture.run('errorMessage(error)').includes(message));
        assert.equal(JSON.stringify(fixture.context.response), before);
      }
      assert.equal(fixture.calls.length, 0);
      assert.equal(fixture.visits.length, 0);
    },
  );
