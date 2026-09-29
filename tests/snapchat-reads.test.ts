import test from 'node:test';
import assert from 'node:assert/strict';
import type {JsonObject} from '../src/types.js';
import {SNAP, bytes, fixture, gateway} from './snapchat-plan-fixture.js';

/**
 * Snapchat S3, S4 and S6 from the owner's live tests. Reading four known creatives needed the whole 312-creative
 * account list (52 KB even projected); the five get_*_by_ids reads failed with HTTP 400 E1001 on guessed bodies (their
 * body is now read from Snapchat's documentation); and pixel and organization reads were refused for resources of the account's own.
 */
const creativeCount = 312,
  pageSize = 100,
  creative = (i: number): JsonObject => ({
    id: 'creative-' + i,
    name: 'AMCP clone creative ' + i + ' | WEB_VIEW | Arabic headline and English brand name',
    type: 'WEB_VIEW',
    ad_account_id: 'acct1',
    status: 'ACTIVE',
    headline: 'Discover the season',
    brand_name: 'Synthetic Company',
    shareable: true,
    call_to_action: 'LEARN_MORE',
    top_snap_media_id: 'media-' + i,
    top_snap_crop_position: 'MIDDLE',
    web_view_properties: {url: 'https://example.test/landing/' + i, allow_snap_javascript_sdk: false},
    ad_product: 'SNAP_AD',
    review_status: 'APPROVED',
  });
const wrapped = (kind: string, rows: JsonObject[], extra: JsonObject = {}) =>
  Response.json({
    request_status: 'SUCCESS',
    request_id: 'r',
    ...extra,
    [kind]: rows.map(r => ({sub_request_status: 'SUCCESS', [kind.slice(0, -1)]: r})),
  });
function reads() {
  return fixture({
    routes: (method, path, url, body) => {
      if (method === 'GET' && path === '/v1/adaccounts/acct1/creatives') {
        const start = Number(url.searchParams.get('cursor') ?? 0),
          next = start + pageSize;
        return wrapped(
          'creatives',
          Array.from({length: Math.min(pageSize, creativeCount - start)}, (_, i) => creative(start + i)),
          {
            paging:
              next < creativeCount
                ? {next_link: 'https://adsapi.snapchat.com/v1/adaccounts/acct1/creatives?cursor=' + next}
                : {},
          },
        );
      }
      const single = /^\/v1\/creatives\/(creative-\d+)$/.exec(path);
      if (method === 'GET' && single) return wrapped('creatives', [creative(Number(single[1]!.slice(9)))]);
      if (method === 'GET' && /^\/v1\/pixels\/pixel-own\/campaign_eligibilities$/.test(path))
        return Response.json({
          request_status: 'SUCCESS',
          campaign_eligibilities: [{objective: 'LEADS', eligible: true}],
        });
      if (method === 'GET' && path === '/v1/organizations/org1/pixels')
        return wrapped('pixels', [{id: 'pixel-own', organization_id: 'org1'}]);
      if (method === 'POST' && path === '/v1/adaccounts/acct1/get_creatives_by_ids') {
        byIdBodies.push(body!);
        const ids = (JSON.parse(body!).entity_ids as JsonObject[]).map(e => String(e.id));
        return wrapped(
          'creatives',
          ids.map(id =>
            id === 'creative-elsewhere'
              ? {...creative(1), id, ad_account_id: 'acct-other'}
              : creative(Number(id.slice(9))),
          ),
        );
      }
      return undefined;
    },
  });
}
const byIdBodies: string[] = [];
const call = (f: ReturnType<typeof fixture>, action: string, extra: JsonObject = {}) =>
  f.call(gateway, {action, connection_id: SNAP, account_id: 'acct1', ...extra});

