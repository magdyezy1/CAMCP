import {snapUpdateKind, readSnapUpdateState} from './snapchat-nested-updates.js';
import {readSnapPixelNames, snapPixelNamePrerequisites} from './snapchat-pixel-names.js';
import {readSnapEvents, snapEventPrerequisites} from './snapchat-event-details.js';
import {readSnapTemplates, snapTemplatePrerequisites} from './snapchat-dynamic-templates.js';
import {readSnapProductSets, snapProductSetPrerequisites} from './snapchat-product-sets.js';
import {readSnapConversions, snapConversionPrerequisites} from './snapchat-custom-conversions.js';
import {readSnapSegmentDelete, snapSegmentDeletePrerequisites} from './snapchat-segment-deletions.js';
import {readSnapDisclaimers, snapDisclaimerPrerequisites} from './snapchat-offer-disclaimers.js';
import {snapchatMediaCopyPrerequisites, readSnapchatMediaCopy} from './snapchat-media-copy.js';
import {assertSnapCreativeReferences} from './snapchat-lead-forms.js';
import {tiktokAdgroupConversionPrerequisites} from './tiktok-adgroup-conversions.js';
import {tiktokCtaPortfolioPrerequisites} from './tiktok-cta-portfolios.js';
import {tiktokSmartPlusAdPrerequisites} from './tiktok-smart-plus-ads.js';
import {tiktokSmartPlusAdUpdateKind, tiktokSmartPlusAdUpdatePrerequisites} from './tiktok-smart-plus-ad-updates.js';
import {
  tiktokSmartPlusAdgroupUpdateSiblingRead,
  tiktokSmartPlusAdgroupUpdatePrerequisites,
} from './tiktok-smart-plus-adgroup-updates.js';
import {tiktokSmartPlusMaterialStatusPrerequisites} from './tiktok-smart-plus-material-status.js';
import {tiktokManualAdIdentityPrerequisites} from './tiktok-manual-ad-identities.js';
import {tiktokInstantFormFollowUps} from './tiktok-instant-forms.js';
import {linkedinLeadFormKind, rememberLinkedInLeadForm} from './linkedin-lead-forms.js';
import {
  googlePreviewKind,
  readGooglePreviewState,
  googlePreviewDelivery,
  googlePreviewSafeOutcome,
} from './google-preview-writes.js';
import {criteoCampaignKind, assertCriteoCampaignScopes, readCriteoCampaignState} from './criteo-campaign-writes.js';
import {metaReportKind, assertMetaReportScope, readMetaReportState} from './meta-insights-jobs.js';
import {
  xReportKind,
  readXReportState,
  xReportSafeData,
  retainXReport,
  xReportIdentity,
  admitXReport,
} from './x-report-jobs.js';
import {tiktokReportKind, readTiktokReportState, retainTiktokReport, admitTiktokReport} from './tiktok-report-jobs.js';
import {criteoReportKind, assertCriteoReportScopes, readCriteoReportState} from './criteo-report-jobs.js';
import {metaCreativeCreate, metaCreativeState} from './meta-creative-state.js';
import {
  placeActionKind,
  assertPlaceActionScope,
  readPlaceActionState,
  placeActionSafe,
  placeActionSafeError,
} from './google-place-action-links.js';
import {
  businessNotificationKind,
  assertBusinessNotificationActor,
  assertBusinessNotificationScope,
  readBusinessNotificationState,
} from './google-business-notifications.js';
import {
  businessAccessKind,
  assertBusinessAccessActor,
  assertBusinessAccessScope,
  readBusinessAccessState,
} from './google-business-access.js';
import {
  googleDismissalKind,
  assertGoogleDismissalPrerequisites,
  readGoogleDismissalState,
} from './google-recommendation-dismissal.js';
import {
  googleAccessKind,
  assertGoogleAccessActor,
  assertGoogleAccessPrerequisites,
  readGoogleAccessState,
} from './google-user-access.js';
import {
  readRedditProfiles,
  validateRedditCreativePrerequisites,
  assertRedditCreativeAvailable,
} from './reddit-creative-writes.js';
import {readKeywordPlanTree} from './google-keyword-plan-writes.js';
import {xDraftKind, readXDraftState} from './x-draft-writes.js';
import {linkedinRuleKind, readLinkedInRules, linkedinRulePrerequisites} from './linkedin-conversion-rules.js';
import {
  googleBidKind,
  assertGoogleBidScope,
  readGoogleBidState,
  googleBidPrerequisites,
} from './google-bid-modifiers.js';
import {
  linkedinConversionKind,
  assertLinkedInConversionScope,
  readLinkedInConversions,
  linkedinConversionPrerequisites,
} from './linkedin-conversion-links.js';
import {
  metaLabelKind,
  assertMetaLabelScope,
  readMetaLabels,
  validateMetaLabelPrerequisites,
} from './meta-label-writes.js';
import {
  criteoTargetingKind,
  assertCriteoTargetingScopes,
  readCriteoTargeting,
  validateCriteoTargetingPrerequisites,
} from './criteo-targeting-writes.js';
import {readAssetSetContents} from './google-asset-set-writes.js';
import {unsupportedProviderAlias} from './retired-provider-actions.js';
import {gtmWorkspaceKind, readGtmWorkspace, validateGtmWorkspacePrerequisites} from './gtm-workspace-writes.js';
import {assertGtmWorkflowActor, readGtmWorkflow, validateGtmWorkflowPrerequisites} from './gtm-workflow-writes.js';
import {
  appleEntityKind,
  appleSharedAccounts,
  appleSharedAccountReads,
  validateAppleEntityPrerequisites,
} from './apple-entity-writes.js';
import {dv360ListKind, readDV360List, validateDV360ListPrerequisites} from './dv360-list-writes.js';
import {
  dv360TargetingKind,
  readDV360Targeting,
  validateDV360TargetingPrerequisites,
} from './dv360-line-item-targeting.js';
import {googleListingGroupKind, validateGoogleListingGroupPrerequisites} from './google-listing-groups.js';
import {readTiktokNegativeKeywords, validateTiktokNegativeKeywordPrerequisites} from './tiktok-negative-keywords.js';
import {validateTiktokBrandSafetyPrerequisites} from './tiktok-brand-safety.js';
import {validateMetaValueRulePrerequisites} from './meta-value-rules.js';
import {validateMetaBrandSafetyPrerequisites} from './meta-brand-safety.js';
import {
  criteoCatalogKind,
  assertCriteoCatalogScopes,
  readCriteoCatalog,
  criteoCatalogPrerequisites,
} from './criteo-catalog-requests.js';
import {
  criteoOverrideKind,
  assertCriteoOverrideScopes,
  readCriteoOverrides,
  criteoOverridePrerequisites,
} from './criteo-budget-overrides.js';
import {
  criteoLineItemKind,
  assertCriteoLineItemScopes,
  validateCriteoLineItemPrerequisites,
  readCriteoLineItems,
} from './criteo-auction-line-items.js';
import {criteoPromotedProductsKind, validateCriteoPromotedProductsPrerequisites} from './criteo-promoted-products.js';
import {
  criteoKeywordKind,
  criteoBidMultiplierKind,
  validateCriteoLineItemBiddingPrerequisites,
} from './criteo-line-item-bidding.js';
import {dv360AdAssetKind, validateDV360AdAssetPrerequisites} from './dv360-ad-assets.js';
import {dv360SdfKind, readDV360Sdf, dv360SdfPrerequisites} from './dv360-sdf-downloads.js';
import {dv360AdKind, validateDV360AdPrerequisites, readDV360Ads} from './dv360-demand-gen-ads.js';
import {validateGoogleConfigurationState} from './google-configuration-writes.js';
import {checkSpendPolicy, describeExceeded, exceededCaps} from './spend-policy.js';
import {randomUUID} from 'node:crypto';
import {MirrorError, errorRemedy, preciseMessage} from './errors.js';
import {assertGoogleAdsScope} from './google-contracts.js';
import {googleSegmentKind} from './google-custom-segments.js';
import {googleConversionGoalKind, readGoogleConversionGoalState} from './google-conversion-goals.js';
import {googleBiddingEventKind, readGoogleBiddingEventState} from './google-bidding-events.js';
import {googlePortfolioKind, readGooglePortfolioState} from './google-portfolio-strategies.js';
import {googleConversionActionKind, readGoogleConversionActionState} from './google-conversion-actions.js';
import {linkedinDSC, linkedinMediaProjection} from './linkedin-posts.js';
import {writeImpact} from './write-impact.js';
import {evidenceForm, executionEvidence, type EvidenceForm} from './contract-evidence.js';
import {Registry} from './catalog.js';
import {Compiler} from './compiler.js';
import {Store} from './store.js';
import {CredentialProvider} from './auth.js';
import {NativeTransport, type TransportResult} from './transport.js';
import {ScopeGuard, normalizeAccount} from './scope.js';
import {applyExecutionRisk} from './execution-risk.js';
import {authorizeExecution, type ExecutionPolicy} from './preflight.js';
import {guardInput, redact, sha256, stable} from './security.js';
import type {Actor, CallOptions, CompiledRequest, Connection, Credentials, JsonObject} from './types.js';
import {nativeAuthority} from './native-authority.js';
import {DelegatedNativeCompiler} from './delegated-native.js';
import {normalizeSnapshot, reviewStateHash, changedStateFields} from './review-state.js';
import {assertAccountWrite} from './write-access.js';
import {xCreativeKind, xCreativeEdit, readXCreativeState} from './x-creative-writes.js';
import {validateGoogleTargetingState} from './google-targeting-writes.js';
import {validateGooglePausedParents} from './google-paused-parents.js';
import {pausedParentFollowUp, validatePausedParents} from './paused-parents.js';
import {validateGoogleAssetLinkState} from './google-asset-links.js';
import {validateXTargetingState} from './x-targeting-writes.js';
import {xTargetingBatchRoute, readXTargetingBatchState} from './x-targeting-batch.js';
import {linkedinTemplateKind, readLinkedInTemplateState} from './linkedin-audience-templates.js';
import {assertRedditWriteScopes} from './reddit-writes.js';
import {microsoftGateway, microsoftScope} from './microsoft-native.js';
import {validateMicrosoftAssociationState} from './microsoft-associations.js';
import {assertMeasurementScopes, optionalMissingState} from './measurement-writes.js';
import {familyOf, readThroughFamilies} from './reviewed-families.js';
import {assertWritesNotPaused} from './owner-operations.js';
import {assertDV360WriteScope} from './dv360-scope.js';
import {object, fail} from './write-common.js';
import {writeOutcome} from './write-outcome.js';
import {validateState} from './write-state.js';
import {assertWriteShape} from './write-shape.js';
import {snapshotPlans} from './write-snapshots.js';

