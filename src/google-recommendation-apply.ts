import {googleJson, assertGoogleAdsScope} from './google-contracts.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {googleAdsCustomers} from './google-version.js';
import {fail} from './family-kit.js';

/**
 * Applying keyword and campaign budget recommendations, Google Ads API v23 (pinned Discovery document:
 * RecommendationService.ApplyRecommendation, ApplyRecommendationOperation with KeywordParameters and
 * CampaignBudgetParameters, and Recommendation with KeywordRecommendation and CampaignBudgetRecommendation; checked
 * 2026-09-27). "If partial_failure=false all recommendations should be of the same type"; a keyword recommendation
 * adds the recommended keyword (or the match type and ad group given, with an optional CPC bid), a campaign budget
 * recommendation sets the budget to the recommended amount or to newBudgetAmountMicros. Other recommendation types
 * change bidding, assets or campaign types and stay outside this contract.
 */
type Read = CompiledRequest & {
  googleApplyState?: {
    names: string[];
    budgets?: string[];
    adGroups?: string[];
    keywords?: {adGroup: string; text: string; matchType: string}[];
    optional?: boolean;
  };
};
const actions = ['APPLY_RECOMMENDATION', 'google_ads_v23_recommendation_apply_recommendation'],
  types = ['KEYWORD', 'CAMPAIGN_BUDGET'],
  matchTypes = ['EXACT', 'PHRASE', 'BROAD'],
  maxOperations = 20;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const micros = (v: unknown) => (typeof v === 'string' || typeof v === 'number') && /^[1-9][0-9]{0,17}$/.test(String(v));
function invalid(message: string): never {
  return fail('INVALID_GOOGLE_RECOMMENDATION_APPLY', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
const account = (p: CompiledRequest) => {
  const id = p.accountId?.replaceAll('-', '');
  if (!id || !/^\d+$/.test(id)) invalid('Select one Google Ads customer.');
  return id!;
};
export function googleApplyKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'google_ads_native_action' &&
    actions.includes(p.action) &&
    p.method === 'POST' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://googleads.googleapis.com') &&
    /^\/v\d+\/customers\/\d+\/recommendations:apply$/.test(p.path)
  );
}
const operations = (p: CompiledRequest) => (googleJson(p.body).operations ?? []) as JsonObject[];
const name = (p: CompiledRequest, v: unknown, collection: string, pattern = '[1-9][0-9]*') =>
  typeof v === 'string' && new RegExp('^customers/' + account(p) + '/' + collection + '/' + pattern + '$').test(v);