test('four known creatives are read in one call under 10 KB, from the account list (S3)', async () => {
  const f = reads();
  try {
    const wanted = ['creative-3', 'creative-150', 'creative-201', 'creative-311'];
    const r = await call(f, 'snapchat_creative_list', {result_ids: wanted, result_fields: ['id', 'name', 'type']});
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    assert.deepEqual(
      r.data.data.creatives.map((w: JsonObject) => w.creative.id),
      wanted,
    );
    assert.deepEqual(r.data.result_ids, {requested: 4, found: wanted, missing: [], pages_read: 4, complete: true});
    assert.ok(bytes(r) < 10 * 1024, String(bytes(r)));
    // The IDs the account list returned are owned: one of them can now be read on its own.
    const one = await call(f, 'snapchat_creative_get', {path_params: {creative_id: 'creative-150'}});
    assert.equal(one.success, true, JSON.stringify(one).slice(0, 500));
    const expiry = f.store.db
      .prepare('SELECT expires_at FROM resource_ownership WHERE resource=?')
      .get('creatives/creative-150') as {expires_at: number};
    // The ownership lifetime is unchanged: five minutes.
    assert.ok(expiry.expires_at <= Date.now() + 300000 + 1000 && expiry.expires_at > Date.now() + 290000);
  } finally {
    f.close();
  }
});

test('an ID the account does not list is reported missing and stays unreadable (S3)', async () => {
  const f = reads();
  try {
    const r = await call(f, 'snapchat_creative_list', {result_ids: ['creative-7', 'creative-of-another-account']});
    assert.deepEqual(r.data.result_ids.missing, ['creative-of-another-account']);
    assert.deepEqual(r.data.result_ids.found, ['creative-7']);
    const before = f.requests.length;
    const foreign = await call(f, 'snapchat_creative_get', {path_params: {creative_id: 'creative-of-another-account'}});
    assert.equal(foreign.error.code, 'RESOURCE_SCOPE_REQUIRED');
    // The refusal's ownership read asks for that one ID, not the whole list.
    assert.deepEqual(foreign.error.details.next_call.arguments.result_ids, ['creative-of-another-account']);
    assert.equal(f.requests.length, before, 'no request for an unverified ID');
    // A bounded search says how far it looked.
    const bounded = await call(f, 'snapchat_creative_list', {result_ids: ['creative-305'], max_pages: 2});
    assert.deepEqual(bounded.data.result_ids.missing, ['creative-305']);
    assert.equal(bounded.data.result_ids.complete, false);
    assert.equal(bounded.data.result_ids.pages_read, 2);
    assert.match(bounded.data.result_ids.note, /2 pages/);
  } finally {
    f.close();
  }
});

