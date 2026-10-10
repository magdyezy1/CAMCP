import type {Actor, JsonObject} from './types.js';
import type {Registry} from './catalog.js';
import type {Store} from './store.js';
import {actionContractSummary} from './action-contracts.js';
import {campaignRecipes} from './campaign-recipes.js';
import {reportPlatforms} from './report-metrics.js';
import {writePause} from './owner-operations.js';
import {mediaPlatforms, mediaPlatformNames, mediaDiscovery} from './media-routing.js';
import {reportPresets} from './report-presets.js';
import {enrichCapabilities} from './capability-eligibility.js';
import {conditionalPrograms, programDiscovery} from './conditional-programs.js';
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
) {
  store.assertActorActive(actor);
  const gateways: Record<string, string> = {
    google: 'google_ads_native_action',
    microsoft: 'microsoft_ads_native_action',
  };
  const recipes = campaignRecipes.map(recipe => ({
    id: 'recipe:' + recipe.id,
    kind: 'campaign_recipe',
    name: recipe.name,
    gateway: gateways[recipe.platform] ?? recipe.platform + '_native_action',
    description: recipe.description,
    required_inputs: recipe.required,
    effects: 'reviewed_provider_writes',
    next_call: {tool: 'amcp_campaign', arguments: {action: 'recipe_context', recipe: recipe.id}},
    website_path: '/campaigns#campaign-create',
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
  const paused = !!writePause(store, actor.tenantId);
  const connections = store.listConnections(actor.tenantId);
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
    contracts: actionContractSummary(registry).filter(c => !gateway || c.gateway === gateway),
    meaning:
      'Workflow discovery is derived from executable recipes, report adapters, capture presets and media routes. Local prerequisites do not authorize a write or establish objective eligibility. Exact native review and account-specific provider evidence remain authoritative.',
  } satisfies JsonObject;
  return enrichCapabilities(store, registry, actor, graph, selection);
}
/** Workflows per summary page by default, and at most: a page stays inside an AI client's 10,000-token warning
 * (MCP-01, owner decision D14). */
export const capabilitySummaryPage = 20,
  capabilitySummaryLimit = 25;
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
    return capabilityGraph(store, registry, actor, allowWrites, input.gateway, input);
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
    graph = capabilityGraph(store, registry, actor, allowWrites, input.gateway, input) as JsonObject,
    all: JsonObject[] = graph.workflows,
    page = all.slice(offset, offset + limit),
    accountCalls =
      (typeof input.connection_id === 'string' && typeof input.account_id === 'string') ||
      typeof input.workflow_id === 'string',
    pairs = all.flatMap(w => w.accounts as JsonObject[]),
    more = offset + page.length < all.length;
  const workflows = page.map(w => ({
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
  }));
  return {
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
    next_cursor: more ? encodeOffsetCursor(binding, offset + page.length) : null,
    ...(more
      ? {
          next_call: {
            tool: 'amcp_workspace',
            arguments: {
              action: 'capabilities',
              ...filters,
              limit,
              cursor: encodeOffsetCursor(binding, offset + page.length),
            },
          },
        }
      : {}),
    account_states: {
      ready_for_preflight: pairs.filter(a => a.local_state === 'ready_for_preflight').length,
      blocked: pairs.filter(a => a.local_state === 'blocked').length,
    },
    workflows,
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
      arguments: {action: 'capabilities', view: 'graph', workflow_id: workflows[0]?.id ?? null},
      meaning: 'The whole graph of one workflow: dependencies, native contracts, lifecycle and per-account evidence.',
    },
    contracts_call: {
      tool: 'amcp_workspace',
      arguments: {action: 'contracts', ...(filters.gateway ? {gateway: filters.gateway} : {})},
    },
    meaning:
      'A summary of the capability graph. ready_for_preflight means only that local prerequisites are present; every listed blocker and unresolved item still applies, and exact native review and account-specific provider evidence remain authoritative. Workflows without accounts have no matching configured account.',
  };
}
