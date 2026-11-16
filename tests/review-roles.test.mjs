import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {normalizeSnapshot, reviewStateHash, changedStateFields, reviewVolatile} from '../dist/src/review-state.js';
import {snapshotPlans} from '../dist/src/write-snapshots.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {lifecycle} from './helpers/review-lifecycle.mjs';
import {standardCreates} from './helpers/tiktok-standard-creates.mjs';
import {advertiserWorld} from './helpers/tiktok-advertiser-noise.mjs';
import {familyFixture} from './helpers/family-conformance.mjs';
import xCreatives from './family-descriptors/x-creatives.mjs';

/**
 * R2.5 M1 (package r25-m1-hash, plan idea 1, the three read roles; L5-01, L4-13, M0's "Found, not fixed" 3 and 4).
 *
 * An ACCOUNT read (the account a create is made in) or a PARENT read (the parent a child is created under) shows what a
 * write under it depends on: who and what it is, its status, its currency and time zone. A review keeps only that, so a
 * field that changes without the user (a balance, a signed link, a counter, a last-modified time) never refuses a write
 * (TikTok's advertiser row was the first, T1; X, LinkedIn and DV360 had the same hash of a whole account row). The
 * objects a write CHANGES are the other role and keep everything but telemetry. These tests pin the field lists by hand
 * (not from the code), prove each projection idempotent and monotone, and drive the real lifecycle: rotation passes,
 * a real change of an identity field refuses with nothing sent, and the gates that read a parent row still read it.
 * Every value is synthetic.
 */
const registry = new Registry();
const read = (gateway, path, fields = {}) => ({
  gateway,
  action: 'AMCP_STATE_READ',
  method: 'GET',
  path,
  query: {},
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  accountId: '123',
  evidence: 'TEST',
  warnings: [],
  ...fields,
});
// What changes at every read of an account or a parent, none of it identity: a signed link, a balance, a creation
// time, a contact and a counter (the White Friday signature, T1), under names no table lists.
const rotating = n => ({
  license_url: 'https://docs.example.test/licence?ticket=ticket-' + n + '&x-expires=' + (1700000000 + n),
  balance: 1000 - n * 3.25,
  create_time: 1700000000 + n,
  contact_email: 'synthetic' + n + '@example.test',
  notes_count: n,
  logo_url: 'https://cdn.example.test/l.png?x-signature=s' + n + '&v=2',
});

// --- The field lists, written out by hand -------------------------------------------------------------------------------

