import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Script, createContext} from 'node:vm';
import {parsers} from 'prettier/plugins/babel';
import {backendContractSourceFiles, checkWebLocales} from './check-locales.mjs';

// WEB-07: one Arabic catalog of 1.9 MB gated every Arabic page; About downloaded all of it to translate 54 strings,
// and the workspace waited for it before asking who was signed in. web/locales/ar.json stays the authored catalog;
// the browser loads the chunks generated from it into web/locales/ar/:
//   shell        the shell scripts, the public pages (About, sign-in, the landing page) and what the website's own
//                server (server/*.ts) says on them; every page loads it first;
//   workspace    what the workspace's services (src/*.ts) say that a page shows from an answer that refused nothing:
//                explanations, recipes, report and measurement copy; every signed-in page loads it;
//   answers      what only an error shows: remedies, next steps and the refusals of the core (R25 ar-answers, Design B of the
//                headroom study). `answerOnlyKeys` names them by where each key is written;
//   providers    the provider contracts' refusal sentences and nothing else (R25 ar-lazy);
//   <module>     what one lazily loaded page script writes and nothing above carries; loaded with that script.
// No page waits for `answers` or `providers`: an error is shown only from an answer, so web/route-assets.js names them in
// `answerLocaleChunks`, and an answer that carries a sentence of them loads them first (`uiEnsureAnswerChunks`). `answers` exists
// when that list names it.
// A message goes to the first chunk whose sources write it, so a page always has it once its chunks are loaded; a script
// also carries every message it writes that only a lazy chunk carries. The check below fails when a chunk is stale, too
// large or missing a message its scripts require, and no script may rely on a lazy chunk.

export const chunkDirectory = 'web/locales/ar';
/** Bytes per chunk: the browser's download bound for one chunk (web/localization.js). */
export const chunkLimit = 1048576;
export const chunkCountLimit = 64;
const skipKeys = new Set(['loc', 'start', 'end', 'range', 'extra', 'comments', 'leadingComments', 'trailingComments']);

/** A type as the proof below reads it: a function type that returns `never`, a reference to a named type, or neither. */
const describeType = type =>
  type?.type === 'TSFunctionType'
    ? (type.returnType ?? type.typeAnnotation)?.typeAnnotation?.type === 'TSNeverKeyword'
      ? {never: true}
      : null
    : type?.type === 'TSTypeReference' && type.typeName?.type === 'Identifier'
      ? {ref: type.typeName.name}
      : null;
const isFunction = node =>
  ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node?.type);
/** The call a one-statement function body is (`throw`, `return f(…)`, `f(…)`, or an arrow's expression), by callee name. */
function soleStatement(fn) {
  const body = fn.body.type === 'BlockStatement' ? (fn.body.body.length === 1 ? fn.body.body[0] : null) : fn.body;
  if (!body) return {throws: false, delegate: null};
  const expression =
    body.type === 'ReturnStatement' ? body.argument : body.type === 'ExpressionStatement' ? body.expression : body;
  return {
    throws: body.type === 'ThrowStatement',
    delegate:
      expression?.type === 'CallExpression' && expression.callee?.type === 'Identifier' ? expression.callee.name : null,
  };
}
/**
 * Every string a source writes literally (string literals and the fixed parts of template literals), and what the backend
 * needs to know about where each is written (R25 ar-lazy), so no occurrence is read twice:
 *   loose   strings written anywhere but as a direct argument of a call to a plain function or of `new` (a property value, a
 *           variable, a return value, a method call, a list element, a template): data a page may show from an answer that
 *           refused nothing;
 *   calls   the other strings, with the function each is handed to (`invalid('…')`, `new MirrorError(code, '…')`);
 *   defs    each function or constant the source defines or imports by name, as far as the proof below needs it.
 */
