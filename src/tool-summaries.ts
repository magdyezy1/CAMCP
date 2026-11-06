import type {JsonObject} from './types.js';
import {actionSummaries, firstPartyContract, type FirstPartyContract} from './first-party-contracts.js';
import {firstPartyActionHints} from './tool-annotations.js';

/**
 * What tools/list shows of each tool (MCP-01). Clients truncate a description at 2,048 characters, and under tool search
 * only names load at session start, so a description is a routing summary: when to use the tool, its safety contract,
 * its core actions and where the rest lives. The full text and the per-action detail are unchanged and returned by
 * the tool's own action:"help". MIRROR_FLAGS {"compactDescriptions":false} lists the full text.
 */
export const descriptionBudget = 2000;
const help = (tool: string) =>
  'Full text: ' + tool + ' {action:"help"}; action rules: ' + tool + ' {action:"help",topic:"<action>"}.';
export const routingSummaries: Readonly<Record<string, string>> = Object.freeze({
  amcp_workspace:
    'Use this before planning a change for account readiness and write contracts, and afterwards for history. ' +
    'Safety: no advertising changes. Local saves need confirmed:true and the current revision/version. Drafts need amcp_write or amcp_campaign review. Missing evidence stays unknown. ' +
    'Core: capabilities (readiness; view:"graph"), check and program_check (only live:true reads providers), contracts, operations (next_call), history, dashboard. ' +
    'Also: portfolio, measurement/catalog evidence and plans, consent drafts, local workbook records, clients, monitors and owner policies. ' +
    'Confirmation: confirmed:true for resume_report_run, save_report_schedule, save_report_query, move_report_query, save_report_binding, save_report_binding_state, save_profile, save_monitor, set_monitor_state, create_consent_plan, create_catalog_removal, delete_profile, delete_brief (operator); set_monitor_notifications, retry_monitor_notification (reader); save_spend_policy, save_retention, save_plan_policy, pause_writes, resume_writes, enable_personal_data, disable_personal_data, save_ga4_test_property (owner). ' +
    help('amcp_workspace') +
    ' Guides: amcp_workspace {action:"help",topic:"guides"}.',
  amcp_campaign:
    'Use this for a launch whose later steps need IDs that earlier steps create (campaign, then ad set, then ad); for one change use amcp_write. ' +
    'It saves a durable dependency plan (native steps, approved templates or recipes) and runs it step by step. ' +
    'Safety: no fabricated IDs, implicit launch or review bypass; every step is a frozen, read-back native review; a step that reached the provider is never sent again; uncertain receipts keep their recovery. ' +
    'Core actions: recipes, recipe_context, recipe_eligibility (live:true adds read-only account prerequisites), recipe_lookup, preview_recipe, create_from_recipe; create, get, list (filters, next_cursor), preflight; ' +
    'prepare_next and execute_next (one reviewed step at a time, read back); verify; approve (what one approval covers; confirmed with that plan_hash records it) and run (every step under it, stopping for anything that needs a person; run_background runs an approved plan of media uploads on the server); ' +
    'recover_step, reconcile_step, confirm_absent and continue_as_new for blocked, refused or uncertain steps; activation_plan; archive, unarchive, assign and unassign; clone (Snapchat, Google Search, TikTok or LinkedIn into a paused draft); validate_provider; cancel. ' +
    'Get with step_id or detail:"full" returns more. ' +
    'Confirmation: confirmed:true for execute_next, continue_as_new, archive (operator). ' +
    help('amcp_campaign'),
  amcp_write:
    'Use this for any single advertising or measurement change; use amcp_campaign when later steps need IDs that earlier steps create. ' +
    'Safety: inspect needs no credentials or network; prepare reads state and freezes a five-minute, actor-bound review whose execute_requirements name every acknowledgement; execute sends it once after confirmed:true (idempotency_key defaults to the review_id) and never retries it; operator role and account write grants apply. ' +
    'Core actions: inspect, prepare and execute (a Google Ads or Snapchat batch over 25 records is one review of parts of 25), status (a retained review read back without a provider request) and reconcile (read-only checks of an uncertain write; accept_applied with its reconciliation_id records what was observed). ' +
    'Confirmation: confirmed:true for execute (operator). ' +
    help('amcp_write'),
  amcp_reporting:
    'Use this to analyse captured native report metrics: reconciliation, comparisons and recommendations. ' +
    'For saved client reports, schedules and Sheets exports, use amcp_reporting_overview. ' +
    'Safety: no advertising writes. A saved plan is an unapproved draft that still needs native review, spending acknowledgement and read-back. Missing metrics stay unknown; most attribution windows and completeness remain declared; partial or changed evidence is refused. ' +
    'Core actions: capture_presets, capture_preset and capture (bounded, source-hashed native reads), overview_sources and capture_overview, list and get (row_query, xlsx_path), ' +
    'analyze (pacing, anomaly, fatigue and search-waste recommendations), reconcile_report and reconcile, combine, scenarios, ' +
    'calibrate_allocation, allocation_candidates, allocation, preview_allocation_plan and create_allocation_plan, allocation_outcome and capture_allocation_outcome (a verified plan’s next closed period), search_exclusion_candidates, preview_search_exclusions and create_search_exclusion_plan. ' +
    'Confirmation: confirmed:true for create_allocation_plan, create_search_exclusion_plan (operator). ' +
    help('amcp_reporting'),
  amcp_reporting_overview:
    'Use this for saved client reports across accounts, their schedules and Sheets or file exports; to analyse one captured native report, use amcp_reporting. ' +
    'Safety: no advertising mutations. Sheets exports replace only an AMCP-owned tab and retries never append duplicate rows; missing metrics remain null; GA4 and Search Console are measurement context. ' +
    'Start with bootstrap (accounts, levels, defaults, metrics, saved reports, destinations). ' +
    'run queues a bounded native snapshot (total to monthly, campaign to ad level where qualified); poll get. ' +
    'Reads: bootstrap, get, list, compare, compare_candidates, report_pack, presentation_profiles, export_status, preview_schedule, preview_workbook_move. ' +
    'Destinations: create_spreadsheet and bind_destination (Google Sheets), bind_file_destination (encrypted local PDF/XLSX). ' +
    'Editing or deleting a saved report, template or schedule needs expected_revision. ' +
    'Confirmation: confirmed:true for save_presentation, apply_profile_presentation, save, save_template, delete_template, delete_view, delete_report, update_schedule, remove_schedule, run, export, schedule, pause_schedule, delete_schedule, resume_schedule, retry, cancel, bind_destination, bind_file_destination, resolve_delivery, move_workbook_schedule, undo_workbook_move (operator); create_spreadsheet (admin). ' +
    help('amcp_reporting_overview'),
  amcp_ad_previews:
    'Use this to see existing ads as the platform shows them, with links that expire. For media files use amcp_media. ' +
    'Safety: reads only; nothing is saved. Core: platform, account_id, ad_ids or statuses, campaign_ids and adset_ids, ' +
    'limit (default 5, at most 10), cursor; ad_format selects a Meta placement. Help: {action:"help"}.',
  amcp_media:
    'Use this to put an image or video into an ad account as a reviewed upload: a file uploaded on the website (source_id; list returns them under sources), a public HTTPS link (source_url), or a public or selected private Google Drive file (drive_url). ' +
    'Safety: the MCP client never downloads bytes; nothing publishes ads or posts; operator role, account write grants and durable idempotency apply; website uploads expire 30 minutes after the upload starts. ' +
    'prepare fetches and encrypts the exact file for a five-minute review (fit_to_platform:true scales or converts it; request.transform says what changed); execute uploads those frozen bytes after explicit confirmation; execute_async and job_status queue and follow it; status reads provider processing; recovery and resume continue an interrupted upload within its original review, never an uncertain part. ' +
    'Other actions: plan (per-account variants), variant, inspect_eligibility (checks a file against a placement before any upload), prepare_library, reuse, cancel, list, library, asset, asset_usage (current Meta, Google and Snapchat references to an uploaded asset), asset_performance, save_asset_metadata, and retain_source and remove_source (workspace owner only). ' +
    'Supports PNG/JPEG and MP4/MOV for Meta, TikTok, Snapchat, Google Ads, LinkedIn, X and DV360. ' +
    'Confirmation: confirmed:true for execute, resume, execute_async, save_asset_metadata (operator); retain_source, remove_source (owner). ' +
    help('amcp_media'),
  'amcp_media:read_only':
    'Use this to inspect account-scoped retained media metadata, original-source availability, verified AMCP plan usage and compatible retained ad performance. ' +
    'Actions: list, library, asset, asset_performance and asset_usage (bounded current Meta v26 image/video references, complete Google v25 image asset links with reference_view ad_images, performance_max or performance_max_brand, and the Snapchat snapchat_top_snap view). ' +
    'These reads create no snapshot, plan, ownership or write grant and need no upload write grant. ' +
    'This deployment exposes media reads only; uploading, source retention/removal and metadata changes require their separately enabled workflow. ' +
    help('amcp_media'),
});
/** The routing summary listed for a first-party tool, or undefined when the tool keeps its own description. */
/** Tools whose read-only listing is already short and keeps its own text (amcp_write offers inspect only). */
const ownReadOnlyDescription = new Set(['amcp_write']);
export function routingSummary(name: string, readOnly = false): string | undefined {
  if (readOnly && ownReadOnlyDescription.has(name)) return undefined;
  return (readOnly ? routingSummaries[name + ':read_only'] : undefined) ?? routingSummaries[name];
}
/**
 * A gateway description (AMCP's own, or the accurate captured one, MCP-10) that does not fit the budget keeps its
 * leading sentences verbatim and points to the help call that returns it whole; the AMCP note and media sentence that
 * follow it are kept whole.
 */
