import {MirrorError} from './errors.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import {
  googleAdsContract,
  googleAdsFieldReplacement,
  googleAdsRequestChange,
  googleAdsVersion,
} from './google-version.js';
import {pinnedJson} from './pinned-json.js';
import {googleAdsScope} from './provider-grants.js';
// Wave 4c round 6 (w4c-arc6-tables): the leaf that holds the Discovery check, so this module, under the provider hooks,
// no longer imports the wire contracts that consult them (which re-export it).
import {discoveryIssues} from './discovery-issues.js';

export function assertGoogleAdsScope(c: Connection): void {
  if (!c.scopes.includes(googleAdsScope))
    throw new MirrorError('INSUFFICIENT_SCOPE', 'Reconnect the selected Ads connection with the adwords scope.');
}

const data = (): JsonObject => pinnedJson('generated/vendor-routes.json');
const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
/** The same conversion is used by validation and by the actual ProtoJSON transport. */
export function googleJson(value: unknown): any {
  if (Array.isArray(value)) return value.map(googleJson);
  if (value && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [key, v] of Object.entries(value)) {
      const k = camel(key);
      if (Object.hasOwn(out, k))
        throw new MirrorError('CONFLICTING_PARAMETER', 'Both snake_case and camelCase specify the same Google field.', {
          field: k,
        });
      Object.defineProperty(out, k, {
        value: /^(?:updateMask|readMask)$/.test(k) && typeof v === 'string' ? camel(v) : googleJson(v),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}
function route(plan: CompiledRequest): JsonObject | undefined {
  if (plan.gateway !== 'google_ads_native_action') return undefined;
  return data().routes.find(
    (r: JsonObject) =>
      r.gateway === plan.gateway &&
      r.method === plan.method &&
      new RegExp(
        '^' +
          (r.flatPath ?? r.path)
            .split(/(\{[^}]+\})/)
            .map((p: string) => (p.startsWith('{') ? '[^/]+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
            .join('') +
          '$',
      ).test(plan.path),
  );
}
export function googleContractEvidence(plan: CompiledRequest): CompiledRequest {
  const r = route(plan);
  if (!r) return plan;
  return {
    ...plan,
    contractEvidence: {
      route_source: r.evidence,
      vendor_method: r.vendorMethod,
      source: r.source,
      ...data().sourceIntegrity[r.sourceFile],
      request_schema: r.requestRef,
      validation:
        'Discovery field names, scalar types and enums on ProtoJSON; business rules and oneofs remain provider/review checks',
      live_qualification: 'unverified',
    },
  };
}
/** Discovery is not JSON Schema: in particular ProtoJSON int64 accepts decimal
 * strings or safe integers and null means unset. Do not silently coerce inputs. The check is the shared Discovery
 * validator (src/wire-contracts.ts, PRV-05); Google Ads keeps enforcing it on every request. */
export function validateGoogleRequest(plan: CompiledRequest): void {
  const r = route(plan);
  if (!r?.requestSchema || plan.body === undefined) return;
  const issues = discoveryIssues(
    data().schemaComponents[googleAdsContract].schemas,
    r.requestSchema,
    googleJson(plan.body),
    {readOnly: plan.readOnly, label: 'Google'},
  );
  if (issues.length)
    throw new MirrorError(
      'INVALID_VENDOR_BODY',
      'Request differs from the official Google Ads ' + googleAdsVersion + ' Discovery contract.',
      {
        vendor_method: r.vendorMethod,
        source: r.source,
        // An issue about a field the current version no longer has names the field that replaces it (R2.5 r25-field3-refs, F6-1): the refusal stays.
        errors: issues.map(issue => ({...issue, ...googleAdsFieldReplacement(plan.path, issue.field)})),
        ...(googleAdsRequestChange(plan.action) ? {version_change: googleAdsRequestChange(plan.action)} : {}),
        next_action:
          'Correct the listed request fields. Refresh and review the pinned specification before enabling a newly introduced vendor field.',
      },
    );
}