export function writtenStrings(source, file) {
  const strings = new Set(),
    loose = new Set(),
    calls = [],
    defs = new Map(),
    aliases = new Map(),
    imports = new Map(),
    typescript = file.endsWith('.ts'),
    parser = typescript ? parsers['babel-ts'] : parsers.babel;
  const define = (name, record) => defs.set(name, [...(defs.get(name) ?? []), record]);
  const functionRecord = (fn, declared) => ({
    never: fn.returnType?.typeAnnotation?.type === 'TSNeverKeyword',
    typeOf: describeType(declared),
    returns: describeType(fn.returnType?.typeAnnotation),
    ...soleStatement(fn),
  });
  const visit = (node, parent) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'StringLiteral') {
      strings.add(node.value);
      if (
        (parent?.type === 'CallExpression' || parent?.type === 'NewExpression') &&
        parent.callee?.type === 'Identifier' &&
        parent.arguments.includes(node)
      )
        calls.push({text: node.value, name: parent.callee.name, isNew: parent.type === 'NewExpression'});
      else loose.add(node.value);
    }
    if (node.type === 'TemplateLiteral')
      for (const quasi of node.quasis) {
        const text = quasi.value.cooked ?? quasi.value.raw;
        strings.add(text);
        loose.add(text);
      }
    if (typescript) {
      if (node.type === 'TSTypeAliasDeclaration') aliases.set(node.id.name, describeType(node.typeAnnotation));
      else if (node.type === 'FunctionDeclaration' && node.id) define(node.id.name, functionRecord(node, null));
      else if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
        const declared = node.id.typeAnnotation?.typeAnnotation;
        if (isFunction(node.init)) define(node.id.name, functionRecord(node.init, declared));
        else
          define(node.id.name, {
            typeOf: describeType(declared),
            factory:
              node.init?.type === 'CallExpression' && node.init.callee?.type === 'Identifier'
                ? node.init.callee.name
                : null,
          });
      } else if (node.type === 'ImportDeclaration' && node.source.value.startsWith('.'))
        for (const specifier of node.specifiers)
          if (specifier.type === 'ImportSpecifier')
            imports.set(specifier.local.name, {
              file: path.posix
                .normalize(path.posix.join(path.posix.dirname(file), node.source.value))
                .replace(/\.js$/, '.ts'),
              name: specifier.imported.name ?? specifier.imported.value,
            });
    }
    for (const [key, value] of Object.entries(node))
      if (!skipKeys.has(key)) for (const child of Array.isArray(value) ? value : [value]) visit(child, node);
  };
  visit(parser.parse(source, {filepath: file}).program, null);
  return {strings, loose, calls, defs, aliases, imports};
}
/**
 * Whether a call to `name` in `file` provably never returns, read from the sources alone: the function is declared to
 * return `never`, is one `throw`, hands everything to a function that provably throws, or is a constant declared with (or
 * built by a factory that returns) a function type returning `never`. A name that cannot be resolved, or that any
 * same-named definition in the file does not satisfy, is not proven: the strings handed to it stay eager.
 */
function throwsWhenCalled(index, file, name, depth = 0) {
  const here = index.get(file);
  if (!here || depth > 6) return false;
  /** Whether a described type is (an alias of, here or in an imported module) a function type that returns `never`. */
  const neverType = (type, inFile, level = 0) => {
    if (!type || level > 6) return false;
    if (type.never) return true;
    const owner = index.get(inFile),
      imported = owner?.imports.get(type.ref);
    if (owner?.aliases.has(type.ref)) return neverType(owner.aliases.get(type.ref), inFile, level + 1);
    return imported ? neverType({ref: imported.name}, imported.file, level + 1) : false;
  };
  /** A constant built by `factory(…)` is a refusal when every definition of the factory returns such a function type. */
  const factoryReturnsRefusal = factory => {
    const imported = here.imports.get(factory),
      local = here.defs.has(factory),
      owner = local ? file : imported?.file,
      made = index.get(owner)?.defs.get(local ? factory : imported?.name);
    return Boolean(made?.length) && made.every(record => neverType(record.returns, owner));
  };
  const records = here.defs.get(name);
  if (!records) {
    const imported = here.imports.get(name);
    return imported ? throwsWhenCalled(index, imported.file, imported.name, depth + 1) : false;
  }
  return records.every(
    record =>
      record.never ||
      record.throws ||
      neverType(record.typeOf, file) ||
      (record.delegate && throwsWhenCalled(index, file, record.delegate, depth + 1)) ||
      (record.factory && factoryReturnsRefusal(record.factory)),
  );
}
/**
 * The strings the backend writes anywhere but as the message of a refusal, in one occurrence at least: written as data (a
 * property value, a variable, a template), handed to a method or to a function that can return, or to something that cannot
 * be resolved. A string left out is only ever handed to a function that provably throws, or to a constructor imported from
 * src/errors.ts. A file `ignored` names is not read for occurrences (R25 ar-answers: a declared error source, whose every string
 * is an error's text), but stays in the index, so a function it defines is still resolved.
 */
