// OWNER-REVIEWER-QA: what a reviewer's pages ask the server for, read from their sources without a browser. Meta's app
// reviewers sign in with an invited test account, and the test-account gate (server/website-gates.ts) admits only its
// allow-list of API routes and workspace tools. For every page the route registry (web/routes.js) marks testAccount,
// the scripts that page runs (the shell's scripts and the page's assets with their dependencies) may name only API
// paths and workspace tools the gate admits. The exceptions are listed below by the control that makes each call: the
// owner-administration and account-security calls the gate refuses on purpose, and the calls whose refusal is an open
// owner question. A concatenated path ('/api/connections/' + id) counts as the route it completes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parsers} from 'prettier/plugins/babel';
import {loadRouteRegistry, pageAssetPlan} from '../tools/check-routes.mjs';

const dynamic = '\u0000';
const skippedKeys = new Set([
  'loc',
  'start',
  'end',
  'range',
  'extra',
  'comments',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'tokens',
]);
const functionTypes = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
]);
const textOf = node => (node.type === 'TemplateElement' ? (node.value.cooked ?? node.value.raw) : node.value);

/** A parsed source: every node in document order, each node's parent and its line. */
function parse(file, source) {
  const ast = (file.endsWith('.ts') ? parsers['babel-ts'] : parsers.babel).parse(source, {filepath: file}),
    parents = new Map(),
    all = [];
  const visit = (node, parent) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent);
      return;
    }
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    parents.set(node, parent);
    all.push(node);
    for (const [key, value] of Object.entries(node)) if (!skippedKeys.has(key)) visit(value, node);
  };
  visit(ast.program ?? ast, null);
  return {
    all,
    parent: node => parents.get(node),
    line: node => source.slice(0, node.start).split('\n').length,
    within: (node, outer) => node.start >= outer.start && node.end <= outer.end,
  };
}

/** The test-account gate as server/website-gates.ts declares it: its routes, its workspace tools and its tool pattern. */
export function testAccountGate(source) {
  const gate = parse('server/website-gates.ts', source),
    scope = gate.all.find(node => node.type === 'FunctionDeclaration' && node.id?.name === 'testAccountScope');
  assert.ok(scope, 'server/website-gates.ts declares testAccountScope');
  const declared = name => {
    const node = gate.all.find(
      node => node.type === 'VariableDeclarator' && node.id?.name === name && gate.within(node, scope),
    );
    assert.ok(node, 'testAccountScope declares ' + name);
    return node;
  };
  const routes = declared('testAccountRoutes').init.elements.map(pair => {
    const [pattern, methods] = pair.elements;
    assert.equal(pattern.type, 'RegExpLiteral', 'each test-account route is a regular expression');
    return {pattern: new RegExp(pattern.pattern, pattern.flags), methods: methods.elements.map(method => method.value)};
  });
  const toolSet = declared('testAccountTools').init,
    toolDeclarator = declared('tool'),
    toolLiteral = gate.all.find(node => node.type === 'RegExpLiteral' && gate.within(node, toolDeclarator));
  assert.equal(toolSet.callee?.name, 'Set', 'the gate lists its workspace tools in a Set');
  const tools = new Set(toolSet.arguments[0].elements.map(tool => tool.value));
  assert.ok(routes.length && tools.size && toolLiteral, 'the gate lists routes and tools');
  const toolPattern = new RegExp(toolLiteral.pattern, toolLiteral.flags);
  return {
    routes,
    tools,
    /** Whether the gate lets a test account make this request: its own comparison of a lower-cased path. */
    admits(method, samplePath) {
      const p = samplePath.toLowerCase(),
        m = method.toUpperCase();
      if (!routes.some(route => route.pattern.test(p) && route.methods.includes(m))) return false;
      const tool = toolPattern.exec(p)?.[1];
      return !tool || tools.has(tool);
    },
  };
}

