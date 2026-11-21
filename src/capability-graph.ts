import type {Actor, JsonObject} from './types.js';
import type {Registry} from './catalog.js';
import type {Store} from './store.js';
import {actionContractSummary} from './action-contracts.js';
import {gatewayOffered} from './provider-offering.js';
import {campaignRecipes, recipeGateway} from './campaign-recipes.js';
import {normalizeAccount} from './account-id.js';
import {reportPlatforms} from './report-metrics.js';
import {writesPausedFor} from './owner-operations.js';
import {providerJobContracts, reportJobAccounts, reviewedJobFamily} from './provider-jobs.js';

/**
 * Whether this person may create provider report and export jobs, and what blocks them (RPT-06): the deployment owner's
 * switch, the owner's pause, the role, and the account grants a job needs. Local prerequisites only, like the graph.
 */
export function providerJobCapability(
  store: Store,
  actor: Actor,
  allowWrites: boolean,
  providerJobs: boolean,
  gateway?: string,
): JsonObject {
  const families = providerJobContracts.filter(
      j => reviewedJobFamily(j.family) && gatewayOffered(j.gateway) && (!gateway || j.gateway === gateway),
    ),
    // Only the logins and accounts this actor reaches (SEC-08: a client access set limits them).
    connections = store.connectionsFor(actor).filter(c => families.some(f => f.gateway === c.gateway)),
    granted = connections.some(c =>
      providerJobs
        ? reportJobAccounts(store, c).length > 0 ||
          (allowWrites && actor.role !== 'reader' && (c.writeAccounts ?? []).some(a => c.accounts.includes(a)))
        : allowWrites && (c.writeAccounts ?? []).some(a => c.accounts.includes(a)),
    ),
    blockers = [
      ...(!allowWrites && !providerJobs ? ['provider_jobs_disabled'] : []),
      ...(writesPausedFor(store, actor.tenantId, 'provider_jobs') ? ['workspace_jobs_paused'] : []),
      ...(actor.role === 'reader' && !providerJobs ? ['operator_required'] : []),
      ...(!granted ? [providerJobs ? 'report_job_grant_required' : 'account_write_grant_required'] : []),
    ];
  return {
    effect: 'provider_job',
    switch: providerJobs ? 'on' : 'off',
    state: blockers.length ? 'blocked' : 'ready_for_preflight',
    blockers,
    families: families.map(f => ({family: f.family, gateway: f.gateway, kind: f.kind})),
    meaning: providerJobs
      ? 'Report and export jobs create a provider-side processing object and use provider quota; they change no serving configuration or spend. The deployment owner allows them with live writes off: each needs the account’s report-job grant (or an operator’s write grant while writes are on) and a reviewed prepare and execute.'
      : 'Report and export jobs are reviewed writes here: live writes on, an operator role and the account’s write grant. The deployment owner can allow them in a read-only deployment with AMCP_PROVIDER_JOBS=true.',
  };
}
import {mediaPlatforms, mediaPlatformNames, mediaDiscovery} from './media-routing.js';
import {reportPresets} from './report-presets.js';
import {enrichCapabilities} from './capability-eligibility.js';
import {conditionalPrograms, programDiscovery} from './conditional-programs.js';
import {discoveryOnlyListing, discoveryOnlyPrograms} from './discovery-programs.js';
import {bad} from './workspace-core.js';
import {cursorBinding, decodeOffsetCursor, encodeOffsetCursor} from './page-cursor.js';
import {callEffects, withEffects} from './workflow-outcomes.js';

/** Discovery uses the same registries as execution. Local readiness is a prerequisite projection, never a grant
 * or a claim that the current payload, objective or provider account has passed native validation. */
