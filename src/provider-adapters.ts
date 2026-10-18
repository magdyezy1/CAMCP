import type {
  AccountModel,
  BodyDeletions,
  PagingFacts,
  ParkedReason,
  ProviderAdapter,
  ProviderParking,
  ProviderStatus,
} from './provider-adapter.js';

/**
 * The provider adapter registry (ARC-01): one adapter per provider gateway, each with its lifecycle status. This module
 * is a leaf: it imports no provider module and no lifecycle module, so any module may consult it without joining an
 * import cycle (tools/architecture-map.mjs).
 *
 * A parked provider is not offered unless the deployment's AMCP_PROVIDERS (a comma- or space-separated list of
 * provider IDs) names it: it is not listed in tools/list, contracts, capabilities or the website, any tool call that
 * names its gateway is refused with GATEWAY_NOT_OFFERED before its arguments are read (a local read of retained audit
 * history may still filter by it), ScopeGuard refuses every request to it before credentials are fetched, and
 * NativeTransport refuses to send one whichever caller built it. Its reviewed families stay registered, by design: the
 * ledger keeps every family, and the listings that show families filter them by their gateway's status. Its code keeps
 * compiling and its tests keep running with the provider named in AMCP_PROVIDERS. AMCP_PROVIDERS is read at each
 * check, so a process sees one value from its environment.
 */

/** An adapter's account model as declared: its fields as a list. */
type AccountDeclaration = Omit<AccountModel, 'fields'> & {fields?: readonly string[]};

/** A set no module can change after load: ScopeGuard compares requests with these facts. */
function fixedSet(values: readonly string[]): ReadonlySet<string> {
  const set = new Set(values);
  const view: ReadonlySet<string> = Object.freeze({
    has: (value: string) => set.has(value),
    get size() {
      return set.size;
    },
    forEach(fn: (value: string, key: string, set: ReadonlySet<string>) => void, thisArg?: unknown) {
      set.forEach(value => fn.call(thisArg, value, value, view));
    },
    entries: () => set.entries(),
    keys: () => set.keys(),
    values: () => set.values(),
    [Symbol.iterator]: () => set.values(),
  });
  return view;
}

/**
 * The frozen account model of a provider. A reference pattern must be global (every reference in a string is
 * compared); a path pattern must not be, so it keeps no position between requests. Both are frozen.
 */
function accountModel(id: string, {fields, ...declared}: AccountDeclaration): AccountModel {
  if (declared.references && !declared.references.global)
    throw new Error('Provider adapter ' + id + ': account references need a global pattern.');
  if (declared.path && (declared.path.global || declared.path.sticky))
    throw new Error('Provider adapter ' + id + ': the account path pattern must not be global or sticky.');
  if (declared.references) Object.freeze(declared.references);
  if (declared.path) Object.freeze(declared.path);
  return Object.freeze({...declared, ...(fields ? {fields: fixedSet(fields)} : {})});
}

/** Body deletions as frozen facts: the field table and each value list. */
function bodyDeletions(declared: BodyDeletions): BodyDeletions {
  return Object.freeze({
    ...declared,
    fields: Object.freeze(
      Object.fromEntries(Object.entries(declared.fields).map(([k, v]) => [k, Object.freeze([...v])])),
    ),
  });
}

function adapter(
  id: string,
  gateway: string,
  options: {
    families?: readonly string[];
    parked?: ProviderParking;
    account?: AccountDeclaration;
    deletions?: BodyDeletions;
    paging?: PagingFacts;
    executionOptions?: true;
  } = {},
): ProviderAdapter {
  const status: ProviderStatus = options.parked ? 'parked' : 'active';
  return Object.freeze({
    id,
    gateway,
    status,
    ...(options.parked ? {parked: Object.freeze({...options.parked})} : {}),
    familyPrefixes: Object.freeze([...(options.families ?? [id + '_'])]),
    ...(options.account ? {account: accountModel(id, options.account)} : {}),
    ...(options.deletions ? {deletions: bodyDeletions(options.deletions)} : {}),
    ...(options.paging ? {paging: Object.freeze({...options.paging})} : {}),
    ...(options.executionOptions ? {executionOptions: true as const} : {}),
  });
}

