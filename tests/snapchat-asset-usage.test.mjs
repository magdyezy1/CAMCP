import test from 'node:test';
import assert from 'node:assert/strict';
import {snapchatAssetUsageFixture, snapUsageIds as ids} from './fixtures/snapchat-asset-usage-data.mjs';
import {workflowOutcome} from '../dist/src/workflow-outcomes.js';

test('original Snapchat image/video reader exposes exact scalar creative links, distinct statuses and no native ownership grant', async t => {
  for (const media_type of ['image', 'video']) {
    const f = snapchatAssetUsageFixture(t, {asset: {media_type}}),
      absent = {...f.creative(ids.other), top_snap_media_id: undefined, type: 'COMPOSITE'},
      different = f.creative('14700000-0000-4000-8000-000000000006', ids.other);
    f.setHook(({kind, body}) => {
      if (kind === 'creatives')
        body.creatives.push(...[absent, different].map(creative => ({sub_request_status: 'success', creative})));
      return body;
    });
    const a = await f.service.call('amcp_media', {action: 'asset', asset_id: 'asset-147'}, f.actor);
    assert.equal(a.success, true);
    assert.equal(a.data.native_usage_kind, 'snapchat_top_snap');
    assert.deepEqual(a.data.native_usage_views, ['snapchat_top_snap']);
    assert.equal(f.requests.length, 0);
    const before = f.store.db
      .prepare("SELECT count(*) AS n FROM documents WHERE tenant_id=? AND kind!='provider_metrics'")
      .get(f.actor.tenantId).n;
    const r = await f.call();
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.complete, true);
    assert.equal(r.data.reference_view, 'snapchat_top_snap');
    assert.equal(r.data.qualified_view, 'creative.top_snap_media_id');
    assert.equal(r.data.rows.length, 1);
    assert.equal(r.data.rows[0].creative_id, ids.creative);
    assert.equal(r.data.rows[0].media_id, ids.media);
    assert.equal(r.data.rows[0].packaging_status, 'SUCCESS');
    assert.equal(r.data.rows[0].review_status, 'APPROVED');
    assert.equal(r.data.native_media.type, media_type.toUpperCase());
    assert.equal(r.data.examined_creatives, 3);
    assert.equal(r.data.scalar_top_snap_creatives, 2);
    assert.equal(r.data.unresolved_creatives, 1);
    assert.equal(r.data.other_top_snap_creatives, 1);
    assert.equal(r.data.collection.requests, 6);
    assert.equal(r.data.collection.rows, 10);
    assert.equal(r.data.has_more, false);
    assert.equal(r.data.next_cursor, null);
    assert.equal(r.data.provider_mutations, 0);
    assert.equal(r.data.saved_snapshot, false);
    assert.equal(f.store.ownsResource(f.connection, ids.account, 'media/' + ids.media), false);
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) AS n FROM documents WHERE tenant_id=? AND kind!='provider_metrics'")
        .get(f.actor.tenantId).n,
      before,
      JSON.stringify(f.store.db.prepare('SELECT kind,count(*) AS n FROM documents GROUP BY kind').all()),
    );
    assert.doesNotMatch(
      JSON.stringify(r),
      /PRIVATE-|download_link|headline|source_url|accessToken|ad_id|campaign_id|ad_squad_id/,
    );
  }
});

test('complete Snapchat paging reconstructs fixed current-account GETs and brackets original media discovered on another page', async t => {
  const f = snapchatAssetUsageFixture(t),
    missing = {...f.creative(ids.other), top_snap_media_id: undefined};
  f.setHook(({kind, cursor, pass, body, url}) => {
    if (kind === 'adaccounts') return body;
    const entityName = kind === 'media' ? 'media' : 'creative';
    const rows =
      kind === 'media'
        ? [cursor ? f.media : {...f.media, id: ids.other}]
        : cursor
          ? [pass === 1 ? missing : f.creative()]
          : [pass === 1 ? f.creative() : missing];
    return {
      ...body,
      [kind]: rows.map(row => ({sub_request_status: 'SUCCESS', [entityName]: row})),
      paging: cursor ? {} : {next_link: url.origin + url.pathname + '?cursor=opaque-' + kind + '&limit=50'},
    };
  });
  const r = await f.call();
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.data.examined_creatives, 2);
  assert.equal(r.data.rows.length, 1);
  assert.equal(f.requests.length, 10);
  assert.equal(r.data.source_references.length, 10);
  assert.equal(r.data.source_references.filter(x => x.source_request.cursor_hash).length, 4);
  assert.doesNotMatch(JSON.stringify(r), /opaque-media|opaque-creatives|next_link/);
  assert.ok(r.data.source_references.every(x => /^[a-f0-9]{64}$/.test(x.source_hash)));
});

