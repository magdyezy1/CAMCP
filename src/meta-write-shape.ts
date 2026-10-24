/**
 * Meta's first write-shape checks (ARC-01 phase B, wave 4c): its adapter's `checks.shape.before`, which the write-shape
 * stage (src/write-shape.ts) asks before its generic checks, where it named Meta before. A creative keeps its own
 * contract, a budget schedule is its own reviewed write, and a reviewed ad names an existing creative.
 *
 * budget_schedule_specs, a field Meta v26.0 removed, is named here only to refuse it: tests/meta-version.test.mjs reads
 * every string literal of a Meta module as a name AMCP may send, and accepts this one name in this module only because
 * it checks that the write-shape stage refuses a Meta write that carries it.
 */
import {validateMetaCreative} from './creative-validation.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {fail} from './write-common.js';

/** Meta's write shape before the generic checks: a creative's own contract, and no budget schedules or inline creatives. */
export function metaWriteShapeBefore(plan: CompiledRequest, body: JsonObject): void {
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
