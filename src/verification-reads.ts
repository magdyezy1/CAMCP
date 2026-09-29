/** Verification plan: the reads that show a write took effect, what each must contain, and how read-backs compare. */
import {
  snapchatMediaCopyKind,
  snapchatMediaCopyVerification,
  isSnapchatMediaCopyCheck,
  snapchatMediaCopyObserved,
} from './snapchat-media-copy.js';
import {snapLeadFormProjection} from './snapchat-lead-forms.js';
import {snapSegmentProjection} from './snapchat-segments.js';
import {tiktokIdentityKind, tiktokIdentityVerification} from './tiktok-identities.js';
import {metaCopyKind, metaCopyVerification} from './meta-copies.js';
import {tiktokLookalikeKind, tiktokLookalikeVerification, tiktokAudienceGetPath} from './tiktok-lookalikes.js';
import {
  metaLookalikeKind,
  metaLookalikeVerification,
  metaLookalikeRead,
  metaLookalikeProjection,
} from './meta-lookalikes.js';
import {tiktokBudgetKind, tiktokBudgetVerification} from './tiktok-budgets.js';
import {
  tiktokCustomConversionKind,
  tiktokCustomConversionVerification,
  tiktokConversionGetPath,
  tiktokCustomConversionProjection,
} from './tiktok-custom-conversions.js';
import {
  tiktokSavedAudienceKind,
  tiktokSavedAudienceVerification,
  tiktokSavedAudienceRead,
  tiktokSavedAudienceProjection,
} from './tiktok-saved-audiences.js';
import {tiktokSmartPlusStatusKind, tiktokSmartPlusStatusVerification} from './tiktok-smart-plus-status.js';
import {tiktokSmartPlusBudgetKind, tiktokSmartPlusBudgetVerification} from './tiktok-smart-plus-budgets.js';
import {
  tiktokSmartPlusCampaignKind,
  tiktokSmartPlusCampaignVerification,
  tiktokSmartPlusCampaignProjection,
} from './tiktok-smart-plus-campaigns.js';
import {
  tiktokSmartPlusAdgroupKind,
  tiktokSmartPlusAdgroupVerification,
  tiktokSmartPlusAdgroupProjection,
} from './tiktok-smart-plus-adgroups.js';
import {
  tiktokSmartPlusCampaignUpdateKind,
  tiktokSmartPlusCampaignUpdateVerification,
} from './tiktok-smart-plus-campaign-updates.js';
import {
  tiktokCtaPortfolioKind,
  tiktokCtaPortfolioVerification,
  tiktokCtaPortfolioProjection,
  tiktokPortfolioGetPath,
} from './tiktok-cta-portfolios.js';
import {
  tiktokSmartPlusAdKind,
  tiktokSmartPlusAdVerification,
  tiktokSmartPlusAdProjection,
  tiktokSmartPlusAdGetPath,
} from './tiktok-smart-plus-ads.js';
import {tiktokSmartPlusAdUpdateKind, tiktokSmartPlusAdUpdateVerification} from './tiktok-smart-plus-ad-updates.js';
import {
  tiktokSmartPlusAdgroupUpdateKind,
  tiktokSmartPlusAdgroupUpdateVerification,
} from './tiktok-smart-plus-adgroup-updates.js';
import {
  tiktokSmartPlusMaterialStatusKind,
  tiktokSmartPlusMaterialStatusVerification,
} from './tiktok-smart-plus-material-status.js';
import {
  linkedinLeadFormKind,
  linkedinLeadFormVerification,
  isLinkedInLeadFormRead,
  linkedinLeadFormProjection,
} from './linkedin-lead-forms.js';
import {redditCreativeKind, redditCreativeVerification} from './reddit-creative-writes.js';
import {criteoTargetingKind, criteoTargetingVerification} from './criteo-targeting-writes.js';
import {metaLabelKind, metaLabelVerification} from './meta-label-writes.js';
import {googleBidKind, googleBidVerification, isGoogleBidRead} from './google-bid-modifiers.js';
import {
  linkedinConversionKind,
  linkedinConversionVerification,
  isLinkedInConversionRead,
} from './linkedin-conversion-links.js';
import {linkedinRuleKind, linkedinRuleVerification, isLinkedInRuleRead} from './linkedin-conversion-rules.js';
import {Registry} from './catalog.js';
import {normalizeReviewState} from './review-state.js';
import {googleAssetLinkKind, googleAssetLinkVerification} from './google-asset-links.js';
import {
  googleConfigurationKind,
  googleConfigurationVerification,
  googleConfigurationObserved,
} from './google-configuration-writes.js';
import {measurementWriteGateways, measurementVerification} from './measurement-writes.js';
import {dv360ListKind, dv360ListVerification, dv360ListObserved} from './dv360-list-writes.js';
import {dv360TargetingKind, dv360TargetingVerification, dv360TargetingObserved} from './dv360-line-item-targeting.js';
import {
  googleListingGroupKind,
  googleListingGroupVerification,
  isGoogleListingGroupRead,
  googleListingGroupObserved,
} from './google-listing-groups.js';
import {
  tiktokNegativeKeywordKind,
  tiktokNegativeKeywordVerification,
  isTiktokNegativeKeywordRead,
  tiktokNegativeKeywordObserved,
} from './tiktok-negative-keywords.js';
import {
  tiktokBrandSafetyKind,
  tiktokBrandSafetyVerification,
  isTiktokBrandSafetyRead,
  tiktokBrandSafetyObserved,
} from './tiktok-brand-safety.js';
import {
  metaValueRuleKind,
  metaValueRuleVerification,
  isMetaValueRuleRead,
  metaValueRuleObserved,
} from './meta-value-rules.js';
import {
  metaBrandSafetyKind,
  metaBrandSafetyVerification,
  isMetaBrandSafetyRead,
  metaBrandSafetyObserved,
} from './meta-brand-safety.js';
import {
  criteoOverrideKind,
  criteoOverrideVerification,
  isCriteoOverrideRead,
  criteoOverrideObserved,
} from './criteo-budget-overrides.js';
import {
  criteoLineItemKind,
  criteoLineItemVerification,
  isCriteoLineItemRead,
  criteoLineItemObserved,
} from './criteo-auction-line-items.js';
import {
  criteoKeywordKind,
  criteoBidMultiplierKind,
  criteoLineItemBiddingVerification,
} from './criteo-line-item-bidding.js';
import {gtmWorkflowKind, gtmWorkflowVerification, gtmWorkflowObserved} from './gtm-workflow-writes.js';
import {gtmWorkspaceKind, gtmWorkspaceVerification, gtmWorkspaceObserved} from './gtm-workspace-writes.js';
import {snapshotPlans} from './write-snapshots.js';
import {compileMicrosoft, microsoftGateway, microsoftContracts} from './microsoft-native.js';
import {
  microsoftAssociationWrite,
  microsoftAssociationVerification,
  microsoftAssociationObserved,
} from './microsoft-associations.js';
import {bad, fingerprint, obj} from './workspace-core.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {familyOf, familyOfRead} from './reviewed-families.js';
import {metaPrefix} from './meta-version.js';

