import {isIP} from 'node:net';
import {MirrorError} from './errors.js';
import {googleJson, validateGoogleRequest} from './google-contracts.js';
import {publicReportAddress} from './microsoft-report-download.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';

type Kind = 'text' | 'images' | 'recommendations';
const textFields = ['HEADLINE', 'LONG_HEADLINE', 'DESCRIPTION'];
const imageFields = [
  'MARKETING_IMAGE',
  'SQUARE_MARKETING_IMAGE',
  'PORTRAIT_MARKETING_IMAGE',
  'TALL_PORTRAIT_MARKETING_IMAGE',
];
const channels = ['SEARCH', 'PERFORMANCE_MAX', 'DISPLAY', 'DEMAND_GEN'];
const biddingTypes = [
  'MAXIMIZE_CLICKS_OPT_IN',
  'MAXIMIZE_CONVERSIONS_OPT_IN',
  'MAXIMIZE_CONVERSION_VALUE_OPT_IN',
  'SET_TARGET_CPA',
  'SET_TARGET_ROAS',
  'TARGET_CPA_OPT_IN',
  'TARGET_ROAS_OPT_IN',
];
const recommendationFields: Record<string, string> = {
  CAMPAIGN_BUDGET: 'campaignBudgetRecommendation',
  KEYWORD: 'keywordRecommendation',
  MAXIMIZE_CLICKS_OPT_IN: 'maximizeClicksOptInRecommendation',
  MAXIMIZE_CONVERSIONS_OPT_IN: 'maximizeConversionsOptInRecommendation',
  MAXIMIZE_CONVERSION_VALUE_OPT_IN: 'maximizeConversionValueOptInRecommendation',
  SET_TARGET_CPA: 'setTargetCpaRecommendation',
  SET_TARGET_ROAS: 'setTargetRoasRecommendation',
  SITELINK_ASSET: 'sitelinkAssetRecommendation',
  TARGET_CPA_OPT_IN: 'targetCpaOptInRecommendation',
  TARGET_ROAS_OPT_IN: 'targetRoasOptInRecommendation',
};

/** Explicit draft-generation RPCs (present in v23 and v25). Neither apply nor shareable previews qualify. */
export function googleGenerationKind(p: CompiledRequest): Kind | undefined {
  if (
    p.gateway !== 'google_ads_native_action' ||
    p.method !== 'POST' ||
    p.specialTransport ||
    (p.origin && p.origin !== 'https://googleads.googleapis.com')
  )
    return;
  const route =
    /^\/v\d+\/customers\/\d+\/(assetGenerations:generateText|assetGenerations:generateImages|recommendations:generate)$/.exec(
      p.path,
    )?.[1];
  return route === 'assetGenerations:generateText'
    ? 'text'
    : route === 'assetGenerations:generateImages'
      ? 'images'
      : route === 'recommendations:generate'
        ? 'recommendations'
        : undefined;
}
function invalid(field: string, reason: string): never {
  throw new MirrorError('INVALID_VENDOR_BODY', 'Invalid Google generation input.', {field, reason});
}
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function words(v: unknown, field: string, max = 1500): asserts v is string {
  if (typeof v !== 'string' || !v.trim() || [...v].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))
    invalid(field, 'Supply nonempty text within ' + max + ' characters.');
}
function list(v: unknown, field: string, max: number, allowed?: string[]): asserts v is string[] {
  if (
    !Array.isArray(v) ||
    !v.length ||
    v.length > max ||
    v.some(x => typeof x !== 'string' || !x.trim() || (allowed && !allowed.includes(x))) ||
    new Set(v).size !== v.length
  )
    invalid(
      field,
      'Supply a nonempty unique list, at most ' + max + ' values' + (allowed ? ': ' + allowed.join(', ') : '.'),
    );
}
function publicUrl(v: unknown, field: string) {
  if (typeof v !== 'string' || v.length > 8192 || /[\s\u0000-\u001f]/.test(v))
    invalid(field, 'Supply a complete public HTTP(S) URL.');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    invalid(field, 'Supply a complete public HTTP(S) URL.');
  }
  const host = u.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.port ||
    (!host.includes('.') && !isIP(host)) ||
    /^(?:localhost|metadata\.google\.internal)$|\.(?:localhost|local|internal|lan)$/.test(host) ||
    (isIP(host) && !publicReportAddress(host))
  )
    invalid(field, 'Private hosts, embedded credentials and custom ports cannot be forwarded.');
  if (
    [...u.searchParams.keys()].some(k =>
      /^(?:access_token|oauth_token|refresh_token|client_secret|authorization)$/i.test(k),
    )
  )
    invalid(field, 'Do not put OAuth credentials in a URL.');
  // Google fetches these URLs. AMCP never resolves or downloads their content here.
}
function positiveMicros(v: unknown, field: string, zero = false) {
  if (
    !((typeof v === 'string' && /^\d+$/.test(v)) || (typeof v === 'number' && Number.isSafeInteger(v))) ||
    BigInt(v as string) < (zero ? 0n : 1n)
  )
    invalid(field, 'Supply nonnegative native micros' + (zero ? ' (zero allowed).' : ' greater than zero.'));
}
function knownEnum(v: unknown, field: string) {
  if (typeof v !== 'string' || ['UNKNOWN', 'UNSPECIFIED', 'INVALID', ''].includes(v))
    invalid(field, 'Supply a named, known native enum value.');
}

