import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {PolicyAmounts, ReviewedFamily} from './reviewed-family.js';
import {metaPrefix, metaRoute} from './meta-version.js';
import {assertNoMethodOverride} from './write-common.js';
import {optionalMetaRead} from './meta-catalogs.js';
import {fail, readOf} from './family-kit.js';

/**
 * Meta automated rules (the Ad Rules Engine), unblocked by the owner on 2026-09-30. Meta's references (read 2026-09-30):
 * "Ad Rules Engine" (POST act_{id}/adrules_library with name, evaluation_spec, execution_spec, schedule_spec and status;
 * "To temporarily turn off a rule, set its status to DISABLED ... To permanently remove a rule, delete it"), "API Calls"
 * (update POST /{ad_rule_id}: "To update a spec, provide all fields, including those that are unchanged ... Updating a
 * rule's status requires no spec changes"; delete DELETE /{ad_rule_id}), "Evaluation Spec", "Execution Spec", "Change
 * Spec" ("limit ... if you increase the budget or bid, this number acts as an upper limit"), "Schedule-based rules",
 * "Trigger based ad rules" and "Rebalance Budget Ad Rules"; Meta's Business SDK 26.0 (AdRule api_update, api_delete).
 *
 * A rule acts later on Meta's schedule, and no AMCP review sees each change it makes. AMCP reviews the rule itself. A
 * rule that only notifies, pauses or lowers budgets and bids needs nothing more. A rule that can raise spend or delivery
 * (budget or bid increases, rebalancing, unpausing, rotating ads) names the objects it acts on with an `id` filter, each
 * of the selected account; an increase carries a `limit`; the account needs a spending policy, whose caps are checked
 * against each object's worst case; and it needs spend_change_confirmed. Webhook pings stay outside: AMCP runs no
 * endpoint for them. The captured catalog maps only creation, so AMCP adds Meta's documented update and delete routes, so
 * that a rule AMCP creates can be disabled or deleted through AMCP.
 */
type Kind = 'create' | 'update' | 'delete';
type State = {kind: Kind; rule?: string; ids: string[]; level?: string; others: string[]; verify?: boolean};
type Read = CompiledRequest & {metaRuleState?: State; metaRulePage?: {object?: string}};
const gateway = 'meta_native_action',
  marker = 'AMCP_META_AD_RULE_READ',
  source = 'https://developers.facebook.com/docs/marketing-api/ad-rules/',
  maxIds = 50;
const actions: Record<string, Kind> = {
  meta_ad_account_id_adrules_library_create: 'create',
  meta_ad_rule_id_update: 'update',
  meta_ad_rule_id_delete: 'delete',
};
const operators = [
    'GREATER_THAN',
    'LESS_THAN',
    'EQUAL',
    'NOT_EQUAL',
    'IN_RANGE',
    'NOT_IN_RANGE',
    'IN',
    'NOT_IN',
    'CONTAIN',
    'NOT_CONTAIN',
    'ANY',
    'ALL',
    'NONE',
  ],
  timePresets = [
    'LIFETIME',
    'TODAY',
    'LAST_2_DAYS',
    'LAST_3_DAYS',
    'LAST_7_DAYS',
    'LAST_14_DAYS',
    'LAST_28_DAYS',
    'LAST_30_DAYS',
    'THIS_MONTH',
    'THIS_WEEK_MON_TODAY',
    'THIS_WEEK_SUN_TODAY',
    'YESTERDAY',
    'LAST_2D',
    'LAST_3D',
    'LAST_7D',
    'LAST_14D',
    'LAST_28D',
    'LAST_30D',
    'LAST_ND_14_8',
    'LAST_ND_30_8',
    'LAST_ND_60_8',
    'LAST_ND_120_8',
    'LAST_ND_180_8',
    'LAST_ND_LIFETIME_8',
    'LAST_ND_60_29',
    'LAST_ND_120_29',
    'LAST_ND_180_29',
    'LAST_ND_LIFETIME_29',
  ],
  triggers = ['METADATA_CREATION', 'METADATA_UPDATE', 'STATS_CHANGE', 'STATS_MILESTONE'],
  /** Execution types with the evaluation types Meta supports for them. PING_ENDPOINT stays outside. */
  executions: Record<string, string[]> = {
    NOTIFICATION: ['SCHEDULE', 'TRIGGER'],
    PAUSE: ['SCHEDULE', 'TRIGGER'],
    UNPAUSE: ['SCHEDULE', 'TRIGGER'],
    CHANGE_BUDGET: ['SCHEDULE'],
    CHANGE_CAMPAIGN_BUDGET: ['SCHEDULE'],
    CHANGE_BID: ['SCHEDULE'],
    ROTATE: ['SCHEDULE'],
    REBALANCE_BUDGET: ['SCHEDULE'],
  },
  optionFields = ['user_ids', 'change_spec', 'rebalance_spec', 'execution_count_limit', 'action_frequency'],
  rebalanceTypes = ['EVEN', 'PROPORTIONAL', 'NO_PAUSE_PROPORTIONAL', 'MATCHED_ONLY_PROPORTIONAL'],
  /** The object level each budget or bid change acts on (Execution Spec). */
  changeLevel: Record<string, string> = {
    CHANGE_BUDGET: 'ADSET',
    CHANGE_CAMPAIGN_BUDGET: 'CAMPAIGN',
    CHANGE_BID: 'ADSET',
    REBALANCE_BUDGET: 'ADSET',
  },
  levelFields: Record<string, string> = {
    CAMPAIGN: 'id,account_id,name,status,effective_status,daily_budget,lifetime_budget',
    ADSET: 'id,account_id,name,status,effective_status,daily_budget,lifetime_budget,bid_amount,campaign_id',
    AD: 'id,account_id,name,status,effective_status,adset_id',
  },
  ruleFields = 'id,account_id,name,status,evaluation_spec,execution_spec,schedule_spec';
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const account = (v: unknown) => String(v ?? '').replace(/^act_/, '');
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v === v.trim() && v.length > 0 && [...v].length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function invalid(message: string): never {
  return fail('INVALID_META_AD_RULE', message, {source});
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function metaRuleKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport || (p.origin && p.origin !== 'https://graph.facebook.com')) return;
  const kind = actions[p.action];
  if (kind === 'create')
    return p.method === 'POST' && metaRoute('act_[1-9][0-9]{0,31}/adrules_library$').test(p.path) ? kind : undefined;
  if (kind === 'update') return p.method === 'POST' && metaRoute('[1-9][0-9]{0,31}$').test(p.path) ? kind : undefined;
  if (kind === 'delete') return p.method === 'DELETE' && metaRoute('[1-9][0-9]{0,31}$').test(p.path) ? kind : undefined;
}
const idOf = (p: CompiledRequest) => p.path.split('/')[2]!;
const body = (p: CompiledRequest): JsonObject => (object(p.body) ? p.body : {});
/** Meta's form parameters arrive as JSON text or objects; the review works on objects. */
function spec(v: unknown): JsonObject | undefined {
  if (typeof v === 'string')
    try {
      const x = JSON.parse(v);
      return object(x) ? x : undefined;
    } catch {
      return undefined;
    }
  return object(v) ? v : undefined;
}
const filtersOf = (e: JsonObject | undefined): JsonObject[] =>
  e && Array.isArray(e.filters) ? (e.filters as JsonObject[]).filter(object) : [];
