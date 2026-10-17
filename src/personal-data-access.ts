import {assertTwoStepSession, workspaceOwner} from './spend-policy.js';
import {normalizeAccount} from './scope.js';
import type {Store} from './store.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {fail, type Direction} from './personal-data.js';

/**
 * The owner's switch for personal-data writes (policy rule 3, approved 2026-09-30): off by default for every ad
 * account; only the workspace owner turns one on; turning it off takes effect at once, including for reviews already
 * prepared. Adding people needs the owner at execution; a removal may be run by an operator.
 */
const kind = 'personal_data_account';
/** The switch's document id: one ad account of one platform. */
const switchId = (gateway: string, account: string) => gateway + ':' + normalizeAccount(gateway, account);
/** Whether the owner turned personal-data writes on for this ad account. */
export function personalDataSwitch(
  store: Store,
  tenant: string,
  gateway: string,
  account: string,
): JsonObject | undefined {
  return store.repo(kind, tenant).payload(switchId(gateway, account));
}
/** Every account the owner turned on, for the owner's view. */
export function personalDataAccounts(store: Store, tenant: string): JsonObject[] {
  return store.documents(tenant, kind).map(d => ({
    gateway: d.gateway,
    account_id: d.account_id,
    enabled_at: new Date(d.enabled_at).toISOString(),
    enabled_by: d.enabled_by,
  }));
}
/**
 * Refuses a personal-data write the account is not open for: at prepare and inspect for anyone; at execution, the
 * switch is read again, and adding people needs the workspace owner.
 */
export function assertPersonalDataAllowed(
  store: Store,
  actor: Actor,
  plan: CompiledRequest,
  direction: Direction,
  executing: boolean,
): void {
  const account = plan.accountId ?? '';
  if (!personalDataSwitch(store, actor.tenantId, plan.gateway, account))
    fail(
      'PERSONAL_DATA_OFF',
      'Personal-data writes are off for this ad account. Only the workspace owner turns them on, one account at a time (amcp_workspace enable_personal_data).',
      {gateway: plan.gateway, account_id: account},
      403,
    );
  // A people upload under the workspace's two-step policy needs a two-step-verified session (SEC-06).
  if (executing && direction === 'add') assertTwoStepSession(actor, 'execute_personal_data');
  if (executing && direction === 'add' && !workspaceOwner(store, actor))
    fail(
      'OWNER_REQUIRED',
      'Only the workspace owner runs an upload of people: an operator may prepare it, and the owner approves it by executing the review.',
      {direction},
      403,
    );
}
/** The owner turns personal-data writes on for one ad account of a connection. */
export function enablePersonalData(store: Store, actor: Actor, input: JsonObject): JsonObject {
  if (input.confirmed !== true || typeof input.connection_id !== 'string' || typeof input.account_id !== 'string')
    fail(
      'INVALID_ARGUMENT',
      'Give connection_id, account_id and confirmed=true to turn personal-data writes on for one ad account.',
    );
  const connection = store.connectionsFor(actor).find(c => c.id === input.connection_id);
  if (!connection) fail('CONNECTION_NOT_FOUND', 'No connection of this workspace has that id.', {}, 404);
  const account = normalizeAccount(connection.gateway, input.account_id);
  if (!connection.accounts.map(a => normalizeAccount(connection.gateway, a)).includes(account))
    fail('ACCOUNT_SCOPE_MISMATCH', 'Select an ad account of that connection.', {}, 403);
  const record = {gateway: connection.gateway, account_id: account, enabled_by: actor.userId, enabled_at: Date.now()};
  store.putDocument(actor.tenantId, kind, switchId(connection.gateway, account), record);
  store.appendAudit(actor.tenantId, kind + '/' + switchId(connection.gateway, account), {
    event: 'personal_data_enabled',
    gateway: connection.gateway,
    account_id: account,
    by: actor.userId,
  });
  return {
    enabled: true,
    gateway: connection.gateway,
    account_id: account,
    effect:
      'Customer-list uploads to this ad account can be prepared by an operator and run by the owner; removals can be run by an operator. Every other rule of the personal-data policy still applies to each upload.',
    accounts: personalDataAccounts(store, actor.tenantId),
  };
}
/** The owner turns personal-data writes off for one ad account; reviews already prepared are refused at execution. */
export function disablePersonalData(store: Store, actor: Actor, input: JsonObject): JsonObject {
  if (typeof input.gateway !== 'string' || typeof input.account_id !== 'string')
    fail('INVALID_ARGUMENT', 'Give gateway and account_id to turn personal-data writes off for one ad account.');
  const id = switchId(input.gateway, input.account_id),
    was = !!personalDataSwitch(store, actor.tenantId, input.gateway, input.account_id);
  store.transaction(() => {
    store.repo(kind, actor.tenantId).delete(id);
  });
  store.appendAudit(actor.tenantId, kind + '/' + id, {
    event: 'personal_data_disabled',
    gateway: input.gateway,
    account_id: normalizeAccount(input.gateway, input.account_id),
    by: actor.userId,
  });
  return {
    enabled: false,
    was_enabled: was,
    effect: 'Taken at once: reviews already prepared for this account are refused at execution.',
    accounts: personalDataAccounts(store, actor.tenantId),
  };
}
