import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

// ARC-04 stage D: MirrorService.callOnce dispatched its seven composite tools and amcp_tool_help through an if-chain
// and named their timing categories in a second list (timingCategory). Both are now one table, compositeTools. These
// tests hold what the chain and the list decided: which names reach a composite tool, the category each is timed
// under, and that a composite tool's refusal is its call's audited error envelope.
const actor = {tenantId: 'composite-tools', userId: 'owner', role: 'admin'};
const key = Buffer.alloc(32, 41).toString('base64');
function fixture(policy) {
  const store = new Store(':memory:', key),
    timed = [];
  let requests = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      requests++;
      throw Error('No provider request is allowed');
    }),
    undefined,
    policy,
  );
  const record = store.serviceTiming.bind(store);
  store.serviceTiming = (tenant, category, ms, success) => {
    timed.push([category, success]);
    return record(tenant, category, ms, success);
  };
  return {store, service, timed, requests: () => requests};
}
// The categories timingCategory named before the table: the AMCP tools, and native_other for every other name.
const categories = {
  amcp_workspace: 'workspace',
  amcp_campaign: 'campaign',
  amcp_reporting: 'analysis',
  amcp_reporting_overview: 'overview',
  amcp_ad_previews: 'preview',
  amcp_media: 'media',
  amcp_write: 'write',
  amcp_tool_help: 'native_other',
};

test('every AMCP tool MirrorService answers itself is one table entry, with the timing category it had', () => {
  for (const policy of [undefined, {allowWrites: true}, {allowWrites: false, providerJobs: true}]) {
    const f = fixture(policy);
    try {
      const table = f.service.compositeTools;
      assert.deepEqual(
        Object.keys(table).sort(),
        [...f.service.firstPartyTools().map(t => t.name), 'amcp_tool_help'].sort(),
        JSON.stringify(policy),
      );
      assert.deepEqual(
        Object.fromEntries(Object.entries(table).map(([name, entry]) => [name, entry.category])),
        categories,
      );
      for (const [name, category] of Object.entries(categories))
        assert.equal(f.service.timingCategory(name), category, name);
    } finally {
      f.store.close();
    }
  }
});

test('an inherited, unknown or native name is no composite tool: it is refused by the catalog and timed as native_other', async () => {
  const f = fixture();
  try {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'not_a_tool']) {
      assert.equal(f.service.timingCategory(name), 'native_other', name);
      const out = await f.service.call(name, {action: 'LIST_ACTIONS'}, actor);
      assert.equal(out.success, false, name);
      assert.equal(out.error.code, 'UNKNOWN_TOOL', name);
    }
    assert.equal(f.service.timingCategory('meta_native_action'), 'native_other');
    assert.deepEqual(new Set(f.timed.map(([category]) => category)), new Set(['native_other']));
    assert.equal(f.requests(), 0);
  } finally {
    f.store.close();
  }
});

test('a composite tool refusal is its call’s audited error envelope, timed under its own category', async () => {
  const f = fixture();
  try {
    const out = await f.service.call('amcp_workspace', {action: 'no-such-workspace-action'}, actor);
    assert.equal(out.success, false);
    assert.equal(typeof out.error.code, 'string');
    assert.equal(typeof out.meta.requestId, 'string');
    const audit = f.store.db
      .prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=? AND request_id=?')
      .get(actor.tenantId, out.meta.requestId);
    assert.equal(audit.n, 1, 'the refusal is audited under the call’s request ID');
    assert.deepEqual(f.timed, [['workspace', false]]);
  } finally {
    f.store.close();
  }
});

test('each AMCP tool’s calls count under its category, whether they succeed or are refused', async () => {
  const f = fixture({allowWrites: true});
  try {
    const calls = [
      ['amcp_workspace', {action: 'contracts', limit: 1}],
      ['amcp_campaign', {action: 'list'}],
      ['amcp_reporting', {action: 'capture_presets'}],
      ['amcp_reporting_overview', {action: 'no-such-overview-action'}],
      ['amcp_ad_previews', {platform: 'x_ads', account_id: '1'}],
      ['amcp_media', {action: 'list'}],
      ['amcp_write', {action: 'execute'}],
      ['amcp_tool_help', {}],
    ];
    for (const [tool, input] of calls) await f.service.call(tool, input, actor);
    assert.deepEqual(
      f.timed.map(([category]) => category),
      calls.map(([tool]) => categories[tool]),
    );
    assert.equal(f.requests(), 0);
  } finally {
    f.store.close();
  }
});
