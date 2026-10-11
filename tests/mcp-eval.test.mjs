// QA-04: the journey and MCP evaluation harness. The metric code is checked on hand-written transcripts whose measures
// are known (the oracle), the transcript sanitizer on values it must refuse, the budget comparison on rises, falls and
// outcome changes, and a deliberate regression (a Home/Operations feed that drops attention items, the class of defect
// OPS-06 fixed) is shown to fail the budget against a clean run of the same journeys. Every run uses an in-memory MCP
// server, the loopback website and synthetic providers; any other host is refused and counted as egress.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  argumentShape,
  compareWithBaseline,
  evaluationFixture,
  externalRanges,
  offeredNextCall,
  offersNextStep,
  outcomeState,
  sanitizeRawCalls,
  sanitizeTranscript,
  syntheticProviders,
  transcriptEntry,
  transcriptMetrics,
} from './journeys/harness.mjs';
import {journeys, branchNames} from './journeys/journeys.mjs';
import {taskSet, scenarios} from './journeys/tasks.mjs';
import {runEvaluation, runIds} from './journeys/run.mjs';
import {
  baselineFrom,
  baselineSubset,
  evaluationArguments,
  measureExternal,
  readBaseline,
  tolerance,
} from '../tools/mcp-eval.mjs';

const entry = (fields = {}) => ({
  surface: 'mcp',
  tool: 'amcp_campaign',
  action: 'get',
  shape: {action: 'string', id: 'string'},
  args_digest: '0123456789abcdef',
  success: true,
  code: null,
  state: 'inspect',
  bytes: 100,
  provider_requests: 0,
  next_call: null,
  next_step: false,
  website_path: null,
  followed_next_call: false,
  user_approval: false,
  ...fields,
});

test('oracle: the four B15 measures and the journey counts come out of a known transcript exactly', () => {
  const transcript = [
    entry({tool: 'amcp_tool_help', action: null, bytes: 50}),
    entry({
      action: 'create',
      bytes: 300,
      provider_requests: 1,
      next_call: {tool: 'amcp_campaign', action: 'preflight'},
    }),
    entry({
      action: 'preflight',
      success: false,
      code: 'INVALID_ARGUMENT',
      state: 'refused',
      args_digest: 'aaaaaaaaaaaaaaaa',
      followed_next_call: true,
      next_step: true,
    }),
    entry({
      action: 'preflight',
      success: false,
      code: 'INVALID_ARGUMENT',
      state: 'refused',
      args_digest: 'aaaaaaaaaaaaaaaa',
      next_step: true,
    }),
    entry({surface: 'web', tool: 'web:campaign', bytes: 40, user_approval: true}),
  ];
  const reference = [
    {tool: 'amcp_campaign', action: 'create'},
    {tool: 'amcp_campaign', action: 'preflight'},
  ];
  assert.deepEqual(transcriptMetrics(transcript, {reference, goalReached: false, handoff: null, userActions: 2}), {
    tool_calls: 4,
    website_actions: 1,
    user_actions: 2,
    help_calls: 1,
    response_bytes: 590,
    provider_requests: 1,
    refused_calls: 2,
    repeated_refused_calls: 1,
    unnecessary_calls: 3,
    correct_tool_choice: true,
    followed_next_calls: 1,
    offered_next_calls: 1,
    wrong_next_calls: 1,
    next_step_at_stop: false,
    user_approvals: 1,
    handoff_success: false,
    end_state: 'dead_end',
  });
  // The first productive call decides tool choice; help calls do not count against it.
  const wrongFirst = [entry({tool: 'amcp_workspace', action: 'operations'}), ...transcript.slice(1)];
  assert.equal(transcriptMetrics(wrongFirst, {reference}).correct_tool_choice, false);
  // A reached goal with a required handoff that failed is not a handoff success.
  assert.equal(
    transcriptMetrics(transcript.slice(0, 2), {reference, goalReached: true, handoff: false}).handoff_success,
    false,
  );
  assert.equal(
    transcriptMetrics(transcript.slice(0, 2), {reference, goalReached: true, handoff: true}).handoff_success,
    true,
  );
  assert.equal(transcriptMetrics(transcript.slice(0, 2), {reference, goalReached: true}).unnecessary_calls, 0);
  assert.equal(
    transcriptMetrics(transcript.slice(0, 3)).end_state,
    'handled_failure',
    'the last response offered a step',
  );
  assert.equal(transcriptMetrics([], {}).correct_tool_choice, null, 'no reference, no tool-choice measure');
});