test('Snapchat exact empty collections and missing native status/type remain explicit unknown evidence', async t => {
  const f = snapchatAssetUsageFixture(t, {rows: []}),
    empty = await f.call();
  assert.equal(empty.success, true);
  assert.equal(empty.data.rows.length, 0);
  assert.equal(empty.data.examined_creatives, 0);
  assert.equal(empty.data.complete, true);
  assert.match(empty.data.meaning, /not an atomic inventory|all-format absence/);
  f.setHook(({kind, body}) => {
    if (kind === 'creatives')
      body.creatives = [
        {
          sub_request_status: 'SUCCESS',
          creative: {id: ids.creative, ad_account_id: ids.account, top_snap_media_id: ids.media},
        },
      ];
    return body;
  });
  const unknown = await f.call();
  assert.equal(unknown.success, true);
  assert.equal(unknown.data.rows[0].creative_type, null);
  assert.equal(unknown.data.rows[0].review_status, null);
  assert.equal(unknown.data.rows[0].packaging_status, null);
  assert.equal(unknown.data.rows[0].name, ids.creative);
});

test('Snapchat foreign scopes, non-receipts, missing permissions and caller cursor/view/limit are refused before egress', async t => {
  for (const extra of [
    {cursor: ''},
    {cursor: 'opaque'},
    {reference_view: 'ad_images'},
    {limit: 0},
    {limit: 1001},
    {limit: '50'},
    {limit: 1.5},
    {account_id: ids.other},
  ]) {
    const f = snapchatAssetUsageFixture(t),
      r = await f.call(extra);
    assert.equal(r.success, false, JSON.stringify(extra));
    assert.equal(f.requests.length, 0);
  }
  for (const asset of [
    {sha256: null},
    {sha256: 'a'.repeat(63)},
    {media_id: '9007199254740993'},
    {media_type: 'lens'},
    {account_id: 'invalid'},
  ]) {
    const f = snapchatAssetUsageFixture(t, {asset}),
      r = await f.call();
    assert.equal(r.success, false);
    assert.equal(f.requests.length, 0);
  }
  const f = snapchatAssetUsageFixture(t);
  f.store.putConnection(f.admin, {...f.connection, scopes: []}, {accessToken: 'synthetic-snapchat'});
  assert.equal((await f.call()).error.code, 'INSUFFICIENT_SCOPE');
  assert.equal(f.requests.length, 0);
});

test('Snapchat native pages refuse partial, foreign, malformed, duplicated and inconsistent identities', async t => {
  const edits = [
    body => {
      body.request_status = 'PARTIAL';
    },
    body => {
      body.errors = [];
    },
    body => {
      body.has_more = true;
    },
    body => {
      body.creatives[0].sub_request_status = 'ERROR';
    },
    body => {
      body.creatives[0].creative.ad_account_id = ids.other;
    },
    body => {
      delete body.creatives[0].creative.ad_account_id;
    },
    body => {
      body.creatives[0].creative.id = 42;
    },
    body => {
      body.creatives[0].creative.top_snap_media_id = 'bad';
    },
    body => {
      body.creatives[0].creative.name = 'bad\u0000name';
    },
    body => {
      body.creatives[0].creative.review_status = {status: 'APPROVED'};
    },
    body => {
      body.creatives.push(structuredClone(body.creatives[0]));
    },
    body => {
      body.creatives.push(...Array.from({length: 50}, () => structuredClone(body.creatives[0])));
    },
  ];
  for (const edit of edits) {
    const f = snapchatAssetUsageFixture(t);
    f.setHook(({kind, body}) => {
      if (kind === 'creatives') edit(body);
      return body;
    });
    const r = await f.call();
    assert.equal(r.success, false, edit.toString());
    assert.equal(r.error.code, 'ASSET_USAGE_INVALID_RESPONSE');
    assert.equal(f.requests.length, 3);
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE-|Native <img|source_references/);
  }
});

