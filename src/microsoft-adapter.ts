import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {compileMicrosoft, microsoftGateway, microsoftRead} from './microsoft-native.js';

/**
 * Microsoft Advertising's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification:
 * its contracts declare their reads (Get, Poll and Submit operations on their exact route), so they decide alone. The
 * account read is its own compiled GetAccount contract, whose response names the account under Account.
 */
export const microsoftHooks: ProviderHooks = Object.freeze({
  gateway: microsoftGateway,
  reads: Object.freeze({readOnly: microsoftRead}),
  accountRead: Object.freeze({
    plan: (_read: CompiledRequest, id: string) => compileMicrosoft({action: 'GetAccount', account_id: id}),
    account: (data: JsonObject) => data.Account,
  }),
});