/** A request's address with each dynamic part as one path segment, without its query or fragment. */
export const samplePath = pattern => pattern.replaceAll(dynamic, 'x').split(/[?#]/)[0];
const product = (left, right) => {
  const out = [];
  for (const a of left) for (const b of right) out.push(a + b);
  return out.length > 64 ? [dynamic] : out;
};

/**
 * What one script asks the server for: each request (api() or fetch(), and each link to an API path in its markup)
 * with its method and address pattern, each workspace tool it calls, and anything the reading could not resolve.
 * `builders` are address builders the scripts define (scriptBuilders), by name.
 */
export function scriptCalls(file, source, builders = new Map()) {
  const {all, parent, line, within} = parse(file, source),
    requests = [],
    tools = [],
    unresolved = [],
    accounted = new Set();
  const enclosingFunctions = node => {
    const out = [];
    for (let at = parent(node); at; at = parent(at)) if (functionTypes.has(at.type)) out.push(at);
    return out;
  };
  const functionName = fn =>
    fn.type === 'FunctionDeclaration'
      ? fn.id?.name
      : parent(fn)?.type === 'VariableDeclarator'
        ? parent(fn).id?.name
        : undefined;
  // The transport itself: api() and workspaceCall() carry every page request; their own calls are not page requests.
  const transport = node => enclosingFunctions(node).some(fn => ['api', 'workspaceCall'].includes(functionName(fn)));
  /** The nearest earlier declaration of a name in the function (or script) that uses it. */
  const declaration = (name, node) => {
    const scope = enclosingFunctions(node)[0] ?? all[0];
    return all
      .filter(
        candidate =>
          candidate.type === 'VariableDeclarator' &&
          candidate.id?.name === name &&
          within(candidate, scope) &&
          candidate.start < node.start,
      )
      .at(-1);
  };
  const account = node => {
    if (node) for (const inner of all) if (within(inner, node)) accounted.add(inner);
  };
  const evaluate = (node, depth = 0) => {
    if (!node || depth > 12) return [dynamic];
    switch (node.type) {
      case 'StringLiteral':
        return [node.value];
      case 'TemplateLiteral': {
        let out = [''];
        node.quasis.forEach((quasi, i) => {
          out = out.map(text => text + textOf(quasi));
          if (i < node.expressions.length) out = product(out, evaluate(node.expressions[i], depth + 1));
        });
        return out;
      }
      case 'BinaryExpression':
        return node.operator === '+'
          ? product(evaluate(node.left, depth + 1), evaluate(node.right, depth + 1))
          : [dynamic];
      case 'ConditionalExpression':
        return [...evaluate(node.consequent, depth + 1), ...evaluate(node.alternate, depth + 1)];
      case 'LogicalExpression':
        return [...evaluate(node.left, depth + 1), ...evaluate(node.right, depth + 1)];
      case 'ParenthesizedExpression':
        return evaluate(node.expression, depth + 1);
      case 'CallExpression': {
        const builder = node.callee?.type === 'Identifier' ? builders.get(node.callee.name) : undefined;
        return builder ?? [dynamic];
      }
      case 'Identifier': {
        const declared = declaration(node.name, node);
        return declared?.init && parent(declared)?.kind === 'const' ? evaluate(declared.init, depth + 1) : [dynamic];
      }
      default:
        return [dynamic];
    }
  };
  /** The request methods options name: GET without them, null when the reading cannot tell. */
  const methods = (options, node) => {
    if (!options) return ['GET'];
    if (options.type === 'Identifier') {
      const declared = declaration(options.name, node);
      return declared?.init ? methods(declared.init, declared) : null;
    }
    if (options.type !== 'ObjectExpression') return null;
    const method = options.properties.find(
      property => property.type === 'ObjectProperty' && (property.key.name ?? property.key.value) === 'method',
    );
    if (!method) return options.properties.some(property => property.type === 'SpreadElement') ? null : ['GET'];
    const values = evaluate(method.value);
    return values.some(value => value.includes(dynamic)) ? null : values.map(value => value.toUpperCase());
  };
  for (const node of all) {
    if (node.type !== 'CallExpression' || node.callee?.type !== 'Identifier') continue;
    const callee = node.callee.name;
    if (callee === 'api' || callee === 'fetch') {
      const [address, options] = node.arguments;
      account(address);
      if (transport(node)) continue;
      const patterns = evaluate(address),
        verbs = methods(options, node);
      // A fetch in a script that names no API path at all reads an asset or a locale chunk.
      if (callee === 'fetch' && !source.includes('/api/')) continue;
      if (!patterns.every(pattern => pattern.startsWith('/api/')) || !verbs) {
        unresolved.push({file, line: line(node), reason: 'request address or method'});
        continue;
      }
      for (const pattern of patterns)
        for (const method of verbs)
          requests.push({file, line: line(node), method, pattern, kind: 'request', start: node.start});
    } else if (callee === 'workspaceCall' && !transport(node)) {
      const [name] = node.arguments;
      if (name?.type === 'StringLiteral') tools.push({file, line: line(node), tool: name.value});
      else if (name?.type === 'Identifier') {
        // A tool passed in: each call of the function that passes it names the tool, or leaves the default.
        const fn = enclosingFunctions(node).find(candidate =>
            candidate.params.some(param => (param.left ?? param).name === name.name),
          ),
          index = fn ? fn.params.findIndex(param => (param.left ?? param).name === name.name) : -1,
          fallback = fn?.params[index]?.right,
          caller = fn && functionName(fn),
          calls = caller
            ? all.filter(
                call =>
                  call.type === 'CallExpression' && call.callee?.type === 'Identifier' && call.callee.name === caller,
              )
            : [];
        if (!calls.length) unresolved.push({file, line: line(node), reason: 'workspace tool'});
        for (const call of calls) {
          const argument = call.arguments[index] ?? fallback;
          if (argument?.type === 'StringLiteral') tools.push({file, line: line(call), tool: argument.value});
          // The function passing its own tool on to itself names nothing new.
          else if (!(argument?.type === 'Identifier' && argument.name === name.name && within(call, fn)))
            unresolved.push({file, line: line(call), reason: 'workspace tool'});
        }
      } else unresolved.push({file, line: line(node), reason: 'workspace tool'});
    }
  }
  // An address builder's own text is read where a request uses it.
  for (const node of all)
    if (node.type === 'VariableDeclarator' && builders.has(node.id?.name) && node.init?.type === 'ArrowFunctionExpression')
      account(node.init.body);
  // Every other '/api/' literal is a link in the page's markup or a comparison of an address; anything else is unread.
  for (const node of all) {
    if (!['StringLiteral', 'TemplateElement'].includes(node.type) || !textOf(node).includes('/api/')) continue;
    if (accounted.has(node)) continue;
    const host = node.type === 'TemplateElement' ? parent(node) : node,
      around = parent(host);
    if (
      (around?.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(around.operator)) ||
      (around?.type === 'CallExpression' &&
        around.callee?.type === 'MemberExpression' &&
        ['startsWith', 'endsWith', 'includes'].includes(around.callee.property?.name) &&
        around.arguments[0] === host)
    )
      continue;
    // A link: the markup around the literal, read in order, up to the attribute's closing quote.
    let chain = host;
    while (parent(chain)?.type === 'BinaryExpression' && parent(chain).operator === '+') chain = parent(chain);
    const pieces = [];
    const flatten = part => {
      if (part.type === 'BinaryExpression' && part.operator === '+') {
        flatten(part.left);
        flatten(part.right);
      } else if (part.type === 'StringLiteral') pieces.push({text: part.value, node: part});
      else if (part.type === 'TemplateLiteral')
        part.quasis.forEach((quasi, i) => {
          pieces.push({text: textOf(quasi), node: quasi});
          if (i < part.expressions.length) pieces.push({text: dynamic});
        });
      else pieces.push({text: dynamic});
    };
    flatten(chain);
    const at = pieces.findIndex(piece => piece.node === node),
      start = pieces.slice(0, at).reduce((sum, piece) => sum + piece.text.length, 0),
      end = start + textOf(node).length,
      links = [...pieces.map(piece => piece.text).join('').matchAll(/href="(\/api\/[^"]*)"/g)].filter(
        match => match.index + 6 >= start && match.index + 6 < end,
      );
    if (!links.length) {
      unresolved.push({file, line: line(node), reason: 'an /api/ path the reading cannot classify'});
      continue;
    }
    for (const link of links) requests.push({file, line: line(node), method: 'GET', pattern: link[1], kind: 'link'});
  }
  return {requests, tools, unresolved};
}

/** The address builders a script defines (const name = id => '/api/...' + id), with their parameters dynamic. */
export function scriptBuilders(file, source) {
  const builders = new Map();
  for (const node of parse(file, source).all)
    if (
      node.type === 'VariableDeclarator' &&
      node.init?.type === 'ArrowFunctionExpression' &&
      node.init.body.type !== 'BlockStatement'
    ) {
      // Read as the address of a request: its parameters are declared nowhere, so each is a dynamic part.
      const body = source.slice(node.init.body.start, node.init.body.end),
        patterns = scriptCalls(file, 'api(' + body + ');')
          .requests.filter(request => request.start === 0)
          .map(request => request.pattern);
      if (patterns.length) builders.set(node.id.name, [...new Set(patterns)]);
    }
  return builders;
}

const gate = testAccountGate(fs.readFileSync('server/website-gates.ts', 'utf8')),
  registry = [...loadRouteRegistry()],
  plan = pageAssetPlan(),
  shellScripts = [...fs.readFileSync('web/index.html', 'utf8').matchAll(/<script src="\/assets\/([^"]+)"/g)].map(
    match => match[1],
  );
