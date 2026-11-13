// OWNER-REVIEWER-QA: what a reviewer's pages ask the server for, read from their sources without a browser. Meta's app
// reviewers sign in with an invited test account, and the test-account gate (server/website-gates.ts) admits only its
// allow-list of API routes and workspace tools. For every page the route registry (web/routes.js) marks testAccount,
// the scripts that page runs (the shell's scripts and the page's assets with their dependencies) may name only API
// paths and workspace tools the gate admits. The exceptions are listed below by the control that makes each call: the
// sign-in, account-security and owner-administration calls the gate refuses on purpose, and the calls whose refusal is
// an open owner question. A concatenated path ('/api/connections/' + id) counts as the route it completes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {parsers} from 'prettier/plugins/babel';
import {testAccountScope} from '../dist/server/website-gates.js';
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

/** A parsed script: every node in document order, each node's parent, its line and the nodes inside it. */
function parse(file, source) {
  const ast = parsers.babel.parse(source, {filepath: file}),
    parents = new Map(),
    order = new Map(),
    all = [],
    lineStarts = [0];
  const visit = (node, parent) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent);
      return;
    }
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    parents.set(node, parent);
    order.set(node, all.length);
    all.push(node);
    for (const [key, value] of Object.entries(node)) if (!skippedKeys.has(key)) visit(value, node);
  };
  visit(ast.program ?? ast, null);
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  const within = (node, outer) => node.start >= outer.start && node.end <= outer.end;
  return {
    all,
    within,
    parent: node => parents.get(node),
    line: node => {
      let low = 0,
        high = lineStarts.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (lineStarts[middle] <= node.start) low = middle;
        else high = middle - 1;
      }
      return low + 1;
    },
    /** A node and everything inside it: they follow it in document order. */
    inside: node => {
      const out = [];
      for (let i = order.get(node); i < all.length && within(all[i], node); i++) out.push(all[i]);
      return out;
    },
  };
}

/**
 * The test-account gate itself (server/website-gates.ts, as built): whether it lets a signed-in test account make a
 * request. Asking the gate, not a copy of its list, keeps this test true to every condition the gate applies.
 */
export function testAccountGate(install = testAccountScope) {
  let gate;
  install({router: {use: handler => (gate = handler)}, web: {session: () => ({actor: {testAccount: true}})}});
  assert.equal(typeof gate, 'function', 'the test-account scope installs its gate');
  return (method, path) => {
    let answered = false,
      refusal;
    gate({method, path}, {}, error => {
      answered = true;
      refusal = error;
    });
    assert.ok(answered, 'the gate answers ' + method + ' ' + path);
    if (refusal && refusal.code !== 'TEST_ACCOUNT_SCOPE') throw refusal;
    return !refusal;
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
  const {all, parent, line, within, inside} = parse(file, source),
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
    if (node) for (const inner of inside(node)) accounted.add(inner);
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
        // A constant's text is read where the request uses it.
        const declared = declaration(node.name, node);
        if (!declared?.init || parent(declared)?.kind !== 'const') return [dynamic];
        account(declared.init);
        return evaluate(declared.init, depth + 1);
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
      // A fetch in a script that names no API path at all reads an asset or a locale chunk.
      if (callee === 'fetch' && !source.includes('/api/')) continue;
      const patterns = evaluate(address),
        verbs = methods(options, node);
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
    if (
      node.type === 'VariableDeclarator' &&
      builders.has(node.id?.name) &&
      node.init?.type === 'ArrowFunctionExpression'
    )
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
      links = [
        ...pieces
          .map(piece => piece.text)
          .join('')
          .matchAll(/href="(\/api\/[^"]*)"/g),
      ].filter(match => match.index + 6 >= start && match.index + 6 < end);
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
      // Read as the address of a request: its parameters are declared nowhere, so each is a dynamic part. Only the
      // body itself counts, not a request made inside it.
      const body = source.slice(node.init.body.start, node.init.body.end),
        patterns = scriptCalls(file, 'api(' + body + ');')
          .requests.filter(request => request.start === 0)
          .map(request => request.pattern);
      if (patterns.length) builders.set(node.id.name, [...new Set(patterns)]);
    }
  return builders;
}

