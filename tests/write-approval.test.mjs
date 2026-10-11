import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {approvalView, approveReview} from '../dist/src/write-approval.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

/**
 * WRT-09 (owner decisions P1 and P5): an owner-selectable human approval mode for spending, cap-override and deletion
 * executions (default off), the opt-in destructive_confirmed tier, and owner-only execution beyond a cap. The approval
 * is minted only on the website, bound to the review's fingerprint and approver; synthetic providers only.
 */
const TIKTOK = '13131313-1313-4131-8131-131313131313',
  gateway = 'tiktok_native_action',
  account = '123',
  tenant = 'write-approval';
const operator = {tenantId: tenant, userId: 'operator', role: 'operator'},
  colleague = {tenantId: tenant, userId: 'colleague', role: 'operator'},
  owner = {tenantId: tenant, userId: 'owner', role: 'admin'},
  key = Buffer.alloc(32, 57).toString('base64');

/** A TikTok ad group with a lifetime budget of 1000, and a budget update that changes spending. */
function tiktok() {
  const store = new Store(':memory:', key);
  store.putConnection(
    owner,
    {
      id: TIKTOK,
      tenantId: tenant,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const group = {
      adgroup_id: '700',
      campaign_id: '70',
      advertiser_id: account,
      adgroup_name: 'Lifetime A',
      budget_mode: 'BUDGET_MODE_TOTAL',
      budget: 1000,
      scheduled_budget: 0,
      campaign_automation_type: 'MANUAL',
      operation_status: 'DISABLE',
    },
    writes = [];
  let n = 0;
  const transport = new NativeTransport(async (raw, init = {}) => {
    const url = new URL(String(raw)),
      method = init.method ?? 'GET';
    if (method === 'GET' && url.pathname === '/open_api/v1.3/adgroup/get/')
      return Response.json({
        code: 0,
        message: 'OK',
        request_id: 'r' + ++n,
        data: {list: [{...group}], page_info: {page: 1, page_size: 100, total_number: 1, total_page: 1}},
      });
    if (method === 'POST' && url.pathname === '/open_api/v1.3/adgroup/budget/update/') {
      writes.push(JSON.parse(init.body));
      group.budget = JSON.parse(init.body).budget[0].budget;
      return Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data: {}});
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + url.pathname);
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
  });
  const prepare = (budget, as = operator) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        connection_id: TIKTOK,
        arguments: {
          action: 'tiktok_adgroup_budget_update',
          account_id: account,
          payload: {budget: [{adgroup_id: '700', budget}]},
        },
      },
      as,
    );
  const execute = (id, extra = {}, as = operator) =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: id, confirmed: true, spend_change_confirmed: true, ...extra},
      as,
    );
  const workspacePolicy = policy => saveSpendPolicy(store, owner, {scope: 'workspace', confirmed: true, policy});
  const accountPolicy = policy =>
    saveSpendPolicy(store, owner, {gateway, account_id: account, confirmed: true, policy});
  const audit = () => store.audit(tenant, 1000).map(row => JSON.parse(row.event));
  return {store, service, writes, prepare, execute, workspacePolicy, accountPolicy, audit};
}

