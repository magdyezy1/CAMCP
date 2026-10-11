import type {Actor, JsonObject} from './types.js';
import {bad, obj, planReference, pointer, type ToolCall} from './workspace-core.js';
import {definitiveRefusalStatuses} from './write-rejection.js';

/**
 * Recovering a plan whose step the provider refused after submission (CMP-04), for families without a declared
 * non-applied proof. Two primitives keep the original identity and never replay an uncertain write:
 *
 * - confirm_absent: a complete, read-only list of the would-be resource's siblings under its parent, matched by the
 *   step's own name and created at or after the step's claim. A complete probe with no match, plus the user's
 *   attestation (audited), lets recover_step amend the step under a new key. An incomplete probe, or any match, refuses.
 * - continue_as_new: a new linked plan of the steps still to write, with references to settled predecessors adopted as
 *   literal values that carry their provenance; the original plan becomes superseded.
 */

/** How far before the step's claim a provider's creation time may read, for clock skew between AMCP and the provider. */
export const absenceSkewMs = 10 * 60000;
/** One probe reads at most this many pages of 100 rows; a longer list is incomplete, and the probe refuses. */
const maxProbePages = 10;

interface ProbeSpec {
  /** The read-only native action that lists the parent's children of the step's type. */
  action: string;
  /** Its path parameter, from the step's resolved arguments (or the account for a top-level create). */
  parent: (step: JsonObject) => {param: string; id: unknown; field?: string};
  entity: string;
}
const metaAccount = (step: JsonObject) => String(step.account_id ?? '').replace(/^act_/, '');
/** The creates each gateway can probe. Meta first (the ticket's acceptance); others are added one family at a time. */
const probes: Record<string, Record<string, ProbeSpec>> = {
  meta_native_action: {
    meta_campaign_create: {
      action: 'meta_ad_account_id_campaigns_get',
      parent: step => ({param: 'ad_account_id', id: metaAccount(step), field: 'account_id'}),
      entity: 'campaign',
    },
    meta_adset_create: {
      action: 'meta_campaign_id_adsets_get',
      parent: step => ({param: 'campaign_id', id: step.resolved?.payload?.campaign_id, field: 'campaign_id'}),
      entity: 'ad set',
    },
    meta_ad_create: {
      action: 'meta_ad_set_id_ads_get',
      parent: step => ({param: 'ad_set_id', id: step.resolved?.payload?.adset_id, field: 'adset_id'}),
      entity: 'ad',
    },
  },
};

const stepAction = (step: JsonObject) => String(step.resolved?.action ?? step.arguments?.action ?? '');
export function absenceProbe(step: JsonObject): ProbeSpec | undefined {
  return step.kind === 'write' ? probes[step.gateway]?.[stepAction(step)] : undefined;
}

/**
 * A step a provider refused definitively after submission (HTTP 4xx with the provider's own error body) whose family
 * proves nothing about whether it applied: its claim stays uncertain, and only an absence probe can settle it.
 */
export function refusedAfterSubmission(step: JsonObject, claim: JsonObject | undefined): boolean {
  return (
    step.kind === 'write' &&
    step.status === 'failed' &&
    claim?.state === 'uncertain' &&
    definitiveRefusalStatuses.includes(Number(step.error?.details?.http_status)) &&
    obj(step.error?.details?.upstream)
  );
}

/** The absence the user confirmed for this exact step key, if any. */
export const absenceConfirmed = (step: JsonObject) =>
  obj(step.absence) && step.absence.review_id === step.review_id && step.absence.attested === true;

/**
 * Reads every child of the step's parent (bounded) and returns what matches the step's name and claim time. It is a
 * provider read only. Complete means every page was read and every row names its id, name, creation time and parent.
 */
