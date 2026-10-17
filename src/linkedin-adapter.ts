import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest, Connection} from './types.js';
import {MirrorError} from './errors.js';
import {linkedinPlanningRoute} from './linkedin-planning-reads.js';

/**
 * LinkedIn's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the audience
 * insight and forecast POSTs, and the share-authorization permission check, a documented read whose path holds
 * "authorization", with its authorization.
 */
const denied = (message: string): never => {
  throw new MirrorError('RESOURCE_SCOPE_REQUIRED', message, {}, 403);
};
/** The permission check names the selected sponsored account as its agent and an administrator bound the tuple. */
function authorizeShareAuthorizationRead(p: CompiledRequest, c: Connection, account: string): boolean {
  const path = decodeURIComponent(p.path),
    key = path.split('/').at(-1)!,
    parts = key.split('&').map(s => s.split('='));
  if (parts.length !== 3 || parts.some(p => p.length !== 2) || new Set(parts.map(p => p[0])).size !== 3)
    denied('Use the documented owner, loggedInMember and agent composite key.');
  const values = Object.fromEntries(parts);
  if (
    !/^urn:li:(?:company|organization):\d+$/.test(values.owner ?? '') ||
    !/^urn:li:person:[A-Za-z0-9_-]+$/.test(values.loggedInMember ?? '') ||
    values.agent !== 'urn:li:sponsoredAccount:' + account
  )
    denied('The exact company/member permission check must identify the selected sponsored account.');
  if (!c.scopes.includes('rw_ads'))
    throw new MirrorError(
      'INSUFFICIENT_SCOPE',
      'LinkedIn share-authorization diagnostics require rw_ads; reading this status does not grant publishing permission.',
      {},
      403,
    );
  if (
    !c.resourceBindings?.some(
      b => b.accountId === account && b.pathPrefix === path && Object.keys(b.query ?? {}).length === 0,
    )
  )
    denied(
      'An administrator must bind this exact company/member/account permission-check tuple before it can be queried.',
    );
  return true;
}

export const linkedinHooks: ProviderHooks = Object.freeze({
  gateway: 'linkedin_native_action',
  reads: Object.freeze({
    plannedRead: (p: CompiledRequest) => !!linkedinPlanningRoute(p),
    qualifiedRead: (p: CompiledRequest) =>
      (!p.origin || p.origin === 'https://api.linkedin.com') &&
      /^\/rest\/organizationalEntityCreateShareAuthorizations\/[^/]+$/.test(p.path),
    authorizeQualifiedRead: authorizeShareAuthorizationRead,
    postRead: (plan: CompiledRequest) => !!linkedinPlanningRoute(plan),
  }),
});
