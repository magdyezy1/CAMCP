import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

function fixture({getPack = async () => ({}), bind = async () => {}} = {}) {
  let focused = false;
  const bindings = [];
  const heading = {
    setAttribute() {},
    focus() {
      focused = true;
    },
  };
  const content = {innerHTML: 'Current page', querySelector: () => heading};
  const context = createContext({
    document: {addEventListener() {}},
    navigationGeneration: 1,
    identityGeneration: 1,
    content,
    location: {search: '?report_id=synthetic'},
    URLSearchParams,
    overviewCall: getPack,
    bindReportPresentation: bind,
    reportPackBody: () => '<article>Snapshot</article>',
    workspaceBind: selector => bindings.push(selector),
    encodeURIComponent,
    esc: String,
  });
  const source = readFileSync('web/evidence-workflows.js', 'utf8');
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(source.slice(source.indexOf('async function renderReportPack('))).runInContext(context);
  return {
    context,
    content,
    bindings,
    focused: () => focused,
    render: () => new Script('renderReportPack(true)').runInContext(context),
  };
}
test('report-pack refresh focuses the updated report after branding is saved', async () => {
  const f = fixture();
  assert.equal(await f.render(), true);
  assert.equal(f.focused(), true);
  assert.deepEqual(f.bindings, ['#print-pack', '#download-pack']);
});
test('a delayed pack cannot replace a newer page or signed-in identity', async () => {
  for (const generation of ['navigationGeneration', 'identityGeneration']) {
    let resolve;
    const f = fixture({
      getPack: () =>
        new Promise(r => {
          resolve = r;
        }),
    });
    const pending = f.render();
    f.context[generation]++;
    resolve({});
    await pending;
    assert.equal(f.content.innerHTML, 'Current page');
    assert.equal(f.focused(), false);
    assert.deepEqual(f.bindings, []);
  }
});
test('a branding-choice response cannot bind downloads or steal focus after navigation', async () => {
  let resolve;
  const f = fixture({
    bind: () =>
      new Promise(r => {
        resolve = r;
      }),
  });
  const pending = f.render();
  await new Promise(r => setImmediate(r));
  f.context.navigationGeneration++;
  f.content.innerHTML = 'New destination';
  resolve();
  await pending;
  assert.equal(f.content.innerHTML, 'New destination');
  assert.equal(f.focused(), false);
  assert.deepEqual(f.bindings, []);
});
