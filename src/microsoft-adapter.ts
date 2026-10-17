import type {ProviderHooks, WireHeaders} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {
  compileMicrosoft,
  microsoftCustomer,
  microsoftCustomerOrigin,
  microsoftGateway,
  microsoftRead,
} from './microsoft-native.js';

/**
 * Microsoft Advertising's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification:
 * its contracts declare their reads (Get, Poll and Submit operations on their exact route), so they decide alone. The
 * account read is its own compiled GetAccount contract, whose response names the account under Account. On the wire,
 * every request carries the developer token and, but for the two discovery reads, the selected account and its
 * customer; a report submission is sent once.
 */
export const microsoftHooks: ProviderHooks = Object.freeze({
  gateway: microsoftGateway,
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
});