export function fitCapturedDescription(name: string, captured: string, tail: string[]): string {
  const full = [captured, ...tail].filter(Boolean).join(' ');
  if (full.length <= descriptionBudget) return full;
  const pointer = 'The full description is returned by amcp_tool_help {gateway:"' + name + '"}.',
    room = descriptionBudget - [pointer, ...tail].filter(Boolean).join(' ').length - 1;
  let head = '';
  for (const sentence of sentences(captured)) {
    const next = head ? head + ' ' + sentence : sentence;
    if (next.length > room) break;
    head = next;
  }
  return [head, pointer, ...tail].filter(Boolean).join(' ');
}
const sentences = (text: string) => text.split(/(?<=\.)\s+/).filter(Boolean);
/**
 * The sentences of a full description that concern one action, verbatim and in order. A sentence belongs to the actions
 * it names (as a whole word, so program_check is not check); one that names none continues the actions before it.
 */
export function actionDetail(description: string, actions: string[], action: string): string[] {
  const named = (sentence: string) =>
    actions.filter(a => new RegExp('(^|[^A-Za-z0-9_])' + a + '($|[^A-Za-z0-9_])').test(sentence));
  let current: string[] = [];
  const out: string[] = [];
  for (const sentence of sentences(description)) {
    const mentions = named(sentence);
    if (mentions.length) current = mentions;
    if (current.includes(action)) out.push(sentence);
  }
  return out;
}
/**
 * amcp_tool_help for a first-party tool: the routing summary, the full description, each action's one-line summary and,
 * per action, its detail and its contract (MCP-07): the arguments it reads as JSON Schema, its effects, the least role
 * that can call it and the calls that usually follow.
 */
