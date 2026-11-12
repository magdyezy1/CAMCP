import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {gzipSync, brotliCompressSync} from 'node:zlib';

const source = () => (fs.existsSync('web/route-assets.js') ? fs.readFileSync('web/route-assets.js', 'utf8') : '');
const scripts = () =>
  [...fs.readFileSync('web/index.html', 'utf8').matchAll(/<script src="\/assets\/([^"]+)" defer><\/script>/g)].map(
    m => m[1],
  );
function fixture() {
  const appended = [],
    listeners = new Map(),
    timers = new Map();
  let timerId = 0;
  const context = createContext({
    URL,
    Map,
    Set,
    Promise,
    location: {href: 'https://amcp.invalid/dashboard', origin: 'https://amcp.invalid'},
    uiText: x => x,
    setTimeout: callback => {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout: id => timers.delete(id),
    window: {
      addEventListener(name, callback) {
        const set = listeners.get(name) ?? new Set();
        set.add(callback);
        listeners.set(name, set);
      },
      removeEventListener(name, callback) {
        listeners.get(name)?.delete(callback);
      },
    },
    document: {
      createElement(tag) {
        // V2-WEB-02: a page's stylesheets are created as links (tests/route-assets-styles.test.mjs).
        assert.ok(tag === 'script' || tag === 'link', tag);
        return {
          remove() {
            this.removed = true;
          },
        };
      },
      head: {
        append(script) {
          appended.push(script);
        },
        insertBefore(link) {
          appended.push(link);
        },
        querySelector() {
          return null;
        },
      },
    },
  });
  const run = text => new Script(text).runInContext(context);
  // Each page's assets are its route registry entry's (WEB-07), so the registry loads first, as in index.html.
  run(fs.readFileSync('web/routes.js', 'utf8'));
  run(source());
  return {
    context,
    run,
    appended,
    listeners,
    timers,
    load: path => run(`ensurePageAssets(${JSON.stringify(path)})`),
    pending: path => run(`pageAssetsPending(${JSON.stringify(path)})`),
  };
}
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

test('the initial document loads only shared scripts and the fixed route loader', () => {
  assert.deepEqual(scripts(), [
    'localization.js',
    // WEB-06: the route registry the shell scripts read.
    'routes.js',
    'app.js',
    'identity.js',
    'workspace.js',
    'account-security.js',
    // WEB-07 (regression): the report builder's script (reporting-overview.js, 23 KB compressed) was part of every page,
    // the landing and sign-in pages included; it now loads with /reporting-overview and the modules that use it.
    'route-assets.js',
    'account-scope.js',
  ]);
  assert.deepEqual(
    Array.from(fixture().run("pageAssetsFor('/reporting-overview')")).filter(file => file === 'reporting-overview.js'),
    ['reporting-overview.js'],
  );
  const baseline = fs.readdirSync('web', {recursive: true}).filter(f => f.endsWith('.js') && f !== 'route-assets.js');
  const bytes = files => files.reduce((n, f) => n + fs.readFileSync('web/' + f).length, 0);
  assert.ok(bytes(scripts()) < bytes(baseline) * 0.36);
  for (const compress of [gzipSync, brotliCompressSync]) {
    const size = files => files.reduce((n, f) => n + compress(fs.readFileSync('web/' + f)).length, 0);
    assert.ok(size(scripts()) < size(baseline) * 0.45);
  }
});

test('public and connection routes need no feature request; unknown input cannot become an asset URL', async () => {
  const f = fixture();
  for (const route of [
    '/',
    '/login',
    '/signup',
    '/forgot-password',
    '/reset-password',
    '/verify-email',
    '/connections',
    '/activity',
    '/connectors',
    '/terms',
    '/data-deletion',
    '/oauth/consent',
    '/oauth/result',
    '/auth/complete',
    'https://evil.invalid/a.js',
    '/__proto__',
    '/constructor',
    '/media?x=1',
  ]) {
    assert.equal(f.pending(route), false);
    await f.load(route);
  }
  assert.equal(f.appended.length, 0);
});

test('concurrent page loads share exact same-origin scripts and revisit without fetching again', async () => {
  const f = fixture(),
    first = f.load('/campaigns'),
    second = f.load('/profiles');
  await tick();
  assert.deepEqual(
    f.appended.map(s => s.src),
    ['/assets/campaign-recipes.js', '/assets/campaign-workflows.js', '/assets/client-playbooks.js'],
  );
  for (const script of f.appended) {
    assert.equal(script.async, false);
    script.onload();
  }
  await Promise.all([first, second]);
  assert.equal(f.pending('/campaigns'), false);
  assert.equal(f.pending('/profiles'), false);
  await f.load('/profiles');
  assert.equal(f.appended.length, 3);
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.get('error')?.size ?? 0, 0);
});

