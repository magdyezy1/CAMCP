import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

/** A call AMCP offers instead of an operation it cannot run, or the website page where that work is done. */
export type Alternative =
  {tool: string; arguments: JsonObject; meaning: string} | {website_path: string; meaning: string};
export interface UnavailableOperation {
  /** The operation's actions that cannot run; absent when none of them can. */
  actions?: string[];
  reason: string;
  alternatives: Alternative[];
}
const connections: Alternative = {
  website_path: '/connections',
  meaning: 'Connect, reconnect or disconnect the provider on the Connections page of the AMCP website.',
};
const adjust: Alternative[] = [
  {
    tool: 'adjust_native_action',
    arguments: {operation: 'adjust_reporting'},
    meaning: 'Adjust apps, events, filters, reports and pivots: the Adjust reads AMCP runs.',
  },
  {
    tool: 'adjust_native_action',
    arguments: {operation: 'adjust_list_assets'},
    meaning: 'The Adjust connections and app bindings configured in AMCP.',
  },
];
/** The OAuth steps of a connection operation; its status, sync and disconnect actions run. */
const connectionOps = (gateway: string, operation: string, provider: string): UnavailableOperation => ({
  actions: ['start', 'exchange', 'refresh'],
  reason: provider + ' is connected through the AMCP website, not through a tool call.',
  alternatives: [
    connections,
    {
      tool: gateway,
      arguments: {operation, arguments: {action: 'status'}},
      meaning: 'The recorded state of this provider’s connections; the operation’s status, sync and disconnect run.',
    },
  ],
});
/**
 * Captured operations AMCP lists for compatibility with the captured catalog but cannot run (owner decision D17: they
 * are annotated, not hidden). The contracts ledger classifies each one as unmapped, and
 * tests/truthful-surface.test.mjs holds this table equal to the ledger, so the descriptions, help and refusals
 * built from it name exactly the operations that cannot run (MCP-10).
 */