export function firstPartyHelp(
  tool: {name: string; description: string; inputSchema: JsonObject},
  listed: string,
  operation?: string,
): JsonObject {
  const actions: string[] = tool.inputSchema.properties?.action?.enum ?? [];
  if (operation === undefined) {
    const single = tool.inputSchema.required?.includes('action') ? undefined : firstPartyContract(tool, null);
    return {
      gateway: tool.name,
      mode: 'amcp_workflow',
      selector: actions.length ? 'action' : null,
      summary: listed,
      description: tool.description,
      ...(actions.length
        ? {
            actions,
            action_summaries: actionSummaries(tool),
            operation_help: {tool: tool.name, arguments: {action: 'help', topic: '<action>'}},
          }
        : {}),
      inputSchema: tool.inputSchema,
      ...(single ? {contract: contractView(single)} : {}),
    };
  }
  const detail = actionDetail(tool.description, actions, operation),
    contract = firstPartyContract(tool, operation);
  return {
    gateway: tool.name,
    operation,
    ...(contract ? {summary: contract.summary} : {}),
    detail: detail.length ? detail.join(' ') : null,
    ...(contract ? {arguments: contract.argumentsSchema.properties, contract: contractView(contract)} : {}),
    ...(detail.length
      ? {}
      : {
          meaning: 'The tool description has no text specific to this action; its contract lists its arguments.',
        }),
    call: {tool: tool.name, arguments: {action: operation}},
    see: {tool: tool.name, arguments: {action: 'help'}},
  };
}
/**
 * A contract row as help serves it: the arguments as one JSON Schema, effects, the action's own MCP hints (MCP-06 per
 * operation: a tool's hints in tools/list cover all of its actions; gateway help has no room for them under the
 * one-call budget, D14), role and the usual next calls.
 */
const contractView = (c: FirstPartyContract): JsonObject => ({
  arguments_schema: c.argumentsSchema,
  effects: c.effects,
  annotations: firstPartyActionHints(c.tool, c.action, c.effects),
  requires_role: c.requires_role,
  next: c.next.map(n => ({tool: n.tool, arguments: {action: n.action}})),
  meaning:
    'Arguments outside arguments_schema are not read by this action: they draw a meta.argument_warnings entry by default and are refused with INVALID_ARGUMENT with MIRROR_FLAGS {"actionArguments":"enforce"}. effects are the most a call can do; annotations are this action’s MCP hints.',
});
