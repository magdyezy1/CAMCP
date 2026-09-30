import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Meta customer lists under the personal-data policy the owner approved on 2026-09-30. Meta's references (read
 * 2026-09-30): "Custom Audience Users" (POST and DELETE /{custom_audience_id}/users, payload {schema, data}, session;
 * "only a maximum of 10000 at a time"; the reply's invalid_entry_samples), "Customer File Custom Audiences" (hashing
 * and normalization: EMAIL trimmed and lower-cased, PHONE digits with the country code; hash("sha256",
 * "mary@example.com") = f1904cf1...), "Custom Audience Terms Of Service" (act_{id}?fields=tos_accepted,
 * custom_audience_tos: 1) and the CustomAudience reference (operation_status 471 flagged, delivery_status 300 too small).
 */
const gateway = 'meta_native_action',
  registry = new Registry(),
  tenantId = 'meta-customer-lists',
  operator = {tenantId, userId: 'operator', role: 'operator'},
  owner = {tenantId, userId: 'owner', role: 'admin'};
const sha = v => createHash('sha256').update(v).digest('hex');
const mary = sha('mary@example.com'),
  bob = sha('bob@example.org'),
  phone = sha('966501234567');
assert.equal(mary, 'f1904cf1a9d73a55fa5de0ac823c4403ded71afd4c3248d00bdcd0866552bb79');
const saudi = {
  countries: ['SA'],
  consent_confirmed: true,
  platform_terms_confirmed: true,
  pdpl: {consent: true, transfer_abroad: true, withdrawal_removal: true},
};
const emails = {schema: 'EMAIL', rows: [' Mary@Example.com ', 'mary@example.com', 'not-an-email', 'bob@example.org']};

