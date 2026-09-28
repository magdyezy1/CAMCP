import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Editing and deleting LinkedIn Direct Sponsored Content posts ("Posts API", li-lms-2026-09, checked 2026-09-28).
 */
const registry = new Registry(),
  gateway = 'linkedin_native_action';
const actions = {
  update: 'linkedin_rest_posts_ugc_post_urn_post',
  delete: 'linkedin_rest_posts_post_urn_delete',
  deleteAlias: 'linkedin_rest_posts_ugc_post_urn_delete',
};
const actor = {tenantId: 'linkedin-dsc-edits', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const acct = 'urn:li:sponsoredAccount:123',
  org = 'urn:li:organization:500';
function fixture(o = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 108).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'login',
      tenantId: actor.tenantId,
      gateway,
      enabled: true,
      accounts: ['123'],
      writeAccounts: ['123'],
      scopes: o.scopes ?? ['rw_ads', 'w_organization_social', 'r_organization_social'],
      label: 'Synthetic LinkedIn',
      resourceBindings: [{accountId: '123', pathPrefix: '/rest/organizations/500'}],
    },
    {accessToken: 'synthetic'},
  );
  const keep = (urn, account = '123') =>
    store.putDocument(actor.tenantId, 'linkedin_post', 'login/' + urn, {
      account_id: account,
      connection_id: 'login',
      author: org,
      post_id: urn,
      verified_at: Date.now(),
    });
  const dsc = (commentary, extra = {}) => ({
    author: org,
    commentary,
    visibility: 'PUBLIC',
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: true,
    distribution: {feedDistribution: 'NONE', targetEntities: [], thirdPartyDistributionChannels: []},
    content: {media: {id: 'urn:li:video:456', title: 'Synthetic video'}},
    adContext: {dscAdAccount: acct, dscStatus: 'ACTIVE'},
    ...extra,
  });
  const posts = new Map([
    [
      'urn:li:ugcPost:900',
      dsc('Autumn launch', {contentLandingPage: 'https://example.com/autumn', contentCallToActionLabel: 'LEARN_MORE'}),
    ],
    ['urn:li:ugcPost:901', dsc('Winter teaser')],
    ['urn:li:share:902', dsc('Old spring post')],
    ['urn:li:ugcPost:903', dsc('Retired post')],
    ['urn:li:ugcPost:950', dsc('Made outside AMCP')],
    [
      'urn:li:ugcPost:960',
      dsc('Other account', {adContext: {dscAdAccount: 'urn:li:sponsoredAccount:999', dscStatus: 'ACTIVE'}}),
    ],
  ]);
  for (const urn of [
    'urn:li:ugcPost:900',
    'urn:li:ugcPost:901',
    'urn:li:share:902',
    'urn:li:ugcPost:903',
    'urn:li:ugcPost:960',
  ])
    keep(urn);
  const creatives = [
    {
      id: 'urn:li:sponsoredCreative:700',
      intendedStatus: 'ACTIVE',
      campaign: 'urn:li:sponsoredCampaign:600',
      content: {reference: 'urn:li:ugcPost:900'},
    },
    {
      id: 'urn:li:sponsoredCreative:701',
      intendedStatus: 'PAUSED',
      campaign: 'urn:li:sponsoredCampaign:600',
      content: {reference: 'urn:li:ugcPost:901'},
    },
    {
      id: 'urn:li:sponsoredCreative:703',
      intendedStatus: 'REMOVED',
      campaign: 'urn:li:sponsoredCampaign:600',
      content: {reference: 'urn:li:ugcPost:903'},
    },
  ];
  let writes = 0;
  const calls = [];
  const fetcher = async (raw, init) => {
    const url = new URL(String(raw)),
      method = init?.method ?? 'GET',
      headers = new Headers(init?.headers),
      path = decodeURIComponent(url.pathname);
    calls.push(method + ' ' + path);
    assert.equal(headers.get('x-restli-protocol-version'), '2.0.0');
    const m = /^\/rest\/posts\/(urn:li:(?:ugcPost|share):\d+)$/.exec(path);
    if (method === 'GET' && m) {
      assert.match(url.pathname, /^\/rest\/posts\/urn%3Ali%3A/);
      return posts.has(m[1])
        ? Response.json({id: m[1], ...posts.get(m[1])})
        : Response.json({status: 404, message: 'Not found'}, {status: 404});
    }
    if (method === 'GET' && url.pathname === '/rest/adAccounts/123/creatives') {
      assert.equal(url.searchParams.get('q'), 'criteria');
      assert.equal(headers.get('x-restli-method'), 'FINDER');
      const refs = /^List\((.*)\)$/.exec(url.searchParams.get('contentReferences'))[1].split(',');
      return Response.json({
        elements: creatives
          .filter(c => refs.includes(c.content.reference))
          .map(c => ({...c, account: acct, isServing: c.intendedStatus === 'ACTIVE'})),
        metadata: {},
      });
    }
    if (m && (method === 'POST' || method === 'DELETE')) {
      writes++;
      if (o.mode === 'error')
        return Response.json({status: 403, message: 'Not enough permissions to modify this post'}, {status: 403});
      if (method === 'DELETE') {
        if (o.mode !== 'ignore') posts.delete(m[1]);
        return new Response(null, {status: 204});
      }
      assert.equal(headers.get('x-restli-method'), 'PARTIAL_UPDATE');
      const b = JSON.parse(String(init.body));
      if (o.mode !== 'ignore') Object.assign(posts.get(m[1]), b.patch.$set);
      return new Response(null, {status: 204});
    }
    throw Error('Unexpected ' + method + ' ' + path);
  };
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(fetcher, undefined, 30000, 8 * 1024 * 1024, 1000),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  const update = (urn, set, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        connection_id: 'login',
        arguments: {
          action: actions.update,
          account_id: '123',
          api_version: '202609',
          path_params: {ugc_post_urn: urn},
          restli_method: 'PARTIAL_UPDATE',
          payload: {patch: {$set: set}},
          ...extra,
        },
      },
      actor,
    );
  const remove = (urn, action = actions.delete, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        connection_id: 'login',
        arguments: {
          action,
          account_id: '123',
          api_version: '202609',
          path_params: action === actions.delete ? {post_urn: urn} : {ugc_post_urn: urn},
          ...extra,
        },
      },
      actor,
    );
  const execute = (p, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, posts, update, remove, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('a sponsored post is edited after spending confirmation and an unused one deleted through both action names; each verifies; a replay sends nothing', async () => {
  const f = fixture();
  try {
    const u = ok(
      await f.update('urn:li:ugcPost:900', {
        commentary: 'Autumn launch: now in stores',
        contentLandingPage: 'https://example.com/autumn-sale',
      }),
    );
    assert.equal(u.data.creative_impact.operation, 'update');
    assert.equal(u.data.creative_impact.may_affect_serving, true);
    assert.match(u.data.creative_impact.effect, /1 active creative/);
    assert.equal((await f.execute(u)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.writes(), 0);
    ok(await f.execute(u, {spend_change_confirmed: true}));
    assert.equal(f.posts.get('urn:li:ugcPost:900').commentary, 'Autumn launch: now in stores');
    assert.equal(ok(await f.verify(u)).data.status, 'verified');
    assert.equal((await f.execute(u, {spend_change_confirmed: true})).data.replayed, true);
    const d = ok(await f.remove('urn:li:share:902'));
    assert.equal(d.data.creative_impact.operation, 'delete');
    ok(await f.execute(d));
    assert.equal(f.posts.has('urn:li:share:902'), false);
    assert.equal(ok(await f.verify(d)).data.status, 'verified');
    const r = ok(await f.remove('urn:li:ugcPost:903', actions.deleteAlias));
    ok(await f.execute(r));
    assert.equal(ok(await f.verify(r)).data.status, 'verified', 'a creative that was REMOVED does not hold the post');
    assert.equal(f.writes(), 3);
  } finally {
    f.store.close();
  }
});

test('malformed edits are refused before any request; posts outside AMCP, other accounts, used, missing and unchanged posts after checking', async () => {
  const cases = [
    ['a lifecycle change', {lifecycleState: 'DRAFT'}],
    ['an adContext change', {adContext: {dscStatus: 'ARCHIVED'}}],
    ['empty commentary', {commentary: ' '}],
    ['3001 characters', {commentary: 'x'.repeat(3001)}],
    ['an http landing page', {contentLandingPage: 'http://example.com'}],
    ['an unknown label', {contentCallToActionLabel: 'BUY_NOW'}],
    ['nothing', {}],
  ];
  for (const [label, set] of cases) {
    const f = fixture();
    try {
      const r = await f.update('urn:li:ugcPost:900', set);
      assert.equal(r.error?.code, 'INVALID_LINKEDIN_DSC_EDIT', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const g = fixture();
  try {
    assert.equal(
      (await g.update('urn:li:person:900', {commentary: 'x'})).error?.code,
      'INVALID_LINKEDIN_DSC_EDIT',
      'a person URN',
    );
    assert.equal(
      (await g.update('urn:li:ugcPost:900', {commentary: 'x'}, {restli_method: 'UPDATE'})).error?.code,
      'INVALID_LINKEDIN_DSC_EDIT',
      'a full update',
    );
    assert.equal(
      (await g.remove('urn:li:share:902', actions.delete, {payload: {force: true}})).error?.code,
      'INVALID_LINKEDIN_DSC_EDIT',
      'a deletion payload',
    );
    assert.equal(g.calls.length, 0);
    assert.equal(
      (await g.update('urn:li:ugcPost:950', {commentary: 'Mine now'})).error?.code,
      'RESOURCE_SCOPE_REQUIRED',
      'a post AMCP did not create',
    );
    assert.equal(
      (await g.update('urn:li:ugcPost:960', {commentary: 'Mine now'})).error?.code,
      'RESOURCE_SCOPE_REQUIRED',
      'a post of another sponsored account',
    );
    const used = await g.remove('urn:li:ugcPost:901');
    assert.equal(used.error?.code, 'ASSET_IN_USE');
    assert.match(used.error?.message ?? '', /sponsoredCreative:701/);
    g.posts.delete('urn:li:ugcPost:900');
    assert.equal((await g.update('urn:li:ugcPost:900', {commentary: 'Gone'})).error?.code, 'STATE_NOT_FOUND');
    assert.match(
      (await g.update('urn:li:ugcPost:901', {commentary: 'Winter teaser'})).error?.message ?? '',
      /already has these values/,
    );
    assert.match(
      (await g.update('urn:li:ugcPost:901', {contentCallToActionLabel: 'LEARN_MORE'})).error?.message ?? '',
      /needs a contentLandingPage/,
    );
    assert.equal(g.writes(), 0);
  } finally {
    g.store.close();
  }
  const h = fixture({scopes: ['rw_ads', 'r_organization_social']});
  try {
    assert.equal((await h.update('urn:li:ugcPost:900', {commentary: 'x'})).error?.code, 'INSUFFICIENT_SCOPE');
  } finally {
    h.store.close();
  }
});

test('an error reply is never resubmitted, ignored edits and deletions are not verified, and the ledger lists the three rows', async () => {
  const e = fixture({mode: 'error'});
  try {
    const p = ok(await e.remove('urn:li:share:902'));
    assert.equal((await e.execute(p)).success, false);
    assert.equal((await e.execute(p)).success, false);
    assert.equal(e.writes(), 1);
  } finally {
    e.store.close();
  }
  const g = fixture({mode: 'ignore'});
  try {
    const u = ok(await g.update('urn:li:ugcPost:901', {commentary: 'Winter is here'}));
    ok(await g.execute(u, {spend_change_confirmed: true}));
    assert.notEqual(ok(await g.verify(u)).data.status, 'verified');
    const d = ok(await g.remove('urn:li:share:902'));
    ok(await g.execute(d));
    assert.notEqual(ok(await g.verify(d)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  for (const [kind, action] of Object.entries(actions)) {
    const row = actionContracts(registry).find(r => r.gateway === gateway && r.action === action);
    assert.equal(row?.status, 'reviewed_write_family', kind);
    assert.equal(row.family, 'linkedin_dsc_edits', kind);
  }
});
