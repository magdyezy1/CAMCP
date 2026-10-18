/** Validation stage: the request shapes each reviewed write family accepts, checked before any read. */
import {reviewedWriteFamily} from './reviewed-routes.js';
import {assertProviderActionAvailable} from './retired-provider-actions.js';
import {assertWireContract} from './wire-contracts.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {assertRedditWrite} from './reddit-writes.js';
import {familyOf} from './reviewed-families.js';
import {withheldWriteProgramId, withheldWriteReason} from './withheld-writes.js';
import {assertNoMethodOverride, object, fail} from './write-common.js';
import {validateMetaCreative} from './creative-validation.js';
import {providerOf, reviewedWriteGateways} from './provider-adapters.js';
import {providerHooks} from './provider-hooks.js';

/** The gateways with reviewed mutation contracts, from the provider adapter registry (ARC-01 phase B). */
export const writeContractGateways: ReadonlySet<string> = new Set(reviewedWriteGateways);
/** The Meta execution_options values that validate instead of applying (a list, its JSON text, or comma-separated). */
export function metaValidationOptions(body: JsonObject): string[] {
  const raw: unknown = body.execution_options;
  if (raw === undefined) return [];
  let options = raw;
  if (typeof raw === 'string')
    try {
      options = JSON.parse(raw);
    } catch {
      options = raw.split(',');
    }
  const values = (Array.isArray(options) ? options : [options]).map(v => String(v).trim().toLowerCase());
  return ['validate_only', 'include_recommendations'].filter(v => values.includes(v));
}
export function assertWriteShape(plan: CompiledRequest) {
  assertReviewedShape(plan);
  // PRV-05: after the family's own refusals, which name the reviewed contract more precisely, a write whose body
  // differs from its pinned vendor contract is refused at inspect, prepare and execute when enforcement is on.
  assertWireContract(plan);
}
function assertReviewedShape(plan: CompiledRequest) {
  // The provider's part of this stage (ARC-01 phase B, its adapter's write checks), asked where it named the provider.
  const checks = providerHooks(plan.gateway)?.checks;
  assertProviderActionAvailable(plan);
  // The provider's own request contracts: Google's Discovery schema, Meta's campaign and v26 rules.
  checks?.request?.(plan);
  if (!writeContractGateways.has(plan.gateway))
    fail('WRITE_CONTRACT_UNAVAILABLE', 'This platform has no reviewed mutation contract.');
  if (plan.readOnly) fail('MUTATION_REQUIRED', 'Use the original native gateway to perform this read.');
  // Meta's validate_only and include_recommendations ask it to check a request without applying it. A reviewed write
  // applies its request, so such a review would be receipted as an applied change (WRT-06); validation is its own path.
  const validation = providerOf(plan.gateway)?.executionOptions ? metaValidationOptions(object(plan.body)) : [];
  if (validation.length)
    fail(
      'WRITE_CONTRACT_UNAVAILABLE',
      'Remove ' +
        validation.join(' and ') +
        ' from execution_options: a reviewed write applies its request. To have Meta check a campaign or ad set without applying it, use amcp_campaign validate_provider.',
      {field: 'execution_options', refused: validation},
    );
  // A provider whose own write contract decides alone (Microsoft's contracts). Reddit's does too, but its module
  // reads pages through src/pagination.ts, which consults the provider hooks, so Reddit's adapter cannot import it
  // without an import cycle: it stays here until that family takes its page step as a hook argument (section 9 of
  // docs/review/ARCHITECTURE.md).
  if (plan.gateway === 'reddit_native_action') {
    assertRedditWrite(plan);
    return;
  }
  if (checks?.contract) {
    checks.contract(plan);
    return;
  }
  if (plan.specialTransport)
    fail(
      'WRITE_CONTRACT_UNAVAILABLE',
      'For Google Drive media imports, use amcp_media prepare and execute. Other binary transports need a dedicated upload contract.',
    );
  const family = familyOf(plan);
  if (family?.assert) {
    // The whole stage is passed in, so a family that checks derived requests imports no lifecycle module (ARC-04).
    family.assert(plan, () => assertGatewayShape(plan), assertWriteShape);
    return;
  }
  assertNoMethodOverride(plan);
  // The provider's generic write contract before the reviewed routes (the measurement providers' resource writes).
  checks?.routeWrite?.(plan);
  const supported = reviewedWriteFamily(plan);
  if (!supported) {
    const reason = withheldWriteReason(plan.gateway, plan.action),
      program = withheldWriteProgramId(plan.gateway, plan.action);
    fail(
      'WRITE_CONTRACT_UNAVAILABLE',
      'This route is outside the reviewed campaign-management execution contracts. Use a local dry run.',
      // A write that waits on a provider program names its discovery-only entry in capabilities (ACC-05).
      reason ? {reason, ...(program ? {program_id: program} : {})} : {},
    );
  }
  assertGatewayShape(plan);
}

