import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
const plain = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setImmediate(r));
function fixture(language = 'en') {
  const requests = [],
    confirmations = [],
    bindings = new Map(),
    nodes = new Map();
  const node = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        innerHTML: '',
        textContent: '',
        isConnected: true,
        events: new Map(),
        setAttribute() {},
        focus() {},
        addEventListener(k, v) {
          this.events.set(k, v);
        },
      });
    return nodes.get(id);
  };
  const form = node('#workbook-binding-form');
  form.elements = {spreadsheet_name: {value: 'Client revision'}};
  const root = node('root');
  root.querySelector = s => node(s);
  const c = createContext({
    document: {addEventListener() {}},
    root,
    navigationGeneration: 1,
    identityGeneration: 1,
    session: {workspaceRole: 'operator'},
    esc: v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    $: node,
    uiNumber: String,
    recordDetails: () => '',
    errorMessage: e => e.message,
    workspaceBind: (s, f) => bindings.set(s, f),
    workspaceCall: (tool, args) => new Promise((resolve, reject) => requests.push({tool, args, resolve, reject})),
    confirmAction: options => new Promise(resolve => confirmations.push({options, resolve})),
  });
  c.URLSearchParams = URLSearchParams;
  c.content = {innerHTML: ''};
  c.header = (title, subtitle) => title + subtitle;
  c.location = {search: '?bindings=1'};
  // WEB-07: the Operations center and the bindings controller take the paged-list loader from web/work-pages.js.
  for (const file of ['localization.js', 'work-pages.js', 'operations-center.js', 'workbook-bindings.js'])
    new Script(readFileSync('web/' + file, 'utf8')).runInContext(c);
  if (language === 'ar') {
    c.messages = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
    new Script("uiLocale='ar';uiMessages=new Map(Object.entries(messages))").runInContext(c);
  }
  const controller = new Script("workbookBindingController(root,'book-001')").runInContext(c);
  const record = {
    id: 'book-001',
    spreadsheet_id: 'SHEET-001',
    spreadsheet_name: '<img src=x>',
    binding_version: 'version-1',
    can_edit: true,
    query_count: 1,
    queries: [{id: 'query-001', name: 'Original query', account_id: '100', gateway: 'meta_native_action'}],
    queries_truncated: false,
  };
  const load = async () => {
    const p = controller.load();
    requests.at(-1).resolve(record);
    await p;
  };
  const review = async () => {
    const p = bindings.get('#workbook-binding-form')(form),
      request = requests.at(-1);
    request.resolve({
      id: 'book-001',
      binding_version: 'version-1',
      binding: plain(request.args.binding),
      spreadsheet_id: 'SHEET-001',
      query_count: 1,
      changes: [
        {field: 'spreadsheet_name', before: record.spreadsheet_name, after: request.args.binding.spreadsheet_name},
      ],
    });
    await p;
  };
  return {c, requests, confirmations, bindings, root, node, form, controller, record, load, review};
}
test('workbook setup route binds exact list filters and ignores old identities before requesting another page', async () => {
  const f = fixture(),
    list = f.node('#workbook-binding-list');
  list.querySelector = s => f.node('list ' + s);
  const filter = f.node('#workbook-binding-filter');
  filter.elements = {search: {value: 'Local client'}, spreadsheet_id: {value: 'SHEET-001'}, state: {value: 'retired'}};
  const opening = new Script('renderOperationsCenter()').runInContext(f.c);
  assert.equal(f.requests[0].args.action, 'report_bindings');
  f.requests[0].resolve({bindings: [{...f.record, next_call: {}}], next_offset: null});
  await opening;
  assert.match(f.c.content.innerHTML, /Find workbooks/);
  assert.match(list.innerHTML, /workbook_binding_id=book-001/);
  const filtering = f.bindings.get('#workbook-binding-filter')();
  assert.deepEqual(plain(f.requests[1].args), {
    action: 'report_bindings',
    search: 'Local client',
    spreadsheet_id: 'SHEET-001',
    state: 'retired',
    offset: 0,
    limit: 20,
  });
  f.c.identityGeneration++;
  f.requests[1].resolve({bindings: [{...f.record, spreadsheet_name: 'private departed workbook'}], next_offset: null});
  await filtering;
  assert.doesNotMatch(list.innerHTML, /private departed workbook/);
  await f.bindings.get('#workbook-binding-filter')();
  assert.equal(f.requests.length, 2);
});
test('workbook setup uses English/Arabic labels while review and confirmed save retain the exact original binding', async () => {
  for (const language of ['en', 'ar']) {
    const f = fixture(language);
    await f.load();
    assert.doesNotMatch(f.root.innerHTML, /<img/);
    assert.match(f.root.innerHTML, /query_id=query-001/);
    assert.match(f.root.innerHTML, language === 'ar' ? /اسم المصنف المحلي/ : /Local workbook name/);
    await f.review();
    assert.deepEqual(plain(f.requests[1].args), {
      action: 'preview_report_binding',
      id: 'book-001',
      binding_version: 'version-1',
      binding: {spreadsheet_name: 'Client revision'},
    });
    const saving = f.bindings.get('#workbook-binding-save')();
    assert.ok(f.confirmations[0].options.title);
    f.confirmations[0].resolve(true);
    await tick();
    assert.deepEqual(plain(f.requests[2].args), {
      action: 'save_report_binding',
      id: 'book-001',
      binding_version: 'version-1',
      binding: {spreadsheet_name: 'Client revision'},
      confirmed: true,
    });
    f.requests[2].resolve({});
    await tick();
    f.requests[3].resolve({...f.record, spreadsheet_name: 'Client revision', binding_version: 'version-2'});
    await saving;
  }
});
test('changing the workbook name invalidates its preview and any pending confirmation', async () => {
  const f = fixture();
  await f.load();
  await f.review();
  const saving = f.bindings.get('#workbook-binding-save')();
  f.form.elements.spreadsheet_name.value = 'Changed while confirming';
  f.form.events.get('input')({target: f.form.elements.spreadsheet_name});
  assert.equal(f.node('#workbook-binding-preview').innerHTML, '');
  f.confirmations[0].resolve(true);
  await saving;
  assert.equal(f.requests.length, 2);
});
test('late workbook loading, preview and save failures cannot repaint a different identity or route', async () => {
  for (const kind of ['load', 'preview', 'save'])
    for (const change of ['identityGeneration', 'navigationGeneration']) {
      const f = fixture();
      let pending;
      if (kind === 'load') pending = f.controller.load();
      else {
        await f.load();
        if (kind === 'preview') pending = f.bindings.get('#workbook-binding-form')(f.form);
        else {
          await f.review();
          pending = f.bindings.get('#workbook-binding-save')();
          f.confirmations[0].resolve(true);
          await tick();
        }
      }
      f.c[change]++;
      const before = f.root.innerHTML;
      f.requests.at(-1).reject(Error('private departed failure'));
      await pending;
      assert.equal(f.root.innerHTML, before);
      assert.doesNotMatch(f.node('[data-binding-status]').textContent, /private departed/);
      const count = f.requests.length;
      await f.controller.load();
      assert.equal(f.requests.length, count);
    }
});