// Snapchat records whose read-back adds provider fields or renames sent ones are compared as projections.
export const snapProjections: Record<string, (row: unknown) => unknown> = {
  lead_generation_forms: snapLeadFormProjection,
  segments: snapSegmentProjection,
};
export const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
export const normalize = (v: any): any =>
  Array.isArray(v)
    ? normalizeReviewState(v.map(normalize))
    : obj(v)
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [snake(k), normalize(x)]))
      : v;
export function differing(expected: any, actual: any, path = '', out: string[] = []): string[] {
  if (obj(expected)) {
    for (const [key, value] of Object.entries(expected)) differing(value, actual?.[key], path + '/' + key, out);
  } else if (
    ((typeof expected === 'number' && typeof actual === 'string') ||
      (typeof expected === 'string' && typeof actual === 'number')) &&
    String(expected) === String(actual)
  )
    return out;
  else if (fingerprint(expected) !== fingerprint(actual ?? null)) out.push(path);
  return out;
}
export type Acknowledged = Record<string, {sent: unknown; echoed: unknown}>;
export function verificationReads(
  plan: CompiledRequest,
  result: JsonObject,
  registry: Registry,
  before: unknown[] = [],
): {read: CompiledRequest; expected: JsonObject; id: string; acknowledged?: Acknowledged; unobservable?: string[]}[] {
  if (linkedinRuleKind(plan)) return linkedinRuleVerification(plan, result, before);
  if (linkedinLeadFormKind(plan)) return linkedinLeadFormVerification(plan, result);
  if (linkedinConversionKind(plan)) return linkedinConversionVerification(plan);
  // Registered families (reviewed-families.ts) are consulted here; the lines around this one belong to families not yet registered.
  const family = familyOf(plan);
  if (family?.verification) return family.verification(plan, result, before);
  if (googleBidKind(plan)) return googleBidVerification(plan, result);
  if (criteoTargetingKind(plan)) return criteoTargetingVerification(plan, before);
  if (metaLabelKind(plan)) return metaLabelVerification(plan, result, before);
  if (redditCreativeKind(plan)) return redditCreativeVerification(plan, result);
  if (gtmWorkspaceKind(plan)) return gtmWorkspaceVerification(plan, result, before);
  if (gtmWorkflowKind(plan)) return gtmWorkflowVerification(plan, result, before);
  if (dv360TargetingKind(plan)) return dv360TargetingVerification(plan, before);
  if (dv360ListKind(plan)) return dv360ListVerification(plan, result, before);
  if (googleListingGroupKind(plan)) return googleListingGroupVerification(plan, before);
  if (tiktokNegativeKeywordKind(plan)) return tiktokNegativeKeywordVerification(plan, before);
  if (tiktokBrandSafetyKind(plan)) return tiktokBrandSafetyVerification(plan, before);
  if (metaValueRuleKind(plan)) return metaValueRuleVerification(plan, result, before);
  if (metaBrandSafetyKind(plan)) return metaBrandSafetyVerification(plan, result);
  if (criteoLineItemKind(plan)) return criteoLineItemVerification(plan, result, before);
  if (criteoOverrideKind(plan)) return criteoOverrideVerification(plan);
  if (criteoKeywordKind(plan) || criteoBidMultiplierKind(plan)) return criteoLineItemBiddingVerification(plan);
  if (snapchatMediaCopyKind(plan)) return snapchatMediaCopyVerification(plan, result, before);
  if (googleConfigurationKind(plan)) return googleConfigurationVerification(plan, result);
  if (googleAssetLinkKind(plan)) return googleAssetLinkVerification(plan);
  if (microsoftAssociationWrite(plan)) return microsoftAssociationVerification(plan, compileMicrosoft);
  if (measurementWriteGateways.has(plan.gateway)) return measurementVerification(plan, result);
  const b = (plan.body ?? {}) as JsonObject,
    d = result.data ?? {},
    gateway = plan.gateway;
  const base = (path: string, query: JsonObject = {}): CompiledRequest => ({
    ...plan,
    path,
    method: 'GET',
    query,
    body: undefined,
    headers:
      gateway === 'linkedin_native_action'
        ? Object.fromEntries(
            Object.entries(plan.headers).filter(([k]) => ['LinkedIn-Version', 'X-Restli-Protocol-Version'].includes(k)),
          )
        : {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    action: 'AMCP_VERIFY_READ',
  });
  if (plan.method === 'DELETE') return [];
  if (gateway === 'google_ads_native_action') {
    const leaves = (value: JsonObject, prefix = ''): string[] =>
      Object.entries(value).flatMap(([k, v]) => (obj(v) ? leaves(v, prefix + snake(k) + '.') : [prefix + snake(k)]));
    return (d.results ?? []).map((r: JsonObject, i: number) => {
      const op = b.operations[i],
        record = op.create ?? op.update,
        expected = op.remove
          ? {status: 'REMOVED'}
          : Object.fromEntries(Object.entries(record).filter(([k]) => !['resource_name', 'resourceName'].includes(k))),
        fake = {
          ...plan,
          body: {
            operations: [
              op.remove
                ? {remove: op.remove}
                : {update: {resource_name: r.resourceName, ...expected}, update_mask: leaves(expected).join(',')},
            ],
          },
        };
      const p = snapshotPlans(fake, registry)[0]!;
      if (op.remove) {
        const resource = String((p.body as JsonObject).query).match(/ FROM ([a-z_]+)/)?.[1];
        if (!resource) bad('Removal has no exact state read.', 'VERIFICATION_UNSUPPORTED');
        p.googleState = {resource, names: [r.resourceName], allowMissing: true, removedAsAbsent: true};
      }
      return {read: p, expected, id: r.resourceName};
    });
  }
  if (gateway === microsoftGateway) {
    const contract = microsoftContracts.get(plan.action)!;
    if (!contract.kind) return [];
    const records = b[contract.kind] ?? [],
      ids = plan.action.startsWith('Add') ? d[contract.result] : records.map((r: JsonObject) => r.Id),
      idKey = contract.kind.slice(0, -1) + 'Ids';
    return ids.map((id: string, i: number) => ({
      read: compileMicrosoft({
        action: 'Get' + contract.kind + 'ByIds',
        account_id: plan.accountId,
        payload: {
          [idKey]: [id],
          ...(contract.kind === 'Campaigns'
            ? {CampaignType: 'Search'}
            : contract.kind === 'AdGroups'
              ? {CampaignId: b.CampaignId}
              : {AdGroupId: b.AdGroupId}),
        },
      }),
      expected: records[i],
      id,
    }));
  }
  if (metaCopyKind(plan))
    return metaCopyVerification(plan, result, before).map(v => ({...v, read: base(v.path, v.query)}));
  if (metaLookalikeKind(plan))
    return metaLookalikeVerification(plan, result).map(v => ({...v, read: base(v.path, v.query)}));
  if (gateway === 'meta_native_action') {
    const id = String(d.id ?? plan.path.split('/').at(-1));
    if (!/^\d+$/.test(id)) return [];
    const expected = {...b};
    delete expected.execution_options;
    if (expected.creative?.creative_id) expected.creative = {id: expected.creative.creative_id};
    return [{read: base(metaPrefix + id, {fields: ['id', ...Object.keys(expected)].join(',')}), expected, id}];
  }
  if (tiktokIdentityKind(plan))
    return tiktokIdentityVerification(plan, result).map(v => ({
      ...v,
      read: {...base(v.path, v.query), action: 'tiktok_identity_info_get'},
    }));
  if (tiktokBudgetKind(plan))
    return tiktokBudgetVerification(plan).map(v => ({
      ...v,
      read: {...base(v.path, v.query), action: 'tiktok_adgroup_get'},
    }));
  if (tiktokCustomConversionKind(plan))
    return tiktokCustomConversionVerification(plan, result).map(v => ({
      ...v,
      read: {...base(v.path, v.query), action: 'tiktok_custom_conversion_get'},
    }));
  if (tiktokSavedAudienceKind(plan))
    return tiktokSavedAudienceVerification(plan, result).map(v => ({
      ...v,
      read: {...base(v.path, v.query), action: 'tiktok_dmp_saved_audience_list_get'},
    }));
  if (tiktokSmartPlusStatusKind(plan))
    return tiktokSmartPlusStatusVerification(plan).map(v => ({
      read: {...base(v.path, v.query), action: v.action},
      expected: v.expected,
      id: v.id,
    }));
  if (tiktokSmartPlusBudgetKind(plan))
    return tiktokSmartPlusBudgetVerification(plan).map(v => ({
      ...v,
      read: {...base(v.path, v.query), action: 'tiktok_smart_plus_adgroup_get'},
    }));
  if (tiktokSmartPlusCampaignKind(plan))
    return tiktokSmartPlusCampaignVerification(plan, result).map(v => ({
      ...v,
      read: {...base(v.path, v.query), action: 'tiktok_smart_plus_campaign_get'},
    }));
  if (tiktokSmartPlusAdgroupKind(plan))
    return tiktokSmartPlusAdgroupVerification(plan, result).map(v => ({
      ...v,
      read: {...base(v.path, v.query), action: 'tiktok_smart_plus_adgroup_get'},
    }));
  if (tiktokSmartPlusCampaignUpdateKind(plan))
    return tiktokSmartPlusCampaignUpdateVerification(plan).map(v => ({
      ...v,
      read: {...base(v.path, v.query), action: 'tiktok_smart_plus_campaign_get'},
    }));
  if (tiktokCtaPortfolioKind(plan))
    return tiktokCtaPortfolioVerification(plan, result).map(v => ({
      ...v,
      read: {...base(v.path, v.query), action: 'tiktok_creative_portfolio_get'},
    }));
  if (tiktokSmartPlusAdKind(plan))
    return tiktokSmartPlusAdVerification(plan, result).map(v => ({
      ...v,
      read: {...base(v.path, v.query), action: 'tiktok_smart_plus_ad_get'},
    }));
  if (tiktokSmartPlusAdUpdateKind(plan))
    return tiktokSmartPlusAdUpdateVerification(plan).map(v => ({
      ...v,
      read: {...base(v.path, v.query), action: 'tiktok_smart_plus_ad_get'},
    }));
  if (tiktokSmartPlusAdgroupUpdateKind(plan))
    return tiktokSmartPlusAdgroupUpdateVerification(plan).map(v => ({
      ...v,
      read: {...base(v.path, v.query), action: 'tiktok_smart_plus_adgroup_get'},
    }));
  if (tiktokSmartPlusMaterialStatusKind(plan))
    return tiktokSmartPlusMaterialStatusVerification(plan).map(v => ({
      ...v,
      read: {...base(v.path, v.query), action: 'tiktok_smart_plus_ad_get'},
    }));
  if (tiktokLookalikeKind(plan))
    return tiktokLookalikeVerification(plan, result).map(v => ({
      ...v,
      read: {...base(v.path, v.query), action: 'tiktok_dmp_custom_audience_get'},
    }));
  if (gateway === 'tiktok_native_action') {
    const kind = plan.path.split('/')[2]!,
      ids = d.data?.[kind + '_ids'] ?? [d.data?.[kind + '_id'] ?? b[kind + '_id']];
    if (ids.some((id: unknown) => typeof id !== 'string')) return [];
    const expected =
      kind === 'ad' && plan.path === '/v1.3/ad/create/'
        ? {...b.creatives[0], adgroup_id: b.adgroup_id}
        : Object.fromEntries(Object.entries(b).filter(([k]) => !['advertiser_id', kind + '_ids'].includes(k)));
    return ids.map((id: string) => ({
      read: {
        ...base('/v1.3/' + kind + '/get/', {
          advertiser_id: plan.accountId,
          filtering: {[kind + '_ids']: [id]},
          page_size: 100,
        }),
        action: 'tiktok_' + kind + '_get',
      },
      expected,
      id,
    }));
  }
  if (gateway === 'snapchat_native_action') {
    const kind = Object.keys(d).find(k =>
      ['campaigns', 'adsquads', 'ads', 'creatives', 'lead_generation_forms', 'segments'].includes(k),
    );
    if (!kind) return [];
    const singular = kind === 'adsquads' ? 'adsquad' : kind.slice(0, -1);
    // Array-index patches and removes need before/after reconstruction. Do not label partial checks verified.
    if (
      Array.isArray(plan.body) &&
      plan.body.some((p: JsonObject) => !['add', 'replace'].includes(p.op) || !/^\/[A-Za-z_]+$/.test(p.path))
    )
      return [];
    // Snapchat's GET never returns placement_v2 (it reads back as placement:"UNSUPPORTED"). A field no read
    // can observe is compared with the provider's own write response instead; a missing echo stays inconclusive.
    const writeOnly = kind === 'adsquads' ? ['placement_v2'] : [];
    return d[kind].map((r: JsonObject, i: number) => {
      const id = r[singular].id,
        expected = {
          ...(b[kind]?.[i] ??
            (Array.isArray(plan.body)
              ? Object.fromEntries((plan.body as JsonObject[]).map(p => [p.path.slice(1), p.value]))
              : b)),
        },
        acknowledged: Acknowledged = {};
      for (const field of writeOnly)
        if (Object.hasOwn(expected, field)) {
          acknowledged[field] = {sent: expected[field], echoed: r[singular]?.[field]};
          delete expected[field];
        }
      return {
        read: base('/v1/' + kind + '/' + id),
        expected: (snapProjections[kind]?.(expected) ?? expected) as JsonObject,
        id,
        ...(Object.keys(acknowledged).length ? {acknowledged} : {}),
      };
    });
  }
  if (gateway === 'reddit_native_action') {
    const kind = plan.method === 'POST' ? plan.path.split('/').at(-1) : plan.path.split('/').at(-2),
      id = d.data?.id;
    if (!id) return [];
    return [{read: base('/api/v3/' + kind + '/' + id), expected: b.data, id}];
  }
  if (gateway === 'x_ads_native_action') {
    const records = Array.isArray(d.data) ? d.data : [d.data];
    return records.filter(Boolean).map((r: JsonObject) => ({
      read: base(plan.method === 'POST' ? plan.path + '/' + r.id : plan.path),
      expected: b,
      id: String(r.id),
    }));
  }
  if (gateway === 'linkedin_native_action') {
    const id = String(result.created_id ?? result.headers?.['x-restli-id'] ?? plan.path.split('/').at(-1)),
      expected = b.patch?.$set ?? b;
    return [
      {
        read: base(
          plan.method === 'POST' && result.status === 201 ? plan.path + '/' + encodeURIComponent(id) : plan.path,
        ),
        expected,
        id: id.split(':').at(-1)!,
      },
    ];
  }
  if (gateway === 'dv360_native_action') {
    const id = d.campaignId ?? d.insertionOrderId ?? d.lineItemId ?? d.creativeId;
    if (!id) return [];
    return [{read: base(plan.method === 'POST' ? plan.path + '/' + id : plan.path), expected: b, id: String(id)}];
  }
  return [];
}
export function entity(plan: CompiledRequest, data: JsonObject): JsonObject {
  const family = familyOfRead(plan);
  if (family?.observed) return family.observed(plan, data);
  if (isLinkedInConversionRead(plan) || isLinkedInRuleRead(plan)) return data;
  if (isLinkedInLeadFormRead(plan)) return linkedinLeadFormProjection(data);
  if (isGoogleBidRead(plan)) return data;
  if (plan.gtmWorkspaceState) return gtmWorkspaceObserved(plan, data);
  if (data.amcp_absent === true) return data;
  if (plan.gtmState) return gtmWorkflowObserved(plan, data);
  if (plan.dv360ListState) return dv360ListObserved(plan, data);
  if (plan.dv360TargetingState) return dv360TargetingObserved(plan, data);
  if (plan.gateway === microsoftGateway && plan.action === 'GetAdExtensionsAssociations')
    return microsoftAssociationObserved(plan, data);
  if (plan.gateway === 'apple_ads_native_action') {
    if (plan.action === 'AMCP_STATE_OPTIONAL' && data.result?.deleted === true)
      return {amcp_absent: true, path: plan.path};
    return Array.isArray(data.result?.adAccountIds)
      ? {
          ...data.result,
          adAccountIds: [...data.result.adAccountIds].sort((a, b) => String(a).localeCompare(String(b), 'en')),
        }
      : data.result;
  }
  if (plan.googleState?.removedAsAbsent && !data.results?.length) return {status: 'REMOVED'};
  if (isGoogleListingGroupRead(plan)) return googleListingGroupObserved(plan, data);
  if (isTiktokNegativeKeywordRead(plan)) return tiktokNegativeKeywordObserved(plan, data);
  if (isTiktokBrandSafetyRead(plan)) return tiktokBrandSafetyObserved(plan, data);
  if (isMetaValueRuleRead(plan)) return metaValueRuleObserved(plan, data);
  if (isMetaBrandSafetyRead(plan)) return metaBrandSafetyObserved(plan, data);
  if (isCriteoLineItemRead(plan)) return criteoLineItemObserved(plan, data);
  if (isCriteoOverrideRead(plan)) return criteoOverrideObserved(plan, data);
  if (isSnapchatMediaCopyCheck(plan)) return snapchatMediaCopyObserved(plan, data);
  if (plan.gateway === 'google_ads_native_action')
    return googleConfigurationObserved(plan, Object.values(data.results?.[0] ?? {})[0] as JsonObject);
  if (plan.gateway === microsoftGateway) return data[microsoftContracts.get(plan.action)!.result]?.[0];
  if (plan.gateway === 'tiktok_native_action' && plan.path === '/v1.3/identity/info/') return data.data?.identity_info;
  if (plan.gateway === 'tiktok_native_action' && plan.path === tiktokAudienceGetPath)
    return data.data?.list?.[0]?.audience_details;
  if (metaLookalikeRead(plan)) return metaLookalikeProjection(data) as JsonObject;
  if (plan.gateway === 'tiktok_native_action' && plan.path === tiktokConversionGetPath)
    return tiktokCustomConversionProjection(data.data);
  if (tiktokSavedAudienceRead(plan)) return tiktokSavedAudienceProjection(data.data?.saved_audiences?.[0]);
  if (plan.gateway === 'tiktok_native_action' && plan.path === '/v1.3/smart_plus/campaign/get/')
    return tiktokSmartPlusCampaignProjection(data.data?.list?.[0]) as JsonObject;
  if (plan.gateway === 'tiktok_native_action' && plan.path === '/v1.3/smart_plus/adgroup/get/')
    return tiktokSmartPlusAdgroupProjection(data.data?.list?.[0]) as JsonObject;
  if (plan.gateway === 'tiktok_native_action' && plan.path === tiktokPortfolioGetPath)
    return tiktokCtaPortfolioProjection(data.data);
  if (plan.gateway === 'tiktok_native_action' && plan.path === tiktokSmartPlusAdGetPath)
    return tiktokSmartPlusAdProjection(data.data?.list?.[0]) as JsonObject;
  if (plan.gateway === 'tiktok_native_action') return data.data?.list?.[0];
  if (plan.gateway === 'snapchat_native_action') {
    const kind = plan.path.split('/').at(-2)!,
      singular = kind === 'adsquads' ? 'adsquad' : kind.slice(0, -1),
      row = data[kind]?.[0]?.[singular];
    return (snapProjections[kind]?.(row) ?? row) as JsonObject;
  }
  if (['reddit_native_action', 'x_ads_native_action'].includes(plan.gateway)) return data.data;
  return data;
}
