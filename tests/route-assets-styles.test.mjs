// V2-WEB-02: a page's stylesheets are page assets. A registry entry lists them among its `assets`; the loader requests
// them with the page's scripts (the route renders only after both are ready), places the link before accessibility.css,
// which stays the last stylesheet, keeps them out of the Arabic catalog chunks (only scripts carry messages), and the
// route byte tool counts them, so a stylesheet cannot reach a page without its bytes measured against the page's budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Script, createContext} from 'node:vm';
import {loaderFiles} from '../tools/locale-chunks.mjs';
import {documentScripts} from '../tools/check-extensions.mjs';
import {routeBytes} from '../tools/web-route-bytes.mjs';

const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
/** The real loader over the real registry plus one test page that has a stylesheet and a script. */
function fixture() {
  const created = [],
    appended = [],
    inserted = [],
    timers = new Map();
  let timerId = 0;
  const accessibility = {href: '/assets/accessibility.css'},
    context = createContext({
      URL,
      Map,
      Set,
      Promise,
      location: {href: 'https://amcp.invalid/styled', origin: 'https://amcp.invalid'},
      uiText: text => text,
      setTimeout: callback => {
        timers.set(++timerId, callback);
        return timerId;
      },
      clearTimeout: id => timers.delete(id),
      window: {addEventListener() {}, removeEventListener() {}},
      document: {
        createElement(tag) {
          const element = {
            tag,
            remove() {
              this.removed = true;
            },
          };
          created.push(element);
          return element;
        },
        head: {
          append(element) {
            appended.push(element);
          },
          insertBefore(element, before) {
            inserted.push({element, before});
          },
          querySelector(selector) {
            return selector.includes('accessibility.css') ? accessibility : null;
          },
        },
      },
    }),
    run = text => new Script(text).runInContext(context);
  run(fs.readFileSync('web/routes.js', 'utf8'));
  run("routeRegistry.push({path: '/styled', label: 'Styled', assets: ['components.css', 'help.js']})");
  // components.css is in the loader's real list (V2-WEB-02), so the test page uses the shipped file name.
  run(fs.readFileSync('web/route-assets.js', 'utf8'));
  return {
    run,
    created,
    appended,
    inserted,
    timers,
    accessibility,
    load: p => run(`ensurePageAssets(${JSON.stringify(p)})`),
  };
}

test('a page lists its stylesheets among its assets, and its Arabic chunks ignore them', () => {
  const f = fixture();
  assert.deepEqual(Array.from(f.run("pageAssetsFor('/styled')")), ['components.css', 'help.js']);
  // `providers` is no page's before it renders (r25-ar-lazy): an answer that carries a refusal loads it.
  assert.deepEqual(Array.from(f.run("pageLocaleChunks('/styled')")), ['workspace', 'help']);
  assert.equal(f.run("pageAssetsPending('/styled')"), true);
});

test('the loader inserts a stylesheet link before accessibility.css and the page waits for it and its script', async () => {
  const f = fixture(),
    loading = f.load('/styled');
  await tick();
  assert.equal(f.created.length, 2);
  const [link, script] = f.created;
  assert.equal(link.tag, 'link');
  assert.equal(link.rel, 'stylesheet');
  assert.equal(link.href, '/assets/components.css');
  assert.equal(f.inserted.length, 1);
  assert.equal(f.inserted[0].element, link);
  assert.equal(f.inserted[0].before, f.accessibility, 'accessibility.css stays the last stylesheet');
  assert.equal(script.tag, 'script');
  assert.equal(script.src, '/assets/help.js');
  assert.equal(script.async, false);
  assert.deepEqual(f.appended, [script], 'only the script is appended; the link is inserted');
  let settled = false;
  loading.then(() => (settled = true));
  script.onload();
  await tick();
  assert.equal(settled, false, 'the page is not ready while its stylesheet is still downloading');
  link.onload();
  await loading;
  assert.equal(f.run("pageAssetsPending('/styled')"), false);
  await f.load('/styled');
  assert.equal(f.created.length, 2, 'a revisit requests nothing again');
  assert.equal(f.timers.size, 0);
});

