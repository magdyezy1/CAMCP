// ACC-06: the authorized read-only acceptance harness (tools/acceptance/read-acceptance.mjs). It must refuse without
// every owner flag before reading a credential, send nothing in a dry run, let through only the part's provider hosts,
// GET requests and documented read POSTs, and record references only: never an account ID, token, payload or value.
// Every provider answer here is synthetic; nothing reaches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {
  dryRunReads,
  readGuard,
  readLiveRefusals,
  readParts,
  readTemplate,
  redactRoute,
  responseShape,
  runReadAcceptance,
  tiktokReads,
  validateReadPlan,
  validateReadRecord,
} from '../tools/acceptance/read-acceptance.mjs';
import {measurementEventReport} from './fixtures/measurement-events-data.mjs';
import {
  measurementIdentityId,
  measurementIdentityMetadata,
  measurementIdentityReport,
} from './fixtures/measurement-identity-data.mjs';

const today = '2026-10-13',
  release = {revision: 'abcdef1', package_sha256: 'a'.repeat(64)},
  ids = {
    property: '480012345',
    gtm: '6001234567',
    container: '7001234567',
    linkedin: '5001234567',
    tiktok: '7000000000000000001',
    reddit: 't2_synthetic',
    x: '18ce54d4x5t',
  };
const base = part => ({
  ticket: 'ACC-06',
  part,
  authorization_ref: 'owner-auth-2026-10-13-' + part.replaceAll('_', '-'),
  release,
});
const plans = {
  measurement: {
    ...base('measurement'),
    reads: [
      {
        action: 'measurement_events',
        account_label: 'ga4-test-a',
        account_id: ids.property,
        requirements: {event_names: ['purchase', 'generate_lead'], minutes: 5},
      },
      {
        action: 'measurement_event_identity',
        account_label: 'ga4-test-a',
        account_id: ids.property,
        requirements: {
          event_name: 'purchase',
          test_id: measurementIdentityId,
          date_from: '2026-10-01',
          date_to: '2026-10-02',
          stream_id: '900',
          expected_count: 1,
        },
      },
      {
        action: 'measurement_audit',
        account_label: 'gtm-test-a',
        account_id: ids.gtm,
        requirements: {container_id: ids.container, workspace_id: '3'},
      },
      {action: 'measurement_conversions', account_label: 'linkedin-a', account_id: ids.linkedin},
    ],
  },
  tiktok: {
    ...base('tiktok'),
    account_label: 'tiktok-read-a',
    account_id: ids.tiktok,
    report: {since: '2026-10-01', until: '2026-10-07'},
  },
  reddit_value_unit: {
    ...base('reddit_value_unit'),
    account_label: 'reddit-read-a',
    account_id: ids.reddit,
    week: {since: '2026-09-28', until: '2026-10-04'},
    manual: {ui_conversion_value: '123.45', currency: 'USD', read_on: '2026-10-12'},
  },
  x_publisher_network: {
    ...base('x_publisher_network'),
    account_label: 'x-read-a',
    account_id: ids.x,
    window: {since: '2026-10-05', until: '2026-10-11'},
  },
};
const noIds = (value, extra = []) => {
  const text = JSON.stringify(value);
  for (const id of [...Object.values(ids), ...extra]) assert.ok(!text.includes(id), 'the record names ' + id);
};