/**
 * The calls the gate refuses on purpose, each by the control that makes it and why. The gate keeps a test account's
 * sign-in as the owner set it up (its password, email, two-step verification and linked identities, so that one
 * evaluator cannot lock another out) and leaves owner administration out of an evaluation (server/website-gates.ts).
 * Keyed as refusedCalls() keys them: the method and the path, each dynamic part as x.
 */
export const refusedOnPurpose = {
  // Signing in: the sign-in pages and the owner door, used before a session exists, where the gate does not apply.
  'POST /api/session': {
    control: 'Open workspace, in the Administrator access dialog (app.js #login-form)',
    why: 'the deployment administrator signs in with the server password',
  },
  'POST /api/signin/x/start': {
    control:
      'Continue with a provider on /login and /signup (account-security.js); Connect, under Your sign-in methods on /account (identity.js), which a test account is not shown; Confirm with a provider, in Confirm it’s you (app.js)',
    why: 'social sign-in and linking an identity; Confirm it’s you offers a test account no provider',
  },
  'POST /api/account/register': {control: 'Send verification email, on /signup', why: 'signing up'},
  'POST /api/account/login': {control: 'Sign in to your workspace, on /login', why: 'signing in'},
  'POST /api/account/resend-verification': {control: 'Resend verification email, after signing up', why: 'signing up'},
  'POST /api/account/forgot-password': {control: 'Send reset link, on /forgot-password', why: 'password recovery'},
  'POST /api/account/verify-email': {
    control: 'Complete verification, on /verify-email and /reset-password',
    why: 'finishing a signup, a password reset, an email change or an invitation',
  },
  'POST /api/account/mfa/login': {control: 'the two-step code form at sign-in', why: 'signing in'},
  // The account's own security, on /account (identity.js and account-security.js). A test account is shown none of
  // these controls, only a note that the owner manages its sign-in.
  'POST /api/account/profile': {control: 'Save changes, under The essentials', why: 'the account profile'},
  'DELETE /api/account/identities/x': {control: 'Remove, under Your sign-in methods', why: 'a linked identity'},
  'POST /api/account/email': {control: 'Send verification link, under Recovery email', why: 'the account email'},
  'POST /api/account/password': {control: 'Update password or Set password', why: 'the account password'},
  'POST /api/account/mfa/start': {
    control: 'Set up authenticator, under Two-step authentication',
    why: 'two-step verification',
  },
  'POST /api/account/mfa/enable': {
    control: 'Verify and enable, after Set up authenticator',
    why: 'two-step verification',
  },
  'POST /api/account/mfa/disable': {control: 'Disable two-step authentication', why: 'two-step verification'},
  'POST /api/account/mfa/recovery-codes': {control: 'Create new recovery codes', why: 'two-step verification'},
  'GET /api/account/deletion': {
    control: 'Review what is deleted, in the account deletion panel, which a test account is not shown',
    why: 'deleting the account',
  },
  'POST /api/account/delete': {control: 'Delete permanently, in the same panel', why: 'deleting the account'},
  'POST /api/account/owner-setup': {
    control: 'Send owner verification email, shown only to the deployment administrator',
    why: 'moving the administrator workspace to an owner account',
  },
  'POST /api/workspaces/switch': {
    control:
      'Switch workspace, under Your workspaces on /account, and the shell’s workspace menu (app.js), neither shown to a test account',
    why: 'switching workspaces; outside its own test workspace a test account is a viewer',
  },
  // Owner administration. Workspace members and client access sets are shown to owners and administrators, and a test
  // account's role reads as operator (server/user-accounts.ts).
  'POST /api/workspaces/invite': {control: 'Send invitation, under Workspace members', why: 'inviting members'},
  'POST /api/workspaces/invitations/x/revoke': {control: 'Withdraw, beside an invitation', why: 'inviting members'},
  'POST /api/workspaces/security-policy': {
    control: 'Save security settings, in Workspace security',
    why: 'the workspace’s two-step and invitation policy',
  },
  'POST /api/workspaces/member': {control: 'Save role and Remove, beside a member', why: 'members’ roles'},
  'POST /api/owner/accounts/mfa-reset': {
    control: 'Reset two-step, beside a member, for the AMCP owner',
    why: 'another account’s security',
  },
  'POST /api/access-sets': {
    control: 'Create client access set and Save client access set',
    why: 'client access sets',
  },
  'DELETE /api/access-sets/x': {control: 'Remove, beside a client access set', why: 'client access sets'},
  'GET /api/owner/accounts': {
    control: 'the Account access section of /settings, which a test account does not ask for (account-approvals.js)',
    why: 'the instance’s accounts',
  },
  'POST /api/owner/accounts/access': {
    control:
      'Grant access, Grant test access, Limit to test access, Give full access and Remove access, in Account access',
    why: 'the instance’s accounts',
  },
  'POST /api/owner/accounts/test-invite': {
    control: 'Send setup link, in Account access',
    why: 'inviting test accounts',
  },
  'POST /api/export-policy': {
    control: 'Save download policy, on /settings for workspace owners (owner-operations.js)',
    why: 'the workspace’s export policy',
  },
  'POST /api/commerce/stores': {
    control:
      'Verify reads and connect, on /commerce for administrators that are not test accounts (commerce-woocommerce.js)',
    why: 'connecting a store; tests/woocommerce-connection-http.test.mjs asserts the refusal',
  },
  'DELETE /api/commerce/stores/x': {
    control: 'Remove local connection, in the same panel',
    why: 'removing a store connection',
  },
  'PATCH /api/connections/x/report-job-access': {
    control:
      'Save report jobs and Revoke report jobs, in the Report jobs panel of a connection on /connections: a test account’s session reports providerJobs false (server/session-routes.ts), so reportJobPanel (app.js) shows it neither while its workspace holds no report-job grant, which only an administrator makes',
    why: 'provider jobs, which stay outside a test account’s scope',
  },
};

