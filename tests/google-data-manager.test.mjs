import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {normalizeGoogleEmail, normalizeGooglePhone} from '../dist/src/personal-data.js';

/**
 * Google Customer Match and offline conversions through the Data Manager API, opened by the owner on 2026-09-30
 * ("Confirm on google": the datamanager scope, and the uploader's own confirmation of Google's Customer Match terms).
 * Google's references (read 2026-09-30): audienceMembers:ingest ("At most 10000"), audienceMembers:remove, events:ingest
 * ("At most 2000"), requestStatus:retrieve, TermsOfService, Destination, and the formatting guide (emails lower-cased
 * without whitespace, gmail.com dots and +suffix removed; phones E.164 with the plus sign).
 */
const gateway = 'google_ads_native_action',
  registry = new Registry(),
  tenantId = 'google-data-manager',
  operator = {tenantId, userId: 'operator', role: 'operator'},
  owner = {tenantId, userId: 'owner', role: 'admin'},
  CUSTOMER = '1234567890',
  adwords = 'https://www.googleapis.com/auth/adwords',
  datamanager = 'https://www.googleapis.com/auth/datamanager';
const sha = v => createHash('sha256').update(v).digest('hex');
const cloudy = sha('cloudysanfrancisco@gmail.com'),
  user = sha('user.name+nyc@example.com'),
  phone = sha('+966501234567');
const saudi = {
  countries: ['SA'],
  consent_confirmed: true,
  platform_terms_confirmed: true,
  pdpl: {consent: true, transfer_abroad: true, withdrawal_removal: true},
};
const granted = {ad_user_data: 'GRANTED', ad_personalization: 'DENIED'};
const people = {
  schema: ['EMAIL', 'PHONE'],
  rows: [
    ['Cloudy.SanFrancisco+shopping@gmail.com', ''],
    [' user.name+NYC@Example.com ', '+966 50 123 4567'],
    ['cloudysanfrancisco@gmail.com', ''],
  ],
};
const now = Math.floor(Date.now() / 1000);
const events = {
  schema: ['EMAIL'],
  rows: [
    {
      EMAIL: 'user.name+NYC@Example.com',
      event_time: now - 3600,
      value: 250,
      currency: 'SAR',
      transaction_id: 'order-7',
    },
    {gclid: 'Cj0KCQiA1234567890abcdEFGH', event_time: now - 7200, event_source: 'WEB'},
  ],
};

