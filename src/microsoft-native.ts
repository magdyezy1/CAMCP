import type {ReviewedFamily} from './reviewed-family.js';
import {microsoftEvidence} from './microsoft-evidence.js';
// Read below while this module is evaluated: the data comes from a leaf, not from the family module that imports this
// one (ARC-04).
import {microsoftAssociationContracts} from './microsoft-association-contracts.js';
import {
  microsoftAssociationWrite,
  assertMicrosoftAssociation,
  microsoftAssociationSnapshots,
  validateMicrosoftAssociations,
  extensionTypes,
} from './microsoft-associations.js';
import {
  microsoftCriterionContracts,
  microsoftCriterionWrite,
  assertMicrosoftCriteria,
  microsoftCriterionSnapshots,
  validateMicrosoftCriteria,
  positiveLocation,
  locationCriteriaPayload,
} from './microsoft-campaign-criteria.js';
import type {Action, CompiledRequest, Connection, DeclaredOperation, JsonObject, ToolDefinition} from './types.js';
import type {TransportResult} from './transport.js';
import {MirrorError} from './errors.js';
import {defineFamily, familyCodeError, type OneCodeRefusal} from './family-kit.js';
import {guardInput, stable} from './security.js';

export const microsoftGateway = 'microsoft_ads_native_action';
export const microsoftScope = 'https://ads.microsoft.com/msads.manage';
export const microsoftOrigin = 'https://campaign.api.bingads.microsoft.com';
export const microsoftCustomerOrigin = 'https://clientcenter.api.bingads.microsoft.com';
export const microsoftReportOrigin = 'https://reporting.api.bingads.microsoft.com';
const base = '/CampaignManagement/v13/';
type Contract = {
  name: string;
  method: string;
  path: string;
  fields: string[];
  required: string[];
  result: string;
  kind?: string;
  parent?: string;
  origin?: string;
  doc?: string;
};
const contracts: Contract[] = [
  {
    name: 'GetAccount',
    method: 'POST',
    path: '/CustomerManagement/v13/Account/Query',
    origin: microsoftCustomerOrigin,
    fields: ['AccountId', 'ReturnAdditionalFields'],
    required: ['AccountId'],
    result: 'Account',
    doc: 'customer-management-service',
  },
];
for (const [kind, parent] of [
  ['Campaigns', 'AccountId'],
  ['AdGroups', 'CampaignId'],
  ['Ads', 'AdGroupId'],
  ['Keywords', 'AdGroupId'],
] as const) {
  const ids = kind!.slice(0, -1) + 'Ids',
    extra = kind === 'Campaigns' ? ['CampaignType'] : kind === 'Ads' ? ['AdTypes'] : [];
  contracts.push({
    name: 'Get' + kind + 'By' + parent,
    method: 'POST',
    path: base + kind + '/QueryBy' + parent,
    fields: [parent!, ...extra, 'ReturnAdditionalFields'],
    required: [parent!, ...(kind === 'Ads' ? ['AdTypes'] : [])],
    result: kind!,
    kind,
    parent,
  });
  contracts.push({
    name: 'Get' + kind + 'ByIds',
    method: 'POST',
    path: base + kind + '/QueryByIds',
    fields: [parent!, ids, ...extra, 'ReturnAdditionalFields'],
    required: [parent!, ids, ...(kind === 'Ads' ? ['AdTypes'] : [])],
    result: kind!,
    kind,
    parent,
  });
  for (const [verb, method] of [
    ['Add', 'POST'],
    ['Update', 'PUT'],
    ['Delete', 'DELETE'],
  ] as const)
    contracts.push({
      name: verb + kind,
      method: method!,
      path: base + kind,
      fields: [parent!, verb === 'Delete' ? ids : kind!],
      required: [parent!, verb === 'Delete' ? ids : kind!],
      result: verb === 'Add' ? ids : 'PartialErrors',
      kind,
      parent,
    });
}
contracts.push(
  ...microsoftAssociationContracts,
  // Campaign location criteria (CMP-03): their own reviewed family, src/microsoft-campaign-criteria.ts.
  ...microsoftCriterionContracts(),
  {
    name: 'GetBudgetsByIds',
    method: 'POST',
    path: base + 'Budgets/QueryByIds',
    fields: ['BudgetIds'],
    required: [],
    result: 'Budgets',
    kind: 'Budgets',
  },
  {
    name: 'SubmitGenerateReport',
    method: 'POST',
    path: '/Reporting/v13/GenerateReport/Submit',
    origin: microsoftReportOrigin,
    fields: ['ReportRequest'],
    required: ['ReportRequest'],
    result: 'ReportRequestId',
    doc: 'reporting-service',
  },
  {
    name: 'PollGenerateReport',
    method: 'POST',
    path: '/Reporting/v13/GenerateReport/Poll',
    origin: microsoftReportOrigin,
    fields: ['ReportRequestId'],
    required: ['ReportRequestId'],
    result: 'ReportRequestStatus',
    doc: 'reporting-service',
  },
);
export const microsoftContracts = new Map(contracts.map(c => [c.name, c]));
/**
 * GetGeoLocationsFileUrl (CMP-03): the URL of Microsoft's geographical locations file, which the location lookup reads
 * (src/microsoft-locations.ts) and this gateway never sends. It is not one of `contracts`: AMCP sends a Microsoft request
 * only as its pinned REST page documents it, and this page is an optional pin that tools/microsoft-rest.mjs records when
 * the owner runs it. Until then the lookup refuses before anything is sent.
 */
