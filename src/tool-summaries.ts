import type {JsonObject} from './types.js';

/**
 * What tools/list shows of each tool (MCP-01). Clients truncate a description at 2,048 characters, and under tool search
 * only names load at session start, so a description is a routing summary: when to use the tool, its safety contract,
 * its core actions and where the rest lives. The full text and the per-action detail are unchanged and returned by
 * amcp_tool_help {gateway: <tool>, operation: <action>}. MIRROR_FLAGS {"compactDescriptions":false} lists the full text.
 */
export const descriptionBudget = 2000;
const help = (tool: string) =>
  'Per-action arguments, limits and rules: amcp_tool_help {gateway:"' +
  tool +
  '", operation:"<action>"}; guides: amcp_tool_help {topic:"guides"} or amcp://guides/index.';
export const routingSummaries: Readonly<Record<string, string>> = Object.freeze({
  amcp_workspace:
    'Use this before planning a change, to see what an account is ready for and which actions have write contracts, and afterwards for its change history. ' +
    'Safety: nothing here changes an advertising account. Previews and saves are local; confirmed saves need confirmed:true and the current revision or version; saved drafts still need native review through amcp_write or amcp_campaign. Missing evidence stays unknown, never passed. ' +
    'Core actions: capabilities (summary of workflows with per-account readiness and blockers, 20 per page, limit up to 25, with next_cursor; filter by workflow_id, connection_id and account_id; view:"graph" for the whole dependency graph), ' +
    'check (exact account prerequisites; live:false saves nothing, live:true reads the provider account and saves its read evidence), ' +
    'program_check (one conditional program; live:false makes no provider request, live:true keeps one observation), ' +
    'contracts (read/write/media/blocked classification of every action, no network), ' +
    'operations (metadata feed of retained work with next_call handoffs), history (bounded audit metadata) and ' +
    'dashboard (counts per provider and account; sections, gateway and account_id select bounded detail). ' +
    'Other actions: portfolio and portfolio_reconcile (bounded inventory), measurement_audit/events/event_identity/conversions/google_goals/ga4_config, catalog_sources/source/preview/compare/plan, consent and catalog-removal drafts, workbook report runs, schedules, queries and bindings, incidents and monitors, client profiles, and owner operations (health, support_bundle, spend policy, retention, write pause, personal-data switch). ' +
    help('amcp_workspace'),
  amcp_campaign:
    'Use this for a launch whose later steps need IDs that earlier steps create (campaign, then ad set, then ad); for one change use amcp_write. ' +
    'It saves a durable campaign dependency plan from a brief and explicit native steps, applies approved profiles and templates, and runs it step by step. ' +
    'Safety: no fabricated IDs, implicit launch or review bypass; every step is a frozen, read-back native review; a step that reached the provider is never sent again, and accepted or uncertain receipts keep their original recovery. ' +
    'Core actions: recipes, recipe_context, recipe_eligibility (checks a brief without saving a plan; live:true adds read-only account prerequisites), recipe_lookup, preview_recipe and create_from_recipe; create (optional idempotency_key), get, list, preflight; ' +
    'prepare_next (the native review of the next step whose predecessors are verified) and execute_next (consumes that exact review and reads the result back); verify; ' +
    'approve (returns what one approval covers; approve with confirmed and that plan_hash records it) and run (prepares and executes every step under it, stopping for anything that needs a person); ' +
    'recover_step and reconcile_step for blocked or uncertain steps; clone (an existing Snapchat, Google Search, TikTok or LinkedIn campaign into a paused draft); validate_provider; cancel. ' +
    'Responses are compact (one row per step); get with step_id, or detail:"full", returns more. ' +
    help('amcp_campaign'),
  amcp_reporting:
    'Use this to analyse metrics captured from native reports: reconciliation, comparisons and recommendations. ' +
    'For saved client reports across platforms, schedules and Sheets exports, use amcp_reporting_overview. ' +
    'Safety: no advertising writes from reporting. A saved plan is an unapproved draft that still needs native review, spending acknowledgement and read-back. Missing metrics stay unknown; attribution windows and completeness remain declared; partial or changed evidence is refused rather than presented as complete. ' +
    'Core actions: capture_presets (guided Google, Meta, LinkedIn, TikTok and Snapchat reports), capture_preset and capture (bounded native reads kept with source hashes), overview_sources and capture_overview, list and get (source-linked metadata pages; get takes row_query and returns an xlsx_path), ' +
    'analyze (pacing, anomaly, fatigue and search-waste recommendations), reconcile_report and reconcile (against a retained or declared reference), combine, scenarios, ' +
    'calibrate_allocation, allocation_candidates, allocation, preview_allocation_plan and create_allocation_plan, search_exclusion_candidates, preview_search_exclusions and create_search_exclusion_plan. ' +
    help('amcp_reporting'),
  amcp_reporting_overview:
    'Use this for saved client reports across platforms and accounts, their schedules and Sheets or retained-file exports; to analyse one captured native report, use amcp_reporting. ' +
    'Safety: no advertising mutations. Sheets exports replace only an AMCP-owned tab and retries never append duplicate rows; destinations, schedules and presentation changes need confirmed:true; missing metrics remain null; GA4 and Search Console are measurement context. ' +
    'Core actions: bootstrap (accounts, metrics, entity levels and saved reports), save, get, list and delete_report (named client reports; edits need expected_revision), save_template, delete_template and delete_view, ' +
    'run (a bounded total, daily, weekly or monthly native report snapshot at campaign, ad-set/ad-group or ad level where qualified), report_pack (snapshot summaries, source evidence and PDF/XLSX download paths), ' +
    'export, export_status, retry and cancel; schedule, preview_schedule, update_schedule, pause_schedule, resume_schedule, remove_schedule (delete_schedule is a legacy pause alias); ' +
    'create_spreadsheet, bind_destination (Google Sheets) and bind_file_destination (encrypted local PDF/XLSX files); save_presentation, presentation_profiles and apply_profile_presentation. ' +
    help('amcp_reporting_overview') +
    ' Guide: amcp://guides/reporting-overview.',
  amcp_media:
    'Use this to put an image or video into an ad account as a reviewed upload: a file uploaded on the AMCP website (source_id; list returns them under sources), a public HTTPS link (source_url), or a public or selected private Google Drive file (drive_url). ' +
    'Safety: the MCP client never downloads bytes; nothing publishes ads or posts; operator role, account write grants and durable idempotency apply; website uploads expire 30 minutes after the upload starts. ' +
    'prepare fetches and encrypts the exact file for a five-minute review (fit_to_platform:true scales or converts it; request.transform says what changed); execute uploads those frozen bytes after explicit confirmation; execute_async and job_status queue and follow it; status reads provider processing; recovery and resume continue an interrupted upload within its original review, never an uncertain part. ' +
    'Other actions: plan (per-account variants), variant, inspect_eligibility (checks a file against a placement before any upload), prepare_library, reuse, cancel, list, library, asset, asset_usage (current Meta, Google and Snapchat references to an uploaded asset, with reference_view), asset_performance, save_asset_metadata, and retain_source and remove_source (workspace owner only). ' +
    'Supports PNG/JPEG and MP4/MOV for Meta, TikTok, Snapchat, Google Ads, LinkedIn, X and DV360. ' +
    help('amcp_media'),
  'amcp_media:read_only':
    'Use this to inspect account-scoped retained media metadata, original-source availability, verified AMCP plan usage and compatible retained ad performance. ' +
    'Actions: list, library, asset, asset_performance and asset_usage (bounded current Meta v26 image/video references, complete Google v25 image asset links with reference_view ad_images, performance_max or performance_max_brand, and the Snapchat snapchat_top_snap view). ' +
    'These reads create no snapshot, plan, ownership or write grant and need no upload write grant. ' +
    'This deployment exposes media reads only; uploading, source retention/removal and metadata changes require their separately enabled workflow. ' +
    help('amcp_media'),
});
/** The routing summary listed for a first-party tool, or undefined when the tool keeps its own description. */
export function routingSummary(name: string, readOnly = false): string | undefined {
  return (readOnly ? routingSummaries[name + ':read_only'] : undefined) ?? routingSummaries[name];
}
/**
 * A captured description that does not fit the budget keeps its leading sentences verbatim and points to the help call
 * that returns it whole; the AMCP note and media instructions that follow it are kept whole.
 */