// The account fields, references and path patterns ScopeGuard compares (ARC-01 phase B: they were tables in
// src/scope.ts), and what a bound resource is (CON-05: src/account-metadata.ts). tests/provider-account-model.test.mjs
// pins them; a change changes what ScopeGuard compares and is reviewed with src/scope.ts. The body deletions were
// the table of src/execution-risk.ts (bodyDeletionValues, which tests/deletion-policy-coverage.test.mjs holds against
// every pinned provider document).
export const providerAdapters: readonly ProviderAdapter[] = Object.freeze([
  // Google Ads customer IDs are compared without the dashes of their display form (123-456-7890). Customer-level RPCs
  // use customers/{id}:method: the colon ends the ID, just like the slash in customers/{id}/resources.
  adapter('google', 'google_ads_native_action', {
    account: {
      normalize: id => id.replaceAll('-', ''),
      fields: ['customer_id', 'customerId'],
      references: /\bcustomers\/([^/:\s'"),]+)/g,
      path: /\/customers\/([^/:]+)/,
    },
    // A REMOVE account budget proposal, experiment asset detail or targeting restriction operation removes what it names.
    deletions: {
      fields: {
        status: ['REMOVED'],
        proposal_type: ['REMOVE'],
        asset_detail_operation: ['REMOVE'],
        operator: ['REMOVE'],
      },
      source: 'pinned Google Ads v25 Discovery document: writable enums of the request messages',
      removePrefix: 'customers/',
      mutateRemovals: true,
    },
    paging: {tokenParameter: 'page_token'},
  }),
  adapter('google_business', 'google_business_native_action', {account: {kind: 'business_profile'}}),
  // Meta ad account IDs are compared without the act_ prefix of their Graph node form.
  adapter('meta', 'meta_native_action', {
    account: {
      normalize: id => id.replace(/^act_/, ''),
      fields: ['account_id', 'ad_account_id'],
      path: /^\/v[^/]+\/act_([^/]+)/,
    },
    deletions: {
      fields: {status: ['DELETED']},
      source: 'Marketing API campaign, ad set and ad updates: status ACTIVE, PAUSED, DELETED or ARCHIVED',
    },
    executionOptions: true,
  }),
  adapter('tiktok', 'tiktok_native_action', {
    account: {fields: ['advertiser_id', 'advertiser_ids']},
    deletions: {
      fields: {operation_status: ['DELETE']},
      source:
        'API for Business v1.3 campaign, ad group and ad /status/update/: operation_status ENABLE, DISABLE or DELETE',
    },
  }),
  adapter('snapchat', 'snapchat_native_action', {
    account: {fields: ['ad_account_id', 'ad_account_ids'], patchFields: true, path: /^\/v1\/adaccounts\/([^/]+)/},
  }),
  adapter('linkedin', 'linkedin_native_action', {
    account: {
      fields: ['ad_account_id', 'account_id'],
      references: /urn:li:sponsoredAccount:(\d+)/g,
      path: /^\/rest\/(?:adAccounts|adAccountTrustPreferences)\/([^/]+)/,
    },
    deletions: {
      fields: {status: ['PENDING_DELETION', 'REMOVED'], intended_status: ['PENDING_DELETION', 'REMOVED']},
      source:
        'LinkedIn campaign groups and creatives: "update the status to PENDING_DELETION" to delete (src/linkedin-entity-deletes.ts)',
    },
  }),
  adapter('x', 'x_ads_native_action', {account: {fields: ['account_id'], path: /\/accounts\/([^/]+)/}}),
  adapter('microsoft', 'microsoft_ads_native_action', {
    account: {fields: ['AccountId', 'AccountIds', 'CustomerAccountId']},
    // Status Deleted on entities; Action Delete in AdGroupCriterionAction and AssetGroupListingGroupAction; a user's
    // UserLifeCycleStatus Deleted (Customer Management).
    deletions: {
      fields: {status: ['Deleted'], action: ['Delete'], user_life_cycle_status: ['Deleted']},
      source:
        'pinned Microsoft Advertising v13 Campaign and Customer Management WSDLs: entity statuses Deleted, ItemAction Delete, UserLifeCycleStatus Deleted',
    },
  }),
  adapter('apple', 'apple_ads_native_action', {account: {fields: ['adAccountId', 'account_id', 'ad_account_id']}}),
  adapter('reddit', 'reddit_native_action', {
    account: {fields: ['ad_account_id', 'account_id'], path: /^\/api\/v3\/ad_accounts\/([^/]+)/},
    // effective_status is computed by Reddit, but its request schemas accept it; sent as DELETED it counts as a deletion.
    deletions: {
      fields: {configured_status: ['DELETED'], effective_status: ['DELETED'], status: ['DELETED']},
      source:
        'pinned Reddit Ads API v3 OpenAPI document: configured_status and status ACTIVE, ARCHIVED, DELETED or PAUSED',
    },
  }),
  adapter('dv360', 'dv360_native_action', {
    account: {fields: ['advertiserId', 'advertiser_id'], path: /\/advertisers\/([^/:]+)/},
    deletions: {
      fields: {entity_status: ['ENTITY_STATUS_SCHEDULED_FOR_DELETION']},
      source:
        'pinned Display & Video 360 v4 Discovery document: "the advertiser will be deleted 30 days from when it was first scheduled for deletion"',
    },
  }),
  adapter('ga4', 'ga4_native_action', {
    account: {path: /\/properties\/([^/:]+)/, kind: 'analytics_property'},
    paging: {bodyArgument: 'request'},
  }),
  adapter('gtm', 'gtm_native_action', {account: {path: /\/accounts\/([^/:]+)/, kind: 'tag_account'}}),
  adapter('gsc', 'google_search_console_native_action', {
    families: ['search_console_'],
    account: {kind: 'search_property'},
  }),
  adapter('adjust', 'adjust_native_action'),
  adapter('drive', 'google_drive_native_action', {account: {kind: 'destination'}}),
  adapter('sheets', 'google_sheets_native_action', {account: {kind: 'destination'}}),
  // The owner parked Criteo and the store platforms (PRK-01, PRK-02); P9 gates them by this status (docs/DECISIONS.md).
  // WooCommerce is the only store platform with a gateway: Shopify and Salla have no connection or module to gate.
  adapter('criteo', 'criteo_native_action', {
    parked: {reason: 'owner_parked', decision: 'PRK-02 and P9, docs/DECISIONS.md'},
    account: {path: /\/accounts\/([^/:]+)/},
  }),
  adapter('woocommerce', 'commerce_native_action', {
    parked: {reason: 'owner_parked', decision: 'PRK-01 and P9, docs/DECISIONS.md'},
  }),
  adapter('amazon', 'amazon_native_action', {
    parked: {reason: 'unimplemented', decision: 'CON-06 option (b), docs/DECISIONS.md'},
  }),
]);

/**
 * The gateways with reviewed mutation contracts (src/write-shape.ts writeContractGateways), in the order the review
 * lists them: a request to any other gateway is refused WRITE_CONTRACT_UNAVAILABLE before anything else is checked.
 */
export const reviewedWriteGateways: readonly string[] = Object.freeze([
  'meta_native_action',
  'tiktok_native_action',
  'snapchat_native_action',
  'google_ads_native_action',
  'google_business_native_action',
  'linkedin_native_action',
  'x_ads_native_action',
  'dv360_native_action',
  'reddit_native_action',
  'criteo_native_action',
  'microsoft_ads_native_action',
  // The measurement providers (src/measurement-writes.ts measurementWriteGateways).
  'ga4_native_action',
  'gtm_native_action',
  'google_search_console_native_action',
  'apple_ads_native_action',
]);

const byGateway = new Map(providerAdapters.map(a => [a.gateway, a]));
const byId = new Map(providerAdapters.map(a => [a.id, a]));

/** The adapter of a gateway tool name, or undefined for AMCP's own tools and unknown names. */
export function providerOf(gateway: unknown): ProviderAdapter | undefined {
  return typeof gateway === 'string' ? byGateway.get(gateway) : undefined;
}

export function providerById(id: string): ProviderAdapter | undefined {
  return byId.get(id);
}

/** The provider IDs AMCP_PROVIDERS names. */
export function namedProviders(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set((env.AMCP_PROVIDERS ?? '').split(/[\s,]+/).filter(Boolean));
}

/** Names in AMCP_PROVIDERS that are no provider ID (a misspelt one offers nothing); startup reports them. */
export function unknownProviderIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...namedProviders(env)].filter(id => !byId.has(id)).sort();
}

