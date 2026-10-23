import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

/**
 * SEC-05 (review 2026-10-08): the owner's Settings offer the viewer-download choice. It shows the saved state, asks
 * for confirmation, and saves through POST /api/export-policy; declining the confirmation sends nothing.
 */
const source = readFileSync('web/owner-operations.js', 'utf8');
function fixture(viewerDownloads, confirmed = true) {
  const areas = [],
    pending = [],
    posts = [],
    confirmations = [],
    bindings = new Map();
  const context = createContext({
    Intl,
    document: {
      addEventListener() {},
      createElement: () => ({}),
    },
    renderWorkspaceSettings() {},
    date: value => String(value),
    esc: value =>
      String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    session: {authenticated: true, administrator: true, workspaceRole: 'owner'},
    location: {pathname: '/settings'},
    navigationGeneration: 7,
    content: {querySelector: () => null, append: area => areas.push(area)},
    platforms: [],
    pretty: String,
    authBind: (selector, fn) => bindings.set(selector, fn),
    $: () => ({addEventListener() {}, scrollIntoView() {}}),
    FormData: class {
      constructor(form) {
        return new Map(Object.entries(form.values));
      }
    },
    confirmAction: async args => {
      confirmations.push(args);
      return confirmed;
    },
    toast() {},
    api(path, options) {
      if (options?.method === 'POST' && path === '/api/export-policy') {
        posts.push(JSON.parse(options.body));
        return Promise.resolve({viewer_downloads: JSON.parse(options.body).viewer_downloads});
      }
      return new Promise(resolve => pending.push({path, resolve}));
    },
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  const app = readFileSync('web/app.js', 'utf8');
  run(app.slice(app.indexOf('const identityKey ='), app.indexOf('function resetPrivateState()')));
  // WEB-07: the shell's Settings page renders its shared part (stubbed above), then the parts scripts registered.
  run(readFileSync('web/routes.js', 'utf8'));
  run(app.slice(app.indexOf('async function renderSettings()'), app.indexOf('function renderWorkspaceSettings()')));
  run(source);
  const health = {
    backup: {status: 'unverified'},
    operations: {},
    connections: [],
    jobs: [],
    email: [],
    storage: {database_bytes: 0, report_rows: 0},
    limits: {},
    api_versions: {},
    policies: [],
    ...(viewerDownloads === undefined ? {} : {export_policy: {viewer_downloads: viewerDownloads}}),
  };
  return {
    areas,
    posts,
    confirmations,
    bindings,
    render: async () => {
      const rendering = run('renderSettings()');
      for (const request of pending.splice(0, 2))
        request.resolve(
          request.path === '/api/account/options'
            ? {emailEnabled: false, providers: []}
            : {success: true, data: health},
        );
      await rendering;
    },
  };
}

test('SEC-05: the owner Settings show the saved viewer-download choice', async () => {
  for (const [saved, checked] of [
    [false, false],
    [true, true],
    [undefined, false],
  ]) {
    const f = fixture(saved);
    await f.render();
    const html = f.areas[0].innerHTML;
    // The owner forms take the workspace form style (design review 2026-10: they rendered unstyled native controls).
    assert.match(html, /<form id="owner-export-policy" class="workspace-form">/);
    assert.equal(/name="viewer_downloads" type="checkbox" checked/.test(html), checked);
    assert.ok(f.bindings.has('#owner-export-policy'));
  }
});

test('SEC-05: saving the viewer-download choice asks first and posts the confirmed choice; declining sends nothing', async () => {
  const f = fixture(false);
  await f.render();
  const save = f.bindings.get('#owner-export-policy');
  void save({values: {viewer_downloads: 'on'}});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.posts, [{viewer_downloads: true, confirmed: true}]);
  assert.match(f.confirmations[0].title, /Let viewers download report files/);
  void save({values: {}});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.posts[1], {viewer_downloads: false, confirmed: true});
  assert.match(f.confirmations[1].title, /Stop viewer downloads/);
  const declined = fixture(false, false);
  await declined.render();
  void declined.bindings.get('#owner-export-policy')({values: {viewer_downloads: 'on'}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(declined.confirmations.length, 1);
  assert.deepEqual(declined.posts, []);
});
