import type {JsonObject} from './types.js';

/**
 * What an agent receives from a campaign plan (Snapchat S1). In the owner's live test on 2026-09-29 every
 * execute_next repeated every earlier step's frozen review, receipt, verification and before_state: 25 KB after the
 * first step and 132 KB after the eleventh, and 8 of 11 responses overflowed the client. A plan response is now the
 * plan header, one short row per step, the step the call acted on and the next call, within a fixed budget whatever
 * the number of steps. The stored plan is unchanged: `get` with detail "full" returns it whole, and `get` with a
 * step_id returns one step whole.
 */
export const planViewBudget = 11 * 1024; // within 12 KB once the response envelope is added
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const done = (s: JsonObject) => ['verified', 'verified_with_acceptance'].includes(s.status);
const pick = (o: JsonObject, keys: string[]) =>
  Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
/** The resources a step created or changed, as its verification and receipt name them. */
export function stepResources(step: JsonObject): string[] {
  const ids = new Set<string>(),
    add = (v: unknown) => {
      if ((typeof v === 'string' && v) || typeof v === 'number') ids.add(String(v));
    };
  for (const c of step.verification?.checks ?? []) add(c?.resource_id);
  for (const r of step.verification?.verified_resources ?? step.result?.verified_resources ?? [])
    add(r?.resource_id ?? r?.id);
  add(step.result?.created_id);
  add(step.result?.media_id);
  return [...ids];
}
/** One short row per step: enough to see where the plan stands and which resources exist. */
function row(step: JsonObject, ids: number): JsonObject {
  const resources = stepResources(step);
  return {
    id: step.id,
    kind: step.kind,
    status: step.status,
    ...(resources.length && ids ? {resource_ids: resources.slice(0, ids)} : {}),
    ...(resources.length > ids ? {resource_count: resources.length} : {}),
    ...(typeof step.verification?.status === 'string' ? {verification: step.verification.status} : {}),
    ...(typeof step.error?.code === 'string' ? {error: step.error.code} : {}),
  };
}
/** A write receipt without its transport headers and integrity fingerprint; `data` is the provider's reply. */
function receipt(result: JsonObject, withData: boolean): JsonObject {
  const {headers: _headers, fingerprint: _fingerprint, verification: _queued, data, parts, ...rest} = result;
  // A group's receipt has one provider reply per part (write-groups.ts); each goes the way a single reply does.
  const partViews = Array.isArray(parts) ? {parts: parts.map((p: JsonObject) => receipt(p, withData))} : {};
  return withData || data === undefined
    ? {...rest, ...partViews, ...(data !== undefined ? {data} : {})}
    : {...rest, ...partViews, data_omitted_bytes: size(data)};
}
/** A verification receipt with its outcome and per-resource comparison, without the repeated explanations. */
export function verificationView(v: JsonObject): JsonObject {
  return {
    ...pick(v, ['status', 'code', 'checked_at', 'actual_hash']),
    checks: (v.checks ?? []).map((c: JsonObject) =>
      pick(c, [
        'resource_id',
        'status',
        'code',
        'message',
        'read_attempts',
        'changed_fields',
        'diff',
        'stable_reads',
        'acknowledged_fields',
        'unacknowledged_fields',
        'unobservable_fields',
        'expected_hash',
        'actual_hash',
      ]),
    ),
    ...(Array.isArray(v.verified_resources)
      ? {
          verified_resources: v.verified_resources.map((r: JsonObject) =>
            pick(r, ['resource_id', 'id', 'kind', 'account_id']),
          ),
        }
      : {}),
    ...pick(v, ['retry_read_after_ms', 'next_call']),
  };
}
/** The one step this call acted on, with its receipt, verification and error. */
function currentStep(run: JsonObject, step: JsonObject, level: number): JsonObject {
  return {
    step_id: step.id,
    status: step.status,
    ...(step.review_id ? {review_id: step.review_id} : {}),
    ...(step.result ? {receipt: receipt(step.result, level < 1)} : {}),
    ...(step.verification ? {verification: verificationView(step.verification)} : {}),
    ...(step.error
      ? {error: level < 2 ? step.error : pick(step.error, ['code', 'message', 'category', 'remedy'])}
      : {}),
    ...(step.submission ? {submission: step.submission} : {}),
    ...(step.previous_attempts?.length ? {previous_attempts: step.previous_attempts.length} : {}),
    detail: {tool: 'amcp_campaign', arguments: {action: 'get', id: run.id, step_id: step.id}},
  };
}
/** Preflight without its per-step boilerplate: blocked steps whole, the rest counted, deferrals grouped by reason. */
export function preflightView(p: JsonObject, brief = false): JsonObject {
  const checks: JsonObject[] = p.checks ?? [],
    blocked = checks.filter(c => c.status === 'blocked').map(c => c.step);
  if (brief) return {status: p.status, checked_at: p.checked_at, ...(blocked.length ? {blocked_steps: blocked} : {})};
  // Steps deferred for the same reason and fields (every ad squad waiting for its campaign's ID) are listed once.
  const groups = new Map<string, JsonObject>();
  for (const d of p.deferred ?? []) {
    const key = JSON.stringify([d.reason, d.fields ?? null]),
      entry = groups.get(key) ?? {reason: d.reason, ...(d.fields ? {fields: d.fields} : {}), steps: []};
    entry.steps.push(d.step);
    groups.set(key, entry);
  }
  return {
    status: p.status,
    checked_at: p.checked_at,
    provider_mutations: p.provider_mutations ?? 0,
    checked_steps: checks.filter(c => c.status !== 'blocked').map(c => c.step),
    blocked_steps: blocked,
    ...(p.warnings?.length ? {warnings: p.warnings} : {}),
    ...(groups.size ? {deferred: [...groups.values()]} : {}),
    ...(checks.some(c => c.assets)
      ? {prerequisites: checks.filter(c => c.assets).map(c => pick(c, ['step', 'assets']))}
      : {}),
  };
}
/** Identical refusals of several steps, stated once. */
function grouped(requirements: JsonObject[]): JsonObject[] {
  const out = new Map<string, JsonObject>();
  for (const r of requirements) {
    const key = JSON.stringify(r.error ?? null),
      entry = out.get(key) ?? {steps: [], error: r.error};
    entry.steps.push(r.step);
    out.set(key, entry);
  }
  return [...out.values()];
}
/**
 * The compact response for any plan action. `current` names the step the call acted on; `extra` carries the
 * action's own fields (next_call, blocked, missing_requirements, notice, ...). When a view would exceed the budget,
 * detail goes first in this order: the provider's reply in the receipt, error details, all but one resource ID per
 * row, repeated refusals, and finally the rows of verified steps, which collapse into a list of their IDs.
 */