test('WRT-09: with the default assistant_ack, a spend change executes on the acknowledgements alone (unchanged)', async () => {
  const f = tiktok();
  try {
    f.accountPolicy({max_budget_native: 5000});
    const r = await f.prepare(1100);
    assert.equal(r.success, true, JSON.stringify(r.error));
    assert.equal(r.data.approval, undefined, 'no website approval is asked for');
    assert.equal(r.data.execute_requirements.destructive_confirmed, undefined);
    const done = await f.execute(r.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done.error));
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('WRT-09 website_approval: execute without a website approval is refused with website_path; an approval of this exact review lets it run once', async () => {
  const f = tiktok();
  try {
    f.workspacePolicy({approval_mode: 'website_approval'});
    const r = await f.prepare(1100);
    assert.equal(r.success, true, JSON.stringify(r.error));
    assert.deepEqual(r.data.approval.classes, ['spend_affecting']);
    assert.equal(r.data.approval.website_path, '/operations?approve=' + r.data.review_id);
    const refused = await f.execute(r.data.review_id);
    assert.equal(refused.error.code, 'HUMAN_APPROVAL_REQUIRED');
    assert.equal(refused.error.details.website_path, '/operations?approve=' + r.data.review_id);
    assert.equal(refused.error.details.submission, 'not_sent');
    assert.match(refused.error.remedy.action, /website_path/);
    assert.equal(f.writes.length, 0);
    // The page shows the review without its body, and the approval posts back the fingerprint it showed.
    const view = approvalView(f.store, colleague, r.data.review_id);
    assert.equal(view.may_approve, true);
    assert.equal(view.fingerprint, r.data.fingerprint);
    assert.equal(JSON.stringify(view).includes('budget/update'), false);
    assert.throws(
      () => approveReview(f.store, colleague, r.data.review_id, {fingerprint: 'another', confirmed: true}),
      e => e.code === 'REVIEW_CHANGED',
    );
    assert.throws(
      () => approveReview(f.store, colleague, r.data.review_id, {fingerprint: view.fingerprint}),
      e => e.code === 'APPROVAL_CONFIRMATION_REQUIRED',
    );
    // A reader cannot approve.
    assert.throws(
      () =>
        approveReview(f.store, {...colleague, role: 'reader'}, r.data.review_id, {
          fingerprint: view.fingerprint,
          confirmed: true,
        }),
      e => e.code === 'FORBIDDEN',
    );
    approveReview(f.store, colleague, r.data.review_id, {fingerprint: view.fingerprint, confirmed: true});
    const done = await f.execute(r.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done.error));
    assert.equal(f.writes.length, 1);
    const events = f.audit();
    assert.ok(events.some(e => e.event === 'write_approved' && e.approver === 'colleague'));
    assert.ok(events.some(e => e.event === 'write_approval_presented' && e.approver === 'colleague'));
    // The review is executed once: a second execute replays, and the page no longer offers an approval.
    assert.equal((await f.execute(r.data.review_id)).data.replayed, true);
    assert.equal(f.writes.length, 1);
    assert.equal(approvalView(f.store, colleague, r.data.review_id).refusal.code, 'REVIEW_ALREADY_EXECUTED');
  } finally {
    f.store.close();
  }
});

test('WRT-09: an approval bound to another fingerprint is refused at execute and nothing is sent', async () => {
  const f = tiktok();
  try {
    f.workspacePolicy({approval_mode: 'website_approval'});
    const r = await f.prepare(1100);
    f.store.putDocument(tenant, 'write_approval', r.data.review_id, {
      review_id: r.data.review_id,
      fingerprint: 'a-different-request',
      approver: 'colleague',
      approver_principal: 'colleague',
      approver_is_owner: false,
      approved_at: Date.now(),
    });
    const refused = await f.execute(r.data.review_id);
    assert.equal(refused.error.code, 'HUMAN_APPROVAL_REQUIRED');
    assert.equal(refused.error.details.reason, 'approval_fingerprint_mismatch');
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('WRT-09 distinct_approver: the person who prepared a review cannot approve it; another member or the owner can', async () => {
  const f = tiktok();
  try {
    f.workspacePolicy({approval_mode: 'distinct_approver'});
    const r = await f.prepare(1100);
    const own = approvalView(f.store, operator, r.data.review_id);
    assert.equal(own.may_approve, false);
    assert.equal(own.refusal.code, 'DISTINCT_APPROVER_REQUIRED');
    assert.throws(
      () => approveReview(f.store, operator, r.data.review_id, {fingerprint: own.fingerprint, confirmed: true}),
      e => e.code === 'DISTINCT_APPROVER_REQUIRED',
    );
    // An approval recorded for the preparer (not through the website check) is still refused at execute.
    f.store.putDocument(tenant, 'write_approval', r.data.review_id, {
      review_id: r.data.review_id,
      fingerprint: own.fingerprint,
      approver: 'operator',
      approver_principal: 'operator',
      approver_is_owner: false,
      approved_at: Date.now(),
    });
    assert.equal((await f.execute(r.data.review_id)).error.details.reason, 'approver_prepared_it');
    approveReview(f.store, colleague, r.data.review_id, {fingerprint: own.fingerprint, confirmed: true});
    assert.equal((await f.execute(r.data.review_id)).success, true);
    // The owner may approve a review the owner prepared.
    const mine = await f.prepare(1200, owner);
    approveReview(f.store, owner, mine.data.review_id, {fingerprint: mine.data.fingerprint, confirmed: true});
    assert.equal((await f.execute(mine.data.review_id, {}, owner)).success, true);
    assert.equal(f.writes.length, 2);
  } finally {
    f.store.close();
  }
});

test('P5: only the workspace owner executes beyond a cap under confirm, or approves it on the website first', async () => {
  // Before WRT-09 any operator could exceed an owner cap by sending cap_override_confirmed=true.
  const f = tiktok();
  try {
    f.accountPolicy({max_budget_native: 950});
    const r = await f.prepare(1200);
    assert.equal(r.data.execute_requirements.cap_override_confirmed, true);
    assert.equal(r.data.approval.owner_required, 'cap_override');
    const refused = await f.execute(r.data.review_id, {cap_override_confirmed: true});
    assert.equal(refused.error.code, 'CAP_OVERRIDE_OWNER_REQUIRED');
    assert.equal(refused.error.details.website_path, '/operations?approve=' + r.data.review_id);
    assert.equal(f.writes.length, 0);
    assert.equal(
      f.audit().some(e => e.event === 'spend_cap_exceeded_with_confirmation'),
      false,
      'nothing was reserved or audited as an override',
    );
    // A colleague's approval is not the owner's.
    assert.throws(
      () => approveReview(f.store, colleague, r.data.review_id, {fingerprint: r.data.fingerprint, confirmed: true}),
      e => e.code === 'OWNER_REQUIRED',
    );
    approveReview(f.store, owner, r.data.review_id, {fingerprint: r.data.fingerprint, confirmed: true});
    const done = await f.execute(r.data.review_id, {cap_override_confirmed: true});
    assert.equal(done.success, true, JSON.stringify(done.error));
    assert.equal(f.writes.length, 1);
    // The owner may execute an operator's review beyond a cap directly.
    const second = await f.prepare(1300);
    assert.equal((await f.execute(second.data.review_id, {cap_override_confirmed: true}, owner)).success, true);
    assert.equal(f.writes.length, 2);
  } finally {
    f.store.close();
  }
});

test('P5: the opt-in destructive_confirmed tier is named at prepare and required at execute; off, nothing changes', async () => {
  const store = new Store(':memory:', key),
    xGateway = 'x_ads_native_action',
    connection = {
      id: 'x-connection',
      tenantId: tenant,
      gateway: xGateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic X',
      scopes: [],
    };
  store.putConnection(owner, connection, {
    consumerKey: 'synthetic',
    consumerSecret: 'synthetic',
    accessToken: 'synthetic',
    tokenSecret: 'synthetic',
  });
  store.rememberResource(connection, account, '111');
  let writes = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init = {}) => {
      const id = new URL(String(raw)).pathname.split('/').at(-1);
      if ((init.method ?? 'GET') !== 'GET') {
        writes++;
        return Response.json({data: {id, deleted: true}});
      }
      return Response.json({data: {id, name: 'Draft', entity_status: 'PAUSED'}});
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true},
  );
  const prepare = () =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway: xGateway,
        arguments: {
          action: 'x_accounts_account_id_campaigns_campaign_id_delete',
          account_id: account,
          path_params: {campaign_id: '111'},
        },
      },
      operator,
    );
  const execute = (id, extra = {}) =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: id, confirmed: true, spend_change_confirmed: true, ...extra},
      operator,
    );
  try {
    const off = await prepare();
    assert.equal(off.success, true, JSON.stringify(off.error));
    assert.equal(off.data.execute_requirements.destructive_confirmed, undefined, 'the tier is off by default');
    saveSpendPolicy(store, owner, {
      gateway: xGateway,
      account_id: account,
      confirmed: true,
      policy: {allow_deletion: true, require_destructive_confirmation: true},
    });
    // A review prepared before the owner turned the tier on is held to it at execute too.
    assert.equal((await execute(off.data.review_id)).error.code, 'DESTRUCTIVE_CONFIRMATION_REQUIRED');
    const r = await prepare();
    assert.equal(r.data.execute_requirements.destructive_confirmed, true);
    assert.ok(r.data.execute_requirements.reasons.some(x => x.flag === 'destructive_confirmed'));
    assert.equal(r.data.effect, 'destructive');
    const refused = await execute(r.data.review_id);
    assert.equal(refused.error.code, 'DESTRUCTIVE_CONFIRMATION_REQUIRED');
    assert.match(refused.error.remedy.action, /destructive_confirmed=true/);
    assert.equal(writes, 0);
    assert.equal(
      (
        await service.call(
          'amcp_write',
          {action: 'prepare', gateway: xGateway, destructive_confirmed: true, arguments: {}},
          operator,
        )
      ).error.code,
      'INVALID_ARGUMENT',
      'destructive_confirmed is an execute acknowledgement only',
    );
    const done = await execute(r.data.review_id, {destructive_confirmed: true});
    assert.equal(done.success, true, JSON.stringify(done.error));
    assert.equal(writes, 1);
  } finally {
    store.close();
  }
});

