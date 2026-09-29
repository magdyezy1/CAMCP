import {snapUpdateKind} from './snapchat-nested-updates.js';
import {criteoCampaignKind} from './criteo-campaign-writes.js';
import {criteoLineItemKind} from './criteo-auction-line-items.js';
import {criteoOverrideNeedsConfirmation} from './criteo-budget-overrides.js';
import {criteoKeywordKind, criteoBidMultiplierKind, criteoKeywordsWiden} from './criteo-line-item-bidding.js';
import {metaReportKind} from './meta-insights-jobs.js';
import {xReportKind} from './x-report-jobs.js';
import {tiktokReportKind} from './tiktok-report-jobs.js';
import {criteoReportKind} from './criteo-report-jobs.js';
import {placeActionKind} from './google-place-action-links.js';
import {businessNotificationKind} from './google-business-notifications.js';
import {businessAccessKind} from './google-business-access.js';
import {googleDismissalKind} from './google-recommendation-dismissal.js';
import {googleAccessKind} from './google-user-access.js';
import {keywordPlanKind} from './google-keyword-plan-writes.js';
import {linkedinConversionKind} from './linkedin-conversion-links.js';
import {linkedinRuleServing} from './linkedin-conversion-rules.js';
import {linkedinLeadFormKind} from './linkedin-lead-forms.js';
import {tiktokCustomConversionKind} from './tiktok-custom-conversions.js';
import {tiktokSavedAudienceKind} from './tiktok-saved-audiences.js';
import {criteoTargetingKind} from './criteo-targeting-writes.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {googleTargetingKind} from './google-targeting-writes.js';
import {googleAssetLinkKind} from './google-asset-links.js';
import {googleConfigurationServing} from './google-configuration-writes.js';
import {googleSegmentKind} from './google-custom-segments.js';
import {googleConversionGoalKind, googleConversionGoalServing} from './google-conversion-goals.js';
import {googleBiddingEventKind} from './google-bidding-events.js';
import {googlePortfolioKind, googlePortfolioServing} from './google-portfolio-strategies.js';
import {googleConversionActionKind, googleConversionActionServing} from './google-conversion-actions.js';
import {xDraftKind} from './x-draft-writes.js';
import {appleEntityServing} from './apple-entity-writes.js';
import {dv360ListAffectsServing} from './dv360-list-writes.js';
import {dv360TargetingKind} from './dv360-line-item-targeting.js';
import {googleListingGroupKind} from './google-listing-groups.js';
import {tiktokNegativeKeywordWidens} from './tiktok-negative-keywords.js';
import {tiktokBrandSafetyWidens, tiktokBrandSafetyHubKind} from './tiktok-brand-safety.js';
import {metaValueRuleServing} from './meta-value-rules.js';
import {metaAccountControlsKind} from './meta-brand-safety.js';
import {microsoftAssociationWrite} from './microsoft-associations.js';
import {xPromotion} from './x-creative-writes.js';
import {tiktokSmartPlusAdgroupUpdateServing} from './tiktok-smart-plus-adgroup-updates.js';
import {numericStatusPaths, deliveryEditFields, namesSpendField} from './spend-effects.js';
import {familyOf} from './reviewed-families.js';
export interface ExecutionPolicy {
  allowWrites: boolean;
  /**
   * Not enforced, and never was: budget changes are limited by the owner spending policy (spend-policy.ts) and
   * confirmed through spend_change_confirmed. Accepted only so existing configurations keep compiling (F-23).
   */
  maxBudgetChange?: number;
  requireBeforeState: boolean;
}
export const readOnlyPolicy: ExecutionPolicy = {allowWrites: false, maxBudgetChange: 0, requireBeforeState: true};
export function authorizeExecution(
  actor: Actor,
  plan: CompiledRequest,
  input: JsonObject,
  policy: ExecutionPolicy,
  verifiedBeforeState = false,
): void {
  if (plan.readOnly) return;
  if (!policy.allowWrites)
    throw new MirrorError('LIVE_WRITES_DISABLED', 'This deployment permits reads and dry-run previews only.', {}, 403);
  if (actor.role === 'reader')
    throw new MirrorError('FORBIDDEN', 'Reader role cannot execute platform writes.', {}, 403);
  if (input.dry_run !== false)
    throw new MirrorError('DRY_RUN_REQUIRED', 'Live execution must explicitly set dry_run=false.');
  if (input.confirmed !== true)
    throw new MirrorError('CONFIRMATION_REQUIRED', 'Live writes require confirmed=true under production policy.');
  if (typeof input.idempotency_key !== 'string' || !input.idempotency_key.trim())
    throw new MirrorError('IDEMPOTENCY_REQUIRED', 'Live writes require an idempotency_key.');
  if (policy.requireBeforeState && !verifiedBeforeState)
    throw new MirrorError(
      'WRITE_REVIEW_REQUIRED',
      'Use amcp_write prepare and execute; caller-supplied before_state is not a verified snapshot.',
    );
  // Structural checks (spend-effects.ts) apply to every family and only ever add this confirmation.
  const numericStatus = numericStatusPaths(plan);
  if (numericStatus.length && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'A status given as a number cannot be shown to leave the entity paused. Name the status, or review the change and provide spend_change_confirmed=true.',
      {fields: numericStatus},
    );
  const delivery = deliveryEditFields(plan);
  if (delivery?.fields.length && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'This edit changes fields that decide what an existing ' +
        delivery.entity +
        ' serves, bids or spends: ' +
        delivery.fields.join(', ') +
        '. Review them against before_state and provide spend_change_confirmed=true.',
      {fields: delivery.fields},
    );
  if (snapUpdateKind(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Snapchat entity updates can change current delivery, dates, bidding and spending. Review the exact effects and provide spend_change_confirmed=true.',
    );
  // Registered families (reviewed-families.ts) are consulted here; the lines around this one belong to families not yet registered.
  const spend = familyOf(plan)?.spendConfirmation;
  if (spend?.needed(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      typeof spend.message === 'function' ? spend.message(plan) : spend.message,
    );
  if (xPromotion(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'X promotion may serve immediately. Review the parent delivery state and provide spend_change_confirmed=true.',
    );
  if (linkedinConversionKind(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Campaign conversion associations can affect optimization. Review the selected campaigns and conversion rules and confirm the spending impact.',
    );
  if (linkedinRuleServing(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Conversion-rule enablement, attribution and matching can affect optimization. Review every associated campaign and confirm this impact.',
    );
  if (criteoCampaignKind(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Criteo campaign creation and PUT can permit delivery. Review all limits, balances, dates and attribution and provide spend_change_confirmed=true.',
    );
  if (criteoOverrideNeedsConfirmation(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Budget overrides replace the daily or monthly spending caps of their periods and remove every override left out. Review them and provide spend_change_confirmed=true.',
    );
  if (criteoLineItemKind(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      criteoLineItemKind(plan) === 'create'
        ? 'The new line item carries budgets and bids that apply once products are added and it is activated. Review them and provide spend_change_confirmed=true.'
        : 'A complete line item PUT replaces its budgets, bids, dates and status and can start or change delivery. Review every field and provide spend_change_confirmed=true.',
    );
  if (
    (criteoKeywordsWiden(plan) || criteoKeywordKind(plan) === 'bids' || criteoBidMultiplierKind(plan)) &&
    input.spend_change_confirmed !== true
  )
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Keywords that widen delivery, keyword bids and bid multipliers change where and at what price the line item bids. Review them and provide spend_change_confirmed=true.',
    );
  if (criteoTargetingKind(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Criteo targeting can change delivery immediately. Review the complete scope and members and provide spend_change_confirmed=true.',
    );
  if (appleEntityServing(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Apple shared budgets, exclusions, creative edits and serving settings can affect existing campaigns. Provide spend_change_confirmed=true.',
    );
  if (dv360TargetingKind(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'DV360 targeting changes which impressions line items and ad groups can buy, at once for active ones. Review them and the changes and provide spend_change_confirmed=true.',
    );
  if (dv360ListAffectsServing(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'DV360 shared-list membership can change serving eligibility. Provide spend_change_confirmed=true.',
    );
  if ((googleAssetLinkKind(plan) || microsoftAssociationWrite(plan)) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Asset associations change which creative can serve. Review the parent state and provide spend_change_confirmed=true.',
    );
  if ((googleTargetingKind(plan) || plan.gateway === 'reddit_native_action') && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Targeting, serving and shared-list changes require spend_change_confirmed=true.',
    );
  if (metaAccountControlsKind(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Account controls change the audience and placements of every eligible Advantage+ campaign of the account. Review the controls and provide spend_change_confirmed=true.',
    );
  if (metaValueRuleServing(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Editing or deleting a value rule set changes the bids of every ad set that uses it. Review the rules and provide spend_change_confirmed=true.',
    );
  if (tiktokBrandSafetyWidens(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Removing apps from the Pangle block list, or clearing it, lets ads show on those apps at once. Review the list and provide spend_change_confirmed=true.',
    );
  if (tiktokBrandSafetyHubKind(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Brand Safety Hub edits change the inventory future Upgraded Smart+ campaigns can buy, and covering all objectives cannot be undone. Review the settings and provide spend_change_confirmed=true.',
    );
  if (tiktokNegativeKeywordWidens(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Removing, replacing or renaming negative keywords lets Search Ads show for more search terms. Review the keyword lists and provide spend_change_confirmed=true.',
    );
  if (googleListingGroupKind(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Listing groups decide which Merchant Center products a Performance Max asset group advertises. Review the resulting tree and provide spend_change_confirmed=true.',
    );
  if (googleConfigurationServing(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Customizer, ad-parameter, segment, signal, exclusion and feed changes can affect existing ads. Review their impact and provide spend_change_confirmed=true.',
    );
  if (googleConversionGoalServing(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Goal edits, attachment, inheritance and removal can change optimization. Review affected campaigns and conversion definitions, then provide spend_change_confirmed=true.',
    );
  if (googleBiddingEventKind(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Seasonality adjustments and data exclusions can change bids, including after removal. Review the account timezone, scope and bidding impact, then provide spend_change_confirmed=true.',
    );
  if (googleConversionActionServing(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Conversion definition changes can alter reporting and bidding. Review the complete goal graph and provide spend_change_confirmed=true.',
    );
  if (tiktokSmartPlusAdgroupUpdateServing(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Bid, end time and dayparting edits change when and at what price the ad group spends, and a bid edit also changes the other ad groups of the campaign. Review them, then provide spend_change_confirmed=true.',
    );
  if (googlePortfolioServing(plan) && input.spend_change_confirmed !== true)
    throw new MirrorError(
      'SPEND_CONFIRMATION_REQUIRED',
      'Portfolio target and bid-limit changes affect all associated campaigns. Review campaign membership, budgets and native units, then provide spend_change_confirmed=true.',
    );
  const statusPatch =
    Array.isArray(plan.body) &&
    plan.body.some(
      op =>
        op &&
        /\/(status|intendedStatus|intended_status|entity_status|operation_status)$/.test(String(op.path)) &&
        ['ACTIVE', 'ENABLE', 'ENABLED'].includes(op.value),
    );
  // Segment effects are decided by the contract above. Native ENABLED denotes
  // an available definition. The rule reads field names, not content, so a keyword, lead form question, campaign name
  // or report metric containing "budget" is not a budget edit.
  if (
    !familyOf(plan)?.exemptFromSpendTextMatch &&
    !xReportKind(plan) &&
    !tiktokReportKind(plan) &&
    !criteoReportKind(plan) &&
    !criteoKeywordKind(plan) &&
    !criteoBidMultiplierKind(plan) &&
    !googlePortfolioKind(plan) &&
    !googleAccessKind(plan) &&
    !googleDismissalKind(plan) &&
    !businessAccessKind(plan) &&
    !businessNotificationKind(plan) &&
    !placeActionKind(plan) &&
    !metaReportKind(plan) &&
    !keywordPlanKind(plan) &&
    !googleSegmentKind(plan) &&
    !googleConversionGoalKind(plan) &&
    !googleConversionActionKind(plan) &&
    !xDraftKind(plan) &&
    !linkedinLeadFormKind(plan) &&
    !tiktokCustomConversionKind(plan) &&
    !tiktokSavedAudienceKind(plan) &&
    (statusPatch || namesSpendField(plan)) &&
    input.spend_change_confirmed !== true
  )
    throw new MirrorError('SPEND_CONFIRMATION_REQUIRED', 'Spend-affecting writes need spend_change_confirmed=true.');
}