function fixture({scopes = [adwords, datamanager], status = 'SUCCESS', listType = 'CRM_BASED', loginCustomer} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 57).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'g',
      tenantId,
      gateway,
      accounts: [CUSTOMER],
      writeAccounts: [CUSTOMER],
      enabled: true,
      label: 'Synthetic Google',
      scopes,
      ...(loginCustomer ? {accountLoginCustomers: {[CUSTOMER]: loginCustomer}} : {}),
    },
    {accessToken: 'synthetic', developerToken: 'synthetic-dev'},
  );
  const calls = [];
  let writes = 0,
    lastBody;
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({
        origin: u.origin,
        path: u.pathname,
        method: init.method,
        query: Object.fromEntries(u.searchParams),
        body,
        headers: init.headers,
      });
      if (u.origin === 'https://googleads.googleapis.com' && u.pathname.endsWith('/googleAds:search')) {
        const q = body.query;
        if (/FROM customer\b/.test(q))
          return Response.json({
            results: [{customer: {resourceName: 'customers/' + CUSTOMER, id: CUSTOMER, manager: false}}],
          });
        if (/FROM user_list\b/.test(q)) {
          const id = /user_list\.id = (\d+)/.exec(q)[1];
          if (id === '404') return Response.json({results: []});
          return Response.json({
            results: [
              {
                userList: {
                  resourceName: 'customers/' + CUSTOMER + '/userLists/' + id,
                  id,
                  name: 'Newsletter',
                  type: listType,
                  readOnly: false,
                  membershipStatus: 'OPEN',
                  crmBasedUserList: {uploadKeyType: 'CONTACT_INFO'},
                },
              },
            ],
          });
        }
        if (/FROM conversion_action\b/.test(q)) {
          const id = /conversion_action\.id = (\d+)/.exec(q)[1];
          return Response.json({
            results: [
              {
                conversionAction: {
                  resourceName: 'customers/' + CUSTOMER + '/conversionActions/' + id,
                  id,
                  name: 'Offline sales',
                  type: id === '801' ? 'WEBPAGE' : 'UPLOAD_CLICKS',
                  status: 'ENABLED',
                  ownerCustomer: 'customers/' + CUSTOMER,
                },
              },
            ],
          });
        }
        throw Error('Unexpected query ' + q);
      }
      if (u.origin === 'https://datamanager.googleapis.com') {
        if (init.method === 'GET' && u.pathname === '/v1/requestStatus:retrieve') {
          const sent = lastBody.audienceMembers?.length ?? lastBody.events?.length;
          const counts = lastBody.events
            ? {eventsIngestionStatus: {recordCount: String(sent)}}
            : u.searchParams.get('requestId').startsWith('remove')
              ? {
                  audienceMembersRemovalStatus: {
                    userDataRemovalStatus: {recordCount: String(sent), userIdentifierCount: '3'},
                  },
                }
              : {
                  audienceMembersIngestionStatus: {
                    userDataIngestionStatus: {
                      recordCount: String(sent),
                      userIdentifierCount: '3',
                      uploadMatchRateRange: 'MATCH_RATE_RANGE_51_TO_60',
                    },
                  },
                };
          return Response.json({
            requestStatusPerDestination: [
              {
                destination: lastBody.destinations[0],
                requestStatus: status,
                ...(status === 'PROCESSING' ? {} : counts),
              },
            ],
          });
        }
        writes++;
        lastBody = body;
        const kind = u.pathname.endsWith(':remove') ? 'remove' : 'ingest';
        return Response.json({requestId: kind + '-' + writes, ...(body.events ? {fieldWarnings: []} : {})});
      }
      throw Error('Unexpected ' + init.method + ' ' + u.href);
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
  const prepare = (action, payload, peopleArg, personal_data, actor = operator) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action, account_id: CUSTOMER, payload},
        ...(peopleArg !== undefined ? {people: peopleArg} : {}),
        ...(personal_data !== undefined ? {personal_data} : {}),
      },
      actor,
    );
  const execute = (p, peopleArg, actor = owner) =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, confirmed: true, ...(peopleArg ? {people: peopleArg} : {})},
      actor,
    );
  const verify = (p, actor = owner) =>
    service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  const kept = () =>
    JSON.stringify([
      store.db.prepare('SELECT data FROM documents').all(),
      store.db.prepare('SELECT event FROM audit').all(),
      store.db.prepare('SELECT result FROM idempotency').all(),
      store.db.prepare('SELECT input,result,error FROM jobs').all(),
    ]);
  return {store, calls, workspace, prepare, execute, verify, kept, writes: () => writes};
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
    'cloudy.sanfrancisco',
    'cloudysanfrancisco@gmail.com',
    'user.name+nyc@example.com',
    'user.name+NYC',
    '966501234567',
    cloudy,
    user,
    phone,
  ])
    assert.equal(text.includes(v), false, label + ' holds ' + v);
};
async function enable(f) {
  return ok(await f.workspace('enable_personal_data', {connection_id: 'g', account_id: CUSTOMER, confirmed: true}));
}
const ingest = 'DATA_MANAGER_INGEST_AUDIENCE_MEMBERS',
  removal = 'DATA_MANAGER_REMOVE_AUDIENCE_MEMBERS',
  conversions = 'DATA_MANAGER_INGEST_EVENTS';

test('Google formats emails and phones its own way', () => {
  assert.equal(normalizeGoogleEmail('Cloudy.SanFrancisco+shopping@gmail.com'), 'cloudysanfrancisco@gmail.com');
  assert.equal(normalizeGoogleEmail(' user.name+NYC@Example.com '), 'user.name+nyc@example.com');
  assert.equal(normalizeGoogleEmail('first last@example.com'), 'firstlast@example.com');
  assert.equal(normalizeGoogleEmail('.+x@googlemail.com'), undefined);
  assert.equal(normalizeGooglePhone('+1 (800) 555-0100'), '+18005550100');
  assert.equal(normalizeGooglePhone('0501234567'), undefined);
});

