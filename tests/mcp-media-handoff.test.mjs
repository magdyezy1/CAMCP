// V2-MCP-06, decision 2, target probe 15: a native gateway's upload under the v2 contract profile writes nothing and returns
// MEDIA_REVIEW_REQUIRED with a next_call to amcp_media, as a native change returns WRITE_REVIEW_REQUIRED with a next_call to
// amcp_write. Under legacy a native upload with dry_run:false still fetches the file and saves a review: the control that shows
// each assertion below could see a save. The routes are every native upload AMCP runs: the payload.url actions of the captured
// gateways, and amcp_native_action platform_media_upload for each of the seven platforms. Nothing in an AMCP store is written
// by a v2 call except the audit line of the refusal, which every refused call leaves: no review, no staged or retained bytes,
// no admission, no job, no idempotency claim; no provider request and no fetch of the file.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {withContractProfile} from '../dist/src/contract-profile.js';
import {setContractProfile} from '../dist/src/mcp-client-profile.js';
import {mediaPlatforms} from '../dist/src/media-routing.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {oauthStack} from './helpers/mcp-oauth-stack.mjs';

const key = Buffer.alloc(32, 41).toString('base64'),
  link = 'https://drive.google.com/file/d/abcdefghijklmno/view?usp=sharing',
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
const operator = {tenantId: 't', userId: 'u', role: 'operator'},
  reader = {...operator, userId: 'r', role: 'reader'},
  admin = {...operator, role: 'admin'};
// The native actions that are upload routes, one per platform where a gateway takes the file in payload.url.
const direct = [
  ['meta', 'meta_image_upload'],
  ['meta', 'meta_video_upload'],
  ['tiktok', 'tiktok_image_upload'],
  ['tiktok', 'tiktok_video_upload'],
  ['snapchat', 'snapchat_media_create'],
  ['google_ads', 'google_ads_v23_asset_mutate_assets'],
  ['google_ads', 'google_ads_v23_you_tube_video_upload_create_you_tube_video_upload'],
];
const workflowName = platform => ({google_ads: 'google', x_ads: 'x'})[platform] ?? platform;

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(24)]);

/** One store, every platform connected with a write grant, a provider that records its requests and a file source that counts. */
function world({allowWrites = true, kind = 'image', grant = true} = {}) {
  const store = new Store(':memory:', key),
    requests = [],
    file = kind === 'video' ? mp4 : png;
  let downloads = 0;
  for (const platform of mediaPlatforms)
    store.putConnection(
      admin,
      {
        id: platform,
        tenantId: 't',
        gateway: platform + '_native_action',
        accounts: ['123'],
        writeAccounts: grant ? ['123'] : [],
        label: 'Synthetic ' + platform,
        enabled: true,
        scopes: [],
      },
      {accessToken: 'synthetic', developerToken: 'synthetic', consumerKey: 's', consumerSecret: 's', tokenSecret: 's'},
    );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (input, init) => {
      const url = new URL(String(input)),
        method = init?.method ?? 'GET';
      requests.push(method + ' ' + url.pathname);
      // The reads a prepare makes of the account, in each platform's own shape; a write is never answered. A call that hands
      // off sends neither.
      const host = url.hostname,
        read = body => Response.json(body);
      if (host.includes('facebook')) return read({id: 'act_123', account_status: 1, currency: 'USD', name: 'Account'});
      if (host.includes('snapchat'))
        return read({
          request_status: 'SUCCESS',
          adaccounts: [{sub_request_status: 'SUCCESS', adaccount: {id: '123', name: 'Account'}}],
        });
      if (host.includes('tiktok')) return read({code: 0, data: {list: [{advertiser_id: '123', name: 'Account'}]}});
      if (host.includes('googleads') && url.pathname.endsWith(':search'))
        return read({results: [{customer: {id: '123', descriptiveName: 'Account'}}]});
      if (host.includes('linkedin')) return read({id: 123, name: 'Account'});
      if (host.includes('displayvideo')) return read({advertiserId: '123', displayName: 'Account'});
      if (method === 'GET') return read({data: {id: '123', name: 'Account'}});
      throw new Error('A native upload never writes before its review is executed');
    }),
    undefined,
    {allowWrites, requireBeforeState: true, maxBudgetChange: 0},
    async () => {
      downloads++;
      return new Response(new Uint8Array(file), {headers: {'Content-Type': 'application/octet-stream'}});
    },
  );
  /** Every AMCP table a saved review or a staged file could be in, counted: the audit trail is not among them. */
  const written = () =>
    Object.fromEntries(
      [
        'documents',
        'media_staging',
        'media_admissions',
        'media_chunks',
        'retained_media',
        'retained_media_chunks',
        'jobs',
        'idempotency',
      ].map(table => [
        table,
        store
          .sql()
          .prepare('SELECT count(*) AS n FROM ' + table)
          .get().n,
      ]),
    );
  return {store, service, requests, downloads: () => downloads, written, close: () => store.close()};
}
// One login per platform, so the account names it: no connection_id is needed.
const nativeCall = (_platform, action, extra = {}) => ({
  action,
  account_id: '123',
  payload: {url: link, name: 'Reviewed media'},
  ...extra,
});
const workflowCall = (platform, extra = {}) => ({
  operation: 'platform_media_upload',
  arguments: {action: 'UPLOAD_FROM_URL', platform: workflowName(platform), account_id: '123', url: link, ...extra},
});

