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

const tick = () => new Promise(resolve => setTimeout(resolve, 0)),
  deferred = () => {
    let resolve, reject;
    const promise = new Promise((done, fail) => ((resolve = done), (reject = fail)));
    return {promise, resolve, reject};
  };

/** Home's scripts in a page whose attention panel is a slot we can watch (the fake DOM keeps `content` as a string). */
function homePage({components = true, locale = 'en'} = {}) {
  const content = {innerHTML: ''},
    slot = {
      isConnected: true,
      innerHTML: '',
      busy: true,
      removeAttribute(name) {
        if (name === 'aria-busy') this.busy = false;
      },
    },
    context = createContext({
      URL,
      URLSearchParams,
      Intl,
      Map,
      Set,
      content,
      catalog,
      document: {addEventListener() {}, querySelector: () => null, querySelectorAll: () => []},
      $: selector => (selector === '#home-attention' ? slot : null),
      esc: value =>
        String(value ?? '').replace(
          /[&<>"']/g,
          c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c],
        ),
      date: value => 'at ' + value,
      header: (title, description, action) => `<h1>${title}</h1><p>${description}</p>${action}`,
      glyph: () => '',
      session: {name: 'Synthetic Person'},
      workspaceBind() {},
      navigationGeneration: 1,
      identityGeneration: 1,
    }),
    run = source => new Script(source).runInContext(context);
  for (const file of ['localization.js', 'routes.js', 'workspace.js', 'work-center.js']) run(read(file));
  if (components) run(read('components.js'));
  if (locale === 'ar') run('uiLocale = "ar"; uiMessages = new Map(Object.entries(catalog));');
  run(
    'globalThis.draw = value => html`<p>${value}</p>`; globalThis.failed = error => html`<p class="error">${error.message}</p>`;',
  );
  return {run, context, content, slot};
}
const dashboard = {
    connections: [],
    campaigns: [],
    writes_paused: null,
    capabilities: {meaning: 'Meaning', features: [], evidence: []},
  },
  feed = {
    operations: [
      {kind: 'campaign', name: 'Launch', state: 'attention', website_path: '/campaigns?id=plan', updated_at: 5},
    ],
    has_more: false,
  };

test('a section fills with its answer, a failure stays in its own slot, and a late answer paints nothing', async () => {
  // The answer.
  let page = homePage();
  page.context.data = Promise.resolve('Fresh');
  assert.equal(await page.run('fillSection($("#home-attention"), data, draw, failed)'), true);
  assert.equal(page.slot.innerHTML, '<p>Fresh</p>');
  assert.equal(page.slot.busy, false, 'the slot is no longer busy');
  // The failure: this slot only, as the caller words it; nothing is thrown at the page.
  page = homePage();
  page.context.data = Promise.reject(Error('offline'));
  assert.equal(await page.run('fillSection($("#home-attention"), data, draw, failed)'), false);
  assert.equal(page.slot.innerHTML, '<p class="error">offline</p>');
  assert.equal(page.slot.busy, false);
  // A draw that throws is a failure of the section too, not an unhandled rejection of the page.
  page = homePage();
  page.context.data = Promise.resolve('x');
  page.run('globalThis.explode = () => { throw Error("bad markup"); }');
  assert.equal(await page.run('fillSection($("#home-attention"), data, explode, failed)'), false);
  assert.equal(page.slot.innerHTML, '<p class="error">bad markup</p>');
  // Late: the person left the route, signed out or asked for a newer draw (which replaces the slot); a superseded request
  // is its newer request's to draw.
  for (const late of ['route', 'identity', 'replaced', 'superseded']) {
    page = homePage();
    const answer = deferred();
    page.context.data = answer.promise;
    const filling = page.run('fillSection($("#home-attention"), data, draw, failed)');
    if (late === 'route') page.context.navigationGeneration = 2;
    if (late === 'identity') page.context.identityGeneration = 2;
    if (late === 'replaced') page.slot.isConnected = false;
    if (late === 'superseded') answer.reject(Object.assign(Error('newer request'), {code: 'REQUEST_SUPERSEDED'}));
    else answer.resolve('Stale');
    assert.equal(await filling, false, late);
    assert.equal(page.slot.innerHTML, '', late + ': nothing painted');
    assert.equal(page.slot.busy, true, late + ': the slot is left as it was');
  }
});