function fixture({tos = 1} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 51).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'm',
      tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  const audiences = new Map([
    [
      '456',
      {
        id: '456',
        account_id: '123',
        name: 'Customers',
        subtype: 'CUSTOM',
        is_value_based: false,
        operation_status: {code: 200, description: 'Normal'},
        delivery_status: {code: 200, description: 'Ready'},
        approximate_count_lower_bound: 1000,
        approximate_count_upper_bound: 1200,
      },
    ],
    [
      '457',
      {
        id: '457',
        account_id: '999',
        name: 'Elsewhere',
        subtype: 'CUSTOM',
        is_value_based: false,
        operation_status: {code: 200},
      },
    ],
    [
      '458',
      {
        id: '458',
        account_id: '123',
        name: 'Similar',
        subtype: 'LOOKALIKE',
        is_value_based: false,
        operation_status: {code: 200},
      },
    ],
    [
      '459',
      {
        id: '459',
        account_id: '123',
        name: 'Flagged',
        subtype: 'CUSTOM',
        is_value_based: false,
        operation_status: {code: 471, description: 'Flagged'},
      },
    ],
    [
      '460',
      {
        id: '460',
        account_id: '123',
        name: 'Valued',
        subtype: 'CUSTOM',
        is_value_based: true,
        operation_status: {code: 200},
      },
    ],
  ]);
  const calls = [];
  let writes = 0,
    reply;
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method;
      const raw = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
      const b = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => {
          try {
            return [k, JSON.parse(v)];
          } catch {
            return [k, v];
          }
        }),
      );
      calls.push({method, path, query: Object.fromEntries(u.searchParams), body: b});
      if (method === 'GET') {
        if (path === '/v26.0/act_123')
          return Response.json({id: 'act_123', account_id: '123', tos_accepted: tos ? {custom_audience_tos: tos} : {}});
        const m = /^\/v26\.0\/(\d+)$/.exec(path);
        if (m && audiences.has(m[1])) return Response.json(audiences.get(m[1]));
        return Response.json(
          {error: {message: 'Unsupported get request.', code: 100, error_subcode: 33}},
          {status: 400},
        );
      }
      writes++;
      if (reply) return reply(b);
      if (method === 'POST' && path === '/v26.0/act_123/customaudiences') {
        const id = String(500 + writes);
        audiences.set(id, {id, account_id: '123', ...b, operation_status: {code: 410}});
        return Response.json({id});
      }
      const m = /^\/v26\.0\/(\d+)\/users$/.exec(path);
      if (m && audiences.has(m[1]) && ['POST', 'DELETE'].includes(method))
        return Response.json({
          audience_id: m[1],
          session_id: String(b.session.session_id),
          num_received: b.payload.data.length,
          num_invalid_entries: 0,
          invalid_entry_samples: {[b.payload.data[0][0]]: 'Invalid'},
        });
      throw Error('Unexpected write ' + method + ' ' + path);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const workspace = (action, extra, actor = owner) => service.call('amcp_workspace', {action, ...extra}, actor);
  const prepare = (action, audience, people, personal_data, actor = operator, payload) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action,
          account_id: '123',
          params: audience ? {custom_audience_id: audience} : {ad_account_id: '123'},
          ...(payload ? {payload} : {}),
        },
        ...(people !== undefined ? {people} : {}),
        ...(personal_data !== undefined ? {personal_data} : {}),
      },
      actor,
    );
  const add = (people = emails, personal_data = saudi, audience = '456', actor = operator) =>
    prepare('meta_custom_audience_id_users_create', audience, people, personal_data, actor);
  const remove = (people = emails, audience = '456', actor = operator) =>
    prepare('meta_custom_audience_id_users_delete', audience, people, undefined, actor);
  const execute = (p, people, actor = owner, extra = {}) =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, confirmed: true, ...(people ? {people} : {}), ...extra},
      actor,
    );
  const verify = (p, actor = owner) =>
    service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  /** Everything AMCP keeps: documents, the audit trail, idempotency records and jobs. */
  const kept = () =>
    JSON.stringify([
      store.db.prepare('SELECT data FROM documents').all(),
      store.db.prepare('SELECT event FROM audit').all(),
      store.db.prepare('SELECT result FROM idempotency').all(),
      store.db.prepare('SELECT input,result,error FROM jobs').all(),
    ]);
  const f = {store, calls, audiences, workspace, prepare, add, remove, execute, verify, kept, writes: () => writes};
  f.reply = fn => (reply = fn);
  return f;
}
const ok = r => {
  assert.equal(r.success ?? true, true, JSON.stringify(r).slice(0, 1500));
  assert.equal(r.error, undefined, JSON.stringify(r).slice(0, 1500));
  return r;
};
const refused = (r, code, pattern) => {
  assert.equal(r.error?.code, code, JSON.stringify(r).slice(0, 1200));
  if (pattern) assert.match(r.error.message, pattern);
};
const noPeople = (text, label) => {
  for (const v of [
    'mary@example.com',
    'Mary@Example.com',
    'bob@example.org',
    'not-an-email',
    mary,
    bob,
    phone,
    '966501234567',
  ])
    assert.equal(text.includes(v), false, label + ' holds ' + v);
};
async function enable(f) {
  return ok(await f.workspace('enable_personal_data', {connection_id: 'm', account_id: '123', confirmed: true}));
}