export function capabilityGraph(
  store: Store,
  registry: Registry,
  actor: Actor,
  allowWrites: boolean,
  gateway?: string,
  selection: JsonObject = {},
  providerJobs = false,
) {
  store.assertActorActive(actor);
  const connections = store.connectionsFor(actor);
  // The follow-up of a recipe is the narrowed recipe_context when the call names an account or a login of the recipe's platform, so that following it
  // lists that account and not every client's (package r25-field3-recipes, fix round S4-1); a recipe of another platform keeps the generic call.
  const narrowing = (gateway: string): JsonObject => {
    const login = typeof selection.connection_id === 'string' ? selection.connection_id : undefined,
      account = typeof selection.account_id === 'string' ? selection.account_id : undefined;
    return (login !== undefined || account !== undefined) &&
      connections.some(
        c =>
          c.gateway === gateway &&
          c.enabled &&
          (login === undefined || c.id === login) &&
          (account === undefined ||
            c.accounts.some(a => normalizeAccount(gateway, a) === normalizeAccount(gateway, account))),
      )
      ? {
          ...(login === undefined ? {} : {connection_id: login}),
          ...(account === undefined ? {} : {account_id: account}),
        }
      : {};
  };
  const recipes = campaignRecipes.map(recipe => ({
    id: 'recipe:' + recipe.id,
    kind: 'campaign_recipe',
    name: recipe.name,
    // Its declaring provider's gateway, whose accounts its plan writes to (src/campaign-recipes.ts checks each).
    gateway: recipeGateway(recipe.id)!,
    description: recipe.description,
    required_inputs: recipe.required,
    effects: 'reviewed_provider_writes',
    next_call: {
      tool: 'amcp_campaign',
      arguments: {action: 'recipe_context', recipe: recipe.id, ...narrowing(recipeGateway(recipe.id)!)},
    },
    // The composer opens on this workflow (WEB-06); the person still chooses the account and inputs.
    website_path: '/campaigns?recipe=' + encodeURIComponent(recipe.id) + '#campaign-create',
    source: 'src/campaign-recipes.ts',
  }));
  const reports = Object.entries(reportPlatforms).map(([platform, provider]) => ({
    id: 'report:' + platform,
    kind: 'campaign_report',
    name: provider.name + ' reporting',
    gateway: provider.gateway,
    description: provider.kind + ' context with native metric definitions and source evidence.',
    required_inputs: ['connection_id', 'account_id', 'date_range', 'timezone'],
    effects: 'provider_reads',
    next_call: {tool: 'amcp_reporting_overview', arguments: {action: 'bootstrap'}},
    website_path: '/reporting-overview',
    source: 'src/report-metrics.ts',
  }));
  const media = mediaPlatforms.map(platform => ({
    id: 'media:' + platform,
    kind: 'media_upload',
    name: mediaPlatformNames[platform] + ' media preparation and upload',
    gateway: platform + '_native_action',
    description: 'Inspect the exact source and destination, review, upload and retain account-bound receipts.',
    required_inputs: ['connection_id', 'account_id', 'source_id or source_url', 'source_hash'],
    effects: 'reviewed_provider_writes',
    next_call: {tool: 'amcp_media', arguments: {action: 'list', platform}},
    website_path: '/media',
    limitations: mediaDiscovery(platform + '_native_action')!.limitations,
    source: 'src/media-routing.ts',
  }));
  const captures = reportPresets.map(preset => ({
    id: 'capture:' + preset.id,
    kind: 'report_capture',
    name: preset.name,
    gateway: preset.gateway,
    description: preset.meaning,
    required_inputs: ['connection_id', 'account_id', 'semantics'],
    effects: 'provider_reads',
    next_call: {tool: 'amcp_reporting', arguments: {action: 'capture_presets'}},
    website_path: '/reports#report-capture',
    grain: preset.grain,
    limits: {rows: preset.max_rows, requests: preset.max_requests},
    source: 'src/report-presets.ts',
  }));
  // A pause scoped to provider jobs alone (RPT-06) leaves advertising writes available.
  const paused = writesPausedFor(store, actor.tenantId, 'advertising');
  const graph = {
    version: 1,
    network_requests: 0,
    captured_at: Date.now(),
    workflows: [...recipes, ...reports, ...media, ...captures, ...conditionalPrograms]
      .filter(w => !gateway || w.gateway === gateway)
      .map(workflow => ({
        ...workflow,
        input_state: 'requires_business_inputs',
        live_qualification: 'unverified',
        accounts: connections
          .filter(c => c.gateway === workflow.gateway)
          .flatMap(c =>
            c.accounts.map(account => {
              const blockers = [
                ...(!c.enabled ? ['connection_disabled'] : []),
                ...(workflow.effects === 'reviewed_provider_writes'
                  ? [
                      ...(!allowWrites ? ['deployment_writes_disabled'] : []),
                      ...(paused ? ['workspace_writes_paused'] : []),
                      ...(actor.role === 'reader' ? ['operator_required'] : []),
                      ...(!c.writeAccounts?.includes(account) ? ['account_write_grant_required'] : []),
                    ]
                  : []),
              ];
              return {
                connection_id: c.id,
                account_id: account,
                label: c.label,
                local_state: blockers.length ? 'blocked' : 'ready_for_preflight',
                blockers,
                unresolved:
                  workflow.kind === 'conditional_program'
                    ? [
                        'current_provider_permissions',
                        'conditional_application_access',
                        'exact_program_request',
                        'provider_acceptance',
                      ]
                    : ['current_provider_permissions', 'exact_payload_and_objective', 'provider_acceptance'],
                // With what following it does (MCP-09): live:false makes no request and saves nothing.
                next_call: withEffects(
                  workflow.kind === 'conditional_program'
                    ? {
                        tool: 'amcp_workspace',
                        arguments: {
                          action: 'program_check',
                          workflow_id: workflow.id,
                          connection_id: c.id,
                          account_id: account,
                          live: false,
                        },
                      }
                    : {
                        tool: 'amcp_workspace',
                        arguments: {
                          action: 'check',
                          connection_id: c.id,
                          account_id: account,
                          requirements: {write: workflow.effects === 'reviewed_provider_writes'},
                          live: false,
                        },
                      },
                ),
              };
            }),
          ),
      }))
      .map(programDiscovery),
    // Provider programs AMCP lists but never checks (ACC-05): no account, no next call, zero requests, never a grant.
    discovery_only_programs: discoveryOnlyPrograms
      .filter(p => gatewayOffered(p.gateway) && (!gateway || p.gateway === gateway))
      .map(discoveryOnlyListing),
    // A provider this deployment does not offer is not shown (CON-06, src/provider-offering.ts).
    contracts: actionContractSummary(registry).filter(
      c => gatewayOffered(c.gateway) && (!gateway || c.gateway === gateway),
    ),
    // Provider report and export jobs, their own effect class (RPT-06), with the blockers that apply to this person.
    provider_jobs: providerJobCapability(store, actor, allowWrites, providerJobs, gateway),
    meaning:
      'Workflow discovery is derived from executable recipes, report adapters, capture presets and media routes. Local prerequisites do not authorize a write or establish objective eligibility. Exact native review and account-specific provider evidence remain authoritative.',
  } satisfies JsonObject;
  return enrichCapabilities(store, registry, actor, graph, selection);
}
/** Workflows per summary page by default, and at most (`limit`): a page stays inside an AI client's 10,000-token warning
 * (MCP-01, owner decision D14). A page may hold fewer, when it reaches `capabilitySummaryBytes`. */
