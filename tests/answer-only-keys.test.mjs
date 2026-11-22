// R25 ar-answers (Design B of the Arabic headroom study): `workspace` carried every message a page may show once it has loaded,
// among them the 277 to 1,000 sentences that only an error can ever carry: remedies, refusals of the core, the transport's
// messages. `answerOnlyKeys` (tools/locale-chunks.mjs) names the keys of a catalogue that only an error shows, so the plan can
// send them to the chunk no page waits for (`answers`). It must fail safe: a key stays in `workspace` unless every place that
// writes it is an error's own text and no page script writes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {answerOnlyKeys, errorSourceFiles, isErrorSource, writtenStrings} from '../tools/locale-chunks.mjs';

/** The analysis the plan makes of each backend file: {file: source text} to a Map of what each file writes. */
const analyse = files => new Map(Object.entries(files).map(([file, text]) => [file, writtenStrings(text, file)]));

const backend = {
  // The error module: the class, and the remedy a refusal carries. Everything a declared error source writes is an error's text.
  'src/errors.ts': [
    'export class MirrorError extends Error {}',
    "export function remedy() { return {category: 'request', action: 'Remedy of the errors module'}; }",
    "export const shared = () => ({action: 'Sentence a success answer also carries'});",
    "export const withScript = () => ({action: 'Sentence a page script also writes'});",
    "export const kind = () => ({action: 'Sentence a success explanation also lists'});",
    'export const sentence = (n: number) => `Template of the errors module`;',
    '',
  ].join('\n'),
  'src/transport.ts': [
    "import {MirrorError} from './errors.js';",
    "export function refuse() { throw new MirrorError('X', 'Message of the transport'); }",
    '',
  ].join('\n'),
  'src/google-remedies.ts': "export const rule = {codes: ['X'], remedy: {action: 'Remedy of a provider table'}};\n",
  'src/report-errors.ts': "export function source(d: any) { d.next_action = 'Next step of a report source'; }\n",
  // A module that is no declared error source: a sentence it only throws is an error's text too.
  'src/store.ts': [
    "import {MirrorError} from './errors.js';",
    'export function fail(code: string, message: string): never { throw new MirrorError(code, message); }',
    "export function a() { fail('STORE', 'Refusal of the store'); }",
    "export function b() { throw new MirrorError('STORE', 'Refusal built in place'); }",
    "export function c() { fail('STORE', 'Sentence that is also a status'); return {status: 'Sentence that is also a status'}; }",
    "export function d(x: number) { throw new MirrorError('STORE', `Refusal as a template`); }",
    "export function e() { fail('STORE', 'Refusal a success explanation lists'); }",
    "export function f() { fail('STORE', 'Sentence a page script writes'); }",
    "export function g() { fail('STORE', 'Sentence the core also takes as an option'); }",
    "export function i() { fail('STORE', 'Refusal no inspector lists'); }",
    '',
  ].join('\n'),
  // The success path: the sentence is data here (a property value, and a call that returns).
  'src/report.ts': [
    "export const answer = () => ({note: 'Sentence a success answer also carries'});",
    'export const label = (text: string) => ({label: text});',
    "export function h() { return label('Sentence the core also takes as an option'); }",
    '',
  ].join('\n'),
};

const keys = [
  'Remedy of the errors module',
  'Template of the errors module',
  'Message of the transport',
  'Remedy of a provider table',
  'Next step of a report source',
  'Refusal of the store',
  'Refusal built in place',
  'Refusal no inspector lists',
  'Sentence that is also a status',
  'Refusal as a template',
  'Refusal a success explanation lists',
  'Sentence a success answer also carries',
  'Sentence a page script writes',
  'Sentence a page script also writes',
  'Sentence the core also takes as an option',
  'Sentence a success explanation also lists',
  'Written by no backend file',
];

const classify = (extra = {}) =>
  answerOnlyKeys(keys, {
    index: analyse(backend),
    sources: new Map([
      ['server:core-contracts', new Set(['Refusal of the store', 'Refusal built in place'])],
      [
        'server:account-explanations',
        new Set(['Refusal a success explanation lists', 'Sentence a success explanation also lists']),
      ],
    ]),
    scripts: new Set(['Sentence a page script writes', 'Sentence a page script also writes']),
    ...extra,
  });

