import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const nativeId = /^[a-z0-9]+$/;
const fields = ['line_item_id', 'targeting_type', 'targeting_value', 'operator_type'];
function invalid(message: string, details: JsonObject = {}): never {
  throw new MirrorError('INVALID_TARGETING_MUTATION', message, details);
}

export function xTargetingKind(plan: CompiledRequest) {
  if (plan.gateway !== 'x_ads_native_action') return undefined;
  if (plan.method === 'POST' && /^\/12\/accounts\/[^/]+\/targeting_criteria$/.test(plan.path)) return 'create' as const;
  if (plan.method === 'DELETE' && /^\/12\/accounts\/[^/]+\/targeting_criteria\/[^/]+$/.test(plan.path))
    return 'delete' as const;
  return undefined;
}
function parent(plan: CompiledRequest): string {
  const body = object(plan.body) ? plan.body : invalid('Provide one native targeting criterion.');
  const lineItem = body.line_item_id;
  if (typeof lineItem !== 'string' || !nativeId.test(lineItem)) invalid('Provide the exact parent line_item_id.');
  return lineItem;
}
export function assertXTargeting(plan: CompiledRequest) {
  if (xTargetingKind(plan) !== 'create') return;
  const body = object(plan.body) ? plan.body : invalid('Provide one native targeting criterion.');
  for (const key of Object.keys(body))
    if (!fields.includes(key)) invalid('Unqualified targeting field: ' + key, {field: key});
  parent(plan);
  // X owns the targeting_type vocabulary and rejects unknown tokens itself; only shape is checked.
  if (typeof body.targeting_type !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(body.targeting_type))
    invalid('targeting_type must be a native X targeting type token.');
  if (
    typeof body.targeting_value !== 'string' ||
    !body.targeting_value.trim() ||
    body.targeting_value.length > 1024 ||
    /[\r\n]/.test(body.targeting_value)
  )
    invalid('targeting_value must be a nonempty single-line native string.');
  if (body.operator_type !== undefined && !['EQ', 'NE'].includes(String(body.operator_type)))
    invalid('operator_type must be EQ or NE.');
}

/** Reads resolve the parent line item on create and the criterion itself on delete, so the
 * existing single-entity x_ads state contract validates them unchanged. */
export function xTargetingSnapshots(plan: CompiledRequest): CompiledRequest[] {
  const account = plan.path.match(/^\/12\/accounts\/[^/]+/)![0];
  const read = (path: string): CompiledRequest => ({
    ...plan,
    action: 'AMCP_STATE_READ',
    method: 'GET',
    path,
    query: {},
    body: undefined,
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
  });
  return xTargetingKind(plan) === 'delete' ? [read(plan.path)] : [read(account + '/line_items/' + parent(plan))];
}

/** A criterion carries no status of its own, and X exposes no atomic non-batch path, so a
 * half-applied set is a valid, servable, narrower audience rather than a visible failure.
 * Requiring a paused parent makes partial application unable to spend. */
export function validateXTargetingState(plan: CompiledRequest, states: unknown[]) {
  if (xTargetingKind(plan) !== 'create') return;
  const state = states[0],
    row = object(state) && object(state.data) ? state.data : undefined;
  if (row?.entity_status !== 'PAUSED')
    throw new MirrorError(
      'TARGETING_PARENT_NOT_PAUSED',
      'X applies targeting criteria one at a time, so a partly applied set would serve as a narrower audience. Pause the line item, apply every criterion, then resume it.',
      {line_item_id: row?.id ?? null, entity_status: row?.entity_status ?? null},
    );
}
