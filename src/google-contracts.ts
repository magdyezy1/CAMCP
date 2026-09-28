import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {MirrorError} from './errors.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';

export function assertGoogleAdsScope(c: Connection): void {
  if (!c.scopes.includes('https://www.googleapis.com/auth/adwords'))
    throw new MirrorError('INSUFFICIENT_SCOPE', 'Reconnect the selected Ads connection with the adwords scope.');
}

let artifact: JsonObject | undefined;
function data(): JsonObject {
  return (artifact ??= JSON.parse(
    fs.readFileSync(fileURLToPath(new URL('../../generated/vendor-routes.json', import.meta.url)), 'utf8'),
  ));
}
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
 * strings or safe integers and null means unset. Do not silently coerce inputs. */
export function validateGoogleRequest(plan: CompiledRequest): void {
  const r = route(plan);
  if (!r?.requestSchema || plan.body === undefined) return;
  const schemas = data().schemaComponents['google-ads-v23'].schemas,
    issues: JsonObject[] = [];
  let nodes = 0;
  const issue = (field: string, reason: string) => {
    if (issues.length < 20) issues.push({field, reason});
  };
  const visit = (raw: JsonObject, value: any, path: string, depth: number) => {
    if (++nodes > 50000 || depth > 64)
      throw new MirrorError('INVALID_VENDOR_BODY', 'Google request exceeds validation bounds.');
    const schema = raw.$ref ? schemas[raw.$ref] : raw;
    if (!schema)
      throw new MirrorError('VENDOR_SCHEMA_UNAVAILABLE', 'An ingested Google schema reference cannot be resolved.', {
        schema: raw.$ref,
      });
    if (value === null || value === undefined) return;
    if (schema.type === 'object') {
      if (typeof value !== 'object' || Array.isArray(value)) {
        issue(path, 'Expected an object');
        return;
      }
      for (const [key, v] of Object.entries(value)) {
        const child = schema.properties?.[key] ?? schema.additionalProperties;
        if (child && typeof child === 'object') visit(child, v, path + '/' + key, depth + 1);
        else if (child !== true && !(key === '@type' && schema.id?.endsWith('__Any')))
          issue(path + '/' + key, 'Field absent from the pinned vendor request schema');
      }
    } else if (schema.type === 'array') {
      if (!Array.isArray(value)) issue(path, 'Expected an array');
      else value.forEach((v, i) => visit(schema.items, v, path + '/' + i, depth + 1));
    } else if (['int64', 'uint64'].includes(schema.format)) {
      const decimal =
        (typeof value === 'string' && /^-?\d+$/.test(value)) ||
        (typeof value === 'number' && Number.isSafeInteger(value));
      if (!decimal) issue(path, 'Expected a decimal string or safe integer');
      else {
        const n = BigInt(value),
          unsigned = schema.format === 'uint64';
        if (n < (unsigned ? 0n : -(1n << 63n)) || n > (unsigned ? (1n << 64n) - 1n : (1n << 63n) - 1n))
          issue(path, 'Integer outside the declared 64-bit range');
      }
    } else if (schema.enum && typeof value === 'number' && Number.isSafeInteger(value)) {
      // ProtoJSON permits enum numbers, but Discovery has no reliable numeric mapping: a reviewed mutation could not be
      // checked against owner policies or read back (CampaignStatus 2 is ENABLED). Reads keep the ProtoJSON allowance.
      if (!plan.readOnly) issue(path, 'Use the enum name; a numeric enum value cannot be reviewed');
    } else if (schema.type === 'integer') {
      if (!Number.isSafeInteger(value)) issue(path, 'Expected a safe integer');
    } else if (schema.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) issue(path, 'Expected a finite number');
    } else if (schema.type && typeof value !== schema.type) issue(path, 'Expected ' + schema.type);
    else if (schema.enum && !schema.enum.includes(value)) issue(path, 'Value absent from the pinned vendor enum');
  };
  visit(r.requestSchema, googleJson(plan.body), '', 0);
  if (issues.length)
    throw new MirrorError(
      'INVALID_VENDOR_BODY',
      'Request differs from the official Google Ads v23 Discovery contract.',
      {
        vendor_method: r.vendorMethod,
        source: r.source,
        errors: issues,
        next_action:
          'Correct the listed request fields. Refresh and review the pinned specification before enabling a newly introduced vendor field.',
      },
    );
}