test('a key owned by error sources only goes to answers: a declared module’s remedy, refusal and next step', () => {
  const found = classify();
  for (const [key, why] of Object.entries({
    'Remedy of the errors module': 'the remedy an error carries (src/errors.ts)',
    'Message of the transport': 'a message of src/transport.ts',
    'Remedy of a provider table': 'a remedy table (src/*-remedies.ts)',
    'Next step of a report source': 'src/report-errors.ts',
    'Template of the errors module': 'everything a declared source writes is an error’s text, a template too',
  }))
    assert.ok(found.has(key), key + ': ' + why);
});

test('a module that is no declared source gives a key to answers only when it does nothing but throw it', () => {
  const found = classify();
  assert.ok(found.has('Refusal of the store'), 'handed to a function that provably throws');
  assert.ok(
    found.has('Refusal built in place'),
    'the message of an error built in place (new MirrorError, imported from errors)',
  );
  assert.ok(found.has('Refusal no inspector lists'), 'no inspector lists it: the roles decide, not the lists');
});

test('a key shared with a success path stays in workspace', () => {
  const found = classify();
  // Written as a property value of an answer: a page may show it from an answer that refused nothing.
  assert.equal(
    found.has('Sentence a success answer also carries'),
    false,
    'a declared module writes it, so does a success path',
  );
  assert.equal(found.has('Sentence that is also a status'), false, 'thrown, and also a property value');
  // A call that can return is not one that throws, so a sentence it takes is data.
  assert.equal(found.has('Sentence the core also takes as an option'), false);
});

test('a key a page script writes literally stays in workspace, whatever else writes it', () => {
  const found = classify();
  assert.equal(found.has('Sentence a page script writes'), false, 'thrown by the store, written by a script');
  assert.equal(found.has('Sentence a page script also writes'), false, 'in a declared source and written by a script');
});

test('a key read through a template stays in workspace unless a declared source writes it', () => {
  const found = classify();
  // The fixed text of a template is written as data: it may be a label the page shows, whatever call it is passed to.
  assert.equal(found.has('Refusal as a template'), false, 'a module that is no declared source');
  assert.ok(found.has('Template of the errors module'), 'a declared source');
});

test('a key listed by a success inspector, and a key nothing writes literally, stay in workspace', () => {
  const found = classify();
  assert.equal(found.has('Refusal a success explanation lists'), false, 'an explanation shown from a success answer');
  assert.equal(found.has('Sentence a success explanation also lists'), false);
  assert.equal(found.has('Written by no backend file'), false, 'where it goes is unknown');
});

test('the result is exactly the keys proven to be an error’s alone, whatever order the files are read in', () => {
  const expected = [
    'Message of the transport',
    'Next step of a report source',
    'Refusal built in place',
    'Refusal no inspector lists',
    'Refusal of the store',
    'Remedy of a provider table',
    'Remedy of the errors module',
    'Template of the errors module',
  ];
  assert.deepEqual([...classify()].sort(), expected);
  const reversed = new Map([...analyse(backend)].reverse());
  assert.deepEqual([...classify({index: reversed})].sort(), expected);
  // Only the keys it is given are classified.
  assert.deepEqual(
    [
      ...answerOnlyKeys(['Message of the transport'], {
        index: analyse(backend),
        sources: new Map(),
        scripts: new Set(),
      }),
    ],
    ['Message of the transport'],
  );
});

test('the declared error sources are the error module, the report errors, the transport and every remedy table', () => {
  assert.deepEqual(errorSourceFiles, ['src/errors.ts', 'src/report-errors.ts', 'src/transport.ts']);
  for (const file of [
    'src/errors.ts',
    'src/report-errors.ts',
    'src/transport.ts',
    'src/google-remedies.ts',
    'src/meta-remedies.ts',
    'src/provider-remedies.ts',
    'src/x-remedies.ts',
  ])
    assert.equal(isErrorSource(file), true, file);
  for (const file of [
    'src/store.ts',
    'src/error-helpers.ts',
    'src/provider-error-core.ts',
    'src/remedies.ts',
    'src/nested/x-remedies.ts',
    'server/transport.ts',
    'web/app.js',
  ])
    assert.equal(isErrorSource(file), false, file);
});
