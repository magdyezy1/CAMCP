import {MirrorError} from './errors.js';
import {assertGoogleAdsScope} from './google-contracts.js';
import type {Classify, ReadBuilder, ReviewedFamily, VerificationRead} from './reviewed-family.js';
import type {TransportResult} from './transport.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {snake} from './write-common.js';

/**
 * Customer lifecycle goals, Google Ads API v25 (F-80). v25 has no lifecycle goal configuration: new customer
 * acquisition, retention and loyalty retention are goals (GoalService.MutateGoals, `customers/{id}/Goals:mutate`) and
 * a campaign optimizes for one through a campaign goal config (CampaignGoalConfigService, `CampaignGoalConfigs:mutate`).
 * Pinned v25 Discovery document and the live one (revision 20260923); the Goal, CampaignGoalConfig, GoalError and
 * CampaignGoalConfigError references, read 2026-09-29.
 *
 * A goal carries exactly one settings block, which fixes its type; one goal of each type per customer
 * (…_GOAL_ALREADY_EXISTS). Value settings: a high lifetime value needs a value and must exceed it, and a high lifetime
 * value multiplier needs a value multiplier and must exceed it. A campaign goal config links one campaign to one goal
 * (both immutable) with the settings block of the goal's type; new customer acquisition that targets new customers
 * only (TARGET_SPECIFIC) takes no override values. Goals are created and updated, never removed; configs are also
 * removed. These settings change the conversion values bidding optimizes for, so every change needs
 * spend_change_confirmed, and removing a config counts as a deletion under an owner policy.
 */
type Kind = 'goals' | 'configs';
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const snakeKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(snakeKeys)
    : object(v)
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [snake(k), snakeKeys(x)]))
      : v;