test('retirement and restoration review exact local state and require a version-bound confirmation in both languages', async () => {
  for (const language of ['en', 'ar'])
    for (const retired of [false, true]) {
      const f = fixture(language);
      Object.assign(f.record, {retired, can_manage_state: true, can_edit: !retired, query_count: 0, queries: []});
      await f.load();
      const reviewing = f.bindings.get('#workbook-binding-state-review')();
      assert.deepEqual(plain(f.requests[1].args), {
        action: 'preview_report_binding_state',
        id: 'book-001',
        binding_version: 'version-1',
        active: retired,
      });
      f.requests[1].resolve({
        id: 'book-001',
        binding_version: 'version-1',
        active: retired,
        spreadsheet_id: 'SHEET-001',
        changes: ['retired'],
      });
      await reviewing;
      const saving = f.bindings.get('#workbook-binding-state-save')();
      assert.ok(f.confirmations[0].options.title);
      assert.match(f.confirmations[0].options.consequence, /SHEET-001/);
      f.confirmations[0].resolve(true);
      await tick();
      assert.deepEqual(plain(f.requests[2].args), {
        action: 'save_report_binding_state',
        id: 'book-001',
        binding_version: 'version-1',
        active: retired,
        confirmed: true,
      });
      f.requests[2].resolve({});
      await tick();
      f.requests[3].resolve({...f.record, retired: !retired, binding_version: 'version-2'});
      await saving;
    }
});

test('pending workbook retirement is invalidated by edits or a departed identity before saving', async () => {
  for (const change of ['edit', 'identity']) {
    const f = fixture();
    Object.assign(f.record, {can_manage_state: true, query_count: 0, queries: [], retired: false});
    await f.load();
    const reviewing = f.bindings.get('#workbook-binding-state-review')();
    f.requests[1].resolve({
      id: 'book-001',
      binding_version: 'version-1',
      active: false,
      spreadsheet_id: 'SHEET-001',
      changes: ['retired'],
    });
    await reviewing;
    const saving = f.bindings.get('#workbook-binding-state-save')();
    if (change === 'edit') {
      f.form.elements.spreadsheet_name.value = 'Changed';
      f.form.events.get('input')();
    } else f.c.identityGeneration++;
    f.confirmations[0].resolve(true);
    await saving;
    assert.equal(f.requests.length, 2);
  }
});
