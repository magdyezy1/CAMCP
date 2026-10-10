import {runEvaluation} from './journeys/run.mjs';
const only = process.argv.slice(3);
const started = Date.now();
const record = await runEvaluation({suites: (process.argv[2] ?? 'journeys,tasks').split(','), only: only.length ? only : undefined, fault: process.env.FAULT});
for (const [suite, runs] of Object.entries(record.runs))
  for (const [id, m] of Object.entries(runs))
    console.log(suite, id, m.end_state, 'goal-handoff', m.handoff_success, 'mcp', m.tool_calls, 'web', m.website_actions, 'user', m.user_actions, 'refused', m.refused_calls, 'rep', m.repeated_refused_calls, 'prov', m.provider_requests, 'mut', m.provider_mutations, 'bytes', m.response_bytes, 'unn', m.unnecessary_calls, 'ctc', m.correct_tool_choice, 'appr', m.user_approvals, 'nextAtStop', m.next_step_at_stop);
console.log(JSON.stringify(record.task_measures ?? {}, null, 0));
console.log('ms', Date.now() - started);