function invalid(message: string, field: string, extra: JsonObject = {}): never {
  throw new MirrorError('INVALID_GOOGLE_LIFECYCLE_GOAL', message, {field, ...extra});
}
export function googleLifecycleGoalKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== 'google_ads_native_action' || p.method !== 'POST') return;
  const m = /^\/v\d+\/customers\/\d+\/(Goals|CampaignGoalConfigs):mutate$/.exec(p.path)?.[1];
  return m === 'Goals' ? 'goals' : m === 'CampaignGoalConfigs' ? 'configs' : undefined;
}
// The settings block of each goal type, on a goal and on a campaign goal config.
const goalSettings: Record<string, string> = {
  new_customer_acquisition_goal_settings: 'NEW_CUSTOMER_ACQUISITION',
  retention_goal_settings: 'CUSTOMER_RETENTION',
  loyalty_retention_goal_settings: 'LOYALTY_RETENTION',
};
const configSettings: Record<string, {type: string; fields: string[]}> = {
  campaign_new_customer_acquisition_settings: {
    type: 'NEW_CUSTOMER_ACQUISITION',
    fields: ['target_option', 'value_settings_override'],
  },
  campaign_retention_settings: {type: 'CUSTOMER_RETENTION', fields: ['target_option', 'value_settings_override']},
  campaign_loyalty_retention_settings: {
    type: 'LOYALTY_RETENTION',
    fields: [
      'enable_bid_adjustments_for_loyalty_members',
      'value_settings_override',
      'show_targeted_loyalty_member_benefits_in_pla',
    ],
  },
};
const valueFields = [
  'value_multiplier',
  'high_lifetime_value_multiplier',
  'additional_value',
  'additional_high_lifetime_value',
];
const account = (p: CompiledRequest) => /\/customers\/(\d+)\//.exec(p.path)![1]!;
interface Op {
  index: number;
  type: 'create' | 'update' | 'remove';
  /** The record sent (create, update), keys in snake_case; the resource name for a remove. */
  record: JsonObject;
  name?: string;
  mask: string[];
  /** The settings block the record carries. */
  block?: string;
}
/** The documented value-setting relations (GoalError, CampaignGoalConfigError). */
function checkValues(v: unknown, where: string) {
  if (v === undefined) return;
  if (!object(v)) invalid(where + ' must be an object of ' + valueFields.join(', ') + '.', where);
  for (const [k, x] of Object.entries(v)) {
    if (!valueFields.includes(k))
      invalid(where + '.' + k + ' is not a value setting.', where + '.' + k, {allowed: valueFields});
    if (typeof x !== 'number' || !Number.isFinite(x)) invalid(where + '.' + k + ' must be a number.', where + '.' + k);
  }
  const pair = (high: string, base: string) => {
    if (v[high] === undefined) return;
    if (v[base] === undefined) invalid(where + '.' + high + ' needs ' + base + ' as well.', where + '.' + base);
    if (!(v[high] > v[base])) invalid(where + '.' + high + ' must be greater than ' + base + '.', where + '.' + high);
  };
  pair('high_lifetime_value_multiplier', 'value_multiplier');
  pair('additional_high_lifetime_value', 'additional_value');
}
function checkBlock(kind: Kind, block: string, value: unknown, where: string) {
  if (!object(value)) invalid(where + ' must be an object.', where);
  const allowed = kind === 'goals' ? ['value_settings'] : configSettings[block]!.fields;
  for (const k of Object.keys(value))
    if (!allowed.includes(k))
      invalid(where + '.' + k + ' is not a field of ' + block + '.', where + '.' + k, {allowed});
  checkValues(
    value.value_settings ?? value.value_settings_override,
    where + (kind === 'goals' ? '.value_settings' : '.value_settings_override'),
  );
  if (value.target_option !== undefined && !['TARGET_ALL', 'TARGET_SPECIFIC'].includes(value.target_option))
    invalid(where + '.target_option must be TARGET_ALL or TARGET_SPECIFIC.', where + '.target_option');
  for (const flag of ['enable_bid_adjustments_for_loyalty_members', 'show_targeted_loyalty_member_benefits_in_pla'])
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean')
      invalid(where + '.' + flag + ' must be true or false.', where + '.' + flag);
  if (
    block === 'campaign_new_customer_acquisition_settings' &&
    value.target_option === 'TARGET_SPECIFIC' &&
    value.value_settings_override !== undefined
  )
    invalid(
      where + ': new customer acquisition that targets new customers only (TARGET_SPECIFIC) takes no override values.',
      where + '.value_settings_override',
    );
}
/** The request's operations, checked against the contract before any read. */
function operations(p: CompiledRequest): Op[] {
  const kind = googleLifecycleGoalKind(p)!,
    id = account(p),
    body = snakeKeys(p.body) as JsonObject;
  if (!object(body)) invalid('Send {operations: [...]}.', 'payload');
  const unknown = Object.keys(body).filter(k => !['operations', 'partial_failure'].includes(k));
  if (unknown.length)
    invalid(
      'This request takes operations and optionally partial_failure: false; ' +
        unknown.join(', ') +
        ' is not accepted.',
      unknown[0]!,
      {allowed: ['operations', 'partial_failure']},
    );
  if (body.partial_failure !== undefined && body.partial_failure !== false)
    invalid('partial_failure must be false or omitted: every operation applies, or none.', 'partial_failure');
  if (!Array.isArray(body.operations) || !body.operations.length || body.operations.length > 25)
    invalid('Send 1–25 operations.', 'operations');
  const blocks = kind === 'goals' ? Object.keys(goalSettings) : Object.keys(configSettings),
    names = new Set<string>(),
    pattern =
      kind === 'goals'
        ? new RegExp('^customers/' + id + '/goals/[1-9][0-9]*$')
        : new RegExp('^customers/' + id + '/campaignGoalConfigs/[1-9][0-9]*~[1-9][0-9]*$');
  return body.operations.map((raw: unknown, index: number): Op => {
    const where = 'operations[' + index + ']';
    if (!object(raw)) invalid(where + ' must be an object.', where);
    const types = (['create', 'update', 'remove'] as const).filter(t => raw[t] !== undefined);
    if (types.length !== 1 || (types[0] === 'remove' && kind === 'goals'))
      invalid(
        where +
          ' must contain exactly one of ' +
          (kind === 'goals' ? 'create or update (goals are not removed)' : 'create, update or remove') +
          '.',
        where,
      );
    const type = types[0]!;
    const extra = Object.keys(raw).filter(k => ![type, 'update_mask'].includes(k));
    if (extra.length || (type !== 'update' && raw.update_mask !== undefined))
      invalid(where + ': only update takes update_mask.', where + '.update_mask');
    if (type === 'remove') {
      if (typeof raw.remove !== 'string' || !pattern.test(raw.remove))
        invalid(where + '.remove must name one of this customer’s campaign goal configs.', where + '.remove');
      if (names.has(raw.remove)) invalid('A config appears twice in one request.', where + '.remove');
      names.add(raw.remove);
      return {index, type, record: {}, name: raw.remove, mask: []};
    }
    const record = raw[type];
    if (!object(record)) invalid(where + '.' + type + ' must be an object.', where + '.' + type);
    const present = blocks.filter(b => record[b] !== undefined);
    if (present.length !== 1)
      invalid(where + '.' + type + ' must carry exactly one of ' + blocks.join(', ') + '.', where + '.' + type, {
        allowed: blocks,
      });
    const block = present[0]!;
    checkBlock(kind, block, record[block], where + '.' + type + '.' + block);
    const identity = kind === 'configs' ? ['campaign', 'goal'] : [];
    if (type === 'create') {
      for (const k of Object.keys(record))
        if (k !== block && !identity.includes(k))
          invalid(
            where +
              '.create.' +
              k +
              (k === 'resource_name' ? ': Google names a new resource.' : ' is not a field this request sets.'),
            where + '.create.' + k,
          );
      if (kind === 'configs') {
        if (
          typeof record.campaign !== 'string' ||
          !new RegExp('^customers/' + id + '/campaigns/[1-9][0-9]*$').test(record.campaign)
        )
          invalid(where + '.create.campaign must name one of this customer’s campaigns.', where + '.create.campaign');
        if (
          typeof record.goal !== 'string' ||
          !new RegExp('^customers/' + id + '/goals/[1-9][0-9]*$').test(record.goal)
        )
          invalid(where + '.create.goal must name one of this customer’s goals.', where + '.create.goal');
      }
      return {index, type, record, mask: [], block};
    }
    const name = record.resource_name;
    if (typeof name !== 'string' || !pattern.test(name))
      invalid(
        where +
          '.update.resource_name must name one of this customer’s ' +
          (kind === 'goals' ? 'goals' : 'campaign goal configs') +
          '.',
        where + '.update.resource_name',
      );
    if (names.has(name)) invalid('A resource appears twice in one request.', where + '.update.resource_name');
    names.add(name);
    for (const k of Object.keys(record))
      if (k !== block && k !== 'resource_name')
        invalid(
          where + '.update.' + k + (identity.includes(k) ? ' is immutable.' : ' is not a field this request sets.'),
          where + '.update.' + k,
        );
    const mask = typeof raw.update_mask === 'string' ? raw.update_mask.split(',').map(f => snake(f.trim())) : [];
    const leaves = (v: JsonObject, prefix: string): string[] =>
      Object.entries(v).flatMap(([k, x]) => (object(x) ? leaves(x, prefix + k + '.') : [prefix + k]));
    const sent = leaves(record[block], block + '.');
    if (
      !mask.length ||
      mask.some(f => !f.startsWith(block + '.')) ||
      sent.some(f => !mask.includes(f)) ||
      mask.some(f => !sent.includes(f))
    )
      invalid(
        where +
          '.update_mask must list exactly the fields sent in ' +
          block +
          ' (' +
          sent.join(', ') +
          '); a masked field without a value would be cleared.',
        where + '.update_mask',
        {expected: sent.join(',')},
      );
    return {index, type, record, name, mask, block};
  });
}
export function assertGoogleLifecycleGoals(p: CompiledRequest) {
  operations(p);
}
type Read = CompiledRequest & {googleLifecycleGoalRead?: true};
const search = (classify: Classify, p: CompiledRequest, query: string, extra: JsonObject = {}): Read =>
  classify({
    ...p,
    action: 'AMCP_STATE_READ',
    method: 'POST',
    path: p.path.replace(/(Goals|CampaignGoalConfigs):mutate$/, 'googleAds:search'),
    query: {},
    body: {query},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
    ...extra,
  });
