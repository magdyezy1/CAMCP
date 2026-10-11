import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * MED-05 (review 2026-10-08): recovery pagination. The media page paged its unfinished-upload recovery list with one
 * `?page` offset that `amcp_media list` also applied to the upload receipts the page never shows, and enabled "Next
 * recovery page" on `has_more || recovery_has_more`, so more than 50 receipts led to empty recovery pages. Recovery now
 * has its own cursor (`recovery_offset`, the page's `?recovery_page`), Next follows `recovery_has_more` only, the page
 * leaves the receipts out (`include_assets: false`), and the creative library's filters and the recovery page never
 * move each other.
 */
const actor = {tenantId: 'recovery-pages', userId: 'operator', role: 'operator'},
  scope = {platform: 'meta', account_id: '100', connection_id: 'meta'};
function service({assets = 0, recovery = 0} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 65).toString('base64'));
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 'meta',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      writeAccounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const later = Date.now() + 300000;
  // Upload receipts, each with its completed review (not a recovery item).
  for (let i = 0; i < assets; i++) {
    store.putDocument(actor.tenantId, 'workspace_asset', 'asset-' + i, {
      ...scope,
      review_id: 'asset-' + i,
      name: 'Receipt ' + i,
      sha256: 'a'.repeat(64),
      media_id: 'provider-' + i,
      ready: true,
      source: 'amcp_upload',
    });
    store.putDocument(actor.tenantId, 'media_review', 'asset-' + i, {
      user_id: actor.userId,
      created_at: 100,
      plan: {...scope, kind: 'image', name: 'Receipt ' + i},
    });
  }
  // Unsubmitted reviews still valid: the recovery list, newest expiry first.
  for (let i = 0; i < recovery; i++)
    store.putDocument(actor.tenantId, 'media_review', 'recovery-' + String(i).padStart(3, '0'), {
      user_id: actor.userId,
      created_at: 100,
      expires_at: later - i * 1000,
      fingerprint: 'f' + i,
      state_hash: 's' + i,
      plan: {...scope, kind: 'image', name: 'Recovery ' + i},
    });
  const mirror = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('No network in a media list');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  return {store, call: args => mirror.call('amcp_media', {action: 'list', ...args}, actor)};
}

test('60 receipts and no recovery items: the recovery list has no next page, whatever the receipts do', async () => {
  const f = service({assets: 60});
  try {
    const listed = await f.call({});
    assert.equal(listed.success, true, JSON.stringify(listed.error));
    assert.equal(listed.data.total, 60);
    assert.equal(listed.data.has_more, true, 'receipts continue');
    assert.equal(listed.data.recovery_total, 0);
    assert.equal(listed.data.recovery_has_more, false, 'recovery does not');
    // The media page's own call: no receipts at all, the same recovery answer.
    const page = await f.call({include_assets: false, recovery_offset: 0, limit: 50});
    assert.equal(page.success, true, JSON.stringify(page.error));
    for (const key of ['assets', 'total', 'has_more']) assert.equal(key in page.data, false, key);
    assert.deepEqual(page.data.recovery_reviews, []);
    assert.equal(page.data.recovery_has_more, false);
    assert.ok(Array.isArray(page.data.sources), 'sources stay in the list');
  } finally {
    f.store.close();
  }
});

test('recovery pages on its own cursor, apart from the receipts', async () => {
  const f = service({assets: 60, recovery: 7});
  try {
    const ids = d => d.recovery_reviews.map(r => r.review_id);
    // Receipts on their second page, recovery on its first.
    const apart = (await f.call({offset: 50, recovery_offset: 0, limit: 5})).data;
    assert.equal(apart.assets.length, 5);
    assert.deepEqual(ids(apart), ['recovery-000', 'recovery-001', 'recovery-002', 'recovery-003', 'recovery-004']);
    assert.equal(apart.recovery_total, 7);
    assert.equal(apart.recovery_has_more, true);
    const second = (await f.call({include_assets: false, recovery_offset: 5, limit: 5})).data;
    assert.deepEqual(ids(second), ['recovery-005', 'recovery-006']);
    assert.equal(second.recovery_has_more, false);
    // Without recovery_offset the recovery list follows offset, as callers wrote it before.
    const legacy = (await f.call({offset: 5, limit: 5})).data;
    assert.deepEqual(ids(legacy), ['recovery-005', 'recovery-006']);
    assert.equal(legacy.has_more, true);
  } finally {
    f.store.close();
  }
});

test('an invalid recovery cursor or include_assets is refused', async () => {
  const f = service();
  try {
    for (const args of [
      {recovery_offset: -1},
      {recovery_offset: 1.5},
      {recovery_offset: '5'},
      {include_assets: 'no'},
    ]) {
      const out = await f.call(args);
      assert.equal(out.success, false, JSON.stringify(args));
      assert.equal(out.error.code, 'INVALID_ARGUMENT', JSON.stringify(args));
    }
  } finally {
    f.store.close();
  }
});

