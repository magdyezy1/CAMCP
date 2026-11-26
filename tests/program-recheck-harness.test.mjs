// ACC-08: the owner-authorized recheck of the externally blocked programs (tools/acceptance/program-recheck.mjs).
// Before it, the 2026-10-08 denial of both LinkedIn programs was recorded only as PROVIDER_ACCESS_DENIED with no literal
// provider code, and nothing defined how to recheck them or when the ticket closes. The harness must refuse without
// every owner flag, send nothing in a dry run, reach only each program's documented read route, keep the provider's
// literal code, redacted message and request ID with the resolution AMCP showed, and report unblocked only when
// forecastReaches, audienceInsights and advertisers.get are all observed. Every provider answer here is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {
  dryRunRecheck,
  recheckGuard,
  recheckPrograms,
  recheckTemplate,
  redactMessage,
  runRecheck,
  validateRecheckPlan,
  validateRecheckRecord,
} from '../tools/acceptance/program-recheck.mjs';
import {unsafeDeclaredValue} from '../dist/src/provider-access.js';
import {removeTestDirectory} from '../dist/tests/temp.js';

const linkedin = '5001234567',
  advertiser = '7001234567',
  urn = 'urn:li:sponsoredAccount:' + linkedin;
/** The template filled for synthetic accounts. */
function plan(mutate) {
  const p = recheckTemplate();
  p.authorization_ref = 'owner-auth-2026-10-15-programs';
  p.release = {revision: 'abcdef1', package_sha256: 'a'.repeat(64)};
  p.programs[0].account_id = linkedin;
  p.programs[0].requirements.request.sponsoredAccountUrn = urn;
  p.programs[1].account_id = linkedin;
  p.programs[1].requirements.request.requestMetaData.sponsoredAccountUrn = urn;
  p.programs[2].account_id = advertiser;
  mutate?.(p);
  return p;
}
const noIds = (value, extra = []) => {
  const text = JSON.stringify(value);
  for (const id of [linkedin, advertiser, ...extra]) assert.ok(!text.includes(id), 'the record names ' + id);
};
const refusal = (code, serviceErrorCode, message, uuid) =>
  Response.json({status: 403, code, serviceErrorCode, message}, {status: 403, headers: {'x-li-uuid': uuid}});