export function compactPlan(run: JsonObject, current?: string, extra: JsonObject = {}): JsonObject {
  const step = current ? run.steps.find((s: JsonObject) => s.id === current) : undefined;
  let view: JsonObject = {};
  for (let level = 0; level <= 4; level++) {
    const rows =
        level < 4
          ? run.steps.map((s: JsonObject) => row(s, level < 2 ? 3 : 1))
          : run.steps.filter((s: JsonObject) => !done(s)).map((s: JsonObject) => row(s, 1)),
      more =
        level >= 3 && Array.isArray(extra.missing_requirements)
          ? {...extra, missing_requirements: grouped(extra.missing_requirements)}
          : extra;
    view = {
      view: 'compact',
      id: run.id,
      name: run.name,
      revision: run.revision,
      state: run.state,
      plan_hash: run.plan_hash,
      steps: rows,
      ...(level >= 4 ? {verified_steps: run.steps.filter(done).map((s: JsonObject) => s.id)} : {}),
      ...(step ? {current: currentStep(run, step, level)} : {}),
      ...more,
    };
    if (size(view) <= planViewBudget) break;
  }
  return view;
}
/** The fields of a review an operator approves, and what AMCP read to freeze it, without the raw provider state. */
export function reviewView(review: JsonObject, runId: string, stepId: string): JsonObject {
  // A group review (write-groups.ts): each part's call and state hash; the whole bodies are in the stored review.
  if (Array.isArray(review.parts))
    return {
      ...pick(review, ['review_id', 'idempotency_key', 'expires_at', 'expires_in_seconds', 'group', 'records']),
      parts: review.parts.map((p: JsonObject) => ({
        ...pick(p, ['part', 'review_id', 'records', 'state_hash']),
        request: pick(p.request ?? {}, ['method', 'path']),
      })),
      ...pick(review, ['execute_requirements', 'contract_evidence', 'confirmation_required', 'meaning']),
      detail: {tool: 'amcp_campaign', arguments: {action: 'get', id: runId, step_id: stepId}},
    };
  const reads: JsonObject[] = review.state_reads ?? [],
    state: unknown[] = Array.isArray(review.before_state) ? review.before_state : [];
  return {
    ...pick(review, ['review_id', 'idempotency_key', 'expires_at', 'expires_in_seconds', 'request', 'state_hash']),
    state_summary: state.map((entry, i) => ({
      ...(reads[i] ? {read: reads[i]!.method + ' ' + reads[i]!.path} : {}),
      ...stateSummary(entry),
    })),
    ...pick(review, [
      'spend_policy',
      'execute_requirements',
      'creative_impact',
      'contract_evidence',
      'confirmation_required',
      'reused',
    ]),
    detail: {tool: 'amcp_campaign', arguments: {action: 'get', id: runId, step_id: stepId}},
  };
}
/** Identity, status, money and time fields of each record a review read; any other field is in the full review. */
const summaryKeys = [
  'id',
  'name',
  'status',
  'type',
  'currency',
  'timezone',
  'organization_id',
  'ad_account_id',
  'campaign_id',
  'ad_squad_id',
  'resourceName',
  'currencyCode',
  'timeZone',
  'account_status',
  'effective_status',
];
function stateSummary(entry: unknown): JsonObject {
  const records = unwrap(entry);
  if (!records.length) return {records: 0};
  const clip = (o: JsonObject, prefix = '') =>
    Object.entries(pick(o, summaryKeys)).map(([k, v]) => [
      prefix + k,
      typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v,
    ]);
  // Google rows nest each resource under its name ({customer:{...}}); one level down is as deep as a summary goes.
  let fields = clip(records[0]!);
  if (!fields.length)
    fields = Object.entries(records[0]!)
      .filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))
      .flatMap(([k, v]) => clip(v as JsonObject, k + '.'));
  return {records: records.length, record: Object.fromEntries(fields)};
}
/** The records in a provider read: Snapchat's wrapped lists ({adsquads:[{adsquad:{...}}]}), `results`, `list`,
 * `data` or `elements` arrays, or the object itself. */
function unwrap(entry: unknown): JsonObject[] {
  if (!entry || typeof entry !== 'object') return [];
  if (Array.isArray(entry)) return entry.flatMap(unwrap);
  const o = entry as JsonObject,
    record = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
  for (const [key, value] of Object.entries(o))
    if (Array.isArray(value) && value.length && value.every(v => record(v) && record(v[key.slice(0, -1)])))
      return value.map(v => v[key.slice(0, -1)]);
  for (const key of ['results', 'list', 'data', 'elements', 'value'])
    if (Array.isArray(o[key])) return o[key].filter(record);
  if (record(o.data)) return unwrap(o.data);
  return [o];
}
