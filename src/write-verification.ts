import {snapUpdateKind, verifySnapUpdate} from './snapchat-nested-updates.js';
import {readSnapPixelNames} from './snapchat-pixel-names.js';
import {readSnapEvents} from './snapchat-event-details.js';
import {readSnapTemplates} from './snapchat-dynamic-templates.js';
import {readSnapProductSets} from './snapchat-product-sets.js';
import {readSnapConversions} from './snapchat-custom-conversions.js';
import {readSnapSegmentDelete} from './snapchat-segment-deletions.js';
import {readSnapDisclaimers} from './snapchat-offer-disclaimers.js';
import {readSnapchatMediaCopy} from './snapchat-media-copy.js';
import {googlePreviewKind, verifyGooglePreview} from './google-preview-writes.js';
import {criteoCampaignKind, assertCriteoCampaignScopes, verifyCriteoCampaign} from './criteo-campaign-writes.js';
import {
  metaReportKind,
  assertMetaReportScope,
  verifyMetaReport,
  metaReportReadResult,
  observeMetaReportRead,
} from './meta-insights-jobs.js';
import {xReportKind, verifyXReport, observeXReport, xReportStatus} from './x-report-jobs.js';
import {tiktokReportKind, verifyTiktokReport} from './tiktok-report-jobs.js';
import {
  criteoReportKind,
  assertCriteoReportScopes,
  verifyCriteoReport,
  criteoReportReadResult,
  observeCriteoReportRead,
} from './criteo-report-jobs.js';
import {placeActionKind, assertPlaceActionScope, verifyPlaceAction} from './google-place-action-links.js';
import {
  businessNotificationKind,
  assertBusinessNotificationActor,
  assertBusinessNotificationScope,
  verifyBusinessNotification,
} from './google-business-notifications.js';
import {
  businessAccessKind,
  assertBusinessAccessActor,
  assertBusinessAccessScope,
  verifyBusinessAccess,
} from './google-business-access.js';
import {googleDismissalKind, verifyGoogleDismissal} from './google-recommendation-dismissal.js';
import {googleAccessKind, assertGoogleAccessActor, verifyGoogleAccess} from './google-user-access.js';
import {readRedditProfiles} from './reddit-creative-writes.js';
import {criteoTargetingKind, readCriteoTargeting, assertCriteoReadScope} from './criteo-targeting-writes.js';
import {redditPostCreation, verifyRedditPostCreation} from './reddit-post-creation.js';
import {metaLabelKind, readMetaLabels, assertMetaLabelScope} from './meta-label-writes.js';
import {googleBidKind, readGoogleBidState, assertGoogleBidScope} from './google-bid-modifiers.js';
import {assertGoogleAdsScope} from './google-contracts.js';
import {googleSegmentKind} from './google-custom-segments.js';
import {googleConversionGoalKind, verifyGoogleConversionGoal} from './google-conversion-goals.js';
import {googleBiddingEventKind, verifyGoogleBiddingEvent} from './google-bidding-events.js';
import {googlePortfolioKind, verifyGooglePortfolio} from './google-portfolio-strategies.js';
import {googleConversionActionKind, verifyGoogleConversionAction} from './google-conversion-actions.js';
import {xDraftKind, verifyXDraft} from './x-draft-writes.js';
import {xTargetingBatchRoute, verifyXTargetingBatch} from './x-targeting-batch.js';
import {linkedinTemplateKind, verifyLinkedInTemplate} from './linkedin-audience-templates.js';
import {
  linkedinConversionKind,
  readLinkedInConversions,
  assertLinkedInConversionScope,
} from './linkedin-conversion-links.js';
import {linkedinRuleKind, readLinkedInRules} from './linkedin-conversion-rules.js';
import {Store} from './store.js';
import {Registry} from './catalog.js';
import {NativeTransport, type TransportResult} from './transport.js';
import {CredentialProvider} from './auth.js';
import {ScopeGuard} from './scope.js';
import {independentlyReadOnly} from './execution-risk.js';
import {MirrorError} from './errors.js';
import {sha256, stable} from './security.js';
import {setTimeout as delay} from 'node:timers/promises';
import {readConsistently} from './read-consistency.js';
import {linkedinDSC, assertLinkedInDSCGrant, rememberLinkedInPost} from './linkedin-posts.js';
import {xCreativeKind, xPromotion, verifyXCreative} from './x-creative-writes.js';
import {measurementVerificationPhase, optionalMissingState} from './measurement-writes.js';
import {appleSharedAccounts} from './apple-entity-writes.js';
import {readDV360List} from './dv360-list-writes.js';
import {readDV360Targeting} from './dv360-line-item-targeting.js';
import {readTiktokNegativeKeywords} from './tiktok-negative-keywords.js';
import {criteoCatalogKind, readCriteoCatalog, assertCriteoCatalogScopes} from './criteo-catalog-requests.js';
import {criteoOverrideKind, readCriteoOverrides, assertCriteoOverrideScopes} from './criteo-budget-overrides.js';
import {criteoLineItemKind, readCriteoLineItems, assertCriteoLineItemScopes} from './criteo-auction-line-items.js';
import {criteoPromotedProductsKind} from './criteo-promoted-products.js';
import {criteoKeywordKind, criteoBidMultiplierKind} from './criteo-line-item-bidding.js';
import {dv360SdfKind, readDV360Sdf, assertDV360SdfScope} from './dv360-sdf-downloads.js';
import {readDV360Ads} from './dv360-demand-gen-ads.js';
import {readGtmWorkflow} from './gtm-workflow-writes.js';
import {readGtmWorkspace} from './gtm-workspace-writes.js';
import {validateState} from './write-state.js';
import {audit, bad, fingerprint, obj, optional, read} from './workspace-core.js';
import type {Actor, CompiledRequest, Connection, Credentials, JsonObject} from './types.js';
import {nativeAuthority} from './native-authority.js';
import {familyOf, readThroughFamilies} from './reviewed-families.js';
import {normalize, differing, verificationReads, entity} from './verification-reads.js';