const marked = {googleLifecycleGoalRead: true};
export const isGoogleLifecycleGoalRead = (r: CompiledRequest) =>
  r.gateway === 'google_ads_native_action' && (r as Read).googleLifecycleGoalRead === true;
/**
 * The snapshot reads are whole collections (every goal; the configs of the campaigns named), so they may be empty.
 * One page only, every row in this customer, only the campaigns asked for, and at most one goal of each type.
 */
export function validateGoogleLifecycleGoalState(read: CompiledRequest, result: TransportResult) {
  const data = object(result.data) ? result.data : {},
    unverified = (message: string): never => {
      throw new MirrorError('STATE_READ_FAILED', message, {}, 502);
    };
  if (result.status !== 200 || (data.results !== undefined && !Array.isArray(data.results)))
    unverified('Google did not return goal state.');
  if (data.nextPageToken) throw new MirrorError('INCOMPLETE_STATE', 'The goal state was paginated.');
  const q = String(object(read.body) ? read.body.query : ''),
    from = / FROM ([a-z_]+)/.exec(q)?.[1],
    asked = [...q.matchAll(/'(customers\/[^']+)'/g)].map(m => m[1]),
    customer = /\/customers\/(\d+)\//.exec(read.path)?.[1],
    rows = ((data.results ?? []) as unknown[]).map(r => (object(r) ? (snakeKeys(r) as JsonObject) : {}));
  for (const r of rows) {
    const entity = from ? r[from] : undefined;
    if (!object(entity) || !String(entity.resource_name ?? '').startsWith('customers/' + customer + '/'))
      unverified('Goal state named a resource outside this customer.');
    if (from === 'campaign' && !asked.includes(entity.resource_name))
      unverified('Campaign state was not the campaign asked for.');
    if (from === 'campaign_goal_config' && !asked.includes(entity.campaign))
      unverified('Goal config state was not for the campaigns asked for.');
  }
  if (from === 'goal') {
    const types = rows.map(r => (r.goal as JsonObject).goal_type);
    if (new Set(types).size !== types.length) unverified('Google returned two goals of one type.');
  }
}
const valueSelect = (prefix: string) => valueFields.map(f => prefix + '.' + f);
const goalFields = [
  'goal.resource_name',
  'goal.goal_type',
  'goal.optimization_eligibility',
  ...Object.keys(goalSettings).flatMap(b => valueSelect('goal.' + b + '.value_settings')),
];
const configFields = [
  'campaign_goal_config.resource_name',
  'campaign_goal_config.campaign',
  'campaign_goal_config.goal',
  'campaign_goal_config.goal_type',
];
const quoted = (names: string[]) => names.map(n => "'" + n + "'").join(', ');
/** Every goal of the customer (at most one per type); for configs, the campaigns named and their configs. */
export function googleLifecycleGoalSnapshots(
  p: CompiledRequest,
  _stateRead: ReadBuilder,
  classify: Classify,
): CompiledRequest[] {
  const ops = operations(p),
    reads = [search(classify, p, 'SELECT ' + goalFields.join(', ') + ' FROM goal', marked)];
  if (googleLifecycleGoalKind(p) === 'configs') {
    const campaigns = [
      ...new Set(
        ops.map(o =>
          o.type === 'create'
            ? String(o.record.campaign)
            : 'customers/' + account(p) + '/campaigns/' + String(o.name).split('/').at(-1)!.split('~')[0],
        ),
      ),
    ].sort();
    reads.push(
      search(
        classify,
        p,
        'SELECT campaign.resource_name, campaign.status, campaign.advertising_channel_type FROM campaign WHERE campaign.resource_name IN (' +
          quoted(campaigns) +
          ')',
        marked,
      ),
      search(
        classify,
        p,
        'SELECT ' +
          configFields.join(', ') +
          ' FROM campaign_goal_config WHERE campaign_goal_config.campaign IN (' +
          quoted(campaigns) +
          ')',
        marked,
      ),
    );
  }
  return reads;
}
const rowsOf = (state: unknown[], entity: string): JsonObject[] =>
  state
    .flatMap(s => (object(s) && Array.isArray(s.results) ? s.results : []))
    .map(r => (object(r) ? (snakeKeys(r) as JsonObject)[entity] : undefined))
    .filter(object);
