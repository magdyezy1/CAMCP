// V2-MCP-06, decision 2, the lead's ruling 12: under the v2 contract profile only, tools/list marks seven native gateways
// readOnlyHint:true: meta, tiktok, snapchat, dv360, linkedin, google_ads and x_ads. Their writes are handed to amcp_write
// (WRITE_REVIEW_REQUIRED) and their uploads to amcp_media (MEDIA_REVIEW_REQUIRED), saving nothing, so no call through them can
// change state. ga4, Search Console, Business Profile, Microsoft and amcp_native_action keep today's annotations on BOTH
// profiles: they write AMCP state or create a provider job. Legacy is unchanged, annotations and bytes.
//
// What pins the claim is the walk: every action of the seven gateways is called under v2, as a read and as a write, against a
// provider that answers the reads a prepare makes and a file source that serves bytes, so a call that could save a review would
// save one; each call must leave the store as it was, send only independently read-only plans, create no provider job and
// fetch no media. The same walk under legacy is the control: it does find the saved reviews.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {withContractProfile} from '../dist/src/contract-profile.js';
import {setContractProfile} from '../dist/src/mcp-client-profile.js';
import {
  keptCautiousReason,
  toolAnnotations,
  toolPresentation,
  v2KeptCautiousGateways,
  v2ReadOnlyGateways,
} from '../dist/src/tool-annotations.js';
import {bags, fill, readOnlyCall} from './helpers/annotation-walk.mjs';
import {oauthStack} from './helpers/mcp-oauth-stack.mjs';

const eras = ['legacy', 'modern'];
const sevenGateways = [
  'meta_native_action',
  'tiktok_native_action',
  'snapchat_native_action',
  'dv360_native_action',
  'linkedin_native_action',
  'google_ads_native_action',
  'x_ads_native_action',
];
const keptFive = [
  'ga4_native_action',
  'google_search_console_native_action',
  'google_business_native_action',
  'microsoft_ads_native_action',
  'amcp_native_action',
];
const hints = a => [a.readOnlyHint, a.destructiveHint, a.idempotentHint, a.openWorldHint];
const log = () => {};

test('the table of the seven and the five is the lead’s ruling', () => {
  assert.deepEqual([...v2ReadOnlyGateways].sort(), [...sevenGateways].sort());
  assert.deepEqual([...v2KeptCautiousGateways].sort(), [...keptFive].sort());
  // The two sets are disjoint, and every one of the five says what it writes.
  for (const gateway of keptFive) {
    assert.ok(!sevenGateways.includes(gateway), gateway);
    assert.ok(keptCautiousReason(gateway).length > 40, gateway);
  }
  assert.equal(keptCautiousReason('meta_native_action'), undefined);
});

test('v2 presents the seven as read-only and every other tool as the table says; legacy is the table', () => {
  const names = [...new Set(Object.keys(toolAnnotations).map(name => name.replace(/:read_only$/, '')))];
  assert.ok(names.length >= 28);
  for (const name of names)
    for (const readOnlyDeployment of [false, true]) {
      const legacy = toolPresentation(name, readOnlyDeployment, log),
        explicit = toolPresentation(name, readOnlyDeployment, log, 'legacy'),
        v2 = toolPresentation(name, readOnlyDeployment, log, 'v2');
      assert.deepEqual(explicit, legacy, name);
      if (sevenGateways.includes(name)) {
        assert.equal(v2.title, legacy.title, name);
        assert.deepEqual(hints(v2.annotations), [true, false, true, true], name + ' read-only under v2');
        assert.deepEqual(hints(legacy.annotations), [false, false, false, true], name + ' as it was under legacy');
      } else assert.deepEqual(v2, legacy, name + ' is the same under both profiles');
    }
  // The five keep today's annotations on both paths, and they are not read-only.
  const pinned = {
    ga4_native_action: [false, true, false, true],
    google_search_console_native_action: [false, true, false, true],
    google_business_native_action: [false, true, false, true],
    microsoft_ads_native_action: [false, false, false, true],
    amcp_native_action: [false, true, false, true],
  };
  for (const [name, expected] of Object.entries(pinned))
    for (const profile of ['legacy', 'v2'])
      assert.deepEqual(hints(toolPresentation(name, false, log, profile).annotations), expected, name + ' ' + profile);
  // The gateways that already read stay read-only on both.
  for (const name of [
    'amazon_native_action',
    'apple_ads_native_action',
    'reddit_native_action',
    'criteo_native_action',
    'adjust_native_action',
    'gtm_native_action',
    'commerce_native_action',
  ])
    for (const profile of ['legacy', 'v2'])
      assert.equal(toolPresentation(name, false, log, profile).annotations.readOnlyHint, true, name + ' ' + profile);
});

