import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Script, createContext} from 'node:vm';
import {parsers} from 'prettier/plugins/babel';

// WEB-07: the website's classic scripts share one global scope, and features used to extend each other by reassigning
// a shell function at load time (render in account-scope.js, renderAccountPage in account-security.js, renderSettings
// twice in owner-operations.js and account-approvals.js; identity.js's sign-in page, field and social-button builders
// were replaced the same way and kept rendering only in tests). The composition then depended on load order, and a
// wrapper dropped in a refactor changed a page without an error. Scripts now register with the shell's extension
// points (AMCP.routes and AMCP.hooks in web/routes.js). For every document the website serves, this check refuses:
//   a reassignment  a top-level assignment to a function one of the document's scripts declares, directly or through
//                   window, globalThis or self;
//   a second copy   a top-level function or var declared again by another script of the same document, which replaces
//                   the first just as silently.

const globalObjects = new Set(['window', 'globalThis', 'self']);

/** The functions and other names a script declares at its top level, and its top-level assignments to globals. */
export function scriptBindings(source, file) {
  const program = parsers.babel.parse(source, {filepath: file}).program,
    functions = [],
    names = [],
    assignments = [];
  const assigned = node => {
    if (node?.type === 'SequenceExpression') return node.expressions.forEach(assigned);
    if (node?.type !== 'AssignmentExpression') return;
    const target = node.left;
    const name =
      target?.type === 'Identifier'
        ? target.name
        : target?.type === 'MemberExpression' &&
            !target.computed &&
            target.object?.type === 'Identifier' &&
            globalObjects.has(target.object.name)
          ? target.property?.name
          : undefined;
    if (name) assignments.push({name, line: node.loc?.start?.line ?? 0});
    assigned(node.right);
  };
  for (const statement of program.body) {
    if (statement.type === 'FunctionDeclaration' && statement.id) {
      functions.push(statement.id.name);
      names.push({name: statement.id.name, kind: 'function', line: statement.loc?.start?.line ?? 0});
    }
    if (statement.type === 'VariableDeclaration')
      for (const declaration of statement.declarations)
        if (declaration.id?.type === 'Identifier')
          names.push({name: declaration.id.name, kind: statement.kind, line: statement.loc?.start?.line ?? 0});
    if (statement.type === 'ExpressionStatement') assigned(statement.expression);
  }
  return {functions, names, assignments};
}
/** Every reassignment and second copy of a declared function among one document's scripts ({file: source}). */
export function reassignmentProblems(sources) {
  const declared = new Map(),
    bindings = new Map();
  for (const [file, source] of Object.entries(sources)) {
    const result = scriptBindings(source, file);
    bindings.set(file, result);
    for (const name of result.functions) if (!declared.has(name)) declared.set(name, file);
  }
  const problems = [],
    first = new Map();
  for (const [file, {assignments, names}] of bindings) {
    for (const {name, line} of assignments)
      if (declared.has(name))
        problems.push(
          file +
            ':' +
            line +
            ': reassigns ' +
            name +
            ' (declared in ' +
            declared.get(name) +
            '); extend a page with AMCP.routes.extend or a render with AMCP.hooks instead (WEB-07)',
        );
    for (const binding of names) {
      const earlier = first.get(binding.name);
      if (!earlier) first.set(binding.name, {...binding, file});
      // A second let, const or class in one global scope fails to load at all; a function or var replaces silently.
      else if (
        earlier.file !== file &&
        [earlier.kind, binding.kind].some(kind => kind === 'function' || kind === 'var')
      )
        problems.push(
          file +
            ':' +
            binding.line +
            ': declares ' +
            binding.name +
            ' again (first declared in ' +
            earlier.file +
            '), which silently replaces it; keep one definition (WEB-07)',
        );
    }
  }
  return problems;
}
/** The scripts of each document the website serves, in load order: its own scripts, and for the workspace shell every
 * file the route loader may add. */
export function documentScripts(root = process.cwd()) {
  const web = path.join(root, 'web'),
    documents = {};
  for (const page of fs
    .readdirSync(web)
    .filter(file => file.endsWith('.html'))
    .sort()) {
    const scripts = [
      ...fs
        .readFileSync(path.join(web, page), 'utf8')
        .matchAll(/<script src="\/assets\/([^"]+)"(?: defer)?><\/script>/g),
    ].map(match => match[1]);
    if (page === 'index.html') {
      const context = createContext({});
      new Script(fs.readFileSync(path.join(web, 'routes.js'), 'utf8')).runInContext(context);
      new Script(
        fs.readFileSync(path.join(web, 'route-assets.js'), 'utf8') + '\n;globalThis.__order = [...pageAssetOrder];',
      ).runInContext(context);
      // A page's stylesheets (V2-WEB-02) share the loader's list but are not scripts.
      scripts.push(...context.__order.filter(file => file.endsWith('.js') && !scripts.includes(file)));
    }
    documents[page] = scripts.filter(file => !file.startsWith('vendor/'));
  }
  return documents;
}
export function checkExtensions(root = process.cwd()) {
  const problems = new Set();
  for (const scripts of Object.values(documentScripts(root))) {
    const sources = {};
    for (const file of scripts) sources['web/' + file] = fs.readFileSync(path.join(root, 'web', file), 'utf8');
    for (const problem of reassignmentProblems(sources)) problems.add(problem);
  }
  return [...problems];
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkExtensions();
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  } else
    console.log(
      'No shipped script reassigns or redeclares a shell function; extensions register with AMCP.routes and AMCP.hooks.',
    );
}