test('next calls and next steps are found where AMCP puts them; outcome states fall back to ok or refused', () => {
  const call = {tool: 'amcp_campaign', arguments: {action: 'preflight', id: 'p'}};
  for (const response of [
    {success: true, data: {next_call: call}},
    {success: false, error: {details: {next_call: call}}},
    {success: true, meta: {workflow: {next_call: call}}},
    {success: true, data: {current: {verification: {next_call: call}}}},
  ])
    assert.deepEqual(offeredNextCall(response), call);
  assert.equal(offeredNextCall({success: true, data: {next_call: {tool: 'x'}}}), undefined, 'arguments are required');
  for (const response of [
    {success: false, error: {next_action: 'Read the list.'}},
    {success: false, error: {remedy: {action: 'Reconnect.'}}},
    {success: false, error: {details: {list_call: {tool: 'amcp_workspace'}}}},
    {success: true, data: {current: {error: {next_action: 'Inspect.'}}}},
    {success: true, data: {step: {error: {remedy: {action: 'Reconcile.'}}}}},
    {success: true, data: {checks: [{next_step: 'Grant the scope.'}]}},
    {success: true, data: {execution_journal: [{next_safe_action: 'Reconcile.'}]}},
    {success: true, data: {recommendations: [{type: 'data_quality', proposal: 'Refresh a complete window.'}]}},
  ])
    assert.equal(offersNextStep(response), true, JSON.stringify(response));
  for (const response of [
    {success: true, data: {steps: [{error: 'WRITE_OUTCOME_UNCERTAIN'}]}},
    {success: true, data: {recommendations: [{type: 'budget', proposal: 'Raise the budget.'}]}},
    {success: false, error: {code: 'X'}},
  ])
    assert.equal(offersNextStep(response), false, JSON.stringify(response));
  assert.equal(
    outcomeState({success: true, meta: {workflow: {state: 'attention_required'}}, data: {state: 'x'}}),
    'attention_required',
  );
  assert.equal(outcomeState({success: true, data: {status: 'failed'}}), 'failed');
  assert.equal(outcomeState({success: false}), 'refused');
  assert.equal(outcomeState({success: true, data: {state: 7}}), 'ok');
});

test('a transcript keeps argument shapes and never values; raw external logs are sanitized locally', () => {
  const secret = 'Synthetic-secret-name-9137';
  const args = {
    action: 'create',
    name: secret,
    steps: [{id: 'campaign', arguments: {payload: {budget: 5, live: true}}}],
  };
  assert.deepEqual(argumentShape(args), {
    action: 'string',
    name: 'string',
    steps: [{arguments: {payload: {budget: 'number', live: 'boolean'}}, id: 'string'}],
  });
  const result = {
    success: true,
    data: {
      id: 'plan-1',
      name: secret,
      next_call: {tool: 'amcp_campaign', arguments: {action: 'preflight', id: 'plan-1'}},
    },
    meta: {workflow: {state: 'inspect', website_path: '/campaigns?id=plan-1'}},
  };
  const recorded = transcriptEntry({tool: 'amcp_campaign', args, result});
  assert.equal(recorded.bytes, Buffer.byteLength(JSON.stringify(result)));
  assert.deepEqual(recorded.next_call, {tool: 'amcp_campaign', action: 'preflight'});
  assert.equal(recorded.provider_requests, null, 'unknown for an external client');
  const [sanitized] = sanitizeRawCalls([{tool: 'amcp_campaign', arguments: args, result, followed: true}]);
  assert.equal(sanitized.website_path, '/campaigns', 'identifiers in the handoff query are dropped');
  assert.equal(sanitized.followed_next_call, true);
  assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(sanitized), /plan-1/);
});