const optionsOf = (x: JsonObject | undefined): Record<string, unknown> =>
  Object.fromEntries(
    (x && Array.isArray(x.execution_options) ? (x.execution_options as JsonObject[]) : [])
      .filter(object)
      .map(o => [String(o.field), o.value]),
  );
const idList = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).map(x => String(x));
/** The objects a rule names: its unprefixed `id` filter, and the level named by `entity_type`. */
function targets(e: JsonObject | undefined) {
  const f = filtersOf(e);
  const own = f.find(x => x.field === 'id'),
    level = f.find(x => x.field === 'entity_type')?.value,
    others = f
      .filter(x => ['ad.id', 'adset.id', 'campaign.id', 'aggregation_id'].includes(String(x.field)))
      .flatMap(x => idList(x.value));
  return {ids: own ? idList(own.value) : [], level: typeof level === 'string' ? level : undefined, others};
}
/** What a rule can do to spending or delivery. */
function effect(x: JsonObject | undefined): {raises: boolean; activates: boolean; changes: boolean} {
  const type = String(x?.execution_type ?? ''),
    change = optionsOf(x).change_spec as JsonObject | undefined;
  const up = !!change && (change.target_field !== undefined || (num(change.amount) && change.amount > 0));
  return {
    raises:
      type === 'UNPAUSE' ||
      type === 'ROTATE' ||
      type === 'REBALANCE_BUDGET' ||
      (!!changeLevel[type] && type !== 'REBALANCE_BUDGET' && up),
    activates: type === 'UNPAUSE' || type === 'ROTATE',
    changes: !!changeLevel[type] && (type === 'REBALANCE_BUDGET' || up),
  };
}
function checkFilter(f: unknown, at: string): void {
  if (!object(f) || Object.keys(f).some(k => !['field', 'value', 'operator'].includes(k)))
    invalid(at + ' is {field, value, operator}.');
  if (typeof f.field !== 'string' || !/^[A-Za-z0-9_.:()+\-*/ ]{1,200}$/.test(f.field))
    invalid(at + '.field is an Insights or metadata field name.');
  if (!operators.includes(String(f.operator))) invalid(at + '.operator is one of ' + operators.join(', ') + '.');
  const v = f.value;
  const scalar = (x: unknown) => num(x) || typeof x === 'boolean' || (typeof x === 'string' && x.length <= 200);
  if (!(scalar(v) || (Array.isArray(v) && v.length > 0 && v.length <= 200 && v.every(scalar))))
    invalid(at + '.value is a number, text or a list of them.');
  if (f.field === 'time_preset' && (f.operator !== 'EQUAL' || !timePresets.includes(String(v))))
    invalid('time_preset is EQUAL to one of ' + timePresets.join(', ') + '.');
  if (f.field === 'attribution_window' && (f.operator !== 'EQUAL' || v !== 'ACCOUNT_DEFAULT'))
    invalid('attribution_window is EQUAL to ACCOUNT_DEFAULT, the only value Meta allows.');
  if (f.field === 'entity_type' && (f.operator !== 'EQUAL' || !['AD', 'ADSET', 'CAMPAIGN'].includes(String(v))))
    invalid('entity_type is EQUAL to AD, ADSET or CAMPAIGN.');
  if (['id', 'ad.id', 'adset.id', 'campaign.id', 'aggregation_id'].includes(f.field)) {
    const ids = idList(v);
    if (
      !['EQUAL', 'IN', 'NOT_IN'].includes(String(f.operator)) ||
      !ids.length ||
      ids.length > maxIds ||
      !ids.every(numeric)
    )
      invalid(f.field + ' lists 1 to ' + maxIds + ' numeric IDs with EQUAL, IN or NOT_IN.');
  }
}
function checkEvaluation(e: JsonObject | undefined): JsonObject {
  if (!e || Object.keys(e).some(k => !['evaluation_type', 'filters', 'trigger'].includes(k)))
    invalid('evaluation_spec is {evaluation_type, filters, trigger?}.');
  if (!['SCHEDULE', 'TRIGGER'].includes(String(e.evaluation_type))) invalid('evaluation_type is SCHEDULE or TRIGGER.');
  const f = e.filters;
  if (!Array.isArray(f) || !f.length || f.length > 50) invalid('evaluation_spec.filters lists 1 to 50 filters.');
  f.forEach((x, i) => checkFilter(x, 'filters[' + i + ']'));
  const fields = f.map(x => (x as JsonObject).field);
  if (!fields.includes('entity_type') && !fields.includes('id'))
    invalid('Meta requires an entity_type or id filter on every rule (Evaluation Spec).');
  for (const once of ['time_preset', 'attribution_window', 'entity_type', 'id'])
    if (fields.filter(x => x === once).length > 1) invalid('A rule has one ' + once + ' filter.');
  if (e.evaluation_type === 'TRIGGER') {
    const t = e.trigger;
    if (!object(t) || Object.keys(t).some(k => !['type', 'field', 'value', 'operator'].includes(k)))
      invalid('A TRIGGER rule has one trigger {type, field, value, operator}.');
    if (!triggers.includes(String(t.type))) invalid('trigger.type is one of ' + triggers.join(', ') + '.');
    if (t.type !== 'METADATA_CREATION' && (typeof t.field !== 'string' || !t.field))
      invalid('trigger.field is required except for METADATA_CREATION.');
    if (t.type === 'STATS_MILESTONE' && t.operator !== 'EQUAL')
      invalid('A STATS_MILESTONE trigger uses EQUAL (Trigger based ad rules).');
    if (t.operator !== undefined && !operators.includes(String(t.operator)))
      invalid('trigger.operator is one of ' + operators.join(', ') + '.');
  } else if (e.trigger !== undefined) invalid('Only TRIGGER rules have a trigger.');
  return e;
}
function checkExecution(x: JsonObject | undefined, evaluation: string): JsonObject {
  if (!x || Object.keys(x).some(k => !['execution_type', 'execution_options'].includes(k)))
    invalid('execution_spec is {execution_type, execution_options?}.');
  const type = String(x.execution_type);
  if (type === 'PING_ENDPOINT')
    invalid(
      'PING_ENDPOINT pings a webhook subscription of the app, and AMCP runs no endpoint for it. Use NOTIFICATION.',
    );
  if (!executions[type]) invalid('execution_type is one of ' + Object.keys(executions).join(', ') + '.');
  if (!executions[type]!.includes(evaluation))
    invalid(type + ' runs only in ' + executions[type]!.join(' or ') + ' rules (Execution Spec).');
  const opts = x.execution_options;
  if (opts !== undefined && (!Array.isArray(opts) || opts.length > optionFields.length))
    invalid('execution_options lists {field, value, operator: "EQUAL"} options.');
  const seen = new Set<string>();
  for (const o of (opts ?? []) as unknown[]) {
    if (!object(o) || Object.keys(o).some(k => !['field', 'value', 'operator'].includes(k)) || o.operator !== 'EQUAL')
      invalid('Each execution option is {field, value, operator: "EQUAL"}, the only operator Meta supports.');
    if (!optionFields.includes(String(o.field))) invalid('Execution options are ' + optionFields.join(', ') + '.');
    if (seen.has(String(o.field))) invalid('Each execution option appears once.');
    seen.add(String(o.field));
  }
  const o = optionsOf(x);
  if (o.user_ids !== undefined) {
    const u = o.user_ids;
    if (!Array.isArray(u) || !u.length || u.length > 50 || !u.every(v => numeric(String(v))))
      invalid('user_ids lists 1 to 50 numeric user IDs.');
  }
  for (const k of ['execution_count_limit', 'action_frequency'])
    if (o[k] !== undefined && !(Number.isSafeInteger(o[k]) && (o[k] as number) > 0))
      invalid(k + ' is a positive whole number.');
  const budgetOrBid = ['CHANGE_BUDGET', 'CHANGE_CAMPAIGN_BUDGET', 'CHANGE_BID'].includes(type);
  if (budgetOrBid) {
    const c = o.change_spec;
    if (!object(c) || Object.keys(c).some(k => !['amount', 'limit', 'unit', 'target_field'].includes(k)))
      invalid(type + ' needs change_spec {amount, unit, limit?, target_field?}.');
    if (!num(c.amount) || c.amount === 0) invalid('change_spec.amount is a number other than 0.');
    if (c.target_field === undefined && !['PERCENTAGE', 'ACCOUNT_CURRENCY'].includes(String(c.unit)))
      invalid('change_spec.unit is PERCENTAGE or ACCOUNT_CURRENCY unless target_field is set.');
    if (c.target_field !== undefined) {
      if (typeof c.target_field !== 'string' || !/^[a-z0-9_]{1,100}$/.test(c.target_field))
        invalid('change_spec.target_field is an Insights field.');
      const range = c.limit;
      if (!Array.isArray(range) || range.length !== 2 || !range.every(num) || range[0]! >= range[1]!)
        invalid('With target_field, change_spec.limit is [lowest, highest] (Change Spec), which bounds the scaling.');
    } else if (c.amount > 0 && !(num(c.limit) && c.limit > 0))
      invalid(
        'An increase needs change_spec.limit, the highest ' +
          (type === 'CHANGE_BID' ? 'bid' : 'budget') +
          ' Meta may set, in minor units of the account currency.',
      );
    else if (c.limit !== undefined && !(num(c.limit) && c.limit >= 0))
      invalid('change_spec.limit is an amount in minor units.');
  } else if (o.change_spec !== undefined)
    invalid('change_spec applies to CHANGE_BUDGET, CHANGE_CAMPAIGN_BUDGET and CHANGE_BID.');
  if (type === 'REBALANCE_BUDGET') {
    const r = o.rebalance_spec;
    if (
      !object(r) ||
      Object.keys(r).some(k => !['type', 'target_field', 'target_count', 'is_cross_campaign', 'is_inverse'].includes(k))
    )
      invalid(
        'REBALANCE_BUDGET needs rebalance_spec {type, target_field?, target_count?, is_cross_campaign?, is_inverse?}.',
      );
    if (!rebalanceTypes.includes(String(r.type)))
      invalid('rebalance_spec.type is one of ' + rebalanceTypes.join(', ') + '.');
    if ((r.type !== 'EVEN' || r.target_count !== undefined) && (typeof r.target_field !== 'string' || !r.target_field))
      invalid('rebalance_spec.target_field is required unless type is EVEN without target_count.');
    if (r.target_count !== undefined && !(Number.isSafeInteger(r.target_count) && (r.target_count as number) > 0))
      invalid('rebalance_spec.target_count is a positive whole number.');
  } else if (o.rebalance_spec !== undefined) invalid('rebalance_spec applies to REBALANCE_BUDGET.');
  return x;
}
function checkSchedule(s: JsonObject | undefined): void {
  if (!s || Object.keys(s).some(k => !['schedule_type', 'schedule'].includes(k)))
    invalid('schedule_spec is {schedule_type, schedule?}.');
  if (!['DAILY', 'HOURLY', 'SEMI_HOURLY', 'CUSTOM'].includes(String(s.schedule_type)))
    invalid('schedule_type is DAILY, HOURLY, SEMI_HOURLY or CUSTOM.');
  if (s.schedule_type !== 'CUSTOM') {
    if (s.schedule !== undefined) invalid('Only CUSTOM schedules list times.');
    return;
  }
  const list = s.schedule;
  if (!Array.isArray(list) || !list.length || list.length > 50) invalid('A CUSTOM schedule lists 1 to 50 entries.');
  for (const e of list as unknown[]) {
    if (!object(e) || Object.keys(e).some(k => !['start_minute', 'end_minute', 'days'].includes(k)))
      invalid('A schedule entry is {start_minute?, end_minute?, days?}.');
    if (e.start_minute === undefined && e.days === undefined) invalid('Each schedule entry has start_minute or days.');
    const minute = (v: unknown) =>
      Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < 1440 && (v as number) % 30 === 0;
    if (e.start_minute !== undefined && !minute(e.start_minute))
      invalid('start_minute is minutes after midnight, a multiple of 30.');
    if (
      e.end_minute !== undefined &&
      (!minute(e.end_minute) || e.start_minute === undefined || (e.end_minute as number) < (e.start_minute as number))
    )
      invalid('end_minute is a multiple of 30, not before start_minute.');
    if (e.days !== undefined) {
      const d = e.days;
      if (
        !Array.isArray(d) ||
        !d.length ||
        !d.every(x => Number.isSafeInteger(x) && x >= 0 && x <= 6) ||
        new Set(d).size !== d.length
      )
        invalid('days lists different days from 0 (Sunday) to 6 (Saturday).');
    }
  }
}
/** The rule's full definition, validated: the one sent by a create or a full update. */
function checkRule(b: JsonObject): void {
  const e = checkEvaluation(spec(b.evaluation_spec)),
    x = checkExecution(spec(b.execution_spec), String(e.evaluation_type));
  if (e.evaluation_type === 'SCHEDULE') checkSchedule(spec(b.schedule_spec));
  else if (b.schedule_spec !== undefined)
    invalid('TRIGGER rules take no schedule_spec: Meta checks them in real time.');
  const t = targets(e),
    type = String(x.execution_type),
    fx = effect(x);
  if (fx.raises) {
    // A rule that can raise spend or delivery names what it acts on, so the review can list it and bound it.
    if (type === 'ROTATE') {
      if (!filtersOf(e).some(f => f.field === 'adset.id') || t.level !== 'AD')
        invalid('ROTATE needs an adset.id filter and entity_type AD (Execution Spec).');
    } else if (!t.ids.length || filtersOf(e).find(f => f.field === 'id')?.operator === 'NOT_IN')
      invalid(
        'A rule that can raise spend or delivery names the objects it acts on with an id filter (IN or EQUAL), so the review can list and bound each one.',
      );
    if (changeLevel[type] && t.level !== changeLevel[type])
      invalid(type + ' acts on ' + changeLevel[type] + ' objects: add entity_type ' + changeLevel[type] + '.');
    if (type === 'UNPAUSE' && !t.level) invalid('Name the level of the objects with entity_type.');
  }
}
export function assertMetaRule(p: CompiledRequest): void {
  const kind = metaRuleKind(p);
  if (!kind) return;
  assertNoMethodOverride(p);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Rule writes take their parameters in the body, without query or header overrides.');
  const b = p.body === undefined ? {} : p.body;
  if (!object(b)) invalid('Send the rule as an object.');
  if (kind === 'delete') {
    if (Object.keys(b).length) invalid('Deletion takes only the rule in the path.');
    return;
  }
  const fields = ['name', 'evaluation_spec', 'execution_spec', 'schedule_spec', 'status'];
  const extra = Object.keys(b).filter(k => !fields.includes(k));
  if (extra.length) invalid('A rule takes ' + fields.join(', ') + '; unqualified: ' + extra.join(', ') + '.');
  if (b.status !== undefined && !['ENABLED', 'DISABLED'].includes(String(b.status)))
    invalid('status is ENABLED or DISABLED.');
  if (kind === 'update' && Object.keys(b).length === 1 && b.status !== undefined) return;
  if (kind === 'create' && b.status === undefined)
    invalid('Name the status, ENABLED or DISABLED: a rule acts as soon as it is enabled.');
  if (!text(b.name, 255)) invalid('name has 1 to 255 characters without surrounding spaces or control characters.');
  // "To update a spec, provide all fields, including those that are unchanged" (API Calls).
  if (b.evaluation_spec === undefined || b.execution_spec === undefined)
    invalid('Send evaluation_spec and execution_spec whole: Meta replaces them, so an update restates every field.');
  checkRule(b);
}
const graph = (p: CompiledRequest, path: string, query: JsonObject, page: {object?: string} = {}): Read =>
  readOf<Read>(p, {
    before: {metaRuleState: undefined, metaRulePage: page},
    action: marker,
    path: metaPrefix + path,
    query,
  });