function dataStrings(index, ignored = () => false) {
  const eager = new Set(),
    proven = new Map();
  for (const [file, here] of index) {
    if (ignored(file)) continue;
    for (const text of here.loose) eager.add(text);
    for (const call of here.calls) {
      const key = file + '\0' + call.name + (call.isNew ? '\0new' : '');
      if (!proven.has(key))
        proven.set(
          key,
          call.isNew ? here.imports.get(call.name)?.file === 'src/errors.ts' : throwsWhenCalled(index, file, call.name),
        );
      if (!proven.get(key)) eager.add(call.text);
    }
  }
  return eager;
}
/**
 * R25 ar-answers: the files that are an error's own text, whatever a string in them is written as. The error module (the
 * class, and the remedy and next step every refusal carries), the report errors, the transport's messages, and each provider's
 * remedy table. The study named `AmcpError`; the code's class is `MirrorError` (src/errors.ts).
 */
export const errorSourceFiles = Object.freeze(['src/errors.ts', 'src/report-errors.ts', 'src/transport.ts']);
export const isErrorSource = file => errorSourceFiles.includes(file) || /^src\/[a-z0-9-]+-remedies\.ts$/.test(file);
/**
 * The inspected kinds (tools/check-locales.mjs, `server:<kind>`) that list refusals, recovery hints and next steps. A key that
 * any other kind lists (an explanation, a label, a catalog's product) is shown from an answer that refused nothing, so it stays
 * in `workspace`. A kind only vetoes: `server:reporting-failures` also lists display warnings, and what proves a key is an
 * error's alone is where the backend writes it (`answerOnlyKeys`).
 */
export const answerKinds = Object.freeze([
  'server:backend-contracts',
  'server:core-contracts',
  'server:measurement-failures',
  'server:measurement-remedies',
  'server:portfolio-failures',
  'server:report-next-actions',
  'server:reporting-failures',
  'server:shared-recovery',
]);
/**
 * The keys of `keys` that only an error shows (R25 ar-answers, Design B of the headroom study), from what the plan has read:
 *   index    each backend file's `writtenStrings` (src and server);
 *   sources  what the inspectors require, by source (`server:<kind>`, `web/<script>`, `html`);
 *   scripts  every string a page script writes, or requires.
 * A key is an error's alone when all of these hold, and any other stays where every signed-in page has it:
 *   - some backend file writes it literally, so where it goes is known (a message no file writes is composed, or dynamic);
 *   - no file but a declared error source writes it as data: a property value, a variable, a template, a call to a function that
 *     can return, or a call that cannot be resolved. What remains is handed only to a function that provably throws, or to
 *     `new` of a class imported from src/errors.ts: the message of an error (a declared source is not read for occurrences);
 *   - no page script writes it (a script cannot wait for an answer: `answers` is no page's before it renders);
 *   - no inspected kind lists it besides the refusal and recovery kinds (`answerKinds`).
 * It fails safe, as the proof of `providers` does: a key it cannot place stays in `workspace`.
 */
export function answerOnlyKeys(keys, {index, sources, scripts, errorSource = isErrorSource}) {
  const data = dataStrings(index, errorSource),
    written = new Set(),
    shown = new Set();
  for (const here of index.values()) for (const text of here.strings) written.add(text);
  for (const [kind, set] of sources)
    if (kind.startsWith('server:') && !answerKinds.includes(kind)) for (const key of set) shown.add(key);
  return new Set([...keys].filter(key => written.has(key) && !data.has(key) && !scripts.has(key) && !shown.has(key)));
}
function typescriptFiles(root, directory) {
  const out = [];
  const visit = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes: true})) {
      const file = relative + '/' + entry.name;
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(file);
    }
  };
  visit(directory);
  return out.sort();
}
/**
 * The loader's lazily loaded scripts in order, each one's dependencies, and the Arabic chunks no page waits for
 * (web/route-assets.js: `answerLocaleChunks`, none in a loader that names no such chunk).
 */