export function validateGoogleGeneration(p: CompiledRequest): void {
  const kind = googleGenerationKind(p);
  if (!kind) return;
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('request', 'These fixed RPCs accept a JSON body without caller header or query overrides.');
  validateGoogleRequest(p);
  const b = googleJson(p.body);
  if (!object(b)) invalid('payload', 'Supply a native object.');
  if (kind !== 'recommendations') {
    const context = b.existingGenerationContext,
      channel = b.advertisingChannelType;
    if (kind === 'text' && context !== undefined) {
      if (channel !== undefined || !object(context) || Object.keys(context).length !== 1)
        invalid('existingGenerationContext', 'Choose exactly one native context or advertisingChannelType.');
      const [key, value] = Object.entries(context)[0]!;
      const shape =
        key === 'existingAssetGroup'
          ? /^customers\/\d+\/assetGroups\/\d+$/
          : key === 'existingAdGroupAd'
            ? /^customers\/\d+\/adGroupAds\/\d+~\d+$/
            : undefined;
      if (typeof value !== 'string' || !shape?.test(value))
        invalid('existingGenerationContext', 'Use an existing AssetGroup or AdGroupAd resource name.');
      if (value.split('/')[1] !== p.accountId?.replaceAll('-', ''))
        throw new MirrorError(
          'ACCOUNT_SCOPE_MISMATCH',
          'Generation context must belong to the selected customer.',
          {},
          403,
        );
    } else if (!channels.includes(channel))
      invalid('advertisingChannelType', 'Choose SEARCH, PERFORMANCE_MAX, DISPLAY or DEMAND_GEN.');
    if (kind === 'text') {
      list(b.assetFieldTypes, 'assetFieldTypes', 3, textFields);
      if (context === undefined || b.finalUrl !== undefined) publicUrl(b.finalUrl, 'finalUrl');
      if (b.freeformPrompt !== undefined) words(b.freeformPrompt, 'freeformPrompt');
      if (b.keywords !== undefined) {
        list(b.keywords, 'keywords', 100);
        b.keywords.forEach((v: string) => words(v, 'keywords', 1000));
      }
    } else {
      if (b.assetFieldTypes !== undefined) {
        if (!Array.isArray(b.assetFieldTypes)) invalid('assetFieldTypes', 'Use an array.');
        if (b.assetFieldTypes.length) list(b.assetFieldTypes, 'assetFieldTypes', 4, imageFields);
      }
      const inputs = ['freeformGeneration', 'finalUrlGeneration', 'productRecontextGeneration'].filter(
        k => b[k] !== undefined,
      );
      if (inputs.length !== 1 || !object(b[inputs[0]!]))
        invalid('generationType', 'Choose exactly one freeform, final URL or product-recontext input.');
      const name = inputs[0]!,
        input = b[name];
      if (name === 'freeformGeneration') words(input.freeformPrompt, 'freeformGeneration.freeformPrompt');
      if (name === 'finalUrlGeneration') publicUrl(input.finalUrl, 'finalUrlGeneration.finalUrl');
      if (name === 'productRecontextGeneration') {
        if (input.prompt !== undefined) words(input.prompt, 'productRecontextGeneration.prompt');
        if (!Array.isArray(input.sourceImages) || input.sourceImages.length < 1 || input.sourceImages.length > 3)
          invalid('sourceImages', 'Supply 1–3 source images.');
        for (const image of input.sourceImages) {
          const data = image?.imageData;
          if (
            typeof data !== 'string' ||
            !data.length ||
            data.length > 700000 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) ||
            Buffer.from(data, 'base64').toString('base64') !== data
          )
            invalid(
              'sourceImages.imageData',
              'Supply canonical base64 image bytes within 700000 encoded characters per image.',
            );
        }
      }
    }
    return;
  }
  if (!['SEARCH', 'PERFORMANCE_MAX'].includes(b.advertisingChannelType))
    invalid('advertisingChannelType', 'Recommendations require SEARCH or PERFORMANCE_MAX.');
  list(b.recommendationTypes, 'recommendationTypes', 10, Object.keys(recommendationFields));
  const types = b.recommendationTypes as string[];
  if (types.some(t => t === 'CAMPAIGN_BUDGET' || biddingTypes.includes(t)))
    knownEnum(b.biddingInfo?.biddingStrategyType, 'biddingInfo.biddingStrategyType');
  if (types.some(t => biddingTypes.includes(t))) knownEnum(b.conversionTrackingStatus, 'conversionTrackingStatus');
  if (
    types.includes('SITELINK_ASSET') &&
    (!Number.isSafeInteger(b.campaignSitelinkCount) || b.campaignSitelinkCount < 0)
  )
    invalid('campaignSitelinkCount', 'Supply the actual nonnegative sitelink count; zero is valid.');
  if (types.includes('KEYWORD')) {
    if (!object(b.seedInfo) || (!b.seedInfo.keywordSeeds?.length && !b.seedInfo.urlSeed))
      invalid('seedInfo', 'Supply keyword seeds and/or a public URL.');
    if (b.seedInfo.keywordSeeds !== undefined) {
      list(b.seedInfo.keywordSeeds, 'seedInfo.keywordSeeds', 100);
      b.seedInfo.keywordSeeds.forEach((v: string) => words(v, 'seedInfo.keywordSeeds', 1000));
    }
    if (b.seedInfo.urlSeed !== undefined) publicUrl(b.seedInfo.urlSeed, 'seedInfo.urlSeed');
  }
  if (b.adGroupInfo !== undefined) {
    if (!Array.isArray(b.adGroupInfo) || b.adGroupInfo.length > 1)
      invalid('adGroupInfo', 'The native method supports information from one ad group.');
    for (const group of b.adGroupInfo) {
      if (types.includes('KEYWORD')) knownEnum(group?.adGroupType, 'adGroupInfo.adGroupType');
      if (group?.keywords !== undefined) {
        if (!Array.isArray(group.keywords) || group.keywords.length > 1000)
          invalid('adGroupInfo.keywords', 'Use at most 1000 native keyword objects.');
        for (const k of group.keywords) {
          words(k?.text, 'adGroupInfo.keywords.text', 1000);
          if (!['BROAD', 'PHRASE', 'EXACT'].includes(k.matchType))
            invalid('adGroupInfo.keywords.matchType', 'Choose a native keyword match type.');
        }
      }
    }
  }
  if (types.includes('CAMPAIGN_BUDGET')) {
    if (!Array.isArray(b.assetGroupInfo) || !b.assetGroupInfo.length || b.assetGroupInfo.length > 100)
      invalid('assetGroupInfo', 'Supply 1–100 actual asset-group inputs with final URLs.');
    for (const group of b.assetGroupInfo) publicUrl(group?.finalUrl, 'assetGroupInfo.finalUrl');
    if (b.advertisingChannelType === 'SEARCH') {
      list(b.countryCodes, 'countryCodes', 250);
      list(b.languageCodes, 'languageCodes', 100);
      if (b.countryCodes.some((v: string) => !/^[A-Z]{2}$/.test(v)))
        invalid('countryCodes', 'Use native uppercase country codes.');
      if (!b.positiveLocationsIds?.length && !b.negativeLocationsIds?.length)
        invalid('positiveLocationsIds/negativeLocationsIds', 'Supply actual included or excluded location IDs.');
      for (const key of ['positiveLocationsIds', 'negativeLocationsIds'])
        if (b[key]?.length) for (const value of b[key]) positiveMicros(value, key);
      if (!b.adGroupInfo?.length || !b.adGroupInfo[0]?.keywords?.length)
        invalid('adGroupInfo.keywords', 'Search budget recommendations need the actual ad-group keywords.');
      if (b.biddingInfo.biddingStrategyType === 'TARGET_IMPRESSION_SHARE') {
        const t = b.biddingInfo.targetImpressionShareInfo;
        positiveMicros(t?.targetImpressionShareMicros, 'targetImpressionShareMicros');
        if (
          BigInt(t.targetImpressionShareMicros) > 1000000n ||
          !['ANYWHERE_ON_PAGE', 'TOP_OF_PAGE', 'ABSOLUTE_TOP_OF_PAGE'].includes(t.location)
        )
          invalid('targetImpressionShareInfo', 'Use 1–1000000 impression-share micros and a known location.');
      }
    }
  }
  if (b.merchantCenterAccountId !== undefined) {
    if (b.advertisingChannelType !== 'PERFORMANCE_MAX')
      invalid('merchantCenterAccountId', 'Only Performance Max uses this input.');
    positiveMicros(b.merchantCenterAccountId, 'merchantCenterAccountId');
  }
  if (b.budgetInfo !== undefined) positiveMicros(b.budgetInfo?.currentBudget, 'budgetInfo.currentBudget', true);
  if (b.biddingInfo?.targetCpaMicros !== undefined) {
    if (!['TARGET_CPA', 'MAXIMIZE_CONVERSIONS'].includes(b.biddingInfo.biddingStrategyType))
      invalid('biddingInfo.targetCpaMicros', 'Use a CPA-compatible bidding strategy.');
    positiveMicros(b.biddingInfo.targetCpaMicros, 'biddingInfo.targetCpaMicros');
  }
  if (
    b.biddingInfo?.targetRoas !== undefined &&
    (!['TARGET_ROAS', 'MAXIMIZE_CONVERSION_VALUE'].includes(b.biddingInfo.biddingStrategyType) ||
      !(b.biddingInfo.targetRoas > 0))
  )
    invalid('biddingInfo.targetRoas', 'Use a positive native ROAS ratio with a compatible bidding strategy.');
  if (b.biddingInfo?.targetImpressionShareInfo?.maxCpcBidCeiling !== undefined)
    positiveMicros(b.biddingInfo.targetImpressionShareInfo.maxCpcBidCeiling, 'maxCpcBidCeiling');
  for (const key of ['campaignSitelinkCount', 'campaignCallAssetCount', 'campaignImageAssetCount'])
    if (b[key] !== undefined && (!Number.isSafeInteger(b[key]) || b[key] < 0))
      invalid(key, 'Supply a nonnegative integer count.');
}
export function assertGoogleGenerationScope(p: CompiledRequest, c: Connection) {
  if (googleGenerationKind(p) && !c.scopes.includes('https://www.googleapis.com/auth/adwords'))
    throw new MirrorError(
      'INSUFFICIENT_SCOPE',
      'Google generation requires the Ads OAuth scope on the selected connection.',
      {},
      403,
    );
}
export function googleGenerationPlan(p: CompiledRequest): CompiledRequest {
  if (!googleGenerationKind(p)) return p;
  validateGoogleGeneration(p);
  return {
    ...p,
    warnings: [
      ...p.warnings,
      'Generation returns draft content or recommendations; it does not save assets, apply changes or approve advertising claims. Text/image generation requires Google closed-beta eligibility.',
    ],
  };
}
export function googleGenerationResult(p: CompiledRequest, data: unknown): JsonObject | undefined {
  const kind = googleGenerationKind(p);
  if (!kind) return;
  const key = kind === 'text' ? 'generatedText' : kind === 'images' ? 'generatedImages' : 'recommendations',
    input = googleJson(p.body);
  function fail(): never {
    throw new MirrorError(
      'UPSTREAM_RESPONSE_INVALID',
      'Google returned an invalid generation result.',
      {result_field: key},
      502,
    );
  }
  if (!object(data) || Object.keys(data).some(k => k !== key) || (data[key] !== undefined && !Array.isArray(data[key])))
    fail();
  const rows = data[key] ?? [];
  if (rows.length > 1000) fail();
  for (const row of rows) {
    if (!object(row)) fail();
    if (kind === 'recommendations') {
      if (!input.recommendationTypes.includes(row.type) || !object(row[recommendationFields[row.type]!])) fail();
    } else {
      if (
        !(kind === 'text' ? textFields : imageFields).includes(row.assetFieldType) ||
        (input.assetFieldTypes?.length && !input.assetFieldTypes.includes(row.assetFieldType))
      )
        fail();
      if (kind === 'text' && (typeof row.text !== 'string' || !row.text.trim())) fail();
      if (kind === 'images') {
        try {
          publicUrl(row.imageTemporaryUrl, 'imageTemporaryUrl');
          if (new URL(row.imageTemporaryUrl).protocol !== 'https:') fail();
        } catch {
          fail();
        }
      }
    }
  }
  const missing =
    kind === 'recommendations'
      ? input.recommendationTypes.filter((t: string) => !rows.some((r: JsonObject) => r.type === t))
      : [];
  return {
    kind,
    status: rows.length ? 'generated' : 'no_output',
    count: rows.length,
    provider_mutations: false,
    assets_saved: false,
    changes_applied: false,
    ...(kind === 'recommendations'
      ? {
          types_without_output: missing,
          empty_result_meaning:
            'No result can mean insufficient evidence or an already recommended state; it does not prove the plan is optimal.',
          money_units: 'Native micros; ROAS is a native ratio. No budget is changed.',
        }
      : {
          eligibility: 'Google closed beta; account access is not established by local tests.',
          ...(kind === 'images'
            ? {
                temporary_urls: true,
                images_downloaded: false,
                expiration: 'Provider controlled; no retention duration is assumed.',
              }
            : {}),
        }),
    next_action:
      kind === 'recommendations'
        ? 'Review the evidence and business constraints. Any application requires a separate reviewed mutation.'
        : 'Review generated claims and content. Save and link selected content through separate reviewed asset/ad operations.',
  };
}
