// Runs the QA-04 journey and task suites and returns one metrics record. Shared by tools/mcp-eval.mjs (the local
// check and baseline writer) and tests/mcp-eval.test.mjs.
import assert from 'node:assert/strict';
import {evaluationFixture, transcriptMetrics} from './harness.mjs';
import {journeys, branchNames} from './journeys.mjs';
import {taskSet, runTask} from './tasks.mjs';

/** Every run starts from a fresh workspace; zero egress and the synthetic providers' own counters are asserted. */
async function measured(fault, body) {
  const f = await evaluationFixture({fault});
  try {
    const before = f.providers.state.requests.length;
    const outcome = await body(f);
    assert.equal(f.providers.state.egress_refused, 0, 'A journey attempted egress outside the synthetic providers');
    const transcript = f.transcript.slice(0, outcome.measured ?? f.transcript.length);
    return {
      ...transcriptMetrics(transcript, {
        reference: outcome.reference ?? [],
        goalReached: outcome.goal,
        handoff: outcome.handoff ?? null,
        userActions: f.userActions(),
      }),
      // Every provider request of the run, the worker's included, and the synthetic mutations it applied.
      provider_requests: f.providers.state.requests.length - before,
      provider_mutations: f.providers.state.mutations,
      surfaces: [...new Set(transcript.map(entry => entry.surface))].sort(),
      discovery: f.discovery,
    };
  } finally {
    await f.close();
  }
}

/** All eight journeys with their four branches each. */
export async function runJourneys({fault, only} = {}) {
  const runs = {};
  for (const journey of journeys)
    for (const branch of branchNames) {
      const id = journey.id + '/' + branch;
      if (only && !only.includes(journey.id) && !only.includes(id)) continue;
      const result = await measured(fault, async f => {
        const outcome = await journey.branches[branch](f);
        return {goal: outcome.goal === true, handoff: outcome.handoff ?? null};
      });
      delete result.discovery;
      runs[id] = result;
    }
  return runs;
}

/** The B15 tasks, each as a scripted reference run and as a guided run that follows AMCP's offered next calls. */
export async function runTasks({fault, only} = {}) {
  const runs = {};
  let discovery;
  for (const task of taskSet.tasks)
    for (const mode of ['reference', 'guided']) {
      const id = task.id + '/' + mode;
      if (only && !only.includes(task.id) && !only.includes(id)) continue;
      const result = await measured(fault, async f => {
        const outcome = await runTask(f, task, mode);
        return {
          goal: outcome.goalReached,
          handoff: outcome.handoff,
          measured: outcome.measured,
          reference: task.reference,
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

/** One metrics record for both suites. */
export async function runEvaluation({fault, suites = ['journeys', 'tasks'], only} = {}) {
  const runs = {};
  let discovery;
  if (suites.includes('journeys')) runs.journeys = await runJourneys({fault, only});
  if (suites.includes('tasks')) {
    const tasks = await runTasks({fault, only});
    runs.tasks = tasks.runs;
    discovery = tasks.discovery;
  }
  return {
    schema_version: 1,
    record_kind: 'amcp_journey_and_mcp_evaluation',
    fault: fault ?? null,
    mcp_surface: discovery ?? null,
    task_measures: runs.tasks ? taskMeasures(runs.tasks) : undefined,
    runs,
  };
}
