// Journey and MCP evaluation (QA-04, B15 "measured"). Runs the ten user journeys (tests/journeys/journeys.mjs, four
// branches each), the B15 tasks (tests/journeys/b15-tasks.json, reference and guided runs) and the MCP evaluation set
// (tests/fixtures/mcp-evaluation/evaluation.xml, each question answered by its reference solution) against an
// in-memory MCP server, the loopback website and synthetic providers, with zero egress, and compares the metrics with
// the committed baseline (tests/journeys/baseline.json). It also measures external AI clients' sanitized transcripts
// with the same metric code, and the mcp-builder skill's LLM runner reports against the reference solutions, as ranges
// over repeated runs.
//
//   node tools/mcp-eval.mjs [--check] [--only J1,T3,E4,J2/failure] [--fault <name>] [--profile v2] [--output <new file>] [--transcripts]
//   node tools/mcp-eval.mjs --write-baseline
//   node tools/mcp-eval.mjs --sanitize <raw calls.json> --output <new file>
//   node tools/mcp-eval.mjs --external <runs.json> [--output <new file>]
//   node tools/mcp-eval.mjs --skill-report <report.md>[,<report.md>...] [--output <new file>]
//
// --check (the default) exits non-zero when a count rises, an end state, handoff or tool choice gets worse, or response
// bytes grow beyond the tolerance. --fault applies a deliberate regression (strip-next-call, hide-attention) so the
// check can be seen to fail. --profile v2 runs every client as one on the v2 contract profile (V2-MCP-06, D26) and compares
// it with the same committed baseline, which is the legacy profile's: what the profile changes in the journeys' counts, outcomes
// and response bytes is what the check then reports. --write-baseline is the only way the baseline changes; it refuses a subset or a fault.
// Requires a built dist (npm run build). Transcripts keep argument shapes, codes, states and sizes, never values.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const baselineFile = fileURLToPath(new URL('../tests/journeys/baseline.json', import.meta.url));
export const tolerance = Object.freeze({bytesTolerance: 0.1, bytesSlack: 512});
const usage =
  'Use: node tools/mcp-eval.mjs [--check] [--only <ids>] [--fault <name>] [--profile legacy|v2] [--output <new file>] [--transcripts] | ' +
  '--write-baseline | --sanitize <raw.json> --output <new file> | --external <runs.json> [--output <new file>] | ' +
  '--skill-report <report.md>[,<report.md>...] [--output <new file>]';

/** Parses the arguments; every option at most once, and the modes exclusive. */
export function evaluationArguments(argv) {
  const options = {
    mode: 'check',
    only: null,
    fault: null,
    output: null,
    transcripts: false,
    input: null,
  };
  const seen = new Set(),
    take = index => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw Error(usage);
      return value;
    };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (seen.has(argument)) throw Error(usage);
    seen.add(argument);
    if (argument === '--check') options.mode = options.mode === 'check' ? 'check' : null;
    else if (argument === '--write-baseline') options.mode = options.mode === 'check' ? 'write-baseline' : null;
    else if (argument === '--transcripts') options.transcripts = true;
    else if (argument === '--only') options.only = take(index++).split(',').filter(Boolean);
    else if (argument === '--fault') options.fault = take(index++);
    else if (argument === '--profile') {
      const profile = take(index++);
      if (!['legacy', 'v2'].includes(profile)) throw Error(usage);
      options.profile = profile;
    } else if (argument === '--output') options.output = take(index++);
    else if (argument === '--sanitize' || argument === '--external' || argument === '--skill-report') {
      options.mode = options.mode === 'check' ? argument.slice(2) : null;
      options.input = take(index++);
    } else throw Error(usage);
    if (options.mode === null) throw Error(usage);
  }
  if ((seen.has('--check') && options.mode !== 'check') || options.only?.length === 0) throw Error(usage);
  if (options.mode === 'write-baseline' && (options.only || options.fault || options.output))
    throw Error('MCP_EVAL_BASELINE_PARTIAL: the baseline is written from a complete run without a fault.');
  if (options.mode === 'write-baseline' && options.profile)
    throw Error(
      'MCP_EVAL_BASELINE_PROFILE: the committed baseline belongs to the legacy profile, so it is never written from a run of another.',
    );
  if (options.mode === 'sanitize' && !options.output) throw Error(usage);
  if (
    ['sanitize', 'external', 'skill-report'].includes(options.mode) &&
    (options.only || options.fault || options.transcripts || options.profile)
  )
    throw Error(usage);
  return options;
}

