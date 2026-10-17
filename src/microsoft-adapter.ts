import type {ProviderHooks} from './provider-adapter.js';
import {microsoftGateway, microsoftRead} from './microsoft-native.js';

/**
 * Microsoft Advertising's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification:
 * its contracts declare their reads (Get, Poll and Submit operations on their exact route), so they decide alone.
 */
export const microsoftHooks: ProviderHooks = Object.freeze({
  gateway: microsoftGateway,
  reads: Object.freeze({readOnly: microsoftRead}),
});
