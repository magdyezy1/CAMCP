// WEB-07: the Arabic catalog (web/locales/ar.json, 1.9 MB at 91 % of its 2 MiB cap) was one download that gated every
// Arabic page: About fetched all of it to translate 54 strings, and the workspace asked who was signed in only after
// it arrived. tools/locale-chunks.mjs generates bounded chunks; a page loads the shell's and its own. These tests guard
// the committed chunks, what each page requests, and the parallel session request.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createContext, Script} from 'node:vm';
import {parsers} from 'prettier/plugins/babel';
import {backendContractSourceFiles} from '../tools/check-locales.mjs';
import {
  chunkLimit,
  chunksWith,
  loaderFiles,
  localeChunkProblems,
  moduleChunk,
  planLocaleChunks,
} from '../tools/locale-chunks.mjs';
import {removeTestDirectory} from '../dist/tests/temp.js';

const plan = planLocaleChunks();

test('the committed chunks are fresh, bounded, carry every message once a page has its own, and stay complete', () => {
  assert.deepEqual(localeChunkProblems(process.cwd(), plan), []);
  const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
    names = Object.keys(plan.chunks);
  for (const name of names) {
    const bytes = fs.statSync('web/locales/ar/' + name + '.json').size;
    assert.ok(bytes <= chunkLimit, name + ': ' + bytes);
  }
  // Every catalog message is in some chunk, with its translation unchanged.
  const merged = Object.assign({}, ...names.map(name => plan.chunks[name]));
  assert.deepEqual(Object.keys(merged).sort(), Object.keys(catalog).sort());
  for (const [key, value] of Object.entries(merged)) assert.equal(value, catalog[key]);
  // The shell a public page loads is a fraction of the catalog it used to wait for.
  const shell = fs.statSync('web/locales/ar/shell.json').size,
    source = fs.statSync('web/locales/ar.json').size;
  assert.ok(shell < source * 0.2, shell + ' of ' + source);
  // Each lazily loaded page script has its chunk, named after it.
  for (const file of plan.modules) assert.ok(names.includes(moduleChunk(file)), file);
  assert.deepEqual(names.slice(0, 4), ['shell', 'workspace', 'answers', 'providers']);
  assert.match(fs.readFileSync('tools/check-web.mjs', 'utf8'), /localeChunkProblems\(/);
});

test('a chunk that drops a message a script requires, a stale chunk and an oversized chunk are refused', () => {
  const clone = {...plan, chunks: Object.fromEntries(Object.entries(plan.chunks).map(([k, v]) => [k, {...v}]))};
  // A message only owner-operations.js writes, removed from its chunk: Settings would show it in English.
  const owned = Object.keys(clone.chunks['owner-operations'])[0];
  assert.ok(owned);
  delete clone.chunks['owner-operations'][owned];
  const problems = localeChunkProblems(process.cwd(), clone).join('\n');
  assert.match(problems, /web\/locales\/ar\/owner-operations\.json is stale/);
  assert.ok(
    problems.includes('Arabic message in no chunk: ' + owned) ||
      problems.includes('web/owner-operations.js requires a message none of its chunks carries: ' + owned),
  );
  const large = {...plan, chunks: {...plan.chunks, shell: {...plan.chunks.shell, Huge: 'ا'.repeat(chunkLimit)}}};
  assert.match(localeChunkProblems(process.cwd(), large).join('\n'), /shell\.json: \d+ bytes \(limit 1048576\)/);
});

// R25 ar-lazy (item 4): the chunk no page waits for is named once, in web/route-assets.js; the plan and the check read it.
// Before, `providers` (4,710 messages, a third of an Arabic page) was assumed available to every page script, so a script
// could write a message that only it carried without the check noticing.
test('route-assets.js names the chunks no page waits for, and no page script can rely on them', () => {
  const {lazy, dependencies, modules} = loaderFiles();
  // R25 ar-answers: `answers` (what only an error shows) beside `providers` (the providers' refusals).
  assert.deepEqual(lazy, ['answers', 'providers']);
  assert.deepEqual(plan.lazy, lazy);
  for (const file of modules)
    for (const name of lazy) assert.equal(chunksWith(file, dependencies).has(name), false, file + ' relies on ' + name);
});

// The two rules that keep a lazy chunk honest. The first: a chunk the loader names must be a generated one, or a page would ask
// for a file that is not there. The second: it holds refusal sentences only, because a page shows any other message before an
// answer has loaded the chunk, in English.
test('the check refuses a lazy chunk that is not generated, and a lazy chunk that carries a message no refusal writes', () => {
  assert.deepEqual(localeChunkProblems(process.cwd(), plan), []);
  const named = localeChunkProblems(process.cwd(), {...plan, lazy: [...plan.lazy, 'no-such-chunk']});
  assert.ok(
    named.includes('web/route-assets.js names a lazy chunk that does not exist: no-such-chunk'),
    named.join('\n'),
  );
  // A word every signed-in page shows ("Yes": no provider contract refuses with it), moved into the lazy chunk.
  const word = 'Yes';
  assert.ok(word in plan.catalog && !plan.sources.get('server:backend-contracts').has(word));
  const moved = localeChunkProblems(process.cwd(), {
    ...plan,
    chunks: {...plan.chunks, providers: {...plan.chunks.providers, [word]: plan.catalog[word]}},
  });
  assert.ok(moved.includes('providers chunk carries a message no provider refusal writes: ' + word), moved.join('\n'));
});

// R25 ar-answers (item 3): `answers` is a second chunk no page waits for, so the check holds it to the same rules as `providers`:
// no page script can rely on it, a source that a page shows from a success answer may not be in it, and it holds only the keys
// the classifier names. These run on clones of the plan that move a key from `workspace` into `answers`, as the plan would if the
// classifier named it.
const withAnswers = (keys, {classified = true} = {}) => {
  const moved = new Set(keys);
  return {
    ...plan,
    answerOnly: new Set([...plan.answerOnly, ...(classified ? keys : [])]),
    chunks: {
      ...plan.chunks,
      workspace: Object.fromEntries(Object.entries(plan.chunks.workspace).filter(([key]) => !moved.has(key))),
      answers: {...plan.chunks.answers, ...Object.fromEntries(keys.map(key => [key, plan.catalog[key]]))},
    },
  };
};
const inWorkspace = (kind, exclude = []) =>
  [...plan.sources.get(kind)].find(key => key in plan.chunks.workspace && !exclude.includes(key));

test('no page script can rely on answers, whichever way the loader lists the chunks', () => {
  const {dependencies, modules} = loaderFiles();
  for (const file of modules)
    for (const lazy of [undefined, [], ['providers'], ['answers', 'providers']])
      assert.equal(chunksWith(file, dependencies, lazy).has('answers'), false, file + ' relies on answers');
  // A script that requires a key that only `answers` carries is refused: it would show it in English until an answer loaded it.
  const scripted = [...plan.sources.get('web/commerce.js')].find(
    key => key in plan.chunks.workspace && !(key in plan.chunks.commerce),
  );
  assert.ok(scripted);
  const problems = localeChunkProblems(process.cwd(), withAnswers([scripted]));
  assert.ok(
    problems.includes('web/commerce.js requires a message none of its chunks carries: ' + scripted),
    problems.join('\n'),
  );
});

test('answers holds what an error alone shows: a recovery hint may be in it, a success answer’s explanation or a word may not', () => {
  const hint = [...plan.sources.get('server:shared-recovery')].find(key => key in plan.chunks.answers),
    explanation = inWorkspace('server:account-explanations');
  assert.ok(hint && explanation && 'Yes' in plan.chunks.workspace);
  // A recovery hint of a remedy is in it, and the committed chunks pass the check.
  assert.deepEqual(localeChunkProblems(process.cwd(), plan), []);
  // An explanation a page shows from a success answer: the source that lists it needs a chunk every page has.
  const shown = localeChunkProblems(process.cwd(), withAnswers([explanation]));
  assert.ok(
    shown.includes('server:account-explanations requires a message none of its chunks carries: ' + explanation),
    shown.join('\n'),
  );
  // A key the classifier does not name (a word every signed-in page shows) is refused, whatever else holds.
  const word = localeChunkProblems(process.cwd(), withAnswers(['Yes'], {classified: false}));
  assert.ok(
    word.includes('answers chunk carries a message that something other than an error shows: Yes'),
    word.join('\n'),
  );
  // A key the classifier names that `workspace` still carries: the split did not happen.
  const left = Object.keys(plan.chunks.workspace)[0],
    kept = localeChunkProblems(process.cwd(), {...plan, answerOnly: new Set([...plan.answerOnly, left])});
  assert.ok(kept.includes('workspace chunk carries a message only an error shows: ' + left), kept.join('\n'));
  // The loader names a chunk the plan did not generate.
  const {answers, ...without} = plan.chunks,
    missing = localeChunkProblems(process.cwd(), {...plan, chunks: without});
  assert.ok(answers && Object.keys(answers).length > 0);
  assert.ok(
    missing.includes('web/route-assets.js names a lazy chunk that does not exist: answers'),
    missing.join('\n'),
  );
});

test('providers carries refusal sentences only: what a provider contract refuses with and no page script or success answer shows', () => {
  const refusals = plan.sources.get('server:backend-contracts'),
    shown = [...plan.sources].filter(([name]) => name !== 'server:backend-contracts' && !name.startsWith('web/'));
  assert.deepEqual(
    Object.keys(plan.chunks.providers).filter(key => !refusals.has(key) || shown.some(([, set]) => set.has(key))),
    [],
  );
  // Words a page script writes, which `providers` carried because some backend file writes them too ("Yes", "Status", a
  // report preset's name, a coverage note shown from a success answer), load with every signed-in page.
  for (const word of [
    'Yes',
    'No',
    'Status',
    'Daily',
    'Weekly',
    'Monthly',
    'Entity ID',
    'Google campaign performance',
  ]) {
    assert.equal(word in plan.chunks.providers, false, word + ' is not a refusal sentence');
    assert.ok(word in plan.chunks.workspace || word in plan.chunks.shell, word + ' is there before a page renders');
  }
});

test('a script that writes a sentence a provider contract also refuses with carries its own copy', () => {
  const key = 'Invalid CSV quoting.';
  // commerce.js and report-reference.js check a CSV before sending it, with the sentence the backend refuses with.
  assert.ok(key in plan.chunks.providers, 'a refusal still reads it from providers');
  assert.ok(key in plan.chunks.commerce, 'web/commerce.js');
  assert.ok(key in plan.chunks['report-reference'], 'web/report-reference.js');
  // The check refuses a script that would rely on the lazy chunk for it.
  const clone = {...plan, chunks: {...plan.chunks, commerce: {...plan.chunks.commerce}}};
  delete clone.chunks.commerce[key];
  assert.ok(
    localeChunkProblems(process.cwd(), clone).includes(
      'web/commerce.js requires a message none of its chunks carries: ' + key,
    ),
  );
});

test('a sentence that is also data in the backend is never lazy (a success answer shows it)', () => {
  // Found by reading the role of every occurrence in src and server (R25 ar-lazy): each is a refusal sentence that is also
  // stored in a property, a variable or a return value, so a page may show it from an answer that refused nothing.
  for (const start of [
    'Not in this account', // not_found_reason of the ad previews answer (web/ad-previews.js shows it)
    'Targeting, serving and shared-list changes require spend_change_confirmed=true.',
    'Personal data: this read returns submitted leads',
    'Snapchat did not return the selected ad account with its organization.',
    'name must start with a letter, use only letters, numbers, spaces, underscores or hyphens',
    'name must not be the name of a standard event.',
  ]) {
    const key = Object.keys(plan.catalog).find(message => message.startsWith(start));
    assert.ok(key, start);
    assert.equal(key in plan.chunks.providers, false, key + ' stays out of the lazy chunk');
    assert.ok(key in plan.chunks.workspace, key + ' loads with every signed-in page');
  }
});

/** A small tree with the files the plan reads, written under a temporary directory. */
function syntheticPlan(files, locales) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-lazy-plan-'));
  try {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
      fs.writeFileSync(path.join(root, file), text);
    }
    return planLocaleChunks(root, locales);
  } finally {
    removeTestDirectory(root, 'amcp-lazy-plan-');
  }
}