test('Snapchat next links never change hosts, collection, account, filters, limit or cursor identity', async t => {
  const base = 'https://adsapi.snapchat.com/v1/adaccounts/' + ids.account + '/creatives';
  for (const link of [
    base + '?limit=51&cursor=a',
    base + '?cursor=a&cursor=b',
    base + '?cursor=a&type=WEB_VIEW',
    base + '?cursor=a#hash',
    base + '?cursor=',
    'https://evil.invalid' + new URL(base).pathname + '?cursor=a',
    base.replace(ids.account, ids.other) + '?cursor=a',
    base.replace('/creatives', '/media') + '?cursor=a',
    'https://user:secret@adsapi.snapchat.com' + new URL(base).pathname + '?cursor=a',
    base + '?cursor=a%0Ab',
  ]) {
    const f = snapchatAssetUsageFixture(t);
    f.setHook(({kind, body}) => {
      if (kind === 'creatives') body.paging = {next_link: link};
      return body;
    });
    const r = await f.call();
    assert.equal(r.success, false, link);
    assert.equal(r.error.code, 'ASSET_USAGE_INVALID_RESPONSE');
    assert.equal(f.requests.length, 3);
    assert.doesNotMatch(JSON.stringify(r), /evil.invalid|user:secret|next_link/);
  }
  for (const paging of [null, [], {next_cursor: 'x'}, {next_link: null}]) {
    const f = snapchatAssetUsageFixture(t);
    f.setHook(({kind, body}) => {
      if (kind === 'creatives') body.paging = paging;
      return body;
    });
    assert.equal((await f.call()).success, false);
  }
});

test('Snapchat repeated cursor and duplicates across pages never return partial references', async t => {
  for (const duplicate of [true, false]) {
    const f = snapchatAssetUsageFixture(t);
    f.setHook(({kind, cursor, body, url}) => {
      if (kind === 'creatives') {
        if (cursor && !duplicate) body.creatives = [];
        body.paging = {next_link: url.origin + url.pathname + '?cursor=repeat&limit=50'};
      }
      return body;
    });
    assert.equal((await f.call()).error.code, 'ASSET_USAGE_INVALID_RESPONSE');
    assert.equal(f.requests.length, 4);
  }
});

test('Snapchat media discovery, selected creative count and page bounds never assert incomplete absence', async t => {
  const limited = snapchatAssetUsageFixture(t, {
    rows: Array.from({length: 2}, (_, i) => ({
      id: '14700000-0000-4000-8000-' + String(i + 100).padStart(12, '0'),
      ad_account_id: ids.account,
    })),
  });
  assert.equal((await limited.call({limit: 1})).error.code, 'ASSET_USAGE_LIMIT');
  const missing = snapchatAssetUsageFixture(t);
  missing.setHook(({kind, body}) => {
    if (kind === 'media') body.media = [];
    return body;
  });
  assert.equal((await missing.call()).error.code, 'ASSET_USAGE_UNQUALIFIED');
  assert.equal(missing.requests.length, 2);
  const looping = snapchatAssetUsageFixture(t);
  looping.setHook(({kind, pass, cursor, body, url}) => {
    if (kind === 'creatives') {
      body.creatives = [];
      body.paging = {
        next_link:
          url.origin + url.pathname + '?limit=50&cursor=empty-' + (cursor ? Number(cursor.split('-')[1]) + 1 : 1),
      };
    }
    return body;
  });
  assert.equal((await looping.call()).error.code, 'ASSET_USAGE_LIMIT');
  assert.equal(looping.requests.length, 42);
});

test('Snapchat changed complete collections, original media status/type and original account are withheld', async t => {
  for (const kind of ['creatives', 'media', 'adaccounts']) {
    const f = snapchatAssetUsageFixture(t);
    f.setHook(({kind: resource, pass, body}) => {
      if (resource === kind && pass === 2) {
        if (kind === 'creatives') body.creatives[0].creative.top_snap_media_id = ids.other;
        if (kind === 'media') body.media[0].media.media_status = 'PENDING_UPLOAD';
        if (kind === 'adaccounts') body.adaccounts[0].adaccount.id = ids.other;
      }
      return body;
    });
    const r = await f.call();
    assert.equal(r.success, false);
    assert.ok(['ASSET_USAGE_CHANGED', 'ASSET_USAGE_INVALID_RESPONSE'].includes(r.error.code));
    assert.doesNotMatch(JSON.stringify(r), /source_references|rows|PRIVATE-/);
  }
});

test('Snapchat original source, credential and scope withdrawal halt inspection at the current native response', async t => {
  for (const mode of ['source', 'credential', 'permission', 'actor']) {
    const f = snapchatAssetUsageFixture(t);
    f.setHook(({kind, body}) => {
      if (kind === 'creatives') {
        if (mode === 'source')
          f.store.putDocument(f.actor.tenantId, 'workspace_asset', 'asset-147', {...f.asset, sha256: 'd'.repeat(64)});
        if (mode === 'credential') f.store.putConnection(f.admin, f.connection, {accessToken: 'changed'});
        if (mode === 'permission')
          f.store.putConnection(f.admin, {...f.connection, scopes: []}, {accessToken: 'synthetic-snapchat'});
        if (mode === 'actor') f.store.revokeKey(f.key);
      }
      return body;
    });
    const r = await f.call();
    assert.equal(r.success, false, mode);
    assert.equal(f.requests.length, 3);
    assert.doesNotMatch(JSON.stringify(r), /source_references|rows|PRIVATE-/);
  }
});

