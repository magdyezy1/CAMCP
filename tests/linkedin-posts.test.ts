import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {WriteVerifier} from '../src/write-verification.js';
import {ScopeGuard} from '../src/scope.js';
import {linkedinDSCReads} from '../src/linkedin-posts.js';
import type {Actor, Connection, JsonObject} from '../src/types.js';

const actor: Actor = {tenantId: 'dsc-fixture', userId: 'operator', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'},
  registry = new Registry();
const post = () => ({
  author: 'urn:li:organization:500',
  commentary: 'Synthetic video post',
  visibility: 'PUBLIC',
  distribution: {feedDistribution: 'NONE', targetEntities: [], thirdPartyDistributionChannels: []},
  content: {media: {id: 'urn:li:video:456', title: 'Synthetic video'}},
  lifecycleState: 'PUBLISHED',
  isReshareDisabledByAuthor: true,
  adContext: {dscAdAccount: 'urn:li:sponsoredAccount:123', dscStatus: 'ACTIVE'},
});
function setup() {
  const store = new Store(':memory:', Buffer.alloc(32, 75).toString('base64'));
  const c: Connection = {
    id: 'login',
    tenantId: actor.tenantId,
    gateway: 'linkedin_native_action',
    accounts: ['123'],
    writeAccounts: ['123'],
    enabled: true,
    label: 'Synthetic',
    scopes: ['rw_ads', 'w_organization_social', 'r_organization_social'],
    resourceBindings: [{accountId: '123', pathPrefix: '/rest/organizations/500'}],
  };
  const save = () => store.putConnection(admin, c, {accessToken: 'synthetic'});
  save();
  store.putDocument(actor.tenantId, 'workspace_asset', 'media-receipt', {
    connection_id: c.id,
    account_id: '123',
    platform: 'linkedin',
    media_id: 'urn:li:video:456',
    status_source: 'provider',
    ready: true,
    owner_urn: 'urn:li:organization:500',
  });
  const calls: JsonObject[] = [];
  let created: JsonObject | undefined,
    creative: JsonObject | undefined,
    owner = 'urn:li:organization:500',
    processing = 'AVAILABLE',
    omitOwner = false,
    wrongPost = false,
    delayReads = 0;
  const transport = new NativeTransport(
    async (input, init) => {
      const url = new URL(String(input)),
        method = init?.method ?? 'GET',
        b = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({
        method,
        path: decodeURIComponent(url.pathname),
        query: Object.fromEntries(url.searchParams),
        version: new Headers(init?.headers).get('LinkedIn-Version'),
      });
      if (url.pathname === '/rest/adAccounts/123') return Response.json({id: 123, name: 'Synthetic'});
      if (url.pathname.startsWith('/rest/videos/'))
        return Response.json({
          id: 'urn:li:video:456',
          ...(!omitOwner ? {owner} : {}),
          status: processing,
          downloadUrl: 'https://example.test/signed?token=must-not-escape-' + calls.length,
          mediaLibraryMetadata: {associatedAccount: 'urn:li:sponsoredAccount:123'},
          lastModifiedAt: calls.length,
        });
      if (url.pathname === '/rest/posts' && method === 'POST') {
        created = structuredClone(b);
        return new Response(null, {status: 201, headers: {'x-restli-id': 'urn:li:ugcPost:900'}});
      }
      if (url.pathname.startsWith('/rest/posts/') && method === 'GET') {
        if (delayReads-- > 0) return Response.json({message: 'not propagated'}, {status: 404});
        return Response.json({...created, id: wrongPost ? 'urn:li:share:900' : 'urn:li:ugcPost:900'});
      }
      if (url.pathname === '/rest/adAccounts/123/creatives' && method === 'POST') {
        creative = {...b, id: 'urn:li:sponsoredCreative:901'};
        return new Response(null, {status: 201, headers: {'x-restli-id': 'urn:li:sponsoredCreative:901'}});
      }
      if (url.pathname.startsWith('/rest/adAccounts/123/creatives/')) return Response.json(creative);
      throw Error('Unexpected synthetic route ' + method + ' ' + url.pathname);
    },
    undefined,
    30000,
    8 * 1024 * 1024,
    1000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const prepare = (payload = post()) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway: c.gateway,
        connection_id: c.id,
        arguments: {action: 'linkedin_rest_posts_post', account_id: '123', api_version: '202609', payload},
      },
      actor,
    );
  const execute = (r: JsonObject) =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: r.review_id, idempotency_key: r.review_id, confirmed: true},
      actor,
    );
  const verify = (r: JsonObject) =>
    new WriteVerifier(store, registry, transport, service.credentials).verify(actor, r.review_id);
  return {
    store,
    c,
    save,
    calls,
    service,
    prepare,
    execute,
    verify,
    owner: (v: string) => {
      owner = v;
    },
    processing: (v: string) => {
      processing = v;
    },
    omitOwner: () => {
      omitOwner = true;
    },
    wrongPost: () => {
      wrongPost = true;
    },
    delayReads: (v: number) => {
      delayReads = v;
    },
  };
}
test('verified media -> reviewed non-feed DSC -> exact read -> paused creative; version and idempotency survive', async () => {
  const f = setup();
  try {
    const prepared = await f.prepare();
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    const r = prepared.data;
    assert.ok(
      !JSON.stringify(r.before_state).includes('must-not-escape'),
      'signed media URLs and telemetry are excluded from review state',
    );
    const executed = await f.execute(r);
    assert.equal(executed.data.success, true, JSON.stringify(executed));
    const plan = f.store.document(actor.tenantId, 'write_review', r.review_id).plan;
    assert.throws(
      () =>
        new ScopeGuard(registry, f.store).authorize(
          {...linkedinDSCReads(plan)[0]!, path: '/rest/posts/urn%3Ali%3AugcPost%3A900'},
          f.c,
        ),
      {code: 'RESOURCE_SCOPE_REQUIRED'},
      'header alone does not grant resource ownership',
    );
    f.delayReads(1);
    const verified = await f.verify(r);
    assert.equal(verified.status, 'verified', JSON.stringify(verified));
    assert.equal(verified.checks[0].read_attempts, 2);
    assert.equal((await f.execute(r)).data.replayed, true);
    assert.equal(f.calls.filter(c => c.method === 'POST' && c.path === '/rest/posts').length, 1);
    assert.equal(
      new ScopeGuard(registry, f.store).authorize(
        {...linkedinDSCReads(plan)[0]!, path: '/rest/posts/urn%3Ali%3AugcPost%3A900'},
        f.c,
      ),
      '123',
    );
    const p = await f.service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway: f.c.gateway,
        connection_id: f.c.id,
        arguments: {
          action: 'linkedin_rest_ad_accounts_ad_account_id_creatives_post',
          account_id: '123',
          api_version: '202609',
          payload: {
            campaign: 'urn:li:sponsoredCampaign:200',
            intendedStatus: 'PAUSED',
            content: {reference: 'urn:li:ugcPost:900'},
          },
        },
      },
      actor,
    );
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal((await f.execute(p.data)).data.success, true);
    assert.equal((await f.verify(p.data)).status, 'verified');
    assert.ok(
      f.calls.every(c => c.version === '202609'),
      'all state and verification reads preserve the reviewed monthly version',
    );
    assert.equal(f.store.verifyAudit(), true);
  } finally {
    f.store.close();
  }
});
test('DSC rejects organic distribution, false paused state, foreign account and extra fields before network', async () => {
  const f = setup();
  try {
    const cases = [
      {...post(), lifecycleState: 'DRAFT'},
      {...post(), distribution: {feedDistribution: 'MAIN_FEED'}},
      {...post(), adContext: {dscAdAccount: 'urn:li:sponsoredAccount:999', dscStatus: 'ACTIVE'}},
      {...post(), author: 'urn:li:person:500'},
      {...post(), unexpected: 'field'},
    ];
    for (const p of cases) {
      const r = await f.prepare(p as ReturnType<typeof post>);
      assert.equal(r.success, false);
      assert.equal(r.error.code, 'INVALID_LINKEDIN_DSC');
    }
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('DSC requires exact organization binding, current token scopes and connection-scoped media proof', async () => {
  for (const mutate of [
    (f: ReturnType<typeof setup>) => {
      f.c.resourceBindings = [{accountId: '123', pathPrefix: '/rest'}];
    },
    (f: ReturnType<typeof setup>) => {
      f.c.scopes = ['rw_ads'];
    },
    (f: ReturnType<typeof setup>) => {
      f.store.putDocument(actor.tenantId, 'workspace_asset', 'media-receipt', {
        connection_id: 'other-login',
        account_id: '123',
        platform: 'linkedin',
        media_id: 'urn:li:video:456',
        ready: true,
        status_source: 'provider',
      });
    },
  ]) {
    const f = setup();
    try {
      mutate(f);
      f.save();
      assert.equal((await f.prepare()).success, false);
      assert.equal(f.calls.length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('DSC checks exact owner/readiness and rejects revocation between preparation and execution', async () => {
  for (const mutate of [
    (f: ReturnType<typeof setup>) => f.owner('urn:li:organization:999'),
    (f: ReturnType<typeof setup>) => f.processing('PROCESSING'),
    (f: ReturnType<typeof setup>) => f.omitOwner(),
  ]) {
    const f = setup();
    try {
      mutate(f);
      const r = await f.prepare();
      assert.equal(r.error.code, 'LINKEDIN_MEDIA_NOT_READY');
      assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
    } finally {
      f.store.close();
    }
  }
  const f = setup();
  try {
    const p = await f.prepare();
    assert.equal(p.success, true);
    f.c.resourceBindings = [];
    f.save();
    assert.equal((await f.execute(p.data)).error.code, 'LINKEDIN_ORGANIZATION_BINDING_REQUIRED');
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  } finally {
    f.store.close();
  }
});
test('wrong full post URN never grants ownership or allows a second submitted write', async () => {
  const f = setup();
  try {
    const p = await f.prepare();
    await f.execute(p.data);
    f.wrongPost();
    assert.equal((await f.verify(p.data)).status, 'inconclusive');
    assert.equal(f.store.documents(actor.tenantId, 'linkedin_post').length, 0);
    assert.equal((await f.execute(p.data)).data.replayed, true);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  } finally {
    f.store.close();
  }
});
