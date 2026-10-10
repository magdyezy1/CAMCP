// MED-03 (review 2026-10-08): the website's creative push no longer depends on the open tab. With server runs on (the
// default) it saves the rows as plans of independent uploads, approves them with the member's confirmation and queues
// them with run_background; the page only reads them back. With server runs off it drives each row through a durable
// job (execute_async + job_status) with a leave-page guard, one staged review at a time. Rows whose exact file is
// already in the account offer "Reuse (fresh availability check)". A plan step whose file expired offers "Replace the
// file", which plans the new file and amends the step. Before this the page awaited a synchronous execute per row, so a
// long row outlasted proxy timeouts and leaving the page stopped and forgot the remaining rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const plain = value => JSON.parse(JSON.stringify(value));
const id = n => 'src-' + String(n).repeat(8) + '-0000-0000-0000-000000000000';

function fixture(locale = 'en') {
  const nodes = new Map(),
    bindings = new Map(),
    calls = [],
    listeners = [];
  const node = selector => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        innerHTML: '',
        textContent: '',
        value: '',
        checked: false,
        hidden: false,
        isConnected: true,
        elements: {},
        dataset: {},
        insertAdjacentHTML(_where, html) {
          this.innerHTML += html;
        },
        addEventListener() {},
        setAttribute() {},
        focus() {},
        click() {},
        querySelector: node,
        querySelectorAll: () => [],
      });
    return nodes.get(selector);
  };
  const context = createContext({
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    Intl,
    Date,
    Blob,
    File,
    crypto: globalThis.crypto,
    URLSearchParams,
    clock: 0,
    // Time passes only in the page's waits: each wait advances the synthetic clock and returns at once.
    setTimeout: (fn, ms = 0) => {
      context.clock += ms;
      context.onWait?.(ms);
      fn();
      return 0;
    },
    clearTimeout() {},
    window: {
      addEventListener: (type, fn) => listeners.push({type, fn, on: true}),
      removeEventListener: (type, fn) =>
        listeners.filter(l => l.type === type && l.fn === fn).forEach(l => (l.on = false)),
    },
    document: {addEventListener() {}, querySelector: node, querySelectorAll: () => []},
    $: node,
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    date: String,
    pretty: value => String(value ?? ''),
    toast() {},
    errorMessage: e => String(e?.message ?? ''),
    session: {authenticated: true, workspaceRole: 'operator', csrf: 'csrf-synthetic'},
    platforms: [],
    navigationGeneration: 1,
    identityGeneration: 1,
    sessionStorage: {getItem: () => null, setItem() {}},
    fetch: async () => ({ok: true, json: async () => ({})}),
    confirmAction: async () => true,
    navigate: async () => {},
    renderWorkspacePage() {},
    accountLabel: (_p, _c, account) => 'Account ' + account,
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  for (const file of ['workspace', 'campaign-workflows', 'creative-push'])
    run(readFileSync('web/' + file + '.js', 'utf8'));
  context.workspaceBind = (selector, fn) => bindings.set(selector, fn);
  const form = node('#push-review');
  form.elements = {name: {value: '', required: false}, owner_urn: {value: ''}, fit: {checked: true}};
  form.querySelectorAll = selector =>
    selector === 'input[name=target]:checked' ? context.targets.map((_t, i) => ({value: String(i)})) : [];
  return {run, context, node, bindings, calls, listeners};
}
const source = (n, minutes, extra = {}) => ({
  source_id: id(n),
  filename: 'file-' + n + '.png',
  state: 'complete',
  origin: 'upload',
  mime: 'image/png',
  kind: 'image',
  size: 1024,
  sha256: String(n).repeat(64),
  expires_at: new Date(Date.now() + minutes * 60000).toISOString(),
  ...extra,
});
const target = account => ({
  platform: 'meta',
  platformName: 'Meta',
  account_id: account,
  account: 'Account ' + account,
  connection_id: 'login',
  label: 'Meta · ' + account,
});
/** Adds the listed files to the push and reviews it for the fixture's targets. */
async function review(f, files) {
  f.context.api = async url => {
    if (url === '/api/media/sources') return {sources: files, server_time: new Date().toISOString()};
    throw Error('unexpected ' + url);
  };
  for (const s of files) await f.bindings.get('[data-push-source]')({dataset: {pushSource: s.source_id}});
  await f.bindings.get('#push-review')(f.node('#push-review'));
  f.node('#push-consent').checked = true;
}

test('without server runs each row is a durable job: a 150-second upload is followed by polling, one review at a time', async () => {
  const f = fixture();
  f.context.targets = [target('101'), target('102')];
  let staged = 0,
    maxStaged = 0,
    polls = 0;
  const jobs = new Map();
  f.context.workspaceCall = async (tool, input) => {
    f.calls.push({tool, ...plain(input)});
    if (input.action === 'plan')
      return {
        destinations: input.destinations.map(() => ({
          ready: true,
          file: {sha256: 'e'.repeat(64), size: 1024, mime: 'image/png'},
        })),
      };
    if (input.action === 'prepare') {
      staged++;
      maxStaged = Math.max(maxStaged, staged);
      // A guard was registered before anything was prepared: leaving the page asks first.
      assert.ok(f.listeners.some(l => l.type === 'beforeunload' && l.on));
      return {review_id: 'review-' + input.account_id};
    }
    if (input.action === 'execute_async') {
      jobs.set(input.review_id, f.context.clock);
      return {state: 'queued', job_id: 'job-' + input.review_id};
    }
    if (input.action === 'job_status') {
      polls++;
      // The upload takes 150 seconds on the server; no request waits for it.
      if (f.context.clock - jobs.get(input.review_id) < 150000) return {state: 'running'};
      staged--;
      return {state: 'complete', result: {ready: true, media_id: 'm-' + input.review_id}};
    }
    throw Error('unexpected ' + input.action);
  };
  f.run('bindCreativePush(targets, [], [], undefined, {serverPush: false})');
  await review(f, [source(1, 25)]);
  f.calls.length = 0;
  await f.bindings.get('#push-execute')();
  assert.equal(maxStaged, 1, 'a second review is never prepared while one is still staged');
  const order = f.calls.map(c => c.action);
  assert.deepEqual(order.slice(0, 3), ['prepare', 'execute_async', 'job_status']);
  assert.equal(order.indexOf('prepare', 1), order.lastIndexOf('job_status', order.indexOf('prepare', 1)) + 1);
  assert.ok(polls >= 2 * 38, 'each 150-second job was followed until it completed');
  assert.equal(f.calls.filter(c => c.action === 'execute').length, 0, 'no synchronous execute holds the page');
  assert.match(f.node('#push-status').textContent, /Submitted 2 of 2/);
  assert.ok(
    f.listeners.every(l => !l.on),
    'the leave-page guard is removed once the rows are done',
  );
});

test('with server runs the push is saved as approved plans and queued; the page only reads them back', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    // 30 accounts and two files: 60 uploads, saved as two plans of at most 50.
    f.context.targets = Array.from({length: 30}, (_, i) => target(String(101 + i)));
    const plans = new Map();
    let gets = 0;
    f.context.workspaceCall = async (tool, input) => {
      f.calls.push({tool, ...plain(input)});
      if (input.action === 'plan')
        return {
          destinations: input.destinations.map(d => ({
            ready: true,
            file: {sha256: 'e'.repeat(64), size: 1024, mime: 'image/png'},
            existing_receipts: d.account_id === '101' ? [{asset_id: 'asset-1', media_id: 'm-1'}] : [],
          })),
        };
      if (tool === 'campaign' && input.action === 'create') {
        const planId = 'plan-' + (plans.size + 1);
        plans.set(planId, input.steps);
        return {id: planId};
      }
      if (input.action === 'approve' && !input.confirmed)
        return {approval: {plan_hash: 'hash-' + input.id, summary_hash: 'summary-' + input.id}};
      if (input.action === 'approve') return {approved: {by: 'u'}};
      if (input.action === 'run_background') return {background: {state: 'queued', job_id: 'job-' + input.id}};
      if (input.action === 'get') {
        gets++;
        // The member leaves the page while the server is still running the second plan.
        if (gets === 3) f.context.navigationGeneration++;
        const steps = plans.get(input.id).map((s, i) => ({
          id: s.id,
          kind: 'media',
          status: i === 0 ? 'failed' : i === 1 ? 'pending' : 'verified',
          ...(i === 0 ? {error: 'MEDIA_CHANGED'} : {}),
          ...(i === 1 ? {waiting: 'MEDIA_MEMORY_BUSY'} : {}),
          ...(i > 1 ? {resource_ids: ['m-' + s.id]} : {}),
        }));
        return {id: input.id, steps, background: {state: 'running'}};
      }
      throw Error('unexpected ' + tool + ' ' + input.action);
    };
    f.run('bindCreativePush(targets, [], [], undefined, {serverPush: true})');
    await review(f, [source(1, 25), source(2, 25)]);
    // The row already in account 101 offers reuse after a fresh availability check, chosen by default.
    assert.match(
      f.node('#push-reviews').innerHTML,
      locale === 'ar' ? /أعد استخدامه \(فحص جديد للتوفر\)/ : /Reuse it \(fresh availability check\)/,
    );
    f.calls.length = 0;
    await f.bindings.get('#push-execute')();
    const creates = f.calls.filter(c => c.action === 'create');
    assert.equal(creates.length, 2);
    assert.deepEqual(
      creates.map(c => c.steps.length),
      [50, 10],
    );
    const step = creates[0].steps[0];
    assert.equal(step.description, 'file-1.png → Meta · Account 101');
    assert.equal(step.arguments.expected_sha256, 'e'.repeat(64));
    assert.equal(step.arguments.reuse_existing, true);
    assert.equal(creates[0].steps[1].arguments.reuse_existing, undefined);
    assert.equal(creates[0].acknowledge_temporary_sources, true);
    assert.equal(creates[0].confirmed, undefined, 'saving a plan approves nothing by itself');
    // Each plan is approved with the exact hashes of its own summary, then queued on the server.
    assert.deepEqual(
      f.calls.filter(c => c.action === 'approve' && c.confirmed).map(c => [c.id, c.plan_hash, c.summary_hash]),
      [
        ['plan-1', 'hash-plan-1', 'summary-plan-1'],
        ['plan-2', 'hash-plan-2', 'summary-plan-2'],
      ],
    );
    assert.deepEqual(
      f.calls.filter(c => c.action === 'run_background').map(c => c.id),
      ['plan-1', 'plan-2'],
    );
    assert.equal(f.calls.filter(c => ['prepare', 'execute', 'execute_async'].includes(c.action)).length, 0);
    // The rows show what the server reports; after the page changed nothing more is read.
    assert.equal(gets, 3);
    const html = f.node('#push-reviews').innerHTML;
    assert.match(html, /\/campaigns\?id=plan-1/);
    if (locale === 'en') {
      assert.match(html, /Needs inspection/);
      assert.match(html, /MEDIA_CHANGED/);
      assert.match(html, /Waiting: AMCP is busy with other media work/);
      assert.match(html, /Uploaded/);
      assert.match(f.node('#push-status').textContent, /you can leave this page/);
    } else assert.match(f.node('#push-status').textContent, /يمكنك مغادرة هذه الصفحة/);
    assert.ok(
      f.listeners.every(l => !l.on),
      'once queued the push no longer holds the page',
    );
  }
});