export const writeTool = {
  name: 'amcp_write',
  description:
    'Use this for any single advertising or measurement change; use amcp_campaign when later steps need IDs that earlier steps create. Inspect, prepare and execute a reviewed native mutation. inspect checks local write-contract support without credentials or network calls. Preparation reads account/resource state and returns a five-minute, actor-bound frozen request, with execute_requirements naming every acknowledgement execute will need. Execution requires its review_id and confirmed=true; idempotency_key defaults to the review_id. Operator role and administrator account write grants are required. A Google Ads mutation or Snapchat batch of more than 25 records is prepared as one review of parts of 25 (group: true) and approved and executed once; execution stops at the first part that does not succeed. This is an AMCP extension, not a captured AMCP tool.',
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: {type: 'string', enum: ['inspect', 'prepare', 'execute']},
      gateway: {type: 'string'},
      arguments: {type: 'object'},
      connection_id: {type: 'string'},
      review_id: {type: 'string'},
      idempotency_key: {
        type: 'string',
        description:
          'Optional at execute: defaults to the review_id. When given it must equal the review_id returned by prepare.',
      },
      confirmed: {type: 'boolean'},
      spend_change_confirmed: {type: 'boolean'},
      cap_override_confirmed: {
        type: 'boolean',
        description:
          'The user approved going beyond a spending cap the owner set. Needed at execute only when prepare lists it in execute_requirements.',
      },
      creative_edit_confirmed: {
        type: 'boolean',
        description:
          'Explicitly acknowledge a reviewed X card edit/deletion or Tweet rename that may disrupt promoted ads. Freeze this choice during prepare and repeat it during execute.',
      },
      evidence: {
        type: 'string',
        enum: ['full', 'ref'],
        description:
          'inspect and prepare: "full" includes the provider contract whole; "ref" only what identifies it (versions, review date, write status, version end), with full_contract naming the amcp_tool_help call that returns the rest. Omitted: whole the first time a session inspects or prepares for a gateway, then "ref".',
      },
    },
    additionalProperties: false,
  },
};
/** A guarded-reader binding: the connection's whole login must stay the one the first read used. */
/** What execute accepts; anything else was frozen at prepare (Snapchat S12). */
const executeFields = [
  'action',
  'review_id',
  'idempotency_key',
  'confirmed',
  'spend_change_confirmed',
  'cap_override_confirmed',
  'creative_edit_confirmed',
  'gateway (the review’s own)',
  'connection_id (the review’s own)',
];
const sameLogin = (message: string) => ({
  value: (credentials: Credentials) => sha256(stable(credentials)),
  changed: (): never => fail('REAUTHORIZATION_REQUIRED', message),
});
/** The call that prepares an expired review's original request again (reviews prepared before this field existed have none). */
const expiredNext = (review: JsonObject): JsonObject =>
  review.prepare_input
    ? {next_call: {tool: 'amcp_write', arguments: {action: 'prepare', ...review.prepare_input}}}
    : {};
