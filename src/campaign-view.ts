import type {JsonObject} from './types.js';
import {maxViewedFieldPaths, providerCheckView, viewProviderErrors} from './provider-error-core.js';
import {sha256, stable} from './security.js';

/**
 * What an agent receives from a campaign plan (Snapchat S1). In the owner's live test on 2026-09-29 every
 * execute_next repeated every earlier step's frozen review, receipt, verification and before_state: 25 KB after the
 * first step and 132 KB after the eleventh, and 8 of 11 responses overflowed the client. A plan response is now the
 * plan header, one short row per step, the step the call acted on and the next call, within a fixed budget whatever
 * the number of steps. The stored plan is unchanged: `get` with detail "full" returns it whole, and `get` with a
 * step_id returns one step as `stepView` shows it (r25-field3-errors, AMCP-11: the request body left out, one part at
 * a time on request, and the whole step on detail "full" up to `detailFullLimit`).
 */
export const planViewBudget = 11 * 1024; // within 12 KB once the response envelope is added
/**
 * The most a step returned whole by detail "full" may be, answer and all: the 25,000 characters that stay under a client's 10,000-token warning
 * (src/guidance.ts campaignPromptBudget, owner decision D14; lead review S3-5: the 30 KB it was is about 8,800 to 12,300 tokens). A larger step
 * comes as its default view and the size left out, and its parts are read a page at a time (a page with its answer is under 24 KB). Measured in
 * bytes of JSON, which are at least its characters.
 */
// The value is guidance.ts `campaignPromptBudget`, which tests/campaign-step-view.test.mjs pins it equal to: this module is imported by src/plan-approval.ts, and
// guidance.ts leads into the family registry, which imports that (a cycle of 21 modules).
export const detailFullLimit = 25000;
/**
 * What the answer's envelope (the meta: request id, latency, the workflow's state) adds to the data of a step returned whole: 537 to 552 bytes
 * measured (the lead re-review N4: a step of 24,800 bytes of data came back as an answer of 25,337). The whole step is returned only when its data and
 * this much together stay within `detailFullLimit`, so that the answer with its envelope is never over it.
 */
export const detailFullEnvelope = 2048;
/** What one page of a step's part holds, as the JSON of its text: a page is under 24 KB with its answer around it. */
export const partPageBytes = 22 * 1024;
/**
 * The parts of a step a read can ask for one at a time (`get` with step_id and topic). `parts` is a write group's own: each of its parts with its
 * review id, state hash, request size and current state (r25-field3-errors, the lead re-review N2).
 */
export const stepParts = ['request', 'arguments', 'before_state', 'receipt', 'parts'] as const;
/** How many of a write group's parts a step view lists: the rest are one call away (`include.parts`). */
const listedParts = 5;
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const done = (s: JsonObject) => ['verified', 'verified_with_acceptance'].includes(s.status);
/** A step whose target already held every value it would send; nothing was sent (COM-01). Settled, not verified. */
const unchanged = (s: JsonObject) => s.status === 'skipped_unchanged';
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
    // A pending upload whose prepare met busy media capacity waits for it; nothing was sent (MED-03 B).
    ...(step.status === 'pending' && typeof step.busy?.code === 'string' ? {waiting: step.busy.code} : {}),
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
        // The behaviour a provider has been seen to show that explains the difference (src/known-behaviours.ts, R2.5 r25-fr-verify).
        'known',
        // A check that verified has two equal hashes (the owner's friction B5), which say nothing: it leaves them out.
        ...(c.status === 'verified' ? [] : ['expected_hash', 'actual_hash']),
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
/**
 * What a view keeps of a refusal's details at every budget level (r25-field3-errors, AMCP-03): the provider's rows (at most five, and
 * how many were left out), the field paths (at most ten) and the facts that find the refusal again. The rest of the details is the
 * view's to trim, as it always was.
 */
function errorDetailsView(details: JsonObject): JsonObject {
  const paths: unknown[] = Array.isArray(details.field_paths) ? details.field_paths : [];
  return {
    ...(paths.length ? {field_paths: paths.slice(0, maxViewedFieldPaths)} : {}),
    ...(paths.length > maxViewedFieldPaths ? {field_paths_omitted: paths.length - maxViewedFieldPaths} : {}),
    ...viewProviderErrors(details),
    ...pick(details, ['provider_message', 'http_status', 'request_id', 'review_id', 'submission']),
  };
}
/**
 * A step's error as the compact view shows it: whole while the view is small, and bounded where it carries the provider's rows or more
 * paths than a view holds; from level 2 on it is trimmed to its code, message, category and remedy, and keeps its rows and paths.
 */
