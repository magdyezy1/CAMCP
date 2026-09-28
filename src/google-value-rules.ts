import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

/**
 * Google Ads conversion value rules and rule sets, per the v23 "Conversion value rules" guide, the ConversionValueRule
 * and ConversionValueRuleSet references and their GAQL fields (checked 2026-09-26). A rule changes reported conversion
 * values, and therefore value-based bidding, only once a rule set includes it; the set applies the first rule, in list
 * order, whose conditions match. SET actions, itinerary conditions (allowlist-only), store-visit categories and
 * NO_CONDITION sets stay outside this contract.
 */
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  throw new MirrorError('INVALID_GOOGLE_VALUE_RULE', message);
}
const conditions: Record<string, string> = {
  audienceCondition: 'AUDIENCE',
  deviceCondition: 'DEVICE',
  geoLocationCondition: 'GEO_LOCATION',
};
const devices = ['MOBILE', 'DESKTOP', 'TABLET'],
  matchTypes = ['ANY', 'LOCATION_OF_PRESENCE'],
  dimensions = ['AUDIENCE', 'DEVICE', 'GEO_LOCATION'];
function keys(v: JsonObject, allowed: string[], at: string) {
  const extra = Object.keys(v).find(k => !allowed.includes(k));
  if (extra) invalid('"' + at + '.' + extra + '" is outside the conversion value rule contract.');
}
function names(v: unknown, pattern: RegExp, at: string, max = 200) {
  if (
    !Array.isArray(v) ||
    v.length > max ||
    new Set(v).size !== v.length ||
    !v.every(x => typeof x === 'string' && pattern.test(x))
  )
    invalid(at + ' must list distinct resource names (' + pattern.source + ').');
}