export const capabilitySummaryPage = 20,
  capabilitySummaryLimit = 25;
/**
 * The most bytes a summary page's record (`data`) takes, the other half of the page's bound (R2.5 M4a; owner decision D14: "15 KB summary
 * capabilities"). A count only approximates the decision: the guided recipes alone run from 464 to 769 bytes a workflow, and a page of 20 of them
 * was 15,514 bytes once the M4 packs joined. What an MCP client receives is the record plus the envelope its tool call wraps around it, `success` and
 * `meta`, which repeats the `next_call` while a page has more: 703 bytes with more and 467 on the last page, measured through
 * tools/measure-tool-list.mjs on both of its fixtures. 15 KB less 768 keeps the whole `structuredContent` at or under 15 * 1024 bytes, with 65 to
 * spare for a longer `latencyMs`; tests/response-budget.test.mjs holds both fixtures to it.
 */
export const capabilitySummaryBytes = 15 * 1024 - 768;
/**
 * How many consecutive workflows a summary page holds, given the serialized bytes of each from the page's first on (`sizes`): at most `limit`, and as
 * many as keep `fixed` (the record around its list, `[]` included) plus the entries and the comma between two within `budget`. It is never fewer
 * than one while any entry is left, so that paging always progresses: an entry over the budget has a page of its own.
 */
