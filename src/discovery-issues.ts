import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

/**
 * The structural check of a request body against a Discovery schema (PRV-05 step 1), moved unchanged from
 * src/wire-contracts.ts (ARC-01, wave 4c round 6), which re-exports it: a leaf, so Google Ads' own check
 * (src/google-contracts.ts, under the provider hooks) and the wire contracts (which consult those hooks) share it
 * without an import cycle.
 */
export interface WireIssue {
  field: string;
  reason: string;
}
export interface DiscoveryOptions {
  /** A read keeps ProtoJSON's numeric enum allowance; a reviewed write must name the enum value. */
  readOnly?: boolean;
  /** At most this many issues are kept (the check still visits the whole body). */
  maxIssues?: number;
  /** Names the provider in the bounds and unresolved-schema refusals. */
  label?: string;
}
/**
 * Structural issues of `value` against a Discovery schema (PRV-05 step 1, shared by Google Ads and every other pinned
 * Discovery document). Discovery is not JSON Schema: ProtoJSON int64 accepts decimal strings or safe integers, null
 * means unset, and nothing is coerced. Unknown fields, wrong types, values outside the declared 64-bit range and enum
 * values absent from the document are issues; so is a numeric enum in a write, which no review could check.
 */
export function discoveryIssues(
  schemas: Record<string, JsonObject>,
  root: JsonObject,
  value: unknown,
  options: DiscoveryOptions = {},
): WireIssue[] {
  const issues: WireIssue[] = [],
    max = options.maxIssues ?? 20,
    label = options.label ?? 'vendor';
  let nodes = 0;
  const issue = (field: string, reason: string) => {
    if (issues.length < max) issues.push({field, reason});
  };
  const visit = (raw: JsonObject, v: any, path: string, depth: number) => {
    if (++nodes > 50000 || depth > 64)
      throw new MirrorError('INVALID_VENDOR_BODY', label + ' request exceeds validation bounds.');
    const schema = raw.$ref ? schemas[raw.$ref] : raw;
    if (!schema)
      throw new MirrorError(
        'VENDOR_SCHEMA_UNAVAILABLE',
        'An ingested ' + label + ' schema reference cannot be resolved.',
        {
          schema: raw.$ref,
        },
      );
    // Discovery's `any` (a protobuf Value, such as a Business Profile attribute value) takes every JSON value.
    if (v === null || v === undefined || schema.type === 'any') return;
    if (schema.type === 'object') {
      if (typeof v !== 'object' || Array.isArray(v)) {
        issue(path, 'Expected an object');
        return;
      }
      for (const [key, item] of Object.entries(v)) {
        const child = schema.properties?.[key] ?? schema.additionalProperties;
        if (child && typeof child === 'object') visit(child, item, path + '/' + key, depth + 1);
        else if (
          child !== true &&
          !(key === '@type' && (schema.id?.endsWith('__Any') || schema.id === 'GoogleProtobufAny'))
        )
          issue(path + '/' + key, 'Field absent from the pinned vendor request schema');
      }
    } else if (schema.type === 'array') {
      if (!Array.isArray(v)) issue(path, 'Expected an array');
      else v.forEach((item, i) => visit(schema.items, item, path + '/' + i, depth + 1));
    } else if (['int64', 'uint64'].includes(schema.format)) {
      const decimal =
        (typeof v === 'string' && /^-?\d+$/.test(v)) || (typeof v === 'number' && Number.isSafeInteger(v));
      if (!decimal) issue(path, 'Expected a decimal string or safe integer');
      else {
        const n = BigInt(v),
          unsigned = schema.format === 'uint64';
        if (n < (unsigned ? 0n : -(1n << 63n)) || n > (unsigned ? (1n << 64n) - 1n : (1n << 63n) - 1n))
          issue(path, 'Integer outside the declared 64-bit range');
      }
    } else if (schema.enum && typeof v === 'number' && Number.isSafeInteger(v)) {
      // ProtoJSON permits enum numbers, but Discovery has no reliable numeric mapping: a reviewed mutation could not be
      // checked against owner policies or read back (CampaignStatus 2 is ENABLED). Reads keep the ProtoJSON allowance.
      if (!options.readOnly) issue(path, 'Use the enum name; a numeric enum value cannot be reviewed');
    } else if (schema.type === 'integer') {
      if (!Number.isSafeInteger(v)) issue(path, 'Expected a safe integer');
    } else if (schema.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) issue(path, 'Expected a finite number');
    } else if (schema.type && typeof v !== schema.type) issue(path, 'Expected ' + schema.type);
    else if (schema.enum && !schema.enum.includes(v)) issue(path, 'Value absent from the pinned vendor enum');
  };
  visit(root, value, '', 0);
  return issues;
}