/** Operation-level checks, before the generic configuration field checks, so each refusal says why. */
export function assertGoogleValueRuleOperation(kind: string, op: JsonObject): void {
  if (kind !== 'conversionValueRules' && kind !== 'conversionValueRuleSets') return;
  const r = op.create ?? op.update;
  if (!obj(r)) return;
  if (kind === 'conversionValueRules' && r.itineraryCondition !== undefined)
    invalid('Travel itinerary conditions are allowlist-only and not qualified.');
  if (kind === 'conversionValueRuleSets' && r.conversionActionCategories !== undefined)
    invalid(
      'conversionActionCategories is immutable and limited to store visits or sales; this contract covers rule sets for all conversion categories, so omit it.',
    );
}
function condition(kind: string, v: unknown, customer: string) {
  if (!obj(v)) invalid(kind + ' must be an object.');
  if (kind === 'audienceCondition') {
    keys(v, ['userLists', 'userInterests'], kind);
    if (v.userLists !== undefined)
      names(v.userLists, new RegExp('^customers/' + customer + '/userLists/[1-9][0-9]*$'), kind + '.userLists');
    if (v.userInterests !== undefined)
      names(
        v.userInterests,
        new RegExp('^customers/' + customer + '/userInterests/[1-9][0-9]*$'),
        kind + '.userInterests',
      );
    if (!(v.userLists?.length || v.userInterests?.length))
      invalid('An audience condition lists at least one user list or user interest of the selected customer.');
  } else if (kind === 'deviceCondition') {
    keys(v, ['deviceTypes'], kind);
    if (
      !Array.isArray(v.deviceTypes) ||
      !v.deviceTypes.length ||
      new Set(v.deviceTypes).size !== v.deviceTypes.length ||
      !v.deviceTypes.every((d: unknown) => devices.includes(d as string))
    )
      invalid('deviceCondition.deviceTypes lists distinct values of ' + devices.join(', ') + '.');
  } else {
    keys(v, ['geoTargetConstants', 'geoMatchType', 'excludedGeoTargetConstants', 'excludedGeoMatchType'], kind);
    names(v.geoTargetConstants, /^geoTargetConstants\/[1-9][0-9]*$/, kind + '.geoTargetConstants');
    if (!v.geoTargetConstants.length || !matchTypes.includes(v.geoMatchType))
      invalid('A geo condition lists geoTargetConstants with a geoMatchType of ANY or LOCATION_OF_PRESENCE.');
    if (v.excludedGeoTargetConstants !== undefined) {
      names(v.excludedGeoTargetConstants, /^geoTargetConstants\/[1-9][0-9]*$/, kind + '.excludedGeoTargetConstants');
      if (!matchTypes.includes(v.excludedGeoMatchType))
        invalid('Excluded locations need an excludedGeoMatchType of ANY or LOCATION_OF_PRESENCE.');
    } else if (v.excludedGeoMatchType !== undefined)
      invalid('excludedGeoMatchType applies only with excludedGeoTargetConstants.');
  }
}
/** Record checks after the generic field checks. */
export function assertGoogleValueRuleRecord(kind: string, r: JsonObject, creating: boolean, customer: string): void {
  if (kind === 'conversionValueRules') {
    if (r.action !== undefined) {
      if (!obj(r.action)) invalid('action must be an object.');
      keys(r.action, ['operation', 'value'], 'action');
      const value = r.action.value;
      if (r.action.operation === 'SET')
        invalid('SET actions are allowlist-only or limited to store-visit sets; use ADD or MULTIPLY.');
      if (r.action.operation === 'ADD' && !(typeof value === 'number' && value > 0 && Number.isFinite(value)))
        invalid('An ADD action adds a positive value.');
      if (r.action.operation === 'MULTIPLY' && !(typeof value === 'number' && value >= 0.5 && value <= 10))
        invalid('A MULTIPLY action multiplies by 0.5 to 10.');
      if (!['ADD', 'MULTIPLY'].includes(r.action.operation)) invalid('action.operation must be ADD or MULTIPLY.');
    }
    const used = Object.keys(conditions).filter(k => r[k] !== undefined);
    if (used.length > 2)
      invalid('A rule has at most two of audienceCondition, deviceCondition and geoLocationCondition.');
    for (const k of used) condition(k, r[k], customer);
    if (r.status !== undefined && !['ENABLED', 'PAUSED'].includes(r.status))
      invalid('A rule status is ENABLED or PAUSED; remove a rule with a remove operation.');
  }
  if (kind === 'conversionValueRuleSets') {
    if (r.conversionValueRules !== undefined) {
      names(
        r.conversionValueRules,
        new RegExp('^customers/' + customer + '/conversionValueRules/[1-9][0-9]*$'),
        'conversionValueRules',
        100,
      );
      if (!r.conversionValueRules.length) invalid('A rule set needs at least one rule.');
    }
    if (
      r.dimensions !== undefined &&
      (!Array.isArray(r.dimensions) ||
        !r.dimensions.length ||
        r.dimensions.length > 2 ||
        new Set(r.dimensions).size !== r.dimensions.length ||
        !r.dimensions.every((d: unknown) => dimensions.includes(d as string)))
    )
      invalid(
        'dimensions lists one or two of ' +
          dimensions.join(', ') +
          ' (the first is the primary dimension); NO_CONDITION and ITINERARY are not qualified.',
      );
    if (creating) {
      if (!['CUSTOMER', 'CAMPAIGN'].includes(r.attachmentType))
        invalid('attachmentType is CUSTOMER (the whole account) or CAMPAIGN.');
      if ((r.attachmentType === 'CAMPAIGN') !== (r.campaign !== undefined))
        invalid('A campaign is named exactly when attachmentType is CAMPAIGN.');
    }
  }
}
/** The rule names a rule set operation includes, for the extra state read. */
export function valueRuleSetRuleNames(kind: string, ops: JsonObject[]): string[] {
  if (kind !== 'conversionValueRuleSets') return [];
  return [
    ...new Set(
      ops.flatMap(op =>
        Array.isArray((op.create ?? op.update)?.conversionValueRules)
          ? ((op.create ?? op.update).conversionValueRules as string[])
          : [],
      ),
    ),
  ];
}
/** Each included rule exists, is not removed, and uses only conditions of the set's dimensions. */
export function validateValueRuleSetPrerequisites(
  kind: string,
  ops: JsonObject[],
  rows: JsonObject[],
  current: (op: JsonObject) => JsonObject | undefined,
): void {
  if (kind !== 'conversionValueRuleSets') return;
  for (const op of ops) {
    const r = op.create ?? op.update;
    if (!obj(r)) continue;
    const rules = r.conversionValueRules ?? current(op)?.conversionValueRules,
      dims = r.dimensions ?? current(op)?.dimensions;
    if (!Array.isArray(rules) || !Array.isArray(dims)) continue;
    for (const name of rules as string[]) {
      const rule = rows.find(x => x.resourceName === name);
      if (!rule)
        throw new MirrorError(
          'STATE_TARGET_MISMATCH',
          'Conversion value rule ' + name + ' was not returned for the selected customer.',
          {resource_name: name},
        );
      if (rule.status === 'REMOVED') invalid('Conversion value rule ' + name + ' is removed.');
      const need = Object.entries(conditions)
        .filter(([k]) => rule[k] !== undefined)
        .map(([, d]) => d);
      const missing = need.filter(d => !dims.includes(d));
      if (missing.length)
        invalid(
          'Rule ' +
            name +
            ' uses ' +
            missing.join(' and ') +
            ' conditions, which the set dimensions (' +
            dims.join(', ') +
            ') do not include.',
        );
    }
  }
}
const sorted = (v: unknown) => (Array.isArray(v) ? [...v].map(String).sort() : v);
/** Conditions compared as sets; rule order in a set and dimension order stay meaningful. Only fields present change. */
export function googleValueRuleCanonical(resource: string, value: unknown): any {
  if (!obj(value) || resource !== 'conversion_value_rule') return value;
  const out: JsonObject = {...value};
  if (obj(out.action) && out.action.value !== undefined) out.action = {...out.action, value: Number(out.action.value)};
  if (obj(out.audienceCondition))
    out.audienceCondition = Object.fromEntries(Object.entries(out.audienceCondition).map(([k, v]) => [k, sorted(v)]));
  if (obj(out.deviceCondition))
    out.deviceCondition = {...out.deviceCondition, deviceTypes: sorted(out.deviceCondition.deviceTypes)};
  if (obj(out.geoLocationCondition)) {
    const g: JsonObject = {...out.geoLocationCondition};
    for (const k of ['geoTargetConstants', 'excludedGeoTargetConstants']) if (g[k] !== undefined) g[k] = sorted(g[k]);
    out.geoLocationCondition = g;
  }
  return out;
}
export function googleValueRuleImpact(kind: string, body: JsonObject): JsonObject {
  const ops = (Array.isArray(body.operations) ? body.operations : []) as JsonObject[];
  const items = ops.map(op => {
    const r = op.create ?? op.update ?? {};
    return {
      operation: op.create ? 'create' : op.update ? 'update' : 'remove',
      ...(kind === 'conversionValueRules'
        ? {
            action: r.action ?? null,
            conditions: Object.keys(conditions).filter(k => r[k] !== undefined),
            status: r.status ?? null,
          }
        : {
            rules_in_order: r.conversionValueRules ?? null,
            dimensions: r.dimensions ?? null,
            attachment: r.attachmentType ?? null,
            campaign: r.campaign ?? null,
          }),
    };
  });
  const serving = kind === 'conversionValueRuleSets' || ops.some(op => !op.create);
  return {
    provider: 'google',
    scope: kind,
    may_affect_serving: serving,
    effect:
      kind === 'conversionValueRules'
        ? 'Creates or edits conversion value rules. A rule changes reported conversion values, and therefore value-based bidding, only while a rule set includes it; edits to a rule in a set take effect at once.'
        : 'Creates, edits or removes a rule set. The set adjusts reported conversion values, and therefore value-based bidding, for its account or campaign, applying the first matching rule in list order.',
    items,
    verification: 'Exact selected-customer read-back; adjusted conversion values and bidding outcomes are not claimed.',
    source: 'https://developers.google.com/google-ads/api/docs/conversions/conversion-value-rules',
  };
}