function errorView(error: JsonObject, level: number): JsonObject {
  const details: JsonObject = error.details && typeof error.details === 'object' ? error.details : {},
    named = Array.isArray(details.provider_errors) || Array.isArray(details.field_paths),
    shown = named ? errorDetailsView(details) : {};
  if (level >= 2)
    return {...pick(error, ['code', 'message', 'category', 'remedy']), ...(named ? {details: shown} : {})};
  const {
    provider_errors: _rows,
    provider_errors_omitted: _left,
    field_paths: _paths,
    field_paths_omitted: _more,
    ...rest
  } = details;
  return named ? {...error, details: {...rest, ...shown}} : error;
}
/** The one step this call acted on, with its receipt, verification and error. */
function currentStep(run: JsonObject, step: JsonObject, level: number): JsonObject {
  return {
    step_id: step.id,
    status: step.status,
    ...(step.review_id ? {review_id: step.review_id} : {}),
    ...(step.result ? {receipt: receipt(step.result, level < 1)} : {}),
    ...(step.verification ? {verification: verificationView(step.verification)} : {}),
    ...(step.error ? {error: errorView(step.error, level)} : {}),
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
    // An activation plan's gates (CMP-03), with the locations a Microsoft gate read, for the operator to confirm.
    ...(Array.isArray(p.activation_gates) && p.activation_gates.length ? {activation_gates: p.activation_gates} : {}),
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
          : run.steps.filter((s: JsonObject) => !done(s) && !unchanged(s)).map((s: JsonObject) => row(s, 1)),
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
      // Linked plans (CMP-03, CMP-04): a continuation, an activation, and the plans they came from, by ID.
      ...Object.fromEntries(
        ['supersedes', 'superseded_by', 'activation_of', 'activation_plan']
          .filter(k => typeof run[k]?.id === 'string')
          .map(k => [k, run[k].id]),
      ),
      // Inventory and team (CMP-05): when it was archived, and how many colleagues it is shared with.
      ...(run.archived ? {archived_at: run.archived.at ?? null} : {}),
      ...(Array.isArray(run.collaborators) && run.collaborators.length
        ? {collaborators: run.collaborators.length}
        : {}),
      ...(run.gtm_consent
        ? {gtm_consent: pick(run.gtm_consent, ['workflow', 'preview_id', 'scope', 'source_hash'])}
        : {}),
      ...(run.catalog_removal
        ? {catalog_removal: pick(run.catalog_removal, ['workflow', 'preview_id', 'scope', 'source_hash'])}
        : {}),
      // Where a catalog plan's products came from: source, mapping, comparison and plan group (COM-03).
      ...(run.catalog_lineage ? {catalog_lineage: run.catalog_lineage} : {}),
      // Temporary files the plan uses are deleted at their deadline; the plan must run before it (owner decision D23).
      ...(run.temporary_sources
        ? {
            temporary_sources: {
              earliest_expires_at: run.temporary_sources.earliest_expires_at ?? null,
              count: run.temporary_sources.sources?.length ?? 0,
            },
            // When the plan must have run: its earliest temporary file's deadline (MED-03 B).
            run_by: run.temporary_sources.earliest_expires_at ?? null,
          }
        : {}),
      ...(run.search_exclusions
        ? {
            search_exclusions: pick(run.search_exclusions, [
              'report_id',
              'source_hash',
              'preview_id',
              'account_id',
              'currency',
              'options',
            ]),
          }
        : {}),
      ...(run.allocation
        ? {
            allocation: pick(run.allocation, [
              'report_id',
              'source_hash',
              'model_fingerprint',
              'preview_id',
              'conversion',
              'period_days',
              'currency',
            ]),
          }
        : {}),
      steps: rows,
      ...(level >= 4 ? {verified_steps: run.steps.filter(done).map((s: JsonObject) => s.id)} : {}),
      ...(level >= 4 && run.steps.some(unchanged)
        ? {skipped_unchanged_steps: run.steps.filter(unchanged).map((s: JsonObject) => s.id)}
        : {}),
      ...(step ? {current: currentStep(run, step, level)} : {}),
      ...more,
    };
    if (size(view) <= planViewBudget) break;
  }
  return view;
}
/** What a body comes to in a view that does not repeat it: its size and the SHA-256 of its canonical JSON. */
const bodyOf = (v: unknown) => ({bytes: size(v), sha256: sha256(stable(v))});
const isObject = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
/** One earlier attempt at a step, without the arguments it replaced: what it ended with and what was changed. */
function attemptView(a: JsonObject): JsonObject {
  return {
    at: a.at,
    ...(a.review_id !== undefined ? {review_id: a.review_id} : {}),
    ...(typeof (a.error?.code ?? a.preflight_error?.code) === 'string'
      ? {error_code: a.error?.code ?? a.preflight_error?.code}
      : {}),
    ...(Array.isArray(a.patch)
      ? {patch_paths: a.patch.map((p: JsonObject) => p?.path).filter((p: unknown) => typeof p === 'string')}
      : {}),
    ...(a.previous_arguments !== undefined ? {previous_arguments: bodyOf(a.previous_arguments)} : {}),
    ...pick(a, ['key_retired', 'rejected_build']),
  };
}
/** A request as a step view shows it: where it goes and how large its body is, never the body. */
const requestView = (request: JsonObject) => ({
  method: request.method,
  path: request.path,
  body_bytes: request.body === undefined ? 0 : size(request.body),
});
/** A step's review without the bodies it holds: the same facts a person approves, and the size of what was left out. */
function stepReview(review: JsonObject, level: number): JsonObject {
  // A group review (write-groups.ts), aggregated (lead re-review N2): how many parts, the request they share, the first five, and the call that pages
  // the rest (a part's view was 270 bytes, so 40 parts passed the budget by themselves); the whole bodies are in the stored review.
  if (Array.isArray(review.parts)) {
    const parts: JsonObject[] = review.parts,
      requests = new Set(parts.map(p => (isObject(p.request) ? p.request.method + ' ' + p.request.path : ''))),
      shared =
        requests.size === 1 && isObject(parts[0]!.request) ? pick(parts[0]!.request, ['method', 'path']) : undefined;
    return {
      ...pick(review, [
        'review_id',
        'expires_at',
        'group',
        'records',
        'execute_requirements',
        'approval',
        'time_budget',
        // The parts that repeat a create that completed in the last ten minutes (r25-mf-groups, audit finding 1): what a group of a plan's step shows, as a single review's view does.
        'duplicate_warning',
      ]),
      parts_count: parts.length,
      ...(shared ? {parts_request: shared} : {}),
      parts: parts.slice(0, listedParts).map(p => ({
        ...pick(p, ['part', 'review_id', 'records']),
        ...(!shared && isObject(p.request) ? {request: pick(p.request, ['method', 'path'])} : {}),
      })),
      ...(parts.length > listedParts ? {parts_omitted: parts.length - listedParts} : {}),
    };
  }
  const reads: JsonObject[] = Array.isArray(review.state_reads) ? review.state_reads : [];
  return {
    ...pick(review, [
      'review_id',
      'expires_at',
      'summary',
      'effects',
      'execute_requirements',
      'state_hash',
      'duplicate_warning',
      'approval',
      // What the request and the before state hide, by path: an approver is told that a value was hidden and where (P2A-02, Ruling 16).
      'redacted',
    ]),
    ...(level < 3 && reads.length
      ? {state_reads: reads.slice(0, 20).map(r => ({method: r.method, path: r.path}))}
      : {}),
    // What the view leaves out it counts (lead review S4-2): the reads beyond twenty, and all of them from level 3.
    ...(reads.length > (level < 3 ? 20 : 0) ? {state_reads_omitted: reads.length - (level < 3 ? 20 : 0)} : {}),
    ...(review.provider_check ? {provider_check: providerCheckView(review.provider_check, true)} : {}),
    ...(isObject(review.request) ? {request: requestView(review.request)} : {}),
    ...(review.before_state !== undefined ? {before_state_bytes: size(review.before_state)} : {}),
  };
}
/** A step's error as its view shows it: what it was, what to do, and what the provider named (at most five rows and ten paths). */
function lastErrorView(error: unknown): JsonObject {
  if (!isObject(error)) return {code: String(error)};
  const details = errorDetailsView(isObject(error.details) ? error.details : {});
  return {
    ...pick(error, ['code', 'message', 'category', 'remedy', 'next_action']),
    ...(Object.keys(details).length ? {details} : {}),
  };
}
/**
 * A read-back as a step view shows it; from level 1 on the checks that matched are counted and the ones that did not are listed (ten of them from
 * level 3, and from level 4 without their diffs, which keep the fields they changed), and the resources it confirmed are counted (lead review S4-2).
 */