test('Home does not wait for the attention feed: it draws with a skeleton in that panel, then fills it', async () => {
  for (const outcome of ['answer', 'failure']) {
    const page = homePage(),
      late = deferred();
    page.context.workspaceCall = async (_tool, args) => (args.action === 'dashboard' ? dashboard : late.promise);
    await page.run('renderOverview()');
    // Drawn without the feed: the panel is busy with one skeleton, and every other panel is complete.
    const html = page.content.innerHTML;
    assert.match(
      html,
      /<div id="home-attention" aria-busy="true"><div class="work-links"><div class="amcp-skeleton-group"/,
      outcome,
    );
    assert.equal((html.match(/id="home-attention"/g) ?? []).length, 1);
    for (const panel of ['Needs attention', 'Continue recent work', 'Account readiness', 'Capabilities and evidence'])
      assert.ok(html.includes('<h2>' + panel + '</h2>'), outcome + ': ' + panel);
    assert.equal(page.slot.innerHTML, '', 'nothing is painted before the answer');
    if (outcome === 'answer') late.resolve(feed);
    else late.reject(Object.assign(Error('offline'), {code: 'NETWORK'}));
    await tick();
    assert.equal(page.slot.busy, false, outcome);
    if (outcome === 'answer') {
      assert.match(
        page.slot.innerHTML,
        /<a href="\/campaigns\?id=plan"><strong dir="auto" data-native>Launch<\/strong>/,
      );
      assert.match(page.slot.innerHTML, /The most recent work that needs attention\./);
    } else {
      // This panel says so; the rest of Home stays as it was drawn (the failure never reaches the page).
      assert.match(
        page.slot.innerHTML,
        /role="alert">Could not load the work that needs attention\. Open Operations to see it\./,
      );
      assert.ok(page.content.innerHTML.includes('<h2>Account readiness</h2>'));
    }
  }
});

test('Home keeps drawing the feed in the same pass when it has arrived, and reads in Arabic while it is on its way', async () => {
  const page = homePage();
  page.context.workspaceCall = async (_tool, args) => (args.action === 'dashboard' ? dashboard : feed);
  await page.run('renderOverview()');
  assert.doesNotMatch(page.content.innerHTML, /aria-busy|amcp-skeleton/, 'an answer that is here needs no skeleton');
  assert.match(page.content.innerHTML, /href="\/campaigns\?id=plan"/);
  // Before the component script has downloaded the panel still says it is loading, in words; in Arabic as well.
  for (const [locale, loading] of [
    ['en', 'Loading…'],
    ['ar', catalog['Loading…']],
  ]) {
    const early = homePage({components: false, locale});
    early.context.d = {campaigns: [], connections: [], writes_paused: null};
    const markup = early.run('workHome(d, [{}], {pending: true})');
    assert.ok(
      markup.includes(
        '<div id="home-attention" aria-busy="true"><div class="work-links"><p class="muted" role="status">' +
          loading +
          '</p>',
      ),
      locale,
    );
  }
  assert.ok(catalog['Loading…'], 'the Arabic entry exists');
});

// V2-WEB-03 decision 4, "view transitions only where they help, and never under reduced motion": none helps here. A route
// change draws in two phases (the frame at once, then the page when its files and data have arrived), so a transition would
// snapshot the frame and cross-fade to a page that is not there yet, or hold the new page until the transition's bound; the
// frame already keeps the shell and the header still. The sidebar and drawer motion is CSS, and reduced motion removes it.
test('the shell uses no view transition, and reduced motion removes every transition and animation', () => {
  for (const file of fs.readdirSync('web').filter(name => /\.(?:js|css|html)$/.test(name)))
    assert.doesNotMatch(
      read(file),
      /startViewTransition|@view-transition|view-transition-name/,
      file + ': a view transition needs its own reduced-motion guard and a case that shows it helps',
    );
  const off = property =>
    cssDeclarations(read('identity.css')).some(
      d =>
        d.selector === '*' &&
        d.property === property &&
        d.value.startsWith('none') &&
        d.atRules.some(rule => rule.includes('prefers-reduced-motion: reduce')),
    );
  assert.ok(off('transition'), 'identity.css switches transitions off under reduced motion');
  assert.ok(off('animation'), 'identity.css switches animations off under reduced motion');
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