export function loaderFiles(root = process.cwd()) {
  const context = createContext({});
  new Script(fs.readFileSync(path.join(root, 'web/routes.js'), 'utf8')).runInContext(context);
  new Script(
    fs.readFileSync(path.join(root, 'web/route-assets.js'), 'utf8') +
      "\n;globalThis.__plan = JSON.stringify({order: pageAssetOrder, dependencies: pageAssetDependencies, lazy: typeof answerLocaleChunks === 'undefined' ? [] : answerLocaleChunks});",
  ).runInContext(context);
  const plan = JSON.parse(context.__plan);
  // A page's stylesheets (V2-WEB-02) are in the loader's list too; only scripts carry messages.
  return {
    modules: plan.order.filter(file => file.endsWith('.js') && !file.startsWith('vendor/')),
    dependencies: plan.dependencies,
    lazy: plan.lazy,
  };
}
/** The chunk a lazily loaded script's own messages travel in. */
export const moduleChunk = file => file.replace(/\.js$/, '');
/** The scripts each page document loads up front: the workspace shell's and the public pages'. */
function documentScripts(root) {
  const web = path.join(root, 'web');
  return [
    ...new Set(
      fs
        .readdirSync(web)
        .filter(file => file.endsWith('.html'))
        .flatMap(file =>
          [...fs.readFileSync(path.join(web, file), 'utf8').matchAll(/<script src="\/assets\/([^"]+)"/g)].map(
            m => m[1],
          ),
        ),
    ),
  ].sort();
}
/** The chunk plan: {chunks: {name: {key: translation}}, modules, dependencies, sources, catalog}. */
export function planLocaleChunks(root = process.cwd(), locales = checkWebLocales(root)) {
  const {catalog, sources} = locales,
    keys = Object.keys(catalog),
    {modules, dependencies, lazy} = loaderFiles(root),
    shellFiles = documentScripts(root).filter(file => !modules.includes(file)),
    // Each source is parsed once: the strings it writes and the role of each occurrence.
    analysed = new Map(),
    analysis = file => {
      if (!analysed.has(file)) analysed.set(file, writtenStrings(fs.readFileSync(path.join(root, file), 'utf8'), file));
      return analysed.get(file);
    },
    written = file => analysis(file).strings,
    providerFiles = new Set(backendContractSourceFiles(root)),
    serverFiles = typescriptFiles(root, 'server'),
    srcFiles = typescriptFiles(root, 'src').filter(file => !providerFiles.has(file));
  const union = sets => {
    const out = new Set();
    for (const set of sets) for (const value of set ?? []) out.add(value);
    return out;
  };
  const shellSources = union([
    ...shellFiles.map(file => sources.get('web/' + file)),
    ...shellFiles.map(file => written('web/' + file)),
    sources.get('html'),
    sources.get('server:website-failures'),
    sources.get('server:platforms'),
    ...serverFiles.map(written),
  ]);
  // R25 ar-lazy: what only a refusal asks for. The messages a provider contract's failures carry are inspected as
  // 'server:backend-contracts'; any of them the backend also writes as data (a property value, a variable, a template) or
  // hands to a function that can return (a method call, a helper that is not one `throw`) is left out, because a page may
  // show it from an answer that refused nothing, as the ad previews page shows `not_found_reason`. Before this, every
  // string any backend file wrote went to `providers` once no earlier chunk had it: 694 of its 4,710 messages were words
  // the page scripts write and report text shown from success answers.
  const index = new Map([...providerFiles].map(file => [file, analysis(file)])),
    refusals = sources.get('server:backend-contracts') ?? new Set(),
    data = dataStrings(index),
    backendWritten = union([...providerFiles].map(written));
  const workspaceSources = union([
    ...[...sources]
      .filter(([name]) => name.startsWith('server:') && name !== 'server:backend-contracts')
      .map(([, set]) => set),
    ...srcFiles.map(written),
  ]);
  // R25 ar-answers: of what would travel in `workspace`, the keys that only an error shows go to `answers`, a chunk no page waits
  // for either (the loader names it in `answerLocaleChunks`; a loader that does not gets none, as nothing would load it).
  const scriptFiles = fs.readdirSync(path.join(root, 'web')).filter(file => file.endsWith('.js')),
    answerOnly = lazy.includes('answers')
      ? answerOnlyKeys(keys, {
          index,
          sources,
          scripts: union([
            ...scriptFiles.map(file => sources.get('web/' + file)),
            ...scriptFiles.map(file => written('web/' + file)),
          ]),
        })
      : new Set(),
    homeOf = key => (answerOnly.has(key) ? 'answers' : 'workspace');
  const assigned = new Map(),
    chunks = {shell: {}, workspace: {}, ...(lazy.includes('answers') ? {answers: {}} : {}), providers: {}};
  for (const file of modules) chunks[moduleChunk(file)] = {};
  const put = (chunk, key) => {
    chunks[chunk][key] = catalog[key];
    if (!assigned.has(key)) assigned.set(key, new Set());
    assigned.get(key).add(chunk);
  };
  for (const key of keys)
    if (shellSources.has(key)) put('shell', key);
    else if (workspaceSources.has(key)) put(homeOf(key), key);
    else if (refusals.has(key) && !data.has(key)) put('providers', key);
    // Anything else the backend writes may reach any signed-in page in a success answer (a report preset's name, a coverage
    // note), whatever script writes it too, so it travels in the chunk every signed-in page has.
    else if (refusals.has(key) || backendWritten.has(key)) put(homeOf(key), key);
  const moduleStrings = new Map(
    modules.map(file => [file, union([sources.get('web/' + file), written('web/' + file)])]),
  );
  for (const key of keys) {
    const owners = modules.filter(file => moduleStrings.get(file).has(key)),
      eager = [...(assigned.get(key) ?? [])].some(chunk => !lazy.includes(chunk));
    // A message no source writes (an older or dynamically named one) goes where every signed-in page has it.
    if (!assigned.has(key) && !owners.length) put('workspace', key);
    // A script finds what it writes in its own chunk, unless a chunk every page loads carries it: a lazy chunk is not there
    // before the page renders (R25 ar-lazy).
    if (!eager) for (const file of owners) put(moduleChunk(file), key);
  }
  const sorted = Object.fromEntries(
    Object.entries(chunks).map(([name, chunk]) => [
      name,
      Object.fromEntries(
        Object.keys(chunk)
          .sort()
          .map(key => [key, chunk[key]]),
      ),
    ]),
  );
  return {
    chunks: sorted,
    modules,
    dependencies,
    lazy,
    shellFiles,
    sources,
    catalog,
    problems: locales.problems,
    answerOnly,
  };
}
const serialize = chunk => JSON.stringify(chunk, null, 2) + '\n';
/**
 * The chunks a lazily loaded script can rely on once its page is ready: its own, its dependencies' and the shared ones. A
 * lazy chunk (`answerLocaleChunks` in web/route-assets.js) is no page's before it renders, so no script can rely on it:
 * `providers` unless the loader says otherwise, and never `answers`, which is lazy by definition (R25 ar-answers).
 */