export function capabilityPageLength(sizes: readonly number[], limit: number, fixed: number, budget: number): number {
  let used = fixed,
    count = 0;
  for (const size of sizes) {
    if (count >= limit) break;
    const next = used + size + (count ? 1 : 0);
    if (count && next > budget) break;
    used = next;
    count++;
  }
  return count;
}
/**
 * `amcp_workspace capabilities`. The summary (the default over MCP) is a pure projection of the graph: per workflow its
 * kind, effects, per-account local state with every blocker and the evidence status, what stays unresolved and the
 * next call, a page at a time. It never upgrades an unknown to ready: blockers and unknowns are carried as they are.
 * view:"graph" returns the whole graph, unchanged apart from the effects on its next calls (MCP-09); the website's
 * Capability Center asks for it.
 */
export function capabilities(
  store: Store,
  registry: Registry,
  actor: Actor,
  allowWrites: boolean,
  input: JsonObject,
  graphByDefault = false,
  providerJobs = false,
) {
  const view = input.view ?? (graphByDefault ? 'graph' : 'summary');
  if (view !== 'summary' && view !== 'graph')
    bad('view is "summary" (the default) or "graph".', 'INVALID_ARGUMENT', {field: 'view'});
  if (input.offset !== undefined)
    bad('Continue capabilities with its next_cursor; offset is not accepted here.', 'INVALID_ARGUMENT', {
      field: 'offset',
    });
  if (view === 'graph') {
    for (const key of ['limit', 'cursor'])
      if (input[key] !== undefined)
        bad(
          'limit and cursor page the capabilities summary. view:"graph" returns the whole selected graph; narrow it with workflow_id, connection_id and account_id.',
          'INVALID_ARGUMENT',
          {field: key},
        );
    return capabilityGraph(store, registry, actor, allowWrites, input.gateway, input, providerJobs);
  }
  const limit = input.limit ?? capabilitySummaryPage;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > capabilitySummaryLimit)
    bad('limit is a whole number of workflows from 1 to the maximum in details.max.', 'INVALID_ARGUMENT', {
      field: 'limit',
      max: capabilitySummaryLimit,
    });
  const filters: JsonObject = Object.fromEntries(
    (['gateway', 'workflow_id', 'connection_id', 'account_id'] as const)
      .filter(key => input[key] !== undefined)
      .map(key => [key, input[key]]),
  );
  const binding = cursorBinding(store, actor, {action: 'capabilities', view, limit, ...filters}),
    offset = decodeOffsetCursor(input.cursor, binding, 'capabilities summary'),
    graph = capabilityGraph(store, registry, actor, allowWrites, input.gateway, input, providerJobs) as JsonObject,
    all: JsonObject[] = graph.workflows,
    accountCalls =
      (typeof input.connection_id === 'string' && typeof input.account_id === 'string') ||
      typeof input.workflow_id === 'string',
    pairs = all.flatMap(w => w.accounts as JsonObject[]);
  const summarize = (w: JsonObject) => ({
    id: w.id,
    kind: w.kind,
    name: w.name,
    gateway: w.gateway,
    objective: w.objective,
    effects: w.effects,
    live_qualification: w.live_qualification,
    accounts: (w.accounts as JsonObject[]).map(a => ({
      connection_id: a.connection_id,
      account_id: a.account_id,
      // The account-metadata resolver's name and its source (CON-05), only when one is known, to keep pages small.
      ...(a.name ? {name: a.name, name_source: a.metadata?.name_source ?? a.metadata?.source} : {}),
      state: a.local_state,
      blockers: a.blockers,
      account_evidence: a.provider_evidence?.status ?? 'missing',
      // A conditional program's evidence (CON-04): unverified, with its last retained read, never a grant.
      ...(a.program_evidence
        ? {
            program_evidence: {
              status: a.program_evidence.status,
              ...(a.program_evidence.member_account_access
                ? {member_account_access: a.program_evidence.member_account_access}
                : {}),
              ...(a.program_evidence.last_observation
                ? {
                    last_observation: {
                      state: a.program_evidence.last_observation.state,
                      code: a.program_evidence.last_observation.code ?? null,
                      checked_at: a.program_evidence.last_observation.checked_at,
                      expires_at: a.program_evidence.last_observation.expires_at,
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(accountCalls ? {next_call: a.next_call} : {}),
    })),
    unresolved: w.accounts.length
      ? [...new Set((w.accounts as JsonObject[]).flatMap(a => a.unresolved as string[]))]
      : ((w.dependencies ?? []) as JsonObject[]).map(d => d.id),
    next_call: w.next_call,
    // A program with no selected account names its setup path instead of a program_check that can only refuse (CON-04).
    ...(w.setup ? {setup: w.setup} : {}),
  });
  // The record of one page: `end` is the offset its cursor continues from, `first` the workflow its detail call names. With no workflows it is
  // what every page carries around them.
  const record = (workflows: JsonObject[], more: boolean, first: unknown, end: number) => ({
    record_kind: 'capability_summary',
    view: 'summary',
    version: graph.version,
    network_requests: 0,
    captured_at: graph.captured_at,
    evidence_lifetime_ms: graph.evidence_lifetime_ms,
    selection: graph.selection,
    ...(filters.gateway !== undefined ? {gateway: filters.gateway} : {}),
    total: all.length,
    returned: workflows.length,
    limit,
    has_more: more,
    next_cursor: more ? encodeOffsetCursor(binding, end) : null,
    ...(more
      ? {
          next_call: {
            tool: 'amcp_workspace',
            arguments: {
              action: 'capabilities',
              ...filters,
              limit,
              cursor: encodeOffsetCursor(binding, end),
            },
          },
        }
      : {}),
    account_states: {
      ready_for_preflight: pairs.filter(a => a.local_state === 'ready_for_preflight').length,
      blocked: pairs.filter(a => a.local_state === 'blocked').length,
    },
    workflows,
    // RPT-06: whether report and export jobs are available to this person, and what blocks them.
    provider_jobs: {
      switch: graph.provider_jobs.switch,
      state: graph.provider_jobs.state,
      blockers: graph.provider_jobs.blockers,
    },
    // Discovery-only programs by ID (ACC-05): view:"graph" lists their prerequisites; none is ever checked.
    discovery_only_programs: ((graph.discovery_only_programs ?? []) as JsonObject[]).map(p => p.id),
    ...(accountCalls
      ? {}
      : {
          account_next_call: {
            tool: 'amcp_workspace',
            check: {
              action: 'check',
              requirements: {write: '<true when effects is reviewed_provider_writes>'},
              live: false,
            },
            program_check: {action: 'program_check', workflow_id: '<the conditional_program id>', live: false},
            effects: {
              check: callEffects({tool: 'amcp_workspace', arguments: {action: 'check', live: false}}),
              program_check: callEffects({tool: 'amcp_workspace', arguments: {action: 'program_check', live: false}}),
            },
            add_from_account: ['connection_id', 'account_id'],
            meaning:
              'The next call for one listed account: program_check for a conditional_program, otherwise check. Filtering by workflow_id, or by connection_id and account_id, returns it filled in on every account.',
          },
        }),
    detail_call: {
      tool: 'amcp_workspace',
      arguments: {action: 'capabilities', view: 'graph', workflow_id: first ?? null},
      meaning: 'The whole graph of one workflow: dependencies, native contracts, lifecycle and per-account evidence.',
    },
    contracts_call: {
      tool: 'amcp_workspace',
      arguments: {action: 'contracts', ...(filters.gateway ? {gateway: filters.gateway} : {})},
    },
    meaning:
      'A summary of the capability graph. ready_for_preflight means only that local prerequisites are present; every listed blocker and unresolved item still applies, and exact native review and account-specific provider evidence remain authoritative. Workflows without accounts have no matching configured account.',
  });
  // The page holds at most `limit` workflows and ends where its record would pass the byte budget (owner decision D14), with at least one so that the
  // cursor always moves on. The last page carries no cursor or next call, so it is the smaller record: when everything left fits it, it is the last
  // page. The record around the list is sized for the larger cursor (the last offset), so a page never grows past the budget by a longer number.
  const candidates = all.slice(offset, offset + limit).map(summarize),
    sizes = candidates.map(c => Buffer.byteLength(JSON.stringify(c))),
    first = candidates[0]?.id,
    around = (more: boolean) => Buffer.byteLength(JSON.stringify(record([], more, first, all.length)));
  let length = capabilityPageLength(sizes, limit, around(false), capabilitySummaryBytes);
  if (offset + length < all.length) length = capabilityPageLength(sizes, limit, around(true), capabilitySummaryBytes);
  return record(candidates.slice(0, length), offset + length < all.length, first, offset + length);
}
