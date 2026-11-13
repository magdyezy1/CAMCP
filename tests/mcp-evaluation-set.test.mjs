import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {
  answerQuestion,
  evaluationFile,
  evaluationPairs,
  evaluationSet,
  skillRanges,
  skillReport,
} from './journeys/evaluation-set.mjs';
import {solutions} from './fixtures/mcp-evaluation/solutions.mjs';
import {evaluationWorkspace} from './fixtures/mcp-evaluation/workspace.mjs';
import {contractProfileOf} from '../dist/src/mcp-client-profile.js';
import {runIds} from './journeys/run.mjs';
import {evaluationArguments, readBaseline} from '../tools/mcp-eval.mjs';

// QA-04 with the mcp-builder skill's evaluation guidance: ten realistic, independent, read-only questions with one
// stable answer each, in the skill's XML format, about a deterministic synthetic agency workspace. The answers are not
// asserted: each is proven here by its reference solution through a real MCP SDK client, on a fresh workspace, with
// every call read-only by its own hints, the store unchanged and nothing leaving the process. The owner runs the same
// set through the skill's LLM runner against the stdio server below (docs/OPERATIONS.md, "MCP evaluation set").
const server = fileURLToPath(new URL('./fixtures/mcp-evaluation/server.mjs', import.meta.url)),
  wrapper = fileURLToPath(new URL('../tools/mcp-skill-evaluation.py', import.meta.url)),
  python = process.env.AMCP_SCHEMA_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

test('the set is ten questions in the skill’s XML format, each with one short answer it does not give away', () => {
  const pairs = evaluationSet();
  assert.equal(pairs.length, 10);
  assert.deepEqual(
    pairs.map(p => p.id),
    runIds.evaluation_set,
  );
  assert.equal(new Set(pairs.map(p => p.question)).size, 10, 'independent questions');
  for (const pair of pairs) {
    assert.ok(pair.question.length > 60 && pair.question.length < 300, pair.id);
    assert.match(pair.question, /Answer (with|in) /, pair.id + ' states the answer format');
    assert.ok(pair.answer.length > 0 && pair.answer.length <= 60 && !/\n/.test(pair.answer), pair.id);
    assert.ok(!pair.question.includes(pair.answer), pair.id + ': the answer is not in the question');
  }
  assert.deepEqual(
    solutions.map(s => s.question),
    pairs.map(p => p.question),
    'one reference solution per question, in order',
  );
  // The runner reads every qa_pair's question and answer; anything else would be read differently, so it is refused.
  const xml = fs.readFileSync(evaluationFile, 'utf8');
  assert.match(
    xml,
    /^<evaluation>\n( {3}<qa_pair>\n {6}<question>[^<]+<\/question>\n {6}<answer>[^<]+<\/answer>\n {3}<\/qa_pair>\n){10}<\/evaluation>\n$/,
  );
  assert.deepEqual(
    evaluationPairs('<evaluation><qa_pair><question>A &amp; B?</question><answer>1</answer></qa_pair></evaluation>'),
    [{id: 'E1', question: 'A & B?', answer: '1'}],
  );
  for (const bad of [
    '<evaluation><qa_pair><question>Q</question></qa_pair></evaluation>',
    '<evaluation><qa_pair><question>Q</question><answer>A</answer></qa_pair><note>x</note></evaluation>',
    '<qa_pair><question>Q</question><answer>A</answer></qa_pair>',
  ])
    assert.throws(() => evaluationPairs(bad), /MCP_EVAL_SET_INVALID/, bad);
});

test('every answer is proven by its reference solution: read-only calls, an unchanged store and zero egress', async () => {
  for (const pair of evaluationSet()) {
    const outcome = await answerQuestion(pair);
    assert.equal(outcome.error, undefined, pair.id + ': ' + outcome.error);
    assert.equal(outcome.answer, pair.answer, pair.id);
    assert.deepEqual(outcome.unsafe, [], pair.id + ': every call is read-only by its own hints');
    assert.equal(outcome.state_changed, false, pair.id + ': the store is unchanged');
    assert.equal(outcome.providers.egress_refused, 0, pair.id);
    assert.equal(outcome.providers.writes_refused, 0, pair.id);
    assert.ok(outcome.transcript.length >= 2, pair.id + ': a multi-call question');
    assert.ok(
      outcome.transcript.every(entry => entry.surface === 'mcp'),
      pair.id,
    );
  }
  // A solution that drifts from its question is refused rather than proving another answer.
  await assert.rejects(answerQuestion({id: 'E1', question: 'Something else?', answer: '1'}), /MCP_EVAL_SET_DRIFT/);
});