test('a stylesheet that fails to download is removed and retried alone', async () => {
  const f = fixture(),
    first = f.load('/styled'),
    rejected = assert.rejects(first, e => e.code === 'PAGE_ASSET_UNAVAILABLE');
  await tick();
  const [link, script] = f.created;
  link.onerror();
  await rejected;
  assert.equal(link.removed, true);
  const retry = f.load('/styled');
  await tick();
  assert.deepEqual(
    f.created.map(element => element.tag + ' ' + (element.href ?? element.src)),
    ['link /assets/components.css', 'script /assets/help.js', 'link /assets/components.css'],
    'only the failed stylesheet is requested again',
  );
  script.onload();
  f.created[2].onload();
  await retry;
});

test('the catalog and extension tools treat a stylesheet in the loader list as a stylesheet, not a script', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-style-tools-')),
    web = path.join(root, 'web');
  try {
    fs.mkdirSync(web);
    fs.writeFileSync(
      path.join(web, 'routes.js'),
      "const routeRegistry = [{path: '/styled', label: 'Styled', assets: ['styled.css', 'styled.js']}];\n",
    );
    fs.writeFileSync(
      path.join(web, 'route-assets.js'),
      "const pageAssetOrder = ['styled.css', 'styled.js'];\nconst pageAssetDependencies = {'styled.js': ['styled.css']};\n",
    );
    fs.writeFileSync(path.join(web, 'index.html'), '<script src="/assets/app.js" defer></script>');
    fs.writeFileSync(path.join(web, 'styled.css'), '.styled { color: red; }\n');
    fs.writeFileSync(path.join(web, 'styled.js'), "'use strict';\n");
    assert.deepEqual(loaderFiles(root).modules, ['styled.js']);
    assert.deepEqual(documentScripts(root)['index.html'], ['app.js', 'styled.js']);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('the route byte tool counts a route’s stylesheets with its scripts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-style-bytes-')),
    web = path.join(root, 'web');
  try {
    fs.mkdirSync(web);
    fs.copyFileSync(path.join('web', 'route-assets.js'), path.join(web, 'route-assets.js'));
    // A registry of two pages: the loader needs only the entries and routeEntry.
    fs.writeFileSync(
      path.join(web, 'routes.js'),
      "const routeRegistry = [{path: '/styled', label: 'Styled', assets: ['styled.css', 'help.js']}, {path: '/connections', label: 'Connections'}];\n" +
        'function routeEntry(path) { return routeRegistry.find(entry => entry.path === path); }\n',
    );
    fs.writeFileSync(
      path.join(web, 'route-assets.js'),
      fs
        .readFileSync(path.join('web', 'route-assets.js'), 'utf8')
        .replace('const pageAssetOrder = [\n', "const pageAssetOrder = [\n  'styled.css',\n"),
    );
    fs.writeFileSync(path.join(web, 'index.html'), '<link rel="stylesheet" href="/assets/tokens.css">');
    fs.writeFileSync(path.join(web, 'about.html'), '<link rel="stylesheet" href="/assets/tokens.css">');
    fs.mkdirSync(path.join(web, 'locales'));
    fs.writeFileSync(path.join(web, 'locales', 'ar.json'), '{}');
    fs.writeFileSync(path.join(web, 'tokens.css'), ':root{--a:1}');
    fs.writeFileSync(path.join(web, 'help.js'), "'use strict';");
    fs.writeFileSync(path.join(web, 'styled.css'), '.styled { color: red; }\n'.repeat(200));
    const bytes = routeBytes(root);
    assert.equal(bytes['en /styled'].files, 3, 'tokens.css, styled.css and help.js');
    assert.ok(bytes['en /styled'].bytes > bytes['en /connections'].bytes, 'the stylesheet adds to its page only');
    assert.equal(bytes['en /connections'].files, 1);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