export const unavailableOperations: Readonly<Record<string, Readonly<Record<string, UnavailableOperation>>>> = {
  amcp_native_action: {
    connect_google_reporting: {
      reason: 'Google is connected on the AMCP website; reporting reads use that connection.',
      alternatives: [
        connections,
        {
          tool: 'amcp_reporting_overview',
          arguments: {action: 'bootstrap'},
          meaning: 'The accounts, metrics and saved reports the connected providers offer.',
        },
      ],
    },
    disconnect_google_reporting: {
      reason: 'Google is disconnected on the AMCP website.',
      alternatives: [connections],
    },
    cross_platform_transfer: {
      reason: 'AMCP does not translate a campaign from one platform to another.',
      alternatives: [
        {
          tool: 'amcp_campaign',
          arguments: {action: 'recipes'},
          meaning: 'Build the campaign for the target platform from a recipe, as a reviewed plan.',
        },
        {
          tool: 'amcp_campaign',
          arguments: {action: 'clone'},
          meaning:
            'Copy an existing Snapchat, Google Search, TikTok or LinkedIn campaign into a paused draft on the same platform.',
        },
      ],
    },
    download_creative_asset: {
      reason: 'AMCP never hands media bytes to the MCP client.',
      alternatives: [
        {
          tool: 'amcp_media',
          arguments: {action: 'library'},
          meaning: 'The media uploaded through AMCP, with its metadata and native IDs.',
        },
      ],
    },
    generate_ad_content: {
      reason: 'AMCP does not generate ad copy.',
      alternatives: [
        {
          tool: 'amcp_write',
          arguments: {action: 'inspect'},
          meaning: 'Check copy you wrote against the review contract of the change that will carry it.',
        },
      ],
    },
    generate_creative_design: {
      reason: 'AMCP does not generate images or videos.',
      alternatives: [
        {
          tool: 'amcp_media',
          arguments: {action: 'prepare'},
          meaning: 'Upload a finished image or video as a reviewed upload.',
        },
      ],
    },
    get_creative_payload: {
      reason: 'AMCP has no creative payload builder.',
      alternatives: [
        {
          tool: 'amcp_native_action',
          arguments: {operation: 'fetch_creatives'},
          meaning: 'Read the creatives of an account.',
        },
        {
          tool: 'amcp_ad_previews',
          arguments: {},
          meaning: 'Preview existing ads.',
        },
      ],
    },
    openai_ads_ops: {
      reason: 'AMCP has no OpenAI Ads connection.',
      alternatives: [],
    },
    suggest_targeting: {
      reason: 'AMCP does not suggest targeting.',
      alternatives: [
        {
          tool: 'amcp_native_action',
          arguments: {operation: 'estimate_audience_size'},
          meaning: 'Estimate the size of a targeting you choose.',
        },
      ],
    },
  },
  adjust_native_action: {
    adjust_ad_spend: {reason: 'AMCP sends no ad spend to Adjust.', alternatives: adjust},
    adjust_app_automation: {reason: 'AMCP does not manage Adjust apps or app secrets.', alternatives: adjust},
    adjust_campaign_api: {reason: 'AMCP does not read or change Adjust trackers or partners.', alternatives: adjust},
    adjust_deeplinks: {reason: 'AMCP does not read or create Adjust deep links.', alternatives: adjust},
  },
  commerce_native_action: {
    woocommerce_store_ops: {
      reason:
        'AMCP reads WooCommerce products only as catalog sources; store reports, orders and customers are not read. Shopify and Salla have no connection, and WooCommerce expansion is parked.',
      alternatives: [
        {
          tool: 'amcp_workspace',
          arguments: {action: 'catalog_sources'},
          meaning: 'The WooCommerce stores configured as catalog sources.',
        },
        {
          tool: 'amcp_workspace',
          arguments: {action: 'catalog_source'},
          meaning: 'Read the products of one configured store.',
        },
      ],
    },
  },
  ga4_native_action: {ga4_connection_ops: connectionOps('ga4_native_action', 'ga4_connection_ops', 'Google Analytics')},
  google_search_console_native_action: {
    gsc_connection_ops: connectionOps('google_search_console_native_action', 'gsc_connection_ops', 'Search Console'),
  },
  google_business_native_action: {
    gmb_connection_ops: connectionOps('google_business_native_action', 'gmb_connection_ops', 'Business Profile'),
    gmb_engagement_ops: {
      actions: ['LEGACY_V4_REQUEST'],
      reason: 'AMCP sends no request to the retired Business Profile v4 API.',
      alternatives: [
        {
          tool: 'google_business_native_action',
          arguments: {operation: 'gmb_engagement_ops', arguments: {action: 'LIST_PLACE_ACTION_LINKS'}},
          meaning: 'The place-action links of a location; the other actions of this operation run.',
        },
      ],
    },
  },
};
/** The unavailable entry for this call, when the operation (or its action) cannot run. */
export function unavailableOperation(gateway: string, operation: unknown, action?: unknown) {
  if (typeof operation !== 'string') return undefined;
  const entry = unavailableOperations[gateway]?.[operation];
  if (!entry || (entry.actions && !(typeof action === 'string' && entry.actions.includes(action)))) return undefined;
  return entry;
}
/** Operations of a gateway none of whose actions run, for its description. */
export const unavailableOperationNames = (gateway: string) =>
  Object.entries(unavailableOperations[gateway] ?? {})
    .filter(([, entry]) => !entry.actions)
    .map(([operation]) => operation);
/**
 * The refusal of a call to an operation AMCP cannot run, before its arguments are checked: correcting them would not
 * help. amcp_native_action keeps its WORKFLOW_UNSUPPORTED code; the other gateways answer CAPABILITY_UNAVAILABLE.
 * Nothing is sent to a provider.
 */
export function unavailableRefusal(gateway: string, input: JsonObject): MirrorError | undefined {
  const action = input.arguments && typeof input.arguments === 'object' ? input.arguments.action : undefined,
    entry = unavailableOperation(gateway, input.operation, action);
  if (!entry) return undefined;
  const name = String(input.operation) + (entry.actions ? ' ' + String(action) : '');
  return new MirrorError(
    gateway === 'amcp_native_action' ? 'WORKFLOW_UNSUPPORTED' : 'CAPABILITY_UNAVAILABLE',
    name + ' is listed for compatibility with the captured catalog, but AMCP cannot run it. ' + entry.reason,
    {
      gateway,
      operation: input.operation,
      ...(entry.actions ? {action} : {}),
      status: 'unmapped',
      alternatives: structuredClone(entry.alternatives),
      submission: 'not_sent',
    },
  );
}
