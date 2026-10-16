import {pinnedJson} from './pinned-json.js';
import type {JsonObject} from './types.js';

/**
 * Route anchors (ARC-03): what each routed action's method and path rest on. The captured catalog stays the naming
 * compatibility surface (owner decision D17); this separates routing truth from it.
 *   vendor_spec     a method of a pinned vendor document (.mirror/VENDOR, its SHA-256 in `sources`)
 *   sdk_method      a request of a pinned vendor SDK (Meta's Python Business SDK 26.0.2, Apple's Node SDK revision)
 *   documented_url  a vendor documentation page with the date it was read (tools/route-anchor-documents.json)
 *   captured_only   nothing but the frozen captured catalog: the capture page and its recorded digest are named
 *   unanchored      an AMCP mapping no pinned or dated document states, with its reason
 *   no_route        the action has no provider request to anchor
 * Advisory only: an anchor never enables, blocks or reclassifies an action. generated/route-anchors.json is written by
 * `npm run contracts:actions` (tools/route-anchors.ts) and checked by `npm run contracts:actions:check`.
 */
export type AnchorStatus =
  'vendor_spec' | 'sdk_method' | 'documented_url' | 'captured_only' | 'unanchored' | 'no_route' | 'not_recorded';
export interface RouteAnchor {
  /** The anchoring document, SDK or page: a key of `sources` in generated/route-anchors.json. */
  source?: string;
  /** The vendor method or SDK request that states this route. */
  method?: string;
  /** Further methods of the same document that share this method and path shape. */
  alternatives?: number;
  /** The SHA-256 of the SDK file that holds the request. */
  sha256?: string;
  /** When a documented page was read. */
  checked_at?: string;
  /** The capture file the route came from, for a route of the captured catalog. */
  capture?: string;
  /** Why the route is not anchored: a key of routeAnchorReasons. */
  reason?: keyof typeof routeAnchorReasons;
}
export const routeAnchorsFile = 'generated/route-anchors.json';
export const anchoredStatuses: ReadonlySet<AnchorStatus> = new Set(['vendor_spec', 'sdk_method', 'documented_url']);
export const routeAnchorReasons = {
  captured_catalog_only:
    'Its method and path come only from the frozen captured catalog: no pinned vendor document, SDK request or dated documentation page states them yet.',
  sdk_has_no_request:
    "Meta's Python Business SDK 26.0.2 has no request for this route (tests/fixtures/meta-sdk-changes-v26.json), so its method and path come only from the frozen captured catalog.",
  not_in_pinned_document:
    "The gateway's pinned vendor document has no method with this route, so its method and path come only from the captured catalog.",
  independent_mapping_unpinned:
    'An AMCP route mapped from vendor documentation that is not pinned in this repository and has no dated page recorded.',
} as const;
export const routeAnchorMeaning =
  'anchor_status says what the method and path of each action rest on: vendor_spec, sdk_method and documented_url name a pinned vendor document, a pinned SDK request or a dated documentation page; captured_only rests on the frozen captured catalog alone and names its capture file; unanchored gives its reason. A native_read that is not anchored carries the advisory read_unanchored. Anchors are evidence only: they never enable, block or reclassify an action.';
/** The shorter statement a contracts page carries (MCP-01 budgets). */
export const routeAnchorPageMeaning =
  'anchor_status: what each method and path rest on. vendor_spec, sdk_method and documented_url name a pinned vendor document, SDK request or dated page (anchor_sources); captured_only, only the frozen captured catalog (anchor.capture); unanchored, anchor.reason. Evidence only, never permission.';
export const routeAnchorKey = (row: {gateway: string; operation?: string; action: string}) =>
  [row.gateway, row.operation ?? '', row.action].join('/');

interface RouteAnchorsArtifact {
  sources: Record<string, JsonObject>;
  routes: Record<string, {anchor_status: AnchorStatus; anchor?: RouteAnchor}>;
}
const empty: RouteAnchorsArtifact = {sources: {}, routes: {}};
/** The generated anchors; empty only while generated/route-anchors.json is first being generated. */
function artifact(): RouteAnchorsArtifact {
  try {
    return pinnedJson<RouteAnchorsArtifact>('generated/route-anchors.json');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return empty;
    throw error;
  }
}

/** The anchor recorded for a ledger row; `not_recorded` when generated/route-anchors.json is older than the row. */
export function recordedRouteAnchor(row: {
  gateway: string;
  operation?: string;
  action: string;
  method: string | null;
  path: string | null;
}): {anchor_status: AnchorStatus; anchor?: RouteAnchor} {
  if (!row.method || !row.path) return {anchor_status: 'no_route'};
  const record = artifact().routes[routeAnchorKey(row)];
  if (!record) return {anchor_status: 'not_recorded'};
  return record.anchor
    ? {anchor_status: record.anchor_status, anchor: record.anchor}
    : {anchor_status: record.anchor_status};
}
/** The anchoring documents a set of rows names, for a page that shows those rows. */
export function routeAnchorSources(rows: {anchor?: RouteAnchor}[]): Record<string, JsonObject> {
  const sources = artifact().sources,
    named = [...new Set(rows.map(r => r.anchor?.source).filter((s): s is string => !!s))].sort();
  return Object.fromEntries(named.filter(s => sources[s]).map(s => [s, sources[s]!]));
}
/** A native read whose route no pinned or dated vendor artifact states (advisory, ARC-03). */
export const readUnanchored = (row: {status: string; anchor_status?: AnchorStatus}) =>
  row.status === 'native_read' && !!row.anchor_status && !anchoredStatuses.has(row.anchor_status);
