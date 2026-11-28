import {sha256, stable} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Requests the service built from a source it read, not requests a caller sent (r25-fr-listings: a copy of product trees, or a tree made to
 * match a list, src/google-listing-group-build.ts). A leaf both the review and a provider import, so that the review names no provider.
 *
 * A request the service built holds what no caller types: 3,000 operations. Its review is the ordinary review of its family, with two
 * differences. Its plan carries a mark (`CompiledRequest.treeBuild`: which build made it, how many operations it holds and their SHA-256), so that
 * it may pass the limit of a hand-sent request, and the mark stands for those operations and no others; and the call that built it, not
 * its operations, is what preparing it again repeats.
 */
export interface BuiltInput {
  /** The build action that made the request. */
  by: string;
  /** The input a "prepare again" of the review repeats: the call that built it. */
  prepareInput: JsonObject;
}
/**
 * The inputs of the reviews the service built, by the input object that prepares each. Only the service puts an input here, after it built that
 * input's arguments itself; an input a caller sent is never in it (a caller cannot reach the object), so a caller cannot ask for the mark.
 */
export const builtInputs = new WeakMap<object, BuiltInput>();
/** The mark of a plan whose operations the service built: how many they are and their SHA-256, so that the mark stands for these operations alone. */
export function builtMark(plan: CompiledRequest, by: string): NonNullable<CompiledRequest['treeBuild']> {
  const body = plan.body as JsonObject | undefined,
    operations = body && Array.isArray(body.operations) ? body.operations : [];
  return {by, operations: operations.length, operations_sha256: sha256(stable(operations))};
}
