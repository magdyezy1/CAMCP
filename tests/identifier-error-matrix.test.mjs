// The identifier-error matrix (October review §5 "Conversion identifiers in errors"; disposition in docs/DECISIONS.md,
// DOC-02). Conversion uploads send click IDs (GCLID, GBRAID, WBRAID), transaction IDs and event IDs as they are; only
// people's emails and phones are hashed. Before this test, a provider error or reply that echoed those identifiers, or
// a phone number, was returned to the caller and written into the append-only audit chain, although AMCP keeps nothing
// of the people otherwise. Every echo of a value AMCP sent is now scrubbed, with the rest of the error kept useful.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {scrubPeople} from '../dist/src/personal-data.js';

const registry = new Registry(),
  sha = v => createHash('sha256').update(v).digest('hex'),
  now = Math.floor(Date.now() / 1000);
const saudi = {
  countries: ['SA'],
  consent_confirmed: true,
  platform_terms_confirmed: true,
  pdpl: {consent: true, transfer_abroad: true, withdrawal_removal: true},
};
const email = 'person.synthetic@example.org',
  phone = '+966501239876';

/** A synthetic workspace whose provider answers every write with `reply(body)`; reads answer as the family needs. */
function workspace({tenantId, gateway, account, scopes, read, reply}) {
  const owner = {tenantId, userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 58).toString('base64'));
  store.putConnection(
    owner,
    {id: 'c', tenantId, gateway, accounts: [account], writeAccounts: [account], enabled: true, label: 'S', scopes},
    {accessToken: 'synthetic', developerToken: 'synthetic-dev'},
  );
  let writes = 0;
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        text = String(init.body ?? '');
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = Object.fromEntries(
          [...new URLSearchParams(text)].map(([k, v]) => {
            try {
              return [k, JSON.parse(v)];
            } catch {
              return [k, v];
            }
          }),
        );
      }
      const answer = read(u, init.method, body);
      if (answer) return answer;
      writes++;
      return reply(body);
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
  const kept = () =>
    JSON.stringify([
      store.db.prepare('SELECT * FROM documents').all(),
      store.db.prepare('SELECT * FROM audit').all(),
      store.db.prepare('SELECT * FROM idempotency').all(),
      store.db.prepare('SELECT * FROM jobs').all(),
    ]);
  const upload = async (args, people) => {
    const enabled = await service.call(
      'amcp_workspace',
      {action: 'enable_personal_data', connection_id: 'c', account_id: account, confirmed: true},
      owner,
    );
    assert.equal(enabled.error, undefined, JSON.stringify(enabled).slice(0, 800));
    const p = await service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {account_id: account, ...args}, people, personal_data: saudi},
      owner,
    );
    assert.equal(p.error, undefined, JSON.stringify(p).slice(0, 1500));
    // Nothing of the identifiers is kept before the upload: the review holds counts and a digest only.
    const before = kept();
    return {
      before,
      result: await service.call(
        'amcp_write',
        {action: 'execute', review_id: p.data.review_id, confirmed: true, people},
        owner,
      ),
    };
  };
  return {upload, kept, writes: () => writes};
}

const google = reply =>
  workspace({
    tenantId: 'identifier-matrix-google',
    gateway: 'google_ads_native_action',
    account: '1234567890',
    scopes: ['https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/datamanager'],
    read(u, method, body) {
      if (!u.pathname.endsWith('/googleAds:search')) return undefined;
      if (/FROM customer\b/.test(body.query))
        return Response.json({results: [{customer: {resourceName: 'customers/1234567890', id: '1234567890'}}]});
      const id = /conversion_action\.id = (\d+)/.exec(body.query)[1];
      return Response.json({
        results: [
          {
            conversionAction: {
              resourceName: 'customers/1234567890/conversionActions/' + id,
              id,
              name: 'Offline sales',
              type: 'UPLOAD_CLICKS',
              status: 'ENABLED',
              ownerCustomer: 'customers/1234567890',
            },
          },
        ],
      });
    },
    reply,
  });
const googleIds = {
  gclid: 'Cj0KCQiA9zSynthGclid0001',
  gbraid: 'GbraidSynthetic0002',
  wbraid: 'WbraidSynthetic0003',
  transaction: 'order-synthetic-7781',
};
const googleEvents = {
  schema: ['EMAIL', 'PHONE'],
  rows: [
    {
      EMAIL: email,
      PHONE: phone,
      event_time: now - 3600,
      value: 10,
      currency: 'SAR',
      transaction_id: googleIds.transaction,
    },
    {gclid: googleIds.gclid, event_time: now - 7200},
    {gbraid: googleIds.gbraid, event_time: now - 7300},
    {wbraid: googleIds.wbraid, event_time: now - 7400},
  ],
};
const googleUpload = f =>
  f.upload(
    {
      action: 'DATA_MANAGER_INGEST_EVENTS',
      payload: {conversion_action_id: '800', consent: {ad_user_data: 'GRANTED', ad_personalization: 'GRANTED'}},
    },
    googleEvents,
  );
const leaks = (text, values) => Object.entries(values).filter(([, v]) => text.includes(v));

