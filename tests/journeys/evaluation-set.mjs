// The MCP evaluation set (QA-04, in the mcp-builder skill's evaluation format): ten read-only questions with one stable
// answer each about a synthetic agency workspace (tests/fixtures/mcp-evaluation/). Each question is answered by its
// scripted reference solution through a real MCP SDK client on a fresh workspace and measured like a B15 task, so the
// harness (node tools/mcp-eval.mjs) and the verifier (tests/mcp-evaluation-set.test.mjs) hold every answer equal to the
// XML, every call read-only by its own hints, the store unchanged and egress at zero. The owner runs the same questions
// through the skill's LLM runner (docs/OPERATIONS.md, "MCP evaluation set"); skillReport() measures its report.
import fs from 'node:fs';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../../dist/server/mcp.js';
import {actionContracts} from '../../dist/src/action-contracts.js';
import {ledgerRowHints} from '../../dist/src/execution-status.js';
import {firstPartyContract} from '../../dist/src/first-party-contracts.js';
import {firstPartyActionHints, toolHints} from '../../dist/src/tool-annotations.js';
import {transcriptEntry, transcriptMetrics, sanitizeTranscript} from './harness.mjs';
import {snapshot} from '../helpers/annotation-walk.mjs';
import {evaluationWorkspace} from '../fixtures/mcp-evaluation/workspace.mjs';
import {solutions} from '../fixtures/mcp-evaluation/solutions.mjs';

export const evaluationFile = new URL('../fixtures/mcp-evaluation/evaluation.xml', import.meta.url);
const entities = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
const decode = text => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => entities[name]).trim();
/**
 * The question and answer pairs of an evaluation file, as the skill's runner reads them (ElementTree: every qa_pair
 * with a question and an answer, text trimmed). Anything else in the file is refused, so the set cannot drift into a
 * shape the runner would read differently.
 */
export function evaluationPairs(xml) {
  const body = /^\s*<evaluation>([\s\S]*)<\/evaluation>\s*$/.exec(String(xml));
  if (!body) throw Error('MCP_EVAL_SET_INVALID: one <evaluation> element');
  const pairs = [],
    pair = /\s*<qa_pair>\s*<question>([^<]*)<\/question>\s*<answer>([^<]*)<\/answer>\s*<\/qa_pair>\s*/y;
  let match,
    end = 0;
  while ((match = pair.exec(body[1]))) {
    pairs.push({question: decode(match[1]), answer: decode(match[2])});
    end = pair.lastIndex;
  }
  // A failed sticky match resets lastIndex, so the end of the last pair is kept apart.
  if (body[1].slice(end).trim())
    throw Error('MCP_EVAL_SET_INVALID: only qa_pair elements, each a question then an answer');
  return pairs.map((p, index) => ({id: 'E' + (index + 1), ...p}));
}
export const evaluationSet = () => evaluationPairs(fs.readFileSync(evaluationFile, 'utf8'));

let ledger;
/** The MCP hints of one call, as help states them for its action (MCP-06 per operation). */
export function callHints(service, tool, args) {
  if (tool === 'amcp_tool_help') return toolHints(tool, false);
  const own = service.firstPartyTools().find(t => t.name === tool);
  if (own) {
    const actions = own.inputSchema.properties?.action?.enum,
      action = actions ? args.action : null,
      contract = firstPartyContract(own, action);
    return contract ? firstPartyActionHints(tool, action, contract.effects) : toolHints(tool, false);
  }
  ledger ??= actionContracts(service.registry);
  const delegated = service.registry.tools.get(tool)?.mode === 'delegated',
    row = ledger.find(r =>
      delegated
        ? r.gateway === tool &&
          r.operation === args.operation &&
          r.action === (args.arguments?.action ?? args.operation)
        : r.gateway === tool && r.action === (service.registry.action(tool, args.action)?.name ?? args.action),
    );
  return row ? ledgerRowHints(row) : toolHints(tool, false);
}

/**
 * Answers one question with its reference solution on a fresh workspace, through a real SDK client. Every call is
 * recorded as a transcript entry; the result says whether the answer matched, whether any call was not read-only by
 * its hints, whether the store changed, and what reached the synthetic providers.
 */
