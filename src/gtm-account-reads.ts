import {DelegatedNativeCompiler} from './delegated-native.js';
import {MirrorError} from './errors.js';
import {sameLogin} from './connection-authority.js';
import {assertGatewayOffered} from './provider-offering.js';
import {assertProviderActionAvailable} from './retired-provider-actions.js';
import {listingBinding, listingPlace, projectListing} from './account-free-listing.js';
import {accessSetAudit} from './access-sets.js';
import type {Store} from './store.js';
import type {CredentialProvider} from './auth.js';
import type {NativeTransport, TransportResult} from './transport.js';
import type {Actor, CompiledRequest, Connection, JsonObject} from './types.js';

/**
 * Tag Manager's two account-free reads (r25-field2-access, B3; the owner's field report of 2026-11-21, issues 3 and 4):
 * gtm_ops LIST_ACCOUNTS, `GET /tagmanager/v2/accounts`, and LOOKUP_CONTAINER, `GET /tagmanager/v2/accounts/containers:lookup`,
 * name no account, so ScopeGuard (src/scope.ts) can never bind them to one: the listing was refused for want of an account_id
 * and, with one, as an unowned resource, and the lookup was refused as the account "containers" (src/gtm-adapter.ts). They are
 * this workflow's instead, which keeps what the guard keeps by its own rules:
 *
 * - It resolves the login without an account (a second login without connection_id is AMBIGUOUS_CONNECTION) and sends only
 *   these two exact GET reads to Tag Manager's own origin, read-only, with the login's recorded permissions and its credentials,
 *   re-checking the actor, the permissions and the login before each attempt as every native read does (src/native-authority.ts).
 *   The query takes only the parameters the route documents and AMCP allows (pageToken, includeGoogleTags and fields for the
 *   listing; one of tagId and destinationId for the lookup), so nothing else reaches Tag Manager.
 * - The answer is projected before anything is returned, kept or cached, by the ownership rule of an account-free listing
 *   (src/account-free-listing.ts, which TikTok's Business Centers can reuse): the accounts this login binds come back whole and
 *   `connected: true`; the others are an identifier and a name for an administrator without a client access set, and a count for
 *   everyone else. A looked-up container is returned only when its own account is one the login binds and the actor reaches;
 *   otherwise GTM_ACCOUNT_NOT_CONNECTED, naming the account to that administrator only, and the body is never returned.
 * - Nothing is remembered as ownership, so a listing opens no read of an account the login does not bind.
 * - The pages are bounded: ten pages, a thousand accounts, sixty seconds; a longer listing says it is not complete.
 * - A read that returned something is audited under its request, as the native reads it replaces are (lead review S3-1): one
 *   gtm_account_read_completed event with the actor, the client access set, the login, the action and the counts, and no account
 *   name and no ID of an account the login does not bind. A refusal is audited by the tool, as every refusal is.
 */
const gateway = 'gtm_native_action',
  actions = ['LIST_ACCOUNTS', 'LOOKUP_CONTAINER'],
  maxPages = 10,
  maxRows = 1000,
  maxMs = 60000;
const listQuery = ['pageToken', 'includeGoogleTags', 'fields'],
  lookupQuery = ['tagId', 'destinationId'];
const tagPattern = /^[A-Z]{1,4}-[A-Z0-9-]{3,40}$/;
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

/** Whether this operation and action of the Tag Manager tool are one of the two reads this workflow answers. */
export const gtmAccountReadAction = (operation: string, action: unknown): boolean =>
  operation === 'gtm_ops' && typeof action === 'string' && actions.includes(action);

// The generic compiler checks the arguments (the route's parameters, their types, a credential parameter, an unknown name in
// params or query); this workflow adds what it allows on top of them. One instance serves the process, as the service's does.
let compiler: DelegatedNativeCompiler | undefined;
const compile = (input: JsonObject): CompiledRequest =>
  (compiler ??= new DelegatedNativeCompiler()).compile(gateway, {operation: 'gtm_ops', arguments: input});

const listRefusal = () =>
  new MirrorError(
    'INVALID_ARGUMENT',
    'Listing Tag Manager accounts takes only pageToken, includeGoogleTags and fields.',
    {allowed_query: listQuery},
  );
const lookupRefusal = (field?: string) =>
  new MirrorError(
    'INVALID_ARGUMENT',
    'Look a container up by exactly one of tagId and destinationId, a Tag Manager ID such as GTM-ABC1234 or AW-123456789, and no other query parameter.',
    {...(field ? {field} : {}), allowed_query: lookupQuery},
  );
const unusable = () =>
  new MirrorError(
    'UPSTREAM_RESPONSE_INVALID',
    'Tag Manager returned an answer that AMCP cannot check against this login: an account or container without a numeric account ID, a repeated page token or a page that is not a list. If you sent fields, keep accountId and nextPageToken in it.',
    {},
    502,
  );

/**
 * The account a row names: its accountId, or the account of its resource name (accounts/{id} for an account,
 * accounts/{id}/containers/{id} for a container); both when it gives both, and they must agree. A row that names none, a
 * non-numeric one or two that disagree cannot be checked against the login and is refused.
 */
