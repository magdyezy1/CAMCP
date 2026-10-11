import {refusedParameters} from './parameters.js';
import {googleAdsVersion} from './google-version.js';
import {unavailableOperations} from './unavailable-operations.js';
import type {ToolDefinition} from './types.js';

const named =
  'For a launch use amcp_campaign, for one reviewed change amcp_write, for uploads amcp_media and for performance amcp_reporting.';
const connectedOnWebsite = 'Providers are connected on the AMCP website (Connections).';
/** Gateways whose catalog holds no action AMCP can run; tests hold this equal to the contracts ledger. */
export const withoutExecutableActions: ReadonlySet<string> = new Set(['amazon_native_action']);
/**
 * AMCP-owned descriptions (MCP-10). Where a captured gateway description names a tool, provider, version or behaviour
 * AMCP does not have, AMCP's own text replaces it; the captured text stays available under captured_catalog in gateway
 * help, and the listed schemas stay byte-identical (owner decision D17). A function corrects named sentences of a
 * long captured description and keeps the rest.
 */
const ownedDescriptions: Readonly<Record<string, string | ((captured: string) => string)>> = {
  meta_native_action:
    'Run one Meta Graph Marketing API action by name; LIST_ACTIONS and DESCRIBE_ACTION find it. ' + named,
  tiktok_native_action:
    'Run one TikTok Business API action by name; LIST_ACTIONS and DESCRIBE_ACTION find it. ' + named,
  snapchat_native_action:
    'Run one Snapchat Marketing API action by name; LIST_ACTIONS and DESCRIBE_ACTION find it. ' + named,
  amazon_native_action:
    'Amazon Ads gateway, listed for compatibility with the captured catalog: AMCP has no executable Amazon Ads action yet. Its catalog is empty, so every call is refused and nothing reaches Amazon.',
  apple_ads_native_action:
    'Run one Apple Ads Platform API v1 action by name (names begin apple_ads_v1_; amcp_tool_help {gateway:"apple_ads_native_action"} lists them). Legacy Campaign Management API v5 routes are unavailable. Reads support result projection and bounded pagination.',
  dv360_native_action: captured =>
    captured
      .replace('with create_campaign or DV360_', 'with amcp_native_action create_campaign or DV360_')
      .replace(
        'create display/video/audio/Demand Gen or explicit YouTube & Partners line items with create_adset or DV360_',
        'create display/video/audio/Demand Gen line items with amcp_native_action create_adset or DV360_',
      )
      .replace(
        /For YouTube & Partners line item writes, provide the exact lineItemType and bidStrategy\.youtubeAndPartnersBid\. Existing DV360 accounts can return YouTube & Partners line items through read\/list, so MCP does not locally block explicit payloads; Google remains the final authority for account\/type-specific write support\./,
        'YouTube & Partners line items cannot be created or updated through the API, so AMCP refuses those writes; reads still return them.',
      )
      .replace('or the semantic create_creative tool,', 'or amcp_native_action create_creative,')
      .replace(
        /For Bid Manager reports, standard report runs, query runs, report retrieval, or report listing, use dv360_reporting_ops instead of this generic REST tool\./,
        'AMCP has no DV360 reporting: Bid Manager reports, query runs and report retrieval are not available.',
      )
      .replace(/ ?Write actions default to dry_run: true and require confirmed: true when dry_run is false\./, ''),
  amcp_native_action:
    'Shared AMCP workflows for Google Ads, LinkedIn, X and DV360 (Meta, TikTok and Snapchat use their own gateways): workspace context and accounts, entity reads and previewed changes (amcp_write makes them), audits, audience estimates, reporting queries, schedules, runs and exports, the Meta Ad Library and existing Meta posts, and media imports.',
  ga4_native_action:
    'Google Analytics 4 gateway for properties, metadata, reports, asynchronous report tasks and audience exports. ' +
    connectedOnWebsite,
  google_search_console_native_action:
    'Google Search Console gateway for sites, sitemaps, URL inspection and search analytics. ' + connectedOnWebsite,
  google_business_native_action:
    'Google Business Profile gateway for accounts, locations, catalogs, verification, engagement, performance, notifications and lodging. ' +
    connectedOnWebsite,
  adjust_native_action:
    'Adjust gateway: adjust_reporting (apps, events, filters, reports and pivots) and adjust_list_assets (the Adjust bindings configured in AMCP) run.',
  commerce_native_action:
    'Commerce gateway: woocommerce_list_stores lists the WooCommerce stores configured in AMCP, without a store request; store products are read through amcp_workspace catalog_sources and catalog_source. Shopify and Salla have no AMCP connection, and Shopify, Salla and WooCommerce expansion is parked.',
};
/**
 * What tools/list shows of a gateway whose whole description is long (MCP-10): a routing summary; amcp_tool_help
 * {gateway} returns the whole text.
 */