test('every answer is the same for a v2 client: the same proof, from the workspace of a client whose record opts it in', async () => {
  const legacy = await evaluationWorkspace(),
    v2 = await evaluationWorkspace({profile: 'v2'});
  try {
    assert.equal(contractProfileOf(legacy.store, legacy.actor), 'legacy');
    assert.equal(contractProfileOf(v2.store, v2.actor), 'v2');
    assert.equal(v2.actor.userId, 'oauth/agency-analyst');
  } finally {
    legacy.close();
    v2.close();
  }
  for (const pair of evaluationSet()) {
    const outcome = await answerQuestion(pair, undefined, {profile: 'v2'});
    assert.equal(outcome.error, undefined, pair.id + ': ' + outcome.error);
    assert.equal(outcome.answer, pair.answer, pair.id);
    assert.deepEqual(outcome.unsafe, [], pair.id + ': every call is read-only by its own hints');
    assert.equal(outcome.state_changed, false, pair.id + ': the store is unchanged');
    assert.equal(outcome.providers.egress_refused, 0, pair.id);
    assert.equal(outcome.providers.writes_refused, 0, pair.id);
  }
  await assert.rejects(evaluationWorkspace({profile: 'v3'}), /MCP_EVAL_PROFILE/);
});
test('the harness runs the set as a suite, and the committed baseline holds every question as answered', () => {
  const baseline = readBaseline();
  assert.deepEqual(Object.keys(baseline.runs.evaluation_set ?? {}), runIds.evaluation_set);
  for (const [id, run] of Object.entries(baseline.runs.evaluation_set)) {
    assert.equal(run.end_state, 'success', id);
    assert.equal(run.answer_correct, true, id);
    assert.equal(run.read_only_calls, true, id);
    assert.equal(run.state_unchanged, true, id);
    assert.equal(run.egress_refused, 0, id);
    assert.ok(run.tool_calls >= 2, id);
  }
});

test('the stdio server the skill’s runner launches serves the fixture workspace, answers a question and sends nothing out', async t => {
  const transport = new StdioClientTransport({command: process.execPath, args: [server], stderr: 'pipe'}),
    client = new Client({name: 'AMCP evaluation stdio check', version: '1.0.0'});
  t.after(() => client.close());
  await client.connect(transport);
  const {tools} = await client.listTools();
  assert.ok(tools.length >= 25, String(tools.length));
  assert.ok(
    tools.every(tool => tool.annotations && tool.outputSchema),
    'the full listing, with hints and schemas',
  );
  let calls = 0;
  const call = async (name, args) => {
    calls++;
    const result = await client.callTool({name, arguments: args});
    return JSON.parse(result.content[0].text);
  };
  const pair = evaluationSet()[3];
  assert.equal(await solutions[3].solve(call), pair.answer);
  assert.ok(calls >= 2);
  // The workspace serves a reader: a change is refused before anything is sent.
  const write = await call('amcp_write', {
    action: 'prepare',
    gateway: 'meta_native_action',
    arguments: {action: 'meta_campaign_create', account_id: '1101', payload: {name: 'Not allowed'}},
  });
  assert.equal(write.success, false);
  assert.equal(write.error.code, 'CONNECTOR_READ_ONLY');
});

/** A report in the format the skill's scripts/evaluation.py writes with -o (REPORT_HEADER and TASK_TEMPLATE). */
const report = (tasks, correct = tasks.filter(t => t.correct).length) =>
  '\n# Evaluation Report\n\n## Summary\n\n- **Accuracy**: ' +
  correct +
  '/' +
  tasks.length +
  '\n\n---\n' +
  tasks
    .map(
      (task, i) =>
        '\n### Task ' +
        (i + 1) +
        '\n\n**Question**: ' +
        task.question +
        '\n**Ground Truth Answer**: `' +
        task.expected +
        '`\n**Actual Answer**: `' +
        task.actual +
        '`\n**Correct**: ' +
        (task.correct ? '✅' : '❌') +
        '\n**Duration**: 12.34s\n**Tool Calls**: ' +
        JSON.stringify(task.calls, null, 2) +
        '\n\n**Summary**\nThe model’s own summary, which the record never keeps.\n\n**Feedback**\nFeedback text.\n\n---\n',
    )
    .join('');