/** A guarded-reader binding: the connection's whole login must stay the one the first read used. */
const sameLogin = (message: string) => ({
  value: (credentials: Credentials) => sha256(stable(credentials)),
  changed: (): never => bad(message, 'REAUTHORIZATION_REQUIRED'),
});
const redditAdsRead = (connection: Connection) => {
  if (!connection.scopes.includes('adsread')) bad('Reddit post verification requires adsread.', 'INSUFFICIENT_SCOPE');
};
export class WriteVerifier {
  constructor(
    private store: Store,
    private registry: Registry,
    private transport: NativeTransport,
    private credentials: CredentialProvider,
  ) {}
  private async request(actor: Actor, plan: CompiledRequest, connection: Connection, auth: Credentials) {
    const access = nativeAuthority(this.store, this.registry, actor, plan, connection, auth);
    const response = await this.transport.request(plan, access(), auth, undefined, {beforeAttempt: access});
    access();
    return response;
  }
  /**
   * The reader a family's verification uses, the counterpart of the review's. Each read must be read-only. Before the
   * credentials are fetched, after, and after the response, the actor must still be active, the `actor` check runs,
   * the connection is resolved, `check` runs on it and the scope guard authorizes the read. A binding keeps the login
   * the first read used; `after` sees the connection and response last checked and may return the response to use.
   */
  private guardedReader(
    actor: Actor,
    plan: CompiledRequest,
    connectionId: string,
    unsafe: string,
    options: {
      actor?: () => void;
      check?: (connection: Connection) => void;
      binding?: {value: (credentials: Credentials) => string; changed: () => never};
      after?: (
        read: CompiledRequest,
        connection: Connection,
        response: TransportResult,
        auth: Credentials,
      ) => TransportResult | void;
    } = {},
  ) {
    let bound: string | undefined;
    return async (read: CompiledRequest): Promise<TransportResult> => {
      if (!independentlyReadOnly(read)) bad(unsafe, 'VERIFICATION_UNSUPPORTED');
      const access = () => {
        this.store.assertActorActive(actor);
        options.actor?.();
        const current = this.store.resolveConnection(actor, plan.gateway, plan.accountId, connectionId);
        options.check?.(current);
        new ScopeGuard(this.registry, this.store).authorize(read, current);
        if (
          options.binding &&
          bound !== undefined &&
          options.binding.value(this.store.credentials(actor.tenantId, current.id)) !== bound
        )
          options.binding.changed();
        return current;
      };
      const current = access(),
        auth = await this.credentials.get(current);
      if (options.binding) bound ??= options.binding.value(auth);
      access();
      const response = await this.request(actor, read, current, auth);
      return options.after?.(read, access(), response, auth) ?? response;
    };
  }
  async verify(actor: Actor, reviewId: string): Promise<JsonObject> {
    const review = read(this.store, actor, 'write_review', reviewId);
    if (review.user_id !== actor.userId && actor.role !== 'admin')
      bad('This write belongs to another actor.', 'FORBIDDEN');
    const row = this.store.db
      .prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?')
      .get(actor.tenantId, reviewId) as JsonObject | undefined;
    if (row?.state !== 'complete' || !row.result)
      bad(
        'The write outcome is uncertain or unavailable; verification cannot make it safe to resubmit.',
        'WRITE_OUTCOME_UNCERTAIN',
      );
    const result = JSON.parse(row.result),
      plan = review.plan as CompiledRequest,
      c = this.store.resolveConnection(actor, plan.gateway, plan.accountId, review.connection_id);
    const checkAppleAccounts = () => {
      for (const account of appleSharedAccounts(plan)) this.store.resolveConnection(actor, plan.gateway, account, c.id);
    };
    checkAppleAccounts();
    if (linkedinDSC(plan)) assertLinkedInDSCGrant(plan, c, false);
    if (redditPostCreation(plan) && !c.scopes.includes('adsread'))
      bad('Reddit post verification requires adsread.', 'INSUFFICIENT_SCOPE');
    if (criteoTargetingKind(plan)) assertCriteoReadScope(c);
    if (metaReportKind(plan)) assertMetaReportScope(c);
    if (criteoCampaignKind(plan)) assertCriteoCampaignScopes(c);
    if (
      criteoLineItemKind(plan) ||
      criteoPromotedProductsKind(plan) ||
      criteoKeywordKind(plan) ||
      criteoBidMultiplierKind(plan)
    )
      assertCriteoLineItemScopes(c);
    if (criteoOverrideKind(plan)) assertCriteoOverrideScopes(c);
    if (criteoCatalogKind(plan)) assertCriteoCatalogScopes(c);
    if (criteoReportKind(plan)) assertCriteoReportScopes(c);
    if (placeActionKind(plan)) assertPlaceActionScope(c);
    if (businessNotificationKind(plan)) {
      assertBusinessNotificationActor(plan, actor);
      assertBusinessNotificationScope(c);
    }
    if (businessAccessKind(plan)) {
      assertBusinessAccessActor(plan, actor);
      assertBusinessAccessScope(c);
    }
    if (googlePreviewKind(plan) || googleDismissalKind(plan) || googleAccessKind(plan)) assertGoogleAdsScope(c);
    assertGoogleAccessActor(plan, actor);
    if (metaLabelKind(plan)) assertMetaLabelScope(c);
    familyOf(plan)?.scope?.(c, false, plan);
    if (googleBidKind(plan)) assertGoogleBidScope(c);
    if (
      googleSegmentKind(plan) ||
      googleBiddingEventKind(plan) ||
      googleConversionGoalKind(plan) ||
      googlePortfolioKind(plan) ||
      googleConversionActionKind(plan)
    )
      assertGoogleAdsScope(c);
    if (linkedinConversionKind(plan) || linkedinRuleKind(plan) || linkedinTemplateKind(plan))
      assertLinkedInConversionScope(c);
    if (result.success !== true)
      bad('Inspect the retained partial failure before recovery.', 'WRITE_PARTIAL_OR_FAILED');
    const cached = optional(this.store, actor.tenantId, 'write_verification', reviewId);
    if (
      !linkedinTemplateKind(plan) &&
      !xTargetingBatchRoute(plan) &&
      !snapUpdateKind(plan) &&
      !xReportKind(plan) &&
      !tiktokReportKind(plan) &&
      !googlePreviewKind(plan) &&
      cached?.status === 'verified' &&
      Date.now() - cached.checked_at < 10000
    )
      return {...cached, cached: true};
    let reads: ReturnType<typeof verificationReads> = [],
      status = 'unverified',
      checks: JsonObject[] = [],
      resources: JsonObject[] = [],
      retryUseful = false;
    const previousChecks: JsonObject[] = Array.isArray(cached?.checks) ? cached.checks : [];
    try {
      if (redditPostCreation(plan)) {
        const verified = await verifyRedditPostCreation(plan, result, reviewId, c, this.store, read =>
          readRedditProfiles(
            read,
            this.guardedReader(actor, plan, c.id, 'Post verification must remain read-only.', {
              check: redditAdsRead,
            }),
          ),
        );
        status = verified.status;
        checks = verified.checks;
        resources = verified.resources ?? [];
      } else if (snapUpdateKind(plan)) {
        const verified = await verifySnapUpdate(
          plan,
          review.state,
          this.guardedReader(actor, plan, c.id, 'Snapchat verification must remain read-only.', {
            binding: sameLogin('The selected login changed during Snapchat verification.'),
          }),
        );
        status = verified.status;
        checks = verified.checks;
      } else if (googlePreviewKind(plan)) {
        const verified = await verifyGooglePreview(
          plan,
          review.state,
          result,
          this.store.previewReceipt(actor.tenantId, reviewId),
          this.guardedReader(actor, plan, c.id, 'Preview verification must remain read-only.', {
            check: assertGoogleAdsScope,
            binding: sameLogin('The selected login changed during preview verification.'),
          }),
        );
        status = verified.status;
        checks = verified.checks;
      } else if (googlePortfolioKind(plan) || googleConversionActionKind(plan)) {
        const verified = await (
          googleConversionActionKind(plan) ? verifyGoogleConversionAction : verifyGooglePortfolio
        )(
          plan,
          result,
          review.state,
          this.guardedReader(actor, plan, c.id, 'Portfolio verification must remain read-only.', {
            check: assertGoogleAdsScope,
            binding: sameLogin('The selected login changed during portfolio verification.'),
          }),
        );
        status = verified.status;
        checks = verified.checks;
      } else if (googleAccessKind(plan)) {
        const verified = await verifyGoogleAccess(
          plan,
          result,
          review.state,
          this.guardedReader(actor, plan, c.id, 'Google access verification must remain read-only.', {
            actor: () => assertGoogleAccessActor(plan, actor),
            check: assertGoogleAdsScope,
          }),
        );
        status = verified.status;
        checks = verified.checks;
      } else if (googleDismissalKind(plan)) {
        const verified = await verifyGoogleDismissal(
          plan,
          review.state,
          this.guardedReader(actor, plan, c.id, 'Dismissal verification must remain read-only.', {
            check: assertGoogleAdsScope,
          }),
        );
        status = verified.status;
        checks = verified.checks;
      } else if (businessAccessKind(plan)) {
        const verified = await verifyBusinessAccess(
          plan,
          result,
          review.state,
          this.guardedReader(actor, plan, c.id, 'Business access verification must remain read-only.', {
            actor: () => assertBusinessAccessActor(plan, actor),
            check: assertBusinessAccessScope,
          }),
        );
        status = verified.status;
        checks = verified.checks;
        resources = verified.resources;
      } else if (placeActionKind(plan) || businessNotificationKind(plan)) {
        const verified = await (placeActionKind(plan) ? verifyPlaceAction : verifyBusinessNotification)(
          plan,
          result,
          review.state,
          this.guardedReader(actor, plan, c.id, 'Place-action verification must remain read-only.', {
            actor: () => assertBusinessNotificationActor(plan, actor),
            check: assertPlaceActionScope,
          }),
        );
        status = verified.status;
        checks = verified.checks;
        resources = verified.resources;
      } else if (criteoCampaignKind(plan)) {
        const verified = await verifyCriteoCampaign(
          plan,
          result,
          review.state,
          this.guardedReader(actor, plan, c.id, 'Campaign verification must remain read-only.', {
            check: active => assertCriteoCampaignScopes(active),
            binding: sameLogin('The selected login changed during campaign verification.'),
          }),
        );
        status = verified.status;
        checks = verified.checks;
        resources = verified.resources;
        if (status === 'verified')
          for (const resource of resources) {
            const current = this.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id);
            assertCriteoCampaignScopes(current);
            this.store.rememberResource(
              current,
              plan.accountId!,
              'criteo-report-target/campaigns/' + resource.resource_id,
            );
            resource.read_result.arguments.arguments.connection_id = c.id;
          }
      } else if (xReportKind(plan)) {
        const verified = await verifyXReport(
          plan,
          result,
          this.guardedReader(actor, plan, c.id, 'Report verification must remain read-only.', {
            after: (read, active, response) => {
              observeXReport(read, active, this.store, xReportStatus(read, response));
            },
          }),
        );
        status = verified.status;
        checks = verified.checks;
        resources = verified.resources;
        for (const resource of resources) resource.read_result.arguments.connection_id = c.id;
      } else if (tiktokReportKind(plan)) {
        const verified = await verifyTiktokReport(
          plan,
          result,
          this.guardedReader(actor, plan, c.id, 'Report verification must remain read-only.'),
        );
        status = verified.status;
        checks = verified.checks;
        resources = verified.resources;
        for (const resource of resources) resource.read_result.arguments.connection_id = c.id;
      } else if (criteoReportKind(plan)) {
        const verified = await verifyCriteoReport(
          plan,
          result,
          reviewId,
          this.guardedReader(actor, plan, c.id, 'Report verification must remain read-only.', {
            check: assertCriteoReportScopes,
            after: (read, active, response, auth) => {
              if (stable(this.store.credentials(actor.tenantId, active.id)) !== stable(auth))
                bad('The login changed while checking this report.', 'REAUTHORIZATION_REQUIRED');
              observeCriteoReportRead(read, active, this.store, criteoReportReadResult(read, response)!);
            },
          }),
        );
        status = verified.status;
        checks = verified.checks;
        resources = verified.resources;
        for (const resource of resources) resource.read_result.arguments.arguments.connection_id = c.id;
      } else if (metaReportKind(plan)) {
        const verified = await verifyMetaReport(
          plan,
          result,
          reviewId,
          this.guardedReader(actor, plan, c.id, 'Report verification must remain read-only.', {
            check: assertMetaReportScope,
            after: (read, active, response) => {
              const data = metaReportReadResult(read, response)!;
              observeMetaReportRead(read, active, this.store, data);
              return {...response, data};
            },
          }),
        );
        status = verified.status;
        checks = verified.checks;
        resources = verified.resources ?? [];
        for (const resource of resources) resource.read_result.arguments.connection_id = c.id;
      } else if (googleBiddingEventKind(plan) || googleConversionGoalKind(plan)) {
        const verified = await (googleConversionGoalKind(plan) ? verifyGoogleConversionGoal : verifyGoogleBiddingEvent)(
          plan,
          result,
          review.state,
          this.guardedReader(actor, plan, c.id, 'Google goal and bidding-event verification must remain read-only.', {
            check: assertGoogleAdsScope,
          }),
        );
        status = verified.status;
        checks = verified.checks;
      } else if (xTargetingBatchRoute(plan) || linkedinTemplateKind(plan)) {
        const verified = await (linkedinTemplateKind(plan) ? verifyLinkedInTemplate : verifyXTargetingBatch)(
          plan,
          result,
          review.state,
          this.guardedReader(actor, plan, c.id, 'Targeting verification must remain read-only.', {
            binding: sameLogin('The selected login changed during targeting verification.'),
          }),
        );
        status = verified.status;
        checks = verified.checks;
      } else if (xDraftKind(plan)) {
        const verified = await verifyXDraft(
          plan,
          result,
          review.state,
          this.guardedReader(actor, plan, c.id, 'Draft verification must remain read-only.'),
        );
        status = verified.status;
        checks = verified.checks;
      } else if (xCreativeKind(plan)) {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt) await delay(attempt * 250);
          const verified = await verifyXCreative(
            plan,
            result,
            this.guardedReader(actor, plan, c.id, 'X verification must remain read-only.'),
          );
          status = verified.status;
          checks = verified.checks;
          if (!xPromotion(plan) || status !== 'pending') break;
        }
      } else {
        reads = verificationReads(plan, result, this.registry, review.state);
        for (const item of reads) {
          if (linkedinDSC(plan)) {
            item.read.scopeContext = {linkedinPostReviewId: reviewId};
            item.read.query = {viewContext: 'AUTHOR'};
          }
          if (!obj(item.expected) || !Object.keys(item.expected).length || !independentlyReadOnly(item.read))
            bad('No complete configuration read contract exists for this write.', 'VERIFICATION_UNSUPPORTED');
          const expected = normalize(item.expected),
            readback = await readConsistently(
              async () => {
                this.store.assertActorActive(actor);
                checkAppleAccounts();
                const current = this.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id);
                new ScopeGuard(this.registry, this.store).authorize(item.read, current);
                const auth = await this.credentials.get(current);
                this.store.assertActorActive(actor);
                new ScopeGuard(this.registry, this.store).authorize(
                  item.read,
                  this.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id),
                );
                let response;
                try {
                  response = await readThroughFamilies(item.read, familyPage =>
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
                                                    readGtmWorkspace(criteoPage, workspacePage =>
                                                      readGtmWorkflow(workspacePage, gtmPage =>
                                                        readDV360List(gtmPage, listPage =>
                                                          readDV360Targeting(listPage, targetingPage =>
                                                            readTiktokNegativeKeywords(targetingPage, negativePage =>
                                                              readCriteoLineItems(negativePage, lineItemPage =>
                                                                readDV360Ads(lineItemPage, async page => {
                                                                  this.store.assertActorActive(actor);
                                                                  const latest = this.store.resolveConnection(
                                                                    actor,
                                                                    plan.gateway,
                                                                    plan.accountId,
                                                                    c.id,
                                                                  );
                                                                  if (googleBidKind(plan)) assertGoogleBidScope(latest);
                                                                  new ScopeGuard(this.registry, this.store).authorize(
                                                                    page,
                                                                    latest,
                                                                  );
                                                                  const result = await this.request(
                                                                    actor,
                                                                    page,
                                                                    latest,
                                                                    auth,
                                                                  );
                                                                  this.store.assertActorActive(actor);
                                                                  const current = this.store.resolveConnection(
                                                                    actor,
                                                                    plan.gateway,
                                                                    plan.accountId,
                                                                    c.id,
                                                                  );
                                                                  if (googleBidKind(plan))
                                                                    assertGoogleBidScope(current);
                                                                  new ScopeGuard(this.registry, this.store).authorize(
                                                                    page,
                                                                    current,
                                                                  );
                                                                  return result;
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
                  );
                } catch (e) {
                  const absent = optionalMissingState(item.read, e);
                  if (!absent) throw e;
                  response = absent;
                }
                this.store.assertActorActive(actor);
                new ScopeGuard(this.registry, this.store).authorize(
                  item.read,
                  this.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id),
                );
                validateState(item.read, response);
                checkAppleAccounts();
                return normalize(entity(item.read, response.data as JsonObject));
              },
              actual => differing(expected, actual).length === 0,
            );
          const actual = readback.value,
            changed = differing(expected, actual),
            acknowledged = item.acknowledged ?? {},
            unacknowledged = Object.entries(acknowledged)
              .filter(([, v]) => differing(normalize(v.sent), normalize(v.echoed)).length)
              .map(([k]) => '/' + k);
          const measured = readback.consistent ? measurementVerificationPhase(item.read, actual) : 'inconclusive',
            actualHash = fingerprint(actual ?? null),
            // Every read of this round returned the same differing state. When the previous round saw the same
            // state too, the disagreement is not propagation: it is a mismatch, and reading again changes nothing.
            stableReads = !readback.consistent && readback.stable === true,
            settled =
              stableReads &&
              previousChecks.some(
                (p: JsonObject) => p.resource_id === item.id && p.actual_hash === actualHash && p.stable_reads === true,
              ),
            phase = settled ? 'mismatch' : measured === 'verified' && unacknowledged.length ? 'inconclusive' : measured;
          if (phase === 'inconclusive' && !readback.consistent && !settled) retryUseful = true;
          checks.push({
            resource_id: item.id,
            status: phase,
            code:
              phase === 'inconclusive'
                ? 'VERIFICATION_INCONCLUSIVE'
                : phase === 'mismatch'
                  ? 'VERIFICATION_MISMATCH'
                  : undefined,
            read_attempts: readback.attempts,
            changed_fields: changed,
            ...(phase === 'mismatch' ? {diff: fieldDiff(expected, actual, changed)} : {}),
            ...(stableReads ? {stable_reads: true} : {}),
            expected_hash: fingerprint(expected),
            actual_hash: actualHash,
            checked_fields: Object.keys(expected),
            ...(Object.keys(acknowledged).length
              ? {
                  acknowledged_fields: Object.keys(acknowledged),
                  acknowledgment:
                    'The native read never returns these fields; they are compared with the provider write response.',
                  ...(unacknowledged.length ? {unacknowledged_fields: unacknowledged} : {}),
                }
              : {}),
            ...(item.unobservable?.length
              ? {
                  unobservable_fields: item.unobservable,
                  unobservable:
                    'Neither the write response nor any native read returns these sent fields, so they cannot be compared.',
                }
              : {}),
          });
          if (linkedinDSC(plan) && readback.consistent)
            rememberLinkedInPost(
              this.store,
              this.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id),
              plan,
              result.headers['x-restli-id'],
            );
          if (metaLabelKind(plan) && readback.consistent && item.expected.label?.present === true) {
            const current = this.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id);
            assertMetaLabelScope(current);
            this.store.rememberResource(current, plan.accountId!, item.id);
          }
          if (
            criteoLineItemKind(plan) === 'create' &&
            readback.consistent &&
            typeof (actual as JsonObject)?.line?.id === 'string'
          ) {
            const current = this.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id);
            assertCriteoLineItemScopes(current);
            this.store.rememberResource(
              current,
              plan.accountId!,
              'criteo-report-target/line-items/' + (actual as JsonObject).line.id,
            );
          }
          const family = familyOf(plan),
            created = readback.consistent ? (family?.verifiedResources?.(plan, actual as JsonObject) ?? []) : [];
          if (created.length) {
            const current = this.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id);
            family!.scope?.(current, true, plan);
            for (const id of created) this.store.rememberResource(current, plan.accountId!, id);
          }
          if (
            criteoCatalogKind(plan) &&
            readback.consistent &&
            typeof (actual as JsonObject)?.catalog?.id === 'string'
          ) {
            const current = this.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id);
            assertCriteoCatalogScopes(current);
            this.store.rememberResource(current, plan.accountId!, 'catalogs/' + (actual as JsonObject).catalog.id);
          }
          // A verified task's operation, and its files once done, become readable for this advertiser.
          if (
            dv360SdfKind(plan) &&
            readback.consistent &&
            typeof (actual as JsonObject)?.operation?.name === 'string'
          ) {
            const current = this.store.resolveConnection(actor, plan.gateway, plan.accountId, c.id),
              op = (actual as JsonObject).operation;
            assertDV360SdfScope(current);
            this.store.rememberResource(current, plan.accountId!, op.name);
            if (typeof op.resource_name === 'string')
              this.store.rememberResource(current, plan.accountId!, op.resource_name);
          }
        }
        status = reads.length
          ? checks.some(c => c.status === 'failed')
            ? 'failed'
            : checks.every(c => c.status === 'verified')
              ? 'verified'
              : checks.some(c => c.status === 'pending')
                ? 'pending'
                : checks.some(c => c.status === 'mismatch')
                  ? 'mismatch'
                  : 'inconclusive'
          : 'unsupported';
      }
    } catch (e) {
      if (redditPostCreation(plan) && e instanceof MirrorError && e.retryable) status = 'pending';
      checks.push({
        status: status === 'pending' ? 'pending' : 'unverified',
        code: e instanceof MirrorError ? e.code : 'READ_FAILED',
        message: e instanceof MirrorError ? e.message : 'Verification read failed.',
      });
    }
    this.store.assertActorActive(actor);
    const receipt = {
      review_id: reviewId,
      connection_id: c.id,
      account_id: plan.accountId,
      action: plan.action,
      status,
      ...(status === 'inconclusive' ? {code: 'VERIFICATION_INCONCLUSIVE'} : {}),
      ...(status === 'mismatch' ? {code: 'VERIFICATION_MISMATCH'} : {}),
      checks,
      // What the operator accepts when accepting the observed state: one hash over every resource read back.
      ...(['mismatch', 'inconclusive'].includes(status) && checks.every(c => typeof c.actual_hash === 'string')
        ? {actual_hash: observedHash(checks)}
        : {}),
      checked_at: Date.now(),
      automatic_retry_of_mutation: false,
      recovery:
        'Preserve successful resources. Field disagreement after bounded reads is inconclusive, not permission to repeat a mutation. Corrective writes need a new review; verification never resets idempotency.',
      // Another read is suggested only when it can change the answer: never for a mismatch or a missing echo.
      ...(status === 'pending' || (status === 'inconclusive' && (retryUseful || !reads.length))
        ? {
            retry_read_after_ms: criteoReportKind(plan)
              ? 6000
              : checks.some(c => c.stable_reads === true && c.status === 'inconclusive')
                ? 5000
                : 1000,
            next_call: {tool: 'amcp_campaign', arguments: {action: 'verify', review_id: reviewId}},
          }
        : {}),
    };
    if (resources.length) Object.assign(receipt, {verified_resources: resources});
    this.store.putDocument(actor.tenantId, 'write_verification', reviewId, receipt);
    audit(this.store, actor, 'write_verification', {
      connection_id: c.id,
      account_id: plan.accountId,
      review_id: reviewId,
      status,
    });
    return receipt;
  }
}
/** The fields a mismatch disagrees on, with what was sent and what the provider holds (bounded; provider text). */
function fieldDiff(expected: unknown, actual: unknown, changed: string[]): JsonObject[] {
  const at = (v: unknown, path: string) =>
      path
        .slice(1)
        .split('/')
        .reduce((o: any, k) => (o && typeof o === 'object' ? o[k] : undefined), v),
    clip = (v: unknown) => {
      const text = JSON.stringify(v ?? null);
      return text.length > 300 ? {omitted_bytes: Buffer.byteLength(text)} : (v ?? null);
    };
  return changed
    .slice(0, 20)
    .map(field => ({field, expected: clip(at(expected, field)), actual: clip(at(actual, field))}));
}
/** One hash over every resource a verification read back; with one resource, that resource's own actual_hash. */
export function observedHash(checks: JsonObject[]): string {
  return checks.length === 1
    ? checks[0]!.actual_hash
    : fingerprint(checks.map(c => [c.resource_id ?? null, c.actual_hash]));
}
