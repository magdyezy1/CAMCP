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
import {conditionalPrograms} from './conditional-programs.js';

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
                next_call:
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
              };
            }),
          ),
      })),
    contracts: actionContractSummary(registry).filter(c => !gateway || c.gateway === gateway),
    meaning:
      'Workflow discovery is derived from executable recipes, report adapters, capture presets and media routes. Local prerequisites do not authorize a write or establish objective eligibility. Exact native review and account-specific provider evidence remain authoritative.',
  } satisfies JsonObject;
  return enrichCapabilities(store, registry, actor, graph, selection);
}