/** Synthetic provider answers: each program refuses or answers as `answers` says; nothing reaches a network. */
const provider =
  (answers, calls = []) =>
  async (input, init) => {
    const url = new URL(String(input)),
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      host: url.hostname,
      method: init?.method ?? 'GET',
      path: url.pathname,
      action: url.searchParams.get('action'),
    });
    if (url.pathname === '/rest/mediaPlanning')
      return answers.forecast === 'ok'
        ? Response.json({
            value: {
              [{forecastReaches: 'reachCurve', forecastImpressions: 'impressionCurve', forecastLeads: 'leadCurve'}[
                url.searchParams.get('action')
              ]]: {
                metricCurve: [
                  {budgetMicros: 100000000, metricValue: 1000},
                  {budgetMicros: 300000000, metricValue: 2500},
                ],
                singlePointMetric: {budgetMicros: 300000000, metricValue: 2500},
              },
            },
          })
        : refusal(
            'ACCESS_DENIED',
            100,
            'Not enough permissions to access: partnerApiMediaPlanning.ACTION.forecastReaches for ' + urn,
            'AAYz-li-uuid_01',
          );
    if (url.pathname === '/rest/targetingAudienceInsights')
      return answers.insights === 'ok'
        ? Response.json({
            value: {
              totalAudienceCount: 420000,
              audienceInsight: {
                groupedBy: body.request.groupBy,
                segmentations: [{value: 'urn:li:function:4', entityCount: 96000, entityPercentage: 23}],
              },
            },
          })
        : answers.insights === 'unknown'
          ? refusal('SOMETHING_NEW', 999, 'An undocumented refusal, contact jane@example.com', 'AAYz-li-uuid_02')
          : refusal('USER_NOT_AUTHORIZED', 100, 'Member has no role on account ' + linkedin, 'AAYz-li-uuid_03');
    return answers.dv360 === 'ok'
      ? Response.json({
          advertiserId: advertiser,
          partnerId: '9',
          entityStatus: 'ENTITY_STATUS_ACTIVE',
          generalConfig: {currencyCode: 'USD'},
          displayName: 'Private advertiser name',
        })
      : Response.json(
          {error: {code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission'}},
          {status: 403},
        );
  };
const credentials = {
  linkedin_native_action: {accessToken: 'synthetic-linkedin-token'},
  dv360_native_action: {accessToken: 'synthetic-dv360-token'},
};
const run = (answers, p = plan(), calls) =>
  runRecheck(p, {
    credentials,
    runId: 'acc08-test',
    planSha256: 'c'.repeat(64),
    fetcher: provider(answers, calls),
    now: () => Date.parse('2026-10-15T09:00:00Z'),
  });

test('ACC-08 plans: the template is refused until filled, and another account, repeats and unknown fields are refused', () => {
  assert.ok(validateRecheckPlan(recheckTemplate()).length, 'the template is not runnable as is');
  assert.deepEqual(validateRecheckPlan(plan()), []);
  assert.deepEqual(
    plan().programs.map(p => p.workflow_id),
    Object.keys(recheckPrograms),
  );
  const cases = [
    [
      p => (p.programs[0].requirements.request.sponsoredAccountUrn = 'urn:li:sponsoredAccount:999'),
      /names the plan account/,
    ],
    [
      p => (p.programs[1].requirements.request.requestMetaData.sponsoredAccountUrn = 'urn:li:sponsoredAccount:9'),
      /names the plan account/,
    ],
    [p => p.programs.push(structuredClone(p.programs[2])), /1 to 3 programs/],
    [p => (p.programs[1] = structuredClone(p.programs[0])), /rechecked once per run/],
    [p => (p.programs[0].workflow_id = 'program:linkedin_lead_sync'), /workflow_id is one of/],
    [p => (p.programs[0].account_label = 'linkedin-5001234567'), /owner label/],
    [p => (p.programs[2].requirements = {extra: true}), /takes no requirements/],
    [p => (p.programs[0].requirements.forecast = 'forecastEverything'), /forecast is forecastReaches/],
    [p => (p.programs[0].extra = 1), /unknown field extra/],
    [p => (p.authorization_ref = ''), /authorization_ref/],
    [p => (p.release = {}), /release is/],
    [p => (p.ticket = 'ACC-06'), /ticket is ACC-08/],
  ];
  for (const [mutate, pattern] of cases) {
    const problems = validateRecheckPlan(plan(mutate));
    assert.ok(
      problems.some(p => pattern.test(p)),
      String(pattern) + ': ' + problems.join('; '),
    );
  }
});

test('ACC-08 dry run and flags: AMCP inspects locally, lists each read, sends nothing and refuses a live run without flags', async () => {
  const dry = await dryRunRecheck(plan(), ['AMCP_ACCEPTANCE_LIVE=true is not set']);
  assert.equal(dry.status, 'valid', JSON.stringify(dry));
  assert.equal(dry.provider_requests, 0);
  assert.deepEqual(
    dry.programs.map(p => [p.workflow_id, p.read, p.local_state, p.blockers.length, p.missing_requirements.length]),
    [
      ['program:linkedin_forecast', 'POST /rest/mediaPlanning?action=forecastReaches', 'unverified', 0, 0],
      [
        'program:linkedin_audience_insights',
        'POST /rest/targetingAudienceInsights?action=audienceInsights',
        'unverified',
        0,
        0,
      ],
      ['program:dv360_advertiser', 'GET /v4/advertisers/{id}', 'unverified', 0, 0],
    ],
  );
  assert.equal(dry.ready_for_live, false);
  noIds(dry);
  // A requirement the live check needs is reported as missing before any request.
  const missing = await dryRunRecheck(
    plan(p => delete p.programs[1].requirements.request.groupBy),
    [],
  );
  assert.equal(missing.status, 'blocked_locally');
  assert.ok(missing.programs[1].missing_requirements.includes('requirements.request.groupBy'));
  // The CLI: the live switch missing is a refusal before credentials are read; the dry run prints no account ID.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-acc08-')),
    file = path.join(dir, 'plan.json'),
    bytes = Buffer.from(JSON.stringify(plan()));
  try {
    fs.writeFileSync(file, bytes);
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AMCP_ACCEPTANCE_')));
    const live = spawnSync(process.execPath, ['tools/acceptance/program-recheck.mjs', file, '--live'], {
      encoding: 'utf8',
      env: {
        ...clean,
        AMCP_ACCEPTANCE_LIVE: 'false',
        AMCP_ACCEPTANCE_AUTHORIZATION: plan().authorization_ref,
        AMCP_ACCEPTANCE_PLAN_SHA256: createHash('sha256').update(bytes).digest('hex'),
        AMCP_ACCEPTANCE_RUN_ID: 'acc08-cli',
        AMCP_ACCEPTANCE_CREDENTIALS_JSON: 'not json',
      },
    });
    assert.equal(live.status, 1, live.stderr);
    const out = JSON.parse(live.stdout);
    assert.equal(out.status, 'refused');
    assert.equal(out.provider_requests, 0);
    assert.deepEqual(out.refusals, ['AMCP_ACCEPTANCE_LIVE=true is not set']);
    assert.doesNotMatch(live.stdout + live.stderr, /not valid JSON/);
    const dryCli = spawnSync(process.execPath, ['tools/acceptance/program-recheck.mjs', file], {
      encoding: 'utf8',
      env: clean,
    });
    assert.equal(dryCli.status, 0, dryCli.stderr);
    const printed = JSON.parse(dryCli.stdout);
    assert.equal(printed.provider_requests, 0);
    assert.equal(printed.live_refusals.length, 5);
    noIds(printed);
  } finally {
    removeTestDirectory(dir, 'amcp-acc08-');
  }
});

test('ACC-08 guard: only each program’s documented read route and method pass, at most three requests per program', async () => {
  let sent = 0;
  const fetcher = async () => {
    sent++;
    return Response.json({}, {status: 403});
  };
  const guard = await recheckGuard(fetcher, ['program:linkedin_forecast'], [linkedin]);
  for (const [url, init] of [
    ['https://api.linkedin.com/rest/mediaPlanning?action=forecastReaches', {method: 'GET'}],
    ['https://api.linkedin.com/rest/adAccounts/' + linkedin, {method: 'GET'}],
    ['https://api.linkedin.com/rest/targetingAudienceInsights?action=audienceInsights', {method: 'POST'}],
    ['https://api.linkedin.com/rest/mediaPlanning?action=createMediaPlan', {method: 'POST'}],
    [
      'https://api.linkedin.com/rest/mediaPlanning?action=forecastReaches',
      {method: 'POST', headers: {'X-HTTP-Method-Override': 'DELETE'}},
    ],
    ['https://displayvideo.googleapis.com/v4/advertisers/' + advertiser, {method: 'GET'}],
    ['http://api.linkedin.com/rest/mediaPlanning?action=forecastReaches', {method: 'POST'}],
    ['https://api.linkedin.com:8443/rest/mediaPlanning?action=forecastReaches', {method: 'POST'}],
  ])
    await assert.rejects(
      () => guard.fetch(url, init),
      e => e.code === 'ACCEPTANCE_ROUTE_REFUSED',
      url,
    );
  assert.equal(sent, 0);
  for (let i = 0; i < 3; i++)
    await guard.fetch('https://api.linkedin.com/rest/mediaPlanning?action=forecastReaches', {method: 'POST'});
  await assert.rejects(
    () => guard.fetch('https://api.linkedin.com/rest/mediaPlanning?action=forecastReaches', {method: 'POST'}),
    e => e.code === 'ACCEPTANCE_ROUTE_REFUSED' && /bounded to 3/.test(e.message),
  );
  assert.equal(sent, 3);
  assert.equal(guard.state.log[0].read_post, true);
  // The advertiser read is a GET of the exact advertiser route.
  const dv = await recheckGuard(fetcher, ['program:dv360_advertiser'], [advertiser]);
  await assert.rejects(
    () => dv.fetch('https://displayvideo.googleapis.com/v4/advertisers/' + advertiser, {method: 'POST'}),
    e => e.code === 'ACCEPTANCE_ROUTE_REFUSED',
  );
  await dv.fetch('https://displayvideo.googleapis.com/v4/advertisers/' + advertiser);
  assert.equal(dv.state.log[0].route, '/v4/advertisers/{id}');
  // Messages keep their words, never an ID, address, URL or URN value.
  assert.equal(
    redactMessage(
      'No role for urn:li:sponsoredAccount:123 on 5001234567, see https://x.example/a?b=1 or ops@example.com',
      [linkedin],
    ),
    'No role for urn:li:sponsoredAccount:{id} on {id}, see {url} or {email}',
  );
});

test('ACC-08 recheck: a documented refusal shows its resolution, an unknown one the generic text, both with literal codes', async () => {
  const calls = [],
    record = await run({forecast: 'denied', insights: 'unknown', dv360: 'denied'}, plan(), calls);
  assert.equal(record.status, 'blocked');
  assert.equal(record.provider_requests, 3);
  assert.equal(record.provider_mutations, 0);
  assert.equal(record.refused_requests, 0);
  assert.deepEqual(
    calls.map(c => [c.host, c.method, c.path, c.action]),
    [
      ['api.linkedin.com', 'POST', '/rest/mediaPlanning', 'forecastReaches'],
      ['api.linkedin.com', 'POST', '/rest/targetingAudienceInsights', 'audienceInsights'],
      ['displayvideo.googleapis.com', 'GET', '/v4/advertisers/' + advertiser, null],
    ],
  );
  const [forecast, insights, dv360] = record.programs;
  // LinkedIn's documented ACCESS_DENIED: AMCP's closed code, the documented resolution, and the literal answer.
  assert.equal(forecast.outcome, 'refused');
  assert.equal(forecast.amcp.code, 'PROVIDER_ACCESS_DENIED');
  assert.equal(forecast.amcp.provider_code, 'ACCESS_DENIED');
  assert.equal(forecast.amcp.documented_refusal, true);
  assert.match(forecast.amcp.owner_action.text, /not provisioned for Media Planning/);
  assert.deepEqual(forecast.provider, {
    http_status: 403,
    literal_codes: ['ACCESS_DENIED', '100'],
    message: 'Not enough permissions to access: partnerApiMediaPlanning.ACTION.forecastReaches for {id}',
    request_id: 'AAYz-li-uuid_01',
  });
  // An undocumented code: AMCP's closed set says OTHER and the generic text infers no cause; the literal code is kept.
  assert.equal(insights.amcp.provider_code, 'OTHER');
  assert.equal(insights.amcp.documented_refusal, false);
  assert.match(insights.amcp.owner_action.text, /without a documented code\. AMCP infers no cause/);
  assert.deepEqual(insights.provider.literal_codes, ['SOMETHING_NEW', '999']);
  assert.equal(insights.provider.message, 'An undocumented refusal, contact {email}');
  // Display & Video 360: Google's status and code, and the user-profile guidance.
  assert.equal(dv360.outcome, 'refused');
  assert.deepEqual(dv360.provider.literal_codes, ['PERMISSION_DENIED', '403']);
  assert.match(dv360.amcp.owner_action.text, /user profile/);
  // The register values to declare, with the day; the register itself accepts them.
  assert.deepEqual(
    record.register.map(r => [r.provider, r.approval, r.checked_on, r.value]),
    [
      ['linkedin', 'media_planning_product', '2026-10-15', 'Recheck refused: 403 ACCESS_DENIED 100'],
      ['linkedin', 'audience_insights_product', '2026-10-15', 'Recheck refused: 403 SOMETHING_NEW 999'],
      ['dv360', 'user_profile', '2026-10-15', 'Recheck refused: 403 PERMISSION_DENIED 403'],
    ],
  );
  for (const r of record.register) assert.equal(unsafeDeclaredValue(r.value), undefined, r.value);
  // One ledger row per program, references only.
  assert.deepEqual(
    record.ledger_rows.map(r => [r.ticket, r.gateway, r.action, r.effect, r.outcome, r.evidence.provider_codes]),
    [
      [
        'ACC-08',
        'linkedin_native_action',
        'linkedin_rest_media_planning_post',
        'read',
        'refused',
        ['ACCESS_DENIED', '100'],
      ],
      [
        'ACC-08',
        'linkedin_native_action',
        'linkedin_rest_targeting_audience_insights_post',
        'read',
        'refused',
        ['SOMETHING_NEW', '999'],
      ],
      ['ACC-08', 'dv360_native_action', 'DV360_ADVERTISERS_GET', 'read', 'refused', ['PERMISSION_DENIED', '403']],
    ],
  );
  assert.deepEqual(await validateRecheckRecord(record), []);
  noIds(record, ['synthetic-linkedin-token', 'synthetic-dv360-token', 'jane@example.com', urn]);
  // USER_NOT_AUTHORIZED names the member's role on the account.
  const role = await run({forecast: 'denied', insights: 'role', dv360: 'ok'});
  assert.match(role.programs[1].amcp.owner_action.text, /no role on this ad account/);
  assert.equal(role.programs[1].provider.message, 'Member has no role on account {id}');
});

test('ACC-08 closes only when forecastReaches, audienceInsights and advertisers.get are all observed', async () => {
  const open = await run({forecast: 'ok', insights: 'ok', dv360: 'ok'});
  assert.equal(open.status, 'unblocked', JSON.stringify(open.programs.map(p => [p.workflow_id, p.state])));
  assert.deepEqual(
    open.programs.map(p => [p.state, p.outcome]),
    [
      ['observed', 'accepted'],
      ['observed', 'accepted'],
      ['observed', 'accepted'],
    ],
  );
  assert.deepEqual(
    open.register.map(r => r.value),
    ['Observed on recheck', 'Observed on recheck', 'Observed on recheck'],
  );
  assert.deepEqual(await validateRecheckRecord(open), []);
  noIds(open, ['Private advertiser name']);
  // Another forecast type, a missing program or one refusal keeps the ticket blocked.
  const impressions = await run(
    {forecast: 'ok', insights: 'ok', dv360: 'ok'},
    plan(p => (p.programs[0].requirements.forecast = 'forecastImpressions')),
  );
  assert.equal(impressions.status, 'blocked');
  const two = await run(
    {forecast: 'ok', insights: 'ok', dv360: 'ok'},
    plan(p => p.programs.pop()),
  );
  assert.equal(two.status, 'blocked');
  assert.equal((await run({forecast: 'ok', insights: 'unknown', dv360: 'ok'})).status, 'blocked');
});

test('ACC-08 check: a record with a token, an unredacted ID, a mutation or an unsupported closure is refused', async () => {
  const record = await run({forecast: 'denied', insights: 'unknown', dv360: 'ok'});
  const broken = [
    r => (r.programs[0].provider.message = 'Bearer abc.def'),
    r => (r.programs[0].provider.message = 'Account ' + linkedin),
    r => (r.programs[0].requests[0].route = '/v4/advertisers/' + advertiser),
    r => (r.provider_mutations = 1),
    r => (r.status = 'unblocked'),
    r => (r.register[0].value = 'Recheck refused for ' + linkedin),
    r => (r.programs[0].provider.literal_codes = ['no permission']),
    r => (r.ledger_rows[0].ticket = 'ACC-01'),
    r => (r.programs[0].account_label = 'Account 5001234567'),
  ];
  for (const mutate of broken) {
    const copy = structuredClone(record);
    mutate(copy);
    assert.ok((await validateRecheckRecord(copy)).length, String(mutate));
  }
  assert.deepEqual(await validateRecheckRecord({record_kind: 'other'}), [
    'the record is an ACC-08 acceptance_program_recheck record',
  ]);
});