export async function answerQuestion(pair, solution = solutions[Number(pair.id.slice(1)) - 1], {profile} = {}) {
  if (!solution || solution.question !== pair.question)
    throw Error('MCP_EVAL_SET_DRIFT: ' + pair.id + ' has no reference solution for its question');
  const w = await evaluationWorkspace({profile}),
    server = createMcpServer(w.service, w.actor),
    client = new Client({name: 'AMCP evaluation-set reference solver', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const transcript = [],
    unsafe = [],
    before = snapshot(w.store);
  try {
    const call = async (tool, args) => {
      const requests = w.providers.state.requests.length,
        response = await client.callTool({name: tool, arguments: args}),
        text = response.content[0].text,
        result = JSON.parse(text);
      if (!callHints(w.service, tool, args).readOnlyHint) unsafe.push(tool + ' ' + (args.action ?? args.operation));
      transcript.push(
        transcriptEntry({
          tool,
          args,
          result,
          bytes: Buffer.byteLength(text),
          providerRequests: w.providers.state.requests.length - requests,
        }),
      );
      return result;
    };
    let answer, error;
    try {
      answer = await solution.solve(call);
    } catch (e) {
      error = e.message;
    }
    return {
      answer,
      error,
      correct: answer === pair.answer,
      transcript,
      unsafe,
      state_changed: snapshot(w.store) !== before,
      providers: structuredClone(w.providers.state),
    };
  } finally {
    await client.close();
    await server.close();
    w.close();
  }
}

/** The set as a QA-04 suite: each question's metrics, like a task's reference run (its own calls are its reference). */
export async function runEvaluationSet({only, transcripts = false, profile} = {}) {
  const runs = {};
  for (const pair of evaluationSet()) {
    if (only && !only.includes(pair.id) && !only.includes('evaluation_set')) continue;
    const outcome = await answerQuestion(pair, undefined, {profile}),
      reference = outcome.transcript.map(entry => ({tool: entry.tool, action: entry.action}));
    runs[pair.id] = {
      ...transcriptMetrics(outcome.transcript, {reference, goalReached: outcome.correct}),
      answer_correct: outcome.correct,
      read_only_calls: outcome.unsafe.length === 0,
      state_unchanged: !outcome.state_changed,
      provider_writes_refused: outcome.providers.writes_refused,
      egress_refused: outcome.providers.egress_refused,
      ...(transcripts ? {transcript: sanitizeTranscript(outcome.transcript)} : {}),
    };
  }
  return runs;
}

/**
 * The report of the skill's LLM runner (scripts/evaluation.py, `-o report.md`), measured against the set: per task
 * whether the answer was correct, its tool calls by tool, and the calls beyond the reference solution's. Only counts,
 * names of AMCP tools and correctness are kept: never the answers, summaries or feedback the report also holds.
 */
export function skillReport(markdown, pairs = evaluationSet(), referenceCalls = {}) {
  const text = String(markdown).replace(/\r\n/g, '\n'),
    sections = text.split(/^### Task (\d+)\n/m).slice(1);
  if (!sections.length) throw Error('MCP_EVAL_SKILL_REPORT_INVALID: no "### Task" sections');
  const tasks = [];
  for (let i = 0; i < sections.length; i += 2) {
    const section = sections[i + 1],
      question = /^\*\*Question\*\*: (.*)$/m.exec(section)?.[1]?.trim(),
      pair = pairs.find(p => p.question === question),
      correct = /^\*\*Correct\*\*: (✅|❌)$/m.exec(section)?.[1],
      calls = /\*\*Tool Calls\*\*: (\{[\s\S]*?\})\n\n\*\*Summary\*\*/.exec(section)?.[1];
    if (!pair || !correct || calls === undefined)
      throw Error('MCP_EVAL_SKILL_REPORT_INVALID: task ' + sections[i] + ' does not match a question of the set');
    let parsed;
    try {
      parsed = JSON.parse(calls);
    } catch {
      throw Error('MCP_EVAL_SKILL_REPORT_INVALID: task ' + sections[i] + ' tool calls');
    }
    const tools = {};
    for (const [tool, entry] of Object.entries(parsed)) {
      if (!/^[a-z0-9_]{1,80}$/.test(tool) || !Number.isSafeInteger(entry?.count) || entry.count < 0)
        throw Error('MCP_EVAL_SKILL_REPORT_INVALID: task ' + sections[i] + ' tool ' + tool.slice(0, 80));
      tools[tool] = entry.count;
    }
    const total = Object.values(tools).reduce((sum, n) => sum + n, 0),
      reference = referenceCalls[pair.id];
    tasks.push({
      id: pair.id,
      correct: correct === '✅',
      tool_calls: total,
      tools,
      ...(Number.isSafeInteger(reference)
        ? {reference_calls: reference, unnecessary_calls: Math.max(0, total - reference)}
        : {}),
    });
  }
  return {
    schema_version: 1,
    record_kind: 'amcp_skill_evaluation',
    tasks,
    correct: tasks.filter(t => t.correct).length,
    total: tasks.length,
  };
}
/** Several runs of the skill's runner as ranges per question (model behaviour varies, so never one number). */
export function skillRanges(records) {
  const ids = [...new Set(records.flatMap(r => r.tasks.map(t => t.id)))].sort(
      (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
    ),
    range = values => {
      const sorted = [...values].sort((x, y) => x - y),
        middle = Math.floor(sorted.length / 2);
      return {
        min: sorted[0],
        median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
        max: sorted.at(-1),
      };
    };
  return ids.map(id => {
    const runs = records.map(r => r.tasks.find(t => t.id === id)).filter(Boolean);
    return {
      id,
      runs: runs.length,
      correct: runs.filter(t => t.correct).length,
      tool_calls: range(runs.map(t => t.tool_calls)),
      ...(runs.every(t => Number.isSafeInteger(t.unnecessary_calls))
        ? {unnecessary_calls: range(runs.map(t => t.unnecessary_calls))}
        : {}),
    };
  });
}
