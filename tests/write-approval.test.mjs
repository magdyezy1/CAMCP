import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {approvalView, approveReview} from '../dist/src/write-approval.js';
import {reviewFriction} from '../dist/src/review-friction.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {
  admin as snapAdmin,
  createPlan,
  fixture as snapchatPlan,
  squadPlan,
} from '../dist/tests/snapchat-plan-fixture.js';

/**
 * WRT-09 (owner questions P1 and P5, open): an owner-selectable human approval mode for spending, cap-override and
 * deletion executions (default off), the opt-in destructive_confirmed tier, and the opt-in owner-only execution beyond a
 * cap (cap_override_owner_only). The approval is minted only on the website, bound to the review's fingerprint and
 * approver; synthetic providers only.
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

test('WRT-09 distinct_approver: a review prepared through a door or a key approved from one needs the owner’s approval', async () => {
  // Regression (wave 3a review): every door sign-in and every key approved from a door is the one principal
  // `workspace-admin`, so the person behind such a review could approve it with their own member sign-in and be counted
  // as another member. AMCP cannot tell them apart, so only the owner's approval is distinct.
  const f = tiktok(),
    doorKey = {tenantId: tenant, userId: 'oauth/door-approved-client', role: 'operator'};
  try {
    f.workspacePolicy({approval_mode: 'distinct_approver'});
    const r = await f.prepare(1100, doorKey);
    assert.equal(r.success, true, JSON.stringify(r.error));
    const view = approvalView(f.store, colleague, r.data.review_id);
    assert.equal(view.may_approve, false);
    assert.equal(view.refusal.code, 'DISTINCT_APPROVER_REQUIRED');
    assert.throws(
      () => approveReview(f.store, colleague, r.data.review_id, {fingerprint: view.fingerprint, confirmed: true}),
      e => assertRefused(e, 'DISTINCT_APPROVER_REQUIRED'),
    );
    // A member's approval recorded before this rule (not through the website check) is refused at execute.
    f.store.putDocument(tenant, 'write_approval', r.data.review_id, {
      review_id: r.data.review_id,
      fingerprint: view.fingerprint,
      approver: 'colleague',
      approver_principal: 'colleague',
      approver_is_owner: false,
      approved_at: Date.now(),
    });
    const refused = await f.execute(r.data.review_id, {}, doorKey);
    assertRefused(refused, 'HUMAN_APPROVAL_REQUIRED', {writes: () => f.writes.length});
    assert.equal(refused.error.details.reason, 'preparer_unidentified');
    // The owner's approval replaces it and the review runs once.
    assert.equal(approvalView(f.store, owner, r.data.review_id).may_approve, true);
    approveReview(f.store, owner, r.data.review_id, {fingerprint: view.fingerprint, confirmed: true});
    assert.equal((await f.execute(r.data.review_id, {}, doorKey)).success, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('P5 default: without cap_override_owner_only an operator executes beyond a cap on the acknowledgement, as before WRT-09', async () => {
  // Regression (wave 3a review): WRT-09 had made owner-only execution beyond a cap always on, which no owner decision
  // backs (P5 is open); it is an opt-in setting now, and the owner may not run a member's review without it.
  const f = tiktok();
  try {
    f.accountPolicy({max_budget_native: 950});
    const r = await f.prepare(1200);
    assert.equal(r.data.execute_requirements.cap_override_confirmed, true);
    assert.equal(r.data.approval, undefined, 'no owner approval is named');
    const status = await f.service.call('amcp_write', {action: 'status', review_id: r.data.review_id}, operator);
    assert.equal(status.data.approval, undefined);
    assert.equal(approvalView(f.store, owner, r.data.review_id).refusal.code, 'APPROVAL_NOT_REQUIRED');
    // The owner does not take over a member's review beyond a cap unless the opt-in makes it the owner's to run.
    assertRefused(await f.execute(r.data.review_id, {cap_override_confirmed: true}, owner), 'FORBIDDEN', {
      message: /belongs to a different actor/,
      writes: () => f.writes.length,
    });
    const done = await f.execute(r.data.review_id, {cap_override_confirmed: true});
    assert.equal(done.success, true, JSON.stringify(done.error));
    assert.equal(f.writes.length, 1);
    assert.ok(f.audit().some(e => e.event === 'spend_cap_exceeded_with_confirmation'));
    // The workspace default's opt-in applies to an account whose own policy does not set it (stricter of the two).
    f.workspacePolicy({cap_override_owner_only: true});
    const after = await f.prepare(1300);
    assert.equal(after.data.approval.owner_required, 'cap_override');
    assertRefused(await f.execute(after.data.review_id, {cap_override_confirmed: true}), 'CAP_OVERRIDE_OWNER_REQUIRED');
    assert.equal(f.writes.length, 1);
    assert.throws(
      () => f.accountPolicy({cap_override_owner_only: 'yes'}),
      e => e.code === 'INVALID_POLICY',
    );
  } finally {
    f.store.close();
  }
});

test('P5 opt-in: under cap_override_owner_only only the workspace owner executes beyond a cap under confirm, or approves it on the website first', async () => {
  // Without the opt-in any operator exceeds an owner cap by sending cap_override_confirmed=true (the default, above).
  const f = tiktok();
  try {
    f.accountPolicy({max_budget_native: 950, cap_override_owner_only: true});
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

test('P5 opt-in: a cap crossed only after prepare is refused for anyone but the owner, and the change is prepared again', async () => {
  // The review did not name the cap, so the approval page has nothing for the owner to approve: the refusal says to
  // prepare again instead of pointing at an approval that cannot be given.
  const f = tiktok();
  try {
    f.accountPolicy({max_budget_native: 5000, cap_override_owner_only: true});
    const r = await f.prepare(1100);
    assert.equal(r.data.approval, undefined);
    f.accountPolicy({max_budget_native: 1050, cap_override_owner_only: true});
    const refused = await f.execute(r.data.review_id, {cap_override_confirmed: true});
    assert.equal(refused.error.code, 'CAP_OVERRIDE_OWNER_REQUIRED', JSON.stringify(refused.error));
    assert.equal(refused.error.details.prepare_again, true);
    assert.equal(refused.error.details.website_path, undefined);
    assert.equal(f.writes.length, 0);
    const again = await f.prepare(1100);
    assert.equal(again.data.approval.owner_required, 'cap_override');
    approveReview(f.store, owner, again.data.review_id, {fingerprint: again.data.fingerprint, confirmed: true});
    const done = await f.execute(again.data.review_id, {cap_override_confirmed: true});
    assert.equal(done.success, true, JSON.stringify(done.error));
    assert.equal(f.writes.length, 1);
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
    // A refusal case, built so it is not read as a documented call: the flag is an execute acknowledgement only.
    const atPrepare = {action: 'prepare', gateway: xGateway, arguments: {}};
    atPrepare.destructive_confirmed = true;
    assert.equal((await service.call('amcp_write', atPrepare, operator)).error.code, 'INVALID_ARGUMENT');
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

test('WRT-09: an approval needs two-step verification where the workspace requires it, and stays in its workspace', async () => {
  // Refusals of the approval itself: a session without two-step under a workspace two-step policy (P2), and a member
  // of another workspace, who can neither see nor approve the review. Neither records an approval or sends anything.
  const f = tiktok();
  try {
    f.workspacePolicy({approval_mode: 'website_approval'});
    const r = await f.prepare(1100);
    const approve = as => () =>
      approveReview(f.store, as, r.data.review_id, {fingerprint: r.data.fingerprint, confirmed: true});
    assert.throws(approve({...colleague, mfaPolicy: true}), e => assertRefused(e, 'MFA_STEP_REQUIRED', {status: 403}));
    const elsewhere = {...colleague, tenantId: 'another-workspace'};
    assert.throws(
      () => approvalView(f.store, elsewhere, r.data.review_id),
      e => assertRefused(e, 'NOT_FOUND', {status: 404}),
    );
    assert.throws(approve(elsewhere), e => assertRefused(e, 'NOT_FOUND', {status: 404}));
    assert.equal(f.store.db.prepare("SELECT 1 FROM documents WHERE kind='write_approval'").get(), undefined);
    assertRefused(await f.execute(r.data.review_id), 'HUMAN_APPROVAL_REQUIRED', {writes: () => f.writes.length});
    // With two-step verified the same member approves, and the review runs once.
    approve({...colleague, mfaPolicy: true, mfaVerified: true})();
    const done = await f.execute(r.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done.error));
    assert.equal(f.writes.length, 1);
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
    // An AI client cannot approve: amcp_write has no such action, and nothing is recorded.
    assertRefused(await service.call('amcp_write', {action: 'approve', review_id: id}, admin), 'INVALID_ARGUMENT');
    assert.equal(store.db.prepare("SELECT 1 FROM documents WHERE kind='write_approval'").get(), undefined);
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

test('WRT-09: an account policy saved for its caps keeps the workspace default approval mode; an account can add to it', async () => {
  // Regression: an account's own spending policy used to replace the workspace default, so setting caps on an account
  // silently turned the owner's website approval off for it.
  const f = tiktok();
  try {
    f.workspacePolicy({approval_mode: 'website_approval'});
    f.accountPolicy({max_budget_native: 5000});
    const r = await f.prepare(1100);
    assert.equal(r.success, true, JSON.stringify(r.error));
    assert.equal(r.data.approval.mode, 'website_approval');
    assert.equal((await f.execute(r.data.review_id)).error.code, 'HUMAN_APPROVAL_REQUIRED');
    assert.equal(f.writes.length, 0);
    // The stricter setting wins in both directions: an account may require more than the default, never less.
    f.accountPolicy({max_budget_native: 5000, approval_mode: 'distinct_approver'});
    assert.equal((await f.prepare(1150)).data.approval.mode, 'distinct_approver');
    f.accountPolicy({max_budget_native: 5000, approval_mode: 'assistant_ack'});
    assert.equal((await f.prepare(1160)).data.approval.mode, 'website_approval');
  } finally {
    f.store.close();
  }
});

test('WRT-09: an expired review is refused as expired, not sent to a person for approval', async () => {
  // Regression: the approval check ran before the expiry check, so an expired review asked for a website approval the
  // approval page then refused.
  const f = tiktok();
  try {
    f.workspacePolicy({approval_mode: 'website_approval'});
    const r = await f.prepare(1100);
    f.store.db
      .prepare("UPDATE documents SET data=json_set(data,'$.expires_at',?) WHERE kind='write_review' AND id=?")
      .run(Date.now() - 1000, r.data.review_id);
    assert.equal((await f.execute(r.data.review_id)).error.code, 'REVIEW_EXPIRED');
    assert.equal(approvalView(f.store, colleague, r.data.review_id).refusal.code, 'REVIEW_EXPIRED');
    assert.throws(
      () => approveReview(f.store, colleague, r.data.review_id, {fingerprint: r.data.fingerprint, confirmed: true}),
      e => e.code === 'REVIEW_EXPIRED',
    );
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('WRT-09: a review is approved once; only the owner replaces a member approval where a cap needs the owner', async () => {
  const f = tiktok();
  try {
    f.accountPolicy({max_budget_native: 950, approval_mode: 'website_approval', cap_override_owner_only: true});
    const r = await f.prepare(1200);
    assert.deepEqual(r.data.approval.classes, ['spend_affecting', 'cap_override']);
    assert.equal(r.data.approval.owner_required, 'cap_override');
    approveReview(f.store, colleague, r.data.review_id, {fingerprint: r.data.fingerprint, confirmed: true});
    // A second member cannot replace it.
    const second = {...colleague, userId: 'second'};
    assert.equal(approvalView(f.store, second, r.data.review_id).refusal.code, 'REVIEW_ALREADY_APPROVED');
    assert.throws(
      () => approveReview(f.store, second, r.data.review_id, {fingerprint: r.data.fingerprint, confirmed: true}),
      e => e.code === 'REVIEW_ALREADY_APPROVED',
    );
    // The member's approval meets the mode, not the owner rule beyond a cap.
    const refused = await f.execute(r.data.review_id, {cap_override_confirmed: true});
    assert.equal(refused.error.code, 'CAP_OVERRIDE_OWNER_REQUIRED', JSON.stringify(refused.error));
    assert.equal(f.writes.length, 0);
    const forOwner = approvalView(f.store, owner, r.data.review_id);
    assert.equal(forOwner.may_approve, true);
    assert.equal(forOwner.approval_pending, true);
    assert.equal(forOwner.approval.approver, 'colleague');
    approveReview(f.store, owner, r.data.review_id, {fingerprint: r.data.fingerprint, confirmed: true});
    assert.equal(approvalView(f.store, owner, r.data.review_id).refusal.code, 'REVIEW_ALREADY_APPROVED');
    const done = await f.execute(r.data.review_id, {cap_override_confirmed: true});
    assert.equal(done.success, true, JSON.stringify(done.error));
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('WRT-09: an approval that no longer meets the mode is refused at execute and may be replaced by another member', async () => {
  const f = tiktok();
  try {
    f.workspacePolicy({approval_mode: 'website_approval'});
    const r = await f.prepare(1100);
    // Under website_approval the person who prepared it may approve it on the website.
    approveReview(f.store, operator, r.data.review_id, {fingerprint: r.data.fingerprint, confirmed: true});
    f.workspacePolicy({approval_mode: 'distinct_approver'});
    const refused = await f.execute(r.data.review_id);
    assert.equal(refused.error.details.reason, 'approver_prepared_it');
    assert.equal(f.writes.length, 0);
    const view = approvalView(f.store, colleague, r.data.review_id);
    assert.equal(view.may_approve, true);
    assert.equal(view.approval_pending, true);
    approveReview(f.store, colleague, r.data.review_id, {fingerprint: r.data.fingerprint, confirmed: true});
    assert.equal((await f.execute(r.data.review_id)).success, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('WRT-09: amcp_write status says whether a person has approved the review, without a provider request', async () => {
  const f = tiktok();
  try {
    f.workspacePolicy({approval_mode: 'website_approval'});
    const r = await f.prepare(1100);
    const status = id => f.service.call('amcp_write', {action: 'status', review_id: id}, operator);
    const before = await status(r.data.review_id);
    assert.equal(before.success, true, JSON.stringify(before.error));
    assert.equal(before.data.approval.approved, false);
    assert.equal(before.data.approval.website_path, '/operations?approve=' + r.data.review_id);
    assert.deepEqual(before.data.approval.classes, ['spend_affecting']);
    approveReview(f.store, colleague, r.data.review_id, {fingerprint: r.data.fingerprint, confirmed: true});
    const after = await status(r.data.review_id);
    assert.equal(after.data.approval.approved, true);
    assert.equal(after.data.approval.approver_is_owner, false);
    assert.equal(after.data.network_requests, 0);
    // Without an approval mode the status names none.
    f.workspacePolicy({approval_mode: 'assistant_ack'});
    assert.equal((await status((await f.prepare(1200)).data.review_id)).data.approval, undefined);
  } finally {
    f.store.close();
  }
});

test('WRT-09: a group is approved once as a whole; a part opens its group and the approval covers every part', async () => {
  // Regression: a cap only the parts together cross is the group's own acknowledgement, which no part's check saw, so
  // such a group ran under website_approval without any approval.
  const f = googleBudgetFixture();
  try {
    saveSpendPolicy(f.store, f.actor, {
      scope: 'workspace',
      confirmed: true,
      policy: {approval_mode: 'website_approval'},
    });
    f.spendPolicy({max_daily_increase_native: 1400000000});
    const review = await f.creates(30, 50000000);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 800));
    assert.equal(review.data.group, true);
    const group = review.data.review_id;
    assert.deepEqual(review.data.approval.classes, ['cap_override']);
    assert.equal(review.data.approval.website_path, '/operations?approve=' + group);
    const refused = await f.execute(group, {cap_override_confirmed: true});
    assert.equal(refused.error.code, 'HUMAN_APPROVAL_REQUIRED', JSON.stringify(refused.error));
    assert.equal(refused.error.details.review_id, group);
    assert.equal(f.writes.length, 0);
    // A part's own page is its group's: one approval, bound to every part's fingerprint.
    const view = approvalView(f.store, f.actor, review.data.parts[1].review_id);
    assert.equal(view.review_id, group);
    assert.equal(view.group, true);
    assert.equal(view.parts, 2);
    assert.equal(view.records, 30);
    assert.deepEqual(view.classes, ['cap_override']);
    approveReview(f.store, f.actor, review.data.parts[0].review_id, {fingerprint: view.fingerprint, confirmed: true});
    assert.equal(f.store.document(f.actor.tenantId, 'write_approval', group).fingerprint, view.fingerprint);
    const done = await f.execute(group, {cap_override_confirmed: true});
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
    assert.ok(f.audit().some(e => e.event === 'write_approval_presented'));
    assert.deepEqual(
      f.writes.map(w => w.operations.length),
      [25, 5],
    );
  } finally {
    f.close();
  }
});

test('WRT-09: run stops at a plan step that needs a website approval, names its page, and continues once approved', async () => {
  const f = snapchatPlan();
  try {
    saveSpendPolicy(f.store, snapAdmin, {
      scope: 'workspace',
      confirmed: true,
      policy: {approval_mode: 'website_approval'},
    });
    const id = (await createPlan(f, squadPlan(3))).data.id;
    const summary = (await f.call('amcp_campaign', {action: 'approve', id})).data;
    await f.call('amcp_campaign', {...summary.next_call.arguments, ...summary.next_call.add_after_user_approval});
    const ran = await f.call('amcp_campaign', {action: 'run', id});
    assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 800));
    assert.equal(ran.data.run.stopped, 'needs_website_approval', JSON.stringify(ran.data.run));
    assert.equal(f.writes.length, 1, 'the campaign, which changes no spending, ran; the ad squad was not sent');
    const step = f.store.document('snap-plan', 'campaign_run', id).steps.find(s => s.id === 'squad_1');
    assert.equal(ran.data.run.website_path, '/operations?approve=' + step.review_id);
    assert.equal(ran.data.run.next_call.arguments.action, 'run');
    const view = approvalView(f.store, snapAdmin, step.review_id);
    approveReview(f.store, snapAdmin, step.review_id, {fingerprint: view.fingerprint, confirmed: true});
    const next = await f.call('amcp_campaign', {action: 'run', id});
    // squad_1 ran under its approval; squad_2 is its own review and waits for its own.
    assert.equal(next.data.run.stopped, 'needs_website_approval', JSON.stringify(next.data.run));
    assert.equal(f.writes.length, 2);
  } finally {
    f.close();
  }
});

test('WRT-09: the owner friction report counts website approvals, their latency and the refusals that waited', async () => {
  const f = tiktok();
  try {
    f.workspacePolicy({approval_mode: 'website_approval'});
    const r = await f.prepare(1100);
    assert.equal((await f.execute(r.data.review_id)).error.code, 'HUMAN_APPROVAL_REQUIRED');
    approveReview(f.store, colleague, r.data.review_id, {fingerprint: r.data.fingerprint, confirmed: true});
    assert.equal((await f.execute(r.data.review_id)).success, true);
    const report = reviewFriction(f.store, tenant);
    assert.equal(report.approvals.approved, 1);
    assert.equal(report.approvals.by_owner, 0);
    assert.equal(report.approvals.latency_ms.count, 1);
    assert.equal(report.approvals.refusals.HUMAN_APPROVAL_REQUIRED, 1);
    assert.equal(report.approvals.refusals.CAP_OVERRIDE_OWNER_REQUIRED, 0);
    assert.equal(report.approvals.per_100_prepares, 100);
  } finally {
    f.store.close();
  }
});

test('WRT-09 approval page: it posts back the fingerprint it showed, after the person confirms, and says what is pending', async () => {
  const requests = [],
    confirmations = [],
    bindings = new Map();
  const status = {textContent: ''},
    root = {innerHTML: '', isConnected: true, setAttribute() {}, removeAttribute() {}, querySelector: () => status};
  const escape = v =>
    String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('"', '&quot;');
  const c = createContext({
    document: {addEventListener() {}},
    $: () => ({focus() {}}),
    navigationGeneration: 1,
    identityGeneration: 1,
    session: {workspaceRole: 'owner'},
    esc: escape,
    pretty: String,
    date: String,
    badge: escape,
    errorMessage: e => e.message,
    recordDetails: () => '',
    toast() {},
    workspaceBind: (s, fn) => bindings.set(s, fn),
    api: (url, options = {}) => new Promise((resolve, reject) => requests.push({url, options, resolve, reject})),
    confirmAction: () => new Promise(resolve => confirmations.push(resolve)),
    root,
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(c);
  new Script(readFileSync('web/operations-center.js', 'utf8')).runInContext(c);
  const controller = new Script("writeApprovalController(root, 'review-1')").runInContext(c);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const view = {
    review_id: 'review-1',
    group: false,
    gateway: 'tiktok_native_action',
    account_id: '123',
    action: '<img onerror=bad>',
    summary: null,
    classes: ['spend_affecting', 'cap_override'],
    reasons: [],
    prepared_by: 'operator',
    prepared_by_name: 'Operator Name',
    expires_at: '2026-10-13T10:05:00.000Z',
    fingerprint: 'f'.repeat(64),
    owner_required: true,
    approval: null,
    approval_pending: true,
    may_approve: true,
  };
  let loaded = controller.load();
  assert.equal(requests[0].url, '/api/write-approvals/review-1');
  requests[0].resolve(view);
  await loaded;
  assert.match(root.innerHTML, /id="write-approval-approve"/);
  assert.match(root.innerHTML, /Prepared by Operator Name/);
  assert.match(root.innerHTML, /&lt;img/);
  assert.doesNotMatch(root.innerHTML, /<img/);
  // Nothing is posted until the person confirms, and then only the fingerprint the page showed.
  const cancelled = bindings.get('#write-approval-approve')();
  confirmations[0](false);
  await cancelled;
  assert.equal(requests.length, 1);
  const approving = bindings.get('#write-approval-approve')();
  confirmations[1](true);
  await settle();
  assert.equal(requests[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[1].options.body), {fingerprint: view.fingerprint, confirmed: true});
  requests[1].resolve({});
  await settle();
  // A member's approval of a change beyond a cap: shown, with the owner's approval still pending.
  requests[2].resolve({
    ...view,
    approval: {approver: 'colleague', approver_name: 'Colleague Name', approver_is_owner: false, approved_at: 1},
  });
  await approving;
  assert.match(root.innerHTML, /Approved by Colleague Name/);
  assert.match(root.innerHTML, /the workspace owner’s approval is still needed/);
  assert.match(root.innerHTML, /id="write-approval-approve"/);
  // Approved and nothing pending: no button and no refusal text; an expired review says so.
  loaded = controller.load();
  requests[3].resolve({
    ...view,
    approval: {approver: 'owner', approver_is_owner: true, approved_at: 1},
    approval_pending: false,
    may_approve: false,
    refusal: {code: 'REVIEW_ALREADY_APPROVED', message: 'This review is already approved.'},
  });
  await loaded;
  assert.match(root.innerHTML, /The AI client can now execute this exact review/);
  assert.doesNotMatch(root.innerHTML, /write-approval-approve|This review is already approved/);
  loaded = controller.load();
  requests[4].resolve({
    ...view,
    may_approve: false,
    refusal: {code: 'REVIEW_EXPIRED', message: 'This review expired. Prepare it again and approve the new review.'},
  });
  await loaded;
  assert.match(root.innerHTML, /This review expired/);
  assert.doesNotMatch(root.innerHTML, /write-approval-approve/);
});

test('WRT-09 website review: the destructive acknowledgement is asked for and the approval page is linked only on this site', () => {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {checked: false, innerHTML: ''});
    return nodes.get(id);
  };
  const context = createContext({
    document: {addEventListener() {}},
    $: node,
    Object,
    Date,
    JSON,
    encodeURIComponent,
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    badge: String,
    date: String,
    blank: String,
    recordDetails: () => '',
    workspaceBind() {},
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(readFileSync('web/campaign-workflows.js', 'utf8'));
  const review = path =>
    `({execute_requirements:{destructive_confirmed:true}, approval:{required:true, mode:'distinct_approver', classes:['destructive'], owner_required:'cap_override', website_path:${JSON.stringify(path)}}})`;
  const html = run(`readableReview(${review('/operations?approve=r-1')}, 'Execute')`);
  assert.match(html, /id="destructive-consent"/);
  assert.match(html, /href="\/operations\?approve=r-1"/);
  assert.match(html, /Another member than the one who prepared it/);
  assert.match(html, /Only the workspace owner executes a change beyond a spending cap/);
  // With the review consent given, the deletion still needs its own checkbox: the read names that acknowledgement.
  node('#review-consent').checked = true;
  assert.throws(
    () => run(`readReviewConsents(${review('/operations?approve=r-1')})`),
    /I authorize the deletion shown in this review/,
  );
  node('#destructive-consent').checked = true;
  assert.equal(run(`readReviewConsents(${review('/operations?approve=r-1')}).destructive_confirmed`), true);
  // A path that leaves this site is not linked.
  assert.doesNotMatch(run(`readableReview(${review('//elsewhere.example/approve')}, 'Execute')`), /href="\/\//);
  // A review that needs no approval shows no notice.
  assert.doesNotMatch(run("readableReview({execute_requirements:{}}, 'Execute')"), /approval page/);
});
