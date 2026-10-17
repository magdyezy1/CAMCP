import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
const tick = () => new Promise(r => setImmediate(r));
const plain = v => JSON.parse(JSON.stringify(v));
function fixture(language = 'en') {
  const nodes = new Map(),
    bindings = new Map(),
    requests = [],
    confirmations = [];
  const node = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        innerHTML: '',
        textContent: '',
        isConnected: true,
        events: new Map(),
        focus() {},
        setAttribute() {},
        addEventListener(k, f) {
          this.events.set(k, f);
        },
        querySelector(s) {
          return node(id + ' ' + s);
        },
      });
    return nodes.get(id);
  };
  const root = node('root'),
    form = node('#query-move-filter');
  form.elements = {search: {value: ''}};
  const c = createContext({
    root,
    navigationGeneration: 1,
    identityGeneration: 1,
    document: {addEventListener() {}},
    URLSearchParams,
    esc: v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    $: node,
    uiNumber: String,
    errorMessage: e => e.message,
    workspaceBind: (s, f) => bindings.set(s, f),
    workspaceCall: (tool, args) => new Promise((resolve, reject) => requests.push({tool, args, resolve, reject})),
    confirmAction: options => new Promise(resolve => confirmations.push({options, resolve})),
  });
  // WEB-07: the rebinding controller needs only the paged-list loader (web/work-pages.js), not the Operations center.
  for (const file of ['localization.js', 'work-pages.js', 'workbook-rebinding.js'])
    new Script(readFileSync('web/' + file, 'utf8')).runInContext(c);
  if (language === 'ar') {
    c.messages = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
    new Script("uiLocale='ar';uiMessages=new Map(Object.entries(messages))").runInContext(c);
  }
  const controller = new Script("workbookQueryMoveController(root,'query-001')").runInContext(c);
  const query = {
    id: 'query-001',
    name: 'Original <query>',
    can_edit: true,
    query_version: 'query-v1',
    workbook_binding_id: 'source',
    account_id: '100',
    schedules: [],
  };
  const target = {id: 'target', spreadsheet_name: 'Target <name>', spreadsheet_id: 'SHEET-target', query_count: 0};
  const preview = {
    id: 'query-001',
    query_version: 'query-v1',
    rebinding_version: 'move-v1',
    source: {id: 'source', spreadsheet_name: 'Source workbook', spreadsheet_id: 'SHEET-source'},
    target,
    schedules_to_rebind: 2,
    schedules_to_pause: 1,
  };
  const load = async () => {
    const p = controller.load();
    requests.at(-1).resolve(query);
    await tick();
    requests.at(-1).resolve({bindings: [target], next_offset: null});
    await p;
  };
  const review = async () => {
    bindings.get('#query-move-select-0')();
    const p = bindings.get('#query-move-review')();
    requests.at(-1).resolve(preview);
    await p;
  };
  return {root, form, c, node, bindings, requests, confirmations, controller, load, review, query, target, preview};
}
test('English and Arabic workbook moves choose an exact target, review schedule impact and confirm the displayed versions', async () => {
  for (const language of ['en', 'ar']) {
    const f = fixture(language);
    await f.load();
    assert.doesNotMatch(f.root.innerHTML, /<query>/);
    assert.match(f.root.innerHTML, language === 'ar' ? /نقل الاستعلام/ : /Move saved query/);
    await f.review();
    assert.deepEqual(plain(f.requests[2].args), {
      action: 'preview_report_query_move',
      id: 'query-001',
      query_version: 'query-v1',
      target_binding_id: 'target',
    });
    assert.doesNotMatch(f.node('#query-move-preview').innerHTML, /<name>/);
    const saving = f.bindings.get('#query-move-save')();
    assert.ok(f.confirmations[0].options.title);
    assert.match(f.confirmations[0].options.consequence, /SHEET-source/);
    assert.match(f.confirmations[0].options.consequence, /SHEET-target/);
    f.confirmations[0].resolve(true);
    await tick();
    assert.deepEqual(plain(f.requests[3].args), {
      action: 'move_report_query',
      id: 'query-001',
      query_version: 'query-v1',
      target_binding_id: 'target',
      rebinding_version: 'move-v1',
      confirmed: true,
    });
    f.requests[3].resolve({
      id: 'query-001',
      prepared_run_id: 'prepared-001',
      schedules: [{id: 'schedule-001', website_path: '/operations?workbook_schedule_id=schedule-001'}],
    });
    await saving;
    assert.match(f.root.innerHTML, /run_id=prepared-001/);
    assert.match(f.root.innerHTML, /workbook_schedule_id=schedule-001/);
    assert.equal(f.requests.length, 4);
  }
});
test('changing target search invalidates pending move approval without submitting it', async () => {
  const f = fixture();
  await f.load();
  await f.review();
  const saving = f.bindings.get('#query-move-save')();
  f.form.elements.search.value = 'New target';
  f.form.events.get('input')();
  assert.equal(f.node('#query-move-preview').innerHTML, '');
  f.confirmations[0].resolve(true);
  await saving;
  assert.equal(f.requests.length, 3);
});
test('late move loads, previews and saves cannot repaint a departed route or identity', async () => {
  for (const stage of ['load', 'preview', 'save'])
    for (const key of ['identityGeneration', 'navigationGeneration']) {
      const f = fixture();
      let pending;
      if (stage === 'load') pending = f.controller.load();
      else {
        await f.load();
        if (stage === 'preview') {
          f.bindings.get('#query-move-select-0')();
          pending = f.bindings.get('#query-move-review')();
        } else {
          await f.review();
          pending = f.bindings.get('#query-move-save')();
          f.confirmations[0].resolve(true);
          await tick();
        }
      }
      f.c[key]++;
      const before = f.root.innerHTML;
      f.requests.at(-1).reject(Error('private departed error'));
      await pending;
      assert.equal(f.root.innerHTML, before);
      assert.doesNotMatch(f.node('#query-move-status').textContent, /private departed/);
      const count = f.requests.length;
      await f.controller.load();
      assert.equal(f.requests.length, count);
    }
});
