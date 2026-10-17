// ARC-03 Stage B: routing truth anchored apart from the captured catalog. Before it, the method and path of 2,037
// Meta, TikTok, Snapchat, LinkedIn and X records came from the captured listing with no pinned vendor document, and
// nothing said so: the ledger, help and the contracts page offered every native read alike. Each routed ledger row now
// names what its route rests on (generated/route-anchors.json), the per-gateway coverage report is committed and
// checked, and a native read that no pinned or dated vendor artifact states carries the advisory read_unanchored.
// These tests use the committed files and a service whose transport refuses every request.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createContext, Script} from 'node:vm';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {
  anchoredStatuses,
  readUnanchored,
  routeAnchorKey,
  routeAnchorPageMeaning,
  routeAnchorReasons,
  routeAnchorsFile,
} from '../dist/src/route-anchors.js';
import {
  documentedRoutes,
  metaSdkEvidenceFile,
  routeAnchorDocumentsFile,
  routeAnchorReportFile,
  routeAnchors,
  serializeRouteAnchors,
} from '../dist/tools/route-anchors.js';
import {vendorContractInventory} from '../dist/tools/vendor-contract-inventory.js';

const registry = new Registry(),
  rows = actionContracts(registry),
  executable = rows.filter(r => r.status === 'native_read' || r.status === 'reviewed_write_family'),
  readJson = file => JSON.parse(fs.readFileSync(file, 'utf8')),
  lf = file => fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n'),
  artifact = readJson(routeAnchorsFile),
  catalog = readJson('web/locales/ar.json'),
  direct = row => registry.tools.get(row.gateway)?.mode === 'direct';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const esc = value =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 53).toString('base64')),
    requests = [],
    transport = new NativeTransport(async raw => {
      requests.push(String(raw));
      throw new Error('no provider request is expected');
    }),
    service = new MirrorService(registry, store, transport),
    actor = {tenantId: 'route-anchors', userId: 'owner', role: 'admin'};
  t.after(() => store.close());
  return {service, actor, requests, call: (tool, input) => service.call(tool, input, actor)};
}

test('every native read and reviewed write family row is anchored, or names its capture file and why nothing else anchors it', () => {
  const evidence = readJson('.mirror/REPORTS/evidence-hashes.json'),
    inventory = readJson('docs/implementation/VENDOR-METHOD-COVERAGE.json'),
    apple = readJson('generated/apple-platform-v1-models.json'),
    meta = readJson(metaSdkEvidenceFile),
    documented = new Map(documentedRoutes(lf(routeAnchorDocumentsFile)).map(d => [routeAnchorKey(d), d])),
    methodsOf = new Map();
  for (const m of inventory.methods)
    methodsOf.set(m.source_file, (methodsOf.get(m.source_file) ?? new Set()).add(m.id));
  assert.ok(executable.length > 2000, String(executable.length));
  const unexplained = [];
  for (const row of executable) {
    const key = routeAnchorKey(row);
    if (!row.method || !row.path) {
      unexplained.push(key + ': an executable row without a route');
      continue;
    }
    // The ledger row carries exactly the record generated/route-anchors.json holds for it.
    assert.deepEqual({status: row.status, anchor_status: row.anchor_status, anchor: row.anchor}, artifact.routes[key]);
    if (anchoredStatuses.has(row.anchor_status)) {
      const source = artifact.sources[row.anchor.source];
      assert.equal(source?.kind, row.anchor_status, key + ' names a source of its kind');
      if (row.anchor_status === 'vendor_spec') {
        // A method of the pinned document, whose bytes still have the recorded digest.
        assert.ok(methodsOf.get(source.file)?.has(row.anchor.method), key + ': ' + row.anchor.method);
        assert.equal(sha256(fs.readFileSync(source.file)), source.sha256, source.file);
      } else if (row.anchor_status === 'sdk_method' && row.gateway === 'meta_native_action') {
        assert.equal(row.anchor.method, meta.catalog_requests[row.action], key);
        assert.equal(row.anchor.sha256, meta.sources[row.anchor.method.split('.')[0].toLowerCase()].to, key);
      } else if (row.anchor_status === 'sdk_method') {
        assert.equal(source.revision, apple.revision, key);
        assert.ok(apple.methods[row.anchor.method], key + ': ' + row.anchor.method);
      } else {
        const page = documented.get(key);
        assert.deepEqual(
          [page?.method, page?.path, page?.url, page?.checked_at],
          [row.method, row.path, row.anchor.source, row.anchor.checked_at],
        );
      }
    } else if (row.anchor_status === 'captured_only' && routeAnchorReasons[row.anchor?.reason]) {
      // The capture page ships, still has its captured digest, and lists the action.
      const page = row.anchor.capture;
      assert.match(String(evidence[page]), /^[a-f0-9]{64}$/, page);
      assert.equal(sha256(Buffer.from(lf(page), 'utf8')), evidence[page], page);
      assert.deepEqual(artifact.captures[page], {sha256: evidence[page], shipped: true});
      assert.ok(fs.readFileSync(page, 'utf8').includes(JSON.stringify(row.action).slice(1, -1)), key);
    } else if (!(row.anchor_status === 'unanchored' && routeAnchorReasons[row.anchor?.reason]))
      unexplained.push(key + ': ' + row.anchor_status + ' ' + JSON.stringify(row.anchor ?? null));
  }
  assert.deepEqual(unexplained, [], 'an executable row that is neither anchored nor listed with a reason');
});