const listedSummaries: Readonly<Record<string, string>> = {
  dv360_native_action:
    'Run one Display & Video 360 v4 REST action by name: a canonical DV360_* action such as DV360_ADVERTISERS_LIST, or resource and method (resource=advertisers, method=list); LIST_ACTIONS and DESCRIBE_ACTION find it. Path and query parameters go in params, pathParams or query, request bodies in body or payload. YouTube & Partners line items cannot be created or updated through the API, so AMCP refuses those writes, and AMCP has no DV360 reporting. The campaign flow, targeting and audience search, inventory and creative assignment: amcp_tool_help {gateway:"dv360_native_action"}.',
};
/** What tools/list shows of a gateway before its note: a routing summary, or the description itself. */
export const listedDescription = (tool: ToolDefinition): string => listedSummaries[tool.name] ?? ownedDescription(tool);
/** The sentence naming what a gateway lists but AMCP cannot run, from the table the contracts ledger holds (MCP-10). */
export function unavailableSentence(gateway: string): string | undefined {
  const entries = Object.entries(unavailableOperations[gateway] ?? {});
  if (!entries.length) return undefined;
  const names = entries.map(([operation, entry]) =>
      entry.actions ? operation + ' ' + entry.actions.join(', ') : operation,
    ),
    list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names.at(-1) : names[0];
  return (
    'Listed for catalog compatibility but not run by AMCP (refused with ' +
    (gateway === 'amcp_native_action' ? 'WORKFLOW_UNSUPPORTED' : 'CAPABILITY_UNAVAILABLE') +
    '; details.alternatives names what to use): ' +
    list +
    '.'
  );
}
/** A gateway's AMCP-owned description, or its captured one where that is accurate. */
export function ownedDescription(tool: ToolDefinition, captured = tool.description ?? ''): string {
  const owned = ownedDescriptions[tool.name],
    text = typeof owned === 'function' ? owned(captured) : (owned ?? captured),
    unavailable = unavailableSentence(tool.name);
  return unavailable ? text + ' ' + unavailable : text;
}
/** Whether AMCP replaced or corrected the captured description of this gateway. */
export const describesOwnText = (tool: ToolDefinition, captured = tool.description ?? '') =>
  ownedDescription(tool, captured) !== captured;
/**
 * An "AMCP note" after a gateway's description: what AMCP does with the gateway's write and refused parameters, and the
 * version it sends where the captured action names another. The listed schemas are unchanged: validation and the
 * parity tests read the captured ones, and a refused parameter still answers with its own reason.
 */
export function amcpNote(tool: ToolDefinition): string | undefined {
  // A gateway with no executable action has nothing to note: its description says every call is refused.
  if (withoutExecutableActions.has(tool.name)) return undefined;
  const properties = Object.keys(tool.inputSchema?.properties ?? {}),
    notes: string[] = [];
  if (tool.mode === 'direct' && properties.includes('dry_run'))
    notes.push(
      'Nothing is written from this tool: writes are previews (dry_run:false, a refusal whose next_call is amcp_write inspect).',
    );
  const refused = properties.filter(k => refusedParameters.includes(k));
  if (refused.length)
    notes.push(
      (refused.length > 1 ? refused.slice(0, -1).join(', ') + ' and ' + refused.at(-1) + ' are' : refused[0] + ' is') +
        ' refused unless false.',
    );
  if (tool.name === 'google_ads_native_action')
    notes.push(
      'Requests go to Google Ads API ' +
        googleAdsVersion +
        '; action names keep their recorded google_ads_v23_ spelling.',
    );
  return notes.length ? 'AMCP note: ' + notes.join(' ') : undefined;
}
/**
 * The media sentence tools/list carries for a media gateway (MCP-10): where files go, in a few words. Gateway help keeps
 * the whole import route (amcp_media_import), so the listing no longer repeats it on every gateway.
 */
export const mediaListing = (gateway: string) =>
  'Media: never download media in the MCP client; upload through amcp_media or ' +
  (gateway === 'amcp_native_action' ? 'platform_media_upload UPLOAD_FROM_URL' : 'payload.url on an upload action') +
  ' (import route: amcp_tool_help {gateway:"' +
  gateway +
  '"}).';
/** The description a caller is shown: AMCP's own (or the accurate captured) text, then its AMCP note. */
export const describedTool = (tool: ToolDefinition, captured = tool.description ?? ''): string => {
  const note = amcpNote(tool),
    text = ownedDescription(tool, captured);
  return note ? text + ' ' + note : text;
};