for (const [platform, action] of direct)
  test(`v2: ${action} with dry_run:false writes nothing and hands off to amcp_media (legacy still saves its review)`, async () => {
    const kind = /video/.test(action) ? 'video' : 'image',
      w = world({kind});
    try {
      const gateway = platform + '_native_action',
        args = nativeCall(platform, action);
      // The preview is the same under both profiles, and names the amcp_media call the hand-off names.
      const preview = await w.service.call(gateway, args, operator);
      assert.equal(preview.success, true, JSON.stringify(preview.error));
      assert.equal(preview.data.dry_run, true);
      const before = w.written();
      // Under v2 the live call is refused, names that call, and has written nothing and fetched nothing.
      const refused = await withContractProfile('v2', () =>
        w.service.call(gateway, {...args, dry_run: false, confirmed: true}, operator),
      );
      assertRefused(refused, 'MEDIA_REVIEW_REQUIRED', {writes: w.requests.length});
      assert.deepEqual(refused.error.details.next_call, preview.data.next_call);
      assert.equal(refused.error.details.next_call.tool, 'amcp_media');
      assert.equal(refused.error.details.next_call.arguments.action, 'prepare');
      assert.equal(refused.error.details.next_call.arguments.platform, platform);
      assert.match(refused.error.next_action, /amcp_media/);
      assert.equal(refused.error.category, 'request');
      assert.equal(refused.error.retryable, false);
      assert.deepEqual(w.written(), before, 'nothing was saved');
      assert.equal(w.downloads(), 0, 'the file was not fetched');
      assert.equal(w.requests.length, 0);
      // The call it names is the reviewed path: it fetches the file and saves the review, which only a person's call does.
      const handedOff = await w.service.call('amcp_media', refused.error.details.next_call.arguments, operator);
      assert.equal(handedOff.success, true, JSON.stringify(handedOff.error));
      assert.equal(typeof handedOff.data.review_id, 'string');
      assert.equal(w.downloads(), 1);
      // The control: legacy, where the live call itself prepared a review and fetched the file.
      const w2 = world({kind});
      try {
        const saved = await w2.service.call(gateway, {...args, dry_run: false, confirmed: true}, operator);
        assert.equal(saved.success, true, JSON.stringify(saved.error));
        assert.equal(typeof saved.data.review_id, 'string');
        assert.equal(w2.downloads(), 1);
        assert.ok(w2.written().documents > 0);
      } finally {
        w2.close();
      }
    } finally {
      w.close();
    }
  });

