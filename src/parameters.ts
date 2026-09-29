import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {Action, JsonObject} from './types.js';

export const accountAliases: Record<string, string[]> = {
  meta_native_action: ['ad_account_id', 'account_id'],
  tiktok_native_action: ['advertiser_id', 'account_id'],
  snapchat_native_action: ['ad_account_id', 'account_id'],
  google_ads_native_action: ['account_id', 'customer_id'],
  linkedin_native_action: ['account_id', 'ad_account_id'],
  x_ads_native_action: ['account_id'],
  amazon_native_action: ['profile_id'],
  apple_ads_native_action: ['account_id', 'ad_account_id', 'org_id'],
  dv360_native_action: ['advertiserId'],
};
const controls = new Set([
  'action',
  'params',
  'path_params',
  'pathParams',
  'query',
  'payload',
  'body',
  'connection_id',
  'connectionId',
  'aggregate_pages',
  'max_pages',
  'paginate',
  'allPages',
  'dry_run',
  'confirmed',
  'idempotency_key',
  'before_state',
  'spend_change_confirmed',
  'result_fields',
  'result_ids',
  'fields',
  'max_items',
  'compact',
]);
const catalogOnly = new Set([
  'target_action',
  'search',
  'category',
  'read_only',
  'limit',
  'offset',
  'cursor',
  'service',
  'surface',
]);
const unsupported: Record<string, string> = {
  campaign: 'Curated campaign preflight is not implemented. Put native request fields in payload.',
  adset: 'Curated ad-set preflight is not implemented. Put native request fields in payload.',
  creative: 'Curated creative preflight is not implemented. Put native request fields in payload.',
  ad: 'Curated ad preflight is not implemented. Put native request fields in payload.',
  assets: 'Curated asset preflight is not implemented.',
  context: 'Curated context preflight is not implemented.',
  skip_preflight: 'Bypassing provider preflight is not supported.',
  override_preflight: 'Bypassing provider preflight is not supported.',
  allowUnsupportedLineItemTypes: 'The DV360 validation escape hatch is not implemented.',
  region: 'Regional Amazon routing is not implemented for captured actions.',
};
const platformControls: Record<string, string[]> = {
  x_ads_native_action: ['download_report'],
  meta_native_action: ['business_id', 'page_id', 'report_run_id', 'batch', 'adbatch', 'include_headers'],
  tiktok_native_action: ['lead_region'],
  linkedin_native_action: ['restli_method', 'http_method_override', 'body_format', 'api_version'],
  dv360_native_action: ['resource', 'method'],
};
/** Envelope parameters AMCP refuses unless false (listed in the AMCP note of each tool that captures them). */
export const refusedParameters = Object.keys(unsupported);
export function parameterHandling(gateway: string, key: string): string | undefined {
  if (controls.has(key)) return 'compiler/service';
  if (catalogOnly.has(key)) return 'introspection only (Snapchat reporting limit is native)';
  if (key in unsupported) return 'explicitly unsupported when enabled';
  if (accountAliases[gateway]?.includes(key)) return 'account scope alias';
  if (platformControls[gateway]?.includes(key)) return 'platform routing or explicit unsupported action';
  return undefined;
}
export function parameterBag(value: unknown, key: string): JsonObject {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MirrorError('INVALID_PARAMETER', key + ' must be an object.', {parameter: key});
  return {...value};
}
export function nativeFields(gateway: string, action: Action): boolean {
  return gateway === 'meta_native_action' || (action.raw.native_fields ?? []).includes('fields');
}

/** Only route documented top-level native fields. Envelope controls never reach a vendor. */
export function nativeTopLevel(gateway: string, action: Action, input: JsonObject): JsonObject {
  const pathKeys = new Set([...action.path!.matchAll(/\{\+?([^{}=]+)(?:=[^{}]+)?\}/g)].map(m => m[1]!));
  const nativeKeys = new Set<string>(action.raw.native_fields ?? []);
  if (nativeFields(gateway, action)) nativeKeys.add('fields');
  if (gateway === 'snapchat_native_action' && /stats|report/i.test(action.path!)) nativeKeys.add('limit');
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (key in unsupported) {
      if (value === false) continue;
      throw new MirrorError('UNSUPPORTED_PARAMETER', unsupported[key]!, {parameter: key, gateway});
    }
    if (key === 'body_format' && gateway === 'linkedin_native_action' && value !== 'json')
      throw new MirrorError(
        'UNSUPPORTED_PARAMETER',
        'LinkedIn form query tunneling is not implemented; use JSON requests.',
        {parameter: key},
      );
    if (controls.has(key) && key !== 'fields') continue;
    if (pathKeys.has(key) || nativeKeys.has(key)) {
      out[key] = gateway === 'meta_native_action' && key === 'fields' && Array.isArray(value) ? value.join(',') : value;
      continue;
    }
    if (gateway === 'x_ads_native_action' && input.download_report === true && ['offset', 'limit'].includes(key))
      continue;
    if (catalogOnly.has(key))
      throw new MirrorError(
        'UNSUPPORTED_PARAMETER',
        key + ' only applies to introspection for this action. Put native API parameters in params or query.',
        {parameter: key},
      );
    if (gateway === 'meta_native_action' && platformControls[gateway]!.includes(key))
      throw new MirrorError(
        'UNSUPPORTED_PARAMETER',
        key + ' is not routed by this action. Automatic Page Access Token resolution is not implemented.',
        {parameter: key},
      );
    if (!parameterHandling(gateway, key))
      throw new MirrorError(
        'UNSUPPORTED_PARAMETER',
        'Unrecognized top-level parameter. Put native API fields in params, query or payload.',
        {parameter: key},
      );
  }
  return out;
}
export function assertSameAlias(a: unknown, b: unknown, label: string) {
  if (a !== undefined && b !== undefined && stable(a) !== stable(b))
    throw new MirrorError('CONFLICTING_PARAMETER', 'Conflicting ' + label + ' aliases.', {parameter: label});
}
