import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

/**
 * Google Ads audiences, per the v23 Audience resource in the pinned Discovery document (captured 2026-09-17) and
 * the v23 GAQL field reference (checked 2026-09-26). A customer-scoped audience combines demographic dimensions and
 * audience segments and is used as a Performance Max or Demand Gen signal. Asset-group-scoped audiences, which
 * cannot carry a name, stay outside this contract; the service exposes no remove.
 */
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  throw new MirrorError('INVALID_GOOGLE_AUDIENCE', message);
}
const minAges = [18, 25, 35, 45, 55, 65],
  maxAges = [24, 34, 44, 54, 64];
const enums: Record<string, [string, string[]]> = {
  gender: ['genders', ['MALE', 'FEMALE', 'UNDETERMINED']],
  householdIncome: [
    'incomeRanges',
    [
      'INCOME_RANGE_0_50',
      'INCOME_RANGE_50_60',
      'INCOME_RANGE_60_70',
      'INCOME_RANGE_70_80',
      'INCOME_RANGE_80_90',
      'INCOME_RANGE_90_UP',
      'INCOME_RANGE_UNDETERMINED',
    ],
  ],
  parentalStatus: ['parentalStatuses', ['PARENT', 'NOT_A_PARENT', 'UNDETERMINED']],
};
// Segment oneof member -> [resource field, customer-scoped collection].
const segments: Record<string, [string, string]> = {
  userList: ['userList', 'userLists'],
  userInterest: ['userInterestCategory', 'userInterests'],
  lifeEvent: ['lifeEvent', 'lifeEvents'],
  detailedDemographic: ['detailedDemographic', 'detailedDemographics'],
  customAudience: ['customAudience', 'customAudiences'],
};
const dimensionKinds = ['age', 'gender', 'householdIncome', 'parentalStatus', 'audienceSegments'];

function keys(v: JsonObject, allowed: string[], path: string) {
  const extra = Object.keys(v).find(k => !allowed.includes(k));
  if (extra) invalid('"' + path + extra + '" is outside the qualified audience contract.');
}
function flag(v: unknown, path: string) {
  if (v !== undefined && typeof v !== 'boolean') invalid(path + 'includeUndetermined must be true or false.');
}
function list(v: unknown, allowed: string[], path: string) {
  if (!Array.isArray(v) || !v.length || new Set(v).size !== v.length || !v.every(x => allowed.includes(x)))
    invalid(path + ' must list unique values from: ' + allowed.join(', ') + '.');
}
function segment(s: unknown, customer: string, path: string): void {
  if (!obj(s)) invalid(path + ' must be an object.');
  const kind = Object.keys(s);
  if (kind.length !== 1 || !segments[kind[0]!])
    invalid(path + ' must set exactly one of ' + Object.keys(segments).join(', ') + '.');
  const [field, collection] = segments[kind[0]!]!,
    inner = s[kind[0]!];
  if (!obj(inner)) invalid(path + '.' + kind[0] + ' must be an object.');
  keys(inner, [field], path + '.' + kind[0] + '.');
  if (
    typeof inner[field] !== 'string' ||
    !new RegExp('^customers/' + customer + '/' + collection + '/[1-9][0-9]*$').test(inner[field])
  )
    invalid(path + '.' + kind[0] + '.' + field + ' must be a ' + collection + ' resource in the selected customer.');
}

