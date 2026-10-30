import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {assertMeasurementWrite, validateMeasurementState} from './measurement-writes.js';
import {gtmSafeConfiguration} from './gtm-workflow-writes.js';

/**
 * Google Tag Manager's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: a
 * folder's entity listing is a POST read. Readiness reads the selected Tag Manager account (CON-03). Its writes follow
 * the measurement resource contract (src/measurement-writes.ts) and may carry the workspace fingerprint; a resource's
 * 404, or its status read, is its documented state, and the resource checks every state read's target.
 */
export const gtmHooks: ProviderHooks = Object.freeze({
  gateway: 'gtm_native_action',
  checks: Object.freeze({
    routeWrite: assertMeasurementWrite,
    shape: Object.freeze({queryParameter: 'fingerprint'}),
    state: Object.freeze({
      settled(read: CompiledRequest, result: TransportResult) {
        if (result.status !== 404 && !(read.path.endsWith('/status') && result.status === 200)) return false;
        validateMeasurementState(read, result);
        return true;
      },
      ownTarget: true as const,
      target: (read: CompiledRequest, result: TransportResult) => validateMeasurementState(read, result),
    }),
  }),
  // A review keeps a Tag Manager resource's configuration, its authorization code as a digest and its container
  // access and trigger lists in one order (src/gtm-workflow-writes.ts).
  review: Object.freeze({snapshot: (_read: CompiledRequest, d: JsonObject) => gtmSafeConfiguration(d)}),
  reads: Object.freeze({
    postRead: (_plan: CompiledRequest, pathname: string) => /\/folders\/[^/:]+:entities$/.test(pathname),
  }),
  accountRead: Object.freeze({
    readiness: (id: string, read: (path: string, origin: string) => CompiledRequest) =>
      read('/tagmanager/v2/accounts/' + id, 'https://tagmanager.googleapis.com'),
    names: (id: string, data: JsonObject) => String(data.accountId) === id,
  }),
  // A delete answers 200 without a body.
  wire: Object.freeze({
    emptyWrite: (plan: CompiledRequest, response: Response) => response.status === 200 && plan.method === 'DELETE',
  }),
  // Workbook reporting (ARC-01, reporting; src/report-resource-scope.ts): a saved query names its Tag Manager account
  // by an account selector (an account ID or accounts/{id}) or by an accounts/{id}/... resource name.
  reportScope: Object.freeze({
    account(kind: unknown, value: string) {
      if (kind === 'account') return /^(?:accounts\/)?([A-Za-z0-9_-]{1,200})$/.exec(value)?.[1];
      if (kind !== 'resource' || value.split('/').some(part => part === '.' || part === '..')) return undefined;
      return /^accounts\/([A-Za-z0-9_-]{1,200})(?:\/[^/\x00-\x20\\?#%]+)*$/.exec(value)?.[1];
    },
    anchorKind: (anchor: string) => (anchor.startsWith('accounts/') ? 'account' : undefined),
  }),
});