const scenarios = [
  {
    name: 'X account',
    gateway: 'x_ads_native_action',
    path: '/12/accounts/acct1',
    role: 'account',
    wrap: row => ({data: row, request: {params: {account_id: 'acct1'}}}),
    state: row => ({data: row}),
    identity: {
      id: 'acct1',
      name: 'Synthetic account',
      approval_status: 'ACCEPTED',
      deleted: false,
      timezone: 'Asia/Riyadh',
      business_id: 'b1',
      business_name: 'Synthetic business',
      currency: 'USD',
    },
    where: field => '$["data"]["' + field + '"]',
  },
  {
    name: 'X line item (parent)',
    gateway: 'x_ads_native_action',
    path: '/12/accounts/acct1/line_items/line1',
    role: 'parent',
    wrap: row => ({data: row, request: {params: {}}}),
    state: row => ({data: row}),
    identity: {
      id: 'line1',
      name: 'Synthetic line item',
      account_id: 'acct1',
      campaign_id: 'campaign1',
      entity_status: 'PAUSED',
      deleted: false,
      objective: 'WEBSITE_CLICKS',
      product_type: 'PROMOTED_TWEETS',
    },
    where: field => '$["data"]["' + field + '"]',
  },
  {
    name: 'X campaign (parent)',
    gateway: 'x_ads_native_action',
    path: '/12/accounts/acct1/campaigns/campaign1',
    role: 'parent',
    wrap: row => ({data: row, request: {params: {}}}),
    state: row => ({data: row}),
    identity: {
      id: 'campaign1',
      name: 'Synthetic campaign',
      account_id: 'acct1',
      entity_status: 'ACTIVE',
      deleted: false,
    },
    where: field => '$["data"]["' + field + '"]',
  },
  {
    name: 'LinkedIn account',
    gateway: 'linkedin_native_action',
    path: '/rest/adAccounts/123',
    role: 'account',
    wrap: row => row,
    state: row => row,
    identity: {
      id: 123,
      name: 'Synthetic account',
      status: 'ACTIVE',
      currency: 'USD',
      type: 'BUSINESS',
      reference: 'urn:li:organization:9',
      test: false,
    },
    where: field => '$["' + field + '"]',
  },
  {
    name: 'DV360 advertiser',
    gateway: 'dv360_native_action',
    path: '/v4/advertisers/123',
    role: 'account',
    wrap: row => row,
    state: row => row,
    identity: {
      advertiserId: '123',
      partnerId: '9',
      name: 'advertisers/123',
      displayName: 'Synthetic account',
      entityStatus: 'ENTITY_STATUS_ACTIVE',
      generalConfig: {currencyCode: 'USD', timeZone: 'Asia/Riyadh'},
    },
    where: field => '$["' + field.replace('.', '"]["') + '"]',
    // Non-identity fields of the same record: the domain of the advertiser is its configuration, not who it is.
    nested: {generalConfig: {domainUrl: 'https://shop.example.test'}},
  },
  {
    name: 'TikTok campaign (parent)',
    gateway: 'tiktok_native_action',
    path: '/v1.3/campaign/get/',
    role: 'parent',
    wrap: row => ({code: 0, message: 'OK', request_id: 'r', data: {list: [row], page_info: {page: 1, total_page: 1}}}),
    state: row => ({data: {list: [row]}}),
    identity: {
      campaign_id: '300',
      campaign_name: 'Synthetic campaign',
      advertiser_id: '9000000000000000001',
      operation_status: 'DISABLE',
      objective_type: 'TRAFFIC',
      campaign_type: 'REGULAR_CAMPAIGN',
    },
    where: field => '$["data"]["list"][0]["' + field + '"]',
  },
  {
    name: 'TikTok ad group (parent)',
    gateway: 'tiktok_native_action',
    path: '/v1.3/adgroup/get/',
    role: 'parent',
    wrap: row => ({code: 0, message: 'OK', request_id: 'r', data: {list: [row], page_info: {page: 1, total_page: 1}}}),
    state: row => ({data: {list: [row]}}),
    identity: {
      adgroup_id: '200',
      adgroup_name: 'Synthetic ad group',
      campaign_id: '300',
      advertiser_id: '9000000000000000001',
      operation_status: 'DISABLE',
      // The parent's own configuration that a gate of the child create reads (src/tiktok-manual-ad-identities.ts).
      placement_type: 'PLACEMENT_TYPE_NORMAL',
      placements: ['PLACEMENT_PANGLE'],
    },
    where: field => '$["data"]["list"][0]["' + field + '"]',
  },
];
const isRecord = v => !!v && typeof v === 'object' && !Array.isArray(v);
/** The identity of a row with the non-identity fields of the same record beside it (a nested record merges). */
const merged = (identity, nested = {}) =>
  Object.fromEntries(
    [...new Set([...Object.keys(identity), ...Object.keys(nested)])].map(k => [
      k,
      isRecord(identity[k]) && isRecord(nested[k]) ? {...identity[k], ...nested[k]} : (nested[k] ?? identity[k]),
    ]),
  );
const identityPaths = identity =>
  Object.entries(identity).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).map(n => k + '.' + n) : [k],
  );
const valueAt = (row, path) => path.split('.').reduce((v, k) => v[k], row);
const withValue = (row, path, value) => {
  const copy = structuredClone(row),
    parts = path.split('.');
  let at = copy;
  for (const part of parts.slice(0, -1)) at = at[part];
  at[parts.at(-1)] = value;
  return copy;
};
// A list that gains an item sorting last (membership lists such as `placements` are compared as sets, in sorted order).
const other = value =>
  typeof value === 'boolean' ? !value : Array.isArray(value) ? [...value, 'ZZ_CHANGED'] : String(value) + '-changed';