function stepVerification(v: JsonObject, level: number): JsonObject {
  const view = verificationView(v);
  if (level < 1) return view;
  const checks: JsonObject[] = view.checks,
    open = checks.filter(c => c.status !== 'verified'),
    listed = open.slice(0, level < 3 ? 50 : 10),
    kept = level < 4 ? listed : listed.map(({diff: _diff, ...check}) => check),
    diffs = level < 4 ? 0 : listed.filter(c => c.diff !== undefined).length,
    {verified_resources: resources, ...rest} = view;
  return {
    ...rest,
    checks: kept,
    verified_checks: checks.length - open.length,
    ...(open.length > listed.length ? {checks_omitted: open.length - listed.length} : {}),
    ...(Array.isArray(resources) && resources.length ? {verified_resources_omitted: resources.length} : {}),
    ...(diffs ? {diffs_omitted: diffs} : {}),
  };
}
/**
 * The journal of a write group's key lists the phase of each of its parts (src/store.ts): a view counts them by phase and lists the parts that were
 * claimed, ten at most (lead re-review N2: that list alone was 3,463 bytes at 40 parts).
 */
function journalParts(parts: JsonObject[]): JsonObject {
  const byPhase: Record<string, number> = {},
    sent = parts.filter(p => !['not_claimed', 'validation_rejected', 'not_sent'].includes(String(p.phase)));
  for (const p of parts) byPhase[String(p.phase)] = (byPhase[String(p.phase)] ?? 0) + 1;
  return {
    parts_by_phase: byPhase,
    ...(sent.length ? {parts_sent: sent.slice(0, 10).map(p => pick(p, ['review_id', 'phase']))} : {}),
    ...(sent.length > 10 ? {parts_sent_omitted: sent.length - 10} : {}),
  };
}
/**
 * A write group's parts as `get` with topic parts pages them (lead re-review N2): each part's number, review id, record count, state hash and request
 * size, and its state now (`stateOf`, read from the store).
 */