const accountRead = (p: CompiledRequest, s: State): Read => ({
  ...graph(p, 'act_' + account(p.accountId), {fields: 'id,account_id,currency'}),
  metaRuleState: s,
});
export function metaRuleSnapshots(p: CompiledRequest): Read[] {
  const kind = metaRuleKind(p)!,
    b = body(p),
    t = targets(spec(b.evaluation_spec));
  return [
    accountRead(p, {
      kind,
      ...(kind === 'create' ? {} : {rule: idOf(p)}),
      ids: [...new Set(t.ids)].sort(),
      ...(t.level ? {level: t.level} : {}),
      others: [...new Set(t.others)].sort(),
    }),
  ];
}
export function isMetaRuleRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).metaRuleState;
}
/** Writes after validation, and the family's reads: the account, the rule and each object the rule names. */
export function authorizeMetaRule(p: CompiledRequest, c: Connection, selected: string): boolean {
  if (metaRuleKind(p)) {
    assertMetaRule(p);
    if (!c.scopes.includes('ads_management'))
      fail(
        'INSUFFICIENT_SCOPE',
        'Rule changes need the ads_management permission.',
        {required: ['ads_management']},
        403,
      );
    if (account(p.accountId) !== selected)
      fail('ACCOUNT_SCOPE_MISMATCH', 'Select the ad account the rule belongs to.', {}, 403);
    return true;
  }
  const r = p as Read;
  if (p.gateway !== gateway || p.action !== marker) return false;
  if (p.method !== 'GET' || !p.readOnly || p.body !== undefined || account(p.accountId) !== selected)
    return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal rule read.', {}, 403);
  const keys = Object.keys(p.query).join();
  if (p.path === metaPrefix + 'act_' + selected && keys === 'fields' && p.query.fields === 'id,account_id,currency')
    return true;
  const o = r.metaRulePage?.object;
  if (
    o &&
    numeric(o) &&
    p.path === metaPrefix + o &&
    keys === 'fields' &&
    [ruleFields, 'id,account_id', ...Object.values(levelFields)].includes(String(p.query.fields))
  )
    return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal rule read.', {}, 403);
}
const budgetView = (x: JsonObject) => ({
  id: String(x.id),
  name: x.name ?? null,
  status: x.status ?? null,
  daily_budget: x.daily_budget == null ? null : Number(x.daily_budget),
  lifetime_budget: x.lifetime_budget == null ? null : Number(x.lifetime_budget),
  ...(x.bid_amount !== undefined ? {bid_amount: x.bid_amount == null ? null : Number(x.bid_amount)} : {}),
});
/** A spec as AMCP compares it: filters and options keyed by field, values as text, ID lists sorted. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) {
    const items = v.map(canonical);
    return items.every(x => typeof x === 'string') ? [...(items as string[])].sort() : items;
  }
  if (!object(v)) return v === null || v === undefined ? null : String(v);
  const out: JsonObject = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === 'filters' && Array.isArray(x))
      out.filters = Object.fromEntries(
        (x as JsonObject[]).filter(object).map(f => [String(f.field) + ' ' + String(f.operator), canonical(f.value)]),
      );
    else if (k === 'execution_options' && Array.isArray(x))
      out.execution_options = Object.fromEntries(
        (x as JsonObject[]).filter(object).map(o => [String(o.field), canonical(o.value)]),
      );
    else out[k] = canonical(x);
  }
  return out;
}
const ruleView = (x: JsonObject): JsonObject => ({
  present: x.status !== 'DELETED',
  id: String(x.id),
  account_id: x.account_id == null ? null : account(x.account_id),
  name: x.name ?? null,
  status: x.status ?? null,
  evaluation_spec: canonical(spec(x.evaluation_spec) ?? null),
  execution_spec: canonical(spec(x.execution_spec) ?? null),
  schedule_spec: canonical(spec(x.schedule_spec) ?? null),
});
/** The account; for a change or deletion the rule; the objects the rule names, each checked against the account. */
export async function readMetaRules(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).metaRuleState;
  if (!s) return fetch(p);
  const rule = async (id: string) => {
    const x = await optionalMetaRead(fetch, graph(p, id, {fields: ruleFields}, {object: id}), 'rule');
    return x ? ruleView(x) : {present: false, id};
  };
  if (s.verify) return {status: 200, headers: {}, data: {rule: await rule(s.rule!)}};
  const acct = await optionalMetaRead(
    fetch,
    graph(p, 'act_' + account(p.accountId), {fields: 'id,account_id,currency'}),
    'ad account',
  );
  if (!acct) unverified('Meta did not return the ad account.');
  const out: JsonObject = {account_id: account(p.accountId), currency: acct.currency ?? null};
  let ids = s.ids,
    level = s.level,
    others = s.others;
  if (s.rule) {
    const r = await rule(s.rule);
    out.rule = r;
    // A status-only change acts on the rule as it stands: read the objects it names.
    if (!ids.length && !others.length && r.present) {
      const t = targets(r.evaluation_spec ? restore(r.evaluation_spec as JsonObject) : undefined);
      ids = t.ids;
      level = t.level;
      others = t.others;
    }
  }
  const objects: JsonObject = {},
    foreign: string[] = [];
  for (const id of ids) {
    const fields = (level && levelFields[level]) || 'id,account_id';
    const x = await optionalMetaRead(fetch, graph(p, id, {fields}, {object: id}), 'object ' + id);
    if (!x || account(x.account_id) !== out.account_id) foreign.push(id);
    else objects[id] = budgetView(x);
  }
  for (const id of others) {
    const x = await optionalMetaRead(fetch, graph(p, id, {fields: 'id,account_id'}, {object: id}), 'object ' + id);
    if (!x || account(x.account_id) !== out.account_id) foreign.push(id);
  }
  out.objects = objects;
  out.foreign = [...new Set(foreign)].sort();
  return {status: 200, headers: {}, data: out};
}
/** The canonical filters back into Meta's list form, for reading the objects of a rule as it stands. */
function restore(e: JsonObject): JsonObject {
  const f = object(e.filters) ? e.filters : {};
  return {
    ...e,
    filters: Object.entries(f).map(([k, v]) => {
      const [field, operator] = k.split(' ');
      return {field, operator, value: v};
    }),
  };
}
export function validateMetaRuleState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).metaRuleState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || (s.verify ? !object(d.rule) : !object(d.objects)))
    unverified('Missing verified rule state.');
}
/** The rule a request leaves in place: the one sent, or for a status-only change the one Meta holds. */
function effective(p: CompiledRequest, s: JsonObject): {x?: JsonObject; status: string} {
  const b = body(p),
    r = object(s.rule) ? s.rule : undefined;
  const x =
    b.execution_spec !== undefined
      ? spec(b.execution_spec)
      : r?.execution_spec
        ? (restoreOptions(r.execution_spec as JsonObject) as JsonObject)
        : undefined;
  return {x, status: String(b.status ?? r?.status ?? '')};
}
function restoreOptions(x: JsonObject): JsonObject {
  const o = object(x.execution_options) ? x.execution_options : {};
  const back = (v: unknown): unknown =>
    typeof v === 'string' && v !== '' && !isNaN(Number(v))
      ? Number(v)
      : Array.isArray(v)
        ? v.map(back)
        : object(v)
          ? Object.fromEntries(Object.entries(v).map(([k, y]) => [k, back(y)]))
          : v;
  return {
    execution_type: x.execution_type,
    execution_options: Object.entries(o).map(([field, value]) => ({field, value: back(value), operator: 'EQUAL'})),
  };
}
export function metaRulePrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = metaRuleKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.objects)) unverified('Missing verified rule state.');
  if (kind !== 'create') {
    const r = s.rule;
    if (!object(r) || r.present === false)
      fail('STATE_NOT_FOUND', 'Rule ' + idOf(p) + ' was not found.', {ad_rule_id: idOf(p)}, 404);
    if (r.account_id !== s.account_id)
      fail('STATE_TARGET_MISMATCH', 'Rule ' + idOf(p) + ' belongs to another ad account.', {ad_rule_id: idOf(p)}, 409);
    if (kind === 'delete') return;
    const b = body(p);
    if (Object.keys(b).length === 1 && b.status === r.status)
      invalid('Rule ' + idOf(p) + ' is already ' + String(r.status) + '.');
  }
  const foreign = Array.isArray(s.foreign) ? (s.foreign as string[]) : [];
  if (foreign.length)
    fail(
      'STATE_TARGET_MISMATCH',
      'Not objects of the selected ad account: ' +
        foreign.join(', ') +
        '. A rule names only objects of its own account.',
      {ids: foreign},
      409,
    );
}
/** Each named object's worst case under the rule: the change's limit, or for rebalancing every budget moved to one. */
function worstCase(
  x: JsonObject | undefined,
  objects: JsonObject[],
): {id: string; key: string; before: number; after: number}[] {
  const type = String(x?.execution_type ?? ''),
    change = optionsOf(x).change_spec as JsonObject | undefined;
  if (!effect(x).changes) return [];
  const budgetKey = (o: JsonObject) =>
    o.daily_budget != null && Number(o.daily_budget) > 0 ? 'daily_budget' : 'lifetime_budget';
  if (type === 'REBALANCE_BUDGET') {
    const out: {id: string; key: string; before: number; after: number}[] = [];
    for (const key of ['daily_budget', 'lifetime_budget']) {
      const bucket = objects.filter(o => budgetKey(o) === key && o[key] != null);
      const total = bucket.reduce((n, o) => n + Number(o[key]), 0);
      for (const o of bucket) out.push({id: String(o.id), key, before: Number(o[key]), after: total});
    }
    return out;
  }
  const cap = Array.isArray(change?.limit) ? Number((change!.limit as number[])[1]) : Number(change?.limit);
  return objects.map(o => {
    const key = type === 'CHANGE_BID' ? 'bid_amount' : budgetKey(o);
    return {id: String(o.id), key, before: Number(o[key] ?? 0), after: Math.max(cap, Number(o[key] ?? 0))};
  });
}
export function metaRulePolicyAmounts(p: CompiledRequest, before: unknown): PolicyAmounts | undefined {
  const kind = metaRuleKind(p);
  if (!kind || kind === 'delete') return;
  const s = Array.isArray(before) ? before[0] : before;
  if (!object(s)) return {creating: false, amounts: [], old: []};
  const {x, status} = effective(p, s);
  if (status !== 'ENABLED') return {creating: false, amounts: [], old: []};
  const w = worstCase(x, Object.values(object(s.objects) ? s.objects : {}) as JsonObject[]);
  return {
    creating: false,
    amounts: w.map(v => ({path: '/rules/' + v.id + '/' + v.key, key: v.key, amount: v.after})),
    old: w.map(v => ({path: '/rules/' + v.id + '/' + v.key, key: v.key, amount: v.before})),
  };
}
/** Whether the request can leave an enabled rule that raises spend or delivery. A status-only enable counts. */
function raisingRequest(p: CompiledRequest): boolean {
  const kind = metaRuleKind(p),
    b = body(p);
  if (!kind || kind === 'delete' || b.status === 'DISABLED') return false;
  if (b.execution_spec === undefined) return b.status === 'ENABLED';
  return effect(spec(b.execution_spec)).raises;
}
export function metaRuleImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = metaRuleKind(p);
  if (!kind) return;
  const s: JsonObject = object(state[0]) ? state[0] : {},
    b = body(p),
    r = object(s.rule) ? s.rule : null,
    objects = Object.values(object(s.objects) ? s.objects : {}) as JsonObject[];
  if (kind === 'delete')
    return {
      provider: 'meta',
      scope: 'ad_rule',
      operation: 'delete',
      deleting: r,
      may_affect_serving: false,
      effect: 'Deletes the rule: Meta stops running it. Changes it already made stay.',
      verification: 'Reads the rule again and expects it to be gone or DELETED.',
      source: source + 'guides/api-calls',
    };
  const {x, status} = effective(p, s),
    fx = effect(x),
    w = worstCase(x, objects);
  const statusOnly = Object.keys(b).length === 1 && b.status !== undefined;
  return {
    provider: 'meta',
    scope: 'ad_rule',
    operation: statusOnly ? (b.status === 'ENABLED' ? 'enable' : 'disable') : kind,
    currency: s.currency ?? null,
    ...(kind === 'create' ? {creating: {...b}} : statusOnly ? {rule: r} : {before: r, after: {...b}}),
    status_after: status,
    acts_on: objects.length ? objects : 'the objects the filters select, including ones created later',
    ...(w.length ? {worst_case: w} : {}),
    raises_spend_or_delivery: fx.raises,
    warning:
      'Meta runs this rule on its own schedule, and AMCP does not review each change it makes. Disable or delete it with meta_ad_rule_id_update (status DISABLED) or meta_ad_rule_id_delete.' +
      (fx.raises ? ' Each named object is bounded as shown and checked against the spending policy.' : ''),
    may_affect_serving: status === 'ENABLED' && (fx.raises || String(x?.execution_type) === 'PAUSE'),
    effect:
      status === 'ENABLED'
        ? 'The rule runs as soon as it is enabled: ' +
          String(x?.execution_type ?? 'its action') +
          ' on every object that passes its filters.'
        : 'The rule is saved disabled and does nothing until it is enabled.',
    verification: 'Reads the rule again and compares name, status and every spec sent.',
    source,
  };
}
export function metaRuleOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = metaRuleKind(p)!,
    d = r.data;
  if (r.status !== 200 || !object(d) || d.error) return false;
  if (kind === 'create') return numeric(String(d.id ?? ''));
  return d.success === true || String(d.id ?? '') === idOf(p);
}
export function metaRuleVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = metaRuleKind(p)!,
    id = kind === 'create' ? String(result.data?.id ?? '') : idOf(p),
    b = body(p);
  if (!numeric(id)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no rule.');
  const expected: JsonObject =
    kind === 'delete'
      ? {present: false}
      : {
          present: true,
          id,
          ...(b.status !== undefined ? {status: b.status} : {}),
          ...(b.name !== undefined ? {name: b.name} : {}),
          ...(b.evaluation_spec !== undefined ? {evaluation_spec: canonical(spec(b.evaluation_spec))} : {}),
          ...(b.execution_spec !== undefined ? {execution_spec: canonical(spec(b.execution_spec))} : {}),
          ...(b.schedule_spec !== undefined ? {schedule_spec: canonical(spec(b.schedule_spec))} : {}),
        };
  return [
    {
      read: accountRead(p, {kind, rule: id, ids: [], others: [], verify: true}),
      expected: {rule: expected},
      id: 'ad rule ' + id,
    },
  ];
}
export function metaRuleObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  const r = object(data.rule) ? data.rule : null;
  return {rule: r && r.present === false ? {present: false} : r};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const metaRuleFamily: ReviewedFamily = {
  name: 'meta_ad_rules',
  files: ['src/meta-ad-rules.ts', ['tests/meta-ad-rules.test.mjs']],
  kind: metaRuleKind,
  assert: plan => assertMetaRule(plan),
  authorize: authorizeMetaRule,
  snapshots: metaRuleSnapshots,
  isRead: isMetaRuleRead,
  reader: readMetaRules,
  validateState: validateMetaRuleState,
  prerequisites: metaRulePrerequisites,
  impact: metaRuleImpact,
  outcome: metaRuleOutcome,
  verification: metaRuleVerification,
  observed: metaRuleObserved,
  policyAmounts: (plan, before) => metaRulePolicyAmounts(plan, before),
  requiresSpendPolicy: plan => raisingRequest(plan),
  spendConfirmation: {
    needed: plan => raisingRequest(plan),
    message:
      'This rule can raise spending or delivery on its own schedule, within the limits the review shows. Review them and provide spend_change_confirmed=true.',
  },
  activates: (plan, before) => {
    if (!raisingRequest(plan)) return false;
    const b = body(plan),
      s = Array.isArray(before) ? before[0] : before,
      x = b.execution_spec !== undefined ? spec(b.execution_spec) : object(s) ? effective(plan, s).x : undefined;
    return effect(x).activates || b.execution_spec === undefined;
  },
  exemptFromSpendTextMatch: true,
  exemptFromActivationScan: true,
  destructive: plan => metaRuleKind(plan) === 'delete',
};
