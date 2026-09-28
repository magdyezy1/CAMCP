import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Publishing and archiving LinkedIn lead gen forms ("Lead Syncing", Updating Form Status; li-lms-2026-09, checked
 * 2026-09-27).
 */
const registry = new Registry(),
  gateway = 'linkedin_native_action',
  action = 'linkedin_rest_lead_forms_lead_form_id_post';
const actor = {tenantId: 'linkedin-lead-form-states', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const acct = 'urn:li:sponsoredAccount:507';
function fixture(o = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 103).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'li',
      tenantId: actor.tenantId,
      gateway,
      enabled: true,
      accounts: ['507'],
      writeAccounts: ['507'],
      scopes: o.scopes ?? ['rw_ads'],
      label: 'Synthetic LinkedIn',
    },
    {accessToken: 'synthetic'},
  );
  const forms = new Map([
    [701, {owner: {sponsoredAccount: acct}, name: 'Demo requests', state: 'DRAFT'}],
    [702, {owner: {sponsoredAccount: acct}, name: 'Webinar', state: 'PUBLISHED'}],
    [703, {owner: {sponsoredAccount: acct}, name: 'Old offer', state: 'ARCHIVED'}],
    [704, {owner: {sponsoredAccount: 'urn:li:sponsoredAccount:999'}, name: 'Foreign', state: 'DRAFT'}],
    [705, {owner: {organization: 'urn:li:organization:5'}, name: 'Organic', state: 'PUBLISHED'}],
  ]);
  let writes = 0;
  const calls = [];
  const fetcher = async (raw, init) => {
    const url = new URL(String(raw)),
      method = init?.method ?? 'GET',
      headers = new Headers(init?.headers);
    calls.push({method, path: url.pathname});
    assert.equal(headers.get('x-restli-protocol-version'), '2.0.0');
    const m = /^\/rest\/leadForms\/(\d+)$/.exec(url.pathname);
    if (method === 'GET' && m)
      return forms.has(Number(m[1]))
        ? Response.json({id: Number(m[1]), creationLocale: {country: 'US', language: 'en'}, ...forms.get(Number(m[1]))})
        : Response.json({status: 404, serviceErrorCode: 100, message: 'Not found'}, {status: 404});
    if (method === 'POST' && m) {
      writes++;
      assert.equal(headers.get('x-restli-method'), 'PARTIAL_UPDATE');
      const b = JSON.parse(String(init.body));
      if (o.mode === 'error')
        return Response.json({status: 400, message: 'Form is not in an editable state'}, {status: 400});
      if (o.mode !== 'ignore') Object.assign(forms.get(Number(m[1])), b.patch.$set);
      return new Response(null, {status: 204});
    }
    throw Error('Unexpected ' + method + ' ' + url.pathname);
  };
  const service = new MirrorService(registry, store, new NativeTransport(fetcher), undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (id, set, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action,
          account_id: '507',
          restli_method: 'PARTIAL_UPDATE',
          path_params: {lead_form_id: String(id)},
          payload: {patch: {$set: set}},
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
  return {store, calls, forms, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('a draft form is published and a published one archived, each after spending confirmation; both verify and a replay sends nothing', async () => {
  const f = fixture();
  try {
    const pub = ok(await f.prepare(701, {state: 'PUBLISHED'}));
    assert.equal(pub.data.creative_impact.operation, 'publish');
    assert.equal(pub.data.creative_impact.may_affect_serving, true);
    assert.equal((await f.execute(pub)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.writes(), 0);
    ok(await f.execute(pub, {spend_change_confirmed: true}));
    assert.equal(f.forms.get(701).state, 'PUBLISHED');
    assert.equal(ok(await f.verify(pub)).data.status, 'verified');
    assert.equal((await f.execute(pub, {spend_change_confirmed: true})).data.replayed, true);
    const arc = ok(await f.prepare(702, {state: 'ARCHIVED'}));
    assert.match(arc.data.creative_impact.effect, /stop serving/);
    ok(await f.execute(arc, {spend_change_confirmed: true}));
    assert.equal(f.forms.get(702).state, 'ARCHIVED');
    assert.equal(ok(await f.verify(arc)).data.status, 'verified');
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
});

test('content edits and other states are refused before any request; forms of other owners, unchanged and invalid transitions after reading', async () => {
  const cases = [
    ['a headline edit', {state: 'PUBLISHED', content: {headline: {localized: {en_US: 'New'}}}}],
    ['a name edit', {name: 'Renamed'}],
    ['back to draft', {state: 'DRAFT'}],
    ['an unknown state', {state: 'DELETED'}],
  ];
  for (const [label, set] of cases) {
    const f = fixture();
    try {
      const r = await f.prepare(701, set);
      assert.equal(r.error?.code, 'INVALID_LINKEDIN_LEAD_FORM_STATE', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    assert.equal((await f.prepare(704, {state: 'PUBLISHED'})).error?.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.equal((await f.prepare(705, {state: 'ARCHIVED'})).error?.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.equal((await f.prepare(702, {state: 'PUBLISHED'})).error?.code, 'INVALID_LINKEDIN_LEAD_FORM_STATE');
    assert.equal((await f.prepare(701, {state: 'ARCHIVED'})).error?.code, 'INVALID_LINKEDIN_LEAD_FORM_STATE');
    assert.equal((await f.prepare(703, {state: 'PUBLISHED'})).error?.code, 'INVALID_LINKEDIN_LEAD_FORM_STATE');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const g = fixture({scopes: ['r_ads']});
  try {
    assert.equal((await g.prepare(701, {state: 'PUBLISHED'})).error?.code, 'INSUFFICIENT_SCOPE');
  } finally {
    g.store.close();
  }
});

test('an error reply is never resubmitted, an ignored change is not verified, and the ledger lists the row', async () => {
  const e = fixture({mode: 'error'});
  try {
    const p = ok(await e.prepare(702, {state: 'ARCHIVED'}));
    assert.equal((await e.execute(p, {spend_change_confirmed: true})).success, false);
    assert.equal((await e.execute(p, {spend_change_confirmed: true})).success, false);
    assert.equal(e.writes(), 1);
  } finally {
    e.store.close();
  }
  const g = fixture({mode: 'ignore'});
  try {
    const p = ok(await g.prepare(701, {state: 'PUBLISHED'}));
    ok(await g.execute(p, {spend_change_confirmed: true}));
    assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  const row = actionContracts(registry).find(r => r.gateway === gateway && r.action === action);
  assert.equal(row?.status, 'reviewed_write_family');
  assert.equal(row.family, 'linkedin_lead_form_states');
});
