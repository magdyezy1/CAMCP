export type JsonObject = Record<string, any>;
export interface Action {
  name: string;
  canonical_name: string;
  aliases: string[];
  method: string | null;
  path: string | null;
  read_only: boolean | null;
  destructive: boolean | null;
  required: string[];
  path_parameters: string[];
  evidence: string;
  raw: JsonObject;
  gateway?: string;
}
export interface Catalog {
  gateway: string;
  mode: 'direct' | 'delegated';
  api_version: string | null;
  reported_total: number | null;
  captured: number;
  complete: boolean;
  denominator_kind: string;
  actions: Action[];
  gaps: string[];
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
  schema_evidence: string;
  mode: string;
  operations?: JsonObject[];
  help: JsonObject;
}
export interface RegistryData {
  surface: string;
  discovery: JsonObject;
  tools: ToolDefinition[];
  catalogs: Catalog[];
  descriptions: Record<string, JsonObject>;
  supplemental: Action[];
  provenance: JsonObject;
}
export interface Actor {
  tenantId: string;
  userId: string;
  role: 'reader' | 'operator' | 'admin';
  ownerUserId?: string;
  accountVersion?: number;
  membershipRole?: 'owner' | 'admin' | 'operator' | 'viewer';
  testAccount?: boolean;
  signedInAt?: number;
}
export interface Connection {
  id: string;
  tenantId: string;
  gateway: string;
  accounts: string[];
  label: string;
  enabled: boolean;
  baseUrl?: string;
  apiVersion?: string;
  scopes: string[];
  userAgent?: string;
  resourceBindings?: {accountId: string; pathPrefix: string; query?: JsonObject}[];
  isDefault?: boolean;
  /** Explicit per-account mutation grants; absent means read-only. */
  writeAccounts?: string[];
  /** New OAuth logins opt into reviewed writes when resources are selected. */
  defaultWriteAccess?: boolean;
  /** Verified Microsoft advertiser-account -> parent customer mapping from discovery. */
  accountCustomers?: Record<string, string>;
  /** Google account -> accessible login customer verified by account discovery. */
  accountLoginCustomers?: Record<string, string>;
}
export interface Credentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  clientSecret?: string;
  developerToken?: string;
  loginCustomerId?: string;
  consumerKey?: string;
  consumerSecret?: string;
  tokenSecret?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  headers?: Record<string, string>;
  redirectUri?: string;
  /** Apple Ads API signing credentials; encrypted with the connection, never public metadata. */
  appleTeamId?: string;
  appleKeyId?: string;
  applePrivateKey?: string;
}
export interface CompiledRequest {
  gateway: string;
  action: string;
  method: string;
  path: string;
  query: JsonObject;
  body?: unknown;
  origin?: string;
  headers: Record<string, string>;
  readOnly: boolean;
  destructive: boolean;
  requiresConfirmation: boolean;
  accountId?: string;
  evidence: string;
  warnings: string[];
  specialTransport?: string;
  queryArrayEncoding?: 'json' | 'repeat';
  responseControls?: import('./projection.js').ResponseControls;
  metaReportRead?: JsonObject;
  /** What a review keeps of a personal-data write: counts, digest and confirmations, never the people. */
  personalData?: JsonObject;
  /** Server-derived original TikTok task binding and process-local deadline. */
  tiktokReportRead?: JsonObject;
  tiktokReportDeadline?: number;
  /** Server-derived original X report bindings and bounded retrieval deadline. */
  xReportRead?: JsonObject[];
  xReportDeadline?: number;
  xAudienceDeadline?: number;
  xTargetingDeadline?: number;
  snapUpdateDeadline?: number;
  linkedinTemplateDeadline?: number;
  /** Server-derived Criteo report binding. External inputs cannot set this. */
  criteoReportRead?: JsonObject;
  criteoReportReviewId?: string;
  /** Process-local monotonic deadline for a server-derived report retrieval. */
  criteoReportDeadline?: number;
  criteoCampaignDeadline?: number;
  scopeContext?: {
    metaReportReviewId?: string;
    campaignId?: string;
    linkedinPostReviewId?: string;
    microsoftExtensionTypes?: string[];
    microsoftAssociationPairs?: {entityId: string; extensionId: string}[];
    appleSharedAccountIds?: string[];
    appleSharedResultAccounts?: string[];
    appleSharedOrgId?: string;
    appleCurrency?: string;
    gtmPriorAuthHash?: string;
    redditProfileId?: string;
    redditProfileUserId?: string;
    redditPostReviewId?: string;
    criteoVerifiedLineId?: string;
    criteoVerifiedCampaignId?: string;
    criteoLineItemCampaignId?: string;
    criteoLineItemId?: string;
    criteoOverrideCampaignId?: string;
    criteoOverrideLineItemId?: string;
    criteoPreferredLineItemId?: string;
    criteoCatalogId?: string;
  };
  reportDownload?: {offset: number; limit: number};
  /** A Google legacy list alias applied this default GAQL LIMIT because the caller gave none. */
  legacyDefaultLimit?: number;
  contractEvidence?: JsonObject;
  /** Internal, derived exact-target GAQL read. Never accepted from client input. */
  googleState?: {
    resource: string;
    names: string[];
    allowMissing: boolean;
    removedAsAbsent?: boolean;
    exactFields?: string[];
  };
  /** Complete bounded Google feed membership/content read; never caller supplied. */
  googleAssetSetState?: {names: string[]};
  /** Server-derived bound for Google measurement discovery; never caller-supplied. */
  measurementSyncDeadline?: number;
  /** Exact internal Adjust read marker/deadline; unavailable to external inputs. */
  adjustReportRead?: boolean;
  adjustReportDeadline?: number;
  /** Complete saved planning hierarchy, derived from exact native resource bindings. */
  googleKeywordPlanState?: {names: string[]};
  /** Bounded current account/profile discovery for Reddit metadata writes. */
  redditProfilesState?: boolean;
  /** Exact selected-account targeting discovery; external callers cannot supply this context. */
  criteoTargetState?: {lineId: string; kind: string; audienceIds: string[]};
  /** Complete selected-account Meta labels and exact target membership; internal only. */
  metaLabelState?: {
    kind: 'create' | 'rename' | 'delete' | 'attach';
    labelId?: string;
    targetId?: string;
    verification?: boolean;
  };
  /** Server-derived DV360 membership/absence read, never caller supplied. */
  dv360ListState?: {kind: string; collection: boolean};
  /** Server-derived DV360 targeting read (line item or advertiser, complete assigned targeting or assigned list); never caller supplied. */
  dv360TargetingState?: {
    kind: 'line_item' | 'advertiser' | 'targeting' | 'reference' | 'audience';
    lineItemIds?: string[];
    adGroupIds?: string[];
    types?: string[];
    reference?: string;
  };
  /** Server-derived Performance Max listing group read (asset group with campaign, or its complete tree); never caller supplied. */
  googleListingGroupState?: {kind: 'group' | 'tree'; group: string};
  /** Server-derived TikTok negative keyword read (campaigns, ad groups or one complete keyword list); never caller supplied. */
  tiktokNegativeKeywordState?: {
    kind: 'adgroups' | 'campaigns' | 'campaign_adgroups' | 'keywords';
    ids: string[];
    objectType?: string;
  };
  /** Server-derived TikTok account brand safety read (Pangle block list or Brand Safety Hub); never caller supplied. */
  tiktokBrandSafetyState?: 'pangle' | 'hub';
  /** Server-derived Meta value rule set list read of the selected account; never caller supplied. */
  metaValueRuleState?: true;
  /** Server-derived Meta account controls or publisher block list read of the selected account; never caller supplied. */
  metaBrandSafetyState?: 'controls' | 'blocklist';
  /** Server-derived Criteo auction line item read of the selected account; never caller supplied. */
  criteoLineItemState?: {
    campaignId?: string;
    lineItemId?: string;
    siblings: boolean;
    products?: boolean;
    keywords?: boolean;
    multipliers?: boolean;
  };
  /** Server-derived Criteo preferred line item read of the selected account; never caller supplied. */
  criteoPreferredState?: {campaignId?: string; lineItemId?: string; creativeId?: string};
  /** Server-derived Criteo catalog request read of the selected account; never caller supplied. */
  criteoCatalogState?: {catalogId?: string; optional?: boolean};
  /** Server-derived DV360 Demand Gen ad group read of the selected advertiser; never caller supplied. */
  dv360AdGroupState?: {adGroupId?: string; lineItemId?: string; optional?: boolean};
  /** Server-derived DV360 ad asset read of one YouTube video of the selected advertiser; never caller supplied. */
  dv360AdAssetState?: {youtubeVideoId: string};
  /** Server-derived DV360 Demand Gen ad read of the selected advertiser; never caller supplied. */
  dv360AdState?: {adGroupAdId?: string; adGroupId?: string; videoAssetIds: string[]; optional?: boolean};
  /** Server-derived GTM workflow read. Never accepted from external arguments. */
  gtmState?: {kind: 'resource' | 'collection' | 'status' | 'latest'; key?: string};
  /** Internal complete GTM workspace read; targets only qualify absence checks. */
  gtmWorkspaceState?: {latest: boolean; targets?: {kind: string; id: string}[]};
}
export interface EnhancementFlags {
  catalogEnvelope?: boolean;
  catalogPagination?: boolean;
  catalogFields?: boolean;
  dryRunSchemaDefault?: boolean;
  uniformIdempotency?: boolean;
  scopeMetadata?: boolean;
  confirmationMetadata?: boolean;
  nativeRequests?: boolean;
  largeIdGuard?: boolean;
  catalogPreflight?: boolean;
  /** Lists each action once in tool schemas: legacy aliases stay accepted but are left out of the advertised enum. */
  compactSchemas?: boolean;
}
export interface CallOptions {
  mode: 'strict' | 'enhanced';
  flags: EnhancementFlags;
}
