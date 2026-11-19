import test, {after, before, mock} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor, JsonObject} from '../src/types.js';
import {assertRefused} from './helpers/assert-refused.js';
import {confirmationPage, drive, file, noOutboundFetch, png, share} from './helpers/drive-large.js';

/**
 * R2.5 field fix r25-media-drive-large, item 5 (2026-11-19): amcp_media plan works on an upload that is already in AMCP, so
 * it still refuses a drive_url or a source_url, and now says how to get a source_id (next_call) instead of only that the
 * argument is wrong; its help says that plan needs an upload first. The link itself is neither downloaded nor staged.
 */
// Nothing in this file may reach Drive or the internet: any other host fails the test.
before(() => noOutboundFetch());
after(() => mock.restoreAll());
const key = Buffer.alloc(32, 57).toString('base64'),
  operator: Actor = {tenantId: 't', userId: 'u', role: 'operator'},
  destinations = [{platform: 'meta', account_id: '123'}];

function setup() {
  const store = new Store(':memory:', key),
    providerCalls: string[] = [],
    stand = drive(confirmationPage, file);
  store.putConnection(
    {...operator, role: 'admin'},
    {
      id: 'c',
      tenantId: operator.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      label: 'Synthetic',
      enabled: true,
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const svc = new MirrorService(
    new Registry(),
    store,
    new NativeTransport((async input => {
      providerCalls.push(String(input));
      throw Error('no provider request is expected');
    }) as typeof fetch),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    stand.fetcher,
    async () => new Response(png),
  );
  const rows = (table: string) => (store.db.prepare('SELECT count(*) AS n FROM ' + table).get() as {n: number}).n;
  return {store, svc, providerCalls, stand, rows};
}
const plan = (svc: MirrorService, input: JsonObject) =>
  svc.call('amcp_media', {action: 'plan', destinations, ...input}, operator);

test('plan with a Drive link or a public link still refuses it, and now names how to get a source_id', async () => {
  const f = setup();
  try {
    for (const input of [{drive_url: share}, {source_url: 'https://cdn.example.com/banner.png'}]) {
      const out = await plan(f.svc, input);
      assertRefused(out, 'INVALID_ARGUMENT', {writes: () => f.providerCalls.length});
      assert.deepEqual(out.error.details.next_call, {
        tool: 'amcp_media',
        arguments: {action: 'list', include_assets: false},
      });
      // The message says what plan works on and where a source_id comes from, in words a person can follow.
      assert.match(out.error.message, /source_id/);
      assert.match(out.error.message, /AMCP website/);
      assert.match(out.error.message, /amcp_media list/);
      assert.match(out.error.message, /prepare/);
      // Nothing was fetched, staged or sent for it.
      assert.equal(f.stand.requests.length, 0);
      assert.equal(f.rows('media_staging'), 0);
      assert.equal(f.rows('media_chunks'), 0);
      assert.equal(f.rows('media_admissions'), 0);
    }
  } finally {
    f.store.close();
  }
});
test('the call it names works: it lists the uploads and imports with their source_id, and plan takes one of them', async () => {
  const f = setup();
  try {
    const imported = await f.svc.mediaSources().importLink(operator, 'https://cdn.example.com/banner.png'),
      refused = await plan(f.svc, {drive_url: share}),
      next = refused.error.details.next_call,
      listed = await f.svc.call(next.tool, next.arguments, operator);
    assert.equal(listed.success, true, JSON.stringify(listed).slice(0, 400));
    assert.deepEqual(
      listed.data.sources.map((s: {source_id: string}) => s.source_id),
      [imported.source_id],
    );
    // With that source_id plan gets past the argument check: whatever it answers, it is no longer this refusal.
    const planned = await plan(f.svc, {source_id: imported.source_id});
    assert.notEqual(planned.error?.details?.next_call?.arguments?.action, 'list');
    assert.doesNotMatch(String(planned.error?.message ?? ''), /plan works on an upload/);
  } finally {
    f.store.close();
  }
});
test('the refusals plan always had are unchanged: no source at all, a source_id beside a link, a variant', async () => {
  const f = setup();
  try {
    const none = await plan(f.svc, {});
    assertRefused(none, 'INVALID_ARGUMENT');
    assert.equal(none.error.message, 'plan works on an upload: pass its source_id.');
    assert.equal(none.error.details?.next_call, undefined);
    const both = await plan(f.svc, {source_id: 'src-00000000-0000-0000-0000-000000000000', drive_url: share});
    assertRefused(both, 'INVALID_ARGUMENT');
    assert.equal(both.error.message, 'plan works on an upload: pass its source_id.');
    assert.equal(both.error.details?.next_call, undefined);
    const variant = await plan(f.svc, {variant_id: 'v-1'});
    assertRefused(variant, 'INVALID_ARGUMENT');
    assert.equal(variant.error.message, 'plan works on an upload: pass its source_id.');
    // The destinations are checked first, as before.
    const bad = await f.svc.call('amcp_media', {action: 'plan', drive_url: share, destinations: []}, operator);
    assertRefused(bad, 'INVALID_ARGUMENT');
    assert.match(bad.error.message, /1 to 20 destinations/);
    assert.equal(f.stand.requests.length, 0);
  } finally {
    f.store.close();
  }
});
test('the help of plan says that it needs an upload first, and where a source_id comes from', async () => {
  const f = setup();
  try {
    const help = await f.svc.call('amcp_media', {action: 'help', topic: 'plan'}, operator),
      text = JSON.stringify(help);
    assert.equal(help.success, true, text.slice(0, 400));
    assert.match(text, /needs an upload|works on an upload/i);
    assert.match(text, /source_id/);
    assert.match(text, /prepare/);
    // What it adds is structured, and names the call that lists the uploads.
    assert.deepEqual(help.data.next_call, {tool: 'amcp_media', arguments: {action: 'list', include_assets: false}});
    assert.match(help.data.needs, /^plan needs an upload first/);
    assert.equal(Array.isArray(help.data.source_id_from) && help.data.source_id_from.length, 2);
    // The same answer through amcp_tool_help, and the root help of the tool is not made longer by it.
    const through = await f.svc.call('amcp_tool_help', {gateway: 'amcp_media', operation: 'plan'}, operator);
    assert.equal(through.success, true, JSON.stringify(through).slice(0, 300));
    assert.deepEqual(through.data.next_call, help.data.next_call);
    assert.equal(through.data.needs, help.data.needs);
    const root = await f.svc.call('amcp_media', {action: 'help'}, operator);
    assert.equal(root.data.needs, undefined);
    const other = await f.svc.call('amcp_media', {action: 'help', topic: 'prepare'}, operator);
    assert.equal(other.data.needs, undefined);
  } finally {
    f.store.close();
  }
});
