import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parsers} from 'prettier/plugins/babel';

// WEB-07: the website's classic scripts share one global scope, and features used to extend each other by reassigning
// a shell function at load time (render in account-scope.js, renderAccountPage in account-security.js, renderSettings
// twice in owner-operations.js and account-approvals.js). The composition then depended on load order, and a wrapper
// dropped in a refactor changed a page without an error. Scripts now register with the shell's extension points
// (AMCP.routes and AMCP.hooks in web/routes.js). This check refuses a top-level assignment to any function a shipped
// script declares, so the pattern cannot return.

/** The functions each script declares at its top level, and its top-level assignments to plain names. */
export function scriptBindings(source, file) {
  const program = parsers.babel.parse(source, {filepath: file}).program,
    functions = [],
    assignments = [];
  const assigned = node => {
    if (node?.type === 'AssignmentExpression' && node.left?.type === 'Identifier')
      assignments.push({name: node.left.name, line: node.loc?.start?.line ?? 0});
    if (node?.type === 'SequenceExpression') node.expressions.forEach(assigned);
  };
  for (const statement of program.body) {
    if (statement.type === 'FunctionDeclaration' && statement.id) functions.push(statement.id.name);
    if (statement.type === 'ExpressionStatement') assigned(statement.expression);
  }
  return {functions, assignments};
}
/** Every top-level reassignment of a declared function, as "web/file:line: ..." problems. */
export function reassignmentProblems(sources) {
  const declared = new Map(),
    bindings = new Map();
  for (const [file, source] of Object.entries(sources)) {
    const result = scriptBindings(source, file);
    bindings.set(file, result);
    for (const name of result.functions) if (!declared.has(name)) declared.set(name, file);
  }
  const problems = [];
  for (const [file, {assignments}] of bindings)
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
  return problems;
}
export function checkExtensions(root = process.cwd()) {
  const sources = {};
  for (const file of fs
    .readdirSync(path.join(root, 'web'), {recursive: true})
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => file.endsWith('.js') && !file.startsWith('vendor/'))
    .sort())
    sources['web/' + file] = fs.readFileSync(path.join(root, 'web', file), 'utf8');
  return reassignmentProblems(sources);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkExtensions();
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  } else console.log('No shipped script reassigns a shell function; extensions register with AMCP.routes and AMCP.hooks.');
}
