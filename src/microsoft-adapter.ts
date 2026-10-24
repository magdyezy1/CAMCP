import type {ProviderHooks, ScopeContext, WireHeaders} from './provider-adapter.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {Store} from './store.js';
import {MirrorError} from './errors.js';
import {
  assertMicrosoftWrite,
  compileMicrosoft,
  microsoftCustomer,
  microsoftCustomerOrigin,
  microsoftContracts,
  microsoftGateway,
  microsoftGeoLocationsContract,
  microsoftRead,
  validateMicrosoftResponse,
} from './microsoft-native.js';
import type {TransportResult} from './transport.js';
import {microsoftReportKey} from './microsoft-report-download.js';
// Writes and campaigns (wave 4c).
import {buildMicrosoftSearchRecipe, microsoftSearchRecipe} from './microsoft-search-recipe.js';

/**
 * Microsoft's resource scope, after the account path: the mandatory CustomerAccountId header confines Campaign
 * Management resources, so a request in scope is one of its exact contracts for the selected account's customer; a
 * report poll also needs the report this account and connection submitted. Report scope is validated by the
 * compiler too, and a caller cannot override headers.
 */
function microsoftResourceScope(plan: CompiledRequest, connection: Connection, id: string, {store}: ScopeContext) {
  microsoftCustomer(connection, id);
  // The location lookup's file URL read (CMP-03) has its own exact route; it is no gateway action.
  const contract =
    microsoftContracts.get(plan.action) ??
    (plan.action === microsoftGeoLocationsContract.name ? microsoftGeoLocationsContract : undefined);
  if (!contract || contract.path !== plan.path || contract.method !== plan.method)
    throw new MirrorError('RESOURCE_SCOPE_REQUIRED', 'Unqualified Microsoft request contract.', {}, 403);
  const body = plan.body as JsonObject;
  if (plan.action === 'PollGenerateReport') {
    let receipt: JsonObject | undefined;
    try {
      receipt = store.document(
        connection.tenantId,
        'microsoft_report',
        microsoftReportKey(connection.id, id, body.ReportRequestId),
      );
    } catch (e) {
      if (!(e instanceof MirrorError) || e.code !== 'NOT_FOUND') throw e;
    }
    const ownsReport =
      receipt?.connection_id === connection.id && receipt.account_id === id && receipt.expires_at > Date.now();
    if (!ownsReport && !store.ownsResource(connection, id, 'report/' + body.ReportRequestId))
      throw new MirrorError(
        'RESOURCE_SCOPE_REQUIRED',
        'Submit the Microsoft report using this account and connection before polling.',
        {},
        403,
      );
  }
  return true;
}
/** A submitted report is remembered for its poll, for a day; expired receipts are dropped. */
function observeMicrosoft(plan: CompiledRequest, connection: Connection, id: string, data: unknown, store: Store) {
  const d = data as JsonObject;
  if (plan.action !== 'SubmitGenerateReport' || typeof d?.ReportRequestId !== 'string') return;
  store.rememberResource(connection, id, 'report/' + d.ReportRequestId);
  // The kind's declared expiry (src/document-kinds.ts: expires_at reached), applied through the store layer by this,
  // its owner module, before it saves the next receipt.
  store.repo('microsoft_report', connection.tenantId).purgeExpired(Date.now());
  store.putDocument(connection.tenantId, 'microsoft_report', microsoftReportKey(connection.id, id, d.ReportRequestId), {
    connection_id: connection.id,
    account_id: id,
    request: (plan.body as JsonObject).ReportRequest,
    expires_at: Date.now() + 86400000,
  });
}

/**
 * Microsoft Advertising's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification:
 * its contracts declare their reads (Get, Poll and Submit operations on their exact route), so they decide alone. The
 * account read is its own compiled GetAccount contract, whose response names the account under Account. On the wire,
 * every request carries the developer token and, but for the two discovery reads, the selected account and its
 * customer; a report submission is sent once.
 */
export const microsoftHooks: ProviderHooks = Object.freeze({
  gateway: microsoftGateway,
  // Its contracts decide alone: the write contract, and a state read's response contract in place of the generic
  // success check; the contract is the target check, whatever a family supplies.
  checks: Object.freeze({
    contract: assertMicrosoftWrite,
    state: Object.freeze({
      contract: (read: CompiledRequest, result: TransportResult) => validateMicrosoftResponse(read, result, true),
      ownTarget: true as const,
      target: () => undefined,
    }),
  }),
  // A contract's result field is its state and what its verification read shows; the rest is its envelope.
  review: Object.freeze({
    snapshot(read: CompiledRequest, d: JsonObject) {
      const field = microsoftContracts.get(read.action)?.result;
      return field && Object.hasOwn(d, field) ? {[field]: d[field]} : d;
    },
    observed: (plan: CompiledRequest, data: JsonObject) => data[microsoftContracts.get(plan.action)!.result]?.[0],
  }),
  scope: Object.freeze({resource: microsoftResourceScope, observe: observeMicrosoft}),
  reads: Object.freeze({readOnly: microsoftRead}),
  accountRead: Object.freeze({
    plan: (_read: CompiledRequest, id: string) => compileMicrosoft({action: 'GetAccount', account_id: id}),
    account: (data: JsonObject) => data.Account,
  }),
  wire: Object.freeze({
    headers({plan, url, connection, credentials, headers}: WireHeaders) {
      if (!credentials.developerToken)
        throw new MirrorError('DEVELOPER_TOKEN_REQUIRED', 'Microsoft Advertising requires its own developer token.');
      headers.DeveloperToken = credentials.developerToken;
      if (plan.accountId) {
        headers.CustomerAccountId = plan.accountId;
        headers.CustomerId = microsoftCustomer(connection, plan.accountId);
      } else if (
        plan.action !== 'AMCP_MICROSOFT_DISCOVERY' ||
        ![
          microsoftCustomerOrigin + '/CustomerManagement/v13/User/Query',
          microsoftCustomerOrigin + '/CustomerManagement/v13/Accounts/Search',
        ].includes(url.href)
      )
        throw new MirrorError('ACCOUNT_REQUIRED', 'Microsoft requests require an explicit selected account.');
    },
    // Report submission creates a provider job: one attempt.
    singleAttempt: (plan: CompiledRequest) => plan.action === 'SubmitGenerateReport',
  }),
  // Writes and campaigns (wave 4c): the guided Search recipe (CMP-03).
  campaign: Object.freeze({
    recipes: Object.freeze([Object.freeze({definition: microsoftSearchRecipe, build: buildMicrosoftSearchRecipe})]),
  }),
});
