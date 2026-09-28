import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Renaming and re-describing DV360 customer match audiences (Display & Video 360 API v4, pinned Discovery document,
 * checked 2026-09-28).
 */
const gateway = 'dv360_native_action',
  registry = new Registry(),
  action = 'DV360_FIRST_PARTY_AND_PARTNER_AUDIENCES_PATCH';
const actor = {tenantId: 'dv360-audience-edits', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const error = (status, code, message) => Response.json({error: {code: status, status: code, message}}, {status});
function fixture(o = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 109).toString('base64')),
    calls = [];
  store.putConnection(
    owner,
    {
      id: 'dv360',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic DV360',
      scopes: o.scopes ?? ['https://www.googleapis.com/auth/display-video'],
    },
    {accessToken: 'synthetic'},
  );
  const audiences = new Map([
    [
      '501',
      {
        displayName: 'Newsletter subscribers',
        description: 'Uploaded monthly',
        audienceType: 'CUSTOMER_MATCH_CONTACT_INFO',
        firstPartyAndPartnerAudienceType: 'TYPE_FIRST_PARTY',
        audienceSource: 'DISPLAY_VIDEO_360',
      },
    ],
    [
      '502',
      {
        displayName: 'App users',
        audienceType: 'CUSTOMER_MATCH_DEVICE_ID',
        firstPartyAndPartnerAudienceType: 'TYPE_FIRST_PARTY',
        audienceSource: 'DISPLAY_VIDEO_360',
      },
    ],
    [
      '503',
      {
        displayName: 'Site visitors',
        audienceType: 'COMMON',
        firstPartyAndPartnerAudienceType: 'TYPE_FIRST_PARTY',
        audienceSource: 'CAMPAIGN_MANAGER',
      },
    ],
    [
      '504',
      {
        displayName: 'Partner list',
        audienceType: 'CUSTOMER_MATCH_CONTACT_INFO',
        firstPartyAndPartnerAudienceType: 'TYPE_PARTNER',
        audienceSource: 'DISPLAY_VIDEO_360',
      },
    ],
  ]);
  let writes = 0;
  const shown = (id, a) => ({
    name: 'firstPartyAndPartnerAudiences/' + id,
    firstPartyAndPartnerAudienceId: id,
    ...a,
    displayAudienceSize: String(1000 + calls.length),
    youtubeAudienceSize: '2000',
  });
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method,
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({path, method, query: u.search});
      if (u.searchParams.has('partnerId')) return error(400, 'INVALID_ARGUMENT', 'Unexpected partner access.');
      if (u.searchParams.get('advertiserId') !== '123')
        return error(403, 'PERMISSION_DENIED', 'Advertiser access required.');
      const m = /^\/v4\/firstPartyAndPartnerAudiences\/(\d+)$/.exec(path),
        a = m && audiences.get(m[1]);
      if (method === 'GET') return a ? Response.json(shown(m[1], a)) : error(404, 'NOT_FOUND', 'Not found.');
      writes++;
      if (a && method === 'PATCH') {
        if (o.mode === 'error') return error(400, 'INVALID_ARGUMENT', 'Display name already used.');
        const changed = {...a};
        for (const f of u.searchParams.get('updateMask').split(',')) changed[f] = body[f];
        if (o.mode !== 'ignore') audiences.set(m[1], changed);
        return Response.json(shown(m[1], o.mode === 'ignore' ? a : changed));
      }
      throw new Error('Unexpected write ' + method + ' ' + path);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const patch = (id, mask, b, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action,
          params: {firstPartyAndPartnerAudienceId: id, advertiserId: '123', updateMask: mask, ...extra},
          body: b,
        },
      },
      actor,
    );
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, audiences, patch, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('customer match audiences are renamed and re-described without spending confirmation and verify; a replay sends nothing', async () => {
  const f = fixture();
  try {
    const p = ok(
      await f.patch('501', 'displayName,description', {
        displayName: 'Newsletter subscribers (EU)',
        description: 'Uploaded monthly from the EU list',
      }),
    );
    assert.equal(p.data.creative_impact.scope, 'customer_match_audience');
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    ok(await f.execute(p));
    assert.equal(f.audiences.get('501').displayName, 'Newsletter subscribers (EU)');
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    const d = ok(await f.patch('502', 'displayName', {displayName: 'App users 2026'}));
    ok(await f.execute(d));
    assert.equal(ok(await f.verify(d)).data.status, 'verified');
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
});

test('malformed edits are refused before any request; other audience types, partner descriptions, missing and unchanged audiences after reading', async () => {
  const cases = [
    ['a membership duration', 'membershipDurationDays', {membershipDurationDays: 30}, 'INVALID_DV360_AUDIENCE_EDIT'],
    ['a field outside the mask', 'displayName', {displayName: 'X', description: 'Y'}, 'INVALID_DV360_AUDIENCE_EDIT'],
    [
      'a mask field missing from the body',
      'displayName,description',
      {displayName: 'X'},
      'INVALID_DV360_AUDIENCE_EDIT',
    ],
    ['a repeated mask field', 'displayName,displayName', {displayName: 'X'}, 'INVALID_DV360_AUDIENCE_EDIT'],
    ['a padded name', 'displayName', {displayName: ' X'}, 'INVALID_DV360_AUDIENCE_EDIT'],
    ['a 241-byte name', 'displayName', {displayName: 'x'.repeat(241)}, 'INVALID_DV360_AUDIENCE_EDIT'],
    ['a 1001-character description', 'description', {description: 'x'.repeat(1001)}, 'INVALID_DV360_AUDIENCE_EDIT'],
    ['members', 'displayName', {displayName: 'X', contactInfoList: {contactInfos: []}}, 'INVALID_DV360_AUDIENCE_EDIT'],
  ];
  for (const [label, mask, b, code] of cases) {
    const f = fixture();
    try {
      const r = await f.patch('501', mask, b);
      assert.equal(r.error?.code, code, label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const g = fixture();
  try {
    assert.equal(
      (await g.patch('501', 'displayName', {displayName: 'X'}, {partnerId: '1'})).error?.code,
      'INVALID_DV360_AUDIENCE_EDIT',
      'partner access',
    );
    assert.equal(g.calls.length, 0);
    assert.match(
      (await g.patch('503', 'displayName', {displayName: 'Visitors'})).error?.message ?? '',
      /COMMON; DV360 edits only customer match audiences/,
    );
    assert.match(
      (await g.patch('504', 'description', {description: 'Shared'})).error?.message ?? '',
      /first-party audiences/,
    );
    assert.equal((await g.patch('599', 'displayName', {displayName: 'Missing'})).error?.code, 'STATE_NOT_FOUND');
    assert.match(
      (await g.patch('502', 'displayName', {displayName: 'App users'})).error?.message ?? '',
      /already has these values/,
    );
    assert.equal(g.writes(), 0);
  } finally {
    g.store.close();
  }
  const h = fixture({scopes: []});
  try {
    assert.equal((await h.patch('501', 'displayName', {displayName: 'X'})).error?.code, 'INSUFFICIENT_SCOPE');
  } finally {
    h.store.close();
  }
});

test('an error reply is never resubmitted, an ignored edit is not verified, and the ledger lists the row', async () => {
  const e = fixture({mode: 'error'});
  try {
    const p = ok(await e.patch('501', 'displayName', {displayName: 'Duplicate'}));
    assert.equal((await e.execute(p)).success, false);
    assert.equal((await e.execute(p)).success, false);
    assert.equal(e.writes(), 1);
  } finally {
    e.store.close();
  }
  const g = fixture({mode: 'ignore'});
  try {
    const p = ok(await g.patch('501', 'displayName', {displayName: 'Ignored'}));
    ok(await g.execute(p));
    assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  const row = actionContracts(registry).find(r => r.gateway === gateway && r.action === action);
  assert.equal(row?.status, 'reviewed_write_family');
  assert.equal(row.family, 'dv360_audience_edits');
});
