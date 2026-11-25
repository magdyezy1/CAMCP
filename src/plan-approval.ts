import type {JsonObject} from './types.js';
import {readableAmount} from './budget-units.js';
import {riskFieldName, statusFieldKeys} from './execution-risk.js';
import type {RequestChange} from './request-changes.js';
import {isNotMoneyName} from './spend-effects.js';
import {fingerprint, obj} from './workspace-core.js';

/**
 * What a plan approval covers (WRT-05 Stage A). Every money and status field of every step is counted: a step whose
 * fields fit the display budget lists each one; a larger step lists one aggregate per field (count, distinct values
 * and, for money, the smallest and largest value) with `truncated: true` and the call that returns every field. The
 * summary's own hash (`summary_hash`) binds the approval to the summary the user was shown, alongside `plan_hash`.
 */
const money = /budget|bid|amount|spend_cap|cpc|cpm|target_cpa|target_roas/i;
/**
 * Money a family sets under a name the words above do not carry (fix round, the sweep of the lead's review S2-3), each one the repository reads as money
 * elsewhere: any field containing "spend" is a spend field to the review's own generic rule (src/spend-effects.ts), Google's pinned target_cpv_micros and
 * target_spend_micros, Reddit's goal_value (a budget for its spend goals, src/reddit-writes.ts), and the spend policy's daily_cap, total_cap and LinkedIn's
 * unit_cost (src/spend-policy.ts). The key is read in snake_case, as the status keys are.
 */
const moreMoney = /spend|cpv|^goal_value$|(?:^|_)(?:daily|total)_cap$|(?:^|_)unit_cost$/;
export const namesMoney = (key: string) =>
  !isNotMoneyName(key) && (money.test(key) || moreMoney.test(riskFieldName(key)));
/**
 * What a field is, for the order the rows of what a step changes come in (R2.5 r25-approval-fields): money (0), then status (1), then dates (2), then
 * the name (3), then the rest (4). The money and status keys are the ones this summary lists as such.
 */
const scheduleName = /(?:^|_)(?:start|end|stop|begin|date|time|schedule|dayparting)(?:_|$)/;
export function changeRank(field: string): number {
  const leaf = field.split('.').at(-1) ?? field,
    name = riskFieldName(leaf);
  if (namesMoney(leaf)) return 0;
  if (statusFieldKeys().has(name)) return 1;
  if (scheduleName.test(name)) return 2;
  return /(?:^|_)name$/.test(name) ? 3 : 4;
}
/** Fields one step lists one by one; a step with more is aggregated. */
export const approvalFieldsShown = 24;
/**
 * The most the steps of a summary hold before the largest are cut to their own list (truncated, with the call that lists them): 8 KB since the
 * owner's friction report of 2026-11-25 (B2: a summary that shows each step's object, field and value), up from 6 KB, which 24 steps of one field
 * each overran. It stays inside the compact plan view (11 KB, 12 KB with the envelope): 24 such steps measure about 7 KB and a view of 9 KB.
 */
export const approvalBytes = 8 * 1024;
const distinctShown = 5;
/** The rows of what a step changes that it lists: an edit lists more than a create, which sets many fields of an object that does not exist yet. */
export const changesShown = 12;
export const createChangesShown = 4;
/** The ids a row lists when it names several objects; its `count` says how many there are. */
export const idsShown = 12;
/** Steps that make one change to different objects are one group from this many (owner, 2026-11-25), when that makes the summary smaller. */
export const groupFrom = 4;
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
/** What a step changes in all: a row that names several objects counts each. */
const changeTotal = (rows: readonly RequestChange[]) => rows.reduce((n, r) => n + (r.count ?? 1), 0);

export interface ApprovalField {
  field: string;
  value: string | number | boolean;
  kind: 'spend' | 'status' | 'setting';
}
/**
 * Meta's budget-sharing choice (CMP-01) is stated. false keeps each ad set on its own budget and is a setting, not a
 * spending field (as in spend-effects.ts); true lets Meta move budget between ad sets and is a spending field.
 */