for (const era of eras)
  test(`${era} HTTP: an opted-in client's tools/list differs from a legacy client's in the seven annotations only, 14 bytes shorter`, async t => {
    const s = await oauthStack(t),
      older = await s.connect('Legacy client'),
      newer = await s.connect('Opted-in client');
    assert.equal(setContractProfile(s.store, newer.client.client_id, 'v2'), true);
    const key = s.store.createKey({tenantId: 'local', userId: 'script', role: 'operator'}),
      listing = async access => (await s.client(era, access)).listTools();
    const [legacy, v2, script] = [await listing(older.access), await listing(newer.access), await listing(key)];
    // An API key is a legacy client, whatever the deployment's other clients are.
    assert.deepEqual(script, legacy);
    const bytes = listed => Buffer.byteLength(JSON.stringify(listed));
    assert.equal(bytes(legacy) - bytes(v2), 14, 'seven tools x two hints shorter: true is one byte shorter than false');
    assert.equal(legacy.tools.length, v2.tools.length);
    for (const [a, b] of legacy.tools.map((tool, i) => [tool, v2.tools[i]])) {
      assert.equal(a.name, b.name);
      if (sevenGateways.includes(a.name)) {
        assert.deepEqual(hints(b.annotations), [true, false, true, true], a.name);
        assert.deepEqual(hints(a.annotations), [false, false, false, true], a.name);
        // Nothing else of the tool differs.
        assert.deepEqual({...b, annotations: a.annotations}, a, a.name);
      } else assert.deepEqual(b, a, a.name);
    }
    // The seven that are listed (a deployment may park some) are the seven that differ.
    assert.equal(legacy.tools.filter(tool => sevenGateways.includes(tool.name)).length, 7);
    // A switch applies at the next listing, with the token the client holds.
    setContractProfile(s.store, newer.client.client_id, 'legacy');
    assert.deepEqual(await listing(newer.access), legacy);
  });

test('the help topic names the seven that are read-only under v2 and why each of the other five is not', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 83).toString('base64')),
    service = new MirrorService(new Registry(), store, new NativeTransport(async () => Response.json({})), undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    }),
    actor = {tenantId: 't', userId: 'u', role: 'operator'};
  try {
    const topic = async profile =>
      (
        await withContractProfile(profile, () =>
          service.call('amcp_workspace', {action: 'help', topic: 'mcp_profile'}, actor),
        )
      ).data;
    for (const profile of ['legacy', 'v2']) {
      const data = await topic(profile);
      assert.equal(data.profile, profile);
      // The topic says the same of both profiles' gateways: it announces what v2 would change.
      assert.deepEqual([...data.native_gateways_read_only].sort(), [...sevenGateways].sort());
      assert.deepEqual(data.native_gateways_unchanged.map(entry => entry.gateway).sort(), [...keptFive].sort());
      for (const entry of data.native_gateways_unchanged) {
        assert.equal(entry.annotations, 'the same under legacy and v2');
        assert.match(entry.writes, /saves|removes|creates|prepares/i, entry.gateway);
        assert.equal(entry.writes, toolAnnotations[entry.gateway].basis);
      }
      const ids = data.v2_changes.map(change => change.id);
      assert.deepEqual(ids, ['annotations', 'media_handoff']);
      const annotations = data.v2_changes.find(change => change.id === 'annotations').text;
      for (const gateway of ['meta', 'tiktok', 'snapchat', 'dv360', 'linkedin', 'google_ads', 'x_ads'])
        assert.match(annotations, new RegExp(gateway));
      assert.match(annotations, /WRITE_REVIEW_REQUIRED/);
      assert.match(annotations, /MEDIA_REVIEW_REQUIRED/);
    }
  } finally {
    store.close();
  }
});

// ---- the walk ----

const drive = 'https://drive.google.com/file/d/abcdefghijklmno/view?usp=sharing',
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ),
  account = '1001';

/** What a platform answers to the read of its ad account, so that a prepare of an upload could go on to save its review. */
function accountRead(url, method) {
  const host = url.hostname;
  if (host.includes('facebook')) return {id: 'act_' + account, account_status: 1, currency: 'USD', name: 'Account'};
  if (host.includes('snapchat'))
    return {
      request_status: 'SUCCESS',
      adaccounts: [{sub_request_status: 'SUCCESS', adaccount: {id: account, name: 'Account'}}],
    };
  if (host.includes('tiktok')) return {code: 0, data: {list: [{advertiser_id: account, name: 'Account'}]}};
  if (host.includes('googleads') && url.pathname.endsWith(':search'))
    return {results: [{customer: {id: account, descriptiveName: 'Account'}}]};
  if (host.includes('linkedin')) return {id: Number(account), name: 'Account'};
  if (host.includes('displayvideo')) return {advertiserId: account, displayName: 'Account'};
  if (method === 'GET') return {data: {id: account, name: 'Account'}};
  return {};
}