/**
 * Measures one or more reports of the mcp-builder skill's LLM runner (scripts/evaluation.py -o <report.md>) against
 * the evaluation set: each task's correctness, tool calls by tool, and the calls beyond the reference solution's
 * (from the committed baseline). Several reports (repeated runs) are summarized as ranges per question.
 */
export async function measureSkillReports(files, baseline = readBaseline()) {
  const {skillReport, skillRanges} = await import('../tests/journeys/evaluation-set.mjs');
  const references = Object.fromEntries(
    Object.entries(baseline.runs?.evaluation_set ?? {}).map(([id, run]) => [id, run.tool_calls]),
  );
  const records = files.map(file => skillReport(fs.readFileSync(file, 'utf8'), undefined, references));
  return {
    schema_version: 1,
    record_kind: 'amcp_skill_evaluation_runs',
    runs: records.map(r => ({tasks: r.tasks, correct: r.correct, total: r.total})),
    ranges: skillRanges(records),
  };
}

/** The committed baseline from a complete evaluation record: metrics only, no transcripts, no durations. */
export function baselineFrom(record) {
  if (record.fault) throw Error('MCP_EVAL_BASELINE_PARTIAL: a faulted run is never a baseline.');
  const runs = {};
  for (const [suite, entries] of Object.entries(record.runs ?? {}))
    runs[suite] = Object.fromEntries(
      Object.entries(entries).map(([id, metrics]) => {
        const {transcript, ...kept} = metrics;
        return [id, kept];
      }),
    );
  return {
    schema_version: 1,
    record_kind: 'amcp_journey_and_mcp_evaluation_baseline',
    note:
      'Deterministic local baseline (QA-04). Counts may not rise and outcomes may not get worse; response bytes may ' +
      'grow at most the tolerance. Regenerate only deliberately with node tools/mcp-eval.mjs --write-baseline.',
    tolerance,
    mcp_surface: record.mcp_surface,
    task_measures: record.task_measures,
    runs,
  };
}

/** The baseline restricted to the runs a subset measured, so a subset check never reports the others as missing. */
export function baselineSubset(baseline, record) {
  const runs = {};
  for (const [suite, entries] of Object.entries(baseline.runs ?? {}))
    if (record.runs?.[suite])
      runs[suite] = Object.fromEntries(Object.entries(entries).filter(([id]) => record.runs[suite][id]));
  return {...baseline, runs, mcp_surface: record.mcp_surface ? baseline.mcp_surface : undefined};
}

export function readBaseline(file = baselineFile) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value?.schema_version !== 1 || value.record_kind !== 'amcp_journey_and_mcp_evaluation_baseline' || !value.runs)
    throw Error('MCP_EVAL_BASELINE_INVALID');
  return value;
}

/**
 * Measures external clients' runs: {schema_version: 1, runs: [{client, task, run, goal_reached, handoff?,
 * user_actions?, transcript: [sanitized entries]}]}. Each transcript is checked to carry no values, measured against
 * its task's reference, and summarized as ranges per client and task.
 */
