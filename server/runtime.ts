import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import type {CallOptions} from '../src/types.js';
import {googleDeveloperTokenWarning} from '../src/google-version.js';
export function createRuntime(warn: (line: string) => void = line => process.stderr.write(line)) {
  // Configuration that still starts but needs the operator's attention (PRV-04): stated once, at startup.
  const developerToken = googleDeveloperTokenWarning();
  if (developerToken) warn('AMCP: ' + developerToken + '\n');
  if (process.env.MIRROR_ALLOW_WRITES !== undefined && !['true', 'false'].includes(process.env.MIRROR_ALLOW_WRITES))
    throw new Error('MIRROR_ALLOW_WRITES must be true or false.');
  const allowWrites = process.env.MIRROR_ALLOW_WRITES === 'true';
  if (allowWrites && !process.env.MIRROR_MASTER_KEY)
    throw new Error('Write support requires encrypted persistent connection credentials.');
  const registry = new Registry();
  const store = new Store(process.env.MIRROR_DB ?? '.runtime/mirror.sqlite', process.env.MIRROR_MASTER_KEY);
  const enhanced = process.env.MIRROR_MODE === 'enhanced';
  const flags = JSON.parse(process.env.MIRROR_FLAGS ?? '{}');
  const options: CallOptions = {mode: enhanced ? 'enhanced' : 'strict', flags};
  const service = new MirrorService(registry, store, undefined, options, {
    allowWrites,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  service.transport.coordination = store;
  return {registry, store, service};
}