/** The shape of tests/helpers/annotation-walk.mjs's world, with a provider and a file source that can complete an upload. */
function world(registry, gateways) {
  const store = new Store(':memory:', Buffer.alloc(32, 61).toString('base64')),
    actor = {tenantId: 'annotations', userId: 'owner', role: 'admin'},
    fetches = [],
    plans = [],
    media = [],
    connections = new Map();
  store.ensureTenant(actor.tenantId);
  let n = 0;
  for (const gateway of gateways) {
    const id = '00000000-0000-4000-8000-' + String(++n).padStart(12, '0');
    store.putConnection(
      actor,
      {
        id,
        tenantId: actor.tenantId,
        gateway,
        accounts: [account],
        writeAccounts: [account],
        enabled: true,
        label: 'Synthetic ' + gateway,
        scopes: [],
        userAgent: 'synthetic-annotation-evaluator/1.0',
      },
      {
        accessToken: 'synthetic-' + n,
        developerToken: 'synthetic',
        consumerKey: 's',
        consumerSecret: 's',
        tokenSecret: 's',
      },
    );
    connections.set(gateway, id);
  }
  const transport = new NativeTransport(
    async (url, init = {}) => {
      const parsed = new URL(String(url)),
        method = String(init.method ?? 'GET').toUpperCase();
      fetches.push({method, url: String(url)});
      return Response.json(accountRead(parsed, method));
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    1e9,
    1,
    1e9,
  );
  const request = transport.request.bind(transport);
  transport.request = (plan, ...rest) => {
    plans.push(plan);
    return request(plan, ...rest);
  };
  const service = new MirrorService(
    registry,
    store,
    transport,
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
    async url => {
      media.push(String(url));
      return new Response(new Uint8Array(png), {headers: {'Content-Type': 'application/octet-stream'}});
    },
  );
  return {store, actor, service, connections, fetches, plans, media, close: () => store.close()};
}

/** Every input the gateway's schema admits for each of its actions: once as a read, once as a write that names a file. */
function inputs(registry, w, tool) {
  const name = tool.name,
    definition = registry.tools.get(name),
    schema = tool.inputSchema,
    {read, write} = bags(w, name),
    withFile = {...write, payload: {name: 'Synthetic', url: drive}};
  if (definition?.mode === 'delegated')
    return (definition.operations ?? []).flatMap(op =>
      (op.argumentsSchema?.properties?.action?.enum ?? [undefined]).flatMap(action =>
        [read, withFile].map(bag => ({
          operation: op.operation,
          arguments: fill({...bag, ...(action ? {action} : {})}, op.argumentsSchema),
        })),
      ),
    );
  const actions = [
    ...new Set([...registry.routes].filter(([key]) => key.startsWith(name + '/')).map(([, action]) => action)),
  ];
  return [
    fill({action: 'LIST_ACTIONS', limit: 5}, schema),
    ...actions.flatMap(action =>
      [read, withFile].map(bag => ({
        ...fill(
          {...bag, path_params: Object.fromEntries((action.path_parameters ?? []).map(p => [p, account]))},
          schema,
        ),
        action: action.name,
      })),
    ),
  ];
}

/** Walks the gateways under a profile; returns the calls made and what each violated, as `readOnlyCall` finds it. */
async function walk(registry, gateways, profile) {
  const w = world(registry, gateways),
    out = {calls: 0, succeeded: 0, reads: 0, violations: []};
  try {
    const listed = withContractProfile(profile, () => w.service.listTools()).filter(tool =>
      gateways.includes(tool.name),
    );
    assert.deepEqual(listed.map(tool => tool.name).sort(), [...gateways].sort());
    for (const tool of listed)
      for (const input of inputs(registry, w, tool)) {
        out.calls++;
        try {
          const outcome = await withContractProfile(profile, () => readOnlyCall(w, tool.name, input, tool.name));
          if (outcome.success) out.succeeded++;
          out.reads += outcome.reads;
        } catch (e) {
          out.violations.push({tool: tool.name, input, message: String(e.message).split('\n')[0].slice(0, 160)});
        }
      }
  } finally {
    w.close();
  }
  return out;
}

test('under v2 no action of the seven gateways saves state, sends a write or a job, or fetches a file (the walk)', async () => {
  const registry = new Registry(),
    result = await walk(registry, sevenGateways, 'v2');
  assert.deepEqual(result.violations, [], JSON.stringify(result.violations.slice(0, 3)));
  // The walk reached the providers and completed calls: it exercised more than argument validation.
  assert.ok(result.calls > 4500, 'calls ' + result.calls);
  assert.ok(result.succeeded > 300, 'succeeded ' + result.succeeded);
  assert.ok(result.reads > 300, 'reads ' + result.reads);
});

test('the control: the same walk under legacy finds the saved reviews, so the walk can see a write', async () => {
  const registry = new Registry(),
    // Gateways whose generic walk inputs complete an upload: legacy's live call prepares the review there. (Snapchat's and
    // Google's upload routes need their own path parameters; tests/mcp-media-handoff.test.mjs calls them exactly, both profiles.)
    gateways = ['meta_native_action', 'tiktok_native_action'],
    result = await walk(registry, gateways, 'legacy'),
    byGateway = new Map();
  for (const violation of result.violations) byGateway.set(violation.tool, (byGateway.get(violation.tool) ?? 0) + 1);
  for (const gateway of gateways)
    assert.ok(byGateway.get(gateway) >= 1, gateway + ' ' + JSON.stringify([...byGateway]));
  // What it found is the saved review and the fetched file, nothing else.
  for (const violation of result.violations)
    assert.match(violation.message, /saved state|fetched media/, violation.message);
});