test('the committed anchors and coverage report are what the generator produces from the committed inputs', () => {
  const fresh = routeAnchors(registry, rows, vendorContractInventory(rows));
  assert.equal(serializeRouteAnchors(fresh.artifact), lf(routeAnchorsFile));
  assert.equal(fresh.report, lf(routeAnchorReportFile));
  // Each input is recorded with the digest of the text it was generated from.
  for (const [file, digest] of Object.entries(artifact.inputs)) assert.equal(sha256(lf(file)), digest, file);
});

test('the coverage report has a row per routed gateway with its target, and names the path for each gateway short of it', () => {
  const report = lf(routeAnchorReportFile).split('\n');
  for (const s of artifact.summary) {
    const mine = executable.filter(r => r.gateway === s.gateway);
    assert.equal(s.executable, mine.length, s.gateway);
    assert.equal(s.anchored_executable, mine.filter(r => anchoredStatuses.has(r.anchor_status)).length, s.gateway);
    assert.equal(s.read_unanchored, mine.filter(readUnanchored).length, s.gateway);
    assert.deepEqual(s.target, {anchored_executable: s.executable, met: s.anchored_executable === s.executable});
    if (!s.routes) continue;
    const cells = report
      .find(line => line.startsWith('| ' + s.gateway + ' |'))
      ?.split('|')
      .slice(2, 6)
      .map(c => c.trim());
    assert.deepEqual(cells, [
      String(s.routes),
      String(s.executable),
      String(s.anchored_executable),
      s.target.met ? 'yes' : 'no',
    ]);
    if (!s.target.met) assert.ok(report.includes('- ' + s.gateway + ': ' + s.target_path), s.gateway);
  }
  const total = key => artifact.summary.reduce((n, s) => n + s[key], 0);
  assert.ok(
    report.includes(
      `Executable routes (native reads and reviewed write families): ${total('executable')}, of which ${total('anchored_executable')} are anchored and ${total('read_unanchored')} native reads carry the advisory \`read_unanchored\`. The target for every gateway is all executable routes anchored.`,
    ),
  );
  // The baseline of 2026-10: only the five gateways without a pinned vendor document (Meta has SDK evidence for part of
  // its routes) have captured-only executable routes. A gateway leaves this list once its routes are anchored; a
  // gateway with a pinned document whose route stops matching it would join the list, and fails here.
  const withoutPinnedDocument = [
    'linkedin_native_action',
    'meta_native_action',
    'snapchat_native_action',
    'tiktok_native_action',
    'x_ads_native_action',
  ];
  assert.deepEqual(
    artifact.summary.filter(s => !s.target.met && !withoutPinnedDocument.includes(s.gateway)).map(s => s.gateway),
    [],
  );
});