export function chunksWith(file, dependencies, lazy = ['providers']) {
  const out = new Set(['shell', 'workspace', 'providers'].filter(name => !lazy.includes(name))),
    visit = name => {
      // A page's stylesheets (V2-WEB-02) are dependencies too, and carry no messages: they have no chunk (package charts
      // makes the report builder depend on the V2 sheets, Merge C).
      if (!name.endsWith('.js') || out.has(moduleChunk(name))) return;
      out.add(moduleChunk(name));
      for (const dependency of dependencies[name] ?? []) visit(dependency);
    };
  visit(file);
  return out;
}
/** Problems with the committed chunks: stale or stray files, sizes, and messages a script cannot find. */
export function localeChunkProblems(root = process.cwd(), plan = planLocaleChunks(root)) {
  const problems = [],
    directory = path.join(root, chunkDirectory),
    names = Object.keys(plan.chunks);
  if (names.length > chunkCountLimit)
    problems.push(chunkDirectory + ': ' + names.length + ' chunks (limit ' + chunkCountLimit + ')');
  const present = fs.existsSync(directory) ? fs.readdirSync(directory).filter(file => file.endsWith('.json')) : [];
  for (const file of present)
    if (!names.includes(file.replace(/\.json$/, '')))
      problems.push(
        chunkDirectory + '/' + file + ' is not a generated chunk; run node tools/locale-chunks.mjs --write',
      );
  for (const [name, chunk] of Object.entries(plan.chunks)) {
    const file = path.join(directory, name + '.json'),
      expected = serialize(chunk);
    if (Buffer.byteLength(expected, 'utf8') > chunkLimit)
      problems.push(
        chunkDirectory +
          '/' +
          name +
          '.json: ' +
          Buffer.byteLength(expected, 'utf8') +
          ' bytes (limit ' +
          chunkLimit +
          ')',
      );
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== expected)
      problems.push(chunkDirectory + '/' + name + '.json is stale; run node tools/locale-chunks.mjs --write');
  }
  // Coverage: every catalog message travels in a chunk, and each script finds the messages it requires.
  const inChunk = new Map(names.map(name => [name, new Set(Object.keys(plan.chunks[name]))]));
  for (const key of Object.keys(plan.catalog))
    if (!names.some(name => inChunk.get(name).has(key))) problems.push('Arabic message in no chunk: ' + key);
  const missing = (label, required, available) => {
    for (const key of required ?? [])
      if (key in plan.catalog && ![...available].some(name => inChunk.get(name)?.has(key)))
        problems.push(label + ' requires a message none of its chunks carries: ' + key);
  };
  for (const file of plan.shellFiles) missing('web/' + file, plan.sources.get('web/' + file), ['shell']);
  missing('index.html and the public pages', plan.sources.get('html'), ['shell']);
  for (const source of ['server:website-failures', 'server:platforms'])
    missing(source, plan.sources.get(source), ['shell']);
  // What the backend says reaches a page in an answer. A refusal sentence may travel in a lazy chunk, which the answer loads
  // first, as may a recovery hint, a next step or a refusal of the core, which an error alone shows (`answers`, R25 ar-answers);
  // every other message of the backend is shown from answers that refused nothing, so it travels in a chunk every signed-in
  // page has (R25 ar-lazy).
  const refusalKey = 'server:backend-contracts';
  for (const [source, set] of plan.sources)
    if (source.startsWith('server:'))
      missing(source, set, [
        'shell',
        'workspace',
        ...(answerKinds.includes(source) ? ['answers'] : []),
        ...(source === refusalKey ? ['providers'] : []),
      ]);
  for (const name of plan.lazy ?? [])
    if (!names.includes(name)) problems.push('web/route-assets.js names a lazy chunk that does not exist: ' + name);
  // A lazy chunk holds only what an error shows: `providers` the refusal sentences, `answers` the keys the classifier names. No
  // page script and no other source may need a message that is in it, and `workspace` holds none that `answers` should.
  for (const name of plan.lazy ?? [])
    for (const key of Object.keys(plan.chunks[name] ?? {}))
      if (name === 'answers') {
        if (!plan.answerOnly?.has(key))
          problems.push('answers chunk carries a message that something other than an error shows: ' + key);
      } else if (!plan.sources.get(refusalKey)?.has(key))
        problems.push(name + ' chunk carries a message no provider refusal writes: ' + key);
  for (const key of Object.keys(plan.chunks.workspace ?? {}))
    if (plan.answerOnly?.has(key)) problems.push('workspace chunk carries a message only an error shows: ' + key);
  for (const file of plan.modules)
    missing('web/' + file, plan.sources.get('web/' + file), chunksWith(file, plan.dependencies, plan.lazy));
  return problems;
}
export function writeLocaleChunks(root = process.cwd()) {
  const plan = planLocaleChunks(root),
    directory = path.join(root, chunkDirectory);
  fs.mkdirSync(directory, {recursive: true});
  for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.json')))
    if (!(file.replace(/\.json$/, '') in plan.chunks)) fs.rmSync(path.join(directory, file));
  for (const [name, chunk] of Object.entries(plan.chunks))
    fs.writeFileSync(path.join(directory, name + '.json'), serialize(chunk));
  return plan;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = process.argv.includes('--write') ? writeLocaleChunks() : planLocaleChunks();
  const problems = localeChunkProblems(process.cwd(), plan);
  for (const [name, chunk] of Object.entries(plan.chunks))
    console.log(
      name.padEnd(28) +
        String(Object.keys(chunk).length).padStart(6) +
        ' messages ' +
        String(Buffer.byteLength(serialize(chunk), 'utf8')).padStart(9) +
        ' bytes',
    );
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }
}
