/** Verification plan: the reads that show a write took effect, what each must contain, and how read-backs compare. */
import {snapLeadFormProjection} from './snapchat-lead-forms.js';
import {snapSegmentProjection} from './snapchat-segments.js';
import {tiktokAudienceGetPath} from './tiktok-paths.js';
import {tiktokConversionGetPath, tiktokCustomConversionProjection} from './tiktok-custom-conversions.js';
import {tiktokSavedAudienceRead, tiktokSavedAudienceProjection} from './tiktok-saved-audiences.js';
import {tiktokSmartPlusCampaignProjection} from './tiktok-smart-plus-campaigns.js';
import {tiktokSmartPlusAdgroupProjection} from './tiktok-smart-plus-adgroups.js';
import {tiktokCtaPortfolioProjection, tiktokPortfolioGetPath} from './tiktok-cta-portfolios.js';
import {tiktokSmartPlusAdProjection, tiktokSmartPlusAdGetPath} from './tiktok-smart-plus-ads.js';
import {Registry} from './catalog.js';
import {normalizeReviewState} from './review-state-core.js';
import {googleConfigurationObserved} from './google-configuration-writes.js';
import {snapshotPlans} from './write-snapshots.js';
import {applyExecutionRisk} from './execution-risk.js';
import {microsoftGateway, microsoftContracts} from './microsoft-native.js';
import {bad, fingerprint, obj} from './workspace-core.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {familyOf, familyOfRead} from './reviewed-families.js';
import {metaPrefix} from './meta-version.js';
import {metaCreativeFeaturesObserved} from './meta-creative-features.js';