test('a server push skips rows whose file is deleted within five minutes and saves only the rest', async () => {
  const f = fixture();
  f.context.targets = [target('101')];
  f.context.workspaceCall = async (tool, input) => {
    f.calls.push({tool, ...plain(input)});
    if (input.action === 'plan')
      return {destinations: [{ready: true, file: {sha256: 'e'.repeat(64), size: 1024, mime: 'image/png'}}]};
    if (input.action === 'create') return {id: 'plan-1'};
    if (input.action === 'approve' && !input.confirmed) return {approval: {plan_hash: 'h', summary_hash: 's'}};
    if (input.action === 'get')
      return {
        id: 'plan-1',
        steps: [{id: 'upload-1', kind: 'media', status: 'verified'}],
        background: {state: 'complete'},
      };
    return {};
  };
  f.run('bindCreativePush(targets, [], [], undefined, {serverPush: true})');
  await review(f, [source(1, 4), source(2, 25)]);
  f.calls.length = 0;
  await f.bindings.get('#push-execute')();
  const create = f.calls.find(c => c.action === 'create');
  assert.deepEqual(
    create.steps.map(s => s.arguments.source_id),
    [id(2)],
  );
  assert.match(f.node('#push-reviews').innerHTML, /Its upload is deleted before this push could finish/);
  assert.match(f.node('#push-status').textContent, /Submitted 1 of 2/);
});

