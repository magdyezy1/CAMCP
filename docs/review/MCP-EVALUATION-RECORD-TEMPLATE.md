# MCP evaluation record template

Copy this template once for each evaluation session with external AI clients (B15, QA-04, ACC-02). The deterministic
local baseline is `tests/journeys/baseline.json`; [operations](../OPERATIONS.md#journey-and-mcp-evaluation-qa-04)
explains how it is produced and checked. This record holds what the local harness cannot measure: real assistants
choosing calls. Model behavior is nondeterministic, so report ranges over repeated runs, never a single number.

## Session

| Field | Value |
|---|---|
| Date | YYYY-MM-DD |
| Evaluator (owner decision D14) | name or role |
| AMCP source | revision and `source_tree_hash` of the qualification record |
| Deployment | local fixture, staging origin (R7) or owner-designated account (authorized live read only) |
| Baseline compared | `tests/journeys/baseline.json` at revision … |
| Changes since the baseline | for example MCP-07 merged at revision … |

## Clients

List each client exactly as it identified itself, with its version, model and connection mode. D14 names the
must-pass clients: the Claude.ai/Desktop connector, Claude Code, ChatGPT, Codex, Cursor and VS Code.

| Client | Version | Model | Connection | Runs per task |
|---|---|---|---|---|
| | | | | |

## Procedure

1. Start each run in a fresh conversation, with the client connected only to the evaluation workspace.
2. Give the client the task's `prompt` from `tests/journeys/b15-tasks.json`, unchanged, and fill in `{plan}`,
   `{report}` and `{snapshot}` from the scenario. Approve nothing the task does not allow (`approval_allowed`).
3. Export the client's call log as `[{tool, arguments, result, followed?, approval?}]` and sanitize it locally:
   `node tools/mcp-eval.mjs --sanitize raw.json --output .runtime/eval/<client>-<task>-<run>.json`. Delete the raw
   log afterwards. Only the sanitized transcript is kept.
4. Record whether the goal (the task's `goal` field) was reached and, for tasks with a handoff, whether the website
   link opened the same object.
5. Collect the runs into `{"schema_version": 1, "runs": [{client, task, run, goal_reached, handoff, user_actions,
   transcript}]}` and measure them with `node tools/mcp-eval.mjs --external runs.json --output .runtime/eval/ranges.json`.

Never paste provider text, account names, identifiers or argument values into this record. The sanitizer refuses
transcripts that carry them.

## Results per task

Copy the ranges from the `--external` output. Mark hold-out tasks (H1, H2). Their results are reported, but tool
descriptions must never be tuned to them.

| Task | Client | Runs | Goal reached | Correct first tool | Tool calls (min / median / max) | Unnecessary calls | Repeated refused calls | Handoff success |
|---|---|---|---|---|---|---|---|---|
| T1 diagnose readiness | | | | | | | | — |
| T2 build an eligible recipe | | | | | | | | |
| T3 inspect a reviewed change | | | | | | | | |
| T4 recover an uncertain execution | | | | | | | | |
| T5 interpret a partial report | | | | | | | | — |
| T6 reuse a verified asset | | | | | | | | |
| H1 safe export retry (hold-out) | | | | | | | | — |
| H2 keep one client's scope (hold-out) | | | | | | | | — |

## Comparison

- Against the local reference: calls above the reference count, and where clients stopped.
- Against the previous record: what improved or regressed, and which change explains it.
- Findings that become register items, each with the task, the client and the call where it went wrong.

## Limits

State what this session does not establish. Examples are other clients, other models, live provider behavior, write
acceptance, and accessibility of the clients' own interfaces.