export const microsoftGeoLocationsContract = Object.freeze({
  name: 'GetGeoLocationsFileUrl',
  method: 'POST',
  path: base + 'GeoLocationsFileUrl/Query',
  fields: Object.freeze(['Version', 'LanguageLocale', 'CompressionType']),
  result: 'FileUrl',
  page: 'https://learn.microsoft.com/en-us/advertising/campaign-management-service/getgeolocationsfileurl?view=bingads-13',
});
/** A Search campaign-management write (Add, Update or Delete) at the exact route of its contract. */
export function microsoftSearchKind(p: CompiledRequest): boolean {
  if (p.gateway !== microsoftGateway) return false;
  const c = microsoftContracts.get(p.action);
  return (
    !!c &&
    c.path === p.path &&
    c.method === p.method &&
    !microsoftAssociationWrite(p) &&
    !microsoftCriterionWrite(p) &&
    /^(Add|Update|Delete)/.test(c.name)
  );
}
export const microsoftActions: Action[] = contracts.map(c => ({
  name: c.name,
  canonical_name: c.name,
  aliases: [],
  method: c.method,
  path: (c.origin ?? microsoftOrigin) + c.path,
  read_only: /^(Get|Poll|Submit)/.test(c.name),
  destructive: c.method === 'DELETE',
  required: c.required,
  path_parameters: [],
  gateway: microsoftGateway,
  evidence: 'INDEPENDENT_MICROSOFT_V13_EXTENSION',
  raw: {
    name: c.name,
    method: c.method,
    path: c.path,
    read_only: /^(Get|Poll|Submit)/.test(c.name),
    required_fields: c.required,
    payload_fields: c.fields,
    source:
      'https://learn.microsoft.com/en-us/advertising/' +
      (c.doc ?? 'campaign-management-service') +
      '/' +
      c.name.toLowerCase() +
      '?view=bingads-13',
  },
}));
export const microsoftTool: ToolDefinition = {
  name: microsoftGateway,
  mode: 'direct',
  schema_evidence: 'INDEPENDENT_MICROSOFT_V13_EXTENSION',
  description:
    // tools/list of a writes deployment must stay within 95 KB (tests/first-party-contracts.test.mjs): the location-criterion
    // rules live in the guide (amcp://guides/microsoft-ads) and the refusals' remedies, not here.
    'Microsoft Advertising (Bing Ads) v13 JSON API. Discover LIST_ACTIONS / DESCRIBE_ACTION; provide account_id and native PascalCase payload. Reads include campaign hierarchy, budgets and account-bound async reports. Use amcp_write for reviewed Add/Update/Delete Search campaigns, ad groups, responsive search ads, keywords and campaign location targets. New serving entities must be Paused. campaign_id supplies parent context for ads, keywords and ad-group extension associations. Set/DeleteAdExtensionsAssociations links existing extensions to the account or Search hierarchy; provide discovered ad_extension_types. Linking can activate serving. Money is decimal account currency, not Google micros. Independent AMCP extension; live use requires your own developer token and OAuth connection.',
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: {type: 'string'},
      account_id: {type: 'string', pattern: '^[1-9][0-9]*$'},
      campaign_id: {type: 'string', pattern: '^[1-9][0-9]*$'},
      ad_extension_types: {
        type: 'array',
        minItems: 1,
        maxItems: 16,
        uniqueItems: true,
        items: {type: 'string'},
        description:
          'Native extension type names from discovery; review metadata only, never sent in the mutation body.',
      },
      connection_id: {type: 'string'},
      payload: {type: 'object'},
      download_report: {
        type: 'boolean',
        description:
          'On PollGenerateReport, securely download and parse Csv/Tsv rows on the server; offset/limit page the stored result.',
      },
      dry_run: {type: 'boolean'},
      search: {type: 'string'},
      target_action: {type: 'string'},
      limit: {type: 'integer', minimum: 1, maximum: 100},
      offset: {type: 'integer', minimum: 0},
      read_only: {type: 'boolean'},
    },
    additionalProperties: false,
  },
  help: {
    qualification:
      'Independent Microsoft Advertising v13 implementation; local contract tests do not establish vendor approval.',
    money: 'Decimal account currency units',
    guidance_uri: 'amcp://guides/microsoft-ads',
  },
};
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const fail: OneCodeRefusal = familyCodeError('INVALID_MICROSOFT_REQUEST');
function id(v: unknown, key: string) {
  if (typeof v !== 'string' || !/^[1-9][0-9]*$/.test(v) || v.length > 19 || BigInt(v) > 9223372036854775807n)
    fail(key + ' must be a positive signed 64-bit decimal ID supplied as a string.');
}
function ids(v: unknown, key: string) {
  if (!Array.isArray(v) || !v.length || v.length > 100) fail(key + ' needs 1–100 IDs.');
  v.forEach(x => id(x, key));
  if (new Set(v).size !== v.length) fail(key + ' must not contain duplicate IDs.');
}
export function compileMicrosoft(input: JsonObject): CompiledRequest {
  guardInput(input);
  const c = microsoftContracts.get(input.action);
  if (!c) throw new MirrorError('UNKNOWN_ACTION', 'Unknown Microsoft action. Use LIST_ACTIONS.');
  id(input.account_id, 'account_id');
  if (
    input.download_report !== undefined &&
    (typeof input.download_report !== 'boolean' || c.name !== 'PollGenerateReport')
  )
    fail('download_report is supported only on PollGenerateReport.');
  if (
    input.download_report === true &&
    (!Number.isInteger(input.offset ?? 0) ||
      (input.offset ?? 0) < 0 ||
      !Number.isInteger(input.limit ?? 100) ||
      (input.limit ?? 100) < 1 ||
      (input.limit ?? 100) > 100)
  )
    fail('Report pages require a nonnegative offset and limit 1–100.');
  const body = structuredClone(input.payload ?? {});
  if (!object(body)) fail('payload must be a native JSON object.');
  if (c.fields.includes('AccountId')) body.AccountId ??= input.account_id;
  for (const k of Object.keys(body))
    if (!c.fields.includes(k)) fail('Unsupported top-level payload field: ' + k, {allowed: c.fields});
  for (const k of c.required) if (body[k] === undefined || body[k] === null) fail('Missing ' + k);
  if (body.AccountId !== undefined && body.AccountId !== input.account_id)
    throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'AccountId must match account_id.', {}, 403);
  for (const [k, v] of Object.entries(body)) {
    if (['AccountId', 'CampaignId', 'AdGroupId'].includes(k)) id(v, k);
    if (/Ids$/.test(k) && k !== 'ReportRequestId' && v !== null) ids(v, k);
  }
  if (input.campaign_id !== undefined) id(input.campaign_id, 'campaign_id');
  if (input.ad_extension_types !== undefined) {
    if (
      !Array.isArray(input.ad_extension_types) ||
      !input.ad_extension_types.length ||
      input.ad_extension_types.some((x: unknown) => typeof x !== 'string')
    )
      fail('ad_extension_types must be discovered native type names.');
    extensionTypes(input.ad_extension_types.join(' '));
    if (!['SetAdExtensionsAssociations', 'DeleteAdExtensionsAssociations'].includes(c.name))
      fail('ad_extension_types is review context for association writes only.');
  }
  if (body.AdExtensionType !== undefined) extensionTypes(body.AdExtensionType);
  if (body.AssociationType !== undefined && !['Account', 'Campaign', 'AdGroup'].includes(body.AssociationType))
    fail('Use one native AssociationType.');
  if (body.CampaignId && input.campaign_id && body.CampaignId !== input.campaign_id)
    fail('campaign_id conflicts with payload.CampaignId.');
  if (
    body.AdTypes !== undefined &&
    (!Array.isArray(body.AdTypes) ||
      !body.AdTypes.length ||
      body.AdTypes.some((x: unknown) => typeof x !== 'string' || !x))
  )
    fail('AdTypes must contain native ad type strings.');
  if (c.name === 'SubmitGenerateReport') {
    const r = body.ReportRequest;
    if (
      !object(r) ||
      !['Account', 'Campaign', 'AdGroup', 'Ad', 'Keyword', 'SearchQuery'].some(
        t => r.Type === t + 'PerformanceReportRequest',
      )
    )
      fail('Choose an account, campaign, ad group, ad, keyword or search query performance report.');
    if (!object(r.Scope) || stable(r.Scope) !== stable({AccountIds: [input.account_id]}))
      fail('Report Scope must be exactly {AccountIds:[account_id]}; cross-account reports are not allowed.');
    if (
      !Array.isArray(r.Columns) ||
      !r.Columns.length ||
      r.Columns.length > 100 ||
      new Set(r.Columns).size !== r.Columns.length ||
      r.Columns.some((x: unknown) => typeof x !== 'string' || !x) ||
      !object(r.Time) ||
      (!r.Time.PredefinedTime && (!r.Time.CustomDateRangeStart || !r.Time.CustomDateRangeEnd))
    )
      fail('Reports require Columns and an explicit Time range.');
    if (
      !['Summary', 'Daily', 'Weekly', 'Monthly', 'Yearly', 'Hourly', 'HourOfDay', 'DayOfWeek'].includes(r.Aggregation)
    )
      fail('Select a native report Aggregation.');
    if (r.Format !== undefined && !['Csv', 'Tsv', 'Xml'].includes(r.Format))
      fail('Report Format must be Csv, Tsv or Xml.');
  }
  if (
    c.name === 'PollGenerateReport' &&
    (typeof body.ReportRequestId !== 'string' || !body.ReportRequestId || body.ReportRequestId.length > 40)
  )
    fail('ReportRequestId must be the provider-issued ID.');
  return {
    gateway: microsoftGateway,
    action: c.name,
    method: c.method,
    path: c.path,
    origin: c.origin ?? microsoftOrigin,
    query: {},
    body,
    headers: {},
    readOnly: /^(Get|Poll|Submit)/.test(c.name),
    destructive: c.method === 'DELETE',
    requiresConfirmation: /^(Add|Update|Delete|Set)/.test(c.name),
    accountId: input.account_id,
    evidence: 'INDEPENDENT_MICROSOFT_V13_EXTENSION',
    contractEvidence: microsoftEvidence(c.name, c.fields, {
      method: c.method,
      url: (c.origin ?? microsoftOrigin) + c.path,
    }),
    warnings: [
      'Microsoft amounts are decimal account-currency units. Provider approval and live contract acceptance remain required.',
    ],
    ...(input.campaign_id || input.ad_extension_types
      ? {
          scopeContext: {
            ...(input.campaign_id ? {campaignId: input.campaign_id} : {}),
            ...(input.ad_extension_types ? {microsoftExtensionTypes: [...input.ad_extension_types].sort()} : {}),
          },
        }
      : {}),
    ...(input.download_report ? {reportDownload: {offset: input.offset ?? 0, limit: input.limit ?? 100}} : {}),
  };
}
/** Read classification comes from the independent exact method + path contract. */
export function microsoftRead(plan: CompiledRequest) {
  const c = microsoftContracts.get(plan.action);
  return (
    !!c &&
    /^(Get|Poll|Submit)/.test(c.name) &&
    plan.method === c.method &&
    plan.path === c.path &&
    plan.origin === (c.origin ?? microsoftOrigin)
  );
}
export function microsoftCustomer(connection: Connection, accountId: string) {
  const customer = connection.accountCustomers?.[accountId];
  if (!customer || !/^[1-9][0-9]*$/.test(customer))
    throw new MirrorError(
      'MICROSOFT_CUSTOMER_REQUIRED',
      'Sync and select the Microsoft account to bind its verified parent CustomerId.',
      {},
      403,
    );
  return customer;
}
export function assertMicrosoftWrite(plan: CompiledRequest) {
  if (microsoftAssociationWrite(plan)) {
    assertMicrosoftAssociation(plan);
    return;
  }
  if (microsoftCriterionWrite(plan)) {
    const c = microsoftContracts.get(plan.action);
    if (!c || plan.path !== c.path || plan.method !== c.method)
      throw new MirrorError('WRITE_CONTRACT_UNAVAILABLE', 'This Microsoft operation has no reviewed write contract.');
    assertMicrosoftCriteria(plan);
    return;
  }
  const c = microsoftContracts.get(plan.action);
  if (!c || !/^(Add|Update|Delete)/.test(c.name) || plan.path !== c.path || plan.method !== c.method)
    throw new MirrorError('WRITE_CONTRACT_UNAVAILABLE', 'This Microsoft operation has no reviewed write contract.');
  const b = plan.body as JsonObject,
    rows = b[c.kind!];
  if (plan.method !== 'DELETE') {
    if (!Array.isArray(rows) || !rows.length || rows.length > 25 || rows.some(r => !object(r)))
      fail('Reviewed Microsoft writes require 1–25 native records.');
    for (const r of rows) {
      if (plan.method === 'POST') {
        if (r.Id !== undefined) fail('New resources must not supply Id.');
        if (r.Status !== 'Paused')
          throw new MirrorError('PAUSED_CREATION_REQUIRED', 'New Microsoft entities require Status: Paused.');
      } else id(r.Id, 'Id');
      if (
        plan.method === 'POST' &&
        ['Campaigns', 'AdGroups'].includes(c.kind!) &&
        (typeof r.Name !== 'string' || !r.Name.trim())
      )
        fail('New campaigns and ad groups require Name.');
      if (c.kind === 'Campaigns') {
        if (r.CampaignType !== undefined && r.CampaignType !== 'Search')
          fail(
            'Reviewed campaign writes currently support Search campaigns. Other campaign types need a qualified state-read contract.',
          );
        if (r.BudgetId !== undefined) id(r.BudgetId, 'BudgetId');
        if (
          r.DailyBudget !== undefined &&
          (typeof r.DailyBudget !== 'number' || !Number.isFinite(r.DailyBudget) || r.DailyBudget <= 0)
        )
          fail('DailyBudget must be positive and use decimal account currency.');
        if (plan.method === 'POST' && !r.BudgetId && r.DailyBudget === undefined)
          fail('A new campaign needs positive DailyBudget in account currency or an existing BudgetId.');
      }
      if (c.kind === 'Ads' && (plan.method === 'POST' || r.Type !== undefined) && r.Type !== 'ResponsiveSearch')
        fail('Reviewed ad writes currently support ResponsiveSearch ads. Other ad formats need a qualified contract.');
      if (
        c.kind === 'Keywords' &&
        plan.method === 'POST' &&
        (typeof r.Text !== 'string' || !r.Text.trim() || !['Exact', 'Phrase', 'Broad'].includes(r.MatchType))
      )
        fail('New keywords require Text and MatchType Exact, Phrase or Broad.');
      if (r.BiddingScheme && ['TargetCpaBiddingScheme', 'TargetRoasBiddingScheme'].includes(r.BiddingScheme.Type))
        fail(
          'Use MaxConversionsBiddingScheme or MaxConversionValueBiddingScheme with its target; standalone Target CPA/ROAS schemes are deprecated.',
        );
    }
    if (plan.method === 'PUT' && new Set(rows.map(r => r.Id)).size !== rows.length)
      fail('Each updated resource ID must be unique.');
    // Owner decision P7 (CMP-03): a campaign activation is refused without a positive location criterion. The review
    // reads each activated campaign's location criteria (microsoftSnapshots) and microsoftLocationGuard decides.
  }
  if (b.AdGroupId && !plan.scopeContext?.campaignId)
    fail('Ad and keyword write reviews need campaign_id to read the exact parent ad group.');
}
/**
 * What Microsoft returns only when ReturnAdditionalFields names it (CampaignAdditionalField, AdGroupAdditionalField,
 * AdAdditionalField and KeywordAdditionalField in the pinned v13 WSDL), for the kinds the reviewed family writes:
 * top-level record fields, Settings entries by their Type, and bidding schemes by their Type. A written record that
 * sets one asks for it on read-back, so verification compares it instead of ending inconclusive.
 */