test('a row whose file is already in the account can be uploaded again instead of reused', async () => {
  const f = fixture();
  f.context.targets = [target('101')];
  const selects = [];
  f.node('#push-reviews').querySelectorAll = selector => (selector === '[data-push-reuse]' ? selects : []);
  f.context.workspaceCall = async (tool, input) => {
    f.calls.push({tool, ...plain(input)});
    if (input.action === 'plan')
      return {
        destinations: [
          {ready: true, file: {sha256: 'e'.repeat(64), size: 1024, mime: 'image/png'}, existing_receipts: [{}]},
        ],
      };
    if (input.action === 'prepare') return {review_id: 'review-1'};
    if (input.action === 'execute_async') return {state: 'queued'};
    if (input.action === 'job_status') return {state: 'complete', result: {ready: true}};
    throw Error('unexpected ' + input.action);
  };
  // The select drawn for the row, as the page binds it.
  selects.push({
    dataset: {pushReuse: '0'},
    value: 'reuse',
    addEventListener(_type, fn) {
      this.change = fn;
    },
  });
  f.run('bindCreativePush(targets, [], [], undefined, {serverPush: false})');
  await review(f, [source(1, 25)]);
  selects.at(-1).value = 'upload';
  selects.at(-1).change();
  f.calls.length = 0;
  await f.bindings.get('#push-execute')();
  assert.equal(f.calls.find(c => c.action === 'prepare').reuse_existing, undefined);
  assert.equal(f.calls.filter(c => c.action === 'execute_async').length, 1);
});