for (const s of scenarios) {
  const asRead = read(s.gateway, s.path, {stateRole: s.role}),
    asTarget = read(s.gateway, s.path),
    row = (n = 1) => ({...merged(structuredClone(s.identity), s.nested), ...rotating(n)});

  test(s.name + ': a review keeps its identity and nothing that changes without the user', () => {
    const kept = normalizeSnapshot(asRead, s.wrap(row(1)));
    assert.deepEqual(kept, s.state(s.identity));
    // The same row rotating, with the whole answer wrapped as the provider sends it: the same state.
    assert.deepEqual(normalizeSnapshot(asRead, s.wrap(row(2))), kept);
    const volatile = reviewVolatile(s.gateway);
    assert.equal(reviewStateHash(kept, volatile), reviewStateHash(normalizeSnapshot(asRead, s.wrap(row(7))), volatile));
  });

  test(s.name + ': a read of the objects a write changes is not an identity read', () => {
    // Without the role the same row is a target: its unknown fields stay protected.
    const a = normalizeSnapshot(asTarget, s.wrap(row(1))),
      b = normalizeSnapshot(asTarget, s.wrap(row(2))),
      volatile = reviewVolatile(s.gateway);
    assert.notEqual(reviewStateHash(a, volatile), reviewStateHash(b, volatile));
    assert.match(JSON.stringify(a), /contact_email|notes_count/);
  });

  test(s.name + ': a real change of each identity field changes the state and names that field', () => {
    const volatile = reviewVolatile(s.gateway),
      before = normalizeSnapshot(asRead, s.wrap(row(1)));
    for (const path of identityPaths(s.identity)) {
      const was = valueAt(s.identity, path),
        changed = normalizeSnapshot(asRead, s.wrap(withValue(row(2), path, other(was))));
      assert.notEqual(reviewStateHash(before, volatile), reviewStateHash(changed, volatile), path);
      // A list that gains an item differs at that item.
      const expected = Array.isArray(was) ? s.where(path) + '[' + was.length + ']' : s.where(path);
      assert.deepEqual(changedStateFields(before, changed, volatile), [expected], path);
    }
  });

  test(s.name + ': the projection is idempotent and monotone, and only identity decides (property, 300 rows)', () => {
    let seed = 20261116 + s.name.length;
    const r = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0), seed / 4294967296),
      volatile = reviewVolatile(s.gateway),
      subset = (out, input) =>
        Array.isArray(input)
          ? Array.isArray(out) && out.length === input.length && out.every((v, i) => subset(v, input[i]))
          : input && typeof input === 'object'
            ? !!out &&
              typeof out === 'object' &&
              Object.keys(out).every(k => Object.hasOwn(input, k) && subset(out[k], input[k]))
            : out === input;
    const quiet = normalizeSnapshot(asRead, s.wrap(merged(structuredClone(s.identity), s.nested)));
    for (let i = 0; i < 300; i++) {
      const noisy = {
        ...merged(structuredClone(s.identity), s.nested),
        ...Object.fromEntries(
          Array.from({length: 1 + Math.floor(r() * 5)}, (_, k) => [
            'noise_' + k + '_' + Math.floor(r() * 9),
            r() < 0.5 ? Math.floor(r() * 1e6) : {n: r(), s: 'https://x.example/a?sig=' + Math.floor(r() * 1e6)},
          ]),
        ),
      };
      const answer = s.wrap(noisy),
        once = normalizeSnapshot(asRead, answer);
      // Re-projecting the state it kept (as a saved review is, at execute) changes nothing.
      assert.deepEqual(normalizeSnapshot(asRead, once), once, 'idempotent');
      assert.ok(subset(once, s.wrap(noisy)) || subset(once, s.state(noisy)), 'monotone');
      // Only identity decides: the noise alone never changes the hash.
      assert.equal(reviewStateHash(once, volatile), reviewStateHash(quiet, volatile));
    }
  });
}

// --- The gates that read a parent row still read it ---------------------------------------------------------------------

const tiktok = (parentExtra, tenant) => standardCreates(advertiserWorld({rotating: true}), {parentExtra, tenant});
const campaignNoise = n => ({
  campaign_name: 'Synthetic campaign',
  objective_type: 'TRAFFIC',
  campaign_type: 'REGULAR_CAMPAIGN',
  budget: 100 + n,
  budget_mode: 'BUDGET_MODE_DAY',
  create_time: '2026-11-0' + (1 + (n % 8)) + ' 10:00:00',
  modify_time: '2026-11-1' + (n % 8) + ' 10:00:00',
  secondary_status: n % 2 ? 'CAMPAIGN_STATUS_DELIVERY_OK' : 'CAMPAIGN_STATUS_BUDGET_EXCEED',
  roas_bid: n,
});
const adgroupNoise = (n, extra = {}) => ({
  adgroup_name: 'Synthetic ad group',
  placement_type: 'PLACEMENT_TYPE_NORMAL',
  placements: ['PLACEMENT_PANGLE'],
  budget: 50 + n,
  bid_price: 0.1 + n / 100,
  modify_time: '2026-11-1' + (n % 8) + ' 10:00:00',
  secondary_status: n % 2 ? 'ADGROUP_STATUS_DELIVERY_OK' : 'ADGROUP_STATUS_BUDGET_EXCEED',
  ...extra,
});