/** What execute will ask for, decided at prepare by the same authorizeExecution rules, so a client can ask the user
 * once instead of discovering a missing flag from a refused execute. Advisory: execute re-checks everything. */
export function executeRequirements(
  actor: Actor,
  plan: CompiledRequest,
  policy: ExecutionPolicy,
  reviewId: string,
  creativeEdit: boolean,
  exceeded: JsonObject[] = [],
): JsonObject {
  const reasons: JsonObject[] = [];
  let spend = false;
  try {
    authorizeExecution(actor, plan, {dry_run: false, confirmed: true, idempotency_key: reviewId}, policy, true);
  } catch (e) {
    if (!(e instanceof MirrorError) || e.code !== 'SPEND_CONFIRMATION_REQUIRED') throw e;
    spend = true;
    reasons.push({
      flag: 'spend_change_confirmed',
      reason: e.message,
      ...(e.details.fields ? {fields: e.details.fields} : {}),
    });
  }
  if (exceeded.length)
    reasons.push({
      flag: 'cap_override_confirmed',
      reason:
        'This change goes beyond a spending cap the owner set: ' +
        describeExceeded(exceeded) +
        '. It is not refused; the user decides.',
      exceeded,
    });
  if (creativeEdit)
    reasons.push({
      flag: 'creative_edit_confirmed',
      reason:
        'This review acknowledges a potentially disruptive creative edit; repeat creative_edit_confirmed=true at execute.',
    });
  return {
    confirmed: true,
    idempotency_key: reviewId,
    spend_change_confirmed: spend,
    cap_override_confirmed: exceeded.length > 0,
    creative_edit_confirmed: creativeEdit,
    reasons,
    user_approval:
      spend || creativeEdit || exceeded.length
        ? 'Show the user before_state, the impact and the reasons, and set these flags only after they approve.'
        : 'Execute after the user approves this review.',
  };
}
export class WriteReviewService {
  constructor(
    private registry: Registry,
    private compiler: Compiler,
    private store: Store,
    private transport: NativeTransport,
    private credentials: CredentialProvider,
    private options: CallOptions,
    private policy: ExecutionPolicy,
    private delegated = new DelegatedNativeCompiler(),
  ) {}
  private authority(
    actor: Actor,
    reviewPlan: CompiledRequest,
    request: CompiledRequest,
    connection: Connection,
    auth: Credentials,
  ) {
    return nativeAuthority(this.store, this.registry, actor, request, connection, auth, () => {
      this.access(actor, reviewPlan, connection.id);
      if (
        tiktokReportKind(reviewPlan) &&
        sha256(this.store.credentials(actor.tenantId, connection.id).accessToken ?? '') !==
          sha256(auth.accessToken ?? '')
      )
        fail(
          'TIKTOK_REPORT_TOKEN_CHANGED',
          'The original task access token changed. Preserve existing reviews and task receipts; do not automatically regenerate the task.',
        );
    });
  }
  private async request(
    actor: Actor,
    reviewPlan: CompiledRequest,
    request: CompiledRequest,
    connection: Connection,
    auth: Credentials,
  ) {
    const access = this.authority(actor, reviewPlan, request, connection, auth);
    const response = await this.transport.request(request, access(), auth, undefined, {beforeAttempt: access});
    // A received mutation outcome must be retained before any post-response permission check.
    if (request.readOnly) access();
    return response;
  }
  private access(actor: Actor, plan: CompiledRequest, connectionId?: string): Connection {
    this.store.assertActorActive(actor);
    assertGtmWorkflowActor(plan, actor);
    assertBusinessNotificationActor(plan, actor);
    assertBusinessAccessActor(plan, actor);
    assertGoogleAccessActor(plan, actor);
    if (!this.policy.allowWrites)
      fail('LIVE_WRITES_DISABLED', 'Enable MIRROR_ALLOW_WRITES=true for reviewed write support.');
    if (actor.role === 'reader')
      throw new MirrorError('FORBIDDEN', 'A writer connector and administrator account grant are required.', {}, 403);
    const c = this.store.resolveConnection(actor, plan.gateway, plan.accountId, connectionId),
      id = normalizeAccount(plan.gateway, plan.accountId ?? (c.accounts.length === 1 ? c.accounts[0] : ''));
    assertAccountWrite(this.store, c, id);
    for (const account of appleSharedAccounts(plan)) {
      this.store.resolveConnection(actor, plan.gateway, account, c.id);
      assertAccountWrite(this.store, c, account);
    }
    if (plan.gateway === 'reddit_native_action') assertRedditWriteScopes(c);
    if (criteoTargetingKind(plan)) assertCriteoTargetingScopes(c);
    if (metaReportKind(plan)) assertMetaReportScope(c);
    if (criteoCampaignKind(plan)) assertCriteoCampaignScopes(c, true);
    if (
      criteoLineItemKind(plan) ||
      criteoPromotedProductsKind(plan) ||
      criteoKeywordKind(plan) ||
      criteoBidMultiplierKind(plan)
    )
      assertCriteoLineItemScopes(c, true);
    if (criteoOverrideKind(plan)) assertCriteoOverrideScopes(c, true);
    if (criteoCatalogKind(plan)) assertCriteoCatalogScopes(c, criteoCatalogKind(plan));
    if (criteoReportKind(plan)) assertCriteoReportScopes(c, criteoReportKind(plan));
    if (placeActionKind(plan)) assertPlaceActionScope(c);
    if (businessNotificationKind(plan)) assertBusinessNotificationScope(c);
    if (businessAccessKind(plan)) assertBusinessAccessScope(c);
    if (metaLabelKind(plan)) assertMetaLabelScope(c, true);
    familyOf(plan)?.scope?.(c, true, plan);
    if (googleBidKind(plan)) assertGoogleBidScope(c);
    if (googlePreviewKind(plan) || googleDismissalKind(plan) || googleAccessKind(plan)) assertGoogleAdsScope(c);
    if (
      googleSegmentKind(plan) ||
      googleBiddingEventKind(plan) ||
      googleConversionGoalKind(plan) ||
      googlePortfolioKind(plan) ||
      googleConversionActionKind(plan) ||
      googleListingGroupKind(plan)
    )
      assertGoogleAdsScope(c);
    if (linkedinConversionKind(plan) || linkedinRuleKind(plan)) assertLinkedInConversionScope(c, true);
    // Registered DV360 families check the scope through their scope hook (dv360-scope.ts).
    if (
      dv360ListKind(plan) ||
      dv360TargetingKind(plan) ||
      dv360AdAssetKind(plan) ||
      dv360AdKind(plan) ||
      dv360SdfKind(plan)
    )
      assertDV360WriteScope(c, true);
    if (plan.gateway === microsoftGateway && !c.scopes.some(s => s === microsoftScope || s === 'msads.manage'))
      fail('INSUFFICIENT_SCOPE', 'Reconnect Microsoft Advertising with msads.manage permission.');
    plan.accountId = id;
    new ScopeGuard(this.registry, this.store).authorize(plan, c);
    assertMeasurementScopes(plan, c);
    return c;
  }
  /**
   * The reader a family's state checks use. Each read must be read-only; the review's connection is checked (actor,
   * grants, scopes) and the read authorized by the scope guard before the credentials are fetched, after, and after the
   * response. With a binding, the login must also stay the one the first read used: the binding reduces credentials to
   * a value (undefined when they are unusable), which the stored login must keep matching.
   */
  private guardedReader(
    actor: Actor,
    plan: CompiledRequest,
    connectionId: string,
    unsafe: string,
    binding?: {value: (credentials: Credentials) => string | undefined; changed: () => never},
  ) {
    let bound: string | undefined;
    const read = async (request: CompiledRequest): Promise<TransportResult> => {
      if (!applyExecutionRisk(request).readOnly) fail('STATE_READ_UNSAFE', unsafe);
      const access = () => {
        const current = this.access(actor, plan, connectionId);
        new ScopeGuard(this.registry, this.store).authorize(request, current);
        if (binding) {
          const value = binding.value(this.store.credentials(actor.tenantId, current.id));
          if (value === undefined || (bound !== undefined && value !== bound)) binding.changed();
        }
        return current;
      };
      const c = access(),
        auth = await this.credentials.get(c);
      if (binding) {
        const value = binding.value(auth);
        if (value === undefined) binding.changed();
        bound ??= value;
      }
      access();
      const response = await this.request(actor, plan, request, c, auth);
      access();
      return response;
    };
    return {read, bound: () => bound!};
  }
  private async state(
    actor: Actor,
    plan: CompiledRequest,
    connectionId: string,
    reads: CompiledRequest[],
  ): Promise<unknown[]> {
    if (criteoCampaignKind(plan))
      return readCriteoCampaignState(
        plan,
        this.guardedReader(
          actor,
          plan,
          connectionId,
          'Campaign prerequisites must remain read-only.',
          sameLogin('The selected login changed during campaign preparation. Prepare again.'),
        ).read,
      );
    if (xReportKind(plan)) {
      const reader = this.guardedReader(actor, plan, connectionId, 'Report prerequisites must remain read-only.', {
        value: xReportIdentity,
        changed: () => fail('X_REPORT_LOGIN_CHANGED', 'The X login changed during preparation.'),
      });
      return readXReportState(plan, reader.read, reader.bound);
    }
    if (tiktokReportKind(plan)) {
      const reader = this.guardedReader(actor, plan, connectionId, 'Report prerequisites must remain read-only.', {
        value: c => (c.accessToken ? sha256(c.accessToken) : undefined),
        changed: () =>
          fail(
            'TIKTOK_REPORT_TOKEN_CHANGED',
            'The original task access token changed. Preserve the task; do not automatically regenerate it.',
          ),
      });
      return readTiktokReportState(plan, reader.read, reader.bound);
    }
    if (criteoReportKind(plan))
      return readCriteoReportState(
        plan,
        this.guardedReader(
          actor,
          plan,
          connectionId,
          'Report prerequisites must remain read-only.',
          sameLogin('The selected login changed during report preparation. Prepare again.'),
        ).read,
      );
    if (snapUpdateKind(plan))
      return readSnapUpdateState(
        plan,
        this.guardedReader(
          actor,
          plan,
          connectionId,
          'Snapchat prerequisites must remain read-only.',
          sameLogin('The selected login changed during Snapchat checks. Prepare again with the current login.'),
        ).read,
      );
    if (googlePreviewKind(plan) || googlePortfolioKind(plan) || googleConversionActionKind(plan))
      return (
        googlePreviewKind(plan)
          ? readGooglePreviewState
          : googleConversionActionKind(plan)
            ? readGoogleConversionActionState
            : readGooglePortfolioState
      )(
        plan,
        this.guardedReader(
          actor,
          plan,
          connectionId,
          'Portfolio prerequisites must remain read-only.',
          sameLogin('The selected login changed during portfolio checks. Prepare again with the current login.'),
        ).read,
      );
    if (metaCreativeCreate(plan)) {
      const read = reads[0]!,
        access = () => this.access(actor, plan, connectionId),
        c = access();
      new ScopeGuard(this.registry, this.store).authorize(read, c);
      const auth = await this.credentials.get(c);
      access();
      const result = await this.request(actor, plan, read, c, auth);
      access();
      validateState(read, result);
      return [
        normalizeSnapshot(read, result.data),
        {creative_source: await metaCreativeState(plan, this.store, this.transport, this.credentials, actor, access)},
      ];
    }
    if (googleAccessKind(plan))
      return readGoogleAccessState(
        plan,
        this.guardedReader(actor, plan, connectionId, 'Google access prerequisites must remain read-only.').read,
      );
    if (googleDismissalKind(plan))
      return readGoogleDismissalState(
        plan,
        this.guardedReader(actor, plan, connectionId, 'Recommendation dismissal prerequisites must remain read-only.')
          .read,
      );
    if (businessAccessKind(plan))
      return readBusinessAccessState(
        plan,
        this.guardedReader(actor, plan, connectionId, 'Business access prerequisites must remain read-only.').read,
      );
    if (placeActionKind(plan) || businessNotificationKind(plan))
      return (placeActionKind(plan) ? readPlaceActionState : readBusinessNotificationState)(
        plan,
        this.guardedReader(actor, plan, connectionId, 'Place-action prerequisites must remain read-only.').read,
      );
    if (metaReportKind(plan))
      return readMetaReportState(
        plan,
        this.guardedReader(actor, plan, connectionId, 'Report prerequisites must remain read-only.').read,
      );
    if (googleBiddingEventKind(plan) || googleConversionGoalKind(plan))
      return (googleConversionGoalKind(plan) ? readGoogleConversionGoalState : readGoogleBiddingEventState)(
        plan,
        this.guardedReader(
          actor,
          plan,
          connectionId,
          'Google goal and bidding-event dependency checks must be read-only.',
        ).read,
      );
    if (xTargetingBatchRoute(plan) || linkedinTemplateKind(plan))
      return (linkedinTemplateKind(plan) ? readLinkedInTemplateState : readXTargetingBatchState)(
        plan,
        this.guardedReader(
          actor,
          plan,
          connectionId,
          'Targeting dependencies must remain read-only.',
          sameLogin('The selected login changed during targeting checks.'),
        ).read,
      );
    if (xCreativeKind(plan) || xDraftKind(plan))
      return (xDraftKind(plan) ? readXDraftState : readXCreativeState)(
        plan,
        this.guardedReader(actor, plan, connectionId, 'Creative dependency checks must be read-only.').read,
      );
    const values: unknown[] = [];
    for (const read of reads) {
      if (!applyExecutionRisk(read).readOnly)
        fail('STATE_READ_UNSAFE', 'The state check must be independently read-only.');
      const c = this.access(actor, plan, connectionId);
      new ScopeGuard(this.registry, this.store).authorize(read, c);
      const auth = await this.credentials.get(c);
      this.access(actor, plan, connectionId);
      let result: TransportResult;
      try {
        result = await readThroughFamilies(read, familyPage =>
          readSnapPixelNames(familyPage, pixelNamePage =>
            readSnapEvents(pixelNamePage, eventPage =>
              readSnapTemplates(eventPage, templatePage =>
                readSnapProductSets(templatePage, productSetPage =>
                  readSnapConversions(productSetPage, conversionReadPage =>
                    readDV360Sdf(conversionReadPage, sdfPage =>
                      readSnapSegmentDelete(sdfPage, segmentDeletePage =>
                        readCriteoCatalog(segmentDeletePage, catalogPage =>
                          readSnapDisclaimers(catalogPage, disclaimerPage =>
                            readCriteoOverrides(disclaimerPage, overridePage =>
                              readSnapchatMediaCopy(overridePage, copyPage =>
                                readLinkedInRules(copyPage, rulePage =>
                                  readLinkedInConversions(rulePage, linkPage =>
                                    readGoogleBidState(linkPage, bidPage =>
                                      readMetaLabels(bidPage, metaPage =>
                                        readCriteoTargeting(metaPage, criteoPage =>
                                          readRedditProfiles(criteoPage, redditPage =>
                                            readKeywordPlanTree(redditPage, planningPage =>
                                              readAssetSetContents(planningPage, feedPage =>
                                                readGtmWorkspace(feedPage, workspacePage =>
                                                  readGtmWorkflow(workspacePage, gtmPage =>
                                                    readDV360List(gtmPage, listPage =>
                                                      readDV360Targeting(listPage, targetingPage =>
                                                        readTiktokNegativeKeywords(targetingPage, negativePage =>
                                                          readCriteoLineItems(negativePage, lineItemPage =>
                                                            readDV360Ads(lineItemPage, async page => {
                                                              const current = this.access(actor, plan, connectionId);
                                                              new ScopeGuard(this.registry, this.store).authorize(
                                                                page,
                                                                current,
                                                              );
                                                              const response = await this.request(
                                                                actor,
                                                                plan,
                                                                page,
                                                                current,
                                                                auth,
                                                              );
                                                              this.access(actor, plan, connectionId);
                                                              return response;
                                                            }),
                                                          ),
                                                        ),
                                                      ),
                                                    ),
                                                  ),
                                                ),
                                              ),
                                            ),
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      } catch (e) {
        const absent = optionalMissingState(read, e);
        if (!absent) throw e;
        result = absent;
      }
      const reader = this.access(actor, plan, connectionId);
      validateState(read, result);
      if (read.gateway === 'snapchat_native_action')
        new ScopeGuard(this.registry, this.store).observe(read, reader, result.data);
      // A Smart+ bid edit also reads the campaign's ad groups once the ad group names its campaign.
      const sibling = tiktokSmartPlusAdgroupUpdateSiblingRead(plan, read, result.data);
      if (sibling && !reads.some(r => r.path === sibling.path && stable(r.query) === stable(sibling.query)))
        reads.push(sibling);
      // An active ad under a serving ad squad, ad set or ad group also reads the campaign its parent names.
      const campaign = pausedParentFollowUp(plan, read, result.data);
      if (campaign && !reads.some(r => r.path === campaign.path && stable(r.query) === stable(campaign.query)))
        reads.push(campaign);
      // Instant Forms cannot be read by ID; the first page names how many more pages to read.
      for (const more of tiktokInstantFormFollowUps(read, result.data))
        if (!reads.some(r => r.path === more.path && stable(r.query) === stable(more.query))) reads.push(more);
      if (appleEntityKind(plan) === 'shared_budget' && read.path === plan.path) {
        const accounts = appleSharedAccounts(plan, result.data),
          frozen = plan.scopeContext?.appleSharedAccountIds;
        for (const account of accounts) {
          const current = this.store.resolveConnection(actor, plan.gateway, account, connectionId);
          assertAccountWrite(this.store, current, account);
        }
        if (!frozen) {
          plan.scopeContext = {...plan.scopeContext, appleSharedAccountIds: accounts};
          for (const extra of appleSharedAccountReads(plan, accounts))
            if (!reads.some(r => r.path === extra.path)) reads.push(extra);
        }
      }
      values.push(
        linkedinDSC(plan) && /^\/rest\/(images|videos)\//.test(read.path)
          ? linkedinMediaProjection(plan, object(result.data))
          : normalizeSnapshot(read, result.data),
      );
    }
    validateRedditCreativePrerequisites(plan, values);
    validateCriteoTargetingPrerequisites(plan, values);
    validateMetaLabelPrerequisites(plan, values);
    googleBidPrerequisites(plan, values);
    snapchatMediaCopyPrerequisites(plan, values);
    snapDisclaimerPrerequisites(plan, values);
    snapSegmentDeletePrerequisites(plan, values);
    snapConversionPrerequisites(plan, values);
    snapProductSetPrerequisites(plan, values);
    familyOf(plan)?.prerequisites?.(plan, values);
    snapTemplatePrerequisites(plan, values);
    snapEventPrerequisites(plan, values);
    snapPixelNamePrerequisites(plan, values);
    linkedinConversionPrerequisites(plan, values);
    linkedinRulePrerequisites(plan, values);
    tiktokAdgroupConversionPrerequisites(plan, values);
    tiktokCtaPortfolioPrerequisites(plan, values);
    tiktokManualAdIdentityPrerequisites(plan, values);
    tiktokSmartPlusAdPrerequisites(plan, values);
    tiktokSmartPlusAdUpdatePrerequisites(plan, values);
    tiktokSmartPlusAdgroupUpdatePrerequisites(plan, values);
    tiktokSmartPlusMaterialStatusPrerequisites(plan, values);
    validateAppleEntityPrerequisites(plan, reads, values);
    validateGtmWorkflowPrerequisites(plan, values);
    validateGtmWorkspacePrerequisites(plan, values);
    validateDV360ListPrerequisites(plan, values);
    validateDV360TargetingPrerequisites(plan, values);
    validateGoogleListingGroupPrerequisites(plan, values);
    validateTiktokNegativeKeywordPrerequisites(plan, values);
    validateTiktokBrandSafetyPrerequisites(plan, values);
    validateMetaValueRulePrerequisites(plan, values);
    validateMetaBrandSafetyPrerequisites(plan, values);
    validateCriteoLineItemPrerequisites(plan, values);
    criteoOverridePrerequisites(plan, values);
    criteoCatalogPrerequisites(plan, values);
    validateCriteoPromotedProductsPrerequisites(plan, values);
    validateCriteoLineItemBiddingPrerequisites(plan, values);
    validateDV360AdAssetPrerequisites(plan, values);
    validateDV360AdPrerequisites(plan, values);
    dv360SdfPrerequisites(plan, values);
    if (appleEntityKind(plan) === 'shared_budget' && !plan.scopeContext?.appleSharedOrgId) {
      const account = object(values[reads.findIndex(r => r.path === '/v1/ad-accounts/' + plan.accountId)]).result;
      const target = object(values[reads.findIndex(r => r.path === plan.path)]).result;
      plan.scopeContext = {
        ...plan.scopeContext,
        appleSharedAccountIds: appleSharedAccounts(plan),
        appleSharedOrgId: String(account.orgId),
        appleSharedResultAccounts: (object(plan.body).adAccountIds ?? target.adAccountIds).map(String),
      };
    }
    validateGoogleTargetingState(plan, values);
    validateGooglePausedParents(plan, values);
    validatePausedParents(plan, values);
    validateGoogleAssetLinkState(plan, values);
    validateGoogleConfigurationState(plan, values);
    validateMicrosoftAssociationState(plan, values);
    validateXTargetingState(plan, values);
    return values;
  }
  /** `evidenceDefault` is the evidence form of a caller that sent none: see ContractMemory. */
  async call(input: JsonObject, actor: Actor, evidenceDefault?: EvidenceForm): Promise<unknown> {
    guardInput(input);
    for (const key of Object.keys(input))
      if (!Object.hasOwn(writeTool.inputSchema.properties, key))
        fail('INVALID_ARGUMENT', 'Unknown write-tool parameter.', {parameter: key});
    if (input.creative_edit_confirmed !== undefined && typeof input.creative_edit_confirmed !== 'boolean')
      fail('INVALID_ARGUMENT', 'creative_edit_confirmed must be a boolean.');
    const evidence = input.evidence === undefined ? (evidenceDefault ?? 'full') : evidenceForm(input.evidence);
    if (input.action === 'prepare' || input.action === 'inspect') {
      if (
        typeof input.gateway !== 'string' ||
        !input.arguments ||
        typeof input.arguments !== 'object' ||
        Array.isArray(input.arguments)
      )
        fail('INVALID_ARGUMENT', 'prepare requires gateway and arguments.');
      const isDelegated = this.registry.tools.get(input.gateway)?.mode === 'delegated',
        nativeArgs = isDelegated ? object(input.arguments.arguments) : input.arguments;
      if (['aggregate_pages', 'paginate', 'allPages'].some(k => input.arguments[k] || nativeArgs[k]))
        fail('MUTATION_PAGINATION_FORBIDDEN', 'A reviewed mutation executes exactly one request.');
      // Enhanced-mode native_request lets the caller choose the action and the path independently, and several families
      // classify by action; a reviewed mutation must come from a catalog action whose route the compiler derived.
      if (input.arguments.native_request !== undefined || nativeArgs.native_request !== undefined)
        fail(
          'WRITE_CONTRACT_UNAVAILABLE',
          'Reviewed writes use catalog actions. native_request is a read-only extension; name the catalog action and its params instead.',
        );
      const args = isDelegated ? {...input.arguments} : {...input.arguments, dry_run: true};
      this.registry.validate(input.gateway, args, this.options);
      const unavailable = unsupportedProviderAlias(input.gateway, nativeArgs.action);
      if (input.action === 'inspect' && unavailable) {
        const e = new MirrorError('PROVIDER_ACTION_UNSUPPORTED', unavailable.reason, unavailable),
          remedy = errorRemedy(e);
        return {
          executed: false,
          network_requests: 0,
          review_contract_supported: false,
          request: null,
          error: {code: e.code, message: preciseMessage(e), details: e.details, category: remedy.category, remedy},
          live_permissions_verified: false,
          next_step: unavailable.replacement,
        };
      }
      const plan = applyExecutionRisk(
        isDelegated
          ? this.delegated.compile(input.gateway, args)
          : this.compiler.compile(input.gateway, args, this.options),
      );
      if (input.connection_id && nativeArgs.connection_id && input.connection_id !== nativeArgs.connection_id)
        fail('CONFLICTING_PARAMETER', 'Connection IDs must agree.');
      if (input.action === 'inspect') {
        let accountCapability: JsonObject;
        try {
          const c = this.store.resolveConnection(
            actor,
            plan.gateway,
            plan.accountId,
            input.connection_id ?? nativeArgs.connection_id,
          );
          accountCapability = {
            connection_id: c.id,
            account_id: plan.accountId,
            selected: true,
            write_granted: c.writeAccounts?.includes(plan.accountId!) ?? false,
            granted_scopes: c.scopes,
            provider_access: 'requires live preparation',
          };
        } catch (e) {
          accountCapability = {
            selected: false,
            error: e instanceof MirrorError ? {code: e.code, message: e.message} : undefined,
          };
        }
        try {
          assertWriteShape(plan);
          assertRedditCreativeAvailable(plan);
          const reads = snapshotPlans(plan, this.registry);
          return {
            executed: false,
            network_requests: 0,
            review_contract_supported: true,
            request: redact(plan.gateway === 'google_business_native_action' ? placeActionSafe(plan) : plan),
            contract_evidence: executionEvidence(plan, evidence),
            state_reads: reads.map(r => ({method: r.method, path: r.path})),
            live_permissions_verified: false,
            account_capability: accountCapability,
            requirements: {
              deployment_writes_enabled: this.policy.allowWrites,
              operator_role: actor.role !== 'reader',
              account_write_grant_required: true,
              ...(businessNotificationKind(plan) || businessAccessKind(plan) || googleAccessKind(plan)
                ? {
                    administrator_role_required: true,
                    administrator_role: actor.role === 'admin' && actor.testAccount !== true,
                  }
                : {}),
            },
            next_step: 'Use prepare to verify live state and account access.',
          };
        } catch (e) {
          if (!(e instanceof MirrorError)) throw e;
          const remedy = errorRemedy(e);
          return {
            executed: false,
            network_requests: 0,
            review_contract_supported: false,
            request: redact(plan.gateway === 'google_business_native_action' ? placeActionSafe(plan) : plan),
            contract_evidence: executionEvidence(plan, evidence),
            error: {code: e.code, message: preciseMessage(e), details: e.details, category: remedy.category, remedy},
            live_permissions_verified: false,
          };
        }
      }
      assertWriteShape(plan);
      assertRedditCreativeAvailable(plan);
      const c = this.access(actor, plan, input.connection_id ?? nativeArgs.connection_id),
        reads = snapshotPlans(plan, this.registry),
        state = await this.state(actor, plan, c.id, reads);
      validateGoogleAssetLinkState(plan, state, true);
      assertGoogleDismissalPrerequisites(plan, state);
      assertGoogleAccessPrerequisites(plan, state);
      validateGoogleConfigurationState(plan, state, true);
      validateDV360ListPrerequisites(plan, state, true);
      validateGtmWorkflowPrerequisites(plan, state, true);
      validateMicrosoftAssociationState(plan, state, true);
      if (plan.gateway === 'gtm_native_action' && !gtmWorkspaceKind(plan)) {
        const route = this.delegated.data.routes.find(
            r => r.gateway === plan.gateway && r.operation + (r.action ? '/' + r.action : '') === plan.action,
          ),
          fingerprint = object(state[0]).fingerprint;
        if (route?.parameters.fingerprint && typeof fingerprint === 'string' && fingerprint) {
          if (plan.query.fingerprint !== undefined && plan.query.fingerprint !== fingerprint)
            fail('STATE_CHANGED', 'The supplied Tag Manager fingerprint is stale.');
          plan.query.fingerprint = fingerprint;
        }
      }
      if (input.creative_edit_confirmed !== undefined && !xCreativeEdit(plan) && !tiktokSmartPlusAdUpdateKind(plan))
        fail(
          'INVALID_ARGUMENT',
          'creative_edit_confirmed is only for an X creative edit or deletion, or a TikTok Smart+ ad edit.',
        );
      const creativeImpact = writeImpact(plan, state, input.creative_edit_confirmed === true, c.id);
      assertSnapCreativeReferences(plan, state, resource =>
        this.store.ownsResource(c, normalizeAccount(plan.gateway, plan.accountId!), resource),
      );
      const override = input.creative_edit_confirmed === true ? {creative_edit_confirmed: true} : {};
      const reviewId = randomUUID(),
        fingerprint = sha256(stable({tenant: actor.tenantId, user: actor.userId, connection: c.id, plan, ...override})),
        expiresAt = Date.now() + 300000;
      const stateHash = reviewStateHash(state),
        spendPolicy = checkSpendPolicy(this.store, actor, plan, state),
        requirements = executeRequirements(
          actor,
          plan,
          this.policy,
          reviewId,
          input.creative_edit_confirmed === true,
          exceededCaps(spendPolicy),
        );
      this.store.putDocument(actor.tenantId, 'write_review', reviewId, {
        user_id: actor.userId,
        connection_id: c.id,
        plan,
        reads,
        state,
        state_hash: stateHash,
        fingerprint,
        expires_at: expiresAt,
        ...override,
        prepare_input: {
          gateway: input.gateway,
          arguments: input.arguments,
          ...(input.connection_id !== undefined ? {connection_id: input.connection_id} : {}),
          ...(input.creative_edit_confirmed === true ? {creative_edit_confirmed: true} : {}),
          ...(input.evidence !== undefined ? {evidence: input.evidence} : {}),
        },
      });
      this.store.appendAudit(actor.tenantId, reviewId, {
        event: 'write_prepared',
        request: plan,
        fingerprint,
        expires_at: expiresAt,
      });
      return {
        success: true,
        executed: false,
        review_id: reviewId,
        idempotency_key: reviewId,
        expires_at: new Date(expiresAt).toISOString(),
        request: redact(plan.gateway === 'google_business_native_action' ? placeActionSafe(plan) : plan),
        contract_evidence: executionEvidence(plan, evidence),
        before_state: redact(state),
        spend_policy: spendPolicy,
        state_hash: stateHash,
        state_reads: reads.map(r => ({method: r.method, path: r.path})),
        fingerprint,
        confirmation_required: true,
        expires_in_seconds: 300,
        execute_requirements: requirements,
        ...(creativeImpact ? {creative_impact: creativeImpact} : {}),
      };
    }
    if (input.action !== 'execute' || typeof input.review_id !== 'string')
      fail('INVALID_ARGUMENT', 'Use prepare or execute with a review_id.');
    // The idempotency key is the review id; asking the client to repeat it protected nothing. A supplied key must still match.
    if (input.idempotency_key === undefined) input = {...input, idempotency_key: input.review_id};
    if (input.arguments !== undefined)
      fail(
        'INVALID_ARGUMENT',
        'Remove arguments: execute takes review_id, idempotency_key, confirmed and, when execute_requirements lists them, spend_change_confirmed, cap_override_confirmed or creative_edit_confirmed. The request was frozen at prepare; prepare a new review to change it.',
        {field: 'arguments', accepted: executeFields},
      );
    const review = this.store.document(actor.tenantId, 'write_review', input.review_id);
    if (review.user_id !== actor.userId)
      throw new MirrorError('FORBIDDEN', 'The review belongs to a different actor.', {}, 403);
    const plan = review.plan as CompiledRequest;
    assertWriteShape(plan);
    // Repeating the review's own gateway/connection is harmless; a different one would silently change the request.
    if (
      (input.gateway !== undefined && input.gateway !== plan.gateway) ||
      (input.connection_id !== undefined && input.connection_id !== review.connection_id)
    )
      fail(
        'INVALID_ARGUMENT',
        'This review is bound to gateway ' +
          plan.gateway +
          ' and connection ' +
          review.connection_id +
          '; the ' +
          (input.gateway !== undefined && input.gateway !== plan.gateway ? 'gateway' : 'connection_id') +
          ' sent differs. Omit gateway and connection_id (repeating the same ones is accepted), or prepare a new review to use another.',
        {
          field: input.gateway !== undefined && input.gateway !== plan.gateway ? 'gateway' : 'connection_id',
          gateway: plan.gateway,
          connection_id: review.connection_id,
          accepted: executeFields,
        },
      );
    this.access(actor, plan, review.connection_id);
    if (input.idempotency_key !== input.review_id)
      fail('IDEMPOTENCY_REQUIRED', 'Use the exact idempotency_key returned by prepare.');
    authorizeExecution(actor, plan, {...input, dry_run: false}, this.policy, true);
    assertWritesNotPaused(this.store, actor.tenantId);
    if (review.creative_edit_confirmed === true && input.creative_edit_confirmed !== true)
      fail(
        'CREATIVE_EDIT_CONFIRMATION_REQUIRED',
        'This review permits a potentially destructive creative edit. Also provide creative_edit_confirmed=true to execute.',
      );
    if (input.creative_edit_confirmed === true && review.creative_edit_confirmed !== true)
      fail('REVIEW_CHANGED', 'Prepare a new review to acknowledge creative-edit risk. Execute cannot add an override.');
    const fingerprint = sha256(
      stable({
        tenant: actor.tenantId,
        user: actor.userId,
        connection: review.connection_id,
        plan,
        ...(review.creative_edit_confirmed === true ? {creative_edit_confirmed: true} : {}),
      }),
    );
    if (fingerprint !== review.fingerprint)
      fail('REVIEW_CHANGED', 'The stored reviewed request failed its integrity check.');
    const previous = this.store.db
      .prepare('SELECT state,result,fingerprint FROM idempotency WHERE tenant_id=? AND key=?')
      .get(actor.tenantId, input.idempotency_key) as JsonObject | undefined;
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'The key is bound to another request.');
      if (previous.state === 'complete') {
        const saved = {...JSON.parse(previous.result), replayed: true};
        return googlePreviewKind(plan)
          ? googlePreviewDelivery(plan, saved, this.store.previewReceipt(actor.tenantId, input.review_id))
          : saved;
      }
      fail(
        'WRITE_OUTCOME_UNCERTAIN',
        'This review was already submitted. Inspect provider state; do not retry with a new key.',
      );
    }
    assertRedditCreativeAvailable(plan);
    if (review.expires_at <= Date.now())
      fail(
        'REVIEW_EXPIRED',
        'Nothing was submitted. Prepare the same request again and review it.',
        expiredNext(review),
      );
    // Reproject saved envelopes as well: a still-valid review prepared before an
    // upgrade must not conflict solely because its stored envelope was wider.
    // X creative discovery already returns its own validated resource projection.
    const expectedState = xCreativeKind(plan)
      ? review.state
      : review.state.map((value: unknown, i: number) => normalizeSnapshot(review.reads[i], value));
    const current = await this.state(actor, plan, review.connection_id, review.reads),
      expectedHash = reviewStateHash(expectedState),
      actualHash = reviewStateHash(current);
    const creativeImpact = writeImpact(plan, current, review.creative_edit_confirmed === true, review.connection_id);
    if (actualHash !== expectedHash)
      fail(
        'STATE_CHANGED',
        'The provider configuration changed after preparation. Prepare and review a fresh request.',
        {
          expected_state_hash: expectedHash,
          actual_state_hash: actualHash,
          changed_fields: changedStateFields(expectedState, current),
        },
      );
    assertGoogleDismissalPrerequisites(plan, current);
    assertGoogleAccessPrerequisites(plan, current);
    const c = this.access(actor, plan, review.connection_id),
      auth = await this.credentials.get(c);
    this.access(actor, plan, review.connection_id);
    assertSnapCreativeReferences(plan, current, resource =>
      this.store.ownsResource(c, normalizeAccount(plan.gateway, plan.accountId!), resource),
    );
    if (review.expires_at <= Date.now())
      fail(
        'REVIEW_EXPIRED',
        'The review expired during state verification. Nothing was submitted; prepare it again.',
        expiredNext(review),
      );
    assertRedditCreativeAvailable(plan);
    if (xReportKind(plan) && xReportIdentity(auth) !== (current[0] as JsonObject).login_fingerprint)
      fail('X_REPORT_LOGIN_CHANGED', 'The X login changed after preparation.');
    if (tiktokReportKind(plan) && sha256(auth.accessToken ?? '') !== (current[0] as JsonObject).token_fingerprint)
      fail(
        'TIKTOK_REPORT_TOKEN_CHANGED',
        'TikTok credentials changed after the prerequisite read. Preserve the review and task.',
      );
    const submittedAt = Date.now(),
      actorBinding = this.store.bindJobActor(actor, input.review_id);
    const claim = this.store.transaction(() => {
      checkSpendPolicy(this.store, actor, plan, current, input.review_id, input.cap_override_confirmed === true);
      const claim = this.store.claim(actor.tenantId, input.idempotency_key, fingerprint);
      if (claim.fresh) {
        admitTiktokReport(plan, this.store, auth);
        admitXReport(plan, this.store, input.review_id);
      }
      return claim;
    });
    if (!claim.fresh) {
      const saved = {...object(claim.result), replayed: true};
      return googlePreviewKind(plan)
        ? googlePreviewDelivery(plan, saved, this.store.previewReceipt(actor.tenantId, input.review_id))
        : saved;
    }
    let completed = false;
    try {
      this.store.appendAudit(actor.tenantId, input.review_id, {
        event: 'write_started',
        request: plan,
        fingerprint,
        before_state: current,
      });
      const response = await this.request(actor, plan, plan, c, auth);
      this.delegated.validateResponse(plan, response.data, response.status);
      const rawResult = writeOutcome(response, plan, current),
        result = googlePreviewKind(plan) ? googlePreviewSafeOutcome(plan, rawResult) : rawResult;
      if (xReportKind(plan)) result.data = xReportSafeData(response.data);
      const outcome: JsonObject = {
        ...result,
        review_id: input.review_id,
        action: plan.action,
        fingerprint,
        ...(creativeImpact ? {creative_impact: creativeImpact} : {}),
      };
      this.store.transaction(() => {
        if (googlePreviewKind(plan) && object(response.data) === response.data)
          this.store.savePreviewReceipt(actor.tenantId, input.review_id, response.data as JsonObject);
        // A valid native job receipt remains useful even when the job immediately
        // failed. Retain its binding and release terminal processing admission;
        // the failed outcome still stays failed and must never be resubmitted.
        retainXReport(plan, c, this.store, response, current, input.review_id, auth, submittedAt);
        if (result.success === true)
          retainTiktokReport(plan, c, this.store, response, current, input.review_id, auth, submittedAt);
        if (result.success === true) new ScopeGuard(this.registry, this.store).observeCreated(plan, c, response.data);
        if (result.success === true && linkedinLeadFormKind(plan))
          rememberLinkedInLeadForm(this.store, c, plan, response);
        if (result.success === true) {
          const job = this.store.enqueue(actor.tenantId, 'write_verification', {
            review_id: input.review_id,
            actor_binding: actorBinding,
          });
          outcome.verification = {
            status: 'queued',
            job_id: job,
            next_call: {tool: 'amcp_campaign', arguments: {action: 'verify', review_id: input.review_id}},
          };
        }
        this.store.complete(actor.tenantId, input.idempotency_key, outcome);
        this.store.appendAudit(actor.tenantId, input.review_id, {event: 'write_completed', outcome});
      });
      completed = true;
      // Retain accepted outcomes first, then withhold delivery if this caller lost access.
      this.authority(actor, plan, plan, c, auth)();
      if (googlePreviewKind(plan)) {
        this.access(actor, plan, review.connection_id);
        return googlePreviewDelivery(plan, outcome, this.store.previewReceipt(actor.tenantId, input.review_id));
      }
      return outcome;
      // The spend reservation taken above is deliberately NOT released here. A write that failed in
      // transport may still have reached the provider — that is why the outcome is recorded as
      // uncertain rather than failed — and releasing the reservation would let repeated "failures"
      // walk past the owner's cumulative daily cap. The accepted cost is that a deterministic
      // rejection, which certainly did not land, still consumes part of the day's allowance. Only
      // release on errors provably raised before dispatch, never on transport-layer uncertainty.
    } catch (e) {
      if (!completed) this.store.uncertain(actor.tenantId, input.idempotency_key);
      this.store.appendAudit(actor.tenantId, input.review_id, {
        event: completed ? 'write_result_withheld' : 'write_uncertain',
        code: e instanceof MirrorError ? e.code : 'INTERNAL_ERROR',
      });
      throw placeActionKind(plan) || businessNotificationKind(plan) || businessAccessKind(plan)
        ? placeActionSafeError(e)
        : e;
    }
  }
}