/** Calls a reviewer page names whose refusal is an open owner question, kept here until the owner decides. */
export const openOwnerQuestions = {};

const admits = testAccountGate(),
  registry = [...loadRouteRegistry()],
  plan = pageAssetPlan(),
  shellScripts = [...fs.readFileSync('web/index.html', 'utf8').matchAll(/<script src="\/assets\/([^"]+)"/g)].map(
    match => match[1],
  );
/**
 * A page's feature scripts and everything they load first (web/route-assets.js); vendor files name no API, and neither does a
 * stylesheet (the report builder loads the charts' sheet and the V2 layer's, V2-EXP-01).
 */
const pageScripts = files => {
  const out = new Set();
  const add = file => {
    if (out.has(file) || file.startsWith('vendor/') || !file.endsWith('.js')) return;
    out.add(file);
    for (const dependency of plan.dependencies[file] ?? []) add(dependency);
  };
  for (const file of files) add(file);
  return [...out];
};
const reviewerPages = registry
    .filter(entry => entry.testAccount === true)
    .map(entry => ({
      path: entry.path,
      scripts: [...new Set([...shellScripts, ...pageScripts([...(entry.assets ?? [])])])],
    })),
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
        if (!admits(request.method, sample)) note(request.method + ' ' + sample, page, request);
      }
      for (const call of tools)
        if (!admits('POST', '/api/workspace/' + call.tool)) note('tool ' + call.tool, page, call);
    }
  return refused;
}