test('the plan makes a sentence lazy only when every place that writes it hands it to a function that provably throws', () => {
  const lazy = {
      'Never helper': 'a function declared to return never',
      'Sole throw helper': 'a function that is one throw',
      'Delegating helper': 'a function that hands everything to one that throws',
      'Factory helper': 'a constant built by a factory whose declared return type is a never function',
      'Typed constant': 'a constant declared with an imported never function type',
      'Constructed': 'a constructor imported from src/errors.ts',
      'Imported helper': 'a never function imported from another module',
    },
    eager = {
      'Returning helper': 'a function that can return, as well as one that throws',
      'Review helper': 'an arrow that returns an object',
      'Method call': 'a method call, as well as a throwing function',
      'Property value': 'a property value',
      'Template text': 'a template',
      'Unresolved helper': 'a helper imported from a package',
      'Other constructor': 'a constructor not imported from src/errors.ts',
    },
    pageOwned = ['Page word and refusal', 'Page word and data', 'Only the page'],
    catalog = Object.fromEntries(
      [...Object.keys(lazy), ...Object.keys(eager), ...pageOwned, 'Shell word', 'Written nowhere'].map(key => [
        key,
        'ar ' + key,
      ]),
    ),
    built = syntheticPlan(
      {
        'web/routes.js': 'const routeRegistry = [];\n',
        'web/route-assets.js':
          "const pageAssetOrder = ['page.js'];\nconst pageAssetDependencies = {};\nconst answerLocaleChunks = ['providers'];\n",
        'web/index.html': '<script src="/assets/app.js" defer></script>',
        'web/app.js': "'use strict';\n",
        'web/page.js':
          "'use strict';\nuiText('Page word and refusal');\nuiText('Page word and data');\nuiText('Only the page');\n",
        'server/website.ts': "export const words = ['Shell word'];\n",
        'src/errors.ts': 'export class MirrorError extends Error {}\n',
        'src/kit.ts': [
          "import {MirrorError} from './errors.js';",
          'export type Refusal = (message: string) => never;',
          'export function fail(code: string, message: string): never { throw new MirrorError(code, message); }',
          'export function makeRefusal(code: string): Refusal { return message => fail(code, message); }',
          '',
        ].join('\n'),
        'src/refusals.ts': [
          "import {MirrorError} from './errors.js';",
          "import {fail, makeRefusal} from './kit.js';",
          "import type {Refusal} from './kit.js';",
          "import {packaged} from 'a-package';",
          'declare function makeOne(code: string): Refusal;',
          'class Other extends Error {}',
          "function invalid(message: string): never { throw new MirrorError('X', message); }",
          "const bad = (message: string) => { throw new MirrorError('X', message); };",
          'const wrapped = (message: string) => invalid(message);',
          "const built = makeRefusal('X');",
          "const typed: Refusal = makeOne('Y');",
          'function note(message: string) { return {note: message}; }',
          'const review = (reason: string) => ({reason});',
          "export function a() { invalid('Never helper'); }",
          "export function b() { bad('Sole throw helper'); }",
          "export function c() { wrapped('Delegating helper'); }",
          "export function d() { built('Factory helper'); }",
          "export function e() { typed('Typed constant'); }",
          "export function f() { throw new MirrorError('X', 'Constructed'); }",
          "export function g() { fail('X', 'Imported helper'); }",
          "export function h() { note('Returning helper'); invalid('Returning helper'); }",
          "export function i() { review('Review helper'); invalid('Review helper'); }",
          "export function j(list: string[]) { list.push('Method call'); invalid('Method call'); }",
          "export function k() { invalid('Property value'); return {text: 'Property value'}; }",
          'export function l(x: number) { invalid(`Template text`); return `Template text ${x}`; }',
          "export function m() { packaged('Unresolved helper'); invalid('Unresolved helper'); }",
          "export function n() { throw new Other('Other constructor'); }",
          "export function o() { invalid('Page word and refusal'); return {text: 'Page word and data'}; }",
          '',
        ].join('\n'),
      },
      {
        catalog,
        sources: new Map([
          ['server:backend-contracts', new Set([...Object.keys(lazy), ...Object.keys(eager), 'Page word and refusal'])],
          ['web/page.js', new Set(pageOwned)],
        ]),
        problems: [],
      },
    ),
    where = key =>
      Object.entries(built.chunks)
        .filter(([, chunk]) => key in chunk)
        .map(([name]) => name)
        .sort();
  assert.deepEqual(built.lazy, ['providers']);
  for (const [key, why] of Object.entries(lazy)) assert.deepEqual(where(key), ['providers'], key + ': ' + why);
  // Anything a page may show from an answer that refused nothing travels in the chunk every signed-in page has.
  for (const [key, why] of Object.entries(eager)) assert.deepEqual(where(key), ['workspace'], key + ': ' + why);
  // A script's own words are its own, even when a refusal needs the same sentence.
  assert.deepEqual(where('Page word and refusal'), ['page', 'providers']);
  // A word the backend also writes (a preset name, a coverage note) may reach any page in an answer: every page has it.
  assert.deepEqual(where('Page word and data'), ['workspace']);
  assert.deepEqual(where('Only the page'), ['page']);
  assert.deepEqual(where('Shell word'), ['shell']);
  assert.deepEqual(where('Written nowhere'), ['workspace']);
});