test('a documented page is refused when malformed, when its route has moved, or when it anchors no routed action', () => {
  const entry = {
    gateway: 'meta_native_action',
    action: 'meta_ad_rule_id_update',
    method: 'POST',
    path: '/v26.0/{ad_rule_id}',
    url: 'https://developers.facebook.com/docs/marketing-api/ad-rules/guides/api-calls/',
    checked_at: '2026-09-30',
    note: 'Ad Rules Engine, API Calls.',
  };
  assert.equal(documentedRoutes(JSON.stringify({routes: [entry]})).length, 1);
  for (const broken of [
    {...entry, url: 'http://developers.facebook.com/docs/'},
    {...entry, checked_at: '30-09-2026'},
    {...entry, note: ''},
    {...entry, path: undefined},
  ])
    assert.throws(
      () => documentedRoutes(JSON.stringify({routes: [broken]})),
      /each route needs gateway, action, method, path, an https url, checked_at and a note/,
    );
  const inventory = vendorContractInventory(rows),
    moved = rows.map(r =>
      r.gateway === entry.gateway && r.action === entry.action ? {...r, path: '/v26.0/{ad_rule_id}/rules'} : r,
    );
  assert.throws(
    () => routeAnchors(registry, moved, inventory),
    /meta_native_action\/\/meta_ad_rule_id_update documents POST \/v26\.0\/\{ad_rule_id\}, the route is now POST \/v26\.0\/\{ad_rule_id\}\/rules/,
  );
  const without = rows.filter(r => !(r.gateway === entry.gateway && r.action === 'meta_ad_rule_id_delete'));
  assert.throws(
    () => routeAnchors(registry, without, inventory),
    /meta_native_action\/\/meta_ad_rule_id_delete anchors no routed ledger action/,
  );
});

test('help and DESCRIBE_ACTION mark an unanchored native read read_unanchored as advice, and change no status', async t => {
  const f = fixture(t),
    unanchoredRead = executable.find(
      r => direct(r) && r.status === 'native_read' && r.anchor_status === 'captured_only',
    ),
    anchoredRead = executable.find(r => direct(r) && r.status === 'native_read' && r.anchor_status === 'vendor_spec'),
    capturedWrite = executable.find(
      r => direct(r) && r.status === 'reviewed_write_family' && r.anchor_status === 'captured_only',
    );
  for (const [row, advised] of [
    [unanchoredRead, true],
    [anchoredRead, false],
    [capturedWrite, false],
  ]) {
    const help = await f.call('amcp_tool_help', {gateway: row.gateway, operation: row.action}),
      described = await f.call(row.gateway, {action: 'DESCRIBE_ACTION', target_action: row.action});
    for (const out of [help, described]) {
      assert.equal(out.success, true, JSON.stringify(out.error));
      const execution = out.data.amcp_execution;
      assert.equal(execution.status, row.status, row.action + ' keeps its classification');
      assert.equal(execution.route_anchor, row.anchor_status, row.action);
      if (advised) {
        assert.equal(execution.advisory, 'read_unanchored', row.action);
        assert.match(execution.advisory_note, /^This read runs as classified, but its method and path come only from/);
      } else assert.equal(execution.advisory, undefined, row.action + ' carries no advisory');
    }
  }
  assert.deepEqual(f.requests, []);
});

test('amcp_workspace contracts shows anchor_status and anchor per row, what they mean and the sources the page names', async t => {
  const f = fixture(t);
  for (const [gateway, search] of [
    ['meta_native_action', 'ad_rule'],
    ['snapchat_native_action', 'campaign'],
    ['google_ads_native_action', 'FETCH_'],
  ]) {
    const page = await f.call('amcp_workspace', {action: 'contracts', gateway, search, limit: 20});
    assert.equal(page.success, true, JSON.stringify(page.error));
    assert.equal(page.data.network_requests, 0);
    assert.equal(page.data.anchor_meaning, routeAnchorPageMeaning);
    assert.ok(page.data.actions.length > 0, gateway);
    for (const a of page.data.actions) {
      assert.equal(typeof a.anchor_status, 'string', a.action);
      if (a.method && a.path) assert.deepEqual(a.anchor, artifact.routes[routeAnchorKey(a)].anchor, a.action);
      else assert.equal(a.anchor_status, 'no_route', a.action);
    }
    const named = [...new Set(page.data.actions.map(a => a.anchor?.source).filter(Boolean))].sort();
    assert.deepEqual(Object.keys(page.data.anchor_sources).sort(), named, gateway);
    for (const id of named) assert.deepEqual(page.data.anchor_sources[id], artifact.sources[id], id);
  }
  assert.deepEqual(f.requests, []);
});