function fail(code: string, message: string, details: JsonObject): never {
  throw new MirrorError(code, message, details, 409);
}
export function googleLifecycleGoalPrerequisites(p: CompiledRequest, state: unknown[]) {
  const kind = googleLifecycleGoalKind(p)!,
    goals = rowsOf(state, 'goal'),
    typeOf = (name: unknown) => goals.find(g => g.resource_name === name)?.goal_type;
  for (const op of operations(p)) {
    const where = 'operations[' + op.index + ']';
    if (kind === 'goals') {
      const type = goalSettings[op.block!]!;
      if (op.type === 'create') {
        const existing = goals.find(g => g.goal_type === type);
        if (existing)
          fail('GOOGLE_GOAL_EXISTS', 'This customer already has a ' + type + ' goal; update it instead.', {
            field: where + '.create',
            existing: existing.resource_name,
          });
        continue;
      }
      if (!typeOf(op.name))
        fail('GOOGLE_GOAL_NOT_FOUND', op.name + ' is not a goal of this customer.', {
          field: where + '.update.resource_name',
        });
      if (typeOf(op.name) !== type)
        fail(
          'GOOGLE_GOAL_TYPE_MISMATCH',
          op.name + ' is a ' + typeOf(op.name) + ' goal; ' + op.block + ' is for ' + type + '.',
          {
            field: where + '.update.' + op.block,
          },
        );
      // The documented relations hold for the values the goal will have.
      const current = goals.find(g => g.resource_name === op.name)?.[op.block!]?.value_settings ?? {};
      checkValues(
        {...current, ...(op.record[op.block!].value_settings ?? {})},
        where + '.update.' + op.block + '.value_settings',
      );
      continue;
    }
    const campaigns = rowsOf(state, 'campaign'),
      configs = rowsOf(state, 'campaign_goal_config');
    if (op.type === 'create') {
      const campaign = campaigns.find(c => c.resource_name === op.record.campaign);
      if (!campaign || campaign.status === 'REMOVED')
        fail('GOOGLE_GOAL_CAMPAIGN_NOT_FOUND', String(op.record.campaign) + ' is not a campaign of this customer.', {
          field: where + '.create.campaign',
        });
      const type = typeOf(op.record.goal);
      if (!type)
        fail('GOOGLE_GOAL_NOT_FOUND', String(op.record.goal) + ' is not a goal of this customer.', {
          field: where + '.create.goal',
        });
      if (configSettings[op.block!]!.type !== type)
        fail(
          'GOOGLE_GOAL_TYPE_MISMATCH',
          String(op.record.goal) +
            ' is a ' +
            type +
            ' goal; ' +
            op.block +
            ' is for ' +
            configSettings[op.block!]!.type +
            '.',
          {
            field: where + '.create.' + op.block,
          },
        );
      if (configs.some(c => c.campaign === op.record.campaign && c.goal === op.record.goal))
        fail('GOOGLE_GOAL_CONFIG_EXISTS', 'This campaign is already linked to that goal; update its config instead.', {
          field: where + '.create',
        });
      continue;
    }
    const config = configs.find(c => c.resource_name === op.name);
    if (!config)
      fail('GOOGLE_GOAL_CONFIG_NOT_FOUND', String(op.name) + ' is not a campaign goal config of this customer.', {
        field: where + '.' + op.type,
      });
    if (op.type === 'update' && configSettings[op.block!]!.type !== config.goal_type)
      fail(
        'GOOGLE_GOAL_TYPE_MISMATCH',
        String(op.name) +
          ' links a ' +
          config.goal_type +
          ' goal; ' +
          op.block +
          ' is for ' +
          configSettings[op.block!]!.type +
          '.',
        {
          field: where + '.update.' + op.block,
        },
      );
  }
}
export function googleLifecycleGoalImpact(p: CompiledRequest, state: unknown[]): JsonObject {
  const kind = googleLifecycleGoalKind(p)!,
    ops = operations(p);
  return {
    scope: kind === 'goals' ? 'customer_lifecycle_goals' : 'campaign_lifecycle_goal_links',
    changes: ops.map(o => ({
      operation: o.type,
      ...(o.name ? {resource: o.name} : {}),
      ...(o.block ? {settings: o.block} : {}),
      ...(o.type === 'create' && kind === 'configs' ? {campaign: o.record.campaign, goal: o.record.goal} : {}),
    })),
    existing_goals: rowsOf(state, 'goal').map(g => ({resource: g.resource_name, type: g.goal_type})),
    meaning:
      'Lifecycle goals change the conversion values Smart Bidding optimizes for (new customers, retention, loyalty) in every campaign linked to them.',
  };
}
export function googleLifecycleGoalOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const ops = operations(p),
    results = object(r.data) && Array.isArray(r.data.results) ? r.data.results : [],
    prefix =
      'customers/' + account(p) + '/' + (googleLifecycleGoalKind(p) === 'goals' ? 'goals/' : 'campaignGoalConfigs/');
  return (
    results.length === ops.length &&
    ops.every((o, i) => {
      const name = object(results[i]) ? results[i].resourceName : undefined;
      return typeof name === 'string' && (o.name ? name === o.name : name.startsWith(prefix));
    })
  );
}
/** Each resource read back by name: the fields sent, or, for a removed config, its absence. */
export function googleLifecycleGoalVerification(
  p: CompiledRequest,
  result: JsonObject,
  _before: unknown[],
  _verificationRead: ReadBuilder,
  classify: Classify,
): VerificationRead[] {
  const kind = googleLifecycleGoalKind(p)!,
    resource = kind === 'goals' ? 'goal' : 'campaign_goal_config',
    results = object(result.data) && Array.isArray(result.data.results) ? result.data.results : [];
  const leaves = (v: JsonObject, prefix = ''): string[] =>
    Object.entries(v).flatMap(([k, x]) => (object(x) ? leaves(x, prefix + k + '.') : [prefix + k]));
  return operations(p).map((o, i) => {
    const id = String(o.name ?? (object(results[i]) ? results[i].resourceName : ''));
    if (o.type === 'remove')
      return {
        read: search(
          classify,
          p,
          'SELECT ' +
            resource +
            '.resource_name FROM ' +
            resource +
            ' WHERE ' +
            resource +
            ".resource_name IN ('" +
            id +
            "')",
          {
            googleState: {resource, names: [id], allowMissing: true, removedAsAbsent: true},
          },
        ),
        expected: {status: 'REMOVED'},
        id,
      };
    const {resource_name: _, ...sent} = o.record;
    return {
      read: search(
        classify,
        p,
        'SELECT ' +
          [resource + '.resource_name', ...leaves(sent).map(f => resource + '.' + f)].join(', ') +
          ' FROM ' +
          resource +
          ' WHERE ' +
          resource +
          ".resource_name IN ('" +
          id +
          "')",
      ),
      expected: sent,
      id,
    };
  });
}
export const googleLifecycleGoalRemoves = (p: CompiledRequest) => operations(p).some(o => o.type === 'remove');
/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleLifecycleGoalFamily: ReviewedFamily = {
  name: 'google_lifecycle_goals',
  files: ['src/google-lifecycle-goals.ts', ['tests/google-lifecycle-goals.test.ts']],
  kind: googleLifecycleGoalKind,
  assert: assertGoogleLifecycleGoals,
  scope: assertGoogleAdsScope,
  snapshots: googleLifecycleGoalSnapshots,
  isRead: isGoogleLifecycleGoalRead,
  validateState: validateGoogleLifecycleGoalState,
  prerequisites: googleLifecycleGoalPrerequisites,
  impact: googleLifecycleGoalImpact,
  outcome: googleLifecycleGoalOutcome,
  verification: googleLifecycleGoalVerification,
  spendConfirmation: {
    needed: () => true,
    message:
      'Lifecycle goals change the conversion values bidding optimizes for in every linked campaign. Confirm with spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: true,
  destructive: googleLifecycleGoalRemoves,
};