export function groupPartsView(review: JsonObject, stateOf: (reviewId: string) => string): JsonObject[] {
  return (Array.isArray(review.parts) ? review.parts : []).map((p: JsonObject) => ({
    ...pick(p, ['part', 'review_id', 'records', 'state_hash']),
    ...(isObject(p.request) ? {request: requestView(p.request)} : {}),
    state: stateOf(String(p.review_id)),
  }));
}
/**
 * One step of a plan as `get` with its step_id answers by default (r25-field3-errors, AMCP-11; the owner's report of 2026-11-21: the whole
 * stored step was about 56,000 characters, mostly the request body three times, and it carried no error). The step's head and status; its
 * arguments, and its review's request, as sizes and hashes (the body is one call away); its review without its before state; the last error
 * with the provider's rows; the receipt without the provider's reply, and the verification; the last three earlier attempts without their
 * bodies; the native request counts; and the call that reads each part left out (`include`). It stays within `planViewBudget` with its
 * journal (the last ten events of each) and degrades, as a plan view does, by dropping the finer detail first: the checks that matched, then the
 * earlier attempts and most of the journal, then the review's state reads; what names the error and the call that reads a part stays.
 */
export function stepView(run: JsonObject, step: JsonObject, journal: JsonObject[]): JsonObject {
  const action = step.arguments?.action ?? step.arguments?.operation,
    review = isObject(step.review) ? step.review : undefined,
    attempts: JsonObject[] = Array.isArray(step.previous_attempts) ? step.previous_attempts : [],
    parts: [string, boolean][] = [
      ['request', isObject(review?.request)],
      ['arguments', step.arguments !== undefined],
      ['before_state', review?.before_state !== undefined],
      ['receipt', step.result !== undefined],
      ['parts', Array.isArray(review?.parts)],
    ],
    include = Object.fromEntries(
      parts
        .filter(([, present]) => present)
        .map(([part]) => [
          part,
          {tool: 'amcp_campaign', arguments: {action: 'get', id: run.id, step_id: step.id, topic: part}},
        ]),
    );
  // The whole step is offered only when detail "full" would return it (a larger step comes back as this view again).
  const small = size(step) + size(journal) + 512 + detailFullEnvelope <= detailFullLimit;
  let view: JsonObject = {};
  for (let level = 0; level <= 4; level++) {
    view = {
      step: {
        ...pick(step, [
          'id',
          'kind',
          'gateway',
          'connection_id',
          'account_id',
          'description',
          'depends_on',
          'status',
          'submission',
          'expected_currency',
          'prerequisites',
          'review_id',
        ]),
        ...(typeof action === 'string' ? {action} : {}),
        // Named as the correction template names it (campaign-amendment.ts): recover_step takes any object as corrected arguments, so a key called
        // `arguments` that held {bytes, sha256} could be echoed back and replace the step's request with it (lead review S3-6).
        ...(step.arguments !== undefined
          ? {arguments_omitted: {...bodyOf(step.arguments), read: include.arguments}}
          : {}),
        // The copy of the arguments with their references resolved is a body too: it is left out and named (lead review S4-2).
        ...(step.resolved !== undefined ? {resolved_omitted: bodyOf(step.resolved)} : {}),
        ...(review ? {review: stepReview(review, level)} : {}),
        ...(step.error ? {last_error: lastErrorView(step.error)} : {}),
        ...(isObject(step.result) ? {receipt: receipt(step.result, false)} : {}),
        ...(isObject(step.verification) ? {verification: stepVerification(step.verification, level)} : {}),
        ...(attempts.length ? {previous_attempts_count: attempts.length} : {}),
        ...(attempts.length && level < 2 ? {previous_attempts: attempts.slice(-3).map(attemptView)} : {}),
        ...pick(step, [
          'native_requests',
          'absence',
          'busy',
          'acceptance',
          'adopted_from',
          'duplicate_warning_shown_at',
          'duplicate_warning_shown_for',
        ]),
        include,
        ...(small
          ? {full: {tool: 'amcp_campaign', arguments: {action: 'get', id: run.id, step_id: step.id, detail: 'full'}}}
          : {}),
      },
      execution_journal: journal.map(entry => {
        const {parts: phases, ...rest} = entry,
          events: JsonObject[] = Array.isArray(entry.events) ? entry.events : [],
          shown = events.slice(level < 2 ? -10 : -3);
        return {
          ...rest,
          events: shown,
          ...(events.length > shown.length ? {events_omitted: events.length - shown.length} : {}),
          ...(Array.isArray(phases) ? journalParts(phases) : {}),
        };
      }),
    };
    if (size(view) <= planViewBudget) break;
  }
  return view;
}
/**
 * The pages of a text: where each starts and ends, so that the JSON of each (its quotes and escapes counted) is at most `pageBytes`
 * and no page ends inside a surrogate pair. The pages, joined, are the text byte for byte.
 */