for (const platform of mediaPlatforms)
  test(`v2: amcp_native_action platform_media_upload for ${platform} with dry_run:false writes nothing and hands off to amcp_media`, async () => {
    const w = world();
    try {
      const preview = await w.service.call('amcp_native_action', workflowCall(platform), operator);
      assert.equal(preview.success, true, JSON.stringify(preview.error));
      assert.equal(preview.data.dry_run, true);
      const before = w.written(),
        refused = await withContractProfile('v2', () =>
          w.service.call('amcp_native_action', workflowCall(platform, {dry_run: false}), operator),
        );
      assertRefused(refused, 'MEDIA_REVIEW_REQUIRED', {writes: w.requests.length});
      assert.deepEqual(refused.error.details.next_call, preview.data.next_call);
      assert.equal(refused.error.details.next_call.tool, 'amcp_media');
      assert.deepEqual(w.written(), before);
      assert.equal(w.downloads(), 0);
      assert.equal(w.requests.length, 0);
      // Legacy prepares the review there and then.
      const saved = await w.service.call('amcp_native_action', workflowCall(platform, {dry_run: false}), operator);
      assert.equal(saved.success, true, JSON.stringify(saved.error));
      assert.equal(typeof saved.data.review_id, 'string');
      assert.equal(w.downloads(), 1);
    } finally {
      w.close();
    }
  });

test('v2 refuses a caller who could not upload as legacy does, with the same code, and hands off to no one who could not', async () => {
  // A reader, a read-only deployment and an operator without the account's write grant: each is refused by the checks prepare
  // makes before it fetches anything, so the refusal is the same under both profiles, and no call that would fail is offered.
  const args = {...nativeCall('meta', 'meta_image_upload'), dry_run: false, confirmed: true},
    cases = [
      ['a reader', {}, reader, 'FORBIDDEN'],
      ['a read-only deployment', {allowWrites: false}, operator, 'LIVE_WRITES_DISABLED'],
      ['an account without a write grant', {grant: false}, operator, undefined],
    ];
  for (const [name, options, who, code] of cases) {
    const w = world(options);
    try {
      const legacy = await w.service.call('meta_native_action', args, who),
        v2 = await withContractProfile('v2', () => w.service.call('meta_native_action', args, who));
      assert.equal(legacy.success, false, name);
      if (code) assert.equal(legacy.error.code, code, name);
      assertRefused(v2, legacy.error.code);
      assert.notEqual(v2.error.code, 'MEDIA_REVIEW_REQUIRED', name);
      assert.equal(v2.error.details?.next_call, undefined, name);
      assert.equal(w.downloads(), 0, name);
      assert.equal(w.requests.length, 0, name);
    } finally {
      w.close();
    }
  }
});

test('v2 leaves the reviewed paths alone: amcp_write prepare of a native upload and amcp_native_action FINALIZE_UPLOAD_SESSION', async () => {
  const w = world();
  try {
    const prepared = await withContractProfile('v2', () =>
      w.service.call(
        'amcp_write',
        {
          action: 'prepare',
          gateway: 'meta_native_action',
          arguments: nativeCall('meta', 'meta_image_upload'),
        },
        operator,
      ),
    );
    assert.equal(prepared.success, true, JSON.stringify(prepared.error));
    assert.equal(typeof prepared.data.review_id, 'string');
    assert.equal(w.downloads(), 1);
    // Executing that frozen review through the workflow gateway is the same reviewed path.
    const finalize = await withContractProfile('v2', () =>
      w.service.call(
        'amcp_native_action',
        {
          operation: 'platform_media_upload',
          arguments: {
            action: 'FINALIZE_UPLOAD_SESSION',
            upload_session_id: prepared.data.review_id,
            idempotency_key: prepared.data.review_id,
            dry_run: true,
          },
        },
        operator,
      ),
    );
    assert.equal(finalize.success, true, JSON.stringify(finalize.error));
    assert.equal(finalize.data.next_call.tool, 'amcp_write');
  } finally {
    w.close();
  }
});