test('ACC-06 plans: each template is refused until filled, and IDs, open ranges and unknown fields are refused', () => {
  for (const part of Object.keys(readParts)) {
    assert.ok(validateReadPlan(readTemplate(part), today).length, part + ' template is not runnable as is');
    assert.deepEqual(validateReadPlan(plans[part], today), [], part);
  }
  const cases = [
    [{...plans.tiktok, account_label: 'tiktok-7000000000'}, /owner label/],
    [{...plans.tiktok, report: {since: '2026-10-08', until: '2026-10-13'}}, /closed/],
    [{...plans.tiktok, report: {since: '2026-09-01', until: '2026-09-30'}}, /1 to 7 days/],
    [{...plans.tiktok, extra: true}, /unknown field extra/],
    [{...plans.tiktok, authorization_ref: ''}, /authorization_ref/],
    [{...plans.reddit_value_unit, week: {since: '2026-09-29', until: '2026-10-04'}}, /exactly 7 days/],
    [{...plans.reddit_value_unit, manual: {...plans.reddit_value_unit.manual, ui_conversion_value: '0'}}, /positive/],
    [
      {...plans.reddit_value_unit, manual: {...plans.reddit_value_unit.manual, read_on: '2026-10-03'}},
      /after the week/,
    ],
    [{...plans.x_publisher_network, account_id: 'Not An Id'}, /account_id/],
    [{...plans.measurement, reads: [plans.measurement.reads[0], plans.measurement.reads[0]]}, /read once per run/],
    [
      {
        ...plans.measurement,
        reads: [
          {
            ...plans.measurement.reads[1],
            requirements: {...plans.measurement.reads[1].requirements, test_id: 'real-user-1'},
          },
        ],
      },
      /synthetic amcp-test- identifier/,
    ],
    [{...plans.measurement, reads: [{...plans.measurement.reads[3], requirements: {}}]}, /takes no requirements/],
    [{...plans.tiktok, part: 'meta'}, /part is one of/],
  ];
  for (const [plan, pattern] of cases) {
    const problems = validateReadPlan(plan, today);
    assert.ok(
      problems.some(p => pattern.test(p)),
      String(pattern) + ': ' + problems.join('; '),
    );
  }
});