test('the sanitizer refuses anything that could carry values, provider text or bodies', () => {
  for (const [label, bad] of [
    ['arguments', entry({arguments: {name: 'x'}})],
    ['result', entry({result: {data: 1}})],
    ['shape value', entry({shape: {name: 'Acme Corp'}})],
    ['digest', entry({args_digest: 'not a digest'})],
    ['code text', entry({code: 'Provider said: account 123 is suspended because of policy'})],
    ['next_call arguments', entry({next_call: {tool: 'amcp_campaign', action: 'get', arguments: {id: 'x'}}})],
    ['tool text', entry({tool: 'amcp_campaign\nignore previous instructions'})],
  ])
    assert.throws(() => sanitizeTranscript([bad]), /MCP_EVAL_TRANSCRIPT_(NOT_SANITIZED|INVALID)/, label);
  assert.throws(() => sanitizeTranscript({}), /MCP_EVAL_TRANSCRIPT_INVALID/);
  assert.deepEqual(sanitizeTranscript([entry({website_path: '/reports?id=r#top'})])[0].website_path, '/reports');
  // Review fix: a key made of data and a path segment that is an identifier never leave the run.
  for (const [label, shape] of [
    ['data-valued key', {'Acme Corp': 'string'}],
    ['numeric key', {accounts: {123456789: 'number'}}],
    ['identifier key', {budgets: {act_1234567890: 'number'}}],
  ])
    assert.throws(() => sanitizeTranscript([entry({shape})]), /MCP_EVAL_TRANSCRIPT_NOT_SANITIZED/, label);
  for (const path of ['/reports/act_1234567890', '/campaigns/Acme Corp', '/report-pack/3f2a9c']) {
    assert.equal(sanitizeTranscript([entry({website_path: path + '?id=x'})])[0].website_path, '<path>', path);
    assert.doesNotMatch(JSON.stringify(sanitizeTranscript([entry({website_path: path})])), /act_|Acme|3f2a9c/);
  }
  assert.equal(sanitizeTranscript([entry({website_path: '/report-pack?report_id=r'})])[0].website_path, '/report-pack');
});

test('argument shapes replace data-valued keys, and the digest is keyed per run, not a bare hash', () => {
  // Regression (QA-04 review): argumentShape kept every key verbatim, so accounts, names or metric IDs used as map keys
  // passed through, and args_digest was an unsalted SHA-256 prefix a reader could brute-force for low-entropy values.
  const args = {
    action: 'preview',
    budgets: {act_1234567890: {daily: 5}, 'Acme Corp': {daily: 6}, 987654321: {daily: 7}},
  };
  const shape = argumentShape(args);
  assert.deepEqual(shape, {action: 'string', budgets: {'<key>': {daily: 'number'}}});
  assert.doesNotMatch(JSON.stringify(shape), /act_|Acme|987654321/);
  const [sanitized] = sanitizeRawCalls([{tool: 'amcp_workspace', arguments: args, result: {success: true}}]);
  assert.deepEqual(sanitized.shape, shape);
  const again = transcriptEntry({tool: 'amcp_workspace', args, result: {success: true}}),
    other = transcriptEntry({tool: 'amcp_workspace', args: {...args, action: 'other'}, result: {success: true}});
  assert.equal(again.args_digest, sanitized.args_digest, 'a repeat within the run is told apart');
  assert.notEqual(other.args_digest, sanitized.args_digest);
  const bare = createHash('sha256')
    .update(JSON.stringify({tool: 'amcp_workspace', args}))
    .digest('hex')
    .slice(0, 16);
  assert.notEqual(sanitized.args_digest, bare, 'the digest is not the unkeyed hash');
});

test('a direct global fetch outside the loopback website is refused and counted while a fixture is open', async () => {
  // Review fix: zero egress was asserted only through the injected synthetic fetchers.
  const original = globalThis.fetch,
    f = await evaluationFixture();
  try {
    await assert.rejects(fetch('https://example.com/'), /refuses egress/);
    assert.equal(f.globalEgress.refused, 1);
    // The fixture's own website still answers.
    const page = await f.web.get('/api/session');
    assert.equal(typeof page.success, 'boolean');
    assert.equal(f.globalEgress.refused, 1);
  } finally {
    await f.close();
  }
  assert.equal(globalThis.fetch, original, 'closing the fixture restores the global fetch');
});

