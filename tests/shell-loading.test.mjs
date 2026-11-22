// V2-WEB-03 decision 4: loading. A route change keeps the shell and the page's header and shows skeleton blocks where the
// page will be, instead of replacing the page with "Loading this page…". The blocks are the shell's own few lines of CSS: the
// V2 component layer is not loaded for them (see the first test). These tests read the loader, the frame and the sources;
// the slow-connection cases (the shell stays, focus lands, a late answer paints nothing) are the runner's `shell` kind.
// always-run: lists web/ for the scripts, styles and pages the shell loads
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {cssDeclarations} from '../tools/check-colours.mjs';
import {dashboard, deferred, feed, homePage, tick} from './fixtures/shell-home.mjs';

const read = file => fs.readFileSync('web/' + file, 'utf8'),
  catalog = JSON.parse(read('locales/ar.json'));

function shell({locale = 'en'} = {}) {
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
  // The shell's helpers before workspaceCall: skeletonBlocks and emptyBlock.
  const workspace = read('workspace.js');
  run(workspace.slice(0, workspace.indexOf('async function workspaceCall(')));
  const app = read('app.js');
  run('function publicAssetUrl(path) { return path; }');
  // header() and the frame: the two functions that draw a page's heading before its page has loaded.
  run(app.slice(app.indexOf('function header('), app.indexOf('function connectionCount(')));
  if (locale === 'ar') run('uiLocale = "ar"; uiMessages = new Map(Object.entries(catalog));');
  return {run, context};
}

// V2-WEB-03: the shell's frame and states are its own. The V2 core on every signed-in route (tokens-v2.css 2,590 +
// components.css 3,863 + components.js 6,740 = 13,193 Brotli bytes) was tried and backed out: it is more than the 10 KB the
// lead set for the shell alone, the lead's ruling is not to load a component file for one small use, and it breaks the WEB-07
// guard in tests/web-route-bytes.test.mjs (en /connections must stay under 95% of its pre-WEB-07 bytes; it measured 97.9%).
// Loading it again is one constant in web/route-assets.js and the baselines (docs/DESIGN-SYSTEM.md, "The shell").
test('the shell loads none of the V2 layer: only the state page does, the loader is as it was, no shell script calls AmcpUI', () => {
  const page = shell(),
    layer = /^(?:tokens-v2|components|design-system)/;
  for (const path of JSON.parse(page.run('JSON.stringify(routeRegistry.map(entry => entry.path))'))) {
    const files = Array.from(page.run('pageAssetsFor(' + JSON.stringify(path) + ')'));
    if (path === '/design-system') continue;
    // Merge C: the report builder is the one other page that lists the layer itself, through its charts script (package
    // charts, V2-EXP-01: the colours and the table behind each chart); the shell still loads none of it for any route.
    if (path === '/reporting-overview') {
      assert.ok(files.includes('charts.js'), path + ' uses the layer only through its charts script');
      continue;
    }
    assert.deepEqual(
      files.filter(file => layer.test(file)),
      [],
      path + ' loads none of the V2 layer; a page that uses it lists it itself',
    );
  }
  assert.doesNotMatch(read('index.html'), /tokens-v2|components/);
  for (const name of [
    'app.js',
    'workspace.js',
    'identity.js',
    'work-center.js',
    'routes.js',
    'route-assets.js',
    'localization.js',
  ])
    assert.ok(!/AmcpUI/.test(read(name)), name + ' draws no V2 component: it would need the layer on every route');
});

test('the frame is the page’s own heading and subtitle, from the registry, over skeleton blocks; nothing says "Loading this page"', () => {
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
    // One busy status the reader hears once, saying Loading…; the blocks are decoration, hidden from assistive technology.
    assert.equal((frame.match(/role="status" aria-busy="true"/g) ?? []).length, 1, path + ': one status, heard once');
    assert.equal((frame.match(/class="skeleton-label">Loading…</g) ?? []).length, 1, path);
    const blocks = frame.match(/<span class="skeleton-block"[^>]*>/g) ?? [];
    assert.equal(blocks.length, 5, path + ': a card and four lines where the sections will be');
    assert.ok(
      blocks.every(block => block.includes('aria-hidden="true"')),
      path + ': blocks are decoration',
    );
    assert.ok(frame.includes('id="route-loading"'), 'the benchmark and the cases look for the frame by this id');
    assert.ok(!frame.includes('Loading this page'));
  }
  // In Arabic the same frame reads in Arabic.
  const arabic = shell({locale: 'ar'});
  assert.match(String(arabic.run("pageFrame('/campaigns', uiText('Campaigns'))")), /الحملات/);
  assert.ok(String(arabic.run("pageFrame('/campaigns', 'x')")).includes('>' + catalog['Loading…'] + '<'));
  // A page the registry does not know has a heading and no subtitle, never an empty paragraph.
  assert.doesNotMatch(String(page.run("pageFrame('/unknown-page', 'Unknown page')")), /<p>/);
});

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
      /<div id="home-attention" aria-busy="true"><div class="work-links"><div class="skeleton" id="home-attention-loading"/,
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
  assert.doesNotMatch(page.content.innerHTML, /aria-busy|skeleton/, 'an answer that is here needs no skeleton');
  assert.match(page.content.innerHTML, /href="\/campaigns\?id=plan"/);
  // The panel's skeleton says Loading… once, in the page's language.
  for (const [locale, loading] of [
    ['en', 'Loading…'],
    ['ar', catalog['Loading…']],
  ]) {
    const early = homePage({locale});
    early.context.d = {campaigns: [], connections: [], writes_paused: null};
    const markup = early.run('workHome(d, [{}], {pending: true})');
    assert.ok(markup.includes('<span class="skeleton-label">' + loading + '</span>'), locale);
    assert.equal((markup.match(/role="status"/g) ?? []).length, 1, locale + ': one status');
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
  assert.ok(/if \(pending \|\| \(routeChanged && page && !page\.public\)\)\s+setHtml\(content, pageFrame\(/.test(app));
  // The blocks are still: no motion to turn off under reduced motion, no colour of their own (a token), logical sizes.
  const rules = cssDeclarations(read('app.css')).filter(d => /^\.skeleton/.test(d.selector));
  assert.ok(rules.length >= 8 && rules.length <= 20, 'a few lines of CSS, not a component: ' + rules.length);
  assert.ok(!rules.some(d => /animation|transition/.test(d.property)), 'no motion');
  assert.ok(!rules.some(d => /#[0-9a-f]{3,8}\b|rgb|hsl/i.test(d.value)), 'no literal colour');
  assert.ok(!rules.some(d => /^(?:width|height|left|right|top|bottom)$/.test(d.property)), 'logical properties only');
  assert.equal(
    rules.find(d => d.selector === '.skeleton-block' && d.property === 'background')?.value,
    'var(--surface-accent)',
  );
});