test('TikTok parents: an ad group is created under a campaign whose counters and budget move, and sends what was reviewed', async () => {
  const f = tiktok((kind, n) => (kind === 'campaign' ? campaignNoise(n) : {}), 'roles-adgroup-rotation');
  try {
    const p = await f.prepare('adgroup');
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
    const done = await f.execute(p.data);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 700));
    assert.equal(f.sent.length, 1);
  } finally {
    f.close();
  }
});

test('TikTok parents: the parent campaign changing status between review and execute is STATE_CHANGED, nothing sent', async () => {
  const f = tiktok((kind, n) => (kind === 'campaign' ? campaignNoise(n) : {}), 'roles-adgroup-status');
  try {
    const p = await f.prepare('adgroup');
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
    f.parents.campaign = 'ENABLE';
    const done = await f.execute(p.data);
    assertRefused(done, 'STATE_CHANGED', {writes: () => f.sent.length});
    assert.deepEqual(done.error.details.changed_fields, ['$[1]["data"]["list"][0]["operation_status"]']);
  } finally {
    f.close();
  }
});

test('TikTok parents: an ad is created under an ad group whose counters move, and sends what was reviewed', async () => {
  const f = tiktok((kind, n) => (kind === 'adgroup' ? adgroupNoise(n) : {}), 'roles-ad-rotation');
  try {
    const p = await f.prepare('ad');
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
    const done = await f.execute(p.data);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 700));
    assert.equal(f.sent.length, 1);
  } finally {
    f.close();
  }
});

test('TikTok parents: a custom identity under an ad group that delivers on TikTok is still refused at review', async () => {
  // src/tiktok-manual-ad-identities.ts reads the PARENT ad group's placement_type, and skips its refusal when the field is
  // absent from the state: the parent projection keeps it, so the gate still sees it (the check is the negative test).
  const f = tiktok(
    (kind, n) =>
      kind === 'adgroup' ? adgroupNoise(n, {placement_type: 'PLACEMENT_TYPE_AUTOMATIC', placements: []}) : {},
    'roles-ad-gate',
  );
  try {
    assertRefused(await f.prepare('ad'), 'TIKTOK_CUSTOM_IDENTITY_PLACEMENT', {writes: () => f.sent.length});
  } finally {
    f.close();
  }
});

test('TikTok parents: an ad group that starts to deliver on TikTok after review is refused by that gate at execute', async () => {
  let placements = ['PLACEMENT_PANGLE'];
  const f = tiktok((kind, n) => (kind === 'adgroup' ? adgroupNoise(n, {placements}) : {}), 'roles-ad-gate-execute');
  try {
    const p = await f.prepare('ad');
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
    placements = ['PLACEMENT_PANGLE', 'PLACEMENT_TIKTOK'];
    assertRefused(await f.execute(p.data), 'TIKTOK_CUSTOM_IDENTITY_PLACEMENT', {writes: () => f.sent.length});
  } finally {
    f.close();
  }
});

test('TikTok parents: a change of the placements the ad group delivers on is a change, though no gate forbids it', async () => {
  // Neither list names TikTok, so the gate of the ad create has nothing to refuse; the list is compared as a set, in order.
  let placements = ['PLACEMENT_GLOBAL_APP_BUNDLE'];
  const f = tiktok((kind, n) => (kind === 'adgroup' ? adgroupNoise(n, {placements}) : {}), 'roles-ad-placements');
  try {
    const p = await f.prepare('ad');
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
    placements = ['PLACEMENT_GLOBAL_APP_BUNDLE', 'PLACEMENT_PANGLE'];
    const done = await f.execute(p.data);
    assertRefused(done, 'STATE_CHANGED', {writes: () => f.sent.length});
    assert.deepEqual(done.error.details.changed_fields, ['$[1]["data"]["list"][0]["placements"][1]']);
  } finally {
    f.close();
  }
});

// --- X, LinkedIn and DV360 creates: the account row ---------------------------------------------------------------------