export function assertGoogleApply(p: CompiledRequest): void {
  if (!googleApplyKind(p)) return;
  if (p.path.split('/')[3] !== account(p))
    fail('ACCOUNT_SCOPE_MISMATCH', 'The path must use the selected customer.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Recommendation reviews take no query or header overrides.');
  const b = googleJson(p.body);
  if (!object(b) || Object.keys(b).some(k => !['operations', 'partialFailure'].includes(k)))
    invalid('Send {operations} only.');
  if (b.partialFailure !== undefined && b.partialFailure !== false)
    invalid('partialFailure must be false: every recommendation is applied, or none.');
  if (!Array.isArray(b.operations) || !b.operations.length || b.operations.length > maxOperations)
    invalid('Apply 1–' + maxOperations + ' recommendations of one type.');
  const seen = new Set<string>();
  for (const op of b.operations as unknown[]) {
    if (!object(op) || Object.keys(op).some(k => !['resourceName', 'keyword', 'campaignBudget'].includes(k)))
      invalid(
        'Each operation names a recommendation and optionally keyword or campaignBudget parameters; other recommendation types are outside this contract.',
      );
    if (!name(p, op.resourceName, 'recommendations', '[A-Za-z0-9_.~=-]{1,1024}'))
      invalid('resourceName is a recommendation of the selected customer.');
    if (seen.has(String(op.resourceName))) invalid('Each recommendation appears once.');
    seen.add(String(op.resourceName));
    if (op.keyword !== undefined && op.campaignBudget !== undefined)
      invalid('An operation carries parameters of one recommendation type.');
    if (op.keyword !== undefined) {
      const k = op.keyword;
      if (!object(k) || Object.keys(k).some(f => !['matchType', 'adGroup', 'cpcBidMicros'].includes(f)))
        invalid('keyword takes matchType, adGroup and cpcBidMicros.');
      if (!matchTypes.includes(k.matchType) || !name(p, k.adGroup, 'adGroups'))
        invalid('keyword parameters need matchType (EXACT, PHRASE or BROAD) and the adGroup of the selected customer.');
      if (k.cpcBidMicros !== undefined && !micros(k.cpcBidMicros))
        invalid('cpcBidMicros is a positive whole number of micros.');
    }
    if (op.campaignBudget !== undefined) {
      const c = op.campaignBudget;
      if (!object(c) || Object.keys(c).some(f => f !== 'newBudgetAmountMicros') || !micros(c.newBudgetAmountMicros))
        invalid('campaignBudget takes newBudgetAmountMicros, a positive whole number of micros.');
    }
  }
}
function search(p: CompiledRequest, query: string): Read {
  return {
    ...p,
    action: 'AMCP_GOOGLE_APPLY_READ',
    method: 'POST',
    path: googleAdsCustomers + account(p) + '/googleAds:search',
    body: {query},
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    googleApplyState: undefined,
  };
}
const quoted = (v: string) => "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const recommendationFields = [
  'resource_name',
  'type',
  'dismissed',
  'campaign',
  'ad_group',
  'campaign_budget',
  'keyword_recommendation.keyword.text',
  'keyword_recommendation.keyword.match_type',
  'keyword_recommendation.recommended_cpc_bid_micros',
  'campaign_budget_recommendation.recommended_budget_amount_micros',
  'campaign_budget_recommendation.current_budget_amount_micros',
].map(f => 'recommendation.' + f);
export function googleApplySnapshots(p: CompiledRequest): Read[] {
  const names = operations(p).map(op => String(op.resourceName));
  return [
    {
      ...search(
        p,
        'SELECT ' +
          recommendationFields.join(', ') +
          ' FROM recommendation WHERE recommendation.resource_name IN (' +
          names.map(quoted).join(', ') +
          ')',
      ),
      googleApplyState: {names},
    },
  ];
}
export function isGoogleApplyRead(p: CompiledRequest): p is Read {
  return p.gateway === 'google_ads_native_action' && !!(p as Read).googleApplyState;
}
async function rows(
  p: CompiledRequest,
  query: string,
  key: string,
  send: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<JsonObject[]> {
  const out: JsonObject[] = [];
  let token: string | undefined;
  const tokens = new Set<string>();
  for (let page = 0; ; page++) {
    if (page >= 5) unverified('A recommendation read has more pages than one review reads.');
    const q = search(p, query);
    if (token) (q.body as JsonObject).pageToken = token;
    const r = await send(q),
      d = r.data;
    if (r.status !== 200 || !object(d) || (d.results !== undefined && !Array.isArray(d.results)))
      unverified('Google Ads did not return the ' + key + ' rows.');
    for (const row of (d.results ?? []) as unknown[]) {
      if (!object(row) || !object(row[key])) unverified('A ' + key + ' row is malformed.');
      out.push(row[key] as JsonObject);
    }
    if (!d.nextPageToken) return out;
    if (typeof d.nextPageToken !== 'string' || tokens.has(d.nextPageToken)) unverified('Google Ads repeated a page.');
    tokens.add(d.nextPageToken);
    token = d.nextPageToken;
  }
}
const mstr = (v: unknown) => (v === undefined || v === null ? null : String(v));
/** The recommendations, their budgets and ad groups, and the keywords the application would add. */
export async function readGoogleApply(
  p: CompiledRequest,
  send: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).googleApplyState;
  if (!s) return send(p);
  if (!s.names.length) return check(p, s, send);
  const recs = await rows(p, String((p.body as JsonObject).query), 'recommendation', send),
    recommendations: JsonObject = {};
  for (const r of recs) {
    if (!s.names.includes(String(r.resourceName)) || Object.hasOwn(recommendations, String(r.resourceName)))
      unverified('Google Ads returned an unexpected recommendation.');
    const k = object(r.keywordRecommendation) ? r.keywordRecommendation : {},
      kw = object(k.keyword) ? k.keyword : {},
      b = object(r.campaignBudgetRecommendation) ? r.campaignBudgetRecommendation : {};
    recommendations[String(r.resourceName)] = {
      type: r.type ?? null,
      dismissed: r.dismissed === true,
      campaign: r.campaign ?? null,
      adGroup: r.adGroup ?? null,
      campaignBudget: r.campaignBudget ?? null,
      keyword:
        kw.text === undefined
          ? null
          : {
              text: String(kw.text),
              matchType: kw.matchType ?? null,
              recommendedCpcBidMicros: mstr(k.recommendedCpcBidMicros),
            },
      budget:
        b.recommendedBudgetAmountMicros === undefined
          ? null
          : {
              recommendedMicros: mstr(b.recommendedBudgetAmountMicros),
              currentMicros: mstr(b.currentBudgetAmountMicros),
            },
    };
  }
  const out: JsonObject = {customer: account(p), recommendations};
  if (s.optional) return {status: 200, headers: {}, data: out};
  const found = Object.values(recommendations) as JsonObject[];
  const budgetNames = [...new Set(found.map(r => r.campaignBudget).filter((v): v is string => typeof v === 'string'))];
  if (budgetNames.length) {
    const budgets: JsonObject = {};
    for (const b of await rows(
      p,
      'SELECT campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.status, campaign_budget.explicitly_shared, campaign_budget.period FROM campaign_budget WHERE campaign_budget.resource_name IN (' +
        budgetNames.map(quoted).join(', ') +
        ')',
      'campaignBudget',
      send,
    ))
      budgets[String(b.resourceName)] = {
        amountMicros: mstr(b.amountMicros),
        status: b.status ?? null,
        shared: b.explicitlyShared === true,
        period: b.period ?? null,
      };
    out.budgets = budgets;
  }
  const groupNames = [...new Set(found.map(r => r.adGroup).filter((v): v is string => typeof v === 'string'))];
  if (groupNames.length) {
    const groups: JsonObject = {};
    for (const g of await rows(
      p,
      'SELECT ad_group.resource_name, ad_group.status, ad_group.type, campaign.status FROM ad_group WHERE ad_group.resource_name IN (' +
        groupNames.map(quoted).join(', ') +
        ')',
      'adGroup',
      send,
    ))
      groups[String(g.resourceName)] = {status: g.status ?? null, type: g.type ?? null};
    out.adGroups = groups;
    const keywords: JsonObject[] = [];
    for (const c of await rows(
      p,
      'SELECT ad_group_criterion.resource_name, ad_group_criterion.ad_group, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.negative, ad_group_criterion.status FROM ad_group_criterion WHERE ad_group_criterion.type = KEYWORD AND ad_group_criterion.status != REMOVED AND ad_group_criterion.ad_group IN (' +
        groupNames.map(quoted).join(', ') +
        ')',
      'adGroupCriterion',
      send,
    )) {
      const kw = object(c.keyword) ? c.keyword : {};
      keywords.push({
        adGroup: String(c.adGroup),
        text: String(kw.text ?? '').toLowerCase(),
        matchType: kw.matchType ?? null,
        negative: c.negative === true,
      });
    }
    out.keywords = keywords;
  }
  return {status: 200, headers: {}, data: out};
}
export function validateGoogleApplyState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).googleApplyState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !object(d) ||
    (s.names.length ? !object(d.recommendations) : !object(d.budgets) && !object(d.keywords))
  )
    unverified('Missing verified recommendation state.');
}
/** What each operation would apply, from the recommendation and the parameters sent. */
function plannedChanges(p: CompiledRequest, s: JsonObject): JsonObject[] {
  const recs = object(s.recommendations) ? s.recommendations : {};
  return operations(p).map(op => {
    const r = recs[String(op.resourceName)] as JsonObject | undefined;
    if (!object(r)) return {resourceName: op.resourceName, missing: true};
    if (r.type === 'KEYWORD') {
      const kw = object(r.keyword) ? r.keyword : {},
        k = object(op.keyword) ? op.keyword : {};
      return {
        resourceName: op.resourceName,
        type: r.type,
        adGroup: k.adGroup ?? r.adGroup,
        text: kw.text ?? null,
        matchType: k.matchType ?? kw.matchType,
        cpcBidMicros: k.cpcBidMicros === undefined ? null : String(k.cpcBidMicros),
      };
    }
    const b = object(r.budget) ? r.budget : {},
      c = object(op.campaignBudget) ? op.campaignBudget : {};
    return {
      resourceName: op.resourceName,
      type: r.type,
      campaignBudget: r.campaignBudget,
      fromMicros: b.currentMicros ?? null,
      toMicros: c.newBudgetAmountMicros === undefined ? (b.recommendedMicros ?? null) : String(c.newBudgetAmountMicros),
    };
  });
}
export function googleApplyPrerequisites(p: CompiledRequest, states: unknown[]): void {
  if (!googleApplyKind(p)) return;
  const s = states[0];
  if (!object(s) || !object(s.recommendations)) unverified('Missing verified recommendation state.');
  const planned = plannedChanges(p, s),
    kinds = new Set<string>();
  for (const c of planned) {
    if (c.missing)
      fail(
        'STATE_NOT_FOUND',
        'Recommendation ' +
          String(c.resourceName) +
          ' is not a current recommendation of the customer; it may have expired or been applied.',
        {recommendation: String(c.resourceName)},
      );
    const r = (s.recommendations as JsonObject)[String(c.resourceName)] as JsonObject;
    if (r.dismissed === true) invalid('Recommendation ' + String(c.resourceName) + ' is dismissed.');
    if (!types.includes(String(r.type)))
      invalid(
        'Recommendation ' +
          String(c.resourceName) +
          ' is a ' +
          String(r.type) +
          ' recommendation; this contract applies KEYWORD and CAMPAIGN_BUDGET recommendations.',
      );
    kinds.add(String(r.type));
  }
  if (kinds.size > 1) invalid('Apply recommendations of one type per review.');
  operations(p).forEach((op, i) => {
    const t = String(planned[i]!.type);
    if ((op.keyword !== undefined && t !== 'KEYWORD') || (op.campaignBudget !== undefined && t !== 'CAMPAIGN_BUDGET'))
      invalid('The parameters of operation ' + i + ' do not match its ' + t + ' recommendation.');
  });
  for (const c of planned) {
    if (c.type === 'KEYWORD') {
      if (!c.text || !matchTypes.includes(String(c.matchType)))
        unverified('Recommendation ' + String(c.resourceName) + ' names no keyword.');
      const g = object(s.adGroups) ? (s.adGroups as JsonObject)[String(c.adGroup)] : undefined;
      if (!object(g))
        fail('STATE_NOT_FOUND', 'Ad group ' + String(c.adGroup) + ' is not an ad group of the customer.', {
          ad_group: String(c.adGroup),
        });
      if (g.status === 'REMOVED') invalid('Ad group ' + String(c.adGroup) + ' is removed.');
      const taken = (Array.isArray(s.keywords) ? (s.keywords as JsonObject[]) : []).find(
        k =>
          k.adGroup === c.adGroup &&
          k.negative !== true &&
          k.text === String(c.text).toLowerCase() &&
          k.matchType === c.matchType,
      );
      if (taken)
        fail(
          'CONFIGURATION_EXISTS',
          'Ad group ' +
            String(c.adGroup) +
            ' already has the ' +
            String(c.matchType) +
            ' keyword "' +
            String(c.text) +
            '".',
          {ad_group: String(c.adGroup)},
        );
    } else {
      const b = object(s.budgets) ? (s.budgets as JsonObject)[String(c.campaignBudget)] : undefined;
      if (!object(b)) unverified('Recommendation ' + String(c.resourceName) + ' names no readable campaign budget.');
      if (b.status === 'REMOVED') invalid('Campaign budget ' + String(c.campaignBudget) + ' is removed.');
      if (!c.toMicros) unverified('Recommendation ' + String(c.resourceName) + ' names no budget amount.');
      if (c.toMicros === b.amountMicros)
        invalid('Campaign budget ' + String(c.campaignBudget) + ' already has this amount.');
    }
  }
}
/** Owner budget limits compare the new daily amounts with the current ones. */
export function googleApplyPolicyAmounts(plan: CompiledRequest, before: unknown) {
  if (!googleApplyKind(plan)) return;
  const first = Array.isArray(before) ? before[0] : undefined;
  if (!object(first)) return;
  const planned = plannedChanges(plan, first).filter(c => c.type === 'CAMPAIGN_BUDGET' && c.toMicros);
  if (!planned.length) return;
  const budgets = object(first.budgets) ? first.budgets : {};
  return {
    creating: false,
    amounts: planned.map((c, i) => ({
      path: '/operations/' + i + '/campaign_budget/amount_micros',
      key: 'amount_micros:' + String(c.campaignBudget),
      amount: Number(c.toMicros),
      decimal: String(c.toMicros),
    })),
    old: planned.map(c => {
      const b = budgets[String(c.campaignBudget)] as JsonObject | undefined;
      return {
        path: '/campaign_budget/amount_micros',
        key: 'amount_micros:' + String(c.campaignBudget),
        amount: Number(b?.amountMicros ?? 0),
        decimal: String(b?.amountMicros ?? '0'),
      };
    }),
  };
}
/** A keyword recommendation adds a keyword that serves at once in an enabled ad group. */
export function googleApplyActivates(plan: CompiledRequest, before: unknown): boolean {
  if (!googleApplyKind(plan)) return false;
  const first = Array.isArray(before) ? before[0] : undefined;
  return !object(first) || plannedChanges(plan, first).some(c => c.type !== 'CAMPAIGN_BUDGET');
}
export function googleApplyImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!googleApplyKind(p)) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    planned = plannedChanges(p, s);
  const budget = planned.some(c => c.type === 'CAMPAIGN_BUDGET');
  return {
    provider: 'google',
    scope: 'recommendation_apply',
    operation: 'apply',
    changes: planned,
    may_affect_serving: true,
    effect: budget
      ? 'Sets the campaign budgets to the amounts shown; spending can change at once.'
      : 'Adds the keywords shown to their ad groups; they serve at once in enabled ad groups and campaigns.',
    verification: budget
      ? 'Reads each campaign budget again and compares its amount.'
      : 'Reads the keywords of each ad group again and looks for each keyword added.',
    source: 'https://developers.google.com/google-ads/api/reference/rpc/v25/RecommendationService',
  };
}
export function googleApplyOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const d = r.data;
  if (r.status !== 200 || !object(d) || (d.partialFailureError !== undefined && d.partialFailureError !== null))
    return false;
  const results = Array.isArray(d.results) ? d.results : [],
    names = operations(p).map(op => String(op.resourceName));
  return (
    results.length === names.length &&
    results.every((x: unknown, i: number) => object(x) && x.resourceName === names[i])
  );
}
export function googleApplyVerification(
  p: CompiledRequest,
  _result: JsonObject,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const first = before[0];
  if (!object(first)) fail('VERIFICATION_UNSUPPORTED', 'The review holds no recommendation state to verify against.');
  const planned = plannedChanges(p, first);
  if (planned.some(c => c.type === 'CAMPAIGN_BUDGET')) {
    const names = [...new Set(planned.map(c => String(c.campaignBudget)))];
    const read: Read = {
      ...search(
        p,
        'SELECT campaign_budget.resource_name, campaign_budget.amount_micros FROM campaign_budget WHERE campaign_budget.resource_name IN (' +
          names.map(quoted).join(', ') +
          ')',
      ),
      googleApplyState: {names: [], budgets: names},
    };
    return [
      {
        read,
        expected: {
          budgets: Object.fromEntries(planned.map(c => [String(c.campaignBudget), {amountMicros: String(c.toMicros)}])),
        },
        id: 'campaign budgets ' + names.join(', '),
      },
    ];
  }
  const keywords = planned.map(c => ({
      adGroup: String(c.adGroup),
      text: String(c.text).toLowerCase(),
      matchType: String(c.matchType),
    })),
    groups = [...new Set(keywords.map(k => k.adGroup))];
  const read: Read = {
    ...search(
      p,
      'SELECT ad_group_criterion.resource_name, ad_group_criterion.ad_group, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.negative, ad_group_criterion.status FROM ad_group_criterion WHERE ad_group_criterion.type = KEYWORD AND ad_group_criterion.status != REMOVED AND ad_group_criterion.ad_group IN (' +
        groups.map(quoted).join(', ') +
        ')',
    ),
    googleApplyState: {names: [], adGroups: groups, keywords},
  };
  return [
    {
      read,
      expected: {
        keywords: Object.fromEntries(
          keywords.map(k => [k.adGroup + '|' + k.matchType + '|' + k.text, {present: true}]),
        ),
      },
      id: 'keywords in ' + groups.join(', '),
    },
  ];
}
/** Verification reads project only the budgets or keywords the review expects. */
async function check(
  p: CompiledRequest,
  s: NonNullable<Read['googleApplyState']>,
  send: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  if (s.budgets) {
    const out: JsonObject = {};
    for (const b of await rows(p, String((p.body as JsonObject).query), 'campaignBudget', send))
      out[String(b.resourceName)] = {amountMicros: mstr(b.amountMicros)};
    return {status: 200, headers: {}, data: {budgets: out}};
  }
  const found = (await rows(p, String((p.body as JsonObject).query), 'adGroupCriterion', send)).map(c => {
    const kw = object(c.keyword) ? c.keyword : {};
    return (
      String(c.adGroup) +
      '|' +
      String(kw.matchType) +
      '|' +
      String(kw.text ?? '').toLowerCase() +
      (c.negative === true ? '|negative' : '')
    );
  });
  return {
    status: 200,
    headers: {},
    data: {
      keywords: Object.fromEntries(
        (s.keywords ?? []).map(k => {
          const key = k.adGroup + '|' + k.matchType + '|' + k.text;
          return [key, {present: found.includes(key)}];
        }),
      ),
    },
  };
}
export function googleApplyObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {
    ...(object(data.budgets) ? {budgets: data.budgets} : {}),
    ...(object(data.keywords) ? {keywords: data.keywords} : {}),
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleApplyFamily: ReviewedFamily = {
  name: 'google_recommendation_apply',
  files: ['src/google-recommendation-apply.ts', ['tests/google-recommendation-apply.test.mjs']],
  kind: googleApplyKind,
  assert: assertGoogleApply,
  scope: assertGoogleAdsScope,
  snapshots: googleApplySnapshots,
  isRead: isGoogleApplyRead,
  reader: readGoogleApply,
  validateState: validateGoogleApplyState,
  prerequisites: googleApplyPrerequisites,
  impact: googleApplyImpact,
  outcome: googleApplyOutcome,
  verification: googleApplyVerification,
  observed: googleApplyObserved,
  spendConfirmation: {
    needed: googleApplyKind,
    message:
      'Applying a recommendation adds keywords that serve at once or changes campaign budgets. Review the changes and provide spend_change_confirmed=true.',
  },
  activates: googleApplyActivates,
  policyAmounts: googleApplyPolicyAmounts,
};
