/** Validation stage: the request shapes each reviewed write family accepts, checked before any read. */
import {pausedParentChildStatuses} from './paused-parents.js';
import {assertSnapLeadForms, assertSnapLeadCreativeRefs} from './snapchat-lead-forms.js';
import {assertSnapSegments, assertSnapSegmentUpdates} from './snapchat-segments.js';
import {tiktokAdgroupConversion} from './tiktok-adgroup-conversions.js';
import {tiktokCtaReferences} from './tiktok-cta-portfolios.js';
import {reviewedWriteFamily} from './reviewed-routes.js';
import {assertProviderActionAvailable} from './retired-provider-actions.js';
import {validateMetaCampaign, validateMetaV26} from './meta-contracts.js';
import {validateGoogleRequest} from './google-contracts.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {validateMetaCreative} from './creative-validation.js';
import {assertXTargeting} from './x-targeting-writes.js';
import {assertRedditWrite} from './reddit-writes.js';
import {microsoftGateway, assertMicrosoftWrite} from './microsoft-native.js';
import {measurementWriteGateways, assertMeasurementWrite} from './measurement-writes.js';
import {familyOf} from './reviewed-families.js';
import {withheldWriteReason} from './withheld-writes.js';
import {assertNoMethodOverride, object, fail} from './write-common.js';

export const writeContractGateways = new Set([
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
  microsoftGateway,
  ...measurementWriteGateways,
]);
export function assertWriteShape(plan: CompiledRequest) {
  assertProviderActionAvailable(plan);
  validateGoogleRequest(plan);
  validateMetaCampaign(plan);
  validateMetaV26(plan);
  if (!writeContractGateways.has(plan.gateway))
    fail('WRITE_CONTRACT_UNAVAILABLE', 'This platform has no reviewed mutation contract.');
  if (plan.readOnly) fail('MUTATION_REQUIRED', 'Use the original native gateway to perform this read.');
  if (plan.gateway === 'reddit_native_action') {
    assertRedditWrite(plan);
    return;
  }
  if (plan.gateway === microsoftGateway) {
    assertMicrosoftWrite(plan);
    return;
  }
  if (plan.specialTransport)
    fail(
      'WRITE_CONTRACT_UNAVAILABLE',
      'For Google Drive media imports, use amcp_media prepare and execute. Other binary transports need a dedicated upload contract.',
    );
  const family = familyOf(plan);
  if (family?.assert) {
    family.assert(plan, () => assertGatewayShape(plan));
    return;
  }
  assertNoMethodOverride(plan);
  if (measurementWriteGateways.has(plan.gateway)) assertMeasurementWrite(plan);
  const supported = reviewedWriteFamily(plan);
  if (!supported) {
    const reason = withheldWriteReason(plan.gateway, plan.action);
    fail(
      'WRITE_CONTRACT_UNAVAILABLE',
      'This route is outside the reviewed campaign-management execution contracts. Use a local dry run.',
      reason ? {reason} : {},
    );
  }
  assertGatewayShape(plan);
}

/**
 * The generic write checks of a gateway: query parameters, method tunnelling, paused creation of serving entities and
 * the structure of native Google operations. A family that relies on them calls them through its `assert` hook.
 */
