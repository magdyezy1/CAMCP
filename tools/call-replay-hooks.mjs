// Loader hook registered by tools/call-replay-recorder.mjs: wraps the recorded functions of the compiled target modules
// (tools/call-replay.mjs, `targets`) as they load. Every other module loads unchanged.
import {instrument, targetOf, targets} from './call-replay.mjs';

let root;
export async function initialize(data) {
  root = data?.root;
}
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const id = root ? targetOf(url, root) : undefined;
  if (!id || result.format !== 'module' || result.source === undefined) return result;
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  return {...result, source: instrument(source, targets[id], id)};
}
