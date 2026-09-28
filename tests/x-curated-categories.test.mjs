import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Curated categories of X Ads pre-roll line items, Ads API v12 (Campaign Management reference, "Line Item Curated
 * Categories"; checked 2026-09-27).
 */
const registry = new Registry(),
  gateway = 'x_ads_native_action',
  account = 'acct1';
const actor = {tenantId: 'x-curated', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const secret = {
  accessToken: 'synthetic-token',
  consumerKey: 'synthetic-key',
  consumerSecret: 'synthetic-secret',
  tokenSecret: 'synthetic-token-secret',
};
const actions = {
  create: 'x_accounts_account_id_line_item_curated_categories_post',
  update: 'x_accounts_account_id_line_item_curated_categories_line_item_curated_category_id_put',
  remove: 'x_accounts_account_id_line_item_curated_categories_line_item_curated_category_id_delete',
};
const copy = x => structuredClone(x);
function setup(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 99).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'x',
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    secret,
  );
  const lines = {
    pre: {
      id: 'pre',
      campaign_id: 'camp1',
      product_type: 'MEDIA',
      objective: 'PREROLL_VIEWS',
      entity_status: 'ACTIVE',
      deleted: false,
    },
    eng: {
      id: 'eng',
      campaign_id: 'camp1',
      product_type: 'PROMOTED_TWEETS',
      objective: 'ENGAGEMENTS',
      entity_status: 'PAUSED',
      deleted: false,
    },
    gone: {
      id: 'gone',
      campaign_id: 'camp1',
      product_type: 'MEDIA',
      objective: 'PREROLL_VIEWS',
      entity_status: 'PAUSED',
      deleted: true,
    },
  };
  const campaigns = {camp1: {id: 'camp1', entity_status: 'ACTIVE', deleted: false}};
  const categories = {
    cat1: {id: 'cat1', name: 'Basketball', country_codes: ['US']},
    cat2: {id: 'cat2', name: 'Football', country_codes: ['US', 'GB']},
  };
  const rows = {
    lc1: {id: 'lc1', line_item_id: 'pre', curated_category_id: 'cat1', deleted: false},
    lc9: {id: 'lc9', line_item_id: 'other', curated_category_id: 'cat2', deleted: false},
  };
  const calls = [];
  let writes = 0,
    next = 5;
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      method = init?.method ?? 'GET',
      suffix = u.pathname.replace('/12/accounts/' + account, '');
    calls.push({method, path: u.pathname, query: Object.fromEntries(u.searchParams)});
    const reply = data =>
      Response.json({
        data: copy(data),
        request: {params: {account_id: account, ...Object.fromEntries(u.searchParams)}},
        ...(Array.isArray(data) ? {next_cursor: null} : {}),
      });
    const missing = () =>
      Response.json({errors: [{code: 'NOT_FOUND', message: 'Not found'}], request: {params: {}}}, {status: 404});
    if (method === 'GET') {
      if (!suffix) return reply({id: account, name: 'Account', deleted: false});
      let m = /^\/(line_items|campaigns|curated_categories|line_item_curated_categories)\/(\w+)$/.exec(suffix);
      if (m) {
        const src = {line_items: lines, campaigns, curated_categories: categories, line_item_curated_categories: rows}[
          m[1]
        ];
        return src[m[2]] ? reply(src[m[2]]) : missing();
      }
      if (suffix === '/line_item_curated_categories') return reply(Object.values(rows).filter(r => !r.deleted));
      return missing();
    }
    writes++;
    const form = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
    if (method === 'POST' && suffix === '/line_item_curated_categories') {
      const id = 'lc' + next++,
        row = {id, ...form, deleted: false};
      if (mode !== 'ignore') rows[id] = row;
      return reply(mode === 'other' ? {...row, line_item_id: 'other'} : row);
    }
    const m = /^\/line_item_curated_categories\/(\w+)$/.exec(suffix);
    if (method === 'PUT' && m) {
      const row = {...rows[m[1]], ...form};
      if (mode !== 'ignore') rows[m[1]] = row;
      return reply(row);
    }
    if (method === 'DELETE' && m) {
      const row = {...rows[m[1]], deleted: true};
      if (mode !== 'ignore') rows[m[1]] = row;
      return reply(row);
    }
    throw Error('Unexpected write ' + method + ' ' + suffix);
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (action, payload, params = {}) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: account, params, ...(payload ? {payload} : {})}},
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
  return {store, calls, rows, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('a curated category is added once after confirmation and verifies; replacing and removing it verify too', async () => {
  const x = setup();
  try {
    const p = ok(await x.prepare(actions.create, {line_item_id: 'pre', curated_category_id: 'cat2'})),
      impact = p.data.creative_impact;
    assert.equal(impact.scope, 'line_item_curated_category');
    assert.equal(impact.may_affect_serving, true);
    assert.deepEqual(impact.after.category.countryCodes, ['GB', 'US']);
    assert.equal((await x.execute(p)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    ok(await x.execute(p, {spend_change_confirmed: true}));
    assert.equal(x.writes(), 1);
    assert.equal(ok(await x.verify(p)).data.status, 'verified');
    assert.equal((await x.execute(p, {spend_change_confirmed: true})).data.replayed, true);
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
  const y = setup();
  try {
    const u = ok(
      await y.prepare(actions.update, {curated_category_id: 'cat2'}, {line_item_curated_category_id: 'lc1'}),
    );
    ok(await y.execute(u, {spend_change_confirmed: true}));
    assert.equal(y.rows.lc1.curated_category_id, 'cat2');
    assert.equal(ok(await y.verify(u)).data.status, 'verified');
    const d = ok(await y.prepare(actions.remove, undefined, {line_item_curated_category_id: 'lc1'}));
    ok(await y.execute(d));
    assert.equal(y.rows.lc1.deleted, true);
    assert.equal(ok(await y.verify(d)).data.status, 'verified');
    saveSpendPolicy(y.store, admin, {gateway, account_id: account, confirmed: true, policy: {allow_activation: false}});
    assert.equal(
      (await y.prepare(actions.create, {line_item_id: 'pre', curated_category_id: 'cat1'})).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
  } finally {
    y.store.close();
  }
});

test('malformed curated category requests are refused before any request', async () => {
  const cases = [
    ['missing category', actions.create, {line_item_id: 'pre'}, {}],
    ['missing line item', actions.create, {curated_category_id: 'cat1'}, {}],
    ['unknown field', actions.create, {line_item_id: 'pre', curated_category_id: 'cat1', name: 'x'}, {}],
    [
      'line item change',
      actions.update,
      {curated_category_id: 'cat1', line_item_id: 'eng'},
      {line_item_curated_category_id: 'lc1'},
    ],
    ['malformed category', actions.update, {curated_category_id: 'Cat One'}, {line_item_curated_category_id: 'lc1'}],
  ];
  for (const [label, action, payload, params] of cases) {
    const x = setup();
    try {
      const r = await x.prepare(action, payload, params);
      assert.equal(r.error?.code, 'INVALID_X_CURATED_CATEGORY', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(x.calls.length, 0, label);
    } finally {
      x.store.close();
    }
  }
});

test('other objectives, deleted line items, unchanged, duplicate and unknown categories are refused after reading, without writes', async () => {
  const x = setup();
  try {
    assert.match(
      (await x.prepare(actions.create, {line_item_id: 'eng', curated_category_id: 'cat1'})).error?.message ?? '',
      /PREROLL_VIEWS/,
    );
    assert.match(
      (await x.prepare(actions.create, {line_item_id: 'gone', curated_category_id: 'cat1'})).error?.message ?? '',
      /deleted/,
    );
    assert.equal(
      (await x.prepare(actions.create, {line_item_id: 'pre', curated_category_id: 'cat1'})).error?.code,
      'CONFIGURATION_EXISTS',
    );
    assert.match(
      (await x.prepare(actions.update, {curated_category_id: 'cat1'}, {line_item_curated_category_id: 'lc1'})).error
        ?.message ?? '',
      /already uses/,
    );
    assert.equal((await x.prepare(actions.create, {line_item_id: 'pre', curated_category_id: 'cat9'})).success, false);
    assert.equal((await x.prepare(actions.remove, undefined, {line_item_curated_category_id: 'lc404'})).success, false);
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});

test('a receipt for another line item is a failure that is never resubmitted, an ignored change is not verified, and the ledger lists the three writes', async () => {
  const other = setup('other');
  try {
    const p = ok(await other.prepare(actions.create, {line_item_id: 'pre', curated_category_id: 'cat2'}));
    assert.equal((await other.execute(p, {spend_change_confirmed: true})).success, false);
    assert.equal((await other.execute(p, {spend_change_confirmed: true})).success, false);
    assert.equal(other.writes(), 1);
  } finally {
    other.store.close();
  }
  const ignored = setup('ignore');
  try {
    const p = ok(
      await ignored.prepare(actions.update, {curated_category_id: 'cat2'}, {line_item_curated_category_id: 'lc1'}),
    );
    ok(await ignored.execute(p, {spend_change_confirmed: true}));
    assert.notEqual(ok(await ignored.verify(p)).data.status, 'verified');
  } finally {
    ignored.store.close();
  }
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'x_curated_categories', action);
  }
});