export const microsoftAdditionalFields: Record<string, {fields: string[]; settings?: string[]; schemes?: string[]}> = {
  Campaigns: {
    fields: ['AdScheduleUseSearcherTimeZone', 'BidStrategyId', 'MultimediaAdsBidAdjustment'],
    settings: [
      'TargetSetting',
      'VerifiedTrackingSetting',
      'DynamicDescriptionSetting',
      'DisclaimerSetting',
      'ResponsiveSearchAdsSetting',
      'CallToActionSetting',
    ],
    schemes: ['MaxConversionValueBiddingScheme', 'TargetImpressionShareBiddingScheme', 'CpvCpmBiddingScheme'],
  },
  AdGroups: {
    fields: [
      'AdScheduleUseSearcherTimeZone',
      'AdGroupType',
      'CpvBid',
      'CpmBid',
      'MultimediaAdsBidAdjustment',
      'UseOptimizedTargeting',
      'FrequencyCapSettings',
      'UsePredictiveTargeting',
    ],
  },
  Ads: {fields: ['ImpressionTrackingUrls', 'LongHeadlines', 'AdSubType']},
  Keywords: {fields: []},
};
/** The ReturnAdditionalFields values a written record needs on read-back (empty when the default read shows it all). */
export function microsoftReturnFields(kind: string, written: JsonObject): string[] {
  const table = microsoftAdditionalFields[kind];
  if (!table || !object(written)) return [];
  const scheme = object(written.BiddingScheme) ? written.BiddingScheme : {},
    settings = Array.isArray(written.Settings) ? written.Settings.filter(object).map(s => s.Type) : [];
  return [
    ...new Set([
      ...table.fields.filter(f => written[f] !== undefined),
      ...(table.settings ?? []).filter(t => settings.includes(t)),
      ...(table.schemes ?? []).filter(t => scheme.Type === t),
      // MaxConversionsBiddingScheme.TargetCpa is returned only when TargetCpaInMaxConversion is requested.
      ...(kind === 'Campaigns' && scheme.Type === 'MaxConversionsBiddingScheme' && scheme.TargetCpa !== undefined
        ? ['TargetCpaInMaxConversion']
        : []),
    ]),
  ];
}
/**
 * One Get{Kind}ByIds payload (PRV-03), shared by the review snapshot and the verification read so neither can omit a
 * field the contract requires: the parent (AccountId comes from account_id), the IDs, CampaignType Search for
 * campaigns and AdTypes ResponsiveSearch for ads (the only ad type the family writes). `written` adds the
 * ReturnAdditionalFields that record needs, comma-separated as the JSON API carries a flags value.
 */
