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
  /** Website sessions only (SEC-06): opened with two-step verification. */
  mfaVerified?: boolean;
  /** Website sessions only (SEC-06): the workspace's own two-step policy covers this member. */
  mfaPolicy?: boolean;
  /** Website sessions only (SEC-06): a two-step requirement's grace period ended before this member enrolled. */
  mfaEnrollmentRequired?: boolean;
  /**
   * A client access set (SEC-08): this credential or member reaches only the accounts the set binds. Absent means the
   * whole workspace, as before. Never on an administrator or owner role.
   */
  accessSetId?: string;
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
  /**
   * Store-assigned login revision (CON-01): bumped when a new authorization, reauthorization or re-provisioning
   * replaces the credentials, never by token refresh. Absent on older rows, which read as 0; callers never set it.
   */
  loginRevision?: number;
  /** Store-assigned random id of the row's first login, so a removed and re-created connection id is a new login. */
  loginId?: string;
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
/**
 * What a reviewed write does, as the family or provider that reviews it declares it (R2.5 S2, src/review-summary.ts): the
 * operation, and, where one request writes several entities, how many, and what one of them is called when its path does
 * not say. The summary's vocabulary is closed, so a declaration names one of its words (`change` is a request whose
 * operations differ); a route that publishes keeps its path's reading, and a deletion stays whatever the method or the
 * destructive flag says.
 */
export interface DeclaredOperation {
  operation: 'create' | 'update' | 'delete' | 'change';
  /** How many entities the request writes (a positive integer); one when omitted. */
  count?: number;
  /** What one of them is called, in the singular ('campaign'), when the request's path does not name it. */
  entity?: string;
  /** What several are called, where the entity's plural is not the entity and an s ('targeting criteria'). */
  plural?: string;
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
  /**
   * The comment list read a TikTok comment status update is reviewed against (PRV-06 B, src/tiktok-ad-comments.ts):
   * the caller's comment_scope, validated by that family and never sent with the update.
   */
  tiktokCommentScope?: JsonObject;
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
  /**
   * Set by the service, never by a caller (the compiler refuses an unrecognised parameter): a first-party workflow, as
   * amcp_ad_previews, sent this read for the person, which is not the person's own request. A provider's read authorizer
   * may admit a read on that path only (Meta's ad identity probe, F-L3-03).
   */
  nested?: true;
  /**
   * The role of a state read in a review (R2.5 M1, plan idea 1): `account` for the read of the account a write creates
   * something in, `parent` for the read of the parent a child is created under. Set where the read is built (src/write-snapshots.ts,
   * the provider's own reads), never by a caller; a read of the objects a write changes has none. The role decides how much of
   * the row the review keeps, and the account is the only container kept to its identity (who it is, its status, its currency
   * and time zone, `review.identity`): a balance, a signed link or a counter of an account is nothing a write depends on. A
   * `parent` is read as a target is, whole but for the fields its provider's table says change by themselves
   * (`review.volatile`), because its budget, bid, flight, schedule, targeting and status are what the child is created under
   * (lead review S2-1). The role is metadata for the review's ordering of what changed (R2.5 M1, `material`) and for the
   * rotation harness; it narrows nothing for a parent. A `reference` is an object a write only names (a funding instrument a
   * Reddit campaign is paid from): its provider keeps its existence and the fields the write uses of it (`review.identity`),
   * not its meters and computed state (lead review S3-4). The role of a read is `readRole`'s (src/review-state-core.ts), asked
   * by the state stage and by `material` alike; nothing else reads this property.
   */
  stateRole?: 'account' | 'parent' | 'reference';
  scopeContext?: {
    metaReportReviewId?: string;
    campaignId?: string;
    linkedinPostReviewId?: string;
    microsoftExtensionTypes?: string[];
    microsoftAssociationPairs?: {entityId: string; extensionId: string}[];
    /** The campaign criterion a Microsoft location-criterion verification read looks for (CMP-03). */
    microsoftCriterionId?: string;
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
  /** Server-derived Standard Shopping listing group read (ad group with campaign, or its complete tree); never caller supplied. */
  googleShoppingTreeState?: {kind: 'ad_group' | 'tree'; ad_group: string};
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
  /** On unless false: tools/list carries routing summaries of at most 2,000 characters; amcp_tool_help has the rest. */
  compactDescriptions?: boolean;
  /** Rollback only: amcp_workspace capabilities returns the whole graph unless view:"summary" is asked for. */
  capabilitiesGraphDefault?: boolean;
  /**
   * Per-action argument checks of the AMCP tools (MCP-07, src/first-party-contracts.ts): "report" (the default) adds a
   * meta warning for an argument the action does not read; "enforce" refuses it with INVALID_ARGUMENT naming it.
   */
  actionArguments?: 'report' | 'enforce';
}
export interface CallOptions {
  mode: 'strict' | 'enhanced';
  flags: EnhancementFlags;
}
