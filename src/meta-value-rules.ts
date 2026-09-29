import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {metaPrefix, metaRoute} from './meta-version.js';

/**
 * Meta value rule sets, per the Marketing API "Value Rules" guide (checked 2026-09-26 at Graph v25.0;
 * the v26.0 SDK keeps the route and its parameters). A set
 * holds up to 10 ordered rules; the first matching rule adjusts the bid, up by 1–1000% or down by 1–90%, for up to four
 * criteria. An account holds up to six sets. An update sends the complete set: existing rules and criteria keep their IDs,
 * new ones have none, and omitted ones are removed. Ad sets that use a set bid by it, so edits and deletion change their
 * bidding at once. Since 22 June 2026 Meta no longer applies DMA location rules.
 */
const actions = {
  create: 'meta_ad_account_id_value_rule_set_create',
  update: 'meta_value_rule_set_id_update',
  delete: 'meta_value_rule_set_id_delete_rule_set_create',
} as const;
type Kind = keyof typeof actions;
const labels = [
  'HIGH_VALUE',
  'LOW_VALUE',
  'OTHER_CUSTOMERS',
  'NEW_USERS',
  'QUALIFIED_LEADS',
  'DISQUALIFIED_LEADS',
  'AT_RISK',
  'DISENGAGED',
  'APP_INSTALLERS',
  'TRIAL_USERS',
  'ENGAGED_USERS',
  'OTHER_1',
  'OTHER_2',
  'OTHER_3',
];
const criteria: Record<string, {values?: string[]; types: string[]}> = {
  AGE: {types: ['NONE']},
  GENDER: {values: ['MALE', 'FEMALE'], types: ['NONE']},
  OS_TYPE: {values: ['ANDROID', 'IOS'], types: ['NONE']},
  DEVICE_PLATFORM: {values: ['MOBILE', 'DESKTOP'], types: ['NONE']},
  LOCATION: {types: ['LOCATION_COUNTRY', 'LOCATION_REGION', 'LOCATION_CITY', 'LOCATION_COMSCORE_MARKET']},
  PLACEMENT: {
    values: [
      'FB_FEED',
      'FB_STORIES',
      'FB_REELS',
      'FB_MARKETPLACE',
      'FB_SEARCH',
      'FB_VIDEO',
      'IG_FEED',
      'IG_STORIES',
      'IG_REELS',
      'IG_EXPLORE',
      'AUDIENCE_NETWORK',
    ],
    types: ['NONE'],
  },
  OMNI_CHANNEL: {values: ['APP', 'INSTANT_FORM', 'PHONE_CALL', 'WEBSITE'], types: ['NONE']},
  AUDIENCE_LABEL: {values: labels, types: ['NONE']},
};
const maxSets = 6,
  maxRules = 10,
  maxCriteria = 4,
  numeric = /^[1-9]\d*$/;
