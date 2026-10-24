import type {ContractRow} from './provider-adapter.js';
import type {CompiledRequest} from './types.js';
import {gtmDiagnosticOperations} from './gtm-diagnostics.js';
import {measurementConnectionSyncKind} from './measurement-connection-sync.js';
import {businessConnectionSyncKind} from './google-business-sync.js';
import {adjustReportingKind} from './adjust-reporting.js';
import {metaPostActions} from './meta-existing-posts.js';
import {placeActionReadKind} from './google-place-action-discovery.js';

/**
 * The provider workflows registry (ARC-01 phase B, wave 4c): the AMCP workflows that answer an operation of a
 * provider's delegated tool, or of AMCP's native tool on a provider's behalf, without a native route of their own
 * (WooCommerce's store listing, Tag Manager's diagnostics, GA4's and Search Console's sync, Business Profile's sync,
 * Adjust's reporting, Meta's Ad Library and existing posts), and the provider rules of their action contract rows. It
 * imports the providers' workflow modules so that the shared modules consult it instead (the architecture ratchet,
 * tools/architecture-map.mjs, counts it with the providers), and it never decides: each shared stage keeps its own
 * rules and order and asks it only where it named a provider before.
 */

/**
 * Where the action contract ledger (src/action-contracts.ts) applies a workflow's row among its own rules, in its
 * order: before the connection diagnostics, before the disconnect rule, or after it.
 */
export type ContractStage = 'before_diagnostics' | 'before_disconnect' | 'after_disconnect';

/** A workflow's action contract row: where the ledger applies it, which operations and actions it lists, and its row. */
export interface WorkflowContract {
  readonly stage: ContractStage;
  /** Whether the row of this operation and action of the workflow's tool is the workflow's, given the row so far. */
  listed(operation: string, action: string, row: {readonly status: string}): boolean;
  readonly row: ContractRow;
}

/** One provider workflow: the provider whose it is (its gateway), the tool whose operations it answers, its row. */
export interface ProviderWorkflow {
  readonly provider: string;
  readonly tool: string;
  readonly contract?: WorkflowContract;
}

const measurementSyncRow: ContractRow = Object.freeze({
  status: 'local_workflow' as const,
  implementation: 'src/measurement-connection-sync.ts / src/google-measurement-assets.ts',
  reason:
    'Administrator-scoped GA4 properties or Search Console sites discovery with dry-run default, bounded native GETs and atomic complete metadata persistence. Preserves selections/write grants; scopes, login, concurrent sync and current authority are fenced. No OAuth grant change or provider mutation.',
  tests: Object.freeze(['tests/measurement-connection-sync.test.ts']),
});
const measurementSync = (tool: string): ProviderWorkflow =>
  Object.freeze({
    provider: tool,
    tool,
    contract: Object.freeze({
      stage: 'before_disconnect' as const,
      listed: (operation: string, action: string) => measurementConnectionSyncKind(tool, operation, action),
      row: measurementSyncRow,
    }),
  });

/**
 * The provider workflows, in the order each shared stage consulted them. Two workflows of one tool answer different
 * operations (tests/provider-action-contracts.test.mjs), so at most one answers a call or lists a row.
 */