test('a plan shows its run-by time and server run, and a step whose file expired is given a new file', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale),
      deadline = new Date(Date.now() + 20 * 60000).toISOString(),
      plan = {
        id: 'plan-1',
        name: 'Creative push · 2 uploads',
        brief: 'Upload only the previewed files.',
        state: 'attention',
        revision: 4,
        temporary_sources: {earliest_expires_at: deadline, sources: []},
        background: {state: 'running'},
        steps: [
          {
            id: 'upload-1',
            kind: 'media',
            status: 'failed',
            error: {code: 'MEDIA_SOURCE_NOT_FOUND', message: 'The upload expired or was removed.'},
            description: 'file-1.png → Meta · Account 101',
            account_id: '101',
            depends_on: [],
            arguments: {
              platform: 'meta',
              account_id: '101',
              connection_id: 'login',
              source_id: id(1),
              fit_to_platform: true,
              expected_sha256: '1'.repeat(64),
            },
          },
          {
            id: 'upload-2',
            kind: 'media',
            status: 'verified',
            account_id: '102',
            depends_on: [],
            arguments: {platform: 'meta', source_id: id(2)},
          },
        ],
      };
    const html = f.run('campaignJournal')(plan);
    assert.match(html, locale === 'ar' ? /قابلة للتشغيل حتى/ : /Runnable until/);
    assert.match(
      html,
      locale === 'ar' ? /قيد التشغيل على خادم AMCP/ : /Running on the AMCP server: you can leave this page/,
    );
    assert.equal((html.match(/data-replace-source=/g) ?? []).length, 1, 'only the expired step offers a new file');
    const fresh = source(3, 28);
    f.context.api = async url => {
      assert.equal(url, '/api/media/sources');
      return {sources: [source(1, 1), fresh, {...source(4, 28), state: 'receiving'}]};
    };
    f.context.workspaceCall = async (tool, input) => {
      f.calls.push({tool, ...plain(input)});
      if (input.action === 'plan')
        return {destinations: [{ready: true, file: {sha256: '3'.repeat(64), size: 1024, mime: 'image/png'}}]};
      if (input.action === 'recover_step') return {id: 'plan-1', state: 'draft'};
      throw Error('unexpected ' + input.action);
    };
    f.context.plan = plan;
    f.run('bindCampaignWorkflow(plan, async () => true, () => true)');
    await f.bindings.get('[data-replace-source]')({dataset: {replaceSource: 'upload-1'}});
    const panel = f.node('#campaign-review').innerHTML;
    assert.match(panel, /file-3\.png/);
    assert.doesNotMatch(
      panel,
      /file-1\.png|file-4\.png/,
      'neither the expired file nor an unfinished upload is offered',
    );
    const form = {elements: {source: {value: '0'}, confirmed: {checked: true}}};
    await f.bindings.get('#replace-source')(form);
    const [planned, recovered] = f.calls;
    assert.equal(planned.action, 'plan');
    assert.equal(planned.source_id, fresh.source_id);
    assert.equal(planned.stage_fits, true);
    assert.deepEqual(planned.destinations, [{platform: 'meta', account_id: '101', connection_id: 'login'}]);
    assert.deepEqual(recovered, {
      tool: 'campaign',
      action: 'recover_step',
      id: 'plan-1',
      step_id: 'upload-1',
      expected_revision: 4,
      confirmed: true,
      acknowledge_temporary_sources: true,
      patch: [
        {path: '/source_id', value: fresh.source_id},
        {path: '/expected_sha256', value: '3'.repeat(64)},
      ],
    });
  }
});