function accountOf(row: JsonObject, container = false): string {
  const named = row.accountId,
    path = typeof row.path === 'string' ? row.path : undefined,
    fromPath =
      path === undefined
        ? undefined
        : (container ? /^accounts\/(\d+)\/containers\/\d+$/ : /^accounts\/(\d+)$/).exec(path)?.[1];
  if (named !== undefined && (typeof named !== 'string' || !/^\d+$/.test(named))) throw unusable();
  if (path !== undefined && fromPath === undefined) throw unusable();
  const id = named ?? fromPath;
  if (id === undefined || (fromPath !== undefined && fromPath !== id)) throw unusable();
  return id;
}
/**
 * A field mask that keeps nextPageToken: a mask that drops it would end every listing after the first page without saying
 * so, which would read as a complete list. A mask that already names it or selects everything is left as it is.
 */
function keepingToken(fields: string): string {
  const top: string[] = [];
  let depth = 0,
    word = '';
  for (const char of fields) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      top.push(word);
      word = '';
    } else word += char;
  }
  top.push(word);
  return top.some(name => name === 'nextPageToken' || name === '*') ? fields : fields + ',nextPageToken';
}

/**
 * Answers gtm_ops LIST_ACCOUNTS and LOOKUP_CONTAINER (see the module comment). Native GETs only; it never writes, keeps nothing
 * and returns, as its error or its answer, nothing the actor may not be told.
 */
