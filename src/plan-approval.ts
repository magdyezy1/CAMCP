import type {JsonObject} from './types.js';
import {riskFieldName, statusFieldKeys} from './execution-risk.js';
import {fingerprint, obj} from './workspace-core.js';

/**
 * What a plan approval covers (WRT-05 Stage A). Every money and status field of every step is counted: a step whose
 * fields fit the display budget lists each one; a larger step lists one aggregate per field (count, distinct values
 * and, for money, the smallest and largest value) with `truncated: true` and the call that returns every field. The
 * summary's own hash (`summary_hash`) binds the approval to the summary the user was shown, alongside `plan_hash`.
 */
const money = /budget|bid|amount|spend_cap|cpc|cpm|target_cpa|target_roas/i;
/** Fields one step lists one by one; a step with more is aggregated. */
export const approvalFieldsShown = 24;
/** The whole summary stays inside the compact plan view (12 KB with the plan rows and the envelope). */
const approvalBytes = 6 * 1024;
const distinctShown = 5;
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

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
      // A JSON Patch operation names its field by path: {op: 'replace', path: '/status', value: ...} sets a status as `{status: ...}` does
      // (Meta, Snapchat and DV360 take patches; src/execution-risk.ts `bodyDeletion` reads them the same way).
      if (
        typeof v.path === 'string' &&
        (typeof v.value === 'string' || typeof v.value === 'number') &&
        status.has(riskFieldName(v.path.split('/').at(-1) ?? ''))
      )
        out.push({field: path + '/value', value: v.value, kind: 'status'});
      for (const [k, x] of Object.entries(v)) {
        if (obj(x) && Object.hasOwn(x, '$ref')) continue;
        if (k === budgetSharing && typeof x === 'boolean') {
          out.push({field: path + '/' + k, value: x, kind: x ? 'spend' : 'setting'});
          continue;
        }
        const spend = money.test(k);
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
}
/** A step's entry of the effects map: a bare boolean is the spend effect alone (the shape this map had), and says nothing of deletion. */
export type StepEffectEntry = boolean | StepEffectFacts;
/**
 * Effects of a step: removals and deletions, and publishing (each review discloses its own). `facts` is the step's compile (above): with it
 * a step is destructive when its review will say so, whatever platform it is on and however that platform deletes (a status value, a `remove`
 * operation, a DELETE method, a family's own rule). A step that could not be compiled is shown as possibly destructive, never as safe
 * (`checked: false`: the person is told the check did not happen). The argument names (an action called delete, remove or destroy, a
 * `remove` operation) stay a second reason, so nothing the summary showed before is shown less; they are the whole rule where no compile
 * is given (the distinct-approver policy's read, and a plan summarized without a runner).
 */
export function planStepEffects(step: JsonObject, facts?: StepEffectFacts): JsonObject | undefined {
  const args = step.arguments ?? {},
    action = String(args.action ?? args.operation ?? ''),
    operations = Array.isArray(args.payload?.operations) ? args.payload.operations : [];
  const unchecked = facts !== undefined && !facts.checked,
    destructive =
      facts?.destructive === true ||
      unchecked ||
      /(?:^|_)(?:delete|remove|destroy)(?:_|$)/i.test(action) ||
      operations.some((op: unknown) => obj(op) && Object.hasOwn(op, 'remove'));
  const publishes = /(?:^|_)publish(?:_|$)/i.test(action);
  return destructive || publishes
    ? {
        ...(destructive ? {destructive: true, irreversible: true} : {}),
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
export function approvalSummary(run: JsonObject, spendEffects?: ReadonlyMap<string, StepEffectEntry>): JsonObject {
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
  const listed = (e: {fields: ApprovalField[]; base: JsonObject}): JsonObject => {
    const spend = e.fields.filter(f => f.kind === 'spend').map(({field, value}) => ({field, value})),
      status = e.fields.filter(f => f.kind === 'status').map(({field, value}) => ({field, value})),
      settings = e.fields.filter(f => f.kind === 'setting').map(({field, value}) => ({field, value}));
    return {
      ...e.base,
      ...(spend.length ? {spend} : {}),
      ...(status.length ? {status} : {}),
      ...(settings.length ? {settings} : {}),
    };
  };
  const aggregated = (e: {fields: ApprovalField[]; base: JsonObject}): JsonObject => ({
    ...e.base,
    truncated: true,
    aggregates: aggregateFields(e.fields),
    // The full list of one step's fields is a read: the read-only action shows it (R2.5 field3, AMCP-07); approve with a step_id answers the same.
    all_fields: {tool: 'amcp_campaign', arguments: {action: 'approval_summary', id: run.id, step_id: e.base.id}},
  });
  const steps: JsonObject[] = entries.map((e: {fields: ApprovalField[]; base: JsonObject}) =>
    e.fields.length > approvalFieldsShown ? aggregated(e) : listed(e),
  );
  // Over the byte budget, the largest listed steps are aggregated first.
  const order = entries
    .map((e: {fields: ApprovalField[]}, i: number) => ({i, n: e.fields.length}))
    .filter((x: {n: number}) => x.n > 0)
    .sort((a: {n: number; i: number}, b: {n: number; i: number}) => b.n - a.n || a.i - b.i);
  for (const {i} of order) {
    if (size(steps) <= approvalBytes) break;
    if (!steps[i]!.truncated) steps[i] = aggregated(entries[i]);
  }
  const effects = steps.filter(s => s.effects).map(s => ({step_id: s.id, ...s.effects}));
  const summary: JsonObject = {
    plan_hash: run.plan_hash,
    steps,
    fields_total: steps.reduce((n, s) => n + s.fields_total, 0),
    ...(steps.some(s => s.truncated) ? {truncated: true} : {}),
    ...(effects.length ? {effects} : {}),
    // The steps whose spend effect this approval shows, once: what spend_change_confirmed given with it covers.
    ...(spendEffects ? {spend_steps: steps.filter(s => s.spend_effect === true).map(s => s.id)} : {}),
    covers,
  };
  return {...summary, summary_hash: fingerprint(summary)};
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
/** Every money and status field of one step, for the "show all fields" view of a truncated summary. */
export function approvalStep(run: JsonObject, stepId: string): JsonObject | undefined {
  const step = run.steps.find((s: JsonObject) => s.id === stepId);
  if (!step) return undefined;
  const fields = approvalFields(step.arguments);
  return {step_id: step.id, fields_total: fields.length, fields};
}