test('Customer Match: hashed in memory, consent and terms from the uploader, sent by the owner, verified by status', async () => {
  const f = fixture({loginCustomer: '5555555555'});
  await enable(f);
  const p = ok(await f.prepare(ingest, {user_list_id: '42', consent: granted}, people, saudi));
  const record = p.data.request.personalData;
  assert.deepEqual(record.counts, {rows: 3, sent: 2, duplicates: 1, refused: {}});
  assert.deepEqual(record.settings, {
    user_list_id: '42',
    consent: {adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_DENIED'},
  });
  assert.match(JSON.stringify(p.data.creative_impact), /Newsletter/);
  assert.match(JSON.stringify(p.data.creative_impact), /uploader confirmed/);
  noPeople(JSON.stringify(p), 'the prepare response');
  refused(await f.execute(p, people, operator), 'OWNER_REQUIRED');
  ok(await f.execute(p, people));
  const sent = f.calls.find(c => c.origin === 'https://datamanager.googleapis.com' && c.method === 'POST');
  assert.equal(sent.path, '/v1/audienceMembers:ingest');
  assert.equal(sent.headers['developer-token'], undefined);
  assert.equal(sent.headers['login-customer-id'], undefined);
  assert.deepEqual(sent.body.destinations, [
    {
      operatingAccount: {accountType: 'GOOGLE_ADS', accountId: CUSTOMER},
      loginAccount: {accountType: 'GOOGLE_ADS', accountId: '5555555555'},
      productDestinationId: '42',
    },
  ]);
  assert.equal(sent.body.encoding, 'HEX');
  assert.deepEqual(sent.body.termsOfService, {customerMatchTermsOfServiceStatus: 'ACCEPTED'});
  assert.deepEqual(sent.body.consent, {adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_DENIED'});
  const identifiers = sent.body.audienceMembers.map(m => m.userData.userIdentifiers);
  assert.deepEqual(
    identifiers.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
    [[{emailAddress: cloudy}], [{emailAddress: user}, {phoneNumber: phone}]].sort((a, b) =>
      JSON.stringify(a) < JSON.stringify(b) ? -1 : 1,
    ),
  );
  const v = ok(await f.verify(p));
  assert.equal(v.data.status, 'verified');
  assert.equal(v.data.checks[0].received, 2);
  assert.equal(v.data.checks[0].match_rate, 'MATCH_RATE_RANGE_51_TO_60');
  noPeople(JSON.stringify(v), 'the verification');
  noPeople(f.kept(), 'the store');
  // A removal needs no consent, confirmations or owner; it carries no terms field.
  const r = ok(await f.prepare(removal, {user_list_id: '42'}, people));
  ok(await f.execute(r, people, operator));
  const removed = f.calls.filter(c => c.method === 'POST' && c.path === '/v1/audienceMembers:remove')[0];
  assert.equal(removed.body.termsOfService, undefined);
  assert.equal(removed.body.consent, undefined);
  assert.equal(ok(await f.verify(r, operator)).data.status, 'verified');
});

test('Customer Match refuses what Google or the policy would not accept, before any upload', async () => {
  const f = fixture();
  await enable(f);
  refused(
    await f.prepare(ingest, {user_list_id: '42'}, people, saudi),
    'PERSONAL_DATA_CONFIRMATION_REQUIRED',
    /consent/,
  );
  refused(
    await f.prepare(ingest, {user_list_id: '42', consent: {ad_user_data: 'GRANTED'}}, people, saudi),
    'PERSONAL_DATA_CONFIRMATION_REQUIRED',
  );
  refused(
    await f.prepare(ingest, {user_list_id: '42', consent: granted, extra: 1}, people, saudi),
    'INVALID_GOOGLE_DATA_MANAGER',
  );
  refused(
    await f.prepare(ingest, {user_list_id: 'abc', consent: granted}, people, saudi),
    'INVALID_GOOGLE_DATA_MANAGER',
  );
  refused(await f.prepare(removal, {user_list_id: '42', consent: granted}, people), 'INVALID_GOOGLE_DATA_MANAGER');
  refused(await f.prepare(ingest, {user_list_id: '404', consent: granted}, people, saudi), 'STATE_TARGET_MISMATCH');
  const g = fixture({listType: 'RULE_BASED'});
  await enable(g);
  refused(
    await g.prepare(ingest, {user_list_id: '42', consent: granted}, people, saudi),
    'INVALID_GOOGLE_DATA_MANAGER',
    /Customer Match list/,
  );
  const h = fixture({scopes: [adwords]});
  await enable(h);
  refused(
    await h.prepare(ingest, {user_list_id: '42', consent: granted}, people, saudi),
    'INSUFFICIENT_SCOPE',
    /datamanager/,
  );
  assert.equal(f.writes() + g.writes() + h.writes(), 0);
  noPeople(f.kept() + g.kept() + h.kept(), 'the stores');
});

test('offline conversions: events by email or click ID to an upload conversion action, verified by status', async () => {
  const f = fixture();
  await enable(f);
  const p = ok(await f.prepare(conversions, {conversion_action_id: '800', consent: granted}, events, saudi));
  const record = p.data.request.personalData;
  assert.deepEqual(record.counts, {rows: 2, sent: 2, duplicates: 0, refused: {}});
  assert.deepEqual(record.summary.value, {SAR: 250});
  assert.equal(record.summary.with_click_id, 1);
  assert.match(JSON.stringify(p.data.creative_impact), /cannot be recalled/);
  ok(await f.execute(p, events));
  const sent = f.calls.find(c => c.method === 'POST' && c.path === '/v1/events:ingest');
  assert.equal(sent.body.destinations[0].productDestinationId, '800');
  const byClick = sent.body.events.find(e => e.adIdentifiers),
    byEmail = sent.body.events.find(e => e.userData);
  assert.deepEqual(byClick, {
    eventTimestamp: new Date((now - 7200) * 1000).toISOString(),
    adIdentifiers: {gclid: 'Cj0KCQiA1234567890abcdEFGH'},
    eventSource: 'WEB',
  });
  assert.deepEqual(byEmail, {
    eventTimestamp: new Date((now - 3600) * 1000).toISOString(),
    userData: {userIdentifiers: [{emailAddress: user}]},
    conversionValue: 250,
    currency: 'SAR',
    transactionId: 'order-7',
  });
  assert.equal(sent.body.termsOfService, undefined);
  assert.equal(ok(await f.verify(p)).data.status, 'verified');
  // The action must be an upload (UPLOAD_CLICKS) action of the account; events need a person or a click; windows.
  refused(
    await f.prepare(conversions, {conversion_action_id: '801', consent: granted}, events, saudi),
    'INVALID_GOOGLE_DATA_MANAGER',
    /UPLOAD_CLICKS/,
  );
  const mixed = ok(
    await f.prepare(
      conversions,
      {conversion_action_id: '800', consent: granted},
      {
        schema: ['EMAIL'],
        rows: [
          ...events.rows,
          {event_time: now - 60},
          {gclid: 'Cj0KCQiA1234567890abcdEFGH', wbraid: 'abcdefghijklmnop', event_time: now - 60},
          {EMAIL: 'a@example.com', event_time: now - 60, value: 5},
          {EMAIL: 'b@example.com', event_time: now - 60, transaction_id: 'b@example.com'},
        ],
      },
      saudi,
    ),
  );
  assert.deepEqual(mixed.data.request.personalData.counts.refused, {
    no_person_or_click: 1,
    more_than_one_click_id: 1,
    value_without_currency: 1,
    invalid_transaction_id: 1,
  });
  refused(
    await f.prepare(
      conversions,
      {conversion_action_id: '800', consent: granted},
      {schema: ['EMAIL'], rows: [{EMAIL: 'a@example.com', event_time: now - 91 * 86400}]},
      saudi,
    ),
    'PERSONAL_DATA_INVALID',
    /90 days/,
  );
  noPeople(f.kept(), 'the store after conversions');
});

test('a status still processing leaves verification pending; the ledger records both families', async () => {
  const f = fixture({status: 'PROCESSING'});
  await enable(f);
  const p = ok(await f.prepare(ingest, {user_list_id: '42', consent: granted}, people, saudi));
  ok(await f.execute(p, people));
  assert.equal((await f.verify(p)).data?.status, 'pending');
  const rows = actionContracts(registry);
  const row = action => rows.find(r => r.gateway === gateway && r.action === action);
  assert.equal(row(ingest)?.family, 'google_customer_match');
  assert.equal(row(removal)?.family, 'google_customer_match');
  assert.equal(row(conversions)?.family, 'google_offline_conversions');
  for (const action of ['CREATE_OFFLINE_USER_DATA_JOB', 'UPLOAD_CLICK_CONVERSIONS'])
    assert.match(
      row(action).reason,
      /Data Manager API.*(reviewed|google_customer_match|google_offline_conversions)/,
      action,
    );
});
