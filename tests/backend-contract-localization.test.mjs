import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {backendContractSourceFiles, inspectBackendContractFailures, localeProblems} from '../tools/check-locales.mjs';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
const files = backendContractSourceFiles();
const selected = files.map(file => ({
  file,
  messages: inspectBackendContractFailures(fs.readFileSync(file, 'utf8'), file),
}));
const owned = new Set(selected.flatMap(row => [...row.messages]));

test('backend diagnostics resolve canonical runtime imports in new and nested sources with lexical ownership intact', () => {
  const source = [
    "import {MirrorError as Owned} from '../../src/errors.js';",
    "import {MirrorError as Other} from '../../src/./errors.js';",
    "new Owned('CODE', 'Future nested reason.');",
    "new Other(native.code, 'Another canonical import.');",
    "new Owned('CODE', 'Future nested reason.');",
    "new Owned('CODE', native.message ?? 'Native fallback.');",
    "new Owned('CODE', 'Dynamic ' + native.message);",
    "new native.Owned('CODE', 'Native member.');",
    "function parameter(Owned){new Owned('CODE','Parameter shadow.');}",
    "function local(){const Owned=native.Error;new Owned('CODE','Local shadow.');}",
    "function unpack({Owned}){new Owned('CODE','Destructured shadow.');}",
    "try{}catch(Owned){new Owned('CODE','Catch shadow.');}",
    "for(let Owned of native.values){new Owned('CODE','Loop shadow.');}",
    "const value=class Owned{run(){new Owned('CODE','Named class shadow.');}};",
    "const result={message:'Provider message.',name:'Native name'};",
  ].join('\n');
  for (const file of ['server/new/routes.ts', 'server\\new\\routes.ts'])
    assert.deepEqual(
      [...inspectBackendContractFailures(source, file)],
      ['Future nested reason.', 'Another canonical import.'],
    );
  for (const file of ['src/new-contract.ts', 'src\\new-contract.ts'])
    assert.deepEqual(
      [
        ...inspectBackendContractFailures(
          "import {MirrorError as Alias} from './errors.js';new Alias('CODE','New file reason.');",
          file,
        ),
      ],
      ['New file reason.'],
    );
});

test('backend ownership rejects paths outside source roots, type imports, unrelated errors, wrappers and dynamic native reasons', () => {
  const source = "import {MirrorError} from './errors.js';new MirrorError('CODE','Owned reason.');";
  for (const file of [
    undefined,
    null,
    1,
    'src/../server/file.ts',
    'src//file.ts',
    './src/file.ts',
    '/src/file.ts',
    'C:\\src\\file.ts',
    'tests/file.ts',
    'src/file.js',
    'src/./file.ts',
    'src/../../private.ts',
  ])
    assert.deepEqual([...inspectBackendContractFailures(source, file)], []);
  for (const source of [
    "new MirrorError('CODE','Unresolved.');",
    "import {MirrorError} from './native-errors.js';new MirrorError('CODE','Unrelated.');",
    "import {MirrorError} from 'native-errors';new MirrorError('CODE','External.');",
    "import type {MirrorError} from './errors.js';new MirrorError('CODE','Type import.');",
    "import {type MirrorError} from './errors.js';new MirrorError('CODE','Type specifier.');",
    "import {MirrorError} from './errors.js';bad('Wrapper sentence.');new MirrorError('CODE',native.message??'Fallback sentence.');",
    "import * as Errors from './errors.js';new Errors.MirrorError('CODE','Namespace member.');",
    "import MirrorError from './errors.js';new MirrorError('CODE','Default import.');",
  ])
    assert.deepEqual([...inspectBackendContractFailures(source, 'src/new-contract.ts')], []);
});

test('source discovery automatically includes future nested TypeScript files and refuses their missing Arabic before publication', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-backend-locale-'));
  const records = {
    'src/errors.ts': 'export class MirrorError extends Error {}',
    'src/future.ts':
      "import {MirrorError} from './errors.js';new MirrorError('CODE','Future undiscovered source reason.');",
    'src/models/row.ts': 'export type Row = {name:string};',
    'server/new/routes.ts':
      "import {MirrorError} from '../../src/errors.js';new MirrorError('CODE','Future nested server reason.');",
    'src/not-source.json': '{}',
    'tests/native.ts': "throw new Error('External test text.');",
  };
  try {
    for (const [file, source] of Object.entries(records)) {
      const target = path.join(temporary, file);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, source);
    }
    const discovered = backendContractSourceFiles(temporary);
    assert.deepEqual(discovered, ['server/new/routes.ts', 'src/errors.ts', 'src/future.ts', 'src/models/row.ts']);
    const messages = new Set(
      discovered.flatMap(file => [
        ...inspectBackendContractFailures(fs.readFileSync(path.join(temporary, file), 'utf8'), file),
      ]),
    );
    assert.deepEqual(localeProblems(catalog, messages), [
      'Missing Arabic message: Future nested server reason.',
      'Missing Arabic message: Future undiscovered source reason.',
    ]);
  } finally {
    for (const file of Object.keys(records)) fs.unlinkSync(path.join(temporary, file));
    for (const directory of ['src/models', 'server/new', 'src', 'server', 'tests'])
      fs.rmdirSync(path.join(temporary, directory));
    fs.rmdirSync(temporary);
  }
});