export function fitCapturedDescription(name: string, captured: string, tail: string[]): string {
  const full = [captured, ...tail].filter(Boolean).join(' ');
  if (full.length <= descriptionBudget) return full;
  const pointer = 'The full captured description is returned by amcp_tool_help {gateway:"' + name + '"}.',
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
/** amcp_tool_help for a first-party tool: the routing summary, the full description and, per action, its detail. */
export function firstPartyHelp(
  tool: {name: string; description: string; inputSchema: JsonObject},
  listed: string,
  operation?: string,
): JsonObject {
  const actions: string[] = tool.inputSchema.properties?.action?.enum ?? [];
  if (operation === undefined)
    return {
      gateway: tool.name,
      mode: 'amcp_workflow',
      selector: actions.length ? 'action' : null,
      summary: listed,
      description: tool.description,
      ...(actions.length
        ? {
            actions,
            operation_help: {tool: 'amcp_tool_help', arguments: {gateway: tool.name, operation: '<action>'}},
          }
        : {}),
      inputSchema: tool.inputSchema,
    };
  const detail = actionDetail(tool.description, actions, operation),
    named = new RegExp('(^|[^A-Za-z0-9_])' + operation + '($|[^A-Za-z0-9_])'),
    argumentsNamed = Object.entries((tool.inputSchema.properties ?? {}) as JsonObject).filter(
      ([key, schema]) => key !== 'action' && typeof schema?.description === 'string' && named.test(schema.description),
    );
  return {
    gateway: tool.name,
    operation,
    detail: detail.length ? detail.join(' ') : null,
    ...(argumentsNamed.length ? {arguments: Object.fromEntries(argumentsNamed)} : {}),
    ...(detail.length
      ? {}
      : {
          meaning:
            'The tool description has no text specific to this action; its arguments are those of the input schema.',
        }),
    call: {tool: tool.name, arguments: {action: operation}},
    see: {tool: 'amcp_tool_help', arguments: {gateway: tool.name}},
  };
}