export async function gtmAccountReads(
  store: Store,
  transport: NativeTransport,
  credentials: CredentialProvider,
  input: JsonObject,
  actor: Actor,
  requestId: string,
): Promise<JsonObject> {
  store.assertActorActive(actor);
  const action = String(input.action),
    listing = action === 'LIST_ACCOUNTS',
    plan = compile(input),
    allowed = listing ? listQuery : lookupQuery;
  // A withdrawn method is refused first, as the native path does (src/service.ts runPlan); neither of these two is withdrawn today.
  assertProviderActionAvailable(plan);
  // Both routes are GET reads of the pinned vendor snapshot; a plan that is not is refused.
  if (plan.method !== 'GET' || !plan.readOnly)
    throw new MirrorError('STATE_READ_UNSAFE', 'Tag Manager account reads must be native GET requests.');
  // Only the parameters this workflow allows reach Tag Manager, and a lookup names exactly one well-formed ID.
  const extra = Object.keys(plan.query).find(key => !allowed.includes(key));
  if (extra !== undefined) throw listing ? listRefusal() : lookupRefusal(extra);
  if (listing) {
    if (plan.query.pageToken !== undefined && (typeof plan.query.pageToken !== 'string' || !plan.query.pageToken))
      throw listRefusal();
    if (plan.query.fields !== undefined && (typeof plan.query.fields !== 'string' || !plan.query.fields))
      throw listRefusal();
  } else {
    const named = lookupQuery.filter(key => plan.query[key] !== undefined);
    if (named.length !== 1) throw lookupRefusal();
    const id = plan.query[named[0]!];
    if (typeof id !== 'string' || !tagPattern.test(id)) throw lookupRefusal(named[0]);
  }
  assertGatewayOffered(gateway);
  // The captured schema of gtm_ops takes connection_id and no alias of it, and no dry_run: this is a read, and a read sends.
  const connection = store.resolveConnection(actor, gateway, plan.accountId, input.connection_id),
    auth = await credentials.get(connection);
  // The authority of every attempt, as src/native-authority.ts keeps it for a native read, without the guard: the account-free
  // route is this workflow's, and the guard would refuse it as an unowned resource. The actor is active, the login is still the
  // actor's choice with every permission it recorded, and its credentials are still the login's.
  const access = (): Connection => {
    store.assertActorActive(actor);
    const current = store.resolveConnection(actor, gateway, plan.accountId, connection.id);
    if (connection.scopes.some(scope => !current.scopes.includes(scope)))
      throw new MirrorError(
        'INSUFFICIENT_SCOPE',
        'The selected login lost recorded permissions during this request. Inspect its current scopes before restarting.',
        {},
        403,
      );
    if (!sameLogin(auth, store.connectionCredentials(current)))
      throw new MirrorError(
        'CONNECTION_AUTHORITY_CHANGED',
        'The selected login changed during this request. Restart reads with its current authorization; preserve existing write receipts.',
        {},
        409,
      );
    return current;
  };
  // What decides what the actor may see is the login's accounts after the last read, not before the first (lead review S3-2): an
  // account unbound during the read, or dropped from the actor's client access set, must not be returned. The native path
  // authorizes a page against the login resolved after it as well (src/service.ts); this is the same step, taken once more with the
  // authority checks, just before the lookup's owner check and the listing's projection.
  const bindingAfterRead = () => listingBinding(store, actor, access());
  // The read names no account, so its rate and circuit keys are the login's.
  const send = async (page: CompiledRequest): Promise<JsonObject> => {
    const result: TransportResult = await transport.request(
      {...page, accountId: undefined},
      access(),
      auth,
      undefined,
      {
        beforeAttempt: access,
      },
    );
    access();
    if (result.status !== 200 || !obj(result.data) || result.data.error) throw unusable();
    return result.data;
  };
  const common = {success: true, dry_run: false, action: plan.action, connection_id: connection.id};
  // The record of a read that returned something: who, which login and what, by counts; never a name or an unbound account's ID.
  const record = (fields: JsonObject) =>
    store.appendAudit(actor.tenantId, requestId, {
      event: 'gtm_account_read_completed',
      actor: actor.userId,
      ...accessSetAudit(actor),
      connection_id: connection.id,
      action: plan.action,
      ...fields,
    });
  if (!listing) {
    const tag = String(plan.query[lookupQuery.find(key => plan.query[key] !== undefined)!]);
    let container: JsonObject;
    try {
      container = await send(plan);
    } catch (e) {
      // Tag Manager says no container with this ID is visible to this login by a 404, or by a plain denial (never a
      // missing permission, a replaced login or a rate limit, which keep their own refusals and remedies).
      if (
        e instanceof MirrorError &&
        ((e.code === 'UPSTREAM_ERROR' && e.status === 404) || (e.code === 'PROVIDER_ACCESS_DENIED' && e.status === 403))
      )
        throw new MirrorError(
          'NOT_FOUND',
          'No container with this tag ID is visible to this Tag Manager login.',
          // The HTTP status of Tag Manager's answer (404, or 403 for a plain denial), so the two stay apart for whoever reports it.
          {gateway, connection_id: connection.id, http_status: e.status},
          404,
        );
      throw e;
    }
    const owner = accountOf(container, true);
    const binding = bindingAfterRead();
    // A container of an account this login does not bind, or that the actor's access set does not reach, is withheld
    // whole; only an administrator without an access set is told which account it is.
    if (listingPlace(binding, owner) !== 'bound')
      throw new MirrorError(
        'GTM_ACCOUNT_NOT_CONNECTED',
        'Container {tag} belongs to a Tag Manager account this login does not bind. An administrator connects it in Connections, then look it up again.',
        {gateway, connection_id: connection.id, ...(binding.administrator ? {account_id: owner} : {})},
        403,
        false,
        {tag},
      );
    if (plan.accountId !== undefined && plan.accountId !== owner)
      throw new MirrorError(
        'ACCOUNT_SCOPE_MISMATCH',
        'Container {tag} is in Tag Manager account {account} of this login, not the selected one.',
        {gateway, connection_id: connection.id, account_id: owner, selected_account_id: plan.accountId},
        403,
        false,
        {tag, account: owner},
      );
    record({pages: 1, returned: 1, account_id: owner, tag});
    return {...common, data: container, pages: 1, truncated: false};
  }
  const rows: JsonObject[] = [],
    seen = new Set<string>(),
    tokens = new Set<string>(),
    started = Date.now();
  let cursor = plan.query.pageToken as string | undefined,
    pages = 0,
    more: string | undefined;
  for (;;) {
    const query = {
      ...plan.query,
      ...(typeof plan.query.fields === 'string' ? {fields: keepingToken(plan.query.fields)} : {}),
      ...(cursor ? {pageToken: cursor} : {}),
    };
    const answer = await send({...plan, query});
    pages++;
    if (
      !Array.isArray(answer.account ?? []) ||
      (answer.nextPageToken !== undefined && typeof answer.nextPageToken !== 'string')
    )
      throw unusable();
    for (const row of (answer.account ?? []) as unknown[]) {
      if (!obj(row)) throw unusable();
      const id = accountOf(row);
      if (!seen.has(id)) {
        seen.add(id);
        rows.push(row);
      }
    }
    const next = (answer.nextPageToken as string | undefined) || undefined;
    if (!next) break;
    if (next === cursor || tokens.has(next)) throw unusable();
    tokens.add(next);
    cursor = next;
    if (pages >= maxPages || rows.length >= maxRows || Date.now() - started > maxMs) {
      more = next;
      break;
    }
  }
  const binding = bindingAfterRead();
  const projected = projectListing(binding, rows, accountOf, (row, id) => ({
    accountId: id,
    name: typeof row.name === 'string' ? row.name : null,
    connected: false,
  }));
  record({
    pages,
    returned: projected.rows.length,
    not_connected: projected.notConnected,
    truncated: more !== undefined,
  });
  return {
    ...common,
    data: {
      account: projected.rows,
      // The accounts Tag Manager lists for this login that it does not bind: shown by identifier and name to an administrator
      // without an access set, and only counted for everyone else.
      not_connected: projected.notConnected,
      ...(more ? {nextPageToken: more} : {}),
    },
    pages,
    truncated: more !== undefined,
    complete: more === undefined,
    next_step: {
      website_path: '/connections',
      message:
        'An administrator connects the Tag Manager accounts this login does not bind in Connections; list the accounts again afterwards.',
    },
  };
}