// WEB-07: account-approvals.js used to capture owner-operations.js's renderSettings wrapper while it initialized, so the
// loader had to wait for one file before requesting the other. Both now register parts of /settings with a declared
// order (tests/web-extensions.test.mjs), so the page's files are requested together and a failed one is retried alone.
test('failed downloads are retryable and settings parts no longer wait for each other to load', async () => {
  const f = fixture(),
    first = f.load('/settings');
  const rejected = assert.rejects(first, e => e.code === 'PAGE_ASSET_UNAVAILABLE');
  await tick();
  assert.deepEqual(
    f.appended.map(s => s.src),
    ['/assets/owner-operations.js', '/assets/account-approvals.js'],
  );
  f.appended[0].onerror();
  await rejected;
  assert.equal(f.appended[0].removed, true);
  const retry = f.load('/settings');
  await tick();
  assert.deepEqual(
    f.appended.map(s => s.src),
    ['/assets/owner-operations.js', '/assets/account-approvals.js', '/assets/owner-operations.js'],
    'Only the failed file is requested again',
  );
  f.appended[1].onload();
  f.appended[2].onload();
  await retry;
  await f.load('/settings');
  assert.equal(f.appended.length, 3);
  assert.equal(f.timers.size, 0);
});

test('uncertain timeout or partial evaluation requires a full reload and never reinserts a script', async () => {
  for (const mode of ['timeout', 'evaluation']) {
    const f = fixture(),
      first = f.load('/account');
    const rejected = assert.rejects(first, e => e.code === 'PAGE_ASSET_RELOAD_REQUIRED');
    await tick();
    if (mode === 'timeout') [...f.timers.values()][0]();
    else
      for (const listener of [...f.listeners.get('error')])
        listener({filename: 'https://amcp.invalid/assets/vendor/qrcode-generator-2.0.4.js'});
    await rejected;
    const count = f.appended.length;
    await assert.rejects(f.load('/account'), e => e.code === 'PAGE_ASSET_RELOAD_REQUIRED');
    assert.equal(f.appended.length, count);
    f.appended[0].onload?.();
    await assert.rejects(f.load('/account'), e => e.code === 'PAGE_ASSET_RELOAD_REQUIRED');
  }
});

