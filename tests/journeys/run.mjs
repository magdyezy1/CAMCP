// Runs the QA-04 journey, task and evaluation-set suites and returns one metrics record. Shared by tools/mcp-eval.mjs
// (the local check and baseline writer) and tests/mcp-eval.test.mjs.
import assert from 'node:assert/strict';
import {evaluationFixture, transcriptMetrics, sanitizeTranscript} from './harness.mjs';
import {journeys, branchNames} from './journeys.mjs';
import {taskSet, runTask} from './tasks.mjs';
import {evaluationSet, runEvaluationSet} from './evaluation-set.mjs';

/**
 * Every run identifier the suites know: J1/success … J9/incomplete_evidence, T1/reference … H2/guided, and the
 * evaluation set's questions E1 … E10 (tests/fixtures/mcp-evaluation/evaluation.xml).
 */
export const runIds = Object.freeze({
  journeys: journeys.flatMap(journey => branchNames.map(branch => journey.id + '/' + branch)),
  tasks: taskSet.tasks.flatMap(task => ['reference', 'guided'].map(mode => task.id + '/' + mode)),
  evaluation_set: evaluationSet().map(pair => pair.id),
});
const selected = (only, groupId, id) => !only || only.includes(groupId) || only.includes(id);

/**
 * Every run starts from a fresh workspace; zero egress is asserted. Provider requests and synthetic mutations made
 * while a task's scenario is set up are not part of the run.
 */
async function measured({fault, transcripts, profile}, body) {
  const f = await evaluationFixture({fault, profile});
  try {
    const outcome = await body(f);
    assert.equal(f.providers.state.egress_refused, 0, 'A journey attempted egress outside the synthetic providers');
    assert.equal(f.globalEgress.refused, 0, 'A journey called the global fetch outside the loopback website');
    const transcript = f.transcript.slice(0, outcome.measured ?? f.transcript.length);
    return {
      ...transcriptMetrics(transcript, {
        reference: outcome.reference ?? [],
        goalReached: outcome.goal,
        handoff: outcome.handoff ?? null,
        userActions: f.userActions(),
      }),
      // Every provider request of the run, the report worker's included, and the synthetic mutations it applied.
      provider_requests: f.providers.state.requests.length - (outcome.setup?.requests ?? 0),
      provider_mutations: f.providers.state.mutations - (outcome.setup?.mutations ?? 0),
      surfaces: [...new Set(transcript.map(entry => entry.surface))].sort(),
      discovery: f.discovery,
      ...(transcripts ? {transcript: sanitizeTranscript(transcript)} : {}),
    };
  } finally {
    await f.close();
  }
}

/** All nine journeys with their four branches each. */
export async function runJourneys({fault, only, transcripts = false, profile} = {}) {
  const runs = {};
  for (const journey of journeys)
    for (const branch of branchNames) {
      const id = journey.id + '/' + branch;
      if (!selected(only, journey.id, id)) continue;
      const result = await measured({fault, transcripts, profile}, async f => {
        const outcome = await journey.branches[branch](f);
        return {goal: outcome.goal === true, handoff: outcome.handoff ?? null};
      });
      delete result.discovery;
      runs[id] = result;
    }
  return runs;
}

/** The B15 tasks, each as a scripted reference run and as a guided run that follows AMCP's offered next calls. */
export async function runTasks({fault, only, transcripts = false, profile} = {}) {
  const runs = {};
  let discovery;
  for (const task of taskSet.tasks)
    for (const mode of ['reference', 'guided']) {
      const id = task.id + '/' + mode;
      if (!selected(only, task.id, id)) continue;
      const result = await measured({fault, transcripts, profile}, async f => {
        const outcome = await runTask(f, task, mode);
        return {
          goal: outcome.goalReached,
          handoff: outcome.handoff,
          measured: outcome.measured,
          reference: task.reference,
          setup: outcome.setup,
        };
      });
      discovery ??= result.discovery;
      delete result.discovery;
      runs[id] = {...result, holdout: task.holdout};
    }
  return {runs, discovery};
}

/** The four B15 measures per task, from its guided run against its reference (the deterministic baseline view). */
export function taskMeasures(taskRuns) {
  const measures = {};
  for (const task of taskSet.tasks) {
    const guided = taskRuns[task.id + '/guided'],
      reference = taskRuns[task.id + '/reference'];
    if (!guided || !reference) continue;
    measures[task.id] = {
      job: task.job,
      holdout: task.holdout,
      reference_completes: reference.end_state === 'success',
      reference_calls: reference.tool_calls,
      correct_tool_choice: guided.correct_tool_choice,
      guided_calls: guided.tool_calls,
      guided_reaches_goal: guided.end_state === 'success',
      unnecessary_calls: guided.unnecessary_calls,
      repeated_refused_calls: guided.repeated_refused_calls,
      handoff_success: guided.handoff_success,
      response_bytes: guided.response_bytes,
    };
  }
  return measures;
}

/**
 * One metrics record for the suites. `only` selects journeys (J1), tasks (T3), questions of the evaluation set (E4, or
 * evaluation_set for all), or single runs (J2/failure, T4/guided); an unknown name is refused rather than silently
 * measuring nothing. A response fault applies to the journeys and tasks; the evaluation set's reference solutions read
 * fields a fault does not touch, and always run unfaulted.
 */
export async function runEvaluation({
  fault,
  suites = ['journeys', 'tasks', 'evaluation_set'],
  only,
  transcripts = false,
  profile,
} = {}) {
  if (only) {
    const known = new Set([
      ...[...runIds.journeys, ...runIds.tasks].flatMap(id => [id, id.split('/')[0]]),
      ...runIds.evaluation_set,
      'evaluation_set',
    ]);
    const unknown = only.filter(name => !known.has(name));
    if (unknown.length) throw Error('MCP_EVAL_UNKNOWN_RUN ' + unknown.join(', '));
  }
  const runs = {},
    started = Date.now();
  let discovery;
  if (suites.includes('journeys')) runs.journeys = await runJourneys({fault, only, transcripts, profile});
  if (suites.includes('tasks')) {
    const tasks = await runTasks({fault, only, transcripts, profile});
    runs.tasks = tasks.runs;
    discovery = tasks.discovery;
  }
  if (suites.includes('evaluation_set')) {
    const set = await runEvaluationSet({only, transcripts, profile});
    if (Object.keys(set).length || !only) runs.evaluation_set = set;
  }
  return {
    schema_version: 1,
    record_kind: 'amcp_journey_and_mcp_evaluation',
    fault: fault ?? null,
    // The contract profile the clients of the run were served (V2-MCP-06); the committed baseline is the legacy one.
    profile: profile ?? 'legacy',
    duration_ms: Date.now() - started,
    mcp_surface: discovery ?? null,
    task_measures: runs.tasks ? taskMeasures(runs.tasks) : undefined,
    runs,
  };
}