/** True unless the gateway belongs to a parked provider that AMCP_PROVIDERS does not name. */
export function providerOffered(provider: ProviderAdapter | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return !provider || provider.status === 'active' || namedProviders(env).has(provider.id);
}

/** The adapter whose family prefix is the longest prefix of a reviewed family's name. */
export function familyProvider(family: string): ProviderAdapter | undefined {
  let found: ProviderAdapter | undefined,
    length = 0;
  for (const provider of providerAdapters)
    for (const prefix of provider.familyPrefixes)
      if (family.startsWith(prefix) && prefix.length > length) [found, length] = [provider, prefix.length];
  return found;
}

/** The IDs of parked providers, offered or not (tools/provider-lifecycle.ts does not watch their pages). */
export function parkedProviderIds(): ReadonlySet<string> {
  return new Set(providerAdapters.filter(a => a.status === 'parked').map(a => a.id));
}

export interface ProviderLifecycleEntry {
  provider: string;
  gateway: string;
  status: ProviderStatus;
  reason?: ParkedReason;
  offered: boolean;
}

/** Every provider's lifecycle status and whether this deployment offers it. */
export function providerLifecycle(env: NodeJS.ProcessEnv = process.env): ProviderLifecycleEntry[] {
  return providerAdapters.map(a => ({
    provider: a.id,
    gateway: a.gateway,
    status: a.status,
    ...(a.parked ? {reason: a.parked.reason} : {}),
    offered: providerOffered(a, env),
  }));
}