test('result_ids is checked before any request', async () => {
  const f = reads();
  try {
    for (const [action, extra, pattern] of [
      ['snapchat_creative_get', {path_params: {creative_id: 'creative-1'}, result_ids: ['creative-1']}, /account list/],
      ['snapchat_creative_list', {result_ids: []}, /1-100/],
      ['snapchat_creative_list', {result_ids: Array.from({length: 101}, (_, i) => 'c' + i)}, /1-100/],
      ['snapchat_creative_list', {result_ids: ['../x']}, /result_ids\[0\]/],
    ] as [string, JsonObject, RegExp][]) {
      const r = await call(f, action, extra);
      assert.equal(r.error?.code, 'INVALID_PARAMETER', action + ' ' + JSON.stringify(r).slice(0, 300));
      assert.match(r.error.message, pattern);
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.close();
  }
});

test('the get_*_by_ids reads send Snapchat’s documented body and nothing else (S4, documented 2026-09-29)', async () => {
  const f = reads();
  try {
    // The documented body: one request, sent exactly as documented, the records returned.
    const body = {entity_ids: [{id: 'creative-3'}, {id: 'creative-150'}]};
    for (const action of [
      'snapchat_creative_get_by_ids',
      'snapchat_adaccounts_ad_account_id_get_creatives_by_ids_get',
    ]) {
      byIdBodies.length = 0;
      const r = await call(f, action, {payload: body});
      assert.equal(r.success, true, action + ' ' + JSON.stringify(r).slice(0, 500));
      assert.deepEqual(
        r.data.data.creatives.map((c: JsonObject) => c.creative.id),
        ['creative-3', 'creative-150'],
      );
      assert.deepEqual(
        byIdBodies.map(b => JSON.parse(b)),
        [body],
      );
    }
    // Guessed shapes are refused before any request, naming the documented body.
    const before = f.requests.length;
    for (const payload of [
      {ids: ['creative-3']},
      {entity_ids: ['creative-3']},
      {entity_ids: []},
      {entity_ids: [{id: 'creative-3'}, {id: 'creative-3'}]},
      {entity_ids: [{id: 'creative-3', name: 'x'}]},
      {entity_ids: [{id: 'creative-3'}], limit: 5},
      {entity_ids: Array.from({length: 2001}, (_, i) => ({id: 'creative-' + i}))},
    ]) {
      const r = await call(f, 'snapchat_creative_get_by_ids', {payload});
      assert.equal(
        r.error?.code,
        'INVALID_ARGUMENT',
        JSON.stringify(payload).slice(0, 80) + ' ' + JSON.stringify(r).slice(0, 300),
      );
      assert.deepEqual(r.error.details.documented_body, {entity_ids: [{id: '<id>'}]});
    }
    for (const entity of ['campaign', 'adsquad', 'ad', 'media'])
      assert.equal(
        (await call(f, 'snapchat_' + entity + '_get_by_ids', {payload: {ids: ['x']}})).error?.code,
        'INVALID_ARGUMENT',
        entity,
      );
    assert.equal(f.requests.length, before, 'no guessed body was sent');
    // A record naming another ad account is not passed on.
    const foreign = await call(f, 'snapchat_creative_get_by_ids', {
      payload: {entity_ids: [{id: 'creative-elsewhere'}]},
    });
    assert.equal(foreign.error?.code, 'ACCOUNT_SCOPE_MISMATCH', JSON.stringify(foreign).slice(0, 300));
    assert.doesNotMatch(JSON.stringify(foreign), /Arabic headline/);
    // The ledger lists them as reads again.
    const page = await f.call('amcp_workspace', {action: 'contracts', gateway, search: 'get_creatives_by_ids'});
    assert.ok(page.data.actions.length >= 1);
    assert.ok(
      page.data.actions.every((a: JsonObject) => a.status !== 'provider_unsupported'),
      JSON.stringify(page.data.actions),
    );
  } finally {
    f.close();
  }
});

test('the account’s own pixels and organization are readable; others are refused (S6)', async () => {
  const f = reads();
  try {
    const eligibility = (pixel: string) =>
      call(f, 'snapchat_pixel_campaign_eligibility', {path_params: {pixel_id: pixel}});
    // Unlisted: refused before any request, naming the account pixel list.
    const unlisted = await eligibility('pixel-own');
    assert.equal(unlisted.error.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.equal(unlisted.error.details.next_call.arguments.action, 'snapchat_pixel_list');
    await call(f, 'snapchat_pixel_list');
    const owned = await eligibility('pixel-own');
    assert.equal(owned.success, true, JSON.stringify(owned).slice(0, 500));
    assert.equal((await eligibility('pixel-of-another-account')).error.code, 'RESOURCE_SCOPE_REQUIRED');
    // The organization: its pixels are readable once an account read confirms it is this account's own.
    const orgPixels = (org: string) =>
      call(f, 'snapchat_organizations_organization_id_pixels_get', {path_params: {organization_id: org}});
    const before = await orgPixels('org1');
    assert.equal(before.error.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.equal(before.error.details.next_call.arguments.action, 'snapchat_account_get');
    await call(f, 'snapchat_account_get');
    const mine = await orgPixels('org1');
    assert.equal(mine.success, true, JSON.stringify(mine).slice(0, 500));
    assert.equal((await orgPixels('org-elsewhere')).error.code, 'RESOURCE_SCOPE_REQUIRED');
    // Only the pixel list: the organization's funding sources, members and billing stay out of reach.
    const funding = await call(f, 'snapchat_organizations_organization_id_fundingsources_get', {
      path_params: {organization_id: 'org1'},
    });
    assert.equal(funding.error.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.equal(
      f.requests.filter(r => r.includes('org-elsewhere') || r.includes('fundingsources') || r.includes('another'))
        .length,
      0,
    );
  } finally {
    f.close();
  }
});