export async function measureExternal(value) {
  const {sanitizeTranscript, transcriptMetrics, externalRanges} = await import('../tests/journeys/harness.mjs');
  const {taskSet} = await import('../tests/journeys/tasks.mjs');
  if (value?.schema_version !== 1 || !Array.isArray(value.runs) || !value.runs.length)
    throw Error('MCP_EVAL_EXTERNAL_INVALID');
  const runs = value.runs.map((run, index) => {
    const task = taskSet.tasks.find(item => item.id === run?.task);
    if (!task || typeof run.client !== 'string' || !/^[\w .:+()-]{1,80}$/.test(run.client))
      throw Error('MCP_EVAL_EXTERNAL_INVALID at ' + index);
    if (typeof run.goal_reached !== 'boolean') throw Error('MCP_EVAL_EXTERNAL_INVALID at ' + index + ': goal_reached');
    const transcript = sanitizeTranscript(run.transcript);
    return {
      client: run.client,
      task: task.id,
      holdout: task.holdout,
      run: Number.isInteger(run.run) ? run.run : index + 1,
      metrics: transcriptMetrics(transcript, {
        reference: task.reference,
        goalReached: run.goal_reached,
        handoff: task.handoff ? run.handoff === true : null,
        userActions: Number.isInteger(run.user_actions) ? run.user_actions : 0,
      }),
    };
  });
  return {
    schema_version: 1,
    record_kind: 'amcp_external_client_evaluation',
    runs,
    ranges: externalRanges(runs),
  };
}

const writeNew = (file, value) => {
  fs.mkdirSync(path.dirname(path.resolve(file)), {recursive: true});
  // A record never replaces an earlier one.
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
};

async function main(argv) {
  const options = evaluationArguments(argv);
  if (options.mode === 'sanitize') {
    const {sanitizeRawCalls} = await import('../tests/journeys/harness.mjs');
    const transcript = sanitizeRawCalls(JSON.parse(fs.readFileSync(options.input, 'utf8')));
    writeNew(options.output, transcript);
    console.log(JSON.stringify({sanitized_calls: transcript.length, output: options.output}));
    return 0;
  }
  if (options.mode === 'external') {
    const measuredRuns = await measureExternal(JSON.parse(fs.readFileSync(options.input, 'utf8')));
    if (options.output) writeNew(options.output, measuredRuns);
    console.log(JSON.stringify(measuredRuns.ranges, null, 2));
    return 0;
  }
  if (options.mode === 'skill-report') {
    const measuredRuns = await measureSkillReports(options.input.split(',').filter(Boolean));
    if (options.output) writeNew(options.output, measuredRuns);
    console.log(JSON.stringify(measuredRuns.ranges, null, 2));
    return 0;
  }
  if (!fs.existsSync(fileURLToPath(new URL('../dist/server/mcp.js', import.meta.url))))
    throw Error('MCP_EVAL_DIST_MISSING: run npm run build first.');
  const {runEvaluation} = await import('../tests/journeys/run.mjs');
  const {compareWithBaseline} = await import('../tests/journeys/harness.mjs');
  const record = await runEvaluation({
    fault: options.fault ?? undefined,
    only: options.only ?? undefined,
    transcripts: options.transcripts,
    profile: options.profile,
  });
  if (options.mode === 'write-baseline') {
    fs.writeFileSync(baselineFile, JSON.stringify(baselineFrom(record), null, 2) + '\n');
    console.log(
      JSON.stringify({baseline: path.relative(process.cwd(), baselineFile), duration_ms: record.duration_ms}),
    );
    return 0;
  }
  const baseline = readBaseline(),
    comparison = compareWithBaseline(record, options.only ? baselineSubset(baseline, record) : baseline, tolerance);
  if (options.output) writeNew(options.output, {...record, comparison});
  const count = Object.values(record.runs).reduce((sum, runs) => sum + Object.keys(runs).length, 0);
  console.log(
    JSON.stringify(
      {
        passed: comparison.passed,
        runs: count,
        fault: record.fault,
        profile: record.profile,
        duration_ms: record.duration_ms,
        regressions: comparison.regressions,
        improvements: comparison.improvements.length,
      },
      null,
      2,
    ),
  );
  return comparison.passed ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]))
  process.exitCode = await main(process.argv.slice(2));