for (const era of ['legacy', 'modern'])
  test(`${era} HTTP: an AI client on v2 is handed off and one on legacy saves its review; a client switched to v2 is handed off at its next call`, async t => {
    const s = await oauthStack(t, {
      // The one read a prepare makes of the account; a call that hands off makes none.
      fetcher: async (_input, init) => {
        if ((init?.method ?? 'GET') !== 'GET') throw new Error('No provider write');
        return Response.json({id: 'act_123', account_status: 1, currency: 'USD', name: 'Account'});
      },
    });
    const older = await s.connect('Legacy client'),
      newer = await s.connect('Opted-in client');
    // The stack's own service is the one /mcp serves: give it the media connection and the file source.
    s.store.putConnection(
      {...admin, tenantId: 'local'},
      {
        id: 'meta',
        tenantId: 'local',
        gateway: 'meta_native_action',
        accounts: ['123'],
        writeAccounts: ['123'],
        label: 'Synthetic',
        enabled: true,
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    let downloads = 0;
    s.service.mediaFetcher = async () => {
      downloads++;
      return new Response(new Uint8Array(png), {headers: {'Content-Type': 'application/octet-stream'}});
    };
    const args = {...nativeCall('meta', 'meta_image_upload'), dry_run: false, confirmed: true},
      upload = client => client.callTool({name: 'meta_native_action', arguments: args}),
      reviews = () => s.store.documents('local', 'media_review').length;
    assert.equal(setContractProfile(s.store, newer.client.client_id, 'v2'), true);
    const optedIn = await s.client(era, newer.access),
      handedOff = await upload(optedIn);
    assert.equal(handedOff.isError, true);
    assertRefused(handedOff.structuredContent, 'MEDIA_REVIEW_REQUIRED');
    assert.equal(handedOff.structuredContent.error.details.next_call.tool, 'amcp_media');
    assert.equal(reviews(), 0);
    assert.equal(downloads, 0);
    // The other client, and a script's API key, are legacy: their live upload prepares the review as it always did.
    const saved = await upload(await s.client(era, older.access));
    assert.equal(saved.isError, undefined, JSON.stringify(saved.structuredContent));
    assert.equal(typeof saved.structuredContent.data.review_id, 'string');
    assert.equal(reviews(), 1);
    assert.equal(downloads, 1);
    // Switching the first client back is at its next call, with the token it holds.
    setContractProfile(s.store, newer.client.client_id, 'legacy');
    assert.equal((await upload(optedIn)).isError, undefined);
    assert.equal(reviews(), 2);
  });

test('the help of a native upload tells a v2 client what the call does, and a legacy client what it always said', async () => {
  const w = world();
  try {
    const describe = () =>
        w.service.call('meta_native_action', {action: 'DESCRIBE_ACTION', target_action: 'meta_image_upload'}, operator),
      legacy = (await describe()).data.amcp_media_import.instructions,
      v2 = (await withContractProfile('v2', describe)).data.amcp_media_import.instructions;
    assert.match(legacy, /A native dry_run:false import prepares only; follow its returned next_call after review\./);
    assert.doesNotMatch(legacy, /MEDIA_REVIEW_REQUIRED/);
    assert.doesNotMatch(v2, /prepares only/);
    assert.match(v2, /refused with MEDIA_REVIEW_REQUIRED/);
    assert.match(v2, /amcp_media prepare for the same file/);
    // The gateway's own help (amcp_tool_help) is read by the same client, in the same profile.
    const gatewayHelp = () => w.service.call('amcp_tool_help', {gateway: 'meta_native_action'}, operator),
      helpLegacy = (await gatewayHelp()).data.amcp_media_import.instructions,
      helpV2 = (await withContractProfile('v2', gatewayHelp)).data.amcp_media_import.instructions;
    assert.equal(helpLegacy, legacy);
    assert.equal(helpV2, v2); // Nothing else of the instructions changes: put the legacy sentence back and the two texts are the same.
    const sentence = /Under the v2 contract profile a native dry_run:false import saves nothing: [^.]*\./;
    assert.match(v2, sentence);
    assert.equal(
      v2.replace(sentence, 'A native dry_run:false import prepares only; follow its returned next_call after review.'),
      legacy,
    );
  } finally {
    w.close();
  }
});
