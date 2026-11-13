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
//   workspace    what the workspace's services (src/*.ts) say: errors, explanations, recipes, report and measurement
//                copy; every signed-in page loads it;
//   providers    the provider contracts' refusals (the reviewed families' sources); every signed-in page loads it;
//   <module>     what one lazily loaded page script writes and nothing above carries; loaded with that script.
// A message goes to the first chunk whose sources write it, so a page always has it once its chunks are loaded. The
// check below fails when a chunk is stale, too large or missing a message its scripts require.

export const chunkDirectory = 'web/locales/ar';
/** Bytes per chunk: the browser's download bound for one chunk (web/localization.js). */
export const chunkLimit = 1048576;
export const chunkCountLimit = 64;
const skipKeys = new Set(['loc', 'start', 'end', 'range', 'extra', 'comments', 'leadingComments', 'trailingComments']);

/** Every string a source writes literally (string literals and the fixed parts of template literals). */
function writtenStrings(source, file) {
  const strings = new Set(),
    parser = file.endsWith('.ts') ? parsers['babel-ts'] : parsers.babel;
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'StringLiteral') strings.add(node.value);
    if (node.type === 'TemplateLiteral')
      for (const quasi of node.quasis) strings.add(quasi.value.cooked ?? quasi.value.raw);
    for (const [key, value] of Object.entries(node))
      if (!skipKeys.has(key)) for (const child of Array.isArray(value) ? value : [value]) visit(child);
  };
  visit(parser.parse(source, {filepath: file}).program);
  return strings;
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
/** The loader's lazily loaded scripts in order, and each one's dependencies (web/route-assets.js). */
export function loaderFiles(root = process.cwd()) {
  const context = createContext({});
  new Script(fs.readFileSync(path.join(root, 'web/routes.js'), 'utf8')).runInContext(context);
  new Script(
    fs.readFileSync(path.join(root, 'web/route-assets.js'), 'utf8') +
      '\n;globalThis.__plan = JSON.stringify({order: pageAssetOrder, dependencies: pageAssetDependencies});',
  ).runInContext(context);
  const plan = JSON.parse(context.__plan);
  // A page's stylesheets (V2-WEB-02) are in the loader's list too; only scripts carry messages.
  return {
    modules: plan.order.filter(file => file.endsWith('.js') && !file.startsWith('vendor/')),
    dependencies: plan.dependencies,
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
    {modules, dependencies} = loaderFiles(root),
    shellFiles = documentScripts(root).filter(file => !modules.includes(file)),
    written = file => writtenStrings(fs.readFileSync(path.join(root, file), 'utf8'), file),
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
  const providerSources = union([sources.get('server:backend-contracts'), ...[...providerFiles].map(written)]);
  const workspaceSources = union([
    ...[...sources]
      .filter(([name]) => name.startsWith('server:') && name !== 'server:backend-contracts')
      .map(([, set]) => set),
    ...srcFiles.map(written),
  ]);
  const assigned = new Map(),
    chunks = {shell: {}, workspace: {}, providers: {}};
  for (const file of modules) chunks[moduleChunk(file)] = {};
  const put = (chunk, key) => {
    chunks[chunk][key] = catalog[key];
    if (!assigned.has(key)) assigned.set(key, new Set());
    assigned.get(key).add(chunk);
  };
  for (const key of keys)
    if (shellSources.has(key)) put('shell', key);
    else if (workspaceSources.has(key)) put('workspace', key);
    else if (providerSources.has(key)) put('providers', key);
  const moduleStrings = new Map(
    modules.map(file => [file, union([sources.get('web/' + file), written('web/' + file)])]),
  );
  for (const key of keys) {
    if (assigned.has(key)) continue;
    const owners = modules.filter(file => moduleStrings.get(file).has(key));
    // A message no source writes (an older or dynamically named one) goes where every signed-in page has it.
    if (!owners.length) put('workspace', key);
    for (const file of owners) put(moduleChunk(file), key);
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
  return {chunks: sorted, modules, dependencies, shellFiles, sources, catalog, problems: locales.problems};
}
const serialize = chunk => JSON.stringify(chunk, null, 2) + '\n';
/** The chunks a lazily loaded script can rely on once its page is ready: its own, its dependencies' and the shared. */
export function chunksWith(file, dependencies) {
  const out = new Set(['shell', 'workspace', 'providers']),
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
  for (const [source, set] of plan.sources)
    if (source.startsWith('server:')) missing(source, set, ['shell', 'workspace', 'providers']);
  for (const file of plan.modules)
    missing('web/' + file, plan.sources.get('web/' + file), chunksWith(file, plan.dependencies));
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