test('a report of the skill’s runner is measured against the reference solutions, keeping only counts and correctness', () => {
  const pairs = evaluationSet(),
    text = report([
      {
        question: pairs[0].question,
        expected: pairs[0].answer,
        actual: '1102',
        correct: true,
        calls: {amcp_platform_workspace: {count: 1, durations: [0.1]}, meta_native_action: {count: 4, durations: []}},
      },
      {
        question: pairs[3].question,
        expected: pairs[3].answer,
        actual: '150.00',
        correct: false,
        calls: {amcp_reporting_overview: {count: 2, durations: [0.2, 0.3]}},
      },
    ]);
  const measured = skillReport(text, pairs, {E1: 3, E4: 2});
  assert.deepEqual(measured.tasks, [
    {
      id: 'E1',
      correct: true,
      tool_calls: 5,
      tools: {amcp_platform_workspace: 1, meta_native_action: 4},
      reference_calls: 3,
      unnecessary_calls: 2,
    },
    {
      id: 'E4',
      correct: false,
      tool_calls: 2,
      tools: {amcp_reporting_overview: 2},
      reference_calls: 2,
      unnecessary_calls: 0,
    },
  ]);
  assert.deepEqual([measured.correct, measured.total], [1, 2]);
  assert.doesNotMatch(JSON.stringify(measured), /summary|Feedback|150\.00|1102/, 'no answers or model text are kept');
  // CRLF line ends (a report saved on Windows) read the same.
  assert.deepEqual(skillReport(text.replace(/\n/g, '\r\n'), pairs, {E1: 3, E4: 2}).tasks, measured.tasks);
  const second = skillReport(
    report([
      {
        question: pairs[0].question,
        expected: '1102',
        actual: '1102',
        correct: true,
        calls: {amcp_platform_workspace: {count: 1, durations: []}, meta_native_action: {count: 2, durations: []}},
      },
    ]),
    pairs,
    {E1: 3},
  );
  assert.deepEqual(
    skillRanges([measured, second]).find(r => r.id === 'E1'),
    {
      id: 'E1',
      runs: 2,
      correct: 2,
      tool_calls: {min: 3, median: 4, max: 5},
      unnecessary_calls: {min: 0, median: 1, max: 2},
    },
  );
  for (const bad of [
    'no tasks here',
    report([{question: 'A question the set does not have', expected: 'x', actual: 'x', correct: true, calls: {}}]),
    report([
      {question: pairs[0].question, expected: 'x', actual: 'x', correct: true, calls: {'bad tool!': {count: 1}}},
    ]),
  ])
    assert.throws(() => skillReport(bad, pairs), /MCP_EVAL_SKILL_REPORT_INVALID/);
  assert.equal(evaluationArguments(['--skill-report', 'a.md,b.md']).input, 'a.md,b.md');
  assert.equal(evaluationArguments(['--skill-report', 'a.md', '--output', 'r.json']).mode, 'skill-report');
  for (const argv of [
    ['--skill-report', 'a.md', '--only', 'E1'],
    ['--skill-report', 'a.md', '--external', 'runs.json'],
    ['--skill-report'],
  ])
    assert.throws(() => evaluationArguments(argv), /Use: /, JSON.stringify(argv));
});