test('the gate answers for a signed-in test account as server/website-gates.ts decides', () => {
  assert.equal(admits('GET', '/api/session'), true);
  assert.equal(admits('GET', '/API/Session'), true, 'the gate compares a lower-cased path');
  assert.equal(admits('POST', '/api/session'), false);
  assert.equal(admits('PATCH', '/api/connections/x/assets'), true);
  assert.equal(admits('PATCH', '/api/connections/x/report-job-access'), false);
  assert.equal(admits('POST', '/api/workspace/overview'), true);
  assert.equal(admits('POST', '/api/workspace/native'), false, 'a workspace tool outside its list');
  assert.equal(admits('GET', '/api/owner/accounts'), false);
});

test('the reading resolves concatenated, conditional, template and constant addresses with their methods', () => {
  const {requests, unresolved} = scriptCalls(
    'synthetic.js',
    `async function load(id, signup) {
      await api('/api/connections/' + encodeURIComponent(id) + '/sync', {method: 'POST', body: '{}'});
      await api('/api/account/' + (signup ? 'register' : 'login'), {method: 'POST'});
      await api(\`/api/media/sources/\${id}?full=1\`, {method: 'DELETE'});
      const options = {method: 'PATCH', body: '{}'};
      await api('/api/connections/' + id + '/label', options);
      const address = '/api/activity';
      return api(address);
    }`,
  );
  assert.deepEqual(unresolved, []);
  assert.deepEqual(
    requests.map(request => [request.method, samplePath(request.pattern)]),
    [
      ['POST', '/api/connections/x/sync'],
      ['POST', '/api/account/register'],
      ['POST', '/api/account/login'],
      ['DELETE', '/api/media/sources/x'],
      ['PATCH', '/api/connections/x/label'],
      ['GET', '/api/activity'],
    ],
  );
});

test('the reading follows an address builder into the requests that use it', () => {
  const source = `const sourceUrl = id => '/api/media/sources/' + encodeURIComponent(id);
    function remove(id) { return fetch(sourceUrl(id), {method: 'DELETE'}); }`;
  const found = scriptBuilders('synthetic.js', source);
  assert.deepEqual([...found], [['sourceUrl', ['/api/media/sources/\u0000']]]);
  const {requests, unresolved} = scriptCalls('synthetic.js', source, found);
  assert.deepEqual(unresolved, []);
  assert.deepEqual(
    requests.map(request => [request.method, samplePath(request.pattern)]),
    [['DELETE', '/api/media/sources/x']],
  );
  // Without the builder, neither the request nor the builder's own text is read.
  assert.deepEqual(
    scriptCalls('synthetic.js', source).unresolved.map(item => item.reason),
    ['request address or method', 'an /api/ path the reading cannot classify'],
  );
  // A function that makes a request, or builds anything but an API path, is no address builder.
  assert.deepEqual(
    [
      ...scriptBuilders(
        'synthetic.js',
        `const refresh = () => api('/api/platforms'); const label = c => c.name + ' · ' + c.id;`,
      ),
    ],
    [],
  );
});

test('the reading names each workspace tool, also one passed in by the callers of a function', () => {
  const {tools, unresolved} = scriptCalls(
    'synthetic.js',
    `async function workspaceCall(tool, args) {
      return api('/api/workspace/' + tool, {method: 'POST', body: JSON.stringify(args)});
    }
    workspaceCall('reporting', {action: 'list'});
    function showReview(review, tool = 'campaign') {
      const again = next => showReview(next, tool);
      return workspaceCall(tool, {review_id: review.id});
    }
    showReview(a, 'media');
    showReview(b);`,
  );
  assert.deepEqual(unresolved, []);
  assert.deepEqual(
    tools.map(call => call.tool),
    ['reporting', 'media', 'campaign'],
  );
  const unknown = scriptCalls(
    'synthetic.js',
    `function run(name) { return workspaceCall(name, {}); }
    function relay(name) { return run(name); }
    workspaceCall(pick(), {});`,
  );
  assert.deepEqual(unknown.tools, []);
  assert.deepEqual(
    unknown.unresolved.map(item => item.reason),
    ['workspace tool', 'workspace tool'],
  );
});