// R25 ar-answers (Design B): what only an error shows leaves `workspace` for `answers`, a second chunk no page waits for. The plan
// makes it when the loader names it in `answerLocaleChunks`, and decides by where each key is written (answerOnlyKeys).
test('the plan sends the keys only an error shows to answers when the loader names that chunk lazy, and to workspace otherwise', () => {
  const words = [
      'Remedy text',
      'Refusal text',
      'Shared text',
      'Script text',
      'Kind script text',
      'Provider refusal',
      'Template refusal',
      'Written nowhere',
    ],
    tree = lazy => ({
      'web/routes.js': 'const routeRegistry = [];\n',
      'web/route-assets.js': `const pageAssetOrder = ['page.js'];\nconst pageAssetDependencies = {};\nconst answerLocaleChunks = ${lazy};\n`,
      'web/index.html': '<script src="/assets/app.js" defer></script>',
      'web/app.js': "'use strict';\n",
      'web/page.js': "'use strict';\nuiText('Script text');\nuiText('Kind script text');\n",
      'server/website.ts': 'export const none = [];\n',
      'src/errors.ts': [
        'export class MirrorError extends Error {}',
        "export const remedy = () => ({action: 'Remedy text'});",
        "export const shared = () => ({action: 'Shared text'});",
        '',
      ].join('\n'),
      'src/store.ts': [
        "import {MirrorError} from './errors.js';",
        'function fail(code: string, message: string): never { throw new MirrorError(code, message); }',
        "export function a() { fail('X', 'Refusal text'); }",
        "export function b() { fail('X', 'Script text'); }",
        "export function c() { fail('X', 'Kind script text'); }",
        "export function d() { fail('X', 'Provider refusal'); }",
        "export function e() { throw new MirrorError('X', `Template refusal`); }",
        "export const row = {note: 'Shared text'};",
        '',
      ].join('\n'),
    }),
    locales = {
      catalog: Object.fromEntries(words.map(key => [key, 'ar ' + key])),
      sources: new Map([
        ['server:core-contracts', new Set(['Refusal text', 'Kind script text', 'Template refusal'])],
        ['server:shared-recovery', new Set(['Remedy text', 'Shared text'])],
        ['server:backend-contracts', new Set(['Refusal text', 'Script text', 'Provider refusal', 'Template refusal'])],
        ['web/page.js', new Set(['Script text', 'Kind script text'])],
      ]),
      problems: [],
    },
    where = (built, key) =>
      Object.entries(built.chunks)
        .filter(([, chunk]) => key in chunk)
        .map(([name]) => name)
        .sort();
  const built = syntheticPlan(tree("['answers', 'providers']"), locales);
  assert.deepEqual(built.lazy, ['answers', 'providers']);
  assert.deepEqual(Object.keys(built.chunks).slice(0, 4), ['shell', 'workspace', 'answers', 'providers']);
  // A remedy, and the refusal of a core module that nothing else writes: an error's alone.
  assert.deepEqual(where(built, 'Remedy text'), ['answers']);
  assert.deepEqual(where(built, 'Refusal text'), ['answers']);
  // Shared with a success path, written by a page script, or only a template: they stay where every signed-in page has them.
  assert.deepEqual(where(built, 'Shared text'), ['workspace'], 'a property value of an answer');
  assert.deepEqual(where(built, 'Kind script text'), ['workspace'], 'a page script writes it');
  assert.deepEqual(where(built, 'Template refusal'), ['workspace'], 'the fixed text of a template is data');
  assert.deepEqual(where(built, 'Written nowhere'), ['workspace'], 'no source writes it');
  // What the plan sent to `providers` before is untouched: a script that also writes it carries its own copy.
  assert.deepEqual(where(built, 'Provider refusal'), ['providers']);
  assert.deepEqual(where(built, 'Script text'), ['page', 'providers']);
  // The classifier names every key an error alone writes, in whichever lazy chunk the plan files it.
  assert.deepEqual([...built.answerOnly].sort(), ['Provider refusal', 'Refusal text', 'Remedy text']);
  // A loader that does not name the chunk gets none: nothing would load it, so the keys stay in workspace.
  const unnamed = syntheticPlan(tree("['providers']"), locales);
  assert.equal('answers' in unnamed.chunks, false);
  assert.deepEqual(where(unnamed, 'Remedy text'), ['workspace']);
  assert.deepEqual(where(unnamed, 'Refusal text'), ['workspace']);
});