test('every route dependency is local, shipped, and initialized once, including QR and reporting helpers', async () => {
  const f = fixture();
  const paths = [
    '/dashboard',
    '/campaigns',
    '/profiles',
    '/media',
    '/reports',
    '/reporting-overview',
    '/report-library',
    '/report-pack',
    '/operations',
    '/monitors',
    '/capabilities',
    '/portfolio',
    '/measurement',
    '/commerce',
    '/schedules',
    '/settings',
    '/account',
    // DOC-03: the members-only Help page's own module.
    '/help',
    // V2-WEB-02: the component state page, whose stylesheets load as page assets too.
    '/design-system',
  ];
  const all = Promise.all(paths.map(path => f.load(path)));
  const finished = new Set();
  for (let i = 0; i < 10; i++) {
    await tick();
    for (const script of f.appended)
      if (!finished.has(script)) {
        const url = script.src ?? script.href;
        assert.match(url, /^\/assets\/(?:[a-z][a-z0-9-]*\.(?:js|css)|vendor\/qrcode-generator-2\.0\.4\.js)$/);
        assert.equal(fs.existsSync('web/' + url.slice(8)), true);
        finished.add(script);
        script.onload();
      }
  }
  await all;
  assert(
    !f.appended.some(script => script.src?.endsWith('/report-delivery.js')),
    'Delivery stays deferred on cold routes',
  );
  const delivery = f.run("loadPageAsset('report-delivery.js')");
  await tick();
  const script = f.appended.find(script => script.src?.endsWith('/report-delivery.js'));
  assert(script, 'Explicit delivery loads its shipped module');
  script.onload();
  await delivery;
  await f.run("loadPageAsset('report-delivery.js')");
  const requested = f.appended.map(s => (s.src ?? s.href).slice(8));
  assert.equal(new Set(requested).size, requested.length);
  // The scripts are compared with the shipped ones below; a stylesheet is not a script.
  const loaded = requested.filter(file => file.endsWith('.js'));
  const publicScripts = new Set(
    fs
      .readdirSync('web')
      .filter(file => file.endsWith('.html') && file !== 'index.html')
      .flatMap(file =>
        [...fs.readFileSync('web/' + file, 'utf8').matchAll(/<script src="\/assets\/([^"]+)"(?: defer)?>/g)].map(
          match => match[1],
        ),
      ),
  );
  const expected = fs
    .readdirSync('web', {recursive: true})
    .filter(f => f.endsWith('.js') && !scripts().includes(f) && !publicScripts.has(f))
    .map(f => f.replaceAll('\\', '/'))
    .sort();
  assert.deepEqual([...loaded].sort(), expected);
  assert.ok(loaded.includes('mfa-qr.js'));
  assert.ok(loaded.indexOf('owner-operations.js') < loaded.indexOf('account-approvals.js'));
  assert.equal(f.timers.size, 0);
});

// Regression (WEB-07): Live portfolio, Measurement and Commerce all loaded account-workflows.js (388 KB: the three pages
// and the parked WooCommerce source) and campaign-workflows.js. Each page now loads its own module over a small shared
// helper, and the parked store source is a module of its own behind the Commerce page.
test('each account workflow page loads only its own module, the shared helper and what it uses', () => {
  const f = fixture(),
    files = path => Array.from(f.run(`pageAssetsFor(${JSON.stringify(path)})`));
  assert.deepEqual(files('/portfolio'), ['account-workflows.js', 'portfolio.js']);
  assert.deepEqual(files('/commerce'), ['account-workflows.js', 'commerce-woocommerce.js', 'commerce.js']);
  assert.deepEqual(files('/measurement'), [
    'campaign-workflows.js',
    'measurement-trace-import.js',
    'account-workflows.js',
    'measurement.js',
  ]);
  const read = file => fs.readFileSync('web/' + file, 'utf8'),
    declared = file => [...read(file).matchAll(/^(?:async )?function ([A-Za-z0-9_$]+)/gm)].map(match => match[1]);
  assert.ok(Buffer.byteLength(read('account-workflows.js')) < 32768, 'The shared helper stays small');
  // Every WooCommerce function lives in the store source's module; the Commerce page only renders its panels.
  const woo = name => /^(?:bindWooCommerce|wooCommerce|wooConnection)/.test(name);
  assert.ok(declared('commerce-woocommerce.js').filter(woo).length >= 12);
  for (const file of ['account-workflows.js', 'portfolio.js', 'measurement.js', 'commerce.js'])
    assert.deepEqual(declared(file).filter(woo), [], file);
  // A page module renders only its own page.
  for (const [file, page] of [
    ['portfolio.js', 'renderPortfolio'],
    ['measurement.js', 'renderMeasurement'],
    ['commerce.js', 'renderCommerce'],
  ])
    assert.deepEqual(
      declared(file).filter(name => /^render(?:Portfolio|Measurement|Commerce)$/.test(name)),
      [page],
      file,
    );
});

