import {refusedParameters} from './parameters.js';
import {unavailableOperations} from './unavailable-operations.js';
import {providerHooks, registeredProviderHooks} from './provider-hooks.js';
import type {ToolNotes} from './provider-adapter.js';
import type {ToolDefinition} from './types.js';

const named =
  'For a launch use amcp_campaign, for one reviewed change amcp_write, for uploads amcp_media and for performance amcp_reporting.';
/** The same routing for a read-only deployment, which lists amcp_write with inspect only and amcp_media reads only. */
const readOnlyNamed =
  'For performance use amcp_reporting; amcp_write inspect checks whether a change has a reviewed write contract.';
const connectedOnWebsite = 'Providers are connected on the AMCP website (Connections).';
/** The gateways whose adapter's tool notes (ToolNotes, src/<provider>-adapter.ts) say so, in name order. */
const noted = (flag: 'withoutExecutableActions' | 'delegatedWrites'): ReadonlySet<string> =>
  new Set(
    registeredProviderHooks
      .filter(hooks => hooks.notes?.[flag])
      .map(hooks => hooks.gateway)
      .sort(),
  );
/** Gateways whose catalog holds no action AMCP can run; tests hold this equal to the contracts ledger. */
export const withoutExecutableActions: ReadonlySet<string> = noted('withoutExecutableActions');
/**
 * Operation-mode gateways whose catalog has write actions (reviewed or blocked): like the action-mode gateways, they
 * preview or refuse a write and name amcp_write inspect as its next call (MCP-09), and their listing now says so.
 * tests/truthful-surface.test.mjs holds this equal to the contracts ledger.
 */
export const delegatedWriteGateways: ReadonlySet<string> = noted('delegatedWrites');
/** A gateway's tool notes, as its provider's adapter declares them (wave 4c round 6, w4c-arc6-versions). */
const toolNotes = (gateway: string): ToolNotes | undefined => providerHooks(gateway)?.notes;
/**
 * A provider's own description of its gateway (its tool notes), ended with the AMCP sentences the notes ask for: the
 * routing of changes, uploads and performance, and where providers are connected.
 */
function providerDescription(gateway: string, captured: string): string | undefined {
  const notes = toolNotes(gateway),
    own = notes?.description;
  if (own === undefined) return undefined;
  return [
    typeof own === 'function' ? own(captured) : own,
    ...(notes!.routing ? [named] : []),
    ...(notes!.connectedOnWebsite ? [connectedOnWebsite] : []),
  ].join(' ');
}
/**
 * AMCP-owned descriptions (MCP-10). Where a captured gateway description names a tool, provider, version or behaviour
 * AMCP does not have, AMCP's own text replaces it; the captured text stays available under captured_catalog in gateway
 * help, and the listed schemas stay byte-identical (owner decision D17). These are AMCP's own tools; a provider's
 * gateway has its description in its adapter's tool notes, where a function corrects named sentences of a long
 * captured description and keeps the rest.
 */
const ownedDescriptions: Readonly<Record<string, string>> = {
  amcp_native_action:
    'Shared AMCP workflows for Google Ads, LinkedIn, X and DV360 (Meta, TikTok and Snapchat use their own gateways): workspace context and accounts, entity reads and previewed changes (amcp_write makes them), audits, audience estimates, reporting queries, schedules, runs and exports, the Meta Ad Library and existing Meta posts, and media imports.',
  // Wave 4b MCP quality pass: the captured texts only named a "gateway" and "native operations".
  amcp_platform_workspace:
    'The workspace and its connected accounts from AMCP’s own records, with no provider request: get_workspace_context (the workspace, your role, each enabled connection), list_accounts (each bound account with its platform, connection, write grant and the name, currency and time zone of its last live read) and list_workspace_assets. Pass the operation’s input in arguments.',
};
/**
 * What tools/list shows of a gateway before its note: the routing summary of a gateway whose whole description is long
 * (its tool notes' summary, MCP-10; amcp_tool_help {gateway} returns the whole text), or the description itself. A
 * read-only deployment routes to what it lists (wave 4b MCP quality pass: it named amcp_write and amcp_media as change
 * paths).
 */
export const listedDescription = (tool: ToolDefinition, readOnly = false): string => {
  const text = toolNotes(tool.name)?.summary ?? ownedDescription(tool);
  return readOnly ? text.replace(named, readOnlyNamed) : text;
};
/** Said where a read-only deployment's description still names amcp_write as a change path (owner decision D15). */
export const readOnlyQualifier =
  'In this read-only deployment amcp_write offers inspect only, so the changes named here are refused.';
/** The same where the owner allows provider report and export jobs (RPT-06): those are the only changes it makes. */
export const providerJobQualifier =
  'In this read-only deployment amcp_write prepares and executes provider report and export jobs only; other changes named here are refused.';
/** The sentence a read-only deployment adds after a gateway's description: the qualifier, where it applies. */
export const readOnlyTail = (description: string, providerJobs = false): string =>
  description.replaceAll('amcp_write inspect', '').includes('amcp_write')
    ? providerJobs
      ? providerJobQualifier
      : readOnlyQualifier
    : '';
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
  const text = ownedDescriptions[tool.name] ?? providerDescription(tool.name, captured) ?? captured,
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
  if (tool.mode === 'delegated' && delegatedWriteGateways.has(tool.name))
    notes.push(
      'Nothing is written from this tool: a write action is previewed, or with dry_run:false refused with amcp_write inspect as its next_call.',
    );
  const refused = properties.filter(k => refusedParameters.includes(k));
  if (refused.length)
    notes.push(
      (refused.length > 1 ? refused.slice(0, -1).join(', ') + ' and ' + refused.at(-1) + ' are' : refused[0] + ' is') +
        ' refused unless false.',
    );
  // The version its adapter states (Google Ads': the version sent, where the recorded action names spell another).
  const version = toolNotes(tool.name)?.version;
  if (version) notes.push(version);
  return notes.length ? 'AMCP note: ' + notes.join(' ') : undefined;
}
/**
 * The media sentence tools/list carries for a media gateway (MCP-10): where files go, in a few words. Gateway help keeps
 * the whole import route (amcp_media_import), so the listing no longer repeats it on every gateway.
 */
export const mediaListing = (gateway: string, readOnly = false) =>
  readOnly
    ? 'Media: never download media in the MCP client; this deployment uploads nothing (amcp_media offers library reads only).'
    : 'Media: never download media in the MCP client; upload through amcp_media or ' +
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