test('anchors stay evidence: outside the ledger, help and the anchors module nothing in src or server reads them', () => {
  // An execution gate that consulted anchor_status would turn advice into permission (or refusal).
  const readers = [];
  for (const directory of ['src', 'server'])
    for (const file of fs.readdirSync(directory).filter(f => f.endsWith('.ts'))) {
      const text = fs.readFileSync(directory + '/' + file, 'utf8');
      if (/route-anchors\.js'|\.anchor_status\b|\breadUnanchored\b|\banchoredStatuses\b/.test(text))
        readers.push(directory + '/' + file);
    }
  assert.deepEqual(readers.sort(), ['src/action-contracts.ts', 'src/execution-status.ts', 'src/route-anchors.ts']);
});

/** capability-center.js on a synthetic /capabilities page whose workspace calls reach the real service in-process. */
async function contractPanel(f, locale) {
  const bindings = new Map(),
    node = () => ({
      innerHTML: '',
      status: {textContent: ''},
      isConnected: true,
      setAttribute() {},
      querySelector(selector) {
        return selector === '[data-page-status]' ? this.status : null;
      },
      querySelectorAll() {
        return [];
      },
    }),
    nodes = {'#capability-results': node(), '#contract-results': node()},
    filter = {elements: {search: {value: ''}, gateway: {value: ''}}},
    workflows = {elements: {workflow_id: {value: '', add() {}}, target: {value: '', add() {}}, search: {value: ''}}};
  const context = createContext({
    Intl,
    Date,
    JSON,
    URL,
    URLSearchParams,
    document: {addEventListener() {}, querySelectorAll: () => []},
    location: {pathname: '/capabilities', search: '', href: 'https://amcp.example/capabilities'},
    history: {replaceState() {}},
    navigationGeneration: 1,
    identityGeneration: 1,
    content: {innerHTML: ''},
    esc,
    pretty: String,
    date: () => 'Synthetic date',
    badge: (value, label) => `<span data-state="${esc(value)}">${esc(label ?? value)}</span>`,
    recordDetails: () => '',
    errorMessage: e => e.message,
    Option: function (text, value, defaultSelected, isSelected) {
      return {text, value, selected: isSelected};
    },
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    workspaceCall: async (tool, input) => {
      const result = await f.call('amcp_' + tool, input);
      if (!result.success) throw Object.assign(Error(result.error.message), {code: result.error.code});
      return result.data;
    },
    $: selector =>
      selector === '#contract-filter' ? filter : selector === '#capability-filter' ? workflows : nodes[selector],
  });
  const run = code => new Script(code).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  context.catalog = catalog;
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  // WEB-07: the paged-list loader is its own small module (web/work-pages.js), as the Capabilities page loads it.
  run(fs.readFileSync('web/work-pages.js', 'utf8'));
  run(fs.readFileSync('web/capability-center.js', 'utf8'));
  await run('renderCapabilityCenter()');
  return {
    /** The rendered contract entry of one action, found through the panel's own filter. */
    async entry(row) {
      filter.elements.gateway.value = row.gateway;
      filter.elements.search.value = row.action;
      await bindings.get('#contract-filter')();
      const html = nodes['#contract-results'].innerHTML,
        start = html.indexOf(`<details><summary><strong>${esc(row.action)}</strong>`);
      assert.ok(start >= 0, row.action + ' is listed');
      return {page: html, entry: html.slice(start, html.indexOf('</details>', start))};
    },
  };
}

test('the contracts panel shows what each route rests on and marks an unanchored read, in English and Arabic', async t => {
  const f = fixture(t),
    unanchoredRead = executable.find(
      r => direct(r) && r.status === 'native_read' && r.anchor_status === 'captured_only',
    ),
    anchoredRead = executable.find(r => direct(r) && r.status === 'native_read' && r.anchor_status === 'vendor_spec'),
    documentedWrite = executable.find(r => r.anchor_status === 'documented_url');
  for (const locale of ['en', 'ar']) {
    const text = message => {
      const translated = locale === 'ar' ? catalog[message] : message;
      assert.ok(translated, message + ' has an Arabic translation');
      return esc(translated);
    };
    const panel = await contractPanel(f, locale),
      read = await panel.entry(unanchoredRead);
    assert.ok(
      read.page.includes(
        text(
          'Route evidence names the vendor source that states each method and path. “Captured catalog only” means no pinned vendor document, SDK request or dated page states them yet. Route evidence never changes what AMCP runs.',
        ),
      ),
    );
    const badge = `<span data-state="attention">${text('Read route without vendor evidence')}</span>`;
    assert.ok(read.entry.includes(badge), locale);
    assert.ok(read.entry.includes(text('Route evidence:') + ' ' + text('Captured catalog only')), locale);
    // Native names, methods and capture files stay literal and left-to-right.
    assert.ok(read.entry.includes(`<bdi dir="ltr">${esc(unanchoredRead.anchor.capture)}</bdi>`), locale);
    const anchored = await panel.entry(anchoredRead);
    assert.ok(!anchored.entry.includes(badge), locale + ': an anchored read has no badge');
    assert.ok(
      anchored.entry.includes(
        text('Pinned vendor document') +
          ` · <bdi dir="ltr">${esc(anchoredRead.anchor.source + ' ' + anchoredRead.anchor.method)}</bdi>`,
      ),
      locale,
    );
    const documented = await panel.entry(documentedWrite);
    assert.ok(
      documented.entry.includes(
        text('Dated vendor documentation page') +
          ` · <bdi dir="ltr">${esc(documentedWrite.anchor.source + ' ' + documentedWrite.anchor.checked_at)}</bdi>`,
      ),
      locale,
    );
    // A route AMCP maps itself shows that it has no pinned vendor evidence; it is not a read, so it has no badge.
    const mapped = await panel.entry(rows.find(r => r.anchor_status === 'unanchored'));
    assert.ok(mapped.entry.includes(text('Route evidence:') + ' ' + text('No pinned vendor evidence')), locale);
    assert.ok(!mapped.entry.includes(badge), locale);
  }
  assert.deepEqual(f.requests, []);
});

test('a route rests on its capture page exactly while it keeps the captured method and path', () => {
  // The first anchors linked a route to its capture only when the ledger's evidence was OBSERVED, so 14 captured
  // LinkedIn, X and Google routes the providers retired (evidence: the vendor page that retired them) were reported as
  // AMCP's own unpinned mappings. The captured route itself decides.
  const served = new Map(
    [...registry.catalogs.values()].flatMap(c => c.actions.map(a => [c.gateway + '/' + a.name, a])),
  );
  const keepsCaptured = row => {
    const captured = served.get(row.gateway + '/' + row.action);
    return !!captured && captured.method === row.method && captured.path === row.path;
  };
  for (const row of rows.filter(r => r.method && r.path)) {
    if (row.anchor_status === 'captured_only') assert.ok(keepsCaptured(row), routeAnchorKey(row));
    if (row.anchor_status === 'unanchored') {
      assert.equal(keepsCaptured(row), false, routeAnchorKey(row) + ' is a captured route');
      assert.equal(row.anchor.reason, 'independent_mapping_unpinned', routeAnchorKey(row));
    }
  }
  const retired = rows.filter(
    r =>
      r.status === 'provider_unsupported' &&
      r.source !== 'OBSERVED' &&
      keepsCaptured(r) &&
      registry.catalogs.get(r.gateway)?.actions.length &&
      !anchoredStatuses.has(r.anchor_status),
  );
  assert.ok(retired.length >= 14, String(retired.length));
  for (const row of retired) {
    assert.equal(row.anchor_status, 'captured_only', routeAnchorKey(row));
    assert.match(row.anchor.capture, new RegExp('^\\.mirror/RAW/' + row.gateway + '/catalog-\\d{4}\\.json$'));
    assert.ok(['captured_catalog_only', 'not_in_pinned_document'].includes(row.anchor.reason), routeAnchorKey(row));
  }
  // What stays unanchored is AMCP's own mapping of a captured name the catalog gives no route for.
  const own = rows.filter(r => r.anchor_status === 'unanchored');
  assert.ok(own.length > 0);
  for (const row of own) assert.equal(served.get(row.gateway + '/' + row.action)?.path ?? null, null, row.action);
});
