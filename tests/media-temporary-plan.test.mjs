// MED-01 Stage E, owner decision D23 (review 2026-10-08): a saved campaign plan may use temporary files (uploads and
// imports not retained, source_id src-…, deleted 30 minutes after they started) only with their deadline acknowledged;
// the plan then records and shows it. Before this, such a plan was saved silently and failed once its files were gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {sha256} from '../dist/src/security.js';
import {WEBSITE_UPLOAD_TTL_MS, temporaryMediaSources} from '../dist/src/media-retention.js';

const key = Buffer.alloc(32, 61).toString('base64'),
  actor = {tenantId: 'temporary-plan', userId: 'owner', role: 'admin'},
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );

function fixture() {
  const store = new Store(':memory:', key),
    requests = [];
  store.ensureTenant(actor.tenantId);
  store.putConnection(
    actor,
    {
      id: 'login',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      writeAccounts: ['100'],
      label: 'Synthetic',
      enabled: true,
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      requests.push({url: String(url), method: init?.method ?? 'GET'});
      throw Error('no provider request is expected');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  return {store, service, requests, call: input => service.call('amcp_campaign', input, actor)};
}
/** A completed website upload started `ago` milliseconds before now. */
function websiteSource(store, ago = 0) {
  const id = 'src-' + randomUUID(),
    created = Date.now() - ago;
  store.reserveMediaSource(actor.tenantId, id, created + WEBSITE_UPLOAD_TTL_MS);
  store.stageMedia(actor.tenantId, id, png);
  store.putDocument(actor.tenantId, 'media_source', id, {
    user_id: actor.userId,
    filename: 'plan.png',
    origin: 'upload',
    state: 'complete',
    size: png.length,
    mime: 'image/png',
    kind: 'image',
    sha256: sha256(png),
    created_at: created,
    expires_at: created + WEBSITE_UPLOAD_TTL_MS,
    inspection: 'unavailable',
  });
  return {id, deadline: created + WEBSITE_UPLOAD_TTL_MS};
}
const step = (id, source) => ({
  id,
  kind: 'media',
  connection_id: 'login',
  account_id: '100',
  arguments: {platform: 'meta', account_id: '100', connection_id: 'login', name: 'Plan', ...source},
  depends_on: [],
});

test('a plan that uses a temporary upload is refused unless its deadline is acknowledged, then records it', async () => {
  const f = fixture();
  try {
    const first = websiteSource(f.store, 10 * 60000),
      second = websiteSource(f.store),
      create = extra =>
        f.call({
          action: 'create',
          name: 'Creative push · 2 uploads',
          brief: 'Upload only the previewed files.',
          steps: [step('upload-1', {source_id: second.id}), step('upload-2', {source_id: first.id})],
          ...extra,
        });
    const refused = await create({});
    assert.equal(refused.success, false);
    assert.equal(refused.error.code, 'TEMPORARY_MEDIA_SOURCES', JSON.stringify(refused));
    assert.equal(refused.error.details.earliest_expires_at, new Date(first.deadline).toISOString());
    assert.deepEqual(
      refused.error.details.temporary_sources.map(s => s.step_id),
      ['upload-1', 'upload-2'],
    );
    assert.equal(f.store.documents(actor.tenantId, 'campaign_run').length, 0, 'nothing was saved');
    // acknowledge_temporary_sources is part of the published tool schema, so the website and MCP clients may send it.
    const saved = await create({acknowledge_temporary_sources: true, detail: 'full'});
    assert.equal(saved.success, true, JSON.stringify(saved));
    const run = f.store.documents(actor.tenantId, 'campaign_run')[0];
    assert.equal(run.temporary_sources.earliest_expires_at, new Date(first.deadline).toISOString());
    assert.equal(run.temporary_sources.acknowledged_by, actor.userId);
    assert.equal(run.temporary_sources.sources.length, 2);
    const compact = await f.call({action: 'get', id: run.id});
    assert.deepEqual(compact.data.temporary_sources, {
      earliest_expires_at: new Date(first.deadline).toISOString(),
      count: 2,
    });
    assert.equal(f.requests.length, 0, 'saving a plan sends nothing to a provider');
  } finally {
    f.store.close();
  }
});

test('plans with durable files need no acknowledgement, and a removed temporary file has no deadline left', async () => {
  const f = fixture();
  try {
    const durable = await f.call({
      action: 'create',
      name: 'Durable plan',
      brief: 'Upload from a link.',
      steps: [step('upload-1', {source_url: 'https://example.com/creative.png'})],
    });
    assert.equal(durable.success, true, JSON.stringify(durable));
    assert.equal(f.store.documents(actor.tenantId, 'campaign_run')[0].temporary_sources, undefined);
    // A retained original (lib-…) is durable; a src-… id that is already gone still needs the acknowledgement.
    const gone = 'src-' + randomUUID();
    assert.deepEqual(
      temporaryMediaSources(f.store, actor.tenantId, [
        step('a', {source_id: 'lib-' + randomUUID()}),
        step('b', {source_id: gone}),
        {id: 'c', kind: 'write', arguments: {source_id: gone}},
      ]),
      [{step_id: 'b', source_id: gone, expires_at: null}],
    );
  } finally {
    f.store.close();
  }
});