const budgetSharing = 'is_adset_budget_sharing_enabled';
/**
 * Every money and status field a step's arguments set, and Meta's budget-sharing choice, in document order; references
 * to predecessors are skipped. A status field is any key that sets an entity's status on any platform, in any spelling (status, Status,
 * operation_status, entityStatus, ...: src/execution-risk.ts statusFieldKeys, derived from the providers' own declarations).
 */
export function approvalFields(args: unknown): ApprovalField[] {
  const out: ApprovalField[] = [],
    status = statusFieldKeys();
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, path + '/' + i));
    else if (obj(v)) {
      // A JSON Patch operation names its field by path: {op: 'replace', path: '/daily_budget_micro', value: ...} sets a budget, and
      // {op: 'replace', path: '/status', value: ...} a status, as `{daily_budget_micro: ...}` and `{status: ...}` do (Meta, Snapchat and DV360 take
      // patches; src/execution-risk.ts `bodyDeletion` reads them the same way). Only an add or a replace sets a value: a `test` asserts one, and
      // a remove, move or copy carries none to list. The money keys come first, as they do for a key, so a plan that writes a budget as a patch
      // changes spending to the distinct-approver policy (CMP-05) as one that writes it as a key does (fix round, the lead's review S2-3).
      if (
        (v.op === 'add' || v.op === 'replace') &&
        typeof v.path === 'string' &&
        (typeof v.value === 'string' || typeof v.value === 'number')
      ) {
        const segment = v.path.split('/').at(-1) ?? '';
        if (namesMoney(segment)) out.push({field: path + '/value', value: v.value, kind: 'spend'});
        else if (status.has(riskFieldName(segment))) out.push({field: path + '/value', value: v.value, kind: 'status'});
      }
      for (const [k, x] of Object.entries(v)) {
        if (obj(x) && Object.hasOwn(x, '$ref')) continue;
        if (k === budgetSharing && typeof x === 'boolean') {
          out.push({field: path + '/' + k, value: x, kind: x ? 'spend' : 'setting'});
          continue;
        }
        const spend = namesMoney(k);
        if ((spend || status.has(riskFieldName(k))) && (typeof x === 'string' || typeof x === 'number'))
          out.push({field: path + '/' + k, value: x, kind: spend ? 'spend' : 'status'});
        else walk(x, path + '/' + k);
      }
    }
  };
  walk(args, '');
  return out;
}
/** A decimal value as an exact scaled integer (value × 10^scale), or undefined when it is not a plain decimal. */
function decimal(v: string | number | boolean): {digits: bigint; scale: number} | undefined {
  if (typeof v === 'boolean') return undefined;
  const text = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v.trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return undefined;
  const fraction = m[3] ?? '';
  return {digits: BigInt((m[1] ?? '') + (m[2] ?? '0') + fraction), scale: fraction.length};
}
function compare(a: {digits: bigint; scale: number}, b: {digits: bigint; scale: number}): number {
  const scale = Math.max(a.scale, b.scale),
    x = a.digits * 10n ** BigInt(scale - a.scale),
    y = b.digits * 10n ** BigInt(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}
/** One entry per field pattern (array positions as `*`): how many, which values, and the money range. */
export function aggregateFields(fields: ApprovalField[]): JsonObject[] {
  const groups = new Map<string, {kind: string; values: (string | number | boolean)[]}>();
  for (const f of fields) {
    const pattern = f.field.replace(/\/\d+(?=\/|$)/g, '/*'),
      group = groups.get(pattern) ?? {kind: f.kind, values: []};
    group.values.push(f.value);
    groups.set(pattern, group);
  }
  return [...groups].map(([field, {kind, values}]) => {
    const distinct = [...new Map(values.map(v => [typeof v + ':' + String(v), v])).values()];
    const numbers = values.map(decimal);
    let range: JsonObject = {};
    if (kind === 'spend' && numbers.every(n => n !== undefined)) {
      let min = 0,
        max = 0;
      numbers.forEach((n, i) => {
        if (compare(n!, numbers[min]!) < 0) min = i;
        if (compare(n!, numbers[max]!) > 0) max = i;
      });
      range = {min: values[min], max: values[max]};
    }
    return {
      field,
      kind,
      count: values.length,
      distinct_count: distinct.length,
      values: distinct.slice(0, distinctShown),
      ...range,
    };
  });
}
/**
 * What the local compile of one write step says of it, by the one rule its review applies (src/campaign-spend-effects.ts `stepEffects`):
 * whether the review will ask execute for spend_change_confirmed (`spend`), whether the request deletes or ends something
 * (`destructive`, `irreversible`: the review's own `writeEffects`), and whether it could be compiled at all (`checked`). One compile
 * answers all of them, so the spend effect and the destructive effect of a step can never judge two different requests.
 */
export interface StepEffectFacts {
  spend: boolean;
  destructive: boolean;
  irreversible: boolean;
  checked: boolean;
  /** What the request does (`create`, `update`, `delete`...), as the review says it: a create lists fewer rows. */
  operation?: string;
  /** What the request changes, row by row (src/request-changes.ts, from the same compile); absent where it was not read. */
  changes?: RequestChange[];
}
/** A step's entry of the effects map: a bare boolean is the spend effect alone (the shape this map had), and says nothing of deletion. */
export type StepEffectEntry = boolean | StepEffectFacts;
/**
 * Effects of a step: removals and deletions, and publishing (each review discloses its own). `facts` is the step's compile (above): with it
 * a step is destructive and irreversible exactly when its review will say so, whatever platform it is on and however that platform deletes (a
 * status value, a `remove` operation, a DELETE method, a family's own rule), so the summary says what the review says (fix round, the lead's
 * review S4-5: the argument names no longer add a second reason where the compile ran, and no longer contradict it). A step that could not be
 * compiled is shown as possibly destructive, never as safe (`checked: false`: the person is told the check did not happen). The argument names
 * (an action called delete, remove or destroy, a `remove` operation) are the fallback where there are no facts: no map was passed (the
 * distinct-approver policy's read, a plan summarized without a runner) or the step is no write step the compile covers (a media step).
 */
export function planStepEffects(step: JsonObject, facts?: StepEffectFacts): JsonObject | undefined {
  const args = step.arguments ?? {},
    action = String(args.action ?? args.operation ?? ''),
    operations = Array.isArray(args.payload?.operations) ? args.payload.operations : [];
  const unchecked = facts !== undefined && !facts.checked,
    destructive = facts
      ? facts.destructive || unchecked
      : /(?:^|_)(?:delete|remove|destroy)(?:_|$)/i.test(action) ||
        operations.some((op: unknown) => obj(op) && Object.hasOwn(op, 'remove')),
    irreversible = facts ? facts.irreversible || unchecked : destructive;
  const publishes = /(?:^|_)publish(?:_|$)/i.test(action);
  return destructive || publishes
    ? {
        ...(destructive ? {destructive: true, ...(irreversible ? {irreversible: true} : {})} : {}),
        ...(unchecked ? {checked: false} : {}),
        ...(publishes ? {publishes_live: true} : {}),
      }
    : undefined;
}
const covers =
  'Each step is still prepared as a frozen review of the state it reads and executed once with its own idempotency key and read-back; this approval stands in for the confirmation of each review. Owner spending caps, creative edits and failures still stop the run for a person.';
/**
 * The approval summary of a plan; `summary_hash` is the fingerprint of everything else in it.
 *
 * `spendEffects` (R2.5 r25-field-plan, the owner's Google issue 2, fix (a)) says, by step ID, whether a write step needs
 * spend_change_confirmed by the one rule each review applies (src/campaign-spend-effects.ts compiles each step locally). With it
 * the summary names the effect of every write step (`spend_effect`), lists the steps that spend (`spend_steps`), and binds that list
 * in `summary_hash`: the approval covers exactly the steps whose spend effect it showed. A write step the map does not name counts as
 * spending (fail closed). Without it the summary is what it was: the money and status fields only, which is also what the
 * distinct-approver policy reads (CMP-05, unchanged).
 *
 * An entry of the map may be the step's whole compile (`StepEffectFacts`, r25-approval-effects, the lead's review S2-1): then the step's
 * destructive and irreversible effects are the review's own, shown for a deletion on any platform, and a step the compile could not judge
 * (or a write step the map does not name) is shown as possibly destructive with `checked: false`. A step with no destructive effect carries
 * no `effects` key, so the `summary_hash` of a plan that deletes nothing is what it was.
 */
export function approvalSummary(
  run: JsonObject,
  spendEffects?: ReadonlyMap<string, StepEffectEntry>,
  accounts?: ReadonlyMap<string, AccountDisplay>,
): JsonObject {
  const entries = run.steps.map((s: JsonObject) => {
    // A write step the map does not name could not be judged: it counts as spending and as possibly destructive (fail closed). An entry that
    // is a bare boolean carries the spend effect only, so its deletion is read from the arguments' names as it always was.
    const asked = spendEffects && s.kind === 'write' ? spendEffects.get(s.id) : undefined,
      facts: StepEffectFacts | undefined =
        spendEffects && s.kind === 'write' && typeof asked !== 'boolean'
          ? (asked ?? {spend: true, destructive: true, irreversible: true, checked: false})
          : undefined,
      fields = approvalFields(s.arguments),
      effects = planStepEffects(s, facts),
      spendEffect =
        spendEffects && s.kind === 'write' ? (typeof asked === 'boolean' ? asked : (facts?.spend ?? true)) : undefined;
    return {
      fields,
      // What the step changes, row by row, from the same compile (r25-approval-fields); nothing where the map held no compile of it.
      changes: facts?.changes ?? [],
      creates: facts?.operation === 'create',
      base: {
        id: s.id,
        gateway: s.kind === 'media' ? s.arguments.platform + '_native_action' : s.gateway,
        action: s.arguments.action ?? s.arguments.operation ?? null,
        account_id: s.account_id,
        ...(s.depends_on.length ? {depends_on: s.depends_on} : {}),
        fields_total: fields.length,
        ...(effects ? {effects} : {}),
        ...(spendEffect !== undefined ? {spend_effect: spendEffect} : {}),
      },
    };
  });
  type Entry = {fields: ApprovalField[]; changes: RequestChange[]; creates: boolean; base: JsonObject};
  // The call that lists every field and row of one step: a read, and the same as approve with a step_id (R2.5 field3, AMCP-07).
  const allFields = (e: Entry) => ({
    tool: 'amcp_campaign',
    arguments: {action: 'approval_summary', id: run.id, step_id: e.base.id},
  });
  // The ids of a row that names many are cut to the first few; its `count` says how many there are.
  const listedRow = (r: RequestChange): JsonObject =>
    r.ids && r.ids.length > idsShown ? {...r, ids: r.ids.slice(0, idsShown)} : r;
  const digest = (e: Entry) => fingerprint(e.changes).slice(0, 16);
  // What a create lists of its rows: its name and its dates, and the people it uploads (withheld, but never uncounted). Its money and status are listed
  // in `spend` and `status` already, and the rest of what it sets (targeting, goals, placements) is counted and one call away; an edit lists its rows
  // by their order.
  const listable = (e: Entry) =>
    e.creates
      ? e.changes.filter(r => changeRank(r.field) === 2 || changeRank(r.field) === 3 || r.field === 'people')
      : e.changes;
  // How many rows a step has that it does not list, or ids of a row (`more`): it says so, binds them in `changes_digest` (a changed value among them
  // changes the summary_hash too) and, for the whole plan, says where they are (`step_fields`).
  const listed = (e: Entry): JsonObject => {
    const spend = e.fields.filter(f => f.kind === 'spend').map(({field, value}) => ({field, value})),
      status = e.fields.filter(f => f.kind === 'status').map(({field, value}) => ({field, value})),
      settings = e.fields.filter(f => f.kind === 'setting').map(({field, value}) => ({field, value})),
      pool = listable(e),
      shown = pool.slice(0, e.creates ? createChangesShown : changesShown),
      rows = shown.map(listedRow),
      more = shown.length < e.changes.length || rows.some((r, i) => r !== shown[i]);
    return {
      ...e.base,
      ...(spend.length ? {spend} : {}),
      ...(status.length ? {status} : {}),
      ...(settings.length ? {settings} : {}),
      ...(rows.length ? {changes: rows} : {}),
      ...(more ? {changes_total: changeTotal(e.changes), changes_digest: digest(e)} : {}),
    };
  };
  const aggregated = (e: Entry): JsonObject => ({
    ...e.base,
    truncated: true,
    aggregates: aggregateFields(e.fields),
    ...(e.changes.length ? {changes_total: changeTotal(e.changes), changes_digest: digest(e)} : {}),
    // The full list of one step's fields is a read: the read-only action shows it (R2.5 field3, AMCP-07); approve with a step_id answers the same.
    all_fields: allFields(e),
  });
  const steps: JsonObject[] = entries.map((e: Entry) =>
    e.fields.length > approvalFieldsShown ? aggregated(e) : listed(e),
  );
  // Steps that make the same change to different objects (24 ad sets given the same end date) are one group, when that makes the summary smaller:
  // the change once, with the count and the ids of the objects in the order of the steps that name the group (owner, 2026-11-25).
  const groups: JsonObject[] = [];
  const candidates = new Map<string, number[]>();
  entries.forEach((e: Entry, i: number) => {
    const rows = e.changes,
      step = steps[i]!;
    if (!rows.length || step.truncated || step.changes_total !== undefined) return;
    // One object, named by every row: a row that names several objects, or none, is its step's own.
    if (!rows.every(r => r.id !== undefined && r.id === rows[0]!.id)) return;
    const key = JSON.stringify([step.gateway, step.action, step.account_id, rows.map(({id: _id, ...rest}) => rest)]);
    candidates.set(key, [...(candidates.get(key) ?? []), i]);
  });
  for (const members of candidates.values()) {
    if (members.length < groupFrom) continue;
    const rows = (entries[members[0]!] as Entry).changes,
      name = 'g' + (groups.length + 1),
      group = {
        group: name,
        count: members.length,
        object: rows[0]!.object,
        ids: members.map(i => (entries[i] as Entry).changes[0]!.id),
        changes: rows.map(({id: _id, object: _object, ...rest}) => rest),
      },
      grouped = members.map(i => {
        const {changes: _changes, ...rest} = steps[i]!;
        return {...rest, group: name};
      });
    if (size(group) + size(grouped) < size(members.map(i => steps[i]))) {
      groups.push(group);
      members.forEach((i, at) => (steps[i] = grouped[at]!));
    }
  }
  const total = () => size(steps) + size(groups);
  const bySize = (rows: (i: number) => number, later: boolean) =>
    entries
      .map((_e: Entry, i: number) => ({i, n: rows(i)}))
      .filter((x: {n: number}) => x.n > 0)
      .sort((a: {n: number; i: number}, b: {n: number; i: number}) => b.n - a.n || (later ? b.i - a.i : a.i - b.i));
  const unlisted = (i: number): JsonObject => {
    const {changes: _changes, ...rest} = steps[i]!;
    return {...rest, changes_total: changeTotal(entries[i].changes), changes_digest: digest(entries[i])};
  };
  // Over the byte budget: first the rows of the creates, which are no part of what the approval has always shown and which no step has to be
  // opened for (the money and status they set are listed, the largest first and only where that makes the step smaller)...
  for (const {i} of bySize(i => (entries[i].creates ? size(steps[i]!.changes ?? []) : 0), true)) {
    if (total() <= approvalBytes) break;
    if (size(unlisted(i)) < size(steps[i])) steps[i] = unlisted(i);
  }
  // ...then the largest listed steps are aggregated, as they always were.
  for (const {i} of bySize(i => entries[i].fields.length, false)) {
    if (total() <= approvalBytes) break;
    // Only where that makes the step smaller (fix round, the lead's review S2-2): a step of one field is larger aggregated, and aggregating it
    // would only lock the website's approval behind a list to open for each such step.
    if (steps[i]!.truncated) continue;
    const smaller = aggregated(entries[i]);
    if (size(smaller) < size(steps[i])) steps[i] = smaller;
  }
  // Still over: the steps that hold the most rows of an edit keep their money and status fields and leave their rows to their own list, truncated
  // like any step that is cut, with the call that lists them (owner, 2026-11-25: a row is never dropped without saying where it is), the largest
  // first and only where that makes the step smaller.
  for (const {i} of bySize(i => size(steps[i]!.changes ?? []), true)) {
    if (total() <= approvalBytes) break;
    const cut = {...unlisted(i), truncated: true, all_fields: allFields(entries[i])};
    if (size(cut) < size(steps[i])) steps[i] = cut;
  }
  const effects = steps.filter(s => s.effects).map(s => ({step_id: s.id, ...s.effects}));
  const summary: JsonObject = {
    plan_hash: run.plan_hash,
    steps,
    ...(groups.length ? {groups} : {}),
    fields_total: steps.reduce((n, s) => n + s.fields_total, 0),
    ...(steps.some(s => s.truncated) ? {truncated: true} : {}),
    ...(effects.length ? {effects} : {}),
    // The steps whose spend effect this approval shows, once: what spend_change_confirmed given with it covers.
    ...(spendEffects ? {spend_steps: steps.filter(s => s.spend_effect === true).map(s => s.id)} : {}),
    // A step that lists fewer rows than it has (`changes_total`) has them all in the read of its own: this call with the step's id. It names no
    // plan and no step, so that two plans that change the same things have the same summary.
    ...(steps.some(s => s.changes_total !== undefined && !s.all_fields)
      ? {
          step_fields: {
            tool: 'amcp_campaign',
            arguments: {action: 'approval_summary', id: '<this plan>', step_id: '<step id>'},
          },
        }
      : {}),
    covers,
  };
  return {...readable(run, summary, accounts), summary_hash: fingerprint(summary)};
}
/** An account as the approval names it, from what the account's last live read (or the login's discovery) stored: never invented, never read for the approval. */
export interface AccountDisplay {
  name?: string;
  currency?: string;
  timezone?: string;
}
/** The key the accounts of an approval are looked up by: a step's gateway and account as the step names them. */
export const accountKey = (gateway: unknown, accountId: unknown) => String(gateway) + '|' + String(accountId);
/** The currency of a step's account: the stored one, else the one the step itself expects (a recipe's, which the preflight checks against the account). */
const currencyOf = (step: JsonObject, accounts?: ReadonlyMap<string, AccountDisplay>): string | undefined =>
  accounts?.get(accountKey(step.gateway, step.account_id))?.currency ??
  (typeof step.expected_currency === 'string' ? step.expected_currency : undefined);
/** A row of money as a person reads it: the amount in the account's currency, and the old amount before it where there is one. */
export function showRow(row: JsonObject, gateway: unknown, currency: string | undefined): JsonObject {
  if (changeRank(String(row.field)) !== 0 || (typeof row.new === 'object' && row.new !== null)) return row;
  const leaf = String(row.field).split('.').at(-1) ?? '',
    now = readableAmount(String(gateway), leaf, row.new, currency);
  if (!now) return row;
  // A value that stays what it is has no arrow: the row holds both, and the person reads that nothing moves.
  const before =
    row.old === undefined || String(row.old) === String(row.new)
      ? undefined
      : readableAmount(String(gateway), leaf, row.old, currency);
  return {
    ...row,
    shown: (before ? before.amount + ' → ' : '') + now.amount + ' ' + (now.currency ?? 'in account currency'),
  };
}
/**
 * The summary as a person reads it (owner decision D3, 2026-11-25): a money value in the account's currency, and the accounts the plan writes to with
 * their currency and time zone. These come from the account's stored read, which the preflight may refresh between the summary and the approval, so
 * they are not part of the `summary_hash`: the hash binds the object, the id, the field and the value as sent, which is everything the approver must
 * notice. A value that cannot be converted (a platform whose unit AMCP does not document, Meta without the account currency) stays as it is.
 */
function readable(run: JsonObject, summary: JsonObject, accounts?: ReadonlyMap<string, AccountDisplay>): JsonObject {
  const currencies = new Map<string, string | undefined>();
  run.steps.forEach((s: JsonObject) => currencies.set(s.id, currencyOf(s, accounts)));
  const steps = (summary.steps as JsonObject[]).map(s =>
    Array.isArray(s.changes)
      ? {...s, changes: s.changes.map((r: JsonObject) => showRow(r, s.gateway, currencies.get(s.id)))}
      : s,
  );
  const first = (group: string) => (summary.steps as JsonObject[]).find(s => s.group === group),
    groups = Array.isArray(summary.groups)
      ? (summary.groups as JsonObject[]).map(g => {
          const lead = first(g.group);
          return lead && Array.isArray(g.changes)
            ? {...g, changes: g.changes.map((r: JsonObject) => showRow(r, lead.gateway, currencies.get(lead.id)))}
            : g;
        })
      : undefined,
    listed = new Map<string, JsonObject>();
  for (const s of run.steps)
    if (s.kind === 'write') {
      const found = accounts?.get(accountKey(s.gateway, s.account_id));
      if (found && Object.keys(found).length)
        listed.set(accountKey(s.gateway, s.account_id), {gateway: s.gateway, account_id: s.account_id, ...found});
    }
  return {
    ...summary,
    steps,
    ...(groups ? {groups} : {}),
    ...(listed.size ? {accounts: [...listed.values()]} : {}),
  };
}
/**
 * True when a step sets a money field, listed or aggregated: what the distinct-approver policy reads to tell a plan that changes
 * spending (CMP-05), as it always has. A summary made with the spend effects (`approvalSummary`'s second argument) is read by its
 * money fields here too, never by the effects.
 */
export function approvalMoney(summary: JsonObject): boolean {
  return summary.steps.some(
    (s: JsonObject) => s.spend?.length || (s.aggregates ?? []).some((a: JsonObject) => a.kind === 'spend'),
  );
}
/**
 * True when the approval has a spend effect to confirm: a step sets a money field, or a step needs spend_change_confirmed by the
 * rule its review applies (`spend_effect`). The approval then offers spend_change_confirmed, which covers `summary.spend_steps`.
 */
export function approvalSpends(summary: JsonObject): boolean {
  return approvalMoney(summary) || summary.steps.some((s: JsonObject) => s.spend_effect === true);
}
/**
 * Every money and status field of one step, and every row of what it changes (r25-approval-fields: with the plan's effects, which hold the step's
 * compile), for the "show all fields" view of a truncated summary.
 */
export function approvalStep(
  run: JsonObject,
  stepId: string,
  spendEffects?: ReadonlyMap<string, StepEffectEntry>,
  accounts?: ReadonlyMap<string, AccountDisplay>,
): JsonObject | undefined {
  const step = run.steps.find((s: JsonObject) => s.id === stepId);
  if (!step) return undefined;
  const fields = approvalFields(step.arguments),
    asked = spendEffects && step.kind === 'write' ? spendEffects.get(step.id) : undefined,
    changes = typeof asked === 'object' ? (asked.changes ?? []) : [],
    currency = currencyOf(step, accounts);
  return {
    step_id: step.id,
    fields_total: fields.length,
    fields,
    ...(changes.length
      ? {changes_total: changeTotal(changes), changes: changes.map(r => showRow({...r}, step.gateway, currency))}
      : {}),
  };
}