// Snapchat records whose read-back adds provider fields or renames sent ones are compared as projections.
export const snapProjections: Record<string, (row: unknown) => unknown> = {
  lead_generation_forms: snapLeadFormProjection,
  segments: snapSegmentProjection,
};
export const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
/** Retire older value-bidding cache proofs without changing their original accepted mutation or receipt. */
export function googleValueVerificationVersion(plan: CompiledRequest): string | undefined {
  const body = plan.body as JsonObject | undefined;
  return plan.gateway === 'google_ads_native_action' &&
    plan.method === 'POST' &&
    /\/campaigns:mutate$/.test(plan.path) &&
    Array.isArray(body?.operations) &&
    body.operations.some((op: JsonObject) =>
      Object.keys(op.create ?? op.update ?? {}).some(key => snake(key) === 'maximize_conversion_value'),
    )
    ? 'google-campaign-value-roas-v1'
    : undefined;
}
/** Retire a family's old partial proof in pending dependency chains, preserving the accepted receipt/key. */
export function verificationContractVersion(plan: CompiledRequest): string | undefined {
  return familyOf(plan)?.verificationCacheVersion ?? googleValueVerificationVersion(plan);
}
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
): {
  read: CompiledRequest;
  expected: JsonObject;
  id: string;
  acknowledged?: Acknowledged;
  unobservable?: string[];
  /** Sent fields the read may omit: when it does, they are compared with the write response instead (inconclusive
   * when that has no echo), never passed silently and never failed for the omission alone. */
  readOptional?: string[];
  /** What the read shows beyond the expected fields, reported in the check and never compared. */
  observe?: (actual: unknown) => JsonObject | undefined;
}[] {
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
  const family = familyOf(plan);
  if (family?.verification) return family.verification(plan, result, before, base, applyExecutionRisk);
  if (plan.method === 'DELETE') return [];
  if (gateway === 'google_ads_native_action') {
    const leaves = (value: JsonObject, prefix = ''): string[] =>
      Object.entries(value).flatMap(([k, v]) => (obj(v) ? leaves(v, prefix + snake(k) + '.') : [prefix + snake(k)]));
    return (d.results ?? []).map((r: JsonObject, i: number) => {
      const op = b.operations[i],
        record = op.create ?? op.update,
        expected = op.remove
          ? {status: 'REMOVED'}
          : Object.fromEntries(Object.entries(record).filter(([k]) => !['resource_name', 'resourceName'].includes(k)));
      // An empty bidding message has no scalar leaves. Prove its oneof through Google's selectable native enum,
      // rather than letting an empty object compare successfully with any or no strategy (F-185).
      if (/\/campaigns:mutate$/.test(plan.path) && !op.remove) {
        const schemes: Record<string, string> = {
          manual_cpc: 'MANUAL_CPC',
          target_spend: 'TARGET_SPEND',
          maximize_conversions: 'MAXIMIZE_CONVERSIONS',
          maximize_conversion_value: 'MAXIMIZE_CONVERSION_VALUE',
        };
        const chosen = Object.keys(expected).find(key => Object.hasOwn(schemes, snake(key)));
        if (chosen) {
          expected.bidding_strategy_type = schemes[snake(chosen)];
          // MaximizeConversions.target_cpa_micros is an implicit-presence proto3 int64. Selecting it establishes
          // zero when ProtoJSON omits the default; a positive unexpected target must not verify an untargeted plan.
          if (
            snake(chosen) === 'maximize_conversions' &&
            obj(expected[chosen]) &&
            !Object.keys(expected[chosen]).some(key => snake(key) === 'target_cpa_micros')
          )
            expected[chosen] = {...expected[chosen], target_cpa_micros: '0'};
          // MaximizeConversionValue.target_roas is likewise an implicit-presence proto3 double in v25.
          if (
            snake(chosen) === 'maximize_conversion_value' &&
            obj(expected[chosen]) &&
            !Object.keys(expected[chosen]).some(key => snake(key) === 'target_roas')
          )
            expected[chosen] = {...expected[chosen], target_roas: 0};
        }
      }
      const fake = {
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
      if (Object.keys(expected).some(key => snake(key) === 'maximize_conversion_value'))
        // Added after GAQL compilation: this local typed proof marker is never a native request field.
        expected.amcp_conversion_value_target_shape_valid = true;
      if (op.remove) {
        const resource = String((p.body as JsonObject).query).match(/ FROM ([a-z_]+)/)?.[1];
        if (!resource) bad('Removal has no exact state read.', 'VERIFICATION_UNSUPPORTED');
        p.googleState = {resource, names: [r.resourceName], allowMissing: true, removedAsAbsent: true};
      }
      return {read: p, expected, id: r.resourceName};
    });
  }
  if (gateway === 'meta_native_action') {
    const id = String(d.id ?? plan.path.split('/').at(-1));
    if (!/^\d+$/.test(id)) return [];
    const expected = {...b};
    delete expected.execution_options;
    if (expected.creative?.creative_id) expected.creative = {id: expected.creative.creative_id};
    // Meta's reference does not say whether a creative read returns destination_spec (the owner's condition of
    // 2026-09-29: verify it on read-back, else against the write response, never silently). The Advantage+ creative
    // feature choices (PRV-06 C) are compared the same way, and the features Meta shows on its own are reported.
    const creative = /\/adcreatives$/.test(plan.path),
      readOptional = creative
        ? ['destination_spec', 'degrees_of_freedom_spec'].filter(field => Object.hasOwn(expected, field))
        : [];
    return [
      {
        read: base(metaPrefix + id, {fields: ['id', ...Object.keys(expected)].join(',')}),
        expected,
        id,
        ...(readOptional.length ? {readOptional} : {}),
        ...(creative && Object.hasOwn(expected, 'degrees_of_freedom_spec')
          ? {observe: (actual: unknown) => metaCreativeFeaturesObserved(expected, actual)}
          : {}),
      },
    ];
  }
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
  return family?.observed
    ? family.observed(plan, data, () => gatewayObserved(plan, data))
    : gatewayObserved(plan, data);
}
/** What a verification read shows of its resource when no family projects it: the gateway's record, unwrapped. */
function gatewayObserved(plan: CompiledRequest, data: JsonObject): JsonObject {
  if (data.amcp_absent === true) return data;
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
  if (plan.gateway === 'google_ads_native_action') {
    let observed = googleConfigurationObserved(plan, Object.values(data.results?.[0] ?? {})[0] as JsonObject);
    const query = (plan.body as JsonObject)?.query ?? '';
    if (
      obj(observed) &&
      observed.biddingStrategyType === 'MAXIMIZE_CONVERSIONS' &&
      /\bcampaign\.maximize_conversions\.target_cpa_micros\b/.test(query) &&
      / FROM campaign(?: |$)/.test(query) &&
      (observed.maximizeConversions === undefined || obj(observed.maximizeConversions)) &&
      !Object.hasOwn(observed.maximizeConversions ?? {}, 'targetCpaMicros')
    )
      observed = {...observed, maximizeConversions: {...observed.maximizeConversions, targetCpaMicros: '0'}};
    if (
      obj(observed) &&
      observed.biddingStrategyType === 'MAXIMIZE_CONVERSION_VALUE' &&
      /\bcampaign\.maximize_conversion_value\.target_roas\b/.test(query) &&
      / FROM campaign(?: |$)/.test(query)
    ) {
      const value = observed.maximizeConversionValue,
        shape = value === undefined || obj(value),
        absent = shape && !Object.hasOwn(value ?? {}, 'targetRoas');
      if (absent) observed = {...observed, maximizeConversionValue: {...value, targetRoas: 0}};
      observed = {
        ...observed,
        amcpConversionValueTargetShapeValid:
          shape && (absent || (typeof value.targetRoas === 'number' && Number.isFinite(value.targetRoas))),
      };
    }
    return observed;
  }
  if (plan.gateway === microsoftGateway) return data[microsoftContracts.get(plan.action)!.result]?.[0];
  if (plan.gateway === 'tiktok_native_action' && plan.path === '/v1.3/identity/info/') return data.data?.identity_info;
  if (plan.gateway === 'tiktok_native_action' && plan.path === tiktokAudienceGetPath)
    return data.data?.list?.[0]?.audience_details;
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