test('an /api/ path in markup is a link, one in a comparison names nothing, and any other is unread', () => {
  const {requests, unresolved} = scriptCalls(
    'synthetic.js',
    `const row = file => '<a class="button" href="/api/reporting-files/' + encodeURIComponent(file.id) + '" download>Download</a>';
    const card = id => \`<a href="/api/reporting-evidence/\${id}">Evidence</a>\`;
    if (location.pathname === '/api/session' || url.startsWith('/api/')) stop();`,
  );
  assert.deepEqual(unresolved, []);
  assert.deepEqual(
    requests.map(request => [request.kind, request.method, samplePath(request.pattern)]),
    [
      ['link', 'GET', '/api/reporting-files/x'],
      ['link', 'GET', '/api/reporting-evidence/x'],
    ],
  );
  assert.deepEqual(
    scriptCalls('synthetic.js', `navigator.sendBeacon('/api/activity', data);`).unresolved.map(item => item.reason),
    ['an /api/ path the reading cannot classify'],
  );
  assert.deepEqual(
    scriptCalls(
      'synthetic.js',
      `api('/api/activity', {...options}); api('/api/activity', {method: verb}); api(address);`,
    ).unresolved.map(item => item.reason),
    ['request address or method', 'request address or method', 'request address or method'],
  );
});

test('the transport and the reads of assets are not page requests', () => {
  const {requests, unresolved} = scriptCalls(
    'synthetic.js',
    `async function api(path, options = {}) {
      const response = await fetch(path, {...options, credentials: 'same-origin'});
      return response.json();
    }
    api('/api/platforms');`,
  );
  assert.deepEqual(unresolved, []);
  assert.deepEqual(
    requests.map(request => [request.method, request.pattern]),
    [['GET', '/api/platforms']],
  );
  assert.deepEqual(scriptCalls('synthetic.js', `fetch('/assets/locales/ar/shell.json'); fetch(address);`), {
    requests: [],
    tools: [],
    unresolved: [],
  });
});

test('every testAccount page is read with the shell scripts and its own', () => {
  const expected = registry.filter(entry => entry.testAccount === true).map(entry => entry.path);
  assert.ok(expected.length > 0, 'the registry opens pages to test accounts');
  assert.deepEqual(
    reviewerPages.map(page => page.path),
    expected,
  );
  for (const file of ['app.js', 'workspace.js', 'identity.js', 'account-security.js'])
    assert.ok(shellScripts.includes(file), 'every page runs ' + file);
  for (const page of reviewerPages)
    for (const file of page.scripts) assert.ok(readings.has(file), page.path + ' runs ' + file + ', which is read');
  const all = [...readings.values()];
  assert.ok(
    all.some(reading =>
      reading.requests.some(request => request.method === 'GET' && request.pattern === '/api/session'),
    ),
    'the reading finds the session read',
  );
  assert.ok(
    all.some(reading => reading.tools.length > 0),
    'the reading finds workspace tools',
  );
});

test('the reading classifies every request, workspace tool and /api/ path of a reviewer page', () => {
  assert.deepEqual(
    [...readings.values()].flatMap(reading => reading.unresolved),
    [],
  );
});

test('every workspace tool a reviewer page calls is one the gate admits', () => {
  const tools = [...new Set([...readings.values()].flatMap(reading => reading.tools.map(call => call.tool)))].sort();
  assert.ok(tools.length > 0);
  assert.deepEqual(
    tools.filter(tool => !admits('POST', '/api/workspace/' + tool)),
    [],
  );
});

test('a reviewer page names only calls the gate admits, apart from the listed refusals', () => {
  const refused = refusedCalls(),
    listed = new Set([...Object.keys(refusedOnPurpose), ...Object.keys(openOwnerQuestions)]);
  assert.deepEqual(
    [...refused]
      .filter(([key]) => !listed.has(key))
      .map(([key, where]) => key + ' at ' + [...where.at].join(', ') + ' on ' + [...where.pages].join(', ')),
    [],
    'a reviewer page names a call the test-account gate refuses: stop the page making it for a test account, ask the owner to admit it, or list it here with its control and reason',
  );
  assert.deepEqual(
    [...listed].filter(key => !refused.has(key)),
    [],
    'a listed refusal that no reviewer page names any more, or that the gate now admits: remove it',
  );
});