test('the budget check: rises and worse outcomes regress, falls and added guidance improve', () => {
  const run = (fields = {}) => ({
    tool_calls: 3,
    website_actions: 1,
    user_actions: 1,
    refused_calls: 0,
    repeated_refused_calls: 0,
    unnecessary_calls: 0,
    provider_requests: 2,
    user_approvals: 1,
    wrong_next_calls: 0,
    response_bytes: 10000,
    end_state: 'success',
    handoff_success: true,
    correct_tool_choice: null,
    ...fields,
  });
  const baseline = {
    mcp_surface: {tools: 28, tools_list_bytes: 100000, instructions_bytes: 1000},
    runs: {
      journeys: {'J2/success': run(), 'J2/failure': run({end_state: 'handled_failure', handoff_success: false})},
      tasks: {'T1/guided': run({end_state: 'dead_end', handoff_success: false, correct_tool_choice: true})},
    },
  };
  const same = structuredClone(baseline);
  assert.deepEqual(compareWithBaseline(same, baseline, tolerance), {passed: true, regressions: [], improvements: []});
  const changed = structuredClone(baseline);
  changed.runs.journeys['J2/success'].tool_calls = 4;
  changed.runs.journeys['J2/success'].response_bytes = 11513; // over 10% + 512
  changed.runs.journeys['J2/failure'].end_state = 'success'; // a safeguard stopped holding
  changed.runs.tasks['T1/guided'].end_state = 'success'; // AMCP's guidance now carries the client
  changed.runs.tasks['T1/guided'].handoff_success = true;
  changed.runs.tasks['T1/guided'].provider_requests = 1;
  changed.mcp_surface.tools_list_bytes = 111000;
  const result = compareWithBaseline(changed, baseline, tolerance);
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.regressions.map(r => r.id + ' ' + r.field),
    ['J2/success tool_calls', 'J2/success response_bytes', 'J2/failure end_state', 'tools/list tools_list_bytes'],
  );
  assert.deepEqual(
    result.improvements.map(r => r.id + ' ' + r.field),
    ['T1/guided provider_requests', 'T1/guided end_state', 'T1/guided handoff_success'],
  );
  const guidance = structuredClone(baseline);
  guidance.runs.tasks['T1/guided'].end_state = 'handled_failure';
  guidance.runs.journeys['J2/success'].response_bytes = 11512; // exactly at the limit
  assert.equal(compareWithBaseline(guidance, baseline, tolerance).passed, true, 'a dead end gaining a next step');
  const worse = structuredClone(baseline);
  worse.runs.journeys['J2/failure'].end_state = 'dead_end';
  delete worse.runs.journeys['J2/success'];
  worse.mcp_surface.tools = 29;
  assert.deepEqual(
    compareWithBaseline(worse, baseline, tolerance).regressions.map(r => r.id + ' ' + r.field),
    ['J2/success missing', 'J2/failure end_state', 'tools/list tools'],
  );
});

