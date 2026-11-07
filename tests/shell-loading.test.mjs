// V2-WEB-03 decision 4: loading. A route change keeps the shell and the page's header and shows skeletons where the page
// will be, instead of replacing the page with "Loading this page…". The skeleton is the V2 component, so the shell loads
// the V2 core (the token sheet, the component sheet and the component script) on every signed-in page and nothing more
// of the layer. These tests read the loader, the frame and the sources; the slow-connection cases (the shell stays, focus
// lands, a late answer paints nothing) are the runner's `shell` kind.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {cssDeclarations} from '../tools/check-colours.mjs';

const read = file => fs.readFileSync('web/' + file, 'utf8'),
  catalog = JSON.parse(read('locales/ar.json'));

function shell({components = true, locale = 'en'} = {}) {
  const context = createContext({
      Intl,
      Map,
      Set,
      document: {addEventListener() {}},
      catalog,
      session: {authenticated: true},
    }),
    run = source => new Script(source).runInContext(context);
  run(read('localization.js'));
  run(read('routes.js'));
  run(read('route-assets.js'));
  if (components) run(read('components.js'));
  const app = read('app.js');
  run('function publicAssetUrl(path) { return path; }');
  // header() and the frame: the two functions that draw a page's heading before its page has loaded.
  run(app.slice(app.indexOf('function header('), app.indexOf('function connectionCount(')));
  if (locale === 'ar') run('uiLocale = "ar"; uiMessages = new Map(Object.entries(catalog));');
  return {run, context};
}

test('every signed-in page loads the V2 core, first, and nothing more of the layer; the public pages load none', () => {
  const page = shell({components: false}),
    core = ['tokens-v2.css', 'components.css', 'components.js'],
    layer = /^(?:tokens-v2|components|design-system)/;
  for (const [path, signedIn] of JSON.parse(
    page.run('JSON.stringify(routeRegistry.map(entry => [entry.path, !entry.public]))'),
  )) {
    const files = Array.from(page.run('pageAssetsFor(' + JSON.stringify(path) + ')'));
    if (!signedIn) assert.deepEqual(files, [], path + ' is public and loads no page file');
    else if (path === '/design-system') continue;
    else {
      assert.deepEqual(
        files.filter(file => layer.test(file)),
        core,
        path + ' loads the core and no other file of the layer',
      );
      assert.deepEqual(files.slice(0, 3), core, path + ': the core comes first, so the skeleton can be drawn early');
    }
  }
  // The state page lists the rest of the layer itself, after the core.
  const state = Array.from(page.run("pageAssetsFor('/design-system')"));
  assert.deepEqual(state.slice(0, 3), core);
  assert.ok(state.includes('components-overlays.js') && state.includes('design-system.js'));
  // The core's messages travel with it: the Arabic chunk of components.js loads on every signed-in page.
  for (const path of ['/dashboard', '/connections', '/media'])
    assert.ok(Array.from(page.run('pageLocaleChunks(' + JSON.stringify(path) + ')')).includes('components'), path);
  assert.deepEqual(Array.from(page.run("pageLocaleChunks('/login')")), []);
  // The shell links no V2 file itself: the loader adds them, only where they are used.
  const index = read('index.html');
  assert.doesNotMatch(index, /tokens-v2|components/);
});

test('the frame is the page’s own heading and subtitle, from the registry, over skeletons; nothing says "Loading this page"', () => {
  const page = shell();
  for (const [path, label] of [
    ['/campaigns', 'Campaigns'],
    ['/connections', 'Connections'],
    ['/reports', 'Evidence &amp; analysis'],
  ]) {
    const frame = String(
      page.run('pageFrame(' + JSON.stringify(path) + ', uiText(routeLabel(' + JSON.stringify(path) + ')))'),
    );
    const subtitle = page.run('uiText(routeSubtitle(' + JSON.stringify(path) + '))');
    assert.ok(
      frame.startsWith('<div class="page-heading"><div><h1>' + label + '</h1><p>' + subtitle + '</p></div></div>'),
      path,
    );
    // One busy status the reader hears once (the blocks after the first are decoration, hidden from assistive
    // technology), and skeleton blocks where the sections will be.
    const heard = frame.replace(/<div aria-hidden="true">[\s\S]*?<\/div><\/div>/, '');
    assert.equal((heard.match(/role="status" aria-busy="true"/g) ?? []).length, 1, path + ': one status, heard once');
    assert.ok((frame.match(/class="amcp-skeleton"/g) ?? []).length >= 2, path + ': blocks for the sections');
    assert.ok(frame.includes('id="route-loading"'), 'the benchmark and the cases look for the frame by this id');
    assert.ok(!frame.includes('Loading this page'));
  }
  // Before the core has downloaded (the first page of a visit) the frame still keeps the heading, and says so in words.
  const early = shell({components: false}),
    frame = String(early.run("pageFrame('/campaigns', 'Campaigns')"));
  assert.ok(frame.includes('<h1>Campaigns</h1>') && frame.includes('id="route-loading"'));
  assert.ok(frame.includes('role="status" aria-busy="true"') && frame.includes('Opening your workspace…'));
  // In Arabic the same frame reads in Arabic.
  const arabic = shell({locale: 'ar'});
  assert.match(String(arabic.run("pageFrame('/campaigns', uiText('Campaigns'))")), /الحملات/);
  // A page the registry does not know has a heading and no subtitle, never an empty paragraph.
  assert.doesNotMatch(String(page.run("pageFrame('/unknown-page', 'Unknown page')")), /<p>/);
});

test('the shell keeps no copy of the old loading panel, and a route change draws the frame', () => {
  const app = read('app.js');
  assert.ok(!app.includes('Loading this page…'), 'the sentence is gone from the shell');
  assert.ok(/setHtml\(content, pageFrame\(/.test(app));
  // The same frame is what the first page of a visit shows while its files download.
  assert.ok(
    /if \(pending \|\| \(routeChanged && page && !page\.public\)\) \{\s+setHtml\(content, pageFrame\(/.test(app),
  );
  const frame = cssDeclarations(read('app.css')).filter(d => d.selector === '.page-frame');
  assert.deepEqual(
    frame.map(d => d.property + ': ' + d.value),
    ['display: grid', 'gap: 16px'],
  );
});