test('the runner wrapper hands the runner JSON content blocks without changing the installed skill', t => {
  // Stubs of the runner's two modules with its defects: connections.call_tool returns model objects, which the
  // runner passes to json.dumps, and the report is written with Python's default encoding (a code page on Windows that
  // cannot encode its check marks). The real ones import the anthropic and mcp packages, which only the owner installs.
  // On Windows "python" on PATH may be the Microsoft Store alias, which runs no Python: it fails or prints nothing.
  const version = spawnSync(python, ['--version'], {encoding: 'utf8'}),
    answered = ((version.stdout ?? '') + (version.stderr ?? '')).trim(),
    [, major, minor] = /^Python (\d+)\.(\d+)/.exec(answered) ?? [];
  assert.ok(
    version.status === 0 && (Number(major) > 3 || (Number(major) === 3 && Number(minor) >= 10)),
    'this test runs ' +
      python +
      ' and needs Python 3.10 or later, but `' +
      python +
      ' --version` answered ' +
      JSON.stringify(answered || String(version.error ?? 'nothing')) +
      ' (exit ' +
      version.status +
      '). Set AMCP_SCHEMA_PYTHON to an installed Python (README); on Windows the Microsoft Store alias runs none.',
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-skill-runner-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(
    path.join(dir, 'connections.py'),
    [
      'class Block:',
      '    def __init__(self, text): self.text = text',
      '    def model_dump(self, mode=None, exclude_none=False): return {"type": "text", "text": self.text}',
      'class Result:',
      '    def __init__(self): self.content = [Block(\'{"success":true}\')]',
      'class Session:',
      '    async def call_tool(self, name, arguments=None): return Result()',
      'class MCPConnection:',
      '    def __init__(self): self.session = Session()',
      '    async def call_tool(self, tool_name, arguments):',
      '        result = await self.session.call_tool(tool_name, arguments=arguments)',
      '        return result.content',
      'def create_connection(**kwargs): return MCPConnection()',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'evaluation.py'),
    [
      'import asyncio, json, sys',
      'from pathlib import Path',
      'from connections import create_connection',
      'async def main():',
      '    result = await create_connection().call_tool("amcp_tool_help", {})',
      '    if "-o" in sys.argv:',
      '        Path(sys.argv[sys.argv.index("-o") + 1]).write_text("**Correct**: \\u2705\\n")',
      '    print(json.dumps({"argv": sys.argv[1:], "response": json.dumps(result), "utf8": sys.flags.utf8_mode}))',
      'if __name__ == "__main__":',
      '    asyncio.run(main())',
      '',
    ].join('\n'),
  );
  const before = fs.readFileSync(path.join(dir, 'connections.py'), 'utf8');
  // Without the wrapper the runner's own serialization fails, as it does on every tool call of the real runner.
  const direct = spawnSync(python, [path.join(dir, 'evaluation.py')], {cwd: dir, encoding: 'utf8'});
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /not JSON serializable/);
  // The report goes to a folder that does not exist yet, as a first run's .runtime/mcp-evaluation/ does not.
  const report = path.join(dir, 'reports', 'run-1.md'),
    runnerArgs = ['-t', 'stdio', '-c', 'node', '-o', report, 'evaluation.xml'],
    wrapped = spawnSync(python, [wrapper, '--skill-scripts', dir, '--', ...runnerArgs], {encoding: 'utf8'});
  assert.equal(wrapped.status, 0, wrapped.stderr);
  const printed = JSON.parse(wrapped.stdout);
  assert.deepEqual(printed.argv, runnerArgs);
  assert.deepEqual(JSON.parse(printed.response), [{type: 'text', text: '{"success":true}'}]);
  // The runner ran in UTF-8 mode, so its report keeps the check mark on every platform (with CRLF on Windows).
  assert.equal(printed.utf8, 1);
  assert.equal(fs.readFileSync(report, 'utf8').replace(/\r\n/g, '\n'), '**Correct**: ✅\n');
  // A repeated run naming the same report is refused before anything runs, and the earlier report is kept.
  fs.writeFileSync(report, 'earlier run');
  const again = spawnSync(python, [wrapper, '--skill-scripts', dir, '--', ...runnerArgs], {encoding: 'utf8'});
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /MCP_SKILL_REPORT_EXISTS/);
  assert.equal(fs.readFileSync(report, 'utf8'), 'earlier run');
  assert.equal(fs.readFileSync(path.join(dir, 'connections.py'), 'utf8'), before, 'the skill files are unchanged');
  const usage = spawnSync(python, [wrapper, '--', 'x'], {encoding: 'utf8'});
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /Use: python tools\/mcp-skill-evaluation\.py/);
  const missing = spawnSync(python, [wrapper, '--skill-scripts', path.join(dir, 'none'), '--', 'x'], {
    encoding: 'utf8',
  });
  assert.match(missing.stderr, /MCP_SKILL_RUNNER_NOT_FOUND/);
});