test('external clients are measured as ranges over repeated runs, from sanitized transcripts only', async () => {
  const transcript = calls => calls.map(([tool, action, fields = {}]) => entry({tool, action, ...fields}));
  const value = {
    schema_version: 1,
    runs: [
      {
        client: 'Client A',
        task: 'T1',
        run: 1,
        goal_reached: true,
        transcript: transcript([
          ['amcp_workspace', 'capabilities'],
          ['amcp_workspace', 'check'],
        ]),
      },
      {
        client: 'Client A',
        task: 'T1',
        run: 2,
        goal_reached: true,
        transcript: transcript([
          ['amcp_workspace', 'capabilities'],
          ['amcp_workspace', 'check', {success: false, code: 'INVALID_ARGUMENT'}],
          ['amcp_workspace', 'check', {success: false, code: 'INVALID_ARGUMENT'}],
          ['amcp_workspace', 'check'],
        ]),
      },
      {
        client: 'Client A',
        task: 'T1',
        run: 3,
        goal_reached: false,
        transcript: transcript([['amcp_campaign', 'list']]),
      },
      {
        client: 'Client B',
        task: 'T3',
        run: 1,
        goal_reached: true,
        handoff: true,
        transcript: transcript([['amcp_campaign', 'prepare_next']]),
      },
    ],
  };
  const measured = await measureExternal(value);
  assert.equal(measured.runs.length, 4);
  const [a, b] = measured.ranges;
  assert.deepEqual(
    {client: a.client, task: a.task, runs: a.runs, goal: a.goal_reached, choice: a.correct_tool_choice},
    {client: 'Client A', task: 'T1', runs: 3, goal: 2, choice: 2},
  );
  assert.deepEqual(a.tool_calls, {min: 1, median: 2, max: 4});
  assert.deepEqual(a.unnecessary_calls, {min: 0, median: 0, max: 2});
  assert.deepEqual(a.repeated_refused_calls, {min: 0, median: 0, max: 1});
  assert.deepEqual([b.task, b.handoff_success], ['T3', 1]);
  assert.deepEqual(
    externalRanges([
      {client: 'c', task: 't', metrics: {tool_calls: 1}},
      {client: 'c', task: 't', metrics: {tool_calls: 4}},
    ])[0].tool_calls,
    {
      min: 1,
      median: 2.5,
      max: 4,
    },
  );
  await assert.rejects(
    measureExternal({schema_version: 1, runs: [{...value.runs[0], transcript: [entry({arguments: {id: 'x'}})]}]}),
    /NOT_SANITIZED/,
  );
  await assert.rejects(
    measureExternal({schema_version: 1, runs: [{...value.runs[0], task: 'T9'}]}),
    /EXTERNAL_INVALID/,
  );
  await assert.rejects(measureExternal({schema_version: 1, runs: []}), /EXTERNAL_INVALID/);
});

test('the B15 task set names the six blueprint jobs plus hold-outs, each runnable from its scenario', () => {
  const measured = taskSet.tasks.filter(task => !task.holdout);
  assert.deepEqual(
    measured.map(task => task.job),
    [
      'diagnose readiness',
      'build an eligible recipe',
      'inspect a reviewed change',
      'recover an uncertain execution',
      'interpret a partial report',
      'reuse a verified asset',
    ],
  );
  assert.ok(
    taskSet.tasks.filter(task => task.holdout).length >= 2,
    'hold-out tasks keep descriptions from being tuned',
  );
  for (const task of taskSet.tasks) {
    assert.equal(typeof scenarios[task.scenario], 'function', task.id);
    assert.deepEqual([task.entry.tool, task.entry.action], [task.reference[0].tool, task.reference[0].action], task.id);
    assert.ok(task.prompt.length > 20 && task.goal.length > 20, task.id);
  }
  assert.deepEqual(
    journeys.map(journey => journey.id),
    ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'J8'],
  );
  for (const journey of journeys) assert.deepEqual(Object.keys(journey.branches), [...branchNames], journey.id);
});

test('the committed baseline covers every journey branch and task run and holds metrics only', () => {
  const baseline = readBaseline();
  assert.deepEqual(Object.keys(baseline.runs.journeys), runIds.journeys);
  assert.deepEqual(Object.keys(baseline.runs.tasks), runIds.tasks);
  assert.deepEqual(baseline.tolerance, tolerance);
  const text = JSON.stringify(baseline);
  assert.doesNotMatch(
    text,
    /transcript|127\.0\.0\.1|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/,
    'no transcripts, origins or IDs',
  );
  // Every reference run completes: each B15 job can be done with the current tools.
  for (const task of taskSet.tasks)
    assert.equal(baseline.runs.tasks[task.id + '/reference'].end_state, 'success', task.id);
  // Success branches reach their goal. An unavailable account and the failures that a safeguard must stop never
  // "succeed" (J5's failure branch includes its safe retry, so it does).
  for (const journey of journeys) {
    assert.equal(baseline.runs.journeys[journey.id + '/success'].end_state, 'success', journey.id);
    assert.notEqual(baseline.runs.journeys[journey.id + '/unavailable_account'].end_state, 'success', journey.id);
  }
  for (const id of ['J1/failure', 'J2/failure', 'J2/incomplete_evidence', 'J4/failure', 'J6/failure', 'J8/failure'])
    assert.notEqual(baseline.runs.journeys[id].end_state, 'success', id);
  assert.throws(() => baselineFrom({fault: 'strip-next-call', runs: {}}), /BASELINE_PARTIAL/);
  const subset = baselineSubset(baseline, {runs: {journeys: {'J7/success': {}}}, mcp_surface: null});
  assert.deepEqual(Object.keys(subset.runs), ['journeys']);
  assert.deepEqual(Object.keys(subset.runs.journeys), ['J7/success']);
  assert.equal(subset.mcp_surface, undefined);
});