/** Validates a create or update record before review; the resource names must use the selected customer. */
export function assertGoogleAudienceRecord(r: JsonObject, creating: boolean, customer: string): void {
  if (r.scope !== undefined && r.scope !== 'CUSTOMER')
    invalid('Only CUSTOMER-scoped audiences are qualified; asset-group audiences cannot carry a name.');
  if (r.assetGroup !== undefined) invalid('assetGroup applies only to asset-group audiences, which are not qualified.');
  if (creating && typeof r.name !== 'string') invalid('A customer-scoped audience needs a name.');
  if (
    r.description !== undefined &&
    (typeof r.description !== 'string' || [...r.description].length > 1024 || /[\u0000]/.test(r.description))
  )
    invalid('description must be text.');
  if (creating && r.dimensions === undefined) invalid('An audience needs at least one dimension.');
  if (r.dimensions !== undefined) {
    if (!Array.isArray(r.dimensions) || !r.dimensions.length) invalid('dimensions must list at least one dimension.');
    const seen = new Set<string>();
    r.dimensions.forEach((d: unknown, i: number) => {
      const path = 'dimensions[' + i + ']';
      if (!obj(d)) invalid(path + ' must be an object.');
      const kind = Object.keys(d);
      if (kind.length !== 1 || !dimensionKinds.includes(kind[0]!))
        invalid(path + ' must set exactly one of ' + dimensionKinds.join(', ') + '.');
      const k = kind[0]!,
        v = d[k];
      if (seen.has(k)) invalid('Each dimension type may appear once; ' + k + ' repeats.');
      seen.add(k);
      if (!obj(v)) invalid(path + '.' + k + ' must be an object.');
      if (k === 'age') {
        keys(v, ['ageRanges', 'includeUndetermined'], path + '.age.');
        flag(v.includeUndetermined, path + '.age.');
        if (!Array.isArray(v.ageRanges) || !v.ageRanges.length)
          invalid(path + '.age.ageRanges must list at least one range.');
        for (const range of v.ageRanges) {
          if (!obj(range)) invalid(path + '.age.ageRanges entries must be objects.');
          keys(range, ['minAge', 'maxAge'], path + '.age.ageRanges.');
          if (!minAges.includes(range.minAge)) invalid('minAge must be one of ' + minAges.join(', ') + '.');
          if (range.maxAge !== undefined && (!maxAges.includes(range.maxAge) || range.maxAge <= range.minAge))
            invalid('maxAge must be one of ' + maxAges.join(', ') + ' and greater than minAge.');
        }
      } else if (k === 'audienceSegments') {
        keys(v, ['segments'], path + '.audienceSegments.');
        if (!Array.isArray(v.segments) || !v.segments.length)
          invalid(path + '.audienceSegments.segments must list at least one segment.');
        v.segments.forEach((s: unknown, j: number) =>
          segment(s, customer, path + '.audienceSegments.segments[' + j + ']'),
        );
        if (new Set(v.segments.map((s: JsonObject) => JSON.stringify(s))).size !== v.segments.length)
          invalid('Audience segments must be unique.');
      } else {
        const [field, allowed] = enums[k]!;
        keys(v, [field, 'includeUndetermined'], path + '.' + k + '.');
        flag(v.includeUndetermined, path + '.' + k + '.');
        list(v[field], allowed, path + '.' + k + '.' + field);
      }
    });
  }
  if (r.exclusionDimension !== undefined) {
    const x = r.exclusionDimension;
    if (!obj(x)) invalid('exclusionDimension must be an object.');
    keys(x, ['exclusions'], 'exclusionDimension.');
    if (!Array.isArray(x.exclusions) || !x.exclusions.length)
      invalid('exclusionDimension.exclusions must list at least one user list.');
    x.exclusions.forEach((e: unknown, j: number) => {
      if (!obj(e) || Object.keys(e).join() !== 'userList')
        invalid('exclusionDimension.exclusions[' + j + '] must be a userList segment.');
      segment(e, customer, 'exclusionDimension.exclusions[' + j + ']');
    });
  }
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    obj(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map(k => [k, x[k]]),
        )
      : x,
  );
const sorted = <T>(values: T[]) =>
  [...values].sort((a, b) => {
    const x = stable(a),
      y = stable(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
function canonicalDimension(d: JsonObject): JsonObject {
  const k = Object.keys(d)[0]!,
    v = obj(d[k]) ? d[k] : {},
    out: JsonObject = {};
  // ProtoJSON omits false booleans and empty lists; the request may state them explicitly.
  if (v.includeUndetermined === true) out.includeUndetermined = true;
  if (k === 'age')
    out.ageRanges = sorted(
      (v.ageRanges ?? []).map((r: JsonObject) => ({
        minAge: Number(r.minAge),
        ...(r.maxAge !== undefined ? {maxAge: Number(r.maxAge)} : {}),
      })),
    );
  else if (k === 'audienceSegments') out.segments = sorted(v.segments ?? []);
  else {
    const field = enums[k]![0];
    out[field] = [...(v[field] ?? [])].sort();
  }
  return {[k]: out};
}
/**
 * Configuration as compared on read-back: dimensions, ranges, segments and exclusions sorted, default booleans
 * dropped. Order carries no meaning in the documented schema, and ProtoJSON may reorder or omit defaults.
 */
export function googleAudienceCanonical(value: JsonObject): JsonObject {
  const out: JsonObject = {...value};
  if (Array.isArray(value.dimensions)) out.dimensions = sorted(value.dimensions.filter(obj).map(canonicalDimension));
  if (obj(value.exclusionDimension))
    out.exclusionDimension = {exclusions: sorted(value.exclusionDimension.exclusions ?? [])};
  return out;
}