test('Snapchat response chunks fence withdrawn credentials and cancel oversized bodies without raw diagnostics', async t => {
  for (const oversized of [false, true]) {
    const f = snapchatAssetUsageFixture(t);
    let cancelled = false,
      pulls = 0;
    f.setHook(({kind, body}) =>
      kind !== 'creatives'
        ? body
        : new Response(
            new ReadableStream(
              {
                pull(controller) {
                  pulls++;
                  if (!oversized) f.store.putConnection(f.admin, f.connection, {accessToken: 'changed'});
                  controller.enqueue(
                    oversized ? new Uint8Array(8 * 1024 * 1024 + 1) : new TextEncoder().encode(JSON.stringify(body)),
                  );
                },
                cancel() {
                  cancelled = true;
                },
              },
              {highWaterMark: 0},
            ),
            {headers: {'content-type': 'application/json'}},
          ),
    );
    const r = await f.call();
    assert.equal(r.success, false);
    assert.equal(r.error.code, oversized ? 'ASSET_USAGE_LIMIT' : 'CONNECTION_AUTHORITY_CHANGED');
    assert.equal(pulls, 1);
    assert.equal(cancelled, true);
    assert.equal(f.requests.length, 3);
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE-|source_references|upstream/);
  }
  const f = snapchatAssetUsageFixture(t);
  f.setHook(({kind, body}) =>
    kind === 'creatives'
      ? Response.json({display_message: 'PRIVATE-ERROR', error: 'PRIVATE-ERROR'}, {status: 403})
      : body,
  );
  const r = await f.call();
  assert.equal(r.error.code, 'ASSET_USAGE_READ_FAILED');
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE-ERROR|upstream/);
});

test('Snapchat full 1000-creative limit and original media at the search bound share all operation counters', async t => {
  const f = snapchatAssetUsageFixture(t),
    id = n => '14700000-0000-4000-8000-' + String(n).padStart(12, '0'),
    media = [...Array.from({length: 999}, (_, i) => ({...f.media, id: id(i + 1000)})), f.media],
    creatives = Array.from({length: 1000}, (_, i) => f.creative(id(i + 3000), i % 2 ? ids.other : ids.media));
  f.setHook(({kind, cursor, body, url}) => {
    if (kind === 'adaccounts') return body;
    const offset = cursor ? Number(cursor) : 0,
      rows = (kind === 'media' ? media : creatives).slice(offset, offset + 50),
      entity = kind === 'media' ? 'media' : 'creative';
    return {
      ...body,
      [kind]: rows.map(row => ({sub_request_status: 'SUCCESS', [entity]: row})),
      paging: offset + 50 < 1000 ? {next_link: url.origin + url.pathname + '?limit=50&cursor=' + (offset + 50)} : {},
    };
  });
  const r = await f.call({limit: 1000});
  assert.equal(r.success, true, JSON.stringify(r.error));
  assert.equal(r.data.examined_creatives, 1000);
  assert.equal(r.data.rows.length, 500);
  assert.equal(r.data.other_top_snap_creatives, 500);
  assert.equal(r.data.collection.requests, 82);
  assert.equal(r.data.collection.rows, 4002);
  assert.equal(r.data.source_references.length, 82);
  assert.ok(r.data.collection.bytes <= r.data.collection.limits.bytes);
  assert.equal(f.store.ownsResource(f.connection, ids.account, 'media/' + ids.media), false);
});

test('Snapchat original asset handoff requires a qualified complete view and preserves the selected bound', () => {
  const data = {
    record_kind: 'native_asset_references',
    platform: 'snapchat',
    asset_id: 'asset-147',
    complete: true,
    reference_view: 'snapchat_top_snap',
    qualified_view: 'creative.top_snap_media_id',
    selected_limit: 200,
  };
  assert.equal(
    workflowOutcome('amcp_media', data).website_path,
    '/media?asset_id=asset-147&reference_view=snapchat_top_snap&reference_limit=200',
  );
  for (const extra of [{complete: false}, {qualified_view: 'ads'}, {reference_view: 'all'}, {selected_limit: 1001}])
    assert.equal(workflowOutcome('amcp_media', {...data, ...extra}).website_path, '/media?asset_id=asset-147');
});
