import {bad, fingerprint, obj, type ToolCall} from './workspace-core.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {linkedinVersion} from './linkedin-version.js';
import {assertAccountWrite} from './write-access.js';
import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';
import {storedLogin} from './connection-authority.js';

const gateway = 'linkedin_native_action';
const invalid = (message: string): never => bad(message, 'ALLOCATION_BUDGET_CHANGED');
const id = (value: unknown) =>
  typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : undefined;
const campaignId = (value: string) => /^urn:li:sponsoredCampaign:([1-9][0-9]{0,19})$/.exec(value)?.[1];

function money(value: unknown, currency: string) {
  if (
    !obj(value) ||
    Object.keys(value).some(k => !['amount', 'currencyCode'].includes(k)) ||
    value.currencyCode !== currency ||
    typeof value.amount !== 'string' ||
    !/^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,6})?$/.test(value.amount)
  )
    invalid('Retain exact LinkedIn decimal budget amounts in the account currency, with at most six decimal places.');
  const native = value as JsonObject,
    [whole, fraction = ''] = native.amount.split('.'),
    scaled = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (scaled <= 0n || scaled > BigInt(Number.MAX_SAFE_INTEGER))
    invalid('Use positive LinkedIn budget amounts within the exact allocation precision limit.');
  return {amount: native.amount, currencyCode: currency, scaled: String(scaled)};
}

