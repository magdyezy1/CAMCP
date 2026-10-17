// WEB-07: explicit extension points. The shipped scripts used to extend the shell by reassigning its functions while
// they loaded (render in account-scope.js, renderAccountPage in account-security.js, renderSettings in
// owner-operations.js and again in account-approvals.js; identity.js's sign-in builders were replaced the same way), so
// the pages depended on the order the files loaded in and a wrapper dropped in a refactor changed a page silently.
// These tests guard the replacement: AMCP.routes and AMCP.hooks (web/routes.js) and tools/check-extensions.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createContext, Script} from 'node:vm';
import {checkExtensions, documentScripts, reassignmentProblems} from '../tools/check-extensions.mjs';

function registry(extra = {}) {
  const context = createContext({...extra});
  const run = source => new Script(source).runInContext(context);
  run(fs.readFileSync('web/routes.js', 'utf8'));
  return {context, run};
}

test('no shipped script reassigns or redeclares a shell function (regression: seven load-time wrappers)', () => {
  assert.deepEqual(checkExtensions(), []);
  // The shapes the website used before, each refused with the file and line that introduced it.
  const problems = reassignmentProblems({
    'web/app.js': 'async function render() {}\nfunction renderSettings() {}',
    'web/identity.js': 'function renderAccountPage() {}\nfunction formField() {}',
    'web/account-scope.js':
      'const baseScopedRender = render;\nrender = async function () { await baseScopedRender(); };',
    'web/owner-operations.js': 'const base = renderSettings;\nrenderSettings = async function () { base(); };',
    'web/account-security.js': 'formField = function () {};\nwindow.renderAccountPage = async () => {};',
    'web/account-approvals.js': 'function renderSettings() {}',
  });
  assert.deepEqual(
    problems.map(problem => problem.replace(/ \(declared in .*$| \(first declared in .*$/, '')),
    [
      'web/account-scope.js:2: reassigns render',
      'web/owner-operations.js:2: reassigns renderSettings',
      'web/account-security.js:1: reassigns formField',
      'web/account-security.js:2: reassigns renderAccountPage',
      'web/account-approvals.js:1: declares renderSettings again',
    ],
  );
  // Different documents may use the same names: About's own render() never shares a page with app.js.
  assert.deepEqual(reassignmentProblems({'web/about.js': 'function render() {}'}), []);
  const documents = documentScripts();
  assert.ok(documents['about.html'].includes('about.js') && !documents['about.html'].includes('app.js'));
  // The workspace document covers every lazily loaded page module too.
  for (const file of ['account-scope.js', 'owner-operations.js', 'account-approvals.js', 'mfa-qr.js'])
    assert.ok(documents['index.html'].includes(file), file);
  assert.match(fs.readFileSync('tools/check-web.mjs', 'utf8'), /checkExtensions\(\)/);
});

test('a page body is registered once for a known page; unknown pages and non-functions are refused', () => {
  const {run} = registry();
  run("AMCP.routes.register('/portfolio', {render: () => 'portfolio body'})");
  assert.equal(run("AMCP.routes.renderer('/portfolio')()"), 'portfolio body');
  assert.equal(run("AMCP.routes.renderer('/campaigns')"), undefined, 'An unregistered page keeps the shell renderer');
  assert.throws(() => run("AMCP.routes.register('/portfolio', {render: () => 'second'})"), /ALREADY_REGISTERED/);
  assert.equal(run("AMCP.routes.renderer('/portfolio')()"), 'portfolio body', 'A second registration never overrides');
  assert.throws(() => run("AMCP.routes.register('/not-a-page', {render() {}})"), /AMCP_ROUTE_UNKNOWN/);
  assert.throws(() => run("AMCP.routes.extend('/not-a-page', () => {})"), /AMCP_ROUTE_UNKNOWN/);
  assert.throws(() => run("AMCP.routes.register('/media', {render: 'renderMedia'})"), /NOT_A_FUNCTION/);
  assert.throws(() => run("AMCP.hooks.beforeRender('hook')"), /NOT_A_FUNCTION/);
  assert.throws(() => run("AMCP.routes.extend('/settings', () => {}, {order: NaN})"), /ORDER_INVALID/);
  // The registry is frozen: a script cannot swap an extension point out either.
  assert.equal(run('Object.isFrozen(AMCP) && Object.isFrozen(AMCP.routes) && Object.isFrozen(AMCP.hooks)'), true);
});

test('page parts render in their declared order whatever order their scripts loaded in, one after another', async () => {
  const {context, run} = registry();
  const events = [];
  context.events = events;
  context.settle = () => new Promise(resolve => setImmediate(resolve));
  // Registered out of order: the access list's script first, as a parallel download may finish first.
  run(`AMCP.routes.extend('/settings', async () => { events.push('access start'); await settle(); events.push('access end'); }, {order: 20});
    AMCP.routes.extend('/settings', async () => { events.push('owner start'); await settle(); events.push('owner end'); }, {order: 10});
    AMCP.routes.extend('/settings', () => events.push('later default'), {order: 20});`);
  await run("AMCP.routes.renderParts('/settings')");
  assert.deepEqual(events, ['owner start', 'owner end', 'access start', 'access end', 'later default']);
  // A part that fails stops the page's remaining parts, as an unfinished page would.
  events.length = 0;
  run(
    "AMCP.routes.extend('/account', () => { throw Error('part failed'); }); AMCP.routes.extend('/account', () => events.push('after'))",
  );
  await assert.rejects(run("AMCP.routes.renderParts('/account')"), /part failed/);
  assert.deepEqual(events, []);
  assert.equal(await run("AMCP.routes.renderParts('/dashboard')"), undefined, 'A page without parts renders none');
});

test('the shipped Settings scripts declare their order, so access follows the owner part in either load order', () => {
  for (const order of [
    ['owner-operations.js', 'account-approvals.js'],
    ['account-approvals.js', 'owner-operations.js'],
  ]) {
    const {run} = registry({document: {addEventListener() {}}});
    run(fs.readFileSync('web/localization.js', 'utf8'));
    for (const file of order) run(fs.readFileSync('web/' + file, 'utf8'));
    assert.deepEqual(
      Array.from(run("AMCP.routes.parts('/settings').map(part => part.name)")),
      ['renderOwnerSettings', 'renderAccountApprovals'],
      order.join(' then '),
    );
  }
  const {run} = registry({document: {addEventListener() {}}, $: () => null});
  run(fs.readFileSync('web/localization.js', 'utf8'));
  run(fs.readFileSync('web/account-security.js', 'utf8'));
  assert.deepEqual(Array.from(run("AMCP.routes.parts('/account').map(part => part.name)")), ['renderAccountSecurity']);
});

test('render() runs the before hooks, then the page, then the after hooks; the shell pages end with their parts', async () => {
  const {context, run} = registry();
  const app = fs.readFileSync('web/app.js', 'utf8'),
    events = [];
  context.events = events;
  run(app.slice(app.indexOf('async function render() {'), app.indexOf('async function renderCurrentPage()')));
  run(`var renderCurrentPage = async () => { events.push('page'); return 'rendered'; };
    AMCP.hooks.beforeRender(() => events.push('before'));
    AMCP.hooks.afterRender(async () => { await null; events.push('after'); });`);
  assert.equal(await run('render()'), 'rendered');
  assert.deepEqual(events, ['before', 'page', 'after']);
  // A page that fails to render skips the after hooks, as the wrapper it replaced did.
  events.length = 0;
  run("renderCurrentPage = async () => { events.push('page'); throw Error('page failed'); }");
  await assert.rejects(run('render()'), /page failed/);
  assert.deepEqual(events, ['before', 'page']);
  // Every render of Settings and Account reaches the parts other scripts registered.
  const settings = app.slice(
    app.indexOf('async function renderSettings()'),
    app.indexOf('function renderWorkspaceSettings()'),
  );
  assert.match(settings, /renderWorkspaceSettings\(\);\s*await AMCP\.routes\.renderParts\('\/settings'\);/);
  const identity = fs.readFileSync('web/identity.js', 'utf8'),
    account = identity.slice(identity.indexOf('async function renderAccountPage()'));
  assert.match(account.slice(0, account.indexOf('\n}\n')), /await AMCP\.routes\.renderParts\('\/account'\);$/);
});