export async function probeAbsence(
  call: ToolCall,
  actor: Actor,
  step: JsonObject,
  claimedAt: number,
): Promise<JsonObject> {
  const spec = absenceProbe(step);
  if (!spec)
    bad(
      'Step ' +
        step.id +
        ' has no absence probe: AMCP cannot list what its action creates. Check in the provider whether the resource exists; nothing is sent again.',
      'RECOVERY_NOT_SAFE',
      {step_id: step.id},
    );
  const parent = spec.parent(step),
    name = step.resolved?.payload?.name ?? step.arguments?.payload?.name,
    since = claimedAt - absenceSkewMs;
  const base = {
    action: spec.action,
    entity: spec.entity,
    parent: {[parent.param]: parent.id ?? null},
    name: typeof name === 'string' ? name : null,
    created_since: new Date(since).toISOString(),
    provider_mutations: 0,
  };
  const incomplete = (reason: string, extra: JsonObject = {}) => ({...base, complete: false, reason, ...extra});
  if (typeof parent.id !== 'string' || !/^[0-9]{1,32}$/.test(parent.id))
    return incomplete(
      'The parent of step ' + step.id + ' is not a resolved native ID, so its children cannot be listed.',
    );
  if (typeof name !== 'string' || !name)
    return incomplete('Step ' + step.id + ' sends no name, so a created resource cannot be told apart.');
  const matches: JsonObject[] = [];
  let rows = 0,
    after: string | undefined;
  for (let page = 0; page < maxProbePages; page++) {
    const out = await call(
      step.gateway,
      {
        action: spec.action,
        account_id: step.account_id,
        connection_id: step.connection_id,
        path_params: {[parent.param]: parent.id},
        query: {fields: 'id,name,created_time,account_id,campaign_id,adset_id', limit: 100, ...(after ? {after} : {})},
        dry_run: false,
      },
      actor,
    );
    if (!out.success)
      return incomplete('The provider refused the list read (' + String(out.error?.code ?? 'unknown') + ').', {
        error: {code: out.error?.code ?? null, message: out.error?.message ?? null},
      });
    const body = out.data?.data;
    if (out.data?.truncated || !obj(body) || !Array.isArray(body.data))
      return incomplete('The provider returned an incomplete or malformed list.');
    for (const row of body.data) {
      if (
        !obj(row) ||
        typeof row.id !== 'string' ||
        typeof row.name !== 'string' ||
        (parent.field && row[parent.field] !== undefined && String(row[parent.field]) !== parent.id)
      )
        return incomplete('A listed row lacks its ID or name, or names another parent.');
      rows++;
      const created = Date.parse(String(row.created_time ?? ''));
      // A row whose creation time is missing or unreadable is counted as a match: absence must be proven.
      if (row.name === name && (!Number.isFinite(created) || created >= since))
        matches.push({id: row.id, name: row.name, created_time: row.created_time ?? null});
    }
    const paging = obj(body.paging) ? body.paging : undefined;
    if (paging?.next === undefined) return {...base, complete: true, rows_read: rows, pages: page + 1, matches};
    after = typeof paging.cursors?.after === 'string' ? paging.cursors.after : undefined;
    if (!after) return incomplete('The provider named a next page without a cursor.', {rows_read: rows});
  }
  return incomplete('The list is longer than ' + maxProbePages + ' pages of 100.', {rows_read: rows});
}

/**
 * Replaces every reference to a settled predecessor with the value it resolved to, recording which predecessors were
 * adopted. References to steps that are carried into the new plan stay references.
 */
export function adoptReferences(value: unknown, settled: Map<string, JsonObject>, adopted: Set<string>): unknown {
  if (obj(value) && Object.hasOwn(value, '$ref')) {
    const {ref, prefix} = planReference(value),
      at = ref.indexOf('#'),
      id = ref.slice(0, at);
    const result = settled.get(id);
    if (at < 1 || !result) return value;
    adopted.add(id);
    const resolved = structuredClone(pointer(result, ref.slice(at + 1)));
    return prefix === undefined ? resolved : prefix + String(resolved);
  }
  if (Array.isArray(value)) return value.map(v => adoptReferences(v, settled, adopted));
  return obj(value)
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, adoptReferences(v, settled, adopted)]))
    : value;
}