test('an upload is hashed in memory: the review keeps counts and a digest, and the owner runs it', async () => {
  const f = fixture();
  await enable(f);
  const p = ok(await f.add());
  const record = p.data.request.personalData;
  assert.deepEqual(record.counts, {rows: 4, sent: 2, duplicates: 1, refused: {invalid_email: 1}});
  assert.match(record.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(record.confirmations.countries, ['SA']);
  assert.match(record.confirmations.laws.join(), /PDPL/);
  assert.equal(p.data.request.body.payload.data.length, 0);
  assert.match(p.data.execute_requirements.people, /same people/);
  assert.match(p.data.execute_requirements.owner_executes, /workspace owner/);
  assert.match(JSON.stringify(p.data.creative_impact), /about 24 hours/);
  noPeople(JSON.stringify(p), 'the prepare response');
  noPeople(f.kept(), 'the store after prepare');
  assert.equal(f.writes(), 0);
  // An operator prepares; only the owner runs an upload.
  refused(await f.execute(p, emails, operator), 'OWNER_REQUIRED', /workspace owner/);
  refused(await f.execute(p, undefined), 'PERSONAL_DATA_REQUIRED', /same people/);
  refused(
    await f.execute(p, {schema: 'EMAIL', rows: ['mary@example.com', 'eve@example.net']}),
    'PERSONAL_DATA_CHANGED',
  );
  assert.equal(f.writes(), 0);
  const done = ok(await f.execute(p, emails));
  const sent = f.calls.find(c => c.method === 'POST' && c.path === '/v26.0/456/users');
  assert.equal(sent.body.payload.schema, 'EMAIL_SHA256');
  assert.deepEqual(
    sent.body.payload.data,
    [[bob], [mary]].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  );
  assert.equal(sent.body.session.batch_seq, 1);
  assert.equal(sent.body.session.last_batch_flag, true);
  assert.equal(sent.body.session.estimated_num_total, 2);
  assert.equal(typeof sent.body.session.session_id, 'number');
  assert.deepEqual(done.data.data, {
    audience_id: '456',
    session_id: String(sent.body.session.session_id),
    num_received: 2,
    num_invalid_entries: 0,
  });
  noPeople(JSON.stringify(done), 'the execute response');
  const v = ok(await f.verify(p));
  assert.equal(v.data.status, 'verified');
  assert.equal(v.data.checks[0].received, 2);
  assert.equal(v.data.checks[0].delivery_status.code, 200);
  noPeople(JSON.stringify(v), 'the verification');
  noPeople(f.kept(), 'the store after execution');
});

test('the switch is the owner’s, off by default, and turning it off stops a prepared review', async () => {
  const f = fixture();
  refused(await f.add(), 'PERSONAL_DATA_OFF', /Only the workspace owner turns them on/);
  refused(
    await f.workspace('enable_personal_data', {connection_id: 'm', account_id: '123', confirmed: true}, operator),
    'OWNER_REQUIRED',
  );
  const on = await enable(f);
  assert.deepEqual(on.data?.accounts?.map(a => a.account_id) ?? on.accounts.map(a => a.account_id), ['123']);
  const p = ok(await f.add());
  ok(await f.workspace('disable_personal_data', {gateway, account_id: 'act_123'}));
  refused(await f.execute(p, emails), 'PERSONAL_DATA_OFF');
  assert.equal(f.writes(), 0);
  noPeople(f.kept(), 'the store');
});

test('consent, country and law confirmations are required to add people, never to remove them', async () => {
  const f = fixture();
  await enable(f);
  refused(await f.add(emails, null), 'PERSONAL_DATA_CONFIRMATION_REQUIRED', /personal_data/);
  refused(await f.add(emails, {...saudi, countries: []}), 'PERSONAL_DATA_CONFIRMATION_REQUIRED', /countries/);
  refused(await f.add(emails, {...saudi, pdpl: {consent: true}}), 'PERSONAL_DATA_CONFIRMATION_REQUIRED', /PDPL/);
  refused(await f.add(emails, {...saudi, consent_confirmed: false}), 'PERSONAL_DATA_CONFIRMATION_REQUIRED', /consent/);
  refused(
    await f.add(emails, {...saudi, platform_terms_confirmed: undefined}),
    'PERSONAL_DATA_CONFIRMATION_REQUIRED',
    /terms/,
  );
  const us = {countries: ['US'], consent_confirmed: true, platform_terms_confirmed: true};
  refused(await f.add(emails, us), 'PERSONAL_DATA_CONFIRMATION_REQUIRED', /Name the privacy law/);
  const named = ok(await f.add(emails, {...us, law: 'California Consumer Privacy Act'}));
  assert.match(
    named.data.request.personalData.confirmations.laws[0],
    /US: California Consumer Privacy Act \(named by the uploader\)/,
  );
  const eu = ok(
    await f.add(emails, {countries: ['DE', 'GB', 'AE'], consent_confirmed: true, platform_terms_confirmed: true}),
  );
  assert.equal(eu.data.request.personalData.confirmations.laws.length, 3);
  refused(
    await f.prepare('meta_custom_audience_id_users_delete', '456', emails, saudi),
    'INVALID_ARGUMENT',
    /removal needs no/,
  );
  // Values: pre-hashed values must be SHA-256 hex; nothing valid is refused; a batch beyond 10,000 is refused.
  const hashed = ok(await f.add({schema: 'EMAIL', hashed: true, rows: [mary, 'MARY@EXAMPLE.COM', mary.toUpperCase()]}));
  assert.deepEqual(hashed.data.request.personalData.counts.refused, {not_sha256_hex: 2});
  refused(await f.add({schema: 'EMAIL', rows: ['nobody']}), 'PERSONAL_DATA_INVALID', /No row/);
  refused(
    await f.add({schema: 'EMAIL', rows: Array.from({length: 10001}, (_, i) => 'p' + i + '@example.com')}),
    'PERSONAL_DATA_INVALID',
    /at most 10000/,
  );
  refused(await f.add({schema: 'NAME', rows: ['Mary']}), 'PERSONAL_DATA_INVALID', /EMAIL, PHONE/);
  // Phones in E.164 only; multi-key rows keep a blank for an unknown key.
  const both = ok(
    await f.add({
      schema: ['EMAIL', 'PHONE'],
      rows: [
        ['mary@example.com', '+966 50 123 4567'],
        ['', '0501234567'],
        ['', '+966501234567'],
      ],
    }),
  );
  assert.deepEqual(both.data.request.personalData.counts, {
    rows: 3,
    sent: 2,
    duplicates: 0,
    refused: {invalid_phone: 1},
  });
  // A request body is built from people only; payload and people elsewhere are refused.
  refused(
    await f.prepare('meta_custom_audience_id_users_create', '456', emails, saudi, operator, {
      payload: {schema: 'EMAIL_SHA256', data: [[mary]]},
    }),
    'INVALID_ARGUMENT',
    /Remove payload/,
  );
  refused(
    await f.prepare('meta_custom_audience_id_users_create', '456', undefined, undefined, operator, {
      payload: {schema: 'EMAIL_SHA256', data: [[mary]]},
    }),
    'INVALID_ARGUMENT',
    /Remove payload/,
  );
  refused(await f.prepare('meta_custom_audience_id_users_create', '456', undefined, saudi), 'PERSONAL_DATA_REQUIRED');
  assert.equal(f.writes(), 0);
  noPeople(f.kept(), 'the store after refusals');
});

test('Meta’s terms and the list are read first: another account, another kind of list, a flagged list', async () => {
  const f = fixture({tos: 0});
  await enable(f);
  refused(await f.add(), 'PERSONAL_DATA_TERMS_NOT_ACCEPTED', /never accepts/);
  const g = fixture();
  await enable(g);
  refused(await g.add(emails, saudi, '457'), 'STATE_TARGET_MISMATCH');
  refused(await g.add(emails, saudi, '458'), 'INVALID_META_CUSTOMER_LIST', /customer list/);
  refused(await g.add(emails, saudi, '459'), 'INVALID_META_CUSTOMER_LIST', /flagged/);
  refused(await g.remove(emails, '459'), 'INVALID_META_CUSTOMER_LIST', /flagged/);
  refused(await g.add(emails, saudi, '460'), 'INVALID_META_CUSTOMER_LIST', /value-based/);
  assert.equal(g.writes(), 0);
});

test('an operator may run a removal; the platform’s echo of a value is never kept', async () => {
  const f = fixture();
  await enable(f);
  const p = ok(await f.remove());
  assert.equal(p.data.execute_requirements.owner_executes, undefined);
  assert.match(JSON.stringify(p.data.creative_impact), /Removes/);
  const done = ok(await f.execute(p, emails, operator));
  const sent = f.calls.find(c => c.method === 'DELETE' && c.path === '/v26.0/456/users');
  assert.equal(sent.body.payload.data.length, 2);
  assert.equal(done.data.data.num_received, 2);
  assert.equal(ok(await f.verify(p, operator)).data.status, 'verified');
  // A rejected upload: Meta's error may quote a value; the error kept and returned holds none.
  const q = ok(await f.add());
  f.reply(b =>
    Response.json(
      {
        error: {
          message: 'Invalid entry ' + b.payload.data[0][0] + ' for mary@example.com',
          code: 100,
          error_subcode: 1713230,
        },
      },
      {status: 400},
    ),
  );
  const r = await f.execute(q, emails);
  assert.equal(r.success, false);
  assert.match(JSON.stringify(r), /\[personal data\]/);
  noPeople(JSON.stringify(r), 'the error');
  noPeople(f.kept(), 'the store after an error');
});

test('an empty customer list is created without people, and read back', async () => {
  const f = fixture();
  const create = payload =>
    f.prepare('meta_ad_account_id_customaudiences_create', undefined, undefined, undefined, operator, payload);
  refused(await create({name: 'Customers', subtype: 'CUSTOM'}), 'INVALID_META_CUSTOMER_LIST', /customer_file_source/);
  const p = ok(
    await create({
      name: 'Customers',
      subtype: 'CUSTOM',
      customer_file_source: 'USER_PROVIDED_ONLY',
      description: 'CRM',
    }),
  );
  assert.match(JSON.stringify(p.data.creative_impact), /no people/);
  ok(await f.execute(p, undefined, operator));
  assert.equal(ok(await f.verify(p, operator)).data.status, 'verified');
  // Lookalikes stay with their own family.
  const l = await create({
    name: 'Similar',
    subtype: 'LOOKALIKE',
    origin_audience_id: '456',
    lookalike_spec: {ratio: 0.01, country: 'SA'},
  });
  assert.notEqual(l.error?.code, 'INVALID_META_CUSTOMER_LIST');
});

test('a rejected native payload cannot persist raw people in the service error audit', async () => {
  const f = fixture();
  await enable(f);
  const raw = '+201001234567';
  const result = await f.prepare('meta_custom_audience_id_users_create', '456', undefined, undefined, operator, {
    payload: {schema: ['PHONE'], data: [[raw, 'Synthetic Person']]},
  });
  assert.equal(result.success, false);
  assert.equal(f.writes(), 0);
  for (const value of [raw, 'Synthetic Person'])
    assert.equal(f.kept().includes(value), false, 'the error audit contains misplaced personal data');
});

test('malformed confirmation fields cannot persist identifying keys or values in the error audit', async () => {
  const f = fixture();
  await enable(f);
  const result = await f.add(emails, {...saudi, 'mary@example.com': '+201001234567'});
  refused(result, 'INVALID_ARGUMENT');
  noPeople(JSON.stringify(result), 'the confirmation error');
  noPeople(f.kept(), 'the confirmation error audit');
  assert.equal(f.kept().includes('+201001234567'), false);
  assert.equal(f.writes(), 0);
});

test('the ledger records the family, and replacing a whole list stays blocked with its reason', () => {
  const rows = actionContracts(registry);
  for (const action of ['meta_custom_audience_id_users_create', 'meta_custom_audience_id_users_delete']) {
    const row = rows.find(r => r.gateway === gateway && r.action === action);
    assert.equal(row?.status, 'reviewed_write_family', action);
    assert.equal(row.family, 'meta_customer_lists', action);
  }
  const replace = rows.find(r => r.gateway === gateway && r.action === 'meta_custom_audience_id_usersreplace_create');
  assert.equal(replace.status, 'blocked_write');
  assert.match(replace.reason, /90 minutes/);
});
