import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest} from './types.js';
import {criteoRoute} from './criteo-version.js';

/**
 * Criteo's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts; the provider is parked, P9). Read
 * classification: searches, previews and the retailer bid and category recommendations are POST reads. On the wire,
 * report and campaign reads carry their own deadlines and report output is checked whole.
 */
export const criteoHooks: ProviderHooks = Object.freeze({
  gateway: 'criteo_native_action',
  reads: Object.freeze({
    postRead: (_plan: CompiledRequest, pathname: string) =>
      /\/(?:search|preview)$/.test(pathname) ||
      criteoRoute('/retailers/[^/:]+/(?:cpc-min-bids|recommend-categories|recommend-keywords)$').test(pathname),
  }),
  wire: Object.freeze({
    deadline: (plan: CompiledRequest) =>
      plan.readOnly && plan.method === 'GET'
        ? plan.criteoReportRead
          ? plan.criteoReportDeadline
          : plan.action === 'AMCP_CRITEO_CAMPAIGN_READ'
            ? plan.criteoCampaignDeadline
            : undefined
        : undefined,
    reportOutput: (plan: CompiledRequest) =>
      plan.criteoReportRead?.kind === 'output' &&
      plan.method === 'GET' &&
      criteoRoute('/reports/[a-f0-9-]+/output$', 'i').test(plan.path),
  }),
});