const account = {
  x: {id: '123', name: 'Synthetic account', approval_status: 'ACCEPTED', timezone: 'Asia/Riyadh', deleted: false},
  linkedin: {id: 123, name: 'Synthetic account', status: 'ACTIVE', currency: 'USD', type: 'BUSINESS', test: false},
  dv360: {
    advertiserId: '123',
    partnerId: '9',
    name: 'advertisers/123',
    displayName: 'Synthetic account',
    entityStatus: 'ENTITY_STATUS_ACTIVE',
    generalConfig: {currencyCode: 'USD', timeZone: 'Asia/Riyadh', domainUrl: 'https://shop.example.test'},
  },
};
const creates = {
  x: (change = {}) => ({
    gateway: 'x_ads',
    args: {action: 'x_accounts_account_id_campaigns_post', payload: {name: 'Draft', entity_status: 'PAUSED'}},
    reply: {response: {data: {id: '111'}}},
    answer: (path, phase) =>
      path === '/12/accounts/123'
        ? {
            data: {...account.x, ...rotating(phase === 'prepare' ? 1 : 2), ...(phase === 'execute' ? change : {})},
            request: {params: {}},
          }
        : {data: {}},
    // The path of the field in the state the review kept: the account read is the one read.
    where: field => '$[0]["data"]["' + field + '"]',
  }),
  linkedin: (change = {}) => ({
    gateway: 'linkedin',
    args: {
      action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post',
      payload: {name: 'Draft', status: 'PAUSED', account: 'urn:li:sponsoredAccount:123'},
    },
    reply: {response: null, status: 201, headers: {'x-restli-id': '111'}},
    answer: (path, phase) => ({
      ...account.linkedin,
      ...rotating(phase === 'prepare' ? 1 : 2),
      servingStatuses: phase === 'prepare' ? ['RUNNABLE'] : ['STOPPED'],
      version: {versionTag: phase === 'prepare' ? '1' : '2'},
      ...(phase === 'execute' ? change : {}),
    }),
    where: field => '$[0]["' + field + '"]',
  }),
  dv360: (change = {}) => ({
    gateway: 'dv360',
    accountArgument: false,
    args: {
      action: 'DV360_ADVERTISERS_CAMPAIGNS_CREATE',
      params: {advertiserId: '123'},
      body: {displayName: 'Draft', entityStatus: 'ENTITY_STATUS_PAUSED'},
    },
    reply: {response: {campaignId: '111'}},
    answer: (path, phase) =>
      path === '/v4/advertisers/123'
        ? {
            ...account.dv360,
            ...rotating(phase === 'prepare' ? 1 : 2),
            updateTime: phase === 'prepare' ? '2026-11-16T10:00:00Z' : '2026-11-16T10:04:00Z',
            billingConfig: {billingProfileId: phase === 'prepare' ? '1' : '2'},
            ...(phase === 'execute' ? structuredClone(change) : {}),
          }
        : {},
    where: field => '$[0]["' + field.replace('.', '"]["') + '"]',
  }),
};
const changes = {
  x: [
    ['approval_status', {approval_status: 'UNDER_REVIEW'}],
    ['timezone', {timezone: 'Europe/London'}],
    ['deleted', {deleted: true}],
    ['name', {name: 'Renamed elsewhere'}],
  ],
  linkedin: [
    ['currency', {currency: 'EUR'}],
    ['status', {status: 'CANCELED'}],
    ['name', {name: 'Renamed elsewhere'}],
  ],
  dv360: [
    ['generalConfig.currencyCode', {generalConfig: {...account.dv360.generalConfig, currencyCode: 'EUR'}}],
    ['entityStatus', {entityStatus: 'ENTITY_STATUS_PAUSED'}],
    ['displayName', {displayName: 'Renamed elsewhere'}],
  ],
};
for (const provider of ['x', 'linkedin', 'dv360']) {
  test(
    provider + ' create: an account row whose link, balance, counters and times rotate is the same account',
    async () => {
      const {done, writes} = await lifecycle(creates[provider]());
      assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
      assert.equal(writes(), 1);
    },
  );
  test(provider + ' create: a real change of the account’s identity is STATE_CHANGED and nothing is sent', async () => {
    for (const [field, change] of changes[provider]) {
      const {done, writes, where} = await (async () => {
        const c = creates[provider](change),
          out = await lifecycle(c);
        return {...out, where: c.where};
      })();
      assertRefused(done, 'STATE_CHANGED', {writes});
      assert.deepEqual(done.error.details.changed_fields, [where(field)], provider + ' ' + field);
    }
  });
}

// --- X creatives: the account and the parents of a promotion --------------------------------------------------------------

const promotion = async (change, check) => {
  const f = familyFixture(xCreatives);
  try {
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 600));
    change(f.state);
    return await check(f, await f.execute(p.data));
  } finally {
    f.close();
  }
};