test('ACC-06 live flags: each missing or different flag is named, and a live run refuses before reading credentials', () => {
  const bytes = Buffer.from(JSON.stringify(plans.tiktok)),
    sha = createHash('sha256').update(bytes).digest('hex'),
    env = {
      AMCP_ACCEPTANCE_LIVE: 'true',
      AMCP_ACCEPTANCE_AUTHORIZATION: plans.tiktok.authorization_ref,
      AMCP_ACCEPTANCE_PLAN_SHA256: sha,
      AMCP_ACCEPTANCE_RUN_ID: 'acc06-run-1',
      AMCP_ACCEPTANCE_CREDENTIALS_JSON: '{}',
    };
  assert.deepEqual(readLiveRefusals(env, bytes, plans.tiktok), []);
  for (const [key, value, pattern] of [
    ['AMCP_ACCEPTANCE_LIVE', 'yes', /AMCP_ACCEPTANCE_LIVE/],
    ['AMCP_ACCEPTANCE_AUTHORIZATION', 'owner-auth-other', /authorization_ref/],
    ['AMCP_ACCEPTANCE_PLAN_SHA256', 'b'.repeat(64), /plan file/],
    ['AMCP_ACCEPTANCE_RUN_ID', '../escape', /run ID/],
    ['AMCP_ACCEPTANCE_CREDENTIALS_JSON', '', /CREDENTIALS_JSON/],
  ]) {
    const refusals = readLiveRefusals({...env, [key]: value}, bytes, plans.tiktok);
    assert.equal(refusals.length, 1, key);
    assert.match(refusals[0], pattern);
  }
  // The CLI: with every flag but the live switch, and unreadable credentials, it refuses and reads nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-acc06-')),
    file = path.join(dir, 'plan.json');
  try {
    fs.writeFileSync(file, bytes);
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AMCP_ACCEPTANCE_')));
    const run = spawnSync(process.execPath, ['tools/acceptance/read-acceptance.mjs', file, '--live'], {
      encoding: 'utf8',
      env: {...clean, ...env, AMCP_ACCEPTANCE_LIVE: 'false', AMCP_ACCEPTANCE_CREDENTIALS_JSON: 'not json'},
    });
    assert.equal(run.status, 1, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.equal(out.status, 'refused');
    assert.equal(out.provider_requests, 0);
    assert.deepEqual(out.refusals, ['AMCP_ACCEPTANCE_LIVE=true is not set']);
    assert.doesNotMatch(run.stderr + run.stdout, /not valid JSON/);
    // The dry run: valid, nothing sent, the missing flags listed and no account ID printed.
    const dry = spawnSync(process.execPath, ['tools/acceptance/read-acceptance.mjs', file], {
      encoding: 'utf8',
      env: clean,
    });
    assert.equal(dry.status, 0, dry.stderr);
    const plan = JSON.parse(dry.stdout);
    assert.equal(plan.status, 'valid');
    assert.equal(plan.provider_requests, 0);
    assert.equal(plan.ready_for_live, false);
    assert.equal(plan.live_refusals.length, 5);
    noIds(plan);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('ACC-06 dry runs list every read of each part by route and label, with no request and no account ID', async () => {
  for (const part of Object.keys(readParts)) {
    const out = await dryRunReads(plans[part], ['AMCP_ACCEPTANCE_LIVE=true is not set'], today);
    assert.equal(out.status, 'valid', JSON.stringify(out));
    assert.equal(out.provider_requests, 0);
    assert.ok(out.reads.length > 0);
    noIds(out);
  }
  const tiktok = await dryRunReads(plans.tiktok, [], today);
  assert.deepEqual(
    tiktok.reads.map(r => [r.ledger_action, r.method, r.route]),
    tiktokReads.map(r => [r.action, 'GET', expectedTikTokRoutes[r.id]]),
  );
  assert.equal(tiktok.ready_for_live, true);
  const x = await dryRunReads(plans.x_publisher_network, [], today);
  assert.match(x.reads[1].query, /placement=PUBLISHER_NETWORK/);
  assert.equal((await dryRunReads({...plans.tiktok, part: 'nope'}, [], today)).status, 'invalid_plan');
});
const expectedTikTokRoutes = {
  advertiser_info: '/v1.3/advertiser/info/',
  campaigns: '/v1.3/campaign/get/',
  adgroups: '/v1.3/adgroup/get/',
  ads: '/v1.3/ad/get/',
  report: '/v1.3/report/integrated/get/',
  identities: '/v1.3/identity/get/',
};

test('ACC-06 guard: other hosts, writes, method overrides and requests past the ceiling are refused before sending', async () => {
  let sent = 0;
  const fetcher = async () => {
    sent++;
    return Response.json({code: 0, data: {}}, {headers: {'x-request-id': 'req-1'}});
  };
  const guard = await readGuard(fetcher, 'tiktok', [ids.tiktok]);
  for (const [url, init] of [
    ['https://business-api.tiktok.com/open_api/v1.3/campaign/update/', {method: 'POST'}],
    ['https://business-api.tiktok.com/open_api/v1.3/campaign/get/', {method: 'DELETE'}],
    [
      'https://business-api.tiktok.com/open_api/v1.3/campaign/get/',
      {method: 'GET', headers: {'X-HTTP-Method-Override': 'POST'}},
    ],
    ['https://graph.facebook.com/v26.0/me', {method: 'GET'}],
    ['https://sandbox-ads.tiktok.com/open_api/v1.3/campaign/get/', {method: 'GET'}],
    ['http://business-api.tiktok.com/open_api/v1.3/campaign/get/', {method: 'GET'}],
    ['https://business-api.tiktok.com:8443/open_api/v1.3/campaign/get/', {method: 'GET'}],
  ])
    await assert.rejects(
      () => guard.fetch(url, init),
      e => e.code === 'ACCEPTANCE_ROUTE_REFUSED',
      url,
    );
  assert.equal(sent, 0);
  for (let i = 0; i < readParts.tiktok.limit; i++)
    await guard.fetch('https://business-api.tiktok.com/open_api/v1.3/campaign/get/?advertiser_id=' + ids.tiktok);
  await assert.rejects(
    () => guard.fetch('https://business-api.tiktok.com/open_api/v1.3/campaign/get/'),
    e => e.code === 'ACCEPTANCE_ROUTE_REFUSED' && /bounded/.test(e.message),
  );
  assert.equal(sent, readParts.tiktok.limit);
  assert.equal(guard.state.refused, 8);
  // Only the documented read POSTs pass, on their own host and route.
  const reddit = await readGuard(fetcher, 'reddit_value_unit', [ids.reddit]);
  await reddit.fetch('https://ads-api.reddit.com/api/v3/ad_accounts/' + ids.reddit + '/reports', {method: 'POST'});
  await assert.rejects(
    () => reddit.fetch('https://ads-api.reddit.com/api/v3/ad_accounts/' + ids.reddit + '/campaigns', {method: 'POST'}),
    e => e.code === 'ACCEPTANCE_ROUTE_REFUSED',
  );
  assert.equal(reddit.state.log[0].read_post, true);
  assert.equal(reddit.state.log[0].route, '/api/v3/ad_accounts/{id}/reports');
  // Routes never keep a native ID; shapes never keep a value.
  assert.equal(
    redactRoute('/tagmanager/v2/accounts/6001234567/containers/7001234567/workspaces/3'),
    '/tagmanager/v2/accounts/{id}/containers/{id}/workspaces/3',
  );
  assert.equal(redactRoute('/12/stats/accounts/' + ids.x, [ids.x]), '/12/stats/accounts/{id}');
  assert.deepEqual(responseShape({spend: '12.50', rows: [{id: 1}, {id: 2}], note: null}), {
    note: 'null',
    rows: {array: [{id: 'number'}]},
    spend: 'string',
  });
});

const measurementFetch = calls => async (input, init) => {
  const url = new URL(String(input));
  calls.push({host: url.hostname, method: init.method});
  if (url.hostname === 'analyticsdata.googleapis.com') {
    if (url.pathname.endsWith(':runRealtimeReport'))
      return Response.json(measurementEventReport(), {headers: {'x-request-id': 'ga4-realtime-1'}});
    if (url.pathname.endsWith('/metadata'))
      return Response.json({...measurementIdentityMetadata(), name: 'properties/' + ids.property + '/metadata'});
    if (url.pathname.endsWith(':runReport')) return Response.json(measurementIdentityReport());
  }
  // Tag Manager and LinkedIn refuse this login: a refusal is recorded as one, never as acceptance.
  if (url.hostname === 'api.linkedin.com')
    return Response.json(
      {status: 403, code: 'ACCESS_DENIED', message: 'Private denial text'},
      {status: 403, headers: {'x-li-uuid': 'li-uuid-1'}},
    );
  return Response.json(
    {error: {code: 403, status: 'PERMISSION_DENIED', message: 'Private denial text'}},
    {status: 403},
  );
};
const credentials = {
  ga4_native_action: {accessToken: 'synthetic-ga4'},
  gtm_native_action: {accessToken: 'synthetic-gtm'},
  linkedin_native_action: {accessToken: 'synthetic-linkedin'},
  tiktok_native_action: {accessToken: 'synthetic-tiktok'},
  reddit_native_action: {accessToken: 'synthetic-reddit'},
  x_ads_native_action: {consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', tokenSecret: 'ts'},
};
const run = (part, fetcher, extra = {}) =>
  runReadAcceptance(plans[part], {
    credentials,
    runId: 'acc06-' + part.replaceAll('_', '-'),
    planSha256: 'c'.repeat(64),
    fetcher,
    today,
    now: () => Date.parse('2026-10-13T09:00:00Z'),
    ...extra,
  });

test('ACC-06 measurement: GA4 reads are accepted with zero mutations, refusals stay refusals, and rows pass the ledger', async () => {
  const calls = [],
    record = await run('measurement', measurementFetch(calls));
  const by = Object.fromEntries(record.reads.map(r => [r.id, r]));
  assert.equal(by.measurement_events.outcome, 'accepted', JSON.stringify(by.measurement_events));
  assert.equal(by.measurement_event_identity.outcome, 'accepted', JSON.stringify(by.measurement_event_identity));
  assert.equal(by.measurement_audit.outcome, 'refused');
  assert.equal(by.measurement_conversions.outcome, 'refused');
  assert.deepEqual(by.measurement_conversions.provider_codes, ['ACCESS_DENIED']);
  assert.equal(record.outcome, 'refused');
  assert.equal(record.provider_mutations, 0);
  assert.equal(record.refused_requests, 0);
  assert.ok(calls.every(c => c.method === 'GET' || c.host === 'analyticsdata.googleapis.com'));
  assert.deepEqual(
    record.ledger_rows.map(r => [r.gateway, r.operation ?? null, r.action, r.outcome]),
    [
      ['ga4_native_action', 'ga4_data_report', 'realtime', 'accepted'],
      ['ga4_native_action', 'ga4_run_report', 'ga4_run_report', 'accepted'],
      ['gtm_native_action', 'gtm_audit_ops', 'gtm_audit_ops', 'refused'],
      ['linkedin_native_action', null, 'linkedin_rest_conversions_get', 'refused'],
    ],
  );
  assert.ok(record.ledger_rows.every(r => r.effect === 'read' && r.environment === 'native'));
  assert.deepEqual(await validateReadRecord(record), []);
  noIds(record, ['Private denial text', 'synthetic-ga4', 'PRIVATE']);
});

const tiktokAnswer =
  (failing = new Map()) =>
  async input => {
    const url = new URL(String(input)),
      route = url.pathname.replace('/open_api', ''),
      id = url.searchParams.get('advertiser_id') ?? JSON.parse(url.searchParams.get('advertiser_ids') ?? '[]')[0];
    const page = {page: 1, page_size: 1, total_number: 1, total_page: 1};
    if (failing.has(route))
      return Response.json({code: failing.get(route), message: 'No permission', request_id: 'tt-denied-1', data: {}});
    const data = {
      '/v1.3/advertiser/info/': {list: [{advertiser_id: id, name: 'Synthetic', currency: 'USD', timezone: 'Etc/GMT'}]},
      '/v1.3/campaign/get/': {
        list: [{campaign_id: '1800000000000001', advertiser_id: id, campaign_name: 'C'}],
        page_info: page,
      },
      '/v1.3/adgroup/get/': {
        list: [{adgroup_id: '1800000000000002', advertiser_id: id, adgroup_name: 'G'}],
        page_info: page,
      },
      '/v1.3/ad/get/': {list: [{ad_id: '1800000000000003', advertiser_id: id, ad_name: 'A'}], page_info: page},
      '/v1.3/report/integrated/get/': {
        list: [{dimensions: {campaign_id: '1800000000000001'}, metrics: {spend: '1.00', impressions: '10'}}],
        page_info: {page: 1, page_size: 10, total_number: 1, total_page: 1},
      },
      '/v1.3/identity/get/': {
        identity_list: [{identity_id: 'synthetic-identity', identity_type: 'CUSTOMIZED_USER'}],
        page_info: page,
      },
    }[route];
    return Response.json({code: 0, message: 'OK', request_id: 'tt-' + route.split('/')[2], data});
  };

test('ACC-06 TikTok: the six reads are accepted and recorded by reference; a TikTok permission code is not acceptance', async () => {
  const record = await run('tiktok', tiktokAnswer());
  assert.deepEqual(
    record.reads.map(r => [r.id, r.outcome]),
    tiktokReads.map(r => [r.id, 'accepted']),
    JSON.stringify(record.reads.map(r => [r.id, r.error_code])),
  );
  assert.equal(record.outcome, 'accepted');
  assert.equal(record.provider_requests, 6);
  assert.equal(record.provider_mutations, 0);
  assert.equal(record.ledger_rows.length, 6);
  assert.deepEqual(record.ledger_rows[0].evidence.status_codes, [200]);
  assert.match(record.ledger_rows[0].evidence.shape_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(record.ledger_rows[0].evidence.provider_request_ids, ['tt-advertiser']);
  assert.deepEqual(await validateReadRecord(record), []);
  noIds(record, ['Synthetic', 'synthetic-identity', '1800000000000001']);
  const denied = await run('tiktok', tiktokAnswer(new Map([['/v1.3/identity/get/', 40001]])));
  const identity = denied.reads.find(r => r.id === 'identities');
  assert.notEqual(identity.outcome, 'accepted');
  assert.deepEqual(identity.provider_codes, ['40001']);
  assert.notEqual(denied.outcome, 'accepted');
  assert.deepEqual(await validateReadRecord(denied), []);
});

const redditAnswer = value => async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith('/reports') && init.method === 'POST')
    return Response.json({
      data: {
        metrics: [
          {
            campaign_id: 'r1',
            SPEND: 2500000,
            CLICKS: 4,
            IMPRESSIONS: 100,
            CONVERSION_PURCHASE_TOTAL_ITEMS: 2,
            CONVERSION_PURCHASE_TOTAL_VALUE: value[0],
          },
          {
            campaign_id: 'r2',
            SPEND: 1000000,
            CLICKS: 1,
            IMPRESSIONS: 50,
            CONVERSION_PURCHASE_TOTAL_ITEMS: 1,
            CONVERSION_PURCHASE_TOTAL_VALUE: value[1],
          },
        ],
      },
    });
  if (url.pathname.endsWith('/campaigns'))
    return Response.json({
      data: [
        {id: 'r1', name: 'One', objective: 'CONVERSIONS'},
        {id: 'r2', name: 'Two', objective: 'CONVERSIONS'},
      ],
    });
  return Response.json({data: {id: ids.reddit, name: 'Synthetic Reddit', currency: 'USD', time_zone_id: 'UTC'}});
};

test('ACC-06 Reddit: a week that matches Reddit Ads Manager is accepted; a micros answer is flagged with its divisor', async () => {
  // 12000 + 345 cents = 123.45, the value the owner read in Reddit Ads Manager.
  const cents = await run('reddit_value_unit', redditAnswer([12000, 345]));
  assert.equal(cents.outcome, 'accepted', JSON.stringify(cents.result));
  assert.equal(cents.result.value_unit, 'matches_ui');
  assert.equal(cents.result.ratio, 1);
  assert.equal(cents.result.current_divisor, 100);
  assert.equal(cents.result.implied_divisor, 100);
  assert.equal(cents.ledger_rows.length, 1);
  assert.deepEqual(
    [cents.ledger_rows[0].operation, cents.ledger_rows[0].action, cents.ledger_rows[0].outcome],
    ['reddit_reporting_ops', 'GET_INSIGHTS', 'accepted'],
  );
  assert.equal(cents.provider_mutations, 0);
  assert.ok(cents.reads[0].requests.some(r => r.method === 'POST' && r.read_post));
  assert.deepEqual(await validateReadRecord(cents), []);
  // The totals stay out of the record: only the ratio and the divisors are kept.
  noIds(cents, ['123.45', '12345']);
  // If Reddit answered in micros, AMCP would overstate the value 10,000-fold: the run says so and accepts nothing.
  const micros = await run('reddit_value_unit', redditAnswer([120000000, 3450000]));
  assert.equal(micros.outcome, 'inconclusive');
  assert.equal(micros.result.value_unit, 'differs_from_ui');
  assert.equal(micros.result.implied_divisor, 1000000);
  assert.equal(micros.result.ratio, 10000);
  assert.equal(micros.ledger_rows[0].outcome, 'inconclusive');
  assert.deepEqual(await validateReadRecord(micros), []);
});

const xAnswer = refuse => async input => {
  const url = new URL(String(input));
  if (url.pathname.endsWith('/active_entities'))
    return Response.json(
      {
        data: [
          {
            entity_id: 'c1',
            activity_start_time: '2026-10-05T00:00:00Z',
            activity_end_time: '2026-10-07T00:00:00Z',
            placements: ['ALL_ON_TWITTER', 'PUBLISHER_NETWORK'],
          },
          {
            entity_id: 'c2',
            activity_start_time: '2026-10-06T00:00:00Z',
            activity_end_time: '2026-10-08T00:00:00Z',
            placements: ['ALL_ON_TWITTER'],
          },
        ],
        request: {params: {}},
      },
      {headers: {'x-transaction-id': 'x-tx-1'}},
    );
  assert.equal(url.searchParams.get('placement'), 'PUBLISHER_NETWORK');
  assert.equal(url.searchParams.get('entity_ids'), 'c1,c2', 'campaigns X lists on the publisher network come first');
  if (refuse)
    return Response.json(
      {errors: [{code: 'INVALID_PARAMETER', message: 'Private X text', parameter: 'placement'}], request: {params: {}}},
      {status: 400, headers: {'x-transaction-id': 'x-tx-2'}},
    );
  return Response.json(
    {
      data: [
        {id: 'c1', id_data: [{segment: null, metrics: {impressions: [5], billed_charge_local_micro: [100000]}}]},
        {id: 'c2', id_data: [{segment: null, metrics: {impressions: null, billed_charge_local_micro: null}}]},
      ],
      data_type: 'stats',
      time_series_length: 1,
      request: {params: {}},
    },
    {headers: {'x-transaction-id': 'x-tx-2'}},
  );
};

test('ACC-06 X: the publisher-network probe decides the branch; a refusal of the placement is not a route refusal', async () => {
  const data = await run('x_publisher_network', xAnswer(false));
  assert.equal(data.outcome, 'accepted', JSON.stringify(data.result));
  assert.equal(data.result.publisher_network, 'data_returned');
  assert.equal(data.result.nonzero_activity, true);
  assert.equal(data.result.campaigns_listing_publisher_network, 1);
  assert.match(data.result.branch, /^include_placement/);
  assert.deepEqual(
    data.ledger_rows.map(r => [r.action, r.outcome]),
    [
      ['x_stats_accounts_account_id_active_entities_get', 'accepted'],
      ['x_stats_accounts_account_id_get', 'accepted'],
    ],
  );
  assert.deepEqual(await validateReadRecord(data), []);
  noIds(data, ['Private X text']);
  const refused = await run('x_publisher_network', xAnswer(true));
  assert.equal(refused.outcome, 'accepted', 'a documented refusal decides the branch too');
  assert.equal(refused.result.publisher_network, 'refused_by_x');
  assert.equal(refused.result.http_status, 400);
  assert.deepEqual(refused.result.provider_codes, ['INVALID_PARAMETER']);
  assert.match(refused.result.branch, /^refuse_or_warn/);
  assert.deepEqual(
    refused.ledger_rows.map(r => r.action),
    ['x_stats_accounts_account_id_active_entities_get'],
    'the placement refusal never marks the stats route refused',
  );
  assert.deepEqual(await validateReadRecord(refused), []);
});

test('ACC-06 check: a record with a token, a native ID in a route or a mutation is refused', async () => {
  const record = await run('tiktok', tiktokAnswer());
  const broken = [
    r => (r.reads[0].requests[0].route = '/v1.3/advertiser/' + ids.tiktok),
    r => (r.reads[0].note = 'Bearer abc.def'),
    r => (r.provider_mutations = 1),
    r => (r.ledger_rows[0].evidence.provider_codes = ['no permission, said TikTok']),
    r => (r.ledger_rows[0].ticket = 'ACC-01'),
  ];
  for (const mutate of broken) {
    const copy = structuredClone(record);
    mutate(copy);
    assert.ok((await validateReadRecord(copy)).length, String(mutate));
  }
});