// Regression (WEB-07): Creative, Capabilities, Evidence & analysis and the report pack loaded the whole Operations
// center and its three workbook controllers (about 110 KB) for one paged-list loader. They now load web/work-pages.js.
test('a page that lists work loads the paged-list loader, not the Operations center and its workbooks', () => {
  const f = fixture(),
    files = path => Array.from(f.run(`pageAssetsFor(${JSON.stringify(path)})`)),
    operations = ['operations-center.js', 'workbook-schedules.js', 'workbook-bindings.js', 'workbook-rebinding.js'];
  for (const path of ['/media', '/capabilities', '/reports', '/report-pack']) {
    assert.ok(files(path).includes('work-pages.js'), path);
    assert.deepEqual(
      files(path).filter(file => operations.includes(file)),
      [],
      path,
    );
  }
  for (const path of ['/operations', '/monitors'])
    assert.deepEqual(
      files(path).filter(f => operations.includes(f)),
      operations,
    );
  // The loader is declared once, in its own module.
  for (const file of fs.readdirSync('web').filter(file => file.endsWith('.js')))
    assert.equal(
      /^function workPageLoader\(/m.test(fs.readFileSync('web/' + file, 'utf8')),
      file === 'work-pages.js',
      file,
    );
});

test('each cold route initializes its real scripts and required handlers in English and Arabic without API traffic', async () => {
  const routes = {
    '/': ['renderLanding'],
    '/login': ['renderAuthPage', 'signInComplete'],
    '/dashboard': ['renderOverview', 'workHome'],
    '/campaigns': ['renderCampaigns', 'mountRecipeBuilder', 'mountCampaignClone', 'bindCampaignWorkflow'],
    '/media': [
      'renderMediaLibrary',
      'bindCreativePush',
      'bindCreativeLibrary',
      'bindAdPreviews',
      'readableReview',
      'workPageLoader',
    ],
    '/reports': [
      'renderDecisionReports',
      'mountCaptureWizard',
      'mountSearchExclusions',
      'mountEvidenceDownload',
      'mountReferenceImport',
      'mountScenarioModel',
      'mountAllocationModel',
    ],
    '/reporting-overview': [
      'renderReportingOverview',
      'openReportDelivery',
      'overviewGranularityFields',
      'overviewGranularityConfig',
      'bindSnapshotAnalysis',
      'refreshRecentReports',
    ],
    '/report-library': ['renderReportLibraryPage', 'selectOverviewDefinition'],
    '/report-pack': ['renderReportPack', 'bindReportPresentation'],
    '/operations': [
      'renderOperationsCenter',
      'renderWorkbookBindings',
      'renderWorkbookQueryMove',
      'workbookScheduleController',
    ],
    '/monitors': ['renderMonitors', 'workPageLoader'],
    '/capabilities': ['renderCapabilityCenter', 'workPageLoader'],
    // WEB-07: each account workflow page brings its own module; only Measurement shows a campaign review table.
    '/portfolio': ['renderPortfolio', 'bindChangeHistory', 'accountChoices'],
    '/measurement': ['renderMeasurement', 'reviewTable', 'measurementTraceImport', 'accountChoices'],
    '/commerce': ['renderCommerce', 'parseProductCSV', 'bindWooCommerceSource', 'accountChoices'],
    '/schedules': ['renderScheduleCenter', 'overviewLabel'],
    '/profiles': ['renderClientPlaybooks', 'reviewTable'],
    // WEB-07: the owner's sections and account access are registered parts of /settings, not wrappers of it.
    '/settings': ['renderSettings', 'renderOwnerSettings', 'renderAccountApprovals'],
    '/account': ['renderAccountPage', 'mfaQr', 'qrcode'],
  };
  // Regression (WEB-07): /portfolio, /measurement and /commerce each loaded all three pages' code (account-workflows.js,
  // 388 KB with the parked WooCommerce source) and campaign-workflows.js. A page now loads none of the others' code.
  // The report builder's script is no longer part of every page either.
  const builder = ['renderReportingOverview', 'overviewState'];
  const absent = {
    '/reporting-overview': ['renderReportDelivery'],
    '/report-library': ['overviewGranularityFields', 'renderReportDelivery'],
    '/': builder,
    '/login': builder,
    '/campaigns': builder,
    '/profiles': builder,
    '/settings': builder,
    '/account': builder,
    '/operations': builder,
    '/monitors': builder,
    '/portfolio': ['renderMeasurement', 'renderCommerce', 'bindWooCommerceSource', 'reviewTable', ...builder],
    '/measurement': ['renderPortfolio', 'renderCommerce', 'bindWooCommerceSource', ...builder],
    '/commerce': ['renderPortfolio', 'renderMeasurement', 'reviewTable', ...builder],
    // A page that lists work loads only the paged-list loader (web/work-pages.js).
    '/media': ['renderOperationsCenter', 'renderWorkbookBindings', ...builder],
    '/capabilities': ['renderOperationsCenter', 'renderWorkbookBindings', ...builder],
    '/reports': ['renderOperationsCenter', 'renderWorkbookBindings'],
    '/report-pack': ['renderOperationsCenter', 'renderWorkbookBindings'],
    // Design review 2026-10: Home and Schedules downloaded the campaign review and plan code (25.9 KB of Brotli, about
    // 14% of Home) through work-center.js and called none of it.
    '/dashboard': ['readableReview', 'bindCampaignWorkflow', 'campaignJournal'],
    '/schedules': ['readableReview', 'bindCampaignWorkflow', 'campaignJournal'],
  };
  // The page bodies these modules provide through the route registry (AMCP.routes.register, web/routes.js).
  const registered = {
    '/portfolio': 'renderPortfolio',
    '/measurement': 'renderMeasurement',
    '/commerce': 'renderCommerce',
  };
  for (const locale of ['en', 'ar'])
    for (const [path, handlers] of Object.entries(routes)) {
      const f = fixture(),
        nodes = new Map();
      const node = key => {
        if (!nodes.has(key))
          nodes.set(key, {
            innerHTML: '',
            textContent: '',
            lastElementChild: {},
            dataset: {},
            classList: {add() {}, remove() {}, toggle() {}},
            setAttribute() {},
            removeAttribute() {},
            addEventListener() {},
            querySelector: node,
            querySelectorAll: () => [],
            focus() {},
            close() {},
          });
        return nodes.get(key);
      };
      Object.assign(f.context.document, {
        readyState: 'interactive',
        body: node('body'),
        querySelector: node,
        getElementById: id => node('#' + id),
        querySelectorAll: () => [],
        addEventListener() {},
      });
      Object.assign(f.context, {
        matchMedia: () => ({matches: false, addEventListener() {}}),
        localStorage: {getItem: () => null},
        history: {replaceState() {}},
        performance,
        AbortController,
        TextDecoder,
        fetch(url) {
          // Asset traffic only: an Arabic page also downloads its catalog chunks (WEB-07). No API request.
          if (/^\/assets\/locales\/ar\/[a-z][a-z0-9-]*\.json$/.test(url))
            return Promise.resolve(new Response(fs.readFileSync('web/' + url.slice(8), 'utf8')));
          throw Error('Asset initialization must not call an API');
        },
      });
      Object.assign(f.context.location, {pathname: path, search: '', hash: ''});
      for (const file of scripts())
        if (!['routes.js', 'route-assets.js'].includes(file)) f.run(fs.readFileSync('web/' + file, 'utf8'));
      f.context.catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
      f.run(
        `uiLocale=${JSON.stringify(locale)};uiMessages=new Map(Object.entries(${locale === 'ar' ? 'catalog' : '{}'}));session={authenticated:true,workspaceRole:'owner'}`,
      );
      const pending = f.load(path),
        finished = new Set();
      for (let i = 0; i < 10; i++) {
        await tick();
        for (const script of f.appended)
          if (!finished.has(script)) {
            finished.add(script);
            // A stylesheet is a link with an address and nothing to run (the report builder loads the charts' sheet and the
            // V2 layer's: V2-EXP-01); a script is run, as the browser would.
            if (script.src) f.run(fs.readFileSync('web/' + script.src.slice(8), 'utf8'));
            script.onload();
          }
      }
      await pending;
      for (const handler of handlers)
        assert.equal(f.run('typeof ' + handler), 'function', `${locale} ${path}: ${handler}`);
      for (const handler of absent[path] ?? [])
        assert.equal(f.run('typeof ' + handler), 'undefined', `${locale} ${path} loads another page's ${handler}`);
      if (registered[path])
        assert.equal(f.run(`AMCP.routes.renderer(${JSON.stringify(path)}) === ${registered[path]}`), true, path);
      else assert.equal(f.run(`AMCP.routes.renderer(${JSON.stringify(path)})`), undefined, path);
      if (path === '/account')
        assert.match(f.run("mfaQr('otpauth://totp/AMCP:test?secret=JBSWY3DPEHPK3PXP&issuer=AMCP')"), /<svg/);
      assert.equal(f.timers.size, 0);
    }
});