/** A page's feature scripts and everything they load first (web/route-assets.js); vendor files name no API. */
const pageScripts = files => {
  const out = new Set();
  const add = file => {
    if (out.has(file) || file.startsWith('vendor/')) return;
    out.add(file);
    for (const dependency of plan.dependencies[file] ?? []) add(dependency);
  };
  for (const file of files) add(file);
  return [...out];
};
const reviewerPages = registry
    .filter(entry => entry.testAccount === true)
    .map(entry => ({path: entry.path, scripts: [...new Set([...shellScripts, ...pageScripts([...(entry.assets ?? [])])])]})),
  sources = new Map(
    [...new Set(reviewerPages.flatMap(page => page.scripts))]
      .sort()
      .map(file => [file, fs.readFileSync('web/' + file, 'utf8')]),
  ),
  builders = new Map([...sources].flatMap(([file, source]) => [...scriptBuilders(file, source)])),
  readings = new Map([...sources].map(([file, source]) => [file, scriptCalls(file, source, builders)]));

/** Every call a reviewer page names that the gate refuses, keyed 'METHOD /sample/path' or 'tool <name>'. */
function refusedCalls() {
  const refused = new Map();
  const note = (key, page, at) => {
    const entry = refused.get(key) ?? {pages: new Set(), at: new Set()};
    entry.pages.add(page.path);
    entry.at.add(at.file + ':' + at.line);
    refused.set(key, entry);
  };
  for (const page of reviewerPages)
    for (const file of page.scripts) {
      const {requests, tools} = readings.get(file);
      for (const request of requests) {
        const sample = samplePath(request.pattern);
        if (!gate.admits(request.method, sample)) note(request.method + ' ' + sample, page, request);
      }
      for (const call of tools) if (!gate.tools.has(call.tool)) note('tool ' + call.tool, page, call);
    }
  return refused;
}

test('DEBUG reviewer refused calls', () => {
  const refused = refusedCalls();
  console.log(JSON.stringify([...refused].map(([key, value]) => [key, [...value.at], [...value.pages].length]), null, 1));
  console.log(JSON.stringify([...readings].flatMap(([, reading]) => reading.unresolved), null, 1));
  console.log(reviewerPages.length, sources.size, builders);
});