export const providerWorkflows: readonly ProviderWorkflow[] = Object.freeze([
  Object.freeze({
    provider: 'commerce_native_action',
    tool: 'commerce_native_action',
    contract: Object.freeze({
      stage: 'before_diagnostics' as const,
      listed: (operation: string) => operation === 'woocommerce_list_stores',
      row: Object.freeze({
        status: 'local_workflow' as const,
        implementation: 'src/woocommerce-source.ts',
        reason:
          'Implemented AMCP workflow; platform and payload support depend on its underlying contracts. This row never enables native writes.',
        tests: Object.freeze([
          'tests/woocommerce-store-discovery.test.mjs',
          'tests/mcp-woocommerce-store-discovery.test.mjs',
        ]),
      }),
    }),
  }),
  Object.freeze({
    provider: 'gtm_native_action',
    tool: 'gtm_native_action',
    contract: Object.freeze({
      stage: 'before_diagnostics' as const,
      listed: (operation: string) => gtmDiagnosticOperations.has(operation),
      row: Object.freeze({
        status: 'local_workflow' as const,
        implementation: 'src/gtm-diagnostics.ts',
        reason:
          'AMCP scoped read-only configuration audit or local reviewed-write verification job status. This workflow never publishes or resubmits a mutation.',
        tests: Object.freeze(['tests/gtm-diagnostics.test.ts']),
      }),
    }),
  }),
  measurementSync('ga4_native_action'),
  measurementSync('google_search_console_native_action'),
  Object.freeze({
    provider: 'google_business_native_action',
    tool: 'google_business_native_action',
    contract: Object.freeze({
      stage: 'before_disconnect' as const,
      listed: (operation: string, action: string) =>
        businessConnectionSyncKind('google_business_native_action', operation, action),
      row: Object.freeze({
        status: 'local_workflow' as const,
        implementation: 'src/google-business-sync.ts / src/google-business-assets.ts',
        reason:
          'Administrator-scoped Business Profile account and optional location discovery. Bounded native GETs, required read mask, shared location parents, current authority and per-attempt login fencing; complete groups persist atomically without changing selections or grants. Website Connections uses the same discovery; no OAuth grant change or provider mutation.',
        tests: Object.freeze(['tests/google-business-sync.test.ts']),
      }),
    }),
  }),
  Object.freeze({
    provider: 'adjust_native_action',
    tool: 'adjust_native_action',
    contract: Object.freeze({
      stage: 'before_disconnect' as const,
      listed: (operation: string, action: string) => adjustReportingKind(operation, action),
      row: Object.freeze({
        status: 'local_workflow' as const,
        implementation: 'src/adjust-reporting.ts',
        reason:
          'Scoped Adjust app/event/filter discovery and bounded native JSON or app-indexed pivot reporting. Encrypted token transport, current grants, exact numeric strings, documented no-content, warning/completeness metadata and no provider writes. Local asset listing describes configured bindings only.',
        source: 'https://dev.adjust.com/en/api/rs-api/',
        tests: Object.freeze(['tests/adjust-reporting.test.ts']),
      }),
    }),
  }),
  Object.freeze({
    provider: 'meta_native_action',
    tool: 'amcp_native_action',
    contract: Object.freeze({
      stage: 'before_disconnect' as const,
      listed: (operation: string) => operation === 'search_ads_library',
      row: Object.freeze({
        status: 'local_workflow' as const,
        implementation: 'src/meta-ad-library.ts',
        reason:
          'Bounded public Meta Ad Library search through the sole/default connection. Media format is translated separately from provider ad category. Geographic API coverage and result limits are explicit; no performance inference or token-bearing URLs are returned.',
        source: 'https://www.facebook.com/ads/library/api/',
        tests: Object.freeze(['tests/meta-ad-library.test.ts']),
      }),
    }),
  }),
  Object.freeze({
    provider: 'meta_native_action',
    tool: 'amcp_native_action',
    contract: Object.freeze({
      stage: 'before_disconnect' as const,
      listed: (operation: string, action: string) =>
        operation === 'fetch_meta_existing_posts' && metaPostActions.includes(action),
      row: Object.freeze({
        status: 'local_workflow' as const,
        implementation: 'src/meta-existing-posts.ts',
        reason:
          'Account-scoped Page/Instagram identity discovery, ephemeral server-side Page token and owned content reads. Exact IDs or bounded canonical permalink lookup with encrypted, scoped continuations. No arbitrary URL fetching or automatic creative writes; native eligibility and approval remain unverified.',
        source: 'https://github.com/facebook/facebook-python-business-sdk/tree/25.0.3/facebook_business/adobjects',
        tests: Object.freeze(['tests/meta-existing-posts.test.ts']),
      }),
    }),
  }),
  // Not a workflow of its own: Business Profile's place-action discovery is a native read, whose row names the
  // modules and tests of its contract.
  Object.freeze({
    provider: 'google_business_native_action',
    tool: 'google_business_native_action',
    contract: Object.freeze({
      stage: 'after_disconnect' as const,
      listed: (operation: string, action: string, row: {readonly status: string}) =>
        row.status === 'native_read' &&
        !!placeActionReadKind({
          gateway: 'google_business_native_action',
          action: operation + '/' + action,
        } as CompiledRequest),
      row: Object.freeze({
        implementation: 'src/delegated-native.ts / src/google-place-action-discovery.ts / src/transport.ts',
        reason:
          'Native place-action metadata, complete bounded link lists or exact link read. Location filters bind the selected location grant; global/region metadata does not establish eligibility. Current scope checks, native envelopes, private URL redaction and explicit page continuation; no ownership or write grants are inferred.',
        tests: Object.freeze([
          'tests/google-place-action-discovery.test.ts',
          'tests/google-place-action-links.test.ts',
        ]),
      }),
    }),
  }),
]);
