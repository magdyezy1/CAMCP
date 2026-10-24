import {MirrorError} from './errors.js';
import type {Actor, JsonObject} from './types.js';
import type {ToolCall} from './workspace-core.js';

/**
 * What every provider's campaign clone shares (ARC-01 phase B, wave 4c: each provider's clone builder left
 * src/campaign-clone.ts for its own module and is its adapter's `campaign.clone`): a step is a plan step, the source
 * is read through the ordinary account-scoped native reads, and a field is copied only when the source holds it.
 */
export type Step = JsonObject;
export const pick = (o: JsonObject, keys: string[]) =>
  Object.fromEntries(keys.filter(k => o[k] !== undefined && o[k] !== null).map(k => [k, o[k]]));
export const unpicked = (o: JsonObject, keys: string[], skip: string[]) =>
  Object.keys(o).filter(k => !keys.includes(k) && !skip.includes(k));
export async function read(call: ToolCall, actor: Actor, gateway: string, input: JsonObject): Promise<unknown> {
  const out = await call(gateway, input, actor);
  if (!out.success)
    throw new MirrorError(out.error.code, 'Reading the source failed: ' + out.error.message, out.error.details);
  if (out.data?.truncated)
    throw new MirrorError(
      'CLONE_SOURCE_TOO_LARGE',
      'The source did not fit in the pages AMCP reads; clone a smaller campaign.',
    );
  return out.data?.data;
}