export const metaValueRuleFields = 'id,name,rules{id,name,adjust_sign,adjust_value,status,criterias}';
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(code: string, message: string, details: JsonObject = {}): never {
  throw new MirrorError(code, message, details);
}
function invalid(message: string): never {
  return fail('INVALID_META_VALUE_RULE', message);
}
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && !!v.trim() && v === v.trim() && [...v].length <= max && !/[\u0000-\u001f]/.test(v);
export function metaValueRuleKind(p: CompiledRequest): Kind | undefined {
  if (
    p.gateway !== 'meta_native_action' ||
    p.method !== 'POST' ||
    (p.origin !== undefined && p.origin !== 'https://graph.facebook.com')
  )
    return;
  if (p.action === actions.create && metaRoute('act_\\d+/value_rule_set$').test(p.path)) return 'create';
  if (p.action === actions.update && metaRoute('\\d+$').test(p.path)) return 'update';
  if (p.action === actions.delete && metaRoute('\\d+/delete_rule_set$').test(p.path)) return 'delete';
  return;
}
const target = (p: CompiledRequest) => p.path.split('/')[2]!;
function age(value: string): boolean {
  const range = /^(\d{2})-(\d{2})$/.exec(value),
    open = /^(\d{2})\+$/.exec(value);
  if (range) return Number(range[1]) >= 13 && Number(range[2]) <= 64 && Number(range[1]) <= Number(range[2]);
  return !!open && Number(open[1]) >= 13 && Number(open[1]) <= 65;
}
function criterion(c: unknown, at: string, updating: boolean): void {
  if (
    !obj(c) ||
    Object.keys(c).some(
      k =>
        !['criteria_type', 'operator', 'criteria_values', 'criteria_value_types', ...(updating ? ['id'] : [])].includes(
          k,
        ),
    )
  )
    invalid(
      at +
        ' takes criteria_type, operator, criteria_values and criteria_value_types' +
        (updating ? ', and the id of an existing criterion' : '') +
        '.',
    );
  const spec = criteria[c.criteria_type];
  if (!spec) invalid(at + '.criteria_type must be one of ' + Object.keys(criteria).join(', ') + '.');
  if (c.operator !== 'CONTAINS') invalid(at + '.operator must be CONTAINS.');
  const values = c.criteria_values,
    kinds = c.criteria_value_types;
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > 100 ||
    !Array.isArray(kinds) ||
    kinds.length !== values.length ||
    values.some(v => typeof v !== 'string' || !v.trim()) ||
    new Set(values.map((v: string) => v.toUpperCase())).size !== values.length
  )
    invalid(at + ' needs distinct criteria_values with one criteria_value_types entry each, in the same order.');
  if (kinds.some((k: unknown) => typeof k !== 'string' || !spec.types.includes(k)))
    invalid(
      at +
        '.criteria_value_types for ' +
        c.criteria_type +
        ' must be ' +
        spec.types.join(' or ') +
        (c.criteria_type === 'LOCATION'
          ? '; Meta stopped applying LOCATION_DMA on 22 June 2026, use LOCATION_COMSCORE_MARKET'
          : '') +
        '.',
    );
  if (spec.values && values.some((v: string) => !spec.values!.includes(v.toUpperCase())))
    invalid(at + '.criteria_values for ' + c.criteria_type + ' must be among ' + spec.values.join(', ') + '.');
  if (c.criteria_type === 'AGE' && values.some((v: string) => !age(v)))
    invalid(
      at +
        ' uses an age range Meta does not accept: use ranges such as 18-24 or 45+, and 18+ instead of an upper limit of 65.',
    );
  if (c.criteria_type === 'LOCATION')
    values.forEach((v: string, i: number) => {
      if (kinds[i] === 'LOCATION_COUNTRY' ? !/^[A-Z]{2}$/.test(v) : !numeric.test(v))
        invalid(at + ' needs two-letter country codes and numeric Meta location keys.');
    });
  if (c.id !== undefined && (typeof c.id !== 'string' || !numeric.test(c.id)))
    invalid(at + '.id must be the ID of an existing criterion.');
}
function rules(value: unknown, updating: boolean): void {
  if (!Array.isArray(value) || !value.length || value.length > maxRules)
    invalid('rules must hold 1 to ' + maxRules + ' rules, in priority order.');
  const names = new Set<string>();
  (value as unknown[]).forEach((r, i) => {
    const at = 'rules[' + i + ']';
    if (
      !obj(r) ||
      Object.keys(r).some(
        k => !['name', 'adjust_sign', 'adjust_value', 'criterias', ...(updating ? ['id', 'status'] : [])].includes(k),
      )
    )
      invalid(
        at +
          ' takes name, adjust_sign, adjust_value and criterias' +
          (updating ? ', and the id and status of an existing rule' : '') +
          '.',
      );
    if (!text(r.name, 255)) invalid(at + '.name must be 1–255 characters.');
    if (names.has(r.name.toLowerCase())) invalid('Rule names must be distinct within a set.');
    names.add(r.name.toLowerCase());
    if (!['INCREASE', 'DECREASE'].includes(r.adjust_sign)) invalid(at + '.adjust_sign must be INCREASE or DECREASE.');
    const max = r.adjust_sign === 'INCREASE' ? 1000 : 90;
    if (!Number.isInteger(r.adjust_value) || r.adjust_value < 1 || r.adjust_value > max)
      invalid(at + '.adjust_value must be a whole percentage from 1 to ' + max + ' for ' + r.adjust_sign + '.');
    if (!Array.isArray(r.criterias) || !r.criterias.length || r.criterias.length > maxCriteria)
      invalid(at + '.criterias must hold 1 to ' + maxCriteria + ' criteria.');
    if (new Set(r.criterias.map((c: JsonObject) => c?.criteria_type)).size !== r.criterias.length)
      invalid(at + ' uses a criteria type twice; list its values in one criterion.');
    r.criterias.forEach((c: unknown, j: number) => criterion(c, at + '.criterias[' + j + ']', updating));
    if (r.id !== undefined && (typeof r.id !== 'string' || !numeric.test(r.id)))
      invalid(at + '.id must be the ID of an existing rule.');
    if (r.status !== undefined && r.status !== 'ACTIVE') invalid(at + '.status can only restate ACTIVE.');
  });
}
export function assertMetaValueRule(p: CompiledRequest): void {
  const kind = metaValueRuleKind(p);
  if (!kind) return;
  if (kind === 'create' && p.path.split('/')[2] !== 'act_' + p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'The value rule set must be created in the selected ad account.');
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Value rule set reviews take no query or header overrides.');
  const b = obj(p.body) ? p.body : {};
  if (kind === 'delete') {
    if (p.body !== undefined && Object.keys(b).length) invalid('Deleting a value rule set takes an empty body.');
    return;
  }
  if (!obj(p.body) || Object.keys(b).some(k => !['name', 'rules', ...(kind === 'update' ? ['id'] : [])].includes(k)))
    invalid('A value rule set takes name and rules' + (kind === 'update' ? ', and its own id' : '') + '.');
  if (kind === 'update' && b.id !== undefined && b.id !== target(p))
    invalid('The id in the body must be the rule set being updated.');
  if (!text(b.name, 255)) invalid('name must be 1–255 characters.');
  rules(b.rules, kind === 'update');
}
export function metaValueRuleReads(p: CompiledRequest): CompiledRequest[] {
  return [
    {
      ...p,
      action: 'AMCP_META_VALUE_RULE_READ',
      method: 'GET',
      path: metaPrefix + 'act_' + p.accountId + '/value_rule_set',
      query: {fields: metaValueRuleFields, limit: 25},
      body: undefined,
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      specialTransport: undefined,
      metaValueRuleState: true,
    },
  ];
}
export function isMetaValueRuleRead(p: CompiledRequest): boolean {
  return p.gateway === 'meta_native_action' && p.metaValueRuleState === true;
}
const edges = (v: unknown): JsonObject[] => (Array.isArray(v) ? v : obj(v) && Array.isArray(v.data) ? v.data : []);
export function validateMetaValueRuleState(read: CompiledRequest, result: TransportResult): void {
  const d = result.data;
  if (result.status !== 200 || !obj(d) || d.error || !Array.isArray(d.data) || (obj(d.paging) && d.paging.next))
    fail('STATE_READ_FAILED', 'Meta must return the complete list of value rule sets of the selected account.');
  if (d.data.length > maxSets + 1)
    fail('STATE_TARGET_MISMATCH', 'Meta returned more value rule sets than an account can hold.');
  const seen = new Set<string>();
  for (const s of d.data) {
    if (!obj(s) || typeof s.id !== 'string' || !numeric.test(s.id) || seen.has(s.id) || typeof s.name !== 'string')
      fail('STATE_TARGET_MISMATCH', 'Value rule sets must have unique IDs and names.');
    seen.add(s.id);
    if (
      (obj(s.rules) && s.rules.paging?.next) ||
      edges(s.rules).some(r => obj(r) && obj(r.criterias) && r.criterias.paging?.next)
    )
      fail('INCOMPLETE_STATE', 'A value rule set was returned incompletely.');
  }
}
/** Stable review state: the sets with their rules and criteria as plain lists, without paging cursors. It accepts its own output. */
export function metaValueRuleState(data: JsonObject): JsonObject {
  return {
    data: (Array.isArray(data.data) ? data.data : []).filter(obj).map((set: JsonObject) => ({
      id: set.id,
      name: set.name,
      rules: edges(set.rules).map(r => ({
        id: r.id,
        name: r.name,
        adjust_sign: r.adjust_sign,
        adjust_value: r.adjust_value,
        status: r.status ?? null,
        criterias: edges(r.criterias).map(c => ({
          id: c.id,
          criteria_type: c.criteria_type,
          operator: c.operator,
          criteria_values: c.criteria_values,
          criteria_value_types: c.criteria_value_types,
        })),
      })),
    })),
  };
}
/** A set as Meta applies it: ordered rules without IDs, criteria sorted by type and value pairs, values in upper case. */
function canonical(set: JsonObject): JsonObject {
  return {
    name: set.name,
    rules: edges(set.rules).map(r => ({
      name: r.name,
      adjust_sign: r.adjust_sign,
      adjust_value: Number(r.adjust_value),
      criterias: edges(r.criterias)
        .map(c => ({
          criteria_type: c.criteria_type,
          values: ((c.criteria_values as string[]) ?? [])
            .map((v, i) => String(c.criteria_value_types?.[i] ?? 'NONE') + ':' + String(v).toUpperCase())
            .sort(),
        }))
        .sort((a, b) => (a.criteria_type < b.criteria_type ? -1 : 1)),
    })),
  };
}
const sets = (v: unknown): JsonObject[] => (obj(v) && Array.isArray(v.data) ? v.data.filter(obj) : []);
export function validateMetaValueRulePrerequisites(plan: CompiledRequest, state: unknown[]): void {
  const kind = metaValueRuleKind(plan);
  if (!kind) return;
  const current = sets(state[0]),
    b = obj(plan.body) ? plan.body : {};
  if (kind === 'create') {
    if (current.length >= maxSets)
      invalid(
        'The ad account already has ' +
          current.length +
          ' value rule sets; Meta allows ' +
          maxSets +
          '. Delete or reuse one.',
      );
    if (current.some(s => String(s.name).toLowerCase() === String(b.name).toLowerCase()))
      fail('CONFIGURATION_EXISTS', 'A value rule set named "' + b.name + '" already exists in this account.', {
        name: b.name,
      });
    return;
  }
  const set = current.find(s => s.id === target(plan));
  if (!set)
    fail('STATE_NOT_FOUND', 'Value rule set ' + target(plan) + ' is not in the selected ad account.', {
      value_rule_set_id: target(plan),
    });
  if (kind === 'delete') return;
  if (current.some(s => s.id !== set!.id && String(s.name).toLowerCase() === String(b.name).toLowerCase()))
    fail('CONFIGURATION_EXISTS', 'Another value rule set is named "' + b.name + '".', {name: b.name});
  const existing = edges(set!.rules);
  for (const r of b.rules as JsonObject[]) {
    const rule = r.id === undefined ? undefined : existing.find(x => x.id === r.id);
    if (r.id !== undefined && !rule)
      fail('STATE_NOT_FOUND', 'Rule ' + r.id + ' is not in value rule set ' + set!.id + '.', {rule_id: r.id});
    for (const c of r.criterias as JsonObject[]) {
      if (c.id === undefined) continue;
      const was = edges(rule?.criterias).find(x => x.id === c.id);
      if (!was) fail('STATE_NOT_FOUND', 'Criterion ' + c.id + ' is not in the rule it names.', {criterion_id: c.id});
      if (was!.criteria_type !== c.criteria_type)
        invalid(
          'Criterion ' +
            c.id +
            ' is a ' +
            was!.criteria_type +
            ' criterion; give a new ' +
            c.criteria_type +
            ' criterion no id.',
        );
    }
  }
  if (stable(canonical({name: b.name, rules: b.rules})) === stable(canonical(set!)))
    invalid('The update does not change value rule set ' + set!.id + '.');
}
export function metaValueRuleImpact(plan: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = metaValueRuleKind(plan);
  if (!kind) return;
  const current = sets(state[0]),
    set = kind === 'create' ? undefined : current.find(s => s.id === target(plan)),
    b = obj(plan.body) ? plan.body : {};
  return {
    provider: 'meta',
    scope: 'value_rule_set',
    action: kind,
    value_rule_set_id: kind === 'create' ? null : target(plan),
    sets_in_account: current.length,
    before: set ? canonical(set) : null,
    after: kind === 'delete' ? null : canonical({name: b.name, rules: b.rules}),
    may_affect_serving: kind !== 'create',
    effect:
      kind === 'create'
        ? 'Creates an unattached value rule set; bids change only after an ad set names it.'
        : kind === 'update'
          ? 'Changes the bid adjustments of every ad set that uses this rule set, at once. Rules apply in order; the first matching rule sets the adjustment.'
          : 'Deletes the rule set; ad sets that use it stop adjusting bids by it.',
    verification: 'Reads the account value rule sets again and compares names, rule order, adjustments and criteria.',
    source: 'https://developers.facebook.com/documentation/ads-commerce/marketing-api/bidding/value-rules',
  };
}
export function metaValueRuleOutcome(plan: CompiledRequest, result: TransportResult): boolean {
  const d = result.data;
  if (result.status !== 200 || !obj(d) || d.error) return false;
  return metaValueRuleKind(plan) === 'create' ? typeof d.id === 'string' && numeric.test(d.id) : d.success === true;
}
export function metaValueRuleVerification(
  plan: CompiledRequest,
  result: JsonObject,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = metaValueRuleKind(plan)!,
    read = metaValueRuleReads(plan)[0]!,
    b = obj(plan.body) ? plan.body : {};
  if (kind === 'delete')
    return [
      {
        read,
        expected: {
          ids: sets(before[0])
            .map(s => s.id as string)
            .filter(id => id !== target(plan))
            .sort(),
        },
        id: 'value rule set ' + target(plan),
      },
    ];
  const id = kind === 'create' ? String(result.data?.id) : target(plan);
  return [{read, expected: {sets: {[id]: canonical({name: b.name, rules: b.rules})}}, id: 'value rule set ' + id}];
}
export function metaValueRuleObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const all = sets(data);
  return {ids: all.map(s => s.id as string).sort(), sets: Object.fromEntries(all.map(s => [s.id, canonical(s)]))};
}
/** Edits and deletion change bidding of the ad sets using the set; creation changes nothing until an ad set names it. */
export function metaValueRuleServing(p: CompiledRequest): boolean {
  const kind = metaValueRuleKind(p);
  return kind === 'update' || kind === 'delete';
}
export function metaValueRuleRemoves(p: CompiledRequest): boolean {
  return metaValueRuleKind(p) === 'delete';
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const metaValueRuleFamily: ReviewedFamily = {
  name: 'meta_value_rules',
  files: ['src/meta-value-rules.ts', ['tests/meta-value-rules.test.mjs']],
  kind: metaValueRuleKind,
  assert: plan => assertMetaValueRule(plan),
  snapshots: metaValueRuleReads,
  isRead: isMetaValueRuleRead,
  validateState: validateMetaValueRuleState,
  snapshotState: (read: CompiledRequest, data: JsonObject) => metaValueRuleState(data),
  prerequisites: (plan, state) => validateMetaValueRulePrerequisites(plan, state),
  impact: metaValueRuleImpact,
  outcome: metaValueRuleOutcome,
  verification: metaValueRuleVerification,
  observed: (read: CompiledRequest, data: JsonObject) =>
    data.amcp_absent === true ? data : metaValueRuleObserved(read, data),
  spendConfirmation: {
    needed: plan => !!metaValueRuleServing(plan),
    message:
      'Editing or deleting a value rule set changes the bids of every ad set that uses it. Review the rules and provide spend_change_confirmed=true.',
  },
  activates: plan => !!metaValueRuleServing(plan),
  destructive: plan => !!metaValueRuleRemoves(plan),
};
