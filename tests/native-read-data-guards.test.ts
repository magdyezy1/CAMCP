// SEC-04 B and C: secrets inside provider URLs never reach an AI client, while other provider text stays verbatim; and
// reads of submitted TikTok leads are refused as personal data even when an administrator bound the resource.
// Synthetic transports only: no provider is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../server/mcp.js';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {redactUrlSecrets} from '../src/security.js';
import {actionContracts} from '../src/action-contracts.js';
import {personalDataReadReason} from '../src/personal-data.js';
import type {Actor, Connection, JsonObject} from '../src/types.js';

const registry = new Registry(),
  actor: Actor = {tenantId: 'guards', userId: 'operator', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'};
function fixture(gateway: string, account: string, response: unknown, extra: Partial<Connection> = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 43).toString('base64')),
    calls: URL[] = [];
  store.putConnection(
    admin,
    {
      id: 'c',
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
      ...extra,
    },
    {accessToken: 'synthetic'},
  );
  const transport = new NativeTransport(
    async url => {
      calls.push(new URL(String(url)));
      return Response.json(response);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  return {store, calls, service: new MirrorService(registry, store, transport)};
}

test('URL secrets in a native read never reach content[0].text; text outside URLs is unchanged', async t => {
  const f = fixture('meta_native_action', '123', {
    data: [
      {
        id: '1',
        name: 'Spring token=KEEP-NAME-TOKEN sale',
        permalink_url: 'https://www.facebook.com/example/posts/1?id=1&access_token=SYNTH-SECRET-ONE',
        notes: ['https://cdn.example.test/a.png?sig=SYNTH-SECRET-TWO#token=SYNTH-SECRET-THREE'],
      },
    ],
    paging: {
      cursors: {after: 'opaque-after'},
      next: 'https://graph.facebook.com/v26.0/act_123/campaigns?access_token=SYNTH-SECRET-FOUR&after=opaque-after',
    },
  });
  const server = createMcpServer(f.service, actor),
    client = new Client({name: 'guards-test', version: '1'}),
    [c, s] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
    f.store.close();
  });
  await Promise.all([server.connect(s), client.connect(c)]);
  const result: any = await client.callTool({
    name: 'meta_native_action',
    arguments: {action: 'meta_campaign_list', account_id: '123', params: {fields: 'id,name'}},
  });
  const text = result.content[0].text as string;
  // Old code returned every provider URL verbatim, access_token included.
  assert.doesNotMatch(text, /SYNTH-SECRET/);
  assert.match(text, /Spring token=KEEP-NAME-TOKEN sale/, 'a name containing token= outside a URL is not touched');
  const data = JSON.parse(text).data;
  assert.equal(data.url_secrets_redacted, 3);
  assert.equal(
    data.data.paging.next,
    'https://graph.facebook.com/v26.0/act_123/campaigns?access_token=[REDACTED]&after=opaque-after',
  );
  assert.equal(data.data.paging.cursors.after, 'opaque-after');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.searchParams.get('access_token'), null, 'AMCP authenticates by header, never in the URL');
});

test('signed provider links keep their signature, never their credentials', () => {
  const signed = new Set(['imageTemporaryUrl']);
  const {value, redacted} = redactUrlSecrets(
    {
      generatedImages: [
        {imageTemporaryUrl: 'https://images.example.test/g?signature=LINK-SIGNATURE&access_token=SECRET-A'},
      ],
      other: 'https://images.example.test/g?signature=SECRET-B',
      plain: 'not a url ?token=KEEP',
    },
    signed,
  );
  assert.deepEqual(value, {
    generatedImages: [
      {imageTemporaryUrl: 'https://images.example.test/g?signature=LINK-SIGNATURE&access_token=[REDACTED]'},
    ],
    other: 'https://images.example.test/g?signature=[REDACTED]',
    plain: 'not a url ?token=KEEP',
  });
  assert.equal(redacted, 2);
});

const leadReads: [string, JsonObject][] = [
  ['tiktok_lead_get', {lead_source: 'INSTANT_FORM', page_id: '9001'}],
  ['tiktok_page_lead_task_download', {task_id: '9002'}],
  ['tiktok_page_lead_mock_get', {lead_source: 'INSTANT_FORM', page_id: '9001'}],
];
for (const [action, params] of leadReads)
  test(action + ' is refused as personal data even with a matching resource binding', async () => {
    const advertiser = '7000000000000000001',
      f = fixture(
        'tiktok_native_action',
        advertiser,
        {code: 0, data: {leads: [{name: 'Synthetic Person'}]}},
        {
          resourceBindings: [
            {accountId: advertiser, pathPrefix: '/v1.3/lead'},
            {accountId: advertiser, pathPrefix: '/v1.3/page/lead'},
          ],
        },
      );
    try {
      for (const dry_run of [false, true]) {
        const r = await f.service.call(
          'tiktok_native_action',
          {action, account_id: advertiser, params, dry_run},
          actor,
        );
        // Old code: the administrator binding passed the scope check and the leads were read.
        assert.equal(r.success, false, JSON.stringify(r));
        assert.equal(r.error.code, 'PERSONAL_DATA_READ_FORBIDDEN');
        assert.match(r.error.message, /^Personal data/);
        assert.equal(r.error.message, personalDataReadReason, 'the refusal and the ledger state one sentence');
        assert.doesNotMatch(r.error.message + JSON.stringify(r.error.details), /provision|ownership_reads|next_call/);
      }
      assert.equal(f.calls.length, 0, 'no provider request');
    } finally {
      f.store.close();
    }
  });

test('the action ledger lists the three lead reads as unqualified personal-data reads', () => {
  const rows = actionContracts(registry).filter(r => r.gateway === 'tiktok_native_action');
  for (const [action] of leadReads) {
    const row = rows.find(r => r.action === action)!;
    assert.equal(row.status, 'unqualified_read', action);
    assert.match(row.reason, /^Personal data/);
    assert.doesNotMatch(row.reason, /provision/i, 'the ledger never suggests a binding for lead reads');
  }
  assert.equal(
    rows.find(r => r.action === 'tiktok_lead_field_get')!.status,
    'native_read',
    'form fields are not leads',
  );
});