export function getByIdsPayload(kind: string, parent: unknown, ids: unknown[], written?: JsonObject): JsonObject {
  const c = microsoftContracts.get('Get' + kind + 'ByIds');
  if (!c?.parent) fail('No Get' + kind + 'ByIds contract is qualified.');
  const extra = written ? microsoftReturnFields(kind, written) : [];
  return {
    ...(c.parent !== 'AccountId' ? {[c.parent]: parent} : {}),
    [kind.slice(0, -1) + 'Ids']: ids,
    ...(kind === 'Campaigns' ? {CampaignType: 'Search'} : kind === 'Ads' ? {AdTypes: ['ResponsiveSearch']} : {}),
    ...(extra.length ? {ReturnAdditionalFields: extra.join(',')} : {}),
  };
}
/** The campaigns an UpdateCampaigns request sets Active (owner decision P7 reads their location criteria first). */
function activatedCampaigns(plan: CompiledRequest): string[] {
  const b = plan.body as JsonObject;
  return plan.action === 'UpdateCampaigns' && Array.isArray(b?.Campaigns)
    ? b.Campaigns.filter((r: unknown) => object(r) && r.Status === 'Active').map((r: JsonObject) => r.Id)
    : [];
}
/**
 * Owner decision P7 (CMP-03): without location targets Microsoft can serve a campaign in any location it supports, so a
 * campaign is activated only when the review's read of its location criteria (taken at prepare and again at execute)
 * holds a positive one. Runs before anything is sent; the remedy adds one with AddCampaignCriterions.
 */