/**
 * The generic write checks of a gateway: query parameters, method tunnelling, paused creation of serving entities and
 * the structure of native operations. A family that relies on them calls them through its `assert` hook. Each
 * provider's own checks are its adapter's (`checks.shape`), asked where this stage named the provider: before the
 * generic checks, after the query parameters, and after the method checks with `expect`, the paused-creation rule.
 */
function assertGatewayShape(plan: CompiledRequest): void {
  const body = object(plan.body),
    shape = providerHooks(plan.gateway)?.checks?.shape;
  shape?.before?.(plan, body);
  // Meta's own first checks stay here: they name budget_schedule_specs, a field v26.0 removed, only to refuse it, and
  // tests/meta-version.test.mjs reads every string literal of a Meta module as a name AMCP may send.
  if (plan.gateway === 'meta_native_action') metaShapeBefore(plan, body);
  // A reviewed write carries body fields only, but for its provider's qualified concurrency parameter.
  const concurrency = shape?.queryParameter;
  if (Object.keys(plan.query).some(k => k !== concurrency))
    fail('WRITE_CONTRACT_UNAVAILABLE', 'Reviewed writes accept body fields and qualified concurrency parameters only.');
  shape?.afterQuery?.(plan, body);
  if (
    ['method', '_method', 'http_method', 'method_override', 'batch', 'adbatch'].some(
      k => plan.query[k] !== undefined || body[k] !== undefined,
    ) ||
    /\/batch\//.test(plan.path)
  )
    fail('WRITE_CONTRACT_UNAVAILABLE', 'Batch and method-tunneled writes require individual reviewed native requests.');
  if (plan.method === 'GET' || plan.method === 'HEAD')
    fail('WRITE_CONTRACT_UNAVAILABLE', 'Side-effecting GET/HEAD actions are not qualified for execution.');
  shape?.after?.(plan, body, expectState);
}
/** Meta's write shape before the generic checks: a creative's own contract, and no budget schedules or inline creatives. */
function metaShapeBefore(plan: CompiledRequest, body: JsonObject) {
  const route = plan.path,
    method = plan.method;
  if (route.endsWith('/adcreatives')) validateMetaCreative(body, route);
  if (body.budget_schedule_specs !== undefined)
    fail(
      'WRITE_CONTRACT_UNAVAILABLE',
      "Schedule budget increases with meta_campaign_id_budget_schedules_create or meta_ad_set_id_budget_schedules_create (/{id}/budget_schedules), whose review checks the spending policy, the caps and Meta's limits.",
      {field: 'budget_schedule_specs'},
    );
  if (
    method === 'POST' &&
    (/^\/v[^/]+\/act_[^/]+\/ads$/.test(route) || ['meta_ad_id_update', 'meta_ad_update'].includes(plan.action)) &&
    body.creative !== undefined
  ) {
    // An inline creative would skip the creative contract's field list and its Page and Instagram identity checks.
    let creative = body.creative;
    if (typeof creative === 'string')
      try {
        creative = JSON.parse(creative);
      } catch {
        creative = undefined;
      }
    if (
      !creative ||
      typeof creative !== 'object' ||
      Array.isArray(creative) ||
      Object.keys(creative).join() !== 'creative_id' ||
      typeof creative.creative_id !== 'string' ||
      !/^[1-9][0-9]{0,31}$/.test(creative.creative_id)
    )
      fail(
        'WRITE_CONTRACT_UNAVAILABLE',
        'A reviewed ad names an existing creative as {creative_id}. Create the creative first with meta_ad_account_id_adcreatives_create, whose review checks its Page, Instagram account and fields.',
        {field: 'creative'},
      );
  }
}

/** Refuses a new serving entity whose `key` is not one of `values` (an explicit paused or draft state). */
function expectState(record: JsonObject, key: string, values: string[]) {
  if (!values.includes(record[key]))
    fail('PAUSED_CREATION_REQUIRED', 'New serving entities require an explicit paused or draft state.', {
      field: key,
      allowed: values,
    });
}