test('X promotion: its line item and campaign are parents, so a budget and a flight that change are not a change', async () => {
  await promotion(
    state => {
      Object.assign(state.line, {
        daily_budget_amount_local_micro: '9000000',
        servable: false,
        reasons_not_servable: ['EXPIRED'],
        effective_status: 'PAUSED',
        updated_at: '2026-11-16T10:04:00Z',
        start_time: '2026-12-01T00:00:00Z',
      });
      Object.assign(state.campaign, {
        daily_budget_amount_local_micro: '1',
        servable: false,
        total_budget_amount_local_micro: '5',
      });
    },
    (f, done) => {
      assert.equal(done.success, true, JSON.stringify(done).slice(0, 600));
      assert.equal(f.sent.length, 1);
    },
  );
});

test('X promotion: the parent line item or campaign changing status or name is STATE_CHANGED', async () => {
  for (const [what, change, path] of [
    ['line item status', s => (s.line.entity_status = 'ACTIVE'), '$[1]["line_item"]["entity_status"]'],
    ['line item name', s => (s.line.name = 'Renamed elsewhere'), '$[1]["line_item"]["name"]'],
    ['campaign status', s => (s.campaign.entity_status = 'PAUSED'), '$[1]["campaign"]["entity_status"]'],
  ])
    await promotion(change, (f, done) => {
      assertRefused(done, 'STATE_CHANGED', {writes: () => f.sent.length});
      assert.ok(
        done.error.details.changed_fields.includes(path),
        what + ': ' + JSON.stringify(done.error.details.changed_fields),
      );
    });
});

// --- Every create names its account and its parents -----------------------------------------------------------------------

test('lint: the reads a create makes of its account and its parent carry their role, and no other read does', () => {
  const plan = (gateway, path, body, fields = {}) => ({
    gateway,
    action: 'native',
    method: 'POST',
    path,
    query: {},
    headers: {},
    body,
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    accountId: '123',
    evidence: 'TEST',
    warnings: [],
    ...fields,
  });
  const roles = p => snapshotPlans(p, registry).map(r => r.stateRole ?? null);
  const tiktokAdvertiser = '9000000000000000001';
  assert.deepEqual(
    roles(
      plan(
        'tiktok_native_action',
        '/v1.3/campaign/create/',
        {advertiser_id: tiktokAdvertiser},
        {accountId: tiktokAdvertiser},
      ),
    ),
    ['account'],
  );
  assert.deepEqual(
    roles(
      plan(
        'tiktok_native_action',
        '/v1.3/adgroup/create/',
        {advertiser_id: tiktokAdvertiser, campaign_id: '300'},
        {accountId: tiktokAdvertiser},
      ),
    ),
    ['account', 'parent'],
  );
  assert.deepEqual(
    roles(
      plan(
        'tiktok_native_action',
        '/v1.3/ad/create/',
        {advertiser_id: tiktokAdvertiser, adgroup_id: '200', creatives: [{ad_name: 'a'}]},
        {accountId: tiktokAdvertiser},
      ),
    ),
    ['account', 'parent'],
  );
  assert.deepEqual(roles(plan('x_ads_native_action', '/12/accounts/123/campaigns', {name: 'Draft'})), ['account']);
  assert.deepEqual(roles(plan('x_ads_native_action', '/12/accounts/123/line_items', {name: 'Draft'})), ['account']);
  assert.deepEqual(roles(plan('linkedin_native_action', '/rest/adAccounts/123/adCampaigns', {name: 'Draft'})), [
    'account',
  ]);
  assert.deepEqual(roles(plan('dv360_native_action', '/v4/advertisers/123/campaigns', {displayName: 'Draft'})), [
    'account',
  ]);
  // An edit reads the object it changes: no role.
  assert.deepEqual(
    roles(
      plan(
        'tiktok_native_action',
        '/v1.3/campaign/update/',
        {advertiser_id: tiktokAdvertiser, campaign_id: '300'},
        {accountId: tiktokAdvertiser},
      ),
    ),
    [null],
  );
  assert.deepEqual(
    roles(plan('x_ads_native_action', '/12/accounts/123/campaigns/111', {name: 'Renamed'}, {method: 'PUT'})),
    [null],
  );
  assert.deepEqual(
    roles(plan('linkedin_native_action', '/rest/adAccounts/123/adCampaigns/111', {patch: {$set: {name: 'R'}}})),
    [null],
  );
});