export function microsoftLocationGuard(plan: CompiledRequest, state: unknown[], reads: CompiledRequest[]): void {
  const missing = activatedCampaigns(plan).filter(campaign => {
    const at = reads.findIndex(
        r => r.action === 'GetCampaignCriterionsByIds' && (r.body as JsonObject)?.CampaignId === campaign,
      ),
      rows = at < 0 ? undefined : (state[at] as JsonObject | undefined)?.CampaignCriterions;
    return !Array.isArray(rows) || !rows.some(r => positiveLocation(r, campaign));
  });
  if (missing.length)
    throw new MirrorError(
      'LOCATION_CRITERIA_REQUIRED',
      'AMCP activates a Microsoft campaign only with a positive location criterion, because without location targets Microsoft can serve its ads in any location it supports. Add the campaign’s target locations while it is paused, then prepare the activation again.',
      {campaign_ids: missing, owner_decision: 'P7'},
      409,
    );
}
export function microsoftSnapshots(plan: CompiledRequest): CompiledRequest[] {
  if (microsoftAssociationWrite(plan)) return microsoftAssociationSnapshots(plan, compileMicrosoft);
  if (microsoftCriterionWrite(plan)) return microsoftCriterionSnapshots(plan);
  const c = microsoftContracts.get(plan.action)!,
    b = plan.body as JsonObject,
    read = (action: string, payload: JsonObject) => compileMicrosoft({action, account_id: plan.accountId, payload});
  const reads = [read('GetAccount', {})];
  if (b.CampaignId) reads.push(read('GetCampaignsByIds', getByIdsPayload('Campaigns', undefined, [b.CampaignId])));
  if (b.AdGroupId) {
    reads.push(read('GetCampaignsByIds', getByIdsPayload('Campaigns', undefined, [plan.scopeContext!.campaignId])));
    reads.push(read('GetAdGroupsByIds', getByIdsPayload('AdGroups', plan.scopeContext!.campaignId, [b.AdGroupId])));
  }
  if (plan.method !== 'POST') {
    const idsKey = c.kind!.slice(0, -1) + 'Ids',
      targetIds = plan.method === 'DELETE' ? b[idsKey] : b[c.kind!].map((r: JsonObject) => r.Id);
    reads.push(read('Get' + c.kind + 'ByIds', getByIdsPayload(c.kind!, b[c.parent!], targetIds)));
  }
  const budgetIds = [
    ...new Set((b.Campaigns ?? []).filter((r: JsonObject) => r.BudgetId).map((r: JsonObject) => r.BudgetId)),
  ];
  if (budgetIds.length) reads.push(read('GetBudgetsByIds', {BudgetIds: budgetIds}));
  for (const campaign of activatedCampaigns(plan))
    reads.push(read('GetCampaignCriterionsByIds', locationCriteriaPayload(campaign)));
  return reads;
}
export function validateMicrosoftResponse(plan: CompiledRequest, result: TransportResult, state = false) {
  const c = microsoftContracts.get(plan.action);
  if (!c) return;
  const d = result.data;
  if (
    !object(d) ||
    // NestedPartialErrors (AddCampaignCriterions) lists the rows that failed, like PartialErrors: an empty list, or one of
    // null entries only, means nothing failed (Microsoft documents that neither list is aligned with the request).
    ['Errors', 'OperationErrors', 'PartialErrors', 'NestedPartialErrors'].some(
      key =>
        d[key] !== undefined &&
        d[key] !== null &&
        (!Array.isArray(d[key]) ||
          (key.endsWith('PartialErrors') ? d[key].some((error: unknown) => error !== null) : d[key].length > 0)),
    )
  )
    throw new MirrorError(
      'MICROSOFT_RESPONSE_FAILED',
      'Microsoft returned a failed, partial or malformed error result.',
      {upstream: d},
      502,
    );
  if (!plan.readOnly) return;
  const value = d[c.result];
  if (c.name === 'GetAdExtensionsAssociations') {
    validateMicrosoftAssociations(plan, d);
    return;
  }
  if (c.name === 'SubmitGenerateReport') {
    if (typeof value !== 'string' || !value || value.length > 40)
      throw new MirrorError('UPSTREAM_RESPONSE_INVALID', 'Microsoft did not return a usable ReportRequestId.', {}, 502);
    return;
  }
  if (c.name === 'PollGenerateReport') {
    if (!object(value) || !['Pending', 'Success', 'Error'].includes(value.Status))
      throw new MirrorError('UPSTREAM_RESPONSE_INVALID', 'Microsoft returned an invalid report status.', {}, 502);
    return;
  }
  if (c.result === 'Account') {
    if (!object(value) || String(value.Id) !== plan.accountId)
      throw new MirrorError('STATE_TARGET_MISMATCH', 'Microsoft returned a different account.', {}, 502);
    return;
  }
  // A campaign without location criteria may answer its whole-set read (no IDs asked) with null: an empty set.
  if (
    c.name === 'GetCampaignCriterionsByIds' &&
    value === null &&
    (plan.body as JsonObject).CampaignCriterionIds == null
  )
    return;
  if (
    !Array.isArray(value) ||
    value.some(v => v !== null && (!object(v) || typeof v.Id !== 'string' || !/^[1-9][0-9]*$/.test(v.Id)))
  )
    throw new MirrorError(
      'UPSTREAM_RESPONSE_INVALID',
      'Microsoft did not return the expected native entity list.',
      {},
      502,
    );
  if (c.name === 'GetCampaignCriterionsByIds') validateMicrosoftCriteria(plan, d);
  if (state && c.kind === 'Campaigns' && value.some(v => v?.CampaignType !== undefined && v.CampaignType !== 'Search'))
    throw new MirrorError(
      'STATE_TARGET_MISMATCH',
      'Only Search campaign state is qualified for Microsoft write reviews.',
      {},
      502,
    );
  const b = plan.body as JsonObject,
    idsKey = c.kind!.slice(0, -1) + 'Ids',
    expected = b[idsKey];
  if (
    state &&
    expected &&
    (value.some(v => v === null) || stable(value.map(v => v.Id).sort()) !== stable([...expected].sort()))
  )
    throw new MirrorError('STATE_TARGET_MISMATCH', 'Microsoft did not return every exact reviewed target.', {}, 502);
}
export function microsoftOutcome(plan: CompiledRequest, result: TransportResult) {
  const c = microsoftContracts.get(plan.action),
    d = result.data,
    b = plan.body as JsonObject;
  if (
    !c ||
    result.status !== 200 ||
    !object(d) ||
    !Object.hasOwn(d, 'PartialErrors') ||
    (d.PartialErrors !== null && !Array.isArray(d.PartialErrors)) ||
    d.PartialErrors?.some((error: unknown) => error !== null)
  )
    return false;
  if (plan.method === 'POST' && !microsoftAssociationWrite(plan))
    return (
      Array.isArray(d[c.result]) &&
      d[c.result].length === b[c.kind!].length &&
      d[c.result].every((v: unknown) => typeof v === 'string' && /^[1-9][0-9]*$/.test(v))
    );
  return true;
}