/** Bracketed exact account, campaign and parent reads. Six-place integers are local bookkeeping, not native units. */
export async function linkedinAllocationBudgets(
  store: Store,
  call: ToolCall,
  actor: Actor,
  source: JsonObject,
  entities: string[],
  pricing = true,
) {
  const account = id(source.account_id),
    ids = entities.map(campaignId),
    version = linkedinVersion(source.api_version);
  if (
    !account ||
    source.timezone !== 'UTC' ||
    typeof source.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(source.currency) ||
    !entities.length ||
    entities.length > 20 ||
    new Set(entities).size !== entities.length ||
    ids.some(v => v === undefined)
  )
    invalid('Select at most 20 exact LinkedIn campaign URNs from this account’s verified UTC report.');
  const connection = store.resolveConnection(actor, gateway, account, source.connection_id);
  const authority = (c: typeof connection) =>
    fingerprint({
      login: storedLogin(store, c),
      scopes: [...c.scopes].sort(),
      accounts: [...c.accounts].sort(),
      write_accounts: [...(c.writeAccounts ?? [])].sort(),
      enabled: c.enabled,
    });
  const authorization = authority(connection),
    current = () => {
      store.assertActorActive(actor);
      const c = store.resolveConnection(actor, gateway, account, connection.id);
      assertAccountWrite(store, c, account!);
      if (!c.scopes.includes('rw_ads') || !c.scopes.includes('r_ads_reporting'))
        bad(
          'This login requires LinkedIn reporting and advertising write permission for an allocation draft.',
          'INSUFFICIENT_SCOPE',
        );
      if (authority(c) !== authorization)
        bad('The selected login changed. Preview the allocation again.', 'CONNECTION_AUTHORITY_CHANGED');
    },
    bound = new ReportCollectionBudget(undefined, fingerprint({account, entities, version}), () => {}, {
      requests: 180,
      rows: 100,
      bytes: 8 * 1024 * 1024,
      elapsed_ms: 60000,
    }),
    references: JsonObject[] = [];
  const read = async (action: string, path_params: JsonObject) => {
    current();
    const args = {
        action,
        account_id: account,
        connection_id: connection.id,
        path_params,
        api_version: version,
        aggregate_pages: false,
        dry_run: false,
      },
      requested_at = Date.now(),
      response = await call(gateway, args, actor);
    current();
    const d = response.data?.data;
    if (!response.success)
      bad(
        response.error?.message ?? 'Current LinkedIn budgets could not be read.',
        response.error?.code ?? 'ALLOCATION_BUDGET_UNAVAILABLE',
      );
    if (
      response.data?.truncated ||
      !obj(d) ||
      ['error', 'errors', 'paging', 'elements', 'truncated', 'partial', 'next', 'nextPageToken'].some(
        k => d[k] !== undefined,
      ) ||
      Buffer.byteLength(JSON.stringify(d), 'utf8') > 65536
    )
      invalid('LinkedIn returned incomplete, ambiguous or oversized native budget evidence.');
    bound.rows('resource-' + references.length, 1);
    references.push({source_request: args, source_hash: fingerprint(d), requested_at, captured_at: Date.now()});
    return d as JsonObject;
  };
  const pricedFor = new Map<string, {targeting: unknown; costType: unknown; type: unknown}>();
  /**
   * LinkedIn's daily budget limits for this account (WRT-07 Stage A): one adBudgetPricing read per draft, priced for the
   * first selected campaign's type, cost type and targeting. Stated limits refuse a daily budget outside them; a read
   * that fails, or an answer without exact limits in the account currency, leaves them unknown, and LinkedIn still
   * checks the amount when the reviewed change is executed.
   */
  const dailyLimits = async (campaign: string): Promise<JsonObject> => {
    const priced = pricedFor.get(campaign),
      unavailable = (reason: string) => ({status: 'unavailable', reason});
    if (!priced || !obj(priced.targeting) || typeof priced.costType !== 'string' || typeof priced.type !== 'string')
      return unavailable('campaign_targeting_unknown');
    current();
    // The criteriaV2 finder takes the campaign's own targetingCriteria shape (include/exclude). The request shape is
    // pending one authorized native read (WRT-07 Native acceptance); a refusal here only leaves the limits unknown.
    const args = {
        action: 'linkedin_rest_ad_budget_pricing_get',
        account_id: account,
        connection_id: connection.id,
        api_version: version,
        query: {
          q: 'criteriaV2',
          account: 'urn:li:sponsoredAccount:' + account,
          campaignType: priced.type,
          bidType: priced.costType,
          matchType: 'EXACT',
          targetingCriteria: priced.targeting,
        },
        aggregate_pages: false,
        dry_run: false,
      },
      requested_at = Date.now();
    let response: JsonObject;
    try {
      response = await call(gateway, args, actor);
    } catch {
      return unavailable('read_failed');
    }
    current();
    bound.rows('pricing', 1);
    const d = response.success ? response.data?.data : undefined,
      element = obj(d) && Array.isArray(d.elements) && d.elements.length === 1 ? d.elements[0] : undefined,
      limits = obj(element) && obj(element.dailyBudgetLimits) ? element.dailyBudgetLimits : undefined;
    if (!limits) return unavailable(response.success ? 'limits_not_stated' : 'read_failed');
    const exact = (v: unknown) =>
      obj(v) &&
      v.currencyCode === source.currency &&
      typeof v.amount === 'string' &&
      /^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,6})?$/.test(v.amount)
        ? (v.amount as string)
        : undefined;
    const min = exact(limits.min),
      max = limits.max === undefined ? null : exact(limits.max);
    if (min === undefined || max === undefined) return unavailable('limits_not_exact');
    const scaled = (amount: string) => {
      const [whole, fraction = ''] = amount.split('.');
      return String(BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0')));
    };
    return {
      status: 'checked',
      min,
      max,
      min_micros: scaled(min),
      max_micros: max === null ? null : scaled(max),
      currency: source.currency,
      campaign_type: priced.type,
      cost_type: priced.costType,
      source_hash: fingerprint(d),
      requested_at,
    };
  };
  const accountState = async () => {
    const row = await read('linkedin_rest_ad_accounts_ad_account_id_get', {ad_account_id: account});
    if (id(row.id) !== account || row.currency !== source.currency || row.status !== 'ACTIVE')
      invalid('Retain an active LinkedIn account with the exact report identity and currency.');
    return {id: account, currency: row.currency, status: row.status, type: row.type ?? null};
  };
  const campaignState = async (campaign: string) => {
    const row = await read('linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_get', {
        ad_account_id: account,
        campaign_id: campaign,
      }),
      group = /^urn:li:sponsoredCampaignGroup:([1-9][0-9]{0,19})$/.exec(row.campaignGroup)?.[1];
    if (
      id(row.id) !== campaign ||
      row.account !== 'urn:li:sponsoredAccount:' + account ||
      !group ||
      !['ACTIVE', 'PAUSED'].includes(row.status) ||
      !['TEXT_AD', 'SPONSORED_UPDATES', 'SPONSORED_INMAILS'].includes(row.type) ||
      typeof row.versionTag !== 'string' ||
      (row.name !== undefined && (typeof row.name !== 'string' || Buffer.byteLength(row.name, 'utf8') > 1024)) ||
      !/^[0-9]{1,20}$/.test(row.versionTag) ||
      row.totalBudget !== undefined ||
      row.pacingStrategy !== undefined ||
      Object.keys(row).some(k => /budget|pacing/i.test(k) && k !== 'dailyBudget')
    )
      invalid(
        'Use an owned active or paused LinkedIn campaign with an independent daily budget. Lifetime, accelerated, shared or unknown budget modes need a separate native review.',
      );
    const amount = money(row.dailyBudget, source.currency);
    // What LinkedIn prices its daily budget limits for; kept for the one pricing read, never in the preview.
    if (!pricedFor.has(campaign))
      pricedFor.set(campaign, {targeting: row.targetingCriteria, costType: row.costType, type: row.type});
    return {
      id: campaign,
      name: row.name ?? null,
      account: row.account,
      group_id: group,
      campaign_group: row.campaignGroup,
      status: row.status,
      type: row.type,
      version_tag: row.versionTag,
      run_schedule: row.runSchedule ?? null,
      daily_budget: {amount: amount.amount, currencyCode: amount.currencyCode},
      amount_micros: amount.scaled,
    };
  };
  const groupState = async (group: string) => {
    const row = await read('linkedin_rest_ad_accounts_ad_account_id_ad_campaign_groups_ad_campaign_groups_id_get', {
      ad_account_id: account,
      ad_campaign_groups_id: group,
    });
    if (
      id(row.id) !== group ||
      row.account !== 'urn:li:sponsoredAccount:' + account ||
      !['ACTIVE', 'PAUSED'].includes(row.status) ||
      Object.keys(row).some(k => /budget|pacing/i.test(k) && k !== 'totalBudget')
    )
      invalid(
        'Use a LinkedIn campaign group without dynamic budget optimization or a group daily budget. Preserve any existing group total cap.',
      );
    const total = row.totalBudget === undefined ? undefined : money(row.totalBudget, source.currency);
    return {
      id: group,
      account: row.account,
      status: row.status,
      run_schedule: row.runSchedule ?? null,
      total_budget: total ? {amount: total.amount, currencyCode: total.currencyCode} : null,
    };
  };
  try {
    return await bound.run(async () => {
      const accountBefore = await accountState(),
        campaigns: JsonObject[] = [];
      for (const campaign of ids) campaigns.push(await campaignState(campaign!));
      const groups = new Map<string, JsonObject>();
      for (const campaign of campaigns)
        if (!groups.has(campaign.group_id)) groups.set(campaign.group_id, await groupState(campaign.group_id));
      for (const campaign of campaigns)
        if (fingerprint(await campaignState(campaign.id)) !== fingerprint(campaign))
          invalid('LinkedIn campaign configuration changed during allocation inspection. Preview again.');
      for (const [group, before] of groups)
        if (fingerprint(await groupState(group)) !== fingerprint(before))
          invalid('LinkedIn campaign-group configuration changed during allocation inspection. Preview again.');
      if (fingerprint(await accountState()) !== fingerprint(accountBefore))
        invalid('LinkedIn account metadata changed during allocation inspection. Preview again.');
      current();
      const targets = campaigns.map((campaign, i) => {
        const state = {
          entity_id: entities[i],
          campaign_id: campaign.id,
          budget_resource: '/rest/adAccounts/' + account + '/adCampaigns/' + campaign.id,
          amount_micros: campaign.amount_micros,
          currency: source.currency,
          timezone: 'UTC',
          api_version: version,
          campaign,
          parent: groups.get(campaign.group_id),
          account: accountBefore,
        };
        return {...state, native_signature: fingerprint(state)};
      });
      return {
        targets,
        source_references: references,
        ...(pricing ? {daily_budget_limits: await dailyLimits(campaigns[0]!.id)} : {}),
      };
    });
  } finally {
    bound.close();
  }
}