test('a Google error echoing click, transaction and phone identifiers is scrubbed from the reply and the audit', async () => {
  const hashedPhone = sha('+966501239876');
  const f = google(() =>
    Response.json(
      {
        error: {
          code: 400,
          message: `Invalid events: gclid ${googleIds.gclid}, gbraid ${googleIds.gbraid}, wbraid ${googleIds.wbraid}, transaction ${googleIds.transaction}, phone ${phone}, ${hashedPhone}`,
          status: 'INVALID_ARGUMENT',
          details: [
            {
              fieldViolations: [
                {field: 'events[1].adIdentifiers.gclid', description: 'Unknown click ' + googleIds.gclid},
                {field: 'events[0].transactionId', description: googleIds.transaction},
              ],
            },
            {[googleIds.gclid]: 'invalid', [googleIds.transaction]: 'duplicate', phone, email},
          ],
        },
      },
      {status: 400},
    ),
  );
  const {before, result} = await googleUpload(f);
  const all = {...googleIds, phone, phoneDigits: '966501239876', email, hashedPhone};
  assert.deepEqual(leaks(before, all), []);
  assert.equal(f.writes(), 1);
  // The error stays a useful provider error: its code, status, field paths and the provider's own words survive.
  assert.equal(result.error.code, 'UPSTREAM_ERROR');
  const upstream = result.error.details.upstream.error;
  assert.equal(result.error.details.http_status, 400);
  assert.equal(upstream.status, 'INVALID_ARGUMENT');
  assert.equal(upstream.details[0].fieldViolations[0].field, 'events[1].adIdentifiers.gclid');
  assert.match(upstream.message, /^Invalid events: gclid \[personal data\], gbraid \[personal data\]/);
  assert.deepEqual(leaks(JSON.stringify(result), all), [], 'the returned error');
  assert.deepEqual(leaks(f.kept(), all), [], 'the store, audit chain included');
});

// Already safe before this matrix (the family keeps a request ID and a warning count); kept as a guard.
test('a successful Google reply that echoes a sent click ID keeps no echo in the reply or the store', async () => {
  const f = google(body =>
    Response.json({
      requestId: 'ingest-1',
      fieldWarnings: [{field: 'events[1]', description: 'Click ' + body.events[1].adIdentifiers?.gclid + ' is old'}],
    }),
  );
  const {result} = await googleUpload(f);
  assert.equal(result.error, undefined, JSON.stringify(result).slice(0, 1200));
  const text = JSON.stringify(result);
  assert.match(text, /ingest-1/);
  assert.deepEqual(leaks(text, googleIds), []);
  assert.deepEqual(leaks(f.kept(), googleIds), []);
});

test('a Meta error echoing an event ID and a phone is scrubbed; event names and account numbers stay', async () => {
  const eventId = 'evt-synthetic-55501',
    f = workspace({
      tenantId: 'identifier-matrix-meta',
      gateway: 'meta_native_action',
      account: '123',
      scopes: ['ads_management'],
      read: (u, method) =>
        method === 'GET'
          ? u.pathname === '/v26.0/act_123/adspixels'
            ? Response.json({data: [{id: '700', name: 'Store pixel'}], paging: {}})
            : Response.json({error: {message: 'Unsupported get request.', code: 100}}, {status: 400})
          : undefined,
      reply: () =>
        Response.json(
          {
            error: {
              message: `Invalid parameter: event_id ${eventId} for Purchase on act_123 was already received from ${phone}`,
              code: 100,
              error_user_msg: 'Duplicate ' + eventId,
              fbtrace_id: 'AbCdEf123',
            },
          },
          {status: 400},
        ),
    });
  const {before, result} = await f.upload(
    {action: 'meta_pixel_id_events_create', params: {pixel_id: '700'}},
    {
      schema: ['EMAIL', 'PHONE'],
      rows: [
        {
          EMAIL: email,
          PHONE: phone,
          event_name: 'Purchase',
          event_time: now - 3600,
          action_source: 'physical_store',
          value: 5,
          currency: 'SAR',
          event_id: eventId,
        },
      ],
    },
  );
  assert.deepEqual(leaks(before, {eventId}), []);
  const text = JSON.stringify(result);
  assert.equal(result.error?.code, 'UPSTREAM_ERROR', text.slice(0, 1200));
  assert.match(result.error.details.upstream.error.message, /event_id \[personal data\] for Purchase on act_123/);
  assert.equal(result.error.details.upstream.error.fbtrace_id, 'AbCdEf123');
  assert.deepEqual(leaks(text, {eventId, phone, email}), []);
  assert.deepEqual(leaks(f.kept(), {eventId, phone, email}), []);
});

test('only whole sent values are scrubbed, so longer numbers that contain one survive', () => {
  const sent = new Set(['7781-a', 'Cj0KCQiA9zSynthGclid0001']);
  assert.deepEqual(
    scrubPeople({message: 'order 7781-a; request 17781-ab; Cj0KCQiA9zSynthGclid0001', count: 7781}, sent),
    {message: 'order [personal data]; request 17781-ab; [personal data]', count: 7781},
  );
  // Without sent values, the scrub is the one personal-data requests always had, plus E.164 phones.
  assert.equal(scrubPeople('call +966501239876 or 1234567890'), 'call [personal data] or 1234567890');
});