/** Reads each written campaign, ad group, ad or keyword back by ID. A deletion has no read that shows it. */
export function microsoftSearchVerification(
  plan: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  if (plan.method === 'DELETE') return [];
  const b = (plan.body ?? {}) as JsonObject,
    d = result.data ?? {};
  const contract = microsoftContracts.get(plan.action)!;
  if (!contract.kind) return [];
  const records = b[contract.kind] ?? [],
    ids = plan.action.startsWith('Add') ? d[contract.result] : records.map((r: JsonObject) => r.Id);
  return ids.map((id: string, i: number) => ({
    read: compileMicrosoft({
      action: 'Get' + contract.kind + 'ByIds',
      account_id: plan.accountId,
      payload: getByIdsPayload(contract.kind!, b[contract.parent!], [id], records[i]),
    }),
    expected: records[i],
    id,
  }));
}

/** What one row of each kind is called in the summary of an Add. */
const rowNames: Readonly<Record<string, string>> = Object.freeze({
  Campaigns: 'campaign',
  AdGroups: 'ad group',
  Ads: 'ad',
  Keywords: 'keyword',
});
/**
 * What a Search write does for the review's summary (R2.5 S2-1, owner 2026-11-15: the approver must read the real
 * operation). The Add, the Update and the Delete of a kind share one route and differ by method, which no path rule
 * reads, so every Add of the launch recipe read "Update 1 Campaigns", for one campaign or twenty. An Add creates every row
 * it lists under its kind's key. An Update or a Delete is left to the summary's own reading, as it always was.
 */
export function microsoftOperation(p: CompiledRequest): DeclaredOperation | undefined {
  const kind = microsoftContracts.get(p.action)?.kind,
    rows = object(p.body) && kind ? p.body[kind] : undefined;
  if (p.method !== 'POST' || !kind) return undefined;
  return {operation: 'create', entity: rowNames[kind], count: Array.isArray(rows) ? rows.length : undefined};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const microsoftSearchFamily: ReviewedFamily = defineFamily({
  name: 'microsoft_search',
  files: ['src/microsoft-native.ts', ['tests/microsoft.test.ts']],
  kind: microsoftSearchKind,
  operation: microsoftOperation,
  snapshots: microsoftSnapshots,
  prerequisites: microsoftLocationGuard,
  outcome: microsoftOutcome,
  verification: microsoftSearchVerification,
});