test('every listed refusal names its control and its reason', () => {
  for (const [key, entry] of Object.entries({...refusedOnPurpose, ...openOwnerQuestions})) {
    assert.match(key, /^(GET|POST|PUT|PATCH|DELETE) \/api\//, key);
    assert.ok(entry.control?.trim() && entry.why?.trim(), key + ' names its control and why');
  }
  assert.deepEqual(
    Object.keys(refusedOnPurpose).filter(key => key in openOwnerQuestions),
    [],
  );
});

test('a test account sees no account-page control the gate refuses, only that the owner manages its sign-in', async () => {
  const nodes = new Map(),
    node = selector => {
      if (!nodes.has(selector))
        nodes.set(selector, {
          innerHTML: '',
          textContent: '',
          insertAdjacentHTML(_where, markup) {
            this.innerHTML += markup;
          },
          classList: {add() {}, remove() {}, toggle() {}, contains: () => false},
          style: {},
          dataset: {},
          setAttribute() {},
          removeAttribute() {},
          getAttribute: () => null,
          append() {},
          appendChild() {},
          querySelector: () => null,
          querySelectorAll: () => [],
          closest: () => null,
          addEventListener() {},
          focus() {},
        });
      return nodes.get(selector);
    },
    answers = {
      '/api/account': {
        name: 'Reviewer',
        email: 'reviewer@example.test',
        identities: [],
        hasPassword: true,
        administrator: false,
        testAccount: true,
        workspaceId: 'own',
        mfaEnabled: false,
      },
      '/api/account/options': {providers: [{id: 'google', name: 'Google', configured: true}], emailEnabled: true},
      '/api/account/sessions': {sessions: []},
      '/api/workspaces': {
        workspaces: [
          {id: 'own', name: 'Test', role: 'owner'},
          {id: 'other', name: 'Other', role: 'viewer'},
        ],
      },
    };
  const context = createContext({
    document: {
      documentElement: {lang: 'en', dir: 'ltr'},
      querySelectorAll: () => [],
      querySelector: node,
      getElementById: id => node('#' + id),
      body: node('body'),
      createElement: tag => node('new ' + tag + ' ' + nodes.size),
      addEventListener() {},
    },
    localStorage: {getItem: () => null, setItem() {}},
    matchMedia: () => ({matches: false, addEventListener() {}}),
    navigationGeneration: 1,
    identityGeneration: 1,
    Intl,
    Date,
    URLSearchParams,
    location: {pathname: '/account', search: '', hash: ''},
    history: {replaceState() {}},
    session: {authenticated: true, testAccount: true, workspaceId: 'own'},
    content: node('#content'),
    $: node,
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    header: (title, lead) => `<h1>${title}</h1><p>${lead}</p>`,
    glyph: () => '',
    formField: () => '<input>',
    date: () => '',
    uiRole: role => role,
    showLogin() {},
    authBind() {},
    toast() {},
    render: async () => {},
    api: async url => answers[url] ?? {},
  });
  const run = code => new Script(code).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  await run('initializeUILocale()');
  run(fs.readFileSync('web/routes.js', 'utf8'));
  run(fs.readFileSync('web/identity.js', 'utf8'));
  run(fs.readFileSync('web/account-security.js', 'utf8'));
  await run('renderAccountPage()');
  await run('renderAccountSecurity()');
  const page = node('#content').innerHTML;
  assert.match(page, /The AMCP owner manages this test account’s sign-in/);
  for (const control of [
    'profile-form',
    'data-link-social',
    'Send verification link',
    'Update password',
    'mfa-start',
    'data-switch-workspace',
  ])
    assert.equal(page.includes(control), false, control);
});