export function pageBounds(text: string, pageBytes = partPageBytes): [number, number][] {
  const encoded = (from: number, to: number) => Buffer.byteLength(JSON.stringify(text.slice(from, to))) - 2,
    bounds: [number, number][] = [];
  let start = 0;
  do {
    let end = Math.min(text.length, start + pageBytes);
    // A character is at most six bytes once escaped: cut by the excess, then look again.
    for (let at = encoded(start, end); end > start + 1 && at > pageBytes; at = encoded(start, end))
      end -= Math.max(1, Math.ceil((at - pageBytes) / 6));
    const last = text.charCodeAt(end - 1);
    if (end < text.length && end > start + 1 && last >= 0xd800 && last <= 0xdbff) end--;
    bounds.push([start, end]);
    start = end;
  } while (start < text.length);
  return bounds;
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
      ...pick(review, [
        'time_budget',
        'execute_requirements',
        'approval',
        'contract_evidence',
        'confirmation_required',
        // The parts that repeat a create that completed in the last ten minutes (r25-mf-groups, audit finding 1): what the plan stops on before it sends a group, as for a single review.
        'duplicate_warning',
        'meaning',
      ]),
      detail: {tool: 'amcp_campaign', arguments: {action: 'get', id: runId, step_id: stepId}},
    };
  const reads: JsonObject[] = review.state_reads ?? [],
    state: unknown[] = Array.isArray(review.before_state) ? review.before_state : [];
  return {
    ...pick(review, [
      'review_id',
      'idempotency_key',
      'expires_at',
      'expires_in_seconds',
      'summary',
      'effects',
      'unchanged_since_review',
      'request',
      // What the request and the before-state hide, by path (P2A-02, P2B-05): the request is shown through the credential view, and
      // an approver reading this view is told that a value was hidden and where, as the full review tells (Ruling 16).
      'redacted',
      'state_hash',
    ]),
    state_summary: state.map((entry, i) => ({
      ...(reads[i] ? {read: reads[i]!.method + ' ' + reads[i]!.path} : {}),
      ...stateSummary(entry),
    })),
    ...pick(review, [
      'spend_policy',
      'execute_requirements',
      // A person's website approval the step needs (WRT-09), with its website_path.
      'approval',
      'creative_impact',
      'contract_evidence',
      'confirmation_required',
      'reused',
      // An identical create completed in the last ten minutes (R2.5 M2, L5-06): the agent shows it before a second object is made.
      'duplicate_warning',
    ]),
    // What the provider's check at prepare came to (r25-field3-errors, AMCP-03): its status, and the rows and paths of a rejection, without
    // the provider's whole answer (the full review holds it, when it is small enough).
    ...(review.provider_check ? {provider_check: providerCheckView(review.provider_check, true)} : {}),
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
