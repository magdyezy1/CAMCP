import {microsoftEvidence} from './microsoft-evidence.js';
import {
  microsoftAssociationContracts,
  microsoftAssociationWrite,
  assertMicrosoftAssociation,
  microsoftAssociationSnapshots,
  validateMicrosoftAssociations,
  extensionTypes,
} from './microsoft-associations.js';
import type {Action, CompiledRequest, Connection, JsonObject, ToolDefinition} from './types.js';
import type {TransportResult} from './transport.js';
import {MirrorError} from './errors.js';
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
    'Microsoft Advertising (Bing Ads) v13 JSON API. Discover LIST_ACTIONS / DESCRIBE_ACTION; provide account_id and native PascalCase payload. Reads include campaign hierarchy, budgets and account-bound asynchronous reporting. Use amcp_write for reviewed Add/Update/Delete Search campaigns, their ad groups, responsive search ads and keywords. New serving entities must be Paused. campaign_id supplies parent context for ads, keywords and ad-group extension associations. Set/DeleteAdExtensionsAssociations links existing extensions to the account or Search hierarchy; provide discovered ad_extension_types. Linking can activate serving. Money is decimal account currency, not Google micros. Independent AMCP extension; live qualification requires your own developer token and OAuth connection.',
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
function fail(message: string, details: JsonObject = {}): never {
  throw new MirrorError('INVALID_MICROSOFT_REQUEST', message, details);
}
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
  }
  if (b.AdGroupId && !plan.scopeContext?.campaignId)
    fail('Ad and keyword write reviews need campaign_id to read the exact parent ad group.');
}
export function microsoftSnapshots(plan: CompiledRequest): CompiledRequest[] {
  if (microsoftAssociationWrite(plan)) return microsoftAssociationSnapshots(plan, compileMicrosoft);
  const c = microsoftContracts.get(plan.action)!,
    b = plan.body as JsonObject,
    read = (action: string, payload: JsonObject) =>
      compileMicrosoft({
        action,
        account_id: plan.accountId,
        payload: {...payload, ...(action === 'GetCampaignsByIds' ? {CampaignType: 'Search'} : {})},
      });
  const reads = [read('GetAccount', {})];
  if (b.CampaignId) reads.push(read('GetCampaignsByIds', {CampaignIds: [b.CampaignId]}));
  if (b.AdGroupId) {
    reads.push(read('GetCampaignsByIds', {CampaignIds: [plan.scopeContext!.campaignId]}));
    reads.push(read('GetAdGroupsByIds', {CampaignId: plan.scopeContext!.campaignId, AdGroupIds: [b.AdGroupId]}));
  }
  if (plan.method !== 'POST') {
    const idsKey = c.kind!.slice(0, -1) + 'Ids',
      targetIds = plan.method === 'DELETE' ? b[idsKey] : b[c.kind!].map((r: JsonObject) => r.Id);
    reads.push(
      read('Get' + c.kind + 'ByIds', {
        [c.parent!]: b[c.parent!],
        [idsKey]: targetIds,
        ...(c.kind === 'Ads' ? {AdTypes: ['ResponsiveSearch']} : {}),
      }),
    );
  }
  const budgetIds = [
    ...new Set((b.Campaigns ?? []).filter((r: JsonObject) => r.BudgetId).map((r: JsonObject) => r.BudgetId)),
  ];
  if (budgetIds.length) reads.push(read('GetBudgetsByIds', {BudgetIds: budgetIds}));
  return reads;
}
export function validateMicrosoftResponse(plan: CompiledRequest, result: TransportResult, state = false) {
  const c = microsoftContracts.get(plan.action);
  if (!c) return;
  const d = result.data;
  if (
    !object(d) ||
    ['Errors', 'OperationErrors', 'PartialErrors'].some(
      key =>
        d[key] !== undefined &&
        d[key] !== null &&
        (!Array.isArray(d[key]) ||
          (key === 'PartialErrors' ? d[key].some((error: unknown) => error !== null) : d[key].length > 0)),
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