test('a sentence a helper that returns data also takes stays eager: report advice gives it as the reason of a recommendation', () => {
  // `review` throws nowhere in src/report-advice-v4.ts: it returns the recommendation row with a `reason`. The same sentence
  // is a refusal elsewhere, so the inspector files it with the refusals; the plan reads the module's own definition of
  // `review` (not the name, which other modules use for a function that throws) and keeps it eager.
  const key = 'A metric exceeds supported numeric precision. Use the retained native source.';
  assert.ok(key in plan.catalog);
  assert.equal(key in plan.chunks.providers, false);
  assert.ok(key in plan.chunks.workspace);
});

/**
 * The name of the function a node opens, if it has one: a declaration's, a method's, or the variable or property an arrow or
 * function expression is assigned to. A callback has none, and belongs to the named function around it (lead review S4-1: a guard
 * keyed by file alone passes a new site in a file that already has a decided one).
 */
function functionName(node, parent) {
  if (
    ![
      'FunctionDeclaration',
      'FunctionExpression',
      'ArrowFunctionExpression',
      'ClassMethod',
      'ClassPrivateMethod',
      'ObjectMethod',
    ].includes(node.type)
  )
    return undefined;
  const named = node.id ?? node.key;
  if (named) return named.name ?? named.id?.name ?? named.value;
  if (parent?.type === 'VariableDeclarator') return parent.id?.name;
  if (['ObjectProperty', 'ClassProperty'].includes(parent?.type)) return parent.key?.name ?? parent.key?.value;
  if (parent?.type === 'AssignmentExpression') return parent.left?.property?.name ?? parent.left?.name;
  return undefined;
}

/**
 * The object literals of one source with a property whose value is a caught error's `.message` (also through `?:`, `??`, `||` and
 * a cast) and no `code` property beside it, as `<file> <function> <key>` (`(module)` outside any function). "Caught" is a name
 * bound by a catch clause, by a `.catch(…)` callback, or by a parameter typed MirrorError or Error.
 */
function messageCopiesIn(text, file) {
  const copies = new Set(),
    skip = new Set([
      'loc',
      'start',
      'end',
      'range',
      'extra',
      'comments',
      'leadingComments',
      'trailingComments',
      'innerComments',
    ]),
    typed = param => {
      const type = (param?.typeAnnotation ?? param?.left?.typeAnnotation)?.typeAnnotation;
      return type?.type === 'TSTypeReference' && ['MirrorError', 'Error'].includes(type.typeName?.name);
    },
    reads = (node, names = []) => {
      if (['MemberExpression', 'OptionalMemberExpression'].includes(node?.type))
        return node.property?.name === 'message' && !node.computed && node.object?.type === 'Identifier'
          ? [...names, node.object.name]
          : names;
      if (node?.type === 'ConditionalExpression') return reads(node.alternate, reads(node.consequent, names));
      if (node?.type === 'LogicalExpression') return reads(node.right, reads(node.left, names));
      if (
        ['TSAsExpression', 'TSNonNullExpression', 'ParenthesizedExpression', 'TSSatisfiesExpression'].includes(
          node?.type,
        )
      )
        return reads(node.expression, names);
      return names;
    };
  const callbacks = new Set(),
    visit = (node, caught, inside, parent) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(child => visit(child, caught, inside, parent));
      if (typeof node.type !== 'string') return;
      let here = caught;
      const around = functionName(node, parent) ?? inside;
      if (node.type === 'CatchClause' && node.param?.type === 'Identifier') here = new Set([...here, node.param.name]);
      if (Array.isArray(node.params)) {
        const names = node.params
          .filter(param => typed(param) || callbacks.has(node))
          .map(param => param.name ?? param.left?.name)
          .filter(Boolean);
        if (names.length) here = new Set([...here, ...names]);
      }
      if (node.type === 'CallExpression' && node.callee?.property?.name === 'catch')
        for (const argument of node.arguments) callbacks.add(argument);
      if (
        node.type === 'ObjectExpression' &&
        !node.properties.some(property => (property.key?.name ?? property.key?.value) === 'code')
      )
        for (const property of node.properties)
          if (property.type === 'ObjectProperty' && reads(property.value).some(name => here.has(name)))
            copies.add(file + ' ' + around + ' ' + (property.key?.name ?? property.key?.value));
      for (const [key, child] of Object.entries(node)) if (!skip.has(key)) visit(child, here, around, node);
    };
  visit(parsers['babel-ts'].parse(text, {filepath: file}).program, new Set(), '(module)', null);
  return copies;
}
/** Every such copy in src/ and server/. */
function messageCopies() {
  const copies = new Set();
  for (const file of backendContractSourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    if (/\.message\b/.test(text)) for (const copy of messageCopiesIn(text, file)) copies.add(copy);
  }
  return [...copies].sort();
}