test('evaluation arguments: one mode, every option once; a baseline is never written from a subset or a fault', () => {
  assert.deepEqual(evaluationArguments([]), {
    mode: 'check',
    only: null,
    fault: null,
    output: null,
    transcripts: false,
    input: null,
  });
  assert.deepEqual(evaluationArguments(['--only', 'J1,T3/guided', '--fault', 'hide-attention']).only, [
    'J1',
    'T3/guided',
  ]);
  assert.equal(evaluationArguments(['--write-baseline']).mode, 'write-baseline');
  assert.equal(evaluationArguments(['--external', 'runs.json']).input, 'runs.json');
  for (const argv of [
    ['--write-baseline', '--only', 'J1'],
    ['--write-baseline', '--fault', 'strip-next-call'],
    ['--sanitize', 'raw.json'],
    ['--external', 'a.json', '--sanitize', 'b.json'],
    ['--check', '--write-baseline'],
    ['--only'],
    ['--only', ','],
    ['--only', 'J1', '--only', 'J2'],
    ['--unknown'],
  ])
    assert.throws(() => evaluationArguments(argv), /Use: |BASELINE_PARTIAL/, JSON.stringify(argv));
});

test('synthetic providers refuse and count any other host, so a run proves zero egress', async () => {
  const {state, fetcher} = syntheticProviders();
  for (const url of [
    'https://example.com/',
    'https://graph.facebook.com.evil.test/v26.0/act_123',
    'https://amcp.shop/healthz',
  ])
    await assert.rejects(fetcher(url), /refuses egress/);
  assert.equal(state.egress_refused, 3);
  assert.deepEqual(state.requests, []);
});

test('a reverted Home attention fix fails the budget: the faulted journeys regress against a clean run', async () => {
  const clean = await runEvaluation({only: ['J7', 'T4/reference']});
  assert.equal(clean.runs.journeys['J7/success'].end_state, 'success');
  assert.ok(
    Object.values(clean.runs.journeys).every(run => run.surfaces.includes('web') && run.surfaces.includes('mcp')),
  );
  assert.deepEqual(compareWithBaseline(clean, clean, tolerance).regressions, [], 'a run matches itself');
  const faulted = await runEvaluation({only: ['J7', 'T4/reference'], fault: 'hide-attention'});
  const comparison = compareWithBaseline(faulted, clean, tolerance);
  assert.equal(comparison.passed, false);
  assert.ok(
    comparison.regressions.some(r => r.id === 'J7/success' && r.field === 'end_state' && r.actual === 'dead_end'),
  );
});

test('oracle run: inspecting a reviewed change through the SDK is one call, sends nothing and hands off to the plan', async () => {
  const record = await runEvaluation({only: ['T3'], transcripts: true});
  const reference = record.runs.tasks['T3/reference'];
  assert.deepEqual(
    {
      calls: reference.tool_calls,
      refused: reference.refused_calls,
      mutations: reference.provider_mutations,
      end: reference.end_state,
      handoff: reference.handoff_success,
      choice: reference.correct_tool_choice,
      surfaces: reference.surfaces,
    },
    {calls: 1, refused: 0, mutations: 0, end: 'success', handoff: true, choice: true, surfaces: ['mcp']},
  );
  assert.deepEqual(
    reference.transcript.map(item => [item.tool, item.action, item.success, item.website_path]),
    [['amcp_campaign', 'prepare_next', true, '/campaigns']],
  );
  assert.equal(record.task_measures.T3.guided_reaches_goal, true);
  assert.ok(record.mcp_surface.tools > 0 && record.mcp_surface.tools_list_bytes > 0);
  await assert.rejects(runEvaluation({only: ['J9']}), /MCP_EVAL_UNKNOWN_RUN J9/);
});
