import type {JsonObject} from './types.js';
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
 * to predecessors are skipped.
 */
export function approvalFields(args: unknown): ApprovalField[] {
  const out: ApprovalField[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, path + '/' + i));
    else if (obj(v))
      for (const [k, x] of Object.entries(v)) {
        if (obj(x) && Object.hasOwn(x, '$ref')) continue;
        if (k === budgetSharing && typeof x === 'boolean') {
          out.push({field: path + '/' + k, value: x, kind: x ? 'spend' : 'setting'});
          continue;
        }
        const spend = money.test(k);
        if ((spend || k === 'status') && (typeof x === 'string' || typeof x === 'number'))
          out.push({field: path + '/' + k, value: x, kind: spend ? 'spend' : 'status'});
        else walk(x, path + '/' + k);
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
/** Effects the step's own arguments name: removals and deletions, and publishing (each review discloses its own). */
export function planStepEffects(step: JsonObject): JsonObject | undefined {
  const args = step.arguments ?? {},
    action = String(args.action ?? args.operation ?? ''),
    operations = Array.isArray(args.payload?.operations) ? args.payload.operations : [];
  const destructive =
    /(?:^|_)(?:delete|remove|destroy)(?:_|$)/i.test(action) ||
    operations.some((op: unknown) => obj(op) && Object.hasOwn(op, 'remove'));
  const publishes = /(?:^|_)publish(?:_|$)/i.test(action);
  return destructive || publishes
    ? {...(destructive ? {destructive: true, irreversible: true} : {}), ...(publishes ? {publishes_live: true} : {})}
    : undefined;
}
const covers =
  'Each step is still prepared as a frozen review of the state it reads and executed once with its own idempotency key and read-back; this approval stands in for the confirmation of each review. Owner spending caps, creative edits and failures still stop the run for a person.';
/** The approval summary of a plan; `summary_hash` is the fingerprint of everything else in it. */
export function approvalSummary(run: JsonObject): JsonObject {
  const entries = run.steps.map((s: JsonObject) => {
    const fields = approvalFields(s.arguments),
      effects = planStepEffects(s);
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
    all_fields: {tool: 'amcp_campaign', arguments: {action: 'approve', id: run.id, step_id: e.base.id}},
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
    covers,
  };
  return {...summary, summary_hash: fingerprint(summary)};
}
/** True when a step sets a money field, listed or aggregated: the approval then offers spend_change_confirmed. */
export function approvalSpends(summary: JsonObject): boolean {
  return summary.steps.some(
    (s: JsonObject) => s.spend?.length || (s.aggregates ?? []).some((a: JsonObject) => a.kind === 'spend'),
  );
}
/** Every money and status field of one step, for the "show all fields" view of a truncated summary. */
export function approvalStep(run: JsonObject, stepId: string): JsonObject | undefined {
  const step = run.steps.find((s: JsonObject) => s.id === stepId);
  if (!step) return undefined;
  const fields = approvalFields(step.arguments);
  return {step_id: step.id, fields_total: fields.length, fields};
}
