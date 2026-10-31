import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {ParameterFacts} from './provider-adapter.js';
import {accountAliasProviders, encodedBodyProviders, providerHooks, registeredProviderHooks} from './provider-hooks.js';
import type {Action, JsonObject} from './types.js';

// Each provider's parameter rules are facts of its adapter hooks (`parameters`, ARC-01 wave 4c round 6), copied into
// the plain tables below; src/provider-hooks.ts orders the two whose order shows.
/** These direct compilers already accept a JSON-encoded native body. Keep metadata recovery aligned. */
export const encodedBodyGateways: readonly string[] = encodedBodyProviders.map(hooks => hooks.gateway);

export const accountAliases: Record<string, string[]> = Object.fromEntries(
  accountAliasProviders.map(hooks => [hooks.gateway, [...hooks.parameters!.accountAliases!]]),
);
const own = (gateway: string): ParameterFacts | undefined => providerHooks(gateway)?.parameters;
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
const platformControls: Record<string, string[]> = Object.fromEntries(
  registeredProviderHooks
    .filter(hooks => hooks.parameters?.platformControls)
    .map(hooks => [hooks.gateway, [...hooks.parameters!.platformControls!]]),
);
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
  return own(gateway)?.everyActionFields === true || (action.raw.native_fields ?? []).includes('fields');
}

/** Only route documented top-level native fields. Envelope controls never reach a vendor. */
export function nativeTopLevel(gateway: string, action: Action, input: JsonObject): JsonObject {
  const pathKeys = new Set([...action.path!.matchAll(/\{\+?([^{}=]+)(?:=[^{}]+)?\}/g)].map(m => m[1]!));
  const nativeKeys = new Set<string>(action.raw.native_fields ?? []);
  const facts = own(gateway),
    joinedFields = providerHooks(gateway)?.compile?.joinedFields === true;
  if (nativeFields(gateway, action)) nativeKeys.add('fields');
  if (facts?.nativeLimit !== undefined && facts.nativeLimit.test(action.path!)) nativeKeys.add('limit');
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (key in unsupported) {
      if (value === false) continue;
      throw new MirrorError('UNSUPPORTED_PARAMETER', unsupported[key]!, {parameter: key, gateway});
    }
    const only = facts?.onlyValue;
    if (only !== undefined && key === only.parameter && value !== only.value) throw only.refusal(key);
    if (controls.has(key) && key !== 'fields') continue;
    if (pathKeys.has(key) || nativeKeys.has(key)) {
      out[key] = joinedFields && key === 'fields' && Array.isArray(value) ? value.join(',') : value;
      continue;
    }
    const dropped = facts?.droppedWhile;
    if (dropped !== undefined && input[dropped.parameter] === true && dropped.dropped.includes(key)) continue;
    if (catalogOnly.has(key))
      throw new MirrorError(
        'UNSUPPORTED_PARAMETER',
        key + ' only applies to introspection for this action. Put native API parameters in params or query.',
        {parameter: key},
      );
    if (facts?.controlRefusal !== undefined && platformControls[gateway]!.includes(key))
      throw new MirrorError('UNSUPPORTED_PARAMETER', key + ' is not routed by this action. ' + facts.controlRefusal, {
        parameter: key,
      });
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
