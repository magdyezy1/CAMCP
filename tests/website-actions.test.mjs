import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

function fixture(form = false, selector = '#action') {
  const elements = new Map(),
    handlers = new Map(),
    body = {tagName: 'BODY', isConnected: true, classList: {remove() {}}},
    document = {
      body,
      activeElement: body,
      addEventListener() {},
      querySelector: selector => elements.get(selector) ?? null,
      querySelectorAll: query => (query === selector ? [target] : []),
    };
  function element(id, tagName = 'BUTTON') {
    const attrs = new Map();
    return {
      id,
      tagName,
      disabled: false,
      isConnected: true,
      attributes: [],
      parentElement: body,
      addEventListener: (type, handler) => handlers.set(type, handler),
      setAttribute: (name, value) => attrs.set(name, value),
      removeAttribute: name => attrs.delete(name),
      getAttribute: name => attrs.get(name),
      focus() {
        document.activeElement = this;
      },
      querySelector: () => button,
    };
  }
  let button = element('action'),
    target = form ? element('action-form', 'FORM') : button;
  elements.set('#action', button);
  elements.set('.main-shell', {inert: false});
  elements.set('#menu-toggle', element('menu-toggle'));
  elements.set('#workspace-sidebar', {inert: false});
  elements.set('#command-query', {addEventListener() {}});
  const messages = [],
    context = createContext({
      document,
      CSS: {escape: value => value},
      location: {pathname: '/dashboard'},
      window: {addEventListener() {}},
      matchMedia: () => ({matches: false, addEventListener() {}}),
      $: document.querySelector,
      esc: String,
      session: {},
      toast: message => messages.push(message),
      perform: async () => {},
      api: async () => ({}),
    });
  for (const file of ['identity', 'workspace'])
    new Script(readFileSync('web/' + file + '.js', 'utf8')).runInContext(context);
  return {
    context,
    document,
    elements,
    target,
    button,
    messages,
    run: code => new Script(code).runInContext(context),
    replace() {
      button.isConnected = false;
      button = element('action');
      elements.set('#action', button);
      document.activeElement = body;
      return button;
    },
    fire: async () => handlers.get(form ? 'submit' : 'click')({preventDefault() {}, submitter: form ? null : target}),
  };
}

test('workspace actions retain keyboard focus on the replacement control after rerender', async () => {
  const f = fixture();
  let replacement;
  f.context.perform = async () => {
    replacement = f.replace();
  };
  f.run('workspaceBind("#action", perform)');
  await f.fire();
  assert.equal(f.document.activeElement, replacement);
});

test('workspace actions announce busy state until their asynchronous work completes', async () => {
  const f = fixture();
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });

  f.context.perform = async () => gate;
  f.run('workspaceBind("#action", perform)');
  const pending = f.fire();
  assert.equal(f.button.disabled, true);
  assert.equal(f.button.getAttribute('aria-busy'), 'true');
  release();
  await pending;
  assert.equal(f.button.disabled, false);
  assert.equal(f.button.getAttribute('aria-busy'), undefined);
});

test('a cancelled previous-page action stays silent', async () => {
  const f = fixture();
  f.context.perform = async () => {
    throw Object.assign(Error('Previous page changed'), {code: 'PAGE_CHANGED'});
  };
  f.run('workspaceBind("#action", perform)');
  await f.fire();
  assert.deepEqual(f.messages, []);
});

test('a cancelled previous-page action preserves focus even after returning to the same pathname', async () => {
  const f = fixture(),
    current = {tagName: 'A', id: 'current-route-link'};
  f.context.perform = async () => {
    f.replace();
    f.document.activeElement = current;
    throw Object.assign(Error('Previous page changed'), {code: 'PAGE_CHANGED'});
  };
  f.run('workspaceBind("#action", perform)');
  await f.fire();
  assert.equal(f.document.activeElement, current);
});

test('auth forms without an event submitter still use and release their submit control', async () => {
  const f = fixture(true);
  let called = false;
  f.context.perform = async () => {
    called = true;
    assert.equal(f.button.disabled, true);
  };
  f.run('authBind("#action", perform)');
  await f.fire();
  assert.equal(called, true);
  assert.equal(f.button.disabled, false);
});

for (const action of ['execute', 'resume'])
  test('media ' + action + ' does not start a recovery read after its page changes', async () => {
    const handlers = new Map(),
      nodes = new Map(),
      node = selector => {
        if (!nodes.has(selector))
          nodes.set(selector, {innerHTML: '', checked: true, addEventListener() {}, setAttribute() {}, focus() {}});
        return nodes.get(selector);
      },
      reads = [],
      context = createContext({
        api: async (_url, options) => {
          const args = JSON.parse(options.body);
          if (args.action === 'list') return {success: true, data: {presets: {}, assets: []}};
          if (args.action === 'recovery') {
            reads.push(args.review_id);
            return {
              success: true,
              data: {
                review_id: 'original-review',
                idempotency_key: 'original-key',
                can_execute: action === 'execute',
                resume_available: action === 'resume',
                journal: {},
              },
            };
          }
          assert.equal(args.action, action);
          throw Object.assign(Error('This page has changed.'), {code: 'PAGE_CHANGED'});
        },
        authBind: (selector, handler) => handlers.set(selector, handler),
        $: node,
        content: node('#content'),
        esc: String,
        date: () => '',
        platforms: [],
        pushDrives: () => [],
        creativePushPanel: () => '',
        adPreviewsPanel: () => '',
        bindCreativePush() {},
        bindAdPreviews() {},
      });
    const run = code => new Script(code).runInContext(context);
    run(readFileSync('web/workspace.js', 'utf8'));
    await run('renderMediaLibrary()');
    await handlers.get('[data-media-recovery]')({dataset: {mediaRecovery: 'original-review'}});
    node('#media-review').innerHTML = 'Current page';
    await assert.rejects(handlers.get('#execute-reviewed')(), e => e.code === 'PAGE_CHANGED');
    assert.deepEqual(reads, ['original-review']);
    assert.equal(node('#media-review').innerHTML, 'Current page');
  });

for (const selector of ['#report-prev', '#report-next'])
  test(selector + ' handles navigation during a pending page request without an uncaught error', async () => {
    const f = fixture(false, selector),
      root = {innerHTML: ''},
      snapshot = {
        id: 'report',
        state: 'complete',
        rows: [],
        row_count: 0,
        sources: [],
        summary: [],
        exports: [],
        config: {
          name: 'report',
          date_range: {since: '2026-09-01', until: '2026-09-01'},
          metrics: [],
          custom_metrics: [],
        },
        job: {state: 'complete'},
      };
    let calls = 0;
    f.context.api = async () => {
      if (++calls === 1) return {success: true, data: snapshot};
      throw Object.assign(Error('This page has changed.'), {code: 'PAGE_CHANGED'});
    };
    f.context.location.pathname = '/reporting-overview';
    f.context.Intl = Intl;
    f.context.clearTimeout = () => {};
    f.context.pollTimer = null;
    f.context.date = () => '';
    f.elements.set('#overview-results', root);
    f.elements.set(selector, f.button);
    for (const file of ['report-library', 'report-quality', 'reporting-overview'])
      f.run(readFileSync('web/' + file + '.js', 'utf8'));
    f.run('overviewState.bootstrap={platforms:[],metrics:{}}');
    await f.run("loadOverviewReport('report')");
    await f.fire();
    assert.deepEqual(f.messages, []);
    assert.equal(f.button.disabled, false);
  });
