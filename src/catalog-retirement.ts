import {AsyncLocalStorage} from 'node:async_hooks';
import {MirrorError} from './errors.js';
import {providerOf} from './provider-adapters.js';
import type {JsonObject} from './types.js';

/**
 * A catalog retirement step (COM-02 B) only updates a product the catalog already has: its availability becomes "out
 * of stock" or "discontinued" through the reviewed upsert, and an upsert of a missing retailer ID would create a new
 * product instead. A comparison blocks such a product (`retire_absent`), but catalog_plan can be saved from supplied
 * products or a CSV source without one, so catalog_plan records the retailer IDs it retires on the plan
 * (`catalog_retirement`) and the plan runner sets the step's retailer ID around its native prepare and execute. The
 * Meta and X product reviews then refuse, from their own state read, a retirement whose product is not there.
 */
const retiring = new AsyncLocalStorage<string>();
export function withCatalogRetirement<T>(retailerId: string, fn: () => Promise<T>): Promise<T> {
  return retiring.run(retailerId, fn);
}
/** At prepare and execute of a retirement step: the reviewed product is the retired one and it exists. */
export function assertCatalogRetirementTarget(retailerId: unknown, present: boolean): void {
  const expected = retiring.getStore();
  if (expected === undefined) return;
  if (String(retailerId) !== expected || !present)
    throw new MirrorError(
      'CATALOG_RETIRE_ABSENT',
      'This retirement names a product the catalog does not have; retiring it would create it. Nothing was sent: remove it from the retirement.',
      {retailer_id: expected},
      409,
    );
}
/**
 * The retailer ID a plan step retires, or undefined: the step's product is among the plan's retired retailer IDs. The
 * step's catalog destination reads the retailer ID from its payload (its adapter's stepRetailerId, ARC-01).
 */
export function catalogRetirementOf(run: JsonObject, step: JsonObject): string | undefined {
  const ids: unknown = run?.catalog_retirement?.retailer_ids;
  if (!Array.isArray(ids) || step?.kind !== 'write') return undefined;
  const payload = step.arguments?.payload,
    id = providerOf(step.gateway)?.catalogDestination?.stepRetailerId?.(payload);
  return typeof id === 'string' && ids.includes(id) ? id : undefined;
}