test('WRT-09: approval_mode accepts only its three modes', () => {
  const f = tiktok();
  try {
    assert.throws(
      () => f.workspacePolicy({approval_mode: 'anyone'}),
      e => e.code === 'INVALID_POLICY',
    );
    assert.throws(
      () => f.accountPolicy({require_destructive_confirmation: 'yes'}),
      e => e.code === 'INVALID_POLICY',
    );
    assert.equal(f.workspacePolicy({approval_mode: 'distinct_approver'}).approval_mode, 'distinct_approver');
  } finally {
    f.store.close();
  }
});

test('WRT-09 website: only a signed-in session with CSRF approves; the MCP tool has no approve action', async () => {
  const origin = 'https://amcp.shop',
    master = Buffer.alloc(32, 59).toString('base64'),
    password = 'synthetic-approval-password';
  const store = new Store(':memory:', master);
  const admin = {tenantId: 'local', userId: 'test', role: 'admin'};
  store.putConnection(
    admin,
    {
      id: TIKTOK,
      tenantId: 'local',
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init = {}) => {
      if ((init.method ?? 'GET') !== 'GET') throw new Error('No write in this test');
      return Response.json({
        code: 0,
        message: 'OK',
        request_id: 'r',
        data: {
          list: [
            {
              adgroup_id: '700',
              campaign_id: '70',
              advertiser_id: account,
              adgroup_name: 'Lifetime A',
              budget_mode: 'BUDGET_MODE_TOTAL',
              budget: 1000,
              scheduled_budget: 0,
              campaign_automation_type: 'MANUAL',
              operation_status: 'DISABLE',
            },
          ],
          page_info: {page: 1, page_size: 100, total_number: 1, total_page: 1},
        },
      });
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const blocked = async () => {
    throw Error('No vendor network requests are permitted in approval tests.');
  };
  const listener = await listenForFetch(
    createHttpApp(service, store, {website: {origin, masterKey: master, adminPassword: password, fetcher: blocked}}),
  );
  const base = 'http://127.0.0.1:' + listener.address().port;
  const request = (url, method = 'GET', body, headers = {}) =>
    fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {Origin: origin, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    saveSpendPolicy(store, admin, {scope: 'workspace', confirmed: true, policy: {approval_mode: 'website_approval'}});
    const prepared = await service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        connection_id: TIKTOK,
        arguments: {
          action: 'tiktok_adgroup_budget_update',
          account_id: account,
          payload: {budget: [{adgroup_id: '700', budget: 1100}]},
        },
      },
      {tenantId: 'local', userId: 'oauth/client', role: 'operator'},
    );
    assert.equal(prepared.success, true, JSON.stringify(prepared.error));
    const id = prepared.data.review_id;
    // An AI client cannot approve: amcp_write has no such action.
    const viaTool = await service.call('amcp_write', {action: 'approve', review_id: id}, admin);
    assert.equal(viaTool.success, false);
    const login = await request('/api/session', 'POST', {password}),
      session = await login.json();
    const headers = {Cookie: login.headers.get('set-cookie').split(';')[0], 'X-AMCP-CSRF': session.csrf};
    const route = '/api/write-approvals/' + id;
    assert.equal((await request(route)).status, 401);
    const view = await (await request(route, 'GET', undefined, headers)).json();
    assert.equal(view.may_approve, true, JSON.stringify(view));
    assert.equal(
      (await request(route, 'POST', {fingerprint: view.fingerprint, confirmed: true}, {Cookie: headers.Cookie})).status,
      403,
      'no CSRF token, no approval',
    );
    const approved = await request(route, 'POST', {fingerprint: view.fingerprint, confirmed: true}, headers);
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).approval.approver_is_owner, true);
    assert.equal(store.document('local', 'write_approval', id).fingerprint, prepared.data.fingerprint);
  } finally {
    await new Promise(resolve => listener.close(() => resolve()));
    store.close();
  }
});