/** The media page from web/workspace.js in a VM, with the list answer `listed` and the address `search`. */
function mediaPage(listed, search = '') {
  const nodes = new Map(),
    bindings = new Map(),
    calls = [],
    visits = [],
    inserted = [];
  const node = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        id,
        innerHTML: '',
        isConnected: true,
        addEventListener() {},
        insertAdjacentHTML: (_where, html) => inserted.push(html),
        setAttribute() {},
        focus() {},
      });
    return nodes.get(id);
  };
  const context = createContext({
    document: {addEventListener() {}},
    content: node('#content'),
    $: node,
    platforms: [],
    accountLabel: () => '',
    accountText: () => '',
    creativePushPanel: () => '',
    pushDrives: () => [],
    adPreviewsPanel: () => '',
    bindCreativePush() {},
    bindAdPreviews() {},
    bindCreativeLibrary: async () => {},
    workspaceCall: async (tool, args) => {
      calls.push({tool, args: JSON.parse(JSON.stringify(args))});
      return listed;
    },
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    Object,
    JSON,
    Number,
    String,
    Math,
    URLSearchParams,
    encodeURIComponent,
    location: {search},
    esc: value => String(value ?? ''),
    date: String,
    badge: String,
    blank: String,
    recordDetails: () => '',
    controls: () => '',
    recordAccountLabelHtml: () => '',
    toast() {},
    navigate: href => visits.push(href),
    clearTimeout() {},
    setTimeout() {},
    pollTimer: undefined,
  });
  const source = readFileSync('web/workspace.js', 'utf8');
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(
    source.slice(source.indexOf('function mediaJobPanel('), source.indexOf('async function renderDecisionReports()')),
  ).runInContext(context);
  return {
    calls,
    visits,
    bindings,
    render: () => new Script('renderMediaLibrary()').runInContext(context),
    pager: () => inserted.find(html => html.includes('media-next')) ?? '',
  };
}
const answer = extra => ({presets: {}, sources: [], recovery_reviews: [], recovery_total: 0, ...extra});

test('the media page disables Next recovery page when only the receipts continue', async () => {
  // What an older server returns for 60 receipts and no recovery items: has_more true, recovery_has_more false.
  const page = mediaPage(answer({total: 60, has_more: true, recovery_has_more: false}));
  await page.render();
  assert.match(page.pager(), /<button id="media-next" class="button" disabled>/);
  assert.match(page.pager(), /<button id="media-prev" class="button" disabled>/);
  // It asks for recovery only.
  assert.deepEqual(page.calls[0], {
    tool: 'media',
    args: {action: 'list', include_assets: false, recovery_offset: 0, limit: 50},
  });
  const more = mediaPage(answer({recovery_total: 51, recovery_has_more: true}));
  await more.render();
  assert.match(more.pager(), /<button id="media-next" class="button" >/);
});

test('recovery pages keep the creative library filters, and the library filters keep the recovery page', async () => {
  const page = mediaPage(
    answer({recovery_total: 120, recovery_has_more: true}),
    '?search=banner&tag=q4&recovery_page=1',
  );
  await page.render();
  // The library filters do not reach the recovery list; only its own page does.
  assert.deepEqual(page.calls[0].args, {action: 'list', include_assets: false, recovery_offset: 50, limit: 50});
  await page.bindings.get('#media-next')();
  await page.bindings.get('#media-prev')();
  assert.deepEqual(page.visits, ['/media?search=banner&tag=q4&recovery_page=2', '/media?search=banner&tag=q4']);
  // An older ?page link still opens that recovery page; paging from it drops the ambiguous parameter.
  const legacy = mediaPage(answer({recovery_total: 200, recovery_has_more: true}), '?page=2');
  await legacy.render();
  assert.equal(legacy.calls[0].args.recovery_offset, 100);
  await legacy.bindings.get('#media-next')();
  assert.deepEqual(legacy.visits, ['/media?recovery_page=3']);

  // The creative library writes its filters to the address and keeps the recovery page as it is.
  const library = readFileSync('web/creative-library.js', 'utf8'),
    context = createContext({URLSearchParams, Object, location: {search: '?recovery_page=3&search=old'}});
  new Script(
    library.slice(
      library.indexOf('function creativeLibraryHref('),
      library.indexOf('/** How an uploaded file reached'),
    ),
  ).runInContext(context);
  context.filters = {search: 'new', tag: '', original_sha256: undefined};
  assert.equal(new Script('creativeLibraryHref(filters)').runInContext(context), '/media?search=new&recovery_page=3');
  context.location.search = '?search=old';
  assert.equal(new Script('creativeLibraryHref(filters)').runInContext(context), '/media?search=new');
});