function assertGatewayShape(plan: CompiledRequest): void {
  const body = object(plan.body);
  const route = plan.path,
    method = plan.method;
  if (plan.gateway === 'meta_native_action' && route.endsWith('/adcreatives')) validateMetaCreative(body);
  if (
    Object.keys(plan.query).some(
      k =>
        !(
          (plan.gateway === 'dv360_native_action' && k === 'updateMask') ||
          (plan.gateway === 'gtm_native_action' && k === 'fingerprint')
        ),
    )
  )
    fail('WRITE_CONTRACT_UNAVAILABLE', 'Reviewed writes accept body fields and qualified concurrency parameters only.');
  if (
    plan.gateway === 'linkedin_native_action' &&
    method === 'POST' &&
    /^\/rest\/adAccounts\/[^/]+\/[^/]+\/[^/]+$/.test(route) &&
    (!body.patch || plan.headers['X-RestLi-Method']?.toUpperCase() !== 'PARTIAL_UPDATE')
  )
    fail(
      'WRITE_CONTRACT_UNAVAILABLE',
      'LinkedIn entity POST requires a native patch and restli_method PARTIAL_UPDATE.',
    );
  if (
    ['method', '_method', 'http_method', 'method_override', 'batch', 'adbatch'].some(
      k => plan.query[k] !== undefined || body[k] !== undefined,
    ) ||
    /\/batch\//.test(plan.path)
  )
    fail('WRITE_CONTRACT_UNAVAILABLE', 'Batch and method-tunneled writes require individual reviewed native requests.');
  if (plan.method === 'GET' || plan.method === 'HEAD')
    fail('WRITE_CONTRACT_UNAVAILABLE', 'Side-effecting GET/HEAD actions are not qualified for execution.');
  const expect = (record: JsonObject, key: string, values: string[]) => {
    if (!values.includes(record[key]))
      fail('PAUSED_CREATION_REQUIRED', 'New serving entities require an explicit paused or draft state.', {
        field: key,
        allowed: values,
      });
  };
  // Campaigns start paused. Ad sets, ad groups and ads may start active under a parent the review reads as paused
  // (paused-parents.ts, the owner's decision of 2026-09-29).
  if (
    plan.gateway === 'meta_native_action' &&
    /^\/v[^/]+\/act_[^/]+\/(campaigns|adsets|ads)$/.test(plan.path) &&
    plan.method === 'POST'
  )
    expect(body, 'status', pausedParentChildStatuses(plan) ?? ['PAUSED']);
  if (plan.gateway === 'tiktok_native_action' && /^\/v1\.3\/(?:campaign|adgroup)\/create\/$/.test(plan.path))
    expect(body, 'operation_status', pausedParentChildStatuses(plan) ?? ['DISABLE']);
  if (plan.gateway === 'tiktok_native_action') tiktokAdgroupConversion(plan);
  if (plan.gateway === 'tiktok_native_action') tiktokCtaReferences(plan);
  if (plan.gateway === 'tiktok_native_action' && plan.path === '/v1.3/ad/create/') {
    if (
      !Array.isArray(body.creatives) ||
      body.creatives.length !== 1 ||
      !body.creatives[0] ||
      Array.isArray(body.creatives[0]) ||
      typeof body.creatives[0] !== 'object'
    )
      fail(
        'WRITE_CONTRACT_UNAVAILABLE',
        'Reviewed TikTok ad creation requires exactly one native creatives record per review. Put the ad fields and operation_status inside that record.',
      );
    if (Object.hasOwn(body, 'operation_status'))
      fail(
        'INVALID_ARGUMENT',
        'TikTok ad creation uses creatives[0].operation_status; a top-level status does not pause the creative.',
      );
    expect(body.creatives[0], 'operation_status', pausedParentChildStatuses(plan) ?? ['DISABLE']);
  }
  if (plan.gateway === 'snapchat_native_action' && plan.method === 'POST') {
    const kind = plan.path.split('/').at(-1)!;
    if (!Array.isArray(body[kind]) || !body[kind].length || body[kind].length > 25)
      fail('MISSING_PAYLOAD', 'Provide 1–25 native ' + kind + ' records.');
    if (kind === 'lead_generation_forms') assertSnapLeadForms(plan, body[kind]);
    else if (kind === 'segments') assertSnapSegments(plan, body[kind]);
    else if (kind === 'creatives') assertSnapLeadCreativeRefs(body[kind]);
    else for (const row of body[kind]) expect(object(row), 'status', pausedParentChildStatuses(plan) ?? ['PAUSED']);
  }
  if (
    plan.gateway === 'snapchat_native_action' &&
    plan.method === 'PUT' &&
    /^\/v1\/adaccounts\/[^/]+\/segments$/.test(plan.path)
  ) {
    if (!Array.isArray(body.segments) || !body.segments.length || body.segments.length > 25)
      fail('MISSING_PAYLOAD', 'Provide 1–25 native segments records.');
    assertSnapSegmentUpdates(plan, body.segments);
  }
  if (plan.gateway === 'snapchat_native_action' && plan.method === 'PATCH') {
    if (
      !Array.isArray(plan.body) ||
      !plan.body.length ||
      plan.body.length > 25 ||
      plan.body.some(
        op =>
          !op ||
          !['add', 'remove', 'replace', 'test'].includes(op.op) ||
          typeof op.path !== 'string' ||
          !/^\/[a-zA-Z0-9_/-]+$/.test(op.path) ||
          op.path.split('/').some((part: string) => ['__proto__', 'constructor', 'prototype'].includes(part)) ||
          (op.op !== 'remove' && !Object.hasOwn(op, 'value')),
      )
    )
      fail('INVALID_PATCH', 'Use 1–25 native JSON Patch add, remove, replace or test operations.');
  }
  if (
    plan.gateway === 'x_ads_native_action' &&
    /^\/12\/accounts\/[^/]+\/(campaigns|line_items)$/.test(plan.path) &&
    plan.method === 'POST'
  )
    expect(body, 'entity_status', ['PAUSED']);
  assertXTargeting(plan);
  if (
    plan.gateway === 'linkedin_native_action' &&
    /^\/rest\/adAccounts\/[^/]+\/(adCampaigns|adCampaignGroups|creatives)$/.test(plan.path) &&
    plan.method === 'POST'
  ) {
    const creative = plan.path.endsWith('/creatives');
    if (creative && Object.hasOwn(body, 'status'))
      fail('INVALID_ARGUMENT', 'LinkedIn creatives use intendedStatus; remove the unsupported status field.');
    expect(body, creative ? 'intendedStatus' : 'status', ['PAUSED', 'DRAFT']);
  }
  if (
    plan.gateway === 'dv360_native_action' &&
    /^\/v\d+\/advertisers\/[^/]+\/(campaigns|insertionOrders|lineItems)$/.test(plan.path) &&
    plan.method === 'POST'
  )
    expect(body, 'entityStatus', ['ENTITY_STATUS_PAUSED', 'ENTITY_STATUS_DRAFT']);
  if (plan.gateway === 'google_ads_native_action') {
    if (!Array.isArray(body.operations) || !body.operations.length || body.operations.length > 25)
      fail('WRITE_CONTRACT_UNAVAILABLE', 'Reviewed Google mutations require 1–25 homogeneous native operations.');
    // A new campaign starts PAUSED. Its ad groups, ads and asset groups may start ENABLED only under a parent the
    // review reads as PAUSED (google-paused-parents.ts, the owner's item 6).
    if (/\/campaigns:mutate$/.test(plan.path))
      for (const op of body.operations) if (op.create) expect(op.create, 'status', ['PAUSED']);
    if (/\/(adGroups|adGroupAds|assetGroups):mutate$/.test(plan.path))
      for (const op of body.operations) if (op.create) expect(op.create, 'status', ['PAUSED', 'ENABLED']);
    if (body.partial_failure === true || body.partialFailure === true)
      fail(
        'WRITE_CONTRACT_UNAVAILABLE',
        'Execute homogeneous Google mutations atomically; partial_failure must be false.',
      );
    if (body.validate_only === true || body.validateOnly === true)
      fail(
        'WRITE_CONTRACT_UNAVAILABLE',
        'This tool executes mutations; use a local dry run for validation-only plans.',
      );
    for (const op of body.operations)
      if (!op || typeof op !== 'object' || ['create', 'update', 'remove'].filter(k => op[k] !== undefined).length !== 1)
        fail('INVALID_MUTATION', 'Each Google operation must contain exactly one create, update or remove.');
  }
}