// R25 ar-lazy (lead review S3-1). A sentence is lazy when every place that writes it hands it to a call that throws; the plan
// cannot see where the text of a thrown error goes next. The answer gate reads an error by its shape (a code beside the
// message), so a message copied out of a caught error into a field with no code beside it reaches a page unread, and shows in
// English until the chunk is in. This lists every such copy in the backend: each is decided here, either shown by a page that
// asks for the chunk itself before it shows the text (the named page source must still call uiEnsureSentences), or shown by
// none (the lead's review checked web/*.js for each field). A new copy fails until someone decides. It is a tripwire for the
// common shapes, not a proof: a message copied through a variable or a helper is not seen. Each site is keyed by its file, the
// function around it and the property, so a new copy in a file that already has a decided one is asked about too (lead review S4-1).
const copiedMessages = {
  'server/platform-routes.ts oauthCallback message': {
    asks: 'web/app.js',
    why: 'the connection result page shows it (renderCallback)',
  },
  'src/write-review.ts executeRequirements reason': {
    asks: 'web/operations-center.js',
    why: 'the write approval page shows it (writeApprovalController)',
  },
  'src/spend-policy.ts breach message': {
    why: 'the exceeded caps: shown by no page with uiText (the review table shows native values as they are)',
  },
  'src/wire-contracts.ts checkResolved reason': {why: 'a wire-contract finding: shown by no page'},
  'src/workbook-migration.ts previewWorkbookMigration error_message': {why: 'a migration blocker: shown by no page'},
  // Package r25-field-tiktok (#6): collect() in src/tiktok-smart-plus-ads.ts copies the sentence of each rule a Smart+ ad create or edit
  // broke into `details.violations`. No file of web/ reads details.violations (checked: web/*.js names no such key; the pages read
  // layer, next_action and retry_after only), and the refusal's own message, which the website does show, is a template with its Arabic.
  'src/tiktok-smart-plus-ads.ts collect message': {
    why: 'the violations of a Smart+ contract refusal (details.violations): AMCP’s own sentences in the details, which no page reads; a client reads them',
  },
};
// Lead review S4-2: a copy the guard cannot see, because its source is not a caught binding. In src/workspace.ts the readiness check
// of a native request (`check('write_contract', …)`) takes the message of an inspect's refusal, `r.data?.error?.message ??
// r.error?.message`, into `{key, status, message}` with no code, so the answer gate does not read it. Only `requirements.native_request`
// reaches it, and the website sends `{write}` alone (web/workspace.js, the account check): no page shows it, MCP clients only. A
// later server package passes the error's code in the check's `extra`. The test below keeps this honest: the copy is still there, and
// no web script sends the field.
const unseenCopy = {
  site: /'write_contract',[^;]{0,200}r\.data\?\.error\?\.message \?\? r\.error\?\.message/,
  sends: /\bnative_request\s*:\s*(?!\s|uiText\()|\.native_request\s*=/,
};

test('the message-copy guard sees a caught error however it is bound, and no error-shaped or uncaught object', () => {
  const source = `
    try { run(); } catch (e) { out.push({note: e.message, other: 'x'}); }
    run().catch(failure => out.push({reason: failure instanceof Error ? failure.message : 'unknown'}));
    const copy = (cause: MirrorError) => ({text: cause.message ?? 'none'});
    const quoted = (cause: Error) => ({line: cause.message as string});
    try { run(); } catch (e) { out.push({code: e.code, message: e.message}); }
    const row = (item: Row) => ({label: item.message});
    try { run(); } catch (e) { out.push({detail: describe(e.message)}); }
  `;
  assert.deepEqual(
    [...messageCopiesIn(source, 'x.ts')].sort(),
    ['x.ts (module) note', 'x.ts (module) reason', 'x.ts copy text', 'x.ts quoted line'],
    'a site is keyed by its file, the function around it and the property',
  );
});

test('two copies in two functions of one file are two sites, and a new function in a decided file is not decided (lead review S4-1)', () => {
  const source = `
    function first() { try { run(); } catch (e) { out.push({note: e.message}); } }
    class Runner { second() { try { run(); } catch (e) { out.push({note: e.message}); } } }
    const third = { fourth: () => { try { run(); } catch (e) { out.push({note: e.message}); } } };
    function fifth() { return [1].map(() => { try { run(); } catch (e) { return {note: e.message}; } }); }
  `;
  assert.deepEqual(
    [...messageCopiesIn(source, 'x.ts')].sort(),
    ['x.ts fifth note', 'x.ts first note', 'x.ts fourth note', 'x.ts second note'],
    'a method, a property’s arrow and a callback belong to the named function around them',
  );
  // A mutation: a function added to a file that already has a decided copy. Keyed by file alone it would pass; it must not.
  const decided = Object.keys(copiedMessages)[0],
    file = decided.split(' ')[0],
    added = `\nfunction mutantCopy() { try { run(); } catch (e) { return {reason: e.message}; } }\n`,
    found = [...messageCopiesIn(fs.readFileSync(file, 'utf8') + added, file)];
  assert.ok(found.includes(decided), 'the decided site is still found in ' + file);
  assert.deepEqual(
    found.filter(site => !(site in copiedMessages)),
    [file + ' mutantCopy reason'],
    'the new function is the one undecided site',
  );
});

test('a copy the guard cannot see is decided: the readiness check’s write contract, which no page can reach (lead review S4-2)', () => {
  assert.match(fs.readFileSync('src/workspace.ts', 'utf8'), unseenCopy.site, 'the copy is still in src/workspace.ts');
  for (const file of fs.readdirSync('web').filter(name => name.endsWith('.js')))
    assert.doesNotMatch(
      fs.readFileSync('web/' + file, 'utf8'),
      unseenCopy.sends,
      'web/' + file + ' sends native_request',
    );
  // The pattern is not vacuous: it sees the request the website would have to send, and not the code-keyed label in
  // web/workbook-schedules.js.
  assert.match('requirements: {native_request: {action: "x"}}', unseenCopy.sends);
  assert.match('requirements.native_request = request', unseenCopy.sends);
  assert.doesNotMatch("native_request: uiText('This saved query is a native provider request.')", unseenCopy.sends);
});

test('a message copied out of a caught error into a field with no code is decided: a page that asks for its chunk, or no page', () => {
  assert.deepEqual(messageCopies(), Object.keys(copiedMessages).sort(), 'decide each new copy: see the comment above');
  for (const [site, {asks, why}] of Object.entries(copiedMessages)) {
    assert.ok(why, site);
    if (asks)
      assert.match(
        fs.readFileSync(asks, 'utf8'),
        /\buiEnsureSentences\(/,
        site + ' is shown by ' + asks + ', which asks',
      );
  }
});

/**
 * The calls of `errorRemedy` and `providerRemedy` in one source, as `<file> <function> <callee>` (`(module)` outside any
 * function): where the backend makes a remedy's text.
 */
function remedyCallsIn(text, file) {
  const calls = new Set(),
    skip = new Set(['loc', 'start', 'end', 'range', 'extra', 'comments', 'leadingComments', 'trailingComments']),
    visit = (node, inside, parent) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(child => visit(child, inside, parent));
      if (typeof node.type !== 'string') return;
      const around = functionName(node, parent) ?? inside;
      if (
        node.type === 'CallExpression' &&
        node.callee?.type === 'Identifier' &&
        ['errorRemedy', 'providerRemedy'].includes(node.callee.name)
      )
        calls.add(file + ' ' + around + ' ' + node.callee.name);
      for (const [key, child] of Object.entries(node)) if (!skip.has(key)) visit(child, around, node);
    };
  visit(parsers['babel-ts'].parse(text, {filepath: file}).program, '(module)', null);
  return calls;
}

// R25 ar-answers: `answers` holds the remedies of src/errors.ts and of the providers' remedy tables. A remedy reaches a page only in a
// `remedy` object or a `next_action` of an error-shaped object, which the answer gate reads (uiEachAnswerMessage). This lists every
// place the backend makes a remedy's text and says where it goes; a new one fails until someone decides. A tripwire for the common
// shape, as the message-copy guard above is: a remedy copied through a variable or a helper is not seen. Each use is keyed by its
// file, the function around it and the callee, so a new call in a file that already has a decided one is asked about too (lead
// review S4-1).
const remedyUses = {
  // r25-field3-approvals (M5-b) made this use and r25-field3-merge decides it, as the lead asked (the review fixes commit): the refusal that a blocked plan's approve and
  // approval_summary carry beside the blocked view is `refusal {code, message, category, remedy, details}`, an error-shaped object, so the answer gate reads its message and its
  // remedy (web/route-assets.js uiEachAnswerMessage: a string `code` beside the message, and the remedy's action).
  'src/campaign-runner.ts blockedAnswer errorRemedy':
    'a blocked plan’s refusal (approve, approval_summary): `refusal` keeps its code beside the message and carries `remedy`, an error-shaped object the answer gate reads',
  // r25-field3-approvals moved this call, unchanged, from the arrow `blockedBy` into the method `blockedView`: the same decided use.
  'src/campaign-runner.ts blockedView errorRemedy':
    'a failed step of a plan: the error keeps its code and gains `remedy`',
  'src/errors.ts errorRemedy providerRemedy': 'the providers’ tables, which errorRemedy consults first',
  'src/errors.ts errorResult errorRemedy': 'the error answer: its `remedy` and its `next_action`',
  'src/errors.ts reviewRemedy errorRemedy': 'the remedy of a review’s part error',
  'src/report-errors.ts reportSourceError providerRemedy': 'a report source’s diagnostic: its `next_action`',
  'src/write-review.ts prepareReview errorRemedy':
    'a review that cannot be prepared: `error.remedy`, beside the error’s code and message (two sites)',
};

test('the remedy detector sees a call however it is nested, and no other call', () => {
  const source = `
    const a = errorRemedy(e);
    const b = {remedy: providerRemedy(code, details)?.action ?? 'x'};
    const c = other.errorRemedy(e);
    const d = remedyOf(e);
  `;
  assert.deepEqual([...remedyCallsIn(source, 'x.ts')].sort(), [
    'x.ts (module) errorRemedy',
    'x.ts (module) providerRemedy',
  ]);
});

test('two calls in two functions of one file are two uses, and a new function in a decided file is not decided (lead review S4-1)', () => {
  const source = `
    function first(e) { return errorRemedy(e); }
    const second = e => ({remedy: errorRemedy(e)});
    class Runner { third(e) { return [e].map(x => errorRemedy(x)); } }
    function fourth(e) { return providerRemedy(e.code, e.details); }
  `;
  assert.deepEqual(
    [...remedyCallsIn(source, 'x.ts')].sort(),
    ['x.ts first errorRemedy', 'x.ts fourth providerRemedy', 'x.ts second errorRemedy', 'x.ts third errorRemedy'],
    'a declaration, an arrow in a variable, a method and a callback around which the method is the named function',
  );
  // A mutation: a function added to a file that already has decided uses. Keyed by file and callee it would pass; it must not.
  for (const decided of ['src/errors.ts', 'src/write-review.ts', 'src/campaign-runner.ts']) {
    const added = `\nfunction mutantRemedy(e: MirrorError) { return errorRemedy(e); }\n`,
      found = [...remedyCallsIn(fs.readFileSync(decided, 'utf8') + added, decided)];
    assert.deepEqual(
      found.filter(use => !(use in remedyUses)),
      [decided + ' mutantRemedy errorRemedy'],
      decided + ': the new function is the one undecided use',
    );
  }
});

test('a remedy is made only where it reaches a page in a field the answer gate reads', () => {
  const uses = new Set();
  for (const file of backendContractSourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    if (/\b(?:errorRemedy|providerRemedy)\(/.test(text)) for (const use of remedyCallsIn(text, file)) uses.add(use);
  }
  assert.deepEqual([...uses].sort(), Object.keys(remedyUses).sort(), 'decide each new use: see the comment above');
  for (const [site, why] of Object.entries(remedyUses)) assert.ok(why, site);
});

/** localization.js, the registry and the loader in a page, with a recording fetch that serves the shipped chunks. */
function page({locale = 'ar', version, answer} = {}) {
  const requests = [],
    appended = [];
  const context = createContext({
    URL,
    Map,
    Set,
    Promise,
    Response,
    TextDecoder,
    AbortController,
    performance,
    setTimeout,
    clearTimeout,
    location: {href: 'https://amcp.invalid/', origin: 'https://amcp.invalid', pathname: '/'},
    localStorage: {getItem: key => (key === 'amcp.locale' ? locale : null), setItem() {}},
    window: {addEventListener() {}, removeEventListener() {}},
    document: {
      documentElement: {},
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => ({remove() {}}),
      // Every feature script "loads" at once: this page only measures the catalog requests.
      head: {append: script => (appended.push(script.src), queueMicrotask(() => script.onload()))},
    },
    fetch: async (url, options) => {
      requests.push({url, options});
      if (answer) return answer(url);
      const file = 'web/' + url.replace(/^\/assets\/(?:v\/[0-9a-f]{64}\/)?/, '');
      return new Response(fs.readFileSync(file, 'utf8'));
    },
  });
  const run = code => new Script(code).runInContext(context);
  if (version) run(`const AMCPAssets = {url: path => '/assets/v/${version}/' + path.slice(8)};`);
  for (const file of ['localization.js', 'routes.js', 'route-assets.js']) run(fs.readFileSync('web/' + file, 'utf8'));
  return {context, run, requests, appended, chunks: () => requests.map(r => r.url.replace(/^.*\/locales\/ar\//, ''))};
}

test('About and the public pages load the shell chunk only; a signed-in page adds the workspace and its scripts', async () => {
  const p = page();
  await p.run('initializeUILocale()');
  assert.deepEqual(p.chunks(), ['shell.json']);
  assert.equal(p.run('uiLocale'), 'ar');
  // Public pages need nothing more.
  for (const route of ['/', '/login', '/signup']) {
    assert.deepEqual(Array.from(p.run(`pageLocaleChunks(${JSON.stringify(route)})`)), []);
    assert.equal(p.run(`pageAssetsPending(${JSON.stringify(route)})`), false);
  }
  // Connections has no feature script, yet as a signed-in page it needs the workspace's messages. providers (the sentences of
  // provider refusals) is no page's before it renders (r25-ar-lazy), and neither is answers (what only an error shows,
  // r25-ar-answers): an answer that carries one of their sentences loads them.
  assert.deepEqual(Array.from(p.run("pageLocaleChunks('/connections')")), ['workspace']);
  assert.equal(p.run("pageAssetsPending('/connections')"), true);
  await p.run("ensurePageAssets('/connections')");
  assert.deepEqual(p.chunks(), ['shell.json', 'workspace.json'], 'neither answers.json nor providers.json');
  assert.equal(p.run("pageAssetsPending('/connections')"), false);
  // Settings adds its two scripts' chunks, requested beside the scripts themselves; nothing is fetched twice.
  await p.run("ensurePageAssets('/settings')");
  assert.deepEqual(p.chunks().slice(2).sort(), ['account-approvals.json', 'owner-operations.json']);
  assert.deepEqual(p.appended, ['/assets/owner-operations.js', '/assets/account-approvals.js']);
  // A message only owner-operations.js writes now reads in Arabic.
  const owned = Object.keys(plan.chunks['owner-operations']).find(key => !key.includes('{'));
  p.context.owned = owned;
  assert.equal(p.run('uiText(owned)'), plan.chunks['owner-operations'][owned]);
  // Back in English nothing is fetched, and choosing Arabic again loads every chunk this page has needed.
  const versions = p.requests.length;
  p.context.confirmAction = async () => true;
  p.context.render = async () => {};
  p.context.toast = () => {};
  await p.run("changeUILocale('en')");
  assert.equal(p.run('uiText(owned)'), owned);
  assert.equal(p.requests.length, versions, 'Cached chunks are not fetched again');
  await p.run("changeUILocale('ar')");
  assert.equal(p.run('uiText(owned)'), plan.chunks['owner-operations'][owned]);
});

test('English pages fetch no catalog, versioned chunks may come from the cache, and a failed chunk offers a retry', async () => {
  const english = page({locale: 'en'});
  await english.run('initializeUILocale()');
  await english.run("ensurePageAssets('/connections')");
  assert.deepEqual(english.requests, []);
  const version = 'a'.repeat(64),
    versioned = page({version});
  await versioned.run('initializeUILocale()');
  assert.equal(versioned.requests[0].url, '/assets/v/' + version + '/locales/ar/shell.json');
  assert.equal(versioned.requests[0].options.cache, 'default', 'An immutable snapshot address needs no revalidation');
  const unversioned = page();
  await unversioned.run('initializeUILocale()');
  assert.equal(unversioned.requests[0].options.cache, 'no-cache');
  // A chunk that cannot be downloaded fails the page with the retryable asset error and changes no message.
  let fail = true;
  const flaky = page({
    answer: url =>
      fail && url.includes('workspace')
        ? new Response('', {status: 503})
        : new Response(fs.readFileSync('web/' + url.slice(8), 'utf8')),
  });
  await flaky.run('initializeUILocale()');
  const before = flaky.run('uiMessages.size');
  await assert.rejects(flaky.run("ensurePageAssets('/activity')"), error => error.code === 'PAGE_ASSET_UNAVAILABLE');
  assert.equal(flaky.run('uiMessages.size'), before);
  assert.equal(flaky.run("pageAssetsPending('/activity')"), true);
  fail = false;
  await flaky.run("ensurePageAssets('/activity')");
  assert.ok(flaky.run('uiMessages.size') > before);
  // After a deploy the old snapshot's chunk answers 409: only a reload can help.
  const updated = page({
    version,
    answer: url =>
      url.endsWith('/shell.json')
        ? new Response(fs.readFileSync('web/locales/ar/shell.json', 'utf8'))
        : new Response('ASSET_VERSION_CHANGED', {status: 409}),
  });
  await updated.run('initializeUILocale()');
  await assert.rejects(
    updated.run("ensurePageAssets('/activity')"),
    error => error.code === 'PAGE_ASSET_RELOAD_REQUIRED',
  );
});

// R25 ar-lazy (items 2 and 3), R25 ar-answers (item 2): an answer that carries a sentence of a lazy chunk (`providers`, the
// providers' refusals, or `answers`, what only an error shows) loads both before the page reads the answer, in an error and in a
// 200 that carries diagnostics or a remedy; an answer whose sentences are loaded, and English, load nothing.
const sentence = chunk => Object.keys(plan.chunks[chunk]).find(key => !key.includes('{') && key.length > 20);
const refusal = (message, extra = {}) => ({
  success: false,
  error: {code: 'INVALID_ARGUMENT', message, retryable: false, category: 'request', ...extra},
  meta: {requestId: 'synthetic-request'},
});
const lazyFiles = ['answers.json', 'providers.json'];

for (const holder of ['providers', 'answers'])
  test(`an Arabic answer that carries a sentence only \`${holder}\` has loads both lazy chunks first, in an error and in a 200`, async () => {
    const lazy = sentence(holder),
      eager = sentence('workspace');
    assert.ok(lazy && eager && !(lazy in plan.chunks.workspace) && !(lazy in plan.chunks.shell));
    const p = page();
    await p.run('initializeUILocale()');
    await p.run("uiNeedChunks(['workspace'])");
    assert.deepEqual(p.chunks(), ['shell.json', 'workspace.json']);
    Object.assign(p.context, {lazy, eager});
    // The sentence is in no loaded chunk: it would be shown in English.
    assert.equal(p.run('uiText(lazy)'), lazy);
    // A refusal whose sentences are loaded asks for nothing more.
    Object.assign(p.context, {loaded: refusal(eager)});
    await p.run('uiEnsureAnswerChunks(loaded)');
    assert.deepEqual(p.chunks(), ['shell.json', 'workspace.json']);
    // A success answer without message-shaped objects, whatever text it holds, asks for nothing either.
    Object.assign(p.context, {plain: {success: true, data: {name: lazy, note: lazy, rows: [{label: lazy}]}}});
    await p.run('uiEnsureAnswerChunks(plain)');
    assert.deepEqual(p.chunks(), ['shell.json', 'workspace.json']);
    // A provider's own literal message is shown as it is, so it asks for nothing either.
    Object.assign(p.context, {literal: {success: true, data: {diagnostics: [{provider: {code: 'X', message: lazy}}]}}});
    await p.run('uiEnsureAnswerChunks(literal)');
    assert.deepEqual(p.chunks(), ['shell.json', 'workspace.json']);
    // A 200 that carries a diagnostic with such a sentence waits for the chunks, which then translate it.
    Object.assign(p.context, {
      success: {
        success: true,
        data: {groups: [{diagnostics: [{code: 'X', message: 'rendered ' + lazy, message_localization: {key: lazy}}]}]},
      },
    });
    await p.run('uiEnsureAnswerChunks(success)');
    assert.deepEqual(p.chunks(), ['shell.json', 'workspace.json', ...lazyFiles], 'both chunks, in one wait');
    assert.equal(p.run('uiText(lazy)'), plan.chunks[holder][lazy]);
    // Once loaded, a later answer does not wait or fetch again.
    Object.assign(p.context, {again: refusal(lazy)});
    await p.run('uiEnsureAnswerChunks(again)');
    assert.deepEqual(p.chunks(), ['shell.json', 'workspace.json', ...lazyFiles]);
  });

for (const holder of ['providers', 'answers'])
  test(`the sentences of an answer are read where the page looks them up, for a sentence only \`${holder}\` has: the message, its template, the next step and the remedy`, async () => {
    const lazy = sentence(holder),
      loaded = sentence('workspace');
    // The lazy chunks the answer fetched, in the order it asked for them: both, or none.
    const fetchedFor = async answer => {
      const q = page();
      await q.run('initializeUILocale()');
      await q.run("uiNeedChunks(['workspace'])");
      q.context.answer = answer;
      await q.run('uiEnsureAnswerChunks(answer)');
      return q.chunks().slice(2);
    };
    // Each position the page passes to uiText, one at a time, with every other sentence of the answer already loaded.
    assert.deepEqual(await fetchedFor(refusal(lazy)), lazyFiles, 'error.message');
    assert.deepEqual(await fetchedFor(refusal(loaded)), [], 'a message that is loaded');
    const template = {message_localization: {key: lazy, values: {}}};
    assert.deepEqual(
      await fetchedFor(refusal('Rendered with values 7', template)),
      lazyFiles,
      'the template of a message',
    );
    assert.deepEqual(await fetchedFor(refusal('Rendered with values 7', {message_localization: {key: loaded}})), []);
    assert.deepEqual(await fetchedFor(refusal(loaded, {next_action: lazy})), lazyFiles, 'next_action');
    assert.deepEqual(await fetchedFor(refusal(loaded, {next_action: loaded})), []);
    assert.deepEqual(
      await fetchedFor(refusal(loaded, {remedy: {category: 'request', action: lazy}})),
      lazyFiles,
      'remedy.action',
    );
    assert.deepEqual(
      await fetchedFor(refusal(loaded, {details: {next_action: lazy}})),
      lazyFiles,
      'details.next_action',
    );
    assert.deepEqual(
      await fetchedFor({...refusal(loaded), meta: {message_parts: {base: lazy, suffix: 'a suffix'}}}),
      lazyFiles,
      'the base of a split message',
    );
    // Nested at depth, as a refused step of a plan or a failed level of a report.
    assert.deepEqual(
      await fetchedFor({success: true, data: {steps: [{id: 'a', error: {code: 'X', message: lazy}}]}}),
      lazyFiles,
    );
    // A 200 that carries a remedy, as a failed step of a plan or the findings of a report's quality do (the mixed answers).
    assert.deepEqual(
      await fetchedFor({
        success: true,
        data: {steps: [{id: 'a', error: {code: 'X', message: loaded, remedy: {category: 'request', action: lazy}}}]},
      }),
      lazyFiles,
      'a remedy in a 200',
    );
    // Not where a page looks a sentence up: a name, a note, a row's label, a provider's own message.
    assert.deepEqual(await fetchedFor({success: true, data: {name: lazy, notes: [lazy], rows: [{label: lazy}]}}), []);
    assert.deepEqual(await fetchedFor(refusal(loaded, {provider: {code: 'X', message: lazy}})), []);
  });
test('a signed-in Arabic page fetches providers when the browser is idle after it has rendered, and only then', async () => {
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  };
  const idle = async (locale, signedIn, scheduler = 'requestIdleCallback') => {
    const p = page({locale}),
      queued = [];
    await p.run('initializeUILocale()');
    p.context.session = {authenticated: signedIn};
    if (scheduler === 'requestIdleCallback')
      p.context.requestIdleCallback = (fn, options) => queued.push({fn, options});
    else
      p.context.setTimeout = (fn, ms) => (ms === 15000 ? setTimeout(fn, ms) : (queued.push({fn, ms}), queued.length));
    // A page has just rendered: the shell runs the after-render hooks.
    await p.run('AMCP.hooks.runAfter()');
    return {p, queued};
  };
  // Signed in, Arabic: one idle task, and nothing is fetched while the browser is busy; then the chunk arrives.
  const {p, queued} = await idle('ar', true);
  assert.equal(queued.length, 1);
  assert.deepEqual(p.chunks(), ['shell.json'], 'nothing is fetched until the browser is idle');
  assert.equal(queued[0].options.timeout, 5000, 'and not later than five seconds after the page rendered');
  await p.run('AMCP.hooks.runAfter()');
  assert.equal(queued.length, 1, 'a second render queues no second task');
  queued[0].fn();
  await settle();
  assert.deepEqual(p.chunks(), ['shell.json', ...lazyFiles], 'both lazy chunks, in one task');
  assert.equal(p.run("uiLoadedChunks.has('ar:providers') && uiLoadedChunks.has('ar:answers')"), true);
  await p.run('AMCP.hooks.runAfter()');
  assert.equal(queued.length, 1, 'once they are in, a render queues nothing');
  // Where there is no requestIdleCallback (Safari), a short timeout stands in for it.
  const timed = await idle('ar', true, 'setTimeout');
  assert.equal(timed.queued.length, 1);
  assert.ok(timed.queued[0].ms >= 1000 && timed.queued[0].ms <= 3000, 'a short timeout: ' + timed.queued[0].ms);
  timed.queued[0].fn();
  await settle();
  assert.deepEqual(timed.p.chunks().slice(1), lazyFiles);
  // Not for English, and not for a visitor who is signed out: they would never read a refusal's Arabic.
  for (const [locale, signedIn] of [
    ['en', true],
    ['ar', false],
  ]) {
    const none = await idle(locale, signedIn);
    assert.equal(none.queued.length, 0, locale + ' signedIn=' + signedIn);
    assert.deepEqual(none.p.requests, locale === 'ar' ? none.p.requests.slice(0, 1) : []);
  }
  // A fetch that fails, whichever of the two chunks it is, is dropped without a message, and the next render tries again.
  for (const failing of ['providers', 'answers']) {
    let fail = true;
    const flaky = page({
      answer: url =>
        fail && url.includes(failing)
          ? new Response('', {status: 503})
          : new Response(fs.readFileSync('web/' + url.slice(8), 'utf8')),
    });
    await flaky.run('initializeUILocale()');
    const tasks = [];
    Object.assign(flaky.context, {session: {authenticated: true}, requestIdleCallback: fn => tasks.push(fn)});
    await flaky.run('AMCP.hooks.runAfter()');
    tasks[0]();
    await settle();
    assert.equal(flaky.run('uiChunksReady(answerLocaleChunks)'), false, failing + ' failed');
    fail = false;
    await flaky.run('AMCP.hooks.runAfter()');
    assert.equal(tasks.length, 2);
    tasks[1]();
    await settle();
    assert.equal(flaky.run('uiChunksReady(answerLocaleChunks)'), true, failing + ' is in on the next try');
  }
});

test('an English page, and an answer after the chunk is in, never fetch a catalog chunk for an answer', async () => {
  const lazy = sentence('providers'),
    english = page({locale: 'en'});
  await english.run('initializeUILocale()');
  english.context.answer = refusal(lazy);
  await english.run('uiEnsureAnswerChunks(answer)');
  assert.deepEqual(english.requests, []);
  for (const name of ['providers', 'answers'])
    assert.equal(
      english.run(`uiCatalogChunks.has("${name}")`),
      false,
      'English adds nothing a language change would load: ' + name,
    );
  // A report of 60,000 rows is read whole, in a few milliseconds, and its diagnostics after the rows are still found.
  const arabic = page();
  await arabic.run('initializeUILocale()');
  arabic.context.big = {
    success: true,
    data: {
      rows: Array.from({length: 60000}, (_, row) => ({row, a: 1, b: {c: 2}})),
      diagnostics: [{code: 'X', message: lazy}],
    },
  };
  const started = performance.now();
  await arabic.run('uiEnsureAnswerChunks(big)');
  assert.deepEqual(arabic.chunks().slice(1), lazyFiles, 'its diagnostics, after the rows, are found');
  assert.ok(performance.now() - started < 3000, 'a large answer is read in bounded time');
});

/** The workspace's boot (web/app.js) at a page, answering /api/session with `answer`; the page's files are recorded. */
function boot(pathname, answer, available = () => true) {
  const app = fs.readFileSync('web/app.js', 'utf8'),
    start = app.indexOf('(async () => {\n  // All deferred feature scripts'),
    code = app.slice(start, app.indexOf('})();', start) + 5),
    events = [];
  let catalogArrived;
  const context = createContext({
    document: {readyState: 'complete', body: {classList: {contains: () => false}}},
    location: {hash: '', pathname},
    pageAssetsFor: path => (path === '/settings' ? ['owner-operations.js', 'account-approvals.js'] : []),
    loadPageAsset: async file => events.push('script ' + file),
    pageLocaleChunks: () => ['workspace', 'owner-operations', 'account-approvals'],
    uiPrefetchChunks: chunks => events.push('chunks ' + chunks.join(' ')),
    routeAvailable: (path, who) => available(path, who),
    initializeUILocale: () => {
      events.push('catalog requested');
      return new Promise(resolve => (catalogArrived = resolve));
    },
    api: async path => {
      events.push('request ' + path);
      return answer;
    },
    refresh: async () => events.push('render'),
    fragmentTarget: () => null,
  });
  const running = new Script(code).runInContext(context);
  return {events, context, running, arrive: () => catalogArrived()};
}

test('the workspace asks who is signed in while the shell chunk downloads (regression: it waited for the catalog)', async () => {
  const f = boot('/settings', {authenticated: true});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(
    f.events,
    [
      'request /api/session',
      'catalog requested',
      // The signed-in page's files start as soon as the session answers, before the shell chunk has arrived.
      'script owner-operations.js',
      'script account-approvals.js',
      'chunks workspace owner-operations account-approvals',
    ],
    'Everything the first page needs starts before the catalog arrives',
  );
  f.arrive();
  await f.running;
  assert.deepEqual(f.events.at(-1), 'render', 'The page still renders after both');
  assert.equal(f.context.session.authenticated, true);
});

test('a signed-out or out-of-scope visitor downloads no page files (regression: they started before the session answered)', async () => {
  // Signed out at a signed-in page, and a test account at a page outside its scope: only the session and the shell
  // chunk are requested, and the page still renders (the sign-in or scope notice).
  for (const f of [
    boot('/settings', {authenticated: false}),
    boot('/settings', {authenticated: true, testAccount: true}, (path, who) => !who.testAccount),
  ]) {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.events, ['request /api/session', 'catalog requested']);
    f.arrive();
    await f.running;
    assert.deepEqual(f.events, ['request /api/session', 'catalog requested', 'render']);
  }
});