test('all actual directly owned backend reasons have Arabic with original native fields and numeric limits preserved', () => {
  assert.equal(files.length, 501);
  assert.equal(selected.filter(row => row.messages.size).length, 198);
  assert.equal(owned.size, 1420);
  assert.equal(Object.keys(catalog).length, 9267);
  assert.deepEqual(localeProblems(catalog, owned), []);
  for (const message of owned) {
    const translated = catalog[message];
    assert.match(translated, /[\u0600-\u06ff]/u);
    assert.notEqual(translated, message);
    for (const token of new Set(message.match(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g) ?? []))
      assert.ok(translated.includes(token), 'Original native field ' + token);
    for (const bound of new Set(message.match(/\b\d[\d,]*(?:\.\d+)?\b/g) ?? [])) {
      if (message === 'Use a name between 1 and 80 characters.' && bound === '1')
        assert.ok(translated.includes('حرف واحد'), 'Existing worded minimum remains one character');
      else assert.ok(translated.includes(bound), 'Original quantity ' + bound);
    }
  }
  for (const [message, tokens] of [
    [
      'Install FFmpeg and ffprobe, or configure AMCP_FFMPEG_PATH and AMCP_FFPROBE_PATH.',
      ['FFmpeg', 'ffprobe', 'AMCP_FFMPEG_PATH', 'AMCP_FFPROBE_PATH'],
    ],
    ['AccountId must match account_id.', ['AccountId', 'account_id']],
    ['New Microsoft entities require Status: Paused.', ['Status: Paused']],
    [
      'Choose square, portrait, vertical or landscape, with contain or crop.',
      ['square', 'portrait', 'vertical', 'landscape', 'contain', 'crop'],
    ],
    [
      'Use amcp_write prepare and execute; caller-supplied before_state is not a verified snapshot.',
      ['amcp_write', 'prepare', 'execute', 'before_state'],
    ],
    ['Live execution must explicitly set dry_run=false.', ['dry_run=false']],
    ['Declare regulated_content explicitly as a boolean.', ['regulated_content']],
    ['Server parsing supports Csv and Tsv reports; submit another report in one of those formats.', ['Csv', 'Tsv']],
    [
      'A reviewed creative may set destination_spec only to {destination_type: WEBSITE_AND_SHOP_OPT_OUT}, which keeps it off the shop.',
      ['destination_spec', 'destination_type', 'WEBSITE_AND_SHOP_OPT_OUT'],
    ],
    ['MIRROR_MASTER_KEY must encode exactly 32 random bytes.', ['MIRROR_MASTER_KEY', '32']],
    [
      'LinkedIn-Version must be a monthly YYYYMM version. Verify that the chosen version is supported by LinkedIn.',
      ['LinkedIn-Version', 'YYYYMM'],
    ],
    [
      'Use native JSON arrays/objects or a well-formed REST.li List/record. Encode reserved punctuation inside scalar values.',
      ['JSON', 'REST.li', 'List', 'record'],
    ],
  ])
    for (const token of tokens) assert.ok(catalog[message].includes(token), 'Original protocol token ' + token);
});

for (const locale of ['en', 'ar'])
  test(
    'actual ' +
      locale +
      ' backend formatter preserves raw native values, uncertainty and original reference for every selected reason',
    () => {
      const fixture = accountWorkflowFixture(locale);
      for (const message of owned) {
        const result = errorResult(
          new MirrorError(
            'ORIGINAL_BACKEND_CODE',
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
          'original-backend-reference',
          0,
        );
        const before = JSON.stringify(result);
        fixture.context.response = result;
        fixture.context.error = fixture.run('requestError(response)');
        const displayed = fixture.run('errorMessage(error)');
        assert.ok(displayed.includes(locale === 'ar' ? catalog[message] : message));
        assert.ok(displayed.includes('original-backend-reference'));
        assert.equal(fixture.context.error.code, 'ORIGINAL_BACKEND_CODE');
        assert.equal(fixture.context.error.message, message);
        assert.equal(fixture.context.error.details, result.error.details);
        assert.equal(result.error.retryable, false);
        assert.equal(result.error.remedy.mutation_retry_safe, false);
        assert.equal(JSON.stringify(result), before);
      }
      for (const message of [
        'Unrecognized provider sentence 00123',
        '9007199254740993',
        'urn:li:adAccount:9007199254740993',
      ]) {
        assert.equal(Object.hasOwn(catalog, message), false);
        const result = errorResult(new MirrorError('NATIVE_UNCHANGED', message), 'original-native-reference', 0),
          before = JSON.stringify(result);
        fixture.context.response = result;
        fixture.context.error = fixture.run('requestError(response)');
        assert.ok(fixture.run('errorMessage(error)').includes(message));
        assert.equal(JSON.stringify(result), before);
      }
      assert.equal(fixture.calls.length, 0);
      assert.equal(fixture.visits.length, 0);
    },
  );
